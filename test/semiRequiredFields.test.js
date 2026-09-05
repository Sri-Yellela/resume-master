// A SEMI RUN MUST SAY WHAT IS STILL YOURS TO ANSWER (TASK AE6).
//
// Observed: a semi run came back with `missingRequired: []` — no, with the field ABSENT — while
// required fields on the form sat blank. The review surface then rendered a clean row: no obstacle,
// nothing outstanding, over an application that could not be submitted.
//
// The gates being off in semi is a product decision and is not what this is about. `isUnattended =
// isFullAuto || isPreview`, so a semi run runs neither the completeness gate nor the low-confidence
// gate, and that is deliberate: a human is looking at the form and pre-filling a guess for them to
// correct is the entire point of the mode. Blocking would defeat it. What the run owes them is the
// LIST — it had already discovered those fields and read their values, and it threw the fact away.
//
// This is the same defect class as the two AE1/AE2 fixed and the third the codebase had already
// named: a condition the system knows about, reported as a different condition or as nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { at } from "../test-support/sourceAnchors.js";

const automation = fs.readFileSync("services/applyAutomation.js", "utf8");
const routes     = fs.readFileSync("routes/apply.js", "utf8");

// The semi branch — everything below is asserted inside it, not merely somewhere in the file, or a
// check would pass on the unattended gate that was always there.
const semiBranch = (() => {
  const i = automation.indexOf('status    = "awaiting_user";');
  assert.ok(i > 0, "the semi branch must exist");
  return automation.slice(i, at(automation, "console.log(`[autoApply] done", i));
})();

test("the semi branch re-reads the form it just filled", () => {
  // The third argument is task H's derived label map, and passing it here is REQUIRED rather than
  // incidental: this re-read decides what is reported as still-missing, so if it ran with a
  // different label map from the one that did the filling, a field the derived mapping had just
  // filled would be reported as blank. That is the same "the two cannot disagree" property the
  // predicate assertion below exists to protect, one argument over.
  assert.match(semiBranch, /discoverFields\(f, detected, derivedLabelMaps\?\.\[detected\] \|\| null\)/,
    "semi has to look at the form to be able to report on it, with the SAME label map that filled it");
  assert.match(semiBranch, /frameList\(page\)\.map/,
    "across every frame — a form in an iframe is the common case on workday/icims/taleo");
});

test("it reports the required fields that are still blank", () => {
  assert.match(semiBranch, /f\.is_required && \(f\.current_value === '' \|\| f\.current_value == null\)/,
    "the same predicate the unattended completeness gate uses, so the two cannot disagree");
  assert.match(semiBranch, /semiMissingRequired = semiMissingFields\.map/);
  assert.match(semiBranch, /semiOpenQuestions\s+= buildOpenQuestions\(\{ missingFields: semiMissingFields \}\)/,
    "openQuestions carries the type and options, so a question can be ANSWERED, not just named");
});

