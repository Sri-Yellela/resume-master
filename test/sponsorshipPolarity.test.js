// A1 finding #1 (CRITICAL): the checkbox "I am authorized to work without sponsorship" was
// answered FALSE from a profile whose requires_sponsorship is "No". Those statements agree — not
// requiring sponsorship IS being authorized without it — so the resolver attested the OPPOSITE of
// the truth, at 0.9 confidence, above the auto-submit floor. It held only because an unchecked
// required checkbox reads as empty to the completeness gate: the field type saved it, not the code.
import test from "node:test";
import assert from "node:assert/strict";
import {
  booleanPolarity, sponsorshipQuestionSense, coerceAffirmative, buildAnswers, invertsKey,
} from "../services/applyAutomation.js";

const resolve = (label, key, stored) => {
  const pol = booleanPolarity({ label, name: "", key });
  if (pol === "unknown") return "REFUSE";
  const aff = coerceAffirmative(stored);
  return (pol === "invert" ? !aff : aff) ? "true" : "false";
};

test("the exact A1 case is answered correctly", () => {
  // requires_sponsorship = No  =>  authorized WITHOUT sponsorship = YES = checked.
  assert.equal(resolve("I am authorized to work without sponsorship", "requires_sponsorship", "No"), "true");
});

test("the inverted question is still answered correctly the other way", () => {
  // A candidate who DOES need sponsorship must not claim to be authorized without it.
  assert.equal(resolve("I am authorized to work without sponsorship", "requires_sponsorship", "Yes"), "false");
});

test("the direct question keeps its existing answers", () => {
  // The Greenhouse phrasing was already correct and must not regress.
  assert.equal(resolve("Do you now or in the future require sponsorship for work authorization?", "requires_sponsorship", "No"), "false");
  assert.equal(resolve("Do you now or in the future require sponsorship for work authorization?", "requires_sponsorship", "Yes"), "true");
  assert.equal(resolve("Will you require visa sponsorship now or in the future?", "requires_sponsorship", "No"), "false");
});

test("question sense reads both directions, and 'without' wins when both match", () => {
  assert.equal(sponsorshipQuestionSense("Do you require sponsorship?"), "needs");
  assert.equal(sponsorshipQuestionSense("Are you authorized to work without sponsorship?"), "without");
  assert.equal(sponsorshipQuestionSense("Do you NOT require sponsorship?"), "without");
  assert.equal(sponsorshipQuestionSense("No sponsorship required for this role?"), "without");
  // Satisfies both patterns; the negated reading is the correct one.
  assert.equal(sponsorshipQuestionSense("Authorized to work without requiring sponsorship"), "without");
  assert.equal(sponsorshipQuestionSense("What is your favourite colour?"), null);
});

test("an unreadable sponsorship question REFUSES rather than guessing", () => {
  // The fail-safe: a false attestation is worse than an unanswered field.
  assert.equal(booleanPolarity({ label: "Sponsorship", name: "", key: "requires_sponsorship" }), "unknown");
  assert.equal(resolve("Sponsorship", "requires_sponsorship", "No"), "REFUSE");
});

test("a key whose meaning we cannot state REFUSES", () => {
  assert.equal(booleanPolarity({ label: "I am authorized to work without sponsorship", name: "", key: "work_auth" }), "unknown");
});

test("other eligibility classes refuse rather than pass through", () => {
  // Only sponsorship has an enumerated vocabulary. Anything else must hold, not guess.
  assert.equal(booleanPolarity({ label: "Do you have a security clearance?", name: "", key: "has_clearance" }), "unknown");
  assert.equal(booleanPolarity({ label: "Are you a protected veteran?", name: "", key: "veteran_status" }), "unknown");
});

test("ordinary non-eligibility checkboxes are unchanged", () => {
  assert.equal(booleanPolarity({ label: "I agree to the terms and conditions", name: "", key: "agree" }), "direct");
  assert.equal(resolve("I agree to the terms and conditions", "agree", "yes"), "true");
  assert.equal(resolve("Subscribe to job alerts", "subscribe", "no"), "false");
});

test("invertsKey could not have caught this — documenting why", () => {
  // INVERSION_RE matches the label ("without") AND the key phrase ("requires sponsorship"), so the
  // two cancel out. This is why a direction-based check was needed rather than a negation-word one.
  assert.equal(invertsKey("I am authorized to work without sponsorship", "requires_sponsorship"), false);
});

test("buildAnswers checks the box end to end", () => {
  const fields = [{
    // handler_type is what discovery derives from the `…sponsorship` attribute, which is how the
    // real run reached the exact field_map path (matched_on = requires_sponsorship).
    field_id: "f1", name: "authorized_no_sponsorship", type: "checkbox", handler_type: "sponsorship",
    label: "I am authorized to work without sponsorship", is_required: true, options: [],
  }];
  const [a] = buildAnswers(fields, {
    handler_map: {}, custom_answers: {},
    field_map: { requires_sponsorship: "No" },
  });
  assert.equal(a.skipped, undefined, "must not be skipped — the answer is knowable");
  assert.equal(a.value, "true", "requires_sponsorship=No means authorized WITHOUT sponsorship");
});

test("buildAnswers refuses when the direction is unreadable", () => {
  const fields = [{
    field_id: "f1", name: "sponsorship_flag", type: "checkbox", handler_type: "sponsorship",
    label: "Sponsorship", is_required: true, options: [],
  }];
  const [a] = buildAnswers(fields, {
    handler_map: {}, custom_answers: {},
    field_map: { requires_sponsorship: "No" },
  });
  assert.equal(a.skipped, true);
  assert.equal(a.value, null);
  assert.ok((a.refusals || []).some(r => /undetermined_boolean_polarity/.test(r)));
});
