/**
 * Company view (FE-4): aggregates the three read-only KB layers — technographics (Task 5),
 * org units (9.5), hiring signals (9.7) — into one payload for the company-view UI. Read-only,
 * writes nothing, camel-cased to match the rest of the client-facing contract (mapJobRow).
 */

import { decayedWeight } from '../jobs/enrichJob.js';
import { mapOrgUnitRow } from './orgLayer.js';
import { getHiringSignals } from '../jobs/hiringSignals.js';

const MAX_STACK_SKILLS = 12;
// A skill whose live (decayed) weight has fallen under this fraction of its last-reinforced
// weight reads as "evidence going stale" rather than "current stack" — the UI dims it.
const STACK_FRESH_FLOOR = 0.4;

function getStack(db, company) {
  const rows = db.prepare(
    `SELECT skill, weight, last_seen, posting_count FROM company_technographics WHERE company = ?`
  ).all(company);
  const now = Math.floor(Date.now() / 1000);
  return rows
    .map(r => {
      const liveWeight = decayedWeight(r.weight, r.last_seen, now);
      return {
        skill: r.skill,
        weight: Math.round(liveWeight * 100) / 100,
        postingCount: r.posting_count,
        lastSeen: r.last_seen,
        fresh: r.weight > 0 ? liveWeight / r.weight >= STACK_FRESH_FLOOR : false,
      };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_STACK_SKILLS);
}

function getOrgUnits(db, company) {
  return db.prepare(
    `SELECT * FROM company_org_units WHERE company = ? ORDER BY confidence DESC`
  ).all(company).map(mapOrgUnitRow);
}

function mapHiringSignal(row) {
  if (!row) return null;
  return {
    openCount: row.open_count,
    newCount: row.new_count,
    expiredCount: row.expired_count,
    domainBreakdown: row.domain_breakdown,
    growthScore: row.growth_score,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    updatedAt: row.updated_at,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} company
 */
function getCompanyProfile(db, company) {
  const stack = getStack(db, company);
  const orgUnits = getOrgUnits(db, company);
  const hiringSignal = mapHiringSignal(getHiringSignals(db, company, { history: false }));
  return {
    company,
    stack,
    orgUnits,
    hiringSignal,
    hasData: stack.length > 0 || orgUnits.length > 0 || !!hiringSignal,
  };
}

export { getCompanyProfile };
