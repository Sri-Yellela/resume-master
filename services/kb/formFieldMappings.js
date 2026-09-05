/**
 * services/kb/formFieldMappings.js — label → field mappings derived from captured form structure (H).
 *
 * PLATFORM_LABEL_MAPS is hand-written for greenhouse, lever and workday; every other ATS falls
 * through to `generic`. G4's capture collects real form STRUCTURE from live pages, so the mapping
 * can be derived from what employers actually label their fields instead of authored one ATS at a
 * time.
 *
 * ⛔ THIS PRODUCES A TABLE. IT DOES NOT PUT A MODEL IN THE FILL PATH. buildAnswers stays
 * deterministic — Jobo's integration terms say "No AI-generated answers" and §7 says the same.
 * Nothing in this module calls a model, and a test asserts it.
 *
 * ── THE HARD BOUNDARY ──────────────────────────────────────────────────────────────────────────
 *
 * NO ELIGIBILITY FIELD MAY BE MAPPED BY THIS TABLE. Not "should not" — cannot: recordMappingProposal
 * REFUSES them, so the row cannot exist to be confirmed later. Work authorisation, sponsorship,
 * clearance, visa, criminal history, EEO and years of experience resolve by EXACT HANDLER MAPPING or
 * not at all.
 *
 * Two live defects say why, and both are label matching getting clever near an attestation:
 *
 *   · `login_email`, labelled "Email", resolved to the email handler and typed the candidate's home
 *     address into a portal's SIGN-IN box at 0.9 confidence — the second-highest tier. The legacy
 *     sweep also wrote to the PASSWORD field, because its type-exclusion list never included
 *     password.
 *   · A `work_authorization` key substring-matched "do you now or in the future require sponsorship
 *     for work authorization". That question is semantically INVERTED: answering it from the
 *     work-authorization value is a materially false attestation to an employer.
 *
 * A derived table is a label matcher with more data behind it. More data does not make an inverted
 * question answerable, so the eligibility classes are excluded by construction rather than by
 * threshold.
 */

import { normaliseAtsTerm } from "../localAtsScorer.js";

/**
 * ⛔ Field keys this table may NEVER map, whatever the evidence.
 *
 * Matched on the FIELD KEY, not the label: a label can be phrased a thousand ways, and the thing
 * being protected is the answer, which is identified by its key.
 */
export const EXCLUDED_FIELD_KEYS = Object.freeze(new Set([
  // Eligibility and attestations.
  "work_authorization", "work_auth", "requires_sponsorship", "sponsorship", "visa_type",
  "clearance_level", "has_clearance", "security_clearance", "criminal_history", "conviction",
  "years_experience", "years_of_experience",
  // EEO / protected characteristics.
  "gender", "ethnicity", "race", "veteran_status", "disability_status", "eeo",
  // Credentials. A sign-in box is not an application field, and this is the login_email defect.
  "password", "login_email", "username", "current_password", "new_password",
]));

/** Label shapes that indicate an attestation even when the proposed key looks innocuous. */
const ELIGIBILITY_LABEL_RE =
  /\b(?:sponsor|sponsorship|visa|work\s*auth|authori[sz]ed?\s+to\s+work|clearance|felony|convict|criminal|citizen|veteran|disabilit|gender|ethnic|race|eeo|years?\s+of\s+experience)\b/i;

/** Password/sign-in shapes, matched on label as well as key — the login_email case had a clean label. */
const CREDENTIAL_LABEL_RE = /\b(?:password|sign[\s-]?in|log[\s-]?in|username)\b/i;

/**
 * Is this mapping forbidden? Returns a reason string, or null when it is allowed.
 *
 * BOTH SIDES ARE CHECKED. The key catches a correctly-identified eligibility field; the label
 * catches a mapping that proposes an innocuous key for an attestation question — which is exactly
 * the sponsorship-inversion shape, where the question is about sponsorship and the key was
 * `work_authorization`.
 */
export function forbiddenMapping(label, fieldKey) {
  const key = String(fieldKey || "").trim().toLowerCase();
  const text = String(label || "");
  if (!key || !text.trim()) return "empty label or field key";
  if (EXCLUDED_FIELD_KEYS.has(key)) {
    return `"${key}" is an eligibility, EEO or credential field — it resolves by exact handler ` +
           `mapping or not at all`;
  }
  if (ELIGIBILITY_LABEL_RE.test(text)) {
    return `the label "${text}" asks an eligibility question; a derived mapping may not answer one ` +
           `(the sponsorship-inversion trap answered "do you require sponsorship" from work_authorization)`;
  }
  if (CREDENTIAL_LABEL_RE.test(text)) {
    return `the label "${text}" is a credential field; a sign-in box is not an application field`;
  }
  return null;
}

/** Labels compare case- and punctuation-insensitively, using the codebase's one normaliser. */
export function labelKey(label) {
  return normaliseAtsTerm(label);
}

const N_FULL_CONFIDENCE = 4;

/**
 * Record a proposal. Returns { recorded, refused } so a generator can report what it declined.
 *
 * ⛔ REFUSES rather than skipping silently: a generator that quietly drops a third of its
 * candidates cannot be reviewed, and "the table has no sponsorship mapping" would be
 * indistinguishable from "the generator never saw one".
 */
