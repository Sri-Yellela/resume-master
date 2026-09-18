// THE FIELD THE MOBILE CONTRACT DOCUMENTS MOST HEAVILY WAS NULL ON EVERY ROW OF EVERY RESPONSE,
// AND THE FIX FOR THAT TURNED IT INTO A CROSS-USER LEAK.
//
// ── ACT ONE (AJ2) ──────────────────────────────────────────────────────────────────────────────
// services/jobs/mapJobRow.js read:
//
//     matchScore: j._matchScore || j.match_score || null
//
// `_matchScore` is assigned NOWHERE in this repository, and `match_score` is NOT A COLUMN on
// scraped_jobs. So GET /api/jobs and GET /api/jobs/by-id emitted matchScore: null unconditionally,
// forever. It surfaced only when the Android client implemented the contract exactly as written and
// banded 100% of jobs "Not enough signal". The fix pointed the field at `sj.ats_score`, the column
// that does store a score.
//
// ── ACT TWO (CC5), AND WHY THAT FIX WAS WRONG ──────────────────────────────────────────────────
// ⛔ `scraped_jobs.ats_score` IS ONE CELL PER JOB. It is written at ingest from whichever user's
// résumé basis happened to trigger the crawl, and overwritten wholesale by adopt-enhanced for a
// single profile. Pointing `matchScore` at it did not give each client its own user's score — it
// gave every user the same stranger's score, on every surface this mapper feeds.
//
// A score is a statement about (résumé, posting). A per-job column cannot hold one. So the score
// now arrives as an explicitly per-caller value that the route supplies from `ats_only_reports`,
// keyed (user_id, domain_profile_id, job_id) as of migration 108.
//
// ── WHAT THIS FILE PINS ────────────────────────────────────────────────────────────────────────
// Both halves, because each direction has already been got wrong once: the field must carry a real
// per-caller score when there is one (AJ2's defect), and it must NEVER carry the shared cell
// (CC5's). The tests stay BEHAVIOURAL — they execute mapJobRow rather than reading its text —
// because the original defect was a wrong key name, and a source-string test asserting the wrong
// name would pass just as happily as one asserting the right name.

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { mapJobRow } from "../services/jobs/mapJobRow.js";
import { atsBandFor, ATS_BAND } from "../shared/atsBands.js";

test("matchScore carries the per-caller score the route supplies", () => {
  // AJ2's requirement, met from a source that can be correct.
  assert.equal(mapJobRow({ job_id: "a", matchScore: 43 }).matchScore, 43);
  assert.equal(mapJobRow({ job_id: "a", matchScore: 44 }).matchScore, 44);
});

test("⛔ matchScore NEVER carries scraped_jobs.ats_score, the shared per-job cell", () => {
  // The leak, pinned in the direction it actually happened. `ats_score` is present on the row
  // object because `sj.*` selects it; the mapper must ignore it.
  assert.equal(mapJobRow({ job_id: "a", ats_score: 44 }).matchScore, null);
  assert.equal(mapJobRow({ job_id: "a", ats_score: 0 }).matchScore, null);
  // And when both are present, the per-caller value is the only one that counts.
  assert.equal(mapJobRow({ job_id: "a", ats_score: 99, matchScore: 12 }).matchScore, 12);
});

test("the two keys it used to read are dead, and reading them again must fail here", () => {
  // If someone reinstates either name, the score silently stops arriving and every band on every
  // native client reverts to "Not enough signal".
  assert.equal(mapJobRow({ job_id: "a", _matchScore: 51 }).matchScore, null);
  assert.equal(mapJobRow({ job_id: "a", match_score: 51 }).matchScore, null);
  assert.equal(mapJobRow({ job_id: "a", matchScore: 44, _matchScore: 9, match_score: 9 }).matchScore, 44);
});

