// The A5 live-run review found the failure the DIRECTION layer (sponsorshipPolarity.test.js) does
// not cover: TENSE. `requires_sponsorship` is one boolean, and the standard Greenhouse question is
// "do you NOW OR IN THE FUTURE require sponsorship". For a candidate on F-1 STEM OPT both readings
// are true at once and they disagree — no sponsorship needed today, H-1B needed when OPT expires —
// so the boolean answered the future-tense question "No". A false material attestation, submitted
// at handler_exact/1.0, the most trustworthy tier the resolver has, with no flag raised.
//
// The A1 trap matrix could not catch it: its payload carries no sponsorship key, so it exercised
// the fallthrough refusal. buildAutofillPayload does carry one. See docs/auto-apply-a5-live-run.md.
import test from "node:test";
import assert from "node:assert/strict";
import {
  sponsorshipQuestionTense, sponsorshipAnswer, resolveSponsorshipNeed, buildAnswers,
  SPONSORSHIP_NEEDS, PROVENANCE, CONFIDENCE_BY_PROVENANCE, AUTO_SUBMIT_MIN_CONFIDENCE,
} from "../services/applyAutomation.js";

const GREENHOUSE_Q = "Do you now or in the future require sponsorship for work authorization?";

// ── the question's tense ─────────────────────────────────────────────────────
test("the canonical Greenhouse wording reads as FUTURE, though it also says 'now'", () => {
  // Both markers are present. If 'now' won, the whole fix would invert.
  assert.equal(sponsorshipQuestionTense(GREENHOUSE_Q), "future");
});

test("an explicitly present-tense question reads as present", () => {
  assert.equal(sponsorshipQuestionTense("Do you currently require sponsorship?"), "present");
  assert.equal(sponsorshipQuestionTense("Do you require sponsorship at this time?"), "present");
});

test("a question naming no tense reads as null, so the caller decides deliberately", () => {
  assert.equal(sponsorshipQuestionTense("Do you require sponsorship?"), null);
});

// ── the situation, from a profile row ────────────────────────────────────────
test("an explicit tri-state wins over the legacy boolean", () => {
  assert.equal(resolveSponsorshipNeed({ sponsorship_need: "future", requires_sponsorship: 0 }), "future");
  assert.equal(resolveSponsorshipNeed({ sponsorship_need: "none", requires_sponsorship: 1 }), "none");
});

test("the legacy boolean set TRUE is unambiguous — sponsorship needed now", () => {
  assert.equal(resolveSponsorshipNeed({ requires_sponsorship: 1 }), "now");
});

test("THE BUG: boolean 0 on a time-limited status REFUSES rather than guessing 'none'", () => {
  // This is user 15's exact stored shape before the fix. 0 was set against the present-tense
  // reading, so it cannot be promoted to "never needs sponsorship".
  assert.equal(resolveSponsorshipNeed({
    requires_sponsorship: 0, visa_type: "F-1 OPT",
    work_auth: "Authorized to work in the US (F-1 STEM OPT)",
  }), null);
  assert.equal(resolveSponsorshipNeed({ requires_sponsorship: 0, visa_type: "H-1B" }), null);
  assert.equal(resolveSponsorshipNeed({ requires_sponsorship: 0, work_auth: "J-1 visa" }), null);
});

test("boolean 0 with no visa signal at all is 'none' — the citizen case is not disturbed", () => {
  assert.equal(resolveSponsorshipNeed({ requires_sponsorship: 0 }), "none");
  assert.equal(resolveSponsorshipNeed({}), "none");
  assert.equal(resolveSponsorshipNeed({
    requires_sponsorship: 0, work_auth: "Authorized to work in the US",
  }), "none");
});

// ── the answer, per tense ────────────────────────────────────────────────────
const answer = (label, need) => {
  const r = sponsorshipAnswer({ label, name: "", need });
  return r === null ? "REFUSE" : (r.affirmative ? "Yes" : "No");
};

test("THE CASE THAT WOULD HAVE BEEN SUBMITTED FALSELY: OPT, future-tense question", () => {
  assert.equal(answer(GREENHOUSE_Q, "future"), "Yes",
    "an OPT candidate WILL require sponsorship; the old code answered No at confidence 1.0");
});

