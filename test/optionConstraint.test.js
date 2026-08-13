// A1 finding #2 (HIGH): the select "Are you legally authorized to work in the country of
// employment?" (options Yes/No) received the free-text string "Authorized to work in the US
// (F-1 STEM OPT)" at 0.9 confidence. It held only because that string matches no option, so the
// page-side fill was a no-op — but the run still RECORDED it as a confident answer, and nothing
// noticed a required eligibility field had actually been left empty.
import test from "node:test";
import assert from "node:assert/strict";
import {
  matchOptionValue, isYesNoOptionSet, workAuthAffirmative, buildAnswers,
} from "../services/applyAutomation.js";

const YES_NO = [{ value: "", label: "Select..." }, { value: "Yes", label: "Yes" }, { value: "No", label: "No" }];
const STATES = [{ value: "MA", label: "Massachusetts" }, { value: "CT", label: "Connecticut" }];

const authField = (overrides = {}) => ({
  field_id: "f1", name: "job_application[legally_authorized]", type: "select",
  handler_type: "work-auth",
  label: "Are you legally authorized to work in the country of employment?",
  is_required: true, options: YES_NO, ...overrides,
});

test("a value the control cannot hold is refused, not recorded as answered", () => {
  const [a] = buildAnswers([authField({ handler_type: null, label: "Pick a colour", options: [{ value: "red", label: "Red" }] })], {
    handler_map: {}, custom_answers: {}, field_map: { name: "chartreuse" },
  });
  // Either unresolved or refused — what must NOT happen is a confident answer holding "chartreuse".
  assert.notEqual(a?.value, "chartreuse");
});

test("the exact A1 case now answers Yes", () => {
  const [a] = buildAnswers([authField()], {
    handler_map: {}, custom_answers: {},
    field_map: { work_auth: "Authorized to work in the US (F-1 STEM OPT)" },
  });
  assert.equal(a.skipped, undefined, "the answer is knowable — must not be skipped");
  assert.equal(a.value, "Yes");
});

test("a negative status answers No, never Yes", () => {
  const [a] = buildAnswers([authField()], {
    handler_map: {}, custom_answers: {},
    field_map: { work_auth: "Not authorized to work in the US" },
  });
  assert.equal(a.value, "No");
});

test("an unreadable status REFUSES rather than guessing", () => {
  // "Requires H-1B transfer" is about SPONSORSHIP, a different question. Guessing here would be a
  // materially false attestation.
  const [a] = buildAnswers([authField()], {
    handler_map: {}, custom_answers: {},
    field_map: { work_auth: "Requires H-1B transfer" },
  });
  assert.equal(a.skipped, true);
  assert.equal(a.value, null);
  assert.ok((a.refusals || []).some(r => /value_not_in_options/.test(r)));
});

test("work-auth status reading is negative-first", () => {
  assert.equal(workAuthAffirmative("Authorized to work in the US (F-1 STEM OPT)"), true);
  assert.equal(workAuthAffirmative("US Citizen"), true);
  assert.equal(workAuthAffirmative("Permanent Resident"), true);
  assert.equal(workAuthAffirmative("Not authorized to work"), false);
  assert.equal(workAuthAffirmative("No work authorization"), false);
  // A denial must not be flipped by a positive word later in the same sentence.
  assert.equal(workAuthAffirmative("Not authorized to work; will need work authorization"), false);
  assert.equal(workAuthAffirmative("Requires H-1B transfer"), null);
  assert.equal(workAuthAffirmative(""), null);
});

test("option matching mirrors the page-side matcher, so nothing that filled stops filling", () => {
  // APPLY_FN_SRC selects an option when opt.text OR opt.value contains the answer, case-insensitive.
  assert.equal(matchOptionValue("No", YES_NO), "No");
  assert.equal(matchOptionValue("Yes", YES_NO), "Yes");
  assert.equal(matchOptionValue("Authorized to work in the US (F-1 STEM OPT)", YES_NO), null);
  // Substring behaviour preserved: a state dropdown keyed by code or by name still resolves.
  assert.equal(matchOptionValue("MA", STATES), "MA");
  assert.equal(matchOptionValue("Massachusetts", STATES), "MA");
  assert.equal(matchOptionValue("Wyoming", STATES), null);
});

test("the direct sponsorship select is unchanged", () => {
  // Greenhouse's sponsorship question was already correct; the option constraint must not alter it.
  const [a] = buildAnswers([{
    field_id: "f2", name: "job_application[requires_sponsorship]", type: "select",
    handler_type: "sponsorship",
    label: "Do you now or in the future require sponsorship for work authorization?",
    is_required: true, options: YES_NO,
  }], { handler_map: {}, custom_answers: {}, field_map: { requires_sponsorship: "No" } });
  assert.equal(a.value, "No");
  assert.equal(a.skipped, undefined);
});

test("isYesNoOptionSet ignores a placeholder and rejects richer sets", () => {
  assert.equal(isYesNoOptionSet(YES_NO), true);
  assert.equal(isYesNoOptionSet([{ value: "Yes", label: "Yes" }, { value: "No", label: "No" }]), true);
  assert.equal(isYesNoOptionSet(STATES), false);
  assert.equal(isYesNoOptionSet([{ value: "Yes", label: "Yes" }, { value: "No", label: "No" }, { value: "Maybe", label: "Maybe" }]), false);
});
