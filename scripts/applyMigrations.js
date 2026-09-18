// ── APPLYING PENDING MIGRATIONS, ONE TRANSACTION EACH ───────────────────────────────────────────
//
// THE DEFECT THIS EXISTS TO FIX.
//
// Both runners — server.js at boot and scripts/migration.js by hand — did this:
//
//     db.exec(migration.sql);
//     db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(migration.id);
//
// `db.exec` runs a multi-statement string with no transaction around it, so each statement commits
// on its own. Two independent ways for that to leave a database nobody can boot:
//
//   1. A MIGRATION THAT FAILS PARTWAY APPLIES ITS EARLIER STATEMENTS AND KEEPS THEM. For 114 of
//      the 115 migrations that was survivable, because they only ADD things — a half-applied
//      `ALTER TABLE ADD COLUMN` pair leaves a column that the retry then collides with, which is
//      noisy but recoverable. Migration 108 is the first one in this project's history that
//      DESTROYS something: it rebuilds `ats_only_reports` as CREATE v2 / INSERT…SELECT / DROP /
//      RENAME to widen a UNIQUE constraint, which SQLite cannot do in place. A failure between the
//      DROP and the RENAME leaves the user's cached ATS reports sitting in a table called
//      `ats_only_reports_v2`, the real name gone, and the next boot re-runs the migration and dies
//      at `INSERT INTO ats_only_reports_v2 SELECT … FROM ats_only_reports` because the source no
//      longer exists. That is a boot loop, and the data is only recoverable by hand.
//
//   2. THE BOOKKEEPING ROW WAS OUTSIDE THE SAME UNIT AS THE WORK IT RECORDS. If the schema change
//      committed and the INSERT then failed, the migration would run AGAIN on the next boot —
//      against a schema it had already changed. "Applied" and "recorded as applied" have to be the
//      same event or the record is a guess.
//
// SQLite's DDL is transactional, so both go away by wrapping each migration — statements and
// bookkeeping row together — in one transaction. Verified rather than assumed: see
// test/migrationsAreTransactional.test.js, which fails a rebuild-shaped migration at its last
// statement and asserts the original table and every row survive.
//
// ⛔ WHY ONE TRANSACTION PER MIGRATION AND NOT ONE AROUND THE WHOLE LOOP. A batch would be
// all-or-nothing across unrelated changes, so migration 40 failing would roll back 39 good ones and
// every boot would repeat all of them. Per-migration means the database is always at a real
// migration boundary: everything before the failure is applied AND recorded, the failure applied
// nothing, and a fix plus a restart resumes from exactly there.
//
// ⛔ WHY THIS IS SHARED CODE WHEN THE TWO MIGRATION LISTS ARE DELIBERATELY NOT. The lists are
// duplicated on purpose (see the note in scripts/migration.js) and test/migrationListsAgree.test.js
// is what makes that survivable. The LOOP has no such excuse: it is one algorithm, it was copied,
// and the copy is why "wrap it in a transaction" was two edits rather than one. Each caller still
// owns its own logging and its own decision about what a failure means — the helper throws.

/**
 * Apply every migration in `migrations` that `schema_migrations` does not already record.
 *
 * Requires `schema_migrations` to exist; both callers create it before getting here, and creating
 * it in passing would hide which component owns the schema's own bookkeeping table.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {Array<{id: string, sql: string}>} migrations  in application order
 * @param {{ onSkip?: (m) => void, onApplied?: (m) => void }} [hooks]
 * @returns {number} how many were applied
 * @throws the SQLite error with `.migrationId` attached and the id prefixed onto the message —
 *         nothing from the failing migration is committed. The id is attached HERE because the
 *         transaction wrapper is what swallowed the per-migration `catch` both callers used to
 *         have, and "FAILED: no such column: foo" without the id is a worse message than the one
 *         this replaced.
 */
export function applyPendingMigrations(db, migrations, { onSkip, onApplied } = {}) {
  const applied = new Set(
    db.prepare("SELECT id FROM schema_migrations").all().map(r => r.id)
  );

  // The statements and the row that records them, as one unit. better-sqlite3 permits `exec`
  // inside a transaction function; what it does not permit is BEGIN/COMMIT inside the SQL, which
  // is why test/migrationsAreTransactional.test.js also asserts that no migration contains any.
  const applyOne = db.transaction((migration) => {
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(migration.id);
  });

  let count = 0;
  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      onSkip?.(migration);
      continue;
    }
    try {
      applyOne(migration);
    } catch (e) {
      e.migrationId = migration.id;
      e.message = `${migration.id}: ${e.message}`;
      throw e;
    }
    onApplied?.(migration);
    count++;
  }
  return count;
}
