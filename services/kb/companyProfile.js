/**
 * Company view (FE-4): aggregates the three read-only KB layers — technographics (Task 5),
 * org units (9.5), hiring signals (9.7) — into one payload for the company-view UI. Read-only,
 * writes nothing, camel-cased to match the rest of the client-facing contract (mapJobRow).
 */

import { decayedWeight } from '../jobs/enrichJob.js';
import { mapOrgUnitRow } from './orgLayer.js';
import { getHiringSignals } from '../jobs/hiringSignals.js';

const MAX_STACK_SKILLS = 12;
// Stripe has 271 org units, 258 of them single-corroboration 'proposed' guesses. Rendering all of
// them made the company view a ~7000px wall of low-confidence inferences that pushed the hiring
// signal off the bottom of the scroll. The cap keeps the highest-confidence units (the ORDER BY
// already floats 'confirmed' up) and the UI discloses the total it was drawn from.
const MAX_ORG_UNITS = 8;
// A skill whose live (decayed) weight has fallen under this fraction of its last-reinforced
// weight reads as "evidence going stale" rather than "current stack" — the UI dims it.
const STACK_FRESH_FLOOR = 0.4;

function getStack(db, company) {
  const rows = db.prepare(
    `SELECT skill, weight, last_seen, posting_count FROM company_technographics WHERE company = ?`
  ).all(company);
  const now = Math.floor(Date.now() / 1000);
  const skills = rows
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
  // How many distinct postings this evidence actually rests on. posting_count is per-SKILL, so
  // summing it across skills counts one posting once per skill it mentions: it turned Stripe's
  // ~201 postings into "1134 posting mentions", and — worse — turned a company known from a
  // SINGLE posting into "12", making the thinnest possible evidence read as twelve-fold. The
  // most-reinforced skill's own count is the honest floor: at least that many postings
  // contributed, and no skill can have been seen in more postings than actually exist.
  const postings = rows.reduce((n, r) => Math.max(n, r.posting_count), 0);
  return { skills, postings };
}

function getOrgUnits(db, company) {
  const rows = db.prepare(
    `SELECT * FROM company_org_units WHERE company = ? ORDER BY confidence DESC`
  ).all(company);
  return { units: rows.slice(0, MAX_ORG_UNITS).map(mapOrgUnitRow), total: rows.length };
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
  const org = getOrgUnits(db, company);
  const hiringSignal = mapHiringSignal(getHiringSignals(db, company, { history: false }));
  return {
    company,
    stack: stack.skills,
    // The honest count of postings behind the stack — see getStack. The UI labels the block with
    // this, never with a sum across skills.
    stackPostings: stack.postings,
    orgUnits: org.units,
    // How many units existed before MAX_ORG_UNITS truncated the list, so the UI can say "8 of 271"
    // instead of implying eight is all there is.
    orgUnitsTotal: org.total,
    hiringSignal,
    hasData: stack.skills.length > 0 || org.total > 0 || !!hiringSignal,
  };
}

export { getCompanyProfile };
