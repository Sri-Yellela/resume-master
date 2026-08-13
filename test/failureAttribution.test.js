// A run against a real Ashby URL reported "Failed / browser error" for an Anthropic 404. The
// browser had navigated, recorded a full audit and completed autofill — it was the one subsystem
// that worked. These tests pin the attribution so a failure names the thing that actually failed.
import test from "node:test";
import assert from "node:assert/strict";
import { classifyGenerationError, classifyRuntimeError } from "../shared/failureAttribution.js";

// The shape the Anthropic SDK actually throws for the observed failure.
function deadModelError() {
  const e = new Error('404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-4-20250514"}}');
  e.status = 404;
  e.error = { type: "error", error: { type: "not_found_error", message: "model: claude-sonnet-4-20250514" } };
  e.request_id = "req_011CTest404";
  return e;
}

test("a 404 on a model id is permanent and named as a dead model", () => {
  const f = classifyGenerationError(deadModelError());
  assert.equal(f.code, "generation_failed");
  assert.equal(f.status, 404);
  assert.equal(f.apiType, "not_found_error");
  assert.equal(f.isDeadModel, true);
  assert.equal(f.permanent, true, "a 404 on a model name can never succeed on retry");
});

test("the upstream 404 body and request_id stay reachable", () => {
  const f = classifyGenerationError(deadModelError());
  assert.match(f.detail, /http=404/);
  assert.match(f.detail, /type=not_found_error/);
  assert.match(f.detail, /request_id=req_011CTest404/);
  assert.match(f.detail, /permanent=yes/);
  assert.match(f.message, /claude-sonnet-4-20250514/);
});

test("overload and rate limit are transient, not permanent", () => {
  for (const status of [429, 500, 529]) {
    const e = new Error(`${status} overloaded`);
    e.status = status;
    assert.equal(classifyGenerationError(e).permanent, false, `${status} must stay retryable`);
  }
});

test("an unknown generation failure is treated as retryable", () => {
  // Guessing "permanent" would let one blip mark a job permanently unapplyable.
  assert.equal(classifyGenerationError(new Error("something odd")).permanent, false);
});

test("an API failure reaching the run catch is NOT called a browser error", () => {
  // This is the exact regression: the run said "browser error" for this.
  const r = classifyRuntimeError(deadModelError());
  assert.notEqual(r.reasonCode, "browser_error");
  assert.equal(r.reasonCode, "upstream_api_error");
  assert.equal(r.permanent, true);
});

test("a real navigation failure is still attributed to the browser", () => {
  // The fix must not overcorrect: genuine browser failures keep their code.
  const r = classifyRuntimeError(new Error("net::ERR_NAME_NOT_RESOLVED at https://example.com"));
  assert.equal(r.reasonCode, "browser_error");

  const t = classifyRuntimeError(new Error("Navigation timeout of 30000 ms exceeded"));
  assert.equal(t.reasonCode, "browser_timeout");
});

test("an unattributable error says internal_error, not browser_error", () => {
  const r = classifyRuntimeError(new TypeError("x is not a function"));
  assert.equal(r.reasonCode, "internal_error",
    "an honest unknown beats blaming a subsystem someone will then go and debug");
});

test("an error that already carries a reasonCode keeps it", () => {
  const e = new Error("nope");
  e.reasonCode = "browser_binary_not_found";
  assert.equal(classifyRuntimeError(e).reasonCode, "browser_binary_not_found");
});
