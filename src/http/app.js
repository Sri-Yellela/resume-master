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
import { generateResume, generateGists, InvalidRequestError } from "../generation/generate.js";
import { enhanceResume } from "../generation/enhance.js";
import { extractPdfText } from "../parsing/extractPdfText.js";
import { scoreAts, formatResume } from "../tools/deterministic.js";
import { requireClient, mcpCaller } from "./auth.js";
import { createMetering } from "./metering.js";
import { mcpHandlers } from "../mcp/server.js";
import { siteRoutes } from "./siteRoutes.js";
import { renderPrivacyPage } from "./privacyPage.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOLKIT_SRC = path.join(ROOT_DIR, "src", "pdf-toolkit");
// D157: the résumé editor's document model (src/editor/sections.js) and the one formatter file it imports — the
// same files the server runs, served to the editor page, so the page and the server can never disagree.
const EDITOR_SRC = path.join(ROOT_DIR, "src", "editor");
const FORMATTER_FILE = path.join(ROOT_DIR, "src", "formatting", "resumeFormatter.js");
// D157: the editor page may be framed only by its hosts (draft), and runs only its own script. A section's HTML is
// sanitised by the model; this policy is the page's second wall (no inline script, nothing fetched elsewhere).
export const EDITOR_FRAME_ANCESTORS = "'self' https://jobsviadraft.com https://*.jobsviadraft.com https://*.up.railway.app http://localhost:* http://127.0.0.1:*";
const EDITOR_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  `frame-ancestors ${EDITOR_FRAME_ANCESTORS}`,
].join("; ");
const PDF_LIB_DIST = path.join(ROOT_DIR, "node_modules", "@cantoo", "pdf-lib", "dist");
const PDFJS_BUILD = path.join(ROOT_DIR, "node_modules", "pdfjs-dist", "build");
// A69 tier 2 (owner, 10-03): Office files (fflate) and OCR (tesseract.js, its wasm core, English data).
const FFLATE_ESM = path.join(ROOT_DIR, "node_modules", "fflate", "esm");
const TESSERACT_DIST = path.join(ROOT_DIR, "node_modules", "tesseract.js", "dist");
const TESSERACT_CORE = path.join(ROOT_DIR, "node_modules", "tesseract.js-core");
const TESSDATA = path.join(ROOT_DIR, "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int");   // LSTM-only data, 2.9 MB — the engine runs LSTM (OEM 1)

export const SERVICE = "resume-master";

/**
 * @param clients  Map<clientId, sha256 Buffer[]> from parseClientTokens. Null or empty FAILS CLOSED:
 *                 every /v1 route but /v1/version answers 503 auth_unconfigured.
 */
