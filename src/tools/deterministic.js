// The deterministic tools — ONE implementation, two envelopes.
//
// POST /v1/ats/score, POST /v1/resumes/format and the MCP tools at /mcp all call these functions.
// Before E1 the bodies lived inline in the route handlers; an MCP server that re-implemented them
// would have been a second implementation, and a second implementation drifts — the same reason
// the MCP schemas are generated from the HTTP contract rather than written beside it.
//
// ⛔ NOTHING HERE CAN REACH A MODEL. No import below leads to src/model/ or src/generation/;
// test/mcp.test.js walks this file's import graph and fails if one ever does.
import { scoreAtsLocally, buildRuntimeAtsBasis, scoreContextual, resolveContextualWeights, CONTEXTUAL_CONTRACT } from "@draft/ats-scorer";
import { normalizeResumeHtml } from "../formatting/resumeFormatter.js";
import { InvalidRequestError } from "../errors.js";

/** JSON has no Map. Weights and synonyms arrive as [key, value] pairs and become Maps explicitly. */
export function mapFromPairs(v, name) {
  if (v == null) return null;
  if (!Array.isArray(v) || !v.every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === "string")) {
    throw new InvalidRequestError(`${name} must be an array of [string, value] pairs`);
  }
  return new Map(v);
}

/** AtsScoreRequest -> { report: AtsReport }. Throws InvalidRequestError on a caller mistake. */
export function scoreAts(body) {
  const { job, resumeText, signalProfile = {}, domainProfile = {}, claims = null } = body || {};
  if (!job || typeof job !== "object") throw new InvalidRequestError("job is required");
  if (typeof resumeText !== "string") throw new InvalidRequestError("resumeText is required");
  // A81: a caller with no signalProfile — an AI assistant over /mcp sends only job + resumeText — gets
  // its years read from the résumé's dated roles and a clearance the résumé states it holds, instead of
  // "years are not set" and an automatic clearance miss. A caller that sends a profile is scored exactly
  // as before. ⛔ Citizenship is never read from text (the scorer's rule; report.facts_from_text.not_read).
  const factsFromText = body.signalProfile == null;
  const runtimeBasis = buildRuntimeAtsBasis({ resumeText, signalProfile, domainProfile, claims, factsFromText });
  try {
    const report = scoreAtsLocally({
      job, runtimeBasis,
      termWeights: mapFromPairs(body.termWeights, "termWeights"),
      synonyms: mapFromPairs(body.synonyms, "synonyms"),
    });
    return { report };
  } catch (e) {
    // The scorer's own refusal of a mis-shaped Map is the caller's mistake, not an outage.
    if (e instanceof TypeError && /termWeights|synonyms/.test(e.message)) throw new InvalidRequestError(e.message);
    throw e;
  }
}

// ── ATS contract 2.0.0 (draft's WORKLOG D192): the v1 report UNCHANGED, plus the contextual score beside it ──────────
// POST /v1/ats/score keeps answering exactly as before; POST /v2/ats/score answers { contract, report, contextual, company }.
// The caller sends what it knows: posting / resume placements (category, subcategory, level), company.techStack and
// company.industry. draft always sends them. When company.techStack is ABSENT (a caller with no data of its own, or this
// site), the company's name — company.name, job.company, or read from the posting — is looked up (src/tools/companyLookup.js).
// An EMPTY array means "the caller knows of none": no lookup, tech_stack is no_data.

/** "… at Kestrel Payments, we …" / "About Kestrel Payments" → the name. A guess for the lookup only; null when unsure. */
export function companyNameFromPosting(text) {
  const t = String(text || "");
  const about = /^\s*About\s+([A-Z][A-Za-z0-9&.'\-]*(?:\s+[A-Z][A-Za-z0-9&.'\-]*){0,3})\s*:?\s*$/m.exec(t);
  if (about && !/^(the|us|you|this)$/i.test(about[1])) return about[1].trim();
  const at = /\b(?:[Aa]t|[Jj]oin)\s+([A-Z][A-Za-z0-9&.'\-]+(?:\s+[A-Z][A-Za-z0-9&.'\-]+){0,3})(?=[,.!]|\s+(?:we|is|are|you)\b)/.exec(t);
  return at ? at[1].trim() : null;
}

