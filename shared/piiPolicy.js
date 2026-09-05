// shared/piiPolicy.js
// PURPOSE: the field-level policy for a generation payload that may leave Anthropic (task F).
//
// ⛔ A WHITELIST, NOT A FILTER, AND THE DIFFERENCE IS THE WHOLE DESIGN.
//
// The alternative — take the payload we already build and strip PII out of it — fails SILENTLY.
// A regex that misses one email in one résumé leaks a real person's address into a training corpus
// with no error raised and no way to discover it afterwards. That is Shape 3 in the worst possible
// place, and this codebase has produced that shape repeatedly (matchScore null on every row; the
// guard blind to `//` in a URL; AH4's location vocabulary emptied by a cron).
//
// A whitelist fails CLOSED. A field nobody thought about is absent by construction rather than
// present by oversight, and adding one is an edit to this file — visible in a diff, next to the
// reason the list exists.
//
// ── THE THREE CLASSES ──────────────────────────────────────────────────────────────────────────
//
//   ALLOWED     may be sent as-is. Job text, and structural facts about the candidate that carry
//               no identity (years of experience, seniority, skill words).
//   TOKENIZED   may be sent, but only as a stable placeholder. Employers, teams, institutions —
//               the things that make a résumé coherent and also make it identifiable.
//   EXCLUDED    may NOT be sent in any form, INCLUDING as a token. A token still carries the
//               value: COMPANY_A can be looked up, but "work_auth: H-1B" tokenized to STATUS_1 is
//               still one bit about someone's immigration status leaving the building, and the
//               mapping travels with it.

/** Fields a tokenized generation payload may contain. Anything else is refused. */
export const GENERATION_FIELD_ALLOWLIST = Object.freeze(new Set([
  // The job. All of it is public — the company published it.
  "job_title", "job_company", "job_description", "job_category", "job_stack",
  // Structural facts about the candidate that are not identifying on their own.
  "years_of_experience", "seniority", "profile_keywords", "profile_tools", "profile_verbs",
  "claimed_skills", "claimed_verbs",
  // Tokenized structure. These keys hold TOKENS, never the underlying names — see tokenizer.js.
  "employer_tokens", "team_tokens", "institution_tokens", "resume_body",
  // Rendering instructions that contain no data about anyone.
  "mode", "include_summary",
]));

/**
 * ⛔ NEVER SENT, NOT EVEN TOKENIZED. Requirement 2, verbatim, plus the reason each is here.
 *
 * IMMIGRATION STATUS IS A SPECIAL CATEGORY in most frameworks, and the eligibility fields are not
 * needed at all: after AF2 the years figure comes from the PROFILE, so generation has no reason to
 * read work authorisation to decide what to write. Verified — buildRuntimeInputs never referenced
 * any of them.
 *
 * linkedin_url and github_url are the ones a "name, email, phone" mental model misses. They are
 * directly identifying, they are stable across every application a person ever makes, and the
 * CURRENT untokenized prompt sends both.
 */
export const EXCLUDED_FIELDS = Object.freeze(new Set([
  // Eligibility. Special category; and generation does not need them.
  "work_auth", "requires_sponsorship", "visa_type", "has_clearance", "clearance_level",
  // Protected characteristics. Never relevant to writing a résumé.
  "gender", "ethnicity", "veteran_status", "disability_status",
  // Directly identifying, and stable forever.
  "linkedin_url", "github_url", "address_line1", "address_line2", "zip", "phone", "email",
  // The name itself. The generated document needs it, but the MODEL does not — it is substituted
  // back in on return, exactly like an employer token.
  "full_name", "first_name", "last_name",
]));

/**
 * The whitelist assertion. Throws on the first field that is not allowed, naming it.
 *
 * Refuses rather than drops, deliberately: silently removing an unexpected field is how a payload
 * quietly stops carrying something the prompt depends on, and it would also mean the caller never
 * learns they built the wrong thing.
 */
export function assertOutboundFields(payload, { where = "outbound payload" } = {}) {
  const keys = Object.keys(payload || {});
  const excluded = keys.filter(k => EXCLUDED_FIELDS.has(k));
  if (excluded.length) {
    const e = new Error(
      `${where}: refusing to send EXCLUDED field(s) ${excluded.join(", ")}. ` +
      `These may not leave in any form, including tokenized — a token still carries the value. ` +
      `See shared/piiPolicy.js.`
    );
    e.code = "PII_EXCLUDED_FIELD";
    throw e;
  }
  const unknown = keys.filter(k => !GENERATION_FIELD_ALLOWLIST.has(k));
  if (unknown.length) {
    const e = new Error(
      `${where}: refusing to send field(s) not on the allow-list: ${unknown.join(", ")}. ` +
      `This is a WHITELIST — a field nobody has considered is refused rather than sent. ` +
      `If it is safe, add it to GENERATION_FIELD_ALLOWLIST in shared/piiPolicy.js with a reason.`
    );
    e.code = "PII_UNKNOWN_FIELD";
    throw e;
  }
  return true;
}

/** The two sets must never intersect, or the policy contradicts itself. Asserted by a test. */
export function policyIsConsistent() {
  for (const f of EXCLUDED_FIELDS) if (GENERATION_FIELD_ALLOWLIST.has(f)) return false;
  return true;
}
