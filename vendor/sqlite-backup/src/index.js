// @draft/sqlite-backup — the backup policy draft runs, as a package (A65, 2026-10-02).
//
// MOVED, NOT REWRITTEN. This is draft's scripts/backup.js with its paths made configurable, so that
// the résumé tools service (repo resume-master) — which since A57 holds accounts, a credit ledger
// and documents users asked to keep — runs the SAME policy rather than a second one (owner's note under WORKLOG A57: "Port draft's policy;
// do not write a second one"). Every rule below was learned on draft's production volume. draft
// consumes this from packages/sqlite-backup; the tools service vendors a checksummed copy, exactly as it
// vendors @draft/ats-scorer. Call configureBackups() once before anything else.
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

// WHERE: set by configureBackups(). draft points it at its data/ (or BACKUP_DATA_DIR, which exists
// for the tests — one run against the real data/ with a faked disk once deleted two local backups
// for good); the tools service points it at its volume.
let DATA_DIR = null;
let DB_PATH = null;
let BAK_DIR = null;
let MANIFEST = null;
let FILE_PREFIX = "resume_master";

/**
 * Point the policy at one database. The backups live in <dataDir>/backups beside it, with a manifest.
 * @param {{dataDir:string, dbFile?:string, filePrefix?:string}} o  filePrefix names the copies:
 *        <prefix>_<timestamp>_<label>.db
 */
export function configureBackups({ dataDir, dbFile = "resume_master.db", filePrefix = "resume_master" }) {
  if (!dataDir) throw new Error("configureBackups needs a dataDir");
  DATA_DIR = dataDir;
  DB_PATH = path.join(DATA_DIR, dbFile);
  BAK_DIR = path.join(DATA_DIR, "backups");
  MANIFEST = path.join(BAK_DIR, "manifest.json");
  FILE_PREFIX = filePrefix;
  fs.mkdirSync(BAK_DIR, { recursive: true });
  return { dataDir: DATA_DIR, dbPath: DB_PATH, backupDir: BAK_DIR };
}

function requireConfigured() {
  if (!BAK_DIR) throw new Error("@draft/sqlite-backup: call configureBackups({ dataDir }) first");
}

