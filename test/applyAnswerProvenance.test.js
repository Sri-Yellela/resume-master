import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAnswers, lowConfidenceAnswers, sanitizeDiscoveredFields,
  coerceAffirmative, eligibilityClassOf, matchesWholeToken, invertsKey,
  refuseReason, formatDateForHint,
  PROVENANCE, CONFIDENCE_BY_PROVENANCE, AUTO_SUBMIT_MIN_CONFIDENCE, CLEAR_FIRST_MIN_CONFIDENCE,
} from "../services/applyAutomation.js";

// TASK A2 regression cover. The two tests the task names explicitly — sponsorship inversion and
// lowercase-yes — are the ones that produce FALSE EMPLOYER ATTESTATIONS, so they come first.
// Full diagnosis of what these replay: docs/auto-apply-a1-trap-matrix.md.

const field = (over = {}) => ({
  field_id: "f", name: "f", type: "text", label: "", is_required: false,
  options: [], handler_type: null, handler_source: null, current_value: "", ...over,
});

// ── The two named regressions ────────────────────────────────────────────────

test("sponsorship inversion: a work-authorization value may never answer a sponsorship question", () => {
  // The exact A1 trap. This label mentions BOTH concepts, and "work authorization" is literally a
  // substring of it, which is how a work_authorization key came to answer it.
  const label = "Do you now or in the future require sponsorship for work authorization?";
  const fields = [field({
    field_id: "sp", name: "job_application[requires_sponsorship]", type: "select", label,
    is_required: true, handler_type: "sponsorship", handler_source: "attr",
    options: [{ value: "", label: "Select..." }, { value: "Yes", label: "Yes" }, { value: "No", label: "No" }],
  })];

  // A yes/no-shaped value is the harmful case: it is selectable in the dropdown, so pre-fix it was
  // submitted as "Yes" — telling an employer the candidate requires sponsorship.
  for (const workAuth of ["Yes", "No", "Authorized to work in the US", "US Citizen"]) {
    const answers = buildAnswers(fields, { field_map: { work_authorization: workAuth } });
    const filled = answers.filter(a => !a.skipped);
    assert.equal(filled.length, 0,
      `work_authorization=${JSON.stringify(workAuth)} must not produce a sponsorship answer`);
    assert.deepEqual(answers[0].refusals, ["work_authorization:eligibility_class:sponsorship"]);
  }

  // The canonical key still answers it — the guard blocks the wrong key, not the field. This
  // resolves via HANDLER_TO_PROFILE_KEYS: handler 'sponsorship' <- profile key
  // 'requires_sponsorship'. Without that reverse lookup the guard would be safe but useless,
  // because no key could ever answer a sponsorship field.
  const ok = buildAnswers(fields, { field_map: { requires_sponsorship: "No" } });
  assert.equal(ok[0].value, "No");
  assert.equal(ok[0].provenance, PROVENANCE.FIELD_MAP_EXACT);
  assert.equal(ok[0].matched_on, "requires_sponsorship");
});

test("lowercase yes: 'yes' checks the box; unrecognised values never become an affirmative", () => {
  // Pre-fix: value === 'Yes' (capital only), so 'yes' fell through to 'false' and silently
  // answered No on a checkbox the candidate had said yes to.
  const cb = [field({ field_id: "ack", name: "ack", type: "checkbox", label: "Willing to relocate" })];

  for (const v of ["yes", "Yes", "YES", "y", "true", "TRUE", "1", "on", "agree"]) {
    const [a] = buildAnswers(cb, { field_map: { willing_to_relocate: v } });
    assert.equal(a.value, "true", `${JSON.stringify(v)} must coerce to an affirmative`);
  }
  // FAIL-SAFE DIRECTION: never invent an affirmative from something unrecognised.
  for (const v of ["no", "No", "false", "0", "maybe", "n/a", "unknown", " ", "yes please"]) {
    const [a] = buildAnswers(cb, { field_map: { willing_to_relocate: v } });
    assert.equal(a.value, "false", `${JSON.stringify(v)} must NOT become an affirmative`);
  }
  assert.equal(coerceAffirmative(true), true);
  assert.equal(coerceAffirmative(undefined), false);
  assert.equal(coerceAffirmative(null), false);
});

// ── Provenance and confidence (requirement 1) ────────────────────────────────

