/**
 * Company KB — org structure layer (Task 9.5).
 *
 * GROWS ONLY from data companies emit about THEMSELVES (their own job postings, already
 * ingested into scraped_jobs) — NEVER from user resumes/profiles. A posting "Senior Engineer,
 * Payments Platform" is the company asserting that team exists; nothing in this module ever
 * reads a resume/profile table to learn or validate that assertion. Only company -> org_unit ->
 * (domain, stacks, seniority mix) is ever stored — no people, ever.
 *
 * Mining: enrichJob.js's existing per-job LLM pass already extracts a RAW team/org name per
 * posting into scraped_jobs.org_unit_raw (its `orgUnit` field) — this module does not re-read
 * title/description itself or make a second LLM call; it only clusters the already-extracted
 * signal across postings, computes confidence, and promotes/decays.
 */

import { decayedWeight } from '../jobs/enrichJob.js';

// Promotion thresholds — documented, tunable constants (not magic numbers).
const PROMOTE_MIN_CORROBORATION = 3;   // distinct postings required to auto-promote
const PROMOTE_MIN_CONFIDENCE    = 0.6;
const N_FULL_CONFIDENCE         = 5;   // corroboration_count at which the corroboration term caps at 1 (pre-decay)
const MAX_SOURCE_POSTINGS       = 50;  // caps the STORED provenance list only, not corroboration_count itself
const MAX_STACK_SKILLS          = 6;

const ORG_SUFFIX_RE = /\b(team|org|organization|group|division|department|unit)\b\.?$/i;

