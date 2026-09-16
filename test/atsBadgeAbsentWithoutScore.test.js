// THE BADGE AND THE PANEL WERE READING TWO DIFFERENT FIELDS, AND EVERY CARD SAID "NO SIGNAL".
//
// Reported from the running board: every posting showed the "No signal" chip, and clicking one
// opened a panel that scored the job and showed a real band. Both halves were true at once, for
// two independent reasons:
//
//  1. THE WIRE. GET /api/jobs maps through services/jobs/mapJobRow.js, which emits the stored
//     ats_score as `matchScore`. Every desktop surface reads `baseAtsScore`, which comes from a
//     different mapper (server.js's /api/jobs/poll shape) over the same column. Nothing on the
//     client read `matchScore`, so baseAtsScore was undefined on every board row and the badge
//     took its null branch. test/matchScoreReachesTheClient.test.js fixed the SERVER half of this
//     drift and its own comment records the client half as still open ("the desktop client never
//     reads it"). JobsPanel.normalizeApiJob now closes it.
//
//  2. THE BAND. `null` reaching the badge does not mean "the scorer declined". It means nobody
//     ever scored the row — 1,262 of 1,266 active postings have a NULL ats_score. The badge
//     cannot tell those apart, and rendering NOT_ENOUGH_SIGNAL for both turned a state
//     shared/atsBands.js measured at 0.1% of the board into a chip on essentially every card.
//
// Fixing only (1) would have left ~1,262 cards still reading "No signal". Fixing only (2) would
// have hidden the badge on 100% of cards forever and made the broken wire permanently invisible.
// Both halves are pinned here for that reason.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mapJobRow } from "../services/jobs/mapJobRow.js";
import { atsBandFor, atsBandLabel, ATS_BAND } from "../shared/atsBands.js";

const JOB_CARD = "client/src/components/JobCard.jsx";
const JOBS_PANEL = "client/src/panels/JobsPanel.jsx";

test("the score the board sends is the score the card reads", () => {
  // Behavioural on the server side, because the defect was a key name and a source test asserting
  // the wrong name would pass just as happily as one asserting the right name.
  assert.equal(mapJobRow({ job_id: "a", ats_score: 44 }).matchScore, 44);

  // The client half: normalizeApiJob must accept what mapJobRow actually emits.
  const src = fs.readFileSync(JOBS_PANEL, "utf8");
  assert.match(src, /baseAtsScore:\s*job\.baseAtsScore\s*\?\?\s*job\.matchScore\s*\?\?\s*null/,
    "normalizeApiJob must map matchScore onto the name every desktop surface reads");
  // ?? not ||, or a real score of 0 collapses into a decline.
  assert.doesNotMatch(src, /baseAtsScore:\s*job\.baseAtsScore\s*\|\|/,
    "|| would turn a legitimate score of 0 into null, which means the scorer declined");
});

test("a card renders NO badge when there is no score, and one when there is", () => {
  const src = fs.readFileSync(JOB_CARD, "utf8");
  const start = src.indexOf("function ATSBadge(");
  assert.ok(start > 0, "ATSBadge must still exist");
  const body = src.slice(start, start + 2200);
  assert.match(body, /if \(score == null \|\| Number\.isNaN\(score\)\) return null;/,
    "an unscored row must produce no chip at all");
  // The guard has to precede the band lookup, or the component computes a label it then discards
  // and the next edit reinstates the chip by deleting one line.
  assert.ok(body.indexOf("return null;") < body.indexOf("atsBandFor("),
    "the absence check must come before the band lookup");
  // == null, not === null: the field is UNDEFINED on rows that never went through normalizeApiJob,
  // and `=== null` would let those through to render a chip again.
  assert.doesNotMatch(body, /if \(score === null\)/,
    "undefined must be caught too — it is what an unnormalised row actually carries");
});

test("the fourth band is NOT deleted — this narrows where it renders, not whether it exists", () => {
  // The decline is still a real state for a surface that RAN the scorer and got nothing usable
  // (a pasted job description, a truncated scrape, the swipe feed). Only the card stops claiming
  // it. If someone "cleans up" the band itself, this fails.
  assert.equal(atsBandFor(null), ATS_BAND.NOT_ENOUGH_SIGNAL);
  assert.equal(atsBandFor(undefined), ATS_BAND.NOT_ENOUGH_SIGNAL);
  const decline = atsBandLabel(ATS_BAND.NOT_ENOUGH_SIGNAL);
  assert.ok(decline.short && decline.blurb, "the decline band must keep its copy");
  assert.notEqual(decline.short, atsBandLabel(atsBandFor(25)).short,
    "the decline must stay distinct from Weak");
});

test("the browser harness stubs the field the real endpoint sends, not one it invents", () => {
  // scripts/ak2BandSurfaces.mjs went green for months while every real card read "No signal",
  // because its /api/jobs stub set `baseAtsScore` — a key that endpoint has never emitted. A
  // fixture that invents the field under test measures the fixture.
  const harness = fs.readFileSync("scripts/ak2BandSurfaces.mjs", "utf8");
  assert.match(harness, /matchScore: c\.score/,
    "the stub must send what mapJobRow sends, so the client's normaliser is on the path");
  assert.doesNotMatch(harness, /baseAtsScore: c\.score/,
    "stubbing baseAtsScore bypasses normalizeApiJob and re-hides the wire defect");
});
