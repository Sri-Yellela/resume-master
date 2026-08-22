// scripts/backup.js
// Run directly:  node scripts/backup.js [list|verify|restore <filename>]
// Or via npm:    npm run backup / npm run restore
//
// A BACKUP IS CHECKPOINTED BEFORE IT IS COPIED — see checkpointWal, and read that comment before
// changing the copy. Without it a running server leaves committed data in the WAL and the copy is a
// valid but STALE database.
//
// RETENTION IS SIZE-AWARE, not just count-capped, and the reason is worth stating: this directory
// reached 442 MB across 30 backups. `manifest.slice(0, 30)` was written when the DB was 1.3 MB, so
// thirty copies cost 40 MB. Migration 082's LCA tables took the DB to 116 MB, and the same rule
// then cost 3.5 GB — the policy did not change, the multiplier did. A byte budget is the backstop
// that a count cannot provide, because a count cannot know how big a row got.
//
// See selectRetained() for the rules. They protect the newest backup and the newest of each LABEL
// before spending the budget on depth, so a tight budget loses HISTORY rather than losing the
// distinct kinds of restore point.
import Database from "better-sqlite3";
import fs       from "fs";
import path     from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH   = path.join(__dirname, "..", "data", "resume_master.db");
const BAK_DIR   = path.join(__dirname, "..", "data", "backups");
const MANIFEST  = path.join(BAK_DIR, "manifest.json");

const envInt = (name, dflt) => {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

// Budget, overridable per deploy. 512 MB holds the current 116 MB DB plus a few generations; a
// bigger DB keeps fewer copies rather than silently using more disk, which is the whole point.
const MAX_BYTES = envInt("BACKUP_MAX_BYTES", 512 * 1024 * 1024);
const MAX_COUNT = envInt("BACKUP_MAX_COUNT", 30);
// One backup is not a backup — if it is corrupt there is nothing behind it. The floor overrides the
// byte budget on purpose, so a DB that grows past the budget on its own degrades to "few copies"
// instead of "no history".
const MIN_KEEP  = envInt("BACKUP_MIN_KEEP", 3);

fs.mkdirSync(BAK_DIR, { recursive: true });

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); }
  catch { return []; }
}

function saveManifest(entries) {
  fs.writeFileSync(MANIFEST, JSON.stringify(entries, null, 2));
}

/**
 * Decides which manifest entries survive. PURE — no filesystem, no dates, so it is testable and so
 * "why was this deleted?" has an answer that does not depend on the disk.
 *
 * Priority, highest first:
 *   1. the newest entry, unconditionally. Pruning the only copy of the current state to satisfy a
 *      budget would be the single worst thing this function could do.
 *   2. the newest entry of each distinct LABEL. Without this a burst of manual backups evicts every
 *      auto-daily and every pre-restore snapshot, so the directory ends up holding five copies of
 *      one afternoon and no coarse history. Bounded by the number of labels, which is 3-4.
 *   3. everything else, newest first, until either cap binds.
 *
 * MIN_KEEP is a floor applied after the caps, because the alternative — obeying a byte budget
 * smaller than one backup — leaves zero backups.
 *
 * @param {{filename:string,label:string,size:number}[]} entries newest-first, as the manifest stores them
 * @returns {{keep:object[], drop:object[], keptBytes:number}} `keep` in the input's order
 */
export function selectRetained(entries, opts = {}) {
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const maxCount = opts.maxCount ?? MAX_COUNT;
  const minKeep  = opts.minKeep  ?? MIN_KEEP;
  if (!entries.length) return { keep: [], drop: [], keptBytes: 0 };

  const sizeOf = (e) => (Number.isFinite(e.size) ? e.size : 0);
  const priority = [];
  const seen = new Set();
  const push = (e) => { if (e && !seen.has(e.filename)) { seen.add(e.filename); priority.push(e); } };

  push(entries[0]);
  for (const label of new Set(entries.map(e => e.label))) {
    push(entries.find(e => e.label === label));
  }
  for (const e of entries) push(e);

  const kept = new Set();
  let bytes = 0;
  for (const e of priority) {
    const withinCount = kept.size < maxCount;
    const withinBytes = bytes + sizeOf(e) <= maxBytes;
    const belowFloor  = kept.size < minKeep;
    // The floor ignores the byte budget but never the count cap — a maxCount of 1 must mean 1.
    if (withinCount && (withinBytes || belowFloor)) { kept.add(e.filename); bytes += sizeOf(e); }
  }

  return {
    keep: entries.filter(e => kept.has(e.filename)),
    drop: entries.filter(e => !kept.has(e.filename)),
    keptBytes: bytes,
  };
}

