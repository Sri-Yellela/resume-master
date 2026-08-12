import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  defaultAnswerPolicy, normalisePolicyDecision, lowConfidenceAnswers,
  buildAnswers, POLICY_ACTIONS, AUTO_SUBMIT_MIN_CONFIDENCE,
} from "../services/applyAutomation.js";

const automation = fs.readFileSync("services/applyAutomation.js", "utf8");

// Step-scoped answer approval. Every step emits a resolved answer set and a policy decides what
// happens to it BEFORE anything is typed. Previously all policy ran at the END of a run: the
// low-confidence gate said "this is a guess, hold" only after the guess had been typed into steps
// 1..N of a real employer's form and Next clicked through them.
// End-to-end: scripts/a6CorrectionLoop.mjs.

const answer = (over = {}) => ({
  field_id: "f", name: "f", label: "Field", type: "text", value: "v",
  provenance: "field_map_exact", confidence: 0.9, required: false, ...over,
});

// ── The default policy ───────────────────────────────────────────────────────

test("semi mode approves everything — a human is looking at the form", () => {
  const answers = [answer({ confidence: 0.9 }), answer({ label: "Guess", confidence: 0.3, required: true })];
  const d = defaultAnswerPolicy({ mode: "semi", answers });
  assert.equal(d.approved.length, 2, "pre-filling a guess for a reviewer to correct is the point of semi");
  assert.ok(!d.escalate);
});

test("full-auto ESCALATES on a guess in a required field, before typing anything", () => {
  const answers = [
    answer({ label: "Email", confidence: 0.9 }),
    answer({ label: "Legal Name", confidence: 0.3, provenance: "label_fuzzy", required: true }),
  ];
  const d = defaultAnswerPolicy({ mode: "full", answers });
  assert.equal(d.escalate, true, "the form cannot proceed without it, so stop and ask");
  assert.equal(d.reason, "low_confidence_answers");
  assert.deepEqual(d.approved, [], "nothing is typed on a step that escalates");
  assert.deepEqual(d.escalated.map(a => a.label), ["Legal Name"]);
});

test("full-auto REJECTS a guess in an optional field and carries on", () => {
  // Leaving an optional field blank is more truthful than typing a value we do not know, and it
  // lets a run that would otherwise be held complete.
  const answers = [
    answer({ label: "Email", confidence: 0.9 }),
    answer({ label: "Preferred Name", confidence: 0.3, provenance: "label_fuzzy", required: false }),
  ];
  const d = defaultAnswerPolicy({ mode: "full", answers });
  assert.ok(!d.escalate, "an optional guess must not stop the run");
  assert.deepEqual(d.approved.map(a => a.label), ["Email"]);
  assert.deepEqual(d.rejected.map(a => a.label), ["Preferred Name"]);
  assert.equal(d.reason, "low_confidence_optional");
});

test("a required guess escalates even when optional guesses are also present, and names both", () => {
  const answers = [
    answer({ label: "Legal Name", confidence: 0.3, required: true }),
    answer({ label: "Preferred Name", confidence: 0.3, required: false }),
  ];
  const d = defaultAnswerPolicy({ mode: "full", answers });
  assert.equal(d.escalate, true);
  assert.deepEqual(d.escalated.map(a => a.label), ["Legal Name"], "what stopped it");
  assert.deepEqual(d.rejected.map(a => a.label), ["Preferred Name"], "and what else it was unsure about");
});

test("skipped refusal records and null values never reach a policy decision as fillable", () => {
  const answers = [
    answer({ label: "Sponsorship", value: null, skipped: true, refusals: ["x:eligibility_class:sponsorship"], confidence: 0 }),
    answer({ label: "Email", confidence: 0.9 }),
  ];
  const d = defaultAnswerPolicy({ mode: "full", answers });
  assert.deepEqual(d.approved.map(a => a.label), ["Email"]);
  assert.ok(!d.escalate, "a refusal is already not being filled — it must not also escalate");
});

test("confidence exactly at the floor is approved, not treated as a guess", () => {
  const d = defaultAnswerPolicy({ mode: "full", answers: [answer({ confidence: AUTO_SUBMIT_MIN_CONFIDENCE, required: true })] });
  assert.ok(!d.escalate);
  assert.equal(d.approved.length, 1);
});

// ── The injectable seam ──────────────────────────────────────────────────────

