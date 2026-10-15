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
  {
    // A65 (owner's note under WORKLOG A57): "stored artifacts expire unless the user pins them".
    // A pinned document is kept until it is unpinned or deleted; the 90-day expiry skips it.
    id: "004_artifact_pins",
    sql: `
      ALTER TABLE artifacts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // A97 (owner, 10-14): the model-spend ledger. ~$7 left the account with no record anywhere: the
    // service's only ledger was a stdout line Railway may or may not still hold. ONE ROW PER MODEL
    // CALL, from either surface — counts and price, never content and never a person: `client` is the
    // calling client's id ("draft", "site-user"), not a user. `key_label` names the API key that paid
    // (ANTHROPIC_KEY_LABEL, matched to the key's name in the Console) and `key_fp` is a short sha256
    // of the key — so two processes sharing one key show the same fp. `cost_usd` is NULL for a model
    // with no price (src/model/prices.js), which is loud rather than a silent $0.
    id: "005_model_usage",
    sql: `
      CREATE TABLE IF NOT EXISTS model_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        client TEXT NOT NULL,
        via TEXT,
        route TEXT NOT NULL,
        purpose TEXT,
        model TEXT,
        success INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        cost_usd REAL,
        key_label TEXT,
        key_fp TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_model_usage_at ON model_usage(created_at);
    `,
  },
  {
    // A97 (10-14), the retry gap: the SDK may send one call twice (MODEL_MAX_RETRIES = 1), and the
    // first send can already have been billed. `attempts` is how many HTTP requests the SDK sent for
    // this one row — 1 normally, 2 when it retried, 0 when it failed before sending. NULL for rows
    // written before this migration, and for a client whose transport this service did not build.
    id: "006_model_usage_attempts",
    sql: `
      ALTER TABLE model_usage ADD COLUMN attempts INTEGER;
    `,
  },
]);

/**
 * WHERE the store lives (A65). RM_DB_PATH wins when set (tests, a deliberate override); otherwise the
 * Railway volume — RAILWAY_VOLUME_MOUNT_PATH is set by Railway when a volume is attached, so the path
 * is never hard-coded. No volume and no override: null, and the service runs without accounts.
 */
export const STORE_FILE = "resume-master.db";
export function resolveStorePath(env = process.env) {
  if (env.RM_DB_PATH) return env.RM_DB_PATH;
  if (env.RAILWAY_VOLUME_MOUNT_PATH) return path.join(env.RAILWAY_VOLUME_MOUNT_PATH, STORE_FILE);
  return null;
}

/** Open an existing store READ-ONLY, with no migration — for reports run beside the live service. */
export function openStoreReadOnly(file) {
  return new Database(file, { readonly: true, fileMustExist: true });
}

/** Open (and migrate) the store. Each migration and its record commit in one transaction. */
export function openStore(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("secure_delete = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))");
  const done = new Set(db.prepare("SELECT id FROM schema_migrations").pluck().all());
  for (const m of STORE_MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(m.id);
    })();
  }
  return db;
}