test("the same candidate answers the present-tense question the other way, and both are true", () => {
  assert.equal(answer("Do you currently require sponsorship?", "future"), "No");
  assert.equal(answer(GREENHOUSE_Q, "future"), "Yes");
});

test("a citizen answers No to both tenses", () => {
  assert.equal(answer(GREENHOUSE_Q, "none"), "No");
  assert.equal(answer("Do you currently require sponsorship?", "none"), "No");
});

test("someone needing sponsorship to start answers Yes to both tenses", () => {
  assert.equal(answer(GREENHOUSE_Q, "now"), "Yes");
  assert.equal(answer("Do you currently require sponsorship?", "now"), "Yes");
});

test("the inverted direction is still handled, per tense", () => {
  // "authorized to work WITHOUT sponsorship" states the opposite sense.
  assert.equal(answer("Are you currently authorized to work without sponsorship?", "future"), "Yes");
  assert.equal(answer("Will you be authorized to work without sponsorship in the future?", "future"), "No");
  assert.equal(answer("Are you currently authorized to work without sponsorship?", "none"), "Yes");
});

test("an untensed question takes the DISCLOSING reading, in both directions", () => {
  // The choice is not arbitrary: across both directions the future-inclusive answer is the one
  // that discloses the need. Over-disclosing is honest; the opposite error misrepresents.
  assert.equal(answer("Do you require sponsorship?", "future"), "Yes");
  assert.equal(answer("Are you authorized to work without sponsorship?", "future"), "No");
  assert.equal(sponsorshipAnswer({ label: "Do you require sponsorship?", need: "future" }).assumed, true);
  assert.equal(sponsorshipAnswer({ label: GREENHOUSE_Q, need: "future" }).assumed, false);
});

test("an unknown situation refuses, and so does an unreadable direction", () => {
  assert.equal(answer(GREENHOUSE_Q, null), "REFUSE");
  assert.equal(answer(GREENHOUSE_Q, "maybe"), "REFUSE");
  assert.equal(answer("Sponsorship", "future"), "REFUSE");
});

test("the tri-state vocabulary is exactly three values", () => {
  assert.deepEqual([...SPONSORSHIP_NEEDS].sort(), ["future", "none", "now"]);
});

// ── through buildAnswers, which is what actually runs ────────────────────────
const sponsorshipSelect = {
  field_id: "f1", name: "job_application[requires_sponsorship]", type: "select",
  handler_type: "sponsorship", label: GREENHOUSE_Q, is_required: true,
  options: [{ value: "", label: "Select..." }, { value: "1", label: "Yes" }, { value: "0", label: "No" }],
};

test("END TO END: the future-tense select is answered Yes, not the stored No", () => {
  const [a] = buildAnswers([sponsorshipSelect], {
    // Exactly what buildAutofillPayload emits: the static "No" IS present, and must lose.
    handler_map: { sponsorship: "No" },
    field_map: { requires_sponsorship: "No", sponsorship: "No" },
    custom_answers: {},
    sponsorship_need: "future",
  });
  assert.equal(a.skipped, undefined);
  assert.equal(a.value, "1", "must select the option labelled Yes");
  assert.equal(a.provenance, PROVENANCE.SPONSORSHIP_DERIVED);
});

test("the static handler_map value can no longer reach a sponsorship field", () => {
  // Step 1 applies no guard at all, which is how handler_map['sponsorship'] = "No" reached a
  // future-tense question at confidence 1.0. Closing it is the load-bearing change.
  const [a] = buildAnswers([sponsorshipSelect], {
    handler_map: { sponsorship: "No" }, field_map: {}, custom_answers: {},
    sponsorship_need: "future",
  });
  assert.notEqual(a.provenance, PROVENANCE.HANDLER_EXACT);
  assert.equal(a.value, "1");
});

test("the candidate's own answer to this exact question still wins over derivation", () => {
  const [a] = buildAnswers([sponsorshipSelect], {
    handler_map: { sponsorship: "No" }, field_map: {},
    custom_answers: { [GREENHOUSE_Q]: "No" },
    sponsorship_need: "future",
  });
  assert.equal(a.provenance, PROVENANCE.CUSTOM_ANSWER);
  assert.equal(a.value, "0");
});

