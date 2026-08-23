/**
 * ATS hostnames, and the rule that one is never an employer's name (TASK AE3).
 *
 * THE DEFECT THIS EXISTS FOR
 * The review modal's header read "JOBS.ASHBYHQ.COM — 1 APPLICATION" for a posting whose card, three
 * pixels away, correctly said OpenAI. Not a missing-company fallback: the popup had been opened from
 * a PORTAL batch, and a portal is defined by its origin, so its scope label was built out of the
 * host. The row qualified as a portal batch only because it had been misclassified as a gate — but
 * the label was wrong independently of that, and would be wrong for any real gate too.
 *
 * `jobs.ashbyhq.com` is not an employer. It is Ashby's multi-tenant apply host, and every one of
 * these hosts serves hundreds of unrelated companies — so a hostname in a company position is not
 * merely ugly, it merges employers that have nothing to do with each other and names none of them.
 *
 * WHY A LIST HERE AND NOT A SHAPE TEST
 * "Looks like a hostname" cannot be the rule. Booking.com, Match.com and Care.com are companies
 * whose names contain a dot and no spaces, and a shape heuristic would render all three as unknown.
 * The set of multi-tenant ATS hosts is small, known, and already written down twice in this
 * codebase, so it is enumerated — and test/applyCompanyAttribution.test.js asserts this list covers
 * every host in platformDetector's URL_ATS_MAP and every source in DIRECT_ATS_SOURCES, so onboarding
 * a provider cannot leave a hole here. That is the same guard-on-a-guard idiom
 * `uncoveredDirectAtsSources()` already uses.
 *
 * It lives in shared/ because both sides need it: the panel decides what to render, and the server
 * decides what to store.
 */

/**
 * Multi-tenant ATS hosts and the bare provider names that identify them. Matched as a SUFFIX so
 * `jobs.ashbyhq.com`, `boards.greenhouse.io` and `acme.myworkdayjobs.com` are all caught without
 * enumerating tenants.
 */
export const ATS_HOST_SUFFIXES = Object.freeze([
  "greenhouse.io", "grnh.se",
  "lever.co",
  "ashbyhq.com", "ashby.com",
  "myworkdayjobs.com", "workday.com",
  "icims.com",
  "taleo.net",
  "jobvite.com",
  "smartrecruiters.com",
  "workable.com",
  "bamboohr.com",
  "recruitee.com",
  "linkedin.com",
]);

/** The provider names themselves. A source name is not a display name either. */
export const ATS_PROVIDER_NAMES = Object.freeze([
  "greenhouse", "lever", "ashby", "workday", "icims", "taleo", "jobvite",
  "smartrecruiters", "workable", "bamboohr", "recruitee", "linkedin",
]);

/** What a company with no name is called. Never a hostname, and never blank. */
export const UNKNOWN_COMPANY = "Unknown company";

/**
 * True when a candidate display name is really an ATS, not an employer.
 *
 * Deliberately strict about what counts: a bare provider name ("ashby"), or a host whose last
 * labels are one of the suffixes above. "Ashby Systems Ltd" is a company and is not matched, because
 * the provider-name check requires the WHOLE string.
 */
export function isAtsHost(name) {
  const s = String(name ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!s) return false;
  if (ATS_PROVIDER_NAMES.includes(s)) return true;
  return ATS_HOST_SUFFIXES.some(h => s === h || s.endsWith("." + h));
}

/**
 * The ONE place a company becomes display text.
 *
 * Every heading, tile and modal title goes through here, which is what makes "an ATS host can never
 * appear as a company name" a property of the product rather than a promise about call sites. A
 * blank, a whitespace-only value and an ATS host all come back as UNKNOWN_COMPANY — saying we do not
 * know is honest, and is the same rule enrichment's null columns follow: absence of evidence is
 * reported as absence, never as a confident wrong answer.
 */
export function companyLabel(company) {
  const s = String(company ?? "").trim();
  if (!s || isAtsHost(s)) return UNKNOWN_COMPANY;
  return s;
}