const NL = String.fromCharCode(10);
const placementOf = (p, name) => {
  if (p == null) return {};
  if (typeof p !== "object" || Array.isArray(p)) throw new InvalidRequestError(`${name} must be an object`);
  const out = {};
  for (const k of ["category", "subcategory", "level"]) {
    if (p[k] != null && typeof p[k] !== "string") throw new InvalidRequestError(`${name}.${k} must be a string`);
    if (p[k]) out[k] = p[k];
  }
  if (p.also?.subcategory && typeof p.also.subcategory === "string") out.also = { subcategory: p.also.subcategory };
  return out;
};

/** AtsScoreV2Request -> { contract, report, contextual, company }. `lookupCompany` = createCompanyLookup(), or null. */
export async function scoreAtsV2(body, { lookupCompany = null } = {}) {
  const { report } = scoreAts(body);
  const b = body || {};
  let weights = null;
  try { weights = b.weights == null ? null : resolveContextualWeights(b.weights); }
  catch (e) { throw new InvalidRequestError(e.message); }
  const posting = { ...placementOf(b.posting, "posting"), text: [b.job.title, b.job.description, b.job.requirements].filter(x => typeof x === "string").join(NL) };
  const resume = { ...placementOf(b.resume, "resume"), text: b.resumeText };
  if (b.company != null && (typeof b.company !== "object" || Array.isArray(b.company))) throw new InvalidRequestError("company must be an object");
  if (b.company?.techStack != null && !Array.isArray(b.company.techStack)) throw new InvalidRequestError("company.techStack must be an array");
  let company = null, source = "none";
  if (Array.isArray(b.company?.techStack)) {
    company = { industry: typeof b.company.industry === "string" ? b.company.industry : null,
      techStack: b.company.techStack.filter(t => t && typeof t.name === "string" && typeof t.postingShare === "number") };
    source = "request";
  } else if (lookupCompany) {
    const name = b.company?.name || b.job.company || companyNameFromPosting(b.job.description);
    const found = name ? await lookupCompany(name) : null;
    if (found?.matched) { company = { industry: found.industry, techStack: found.techStack }; source = "lookup"; }
    else if (typeof b.company?.industry === "string") { company = { industry: b.company.industry, techStack: [] }; source = "request"; }
  } else if (typeof b.company?.industry === "string") { company = { industry: b.company.industry, techStack: [] }; source = "request"; }
  const contextual = scoreContextual({ skillMatch: report.score, skillsBoth: report.tier1_matched || [], posting, resume, company, weights });
  return { contract: CONTEXTUAL_CONTRACT, report, contextual, company: { source } };
}

/** FormatRequest -> { html }. */
export function formatResume(body) {
  const { html } = body || {};
  if (typeof html !== "string" || !html.trim()) throw new InvalidRequestError("html is required");
  return { html: normalizeResumeHtml(html) };
}

// ── "Not enough signal" is a STATE, not a number ─────────────────────────────────────────────────
//
// The scorer declines (score null, scorable false, decline_reasons) rather than guess. Over HTTP the
// caller is a product that reads `scorable`. Over MCP the caller is a model that may paraphrase the
// output as its own conclusion — and "score: null" paraphrased is "your fit is low", which converts
// a refusal into a fabrication in a layer this service cannot see. So the MCP envelope carries the
// state as its own discriminant, with its meaning in words beside it.
//
// ⛔ CONSERVATIVE BY CONSTRUCTION: only an explicitly scorable report with a numeric score is
// "scored". Anything else — including a shape this code has never seen — is not_enough_signal.
export const ATS_OUTCOME = Object.freeze({ SCORED: "scored", NOT_ENOUGH_SIGNAL: "not_enough_signal" });

export const ATS_MEANING = Object.freeze({
  scored: "Scored: `score` is 0-100 for this résumé against this posting. No band is included; what counts as a " +
    "strong score is the calling product's decision — do not invent one.",
  not_enough_signal: "NOT ENOUGH SIGNAL — the scorer DECLINED to score. This is NOT a low score and NOT a poor fit: " +
    "the posting or résumé carried too few scorable terms to measure fit at all (see report.decline_reasons). " +
    "Do not present it as a score, percentage, band or verdict. Say it could not be scored and why, and ask for " +
    "the full job description or fuller résumé text.",
});

export function atsOutcome(report) {
  const scored = report?.scorable === true && typeof report?.score === "number";
  const outcome = scored ? ATS_OUTCOME.SCORED : ATS_OUTCOME.NOT_ENOUGH_SIGNAL;
  return { outcome, score: scored ? report.score : null, meaning: ATS_MEANING[outcome], report };
}
