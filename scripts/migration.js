// scripts/migrate.js
// Safe additive-only migrations — never drops tables or columns.
// Each migration has an id, runs once, and is recorded in schema_migrations table.
// Run: node scripts/migrate.js
import Database from "better-sqlite3";
import path     from "path";
import { fileURLToPath } from "url";
import { MIGRATIONS } from "./migrations.js";

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

// Migration definitions live in ./migrations.js — the single source of truth shared
// with server.js's boot-time runner. Add new migrations there, never here.

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