test("every answer carries the rule that produced it, with a confidence", () => {
  const fields = [
    field({ field_id: "a", name: "a", label: "First Name", handler_type: "first-name", handler_source: "attr" }),
    field({ field_id: "b", name: "b", label: "Last Name",  handler_type: "last-name",  handler_source: "attr" }),
    field({ field_id: "c", name: "c", label: "Current company" }),
    field({ field_id: "d", name: "d", label: "How did you hear about us? (free text)" }),
  ];
  const answers = buildAnswers(fields, {
    handler_map:    { "first-name": "Ada" },
    field_map:      { last_name: "Lovelace", current_company: "Analytical Engines Ltd" },
    custom_answers: { "How did you hear about us?": "Your engineering blog" },
  });

  assert.deepEqual(answers.map(a => a.provenance), [
    PROVENANCE.HANDLER_EXACT, PROVENANCE.FIELD_MAP_EXACT, PROVENANCE.LABEL_FUZZY, PROVENANCE.CUSTOM_ANSWER,
  ]);
  for (const a of answers) {
    assert.equal(a.confidence, CONFIDENCE_BY_PROVENANCE[a.provenance], `${a.label} confidence`);
    assert.ok(a.matched_on, `${a.label} must record what it matched on`);
  }
  assert.equal(answers[0].confidence, 1.0, "an exact handler hit is the strongest signal");
});

test("clear_first is granted only to exact-path answers, so a guess cannot wipe an ATS-parsed value", () => {
  const fields = [
    field({ field_id: "a", name: "a", label: "Email", handler_type: "email", handler_source: "attr" }),
    field({ field_id: "b", name: "b", label: "Current company" }),
  ];
  const [exact, fuzzy] = buildAnswers(fields, {
    field_map: { email: "ada@example.com", current_company: "Analytical Engines Ltd" },
  });
  assert.equal(exact.clear_first, true);
  assert.equal(fuzzy.clear_first, false, "a label_fuzzy answer must not overwrite an existing value");
  assert.ok(fuzzy.confidence < CLEAR_FIRST_MIN_CONFIDENCE);
});

// ── Fuzzy matching restrictions (requirement 2) ──────────────────────────────

test("third-party subjects never receive the candidate's identity", () => {
  // "name" IS a whole token in "Name of Referrer", so token matching alone does not save us —
  // the third-party subject guard is what does.
  assert.equal(matchesWholeToken("Name of Referrer", "name"), true);

  const fields = [
    field({ field_id: "legal", name: "legal_name", label: "Legal Name" }),
    field({ field_id: "ref", name: "referrer_name", label: "Name of Referrer" }),
    field({ field_id: "emg", name: "emergency", label: "Emergency Contact Phone" }),
  ];
  const answers = buildAnswers(fields, { field_map: { name: "Ada Lovelace", phone: "+1 555 0100" } });
  const byId = Object.fromEntries(answers.map(a => [a.field_id, a]));

  assert.equal(byId.legal.value, "Ada Lovelace", "the candidate's own name field still resolves");
  assert.ok(byId.ref.skipped, "referrer must not receive the candidate's name");
  assert.deepEqual(byId.ref.refusals, ["name:third_party_subject"]);
  assert.ok(byId.emg.skipped, "emergency contact must not receive the candidate's phone");
});

test("discovery's label-map handler is re-vetted; attribute-derived handlers are trusted", () => {
  // N5: the label map's "Name" -> full_name matched "Name of Referrer" by substring and then
  // resolved through the EXACT field_map path — a wrong answer wearing high confidence.
  const fields = sanitizeDiscoveredFields([
    field({ name: "referrer_name", label: "Name of Referrer", handler_type: "full-name", handler_source: "label" }),
    field({ name: "job_application[requires_sponsorship]", label: "Do you require sponsorship?", handler_type: "sponsorship", handler_source: "attr" }),
    field({ name: "legal_name", label: "Legal Name", handler_type: "full-name", handler_source: "label" }),
  ]);
  assert.equal(fields[0].handler_type, null, "label-derived identity handler on a referrer field is stripped");
  assert.equal(fields[0].handler_rejected, "full-name:third_party_subject");
  assert.equal(fields[1].handler_type, "sponsorship", "attribute-derived handlers are an exact signal and survive");
  assert.equal(fields[2].handler_type, "full-name", "a legitimate label hit survives");
});

test("a key cannot fuzzy-match a label that inverts its sense", () => {
  assert.equal(invertsKey("Do you require sponsorship?", "sponsorship"), true);
  assert.equal(invertsKey("Are you unable to relocate?", "willing_to_relocate"), true);
  assert.equal(invertsKey("Current company", "current_company"), false);

  // Non-eligibility field, and one where the key genuinely token-matches the label, so the
  // inversion guard is what refuses it rather than token matching. ("unable to start" would be
  // rejected earlier by the token boundary, since "able" there is inside "unable".)
  const fields = [field({ field_id: "r", name: "r", label: "Do you require relocation assistance?" })];
  const answers = buildAnswers(fields, { field_map: { relocation: "Boston, MA" } });
  assert.ok(answers[0]?.skipped, "an inverted label must not be fuzzy-answered");
  assert.deepEqual(answers[0].refusals, ["relocation:inverted_label"]);

  // The token boundary independently rejects a key embedded in a longer word.
  assert.equal(matchesWholeToken("Are you unable to start immediately?", "able_to_start"), false);
});

