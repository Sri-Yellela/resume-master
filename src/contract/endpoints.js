// The DECLARED half of the contract: envelopes and the endpoint table.
//
// Envelopes are built inline in the route handlers, so they are declared — but every envelope that
// carries a derived shape REFERENCES it ($AtsReport, $UsageRecord, $ClaimViolation, …) and never
// restates a field of it. What keeps these honest is test/contractEnvelope.test.js: it boots the
// real app and drives every endpoint through every declared outcome, checking every key and every
// value type a real response carries against what is declared here.
import { str, num, bool, arr, obj, ref, nullable, enumOf } from "./schema.js";

// 1.1.0 (E1): additive — the /mcp routes, the JSON-RPC envelopes, the MCP tool result shapes and
// the generated tool table (`x-mcp`). No 1.0.0 shape changed.
// 1.3.0 (D21): additive — 429 limit_exceeded on the free routes and /mcp (free daily caps; the
// anonymous caps), and each MCP tool's `securitySchemes` (noauth for the anonymous ones).
export const CONTRACT_VERSION = "1.3.0";

const usage = arr(ref("UsageRecord"));

export const DECLARED_SCHEMAS = {
  Health: obj({ ok: bool, service: str }),
  Version: obj({ service: enumOf("resume-master"), version: str, commit: nullable(str), scorer: str, llmFormat: bool },
    { description: "Assert `service`, never the status: an unknown path elsewhere may answer 200 with HTML." }),

  Candidate: obj({ fullName: str, phone: str, email: str, linkedinUrl: str, githubUrl: str, location: str,
    yearsOfExperience: nullable(num) }, { optional: ["fullName", "phone", "email", "linkedinUrl", "githubUrl", "location", "yearsOfExperience"],
    description: "yearsOfExperience is THE AUTHORITY the claim guard enforces; a JD may not change it." }),
  JobProfile: obj({ name: str, seniority: nullable(enumOf("junior", "mid", "senior", "executive")),
    keywords: arr(str), tools: arr(str), actionVerbs: arr(str) },
    { optional: ["seniority", "keywords", "tools", "actionVerbs"],
      description: "seniority is the candidate's own declaration: the document may use it and may not exceed it." }),
  Claims: obj({ skills: arr(str), actionVerbs: arr(str) }, { optional: ["skills", "actionVerbs"],
    description: "Skills and verbs the CANDIDATE asserts. Never a title, level or headline." }),
  Job: obj({ title: str, company: str, category: str, description: str, stack: nullable(str) },
    { optional: ["company", "category", "description", "stack"] }),

  GenerateRequest: obj({
    mode: enumOf("GENERATE", "A_PLUS"), domainModuleKey: str, roleFamily: str, domain: str,
    candidate: ref("Candidate"), profile: nullable(ref("JobProfile")), claims: nullable(ref("Claims")),
    employers: arr(str), job: ref("Job"), baseResumeText: str,
    options: obj({ includeSummary: bool }, { optional: ["includeSummary"] }),
  }, { optional: ["mode", "domainModuleKey", "roleFamily", "domain", "candidate", "profile", "claims", "employers", "options"] }),
  GenerateResponse: obj({
    html: str, domainModuleKey: str,
    claimCheck: obj({ ok: { type: "boolean", enum: [true] }, inspected: ref("ClaimInspection") }),
    usage,
  }, { description: "Only ever returned for a document that PASSED the claim guard." }),

  EnhanceRequest: obj({ resumeText: str, profile: obj({ name: str, roleFamily: str, domain: str }, { optional: ["name", "roleFamily", "domain"] }),
    selectedAdditions: arr(str) }, { optional: ["profile", "selectedAdditions"] }),
  EnhanceResponse: obj({ text: str, usage }),
  ParsePdfRequest: obj({ pdfBase64: str }, { description: "A PDF of at most 10 MB, base64-encoded." }),
  ParsePdfResponse: obj({ text: str, chars: num, usage }),
  FormatRequest: obj({ html: str }),
  FormatResponse: obj({ html: str }),
  AtsScoreRequest: obj({ job: ref("Job"), resumeText: str, signalProfile: { type: "object" }, domainProfile: { type: "object" },
    claims: nullable(ref("Claims")),
    termWeights: nullable(arr({ type: "array" })), synonyms: nullable(arr({ type: "array" })) },
    { optional: ["signalProfile", "domainProfile", "claims", "termWeights", "synonyms"],
      description: "termWeights/synonyms are arrays of [key, value] pairs — JSON has no Map. Any other shape is a 400, never a silent unweighted score." }),
  AtsScoreResponse: obj({ report: ref("AtsReport") }),

  // ── MCP (E1) ────────────────────────────────────────────────────────────────────────────────────
  // A tool result's structuredContent. It WRAPS the HTTP shape (`report` is the same AtsReport,
  // `html` the same renderer's output) and never restates it — the tool table below points each
  // tool at its HTTP endpoint, and the generator derives the tool's inputSchema from that
  // endpoint's request schema. See src/contract/build.js buildMcpTools.
  McpAtsScoreResult: obj({
    outcome: enumOf("scored", "not_enough_signal"),
    score: nullable(num),
    meaning: str,
    report: ref("AtsReport"),
  }, { description: "`outcome` is the scorer's STATE, and `not_enough_signal` is its own state: the scorer declined " +
    "for want of signal, `score` is null, and it is NOT a low score. `meaning` says so in words, for a caller that " +
    "paraphrases. `scored` only when report.scorable is true and report.score is a number." }),
  McpFormatResult: obj({ html: str, contentType: enumOf("text/html"), howToGetPdf: str },
    { description: "Print-ready HTML, not a PDF — there is no server-side PDF. The browser prints it." }),

  // JSON-RPC 2.0 as the MCP Streamable HTTP transport answers it (stateless, JSON responses, no SSE).
  JsonRpcErrorObject: obj({ code: num, message: str, data: {} }, { optional: ["data"] }),
  JsonRpcResponse: obj({ jsonrpc: enumOf("2.0"), id: { type: ["number", "string", "null"] },
    result: { type: "object" }, error: ref("JsonRpcErrorObject") }, { optional: ["result", "error"],
    description: "Exactly one of result / error. A transport-level refusal (bad JSON, missing Accept) carries id null." }),

  Error: obj({
    error: enumOf("invalid_request", "invalid_json", "unauthenticated", "not_found", "payload_too_large",
      "resume_claim_violation", "resume_claim_not_inspected", "upstream_model_failure", "model_unconfigured",
      "auth_unconfigured", "limit_exceeded", "internal_error"),
    message: str, retryable: bool, permanent: bool, violations: arr(ref("ClaimViolation")), usage,
  }, { optional: ["message", "retryable", "permanent", "violations", "usage"],
    description: "`retryable` is present on every model-backed and auth error. ⛔ A non-retryable failure says so: " +
      "`retryable: false` for an exhausted balance, a bad key or an unconfigured service. " +
      "resume_claim_violation carries `violations` and NEVER the document." }),
};

