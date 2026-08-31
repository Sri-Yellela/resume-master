import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { at } from "../test-support/sourceAnchors.js";

const apiSrc = fs.readFileSync("client/src/lib/api.js", "utf8");

// The apply guards (A3) answer with a machine code in `error` and the sentence in `message`:
//   { error: "daily_cap_exceeded", message: "Daily application cap reached: 2 of 3 used…" }
// api.js preferred `error`, so the user was shown "daily_cap_exceeded" — which reads like a crash,
// not an explanation. Every throw site must now go through errorMessage(), which prefers `message`.

test("errorMessage prefers the human sentence over the machine code", () => {
  assert.match(apiSrc, /function errorMessage\(payload, fallback\)/,
    "a single helper must own this precedence");
  const start = apiSrc.indexOf("function errorMessage(payload, fallback)");
  const fn = apiSrc.slice(start, at(apiSrc, "\n}", start));
  assert.match(fn, /payload\?\.message/, "must read message");
  assert.match(fn, /payload\?\.error/, "must fall back to error for older endpoints");
  assert.match(fn, /return message \|\| error \|\| fallback/, "message wins, then error, then generic");
});

test("no throw site re-introduces the raw `payload.error ||` precedence", () => {
  // The bug shape: `new Error(payload.error || "...")`. Every branch must route through the helper.
  assert.doesNotMatch(apiSrc, /new Error\(payload\.error\s*\|\|/,
    "a throw site is bypassing errorMessage and will surface the machine code");
  // Counted on the call itself: one fallback is a template literal containing parentheses
  // (`Request failed (${r.status})`), which a naive [^)]+ would not span.
  const throughHelper = apiSrc.match(/new Error\(errorMessage\(payload,/g) || [];
  assert.ok(throughHelper.length >= 4,
    `all error branches must use errorMessage — found ${throughHelper.length}`);
});

test("the generic fallbacks are kept for bodies that carry neither field", () => {
  // A body with no message and no error must still produce human copy rather than "undefined".
  assert.match(apiSrc, /Too many requests\. Try again shortly\./);
  assert.match(apiSrc, /Service temporarily unavailable\. Try again shortly\./);
  assert.match(apiSrc, /Request failed \(\$\{r\.status\}\)/);
  assert.match(apiSrc, /Invalid credentials\./);
});

test("the payload is still attached, so structured fields stay reachable", () => {
  // JobsPanel reads e.payload.missingPrerequisites; changing the message must not drop the payload.
  const attaches = apiSrc.match(/\{ status: [^}]*payload \}/g) || [];
  assert.ok(attaches.length >= 3, `payload must remain attached to the thrown error (${attaches.length})`);
  // startApplyRun, and with it the missingPrerequisites read, moved into
  // contexts/AutoApplyContext.jsx when the pipeline got its own tab (W5).
  const jobsPanel = fs.readFileSync("client/src/contexts/AutoApplyContext.jsx", "utf8");
  assert.match(jobsPanel, /e\.payload\?\.missingPrerequisites/);
});

test("errorMessage picks the right string for each real guard response", async () => {
  // Behavioural: exercise the precedence directly against the bodies the server actually sends.
  // api.js imports browser-only modules, so the helper is re-declared here from its own source —
  // if the implementation changes shape, the source-level tests above fail first.
  const start = apiSrc.indexOf("function errorMessage(payload, fallback)");
  const end = apiSrc.indexOf("\n}", start) + 2;
  const errorMessage = new Function(`${apiSrc.slice(start, end)}; return errorMessage;`)();

  assert.equal(
    errorMessage({ error: "daily_cap_exceeded", message: "Daily application cap reached: 2 of 3 used in the last 24h, 2 requested." }, "generic"),
    "Daily application cap reached: 2 of 3 used in the last 24h, 2 requested.");
  assert.equal(
    errorMessage({ error: "full_auto_disabled", message: "Automatic submission is currently disabled. Manual review mode is still available." }, "generic"),
    "Automatic submission is currently disabled. Manual review mode is still available.");
  assert.equal(
    errorMessage({ error: "upgrade_required", message: "A+ Resume requires the PRO plan." }, "generic"),
    "A+ Resume requires the PRO plan.");
  // Older endpoints: the sentence lives in `error`.
  assert.equal(errorMessage({ error: "All selected jobs are already applied or in progress" }, "generic"),
    "All selected jobs are already applied or in progress");
  assert.equal(errorMessage({ error: "Apply prerequisites are not set up yet" }, "generic"),
    "Apply prerequisites are not set up yet");
  // Neither field, or empty/whitespace values: fall through to the generic copy.
  assert.equal(errorMessage({}, "generic"), "generic");
  assert.equal(errorMessage({ message: "   ", error: "" }, "generic"), "generic");
  assert.equal(errorMessage(undefined, "generic"), "generic");
  assert.equal(errorMessage({ message: 42, error: null }, "generic"), "generic", "non-strings are ignored");
});
