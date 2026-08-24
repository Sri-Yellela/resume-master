import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPANY_TOKEN, isMotivationQuestion, isTemplate, companyKey, expandCompany,
  readAnswerStore, resolveForCompany, effectiveCustomAnswers, withheldTemplates,
  SEED_QUESTIONS, seedQuestions,
} from "../services/customAnswers.js";
import { buildAnswers, PROVENANCE, CONFIDENCE_BY_PROVENANCE } from "../services/applyAutomation.js";

const field = (label, over = {}) => ({
  field_id: "q", name: "q", type: "text", label, handler_type: null,
  is_required: false, options: [], ...over,
});

// ── The placeholder ──────────────────────────────────────────────────────────

test("isTemplate is stable across repeated calls on the same string", () => {
  // A /g/ regex shared with `replace` advances lastIndex, so `.test()` alternates true/false. That
  // would make a template resolve on one field and silently vanish on the next.
  const q = "Why do you want to join {company}?";
  for (let i = 0; i < 5; i++) assert.equal(isTemplate(q), true, `call ${i + 1}`);
  for (let i = 0; i < 5; i++) assert.equal(isTemplate("How did you hear about us?"), false);
});

test("the placeholder is recognised however it was typed, and every copy is expanded", () => {
  assert.equal(isTemplate("Why {Company}?"), true);
  assert.equal(isTemplate("Why { company }?"), true);
  assert.equal(expandCompany("{company} and {company} again", "Figma"), "Figma and Figma again");
  assert.equal(COMPANY_TOKEN, "{company}");
});

test("companyKey normalises case and surrounding whitespace", () => {
  assert.equal(companyKey("  Figma  "), companyKey("figma"));
  assert.equal(companyKey("Acme  Corp"), "acme corp");
});

// ── Motivation detection ─────────────────────────────────────────────────────

test("motivation questions are detected; factual ones are not", () => {
  for (const q of [
    "Why do you want to join {company}?",
    "Why are you interested in this role?",
    "What excites you about our product?",
    "Tell us why you applied.",
    "What is your motivation for applying?",
  ]) assert.equal(isMotivationQuestion(q), true, q);

  for (const q of [
    "Have you ever worked for {company} before?",
    "From where do you intend to work?",
    "Years of professional experience",
    "How did you hear about us?",
    "Have you worked as a full-time software engineer (excluding internships)?",
  ]) assert.equal(isMotivationQuestion(q), false, q);
});

// ── Resolution ───────────────────────────────────────────────────────────────

test("a literal stored answer passes through untouched — the pre-template behaviour", () => {
  const store = readAnswerStore({ custom_answers: '{"How did you hear about us?":"LinkedIn"}' });
  assert.deepEqual(effectiveCustomAnswers(store, "Figma"), { "How did you hear about us?": "LinkedIn" });
  // ...and with no company at all, which is how the gate packet resolves.
  assert.deepEqual(effectiveCustomAnswers(store, null), { "How did you hear about us?": "LinkedIn" });
});

test("a factual template expands to the employer's literal question text", () => {
  const store = readAnswerStore({
    custom_answers: JSON.stringify({ "Have you ever worked for {company} before?": "No" }),
  });
  assert.deepEqual(effectiveCustomAnswers(store, "Figma"),
    { "Have you ever worked for Figma before?": "No" });
  assert.deepEqual(withheldTemplates(store, "Figma"), []);
});

test("no {company} placeholder survives into the resolved map", () => {
  const store = readAnswerStore({
    custom_answers: JSON.stringify({
      "Have you ever worked for {company} before?": "No",
      "Which {company} team interests you?": "Platform at {company}",
    }),
  });
  const resolved = effectiveCustomAnswers(store, "Figma");
  for (const [q, a] of Object.entries(resolved)) {
    assert.equal(isTemplate(q), false, `question still templated: ${q}`);
    assert.equal(isTemplate(a), false, `answer still templated: ${a}`);
  }
});

test("A MOTIVATION TEMPLATE IS WITHHELD, and offered as a draft instead of an answer", () => {
  const store = readAnswerStore({
    custom_answers: JSON.stringify({ "Why do you want to join {company}?": "I admire {company}'s craft." }),
  });
  // The whole point: nothing is submitted.
  assert.deepEqual(effectiveCustomAnswers(store, "Figma"), {});
  const [held] = withheldTemplates(store, "Figma");
  assert.equal(held.question, "Why do you want to join Figma?");
  assert.equal(held.template, "Why do you want to join {company}?");
  assert.equal(held.draft, "I admire Figma's craft.", "the draft is a starting point the user edits");
  assert.equal(held.reason, "motivation_needs_own_words");
});

