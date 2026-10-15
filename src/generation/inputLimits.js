// ── A97 (10-14): INPUT CAPS ON THE MODEL ROUTES — REFUSED, NEVER TRUNCATED ─────────────────────
//
// Before this, baseResumeText and job.description reached Sonnet at whatever size the caller sent:
// the only bound was the 15 MB JSON body limit, so one request could bill millions of input tokens.
// These caps sit in the KERNEL (generateResume / enhanceResume), so the token API and the site's paid
// tools are bound by the same numbers, and they run BEFORE any model call — the classifier included.
//
// ⛔ REFUSE, DON'T TRUNCATE. A silently shortened résumé produces a document missing the candidate's
// later roles with nothing saying why; a 400 invalid_request naming the field and the limit tells the
// caller exactly what to fix. Lengths are JavaScript string lengths (UTF-16 code units) — the same
// thing a caller's `.length` reports.
//
// THE NUMBERS — generous on purpose; they bound abuse and accidents, not real documents:
//   · baseResumeText / resumeText  100,000 chars. A two-page résumé is ~5–8k chars; a long academic
//     CV with publications ~40–60k. 100k (~25–30k tokens, about $0.06 of Sonnet input) clears both.
//   · job.description               50,000 chars. A long posting with benefits and EEO boilerplate is
//     ~8–15k chars; 50k is three of those pasted together.
//   · selectedAdditions             100 items of ≤ 500 chars — draft sends a short list of labels.
//   · the whole request body         250,000 chars for generate, 200,000 for enhance — the named caps
//     plus generous headroom for everything else (candidate, claims, keywords, profile), so no OTHER
//     field can carry the bulk the named caps keep out.
// Change a number here and docs/API.md and the contract (src/contract/endpoints.js) move with it;
// test/a97SpendControls.test.js pins all three.
import { InvalidRequestError } from "../errors.js";

export const INPUT_LIMITS = Object.freeze({
  baseResumeText: 100_000,
  jobDescription: 50_000,
  resumeText: 100_000,
  selectedAdditions: 100,
  selectedAdditionChars: 500,
  generateRequestChars: 250_000,
  enhanceRequestChars: 200_000,
});

const n = (x) => x.toLocaleString("en-US");
const REFUSED = "Nothing was sent to the model; it is refused, never truncated.";

/** Throws InvalidRequestError when a string field is over its cap. Non-strings are left to the caller's own checks. */
export function capString(value, limit, name) {
  if (typeof value === "string" && value.length > limit) {
    throw new InvalidRequestError(`${name} is ${n(value.length)} characters; the limit is ${n(limit)} characters. ${REFUSED}`);
  }
}

/** The whole request, serialised: bounds every field the named caps do not. */
export function capRequest(input, limit, what) {
  let size = 0;
  try { size = JSON.stringify(input ?? {}).length; } catch { size = Infinity; }
  if (size > limit) {
    throw new InvalidRequestError(`the request is ${Number.isFinite(size) ? n(size) : "too many"} characters; the limit for ${what} is ${n(limit)}. ${REFUSED}`);
  }
}
