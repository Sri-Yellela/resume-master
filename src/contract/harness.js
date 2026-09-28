// ⛔ THE ENVELOPE HARNESS — the deliverable of A3, not the schema file.
//
// Drives the real app over real HTTP through every endpoint and every declared outcome, and checks
// each REAL response against the contract:
//   1. it is JSON (an HTML 200 is the SPA-catch-all false finding this project has had five times)
//   2. its status is one the contract declares for that route
//   3. every key and value type it carries is declared (real -> declared; see schema.js conforms)
// and, across the whole run, that every declared (route, status) pair was exercised at least once —
// so no declaration survives on never having been checked.
//
// The same scenarios run in-process against a fake model client (test/contractEnvelope.test.js,
// every `npm test`) and live against a deployed service with a real token
// (scripts/verifyContract.mjs). Live runs only scenarios marked `live`; paid ones also need `metered`.
import { ENDPOINTS, NOT_FOUND } from "./endpoints.js";
import { conforms } from "./schema.js";

const PHONE = "555-867-5309";
export const BASE_RESUME = `JANE DOE ${PHONE}
SUMMARY
Software Engineer with 4 years building distributed systems.
EXPERIENCE
Stripe — Software Engineer
- Built payment services`;
const honestHtml = (years = 4) => `<html><body><div class="header"><div class="name">JANE DOE</div></div>` +
  `<div class="section-title">SUMMARY</div><p>Software Engineer with ${years} years building distributed systems.</p>` +
  `<div class="section-title">EXPERIENCE</div><div class="entry"><div class="entry-org">Stripe</div>` +
  `<div class="entry-role">Software Engineer</div><ul class="bullets"><li>Built payment services</li></ul></div></body></html>`;
// A REAL one-page PDF with a line of text. ⛔ This replaced a zero-page stub whose comment called it
// "well-formed": it passed this service's own header check and every in-process test, and the model
// provider rejected it as "not valid" on the first live run (Phase B). The xref offsets are COMPUTED,
// not hand-written, because a wrong offset is exactly the invalidity a strict parser rejects.
function buildOnePagePdf(text) {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1").toString("base64");
}
export const TINY_PDF_BASE64 = buildOnePagePdf("JANE DOE - Software Engineer - Built payment services");
// A document the provider rejects: a PDF header and nothing a parser can use. Its failure must be
// PERMANENT — retrying an invalid document fails identically every time.
export const INVALID_PDF_BASE64 = Buffer.from("%PDF-1.4\nnot a document\n%%EOF\n").toString("base64");

const GENERATE = {
  mode: "GENERATE", domainModuleKey: "engineering", baseResumeText: BASE_RESUME,
  candidate: { fullName: "Jane Doe", yearsOfExperience: 4, phone: PHONE },
  profile: { name: "Backend", seniority: "mid", keywords: [], tools: [], actionVerbs: [] },
  job: { title: "Backend Engineer", company: "Acme", description: "Build services in Go." },
};
const ATS_JOB = { title: "Backend Engineer", company: "Acme", description: "Python, Kubernetes, Kafka, Terraform and AWS.",
  skills_json: JSON.stringify(["Python", "Kubernetes", "Kafka", "Terraform", "AWS"].map(skill => ({ skill, type: "hard" }))) };
const OVERSIZE = "x".repeat(16 * 1024 * 1024);

const permanent = () => Object.assign(new Error("400 Your credit balance is too low to access the Anthropic API."), { status: 400 });
const transient = () => Object.assign(new Error("overloaded_error"), { status: 529 });
// The provider's real answer to an invalid PDF, captured in Phase B's first live run.
const rejectedDocument = () => Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error",' +
  '"message":"messages.0.content.0.pdf.source.base64.data: The PDF specified was not valid."}}'), { status: 400 });

/**
 * One scenario = one real request. Fields:
 *   route    "METHOD /path" in ENDPOINTS, or null for an unknown path
 *   status   the status the scenario must produce
 *   body | raw   the request body (raw = a literal string, for malformed JSON / oversize)
 *   auth     "valid" (default on authed routes) | "none" | "wrong"
 *   model    in-process only: text the fake model returns, or an Error to throw, or "none" = no client
 *   service  in-process only: "no-clients" | "refuse-limits"
 *   expect   extra assertions on the parsed body
 *   live     safe to run against a deployed service; `metered` = spends money
 */