/** Deletes a backup and the -shm/-wal sidecars SQLite may have left beside it. */
function removeBackupFile(filename) {
  const p = path.join(BAK_DIR, filename);
  try { fs.unlinkSync(p); } catch {}
  for (const side of ["-shm", "-wal"]) { try { fs.unlinkSync(p + side); } catch {} }
}

/** Sidecars whose .db is already gone. They are invisible in `list` and outlive everything else. */
function sweepOrphanSidecars() {
  let removed = 0;
  for (const f of fs.readdirSync(BAK_DIR)) {
    const m = /^(.*\.db)-(shm|wal)$/.exec(f);
    if (m && !fs.existsSync(path.join(BAK_DIR, m[1]))) {
      try { fs.unlinkSync(path.join(BAK_DIR, f)); removed++; } catch {}
    }
  }
  return removed;
}

const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;

/**
 * Folds the write-ahead log into the main database file, so that copying that ONE file yields a
 * complete backup.
 *
 * WITHOUT THIS, EVERY BACKUP TAKEN WHILE THE SERVER RUNS CAN BE SILENTLY STALE. The database is in
 * WAL mode, so committed transactions live in `resume_master.db-wal` until something checkpoints
 * them; `fs.copyFileSync(DB_PATH, dest)` copies only the main file and leaves them behind. Measured
 * on this repo: two backups taken nine hours apart, and the live DB, all had the SAME md5 — the main
 * file had not changed at all while a 42 MB WAL accumulated. Opening one of those backups showed
 * Stripe with `periods_with_filings = 18` against the live DB's 21. The backup was three hours
 * behind and restored perfectly cleanly, which is the dangerous kind of wrong.
 *
 * TRUNCATE rather than PASSIVE or FULL: PASSIVE is the automatic behaviour that had already failed
 * to keep up, and FULL merges the WAL without resetting the file, so the next copy would face the
 * same race. TRUNCATE merges AND zeroes the log, which is the only outcome that makes "the main file
 * is the whole database" true at the moment of the copy.
 *
 * This WRITES to the live database, which is why it is worth being explicit about: it is the same
 * write SQLite performs on its own during normal operation, and a second writer is legal in WAL
 * mode, so it does not disturb the server's connection. It can still report `busy` if another
 * connection is mid-read — so the result is returned rather than assumed, and the caller falls back
 * to copying the sidecar instead of shipping a backup it cannot vouch for.
 */
function checkpointWal() {
  let db = null;
  try {
    db = new Database(DB_PATH);
    const [row = {}] = db.pragma("wal_checkpoint(TRUNCATE)", { simple: false });
    // busy = 1 means the log could not be fully reclaimed, so the copy may still miss pages.
    return { ok: row.busy === 0, busy: row.busy, log: row.log, checkpointed: row.checkpointed };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { db?.close(); } catch {}
  }
}