test("a per-company override WINS over the template, and is the only thing that submits a motivation answer", () => {
  const store = readAnswerStore({
    custom_answers: JSON.stringify({ "Why do you want to join {company}?": "Generic." }),
    custom_answer_overrides: JSON.stringify({
      figma: { "Why do you want to join {company}?": "I have used the plugin API since 2023." },
    }),
  });
  assert.deepEqual(effectiveCustomAnswers(store, "Figma"),
    { "Why do you want to join Figma?": "I have used the plugin API since 2023." });
  assert.deepEqual(withheldTemplates(store, "Figma"), [],
    "an answered override is not still an open question");

  // A different employer gets the withhold, not the other company's words.
  assert.deepEqual(effectiveCustomAnswers(store, "Linear"), {});
  assert.equal(withheldTemplates(store, "Linear")[0].question, "Why do you want to join Linear?");
});

test("an override wins over a factual template too, and may be keyed by expanded wording", () => {
  const store = readAnswerStore({
    custom_answers: JSON.stringify({ "Have you ever worked for {company} before?": "No" }),
    custom_answer_overrides: JSON.stringify({
      figma: { "Have you ever worked for Figma before?": "Yes" },
    }),
  });
  assert.deepEqual(effectiveCustomAnswers(store, "Figma"),
    { "Have you ever worked for Figma before?": "Yes" });
});

test("an override applies to a question whose wording never varies", () => {
  const store = readAnswerStore({
    custom_answers: JSON.stringify({ "How did you hear about us?": "LinkedIn" }),
    custom_answer_overrides: JSON.stringify({ figma: { "How did you hear about us?": "A friend on the team" } }),
  });
  assert.deepEqual(effectiveCustomAnswers(store, "Figma"),
    { "How did you hear about us?": "A friend on the team" });
  assert.deepEqual(effectiveCustomAnswers(store, "Linear"),
    { "How did you hear about us?": "LinkedIn" });
});

test("with no company known, templates are dropped rather than expanded to nothing", () => {
  const store = readAnswerStore({
    custom_answers: JSON.stringify({
      "Have you ever worked for {company} before?": "No",
      "How did you hear about us?": "LinkedIn",
    }),
  });
  for (const company of [null, undefined, "", "   "]) {
    const resolved = effectiveCustomAnswers(store, company);
    assert.deepEqual(resolved, { "How did you hear about us?": "LinkedIn" },
      `company=${JSON.stringify(company)} must not produce "Have you ever worked for  before?"`);
  }
});

// ── Reading the store ────────────────────────────────────────────────────────

test("a non-string answer never becomes a value typed into a form", () => {
  const store = readAnswerStore({
    custom_answers: JSON.stringify({ nested: { a: 1 }, list: [1, 2], ok: "yes", num: 4 }),
  });
  assert.deepEqual(store.answers, { ok: "yes", num: "4" });
  const resolved = effectiveCustomAnswers(store, "Figma");
  for (const v of Object.values(resolved)) assert.notEqual(v, "[object Object]");
});

test("a malformed store degrades to empty instead of throwing mid-run", () => {
  for (const bad of ["not json", "[1,2]", null, undefined, "null"]) {
    const store = readAnswerStore({ custom_answers: bad, custom_answer_overrides: bad });
    assert.deepEqual(store.answers, {});
    assert.deepEqual(store.overrides, {});
    assert.deepEqual(effectiveCustomAnswers(store, "Figma"), {});
  }
});

test("an already-parsed object is accepted, since callers hand back both shapes", () => {
  const store = readAnswerStore({ custom_answers: { "Q?": "A" } });
  assert.deepEqual(store.answers, { "Q?": "A" });
});

test("a blank answer is not an answer — it stays a question", () => {
  const store = readAnswerStore({
    custom_answers: JSON.stringify({ "From where do you intend to work?": "" }),
  });
  assert.deepEqual(effectiveCustomAnswers(store, "Figma"), {});
});

// ── The tier guarantee (AF1 requirement 4) ───────────────────────────────────

