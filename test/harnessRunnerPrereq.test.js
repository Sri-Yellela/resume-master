// The harness runner has a prerequisite it does not satisfy itself, and used to fail silently.
//
// `npm run verify:harness` starts fakeAts on :4599 and NOTHING ELSE. Most harnesses drive the real
// app on :3001, which has to be running already. Without it every harness times out — and because
// each one's stdout is buffered until it exits and each gets a 700-SECOND kill timeout, the suite
// prints absolutely nothing for hours before reporting a full board of failures.
//
// AL1 spent 30 minutes watching a zero-byte output file. That is Shape 3 — a silent failure
// indistinguishable from slow progress — inside the one tool whose entire job is catching silent
// failures. These pin the fix so it cannot quietly come back out.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { at } from "../test-support/sourceAnchors.js";

const runner = fs.readFileSync("scripts/verifyHarnesses.mjs", "utf8");

test("the runner checks the app port BEFORE running anything", () => {
  assert.match(runner, /async function assertAppUp\(\)/);
  // Order is the whole point: after the first harness has started, the 700s timeouts have begun
  // and the silence this exists to prevent has already started.
  assert.ok(at(runner, "await assertAppUp()") < at(runner, "await startAts()"),
    "the app check must come before fakeAts is spawned");
  assert.ok(at(runner, "await assertAppUp()") < at(runner, "for (const name of all)"),
    "the app check must come before the first harness runs");
});

test("a dead app port EXITS rather than proceeding", () => {
  const fn = runner.slice(at(runner, "async function assertAppUp()"), at(runner, "let ats = null;"));
  assert.match(fn, /process\.exit\(2\)/,
    "it must refuse, not warn — a warning scrolls past and the 30 minutes of silence still happen");
  assert.match(fn, /node server\.js/, "the message must say how to fix it, not just what is wrong");
  assert.match(fn, /AbortSignal\.timeout/,
    "the probe itself must not hang, or the fail-fast check becomes the thing that hangs");
});

test("a 401 or a redirect counts as UP — the app is running, it just wants a login", () => {
  // A stricter `r.ok` would refuse to start against a healthy server that redirects anonymous
  // requests, which is exactly what this app does in some configurations. The check is "is
  // something serving HTTP here", not "is the root page 200".
  const fn = runner.slice(at(runner, "async function assertAppUp()"), at(runner, "let ats = null;"));
  assert.match(fn, /r\.status === 401 \|\| r\.status === 302/);
});

test("the runner says a green board is NOT evidence about the model-call path", () => {
  // Every harness that would exercise routing, generation, enrichment or classification is in
  // EXCLUDED because it spends tokens. A future session must not read a full green board as
  // provider verification — which is precisely the inference AL1's own summary had to disclaim.
  assert.match(runner, /does NOT mean: it is not evidence about the MODEL-CALL path/i);
  assert.match(runner, /al1ProviderQualityDiff/,
    "it must name what DOES verify real provider traffic, or the warning is a dead end");
  const pkg = fs.readFileSync("package.json", "utf8");
  assert.match(pkg, /REQUIRES the app already running on :3001/,
    "the prerequisite belongs where the command is invoked too, not only in the file it runs");
});