export function createBackup(label = "manual") {
  if (!fs.existsSync(DB_PATH)) {
    console.warn("[backup] No DB found at", DB_PATH);
    return null;
  }
  const ts       = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `resume_master_${ts}_${label}.db`;
  const dest     = path.join(BAK_DIR, filename);

  // Merge the WAL first — see checkpointWal. The copy is only a complete database afterwards.
  const cp = checkpointWal();

  // fs.copyFileSync is safe, synchronous, and works regardless of connection state.
  // db.backup() is NOT used here: it is SQLite's online-backup API and would be defensible, but a
  // checkpoint plus a file copy keeps the restore path a single plain file, which is what makes
  // `restore` auditable by hand.
  fs.copyFileSync(DB_PATH, dest);

  // Fallback for the case the checkpoint could not fully drain. A two-file backup is inelegant; a
  // backup missing the last few hours is worse, and restoreBackup puts the sidecar back.
  let walCopied = false;
  if (!cp.ok && fs.existsSync(`${DB_PATH}-wal`)) {
    fs.copyFileSync(`${DB_PATH}-wal`, `${dest}-wal`);
    walCopied = true;
  }
  if (!cp.ok) {
    console.warn(`[backup] WAL checkpoint incomplete (${cp.error ?? `busy=${cp.busy}`})` +
                 `${walCopied ? " — copied the -wal sidecar alongside" : " — BACKUP MAY BE STALE"}`);
  }

  const size = fs.statSync(dest).size + (walCopied ? fs.statSync(`${dest}-wal`).size : 0);
  console.log(`[backup] Saved: ${dest} (${mb(size)})`);

  const manifest = loadManifest();
  manifest.unshift({
    filename, label,
    created: new Date().toISOString(),
    // Sidecar included, so the retention budget accounts for what this backup actually costs.
    size,
    // Recorded, not assumed. A backup whose WAL could not be drained AND could not be copied is one
    // a future reader has to be able to distrust.
    walCheckpointed: cp.ok,
    ...(walCopied ? { walSidecar: true } : {}),
  });

  const { keep, drop, keptBytes } = selectRetained(manifest);
  for (const e of drop) removeBackupFile(e.filename);
  sweepOrphanSidecars();
  saveManifest(keep);
  if (drop.length) {
    const freed = drop.reduce((n, e) => n + (e.size || 0), 0);
    console.log(`[backup] Pruned ${drop.length} older backup(s), freed ${mb(freed)}; ` +
                `retaining ${keep.length} (${mb(keptBytes)} of ${mb(MAX_BYTES)} budget)`);
  }
  return { filename, path: dest, created: new Date().toISOString() };
}

export function listBackups() {
  return loadManifest();
}

/**
 * Re-reads every backup on disk and records what is checkable NOW. Repeatable, not a one-off
 * backfill script, because the question it answers ("is this file still readable?") goes stale.
 *
 * WHAT IT CAN ESTABLISH: that the file is a valid, self-consistent database (integrity_check) and
 * which schema era it belongs to (its last applied migration — the thing you actually want to know
 * when choosing what to restore).
 *
 * WHAT IT CANNOT: whether a backup taken before checkpointing existed was missing WAL data at the
 * moment it was copied. That information is gone, and `integrity_check = ok` does NOT recover it —
 * a database copied mid-WAL is perfectly valid, just older. This is exactly how the stale backup
 * that started all this passed every check while being three hours behind.
 *
 * So `walCheckpointed` is backfilled as FALSE rather than left absent, and that is a literal
 * statement about the PROCESS: no checkpoint was performed for those copies. It deliberately does
 * NOT distinguish "not attempted" from "attempted and reported busy", because the consequence for a
 * reader is identical — this copy may be missing whatever was in the WAL — and a boolean that is
 * present on every entry is one a caller can rely on. `walNote` keeps the distinction for anyone who
 * needs it, so nothing is asserted that was not measured.
 */
export function verifyBackups() {
  const verified = loadManifest().map(e => {
    const entry = { ...e };
    const p = path.join(BAK_DIR, e.filename);
    if (!fs.existsSync(p)) {
      entry.integrity = "missing";
      return entry;
    }
    // Opening a WAL database creates -wal and -shm beside it EVEN READ-ONLY. Verifying five backups
    // silently produced ten files the first time this was run by hand, and a sidecar next to an
    // existing .db is invisible to sweepOrphanSidecars. Record what was there first, so this check
    // removes only what it created and never a backup's own carried WAL.
    const pre = { wal: fs.existsSync(`${p}-wal`), shm: fs.existsSync(`${p}-shm`) };
    let db = null;
    try {
      db = new Database(p, { readonly: true });
      entry.integrity = db.pragma("integrity_check", { simple: true });
      try {
        entry.schema = db.prepare(
          "SELECT id FROM schema_migrations ORDER BY rowid DESC LIMIT 1").get()?.id ?? null;
      } catch { entry.schema = null; } // predates schema_migrations
    } catch (err) {
      entry.integrity = `unreadable: ${err.message}`;
    } finally {
      try { db?.close(); } catch {}
    }
    if (!pre.wal) { try { fs.unlinkSync(`${p}-wal`); } catch {} }
    if (!pre.shm) { try { fs.unlinkSync(`${p}-shm`); } catch {} }

    if (entry.walCheckpointed === undefined) {
      entry.walCheckpointed = false;
      entry.walNote = "no checkpoint was performed for this copy (predates the checkpoint step) — " +
                      "it may be missing data that was in the WAL when it was taken";
    }
    entry.verifiedAt = new Date().toISOString();
    return entry;
  });
  saveManifest(verified);
  return verified;
}