test("eligibility classes are recognised, and the more specific subject wins", () => {
  assert.equal(eligibilityClassOf("Do you now or in the future require sponsorship for work authorization?"), "sponsorship");
  assert.equal(eligibilityClassOf("Are you legally authorized to work in the US?"), "work_auth");
  assert.equal(eligibilityClassOf("Do you hold an active security clearance?"), "clearance");
  assert.equal(eligibilityClassOf("Have you been convicted of a felony?"), "criminal");
  assert.equal(eligibilityClassOf("Gender"), "eeo");
  assert.equal(eligibilityClassOf("What is your current visa status?"), "visa");
  assert.equal(eligibilityClassOf("First Name"), null);

  for (const cls of ["clearance", "criminal", "eeo", "visa"]) {
    const label = { clearance: "Security clearance level", criminal: "Have you been convicted of a felony?",
      eeo: "Gender", visa: "Visa status" }[cls];
    assert.ok(refuseReason({ label, key: "full_name" }), `${cls} must refuse an unrelated key`);
  }
});

// ── custom_answers tightening (requirement 3) ───────────────────────────────

test("custom_answers no longer match in reverse, and only answer eligibility on an exact question", () => {
  // The dropped direction: ql.includes(lbl) let a two-character label claim any longer question.
  const shortLabel = [field({ field_id: "s", name: "s", label: "Do" })];
  const answers = buildAnswers(shortLabel, {
    custom_answers: { "Do you now or in the future require sponsorship?": "No" },
  });
  assert.equal(answers.filter(a => !a.skipped).length, 0, "a short label must not claim a long stored question");

  const elig = [field({
    field_id: "e", name: "e", type: "select", is_required: true,
    label: "Are you authorized to work without sponsorship?",
  })];
  // Exact question match IS allowed: the user answered precisely this question.
  const exact = buildAnswers(elig, {
    custom_answers: { "Are you authorized to work without sponsorship?": "yes" },
  });
  assert.equal(exact[0].value, "yes");
  assert.equal(exact[0].provenance, PROVENANCE.CUSTOM_ANSWER);
  // A merely-contained question is not, for an eligibility field.
  const partial = buildAnswers(elig, { custom_answers: { "authorized to work": "yes" } });
  assert.ok(partial[0]?.skipped, "partial question match must not answer an eligibility field");
});

// ── Low-confidence policy (requirement 5) ───────────────────────────────────

test("label_fuzzy answers are below the auto-submit floor and are reported", () => {
  const fields = [
    field({ field_id: "a", name: "a", label: "Email", handler_type: "email", handler_source: "attr" }),
    field({ field_id: "b", name: "b", label: "Current company" }),
  ];
  const answers = buildAnswers(fields, {
    field_map: { email: "ada@example.com", current_company: "Analytical Engines Ltd" },
  });
  const low = lowConfidenceAnswers(answers);
  assert.equal(low.length, 1);
  assert.equal(low[0].provenance, PROVENANCE.LABEL_FUZZY);
  assert.ok(CONFIDENCE_BY_PROVENANCE.label_fuzzy < AUTO_SUBMIT_MIN_CONFIDENCE,
    "the whole point: a guess must not clear the auto-submit floor");
  assert.ok(CONFIDENCE_BY_PROVENANCE.custom_answer >= AUTO_SUBMIT_MIN_CONFIDENCE,
    "the user's own answer to a question is not a guess");
  // Refusal records are not answers and must not trigger a hold on their own.
  assert.equal(lowConfidenceAnswers([{ skipped: true, refusals: ["x"], confidence: 0 }]).length, 0);
});

// ── Date formatting (A1 trap 6) ─────────────────────────────────────────────

test("an explicitly advertised date format is honoured on text controls", () => {
  assert.equal(formatDateForHint("2026-09-01", "Available from (MM/DD/YYYY)"), "09/01/2026");
  assert.equal(formatDateForHint("2026-09-01", "Start date (DD/MM/YYYY)"), "01/09/2026");
  // No hint, or an unparseable value: pass through untouched rather than guess.
  assert.equal(formatDateForHint("2026-09-01", "Earliest start date"), "2026-09-01");
  assert.equal(formatDateForHint("next month", "Available from (MM/DD/YYYY)"), "next month");

  const fields = [field({ field_id: "d", name: "start_date", label: "Available from (MM/DD/YYYY)", handler_type: "start-date", handler_source: "attr" })];
  const [a] = buildAnswers(fields, { field_map: { start_date: "2026-09-01" } });
  assert.equal(a.value, "09/01/2026");

  // A real type="date" control still gets ISO, which is what it requires.
  const isoFields = [field({ field_id: "d2", name: "start", type: "date", label: "Earliest start date", handler_type: "start-date", handler_source: "attr" })];
  assert.equal(buildAnswers(isoFields, { field_map: { start_date: "09/01/2026" } })[0].value, "2026-09-01");
});