test("and it does NOT hold — semi's premise is that a human finishes the form", () => {
  // The distinction the task draws: gates off is fine, silence is not. So there must be no early
  // return, no status change, and no browser close inside this branch.
  assert.ok(!/return \{/.test(semiBranch), "the semi report must not become a terminal hold");
  assert.ok(!/browser\.close\(\)/.test(semiBranch), "semi leaves the browser open for the human");
  assert.match(semiBranch, /status\s+= "awaiting_user"/);
});

test("it says the count out loud, in the run's own log", () => {
  assert.match(semiBranch, /required field\(s\) are yours to answer/);
});

test("AN EMPTY LIST IS AN ANSWER, and is distinguishable from no answer", () => {
  // The original defect was the field being ABSENT, which a consumer can only read as "no
  // information". `[]` means "we checked and nothing is outstanding". The result spreads
  // `missingRequired` whenever the semi path ran, including when it is empty — and omits it entirely
  // on the unattended path, where the gate already owns that story.
  assert.match(automation, /let semiMissingRequired = null, semiOpenQuestions = null;/);
  assert.match(automation,
    /\.\.\.\(semiMissingRequired \? \{ missingRequired: semiMissingRequired \} : \{\}\)/,
    "presence is keyed on the semi path having RUN, not on the list being non-empty");
});

test("the review surface is told, rather than left to infer it", () => {
  // routes/apply.js's semi branch is where a manual-review run's audit is written. The count has to
  // reach the event, and it has to be recorded even when zero — an absent key is exactly how this
  // went unnoticed.
  const semiRoute = routes.slice(at(routes, '} else if (mode === "semi") {'),
                                at(routes, "// CASE C: no artifact + auto mode"));
  assert.ok(semiRoute.length > 0, "the semi route branch must exist");
  assert.match(semiRoute, /const semiMissing = Array\.isArray\(result\.missingRequired\) \? result\.missingRequired : null;/);
  assert.match(semiRoute, /yours to answer/);
  assert.match(semiRoute, /no required field is left blank/,
    "the zero case gets a sentence too, or silence still reads as success");
  assert.match(semiRoute, /missingRequiredCount: semiMissing === null \? null : semiMissing\.length/);
  // And the questions themselves already had a route to the panel: a held_review row's
  // open_questions_json is what /api/apply/questions reads. Semi now populates it.
  assert.match(semiRoute, /open_questions_json: Array\.isArray\(result\.openQuestions\)/);
  assert.match(routes, /WHERE rj\.user_id=\? AND rj\.status='held_review' AND rj\.open_questions_json IS NOT NULL/);
});

test("a refusal explains itself — 'we would not guess' is not the same as 'blank'", () => {
  assert.match(semiBranch, /a\.skipped && a\.refusals\?\.length/);
  assert.match(semiBranch, /f\.refusals = r/);
});

// ── The docs (AE6's other half) ───────────────────────────────────────────────
//
// A stale status doc is what this project's golden rule exists to prevent, and "end to end" was
// being used loosely enough that three different readers could have taken three different meanings
// from it. These assertions are deliberately about the CLAIMS, not the prose: they fail if the
// single source for "what has met a real employer" disappears, or if a doc goes back to asserting
// something the code does not do.

test("ONE place states which paths have met a real employer", () => {
  const status = fs.readFileSync("docs/GATED_HANDOFF_STATUS.md", "utf8");
  assert.match(status, /## 8\. What has run against a real employer, and what has not/);
  // The three facts the section exists to state.
  assert.match(status, /\*\*Unattended, SUBMITTING\*\* \| `full` \| \*\*NO\*\*/,
    "the submitting path's status is the one that matters most and must be unambiguous");
  assert.match(status, /`ab1HeldHandoff`'s end-to-end proof was `semi`, against `fakeAts`/);
  assert.match(status, /the human's reading of the form is the only check[\s\S]{0,8}that runs/,
    "the attended path running no automated checks has to be said, not implied");
  // And the header points at it, so a reader quoting "end to end" from §1 is sent there first.
  assert.match(status, /Read §8 before quoting anything/);
});

test("the docs that could be read as an end-to-end claim point at that one place", () => {
  for (const f of ["docs/auto-apply-a5-live-run.md", "docs/PIPELINE_DIAGNOSIS.md"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.match(src, /GATED_HANDOFF_STATUS\.md.{0,4}§8/s,
      `${f} must point at the single source rather than carry a second copy of the table`);
    assert.match(src, /AE6/, `${f} was not dated to the correction`);
  }
});

test("the 'unmeasured on a real SPA' claim is gone, because it was measured", () => {
  // It was true when written and is not any more: readiness settled at 32 stable controls and
  // discovery found 15 fields on the exact posting the original blocker came from. Leaving the claim
  // standing would send the next reader to re-do work, and would misattribute AE1's cause.
  for (const f of ["docs/GATED_HANDOFF_ARCHITECTURE.md", "docs/GATED_HANDOFF_STATUS.md"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.ok(!/Discovery on a real, heavy SPA is unmeasured\.\*\*\s*G4/.test(src),
      `${f} still asserts discovery is unmeasured on a real SPA`);
    assert.match(src, /15 fields/, `${f} should carry the measurement that replaced the claim`);
  }
});

test("the no-real-ATS convention still stands, with its exception scoped", () => {
  // The rule is load-bearing and must not read as relaxed. What the exception permits is named
  // exactly: read-only diagnosis, and the two non-submitting modes under a fixture identity.
  for (const f of ["docs/GATED_HANDOFF_PROMPTS.md", "docs/AUTOAPPLY_PROMPTS.md"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.match(src, /THE ONE EXCEPTION, and its exact scope/, `${f} does not record the exception`);
    assert.match(src, /FIXTURE identity/, `${f} does not say the identity was a placeholder`);
    assert.match(src, /never run against a real[\s\S]{0,8}employer/,
      `${f} must still say mode:'full' has never met a real employer`);
  }
  // And the guard the claim rests on is real code, not a promise in a doc.
  const verify = fs.readFileSync("scripts/ae1LiveVerify.mjs", "utf8");
  assert.match(verify, /REFUSING: /);
  assert.match(verify, /does not look like a /);
  assert.match(verify, /mode: MODE, jobId/);
  assert.ok(!/"full"/.test(verify), "the live verifier must never be able to select the submitting mode");
});
