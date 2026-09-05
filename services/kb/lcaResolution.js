/**
 * services/kb/lcaResolution.js — human-reviewed identity resolutions for LCA company matching (G2).
 *
 * ⛔ WHAT A WRONG ROW HERE DOES. It tells a candidate that Company A sponsors H-1B visas when the
 * filings belong to a similarly-named Company B. That is a FALSE ATTESTATION ABOUT A THIRD PARTY —
 * categorically worse than a wrong match score, because it is a factual claim about someone who is
 * not the user, cannot see it, and cannot correct it. And it is not hypothetical: the LCA corpus
 * contains "Linear Labs LLC" (electric motors), "Mercury Insurance Services, LLC" and
 * "Ramp Systems, Inc." alongside our Linear, Mercury and Ramp.
 *
 * services/kb/lcaMatch.js already declines all three, deliberately and with measurements. This
 * module does NOT loosen it. It adds a separate, slower path: a model proposes an identity, a human
 * confirms it, and only then does the matcher see it — as its own tier, at its own confidence.
 *
 * ── WHY TIER R SITS WHERE IT DOES ──────────────────────────────────────────────────────────────
 *
 * Every other tier's confidence is the measured ambiguity of a rule applied to the source data.
 * Tier R is the only one whose evidence is NOT IN THE DATA AT ALL — it rests on outside knowledge
 * that Ramp the fintech is registered as "Ramp Business Corporation". So it is placed:
 *
 *     0.70   above PRESENTABLE_MIN_CONFIDENCE (0.60), so a confirmed resolution can be shown,
 *            but BELOW HIGH_CONFIDENCE (0.80), so it renders with the matched legal entity NAMED
 *            INLINE and a "matched on name" qualifier rather than as bare prose with a count.
 *
 * That placement is the whole point rather than a tuning choice: a claim resting on outside
 * knowledge must show its working, so the reader can check the entity themselves.
 *
 * ── A NULL RESOLUTION IS A REAL ANSWER ─────────────────────────────────────────────────────────
 *
 * `resolved_employer_name = NULL` means "none of these candidates is this company", and it is the
 * expected answer for Linear. Recording it pins the negative so a later pass cannot re-propose the
 * wrong entity — the same stickiness a rejected skill synonym has, and for the same reason.
 */

import { companyMatchKey } from "./lcaMatch.js";

/**
 * Tier R's confidence. Exported so lcaMatch's TIER_CONFIDENCE and this stay one number.
 * See the header for why it is between the two display thresholds and not above them.
 */
export const RESOLUTION_CONFIDENCE = 0.70;

export function recordResolutionProposal(db, {
  company, resolvedEmployerName = null, candidates = [], modelConfidence = null, modelReason = null,
} = {}, now = Math.floor(Date.now() / 1000)) {
  if (!company) return false;
  const prior = db.prepare("SELECT status FROM lca_company_resolutions WHERE company=?").get(company);
  // A human decision outranks any number of later proposals — including a decision to reject.
  if (prior && prior.status !== "proposed") return false;

  db.prepare(`
    INSERT INTO lca_company_resolutions
      (company, resolved_employer_name, resolved_match_key, candidates_json,
       model_confidence, model_reason, status, proposed_at, updated_at)
    VALUES (@company, @name, @key, @candidates, @confidence, @reason, 'proposed', @now, @now)
    ON CONFLICT(company) DO UPDATE SET
      resolved_employer_name = excluded.resolved_employer_name,
      resolved_match_key     = excluded.resolved_match_key,
      candidates_json        = excluded.candidates_json,
      model_confidence       = excluded.model_confidence,
      model_reason           = excluded.model_reason,
      updated_at             = excluded.updated_at
  `).run({
    company,
    name: resolvedEmployerName || null,
    key: resolvedEmployerName ? companyMatchKey(resolvedEmployerName) : null,
    candidates: JSON.stringify(candidates || []),
    confidence: modelConfidence,
    reason: modelReason,
    now,
  });
  return true;
}

/**
 * Confirmed resolutions, keyed by company. THE ONLY THING the matcher is allowed to read.
 *
 * A confirmed row whose resolved_employer_name is NULL is included: it is the recorded decision
 * that none of the candidates is this company, and the matcher must be able to see that it was
 * decided rather than merely never attempted.
 */
export function loadConfirmedResolutions(db) {
  const map = new Map();
  let rows;
  try {
    rows = db.prepare(`
      SELECT company, resolved_employer_name, resolved_match_key, reviewed_by
      FROM lca_company_resolutions WHERE status='confirmed'
    `).all();
  } catch {
    // Predates migration 099. No resolutions is the pre-G2 behaviour, which is correct.
    return map;
  }
  for (const r of rows) {
    map.set(r.company, {
      employerName: r.resolved_employer_name || null,
      matchKey: r.resolved_match_key || null,
      reviewedBy: r.reviewed_by || null,
    });
  }
  return map;
}

export function listResolutionProposals(db) {
  try {
    return db.prepare("SELECT * FROM lca_company_resolutions WHERE status='proposed' ORDER BY company").all();
  } catch { return []; }
}

export function confirmResolution(db, company, reviewedBy = "owner") {
  return db.prepare(`
    UPDATE lca_company_resolutions SET status='confirmed', reviewed_at=unixepoch(), reviewed_by=?
    WHERE company=?
  `).run(reviewedBy, company).changes > 0;
}

export function rejectResolution(db, company, reviewedBy = "owner") {
  return db.prepare(`
    UPDATE lca_company_resolutions SET status='rejected', reviewed_at=unixepoch(), reviewed_by=?
    WHERE company=?
  `).run(reviewedBy, company).changes > 0;
}

export function resolutionStats(db) {
  try {
    const rows = db.prepare("SELECT status, COUNT(*) n FROM lca_company_resolutions GROUP BY status").all();
    const out = { proposed: 0, confirmed: 0, rejected: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  } catch { return { proposed: 0, confirmed: 0, rejected: 0 }; }
}
