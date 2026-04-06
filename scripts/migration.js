// scripts/migrate.js
// Safe additive-only migrations — never drops tables or columns.
// Each migration has an id, runs once, and is recorded in schema_migrations table.
// Run: node scripts/migrate.js
import Database from "better-sqlite3";
import path     from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "..", "data", "resume_master.db");

const db = new Database(DB_PATH);

// Migration tracking table — created first, always
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id         TEXT    PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

// ── Migration definitions ─────────────────────────────────────
// Add new migrations to the END of this array only.
// Never edit or remove an existing migration.
const MIGRATIONS = [
  {
    id: "001_initial_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT    NOT NULL UNIQUE,
        password_hash TEXT    NOT NULL,
        is_admin      INTEGER NOT NULL DEFAULT 0,
        apply_mode    TEXT    NOT NULL DEFAULT 'TAILORED',
        apify_token   TEXT,
        created_at    INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS user_profile (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id              INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        full_name            TEXT, email TEXT, phone TEXT,
        linkedin_url         TEXT, github_url TEXT, location TEXT,
        address_line1        TEXT, address_line2 TEXT,
        city TEXT, state TEXT, zip TEXT, country TEXT DEFAULT 'United States',
        gender TEXT, ethnicity TEXT, veteran_status TEXT, disability_status TEXT,
        requires_sponsorship INTEGER NOT NULL DEFAULT 0,
        has_clearance        INTEGER NOT NULL DEFAULT 0,
        clearance_level      TEXT, visa_type TEXT, work_auth TEXT,
        updated_at           INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS job_cache (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        search_query TEXT    NOT NULL,
        source       TEXT    NOT NULL DEFAULT 'combined',
        scraped_at   INTEGER NOT NULL,
        jobs_json    TEXT    NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resumes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        job_id     TEXT    NOT NULL,
        company    TEXT    NOT NULL,
        role       TEXT    NOT NULL,
        category   TEXT,
        apply_mode TEXT    NOT NULL DEFAULT 'TAILORED',
        html       TEXT    NOT NULL,
        ats_score  INTEGER,
        ats_report TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(user_id, job_id)
      );
      CREATE TABLE IF NOT EXISTS resume_versions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        job_id     TEXT    NOT NULL,
        company    TEXT    NOT NULL,
        role       TEXT    NOT NULL,
        category   TEXT,
        html       TEXT    NOT NULL,
        ats_score  INTEGER,
        ats_report TEXT,
        version    INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS base_resume (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT,
        content    TEXT    NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS job_applications (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        job_id       TEXT    NOT NULL,
        company      TEXT    NOT NULL,
        role         TEXT    NOT NULL,
        job_url      TEXT,
        source       TEXT,
        location     TEXT,
        apply_mode   TEXT,
        resume_file  TEXT,
        applied_at   INTEGER,
        notes        TEXT,
        UNIQUE(user_id, job_id)
      );
      CREATE TABLE IF NOT EXISTS refresh_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        query        TEXT    NOT NULL,
        refreshed_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `,
  },
  // ── Future migrations go here ─────────────────────────────
  // Example format:
  // {
  //   id: "002_add_column_example",
  //   sql: `ALTER TABLE job_applications ADD COLUMN priority TEXT;`
  // },
];

// ── Runner ────────────────────────────────────────────────────
function runMigrations() {
  const applied = new Set(
    db.prepare("SELECT id FROM schema_migrations").all().map(r => r.id)
  );

  let count = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) {
      console.log(`[migrate] skip  ${migration.id}`);
      continue;
    }
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(migration.id);
      console.log(`[migrate] ✓ ran ${migration.id}`);
      count++;
    } catch (e) {
      console.error(`[migrate] ✗ FAILED ${migration.id}:`, e.message);
      process.exit(1);
    }
  }

  if (count === 0) console.log("[migrate] All migrations already applied — schema is current.");
  else console.log(`[migrate] Applied ${count} migration(s).`);
  db.close();
}

runMigrations();
