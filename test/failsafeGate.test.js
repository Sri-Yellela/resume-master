import test from "node:test";
import assert from "node:assert/strict";
import {
  extractTeamClaim, extractStackClaim, jaccardOverlap, levenshteinSimilarity, similarity,
} from "../services/kb/failsafe.js";

test("extractTeamClaim derives the team from a comma-separated role", () => {
  assert.equal(extractTeamClaim({ role: "Senior Engineer, Payments Platform" }), "Payments Platform");
  assert.equal(extractTeamClaim({ role: "Engineer — Fraud ML" }), "Fraud ML");
});

test("extractTeamClaim returns null when the role has no team-like separator", () => {
  assert.equal(extractTeamClaim({ role: "Senior Software Engineer" }), null);
  assert.equal(extractTeamClaim({}), null);
});

test("extractTeamClaim falls back to meta when role has no separator", () => {
  assert.equal(extractTeamClaim({ role: "Software Engineer", meta: "Acme, Developer Experience" }), "Developer Experience");
});

test("extractStackClaim splits the tech line on common delimiters", () => {
  assert.deepEqual(extractStackClaim({ tech: "Python, AWS, Postgres" }), ["Python", "AWS", "Postgres"]);
  assert.deepEqual(extractStackClaim({ tech: "React | Node | GraphQL" }), ["React", "Node", "GraphQL"]);
  assert.deepEqual(extractStackClaim({}), []);
});

test("jaccardOverlap is 1 for identical word sets regardless of order, 0 for disjoint sets", () => {
  assert.equal(jaccardOverlap("payments platform", "platform payments"), 1);
  assert.equal(jaccardOverlap("payments platform", "fraud ml"), 0);
});

test("levenshteinSimilarity catches single-character typos word-Jaccard would miss entirely", () => {
  assert.equal(jaccardOverlap("payment platfrom", "payments platform"), 0);
  assert.ok(levenshteinSimilarity("payment platfrom", "payments platform") > 0.8);
});

test("similarity takes the higher of the two signals", () => {
  const exact = similarity("payments platform", "payments platform");
  const typo = similarity("payment platfrom", "payments platform");
  const unrelated = similarity("payments platform", "quantum sandbox");
  assert.equal(exact, 1);
  assert.ok(typo > 0.4 && typo < 1);
  assert.ok(unrelated < 0.4);
});

// Regression: the pair above happens to score low, which hid the real failure mode. These two
// phrases share NO word, yet whole-phrase Levenshtein alone rates them 0.409 — over the 0.4
// suggest_fix bar — so against Stripe's real 271-unit KB an invented team was reported as "may be
// an imprecise reference to" Growth Marketing. Character similarity must only count as evidence
// when it is high enough to mean "typo".
test("similarity ignores coincidental character overlap between phrases sharing no word", () => {
  assert.equal(jaccardOverlap("quantum basket weaving", "growth marketing"), 0);
  assert.ok(levenshteinSimilarity("quantum basket weaving", "growth marketing") > 0.4);
  assert.equal(similarity("quantum basket weaving", "growth marketing"), 0);
});

test("similarity still credits a real typo above the suggest_fix bar", () => {
  assert.ok(similarity("platform sale", "platform sales") > 0.9);
  assert.ok(similarity("payment platfrom", "payments platform") > 0.8);
});
