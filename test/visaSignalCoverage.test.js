// THE VISA DIFFERENTIATOR HAS NO DATA BEHIND IT, AND ENRICHMENT CANNOT PRODUCE ANY.
//
// The OPT/STEM-OPT/H-1B story rests on scraped_jobs.is_h1b_sponsor. A full enrichment backfill of
// every active posting was run on 2026-08-22 — 1261 of 1261 rows, 0 failed, $3.22 of Haiku — and it
// produced ZERO rows with is_h1b_sponsor = 1. Not because the pass is broken: because the postings
// do not say. Measured over the same 1261 descriptions (avg 4.3-5.0k chars, 0 missing):
//
//     "H-1B" or "H1B"        0 postings     0.0%
//     "sponsor*"            28 postings     2.2%
//     "visa"                 7 postings     0.6%
//     "work authorization"   1 posting      0.1%
//     any of the above      36 postings     2.9%
//
// The prompt is deliberately strict — "null unless the posting explicitly states its sponsorship
// policy" — so a silent posting yields null, which is correct and is what happened 1258 times.
// After the backfill: is_h1b_sponsor 3 non-null (all FALSE), requires_work_auth 18 non-null (14
// true), is_clearance_required 11 non-null (3 true).
//
// SO: "Sponsors H-1B" can never render from crawled JD text on this pool, and no amount of
// re-running enrichment will change that. Making that badge real needs a DIFFERENT SOURCE — an
// employer H-1B filing dataset (e.g. the DOL LCA disclosure files), keyed by company — not another
// LLM pass over the same text. This file exists so the next person to notice the empty column finds
// the measurement instead of re-running the backfill to discover it again.
//
// What DID land is large and is the reason the pass was worth running: skills_json 100 -> 1259
// (7.9% -> 99.8%), org_unit_raw 52 -> 1091, workplace_type 542 -> 859, and company_technographics
// 1489 -> 8507 rows, which is what FE-4's STACK block and FE-6's recruiter reference read.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8");
const enrich = read("services/jobs/enrichJob.js");
const card = read("client/src/components/JobCard.jsx");
const detail = read("client/src/components/JobDetailPanel.jsx");

/** Both copies of the badge, sliced from their own function. */
const badgeOf = (src) => {
  const start = src.indexOf("function VisaBadge");
  assert.ok(start >= 0, "VisaBadge moved");
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
};

test("the model is asked for a TRI-STATE and told not to guess", () => {
  // The whole soft-null contract starts here. If the prompt ever asks for a boolean, a silent
  // posting starts coming back `false`, and "we don't know" becomes "does not sponsor" — which is
  // the one failure mode this column must never have.
  assert.match(enrich, /"isH1bSponsor": <true, false, or null[^>]*explicitly states its sponsorship policy>/);
  assert.match(enrich, /"requiresWorkAuth": <true, false, or null — null unless explicitly stated>/);
  assert.match(enrich, /Never guess or infer beyond what's\s*\n?\s*written/);
  // coerceBool maps anything that is not exactly true/false to null.
  assert.match(enrich, /function coerceBool\(value\) \{\s*\n\s*return value === true \? 1 : value === false \? 0 : null;/);
});

test("null renders NOTHING — in both copies of the badge", () => {
  // FE-1's rule: null means "no signal", never "does not sponsor". This survived the data arriving,
  // which is the thing worth pinning: 1258 of 1261 rows are still null after a full backfill, so a
  // badge that treated null as false would now be lying on 99.8% of the board.
  for (const [name, src] of [["JobCard", card], ["JobDetailPanel", detail]]) {
    const badge = badgeOf(src);
    assert.match(badge, /if \(isH1bSponsor === 1 \|\| isH1bSponsor === true\)/,
      `${name}: the sponsor branch must test for an explicit true`);
    assert.match(badge, /if \(requiresWorkAuth === 1 \|\| requiresWorkAuth === true\)/,
      `${name}: the work-auth branch must test for an explicit true`);
    assert.match(badge, /return null;/, `${name}: the fall-through must render nothing`);
    // The trap: any truthiness test would make 0 and null indistinguishable.
    assert.ok(!/if \(isH1bSponsor\)|if \(!!isH1bSponsor\)/.test(badge),
      `${name}: a truthiness test would render the badge for a value we do not have`);
  }
});

test("mapJobRow passes the tri-state through without collapsing it", () => {
  const map = read("services/jobs/mapJobRow.js");
  assert.match(map, /isH1bSponsor:\s+j\.is_h1b_sponsor\s+\?\? null/);
  assert.match(map, /requiresWorkAuth:\s+j\.requires_work_auth\s+\?\? null/);
  // `||` instead of `??` would turn a real 0 ("explicitly does not sponsor") into null.
  assert.ok(!/is_h1b_sponsor\s+\|\|/.test(map), "`||` would erase an explicit false");
});

test("the sponsorship filter excludes only on an explicit disqualifying signal", () => {
  // With 1258 nulls, a filter that dropped unknowns would empty the board for exactly the users it
  // is meant to help. Measured after the backfill: 1245 of 1261 kept, 16 excluded — it discriminates
  // now (it excluded 0 before, when both columns were 100% null) without touching the unknowns.
  const q = read("services/jobs/jobQuery.js");
  assert.match(q, /sj\.requires_work_auth IS NULL OR sj\.requires_work_auth != 1/);
  assert.match(q, /sj\.is_h1b_sponsor IS NULL OR sj\.is_h1b_sponsor != 0/);
});
