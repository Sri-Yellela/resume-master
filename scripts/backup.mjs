// Backups of the store, by hand (A65) — draft's policy (vendor/sqlite-backup), pointed at this store.
//
//   node scripts/backup.mjs list
//   node scripts/backup.mjs verify
//   node scripts/backup.mjs create [label]
//   node scripts/backup.mjs restore <filename>     ⚠ STOP THE SERVICE FIRST
//
// The store is found exactly as server.js finds it: RM_DB_PATH, else the Railway volume. A restore
// takes a pre-restore safety copy of the current database before it overwrites anything.
import { resolveStorePath } from "../src/store/db.js";
import { configureStoreBackups, listBackups, verifyBackups, restoreBackup, createBackup } from "../src/store/backups.js";

const storePath = resolveStorePath(process.env);
if (!storePath) {
  console.error("No store: set RM_DB_PATH, or run where RAILWAY_VOLUME_MOUNT_PATH is set.");
  process.exit(2);
}
configureStoreBackups(storePath);

const [cmd = "list", arg] = process.argv.slice(2);
if (cmd === "list") {
  for (const e of listBackups()) console.log(`${e.created}  ${e.label.padEnd(12)}  ${(e.size / 1048576).toFixed(1)} MB  ${e.filename}`);
} else if (cmd === "verify") {
  const all = verifyBackups();
  for (const e of all) console.log(`${e.integrity === "ok" ? "ok " : "BAD"}  ${e.filename}  schema=${e.schema ?? "?"}  ${e.integrity}`);
  process.exit(all.every(e => e.integrity === "ok") ? 0 : 1);
} else if (cmd === "create") {
  const r = createBackup(arg || "manual");
  if (!r) process.exit(1);
} else if (cmd === "restore") {
  if (!arg) { console.error("restore needs a filename — see `list`."); process.exit(2); }
  restoreBackup(arg);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
