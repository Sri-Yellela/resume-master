// The DECLARED half of the contract: envelopes and the endpoint table.
//
// Envelopes are built inline in the route handlers, so they are declared — but every envelope that
// carries a derived shape REFERENCES it ($AtsReport, $UsageRecord, $ClaimViolation, …) and never
// restates a field of it. What keeps these honest is test/contractEnvelope.test.js: it boots the
// real app and drives every endpoint through every declared outcome, checking every key and every
// value type a real response carries against what is declared here.
import { str, num, bool, arr, obj, ref, nullable, enumOf } from "./schema.js";

export const CONTRACT_VERSION = "1.0.0";

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
const authErrors = { 401: E, 503: E };
const modelErrors = { 400: E, ...authErrors, 413: E, 429: E, 502: E };

/** method, path, auth, request, responses (status -> schema) — the table the harness covers. */
export const ENDPOINTS = [
  { method: "get", path: "/health", auth: false, responses: { 200: ref("Health") } },
  { method: "get", path: "/v1/version", auth: false, responses: { 200: ref("Version") } },
  { method: "post", path: "/v1/resumes/format", auth: true, cost: "free", request: ref("FormatRequest"),
    responses: { 200: ref("FormatResponse"), 400: E, 413: E, ...authErrors } },
  { method: "post", path: "/v1/ats/score", auth: true, cost: "free", request: ref("AtsScoreRequest"),
    responses: { 200: ref("AtsScoreResponse"), 400: E, 413: E, ...authErrors } },
  { method: "post", path: "/v1/resumes/generate", auth: true, cost: "metered", request: ref("GenerateRequest"),
    responses: { 200: ref("GenerateResponse"), 422: E, ...modelErrors } },
  { method: "post", path: "/v1/resumes/enhance", auth: true, cost: "metered", request: ref("EnhanceRequest"),
    responses: { 200: ref("EnhanceResponse"), ...modelErrors } },
  { method: "post", path: "/v1/resumes/parse-pdf", auth: true, cost: "metered", request: ref("ParsePdfRequest"),
    responses: { 200: ref("ParsePdfResponse"), ...modelErrors } },
];

/** Any path not in the table. */
export const NOT_FOUND = { 404: E };
