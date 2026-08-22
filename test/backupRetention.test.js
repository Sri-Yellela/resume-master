// Backup retention, and the two ways this directory reached 442 MB.
//
// CAUSE ONE was an import side effect. scripts/backup.js ended in an unguarded CLI block, and
// server.js imports createBackup for its auto-daily job — so every server boot fell through to the
// default branch and wrote a full copy of the DB. 27 of the 30 backups on disk were restarts.
//
// CAUSE TWO was count-only retention. `manifest.slice(0, 30)` cost 40 MB when the DB was 1.3 MB and
// 3.5 GB once migration 082's LCA tables took it to 116 MB. The policy never changed; the row count
// did. A count cap cannot see that, which is why the budget is in bytes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { selectRetained } from "../scripts/backup.js";

const MB = 1024 * 1024;
const BACKUP_SRC = fs.readFileSync(new URL("../scripts/backup.js", import.meta.url), "utf8");

/** Newest-first, the order the manifest stores. */
const entry = (n, label = "manual", size = 100 * MB) => ({ filename: `b${n}.db`, label, size });

// ── The import side effect ───────────────────────────────────────────────────────────────────

test("the CLI block is guarded, so importing this module cannot write a backup", () => {
  assert.match(BACKUP_SRC, /const isEntryPoint = process\.argv\[1\] &&/,
    "the run-as-script block must be gated on being the entry point");
  assert.match(BACKUP_SRC, /if \(isEntryPoint\) \{/);
  // The default branch — the one that fired on every server boot — must sit INSIDE the guard.
  const guardAt = BACKUP_SRC.indexOf("if (isEntryPoint) {");
  const createAt = BACKUP_SRC.lastIndexOf('createBackup(args[0] || "manual")');
  assert.ok(guardAt > 0 && createAt > guardAt,
    "createBackup(args[0]) must be inside the entry-point guard, not at module scope");
  // Importing for real is the actual proof, and test/ importing it above already exercises that:
  // if the guard were missing, running this suite would have written a backup.
});

// ── The byte budget ──────────────────────────────────────────────────────────────────────────

test("the byte budget binds before the count cap when backups are large", () => {
  // Ten 100 MB backups under a 30-count cap: the count says keep all ten, the budget says five.
  const entries = Array.from({ length: 10 }, (_, i) => entry(i));
  const { keep, drop, keptBytes } = selectRetained(entries,
    { maxBytes: 500 * MB, maxCount: 30, minKeep: 3 });
  assert.equal(keep.length, 5);
  assert.equal(drop.length, 5);
  assert.ok(keptBytes <= 500 * MB, `kept ${keptBytes} over budget`);
  // And it keeps the NEWEST five, not an arbitrary five.
  assert.deepEqual(keep.map(e => e.filename), ["b0.db", "b1.db", "b2.db", "b3.db", "b4.db"]);
});

test("the count cap still binds when backups are small — the old behaviour is intact", () => {
  const entries = Array.from({ length: 40 }, (_, i) => entry(i, "manual", 1.3 * MB));
  const { keep } = selectRetained(entries, { maxBytes: 512 * MB, maxCount: 30, minKeep: 3 });
  assert.equal(keep.length, 30, "40 tiny backups under a 30 cap must retain 30");
});

test("the newest backup is never pruned, even alone over budget", () => {
  // A DB bigger than the whole budget. Deleting the only copy of the current state to satisfy a
  // number would be the worst thing this function could do.
  const entries = [entry(0, "manual", 900 * MB), entry(1, "manual", 900 * MB)];
  const { keep } = selectRetained(entries, { maxBytes: 512 * MB, maxCount: 30, minKeep: 1 });
  assert.deepEqual(keep.map(e => e.filename), ["b0.db"]);
});

test("MIN_KEEP overrides the budget — one backup is not a backup", () => {
  const entries = Array.from({ length: 6 }, (_, i) => entry(i, "manual", 400 * MB));
  const { keep } = selectRetained(entries, { maxBytes: 512 * MB, maxCount: 30, minKeep: 3 });
  assert.equal(keep.length, 3, "the floor holds even though 3 x 400 MB blows a 512 MB budget");
  // ...but the floor must not override the COUNT cap, or maxCount stops meaning anything.
  const capped = selectRetained(entries, { maxBytes: 512 * MB, maxCount: 1, minKeep: 3 });
  assert.equal(capped.keep.length, 1);
});

// ── Keeping the KINDS of restore point ───────────────────────────────────────────────────────

test("a burst of manual backups cannot evict every auto-daily", () => {
  // The realistic failure: a day of restarts/manual saves pushes the coarse history off the end,
  // leaving five copies of one afternoon and no older restore point at all.
  const entries = [
    ...Array.from({ length: 8 }, (_, i) => entry(i, "manual")),
    entry(90, "auto-daily"),
    entry(91, "auto-daily"),
  ];
  const { keep } = selectRetained(entries, { maxBytes: 500 * MB, maxCount: 30, minKeep: 1 });
  assert.equal(keep.length, 5, "budget still respected");
  assert.ok(keep.some(e => e.label === "auto-daily"),
    "the newest auto-daily must survive a burst of manuals");
  assert.equal(keep[0].filename, "b0.db", "and the newest overall still leads");
});

test("a pre-restore snapshot is protected as its own kind", () => {
  // It is the file you want most after a mistaken restore, and it used to be untracked entirely —
  // never listed, never pruned. Now it has a label, so rule 2 keeps the newest one.
  const entries = [
    ...Array.from({ length: 6 }, (_, i) => entry(i, "manual")),
    entry(80, "pre-restore"),
    entry(90, "auto-daily"),
  ];
  const { keep } = selectRetained(entries, { maxBytes: 400 * MB, maxCount: 30, minKeep: 1 });
  assert.ok(keep.some(e => e.label === "pre-restore"), "the pre-restore snapshot must survive");
  assert.ok(keep.some(e => e.label === "auto-daily"));
  assert.ok(keep.reduce((n, e) => n + e.size, 0) <= 400 * MB);
});

test("restoreBackup records the pre-restore copy in the manifest", () => {
  // Untracked files are invisible to `list` and immune to pruning — the two properties that made
  // them accumulate forever.
  assert.match(BACKUP_SRC, /filename: safeName, label: "pre-restore"/);
  const at = BACKUP_SRC.indexOf('label: "pre-restore"');
  assert.ok(BACKUP_SRC.slice(at).includes("saveManifest(keep)"),
    "and the manifest must actually be written after adding it");
});

// ── Housekeeping ─────────────────────────────────────────────────────────────────────────────

test("sidecars are removed with their .db, and orphans are swept", () => {
  // A pruned .db could leave -shm/-wal behind; two such orphans outlived every backup in the
  // directory because nothing ever looked for them.
  assert.match(BACKUP_SRC, /for \(const side of \["-shm", "-wal"\]\)/);
  assert.match(BACKUP_SRC, /function sweepOrphanSidecars\(\)/);
  assert.match(BACKUP_SRC, /sweepOrphanSidecars\(\);/);
});

test("the caps are configurable, so a deploy is not stuck with this machine's budget", () => {
  for (const name of ["BACKUP_MAX_BYTES", "BACKUP_MAX_COUNT", "BACKUP_MIN_KEEP"]) {
    assert.ok(BACKUP_SRC.includes(name), `${name} must be readable from the environment`);
  }
  assert.match(BACKUP_SRC, /envInt\("BACKUP_MAX_BYTES", 512 \* 1024 \* 1024\)/);
});

test("an empty manifest is not an error", () => {
  assert.deepEqual(selectRetained([]), { keep: [], drop: [], keptBytes: 0 });
});

test("a missing size does not let an entry escape the budget as free", () => {
  // Manifest entries written by older versions may lack `size`. Treating undefined as 0 is the
  // only safe reading, but it must not then be COUNTED as if it were free forever.
  const entries = [entry(0, "manual", undefined), entry(1, "manual", 600 * MB)];
  const { keep } = selectRetained(entries, { maxBytes: 500 * MB, maxCount: 30, minKeep: 1 });
  assert.deepEqual(keep.map(e => e.filename), ["b0.db"], "the oversized one is still dropped");
});