export function restoreBackup(filename) {
  const src = path.join(BAK_DIR, filename);
  if (!fs.existsSync(src)) throw new Error(`Backup not found: ${filename}`);

  // Safety: back up current DB before restoring.
  if (fs.existsSync(DB_PATH)) {
    const safeTs   = new Date().toISOString().replace(/[:.]/g,"-");
    const safeName = `resume_master_${safeTs}_pre-restore.db`;
    const safePath = path.join(BAK_DIR, safeName);
    fs.copyFileSync(DB_PATH, safePath);
    // RECORDED IN THE MANIFEST, which it was not before. An untracked file is never pruned and never
    // listed, so pre-restore snapshots accumulated forever and invisibly — and the one file you most
    // want to find after a mistaken restore was the one `list` would not show you. Its own label
    // means selectRetained's rule 2 protects the newest of them.
    const manifest = loadManifest();
    manifest.unshift({
      filename: safeName, label: "pre-restore",
      created: new Date().toISOString(),
      size: fs.statSync(safePath).size,
    });
    const { keep, drop } = selectRetained(manifest);
    for (const e of drop) removeBackupFile(e.filename);
    saveManifest(keep);
    console.log(`[restore] Current DB backed up as ${safeName} before restore`);
  }

  fs.copyFileSync(src, DB_PATH);

  // THE LIVE SIDECARS MUST GO, and this is not housekeeping. Copying the main file while
  // `resume_master.db-wal` still holds the PREVIOUS database's committed pages leaves SQLite to
  // reconcile a restored file with a log that belongs to something else. It usually detects the
  // mismatch and discards the log — but "usually" is the wrong standard for the one operation whose
  // entire job is to put the database into a known state. Removing them makes the restored file the
  // whole truth, which is the same property checkpointWal() buys on the way in.
  for (const side of ["-wal", "-shm"]) {
    try { fs.unlinkSync(`${DB_PATH}${side}`); } catch {}
  }
  // ...unless the backup carried its own WAL because its checkpoint could not drain. Then that log
  // is part of the backup and belongs beside the file it came from.
  if (fs.existsSync(`${src}-wal`)) {
    fs.copyFileSync(`${src}-wal`, `${DB_PATH}-wal`);
    console.log(`[restore] Restored the backup's -wal sidecar alongside it`);
  }

  console.log(`[restore] ✓ Restored from ${filename}`);
  return { ok: true, restored: filename };
}

// ── Run as script ──────────────────────────────────────────────
// GUARDED BY AN ENTRY-POINT CHECK, and this is a bug fix rather than tidying. This block used to run
// on IMPORT: server.js imports createBackup for its auto-daily job, so every server boot fell
// through to the `else` branch and wrote a full copy of the DB. That is where 27 of the 30 backups
// in this directory came from — they are restarts, not backups, and at 116 MB each they were the
// entire 442 MB. A module with a side effect at import time cannot be imported safely.
const isEntryPoint = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isEntryPoint) {
  const args = process.argv.slice(2);
  // The checkpoint state is shown, not buried in the manifest: a backup that may be missing WAL data
  // restores just as cleanly as a complete one, so the only place a reader can be warned is here.
  const flag = (e) => e.walCheckpointed === true ? "complete"
    : e.walCheckpointed === false ? "UNVERIFIED-WAL" : "unknown-wal";
  if (args[0] === "list") {
    const entries = listBackups();
    if (!entries.length) { console.log("No backups found."); }
    else entries.forEach((e, i) => console.log(
      `${i+1}. ${e.filename}  (${e.label})  ${e.created}  ${mb(e.size || 0)}  ` +
      `${flag(e)}${e.integrity && e.integrity !== "ok" ? `  integrity=${e.integrity}` : ""}` +
      `${e.schema ? `  schema=${e.schema}` : ""}`));
  } else if (args[0] === "verify") {
    const entries = verifyBackups();
    entries.forEach((e, i) => console.log(
      `${i+1}. ${e.filename}  integrity=${e.integrity}  ${flag(e)}` +
      `${e.schema ? `  schema=${e.schema}` : ""}`));
    console.log(`[verify] ${entries.length} backup(s) checked; manifest updated`);
  } else if (args[0] === "restore") {
    if (!args[1]) { console.error("Usage: node scripts/backup.js restore <filename>"); process.exit(1); }
    restoreBackup(args[1]);
  } else {
    createBackup(args[0] || "manual");
  }
}