const E = ref("Error");
const RPC = ref("JsonRpcResponse");
const authErrors = { 401: E, 503: E };
const limited = { 429: E };
const modelErrors = { 400: E, ...authErrors, 413: E, 429: E, 502: E };

/** method, path, auth, request, responses (status -> schema) — the table the harness covers. */
export const ENDPOINTS = [
  { method: "get", path: "/health", auth: false, responses: { 200: ref("Health") } },
  { method: "get", path: "/v1/version", auth: false, responses: { 200: ref("Version") } },
  { method: "post", path: "/v1/resumes/format", auth: true, cost: "free", request: ref("FormatRequest"),
    responses: { 200: ref("FormatResponse"), 400: E, 413: E, ...authErrors, ...limited } },
  { method: "post", path: "/v1/ats/score", auth: true, cost: "free", request: ref("AtsScoreRequest"),
    responses: { 200: ref("AtsScoreResponse"), 400: E, 413: E, ...authErrors, ...limited } },
  { method: "post", path: "/v1/resumes/generate", auth: true, cost: "metered", request: ref("GenerateRequest"),
    responses: { 200: ref("GenerateResponse"), 422: E, ...modelErrors } },
  { method: "post", path: "/v1/resumes/enhance", auth: true, cost: "metered", request: ref("EnhanceRequest"),
    responses: { 200: ref("EnhanceResponse"), ...modelErrors } },
  // 1.2.0 (D17): read from the PDF's text layer — free, no model; a scan is a 400.
  { method: "post", path: "/v1/resumes/parse-pdf", auth: true, cost: "free", request: ref("ParsePdfRequest"),
    responses: { 200: ref("ParsePdfResponse"), 400: E, 413: E, ...authErrors, ...limited } },

  // MCP (E1). Auth errors are this service's Error shape — they are refused before the MCP layer
  // runs, by the same middleware as /v1. Everything past auth answers JSON-RPC. 202 is the one
  // body-less answer in the contract, and the protocol requires it: a POST carrying only
  // notifications MUST be answered 202 with no body. `null` declares exactly that.
  { method: "post", path: "/mcp", auth: true, cost: "free", request: { type: ["object", "array"] },
    responses: { 200: { anyOf: [RPC, arr(RPC)] }, 202: null, 400: RPC, 406: RPC, 413: RPC, 415: RPC, ...authErrors, ...limited } },
  { method: "get", path: "/mcp", auth: true, responses: { 405: RPC, ...authErrors, ...limited } },
  { method: "delete", path: "/mcp", auth: true, responses: { 405: RPC, ...authErrors, ...limited } },
];

