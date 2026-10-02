// ── Backups of the store (A65) — draft's policy, not a second one ───────────────────────────────
//
// The owner's note under WORKLOG A57: Resume Master holds accounts, a credit ledger and documents
// users asked to keep — "not crawled rows … unrecoverable. Port draft's policy; do not write a
// second one." So this file only POINTS @draft/sqlite-backup (vendored from draft/packages/
// sqlite-backup, checksummed) at the store and schedules it; every rule — checkpoint before copy,
// budget from the volume, refuse before the copy, label-protected retention — is draft's code.
//
// ⛔ NEVER AT BOOT. draft once took a full copy on every import, and 27 of its 30 "backups" were
// restarts. One copy a day at 02:00 UTC (draft's own time), plus admin-requested ones.
import path from "node:path";
import {
  configureBackups, createBackup, listBackups, verifyBackups, restoreBackup, BackupRefused,
} from "../../vendor/sqlite-backup/src/index.js";

export { listBackups, verifyBackups, restoreBackup, createBackup, BackupRefused };

/** Point the policy at the store's file. Backups go to <volume>/backups beside it. */
export function configureStoreBackups(dbPath) {
  return configureBackups({ dataDir: path.dirname(path.resolve(dbPath)), dbFile: path.basename(dbPath), filePrefix: "resume-master" });
}

/** ms from `now` until the next 02:00 UTC. */
export function msUntilNextRun(now = new Date(), hourUtc = 2) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

/** One backup, its outcome logged as a line with no content in it. Never throws. */
export function runBackup(label, log = console) {
  try {
    const r = createBackup(label);
    log.log(JSON.stringify({ t: new Date().toISOString(), backup: label, ok: !!r, file: r?.filename ?? null }));
    return r;
  } catch (e) {
    // A refusal is the policy working (the volume has no room): loud, never a crash.
    log.error(JSON.stringify({ t: new Date().toISOString(), backup: label, ok: false,
      refused: e instanceof BackupRefused, error: e.message }));
    return null;
  }
}

/** Daily at 02:00 UTC. Timers are unref'd so they never hold the process open. */
export function scheduleDailyBackups(log = console) {
  const tick = () => {
    runBackup("auto-daily", log);
    const t = setTimeout(tick, msUntilNextRun());
    t.unref?.();
  };
  const first = setTimeout(tick, msUntilNextRun());
  first.unref?.();
}
