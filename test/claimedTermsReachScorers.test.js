// CC4 — a term the candidate CLAIMS reaches both scorers, and the score says when it did.
//
// Before this, `listProfileClaims` had exactly one consumer: the generation prompt. AG2's own copy
// said so — "it does not change this score" — and it was literally true. So the user-enrichable
// layer that changes RANKING did not exist: the only way to influence the board was an unlabelled
// "Extracted …" textarea that a résumé re-upload silently overwrote.
//
// These exercise the REAL scorer over a real basis, because the change is about what a score counts.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scoreAtsLocally, buildRuntimeAtsBasis } from "../services/localAtsScorer.js";

// ⛔ THE POSTING HAS TO BE RICH ENOUGH TO SCORE. MIN_SCORABLE_TERMS is 4, and the scorer DECLINES
// rather than fabricating a number below it (AK1). A three-line JD yields two terms and every
// assertion here comes back null — which reads exactly like a broken feature. It is not: it is the
// decline guard working, and this fixture is sized to clear it.
const JOB = {
  title: "Platform Engineer",
  company: "Acme",
  description: `We are hiring a platform engineer. You will run our Kubernetes clusters and own
    our Terraform modules. Strong Python is required for our automation. You will build CI/CD
    pipelines, improve observability and monitoring, work with Docker containers and AWS, own
    service reliability, and mentor other engineers. Kubernetes experience is required.
    Terraform experience is required. Python experience is required.`,
};

/** A résumé that mentions some of those, so the rest are genuine gaps the user can claim. */
const RESUME = `Platform engineer. Built and operated Terraform modules for a payments team.
  Wrote Python automation and CI/CD pipelines. Handled Docker containers and AWS deployments.
  Wrote runbooks, handled on-call, and improved deploy reliability and monitoring.`;