// ── The MCP tool table — the ONE place a tool is declared ───────────────────────────────────────
//
// ⛔ A TOOL'S SCHEMAS ARE NOT WRITTEN HERE. `endpoint` names the HTTP route whose request schema
// becomes the tool's inputSchema; `result` names the declared result shape above. The generator
// resolves both into self-contained JSON Schema and writes them to the contract (`x-mcp`), and the
// MCP server serves that generated table verbatim. test/mcp.test.js fails if what /mcp serves
// differs from the contract, or if a tool's inputSchema differs from its endpoint's request schema.
//
// Descriptions are what a model chooses tools by, so each says what the tool does, what it refuses
// and what a refusal MEANS. They are prose: the shape hash ignores them, so rewording is not a version.
//
// `anonymous: true` (D21) = served to a caller with NO token when RM_MCP_ANONYMOUS is set. Every MCP tool
// is already free and read-only — the generator refuses any other (buildMcpTools) — so this marks only
// WHICH free tools strangers may call.
//
// ⛔ DELIBERATELY ABSENT (see docs/API.md, MCP):
//   · generation — an LLM calling an API to call an LLM; its value would be the integrity layer, and
//     it costs money a tool loop can spend repeatedly. Not in the first pass.
//   · PDF parsing — the only implementation here is a model call (Sonnet reads the PDF). There is
//     no deterministic extraction path to expose, and the calling assistant already has the file.
export const MCP_TOOLS = [
  {
    name: "score_ats_fit",
    title: "ATS fit score (deterministic)",
    endpoint: "POST /v1/ats/score",
    result: "McpAtsScoreResult",
    cost: "free",
    // D21 (owner, 10-04): anonymous first — callable on /mcp with no token, under RM_MCP_ANONYMOUS's caps.
    anonymous: true,
    description: [
      "Scores how well a résumé's text matches one job posting, using Resume Master's deterministic ATS scorer " +
      "(@draft/ats-scorer — the same code as POST /v1/ats/score). Local and free: NO model call, no network call, " +
      "nothing stored or logged; the same input always gives the same output.",
      "Returns `outcome`, `score` (0-100, or null) and the full `report`: required terms matched and missing " +
      "(tier1_matched / tier1_missing), competencies, action verbs, the years-of-experience comparison, hard-constraint " +
      "misses (e.g. a clearance), and whether a seniority cap applied.",
      "⛔ IT DECLINES RATHER THAN GUESSES. When the posting or résumé carries too few scorable terms, `outcome` is " +
      "\"not_enough_signal\", `score` is null and report.decline_reasons says why. A declined result is NOT a low " +
      "score and NOT a poor fit — it means fit could not be measured from what was given. Never present it as a " +
      "score, a percentage, a band or a verdict: say it could not be scored and why, and ask for the full job " +
      "description or fuller résumé text.",
      "No band is returned: what counts as a strong score is the calling product's decision — do not invent one.",
      "Refused (isError, error \"invalid_request\"): a missing `job` or `resumeText`, or termWeights / synonyms not " +
      "given as arrays of [key, value] pairs — never silently scored unweighted. A refusal means the input was " +
      "malformed, not that the résumé is weak.",
      "Scope: a job posting (a company and a role) and the candidate's own résumé. It does not research, look up or " +
      "profile any individual — companies and roles only.",
      "Only `job` (title and description at least) and `resumeText` are needed; omit the other fields unless you " +
      "already hold them.",
      "⚠ NOT READ FROM THE RÉSUMÉ TEXT (D21, measured): years of experience, security clearance and citizenship. " +
      "Years are compared only when signalProfile.yearsExperience (a number) is given; without it the experience " +
      "line says the candidate's years are not set — report that, never \"lacks the experience\". A requirement in " +
      "hard_constraint_misses (e.g. \"Security clearance\") means the POSTING states it and it was not confirmed — " +
      "not that the résumé lacks it. Say \"the posting requires X; check whether you meet it\". Do not ask the user " +
      "for clearance or citizenship status to fill these in.",
    ].join("\n\n"),
  },
  {
    name: "format_resume_print_html",
    title: "Print-ready résumé HTML (deterministic)",
    endpoint: "POST /v1/resumes/format",
    result: "McpFormatResult",
    cost: "free",
    description: [
      "Renders résumé text or HTML into Resume Master's print-ready résumé HTML (the deterministic renderer behind " +
      "POST /v1/resumes/format). NO model call, nothing stored or logged; the same input always gives the same output.",
      "⛔ Returns HTML, NOT a PDF. There is no server-side PDF: open the HTML in a browser and print to PDF.",
      "It lays out; it does not write. It adds no content, and it neither checks nor improves what the résumé " +
      "claims — the claim guard (a résumé may not claim more years or seniority than the candidate's profile " +
      "states) applies to generation, which this server does not offer. Known sections are re-ordered and " +
      "re-labelled to a standard order (e.g. SKILLS becomes TECHNICAL SKILLS); a heading it does not recognise is " +
      "not dropped but folded into the preceding section as body text, and lines within an entry may be regrouped. " +
      "Review the rendered page before it is sent anywhere.",
      "Refused (isError, error \"invalid_request\"): missing or empty `html`. A refusal means there was nothing to render.",
    ].join("\n\n"),
  },
];

/** Any path not in the table. */
export const NOT_FOUND = { 404: E };
