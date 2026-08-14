// A1 trap 4: SUBMIT_RE was ^-anchored, so Lever's "Review and Submit" never matched and a fully
// filled, fully gated application silently ended as filled_not_submitted. This regex decides which
// button gets CLICKED to send a real application under a real person's name, so the tests below
// pin BOTH directions: the phrasings that must now match, and the look-alikes that must not.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { classifySubmitLabel } from "../services/applyAutomation.js";

const automation = fs.readFileSync("services/applyAutomation.js", "utf8");

test("the qualifier-before-verb phrasings real ATSes use now match", () => {
  // Every one of these was rejected by the ^ anchor.
  for (const label of ["Review and Submit", "Confirm and Submit", "Finish and Submit", "REVIEW AND SUBMIT"]) {
    assert.equal(classifySubmitLabel(label), 2, `${label} must be recognised as the submit control`);
  }
});

test("plain submit labels still match", () => {
  for (const label of ["Submit", "Submit Application", "Submit application", "Send Application", "Submit Application "]) {
    assert.equal(classifySubmitLabel(label), 2);
  }
});

test("Apply matches only as the whole label", () => {
  assert.equal(classifySubmitLabel("Apply"), 1);
  assert.equal(classifySubmitLabel("Apply Now"), 1);
  assert.equal(classifySubmitLabel("apply now"), 1);
  // "apply" is a common verb for controls that submit nothing — this is why it is not
  // accepted mid-label the way "submit" is.
  assert.equal(classifySubmitLabel("Apply filters"), 0);
  assert.equal(classifySubmitLabel("Apply Filters"), 0);
  assert.equal(classifySubmitLabel("Apply coupon"), 0);
});

test("submit-shaped buttons doing a different job are rejected", () => {
  // Dropping the ^ anchor without this list would make every one of these clickable.
  for (const label of [
    "Submit feedback", "Submit a question", "Submit comment", "Submit an inquiry",
    "Report this job", "Withdraw application", "Save for later", "Save as draft",
    "Subscribe", "Refer a friend", "Cancel", "Delete",
  ]) {
    assert.equal(classifySubmitLabel(label), 0, `${label} must never be clicked as the submit control`);
  }
});

test("non-submit navigation is untouched", () => {
  for (const label of ["Next", "Continue", "Back", "Previous", "Save and Continue", ""]) {
    assert.equal(classifySubmitLabel(label), 0);
  }
});

test("strong candidates outrank weak ones", () => {
  // A page offering both "Apply" and "Review and Submit" must click the latter.
  assert.ok(classifySubmitLabel("Review and Submit") > classifySubmitLabel("Apply"));
});

test("the anchored regex is gone and selection is scored, not first-match", () => {
  // Target the CODE, not the prose: the comment above classifySubmitLabel quotes the old
  // pattern on purpose, to record what was wrong with it.
  assert.doesNotMatch(automation, /const SUBMIT_RE\s*=/,
    "the ^-anchored SUBMIT_RE is the defect; it must not come back");
  // \b matters: without it this also matches NOT_SUBMIT_RE.test( and STRONG_SUBMIT_RE.test( —
  // the same unanchored-substring mistake this whole commit is about.
  assert.doesNotMatch(automation, /\bSUBMIT_RE\.test\(/,
    "button matching must go through classifySubmitLabel");
  assert.match(automation, /classifySubmitLabel\(txt\)/);
  assert.match(automation, /scored\.sort\(\(a, b\) => b\.score - a\.score\)/,
    "candidates must be ranked — first-match was only safe while the pattern was anchored");
  // The frame scope guard must survive: a submit-shaped button in an untouched third-party
  // frame (ad, captcha, analytics) must remain unreachable.
  assert.match(automation, /const submitCandidates = \[page\.mainFrame\(\), \.\.\.touchedFrames\]/,
    "submit scanning must stay scoped to the main frame plus frames we actually filled");
});

test("post-click evidence is still required", () => {
  // Broadening the matcher raises the cost of a wrong click, so the N1 guarantee that
  // 'submitted' requires evidence must still be in place.
  assert.match(automation, /clicked_no_evidence|submitVerified/);
});
