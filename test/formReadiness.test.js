// A real Ashby run discovered nothing, filled nothing, and reported "Autofilled 0 fields" as a
// clean autofill_done — in 9 seconds, far too fast for an Ashby SPA to have hydrated. These tests
// pin the readiness condition that replaced the fixed sleep, and the outcome that makes a
// zero-field pass impossible to mistake for success.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  FORM_READY_POLL_MS, FORM_READY_STABLE_POLLS, FORM_READY_TIMEOUT_MS, waitForFormReady,
} from "../services/applyAutomation.js";

const automation = fs.readFileSync("services/applyAutomation.js", "utf8");
const harness = fs.readFileSync("scripts/fakeAts.js", "utf8");

test("no discovery pass runs behind a fixed sleep", () => {
  // Two of these existed: one after navigation, one after clicking through to the next step of a
  // multi-step form. Both preceded a discovery pass, and both could walk a DOM still mounting.
  assert.doesNotMatch(automation, /await new Promise\(r => setTimeout\(r, 1500\)\)/,
    "a fixed 1500ms sleep is what let discovery walk an un-hydrated Ashby DOM");
  assert.match(automation, /const readiness = await waitForFormReady\(page\)/,
    "post-navigation discovery must wait on the readiness condition");
  const clickNext = automation.slice(automation.indexOf("async function clickNext"));
  assert.match(clickNext.slice(0, 900), /await waitForFormReady\(page\)/,
    "the next-step click must also wait for the new step to finish mounting");
});

test("the control count is an expression, not an arrow function", () => {
  // frame.evaluate(string) evaluates the string as an EXPRESSION. `() => ...` evaluates to a
  // function object, the count comes back undefined, the sum is NaN, `count === lastCount` is
  // never true, and the readiness check silently degrades into a full-timeout sleep on every run.
  // This was a real bug caught by a live run, not a hypothetical.
  assert.doesNotMatch(automation, /const COUNT_CONTROLS = `\(\) =>/);
  assert.match(automation, /const COUNT_CONTROLS = `document\.querySelectorAll/);
  assert.match(automation, /Number\.isFinite\(n\)/, "a non-numeric count must not be summed");
});

test("the stability window is wider than a realistic inter-chunk gap", () => {
  // Forms mount in chunks. With a 300ms window, discovery fired on chunk 1 of the /spa form and
  // found 3 of 8 fields — filling a partial form and holding, which looks like it worked.
  const windowMs = FORM_READY_POLL_MS * FORM_READY_STABLE_POLLS;
  assert.ok(windowMs >= 700,
    `stability window is ${windowMs}ms; must exceed the gap between hydration chunks`);
  // Still cheaper than the fixed sleep it replaced for an ordinary static page.
  assert.ok(windowMs < 1500, `${windowMs}ms would be slower than the sleep it replaced`);
  assert.ok(FORM_READY_TIMEOUT_MS >= 10000, "an SPA needs room to hydrate before we give up");
});

test("readiness reports honestly when it never settles", async () => {
  // A stub frame that always reports zero controls: readiness must time out and say so rather
  // than claiming a readiness it never observed.
  const fakePage = {
    mainFrame() { return this._f; },
    frames() { return [this._f]; },
    _f: { evaluate: async () => 0 },
  };
  const r = await waitForFormReady(fakePage, { pollMs: 5, stablePolls: 2, timeoutMs: 60 });
  assert.equal(r.ready, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.count, 0);
});

test("readiness waits for the count to stop climbing", async () => {
  // Mimics chunked hydration: 0 -> 3 -> 8, then steady. Must return 8, never 3.
  const counts = [0, 0, 3, 3, 8, 8, 8, 8, 8, 8, 8, 8];
  let i = 0;
  const fakePage = {
    mainFrame() { return this._f; },
    frames() { return [this._f]; },
    _f: { evaluate: async () => counts[Math.min(i++, counts.length - 1)] },
  };
  const r = await waitForFormReady(fakePage, { pollMs: 1, stablePolls: 3, timeoutMs: 2000 });
  assert.equal(r.ready, true);
  assert.equal(r.count, 8, "returned mid-hydration; a partial form would have been submitted");
});

test("zero discovered fields is a distinct outcome that holds", () => {
  // The third instance of the "logs like success" defect class, after the Jobo unconfigured skip
  // and the enrichment empty-write stamp.
  assert.match(automation, /status:\s+"no_fields_discovered"/);
  assert.match(automation, /reasonCode:\s+"no_fields_discovered"/);
  assert.match(automation, /if \(firstPassFieldCount === 0\)/);
  // It must return BEFORE the submit path, not fall through to it.
  const idxHold = automation.indexOf('status:           "no_fields_discovered"');
  const idxSubmit = automation.indexOf("Completeness gate");
  assert.ok(idxHold > 0 && idxHold < idxSubmit,
    "the zero-field hold must return before the completeness/submit path");
});

test("discoverAndFill reports raw field count separately from filled count", () => {
  // "0 filled" and "0 discovered" are different failures: one means we chose not to answer,
  // the other means we never saw a form.
  assert.match(automation, /fieldCount \+= fields\.length/);
  assert.match(automation, /return \{ filled, fieldCount, answers: collected/);
});

test("the harness has a JS-rendered route that mounts in more than one chunk", () => {
  assert.match(harness, /function spaForm/);
  assert.match(harness, /path === '\/spa'/);
  assert.match(harness, /chunk2/, "a single-chunk SPA would not catch an over-eager readiness check");
  assert.match(harness, /enctype="multipart\/form-data"/);
  // The delay must exceed the fixed sleep that used to sit here, or the route cannot reproduce
  // the failure it exists to reproduce.
  const m = harness.match(/Number\.isFinite\(delayMs\) \? delayMs : (\d+)/);
  assert.ok(m && Number(m[1]) > 1500, "hydration delay must exceed the old 1500ms fixed sleep");
});

test("every harness form with a file input declares enctype", () => {
  // Already true before this change (commit 196f4cf); pinned so it cannot regress, since without
  // it a file input submits a filename only and the resume upload path is never exercised.
  const forms = harness.match(/<form[^>]*>/g) || [];
  for (const f of forms) {
    const action = (f.match(/action="([^"]+)"/) || [])[1] || "";
    if (/decoy/.test(action)) continue;
    // Find the form body to check for a file input.
    const start = harness.indexOf(f);
    const end = harness.indexOf("</form>", start);
    const body = harness.slice(start, end === -1 ? undefined : end);
    if (/type="file"/.test(body)) {
      assert.match(f, /enctype="multipart\/form-data"/,
        `form ${action} has a file input but no enctype — uploads would submit a filename only`);
    }
  }
});