test("a present-tense select gets the other answer from the same profile", () => {
  const [a] = buildAnswers([{
    ...sponsorshipSelect, label: "Do you currently require sponsorship to work in the US?",
  }], {
    handler_map: { sponsorship: "No" }, field_map: {}, custom_answers: {},
    sponsorship_need: "future",
  });
  assert.equal(a.value, "0", "answered No — the question scopes itself to today");
});

test("a present-but-null tri-state REFUSES; it does not fall back to the boolean", () => {
  const [a] = buildAnswers([sponsorshipSelect], {
    handler_map: { sponsorship: "No" }, field_map: { requires_sponsorship: "No" },
    custom_answers: {}, sponsorship_need: null,
  });
  assert.equal(a.skipped, true);
  assert.equal(a.value, null);
  assert.ok((a.refusals || []).some(r => /unknown_sponsorship_need/.test(r)), JSON.stringify(a.refusals));
});

test("a payload with NO tri-state key keeps the legacy path — nothing that worked stops working", () => {
  // The extension payload and the A1-era tests do not carry sponsorship_need. They must be
  // unaffected, or this fix breaks every caller that predates it.
  const [a] = buildAnswers([{
    field_id: "f1", name: "authorized_no_sponsorship", type: "checkbox", handler_type: "sponsorship",
    label: "I am authorized to work without sponsorship", is_required: true, options: [],
  }], {
    handler_map: {}, custom_answers: {}, field_map: { requires_sponsorship: "No" },
  });
  assert.equal(a.skipped, undefined);
  assert.equal(a.value, "true", "the A1 behaviour is preserved when no tri-state is supplied");
});

test("a derived answer on a CHECKBOX is not re-inverted by the polarity layer", () => {
  // sponsorshipAnswer already resolved the direction, and matched_on names the tri-state rather
  // than a canonical boolean key — so running booleanPolarity over it would refuse outright.
  const [a] = buildAnswers([{
    field_id: "f1", name: "authorized_no_sponsorship", type: "checkbox", handler_type: "sponsorship",
    label: "I am authorized to work without sponsorship", is_required: true, options: [],
  }], {
    handler_map: {}, field_map: {}, custom_answers: {}, sponsorship_need: "none",
  });
  assert.equal(a.skipped, undefined, "must not refuse: the answer is knowable");
  assert.equal(a.value, "true", "a citizen IS authorized to work without sponsorship");

  const [b] = buildAnswers([{
    field_id: "f1", name: "authorized_no_sponsorship", type: "checkbox", handler_type: "sponsorship",
    label: "I am authorized to work without sponsorship", is_required: true, options: [],
  }], {
    handler_map: {}, field_map: {}, custom_answers: {}, sponsorship_need: "now",
  });
  assert.equal(b.value, "false", "someone needing sponsorship now is NOT authorized without it");
});

// ── confidence ───────────────────────────────────────────────────────────────
test("an assumed tense scores below the auto-submit floor so full-auto asks a human", () => {
  const assumed = CONFIDENCE_BY_PROVENANCE[PROVENANCE.SPONSORSHIP_ASSUMED_FUTURE];
  const derived = CONFIDENCE_BY_PROVENANCE[PROVENANCE.SPONSORSHIP_DERIVED];
  assert.ok(assumed < AUTO_SUBMIT_MIN_CONFIDENCE, `${assumed} must be < ${AUTO_SUBMIT_MIN_CONFIDENCE}`);
  assert.ok(derived >= AUTO_SUBMIT_MIN_CONFIDENCE, `${derived} must clear ${AUTO_SUBMIT_MIN_CONFIDENCE}`);
});

test("an untensed question through buildAnswers is marked assumed, not certain", () => {
  const [a] = buildAnswers([{
    ...sponsorshipSelect, label: "Do you require visa sponsorship?",
  }], {
    handler_map: {}, field_map: {}, custom_answers: {}, sponsorship_need: "future",
  });
  assert.equal(a.provenance, PROVENANCE.SPONSORSHIP_ASSUMED_FUTURE);
  assert.equal(a.value, "1");
  assert.ok(a.confidence < AUTO_SUBMIT_MIN_CONFIDENCE);
});
