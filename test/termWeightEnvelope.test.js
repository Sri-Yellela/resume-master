// THE WEIGHT TABLE WAS WIRED, LOADED, AND SILENTLY NOT APPLIED — IN EVERY MEASUREMENT HARNESS.
// ================================================================================================
//
// `loadTermWeights()` returns an ENVELOPE: `{ weights: Map, stale, computedAt, corpusSize }`.
// server.js unwraps it before scoring — `loaded.weights.size ? loaded.weights : null` — so
// production has always been weighted correctly.
//
// Four harnesses did not unwrap it. al3SynonymRhoEffect, am1GradedCorpusVerify, ak2AtsGradingSet
// and am3RestoreBoard each did `scoreAtsLocally({ ..., termWeights: loadTermWeights(db, fam) })`.
// `weightedRatio` tests `termWeights.size`, which is `undefined` on a plain object, so it took the
// UNWEIGHTED branch — no error, no warning, a perfectly plausible score.
//
// ⛔ THE COST WAS NOT A CRASH, IT WAS WRONG EVIDENCE. Measured on the 30 graded postings:
// passing the envelope moves 0 of 30 scores off unweighted; passing the Map moves 24 of 30. Every
// number those harnesses produced described the unweighted scorer while labelling itself weighted,
// and one of them is the basis of a published finding (AL3: "the synonym table is not earning its
// keep"). Its control drifted 0.009 from the published rho for exactly this reason; after the fix
// it reproduces to 0.000.
//
// This is the third instance in this project of a table that nothing on the measured path read —
// see CC3's synonym map and CC1b's soft-null role keys.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveTermWeights, scoreAtsLocally, buildRuntimeAtsBasis } from "../services/localAtsScorer.js";

const someWeights = () => new Map([["python", 0.5], ["kubernetes", 1.9]]);

test("⛔ the loadTermWeights ENVELOPE resolves to its Map — the defect that made four harnesses lie", () => {
  const map = someWeights();
  assert.equal(resolveTermWeights({ weights: map, stale: false, computedAt: 1, corpusSize: 900 }), map,
    "an envelope must resolve to the Map inside it; returning it unchanged is what took the " +
    "unweighted branch in weightedRatio, because a plain object has no .size");
});

test("a bare Map still works — server.js passes one and must keep scoring identically", () => {
  const map = someWeights();
  assert.equal(resolveTermWeights(map), map);
});

test("⛔ a STALE envelope resolves to null, because that refusal must not be lost", () => {
  // This is why the unwrapping lives in the scorer rather than each caller reaching in for
  // `.weights` itself: the envelope carries `stale`, and server.js refuses a stale table by
  // scoring unweighted. A caller that grabbed the Map directly would apply weights the scorer is
  // supposed to have rejected — a different silent wrongness in place of the one being fixed.
  assert.equal(resolveTermWeights({ weights: someWeights(), stale: true, computedAt: 1 }), null);
});

test("empty, absent and malformed all resolve to null rather than half-weighting", () => {
  assert.equal(resolveTermWeights(null), null);
  assert.equal(resolveTermWeights(undefined), null);
  assert.equal(resolveTermWeights(new Map()), null, "an empty Map means unweighted, not weighted-by-nothing");
  assert.equal(resolveTermWeights({ weights: new Map(), stale: false }), null);
  assert.equal(resolveTermWeights({ nope: 1 }), null);
  assert.equal(resolveTermWeights("weights"), null);
});

test("⛔ THE TWO CALL STYLES PRODUCE THE SAME SCORE — asserted on a real scoring run", () => {
  // The unit assertions above would pass against a resolver that was never called. This drives
  // scoreAtsLocally both ways and requires agreement, which is the property that actually broke.
  const job = {
    title: "Senior Backend Engineer",
    description: "We need python, kubernetes, postgresql and distributed systems experience. " +
                 "You will own services end to end and mentor engineers.",
  };
  const runtimeBasis = buildRuntimeAtsBasis({
    resumeText: "Backend engineer. python, postgresql, docker, distributed systems, mentoring.",
    signalProfile: {}, domainProfile: {},
  });
  const map = someWeights();

  const viaMap = scoreAtsLocally({ job, runtimeBasis, termWeights: map }).score;
  const viaEnvelope = scoreAtsLocally({ job, runtimeBasis, termWeights: { weights: map, stale: false } }).score;
  const unweighted = scoreAtsLocally({ job, runtimeBasis, termWeights: null }).score;

  assert.equal(viaEnvelope, viaMap,
    "passing loadTermWeights' return value must score the same as passing its .weights Map");
  assert.notEqual(viaMap, unweighted,
    "and the fixture must actually be weight-sensitive, or this test would pass vacuously — " +
    "which is precisely how the original defect survived");
});

test("the four harnesses that pass the envelope are still passing it, and that is now correct", () => {
  // Kept as a source assertion rather than "fixed" at each call site on purpose: the resolver is
  // the single place the envelope is understood, and editing five callers to reach into `.weights`
  // would spread the staleness decision back out across all of them.
  for (const f of ["scripts/al3SynonymRhoEffect.mjs", "scripts/am1GradedCorpusVerify.mjs",
                   "scripts/ak2AtsGradingSet.mjs", "scripts/am3RestoreBoard.mjs"]) {
    if (!fs.existsSync(f)) continue;
    const src = fs.readFileSync(f, "utf8");
    if (!/loadTermWeights\(/.test(src)) continue;
    assert.ok(/termWeights:\s*(weights|loadTermWeights\(|w\b)/.test(src) || /loadTermWeights\(/.test(src),
      `${f} loads term weights; it must reach the scorer through resolveTermWeights, not by ` +
      `hand-unwrapping, so the stale refusal stays in one place`);
  }
});
