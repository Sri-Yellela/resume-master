import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeOrgUnitKey, computeConfidence, PROMOTE_MIN_CORROBORATION, PROMOTE_MIN_CONFIDENCE,
  N_FULL_CONFIDENCE,
} from "../services/kb/orgLayer.js";
import { computeGrowthScore, WINDOW_DAYS } from "../services/jobs/hiringSignals.js";

test("normalizeOrgUnitKey clusters near-duplicate team names", () => {
  assert.equal(normalizeOrgUnitKey("Payments Platform Team"), normalizeOrgUnitKey("payments platform"));
  assert.equal(normalizeOrgUnitKey("Fraud ML Group"), normalizeOrgUnitKey("Fraud ML"));
  assert.equal(normalizeOrgUnitKey("Developer Experience Org"), normalizeOrgUnitKey("developer experience"));
});

test("normalizeOrgUnitKey distinguishes genuinely different teams", () => {
  assert.notEqual(normalizeOrgUnitKey("Payments Platform"), normalizeOrgUnitKey("Fraud ML"));
});

test("normalizeOrgUnitKey handles empty/null input", () => {
  assert.equal(normalizeOrgUnitKey(null), "");
  assert.equal(normalizeOrgUnitKey(""), "");
  assert.equal(normalizeOrgUnitKey("   "), "");
});

test("computeConfidence increases with corroboration_count, caps the corroboration term at 1", () => {
  const now = 1_000_000;
  const c1 = computeConfidence(1, now, now);
  const c3 = computeConfidence(3, now, now);
  const cFull = computeConfidence(N_FULL_CONFIDENCE, now, now);
  const cOver = computeConfidence(N_FULL_CONFIDENCE * 2, now, now);
  assert.ok(c1 < c3, "more corroboration should raise confidence");
  assert.ok(c3 < cFull, "confidence should keep rising up to N_FULL_CONFIDENCE");
  assert.equal(cFull, cOver, "corroboration term must cap at 1 beyond N_FULL_CONFIDENCE");
  assert.equal(cFull, 1, "no decay (last_seen === now) + full corroboration -> confidence 1");
});

test("computeConfidence decays as last_seen ages, without going negative", () => {
  const now = 1_000_000;
  const oneYearAgo = now - 365 * 86400;
  const fresh = computeConfidence(N_FULL_CONFIDENCE, now, now);
  const stale = computeConfidence(N_FULL_CONFIDENCE, oneYearAgo, now);
  assert.ok(stale < fresh, "a stale last_seen must lower confidence");
  assert.ok(stale >= 0, "confidence must never go negative");
});

test("promotion thresholds are documented, sane constants", () => {
  assert.ok(PROMOTE_MIN_CORROBORATION >= 1);
  assert.ok(PROMOTE_MIN_CONFIDENCE > 0 && PROMOTE_MIN_CONFIDENCE <= 1);
  // A cluster right at the corroboration threshold, seen today, must be able to promote —
  // otherwise the two thresholds would be mutually unreachable.
  const now = 1_000_000;
  const confidenceAtThreshold = computeConfidence(PROMOTE_MIN_CORROBORATION, now, now);
  assert.ok(confidenceAtThreshold >= PROMOTE_MIN_CONFIDENCE,
    "PROMOTE_MIN_CORROBORATION postings seen today must clear PROMOTE_MIN_CONFIDENCE");
});

test("computeGrowthScore is positive when new outpaces expired, negative when the reverse", () => {
  assert.ok(computeGrowthScore(10, 2, 20) > 0);
  assert.ok(computeGrowthScore(2, 10, 20) < 0);
  assert.equal(computeGrowthScore(5, 5, 20), 0);
});

test("computeGrowthScore never divides by zero when open_count is 0", () => {
  assert.equal(computeGrowthScore(3, 0, 0), 3); // (3-0)/max(1,0) = 3/1
  assert.doesNotThrow(() => computeGrowthScore(0, 0, 0));
});

test("WINDOW_DAYS is the documented 30-day trailing window", () => {
  assert.equal(WINDOW_DAYS, 30);
});
