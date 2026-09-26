import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ── THE DOC GUARD ───────────────────────────────────────────────────────────────────────────────
//
// HANDOFF.md and ARCHITECTURE.md quote facts about this repo. Every doc that quoted a fact here has
// gone stale — NEXT_WORK.md was stale EIGHT times, most recently about its own headline — and
// staleness was always discovered by a later session acting on a wrong number, never by CI.
//
// This asserts the quoted values against the source of truth, so the DOC fails the build when it
// drifts. That is the point: a failing test naming the file and the stale value is cheaper than a
// session spent reasoning from it.
//
// ⛔ WHEN THIS FAILS, FIX THE DOC — do not relax the assertion. The whole value is that it is
// annoying at exactly the moment the doc stops being true.
//
// WHAT IS DELIBERATELY *NOT* GUARDED, and why:
//
//   · The deployed commit. It changes on every push and the doc cannot lead it. HANDOFF tells the
//     reader to run GET /api/version instead, which is the honest answer.
//   · The exact test count (2655/2655/0). There is no non-fragile way to know the suite's own
//     total from inside the suite — counting `test(` occurrences is an approximation that would
//     drift from the real number and produce a guard that is wrong in both directions. Asserting
//     an approximation would be defect shape 5: a test that pins something other than the truth.
//     The count is instead recorded in CLAUDE.md, where the deliberate-failure list already lives
//     and where a human updating the board will see it.
//
// Practicality was the brief's question, and the answer is: the structural facts below are exact
// and cheap to assert; the test count is not, and pretending otherwise would be worse than the gap.

const read = (p) => fs.readFileSync(p, "utf8");

/** Last `id: "NNN_..."` in a migration runner — the high-water mark. */
function highWater(file) {
  const ids = [...read(file).matchAll(/id: "(\d{3}_[a-z0-9_]+)"/g)].map(m => m[1]);
  assert.ok(ids.length > 0, `${file}: found no migration ids — the regex has drifted, not the doc`);
  return ids[ids.length - 1];
}

test("both migration runners still agree on the high-water mark", () => {
  // Asserted first: if the two runners disagree, the doc cannot be right about either, and the
  // failure below would be misleading about which thing is broken.
  assert.equal(highWater("server.js"), highWater("scripts/migrations.js"),
    "server.js and scripts/migrations.js disagree — server.js is the runner that executes");
});

test("HANDOFF.md quotes the real migration high-water mark", () => {
  const actual = highWater("server.js");
  assert.ok(read("HANDOFF.md").includes(actual),
    `HANDOFF.md does not mention the current high-water "${actual}" — update the doc`);
});

test("ARCHITECTURE.md quotes the real migration high-water mark", () => {
  const actual = highWater("server.js");
  assert.ok(read("ARCHITECTURE.md").includes(actual),
    `ARCHITECTURE.md does not mention the current high-water "${actual}" — update the doc`);
});

test("ARCHITECTURE.md quotes the real count of DEFINED migrations", () => {
  // The doc says production applied 116: 110 numbered plus 6 unnumbered legacy ids. The 110 is a
  // fact about this repo and must stay true; the 116 is a fact about a deployment and is not
  // guarded here (HANDOFF points the reader at /api/version for deployed state).
  const defined = new Set();
  for (const f of ["server.js", "scripts/migrations.js"])
    for (const m of read(f).matchAll(/id: "(\d{3}_[a-z0-9_]+)"/g)) defined.add(m[1]);
  assert.ok(read("ARCHITECTURE.md").includes(`**${defined.size}** numbered migrations`),
    `ARCHITECTURE.md's numbered-migration count is stale — there are now ${defined.size}`);
});

test("HANDOFF.md quotes the real contract version", () => {
  // `info.version`, not a top-level `version` — the file is an OpenAPI document. Asserted rather
  // than grepped so a malformed contract fails here instead of silently matching nothing.
  const contract = JSON.parse(read("contract/mobile-api.v1.json")).info?.version;
  assert.ok(/^\d+\.\d+\.\d+$/.test(contract || ""), `contract version looks wrong: ${contract}`);
  assert.ok(read("HANDOFF.md").includes(contract),
    `HANDOFF.md does not mention contract ${contract} — update the doc`);
});

test("the four documents the reset produced all exist", () => {
  // A handoff that points at a missing file is worse than no pointer. Cheap to assert, and it
  // catches a delete that a later doc cleanup makes without reading what links to it.
  for (const f of ["README.md", "HANDOFF.md", "ARCHITECTURE.md", "docs/CORRECTIONS_REGISTER.md"])
    assert.ok(fs.existsSync(f), `${f} is referenced by the doc set and does not exist`);
});

test("HANDOFF.md still points only at documents that exist", () => {
  // Link rot in the orientation doc is how a newcomer's first five minutes get wasted.
  //
  // ANDROID.md and IOS.md are named deliberately and live in the two MOBILE repos, not this one —
  // HANDOFF says so in the same sentence. They are excluded BY NAME rather than by loosening the
  // pattern, so a genuinely broken local link still fails.
  const EXTERNAL = new Set(["ANDROID.md", "IOS.md"]);
  const links = [...read("HANDOFF.md").matchAll(/`(docs\/[A-Za-z0-9_.-]+\.md|[A-Z_]+\.md)`/g)]
    .map(m => m[1])
    .filter(f => !EXTERNAL.has(f));
  const missing = [...new Set(links)].filter(f => !fs.existsSync(f));
  assert.deepEqual(missing, [], `HANDOFF.md points at files that do not exist: ${missing.join(", ")}`);
});