test("a score of ZERO survives — `||` would collapse it into a decline", () => {
  // 0 is a real score and bands as Weak. null means the scorer DECLINED for want of signal, which
  // is its own band. `||` cannot tell them apart, and conflating them is exactly what the fourth
  // band exists to prevent: it would report the engine's most honest answer as its worst grade.
  const zero = mapJobRow({ job_id: "a", matchScore: 0 }).matchScore;
  assert.equal(zero, 0);
  assert.notEqual(zero, null);
  assert.equal(atsBandFor(zero), ATS_BAND.WEAK);
  assert.equal(atsBandFor(null), ATS_BAND.NOT_ENOUGH_SIGNAL);
});

test("an absent or null score still means the scorer declined", () => {
  // Correct on the paths that genuinely have none: /api/jobs/generic selects an explicit column
  // list and has no per-user score at all, live aggregator results have never been scored, and
  // since CC5 the common case is simply "this user has not opened a report for this job yet".
  assert.equal(mapJobRow({ job_id: "a" }).matchScore, null);
  assert.equal(mapJobRow({ job_id: "a", matchScore: null }).matchScore, null);
  assert.equal(atsBandFor(mapJobRow({ job_id: "a" }).matchScore), ATS_BAND.NOT_ENOUGH_SIGNAL);
});

test("the band each seeded boundary produces is the band the graded 30 defined", () => {
  // The exact values verified end to end against a real emulator in AJ2. They are boundaries, not
  // midpoints: 43 vs 44 and 25 vs 26 fail if a cutpoint moves by one, where a mid-band value would
  // pass against 40, 44 or 46 alike.
  const bandOf = score => atsBandFor(mapJobRow({ job_id: "a", matchScore: score }).matchScore);
  assert.equal(bandOf(44), ATS_BAND.STRONG);
  assert.equal(bandOf(43), ATS_BAND.MODERATE);
  assert.equal(bandOf(26), ATS_BAND.MODERATE);
  assert.equal(bandOf(25), ATS_BAND.WEAK);
});

test("the board SELECTS the score from the caller's own cache, joined per profile", () => {
  // The other half of the contract: mapJobRow can only emit what the route hands it, so the route
  // has to supply `matchScore` — and from a source that is scoped to this user AND this profile.
  // A source scan, because the thing being checked is which table the SQL names.
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /LEFT JOIN ats_only_reports aor\s*\n\s*ON aor\.job_id = sj\.job_id AND aor\.user_id = \? AND aor\.domain_profile_id IS \?/,
    "the board must join the per-(user, profile) report cache");
  assert.match(server, /aor\.ats_score AS matchScore/,
    "and serve matchScore from it");
  // ⛔ The leak, pinned at the SQL level too: no board query may alias the shared cell into the
  // name the client reads as its score.
  assert.doesNotMatch(server, /sj\.ats_score AS matchScore/,
    "the shared per-job cell must never be aliased into matchScore");
});

test("ats_score is still projectable, and mapJobRow is what keeps it off the wire", async () => {
  // buildSelectColumns is a whitelist, and ats_score stays in it because the COLUMN is not dropped —
  // it is RETIRED: no writer, no reader, old values left where they are. See
  // docs/CC5_PER_PROFILE_SCORES.md §3 for why "retired" rather than "kept as a profile-agnostic
  // signal". So `include_fields=ats_score` still puts sj.ats_score in the SELECT.
  const { buildSelectColumns } = await import("../services/jobs/jobQuery.js");
  assert.match(buildSelectColumns("ats_score,title"), /sj\.ats_score/);

  // ⛔ THAT IS HARMLESS FOR EXACTLY ONE REASON, WHICH IS WORTH PINNING RATHER THAN ASSUMING.
  // mapJobRow builds an explicit object; it does not spread the row. A projected column it does not
  // name cannot reach a response. If that mapper ever becomes a spread, this retired cross-user
  // cell becomes reachable again through a query parameter.
  const mapped = mapJobRow({ job_id: "a", ats_score: 77, ats_report: '{"score":77}' });
  assert.equal(mapped.ats_score, undefined, "a projected column must not pass through the mapper");
  assert.equal(mapped.ats_report, undefined);
  assert.equal(mapped.matchScore, null);
});
