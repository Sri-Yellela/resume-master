// A MIGRATION THAT FAILS PARTWAY USED TO KEEP WHAT IT HAD ALREADY DONE.
//
// Both runners called `db.exec(migration.sql)` bare. `exec` runs a multi-statement string with no
// transaction, so every statement commits on its own, and the row recording the migration was a
// SEPARATE statement after it. Two failure shapes:
//
//   1. Half a migration applied and kept. Survivable for 114 of the 115 migrations, which only ADD
//      things. Not survivable from 108, the first one in this project that DESTROYS anything: it
//      rebuilds `ats_only_reports` (CREATE v2 / INSERT…SELECT / DROP / RENAME) because SQLite
//      cannot widen a UNIQUE constraint in place. Failing between the DROP and the RENAME leaves
//      the cached ATS reports in a table named `ats_only_reports_v2`, the real name gone, and the
//      next boot dies reading a source table that no longer exists. A boot loop.
//
//   2. The schema change committing while the bookkeeping INSERT failed — so the migration runs
//      AGAIN next boot against a schema it already changed. "Applied" and "recorded as applied"
//      have to be one event.
//
// ⛔ THESE TESTS ARE BEHAVIOURAL, AND THAT IS THE POINT. A source scan for the word "transaction"
// would have passed against a wrapper that committed the DDL anyway — SQLite's DDL being
// transactional is the load-bearing fact, and it is a property of SQLite, not of our code. So the
// rebuild is actually failed at its last statement and the surviving rows are counted.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../scripts/migrations.js";
import { applyPendingMigrations } from "../scripts/applyMigrations.js";

