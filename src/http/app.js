// The HTTP surface. The service-token API (/v1/…, /mcp) is stateless: no database, no session, no
// file written. A57 (10-02) added a SECOND surface for people on resumemaster.one — /v1/site/…,
// with accounts, credits and opt-in storage (src/http/siteRoutes.js) — and A54 a front door: the
// site itself, served from public/ at "/". ⛔ Neither changes the token API; see siteRoutes.js.
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
import { scoreAts, formatResume } from "../tools/deterministic.js";
import { requireClient } from "./auth.js";
import { createMetering } from "./metering.js";
import { mcpHandlers } from "../mcp/server.js";
import { siteRoutes } from "./siteRoutes.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

export const SERVICE = "resume-master";

/**
 * @param clients  Map<clientId, sha256 Buffer[]> from parseClientTokens. Null or empty FAILS CLOSED:
 *                 every /v1 route but /v1/version answers 503 auth_unconfigured.
 */
export function createApp({ anthropic = null, version = {}, log = defaultLog, env = process.env,
                            clients = null, metering = createMetering({ log }), store = null,
                            siteOptions = {} } = {}) {
  const app = express();
  app.disable("x-powered-by");
  // Railway terminates TLS in front of the service: req.secure (the session cookie's Secure flag)
  // and req.ip (the anonymous tools' rate key) must come from the one proxy hop.
  app.set("trust proxy", 1);
  const client = requireClient(clients);

  // A model-backed route: the limit hook runs before any spend, and the usage — success OR failure,
  // because a failed call can still have spent — is recorded against the client afterwards.
  const metered = (route, fn) => async (req, res, next) => {
    if (!metering.allow(req.client.id, route)) {
      return res.status(429).json({ error: "limit_exceeded", retryable: true,
        message: "This client has reached its limit for this route. Try again later." });
    }
    try {
      const out = await fn(req);
      metering.record(req.client.id, route, out.usage);
      res.json(out);
    } catch (e) {
      metering.record(req.client.id, route, e.usageSoFar || (e.usage ? [e.usage] : []));
      next(e);
    }
  };

  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => log({
      method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started,
      client: req.client?.id ?? null,
    }));
    next();
  });
  // Parsed only AFTER authentication: an unauthenticated caller cannot make this service read a
  // 15 MB body before being refused.
  const json = express.json({ limit: "15mb" });

  app.get("/health", (_req, res) => res.json({ ok: true, service: SERVICE }));
  app.get("/v1/version", (_req, res) => res.json({ service: SERVICE, ...version }));

  // ── deterministic: no model, no cost — still authenticated, so every caller is identified ───────
  // One implementation each, in src/tools/deterministic.js — the MCP tools below call the same ones.
  app.post("/v1/resumes/format", client, json, (req, res, next) => {
    try { res.json(formatResume(req.body)); } catch (e) { next(e); }
  });

  app.post("/v1/ats/score", client, json, (req, res, next) => {
    try { res.json(scoreAts(req.body)); } catch (e) { next(e); }
  });

  // ── MCP (E1): the deterministic tools as LLM tools, in the same service ─────────────────────────
  // The SAME auth middleware, and it runs FIRST: an unauthenticated or unconfigured request is
  // refused before the body is read, exactly as on /v1. See src/mcp/server.js.
  const mcp = mcpHandlers({ metering, log, version });
  app.post("/mcp", client, json, mcp.post, mcp.errors);
  app.get("/mcp", client, mcp.methodNotAllowed);
  app.delete("/mcp", client, mcp.methodNotAllowed);

  // ── model-backed ─────────────────────────────────────────────────────────────────────────────
  app.post("/v1/resumes/generate", client, json, metered("resumes.generate", req => generateResume(anthropic, req.body || {}, { env })));
  app.post("/v1/resumes/enhance", client, json, metered("resumes.enhance", req => enhanceResume(anthropic, req.body || {})));
  app.post("/v1/resumes/parse-pdf", client, json, metered("resumes.parse-pdf", req => parsePdf(anthropic, req.body || {})));

  // ── the site (A54) and a person's routes (A57) ──────────────────────────────────────────────
  app.use("/v1/site", siteRoutes({ store, anthropic, env, metering, ...siteOptions }));
  app.use(express.static(PUBLIC_DIR, { index: "index.html", extensions: false, fallthrough: true }));

  // Everything else is still JSON, including "not found" — only the site's own files are pages.
  app.use((_req, res) => res.status(404).json({ error: "not_found",
    message: "No such route. The API's routes are listed in its published contract; the site is at /." }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const usage = err.usageSoFar || (err.usage ? [err.usage] : []);
    log({ error: err.code || err.name || "error", status: err.status ?? null });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json",
      message: "The request body is not valid JSON." });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "payload_too_large",
      message: "The request body is larger than this route accepts (15 MB for the API)." });
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
