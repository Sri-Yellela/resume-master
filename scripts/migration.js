// scripts/migration.js
// Each migration has an id, runs once inside ONE TRANSACTION, and is recorded in
// schema_migrations in that same transaction.
// Run: node scripts/migration.js   (or `npm run migrate`)
//
// ⛔ "SAFE ADDITIVE-ONLY MIGRATIONS — NEVER DROPS TABLES OR COLUMNS" is what this header said, and
// it has been false since migration 108: SQLite cannot widen a UNIQUE constraint in place, so
// rekeying ats_only_reports to (user_id, domain_profile_id, job_id) meant rebuilding the table —
// CREATE v2 / INSERT…SELECT / DROP / RENAME. It carries every row over, but a DROP is a DROP, and
// the claim was load-bearing: it is why nobody had noticed the runner had no transaction.
import Database from "better-sqlite3";
import path     from "path";
import { fileURLToPath } from "url";
import { MIGRATIONS } from "./migrations.js";
import { applyPendingMigrations } from "./applyMigrations.js";

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

// Migration definitions live in ./migrations.js.
//
// ⛔ IT IS NOT THE SINGLE SOURCE OF TRUTH, WHICH THIS COMMENT CLAIMED FOR A LONG TIME.
// server.js carries its OWN inline `const MIGRATIONS = [...]`, and THAT is the list which runs at
// boot in production. This script reads the other copy. A migration added only to ./migrations.js
// never runs on the deployed app; added only to server.js, it is invisible to this tool and a
// fixture database silently diverges from production. Both must be updated together —
// test/migrationListsAgree.test.js now fails if they disagree, which is the only reason the
// duplication is survivable. Add new migrations to BOTH, never just here.

// ── Runner ────────────────────────────────────────────────────
// The loop itself lives in ./applyMigrations.js and is SHARED with server.js's boot path. It used
// to be copied here, and the copy is the reason "wrap each migration in a transaction" was two
// edits instead of one — the same shape as the duplicated MIGRATIONS list above, but without that
// list's excuse. This file still owns its own logging and its own exit code.
//
// The header of this file says "never drops tables or columns". That stopped being true at
// migration 108, which rebuilds ats_only_reports to widen a UNIQUE constraint SQLite cannot widen
// in place — which is exactly why the transaction now matters. Corrected at the top.
function runMigrations() {
  let count = 0;
  try {
    count = applyPendingMigrations(db, MIGRATIONS, {
      onSkip:    (m) => console.log(`[migrate] skip  ${m.id}`),
      onApplied: (m) => console.log(`[migrate] ✓ ran ${m.id}`),
    });
  } catch (e) {
    // The message already carries the migration id — applyPendingMigrations prefixes it, because
    // the transaction wrapper is what replaced the per-migration catch that used to name it here.
    console.error(`[migrate] ✗ FAILED ${e.message}`);
    process.exit(1);
  }

  if (count === 0) console.log("[migrate] All migrations already applied — schema is current.");
  else console.log(`[migrate] Applied ${count} migration(s).`);
  db.close();
}

runMigrations();
