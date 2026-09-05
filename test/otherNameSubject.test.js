// A DIFFERENT NAME FOR THE SAME PERSON — the "Preferred Name" defect.
//
// OBSERVED (AL8, on the Ashby SPA fixture): the field labelled "Preferred Name (if applicable)" has
// a bare GUID for a control name, so only its LABEL can resolve it. The generic label map's `"Name"`
// needle is a whole token in that label, so it matched, and the candidate's LEGAL name was typed
// into the preferred-name box at `field_map_exact` — 0.9 confidence, the second-highest tier.
//
//     buildAnswers:  "Preferred Name (if applicable)"  =  "Ada Lovelace"   field_map_exact
//
// This is the A1 name_ambiguity class one step milder than "Name of Referrer": nothing false is
// asserted about a third party, because it is still the candidate's own name. It is still wrong. A
// preferred name is a DIFFERENT DATUM — the entire reason a form asks for it separately is that it
// may not be the legal one — and answering it from the legal name silently overwrites a question
// the candidate was being offered the chance to answer.
//
// ⛔ THE FAILURE MODE OF THE FIX IS WORSE THAN THE BUG. A rule that swallowed ordinary name fields
// would leave every application nameless, so the "still fills" half below is the more important
// half of this file.

import test from "node:test";
import assert from "node:assert/strict";
import {
  refuseReason, sanitizeDiscoveredFields, buildAnswers,
  OTHER_NAME_SUBJECT_RE, CANONICAL_NAME_HANDLERS,
} from "../services/applyAutomation.js";

const reason = (label, handler = "full-name", key = null) =>
  refuseReason({ label, name: "", handler, key });

// ── THE ORDINARY NAME FIELDS STILL FILL ─────────────────────────────────────────────────────────

test("⛔ every ordinary name label is UNAFFECTED", () => {
  // The qualifier is required. Without this, the fix is worse than the defect.
  for (const label of ["Name", "Full Name", "Full name", "Legal Name", "Full Legal Name",
                       "First Name", "Last Name", "Given Name", "Family Name", "Surname",
                       "Your name", "Candidate Name", "Name *"]) {
    assert.equal(reason(label), null, `${label} must still resolve to the candidate's name`);
  }
});

test("a bare 'Name' is not caught by the qualifier pattern", () => {
  assert.ok(!OTHER_NAME_SUBJECT_RE.test("Name"));
  assert.ok(!OTHER_NAME_SUBJECT_RE.test("Full Legal Name"));
  assert.ok(!OTHER_NAME_SUBJECT_RE.test("First Name"));
});

// ── THE OTHER-NAME FIELDS ARE REFUSED ───────────────────────────────────────────────────────────

test("⛔ a name field qualified as a DIFFERENT name refuses the canonical name", () => {
  for (const label of ["Preferred Name (if applicable)", "Preferred Name", "Preferred First Name",
                       "Nickname", "Nick Name", "Maiden Name", "Former Name", "Former Names",
                       "Previous Name", "Chosen Name", "Other Names", "Alias Name",
                       "What name do you go by?", "Name you prefer"]) {
    assert.equal(reason(label), "other_name_subject", `${label} must not be filled with the legal name`);
  }
});

test("it applies to first-name and last-name handlers too, not just full-name", () => {
  // Workday asks "Preferred First Name" separately from "Legal First Name".
  for (const handler of CANONICAL_NAME_HANDLERS) {
    assert.equal(reason("Preferred First Name", handler), "other_name_subject", handler);
  }
});

test("it is keyed on the SOURCE, so an other-name key answering an other-name field passes", () => {
  // This blocks the wrong source, not the field. If a `preferred_name` value ever exists, it is
  // exactly the right answer here and must not be refused by its own rule.
  assert.equal(refuseReason({ label: "Preferred Name", key: "preferred_name", handler: null }), null);
  assert.equal(refuseReason({ label: "Nickname", key: "nickname", handler: null }), null);
});

test("a non-name key is not refused by THIS rule", () => {
  // The rule is about which NAME answers a name question. It must not become a general veto on
  // anything whose label happens to contain "preferred".
  assert.equal(refuseReason({ label: "Preferred Name", key: "email", handler: "email" }), null);
  assert.equal(reason("Preferred Work Location", "location"), null);
  assert.equal(reason("Preferred pronouns", null, "pronouns"), null);
});

// ── IT DOES NOT DISPLACE THE OLDER, MORE SERIOUS RULE ───────────────────────────────────────────

test("a third-party name is still refused as third_party_subject, not downgraded", () => {
  // "Name of Referrer" is a different PERSON — a more serious claim than a different name for the
  // same person — and it must keep its own reason so the two stay distinguishable in an audit.
  assert.equal(reason("Name of Referrer"), "third_party_subject");
  assert.equal(reason("Emergency Contact Name"), "third_party_subject");
});

test("eligibility still outranks both", () => {
  assert.match(reason("Do you require sponsorship?", "full-name") || "", /eligibility_class/);
});

// ── END TO END THROUGH THE REAL RESOLUTION PATH ─────────────────────────────────────────────────

/** The Ashby SPA shape exactly: a bare GUID control name, so only the label can resolve it. */
const ashbyFields = () => ([
  { label: "Legal Name", name: "_systemfield_name", type: "text", is_required: true,
    handler_type: "full-name", handler_source: "label", field_id: "f_legal" },
  { label: "Preferred Name (if applicable)", name: "09a328e0-8d57-4f88-86ab-688de1657b17",
    type: "text", is_required: false, handler_type: "full-name", handler_source: "label", field_id: "f_pref" },
]);

test("the legal name fills and the preferred name does NOT", () => {
  const fields = sanitizeDiscoveredFields(ashbyFields());
  const answers = buildAnswers(fields, { field_map: { full_name: "Ada Lovelace" }, handler_map: {}, custom_answers: {} });
  const filled = answers.filter(a => !a.skipped && !a.policy_rejected);

  assert.equal(filled.length, 1, "exactly one name field may be filled");
  assert.equal(filled[0].label, "Legal Name");
  assert.equal(filled[0].value, "Ada Lovelace");
  assert.ok(!filled.some(a => /preferred/i.test(a.label || "")),
    "the preferred-name box must be left for the candidate");
});

test("the refusal is RECORDED, not silent", () => {
  // A field that quietly stops being filled is indistinguishable from one the form never had. The
  // reason travels on the field so the fill log can say why, and so the run can report it as an
  // open question rather than as an absence.
  const [, preferred] = sanitizeDiscoveredFields(ashbyFields());
  assert.equal(preferred.handler_type, null);
  assert.equal(preferred.handler_rejected, "full-name:other_name_subject");
});

test("a required preferred-name field becomes an unanswered question, not a wrong answer", () => {
  // The safe direction: the run holds and the candidate is told, rather than an employer receiving
  // a preferred name the candidate never gave.
  const fields = sanitizeDiscoveredFields([
    { label: "Preferred Name", name: "guid-1", type: "text", is_required: true,
      handler_type: "full-name", handler_source: "label", field_id: "f_pref" },
  ]);
  const answers = buildAnswers(fields, { field_map: { full_name: "Ada Lovelace" }, handler_map: {}, custom_answers: {} });
  assert.ok(!answers.some(a => !a.skipped && a.value === "Ada Lovelace"),
    "no legal name may reach a required preferred-name field either");
});
