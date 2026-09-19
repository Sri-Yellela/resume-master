// A DRAIN THAT WROTE NOTHING BECAUSE EVERY ROW FAILED RECORDED `status: 'ok'`.
//
// Production, 2026-09-05 to 09-07 and again 09-17 to 09-18: five days of enrichment runs with
// 25 of 25 rows failing, zero tokens spent, 10-second durations — and `pipeline_runs.status = 'ok'`
// on every one. The cause was billing:
//
//     400 invalid_request_error — "Your credit balance is too low to access the Anthropic API."
//
// which is precisely the class of outage a run log exists to make visible. The log said fine.
//
// The reason was that the only non-`ok` branch was a refusal (`stopReason === 'refused'`), so any
// other terminal state — including "every single row errored" — fell through to `ok`.
//
// ⛔ THE HEALTH CHECK DID CATCH IT, and that does not excuse the row. It reported "the last 2
// enrichment runs wrote nothing — this is the shape that ran for three days undetected", which is
// the system working. But `pipeline_runs.status` is read by things other than that check, and a
// status that contradicts its own `failed` column is a trap for whoever reads it next.
//
// The fix is deliberately narrow, and the tests below pin the narrowness as hard as the fix: a
// PARTIAL run stays `ok`, because 299 written against 9 failed is a working drain and promoting it
// would be an alarm nobody reads.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { at } from "../test-support/sourceAnchors.js";

const SRC = fs.readFileSync("services/jobs/enrichJob.js", "utf8");

/**
 * The status expression, evaluated the way the source computes it.
 *
 * Lifted from the source rather than restated: the defect was a missing branch, and a
 * re-implementation here would have had whatever branches I remembered to give it.
 */
function statusFor({ stopReason, enriched, failed }) {
  // The end anchor is searched FROM the start anchor and carries no newline: this file is CRLF, so
  // an anchor spelled with "\n" does not match it. That cost one red run.
  const start = at(SRC, "status: stopReason === 'refused'");
  const expr = SRC.slice(start, at(SRC, "startedAt,", start));
  const body = expr.replace(/^\s*status:\s*/, "").replace(/,\s*$/, "").trim();
  // eslint-disable-next-line no-new-func
  return new Function("stopReason", "enriched", "failed", `return (${body});`)(stopReason, enriched, failed);
}

test("⛔ every row failing and nothing written is NOT ok", () => {
  // The exact production shape: 25 fetched, 25 failed, 0 written.
  assert.equal(statusFor({ stopReason: "no_progress", enriched: 0, failed: 25 }), "failed");
});

test("a PARTIAL run is still ok — 299 written against 9 failed is a working drain", () => {
  // 2026-09-16, a genuinely good day. Promoting this to `failed` would be the opposite error.
  assert.equal(statusFor({ stopReason: "no_progress", enriched: 299, failed: 9 }), "ok");
  assert.equal(statusFor({ stopReason: "budget", enriched: 300, failed: 0 }), "ok");
});

test("an EMPTY queue is ok — a drained backlog is the goal state, not a fault", () => {
  assert.equal(statusFor({ stopReason: "drained", enriched: 0, failed: 0 }), "ok");
});

test("a refusal is still not a run", () => {
  // Two drains are scheduled in the same 04:00 tick and the second is routinely refused by the
  // concurrency guard. Recording that as a failure every day is a permanent false alarm.
  assert.equal(statusFor({ stopReason: "refused", enriched: 0, failed: 0 }), "skipped_unconfigured");
  assert.equal(statusFor({ stopReason: "refused", enriched: 0, failed: 25 }), "skipped_unconfigured",
    "a refusal outranks the failure branch — it means the run never really happened");
});

test("the status it emits is one the run log will accept", () => {
  // recordPipelineRun warns and records anyway on an unknown status, creating a category the
  // monitor never renders — the same class of invisible failure this table exists to catch.
  const log = fs.readFileSync("services/jobs/pipelineRunLog.js", "utf8");
  const valid = log.slice(at(log, "const VALID_STATUSES"), at(log, ";", at(log, "const VALID_STATUSES")));
  for (const s of ["ok", "failed", "skipped_unconfigured"]) {
    assert.ok(valid.includes(`'${s}'`), `${s} must be a status the log recognises`);
  }
});