/** A database with the bookkeeping table both runners create before they get here. */
function bare() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
             id TEXT PRIMARY KEY,
             applied_at INTEGER NOT NULL DEFAULT (unixepoch())
           );`);
  return db;
}

const recorded = (db) =>
  db.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all().map(r => r.id);
const exists = (db, name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);

test("a migration that fails partway commits NOTHING, and is not recorded", () => {
  const db = bare();
  try {
    const migrations = [
      { id: "001_good", sql: "CREATE TABLE kept (a);" },
      {
        id: "002_breaks_late",
        // Three statements that succeed, then one that cannot. Before the transaction, `also_kept`
        // and the DROP both survived.
        sql: `CREATE TABLE also_kept (b);
              DROP TABLE kept;
              SELECT this_column_does_not_exist;`,
      },
    ];

    assert.throws(() => applyPendingMigrations(db, migrations), /this_column_does_not_exist/);

    assert.equal(exists(db, "kept"), true, "the DROP inside the failed migration was rolled back");
    assert.equal(exists(db, "also_kept"), false, "so was the CREATE that preceded it");
    assert.deepEqual(recorded(db), ["001_good"],
      "the good migration stays applied AND recorded; the failed one is neither");
  } finally { db.close(); }
});

test("the error names the migration that failed", () => {
  // The transaction wrapper replaced the per-migration `catch` both runners used to have, which is
  // where the id came from. Without this the boot log says only "FAILED: no such column: x".
  const db = bare();
  try {
    let caught = null;
    try {
      applyPendingMigrations(db, [{ id: "042_bad", sql: "SELECT nope;" }]);
    } catch (e) { caught = e; }
    assert.ok(caught, "it must throw rather than swallow");
    assert.equal(caught.migrationId, "042_bad");
    assert.match(caught.message, /^042_bad: /);
  } finally { db.close(); }
});

test("⛔ the 108 SHAPE: a table rebuild that fails at the RENAME keeps the table and every row", () => {
  // The specific sequence migration 108 runs, failed at its last statement. This is the case that
  // turned the missing transaction from untidy into data-losing.
  const db = bare();
  try {
    db.exec(`CREATE TABLE reports (id INTEGER PRIMARY KEY, user_id INTEGER, job_id TEXT,
                                   UNIQUE(user_id, job_id));`);
    const ins = db.prepare("INSERT INTO reports (user_id, job_id) VALUES (?, ?)");
    for (let i = 0; i < 25; i++) ins.run(i, `job${i}`);

    const rebuild = {
      id: "999_rebuild_fails_at_the_end",
      sql: `CREATE TABLE reports_v2 (id INTEGER PRIMARY KEY, user_id INTEGER,
                                     domain_profile_id INTEGER, job_id TEXT,
                                     UNIQUE(user_id, domain_profile_id, job_id));
            INSERT INTO reports_v2 (user_id, domain_profile_id, job_id)
              SELECT user_id, NULL, job_id FROM reports;
            DROP TABLE reports;
            ALTER TABLE reports_v2 RENAME TO reports;
            CREATE INDEX idx ON reports(nonexistent_column);`,
    };

    assert.throws(() => applyPendingMigrations(db, [rebuild]), /nonexistent_column/);

    assert.equal(exists(db, "reports"), true, "the original table is back");
    assert.equal(exists(db, "reports_v2"), false, "and the half-built replacement is gone");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM reports").get().n, 25, "with every row");
    // And the old UNIQUE is still the old one — a rolled-back rebuild must not leave the new key.
    assert.throws(() => ins.run(0, "job0"), /UNIQUE/);
    assert.deepEqual(recorded(db), []);
  } finally { db.close(); }
});

test("the same rebuild SUCCEEDS end to end when nothing is wrong with it", () => {
  // The rollback tests above would all pass against a runner that rolled everything back always.
  const db = bare();
  try {
    db.exec("CREATE TABLE reports (id INTEGER PRIMARY KEY, user_id INTEGER, job_id TEXT);");
    db.prepare("INSERT INTO reports (user_id, job_id) VALUES (1,'j')").run();
    const n = applyPendingMigrations(db, [{
      id: "999_rebuild_ok",
      sql: `CREATE TABLE reports_v2 (id INTEGER PRIMARY KEY, user_id INTEGER,
                                     domain_profile_id INTEGER, job_id TEXT);
            INSERT INTO reports_v2 (user_id, domain_profile_id, job_id)
              SELECT user_id, NULL, job_id FROM reports;
            DROP TABLE reports;
            ALTER TABLE reports_v2 RENAME TO reports;`,
    }]);
    assert.equal(n, 1);
    assert.deepEqual(recorded(db), ["999_rebuild_ok"]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM reports").get().n, 1);
    assert.ok(db.prepare("PRAGMA table_info(reports)").all().some(c => c.name === "domain_profile_id"));
  } finally { db.close(); }
});

test("an already-recorded migration is skipped, and skipping is not an error", () => {
  const db = bare();
  try {
    db.prepare("INSERT INTO schema_migrations (id) VALUES ('001_done')").run();
    const skipped = [];
    const n = applyPendingMigrations(
      db,
      [{ id: "001_done", sql: "SELECT this_would_throw_if_it_ran;" },
       { id: "002_new",  sql: "CREATE TABLE fresh (a);" }],
      { onSkip: (m) => skipped.push(m.id) },
    );
    assert.equal(n, 1, "only the pending one counts");
    assert.deepEqual(skipped, ["001_done"]);
    assert.equal(exists(db, "fresh"), true);
  } finally { db.close(); }
});

test("ONE transaction per migration, not one around the whole run", () => {
  // A batch would be all-or-nothing across unrelated changes: migration 40 failing would roll back
  // 39 good ones, and every boot would repeat all of them. Per-migration means the database is
  // always left at a real migration boundary — which is what the first test's
  // `recorded == ["001_good"]` asserts, and this makes explicit at a length where a batch and a
  // per-migration wrapper visibly differ.
  const db = bare();
  try {
    const ms = [];
    for (let i = 1; i <= 5; i++) ms.push({ id: `00${i}_t`, sql: `CREATE TABLE t${i} (a);` });
    ms.push({ id: "006_bad", sql: "CREATE TABLE t6 (a); SELECT boom;" });
    ms.push({ id: "007_never_reached", sql: "CREATE TABLE t7 (a);" });

    assert.throws(() => applyPendingMigrations(db, ms));
    assert.deepEqual(recorded(db), ["001_t", "002_t", "003_t", "004_t", "005_t"],
      "everything before the failure is kept — a whole-run transaction would have lost all five");
    assert.equal(exists(db, "t6"), false, "the failing migration applied nothing");
    assert.equal(exists(db, "t7"), false, "and the run stopped rather than continuing past it");
  } finally { db.close(); }
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE PRECONDITION — not every statement CAN be wrapped
// ════════════════════════════════════════════════════════════════════════════════════════════

test("no migration contains a statement that cannot run inside a transaction", () => {
  // ⛔ THIS IS THE GUARD THAT KEEPS THE WRAPPER HONEST. `PRAGMA journal_mode`, `VACUUM` and
  // `ANALYZE` either error or silently no-op inside a transaction, and an explicit
  // BEGIN/COMMIT/SAVEPOINT in a migration's SQL would fight the wrapper — committing the work
  // early, which is precisely the behaviour this change removes. All 115 were checked before the
  // wrapper was added; this is what stops number 116 reintroducing it.
  const offenders = MIGRATIONS
    .filter(m => /\b(PRAGMA|VACUUM|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i.test(m.sql))
    .map(m => m.id);
  assert.deepEqual(offenders, [],
    "these cannot be wrapped in a transaction — the migration needs splitting, or the runner needs "
    + "an explicit opt-out that says which statement needs it and why");
});

test("every migration still applies cleanly from an empty database, transactions and all", () => {
  // The whole list through the real runner rather than the `for (const m of MIGRATIONS) db.exec(...)`
  // shortcut most test files use — which bypasses the runner entirely and so could not have caught
  // a wrapper that broke one of them.
  const db = bare();
  try {
    const n = applyPendingMigrations(db, MIGRATIONS);
    assert.equal(n, MIGRATIONS.length, "all of them applied");
    assert.equal(recorded(db).length, MIGRATIONS.length, "and all of them recorded");
    // Running again is a no-op rather than a re-application.
    assert.equal(applyPendingMigrations(db, MIGRATIONS), 0);
  } finally { db.close(); }
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// BOTH RUNNERS, because the loop being copied is why this was two edits
// ════════════════════════════════════════════════════════════════════════════════════════════

test("neither runner keeps its own loop", () => {
  // The MIGRATIONS lists are duplicated on purpose (test/migrationListsAgree.test.js guards that).
  // The loop is not: it was copied, and the copy is why the missing transaction had to be found
  // twice. A runner that grows its own loop back loses the transaction silently.
  for (const file of ["server.js", "scripts/migration.js"]) {
    const src = fs.readFileSync(file, "utf8");
    assert.match(src, /applyPendingMigrations\(db, MIGRATIONS/,
      `${file} must apply migrations through the shared runner`);
    const live = src.split(/\r?\n/)
      .filter(l => /db\.exec\(\s*m(igration)?\.sql\s*\)/.test(l))
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
    assert.deepEqual(live, [],
      `${file} applies a migration's SQL outside the transaction wrapper`);
  }
});
