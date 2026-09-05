/**
 * Company view (FE-4): aggregates the four read-only KB layers — technographics (Task 5),
 * org units (9.5), hiring signals (9.7), H-1B sponsorship evidence (X3) — into one payload for the
 * company-view UI. Read-only, writes nothing, camel-cased to match the rest of the client-facing
 * contract (mapJobRow).
 */

import { decayedWeight } from '../jobs/enrichJob.js';
import { mapOrgUnitRow } from './orgLayer.js';
import { getHiringSignals } from '../jobs/hiringSignals.js';
import { getCompanyLca } from './lcaLayer.js';
// G3 — one vocabulary, used twice: the same normaliser the ATS scorer matches with and the same
// CONFIRMED synonym table it expands with. A second one here would let a company's stack and a
// candidate's match disagree about what a skill is.
import { mergeStackRows } from './technographics.js';
import { loadConfirmedSynonyms } from './skillSynonyms.js';

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
  // G3 — MERGED HERE, NOT IN THE TABLE. 386 of the 8690 stored rows are the same skill for the
  // same company under a different spelling ("Infrastructure-as-Code" six ways), so an unmerged
  // stack ranks each fragment below skills that happen to have one spelling. The rows themselves
  // are left alone: the board that produced them was deleted by retention, so the raw variants are
  // now the only surviving record of what the postings said. See services/kb/technographics.js.
  const merged = mergeStackRows(rows, loadConfirmedSynonyms(db));
  const skills = merged
    .map(r => {
      const liveWeight = decayedWeight(r.weight, r.lastSeen, now);
      return {
        skill: r.skill,
        weight: Math.round(liveWeight * 100) / 100,
        postingCount: r.postingCount,
        lastSeen: r.lastSeen,
        fresh: r.weight > 0 ? liveWeight / r.weight >= STACK_FRESH_FLOOR : false,
        // What was collapsed into this entry. Present so the surface can disclose a merge rather
        // than silently presenting six postings' evidence as one tidy row.
        ...(r.variants.length > 1 ? { mergedFrom: r.variants } : {}),
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
  // Still the MAX rather than a sum, and now over MERGED groups — which is what makes the floor
  // honest again. Before the merge the most-reinforced skill might be one of six fragments, so the
  // floor under-reported; summing would over-report for the reason the note above gives.
  const postings = merged.reduce((n, r) => Math.max(n, r.postingCount), 0);
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
  // H-1B sponsorship evidence from DOL LCA filings (TASK X3). The ONLY one of these four layers
  // that is not mined from postings — which is the point: 0 of 1,261 postings mention H-1B, so the
  // posting-derived version of this signal does not exist.
  const lca = getCompanyLca(db, company);
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
    // Sent whole, including a non-presentable match, so the client never has to re-derive the
    // integrity rule — but `presentable: false` is the UI's instruction to render nothing.
    lca,
    // A non-presentable LCA row does NOT count as data. An ambiguous or unmatched company has
    // nothing to show, and letting it flip hasData would replace "Not enough data on X yet" with
    // an empty panel that looks broken.
    hasData: stack.skills.length > 0 || org.total > 0 || !!hiringSignal || !!lca?.presentable,
  };
}

export { getCompanyProfile };
