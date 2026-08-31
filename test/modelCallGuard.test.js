// The half that keeps cost coverage from rotting.
//
// An audit found 4 of 14 model call sites recorded usage. The other 10 — including one call PER
// JOB across hundreds of enrichment rows, and three UNAUTHENTICATED standalone endpoints — spent
// real money and logged nothing, so the admin cost panel showed a confident total that omitted
// most of the traffic. A wrapper alone would have rotted the same way the hardcoded model IDs
// did: the fix was applied once, and the next call site added went straight back to the raw SDK.
//
// This guard fails the build when that happens.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const WRAPPER = "services/modelCall.js";
// This file quotes the forbidden call inside its own failure message, so it must not scan
// itself. Every OTHER test file is still scanned — a test that calls the SDK directly is a
// real untracked call site, not an exemption.
const SELF = "test/modelCallGuard.test.js";

/** Every tracked .js/.jsx file, excluding deps, build output and the wrapper itself. */
function sourceFiles(dir = ".", acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (/^(node_modules|\.git|dist|build|coverage|\.cinematic)$/.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.(js|mjs|jsx)$/.test(entry.name)) acc.push(full.split(path.sep).join("/"));
  }
  return acc;
}

test("no bare anthropic.messages.create outside the wrapper", () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    if (file === WRAPPER || file === SELF) continue;
    const src = fs.readFileSync(file, "utf8");
    src.split("\n").forEach((line, i) => {
      // Ignore comments — several files legitimately explain why they no longer call it directly.
      const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      // BATCHES COUNT TOO. This pattern used to be /\.messages\.create\s*\(/, which does not match
      // `messages.batches.create(` — ".messages.create" is not a substring of
      // ".messages.batches.create". The Batch API was therefore invisible to the one guard that
      // exists to stop untracked spend: adding batching would have created exactly the defect
      // described below while this test stayed green. Verified against all four shapes in the test
      // beneath this one, so the regex cannot quietly narrow again.
      if (/\.messages\.(batches\.)?(create|results)\s*\(/.test(code)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(
    offenders, [],
    "These call a model without recording what it cost:\n" +
    offenders.map(o => `  ${o}`).join("\n") +
    `\n\nFIX: import { callModel } from '${WRAPPER}' (adjust the relative path) and replace\n` +
    "      await anthropic.messages.create({ model, ...params })\n" +
    "  with\n" +
    "      await callModel({ anthropic, db, purpose: 'some_feature', userId, model, ...params })\n" +
    "  `purpose` is a stable snake_case feature name and is REQUIRED — it is how spend is\n" +
    "  attributed to a feature rather than only to a model. For background work with no user in\n" +
    "  scope, pass userId: SYSTEM_USER_ID from the same module.\n" +
    "  Do NOT add an exemption here: an untracked call site is exactly the defect this guards."
  );
});

// The guard above is a regex over source text, so its COVERAGE is a property of the regex and
// nothing else was checking it. It read /\.messages\.create\s*\(/ and therefore could not see
// `messages.batches.create(` at all — the Batch API would have been an untracked spend path with a
// green suite. Asserted against the literal call shapes rather than against a file, because that is
// the thing that was wrong: the scan, not any call site.
test("the untracked-call scan sees batch call shapes, not just messages.create", () => {
  const SCAN = /\.messages\.(batches\.)?(create|results)\s*\(/;
  const mustCatch = [
    "const m = await client.messages.create({ model });",
    "const m = await client.beta.messages.create({ model });",
    "const b = await client.messages.batches.create({ requests });",
    "for await (const r of client.messages.batches.results(id)) {}",
    "await anthropic.messages.batches.create({requests})",
  ];
  for (const line of mustCatch) {
    assert.ok(SCAN.test(line), `the scan would MISS an untracked call site: ${line}`);
  }
  // Must not fire on unrelated code, or the guard becomes noise and gets exemptions added to it.
  const mustIgnore = [
    "const messages = buildMessages();",
    "db.prepare('SELECT * FROM messages').all();",
    "await client.messages.countTokens({ messages });",
    "batches.push(job);",
  ];
  for (const line of mustIgnore) {
    assert.ok(!SCAN.test(line), `the scan false-positives on: ${line}`);
  }
});

test("the wrapper is the only thing importing trackApiCall", () => {
  // Two paths to the same table is how the four 'tracked' sites drifted from the other ten.
  const offenders = [];
  for (const file of sourceFiles()) {
    if (file === WRAPPER || file.startsWith("test/")) continue;
    const src = fs.readFileSync(file, "utf8");
    if (/import\s*\{[^}]*\btrackApiCall\b[^}]*\}\s*from/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    "trackApiCall must be called only by services/modelCall.js so there is ONE logged path.\n" +
    "Route the call through callModel instead of tracking it separately.");
});

test("every callModel invocation passes a purpose", () => {
  // A call recorded without a purpose is spend that cannot be attributed to a feature.
  const missing = [];
  for (const file of sourceFiles()) {
    if (file === WRAPPER || file.startsWith("test/")) continue;
    const src = fs.readFileSync(file, "utf8");
    // Each call's argument object, up to the model line — purpose is written adjacent to it.
    // Inspect the whole argument window, not just the text before `model`: key order is a style
    // choice, and a site writing `{ anthropic, db, model, purpose }` is perfectly correct.
    for (const m of src.matchAll(/callModel\(\{([\s\S]{0,600})/g)) {
      // Accept property shorthand (`{ purpose }`) as well as `purpose: '…'` — otherwise a
      // perfectly good call site that forwards a `purpose` variable fails this guard.
      if (!/\bpurpose\s*[:,}]/.test(m[1])) {
        missing.push(`${file}: callModel({...}) near "${m[1].trim().slice(0, 60)}"`);
      }
    }
  }
  assert.deepEqual(missing, [],
    "callModel requires a `purpose`:\n" + missing.map(x => `  ${x}`).join("\n"));
});