export const SCENARIOS = [
  { name: "health", route: "GET /health", status: 200, live: true },
  { name: "version names the service", route: "GET /v1/version", status: 200, live: true,
    expect: b => b.service === "resume-master" || "service is not resume-master" },
  { name: "unknown GET is a JSON 404, never a page", path: "/api/config", method: "get", status: 404, live: true },
  { name: "the root is a JSON 404", path: "/", method: "get", status: 404, live: true },
  { name: "unknown POST under /v1 is a JSON 404", path: "/v1/nope", method: "post", body: {}, status: 404, live: true },

  // format — free
  { name: "format", route: "POST /v1/resumes/format", body: { html: "JANE DOE\nSUMMARY\nBuilt things." }, status: 200, live: true },
  { name: "format: missing html", route: "POST /v1/resumes/format", body: {}, status: 400, live: true },
  { name: "format: no token", route: "POST /v1/resumes/format", auth: "none", body: { html: "x" }, status: 401, live: true },
  { name: "format: wrong token", route: "POST /v1/resumes/format", auth: "wrong", body: { html: "x" }, status: 401, live: true },
  { name: "format: oversize body", route: "POST /v1/resumes/format", raw: JSON.stringify({ html: OVERSIZE }), status: 413 },
  { name: "format: no clients configured fails closed", route: "POST /v1/resumes/format", service: "no-clients", body: { html: "x" }, status: 503,
    expect: b => b.error === "auth_unconfigured" && b.retryable === false || "expected auth_unconfigured, retryable false" },

  // ats/score — free
  { name: "ats: weighted", route: "POST /v1/ats/score", status: 200, live: true,
    body: { job: ATS_JOB, resumeText: "Python Kubernetes engineer", termWeights: [["kafka", 3], ["python", 0.5]] },
    expect: b => b.report.weighting.applied === true || "weights were not applied" },
  { name: "ats: declined for want of signal", route: "POST /v1/ats/score", status: 200, live: true,
    body: { job: { title: "Role", description: "Join us." }, resumeText: "Python" },
    expect: b => b.report.score === null || "a declined report must carry score null, never 0" },
  { name: "ats: seniority cap", route: "POST /v1/ats/score", status: 200, live: true,
    body: { job: { ...ATS_JOB, title: "Backend Engineer Intern" }, resumeText: "Python Kubernetes Kafka Terraform AWS", domainProfile: { seniority: "senior" } },
    expect: b => b.report.seniority_cap.applied === true || "cap did not apply" },
  { name: "ats: a plain-object termWeights is refused, not scored unweighted", route: "POST /v1/ats/score", status: 400, live: true,
    body: { job: ATS_JOB, resumeText: "x", termWeights: { kafka: 3 } } },
  { name: "ats: no token", route: "POST /v1/ats/score", auth: "none", body: {}, status: 401, live: true },
  { name: "ats: no clients configured", route: "POST /v1/ats/score", service: "no-clients", body: {}, status: 503 },
  { name: "ats: oversize", route: "POST /v1/ats/score", raw: JSON.stringify({ resumeText: OVERSIZE }), status: 413 },

  // generate — metered
  { name: "generate: honest document", route: "POST /v1/resumes/generate", body: GENERATE, model: honestHtml(4), status: 200,
    expect: b => b.claimCheck.inspected.documentChars > 0 || "the guard read nothing" },
  { name: "generate: REAL generation", route: "POST /v1/resumes/generate", body: GENERATE, status: 200, live: true, metered: true, inProcess: false },
  { name: "generate: claim violation withholds the document", route: "POST /v1/resumes/generate", body: GENERATE, model: honestHtml(9), status: 422,
    expect: b => (b.html === undefined && b.violations?.length > 0 && b.retryable === true) || "422 must carry violations and NO document" },
  { name: "generate: unread document refused", route: "POST /v1/resumes/generate", body: GENERATE, model: "", status: 502,
    expect: b => b.error === "resume_claim_not_inspected" || "expected resume_claim_not_inspected" },
  { name: "generate: permanent upstream failure says so", route: "POST /v1/resumes/generate", body: GENERATE, model: permanent, status: 502,
    expect: b => (b.retryable === false && b.permanent === true) || "an exhausted balance must be retryable:false" },
  { name: "generate: transient upstream failure", route: "POST /v1/resumes/generate", body: GENERATE, model: transient, status: 502,
    expect: b => b.retryable === true || "a 529 must be retryable" },
  { name: "generate: no model key", route: "POST /v1/resumes/generate", body: GENERATE, model: "none", status: 503,
    expect: b => (b.error === "model_unconfigured" && b.retryable === false) || "expected model_unconfigured, retryable false" },
  { name: "generate: invalid request, refused before spend", route: "POST /v1/resumes/generate", body: { job: { title: "E" } }, status: 400, live: true },
  { name: "generate: malformed JSON", route: "POST /v1/resumes/generate", raw: "{\"baseResumeText\":", status: 400, live: true,
    expect: b => b.error === "invalid_json" || "expected invalid_json" },
  { name: "generate: no token", route: "POST /v1/resumes/generate", auth: "none", body: GENERATE, status: 401, live: true },
  { name: "generate: oversize", route: "POST /v1/resumes/generate", raw: JSON.stringify({ baseResumeText: OVERSIZE }), status: 413 },
  { name: "generate: limit policy refuses before spend", route: "POST /v1/resumes/generate", service: "refuse-limits", body: GENERATE, model: honestHtml(4), status: 429 },
  { name: "generate: no clients configured", route: "POST /v1/resumes/generate", service: "no-clients", body: GENERATE, status: 503 },

  // enhance — metered
  { name: "enhance", route: "POST /v1/resumes/enhance", body: { resumeText: BASE_RESUME, profile: { name: "Backend" }, selectedAdditions: ["Kafka"] }, model: "Enhanced text", status: 200 },
  { name: "enhance: REAL", route: "POST /v1/resumes/enhance", body: { resumeText: BASE_RESUME, profile: { name: "Backend" } }, status: 200, live: true, metered: true, inProcess: false },
  { name: "enhance: missing resumeText", route: "POST /v1/resumes/enhance", body: {}, status: 400, live: true },
  { name: "enhance: no token", route: "POST /v1/resumes/enhance", auth: "none", body: {}, status: 401, live: true },
  { name: "enhance: oversize", route: "POST /v1/resumes/enhance", raw: JSON.stringify({ resumeText: OVERSIZE }), status: 413 },
  { name: "enhance: limit refused", route: "POST /v1/resumes/enhance", service: "refuse-limits", body: { resumeText: "x" }, status: 429 },
  { name: "enhance: upstream failure", route: "POST /v1/resumes/enhance", body: { resumeText: "x" }, model: permanent, status: 502 },
  { name: "enhance: no model key", route: "POST /v1/resumes/enhance", body: { resumeText: "x" }, model: "none", status: 503 },

  // parse-pdf — metered
  { name: "parse-pdf", route: "POST /v1/resumes/parse-pdf", body: { pdfBase64: TINY_PDF_BASE64 }, model: "JANE DOE\nSUMMARY", status: 200 },
  { name: "parse-pdf: REAL", route: "POST /v1/resumes/parse-pdf", body: { pdfBase64: TINY_PDF_BASE64 }, status: 200, live: true, metered: true, inProcess: false },
  { name: "parse-pdf: not a PDF", route: "POST /v1/resumes/parse-pdf", body: { pdfBase64: Buffer.from("hello").toString("base64") }, status: 400, live: true },
  { name: "parse-pdf: no token", route: "POST /v1/resumes/parse-pdf", auth: "none", body: {}, status: 401, live: true },
  { name: "parse-pdf: oversize", route: "POST /v1/resumes/parse-pdf", raw: JSON.stringify({ pdfBase64: OVERSIZE }), status: 413 },
  { name: "parse-pdf: limit refused", route: "POST /v1/resumes/parse-pdf", service: "refuse-limits", body: { pdfBase64: TINY_PDF_BASE64 }, status: 429 },
  { name: "parse-pdf: upstream failure", route: "POST /v1/resumes/parse-pdf", body: { pdfBase64: TINY_PDF_BASE64 }, model: transient, status: 502 },
  { name: "parse-pdf: a document the provider rejects is PERMANENT", route: "POST /v1/resumes/parse-pdf",
    body: { pdfBase64: INVALID_PDF_BASE64 }, model: rejectedDocument, status: 502,
    expect: b => (b.permanent === true && b.retryable === false) || "an invalid document must never be reported retryable" },
  { name: "parse-pdf: no model key", route: "POST /v1/resumes/parse-pdf", body: { pdfBase64: TINY_PDF_BASE64 }, model: "none", status: 503 },
];

