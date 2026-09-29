// The deterministic tools — ONE implementation, two envelopes.
//
// POST /v1/ats/score, POST /v1/resumes/format and the MCP tools at /mcp all call these functions.
// Before E1 the bodies lived inline in the route handlers; an MCP server that re-implemented them
// would have been a second implementation, and a second implementation drifts — the same reason
// the MCP schemas are generated from the HTTP contract rather than written beside it.
//
// ⛔ NOTHING HERE CAN REACH A MODEL. No import below leads to src/model/ or src/generation/;
// test/mcp.test.js walks this file's import graph and fails if one ever does.
import { scoreAtsLocally, buildRuntimeAtsBasis } from "@draft/ats-scorer";
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
  const runtimeBasis = buildRuntimeAtsBasis({ resumeText, signalProfile, domainProfile, claims });
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
