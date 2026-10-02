# @draft/sqlite-backup

The backup policy draft runs on its production volume, moved out of `draft/scripts/backup.js`
unchanged (A65, 2026-10-02) so that the résumé tools service (repo resume-master) runs the same one rather than a second.

- **Checkpoint before copy** (`wal_checkpoint(TRUNCATE)`), so the copy is the whole database.
- **The budget comes from the volume** (`statfs`): `BACKUP_DISK_SHARE` (0.4) of it, lowered — never
  raised — by `BACKUP_MAX_BYTES`; a 5 % / 64 MB reserve stays free for the live database.
- **Room is proven, then made, before the copy** — a backup that will not fit is refused
  (`BackupRefused`) having deleted nothing.
- **Retention** (`selectRetained`): the newest, the newest of each label, then a contiguous newest
  run; `BACKUP_MAX_COUNT` (30), `BACKUP_MIN_KEEP` (3).
- **Restore** takes a checkpointed, recorded `pre-restore` copy first, and clears stale sidecars.

```js
import { configureBackups, createBackup, listBackups, verifyBackups, restoreBackup } from "@draft/sqlite-backup";
configureBackups({ dataDir: "/app/data", dbFile: "app.db", filePrefix: "app" });
createBackup("auto-daily");
```

`verifyBackups` reads the newest id from a `schema_migrations` table when the database has one.

Distribution: the source of truth is `draft/packages/sqlite-backup`; another repository vendors a
byte-for-byte copy and its own suite re-hashes it against `CHECKSUMS.json` (LF-normalised). Change
it here, run `npm run checksums`, copy the directory across.