const endpointFor = (route) => ENDPOINTS.find(e => `${e.method.toUpperCase()} ${e.path}` === route);

/**
 * Checks one real response against the contract. Returns a list of problems; empty = conforms.
 */
export function checkResponse(scenario, response, components) {
  const problems = [];
  if (!/^application\/json\b/.test(response.contentType || "")) {
    return [`answered ${response.status} with ${response.contentType || "no content-type"} — not JSON`];
  }
  const declared = scenario.route ? endpointFor(scenario.route)?.responses : NOT_FOUND;
  if (!declared) return [`route ${scenario.route} is not in the contract`];
  if (response.status !== scenario.status) problems.push(`status ${response.status}, scenario expects ${scenario.status}`);
  const schema = declared[response.status];
  if (!schema) problems.push(`status ${response.status} is not declared for ${scenario.route || "unknown paths"}`);
  else problems.push(...conforms(response.body, schema, components));
  if (scenario.expect && problems.length === 0) {
    const r = scenario.expect(response.body);
    if (r !== true) problems.push(`expectation failed: ${r}`);
  }
  return problems;
}

/** Declared (route, status) pairs no scenario exercises. */
export function uncovered(scenarios) {
  const hit = new Set(scenarios.map(s => `${s.route ?? "UNKNOWN"} ${s.status}`));
  const missing = [];
  for (const e of ENDPOINTS) for (const status of Object.keys(e.responses)) {
    const key = `${e.method.toUpperCase()} ${e.path} ${status}`;
    if (!hit.has(key)) missing.push(key);
  }
  for (const status of Object.keys(NOT_FOUND)) if (!hit.has(`UNKNOWN ${status}`)) missing.push(`UNKNOWN ${status}`);
  return missing;
}

export function requestFor(scenario) {
  const [method, path] = scenario.route ? scenario.route.split(" ") : [scenario.method.toUpperCase(), scenario.path];
  const body = scenario.raw ?? (scenario.body === undefined ? undefined : JSON.stringify(scenario.body));
  return { method, path, body };
}
