/**
 * DB access for the provider evaluation harness.
 *
 * Connects to the SAME sqlite file the live app uses (so metrics can compare against real
 * scraped_jobs/company_ats_list data), but this module is the ONLY place that creates or
 * writes to provider_eval_jobs — a scratch table, fully separate from scraped_jobs, that the
 * live pipeline never reads or writes. Schema setup happens here directly (CREATE TABLE IF
 * NOT EXISTS) rather than through scripts/migrations.js — this harness is intentionally
 * self-contained and out-of-band from the live migration system.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, '..', '..', 'data', 'resume_master.db');

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  ensureSchema(db);
  return db;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_eval_jobs (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      provider               TEXT    NOT NULL,
      provider_job_id        TEXT,
      query                  TEXT,
      title                  TEXT,
      company                TEXT,
      location               TEXT,
      url                    TEXT,
      apply_url              TEXT,
      description            TEXT,
      posted_at              TEXT,
      salary_min_usd         INTEGER,
      salary_max_usd         INTEGER,
      workplace_type         TEXT,
      experience_level       TEXT,
      valid_through          INTEGER,
      is_h1b_sponsor         INTEGER,
      requires_work_auth     INTEGER,
      is_clearance_required  INTEGER,
      fingerprint            TEXT,
      fetched_at             INTEGER NOT NULL,
      raw_json               TEXT,
      UNIQUE(provider, provider_job_id)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_eval_jobs_fingerprint ON provider_eval_jobs(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_provider_eval_jobs_provider    ON provider_eval_jobs(provider);
  `);
}

// Wipes only this harness's own scratch data (e.g. to re-run a clean pull) — never touches
// any live table.
function resetEvalData(db, provider = null) {
  if (provider) db.prepare(`DELETE FROM provider_eval_jobs WHERE provider = ?`).run(provider);
  else db.prepare(`DELETE FROM provider_eval_jobs`).run();
}

export { openDb, ensureSchema, resetEvalData, DB_PATH };