// Clustering key: lowercase, strip a trailing generic suffix ("...Team"/"...Org"/etc.), collapse
// punctuation/whitespace. "Payments Platform Team" and "payments platform" collapse to the same
// key; the DISPLAY name (org_unit) is chosen separately (see runOrgLayerRollup) and kept stable
// once established, rather than potentially flipping to whichever raw variant is most frequent
// on a given run.
function normalizeOrgUnitKey(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(ORG_SUFFIX_RE, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// confidence = min(1, corroboration_count / N_FULL_CONFIDENCE) * decayFactor(last_seen).
// decayedWeight(1, lastSeen, now) is exactly enrichJob.js's established exponential-decay
// factor (value * 0.5^(elapsed/halflife)) with weight=1 — reused as-is rather than re-deriving
// the same math, since company_technographics already established this as the codebase's decay
// convention for "confidence fades without reinforcement."
function computeConfidence(corroborationCount, lastSeenEpoch, nowEpoch) {
  const corroborationTerm = Math.min(1, corroborationCount / N_FULL_CONFIDENCE);
  const decayFactor = decayedWeight(1, lastSeenEpoch, nowEpoch);
  return corroborationTerm * decayFactor;
}

function mostFrequent(list) {
  const counts = new Map();
  for (const v of list) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null, bestCount = -1;
  for (const [v, c] of counts) { if (c > bestCount) { best = v; bestCount = c; } }
  return best;
}

// Per-unit stack signal, from the UNIT'S OWN contributing postings' skills_json — deliberately
// not company_technographics (whole-company), which would make every org unit at a company
// look identical and defeat the point of a per-unit view.
function topSkills(postings, max) {
  const counts = new Map();
  for (const p of postings) {
    let arr;
    try { arr = JSON.parse(p.skills_json || '[]'); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      const skill = typeof entry === 'string' ? entry
                  : (entry && typeof entry.skill === 'string' ? entry.skill : null);
      if (!skill) continue;
      counts.set(skill, (counts.get(skill) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([s]) => s);
}

function seniorityBreakdown(postings) {
  const counts = {};
  for (const p of postings) {
    if (!p.experience_level) continue;
    counts[p.experience_level] = (counts[p.experience_level] || 0) + 1;
  }
  return counts;
}

/**
 * Mines scraped_jobs.org_unit_raw across active postings, clusters near-duplicates per company,
 * and upserts company_org_units: proposes new/updated units, auto-promotes ones crossing the
 * corroboration+confidence thresholds, decays confidence for units not recently reinforced.
 * Never demotes an already-confirmed unit back to proposed, and never deletes a row (mirrors
 * the is_active soft-pattern used everywhere else in this codebase for "stale, not gone").
 * @param {import('better-sqlite3').Database} db
 */
function runOrgLayerRollup(db) {
  const now = Math.floor(Date.now() / 1000);

  const rows = db.prepare(`
    SELECT job_id, company, org_unit_raw, skills_json, experience_level, discovered_at
    FROM scraped_jobs
    WHERE is_active = 1 AND org_unit_raw IS NOT NULL AND org_unit_raw != '' AND company IS NOT NULL
  `).all();

  // company -> normalizedKey -> { rawVariants: [...], postings: [...] }
  const clustersByCompany = new Map();
  for (const row of rows) {
    const key = normalizeOrgUnitKey(row.org_unit_raw);
    if (!key) continue;
    if (!clustersByCompany.has(row.company)) clustersByCompany.set(row.company, new Map());
    const perCompany = clustersByCompany.get(row.company);
    if (!perCompany.has(key)) perCompany.set(key, { rawVariants: [], postings: [] });
    const cluster = perCompany.get(key);
    cluster.rawVariants.push(row.org_unit_raw.trim());
    cluster.postings.push(row);
  }

  const getExistingForCompany = db.prepare(`SELECT * FROM company_org_units WHERE company = ?`);
  const upsert = db.prepare(`
    INSERT INTO company_org_units
      (company, org_unit, domain, stacks_json, seniority_json, confidence, corroboration_count,
       status, first_seen, last_seen, source_postings_json)
    VALUES (@company, @org_unit, @domain, @stacks_json, @seniority_json, @confidence,
            @corroboration_count, @status, @first_seen, @last_seen, @source_postings_json)
    ON CONFLICT(company, org_unit) DO UPDATE SET
      stacks_json          = excluded.stacks_json,
      seniority_json       = excluded.seniority_json,
      confidence           = excluded.confidence,
      corroboration_count  = excluded.corroboration_count,
      status               = CASE WHEN company_org_units.status = 'confirmed'
                                   THEN 'confirmed' ELSE excluded.status END,
      last_seen            = excluded.last_seen,
      source_postings_json = excluded.source_postings_json
  `);

  let unitCount = 0, promotedCount = 0;

  for (const [company, perCompany] of clustersByCompany) {
    // Match this run's clusters against already-stored rows BY NORMALIZED KEY (not exact
    // org_unit string) so the canonical display name stays stable across runs instead of
    // potentially flipping to whichever raw variant happens to be most frequent this time.
    const existingByKey = new Map(
      getExistingForCompany.all(company).map(r => [normalizeOrgUnitKey(r.org_unit), r])
    );

    for (const [key, cluster] of perCompany) {
      const existing = existingByKey.get(key) || null;
      const orgUnit = existing ? existing.org_unit : mostFrequent(cluster.rawVariants);

      const distinctJobIds = [...new Set(cluster.postings.map(p => p.job_id))];
      const corroborationCount = distinctJobIds.length;
      const lastSeen = Math.max(...cluster.postings.map(p => p.discovered_at || now));
      const firstSeen = existing ? Math.min(existing.first_seen, lastSeen) : lastSeen;

      const confidence = computeConfidence(corroborationCount, lastSeen, now);
      const wouldPromote = corroborationCount >= PROMOTE_MIN_CORROBORATION
        && confidence >= PROMOTE_MIN_CONFIDENCE;

      upsert.run({
        company,
        org_unit: orgUnit,
        domain: null, // left for a future company_ats_list join if a per-company domain is wanted
        stacks_json: JSON.stringify(topSkills(cluster.postings, MAX_STACK_SKILLS)),
        seniority_json: JSON.stringify(seniorityBreakdown(cluster.postings)),
        confidence,
        corroboration_count: corroborationCount,
        status: wouldPromote ? 'confirmed' : 'proposed',
        first_seen: firstSeen,
        last_seen: lastSeen,
        source_postings_json: JSON.stringify(distinctJobIds.slice(0, MAX_SOURCE_POSTINGS)),
      });

      unitCount++;
      if (wouldPromote) promotedCount++;
    }
  }

  console.log(`[orgLayer] Rollup complete — ${unitCount} org unit(s) upserted, ${promotedCount} at/above promotion threshold`);
  return { unitCount, promotedCount };
}

/**
 * Admin-gated manual confirm — the "one-click confirm" for a below-threshold proposal. Only
 * flips status on a unit that already exists (mined from postings); never creates one from
 * nothing, since a confirm with no underlying evidence would violate the "companies emit this
 * about themselves" provenance rule.
 */
function confirmOrgUnit(db, company, orgUnit) {
  const info = db.prepare(`
    UPDATE company_org_units SET status = 'confirmed' WHERE company = ? AND org_unit = ?
  `).run(company, orgUnit);
  return info.changes > 0;
}

export {
  runOrgLayerRollup, confirmOrgUnit, normalizeOrgUnitKey, computeConfidence,
  PROMOTE_MIN_CORROBORATION, PROMOTE_MIN_CONFIDENCE, N_FULL_CONFIDENCE,
};
