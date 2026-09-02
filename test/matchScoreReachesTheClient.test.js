// THE FIELD THE MOBILE CONTRACT DOCUMENTS MOST HEAVILY WAS NULL ON EVERY ROW OF EVERY RESPONSE.
//
// services/jobs/mapJobRow.js read:
//
//     matchScore: j._matchScore || j.match_score || null
//
// `_matchScore` is assigned NOWHERE in this repository, and `match_score` is NOT A COLUMN on
// scraped_jobs — the stored column is `ats_score`. So GET /api/jobs and GET /api/jobs/by-id emitted
// matchScore: null unconditionally, forever.
//
// WHY IT SURVIVED. The desktop client never reads it. JobCard.jsx, JobDetailPanel.jsx and
// JobsPanel.jsx all read `g?.atsScore ?? job?.baseAtsScore`, and baseAtsScore comes from a
// different mapper (server.js's /api/jobs/poll shape) reading the same ats_score column. Two sides,
// each internally consistent, joined to nothing — and no test on either side crossed the gap.
// It surfaced only when the Android client implemented the contract exactly as written (AJ2) and
// banded 100% of jobs "Not enough signal", including rows whose ats_score was 43.
//
// These tests are BEHAVIOURAL — they execute mapJobRow rather than asserting on its text — because
// the defect was a wrong key name, and a source-string test asserting the wrong name would have
// passed just as happily as one asserting the right name.

import test from "node:test";
import assert from "node:assert";
import { mapJobRow } from "../services/jobs/mapJobRow.js";
import { atsBandFor, ATS_BAND } from "../shared/atsBands.js";

test("matchScore is read from ats_score, the column that actually stores it", () => {
  assert.equal(mapJobRow({ job_id: "a", ats_score: 43 }).matchScore, 43);
  assert.equal(mapJobRow({ job_id: "a", ats_score: 44 }).matchScore, 44);
});

test("the two keys it used to read are dead, and reading them again must fail here", () => {
  // If someone reinstates either name, the score silently stops arriving and every band on every
  // native client reverts to "Not enough signal". Pinned in both directions: the dead keys must not
  // be honoured, and ats_score must win when present.
  assert.equal(mapJobRow({ job_id: "a", _matchScore: 51 }).matchScore, null);
  assert.equal(mapJobRow({ job_id: "a", match_score: 51 }).matchScore, null);
  assert.equal(mapJobRow({ job_id: "a", ats_score: 44, _matchScore: 9, match_score: 9 }).matchScore, 44);
});

test("a score of ZERO survives — `||` would collapse it into a decline", () => {
  // 0 is a real score and bands as Weak. null means the scorer DECLINED for want of signal, which
  // is its own band. `||` cannot tell them apart, and conflating them is exactly what the fourth
  // band exists to prevent: it would report the engine's most honest answer as its worst grade.
  const zero = mapJobRow({ job_id: "a", ats_score: 0 }).matchScore;
  assert.equal(zero, 0);
  assert.notEqual(zero, null);
  assert.equal(atsBandFor(zero), ATS_BAND.WEAK);
  assert.equal(atsBandFor(null), ATS_BAND.NOT_ENOUGH_SIGNAL);
});

test("an absent or null ats_score still means the scorer declined", () => {
  // Correct on the paths that genuinely have no score: /api/jobs/generic selects an explicit column
  // list without ats_score because a public unpersonalized feed has no per-user score, and live
  // aggregator results have never been scored.
  assert.equal(mapJobRow({ job_id: "a" }).matchScore, null);
  assert.equal(mapJobRow({ job_id: "a", ats_score: null }).matchScore, null);
  assert.equal(atsBandFor(mapJobRow({ job_id: "a" }).matchScore), ATS_BAND.NOT_ENOUGH_SIGNAL);
});

test("a camelCase row (live search) is still accepted, matching every other field here", () => {
  // mapJobRow normalises snake_case DB rows AND camelCase live-search results; every other field
  // takes both spellings, so this one does too.
  assert.equal(mapJobRow({ job_id: "a", matchScore: 37 }).matchScore, 37);
});

test("the band each seeded boundary produces is the band the graded 30 defined", () => {
  // The exact values verified end to end against a real emulator in AJ2. They are boundaries, not
  // midpoints: 43 vs 44 and 25 vs 26 fail if a cutpoint moves by one, where a mid-band value would
  // pass against 40, 44 or 46 alike.
  const bandOf = score => atsBandFor(mapJobRow({ job_id: "a", ats_score: score }).matchScore);
  assert.equal(bandOf(44), ATS_BAND.STRONG);
  assert.equal(bandOf(43), ATS_BAND.MODERATE);
  assert.equal(bandOf(26), ATS_BAND.MODERATE);
  assert.equal(bandOf(25), ATS_BAND.WEAK);
});

test("ats_score is projectable, or mapJobRow could never receive it", async () => {
  // buildSelectColumns is a whitelist. If ats_score were missing from it, an include_fields request
  // would drop the column and matchScore would go back to null for exactly the clients that asked
  // for a narrower payload — the binding constraint sits there, not here.
  const { buildSelectColumns } = await import("../services/jobs/jobQuery.js");
  assert.match(buildSelectColumns("ats_score,title"), /sj\.ats_score/);
  // The default projection is sj.*, which carries every column including this one.
  assert.equal(buildSelectColumns(""), "sj.*");
});
