// The DECLARED half of the contract: envelopes and the endpoint table.
//
// Envelopes are built inline in the route handlers, so they are declared — but every envelope that
// carries a derived shape REFERENCES it ($AtsReport, $UsageRecord, $ClaimViolation, …) and never
// restates a field of it. What keeps these honest is test/contractEnvelope.test.js: it boots the
// real app and drives every endpoint through every declared outcome, checking every key and every
// value type a real response carries against what is declared here.
import { str, num, bool, arr, obj, ref, nullable, enumOf } from "./schema.js";
import { INPUT_LIMITS } from "../generation/inputLimits.js";
const capped = (maxLength, description) => ({ type: "string", maxLength, description });

// 1.1.0 (E1): additive — the /mcp routes, the JSON-RPC envelopes, the MCP tool result shapes and
// the generated tool table (`x-mcp`). No 1.0.0 shape changed.
// 1.3.0 (D21): additive — 429 limit_exceeded on the free routes and /mcp (free daily caps; the
// anonymous caps), and each MCP tool's `securitySchemes` (noauth for the anonymous ones).
// 1.4.0 (A81): additive — AtsReport.facts_from_text, present when the request carried no signalProfile
// and the scorer read years (dated roles) and a stated clearance from the résumé text. No 1.3.0 shape changed.
// 1.5.0 (D70): additive — GenerateRequest.options.cache, options.jobContext and job.keywords. And the
// SHAPE HASH NOW SEES FIELD NAMES: before 1.5.0 it dropped every key called `description` at every
// depth, Job.description included (src/contract/build.js shapeOf). Hashes recorded for 1.0.0–1.4.0
// in VERSIONS.json were computed the old way and stay as recorded — append-only; nothing re-hashes
// a version a consumer already holds. No 1.4.0 shape changed.
// 1.6.0 (A97): additive — UsageRecord.attempts (number | null: HTTP sends behind the call, SDK retry
// included), and the model routes' input caps declared as maxLength / maxItems (baseResumeText,
// job.description, resumeText, selectedAdditions). A request over a cap was already accepted by the
// 1.5.0 shape and is now a 400 invalid_request — the caps are stated here so a caller can check first.
// No 1.5.0 response shape changed.
// 1.7.0 (D123 P2): additive — GenerateRequest.options.tailoring ("full" default | "lean"), job.keywords.placements
// ({ term, employer }: a posting term the caller's knowledge base shows in one of the candidate's employers' stacks;
// read by the lean path only), and GenerateResponse.tailoring (present on a lean answer). No 1.6.0 shape changed.
// 1.8.0 (D123 P6a / P6d / P6g, and the owner's model choice 11-01): additive — options.tailoring gains "payload" (the job
// block + per-employer gists; the model may write a new bullet a gist supports) and "code" (no model: Skills, coursework and
// bullet order by code); options.model ("haiku" | "sonnet" | "open") names the model of a lean or payload call;
// GenerateRequest.gists and .coursework; job.keywords.mustHave, .niceToHave and .broader; GenerateResponse.tailoring gains
// `added` and `modelCalled`; and POST /v1/resumes/gists (the gists, built once per base résumé). No 1.7.0 shape changed.
// 1.9.0 (draft's WORKLOG 44y): additive — Error.error gains "resume_unparsed" (422 on POST /v1/resumes/generate, retryable
// false, permanent true): an editing tailoring's base is real text with no readable section heading, which until now was
// answered 200 with the header alone. Headings ending in ":" now read as headings. No 1.8.0 shape changed.
export const CONTRACT_VERSION = "1.9.0";

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
  // 1.5.0 (D70 Phase 1): job.keywords — what the caller's own scorer found, sent INSTEAD of the posting when
  // options.jobContext is "keywords". Bounds are runtimeInputs.js KEYWORD_LIMITS (a test holds them equal).
  JobKeywords: obj({
    matched: { type: "array", maxItems: 60, items: { type: "string", minLength: 1, maxLength: 80 },
      description: "Posting terms the base résumé already evidences." },
    claimed: { type: "array", maxItems: 40, items: { type: "string", minLength: 1, maxLength: 80 },
      description: "Posting terms the candidate has claimed. Never a term that is missing AND unclaimed." },
    verbs: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 80 } },
    competencies: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 80 } },
    phrases: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 80 },
      description: "Short responsibility phrases from the posting — never its sentences." },
    seniority: nullable({ type: "string", maxLength: 40 }),
    placements: { type: "array", maxItems: 30, items: obj({ term: { type: "string", minLength: 1, maxLength: 80 },
      employer: { type: "string", minLength: 1, maxLength: 120 } }),
      description: "1.7.0 · lean tailoring only: a posting term the résumé does not show, which the caller's knowledge base " +
        "shows in `employer`'s stack. It may be named only in a bullet of that employer. Sent with any other tailoring is a 400." },
    mustHave: { type: "array", maxItems: 40, items: { type: "string", minLength: 1, maxLength: 80 },
      description: "1.8.0 · payload / code only: the posting's required terms, in the posting's spelling." },
    niceToHave: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 80 },
      description: "1.8.0 · payload / code only: the posting's preferred / bonus terms." },
    broader: { type: "array", maxItems: 30, items: obj({ term: { type: "string", minLength: 1, maxLength: 80 },
      from: { type: "string", minLength: 1, maxLength: 80 } }),
      description: "1.8.0 · payload / code only: a posting term one of the résumé's own skills (`from`) implies. Code places it in Skills beside `from`." },
  }, { optional: ["matched", "claimed", "verbs", "competencies", "phrases", "seniority", "placements", "mustHave", "niceToHave", "broader"] }),

  Job: obj({ title: str, company: str, category: str, description: capped(INPUT_LIMITS.jobDescription, "The posting. Over the cap on a model route is a 400 — refused, never truncated (A97)."), stack: nullable(str), keywords: ref("JobKeywords") },
    { optional: ["company", "category", "description", "stack", "keywords"] }),

  GenerateRequest: obj({
    mode: enumOf("GENERATE", "A_PLUS"), domainModuleKey: str, roleFamily: str, domain: str,
    candidate: ref("Candidate"), profile: nullable(ref("JobProfile")), claims: nullable(ref("Claims")),
    employers: arr(str), job: ref("Job"),
    gists: { type: "array", maxItems: 12, items: obj({ employer: { type: "string", minLength: 1, maxLength: 200 }, text: { type: "string", maxLength: 400 } }),
      description: "1.8.0 · payload only: the per-employer gists POST /v1/resumes/gists returned (or the candidate's edit of them), keyed by the entry's header line." },
    coursework: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 80 },
      description: "1.8.0 · payload / code only: the candidate's own courses; code picks the most posting-relevant for a Relevant Coursework row." },
    baseResumeText: capped(INPUT_LIMITS.baseResumeText, "Over the cap is a 400 — refused, never truncated. The whole request is also capped at " +
      `${INPUT_LIMITS.generateRequestChars} characters (A97).`),
    // 1.5.0 (D70 Phase 3): `cache` — prompt-cache breakpoints on the system blocks. Default true.
    options: obj({ includeSummary: bool,
      cache: { type: "boolean", default: true, description: "Prompt-cache breakpoints on the static system blocks. " +
        "Absent or true: on (the default, and the request this route always sent). false: none — for a one-shot caller, " +
        "whose cache write would never be read." },
      // 1.5.0 (D70 Phase 1): which job context the prompt carries. Default "description" — the pinned prompt.
      jobContext: { type: "string", enum: ["description", "keywords"], default: "description",
        description: "description (default): the posting's text, as always. keywords: job.keywords instead — the posting's " +
          "text is not sent anywhere, even if job.description is present. keywords without job.keywords is a 400." },
      // 1.7.0 (D123 P2): the lean path — the model returns changes to bullets and skills only; code builds the document.
      tailoring: { type: "string", enum: ["full", "lean", "payload", "code"], default: "full",
        description: "full (default): the whole résumé is written by the model, as always. lean: Haiku edits bullets and skills " +
          "from job.keywords (required; the posting's text is not sent), one repair call on Sonnet after a failed check, " +
          "refused edits reverted to the candidate's own text. payload (1.8.0): lean's checks plus the job block and the gists; " +
          "the model rewords first and may write a new bullet a gist supports; no model is called when no bullet can gain. " +
          "code (1.8.0): no model — Skills order, broader terms, coursework and bullet order by code. mode GENERATE only." },
      model: { type: "string", enum: ["haiku", "sonnet", "open"],
        description: "1.8.0 · lean / payload only: the tailoring call's model for this request. open = the service's configured " +
          "OpenAI-compatible model; a 400 when it is not configured. Absent: the service's configured default." } },
      { optional: ["includeSummary", "cache", "jobContext", "tailoring", "model"] }),
  }, { optional: ["mode", "domainModuleKey", "roleFamily", "domain", "candidate", "profile", "claims", "employers", "options", "gists", "coursework"] }),
  GenerateResponse: obj({
    html: str, domainModuleKey: str,
    claimCheck: obj({ ok: { type: "boolean", enum: [true] }, inspected: ref("ClaimInspection") }),
    tailoring: obj({ mode: enumOf("lean", "payload", "code"), model: str, repaired: bool, changed: num, added: num, modelCalled: bool,
      refused: arr(obj({ id: str, kind: str })) }, { optional: ["added", "modelCalled"], description: "1.7.0 · present on an " +
      "editing answer only. `refused`: edits the checks reverted to the candidate's own text (kinds: number_not_in_bullet, " +
      "number_dropped, sole_ownership_claimed, term_wrong_employer, skill_not_supported, bullet_too_long, unreadable_answer; " +
      "1.8.0 adds new_bullet_without_gist, too_many_new_bullets, new_bullet_no_must_have, outside_gist, term_overused). " +
      "1.8.0: `added` new bullets (payload), `modelCalled` false when code alone tailored (payload / code); model \"none\" then." }),
    usage,
  }, { optional: ["tailoring"], description: "Only ever returned for a document that PASSED the claim guard." }),

  EnhanceRequest: obj({ resumeText: capped(INPUT_LIMITS.resumeText, "Over the cap is a 400 — refused, never truncated. The whole request is also capped at " +
      `${INPUT_LIMITS.enhanceRequestChars} characters (A97).`), profile: obj({ name: str, roleFamily: str, domain: str }, { optional: ["name", "roleFamily", "domain"] }),
    selectedAdditions: { type: "array", maxItems: INPUT_LIMITS.selectedAdditions, items: { type: "string", maxLength: INPUT_LIMITS.selectedAdditionChars } } },
    { optional: ["profile", "selectedAdditions"] }),
  EnhanceResponse: obj({ text: str, usage }),
  GistsRequest: obj({ baseResumeText: capped(INPUT_LIMITS.baseResumeText, "Over the cap is a 400 — refused, never truncated.") }),
  GistsResponse: obj({
    gists: arr(obj({ employer: str, text: str })),
    numberless: arr(obj({ employer: str, bullet: str })),
    usage,
  }, { description: "1.8.0 · `gists`: one per EXPERIENCE entry, keyed by its header line, no numbers; `numberless`: that entry's bullets that state no number, for the caller's optional prompt to add a real one." }),
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
      "resume_claim_violation", "resume_claim_not_inspected", "resume_unparsed", "upstream_model_failure", "model_unconfigured",
      "auth_unconfigured", "limit_exceeded", "internal_error"),
    message: str, retryable: bool, permanent: bool, violations: arr(ref("ClaimViolation")), usage,
  }, { optional: ["message", "retryable", "permanent", "violations", "usage"],
    description: "`retryable` is present on every model-backed and auth error. ⛔ A non-retryable failure says so: " +
      "`retryable: false` for an exhausted balance, a bad key or an unconfigured service. " +
      "resume_claim_violation carries `violations` and NEVER the document. " +
      "resume_unparsed (1.9.0, 422, permanent) — an editing tailoring's base is real text with no readable section heading." }),
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
  // 1.8.0 (D123 P6g): the per-employer gists — one Sonnet call, once per base résumé.
  { method: "post", path: "/v1/resumes/gists", auth: true, cost: "metered", request: ref("GistsRequest"),
    responses: { 200: ref("GistsResponse"), ...modelErrors } },
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
      "READ FROM THE RÉSUMÉ TEXT when no signalProfile is sent (A81): years of experience — the union of the dated " +
      "roles in its experience section, whole years rounded down (or a stated \"N years of experience\" when no role " +
      "is dated) — and a security clearance the résumé states is held (a hedged line such as \"eligible for\" or " +
      "\"able to obtain\" does not count). report.facts_from_text shows exactly what was read; the experience line " +
      "says where the years came from. If no dated roles were found the experience line says so — report that, " +
      "never \"lacks the experience\".",
      "⚠ CITIZENSHIP IS NEVER READ (report.facts_from_text.not_read). A \"U.S. citizenship\" entry in " +
      "hard_constraint_misses means the POSTING requires it and nothing confirmed it — not that the person lacks " +
      "it. Say \"the posting requires U.S. citizenship; check whether you meet it\". The same wording applies to a " +
      "clearance miss: the résumé did not state one as held. Do not ask the user for citizenship or clearance " +
      "status to fill these in.",
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