export function recordMappingProposal(db, {
  platform, label, fieldKey, host = null, now = Math.floor(Date.now() / 1000),
} = {}) {
  const reason = forbiddenMapping(label, fieldKey);
  if (reason) return { recorded: false, refused: reason };

  const plat = String(platform || "generic").toLowerCase();
  const key = labelKey(label);
  if (!key) return { recorded: false, refused: "label normalises to nothing" };

  const prior = db.prepare("SELECT * FROM form_field_mappings WHERE platform=? AND label=?").get(plat, key);
  // A reviewed decision outranks any later proposal, including a rejection — the corpus that
  // produced a bad mapping will keep producing it.
  if (prior && prior.status !== "proposed") return { recorded: false, refused: "already reviewed" };

  const hosts = prior ? safeParse(prior.source_hosts_json) : [];
  if (host && !hosts.includes(host)) hosts.push(host);
  // CORROBORATION IS DISTINCT HOSTS when hosts are known, not a call counter. Re-capturing the same
  // employer's form ten times is one employer's evidence, and counting it as ten would let a single
  // host saturate confidence on its own — which is the shape that makes a review queue useless,
  // because the strongest-looking rows would be the most re-scraped rather than the most corroborated.
  // Only where no host is supplied does it fall back to incrementing.
  const corroboration = host ? hosts.length : (prior?.corroboration_count ?? 0) + 1;

  db.prepare(`
    INSERT INTO form_field_mappings
      (platform, label, field_key, confidence, corroboration_count, source_hosts_json,
       status, first_seen, last_seen)
    VALUES (@platform, @label, @field_key, @confidence, @corroboration, @hosts, 'proposed', @now, @now)
    ON CONFLICT(platform, label) DO UPDATE SET
      field_key           = excluded.field_key,
      confidence          = excluded.confidence,
      corroboration_count = excluded.corroboration_count,
      source_hosts_json   = excluded.source_hosts_json,
      last_seen           = excluded.last_seen
  `).run({
    platform: plat, label: key, field_key: String(fieldKey).toLowerCase(),
    confidence: Math.min(1, corroboration / N_FULL_CONFIDENCE),
    corroboration, hosts: JSON.stringify(hosts.slice(0, 25)), now,
  });
  return { recorded: true, refused: null };
}

function safeParse(json) {
  try { const v = JSON.parse(json || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

/**
 * The mappings the RESOLVER may use: confirmed only, for one platform.
 *
 * Returns { normalisedLabel: field_key }. Low-confidence and unreviewed mappings never appear —
 * requirement 2. A wrong mapping fills the wrong answer into a real employer's form, and that
 * cannot be recalled.
 */
export function loadConfirmedMappings(db, platform = "generic") {
  const out = {};
  try {
    const rows = db.prepare(
      "SELECT label, field_key FROM form_field_mappings WHERE platform=? AND status='confirmed'"
    ).all(String(platform || "generic").toLowerCase());
    for (const r of rows) {
      // Belt and braces: even a row that somehow reached 'confirmed' cannot deliver an excluded
      // key to the resolver. The table is a store; this is the boundary.
      if (EXCLUDED_FIELD_KEYS.has(r.field_key)) continue;
      out[r.label] = r.field_key;
    }
  } catch { /* predates migration 100 — no mappings is the pre-H behaviour */ }
  return out;
}

/**
 * Every platform's confirmed mappings, keyed by platform.
 *
 * Loaded in one go because services/applyAutomation.js deliberately has NO DATABASE ACCESS — it is
 * pure automation, and the DB stays in routes/apply.js. The platform is not known until the browser
 * has detected it, so the whole set is injected and autoApply picks after detection rather than the
 * automation layer growing a database handle.
 */
export function loadAllConfirmedMappings(db) {
  const out = {};
  try {
    for (const r of db.prepare(
      "SELECT platform, label, field_key FROM form_field_mappings WHERE status='confirmed'").all()) {
      if (EXCLUDED_FIELD_KEYS.has(r.field_key)) continue;
      (out[r.platform] ||= {})[r.label] = r.field_key;
    }
  } catch { /* predates migration 100 */ }
  return out;
}

export function listMappingProposals(db, platform = null) {
  try {
    return platform
      ? db.prepare("SELECT * FROM form_field_mappings WHERE status='proposed' AND platform=? ORDER BY corroboration_count DESC").all(platform)
      : db.prepare("SELECT * FROM form_field_mappings WHERE status='proposed' ORDER BY platform, corroboration_count DESC").all();
  } catch { return []; }
}

export function confirmMapping(db, platform, label, reviewedBy = "owner") {
  return db.prepare(`
    UPDATE form_field_mappings SET status='confirmed', reviewed_at=unixepoch(), reviewed_by=?
    WHERE platform=? AND label=?
  `).run(reviewedBy, String(platform).toLowerCase(), labelKey(label)).changes > 0;
}

export function rejectMapping(db, platform, label, reviewedBy = "owner") {
  return db.prepare(`
    UPDATE form_field_mappings SET status='rejected', reviewed_at=unixepoch(), reviewed_by=?
    WHERE platform=? AND label=?
  `).run(reviewedBy, String(platform).toLowerCase(), labelKey(label)).changes > 0;
}

export function mappingStats(db) {
  try {
    const rows = db.prepare("SELECT status, COUNT(*) n FROM form_field_mappings GROUP BY status").all();
    const out = { proposed: 0, confirmed: 0, rejected: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  } catch { return { proposed: 0, confirmed: 0, rejected: 0 }; }
}