const basisWith = (claims) => buildRuntimeAtsBasis({
  resumeText: RESUME,
  signalProfile: { skills: ["terraform"], keywords: [], titles: [] },
  domainProfile: { seniority: "mid" },
  claims,
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// REQUIREMENT 1 — the claim reaches the BAND
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("a claimed term counts toward the score", () => {
  const before = scoreAtsLocally({ job: JOB, runtimeBasis: basisWith(null) });
  const after = scoreAtsLocally({ job: JOB, runtimeBasis: basisWith({ skills: ["Kubernetes"] }) });
  assert.ok(after.score > before.score,
    `a claim must move the score: got ${before.score} -> ${after.score}`);
  assert.ok(!before.tier1_matched.concat(before.competencies_matched).some(t => /kubernetes/i.test(t)),
    "kubernetes must be a genuine gap before the claim");
  assert.ok(after.tier1_matched.concat(after.competencies_matched).some(t => /kubernetes/i.test(t)),
    "and a match after it");
});

test("withdrawing the claim puts the score back exactly", () => {
  // The revert has to be exact, or "withdraw" is an approximation of undo.
  const before = scoreAtsLocally({ job: JOB, runtimeBasis: basisWith(null) });
  const claimed = scoreAtsLocally({ job: JOB, runtimeBasis: basisWith({ skills: ["Kubernetes"] }) });
  const withdrawn = scoreAtsLocally({ job: JOB, runtimeBasis: basisWith({ skills: [] }) });
  assert.notEqual(claimed.score, before.score);
  assert.equal(withdrawn.score, before.score);
  assert.deepEqual(withdrawn.claimed_matches, []);
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// ⛔ THE INTEGRITY PROPERTY THAT REPLACES "CLAIMS CANNOT AFFECT THE SCORE"
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("⛔ a match that rested on a CLAIM ALONE is reported as such", () => {
  // This is what makes the reversal defensible. The old guarantee was "a claim cannot flatter its
  // own number" — enforced by keeping claims out of the basis entirely. The new one is weaker but
  // still real: a claim CAN move the number, and the report always says which matches it moved.
  // Without this, CC4 would be a silent self-inflation channel.
  const rep = scoreAtsLocally({ job: JOB, runtimeBasis: basisWith({ skills: ["Kubernetes"] }) });
  assert.ok(rep.claimed_matches.some(t => /kubernetes/i.test(t)),
    "the claimed term must appear in claimed_matches");
  assert.ok(!rep.claimed_matches.some(t => /terraform/i.test(t)),
    "terraform is in the résumé, so it must NOT be attributed to a claim");
});

test("claimed_matches is present and empty when nothing was claimed", () => {
  // A consumer that shows a score should never have to guess whether the field exists.
  const rep = scoreAtsLocally({ job: JOB, runtimeBasis: basisWith(null) });
  assert.ok(Array.isArray(rep.claimed_matches));
  assert.deepEqual(rep.claimed_matches, []);
});

test("a claim for something the job never asked about changes nothing", () => {
  // Claims are not a free score: they only land on terms the posting actually wants.
  const before = scoreAtsLocally({ job: JOB, runtimeBasis: basisWith(null) });
  const after = scoreAtsLocally({ job: JOB, runtimeBasis: basisWith({ skills: ["Underwater Basket Weaving"] }) });
  assert.equal(after.score, before.score);
  assert.deepEqual(after.claimed_matches, []);
});

test("a profile with ONLY claims is still scorable", () => {
  // The scorable guard used to require résumé text, skills or titles. A person who has claimed
  // terms but uploaded nothing has told us something, and declining to score them would read as
  // "no signal" when there is some.
  const rep = scoreAtsLocally({
    job: JOB,
    runtimeBasis: buildRuntimeAtsBasis({
      resumeText: "", signalProfile: {}, domainProfile: {},
      claims: { skills: ["Kubernetes", "Terraform"] },
    }),
  });
  assert.notEqual(rep.score, null, "a claims-only profile must not decline to score");
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// REQUIREMENT 1 / 6 — the claim reaches the BOARD, and every scorer call site
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("⛔ EVERY buildRuntimeAtsBasis CALL SITE IN server.js PASSES claims", () => {
  // Same shape of guard as CC3's synonym scan, and for the same reason: the failure mode is a NEW
  // call site forgetting the argument, which no behavioural test over the existing ones can see.
  const server = fs.readFileSync("server.js", "utf8");
  const missing = [];
  const re = /buildRuntimeAtsBasis\(\{/g;
  let m;
  while ((m = re.exec(server))) {
    const segment = server.slice(m.index, m.index + 500);
    if (!/claims\s*:/.test(segment)) missing.push(`server.js:${server.slice(0, m.index).split("\n").length}`);
  }
  assert.deepEqual(missing, [],
    "these basis call sites do not pass `claims`, so a claim cannot affect their score:\n  " +
    missing.join("\n  ") + "\n\nPass `claims: atsClaims(<profile>)`.");
});

test("the board's bridge sees claimed skills, and they lead the derived list", () => {
  // profileFilterBridge caps derived skills at MAX_DERIVED_SKILLS = 6 by taking the FIRST six, so
  // appending claims would mean a profile with six extracted terms silently drops every one. An
  // explicit assertion outranks an extraction — CC2 measured that extraction to be largely noise.
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /const boardClaims = savedTab \? null : atsClaims\(sessionActiveProfile\)/,
    "the board must load claims");
  assert.match(server, /skills: \[\.\.\.boardClaims\.skills, \.\.\.\(signals\?\.skills \|\| \[\]\)\]/,
    "claims must be PREPENDED, or the 6-term cap drops them");
  assert.match(server, /deriveProfileFilters\(sessionActiveProfile, curationSignals\)/,
    "and the bridge must receive the merged object, not the raw signals");
  // ⛔ `signals` has another reader (the YoE constraint), so it must not be mutated in place.
  assert.doesNotMatch(server, /signals\.skills\s*=/,
    "widening `signals` in place for one consumer is how the other starts disagreeing");
});

test("the Saved tab contributes no claims, because it is not a discovery surface", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /savedTab \? null : atsClaims\(sessionActiveProfile\)/);
});

test("claims still reach GENERATION — the one consumer that already worked", () => {
  // CC4 adds consumers; it must not lose the original. AG2's guarantee that a claim never rewrites
  // an existing artifact depends on this being read per generation.
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /listProfileClaims\(db, \{ userId, profileId: activeDomainProfile\.id \}\)/);
});
