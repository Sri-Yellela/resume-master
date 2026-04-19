import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedModesForTier,
  canUseAPlusResume,
  canUseGenerate,
  canUseMode,
  nextPlan,
  planForMode,
} from "../services/entitlements.js";

test("plan tiers expose only their entitled apply mode", () => {
  assert.deepEqual(allowedModesForTier("BASIC"), ["SIMPLE"]);
  assert.deepEqual(allowedModesForTier("PLUS"), ["TAILORED"]);
  assert.deepEqual(allowedModesForTier("PRO"), ["CUSTOM_SAMPLER"]);
});

test("A+ requires Pro and lower tiers cannot select it", () => {
  assert.equal(canUseMode("BASIC", "CUSTOM_SAMPLER"), false);
  assert.equal(canUseMode("PLUS", "CUSTOM_SAMPLER"), false);
  assert.equal(canUseMode("PRO", "CUSTOM_SAMPLER"), true);
  assert.equal(planForMode("CUSTOM_SAMPLER"), "PRO");
});

test("tool capabilities are derived from plan tier", () => {
  assert.equal(canUseGenerate("BASIC"), false);
  assert.equal(canUseGenerate("PLUS"), true);
  assert.equal(canUseGenerate("PRO"), true);
  assert.equal(canUseAPlusResume("BASIC"), false);
  assert.equal(canUseAPlusResume("PLUS"), false);
  assert.equal(canUseAPlusResume("PRO"), true);
});

test("upgrade path advances Basic to Plus to Pro", () => {
  assert.equal(nextPlan("BASIC"), "PLUS");
  assert.equal(nextPlan("PLUS"), "PRO");
  assert.equal(nextPlan("PRO"), null);
});
