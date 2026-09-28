// The HTTP surface. Stateless: no database, no session, no file written.
//
// ⛔ EVERY ANSWER IS JSON, INCLUDING "NOT FOUND". draft's SPA catch-all answered 200 with index.html
// for any unknown path and produced a false finding five times; a verification here asserts a JSON
// key, and an unknown path is a 404 with `{ error: "not_found" }`, never a page.
//
// ⛔ NO PAYLOAD IS LOGGED. The request log line is method, path, status, duration and the calling
// client — never a body, a query string or a header value. The error handler logs the error's code
// and name, never the request, and never express's JSON parse error `body`, which echoes the input.
import express from "express";
import { generateResume, InvalidRequestError } from "../generation/generate.js";
import { enhanceResume } from "../generation/enhance.js";
import { parsePdf } from "../parsing/parsePdf.js";
import { normalizeResumeHtml } from "../formatting/resumeFormatter.js";
import { scoreAtsLocally, buildRuntimeAtsBasis } from "@draft/ats-scorer";

export const SERVICE = "resume-master";

/** JSON has no Map. Weights and synonyms arrive as [key, value] pairs and become Maps explicitly. */
function mapFromPairs(v, name) {
  if (v == null) return null;
  if (!Array.isArray(v) || !v.every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === "string")) {
    throw new InvalidRequestError(`${name} must be an array of [string, value] pairs`);
  }
  return new Map(v);
}

export function createApp({ anthropic = null, version = {}, log = defaultLog, env = process.env } = {}) {
  const app = express();
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => log({
      method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started,
      client: req.client?.id ?? null,
    }));
    next();
  });
  app.use(express.json({ limit: "15mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true, service: SERVICE }));
  app.get("/v1/version", (_req, res) => res.json({ service: SERVICE, ...version }));

  // ── deterministic: no model, no cost ──────────────────────────────────────────────────────────
  app.post("/v1/resumes/format", (req, res, next) => {
    try {
      const { html } = req.body || {};
      if (typeof html !== "string" || !html.trim()) throw new InvalidRequestError("html is required");
      res.json({ html: normalizeResumeHtml(html) });
    } catch (e) { next(e); }
  });

  app.post("/v1/ats/score", (req, res, next) => {
    try {
      const { job, resumeText, signalProfile = {}, domainProfile = {}, claims = null } = req.body || {};
      if (!job || typeof job !== "object") throw new InvalidRequestError("job is required");
      if (typeof resumeText !== "string") throw new InvalidRequestError("resumeText is required");
      const runtimeBasis = buildRuntimeAtsBasis({ resumeText, signalProfile, domainProfile, claims });
      const report = scoreAtsLocally({
        job, runtimeBasis,
        termWeights: mapFromPairs(req.body.termWeights, "termWeights"),
        synonyms: mapFromPairs(req.body.synonyms, "synonyms"),
      });
      res.json({ report });
    } catch (e) { next(e); }
  });

  // ── model-backed ─────────────────────────────────────────────────────────────────────────────
  app.post("/v1/resumes/generate", async (req, res, next) => {
    try { res.json(await generateResume(anthropic, req.body || {}, { env })); } catch (e) { next(e); }
  });
  app.post("/v1/resumes/enhance", async (req, res, next) => {
    try { res.json(await enhanceResume(anthropic, req.body || {})); } catch (e) { next(e); }
  });
  app.post("/v1/resumes/parse-pdf", async (req, res, next) => {
    try { res.json(await parsePdf(anthropic, req.body || {})); } catch (e) { next(e); }
  });

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const usage = err.usageSoFar || (err.usage ? [err.usage] : []);
    log({ error: err.code || err.name || "error", status: err.status ?? null });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json" });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "payload_too_large" });
    if (err instanceof InvalidRequestError) return res.status(400).json({ error: "invalid_request", message: err.message });
    if (err instanceof TypeError && /termWeights|synonyms/.test(err.message)) {
      return res.status(400).json({ error: "invalid_request", message: err.message });
    }
    if (err.code === "resume_claim_violation") {
      // The document is withheld. The violations say why; retrying may produce an honest one,
      // because generation is stochastic — so this is retryable, and the refusal is not an outage.
      return res.status(422).json({ error: "resume_claim_violation", retryable: true,
        violations: err.violations, usage });
    }
    if (err.code === "resume_claim_not_inspected") {
      return res.status(502).json({ error: "resume_claim_not_inspected", retryable: true, usage });
    }
    if (err.code === "model_unconfigured") {
      return res.status(503).json({ error: "model_unconfigured", retryable: false, usage });
    }
    if (err.code === "upstream_model_failure") {
      // ⛔ A NON-RETRYABLE FAILURE SAYS SO. "Try again" for an exhausted balance can never be true.
      return res.status(502).json({ error: "upstream_model_failure", retryable: !err.permanent,
        permanent: err.permanent, message: err.message, usage });
    }
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}

function defaultLog(entry) {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }));
}