export function createApp({ anthropic = null, version = {}, log = defaultLog, env = process.env,
                            clients = null, metering = createMetering({ log }), store = null,
                            anonymous = null, siteOptions = {} } = {}) {
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

  // draft D173 (5): ONE REQUEST ID ACROSS SERVICES. draft sends `x-request-id` (its own request's id, or
  // "run<id>-job<id>" for an application run's job); it is logged on this service's line for the same work and
  // echoed back, so one application can be followed draft → here → the model. A missing or malformed id gets
  // none — this service never invents one that the caller's logs could not match.
  app.use((req, res, next) => {
    const started = Date.now();
    const rid = requestIdOf(req);
    if (rid) res.setHeader("x-request-id", rid);
    res.on("finish", () => log({
      method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started,
      client: req.client?.id ?? null, ...(rid ? { rid } : {}),
    }));
    next();
  });
  // Parsed only AFTER authentication: an unauthenticated caller cannot make this service read a
  // 15 MB body before being refused.
  const json = express.json({ limit: "15mb" });
  // D21: an anonymous MCP caller gets a body cap sized for a résumé and a posting, not for a PDF.
  const anonJson = express.json({ limit: "512kb" });
  const mcpJson = (req, res, next) => (req.client?.anonymous ? anonJson : json)(req, res, next);

  // D21: free is not unbounded. The deterministic routes take from the client's FREE daily cap
  // (RM_FREE_LIMITS_PER_DAY), before the body is read; off unless configured.
  const freeCap = (route) => (req, res, next) => {
    if (metering.allowFree(req.client.id, route)) return next();
    res.status(429).json({ error: "limit_exceeded", retryable: true,
      message: "This client has reached its daily limit for the free tools. Try again tomorrow." });
  };

  app.get("/health", (_req, res) => res.json({ ok: true, service: SERVICE }));
  app.get("/v1/version", (_req, res) => res.json({ service: SERVICE, ...version }));

  // ── deterministic: no model, no cost — still authenticated, so every caller is identified ───────
  // One implementation each, in src/tools/deterministic.js — the MCP tools below call the same ones.
  app.post("/v1/resumes/format", client, freeCap("resumes.format"), json, (req, res, next) => {
    try { res.json(formatResume(req.body)); } catch (e) { next(e); }
  });

  app.post("/v1/ats/score", client, freeCap("ats.score"), json, (req, res, next) => {
    try { res.json(scoreAts(req.body)); } catch (e) { next(e); }
  });

  // ── MCP (E1): the deterministic tools as LLM tools, in the same service ─────────────────────────
  // The SAME auth middleware, and it runs FIRST: an unauthenticated or unconfigured request is
  // refused before the body is read, exactly as on /v1. See src/mcp/server.js.
  // D21: with RM_MCP_ANONYMOUS set, a caller with NO token is admitted as "(anonymous)" — capped per
  // address and in total, before the body is read — and sees only the tools marked anonymous.
  const mcp = mcpHandlers({ metering, log, version });
  const mcpAuth = mcpCaller(clients, anonymous);
  app.post("/mcp", mcpAuth, mcpJson, mcp.post, mcp.errors);
  app.get("/mcp", mcpAuth, mcp.methodNotAllowed);
  app.delete("/mcp", mcpAuth, mcp.methodNotAllowed);

  // PDF → text (D17, O16e — 10-03): the PDF's own text layer, read here by the same reader as the
  // site's free tool (A70). It was Sonnet transcribing the document; D17 allows a model for
  // generation only. A scan has no text layer — refused with what to do, never an empty résumé.
  // `usage` stays in the answer, always empty, so the response shape is unchanged.
  app.post("/v1/resumes/parse-pdf", client, freeCap("resumes.parse-pdf"), json, async (req, res, next) => {
    try {
      const out = await extractPdfText(req.body || {});
      if (out.needsOcr) {
        throw new InvalidRequestError("This PDF has no text layer — it looks like a scan or an image. " +
          "Export it from its editor as a PDF, or send the text instead.");
      }
      res.json({ text: out.text, chars: out.chars, usage: [] });
    } catch (e) { next(e); }
  });

  // ── model-backed ─────────────────────────────────────────────────────────────────────────────
  app.post("/v1/resumes/generate", client, json, metered("resumes.generate", req => generateResume(anthropic, req.body || {}, { env })));
  app.post("/v1/resumes/enhance", client, json, metered("resumes.enhance", req => enhanceResume(anthropic, req.body || {})));
  // 1.8.0 (D123 P6g): the per-employer gists, built once per base résumé.
  app.post("/v1/resumes/gists", client, json, metered("resumes.gists", req => generateGists(anthropic, req.body || {})));

  // ── the site (A54) and a person's routes (A57) ──────────────────────────────────────────────
  app.use("/v1/site", siteRoutes({ store, anthropic, env, metering, ...siteOptions }));
  // A69: the PDF tools run in the visitor's browser. Their libraries are served from HERE — the site
  // makes no third-party request — and the component is src/pdf-toolkit, the same file the server's
  // PDF → text reads with. Static middleware, like public/ — files, not API routes, so the contract's route
  // table stays the API. Explicit JavaScript types: a module script refuses anything else.
  const js = { fallthrough: true, setHeaders: (res, file) => {
    if (/\.m?js$/.test(file)) res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    if (/\.wasm$/.test(file)) res.setHeader("Content-Type", "application/wasm");
    // The language data is fetched as bytes and unzipped by the reader itself — never Content-Encoding.
    if (/\.gz$/.test(file)) res.setHeader("Content-Type", "application/octet-stream");
  } };
  app.use("/lib/pdf-lib", express.static(PDF_LIB_DIST, js));
  app.use("/lib/pdfjs", express.static(PDFJS_BUILD, js));
  app.use("/lib/pdf-toolkit", express.static(TOOLKIT_SRC, js));
  app.use("/lib/editor", express.static(EDITOR_SRC, js));
  // One file, as middleware (a file, not an API route — the contract's route table stays the API).
  app.use("/lib/formatting/resumeFormatter.js", (req, res, next) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || req.path !== "/") return next();
    res.type("text/javascript; charset=utf-8").sendFile(FORMATTER_FILE);
  });
  app.use("/editor", (req, res, next) => {
    // Mounted at /editor, so the page itself is "/" (or "/index.html") here; its scripts and styles need no policy.
    if (req.path === "/" || req.path === "/index.html") res.setHeader("Content-Security-Policy", EDITOR_CSP);
    next();
  });
  app.use("/lib/fflate", express.static(FFLATE_ESM, js));
  app.use("/lib/tesseract", express.static(TESSERACT_DIST, js));
  app.use("/lib/tesseract-core", express.static(TESSERACT_CORE, js));
  app.use("/lib/tessdata", express.static(TESSDATA, { ...js, maxAge: "30d" }));
  // A83: the privacy page is rendered on the server from docs/PRIVACY.md, so it reads with no JavaScript
  // (an app-directory review reads the URL). Before the static files, which hold only its frame. A
  // page, like public/ — middleware, not an API route, so the contract's route table stays the API.
  const PRIVACY_PATHS = new Set(["/privacy.html", "/privacy"]);
  app.use((req, res, next) => {
    if (!PRIVACY_PATHS.has(req.path) || (req.method !== "GET" && req.method !== "HEAD")) return next();
    try { res.type("html").send(renderPrivacyPage()); } catch (e) { next(e); }
  });
  app.use(express.static(PUBLIC_DIR, { index: "index.html", extensions: false, fallthrough: true }));

  // Everything else is still JSON, including "not found" — only the site's own files are pages.
  app.use((_req, res) => res.status(404).json({ error: "not_found",
    message: "No such route. The API's routes are listed in its published contract; the site is at /." }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const usage = err.usageSoFar || (err.usage ? [err.usage] : []);
    log({ error: err.code || err.name || "error", status: err.status ?? null,
      // draft 46a: every résumé generation since 11-07 answered 500 here with only "TypeError" to go on. An unexpected
      // error (no HTTP status of its own) now also logs its message and where in THIS service's code it was thrown —
      // code locations only (paths under src/), never the request, the résumé or the model's text.
      ...(err.status == null && (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError) ? {
        message: String(err.message || "").slice(0, 200),
        at: String(err.stack || "").split("\n").slice(1).filter(l => /[\\/]src[\\/]/.test(l)).slice(0, 4)
          .map(l => l.trim().replace(/^at\s+/, "").replace(/\(?(?:file:\/\/\/)?.*?[\\/](src[\\/][^)]+)\)?$/, "$1")),
      } : {}) });
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
    if (err.code === "resume_unparsed") {
      // Permanent: the same base reads the same way every time. Nothing was generated; no model was called.
      return res.status(422).json({ error: "resume_unparsed", retryable: false, permanent: true, message: err.message, usage });
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

/** draft D173 (5): the caller's request id when it is a plain token (letters, digits, - _ . :), ≤ 80 chars; else null. */
export function requestIdOf(req) {
  const raw = typeof req?.get === "function" ? req.get("x-request-id") : req?.headers?.["x-request-id"];
  const v = typeof raw === "string" ? raw.trim() : "";
  return /^[\w.:-]{6,80}$/.test(v) ? v : null;
}

function defaultLog(entry) {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }));
}
