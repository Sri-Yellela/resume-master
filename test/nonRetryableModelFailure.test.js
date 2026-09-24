import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isPermanentModelFailure } from "../services/modelCall.js";

// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
// /api/import/job answered "Could not import this job. Please try again" for an EXHAUSTED BILLING
// BALANCE. Every retry failed the same way in about 200ms, so the message sent users into a loop
// that could only fail — and made an unfunded account read as a flaky feature, which is exactly
// how it was reported (docs/EXTENSION_DIAGNOSIS.md §5).
//
// The classifier is a pure function, so unlike most of the extension's behaviour it can be tested
// properly rather than by asserting on source text.

test("an exhausted balance is permanent — the case this was built for", () => {
  // The literal wording Anthropic returns, captured from a real 400 on 2026-09-24.
  const err = Object.assign(new Error(
    '400 {"type":"error","error":{"type":"invalid_request_error","message":' +
    '"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing."}}'
  ), { status: 400 });
  assert.equal(isPermanentModelFailure(err), true);
});

test("a bad or missing key is permanent — no retry can fix it either", () => {
  for (const msg of ["invalid_api_key", "authentication_error: invalid x-api-key",
                     "permission_error: your account cannot access this model"]) {
    assert.equal(isPermanentModelFailure(new Error(msg)), true, msg);
  }
});

test("⛔ a 429 is NOT permanent, even when it talks about quota", () => {
  // Rate limiting is the single case retrying exists for. It also carries billing vocabulary often
  // enough to trip a naive signature scan, which is why status is checked BEFORE the text.
  const err = Object.assign(new Error("429 rate_limit_error: quota exceeded, please slow down"),
    { status: 429 });
  assert.equal(isPermanentModelFailure(err), false);
});

test("ordinary transient failures stay retryable", () => {
  for (const [msg, status] of [
    ["overloaded_error: the model is temporarily overloaded", 529],
    ["fetch failed: ECONNRESET", undefined],
    ["500 internal server error", 500],
    ["socket hang up", undefined],
  ]) {
    const err = Object.assign(new Error(msg), status ? { status } : {});
    assert.equal(isPermanentModelFailure(err), false, msg);
  }
});

test("it fails SAFE — anything unrecognised is treated as retryable", () => {
  // The scan matches provider wording, which is fragile. A false "retryable" costs one pointless
  // retry; a false "permanent" would tell a user to give up on a blip. Only one of those is
  // acceptable, so the default has to be retryable.
  assert.equal(isPermanentModelFailure(new Error("something nobody has seen before")), false);
  assert.equal(isPermanentModelFailure(new Error("")), false);
  assert.equal(isPermanentModelFailure({}), false);
  assert.equal(isPermanentModelFailure(null), false, "must not throw on a non-error");
});

test("it reads the SDK's nested error.message too, not just err.message", () => {
  // The Anthropic SDK surfaces the provider's text on a nested object as well as on the message.
  // Reading only one of the two is how this would pass its tests and miss the real shape.
  assert.equal(isPermanentModelFailure({ error: { message: "credit balance is too low" } }), true);
});

test("the import route uses the classifier and stops promising a retry", () => {
  const src = fs.readFileSync("routes/importJob.js", "utf8");
  assert.match(src, /isPermanentModelFailure\(err\)/);
  // 503 for the permanent case, and a machine-readable flag so a client can branch on the fact
  // rather than pattern-matching the prose.
  assert.match(src, /status\(503\)[\s\S]{0,400}retryable: false/);
  assert.match(src, /Retrying will not help/);
  // The retryable branch must still say so, or the two cases become indistinguishable again.
  assert.match(src, /retryable: true/);
});
