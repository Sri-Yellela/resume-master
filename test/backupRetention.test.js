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
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
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

// ── The WAL, which is why a file copy was not a backup ───────────────────────────────────────

test("copying only the main file loses committed data; a TRUNCATE checkpoint recovers it", () => {
  // THE PROPERTY, demonstrated on a throwaway database rather than asserted about ours. Measured on
  // the real one first: two backups nine hours apart and the live DB all shared one md5, because the
  // main file had not changed while a 41 MB WAL accumulated. A backup taken then read
  // periods_with_filings = 18 against the live 21 — three hours behind, and it restored cleanly.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "walcheck-"));
  const dbPath = path.join(dir, "t.db");
  // Windows holds a lock for every OPEN sqlite handle, so rmSync fails with EPERM unless all of
  // them are closed first — including the read-only ones, and including the case where an assertion
  // threw before the close. Hence a list closed in `finally` rather than closes inline.
  const open = [];
  const openDb = (p, opts) => { const d = new Database(p, opts); open.push(d); return d; };
  try {
    const db = openDb(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE t (v INTEGER)");
    db.prepare("INSERT INTO t (v) VALUES (1)").run();
    db.pragma("wal_checkpoint(TRUNCATE)");           // baseline: row 1 is in the main file

    // A committed write that stays in the WAL, exactly like the server's.
    db.prepare("INSERT INTO t (v) VALUES (2)").run();
    assert.ok(fs.existsSync(`${dbPath}-wal`) && fs.statSync(`${dbPath}-wal`).size > 0,
      "the WAL must actually hold something for this test to mean anything");

    // What the OLD createBackup did: copy the main file only.
    const naive = path.join(dir, "naive.db");
    fs.copyFileSync(dbPath, naive);
    assert.equal(openDb(naive, { readonly: true }).prepare("SELECT count(*) c FROM t").get().c, 1,
      "a main-file-only copy is missing the committed row — the bug");

    // What it does now.
    const [row] = db.pragma("wal_checkpoint(TRUNCATE)", { simple: false });
    assert.equal(row.busy, 0, "checkpoint should not be busy against a single connection");
    const checked = path.join(dir, "checked.db");
    fs.copyFileSync(dbPath, checked);
    assert.equal(openDb(checked, { readonly: true }).prepare("SELECT count(*) c FROM t").get().c, 2,
      "after the checkpoint the main file is the whole database");
  } finally {
    for (const d of open) { try { d.close(); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("the checkpoint runs BEFORE the copy, and its result is recorded rather than assumed", () => {
  const cpAt = BACKUP_SRC.indexOf("const cp = checkpointWal();");
  const copyAt = BACKUP_SRC.indexOf("fs.copyFileSync(DB_PATH, dest);");
  assert.ok(cpAt > 0 && copyAt > cpAt, "checkpointWal() must run before the file copy");
  assert.match(BACKUP_SRC, /wal_checkpoint\(TRUNCATE\)/,
    "PASSIVE is the automatic behaviour that already failed to keep up; FULL leaves the log in place");
  // A backup it cannot vouch for must say so, in the manifest and on stdout.
  assert.match(BACKUP_SRC, /walCheckpointed: cp\.ok/);
  assert.match(BACKUP_SRC, /WAL checkpoint incomplete/);
  // ...and fall back to carrying the sidecar rather than shipping a possibly-stale copy.
  assert.match(BACKUP_SRC, /fs\.copyFileSync\(`\$\{DB_PATH\}-wal`, `\$\{dest\}-wal`\)/);
  // A carried sidecar is part of what the backup costs, so it has to count against the budget or
  // retention would under-estimate the directory it is meant to bound.
  assert.match(BACKUP_SRC, /const size = fs\.statSync\(dest\)\.size \+ \(walCopied/);
});

test("restore clears the live sidecars, so a restored file is not merged with the old log", () => {
  // Copying the main file while resume_master.db-wal still holds the PREVIOUS database's pages
  // leaves SQLite reconciling a restored file with a log belonging to something else.
  const restoreAt = BACKUP_SRC.indexOf("export function restoreBackup");
  const body = BACKUP_SRC.slice(restoreAt);
  const copyAt = body.indexOf("fs.copyFileSync(src, DB_PATH);");
  const unlinkAt = body.indexOf('for (const side of ["-wal", "-shm"])');
  assert.ok(copyAt > 0 && unlinkAt > copyAt, "sidecars must be cleared after the main file lands");
  // And a backup that carried its own WAL gets it back.
  assert.match(body, /if \(fs\.existsSync\(`\$\{src\}-wal`\)\)/);
});

// ── verify: backfilling only what is actually knowable ───────────────────────────────────────

test("verify backfills walCheckpointed as false, and says so about the PROCESS not the data", () => {
  // The honest reading: for a copy taken before the checkpoint existed, "was the WAL checkpointed?"
  // is literally false — none was performed. What is NOT knowable is whether the WAL held anything
  // at that moment, and integrity_check cannot recover it: a database copied mid-WAL is perfectly
  // valid, just older. That is precisely how the stale backup passed every check while being three
  // hours behind, so the note has to carry the caveat the boolean cannot.
  assert.match(BACKUP_SRC, /entry\.walCheckpointed = false;/);
  assert.match(BACKUP_SRC, /walNote =[\s\S]{0,120}predates the checkpoint step/);
  assert.match(BACKUP_SRC, /may be missing data that was in the WAL/);
  // Only filled when ABSENT — a real `false` from a busy checkpoint, or a real `true`, must survive.
  assert.match(BACKUP_SRC, /if \(entry\.walCheckpointed === undefined\) \{/);
});

test("verify cannot downgrade a checkpoint that really happened", () => {
  // The failure this guards: re-running verify stamping `false` over a genuine `true` would turn a
  // complete backup into one the operator distrusts, and the `list` output is the only place that
  // distinction ever reaches a human.
  const at = BACKUP_SRC.indexOf("entry.walCheckpointed = false;");
  const guardAt = BACKUP_SRC.lastIndexOf("if (entry.walCheckpointed === undefined) {", at);
  assert.ok(guardAt > 0 && guardAt < at,
    "the backfill must sit inside an `=== undefined` guard so it is never an overwrite");
});

test("verifying a WAL database creates sidecars, so verify has to clean up after itself", () => {
  // Not hypothetical: opening the five real backups read-only produced TEN files, and a sidecar
  // beside an EXISTING .db is invisible to sweepOrphanSidecars, which only looks for orphans. This
  // is where the two mystery -shm/-wal files in data/backups came from.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-"));
  const dbPath = path.join(dir, "t.db");
  const open = [];
  try {
    const db = new Database(dbPath);
    open.push(db);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE t (v INTEGER)");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    for (const side of ["-wal", "-shm"]) { try { fs.unlinkSync(`${dbPath}${side}`); } catch {} }
    assert.ok(!fs.existsSync(`${dbPath}-wal`), "clean starting point");

    // READ-ONLY is enough to recreate them.
    const ro = new Database(dbPath, { readonly: true });
    open.push(ro);
    ro.pragma("integrity_check", { simple: true });
    assert.ok(fs.existsSync(`${dbPath}-shm`),
      "a read-only open recreates the sidecars — the reason verify records what existed first");
  } finally {
    for (const d of open) { try { d.close(); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }

  // And the implementation has to note pre-existing sidecars so it removes only its own, never a
  // backup's carried WAL from the busy-checkpoint path.
  assert.match(BACKUP_SRC, /const pre = \{ wal: fs\.existsSync\(`\$\{p\}-wal`\), shm: fs\.existsSync\(`\$\{p\}-shm`\) \}/);
  assert.match(BACKUP_SRC, /if \(!pre\.wal\) \{ try \{ fs\.unlinkSync\(`\$\{p\}-wal`\)/);
});

test("verify records the schema era, which is the question you ask before restoring", () => {
  assert.match(BACKUP_SRC, /FROM schema_migrations ORDER BY rowid DESC LIMIT 1/);
  // An ancient backup may predate the table entirely; that must be null, not a crash.
  assert.match(BACKUP_SRC, /catch \{ entry\.schema = null; \}/);
  // A file that has gone missing is reported, not thrown over.
  assert.match(BACKUP_SRC, /entry\.integrity = "missing";/);
  assert.match(BACKUP_SRC, /entry\.integrity = `unreadable: \$\{err\.message\}`/);
});

test("list surfaces the checkpoint state — the manifest alone warns nobody", () => {
  assert.match(BACKUP_SRC, /UNVERIFIED-WAL/);
  const listAt = BACKUP_SRC.indexOf('if (args[0] === "list")');
  const flagAt = BACKUP_SRC.indexOf("const flag = (e) =>");
  assert.ok(flagAt > 0 && flagAt < listAt, "the flag helper must be in scope for list");
  assert.match(BACKUP_SRC, /\$\{flag\(e\)\}/);
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
