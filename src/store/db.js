// ── The store (A57) — Resume Master's first database, and a DELIBERATE REVERSAL ─────────────────
//
// Until 2026-10-02 this service was stateless by decision (2026-09-26): input in, output back,
// nothing persisted. The owner reversed that on 10-02 (draft WORKLOG A57; draft
// docs/PRODUCT_MODEL.md and docs/CORRECTIONS_REGISTER.md record the reversal): accounts, a credit
// ledger, and OPT-IN storage of the documents a signed-in user asks to keep.
//
// What did NOT change, and is enforced by test/stateless.test.js's narrowed form:
//   · the service-token API (/v1/…, /mcp) still stores nothing a caller sends;
//   · ONLY src/store/ opens the database, and only src/accounts/ writes to it;
//   · nothing is retained unless the user asks, per document, and a delete deletes
//     (secure_delete is on, so the freed pages are zeroed, not merely unlinked).
//
// ⚠ The store is OPTIONAL. Without RM_DB_PATH the service boots exactly as before and every account
// route answers 503 accounts_unconfigured — a deploy without a volume can never quietly create
// accounts that vanish at the next restart.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export const STORE_MIGRATIONS = Object.freeze([
  {
    id: "001_accounts",
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        password_changed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        sid_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS password_resets (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
    `,
  },
  {
    // ⚠ Every debit records WHAT it was for and WHAT it cost in tokens (owner, 10-02): change the
    // price later and the history still reconciles; omit it and the ledger can never be re-priced.
    id: "002_credit_ledger",
    sql: `
      CREATE TABLE IF NOT EXISTS credit_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        delta INTEGER NOT NULL,
        reason TEXT NOT NULL,
        period TEXT,
        route TEXT,
        model_calls INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        cache_creation_input_tokens INTEGER,
        ref INTEGER,
        note TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_monthly_grant
        ON credit_ledger(user_id, period) WHERE reason = 'monthly_grant';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_one_refund
        ON credit_ledger(ref) WHERE reason = 'refund';
    `,
  },
  {
    id: "003_artifacts",
    sql: `
      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT,
        content TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_user ON artifacts(user_id, created_at);
    `,
  },
]);

/** Open (and migrate) the store. Each migration and its record commit in one transaction. */
export function openStore(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("secure_delete = ON");
  db.exec("CREATE TABLE IF NOT EXISTS store_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))");
  const done = new Set(db.prepare("SELECT id FROM store_migrations").pluck().all());
  for (const m of STORE_MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO store_migrations (id) VALUES (?)").run(m.id);
    })();
  }
  return db;
}