test("a custom policy can approve, reject or escalate, and omissions default to approve", () => {
  const fillable = [answer({ label: "A" }), answer({ label: "B" })];

  const approveAll = normalisePolicyDecision({}, fillable);
  assert.deepEqual(approveAll.approved.map(a => a.label), ["A", "B"], "an empty decision approves");
  assert.equal(approveAll.escalate, false);

  const subset = normalisePolicyDecision({ approved: [fillable[0]], rejected: [fillable[1]] }, fillable);
  assert.deepEqual(subset.approved.map(a => a.label), ["A"]);
  assert.deepEqual(subset.rejected.map(a => a.label), ["B"]);

  const stop = normalisePolicyDecision({ escalate: true, reason: "needs_human" }, fillable);
  assert.equal(stop.escalate, true);
  assert.equal(stop.reason, "needs_human");

  // A non-object (a policy that returned nothing) must not silently drop every answer.
  assert.deepEqual(normalisePolicyDecision(undefined, fillable).approved.map(a => a.label), ["A", "B"]);
  assert.deepEqual(normalisePolicyDecision(null, fillable).approved.map(a => a.label), ["A", "B"]);
});

test("the policy is injectable and awaited, and a throwing policy escalates rather than approving", () => {
  assert.match(automation, /answerPolicy\s*=\s*defaultAnswerPolicy/,
    "autoApply must accept an answerPolicy option — this is the confirmation/provider hook");
  assert.match(automation, /await policy\(\{ step, mode, provider, url: page\.url\(\), answers, fields, fillable \}\)/,
    "the policy must be awaited and receive the step context");
  // A broken confirmation hook must not become an unreviewed submission.
  assert.match(automation, /answer policy threw — escalating/);
  assert.match(automation, /reason: 'policy_error', escalated: fillable/);
});

test("nothing is typed before the policy returns", () => {
  // The APPLY_FN_SRC evaluate call must come after the decision, and only ever receive `approved`.
  const fnStart = automation.indexOf("async function discoverAndFill");
  const fnEnd = automation.indexOf("\n// -- Helpers", fnStart);
  // Comments stripped first: one of them names APPLY_FN_SRC while explaining why refusal records
  // must not reach the page, which sits ABOVE the decision and would match instead of the fill.
  const fn = automation.slice(fnStart, fnEnd).replace(/^\s*\/\/.*$/gm, "");

  const decisionAt = fn.indexOf("normalisePolicyDecision(");
  const applyAt = fn.indexOf("APPLY_FN_SRC");
  assert.ok(decisionAt > 0 && applyAt > 0 && decisionAt < applyAt,
    "the approval decision must precede the fill");
  assert.match(fn, /const approved = decision\.approved;/);
  assert.match(fn, /JSON\.stringify\(simpleAnswers\)/);
  assert.doesNotMatch(fn.slice(applyAt), /JSON\.stringify\(fillable\)/,
    "the fill must use the approved set, never the raw fillable set");
  // An escalation must return before any fill happens on that step.
  const escalateAt = fn.indexOf("if (decision.escalate)");
  assert.ok(escalateAt > 0 && escalateAt < applyAt);
});

test("the multi-step walk stops on escalation instead of clicking Next again", () => {
  assert.match(automation, /for \(let step = 0; step < 8 && !escalation; step\+\+\)/,
    "advancing further would mean clicking through a form on an answer a human must see");
  assert.match(automation, /if \(!await runDiscovery\(\)\) break;/);
});

// ── Interaction with the end-of-run gate ─────────────────────────────────────

test("a policy-rejected guess does not also hold the run at the end", () => {
  // Found by the real run: an optional guess the policy correctly DROPPED was still counted by the
  // end-of-run low-confidence gate, so it re-opened as a question forever — answering it could not
  // close it, because the answer was never the problem.
  const submitted = answer({ label: "Guess", confidence: 0.3, provenance: "label_fuzzy" });
  const dropped   = answer({ label: "Dropped", confidence: 0.3, provenance: "label_fuzzy", policy_rejected: true });

  assert.equal(lowConfidenceAnswers([submitted, dropped]).length, 1);
  assert.equal(lowConfidenceAnswers([submitted, dropped])[0].label, "Guess");
  assert.equal(lowConfidenceAnswers([dropped]).length, 0,
    "a guess that was never typed cannot make the submission unsafe");
});

test("answers carry required-ness and options, so a policy can reason about them", () => {
  const fields = [{
    field_id: "s", name: "s", type: "select", label: "Requires sponsorship", is_required: true,
    options: [{ value: "Yes", label: "Yes" }, { value: "No", label: "No" }],
    handler_type: null, handler_source: null, current_value: "",
  }];
  const [a] = buildAnswers(fields, { field_map: { requires_sponsorship: "No" } });
  assert.equal(a.required, true, "the policy needs this to tell blocking from optional");
  assert.deepEqual(a.options.map(o => o.value), ["Yes", "No"]);
});

test("POLICY_ACTIONS documents the three outcomes", () => {
  assert.deepEqual(POLICY_ACTIONS, { APPROVE: "approve", REJECT: "reject", ESCALATE: "escalate" });
});

test("the legacy sweep is documented as outside the policy seam", () => {
  // Honesty check: fillContext fills inside the page by heuristic and produces no answer object to
  // approve, so it is NOT policy-gated. That limitation must stay written down next to the code.
  assert.match(automation, /this path is NOT policy-gated/);
});