const envInt = (name, dflt) => {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

// THE BUDGET IS DERIVED FROM THE VOLUME, not a constant. It used to be a flat 512 MB — larger than
// the whole 500 MB production volume it lived on — and on 2026-09-29 the 02:00 backup died with
// ENOSPC at 481/500 MB. A constant cannot know what disk it is on; statfs can. BACKUP_MAX_BYTES
// still exists, but it can only LOWER the derived budget, never raise it past the disk.
const MAX_BYTES_ENV = envInt("BACKUP_MAX_BYTES", Infinity);
// The share of the volume backups may occupy. The rest is the live database, its WAL, and growth.
const DISK_SHARE = (() => {
  const f = parseFloat(process.env.BACKUP_DISK_SHARE ?? "");
  return f > 0 && f < 1 ? f : 0.4;
})();
const MAX_COUNT = envInt("BACKUP_MAX_COUNT", 30);
// One backup is not a backup — if it is corrupt there is nothing behind it. The floor overrides the
// byte BUDGET on purpose, so a DB that grows past the budget degrades to "few copies" instead of "no
// history". It does NOT override the disk: see the ceiling in backupLimits.
const MIN_KEEP  = envInt("BACKUP_MIN_KEEP", 3);

/**
 * The two limits a backup must respect, from the volume's own numbers. PURE, so it is testable.
 *
 *   budget  — the policy: DISK_SHARE of the volume, lowered by BACKUP_MAX_BYTES if set. MIN_KEEP
 *             may exceed it.
 *   ceiling — the physics: what backups can occupy without eating the reserve kept free for the
 *             live database. Nothing may exceed it — not MIN_KEEP, not even the newest backup.
 *             Existing backups count as reclaimable, because pruning them is how room is made.
 *
 * @param {{total:number, free:number}} disk  bytes, from statfs
 * @param {number} backupBytes  bytes the manifest's backups occupy now
 */
export function backupLimits(disk, backupBytes, opts = {}) {
  const share   = opts.share ?? DISK_SHARE;
  const envMax  = opts.maxBytes ?? MAX_BYTES_ENV;
  const reserve = Math.max(64 * 1024 * 1024, Math.floor(disk.total * 0.05));
  const budget  = Math.min(envMax, Math.floor(disk.total * share));
  const ceiling = Math.max(0, backupBytes + disk.free - reserve);
  return { budget, ceiling, reserve };
}

function readDisk(dir) {
  const s = fs.statfsSync(dir);
  return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
}

const fileSize = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

/** Thrown, not logged: both callers (the 02:00 cron and the admin route) surface a throw. */
export class BackupRefused extends Error {
  constructor(msg) { super(`BACKUP REFUSED — ${msg}`); this.name = "BackupRefused"; }
}

function loadManifest() {
  requireConfigured();
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
 * `ceiling` is the DISK, and it binds everything, rule 1 included: a backup that does not fit is not
 * kept, and createBackup refuses before copying rather than dying mid-copy with ENOSPC. The old
 * floor overrode the budget with nothing above it, which is how 3 × a large DB outgrew the volume.
 *
 * @param {{filename:string,label:string,size:number}[]} entries newest-first, as the manifest stores them
 * @returns {{keep:object[], drop:object[], keptBytes:number}} `keep` in the input's order
 */
export function selectRetained(entries, opts = {}) {
  const maxBytes = opts.maxBytes ?? MAX_BYTES_ENV;
  const ceiling  = opts.ceiling  ?? Infinity;
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
  // The protected head: the newest, and the newest of each label. Everything after it is the plain
  // history, which must be kept as a CONTIGUOUS newest run — see `stopped` below.
  const head = priority.length;
  for (const e of entries) push(e);

  const kept = new Set();
  let bytes = 0;
  // ⛔ STOP AT THE FIRST MISFIT; NEVER SKIP OVER IT. This loop used to `continue` past a backup that
  // did not fit and keep going, so a large RECENT backup was dropped while smaller OLDER ones behind
  // it were kept — a knapsack, not a retention policy. Production, 09-30: the database had grown from
  // 14 MB to 28 MB+, every backup from 09-17 to 09-29 was gone, and 08-22..09-16 survived — the
  // newest restorable state before the latest one was two weeks old. Uniform-size tests never saw it.
  let stopped = false;
  for (const [i, e] of priority.entries()) {
    if (i >= head && stopped) continue;
    const withinCount = kept.size < maxCount;
    const withinBytes = bytes + sizeOf(e) <= maxBytes;
    const withinDisk  = bytes + sizeOf(e) <= ceiling;
    const belowFloor  = kept.size < minKeep;
    // The floor ignores the byte budget but never the count cap — a maxCount of 1 must mean 1 — and
    // never the disk. The newest is exempt from the budget (it is always first, so bytes is 0 and
    // only an over-budget newest fails withinBytes) but not from the disk.
    const first = kept.size === 0;
    if (withinCount && withinDisk && (withinBytes || belowFloor || first)) {
      kept.add(e.filename); bytes += sizeOf(e);
    } else if (i >= head) {
      stopped = true;
    }
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

export const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;

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

/**
 * Makes room for one new backup, or throws BackupRefused having deleted NOTHING.
 *
 * The order is the point. Copy-then-prune needed room for one backup more than the policy allowed —
 * the exact moment the disk ran out on 09-29. So pruning comes first; but a prune followed by a
 * refusal would destroy history and still fail, so the room is PROVEN before anything is deleted:
 * sizes are read from the files on disk, sidecars included, not trusted from the manifest. What is
 * dropped is only what the plan would drop after a successful copy anyway.
 */
function makeRoom(newEntry, onRefuse = "backup not taken") {
  let disk;
  try { disk = readDisk(BAK_DIR); }
  catch (e) { throw new BackupRefused(`cannot read free space on ${BAK_DIR} (${e.message}); ${onRefuse}`); }
  const onDisk = (e) => ["", "-wal", "-shm"].reduce((n, x) => n + fileSize(path.join(BAK_DIR, e.filename) + x), 0);
  const before = loadManifest().map(e => ({ ...e, size: onDisk(e) }));
  const held = before.reduce((n, e) => n + e.size, 0);
  const { budget, ceiling, reserve } = backupLimits(disk, held);
  const plan = selectRetained([newEntry, ...before], { maxBytes: budget, ceiling });
  const freed = plan.drop.reduce((n, e) => n + e.size, 0);
  const fits = plan.keep.some(e => e.filename === newEntry.filename) &&
    disk.free + freed - reserve >= newEntry.size;
  if (!fits) {
    const msg = `a ${mb(newEntry.size)} copy does not fit: ${mb(disk.free)} free of ${mb(disk.total)}, ` +
      `${mb(held)} in backups, ${mb(reserve)} reserved for the live database; ${onRefuse}`;
    console.error(`[backup] ${msg}`);
    throw new BackupRefused(msg);
  }
  for (const e of plan.drop) removeBackupFile(e.filename);
  sweepOrphanSidecars();
  if (plan.drop.length) console.log(`[backup] Pruned ${plan.drop.length} older backup(s) to make room, ` +
    `freeing ${mb(freed)}`);
  const kept = new Set(plan.keep.map(e => e.filename));
  saveManifest(loadManifest().filter(e => kept.has(e.filename)));
  return { budget, ceiling, disk };
}

export function createBackup(label = "manual") {
  requireConfigured();
  if (!fs.existsSync(DB_PATH)) {
    console.warn("[backup] No DB found at", DB_PATH);
    return null;
  }
  const ts       = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${FILE_PREFIX}_${ts}_${label}.db`;
  const dest     = path.join(BAK_DIR, filename);

  // Merge the WAL first — see checkpointWal. The copy is only a complete database afterwards.
  const cp = checkpointWal();

  // ROOM IS PROVEN, THEN MADE, BEFORE THE COPY — see makeRoom. Measured after the checkpoint, which
  // moves the WAL into the main file; a WAL that could not drain is copied too, so it is counted.
  const need = fileSize(DB_PATH) + (cp.ok ? 0 : fileSize(`${DB_PATH}-wal`));
  const { budget, ceiling, disk } = makeRoom({ filename, label, size: need });

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

  // Re-run against the real size — normally a no-op, since the plan above already made room.
  const { keep, drop, keptBytes } = selectRetained(manifest, { maxBytes: budget, ceiling });
  for (const e of drop) removeBackupFile(e.filename);
  sweepOrphanSidecars();
  saveManifest(keep);
  console.log(`[backup] Retaining ${keep.length} (${mb(keptBytes)} of ${mb(budget)} budget, ` +
              `${mb(disk.total)} volume)${drop.length ? `; pruned ${drop.length} more after the copy` : ""}`);
  return { filename, path: dest, created: new Date().toISOString() };
}

export function listBackups() {
  requireConfigured();
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
  requireConfigured();
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
  requireConfigured();
  const src = path.join(BAK_DIR, filename);
  if (!fs.existsSync(src)) throw new Error(`Backup not found: ${filename}`);

  // Safety: back up current DB before restoring.
  if (fs.existsSync(DB_PATH)) {
    const safeTs   = new Date().toISOString().replace(/[:.]/g,"-");
    const safeName = `${FILE_PREFIX}_${safeTs}_pre-restore.db`;
    const safePath = path.join(BAK_DIR, safeName);
    // A58 (c): CHECKPOINTED FIRST, as createBackup is — see checkpointWal. Without it the safety copy
    // was the main file only, so committed pages still in the WAL were in NEITHER the safety copy nor
    // the restored file, and the unlink below then deleted the WAL: the one copy of them.
    const cp = checkpointWal();
    // Same disk rule as createBackup. A restore with no safety copy would overwrite the only copy of
    // the current state, so no room means no restore — never "restore anyway".
    const { budget, ceiling } = makeRoom(
      { filename: safeName, label: "pre-restore", size: fileSize(DB_PATH) + (cp.ok ? 0 : fileSize(`${DB_PATH}-wal`)) },
      "restore not attempted");
    fs.copyFileSync(DB_PATH, safePath);
    // A log that could not drain travels with the safety copy, exactly as createBackup carries it.
    let walCopied = false;
    if (!cp.ok && fs.existsSync(`${DB_PATH}-wal`)) {
      fs.copyFileSync(`${DB_PATH}-wal`, `${safePath}-wal`);
      walCopied = true;
    }
    if (!cp.ok) {
      console.warn(`[restore] WAL checkpoint incomplete before the safety copy (${cp.error ?? `busy=${cp.busy}`})` +
                   `${walCopied ? " — copied the -wal sidecar alongside" : ""}`);
    }
    // RECORDED IN THE MANIFEST, which it was not before. An untracked file is never pruned and never
    // listed, so pre-restore snapshots accumulated forever and invisibly — and the one file you most
    // want to find after a mistaken restore was the one `list` would not show you. Its own label
    // means selectRetained's rule 2 protects the newest of them.
    const manifest = loadManifest();
    manifest.unshift({
      filename: safeName, label: "pre-restore",
      created: new Date().toISOString(),
      size: fs.statSync(safePath).size + (walCopied ? fs.statSync(`${safePath}-wal`).size : 0),
      walCheckpointed: cp.ok,
      ...(walCopied ? { walSidecar: true } : {}),
    });
    const { keep, drop } = selectRetained(manifest, { maxBytes: budget, ceiling });
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