test("an expanded template resolves at the EXACT custom-answer tier, never the fuzzy path", () => {
  const store = readAnswerStore({
    custom_answers: JSON.stringify({ "Have you ever worked for {company} before?": "No" }),
  });
  const answers = buildAnswers([field("Have you ever worked for Figma before?")], {
    field_map: {}, handler_map: {},
    custom_answers: effectiveCustomAnswers(store, "Figma"),
  });
  assert.equal(answers.length, 1);
  assert.equal(answers[0].value, "No");
  assert.equal(answers[0].provenance, PROVENANCE.CUSTOM_ANSWER);
  assert.notEqual(answers[0].provenance, PROVENANCE.LABEL_FUZZY);
  assert.equal(answers[0].confidence, CONFIDENCE_BY_PROVENANCE.custom_answer);
});

test("a stored answer is not applied to a DIFFERENT company's question", () => {
  const store = readAnswerStore({
    custom_answers: JSON.stringify({ "Have you ever worked for {company} before?": "No" }),
  });
  const answers = buildAnswers([field("Have you ever worked for Stripe before?")], {
    field_map: {}, handler_map: {},
    custom_answers: effectiveCustomAnswers(store, "Figma"),
  });
  const filled = answers.filter(a => !a.skipped && a.value !== null);
  assert.equal(filled.length, 0, "Figma's answer must not answer Stripe's question");
});

test("the two wordings of the same underlying question are separately answerable", () => {
  // AF1 requirement 1: these are different strings and both must be storable.
  const store = readAnswerStore({
    custom_answers: JSON.stringify({
      "Have you ever worked for {company} before?": "No",
      "Are you a former employee?": "No",
    }),
  });
  const resolved = effectiveCustomAnswers(store, "Figma");
  for (const label of ["Have you ever worked for Figma before?", "Are you a former employee?"]) {
    const [a] = buildAnswers([field(label)], { field_map: {}, handler_map: {}, custom_answers: resolved });
    assert.equal(a.value, "No", label);
    assert.equal(a.provenance, PROVENANCE.CUSTOM_ANSWER, label);
  }
});

test("a withheld motivation template leaves the field genuinely unanswered", () => {
  const store = readAnswerStore({
    custom_answers: JSON.stringify({ "Why do you want to join {company}?": "Generic enthusiasm." }),
  });
  const answers = buildAnswers([field("Why do you want to join Figma?", { is_required: true })], {
    field_map: {}, handler_map: {},
    custom_answers: effectiveCustomAnswers(store, "Figma"),
  });
  const filled = answers.filter(a => !a.skipped && a.value !== null && a.value !== "");
  assert.equal(filled.length, 0, "manufactured enthusiasm must not reach an employer's form");
});

// ── Seeds (AF1 requirement 5) ────────────────────────────────────────────────

test("the five Figma questions seed as WORDINGS with no invented answers", () => {
  assert.equal(SEED_QUESTIONS.length, 5);
  for (const s of SEED_QUESTIONS) assert.equal(s.answer, "", `${s.question} must not ship an answer`);
  const seeded = seedQuestions({});
  assert.equal(Object.keys(seeded).length, 5);
  // Seeded but blank means the store resolves nothing yet — the run still holds, as it does today.
  assert.deepEqual(effectiveCustomAnswers(readAnswerStore({ custom_answers: seeded }), "Figma"), {});
});

test("seeding never overwrites an answer the candidate already wrote", () => {
  const mine = { "From where do you intend to work?": "Boston, MA (hybrid)" };
  const seeded = seedQuestions(mine);
  assert.equal(seeded["From where do you intend to work?"], "Boston, MA (hybrid)");
  assert.equal(Object.keys(seeded).length, 5);
});

test("two of the seeds are company-templated, and exactly one of those is motivation", () => {
  const templated = SEED_QUESTIONS.filter(s => isTemplate(s.question));
  assert.equal(templated.length, 2);
  assert.deepEqual(templated.filter(s => isMotivationQuestion(s.question)).map(s => s.question),
    ["Why do you want to join {company}?"]);
});

// ── Shape ────────────────────────────────────────────────────────────────────

test("resolveForCompany returns both halves, and they never overlap", () => {
  const store = readAnswerStore({
    custom_answers: JSON.stringify({
      "Why do you want to join {company}?": "Generic.",
      "Have you ever worked for {company} before?": "No",
    }),
  });
  const { answers, withheld } = resolveForCompany(store, "Figma");
  assert.deepEqual(Object.keys(answers), ["Have you ever worked for Figma before?"]);
  assert.deepEqual(withheld.map(w => w.question), ["Why do you want to join Figma?"]);
  for (const w of withheld) {
    assert.ok(!Object.prototype.hasOwnProperty.call(answers, w.question),
      "a question cannot be both answered and withheld");
  }
});
