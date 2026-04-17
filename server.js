// ============================================================
// server.js — Resume Master v5
// ============================================================
import "dotenv/config";
import express        from "express";
import cors           from "cors";
import cron           from "node-cron";
import Database       from "better-sqlite3";
import Anthropic      from "@anthropic-ai/sdk";
import { ApifyClient } from "apify-client";
import passport       from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import session        from "express-session";
import SQLiteStoreFactory from "connect-sqlite3";
import bcrypt         from "bcryptjs";
import chromium    from "@sparticuz/chromium";
import puppeteer   from "puppeteer-core";
import multer         from "multer";
import ExcelJS        from "exceljs";
import crypto         from "crypto";
import { fileURLToPath } from "url";
import path           from "path";
import fs             from "fs";
import { createBackup, listBackups, restoreBackup } from "./scripts/backup.js";
import applyRoutes from "./routes/apply.js";
import { createAdminRouter } from "./routes/admin.js";
import { createAdminDbRouter } from "./routes/adminDb.js";
import { createDomainProfilesRouter } from "./routes/domainProfiles.js";
import { trackApiCall, trackScrape } from "./services/usageTracker.js";
import { checkLimit } from "./services/limitEnforcer.js";
import { loadAllPrompts, assemblePrompt } from "./services/promptAssembler.js";
import { classify } from "./services/classifier.js";
import { resolveFromClassifier, getDomainModuleKey, getSearchQueryTemplates } from "./services/qualificationResolver.js";
import { normaliseRole, buildApifyQueries, buildApifyQueriesFromProfile, isTitleRelevant as isTitleRelevantNew, isTitleRelevantToProfile } from "./services/searchQueryBuilder.js";

// ── Config ────────────────────────────────────────────────────
const PORT           = process.env.PORT           || 3001;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY  || "";
// NOTE: There is NO server-level APIFY_TOKEN.
// Each user stores their own token in the DB (users.apify_token).
// The cron job borrows the most recently active user's token.
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-in-production";
const ADMIN_USER     = process.env.ADMIN_USER     || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const CACHE_TTL_MS        = 12 * 60 * 60 * 1000;
const MAX_JOBS_PER_REFRESH= 50;
// 64-char hex → 32-byte AES-256 key.  Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// If not set, a random key is generated at startup (LinkedIn sessions won't survive restarts — acceptable for dev).
const COOKIE_ENCRYPTION_KEY = Buffer.from(
  process.env.COOKIE_ENCRYPTION_KEY
    ? process.env.COOKIE_ENCRYPTION_KEY.replace(/\s/g,"").slice(0,64)
    : crypto.randomBytes(32).toString("hex"),
  "hex"
);

// ── Scaling notes ─────────────────────────────────────────────
// Current: single Node.js process + SQLite + @sparticuz/chromium.
// Appropriate for ~50-100 concurrent users.
//
// Migration order when scaling to SaaS:
//
// 1. PDF → Gotenberg (see htmlToPdf() comment block above)
//    Add as Railway Docker sidecar: gotenberg/gotenberg:8
//    Set GOTENBERG_URL env var. Zero per-call RAM overhead.
//    Handles concurrent PDF exports natively.
//
// 2. SESSIONS → Redis (connect-redis replaces connect-sqlite3)
//    npm install connect-redis ioredis
//    store: new RedisStore({ client: new Redis(process.env.REDIS_URL) })
//
// 3. DATABASE → PostgreSQL (pg replaces better-sqlite3)
//    npm install pg
//    All db.prepare().get/all/run() become async pool.query()
//    Railway: add PostgreSQL plugin, use DATABASE_URL env var
//    Migration runner pattern stays the same
//
// 4. JOB SCRAPING → Queue (BullMQ + Redis)
//    Move scrapeJobs() into a worker process
//    API enqueues job, client polls for completion
//    Prevents scrape timeouts on Railway's 30s request limit
//
// 5. STATIC FILES → CDN
//    Push client/dist to Cloudflare R2 or S3
//    Reduces Railway egress costs at scale

// ABSOLUTE EXCLUSION LIST: these companies never appear in generated output.
// To modify this list edit ABSOLUTE COMPANY EXCLUSION in layer1_global_rules.md
// and update this array in sync.
const EXCLUDED_COMPANIES = [
  'apple', 'netflix', 'fidelity',
  'tiktok', 'bytedance',
];

// Strip excluded companies from any employer list before passing to prompt
function sanitiseEmployers(employers) {
  if (!employers?.length) return employers;
  return employers.filter(e =>
    !EXCLUDED_COMPANIES.includes((e || '').toLowerCase().trim())
  );
}

const NON_FULLTIME_TERMS = [
  "intern","internship","co-op","coop","contract","contractor",
  "temporary","temp","part-time","part time","freelance","seasonal",
];

const INDUSTRY_CATEGORIES = [
  "Fintech / Banking","E-commerce / Retail","Healthcare / Health Tech",
  "Hardware / Embedded / Robotics","Cybersecurity","Data Science / ML / AI",
  "DevOps / Infrastructure / SRE","Product Management","Design / UX",
  "Consulting / Professional Services","Sales / Business Development",
  "Marketing / Growth","Software Engineering","Research / Academia",
  "Operations / Supply Chain","Legal / Compliance","Other",
];

// ── Paths ─────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "data", "resume_master.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ── DB ────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
// WAL mode: allows concurrent readers alongside a single writer.
// Critical for multi-user deployments — prevents SQLITE_BUSY lock errors.
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// ── Inline migration runner (additive only — never drops data) ─
{
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch())
  );`);

  const MIGRATIONS = [
    {
      id: "001_initial_schema",
      sql: `
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          is_admin INTEGER NOT NULL DEFAULT 0,
          apply_mode TEXT NOT NULL DEFAULT 'TAILORED',
          apify_token TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS user_profile (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          full_name TEXT, email TEXT, phone TEXT,
          linkedin_url TEXT, github_url TEXT, location TEXT,
          address_line1 TEXT, address_line2 TEXT,
          city TEXT, state TEXT, zip TEXT, country TEXT DEFAULT 'United States',
          gender TEXT, ethnicity TEXT, veteran_status TEXT, disability_status TEXT,
          requires_sponsorship INTEGER NOT NULL DEFAULT 0,
          has_clearance INTEGER NOT NULL DEFAULT 0,
          clearance_level TEXT, visa_type TEXT, work_auth TEXT,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS job_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          search_query TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'combined',
          scraped_at INTEGER NOT NULL,
          jobs_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS resumes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          company TEXT NOT NULL,
          role TEXT NOT NULL,
          category TEXT,
          apply_mode TEXT NOT NULL DEFAULT 'TAILORED',
          html TEXT NOT NULL,
          ats_score INTEGER,
          ats_report TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(user_id, job_id)
        );
        CREATE TABLE IF NOT EXISTS resume_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          company TEXT NOT NULL,
          role TEXT NOT NULL,
          category TEXT,
          html TEXT NOT NULL,
          ats_score INTEGER,
          ats_report TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS base_resume (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          name TEXT,
          content TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS job_applications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          company TEXT NOT NULL,
          role TEXT NOT NULL,
          job_url TEXT,
          source TEXT,
          location TEXT,
          apply_mode TEXT,
          resume_file TEXT,
          applied_at INTEGER,
          notes TEXT,
          UNIQUE(user_id, job_id)
        );
        CREATE TABLE IF NOT EXISTS refresh_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          query TEXT NOT NULL,
          refreshed_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `,
    },
    {
      id: "002_scraped_jobs_pool",
      sql: `
        CREATE TABLE IF NOT EXISTS scraped_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL UNIQUE,
          search_query TEXT NOT NULL,
          company TEXT NOT NULL,
          title TEXT NOT NULL,
          category TEXT,
          location TEXT,
          work_type TEXT,
          source TEXT,
          url TEXT,
          posted_at TEXT,
          description TEXT,
          ghost_score INTEGER DEFAULT 0,
          years_experience INTEGER,
          is_frequent_repost INTEGER DEFAULT 0,
          _hash TEXT NOT NULL,
          scraped_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_scraped_jobs_query
          ON scraped_jobs(search_query, scraped_at);
        CREATE INDEX IF NOT EXISTS idx_scraped_jobs_hash
          ON scraped_jobs(_hash);
      `,
    },
    {
      id: "003_user_job_views",
      sql: `
        CREATE TABLE IF NOT EXISTS user_job_views (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          viewed_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(user_id, job_id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_job_views_user
          ON user_job_views(user_id, job_id);
      `,
    },
    {
      id: "004_user_job_searches",
      sql: `
        CREATE TABLE IF NOT EXISTS user_job_searches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          search_query TEXT NOT NULL,
          last_scraped_at INTEGER,
          UNIQUE(user_id, search_query)
        );
      `,
    },
    {
      id: "005_scraped_jobs_new_columns",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN compensation TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN company_icon_url TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN source_platform TEXT;
        UPDATE scraped_jobs SET source_platform = LOWER(source) WHERE source IS NOT NULL;
      `,
    },
    {
      id: "006_user_jobs",
      sql: `
        CREATE TABLE IF NOT EXISTS user_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          visited INTEGER NOT NULL DEFAULT 0,
          applied INTEGER NOT NULL DEFAULT 0,
          starred INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(user_id, job_id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_jobs_user ON user_jobs(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_jobs_job ON user_jobs(job_id);
        INSERT OR IGNORE INTO user_jobs (user_id, job_id, applied)
          SELECT user_id, job_id, 1 FROM job_applications;
      `,
    },
    {
      id: "007_scraped_jobs_v5_columns",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN apply_url TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN salary_min REAL;
        ALTER TABLE scraped_jobs ADD COLUMN salary_max REAL;
        ALTER TABLE scraped_jobs ADD COLUMN salary_currency TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN description_html TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN applicant_count INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN min_years_exp REAL;
        ALTER TABLE scraped_jobs ADD COLUMN max_years_exp REAL;
        ALTER TABLE scraped_jobs ADD COLUMN exp_raw TEXT;
      `,
    },
    {
      id: "008_disliked_and_linkedin_sessions",
      sql: `
        ALTER TABLE user_jobs ADD COLUMN disliked INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX IF NOT EXISTS idx_user_jobs_disliked ON user_jobs(user_id, disliked);
        CREATE TABLE IF NOT EXISTS user_linkedin_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          cookies_enc TEXT NOT NULL,
          iv TEXT NOT NULL,
          auth_tag TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `,
    },
    {
      id: "009_profile_name_split_and_pending",
      sql: `
        ALTER TABLE user_profile ADD COLUMN first_name TEXT;
        ALTER TABLE user_profile ADD COLUMN middle_name TEXT;
        ALTER TABLE user_profile ADD COLUMN last_name TEXT;
        ALTER TABLE user_profile ADD COLUMN name_suffix TEXT;
        ALTER TABLE user_jobs ADD COLUMN resume_generated INTEGER NOT NULL DEFAULT 0;
      `,
    },
    {
      id: "010_apply_automation",
      sql: `
        ALTER TABLE job_applications ADD COLUMN auto_status TEXT;
        ALTER TABLE job_applications ADD COLUMN screenshot_path TEXT;
      `,
    },
    {
      id: "011_cleanup_log",
      sql: `
        CREATE TABLE IF NOT EXISTS cleanup_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_at INTEGER NOT NULL DEFAULT (unixepoch()),
          jobs_deleted INTEGER NOT NULL DEFAULT 0,
          orphans_cleaned INTEGER NOT NULL DEFAULT 0,
          details TEXT
        );
      `,
    },
    {
      id: "012_clear_all_dislikes",
      sql: `UPDATE user_jobs SET disliked = 0 WHERE disliked = 1;`,
    },
    {
      id: "013_employment_type",
      sql: `ALTER TABLE scraped_jobs ADD COLUMN employment_type TEXT;`,
    },
    {
      id: "admin_usage_events",
      sql: `
        CREATE TABLE IF NOT EXISTS usage_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          event_subtype TEXT,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          cache_read_tokens INTEGER DEFAULT 0,
          cache_creation_tokens INTEGER DEFAULT 0,
          cached INTEGER NOT NULL DEFAULT 0,
          model TEXT,
          cost_usd REAL DEFAULT 0,
          ats_score_before INTEGER,
          ats_score_after INTEGER,
          duration_ms INTEGER,
          job_id TEXT,
          company TEXT,
          success INTEGER NOT NULL DEFAULT 1,
          error_text TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_usage_events_user
          ON usage_events(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_usage_events_type
          ON usage_events(event_type, created_at);
      `,
    },
    {
      id: "admin_user_limits",
      sql: `
        CREATE TABLE IF NOT EXISTS user_limits (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          monthly_resumes INTEGER,
          monthly_ats_scores INTEGER,
          monthly_job_scrapes INTEGER,
          monthly_pdf_exports INTEGER,
          monthly_apply_runs INTEGER,
          monthly_token_budget INTEGER,
          daily_resumes INTEGER,
          daily_job_scrapes INTEGER,
          warning_threshold REAL DEFAULT 0.8,
          notes TEXT,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_by INTEGER REFERENCES users(id)
        );
      `,
    },
    {
      id: "admin_cache_events",
      sql: `
        CREATE TABLE IF NOT EXISTS cache_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          layer TEXT,
          domain_module TEXT,
          tokens_in_cache INTEGER DEFAULT 0,
          tokens_saved INTEGER DEFAULT 0,
          cost_saved_usd REAL DEFAULT 0,
          model TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_cache_events_user
          ON cache_events(user_id, created_at);
      `,
    },
    {
      id: "admin_scrape_events",
      sql: `
        CREATE TABLE IF NOT EXISTS scrape_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          search_query TEXT NOT NULL,
          raw_count INTEGER DEFAULT 0,
          filtered_count INTEGER DEFAULT 0,
          inserted_count INTEGER DEFAULT 0,
          duplicate_count INTEGER DEFAULT 0,
          ghost_count INTEGER DEFAULT 0,
          irrelevant_count INTEGER DEFAULT 0,
          duration_ms INTEGER,
          success INTEGER NOT NULL DEFAULT 1,
          error_text TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_scrape_events_user
          ON scrape_events(user_id, created_at);
      `,
    },
    {
      id: "ats_only_reports",
      sql: `
        CREATE TABLE IF NOT EXISTS ats_only_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          ats_report TEXT NOT NULL,
          ats_score INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(user_id, job_id)
        );
      `,
    },
    {
      id: "contact_messages",
      sql: `
        CREATE TABLE IF NOT EXISTS contact_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          subject TEXT,
          message TEXT NOT NULL,
          read INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `,
    },
    // ── Phase 2A: Domain profiles ──────────────────────────────
    {
      id: "013_domain_profiles",
      sql: `
        CREATE TABLE IF NOT EXISTS domain_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          profile_name TEXT NOT NULL,
          role_family TEXT NOT NULL,
          domain TEXT NOT NULL,
          seniority TEXT NOT NULL DEFAULT 'mid',
          target_titles JSON NOT NULL DEFAULT '[]',
          selected_keywords JSON NOT NULL DEFAULT '[]',
          selected_verbs JSON NOT NULL DEFAULT '[]',
          selected_tools JSON NOT NULL DEFAULT '[]',
          is_active INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_domain_profiles_user
          ON domain_profiles(user_id, is_active);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_profiles_active
          ON domain_profiles(user_id) WHERE is_active = 1;
      `,
    },
    {
      id: "014_profile_onboarding_flag",
      sql: `
        ALTER TABLE users ADD COLUMN domain_profile_complete INTEGER NOT NULL DEFAULT 0;
      `,
    },
    // ── Phase 5A: Standalone users ─────────────────────────────
    {
      id: "015_standalone_users",
      sql: `
        CREATE TABLE IF NOT EXISTS standalone_users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE,
          phone TEXT UNIQUE,
          google_id TEXT UNIQUE,
          display_name TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          last_seen_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS standalone_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          standalone_user_id INTEGER REFERENCES standalone_users(id) ON DELETE CASCADE,
          session_id TEXT,
          service TEXT NOT NULL,
          used_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_standalone_usage_user
          ON standalone_usage(standalone_user_id, service);
        CREATE INDEX IF NOT EXISTS idx_standalone_usage_session
          ON standalone_usage(session_id, service);
      `,
    },
    // ── Phase 6A: Profile-isolated job pools ──────────────────
    {
      id: "016_scraped_jobs_profile_tag",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN
          domain_profile_id INTEGER REFERENCES domain_profiles(id) ON DELETE SET NULL;
        ALTER TABLE user_jobs ADD COLUMN
          domain_profile_id INTEGER REFERENCES domain_profiles(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_scraped_jobs_profile
          ON scraped_jobs(domain_profile_id);
        CREATE INDEX IF NOT EXISTS idx_user_jobs_profile
          ON user_jobs(user_id, domain_profile_id);
      `,
    },
    // ── Phase 6B: ATS scoring at scrape time ──────────────────
    {
      id: "017_scraped_jobs_ats",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN ats_score INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN ats_report TEXT;
      `,
    },
    // ── Phase 6C: Resume Enhancer ────────────────────────────
    {
      id: "018_base_resume_enhance",
      sql: `
        ALTER TABLE base_resume ADD COLUMN enhanced_at INTEGER;
        ALTER TABLE base_resume ADD COLUMN enhanced_content TEXT;
        ALTER TABLE base_resume ADD COLUMN enhanced_ats_delta INTEGER;
        ALTER TABLE users ADD COLUMN enhance_used INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN enhance_paid INTEGER NOT NULL DEFAULT 0;
      `,
    },
    {
      id: "019_notifications",
      sql: `
        CREATE TABLE IF NOT EXISTS notifications (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type       TEXT    NOT NULL,
          message    TEXT    NOT NULL,
          payload    TEXT,
          read       INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_user
          ON notifications(user_id, created_at);
      `,
    },
    {
      id: "020_dock_preferences",
      sql: `
        CREATE TABLE IF NOT EXISTS dock_preferences (
          user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          items_json TEXT    NOT NULL DEFAULT '["profile_switcher","notifications","quick_actions","settings","user_avatar"]',
          dock_enabled INTEGER NOT NULL DEFAULT 1,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `,
    },
    // ── Phase 7: Profile isolation backfill ──────────────────
    {
      id: "021_backfill_profile_tags",
      sql: `
        -- Disable foreign key enforcement for this migration
        -- The -1 sentinel approach violates the FK constraint
        -- on domain_profile_id. Use NULL instead of -1 for
        -- unmatched legacy rows and handle exclusion in queries.

        -- Best-effort tag: assign user_jobs rows to the user's
        -- active profile where one exists
        UPDATE user_jobs
        SET domain_profile_id = (
          SELECT dp.id
          FROM domain_profiles dp
          WHERE dp.user_id = user_jobs.user_id
            AND dp.is_active = 1
          LIMIT 1
        )
        WHERE domain_profile_id IS NULL;
      `
    },
    {
      id: "022_clear_legacy_user_jobs",
      sql: `
        -- Remove user_jobs rows that could not be matched
        -- to any domain profile (domain_profile_id still NULL
        -- after backfill means no active profile exists for
        -- that user — safe to clear, they will re-populate
        -- on next search with a profile set)
        DELETE FROM user_jobs
        WHERE domain_profile_id IS NULL
          AND job_id NOT IN (
            SELECT job_id FROM job_applications
          );
        -- Applied jobs are always protected regardless
      `
    },
    {
      id: "023_clean_wrong_profile_jobs",
      sql: `
        -- Keep only user_jobs that belong to a valid profile or are applied.
        -- Uses temp table to avoid correlated-subquery limitations in older SQLite.
        CREATE TEMP TABLE IF NOT EXISTS jobs_to_keep AS
          SELECT uj.rowid FROM user_jobs uj
          WHERE uj.domain_profile_id IN (
            SELECT id FROM domain_profiles WHERE user_id = uj.user_id
          )
          OR uj.job_id IN (SELECT job_id FROM job_applications);

        DELETE FROM user_jobs
        WHERE rowid NOT IN (SELECT rowid FROM jobs_to_keep);

        DROP TABLE IF EXISTS jobs_to_keep;
      `
    },
    {
      id: "024_clean_crossprofile_jobs",
      sql: `
        -- Remove user_jobs rows whose domain_profile_id belongs to a different user
        DELETE FROM user_jobs
        WHERE rowid IN (
          SELECT uj.rowid FROM user_jobs uj
          WHERE uj.domain_profile_id IS NOT NULL
            AND uj.domain_profile_id NOT IN (
              SELECT id FROM domain_profiles WHERE user_id = uj.user_id
            )
            AND uj.job_id NOT IN (
              SELECT job_id FROM job_applications WHERE user_id = uj.user_id
            )
        );

        -- Remove NULL-tagged rows that are not applied jobs
        DELETE FROM user_jobs
        WHERE domain_profile_id IS NULL
          AND job_id NOT IN (
            SELECT job_id FROM job_applications WHERE user_id = user_jobs.user_id
          );
      `
    },
    {
      id: "025_clean_wrong_profile_jobs",
      sql: `
        -- Remove user_jobs rows with NULL profile tag
        -- that are not applied jobs.
        -- These were inserted by the old search_query
        -- sync before this fix and will never match
        -- any profile filter.
        DELETE FROM user_jobs
        WHERE domain_profile_id IS NULL
        AND job_id NOT IN (
          SELECT job_id FROM job_applications
          WHERE user_id = user_jobs.user_id
        );
      `
    },
    {
      id: "026_backfill_scraped_jobs_profile_tag",
      sql: `
        -- Tag scraped_jobs to the active profile of the user whose
        -- search_query matches, using user_job_searches as the link.
        -- Not perfect for historical data but far better than NULL.
        UPDATE scraped_jobs
        SET domain_profile_id = (
          SELECT dp.id
          FROM user_job_searches ujs
          JOIN domain_profiles dp
            ON dp.user_id = ujs.user_id
            AND dp.is_active = 1
          WHERE LOWER(ujs.search_query) = LOWER(scraped_jobs.search_query)
          LIMIT 1
        )
        WHERE domain_profile_id IS NULL;
      `,
    },
    {
      id: "027_backfill_user_jobs_profile_tag",
      sql: `
        -- Pull domain_profile_id from the scraped_job onto any user_jobs
        -- rows that are still NULL-tagged but whose scraped_job is now tagged.
        UPDATE user_jobs
        SET domain_profile_id = (
          SELECT sj.domain_profile_id
          FROM scraped_jobs sj
          WHERE sj.job_id = user_jobs.job_id
            AND sj.domain_profile_id IS NOT NULL
          LIMIT 1
        )
        WHERE domain_profile_id IS NULL
          AND job_id IN (
            SELECT job_id FROM scraped_jobs WHERE domain_profile_id IS NOT NULL
          );

        -- Remove any remaining NULL-tagged user_jobs that couldn't be matched
        -- and are not applied jobs (safe to drop — they'd never appear anyway).
        DELETE FROM user_jobs
        WHERE domain_profile_id IS NULL
          AND job_id NOT IN (
            SELECT job_id FROM job_applications WHERE user_id = user_jobs.user_id
          );
      `,
    },
    {
      id: "028_remove_irrelevant_swe_jobs",
      sql: `
        -- Remove from user_jobs any job tagged to an engineering profile
        -- whose title contains no SWE-relevant keyword. These were incorrectly
        -- inserted when the title relevance filter was broken and then backfilled.
        DELETE FROM user_jobs
        WHERE domain_profile_id IN (
          SELECT id FROM domain_profiles WHERE role_family = 'engineering'
        )
        AND job_id IN (
          SELECT job_id FROM scraped_jobs
          WHERE (
            LOWER(title) NOT LIKE '%engineer%'
            AND LOWER(title) NOT LIKE '%developer%'
            AND LOWER(title) NOT LIKE '%software%'
            AND LOWER(title) NOT LIKE '%programmer%'
            AND LOWER(title) NOT LIKE '%devops%'
            AND LOWER(title) NOT LIKE '%sre%'
            AND LOWER(title) NOT LIKE '%architect%'
            AND LOWER(title) NOT LIKE '%data%'
            AND LOWER(title) NOT LIKE '%machine learning%'
            AND LOWER(title) NOT LIKE '%ml%'
            AND LOWER(title) NOT LIKE '%ai%'
            AND LOWER(title) NOT LIKE '%backend%'
            AND LOWER(title) NOT LIKE '%frontend%'
            AND LOWER(title) NOT LIKE '%fullstack%'
            AND LOWER(title) NOT LIKE '%full stack%'
            AND LOWER(title) NOT LIKE '%platform%'
            AND LOWER(title) NOT LIKE '%infrastructure%'
            AND LOWER(title) NOT LIKE '%cloud%'
            AND LOWER(title) NOT LIKE '%systems%'
            AND LOWER(title) NOT LIKE '%technical%'
            AND LOWER(title) NOT LIKE '%technology%'
            AND LOWER(title) NOT LIKE '%security%'
            AND LOWER(title) NOT LIKE '%analyst%'
            AND LOWER(title) NOT LIKE '%scientist%'
          )
        )
        AND job_id NOT IN (
          SELECT job_id FROM job_applications WHERE user_id = user_jobs.user_id
        );

        -- Also purge from scraped_jobs if no user has applied to them
        DELETE FROM scraped_jobs
        WHERE domain_profile_id IN (
          SELECT id FROM domain_profiles WHERE role_family = 'engineering'
        )
        AND (
          LOWER(title) NOT LIKE '%engineer%'
          AND LOWER(title) NOT LIKE '%developer%'
          AND LOWER(title) NOT LIKE '%software%'
          AND LOWER(title) NOT LIKE '%programmer%'
          AND LOWER(title) NOT LIKE '%devops%'
          AND LOWER(title) NOT LIKE '%architect%'
          AND LOWER(title) NOT LIKE '%data%'
          AND LOWER(title) NOT LIKE '%machine learning%'
          AND LOWER(title) NOT LIKE '%platform%'
          AND LOWER(title) NOT LIKE '%infrastructure%'
          AND LOWER(title) NOT LIKE '%cloud%'
          AND LOWER(title) NOT LIKE '%systems%'
          AND LOWER(title) NOT LIKE '%technical%'
          AND LOWER(title) NOT LIKE '%security%'
          AND LOWER(title) NOT LIKE '%analyst%'
          AND LOWER(title) NOT LIKE '%scientist%'
        )
        AND job_id NOT IN (SELECT DISTINCT job_id FROM job_applications);
      `,
    },
    {
      id: "029_remove_irrelevant_pm_jobs",
      sql: `
        -- Remove from user_jobs any job tagged to a PM profile
        -- whose title contains no PM-relevant keyword.
        DELETE FROM user_jobs
        WHERE domain_profile_id IN (
          SELECT id FROM domain_profiles WHERE role_family = 'pm'
        )
        AND job_id IN (
          SELECT job_id FROM scraped_jobs
          WHERE (
            LOWER(title) NOT LIKE '%project%'
            AND LOWER(title) NOT LIKE '%program%'
            AND LOWER(title) NOT LIKE '%product%'
            AND LOWER(title) NOT LIKE '%manager%'
            AND LOWER(title) NOT LIKE '%coordinator%'
            AND LOWER(title) NOT LIKE '%director%'
            AND LOWER(title) NOT LIKE '%lead%'
            AND LOWER(title) NOT LIKE '%agile%'
            AND LOWER(title) NOT LIKE '%scrum%'
            AND LOWER(title) NOT LIKE '%pmo%'
            AND LOWER(title) NOT LIKE '%delivery%'
            AND LOWER(title) NOT LIKE '%operations%'
          )
        )
        AND job_id NOT IN (
          SELECT job_id FROM job_applications WHERE user_id = user_jobs.user_id
        );
      `,
    },
    {
      id: "030_repair_profile_isolation_contamination",
      sql: `
        -- Repair non-applied profile contamination left by legacy active-profile
        -- and user_job_searches backfills. Applied rows are preserved in
        -- job_applications and hidden from active boards by applied filters.

        DELETE FROM user_jobs
        WHERE applied = 0
          AND (
            domain_profile_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM domain_profiles dp
              WHERE dp.id = user_jobs.domain_profile_id
                AND dp.user_id = user_jobs.user_id
            )
            OR NOT EXISTS (
              SELECT 1 FROM scraped_jobs sj
              WHERE sj.job_id = user_jobs.job_id
                AND sj.domain_profile_id = user_jobs.domain_profile_id
            )
          );

        UPDATE scraped_jobs
        SET domain_profile_id = NULL
        WHERE domain_profile_id IN (SELECT id FROM domain_profiles WHERE role_family = 'engineering')
          AND job_id NOT IN (SELECT DISTINCT job_id FROM job_applications)
          AND LOWER(title) NOT LIKE '%engineer%'
          AND LOWER(title) NOT LIKE '%developer%'
          AND LOWER(title) NOT LIKE '%software%'
          AND LOWER(title) NOT LIKE '%programmer%'
          AND LOWER(title) NOT LIKE '%devops%'
          AND LOWER(title) NOT LIKE '%sre%'
          AND LOWER(title) NOT LIKE '%architect%'
          AND LOWER(title) NOT LIKE '%backend%'
          AND LOWER(title) NOT LIKE '%frontend%'
          AND LOWER(title) NOT LIKE '%fullstack%'
          AND LOWER(title) NOT LIKE '%full stack%'
          AND LOWER(title) NOT LIKE '%platform%'
          AND LOWER(title) NOT LIKE '%infrastructure%'
          AND LOWER(title) NOT LIKE '%cloud%'
          AND LOWER(title) NOT LIKE '%systems%'
          AND LOWER(title) NOT LIKE '%security%';

        UPDATE scraped_jobs
        SET domain_profile_id = NULL
        WHERE domain_profile_id IN (SELECT id FROM domain_profiles WHERE role_family = 'pm')
          AND job_id NOT IN (SELECT DISTINCT job_id FROM job_applications)
          AND LOWER(title) NOT LIKE '%project%'
          AND LOWER(title) NOT LIKE '%program%'
          AND LOWER(title) NOT LIKE '%product%'
          AND LOWER(title) NOT LIKE '%manager%'
          AND LOWER(title) NOT LIKE '%coordinator%'
          AND LOWER(title) NOT LIKE '%director%'
          AND LOWER(title) NOT LIKE '%lead%'
          AND LOWER(title) NOT LIKE '%agile%'
          AND LOWER(title) NOT LIKE '%scrum%'
          AND LOWER(title) NOT LIKE '%pmo%'
          AND LOWER(title) NOT LIKE '%delivery%'
          AND LOWER(title) NOT LIKE '%operations%';

        UPDATE scraped_jobs
        SET domain_profile_id = NULL
        WHERE domain_profile_id IN (SELECT id FROM domain_profiles WHERE role_family = 'data')
          AND job_id NOT IN (SELECT DISTINCT job_id FROM job_applications)
          AND LOWER(title) NOT LIKE '%data%'
          AND LOWER(title) NOT LIKE '%analytics%'
          AND LOWER(title) NOT LIKE '%analyst%'
          AND LOWER(title) NOT LIKE '%scientist%'
          AND LOWER(title) NOT LIKE '%machine learning%'
          AND LOWER(title) NOT LIKE '%ml%'
          AND LOWER(title) NOT LIKE '%ai%'
          AND LOWER(title) NOT LIKE '%business intelligence%'
          AND LOWER(title) NOT LIKE '%bi%'
          AND LOWER(title) NOT LIKE '%research%'
          AND LOWER(title) NOT LIKE '%quantitative%';

        DELETE FROM user_jobs
        WHERE applied = 0
          AND NOT EXISTS (
            SELECT 1 FROM scraped_jobs sj
            WHERE sj.job_id = user_jobs.job_id
              AND sj.domain_profile_id = user_jobs.domain_profile_id
          );
      `,
    },
    // Add future migrations here — never edit existing ones
  ];

  const applied = new Set(
    db.prepare("SELECT id FROM schema_migrations").all().map(r => r.id)
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(m.id);
      console.log(`[migrate] ✓ ${m.id}`);
    } catch(e) {
      console.error(`[migrate] ✗ FAILED ${m.id}:`, e.message);
      process.exit(1);
    }
  }
}

// Load layered prompt system at startup
loadAllPrompts();

// ── Backfill: split full_name into first_name / last_name ─────
{
  const rows = db.prepare("SELECT user_id, full_name FROM user_profile WHERE full_name IS NOT NULL AND first_name IS NULL").all();
  if (rows.length > 0) {
    const upd = db.prepare("UPDATE user_profile SET first_name=?, last_name=? WHERE user_id=?");
    db.transaction(() => {
      rows.forEach(r => {
        const parts = (r.full_name || "").trim().split(/\s+/);
        const first = parts[0] || "";
        const last  = parts.length > 1 ? parts[parts.length - 1] : "";
        upd.run(first, last, r.user_id);
      });
    })();
    console.log(`[backfill] Split full_name for ${rows.length} profiles`);
  }
}

// ── Seed admin user ───────────────────────────────────────────
const adminExists = db.prepare("SELECT id FROM users WHERE username=?").get(ADMIN_USER);
if (!adminExists) {
  db.prepare("INSERT INTO users (username,password_hash,is_admin) VALUES (?,?,1)")
    .run(ADMIN_USER, bcrypt.hashSync(ADMIN_PASSWORD, 10));
}

// ── Anthropic ─────────────────────────────────────────────────
// Guard: if ANTHROPIC_KEY is missing, log a clear warning at startup
// (endpoints that call Anthropic will return 500 with a descriptive error)
if (!ANTHROPIC_KEY) {
  console.error("[startup] WARNING: ANTHROPIC_KEY is not set in .env — PDF parsing and resume generation will fail.");
}
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// PRICING: Anthropic per-token costs in USD as of 2025.
// Update these when Anthropic changes pricing.
// Cache read tokens cost 10% of base input price.
// Cache write tokens cost 125% of base input price.
const ANTHROPIC_PRICING = {
  "claude-sonnet-4-20250514": {
    input:       0.000003,
    output:      0.000015,
    cache_read:  0.0000003,
    cache_write: 0.00000375,
  },
  "claude-haiku-4-5-20251001": {
    input:       0.0000008,
    output:      0.000004,
    cache_read:  0.00000008,
    cache_write: 0.000001,
  },
};

function calculateCost(model, usage) {
  const p = ANTHROPIC_PRICING[model];
  if (!p) return 0;
  return (
    (usage.input_tokens || 0)              * p.input +
    (usage.output_tokens || 0)             * p.output +
    (usage.cache_read_input_tokens || 0)   * p.cache_read +
    (usage.cache_creation_tokens || 0)     * p.cache_write
  );
}
// TO UPDATE PRICING — edit ANTHROPIC_PRICING above.
// Historical cost calculations use the price at insert time
// (stored in usage_events.cost_usd) so changing this does not
// retroactively alter past records.

// ── Multer ────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  preservePath: true,
});

// ── ATS scoring system prompt (module-level, defined once) ────
const ATS_SYSTEM_PROMPT = `You are an ATS (Applicant Tracking System) scoring engine.

Score the provided resume against the provided job description.
Extract keywords ONLY from the job description text provided in this message.
Do not use prior knowledge, assumptions, or memory of other calls.
Every keyword in tier1_matched and tier1_missing must appear verbatim
in the job description text provided below.

ACTION VERB RULES — critical:
Only include STRONG, SPECIFIC action verbs in action_verbs_matched and action_verbs_missing.
Strong action verbs are domain-specific and demonstrate concrete professional capability. What counts as strong depends on the role: Architecting and Deploying are strong for engineering; Negotiated, Structured, and Modelled are strong for finance; Procured, Commissioned, and Coordinated are strong for construction PM; Diagnosed, Administered, and Triaged are strong for healthcare. Apply the same principle: include verbs that signal specific professional capability in the domain of the job description. Exclude weak/generic verbs regardless of domain.

WEAK generic verbs to EXCLUDE from action verb lists (do not count these):
  Utilize, Use, Apply, Employ, Bring, Demonstrate, Perform, Do, Make, Have, Get,
  Ensure, Support, Help, Assist, Provide, Enable, Allow, Work, Handle, Manage (when vague),
  Involve, Include, Require, Need, Want, Like, Know, Understand, Able, Capable.

If a verb appears in the JD but is weak/generic, omit it from both action_verbs_matched
and action_verbs_missing entirely. Do not penalize the candidate for missing weak verbs.

Reply ONLY with valid JSON. No markdown fences, no explanation, no preamble.
Use this exact schema:
{
  "score": <integer 0-100>,
  "tier1_matched": [<specific technical keywords, tools, skills from JD that appear in resume>],
  "tier1_missing": [<specific technical keywords, tools, skills from JD NOT in resume>],
  "action_verbs_matched": [<STRONG domain-specific action verbs from JD found in resume>],
  "action_verbs_missing": [<STRONG domain-specific action verbs from JD NOT in resume>],
  "strengths": [<2-4 specific strengths as short sentences>],
  "improvements": [<2-4 specific improvements as short sentences>],
  "best_possible_score": <integer — highest achievable score given candidate background. Account for: cloud provider mismatches, domain gaps, missing certifications, seniority gaps>,
  "best_possible_reason": "<one sentence: specific gaps preventing higher score>",
  "verdict": "<one sentence overall assessment>"
}`;

// ── Helpers ───────────────────────────────────────────────────
function inferWorkType(text = "") {
  const t = text.toLowerCase();
  if (t.includes("remote")) return "Remote";
  if (t.includes("hybrid")) return "Hybrid";
  return "Onsite";
}

function jobHash(job) {
  const key = `${(job.company||"").toLowerCase().trim()}|${(job.title||"").toLowerCase().trim()}`;
  return crypto.createHash("md5").update(key).digest("hex");
}

// Maps a single HarvestAPI LinkedIn item to our internal schema.
// Real LinkedIn job IDs are used as primary keys (INSERT OR IGNORE — first write wins).
function normaliseItem(raw) {
  const company =
    raw.company?.name ||
    raw.companyName   ||
    raw.employer?.name ||
    "";

  const title = raw.title || raw.jobTitle || "";

  const description =
    raw.description?.text ||
    raw.descriptionText   ||
    (typeof raw.description === "string" ? raw.description : "") ||
    "";

  const descriptionHtml =
    raw.description?.html ||
    raw.descriptionHtml   ||
    null;

  const location =
    (typeof raw.location === "string" ? raw.location : "") ||
    (raw.location?.city && raw.location?.state
      ? `${raw.location.city}, ${raw.location.state}`
      : raw.location?.city || raw.location?.state || "") ||
    "United States";

  let workTypeHint = "";
  if (raw.workplaceType)                                              workTypeHint = String(raw.workplaceType).toLowerCase();
  else if (Array.isArray(raw.workplaceTypes) && raw.workplaceTypes.length) workTypeHint = raw.workplaceTypes[0].toLowerCase();
  else if (raw.remoteAllowed)                                         workTypeHint = "remote";

  const applyUrl =
    raw.applyMethod?.companyApplyUrl ||
    raw.applyUrl      ||
    raw.apply_url     ||
    raw.jobPostingUrl ||
    null;

  const url = raw.linkedinUrl || raw.url || raw.jobUrl || null;

  const postedAt =
    raw.listingDate ||
    raw.listedAt    ||
    raw.postedAt    ||
    raw.datePosted  ||
    null;

  const EMP_TYPE_MAP = {
    "full_time":  "full-time",
    "part_time":  "part-time",
    "full-time":  "full-time",
    "part-time":  "part-time",
    "contract":   "contract",
    "internship": "internship",
    "temporary":  "temporary",
    "temp":       "temporary",
    "other":      "full-time",
  };
  const rawJobType = (
    raw.contractType   ||
    raw.employmentType ||
    raw.jobType        ||
    ""
  ).toLowerCase().replace(/\s+/g, "_");
  const jobType = EMP_TYPE_MAP[rawJobType] || (rawJobType ? "full-time" : "");

  // Salary — HarvestAPI provides nested object or null
  const salaryMin      = raw.salary?.min      ?? null;
  const salaryMax      = raw.salary?.max      ?? null;
  const salaryCurrency = raw.salary?.currency || null;

  // Applicant count
  const applicantCount = raw.applicants ?? raw.applies ?? raw.applicantCount ?? null;

  // Company logo (use from HarvestAPI if available, otherwise clearbit fallback later)
  const companyLogoUrl = raw.company?.logo || raw.companyLogo || null;

  // Real LinkedIn job ID (string)
  const jobId = raw.id != null ? String(raw.id) : (raw.jobId != null ? String(raw.jobId) : null);

  return {
    _source: "LinkedIn",
    jobId,
    company,
    title,
    description,
    descriptionHtml,
    location,
    workTypeHint,
    applyUrl,
    url,
    postedAt,
    jobType,
    salaryMin,
    salaryMax,
    salaryCurrency,
    applicantCount,
    companyLogoUrl,
  };
}

function isFullTimeNorm(item) {
  const text = [item.title, item.jobType, item.description].join(" ").toLowerCase();
  return !NON_FULLTIME_TERMS.some(t => text.includes(t));
}

function isEmploymentTypeWanted(item, wantedTypes) {
  // If 3+ types selected, keep everything
  if (wantedTypes.length >= 3) return true;

  const text = [item.title, item.jobType, item.description].join(" ").toLowerCase();

  const signals = {
    "full-time":  ["full-time", "full time", "permanent"],
    "contract":   ["contract", "contractor", "freelance", "temp", "temporary"],
    "internship": ["intern", "internship", "co-op", "coop"],
  };

  // No type signal in text — assume full-time (most roles don't say it explicitly)
  const hasAnySignal = Object.values(signals).flat().some(s => text.includes(s));
  if (!hasAnySignal) return wantedTypes.includes("full-time");

  // Check if any wanted type's signals match
  return wantedTypes.some(type => signals[type]?.some(s => text.includes(s)));
}

function parseYearsExperience(description = "") {
  const patterns = [
    { re:/(\d+)\s*\+\s*years?\s+(?:of\s+)?experience/i,              type:"plus"  },
    { re:/(\d+)\s*[-–]\s*(\d+)\s*years?\s+(?:of\s+)?experience/i,   type:"range" },
    { re:/minimum\s+(\d+)\s*years?/i,                                type:"min"   },
    { re:/at\s+least\s+(\d+)\s*years?/i,                            type:"min"   },
    { re:/(\d+)\s*years?\s+(?:of\s+)?(?:relevant\s+)?experience/i,  type:"exact" },
  ];
  for (const { re, type } of patterns) {
    const m = description.match(re);
    if (m) {
      if (type === "range") return { min: Number(m[1]), max: Number(m[2]), raw: m[0] };
      if (type === "plus")  return { min: Number(m[1]), max: null,         raw: m[0] };
      return { min: Number(m[1]), max: Number(m[1]), raw: m[0] };
    }
  }
  return { min: null, max: null, raw: null };
}

function ghostJobScoreNorm(item) {
  let score = 0;
  const desc = item.description.toLowerCase();
  const url  = (item.url || "").toLowerCase();
  if (!url || url === "#")                                                score += 3;
  if (url.includes("linkedin.com/jobs/view") && !url.includes("apply")) score += 1;
  if (desc.length < 150)                                                 score += 2;
  if (!item.company || item.company === "Unknown")                       score += 2;
  if (item.title.toLowerCase().includes("multiple") ||
      item.title.toLowerCase().includes("various"))                      score += 2;
  return score;
}

function isReposted(job) {
  return ((job.title||"")+" "+(job.description||"")).toLowerCase().includes("reposted");
}

function encryptCookies(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", COOKIE_ENCRYPTION_KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { enc: enc.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decryptCookies(enc, iv, tag) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", COOKIE_ENCRYPTION_KEY, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(enc, "base64")), decipher.final()]).toString("utf8");
}

async function classifyJob(title, description = "") {
  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 30,
      messages: [{ role:"user", content:
        `Classify this job into the single best matching category from the list below.
If no category fits well, reply with exactly: Other

Categories: ${INDUSTRY_CATEGORIES.join(", ")}

Title: ${title}
Description: ${description.slice(0,600)}

Reply with the category name only. No explanation.` }],
    });
    const raw = msg.content.map(b => b.text||"").join("").trim();
    const match = INDUSTRY_CATEGORIES.find(c => raw.toLowerCase().includes(c.toLowerCase()));
    return match || "Other";
  } catch { return "Other"; }
}

// ── Company icon helpers ──────────────────────────────────────
function extractDomain(url) {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return null; }
}

async function fetchCompanyIcon(domain) {
  if (!domain) return null;
  const clearbitUrl = `https://logo.clearbit.com/${domain}`;
  try {
    const r = await fetch(clearbitUrl, { method:"HEAD", signal:AbortSignal.timeout(3000) });
    if (r.ok) return clearbitUrl;
  } catch {}
  // Fallback: Google S2 favicon (always returns an image)
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
}

// ── Scraping ──────────────────────────────────────────────────
// Actor: harvestapi/linkedin-job-search
// Returns real LinkedIn job IDs — INSERT OR IGNORE keeps first-write wins.
async function scrapeHarvestAPI(query, token, scrapeParams = {}) {
  if (!token) throw new Error("No Apify token");
  const client = new ApifyClient({ token });
  // QUERY BUILDING: scrapeParams.jobTitles (profile-driven array) takes priority over
  // the single query string. This allows multi-title searches from domain profiles.
  const jobTitles = (scrapeParams.jobTitles?.length)
    ? scrapeParams.jobTitles
    : [query];
  const input = {
    jobTitles,
    locations:      [scrapeParams.location      || "United States"],
    workplaceType:  scrapeParams.workplaceTypes?.length
                      ? scrapeParams.workplaceTypes
                      : ["remote", "hybrid", "office"],
    employmentType: scrapeParams.employmentTypes?.length
                      ? scrapeParams.employmentTypes
                      : ["full-time"],
    postedLimit:    scrapeParams.postedLimit     || "24h",
    maxItems:       MAX_JOBS_PER_REFRESH * 3,
  };
  console.log(`[scrape] Apify input: titles=[${jobTitles.join(",")}] workplaceType=${input.workplaceType} empType=${input.employmentType} postedLimit=${input.postedLimit} location=${input.locations[0]}`);
  const run = await client.actor("harvestapi/linkedin-job-search").call(input, { waitSecs: 300 });
  const dataset = await client.dataset(run.defaultDatasetId).listItems({ limit: MAX_JOBS_PER_REFRESH * 3 });
  const items = Array.isArray(dataset.items) ? dataset.items : [];
  console.log(`[scrape] HarvestAPI returned ${items.length} raw items`);
  items.forEach((item, i) => {
    const title   = item.title   ?? item.jobTitle   ?? "unknown";
    const company = item.company?.name ?? item.companyName ?? "unknown";
    const empType = item.contractType  ?? item.employmentType ?? item.jobType ?? "unknown";
    const wpType  = item.workplaceType ?? item.workplaceTypes?.[0] ?? "unknown";
    console.log(`[scrape] #${i+1} "${title}" @ ${company} | ${empType} | ${wpType}`);
  });
  return items;
}

async function scrapeJobs(query, apifyToken, scrapeParams = {}, domainProfileId = null) {
  const employmentTypes = scrapeParams.employmentTypes?.length ? scrapeParams.employmentTypes : ["full-time"];
  // TITLE RELEVANCE: if jobTitles array supplied (profile-driven), check against all targets.
  // Otherwise fall back to single-query isTitleRelevantNew.
  // Edit isTitleRelevantToProfile() in services/searchQueryBuilder.js to change matching logic.
  const profileTitles = scrapeParams.jobTitles?.length ? scrapeParams.jobTitles : null;
  // Derive userId from domainProfileId for ATS scoring and usage tracking
  const userId = domainProfileId
    ? (db.prepare("SELECT user_id FROM domain_profiles WHERE id=?").get(domainProfileId)?.user_id ?? null)
    : null;
  console.log(`[scrape] "${query}" — HarvestAPI (${profileTitles ? profileTitles.length + " profile titles" : "single query"})`);
  let rawItems = [];
  try {
    rawItems = await scrapeHarvestAPI(query, apifyToken, scrapeParams);
    console.log(`[scrape] HarvestAPI: ${rawItems.length} raw items`);
  } catch(e) {
    console.warn("[scrape] HarvestAPI failed:", e.message);
    throw e;
  }

  const combined = rawItems.map(j => normaliseItem(j));

  let cntNoTitle = 0, cntNoApply = 0, cntNotFT = 0, cntIrrelevant = 0, cntRepost = 0, cntGhost = 0, cntDup = 0;
  const thisRunIds    = new Set();
  const thisRunHashes = new Set();

  const filtered = combined.filter(item => {
    if (!item.title || !item.company || !item.jobId) { cntNoTitle++;  return false; }
    // Hard-drop: applyUrl is a LinkedIn-internal apply link (not an external ATS)
    // noExternalApplyUrl (Easy Apply) is counted but NOT dropped — many valid roles (PM, etc.) use Easy Apply
    if (item.applyUrl) {
      const applyDomain = extractDomain(item.applyUrl);
      if (applyDomain && applyDomain.includes("linkedin.com")) { cntNoApply++; return false; }
    }
    // Post-scrape contract filter — catches what Apify's filter misses
    // (staffing agency postings often slip through the API's employmentType param)
    if (!employmentTypes.includes("contract") && !employmentTypes.includes("temporary")) {
      const textCheck = [
        item.title,
        item.jobType,
        item.contractType,
        item.description?.slice(0, 200),
      ].join(" ").toLowerCase();
      const contractSignals = [
        "contract", "contractor", "contract-to-hire",
        "c2h", "c2c", "corp-to-corp", "w2 contract",
        "temporary", "temp-to-perm",
      ];
      if (contractSignals.some(s => textCheck.includes(s))) { cntNotFT++; return false; }
    }
    if (!isEmploymentTypeWanted(item, employmentTypes)) { cntNotFT++; return false; }
    const titleOk = profileTitles
      ? isTitleRelevantToProfile(item.title, profileTitles)
      : isTitleRelevantNew(item.title, query);
    if (!titleOk) { cntIrrelevant++; return false; }
    // Profile-aware title guard: second pass using profile's target_titles tokens.
    // Runs after the generic relevance check to catch cross-domain bleed
    // (e.g. "Nurse Educator" passing isTitleRelevantNew for a SWE profile).
    if (domainProfileId) {
      const profileRow = db.prepare(
        "SELECT target_titles FROM domain_profiles WHERE id=?"
      ).get(domainProfileId);
      const targetTitles = JSON.parse(profileRow?.target_titles || "[]");
      if (targetTitles.length > 0) {
        const titleLower = item.title.toLowerCase();
        const STOP = new Set(["the","and","for","with","senior","junior","staff","lead"]);
        const matches = targetTitles.some(target => {
          const tokens = target.toLowerCase()
            .split(/[\s/\-]+/)
            .filter(w => w.length > 2 && !STOP.has(w));
          return tokens.length === 0 || tokens.every(t => titleLower.includes(t));
        });
        if (!matches) { cntIrrelevant++; return false; }
      }
    }
    if (isReposted(item))                      { cntRepost++;     return false; }
    if (ghostJobScoreNorm({ ...item, url: item.applyUrl || item.url }) >= 4) { cntGhost++; return false; }
    if (thisRunIds.has(item.jobId))            { cntDup++;        return false; }
    thisRunIds.add(item.jobId);
    const h = jobHash(item);
    if (thisRunHashes.has(h))                  { cntDup++;        return false; }
    thisRunHashes.add(h);
    return true;
  });

  console.log(
    `[scrape] filtered: ${filtered.length}/${combined.length}` +
    ` (missingTitleOrCompany:${cntNoTitle} noExternalApplyUrl:${cntNoApply} notFullTime:${cntNotFT}` +
    ` titleIrrelevant:${cntIrrelevant} repost:${cntRepost} ghostScore:${cntGhost} duplicate:${cntDup})`
  );
  const classified = [];
  for (let i = 0; i < Math.min(filtered.length, MAX_JOBS_PER_REFRESH); i += 5) {
    const batch = filtered.slice(i, i + 5);
    const cats  = await Promise.all(batch.map(item => classifyJob(item.title, item.description)));
    batch.forEach((item, idx) => classified.push({ ...item, _category: cats[idx] }));
  }

  const nowUnix = Math.floor(Date.now() / 1000);

  const insertJob = db.prepare(`
    INSERT OR IGNORE INTO scraped_jobs
    (job_id, search_query, company, title, category, location,
     work_type, source, url, apply_url, posted_at, description, description_html,
     ghost_score, years_experience, min_years_exp, max_years_exp, exp_raw,
     is_frequent_repost, _hash, scraped_at, source_platform,
     salary_min, salary_max, salary_currency, applicant_count, company_icon_url,
     employment_type, domain_profile_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const insertMany = db.transaction((jobs) => {
    let inserted = 0;
    jobs.forEach(item => {
      const jobId   = item.jobId; // always a real LinkedIn job ID — synthetic IDs were removed
      const hash    = jobHash(item);
      const yoe     = parseYearsExperience(item.description);
      const wt      = inferWorkType(
        (item.workTypeHint || "") + " " + (item.location || "") + " " + (item.description || "")
      );
      const empType = item.jobType || null;
      const result = insertJob.run(
        jobId,
        query.toLowerCase(),
        item.company,
        item.title,
        item._category || "Other",
        item.location  || "United States",
        wt,
        "LinkedIn",
        item.url        || null,
        item.applyUrl   || null,
        item.postedAt   || null,
        item.description || null,
        item.descriptionHtml || null,
        ghostJobScoreNorm({ ...item, url: item.applyUrl || item.url }),
        yoe.min,          // years_experience (compat col — use min)
        yoe.min,
        yoe.max,
        yoe.raw,
        isReposted(item) ? 1 : 0,
        hash,
        nowUnix,
        "linkedin",
        item.salaryMin      || null,
        item.salaryMax      || null,
        item.salaryCurrency || null,
        item.applicantCount || null,
        item.companyLogoUrl || null,
        empType,
        domainProfileId,
      );
      if (result.changes > 0) inserted++;
      else if (domainProfileId) {
        db.prepare(`
          UPDATE scraped_jobs
          SET domain_profile_id = ?
          WHERE job_id = ? AND domain_profile_id IS NULL
        `).run(domainProfileId, jobId);
      }
    });
    return inserted;
  });

  const inserted = insertMany(classified);

  // ── ATS scoring for newly inserted jobs (D1) ──────────────────────────────
  // Score new jobs against the user's base resume using Haiku.
  // Non-fatal — job is still inserted if scoring fails.
  if (userId && ANTHROPIC_KEY) {
    setImmediate(async () => {
      try {
        const baseResumeRow = db.prepare("SELECT content FROM base_resume WHERE user_id=?").get(userId);
        const baseResumeText = baseResumeRow?.content;
        if (!baseResumeText) return; // No base resume — skip scoring

        // Find newly inserted jobs that have no ats_score yet
        const newlyInserted = classified.filter(item => {
          const row = db.prepare("SELECT ats_score FROM scraped_jobs WHERE job_id=?").get(item.jobId);
          return row && row.ats_score === null;
        });

        if (!newlyInserted.length) return;

        const updateAts = db.prepare(
          "UPDATE scraped_jobs SET ats_score=?, ats_report=? WHERE job_id=?"
        );

        for (let i = 0; i < newlyInserted.length; i += 5) {
          const batch = newlyInserted.slice(i, i + 5);
          await Promise.all(batch.map(async item => {
            try {
              const start = Date.now();
              const scoreMsg = await anthropic.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 900,
                system: ATS_SYSTEM_PROMPT,
                messages: [{ role: "user", content:
                  `JOB DESCRIPTION:\n${item.description || item.title}\n\nRESUME TEXT:\n${baseResumeText}` }],
              });
              const raw = scoreMsg.content.map(b => b.text || "").join("")
                .replace(/```json|```/g, "").trim();
              const report = JSON.parse(raw);
              updateAts.run(report.score, JSON.stringify(report), item.jobId);
              trackApiCall(db, {
                userId,
                eventType: "ats_score",
                eventSubtype: "scrape_time",
                model: "claude-haiku-4-5-20251001",
                usage: scoreMsg.usage,
                durationMs: Date.now() - start,
                jobId: item.jobId,
                company: item.company,
              });
            } catch(e) {
              console.warn(`[scrape] ATS score failed for ${item.jobId}:`, e.message);
            }
          }));
        }
      } catch(e) {
        console.warn("[scrape] ATS batch scoring failed:", e.message);
      }
    });
  }

  // ── Async clearbit icon fallback (non-blocking, only for jobs without a logo) ──
  setImmediate(async () => {
    const updateIcon = db.prepare(
      "UPDATE scraped_jobs SET company_icon_url=? WHERE _hash=? AND company_icon_url IS NULL"
    );
    for (const item of classified) {
      if (item.companyLogoUrl) continue; // HarvestAPI already provided a logo
      try {
        const domain  = extractDomain(item.url);
        const iconUrl = await fetchCompanyIcon(domain);
        if (iconUrl) updateIcon.run(iconUrl, jobHash(item));
      } catch {}
    }
  });

  console.log(`[scrape] ✓ "${query}" — ${inserted} inserted, ${classified.length} classified, ${filtered.length} passed filter of ${combined.length} total`);
  return {
    classified,
    rawCount: rawItems.length,
    filteredCount: filtered.length,
    insertedCount: inserted,
    duplicateCount: cntDup,
    ghostCount: cntGhost,
    irrelevantCount: cntIrrelevant,
  };
}

// ── Cron: daily backup 02:00, re-scrape 07:00, cleanup 03:00 ──
cron.schedule("0 3 * * *", () => {
  const cutoff = Math.floor(Date.now()/1000) - 7*24*60*60;
  // Delete jobs older than 7 days based on original posting date (scraped_at as fallback).
  // Applied jobs are permanently exempt from expiry.
  const deletedJobs = db.prepare(`
    DELETE FROM scraped_jobs
    WHERE (
      (posted_at IS NOT NULL AND posted_at != ''
        AND CAST(strftime('%s', posted_at) AS INTEGER) < ?)
      OR ((posted_at IS NULL OR posted_at = '') AND scraped_at < ?)
    )
    AND job_id NOT IN (
      SELECT DISTINCT job_id FROM user_jobs WHERE applied = 1
    )
  `).run(cutoff, cutoff);

  // Cascade: remove orphaned user records for expired jobs (exempt applied rows)
  const deletedViews = db.prepare(
    "DELETE FROM user_job_views WHERE job_id NOT IN (SELECT job_id FROM scraped_jobs)"
  ).run();
  const deletedUserJobs = db.prepare(
    "DELETE FROM user_jobs WHERE job_id NOT IN (SELECT job_id FROM scraped_jobs) AND applied != 1"
  ).run();

  // Clean orphaned resumes/versions for expired jobs (preserve applied-job data)
  const deletedResumes = db.prepare(`
    DELETE FROM resumes
    WHERE job_id NOT IN (SELECT job_id FROM scraped_jobs)
    AND job_id NOT IN (SELECT DISTINCT job_id FROM user_jobs WHERE applied = 1)
  `).run();
  const deletedVersions = db.prepare(`
    DELETE FROM resume_versions
    WHERE job_id NOT IN (SELECT job_id FROM scraped_jobs)
    AND job_id NOT IN (SELECT DISTINCT job_id FROM user_jobs WHERE applied = 1)
  `).run();

  const orphans = deletedViews.changes + deletedUserJobs.changes
                + deletedResumes.changes + deletedVersions.changes;

  const details = JSON.stringify({
    resumes: deletedResumes.changes,
    resumeVersions: deletedVersions.changes,
    userJobs: deletedUserJobs.changes,
    userJobViews: deletedViews.changes,
  });
  db.prepare(
    "INSERT INTO cleanup_log (jobs_deleted, orphans_cleaned, details) VALUES (?,?,?)"
  ).run(deletedJobs.changes, orphans, details);

  console.log(`[cleanup] Expired ${deletedJobs.changes} jobs (by posting date), pruned ${orphans} orphaned rows`);
});

cron.schedule("0 2 * * *", () => {
  try { createBackup("auto-daily"); }
  catch(e) { console.error("[backup-cron]", e.message); }
});

cron.schedule("0 7 * * *", async () => {
  const last = db.prepare(`
    SELECT ujs.search_query, ujs.user_id, dp.id as profile_id
    FROM user_job_searches ujs
    JOIN domain_profiles dp ON dp.user_id = ujs.user_id AND dp.is_active = 1
    ORDER BY ujs.last_scraped_at DESC LIMIT 1
  `).get();
  if (!last) return;
  const recent = db.prepare(
    "SELECT apify_token FROM users WHERE id=?"
  ).get(last.user_id);
  if (!recent?.apify_token) {
    console.log("[cron] Skipping daily re-scrape — no user Apify token available");
    return;
  }
  try {
    await scrapeJobs(last.search_query, recent.apify_token, {
      workplaceTypes:  ["remote", "hybrid", "office"],
      employmentTypes: ["full-time"],
      location:        "United States",
      postedLimit:     "24h",
    }, last.profile_id);
  }
  catch(e) { console.error("[cron]", e.message); }
});

// ── Prompt injection ──────────────────────────────────────────
// domainProfile is the active domain_profiles row (or null).
// When supplied, profile keywords/verbs/tools are injected as Tier 1 signal.
function buildRuntimeInputs(profile, job, resumeText, mode, employers, domainProfile = null) {
  const userLocation = mode === "CUSTOM_SAMPLER" ? "" : (profile?.location||"");
  let employerBlock  = "";
  // Apply exclusion list before injecting employer names into prompt
  const safeEmployers = sanitiseEmployers(employers);
  if (mode === "TAILORED" && safeEmployers?.length >= 2)
    employerBlock = `**Employer 1 (fixed):** ${safeEmployers[0]}\n**Employer 2 (fixed):** ${safeEmployers[1]}\n`;

  const candidateName = profile?.full_name ||
    [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || "";

  // Domain profile block — injected when user has an active profile
  let domainProfileBlock = "";
  if (domainProfile) {
    const kw    = JSON.parse(domainProfile.selected_keywords || "[]").join(", ");
    const tools = JSON.parse(domainProfile.selected_tools    || "[]").join(", ");
    const verbs = JSON.parse(domainProfile.selected_verbs    || "[]").join(", ");
    domainProfileBlock = `
**User domain profile:** ${domainProfile.profile_name}
**Target seniority:** ${domainProfile.seniority}
**Profile keywords:** ${kw || "—"}
**Profile tools:** ${tools || "—"}
**Profile action verbs:** ${verbs || "—"}
`;
  }

  return `## RUNTIME INPUTS

**Mode:** ${mode}
**Candidate full name:** ${candidateName}
**Phone:** ${profile?.phone||""}
**Email:** ${profile?.email||""}
**LinkedIn URL:** ${profile?.linkedin_url||""}
**GitHub URL:** ${profile?.github_url||""}
**User location (City, State):** ${userLocation}
${employerBlock}${domainProfileBlock}
**Target role / job title:** ${job.title}
**Target industry / domain:** ${job.category && job.category !== "Other" ? job.category : job.title || "Technology"}
**Target company:** ${job.company}
**Known tech stack of target company:** ${job.stack||"unknown"}

---

**TARGET JOB DESCRIPTION**
${job.description||job.title}

---

**BASE RESUME TEXT**
${resumeText}`;
}

// ── PDF generation ─────────────────────────────────────────────
//
// CURRENT: @sparticuz/chromium + puppeteer-core
// Lightweight Chromium binary, single Railway service.
// Per-call RAM spike: ~70MB. Safe for low-to-medium traffic.
//
// ── FUTURE MIGRATION PATH → Gotenberg ─────────────────────────
// When scaling to SaaS (concurrent PDF exports, 100+ users):
// Gotenberg runs Chromium as a persistent Docker sidecar — zero
// per-call RAM spike, handles concurrency natively.
//
// Migration steps (when ready):
//   1. In Railway: "+ New Service" → Docker Image → gotenberg/gotenberg:8
//   2. Add env var to main service: GOTENBERG_URL=<railway internal URL>
//   3. npm uninstall @sparticuz/chromium puppeteer-core
//   4. npm install  (form-data is built into Node 18+ via FormData global)
//   5. Replace this entire function with:
//
//   async function htmlToPdf(html) {
//     const GOTENBERG_URL = process.env.GOTENBERG_URL;
//     if (!GOTENBERG_URL) throw new Error("GOTENBERG_URL not set");
//     const fullHtml = html.includes("<html") ? html
//       : `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
//     const form = new FormData();
//     form.append("files", new Blob([fullHtml], { type:"text/html" }),
//       "index.html");
//     form.append("paperWidth",      "8.5");
//     form.append("paperHeight",     "11");
//     form.append("marginTop",       "0.5");
//     form.append("marginBottom",    "0.5");
//     form.append("marginLeft",      "0.5");
//     form.append("marginRight",     "0.5");
//     form.append("printBackground", "true");
//     const r = await fetch(
//       `${GOTENBERG_URL}/forms/chromium/convert/html`,
//       { method:"POST", body:form }
//     );
//     if (!r.ok) throw new Error(`Gotenberg: ${r.status} ${await r.text()}`);
//     return Buffer.from(await r.arrayBuffer());
//   }
//
//   6. Remove the chromium + puppeteer-core imports above
//   7. Delete this comment block
// ──────────────────────────────────────────────────────────────

async function htmlToPdf(html) {
  // Ensure doctype for correct browser rendering
  if (!html.trimStart().toLowerCase().startsWith("<!doctype")) {
    html = "<!DOCTYPE html>" + html;
  }

  // On Windows, @sparticuz/chromium provides a Linux ELF binary that cannot run.
  // Detect Windows and use the system Chrome installation instead.
  const isWindows = process.platform === "win32";
  let executablePath, launchArgs;

  if (isWindows) {
    const winPaths = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
    ];
    const fs = await import("fs");
    executablePath = winPaths.find(p => { try { return fs.existsSync(p); } catch { return false; } });
    if (!executablePath) throw new Error("Chrome not found on Windows. Install Chrome to enable PDF export.");
    launchArgs = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];
  } else {
    executablePath = await chromium.executablePath();
    console.log(`[pdf] chromium path: ${executablePath}`);
    launchArgs = [...chromium.args, "--single-process"];
  }

  const browser = await puppeteer.launch({
    args:            launchArgs,
    defaultViewport: isWindows ? { width:1240, height:1754 } : chromium.defaultViewport,
    executablePath,
    headless:        isWindows ? true : chromium.headless,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width:1240, height:1754 });
    await page.setContent(html, { waitUntil:"networkidle0", timeout:30000 });
    // Wait for fonts to settle
    await new Promise(r => setTimeout(r, 1500));
    const pdf = await page.pdf({
      format:           "Letter",
      printBackground:  true,
      preferCSSPageSize:false,
      margin: {
        top:    "0.5in",
        bottom: "0.5in",
        left:   "0.5in",
        right:  "0.5in",
      },
    });
    if (!pdf || pdf.length === 0) throw new Error("PDF generation produced empty output");
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// ── Field normalisers (server-side, mirrors client normalisers) ──
function normalisePhone(raw) {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  const local  = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (local.length !== 10) return raw;
  return `+1 (${local.slice(0,3)}) ${local.slice(3,6)}-${local.slice(6)}`;
}
function normaliseUrl(raw) {
  if (!raw) return "";
  const t = raw.trim();
  if (!t) return "";
  return t.startsWith("http://") || t.startsWith("https://") ? t : "https://" + t;
}

// ── Autofill payload builder ──────────────────────────────────
function buildAutofillPayload(profile, mode) {
  const loc   = mode==="CUSTOM_SAMPLER" ? "" : (profile?.location||"");
  const city  = mode==="CUSTOM_SAMPLER" ? "" : (profile?.city||loc.split(",")[0]?.trim()||"");
  const state = mode==="CUSTOM_SAMPLER" ? "" : (profile?.state||loc.split(",")[1]?.trim()||"");

  const phone       = normalisePhone(profile?.phone||"");
  const linkedinUrl = normaliseUrl(profile?.linkedin_url||"");
  const githubUrl   = normaliseUrl(profile?.github_url||"");

  const nameParts  = (profile?.full_name||"").trim().split(/\s+/).filter(Boolean);
  const firstName  = profile?.first_name  || nameParts[0] || "";
  const lastName   = profile?.last_name   || (nameParts.length > 1 ? nameParts[nameParts.length - 1] : "");
  const middleName = profile?.middle_name || (nameParts.length > 2 ? nameParts.slice(1, -1).join(" ") : "");
  const suffix     = profile?.name_suffix || "";

  return {
    full_name:profile?.full_name||"", email:profile?.email||"", phone,
    location:loc, linkedin_url:linkedinUrl, github_url:githubUrl,
    requires_sponsorship:!!profile?.requires_sponsorship,
    has_clearance:!!profile?.has_clearance,
    clearance_level:profile?.clearance_level||"",
    visa_type:profile?.visa_type||"", work_auth:profile?.work_auth||"",
    field_map:{
      first_name:firstName, firstName, fname:firstName, given_name:firstName,
      last_name:lastName,   lastName,  lname:lastName,  family_name:lastName, surname:lastName,
      middle_name:middleName, middleName, middle:middleName,
      suffix, name_suffix:suffix, nameSuffix:suffix,
      name:profile?.full_name||"", fullName:profile?.full_name||"", full_name:profile?.full_name||"",
      email:profile?.email||"", email_address:profile?.email||"", emailAddress:profile?.email||"",
      phone, phone_number:phone, phoneNumber:phone, mobile:phone, telephone:phone,
      location:loc, city, state,
      zip:profile?.zip||"", zipCode:profile?.zip||"", postal_code:profile?.zip||"", postalCode:profile?.zip||"",
      country:profile?.country||"United States",
      address:profile?.address_line1||"", address_line1:profile?.address_line1||"", addressLine1:profile?.address_line1||"",
      address_line2:profile?.address_line2||"", addressLine2:profile?.address_line2||"",
      linkedin:linkedinUrl, linkedinUrl, linkedin_url:linkedinUrl, linkedin_profile:linkedinUrl,
      github:githubUrl, githubUrl, github_url:githubUrl,
      website:githubUrl||linkedinUrl||"",
      gender:profile?.gender||"", ethnicity:profile?.ethnicity||"", race:profile?.ethnicity||"",
      veteran_status:profile?.veteran_status||"", veteranStatus:profile?.veteran_status||"",
      disability_status:profile?.disability_status||"", disabilityStatus:profile?.disability_status||"",
      visa_type:profile?.visa_type||"", visaType:profile?.visa_type||"",
      work_authorization:profile?.work_auth||"", workAuthorization:profile?.work_auth||"",
      requires_sponsorship:profile?.requires_sponsorship?"Yes":"No",
      sponsorship:profile?.requires_sponsorship?"Yes":"No",
      clearance_level:profile?.clearance_level||"", clearanceLevel:profile?.clearance_level||"",
      has_clearance:profile?.has_clearance?"Yes":"No",
    },
    dropdown_map:{
      gender:   profile?.gender          ? [profile.gender]          : [],
      work_auth:profile?.work_auth       ? [profile.work_auth]        : [],
      clearance:profile?.clearance_level ? [profile.clearance_level]  : [],
    },
  };
}

// ── Auth ──────────────────────────────────────────────────────
const SQLiteStore = SQLiteStoreFactory(session);
const SStore = new SQLiteStore({ db:"sessions.db", dir:path.join(__dirname,"data") });

passport.use(new LocalStrategy((username, password, done) => {
  const user = db.prepare("SELECT * FROM users WHERE username=?").get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return done(null, false, { message:"Invalid credentials." });
  return done(null, { id:user.id, username:user.username, isAdmin:!!user.is_admin, applyMode:user.apply_mode, domainProfileComplete:!!user.domain_profile_complete });
}));
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const user = db.prepare("SELECT id,username,is_admin,apply_mode,domain_profile_complete FROM users WHERE id=?").get(id);
  user ? done(null, { id:user.id, username:user.username, isAdmin:!!user.is_admin, applyMode:user.apply_mode, domainProfileComplete:!!user.domain_profile_complete })
       : done(new Error("User not found"));
});

function requireAuth(req, res, next)  { if (req.isAuthenticated()) return next(); res.status(401).json({ error:"Unauthorized." }); }
function requireAdmin(req, res, next) { if (req.isAuthenticated()&&req.user.isAdmin) return next(); res.status(403).json({ error:"Forbidden." }); }

// assertUserOwns — use this when fetching a record by ID WITHOUT user_id in the
// WHERE clause, then verifying ownership. Returns the row on success; sends the
// appropriate error response and returns null if the check fails.
// NOTE: Most routes in this file use the safer pattern:
//   WHERE user_id=? AND id=?  ← returns null for both "not found" and "not yours"
// which leaks no information about whether the record exists. assertUserOwns is
// most useful for admin-adjacent lookups or any future route that must fetch a
// shared resource then check whether the caller may mutate it.
function assertUserOwns(row, userId, res) {
  if (!row) { res.status(404).json({ error:"Not found" }); return null; }
  if (row.user_id !== userId) { res.status(403).json({ error:"Forbidden" }); return null; }
  return row;
}

function resolveUserJobDomainProfileId(userId, jobId) {
  const existing = db.prepare(`
    SELECT uj.domain_profile_id
    FROM user_jobs uj
    JOIN domain_profiles dp ON dp.id = uj.domain_profile_id AND dp.user_id = uj.user_id
    JOIN scraped_jobs sj ON sj.job_id = uj.job_id AND sj.domain_profile_id = uj.domain_profile_id
    WHERE uj.user_id=? AND uj.job_id=?
  `).get(userId, String(jobId));
  if (existing?.domain_profile_id) return existing.domain_profile_id;

  const scraped = db.prepare(`
    SELECT sj.domain_profile_id
    FROM scraped_jobs sj
    JOIN domain_profiles dp ON dp.id = sj.domain_profile_id
    WHERE sj.job_id = ? AND dp.user_id = ?
  `).get(String(jobId), userId);
  return scraped?.domain_profile_id ?? null;
}

// ── Express ───────────────────────────────────────────────────
const app = express();
// Active scrapes: key = "userId:query", value = { startedAt, done }
// Polled by GET /api/jobs/poll to determine if a background scrape is still running.
const activeScrapes = new Map();

// SYNC CLIENTS: in-memory SSE registry.
// Clients reconnect on server restart automatically.
// To add a new sync event type: call emitToUser() from the relevant route handler
// and handle the event type in the frontend useSyncEvents hook.
const syncClients = new Map(); // key: userId, value: Set of res objects

function emitToUser(userId, event) {
  const clients = syncClients.get(userId);
  if (!clients?.size) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  clients.forEach(res => {
    try { res.write(data); }
    catch(e) { clients.delete(res); }
  });
}
// trust proxy: required for Railway/Render — without this, secure: true cookies
// fail behind their HTTPS reverse proxy and all sessions silently break.
app.set("trust proxy", 1);
app.use(cors({ origin:true, credentials:true }));
app.use(express.json({ limit:"4mb" }));
// TODO: reduce cookie maxAge to 30 min + implement sliding renewal
// once useInactivityLogout (30-min idle) is deployed on the client.
app.use(session({
  store: SStore,
  secret:SESSION_SECRET, resave:false, saveUninitialized:false,
  cookie:{ maxAge:7*24*60*60*1000, httpOnly:true, secure:process.env.NODE_ENV==="production", sameSite:"lax" },
}));
app.use(passport.initialize());
app.use(passport.session());

const CLIENT_DIST = path.join(__dirname,"client","dist");
if (fs.existsSync(CLIENT_DIST)) app.use(express.static(CLIENT_DIST));

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════
app.post("/api/auth/login", (req, res, next) => {
  passport.authenticate("local", (err, user, info) => {
    if (err)   return next(err);
    if (!user) return res.status(401).json({ error:info?.message||"Invalid credentials." });
    req.logIn(user, e => e ? next(e) : res.json({ ok:true, user:{ id:user.id, username:user.username, isAdmin:user.isAdmin, applyMode:user.applyMode, domainProfileComplete:user.domainProfileComplete } }));
  })(req, res, next);
});

app.post("/api/auth/register", (req, res) => {
  const { username, password, profile={}, apifyToken } = req.body;
  if (!username||!password) return res.status(400).json({ error:"username and password required" });
  if (password.length < 8)  return res.status(400).json({ error:"password must be at least 8 characters" });
  if (!profile.email)       return res.status(400).json({ error:"email is required" });
  if (!profile.first_name)  return res.status(400).json({ error:"first name is required" });
  if (!profile.last_name)   return res.status(400).json({ error:"last name is required" });

  // Build full_name from parts for backwards compat
  const fullName = [
    profile.first_name?.trim(),
    profile.middle_name?.trim() || null,
    profile.last_name?.trim(),
    profile.name_suffix?.trim() || null,
  ].filter(Boolean).join(" ");

  try {
    db.prepare("INSERT INTO users (username,password_hash,is_admin,apply_mode) VALUES (?,?,0,'TAILORED')")
      .run(username, bcrypt.hashSync(password, 10));
    const newUser = db.prepare("SELECT id FROM users WHERE username=?").get(username);
    db.prepare(`INSERT INTO user_profile
      (user_id,full_name,first_name,middle_name,last_name,name_suffix,
       email,phone,linkedin_url,github_url,location,
       address_line1,address_line2,city,state,zip,country,
       gender,ethnicity,veteran_status,disability_status,
       requires_sponsorship,has_clearance,clearance_level,visa_type,work_auth)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        newUser.id,
        fullName||null,
        profile.first_name||null, profile.middle_name||null,
        profile.last_name||null,  profile.name_suffix||null,
        profile.email||null, profile.phone||null,
        profile.linkedin_url||null, profile.github_url||null,
        profile.city&&profile.state ? `${profile.city}, ${profile.state}` : (profile.location||null),
        profile.address_line1||null, profile.address_line2||null,
        profile.city||null, profile.state||null, profile.zip||null, profile.country||"United States",
        profile.gender||null, profile.ethnicity||null,
        profile.veteran_status||null, profile.disability_status||null,
        profile.requires_sponsorship?1:0, profile.has_clearance?1:0,
        profile.clearance_level||null, profile.visa_type||null, profile.work_auth||null
      );
    db.prepare("UPDATE users SET apify_token=? WHERE id=?").run(apifyToken||null, newUser.id);
    const sessionUser = { id:newUser.id, username, isAdmin:false, applyMode:"TAILORED", domainProfileComplete:false };
    req.logIn(sessionUser, e => {
      if (e) return res.status(500).json({ error:"Account created but login failed. Please sign in." });
      res.json({ ok:true, user:sessionUser });
    });
  } catch(e) {
    res.status(400).json({ error:e.message.includes("UNIQUE")?"Username already taken.":e.message });
  }
});

app.post("/api/auth/logout", (req, res) => req.logout(() => res.json({ ok:true })));

app.get("/api/auth/me", (req, res) =>
  req.isAuthenticated()
    ? res.json({ authenticated:true, user:{ id:req.user.id, username:req.user.username, isAdmin:req.user.isAdmin, applyMode:req.user.applyMode, domainProfileComplete:req.user.domainProfileComplete } })
    : res.json({ authenticated:false })
);

// ═══════════════════════════════════════════════════════════════
// DOMAIN PROFILES
// ═══════════════════════════════════════════════════════════════
// /api/domain-profiles        — CRUD + activate
// /api/domain-profiles/metadata[/:domain]  — registry (no auth)
// /api/domain-profiles/generate-chips      — AI chip generation
app.use("/api/domain-profiles", requireAuth, createDomainProfilesRouter(db, anthropic, emitToUser));
// Metadata is also public — mount without requireAuth at a sub-path so
// the chip registry is accessible from the wizard before login
app.get("/api/domain-metadata",       (_req, res) => res.redirect(307, "/api/domain-profiles/metadata"));
app.get("/api/domain-metadata/:key",  (req, res) => res.redirect(307, `/api/domain-profiles/metadata/${req.params.key}`));

// Mark onboarding complete (called by wizard on profile save, also done inside createDomainProfilesRouter)
app.patch("/api/auth/complete-profile", requireAuth, (req, res) => {
  db.prepare("UPDATE users SET domain_profile_complete=1 WHERE id=?").run(req.user.id);
  res.json({ ok: true });
});


// ═══════════════════════════════════════════════════════════════
// MULTI-SESSION SYNC — Server-Sent Events
// ═══════════════════════════════════════════════════════════════
app.get("/api/sync/events", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  const userId = req.user.id;
  if (!syncClients.has(userId)) syncClients.set(userId, new Set());
  syncClients.get(userId).add(res);
  res.write('data: {"type":"connected"}\n\n');
  const heartbeat = setInterval(() => {
    try { res.write('data: {"type":"heartbeat"}\n\n'); }
    catch { clearInterval(heartbeat); }
  }, 30000);
  req.on("close", () => {
    clearInterval(heartbeat);
    syncClients.get(userId)?.delete(res);
  });
});

// ═══════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════

// Helper: insert a notification and emit SSE so badges update live.
function insertNotification(userId, type, message, payload = null) {
  try {
    const row = db.prepare(
      "INSERT INTO notifications (user_id, type, message, payload) VALUES (?,?,?,?)"
    ).run(userId, type, message, payload ? JSON.stringify(payload) : null);
    emitToUser(userId, { type: "notification", id: row.lastInsertRowid, notif_type: type, message });
  } catch(e) {
    console.warn("[notification] insert failed:", e.message);
  }
}

app.get("/api/notifications", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, type, message, payload, read, created_at
    FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id);
  const unreadCount = rows.filter(r => !r.read).length;
  res.json({ notifications: rows, unreadCount });
});

app.patch("/api/notifications/read-all", requireAuth, (req, res) => {
  db.prepare("UPDATE notifications SET read=1 WHERE user_id=?").run(req.user.id);
  res.json({ ok: true });
});

// Must be after /read-all to avoid route collision
app.patch("/api/notifications/:id/read", requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const row = db.prepare("SELECT id FROM notifications WHERE id=? AND user_id=?").get(id, req.user.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  db.prepare("UPDATE notifications SET read=1 WHERE id=?").run(id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════
// DOCK PREFERENCES
// ═══════════════════════════════════════════════════════════════

const DEFAULT_DOCK_ITEMS = ["profile_switcher","notifications","quick_actions","settings","user_avatar"];

app.get("/api/dock-preferences", requireAuth, (req, res) => {
  const row = db.prepare("SELECT items_json, dock_enabled FROM dock_preferences WHERE user_id=?").get(req.user.id);
  if (!row) return res.json({ itemsOrder: DEFAULT_DOCK_ITEMS, dockEnabled: true });
  let itemsOrder;
  try { itemsOrder = JSON.parse(row.items_json); } catch { itemsOrder = DEFAULT_DOCK_ITEMS; }
  res.json({ itemsOrder, dockEnabled: !!row.dock_enabled });
});

app.put("/api/dock-preferences", requireAuth, (req, res) => {
  const VALID_KEYS = new Set(["profile_switcher","notifications","quick_actions","settings","user_avatar"]);
  let { itemsOrder, dockEnabled } = req.body;
  if (!Array.isArray(itemsOrder)) return res.status(400).json({ error: "itemsOrder must be array" });
  // Validate keys
  if (!itemsOrder.every(k => VALID_KEYS.has(k))) return res.status(400).json({ error: "Invalid item key" });
  // Ensure user_avatar is last
  itemsOrder = itemsOrder.filter(k => k !== "user_avatar");
  itemsOrder.push("user_avatar");
  // Ensure settings is present
  if (!itemsOrder.includes("settings")) itemsOrder.splice(itemsOrder.length - 1, 0, "settings");
  db.prepare(`
    INSERT INTO dock_preferences (user_id, items_json, dock_enabled, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET items_json=excluded.items_json,
      dock_enabled=excluded.dock_enabled, updated_at=excluded.updated_at
  `).run(req.user.id, JSON.stringify(itemsOrder), dockEnabled ? 1 : 0);
  res.json({ itemsOrder, dockEnabled: !!dockEnabled });
});

// ═══════════════════════════════════════════════════════════════
// ADMIN BACKUP / RESTORE
// ═══════════════════════════════════════════════════════════════
app.get("/api/admin/backups", requireAdmin, (_req, res) => {
  try { res.json(listBackups()); } catch(e) { res.status(500).json({ error:e.message }); }
});
app.post("/api/admin/backups", requireAdmin, (req, res) => {
  try {
    const result = createBackup(req.body.label||"manual");
    res.json({ ok:true, ...result });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.post("/api/admin/backups/restore", requireAdmin, (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error:"filename required" });
  try {
    const result = restoreBackup(filename);
    res.json({ ok:true, ...result, message:"Restore complete. Restart the server to apply." });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN USER MANAGEMENT
// ═══════════════════════════════════════════════════════════════
app.get("/api/admin/users", requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT id,username,is_admin,apply_mode,created_at FROM users ORDER BY created_at DESC").all());
});
app.post("/api/admin/users", requireAdmin, (req, res) => {
  const { username, password, isAdmin } = req.body;
  if (!username||!password) return res.status(400).json({ error:"username and password required" });
  try {
    db.prepare("INSERT INTO users (username,password_hash,is_admin) VALUES (?,?,?)")
      .run(username, bcrypt.hashSync(password,10), isAdmin?1:0);
    const u = db.prepare("SELECT id FROM users WHERE username=?").get(username);
    db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").run(u.id);
    res.json({ ok:true });
  } catch(e) { res.status(400).json({ error:e.message.includes("UNIQUE")?"Username taken":e.message }); }
});
app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (id===req.user.id) return res.status(400).json({ error:"Cannot delete yourself" });
  db.prepare("DELETE FROM users WHERE id=?").run(id);
  res.json({ ok:true });
});
app.patch("/api/admin/users/:id/password", requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error:"password required" });
  db.prepare("UPDATE users SET password_hash=? WHERE id=?")
    .run(bcrypt.hashSync(password,10), parseInt(req.params.id));
  res.json({ ok:true });
});
app.get("/api/admin/users/:id/profile", requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(parseInt(req.params.id))||{});
});
app.get("/api/admin/users/:id/applications", requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT * FROM job_applications WHERE user_id=? ORDER BY applied_at DESC").all(parseInt(req.params.id)));
});
// (quota reset routes removed — no refresh cap)

// Analytics admin routes (usage tracking, limits, timeseries)
app.use("/api/admin/analytics", createAdminRouter(db));
app.use("/api/admin/db", createAdminDbRouter(db, { dbPath: DB_PATH, scrapeJobs }));

// ═══════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════
app.patch("/api/settings/apply-mode", requireAuth, (req, res) => {
  const { mode } = req.body;
  if (!["SIMPLE","TAILORED","CUSTOM_SAMPLER"].includes(mode))
    return res.status(400).json({ error:"Invalid mode" });
  db.prepare("UPDATE users SET apply_mode=? WHERE id=?").run(mode, req.user.id);
  res.json({ ok:true, mode });
});
// Save user's personal Apify token (per-user — no server-level token exists)
app.patch("/api/settings/apify-token", requireAuth, (req, res) => {
  const token = (req.body.token||"").trim() || null;
  db.prepare("UPDATE users SET apify_token=? WHERE id=?").run(token, req.user.id);
  res.json({ ok:true });
});
// Clear user's Apify token
app.delete("/api/settings/apify-token", requireAuth, (req, res) => {
  db.prepare("UPDATE users SET apify_token=NULL WHERE id=?").run(req.user.id);
  res.json({ ok:true });
});
app.get("/api/settings", requireAuth, (req, res) => {
  const u = db.prepare("SELECT apply_mode,apify_token FROM users WHERE id=?").get(req.user.id);
  res.json({ applyMode:u?.apply_mode, hasApifyToken:!!u?.apify_token });
});

// ═══════════════════════════════════════════════════════════════
// PROFILE
// ═══════════════════════════════════════════════════════════════
app.get("/api/profile", requireAuth, (req, res) => {
  db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").run(req.user.id);
  res.json(db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(req.user.id)||{});
});
app.post("/api/profile", requireAuth, (req, res) => {
  const f = req.body;
  db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").run(req.user.id);
  db.prepare(`UPDATE user_profile SET
    full_name=?,email=?,phone=?,linkedin_url=?,github_url=?,location=?,
    address_line1=?,address_line2=?,city=?,state=?,zip=?,country=?,
    gender=?,ethnicity=?,veteran_status=?,disability_status=?,
    requires_sponsorship=?,has_clearance=?,clearance_level=?,
    visa_type=?,work_auth=?,updated_at=unixepoch() WHERE user_id=?`
  ).run(
    f.full_name||null,f.email||null,f.phone||null,f.linkedin_url||null,f.github_url||null,f.location||null,
    f.address_line1||null,f.address_line2||null,f.city||null,f.state||null,f.zip||null,f.country||"United States",
    f.gender||null,f.ethnicity||null,f.veteran_status||null,f.disability_status||null,
    f.requires_sponsorship?1:0,f.has_clearance?1:0,f.clearance_level||null,
    f.visa_type||null,f.work_auth||null,req.user.id
  );
  res.json({ ok:true });
});

// ═══════════════════════════════════════════════════════════════
// AUTOFILL
// ═══════════════════════════════════════════════════════════════
app.get("/api/autofill", requireAuth, (req, res) => {
  db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").run(req.user.id);
  const profile = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(req.user.id)||{};
  res.json(buildAutofillPayload(profile, req.user.applyMode));
});
app.get("/api/extension/autofill", requireAuth, (req, res) => {
  db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").run(req.user.id);
  const profile = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(req.user.id)||{};
  res.json({ ok:true, mode:req.user.applyMode, ...buildAutofillPayload(profile, req.user.applyMode) });
});

// ═══════════════════════════════════════════════════════════════
// ── /api/jobs/facets — live counts for filter UI ──────────────
// Returns grouped counts over the current user's job pool (7-day window,
// non-disliked, non-applied). Used to show "Remote (23)" labels and hide
// zero-count filter options. Re-fetch after each scrape completes.
app.get("/api/jobs/facets", requireAuth, (req, res) => {
  const userId = req.user.id;
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const facetProfile = db.prepare("SELECT id FROM domain_profiles WHERE user_id=? AND is_active=1").get(userId);
  if (!facetProfile) {
    return res.json({ workType:{}, employmentType:{}, category:{}, postedAge:{}, salaryRange:null, total:0 });
  }
  const rows = db.prepare(`
    SELECT sj.work_type, sj.employment_type, sj.category,
           sj.scraped_at, sj.posted_at, sj.salary_min, sj.salary_max
    FROM scraped_jobs sj
    JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ?
    WHERE (uj.disliked IS NULL OR uj.disliked = 0)
      AND (uj.applied  IS NULL OR uj.applied  = 0)
      AND ((sj.posted_at IS NOT NULL AND sj.posted_at != ''
            AND CAST(strftime('%s', sj.posted_at) AS INTEGER) > ?)
           OR ((sj.posted_at IS NULL OR sj.posted_at = '') AND sj.scraped_at > ?))
      AND uj.domain_profile_id = ?
      AND sj.domain_profile_id = ?
  `).all(userId, sevenDaysAgo, sevenDaysAgo, facetProfile.id, facetProfile.id);

  const workType = {}, empType = {}, category = {}, postedAge = {};
  const salaries = [];
  const now = Math.floor(Date.now() / 1000);

  for (const r of rows) {
    if (r.work_type)       workType[r.work_type]           = (workType[r.work_type]       || 0) + 1;
    if (r.employment_type) empType[r.employment_type]      = (empType[r.employment_type]  || 0) + 1;
    if (r.category)        category[r.category]            = (category[r.category]        || 0) + 1;
    const ts = r.posted_at ? parseInt(r.posted_at) || 0 : r.scraped_at;
    const age = now - ts;
    const bucket = age < 86400 ? "24h" : age < 259200 ? "3d" : "1w";
    postedAge[bucket] = (postedAge[bucket] || 0) + 1;
    if (r.salary_min) salaries.push(r.salary_min);
    if (r.salary_max) salaries.push(r.salary_max);
  }

  const salaryRange = salaries.length
    ? { min: Math.min(...salaries), max: Math.max(...salaries),
        median: salaries.sort((a,b)=>a-b)[Math.floor(salaries.length/2)] }
    : null;

  res.json({ workType, employmentType: empType, category, postedAge, salaryRange, total: rows.length });
});

// JOBS — shared pool with pagination, filters, sort
// ═══════════════════════════════════════════════════════════════
app.get("/api/jobs", requireAuth, (req, res) => {
  const userId   = req.user.id;
  const page     = Math.max(1, parseInt(req.query.page     || "1"));
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || "25")));
  const offset   = (page - 1) * pageSize;
  const sort     = req.query.sort || "dateDesc";
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

  // ── Session sync: populate user_jobs — strictly isolated to the active profile ──
  // IMPORTANT: use domain_profile_id = ? (not IN all profiles) so jobs scraped under
  // another profile never bleed into this board.  No active profile → return empty immediately.
  const sessionActiveProfile = db.prepare(
    "SELECT id FROM domain_profiles WHERE user_id=? AND is_active=1"
  ).get(userId);

  if (!sessionActiveProfile) {
    return res.json({ jobs: [], total: 0, totalPages: 0, page, pageSize });
  }

  // ── Session sync: populate user_jobs from active
  // domain profile only ──────────────────────────────────
  // IMPORTANT: uses domain_profile_id not search_query.
  // Only jobs scraped for the user's active profile
  // enter their pool. This prevents cross-profile and
  // cross-user job bleeding.
  // To change: update the domain_profiles WHERE clause.
  // ────────────────────────────────────────────────────
  const syncProfile = db.prepare(`
    SELECT id FROM domain_profiles
    WHERE user_id = ? AND is_active = 1
  `).get(userId);

  if (syncProfile) {
    db.prepare(`
      INSERT OR IGNORE INTO user_jobs
        (user_id, job_id, domain_profile_id)
      SELECT ?, sj.job_id, sj.domain_profile_id
      FROM scraped_jobs sj
      WHERE sj.domain_profile_id = ?
      AND (
        (sj.posted_at IS NOT NULL AND sj.posted_at != ''
          AND CAST(strftime('%s', sj.posted_at) AS INTEGER)
          > ${sevenDaysAgo})
        OR ((sj.posted_at IS NULL OR sj.posted_at = '')
          AND sj.scraped_at > ${sevenDaysAgo})
      )
      AND sj.job_id NOT IN (
        SELECT job_id FROM user_jobs
        WHERE user_id = ? AND disliked = 1
      )
    `).run(userId, syncProfile.id, userId);
  }

  // Keep applied flag in sync with job_applications
  db.prepare(`
    UPDATE user_jobs SET applied = 1, updated_at = unixepoch()
    WHERE user_id = ? AND applied = 0
    AND job_id IN (SELECT job_id FROM job_applications WHERE user_id = ?)
  `).run(userId, userId);

  // ── Active profile filter ──────────────────────────────
  // Fetch active profile for WHERE clause.
  // Same profile used in session sync above.
  // If no profile: return empty results.
  // ──────────────────────────────────────────────────────
  const activeProfile = db.prepare(`
    SELECT id FROM domain_profiles
    WHERE user_id = ? AND is_active = 1
  `).get(userId);

  if (!activeProfile) {
    return res.json({
      jobs: [], total: 0, page: 1,
      pageSize, totalPages: 0,
    });
  }

  // ── Filter conditions ──────────────────────────────────
  // domain_profile_id filter is ALWAYS first and required.
  // This ensures only jobs from the active profile show.
  // ──────────────────────────────────────────────────────
  const conditions = [
    `uj.domain_profile_id = ?`,
    `sj.domain_profile_id = ?`,
    `((sj.posted_at IS NOT NULL AND sj.posted_at != '' AND CAST(strftime('%s', sj.posted_at) AS INTEGER) > ${sevenDaysAgo}) OR ((sj.posted_at IS NULL OR sj.posted_at = '') AND sj.scraped_at > ${sevenDaysAgo}))`,
    `(uj.disliked IS NULL OR uj.disliked = 0)`,
    `(uj.applied IS NULL OR uj.applied = 0)`,
    `(uj.resume_generated IS NULL OR uj.resume_generated = 0)`,
  ];
  const filterParams = [activeProfile.id, activeProfile.id];

  const role = (req.query.role || "").trim().toLowerCase();
  if (role) { conditions.push(`LOWER(sj.search_query) = ?`); filterParams.push(role); }

  const src = (req.query.source || "").trim().toLowerCase();
  if (src) { conditions.push(`LOWER(sj.source) = ?`); filterParams.push(src); }

  const workType = (req.query.workType || "").trim();
  if (workType) { conditions.push(`sj.work_type = ?`); filterParams.push(workType); }

  const empTypeParam = (req.query.employmentType || "").trim();
  if (empTypeParam) {
    const empTypes = empTypeParam.split(",").map(t => t.trim()).filter(Boolean);
    if (empTypes.length) {
      conditions.push(`(sj.employment_type IS NULL OR sj.employment_type IN (${empTypes.map(() => "?").join(",")}))`);
      filterParams.push(...empTypes);
    }
  }

  const cat = (req.query.category || "").trim();
  if (cat) { conditions.push(`sj.category = ?`); filterParams.push(cat); }

  const loc = (req.query.location || "").trim().toLowerCase();
  if (loc) { conditions.push(`LOWER(sj.location) LIKE ?`); filterParams.push(`%${loc}%`); }

  const ageLimits = { "1d":86400,"2d":172800,"3d":259200,"1w":604800,"1m":2592000 };
  const ageFilter = req.query.ageFilter;
  if (ageFilter && ageLimits[ageFilter]) {
    const ageTs = Math.floor(Date.now()/1000) - ageLimits[ageFilter];
    conditions.push(`(
      (sj.posted_at IS NOT NULL AND sj.posted_at != '' AND CAST(strftime('%s', sj.posted_at) AS INTEGER) > ?)
      OR ((sj.posted_at IS NULL OR sj.posted_at = '') AND sj.scraped_at > ?)
    )`);
    filterParams.push(ageTs, ageTs);
  }

  const minYoe = req.query.minYoe !== undefined && req.query.minYoe !== "" ? parseInt(req.query.minYoe) : null;
  const maxYoe = req.query.maxYoe !== undefined && req.query.maxYoe !== "" ? parseInt(req.query.maxYoe) : null;
  if (minYoe !== null && !isNaN(minYoe)) {
    conditions.push(`(sj.min_years_exp IS NULL OR sj.min_years_exp >= ?)`);
    filterParams.push(minYoe);
  }
  if (maxYoe !== null && !isNaN(maxYoe)) {
    conditions.push(`(sj.max_years_exp IS NULL OR sj.max_years_exp <= ?)`);
    filterParams.push(maxYoe);
  }

  const maxApplicants = req.query.maxApplicants !== undefined && req.query.maxApplicants !== ""
    ? parseInt(req.query.maxApplicants) : null;
  if (maxApplicants !== null && !isNaN(maxApplicants)) {
    conditions.push(`(sj.applicant_count IS NULL OR sj.applicant_count <= ?)`);
    filterParams.push(maxApplicants);
  }

  if (req.query.starred === "1") {
    conditions.push(`uj.starred = 1`);
  } else {
    // Hide starred/saved jobs from All Jobs view — they appear in the Saved tab
    conditions.push(`(uj.starred IS NULL OR uj.starred = 0)`);
  }

  const visitedParam = (req.query.visited || "").trim();
  if (visitedParam === "0") {
    conditions.push("(uj.visited IS NULL OR uj.visited = 0)");
  } else if (visitedParam === "1") {
    conditions.push("uj.visited = 1");
  }
  // else default: include all, visited sorted to end via ORDER BY

  const localSearch = (req.query.localSearch || "").trim().toLowerCase();
  if (localSearch) {
    conditions.push(`(LOWER(sj.company) LIKE ? OR LOWER(sj.location) LIKE ? OR LOWER(sj.category) LIKE ? OR LOWER(sj.search_query) LIKE ? OR LOWER(sj.title) LIKE ?)`);
    const pat = `%${localSearch}%`;
    filterParams.push(pat, pat, pat, pat, pat);
  }

  const sortMap = {
    dateDesc: "sj.scraped_at DESC",
    dateAsc:  "sj.scraped_at ASC",
    compHigh: "CAST(sj.compensation AS REAL) DESC",
    compLow:  "CAST(sj.compensation AS REAL) ASC",
    yoeHigh:  "sj.years_experience DESC",
    yoeLow:   "sj.years_experience ASC",
  };
  const orderBy = sortMap[sort] || sortMap.dateDesc;

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const baseJoin = `
    FROM scraped_jobs sj
    JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ?
  `;

  const countRow = db.prepare(
    `SELECT COUNT(*) as cnt ${baseJoin} ${where}`
  ).get(userId, ...filterParams);
  const total = countRow?.cnt || 0;

  let rows = db.prepare(
    `SELECT sj.*, uj.visited, uj.applied, uj.starred, uj.disliked,
       sj.ats_score as base_ats_score,
       r.ats_score as resume_ats_score,
       r.html as resume_html, r.ats_report
     ${baseJoin}
     LEFT JOIN resumes r ON r.user_id = ? AND r.job_id = sj.job_id
     ${where}
     ORDER BY CASE WHEN (uj.visited IS NOT NULL AND uj.visited = 1) THEN 1 ELSE 0 END ASC, ${orderBy}
     LIMIT ? OFFSET ?`
  ).all(userId, userId, ...filterParams, pageSize, offset);

  // Filter clearance-required jobs for non-cleared users
  const profile = db.prepare("SELECT has_clearance FROM user_profile WHERE user_id=?").get(userId) || {};
  if (!profile.has_clearance) {
    rows = rows.filter(j => {
      const d = (j.description || "").toLowerCase();
      return !d.includes("security clearance required") && !d.includes("ts/sci") && !d.includes("secret clearance");
    });
  }

  const appliedCoSet = new Set(
    db.prepare("SELECT LOWER(company) as co FROM job_applications WHERE user_id=?")
      .all(userId).map(a => a.co)
  );

  const jobs = rows.map(j => ({
    jobId:                j.job_id,
    company:              j.company,
    title:                j.title,
    category:             j.category,
    location:             j.location,
    workType:             j.work_type,
    employmentType:       j.employment_type || "full-time",
    source:               j.source,
    sourcePlatform:       "linkedin",
    url:                  j.url,
    applyUrl:             j.apply_url,
    postedAt:             j.posted_at,
    description:          j.description,
    descriptionHtml:      j.description_html,
    ghostScore:           j.ghost_score,
    yearsExperience:      j.years_experience,
    minYearsExp:          j.min_years_exp,
    maxYearsExp:          j.max_years_exp,
    expRaw:               j.exp_raw,
    salaryMin:            j.salary_min,
    salaryMax:            j.salary_max,
    salaryCurrency:       j.salary_currency,
    applicantCount:       j.applicant_count,
    compensation:         j.compensation,
    companyIconUrl:       j.company_icon_url,
    isFrequentRepost:     !!j.is_frequent_repost,
    visited:              !!j.visited,
    alreadyApplied:       !!j.applied,
    starred:              !!j.starred,
    disliked:             !!j.disliked,
    companyAppliedBefore: appliedCoSet.has((j.company || "").toLowerCase()),
    baseAtsScore:         j.base_ats_score ?? null,   // ATS of base resume vs JD (from scrape time)
    resumeAtsScore:       j.resume_ats_score ?? null, // ATS of generated tailored resume vs JD
    recruiterData:        null,
    enrichmentAvailable:  false,
  }));

  res.json({ jobs, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
});

// GET /api/jobs/best-match — jobs where base resume already scores well
// Returns jobs ordered by base_ats_score DESC for the user's active profile pool.
app.get("/api/jobs/best-match", requireAuth, (req, res) => {
  const userId = req.user.id;
  let threshold = parseInt(req.query.threshold || "70");
  const limit   = Math.min(50, Math.max(1, parseInt(req.query.limit || "20")));
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

  const bmProfile   = db.prepare("SELECT id FROM domain_profiles WHERE user_id=? AND is_active=1").get(userId);
  if (!bmProfile) return res.json({ jobs: [], threshold, total: 0 });
  const bestMatchQuery = (thresh) => db.prepare(`
    SELECT sj.*, uj.visited, uj.applied, uj.starred, uj.disliked,
      sj.ats_score as base_ats_score,
      r.ats_score as resume_ats_score
    FROM scraped_jobs sj
    JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ?
    LEFT JOIN resumes r ON r.user_id = ? AND r.job_id = sj.job_id
    WHERE sj.ats_score >= ?
      AND (uj.applied IS NULL OR uj.applied = 0)
      AND (uj.disliked IS NULL OR uj.disliked = 0)
      AND (
        (sj.posted_at IS NOT NULL AND sj.posted_at != ''
          AND CAST(strftime('%s', sj.posted_at) AS INTEGER) > ${sevenDaysAgo})
        OR ((sj.posted_at IS NULL OR sj.posted_at = '') AND sj.scraped_at > ${sevenDaysAgo})
      )
      AND uj.domain_profile_id = ?
      AND sj.domain_profile_id = ?
    ORDER BY sj.ats_score DESC
    LIMIT ?
  `).all(userId, userId, thresh, bmProfile.id, bmProfile.id, limit);

  let jobs = bestMatchQuery(threshold);

  // Lower threshold to 60 if fewer than 5 results
  if (jobs.length < 5) {
    threshold = 60;
    jobs = bestMatchQuery(threshold);
  }

  res.json({
    jobs: jobs.map(j => ({
      jobId:        j.job_id,
      company:      j.company,
      title:        j.title,
      location:     j.location,
      workType:     j.work_type,
      url:          j.url,
      applyUrl:     j.apply_url,
      description:  j.description,
      postedAt:     j.posted_at,
      applicantCount: j.applicant_count,
      companyIconUrl: j.company_icon_url,
      baseAtsScore: j.base_ats_score,
      resumeAtsScore: j.resume_ats_score,
      visited:      !!j.visited,
      starred:      !!j.starred,
    })),
    threshold,
    total: jobs.length,
  });
});

// GET /api/jobs/poll — returns new jobs since <since> ms timestamp + scraping status
// Used by frontend to stream live results during an active background scrape.
// LIVE POLLING: polls every 4s during active scrape (POLL_INTERVAL_MS on client).
// Stops when scraping:false returned. Stale entries cleaned up every poll (>10 min).
app.get("/api/jobs/poll", requireAuth, (req, res) => {
  const since  = parseInt(req.query.since) || 0;
  const qRaw   = (req.query.query || "").trim().toLowerCase();
  if (!qRaw) return res.status(400).json({ error:"query required" });

  // Evict stale activeScrapes entries older than 10 minutes
  const staleCutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of activeScrapes) {
    if (v.startedAt < staleCutoff) activeScrapes.delete(k);
  }

  const scrapeKey    = `${req.user.id}:${qRaw}`;
  const scrapeState  = activeScrapes.get(scrapeKey);
  const stillScraping = !!(scrapeState && !scrapeState.done);

  const sinceSeconds = Math.floor(since / 1000);
  const userId = req.user.id;
  const activeProfile = db.prepare(
    "SELECT id FROM domain_profiles WHERE user_id=? AND is_active=1"
  ).get(userId);
  if (!activeProfile) {
    return res.json({ jobs: [], scraping: stillScraping, total: 0 });
  }

  const rows = db.prepare(`
    SELECT sj.*, uj.visited, uj.applied, uj.starred, uj.disliked
    FROM scraped_jobs sj
    JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ?
    WHERE LOWER(sj.search_query) = ?
      AND sj.scraped_at > ?
      AND (uj.disliked  IS NULL OR uj.disliked  = 0)
      AND (uj.applied   IS NULL OR uj.applied   = 0)
      AND uj.domain_profile_id = ?
      AND sj.domain_profile_id = ?
    ORDER BY sj.scraped_at DESC
    LIMIT 50
  `).all(userId, qRaw, sinceSeconds, activeProfile.id, activeProfile.id);

  const jobs = rows.map(j => ({
    jobId:           j.job_id,
    company:         j.company,
    title:           j.title,
    category:        j.category,
    location:        j.location,
    workType:        j.work_type,
    source:          j.source,
    sourcePlatform:  "linkedin",
    url:             j.url,
    applyUrl:        j.apply_url,
    postedAt:        j.posted_at,
    description:     j.description,
    descriptionHtml: j.description_html,
    ghostScore:      j.ghost_score,
    minYearsExp:     j.min_years_exp,
    maxYearsExp:     j.max_years_exp,
    expRaw:          j.exp_raw,
    salaryMin:       j.salary_min,
    salaryMax:       j.salary_max,
    salaryCurrency:  j.salary_currency,
    applicantCount:  j.applicant_count,
    compensation:    j.compensation,
    companyIconUrl:  j.company_icon_url,
    isFrequentRepost: !!j.is_frequent_repost,
    visited:         !!j.visited,
    alreadyApplied:  !!j.applied,
    starred:         !!j.starred,
    disliked:        !!j.disliked,
  }));

  res.json({ jobs, scraping: stillScraping, total: jobs.length });
});

const VALID_EMP_TYPES       = new Set(["full-time","part-time","contract","internship","temporary"]);
const VALID_WORKPLACE_TYPES = new Set(["remote","hybrid","office"]);
const VALID_POSTED_LIMITS   = new Set(["24h","1w","1m"]);

// Map UI workType string → Apify workplaceType array
function mapWorkplaceTypes(workType) {
  const map = { Remote:"remote", Hybrid:"hybrid", Onsite:"office", "On-site":"office",
                remote:"remote", hybrid:"hybrid", office:"office" };
  if (!workType) return ["remote","hybrid","office"];
  const mapped = map[workType];
  return mapped ? [mapped] : ["remote","hybrid","office"];
}

// Map UI ageFilter string → Apify postedLimit
function mapPostedLimit(ageFilter) {
  const map = { "1d":"24h","2d":"24h","3d":"24h","1w":"1w","1m":"1m","1mo":"1m" };
  return map[ageFilter] || "24h";
}

app.post("/api/scrape", requireAuth, async (req, res) => {
  const rawQuery = (req.body.query || "").trim();
  if (!rawQuery) return res.status(400).json({ error:"query required" });

  // DOMAIN PROFILE: if an active profile exists, build multi-title jobTitles array.
  // Falls back to single normalised query when no profile is set.
  // QUERY PRIORITY: active profile target_titles + seniority variants first;
  // single query string as fallback. Edit buildApifyQueriesFromProfile() in
  // services/searchQueryBuilder.js to change title variant logic.
  const activeProfile = db.prepare(
    "SELECT * FROM domain_profiles WHERE user_id=? AND is_active=1"
  ).get(req.user.id);
  const profileJobTitles = activeProfile
    ? buildApifyQueriesFromProfile(activeProfile)
    : null;
  const query = normaliseRole(rawQuery);

  // employmentTypes — array of HarvestAPI-accepted strings; default full-time
  const rawEmpTypes = Array.isArray(req.body.employmentTypes) ? req.body.employmentTypes : [];
  const employmentTypes = rawEmpTypes.filter(t => VALID_EMP_TYPES.has(t));
  if (!employmentTypes.length) employmentTypes.push("full-time");

  // workplaceTypes — from UI workType string or explicit array
  const rawWorkplaceTypes = Array.isArray(req.body.workplaceTypes) ? req.body.workplaceTypes : [];
  const workplaceTypes = rawWorkplaceTypes.length
    ? rawWorkplaceTypes.filter(t => VALID_WORKPLACE_TYPES.has(t))
    : mapWorkplaceTypes(req.body.workType || "");
  if (!workplaceTypes.length) workplaceTypes.push("remote","hybrid","office");

  // postedLimit — from explicit value or mapped from ageFilter
  const rawPostedLimit = req.body.postedLimit || mapPostedLimit(req.body.ageFilter || "");
  const postedLimit = VALID_POSTED_LIMITS.has(rawPostedLimit) ? rawPostedLimit : "24h";

  // location
  const location = typeof req.body.location === "string" && req.body.location.trim()
    ? req.body.location.trim()
    : "United States";

  const scrapeParams = {
    employmentTypes, workplaceTypes, postedLimit, location,
    ...(profileJobTitles ? { jobTitles: profileJobTitles } : {}),
  };

  const user  = db.prepare("SELECT apify_token FROM users WHERE id=?").get(req.user.id);
  const token = user?.apify_token;
  if (!token) return res.status(400).json({
    error:"No Apify token set. Open ☰ → API Keys and paste your token.",
    missingToken:true,
  });

  const scrapeLimit = checkLimit(db, req.user.id, "job_scrape");
  if (!scrapeLimit.allowed) {
    return res.status(429).json({
      error: scrapeLimit.reason, limitReached: true,
      current: scrapeLimit.current, limit: scrapeLimit.limit, period: scrapeLimit.period,
    });
  }

  // Log search intent (enables pool inheritance for this user)
  db.prepare(`
    INSERT INTO user_job_searches (user_id, search_query, last_scraped_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(user_id, search_query) DO UPDATE SET last_scraped_at = unixepoch()
  `).run(req.user.id, query.toLowerCase());

  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

  // DB-first: count fresh unvisited quality jobs for this role
  const existingCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM scraped_jobs sj
    JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ?
    WHERE LOWER(sj.search_query) = ?
      AND sj.scraped_at > ?
      AND uj.domain_profile_id = ?
      AND sj.domain_profile_id = ?
      AND uj.visited = 0
      AND (uj.applied IS NULL OR uj.applied = 0)
      AND (uj.disliked IS NULL OR uj.disliked = 0)
      AND sj.ghost_score < 4
  `).get(req.user.id, query.toLowerCase(), sevenDaysAgo, activeProfile?.id ?? -1, activeProfile?.id ?? -1);

  const THRESHOLD = 50;
  const hasEnough = (existingCount?.cnt || 0) >= THRESHOLD;

  if (hasEnough) {
    console.log(`[scrape] DB-first: ${existingCount.cnt} jobs for "${query}" — skipping scrape`);
    // Sync pool jobs not yet in user_jobs (profile-isolated)
    // Only sync if user has an active profile — no fallback to search_query matching
    if (activeProfile) {
      db.prepare(`
        INSERT OR IGNORE INTO user_jobs (user_id, job_id, domain_profile_id)
        SELECT ?, sj.job_id, sj.domain_profile_id FROM scraped_jobs sj
        WHERE sj.domain_profile_id = ? AND sj.scraped_at > ?
        AND sj.job_id NOT IN (SELECT job_id FROM user_jobs WHERE user_id = ? AND disliked = 1)
      `).run(req.user.id, activeProfile.id, sevenDaysAgo, req.user.id);
    }
    return res.json({ ok:true, count:0, scrapedAt:Date.now(), query, fromCache:true });
  }

  console.log(`[scrape] DB-first: only ${existingCount?.cnt||0} jobs for "${query}" — triggering background scrape`);

  // Respond immediately — HarvestAPI takes 2–5 min; Railway timeout is 30s
  res.json({ ok:true, count:0, scrapedAt:Date.now(), query, scraping:true });

  const scrapeUserId = req.user.id;
  const scrapeKey = `${scrapeUserId}:${query.toLowerCase()}`;
  activeScrapes.set(scrapeKey, { startedAt: Date.now(), done: false });

  // Background scrape — runs after response is flushed
  setImmediate(async () => {
    const scrapeStart = Date.now();
    try {
      const scrapeResult = await scrapeJobs(query, token, scrapeParams, activeProfile?.id ?? null);

      // Tag newly inserted scraped_jobs rows with the active profile id
      if (activeProfile) {
        const nowUnixScrape = Math.floor(Date.now() / 1000);
        const jobTitlePlaceholders = (scrapeResult.classified || []).map(() => '?').join(',');
        if (jobTitlePlaceholders) {
          const jobIds = (scrapeResult.classified || []).map(j => j.jobId);
          if (jobIds.length) {
            const idsPlaceholders = jobIds.map(() => '?').join(',');
            db.prepare(`
              UPDATE scraped_jobs SET domain_profile_id = ?
              WHERE job_id IN (${idsPlaceholders})
                AND domain_profile_id IS NULL
                AND scraped_at >= ?
            `).run(activeProfile.id, ...jobIds, nowUnixScrape - 120);
          }
        }
      }

      // Insert into user_jobs with profile isolation
      // Only sync if user has an active profile — no fallback to search_query matching
      if (activeProfile) {
        db.prepare(`
          INSERT OR IGNORE INTO user_jobs (user_id, job_id, domain_profile_id)
          SELECT ?, sj.job_id, sj.domain_profile_id
          FROM scraped_jobs sj
          WHERE sj.domain_profile_id = ?
            AND sj.scraped_at > ?
            AND sj.job_id NOT IN (
              SELECT job_id FROM user_jobs WHERE user_id = ? AND disliked = 1
            )
        `).run(scrapeUserId, activeProfile.id, sevenDaysAgo, scrapeUserId);
      }
      trackScrape(db, {
        userId: scrapeUserId, searchQuery: query,
        rawCount: scrapeResult.rawCount,
        filteredCount: scrapeResult.filteredCount,
        insertedCount: scrapeResult.insertedCount,
        duplicateCount: scrapeResult.duplicateCount,
        ghostCount: scrapeResult.ghostCount,
        irrelevantCount: scrapeResult.irrelevantCount,
        durationMs: Date.now() - scrapeStart,
      });
      emitToUser(scrapeUserId, { type: "scrape_complete", query, insertedCount: scrapeResult.insertedCount });
      if (scrapeResult.insertedCount > 0) {
        insertNotification(scrapeUserId, "scrape_complete",
          `${scrapeResult.insertedCount} new job${scrapeResult.insertedCount > 1 ? "s" : ""} added for "${query}"`,
          { query, count: scrapeResult.insertedCount });
      }
      console.log(`[scrape] Background scrape complete for "${query}"`);
    } catch(e) {
      trackScrape(db, {
        userId: scrapeUserId, searchQuery: query,
        rawCount: 0, filteredCount: 0, insertedCount: 0,
        duplicateCount: 0, ghostCount: 0, irrelevantCount: 0,
        durationMs: Date.now() - scrapeStart,
        success: false, errorText: e.message,
      });
      console.error(`[scrape] Background scrape failed for "${query}":`, e.message);
    } finally {
      const existing = activeScrapes.get(scrapeKey) || {};
      activeScrapes.set(scrapeKey, { ...existing, done: true });
    }
  });
});

// ── Visited / Starred flags ────────────────────────────────────
app.patch("/api/jobs/:id/visited", requireAuth, (req, res) => {
  const jobId = req.params.id;
  const profileId = resolveUserJobDomainProfileId(req.user.id, jobId);
  db.prepare(`
    INSERT INTO user_jobs (user_id, job_id, domain_profile_id, visited, updated_at)
    VALUES (?, ?, ?, 1, unixepoch())
    ON CONFLICT(user_id, job_id) DO UPDATE SET visited = 1, updated_at = unixepoch()
  `).run(req.user.id, jobId, profileId);
  res.json({ ok:true });
});

app.patch("/api/jobs/:id/starred", requireAuth, (req, res) => {
  const jobId = req.params.id;
  const profileId = resolveUserJobDomainProfileId(req.user.id, jobId);
  const current = db.prepare(
    "SELECT starred FROM user_jobs WHERE user_id = ? AND job_id = ?"
  ).get(req.user.id, jobId);
  const newStarred = current ? (current.starred ? 0 : 1) : 1;
  db.prepare(`
    INSERT INTO user_jobs (user_id, job_id, domain_profile_id, starred, disliked, updated_at)
    VALUES (?, ?, ?, ?, 0, unixepoch())
    ON CONFLICT(user_id, job_id) DO UPDATE SET starred = ?, disliked = 0, updated_at = unixepoch()
  `).run(req.user.id, jobId, profileId, newStarred, newStarred);
  emitToUser(req.user.id, { type: "job_flag", jobId, starred: !!newStarred });
  res.json({ ok:true, starred: !!newStarred });
});

app.patch("/api/jobs/:id/disliked", requireAuth, (req, res) => {
  const jobId = req.params.id;
  const profileId = resolveUserJobDomainProfileId(req.user.id, jobId);
  const current = db.prepare(
    "SELECT disliked FROM user_jobs WHERE user_id = ? AND job_id = ?"
  ).get(req.user.id, jobId);
  const newDisliked = current ? (current.disliked ? 0 : 1) : 1;
  db.prepare(`
    INSERT INTO user_jobs (user_id, job_id, domain_profile_id, disliked, starred, updated_at)
    VALUES (?, ?, ?, ?, 0, unixepoch())
    ON CONFLICT(user_id, job_id) DO UPDATE SET disliked = ?, starred = 0, updated_at = unixepoch()
  `).run(req.user.id, jobId, profileId, newDisliked, newDisliked);
  emitToUser(req.user.id, { type: "job_flag", jobId, disliked: !!newDisliked });
  res.json({ ok:true, disliked: !!newDisliked });
});

app.get("/api/jobs/:id/recruiter", requireAuth, (_req, res) => {
  res.json({ comingSoon: true, available: false });
});

// ── Keyword analysis for a job (no generated resume needed) ──────
app.post("/api/jobs/:id/keywords", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const jobId  = req.params.id;
  const { resumeText } = req.body;
  if (!resumeText) return res.status(400).json({ error: "resumeText required" });

  // Priority 1: return ats_report from an existing generated resume (most accurate)
  const existingResume = db.prepare(
    "SELECT ats_report FROM resumes WHERE user_id=? AND job_id=?"
  ).get(userId, jobId);
  if (existingResume?.ats_report) {
    try { return res.json(JSON.parse(existingResume.ats_report)); } catch {}
  }

  // Priority 2: return cached ats_only_reports entry (avoids re-running Haiku)
  const cached = db.prepare(
    "SELECT ats_report FROM ats_only_reports WHERE user_id=? AND job_id=?"
  ).get(userId, jobId);
  if (cached?.ats_report) {
    try { return res.json(JSON.parse(cached.ats_report)); } catch {}
  }

  // Check monthly_ats_scores limit before running Haiku
  const limitCheck = checkLimit(db, userId, "ats_score");
  if (!limitCheck.allowed) {
    return res.status(429).json({
      error: limitCheck.reason, limitReached: true,
      current: limitCheck.current, limit: limitCheck.limit, period: limitCheck.period,
    });
  }

  // Priority 3: fetch job + run Haiku call
  const job = db.prepare("SELECT * FROM scraped_jobs WHERE job_id=?").get(jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const jobDescription = job.description || job.title;
  const atsDynamic = `JOB DESCRIPTION (extract keywords ONLY from this text):
Company: ${job.company}
Title: ${job.title}
Category: ${job.category || ""}
Full description:
${jobDescription}

RESUME TEXT (check which JD keywords appear here):
${resumeText}`;

  const t0 = Date.now();
  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 900,
      system: ATS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: atsDynamic }],
    });
    const raw = msg.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
    const result = JSON.parse(raw);

    // Save to cache — INSERT OR REPLACE via ON CONFLICT
    db.prepare(`
      INSERT INTO ats_only_reports (user_id, job_id, ats_report, ats_score)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, job_id) DO UPDATE SET
        ats_report=excluded.ats_report,
        ats_score=excluded.ats_score,
        created_at=unixepoch()
    `).run(userId, jobId, JSON.stringify(result), result.score ?? null);

    trackApiCall(db, {
      userId, eventType: "ats_score", eventSubtype: "keywords",
      model: "claude-haiku-4-5-20251001", usage: msg.usage,
      durationMs: Date.now() - t0, jobId: String(jobId), company: job.company,
      atsScoreAfter: result.score,
    });

    res.json(result);
  } catch (e) {
    console.error("[keywords]", e.message);
    res.status(500).json({ error: "Keyword analysis failed" });
  }
});

// ── Pending jobs (resume generated but not yet applied or disliked) ──
app.get("/api/jobs/pending", requireAuth, (req, res) => {
  const userId = req.user.id;
  const activeProfile = db.prepare(
    "SELECT id FROM domain_profiles WHERE user_id=? AND is_active=1"
  ).get(userId);
  if (!activeProfile) return res.json([]);
  const rows = db.prepare(`
    SELECT sj.*, uj.starred, uj.applied, uj.disliked, uj.visited, uj.resume_generated,
           r.ats_score, r.ats_report, r.html as resume_html, r.apply_mode
    FROM scraped_jobs sj
    JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ?
    LEFT JOIN resumes r ON r.user_id = ? AND r.job_id = sj.job_id
    WHERE uj.resume_generated = 1
      AND (uj.applied IS NULL OR uj.applied = 0)
      AND (uj.disliked IS NULL OR uj.disliked = 0)
      AND uj.domain_profile_id = ?
      AND sj.domain_profile_id = ?
    ORDER BY uj.updated_at DESC
  `).all(userId, userId, activeProfile.id, activeProfile.id);
  res.json(rows);
});

app.get("/api/categories", requireAuth, (_req,res) => res.json(INDUSTRY_CATEGORIES));

// ═══════════════════════════════════════════════════════════════
// BASE RESUME
// ═══════════════════════════════════════════════════════════════
app.get("/api/base-resume", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM base_resume WHERE user_id=?").get(req.user.id);
  res.json(row ? { content:row.content, name:row.name, updatedAt:row.updated_at } : { content:null });
});
app.post("/api/base-resume", requireAuth, (req, res) => {
  const { content, name } = req.body;
  if (content===undefined) return res.status(400).json({ error:"content required" });
  db.prepare(`INSERT INTO base_resume (user_id,content,name,updated_at) VALUES (?,?,?,unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET content=excluded.content,name=excluded.name,updated_at=excluded.updated_at`)
    .run(req.user.id, content, name||"resume.txt");
  res.json({ ok:true });
});
// ENHANCE GATING: one free per account lifetime.
// enhance_used is set server-side on API call, not on adoption.
// Cannot be reset. Future paid unlock: enhance_paid flag in users table.
// To change gating logic: edit /api/base-resume/enhance below
// and update enhance-status response.

// GET /api/base-resume/enhance-status
app.get("/api/base-resume/enhance-status", requireAuth, (req, res) => {
  const user = db.prepare("SELECT enhance_used, enhance_paid FROM users WHERE id=?").get(req.user.id);
  res.json({
    enhanceUsed: !!(user?.enhance_used),
    enhancePaid: !!(user?.enhance_paid),
  });
});

// POST /api/base-resume/enhance — one-time free enhancement
app.post("/api/base-resume/enhance", requireAuth, async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_KEY not configured" });

  const user = db.prepare("SELECT enhance_used, enhance_paid FROM users WHERE id=?").get(req.user.id);
  if (user?.enhance_used && !user?.enhance_paid) {
    return res.status(403).json({
      error: "enhance_limit_reached",
      message: "You have used your free resume enhancement. Upgrade to enhance again.",
      upgradeRequired: true,
    });
  }

  const baseResumeRow = db.prepare("SELECT content FROM base_resume WHERE user_id=?").get(req.user.id);
  if (!baseResumeRow?.content) return res.status(400).json({ error: "No base resume uploaded" });

  const originalText = baseResumeRow.content;

  // Mark enhance as used immediately (consumed on API call, not on adoption)
  db.prepare("UPDATE users SET enhance_used = 1 WHERE id = ?").run(req.user.id);

  try {
    const ENHANCE_SYSTEM = `You are a professional resume writer specialising in ATS optimisation.
Rewrite the provided resume to significantly improve its ATS score by:
- Strengthening action verbs (replace weak verbs with domain-specific strong ones)
- Improving keyword density and placement without keyword stuffing
- Restructuring bullet points to lead with impact (action → outcome → metric)
- Removing filler adjectives and generic phrases
- Ensuring consistent past tense and clean formatting
- Keeping all facts, dates, companies, job titles, and metrics exactly as provided
Do NOT fabricate any information. Do NOT change employment dates, company names, or job titles.
Return ONLY the improved resume text with no commentary, preamble, or explanation.`;

    const t0 = Date.now();
    const enhanceMsg = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: ENHANCE_SYSTEM,
      messages: [{ role: "user", content: `RESUME TO ENHANCE:\n\n${originalText}` }],
    });
    const enhancedText = enhanceMsg.content.map(b => b.text || "").join("").trim();
    trackApiCall(db, {
      userId: req.user.id, eventType: "resume_enhance", eventSubtype: "enhance",
      model: "claude-sonnet-4-20250514", usage: enhanceMsg.usage,
      durationMs: Date.now() - t0,
    });

    // Score both against a generic template to calculate delta
    const templateJd = "Software Engineer, Product Manager, Data Scientist, Data Engineer, Machine Learning Engineer";
    const scoreFor = async (resumeContent) => {
      try {
        const scoreMsg = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 900,
          system: ATS_SYSTEM_PROMPT,
          messages: [{ role: "user", content:
            `JOB DESCRIPTION:\n${templateJd}\n\nRESUME TEXT:\n${resumeContent}` }],
        });
        const raw = scoreMsg.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
        return JSON.parse(raw);
      } catch { return null; }
    };

    const [origReport, enhReport] = await Promise.all([scoreFor(originalText), scoreFor(enhancedText)]);
    const delta = (enhReport?.score ?? 0) - (origReport?.score ?? 0);

    // Store enhanced content
    db.prepare(`
      UPDATE base_resume SET enhanced_content=?, enhanced_at=unixepoch(), enhanced_ats_delta=?
      WHERE user_id=?
    `).run(enhancedText, delta, req.user.id);

    insertNotification(req.user.id, "enhance_ready",
      `Enhanced resume ready${delta > 0 ? ` (+${delta} ATS pts)` : ""}`,
      { delta });
    res.json({
      original: { text: originalText, atsScore: origReport?.score ?? null },
      enhanced: { text: enhancedText, atsScore: enhReport?.score ?? null },
      delta,
      improvements: enhReport?.improvements || [],
    });
  } catch(e) {
    // If generation fails, the enhance_used flag is already set — resource was consumed
    console.error("[enhance]", e.message);
    res.status(500).json({ error: "Enhancement failed: " + e.message });
  }
});

// PATCH /api/base-resume/adopt-enhanced — replace base resume with enhanced version
app.patch("/api/base-resume/adopt-enhanced", requireAuth, async (req, res) => {
  const row = db.prepare("SELECT enhanced_content FROM base_resume WHERE user_id=?").get(req.user.id);
  if (!row?.enhanced_content) return res.status(400).json({ error: "No enhanced resume available" });

  // Replace base resume content with enhanced version
  db.prepare(`
    UPDATE base_resume SET content = enhanced_content, updated_at = unixepoch()
    WHERE user_id = ?
  `).run(req.user.id);

  // Background: re-score all user's jobs against the new enhanced resume
  const userId = req.user.id;
  setImmediate(async () => {
    try {
      const newContent = db.prepare("SELECT content FROM base_resume WHERE user_id=?").get(userId)?.content;
      if (!newContent) return;

      const jobsToRescore = db.prepare(`
        SELECT sj.job_id, sj.description, sj.title, sj.company FROM scraped_jobs sj
        JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ?
        WHERE sj.description IS NOT NULL
      `).all(userId);

      const updateAts = db.prepare("UPDATE scraped_jobs SET ats_score=?, ats_report=? WHERE job_id=?");

      for (let i = 0; i < jobsToRescore.length; i += 5) {
        const batch = jobsToRescore.slice(i, i + 5);
        await Promise.all(batch.map(async job => {
          try {
            const scoreMsg = await anthropic.messages.create({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 900,
              system: ATS_SYSTEM_PROMPT,
              messages: [{ role: "user", content:
                `JOB DESCRIPTION:\n${job.description}\n\nRESUME TEXT:\n${newContent}` }],
            });
            const raw = scoreMsg.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
            const report = JSON.parse(raw);
            updateAts.run(report.score, JSON.stringify(report), job.job_id);
          } catch(e) {
            console.warn(`[adopt-enhanced] rescore failed for ${job.job_id}:`, e.message);
          }
        }));
      }
      console.log(`[adopt-enhanced] Re-scored ${jobsToRescore.length} jobs for user ${userId}`);
    } catch(e) {
      console.warn("[adopt-enhanced] background rescore failed:", e.message);
    }
  });

  res.json({ ok: true });
});

app.post("/api/parse-pdf", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error:"No file" });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error:"ANTHROPIC_KEY not configured on server. Set it in your .env file." });
  try {
    const base64 = req.file.buffer.toString("base64");
    const msg = await anthropic.messages.create({
      model:"claude-sonnet-4-20250514", max_tokens:4000,
      messages:[{ role:"user", content:[
        { type:"document", source:{ type:"base64", media_type:"application/pdf", data:base64 } },
        { type:"text", text:"Extract all text from this resume PDF preserving section structure. Return plain text only, no commentary." },
      ]}],
    });
    const text = msg.content.map(b=>b.text||"").join("").trim();
    res.json({ text, chars:text.length });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// GENERATE
// ═══════════════════════════════════════════════════════════════
app.post("/api/generate", requireAuth, async (req, res) => {
  const { jobId, job, resumeText, forceRegen } = req.body;
  // Strip excluded companies from employer list before any processing
  const employers = sanitiseEmployers(req.body.employers);
  if (!job||!resumeText) return res.status(400).json({ error:"job and resumeText required" });
  const mode = req.user.applyMode;
  if (mode==="SIMPLE") return res.status(400).json({ error:"Generate not available in SIMPLE mode" });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error:"ANTHROPIC_KEY not configured on server." });

  // Guard: reject obviously empty or template-placeholder resume content
  const resumeTrimmed = resumeText.trim();
  if (resumeTrimmed.length < 100) {
    return res.status(400).json({ error:"Base resume is too short or empty. Please re-upload your resume and try again." });
  }
  const PLACEHOLDER_PATTERNS = [/your name/i, /your\.email@example/i, /\[your name\]/i, /YOUR NAME/];
  if (PLACEHOLDER_PATTERNS.some(p => p.test(resumeTrimmed.slice(0, 300)))) {
    return res.status(400).json({ error:"Base resume data failed to load — placeholder text detected. Please re-upload your resume and try again." });
  }

  const existing = db.prepare("SELECT * FROM resumes WHERE user_id=? AND job_id=?").get(req.user.id, String(jobId));

  // Limit check only applies to new generation (not cache hits)
  if (!existing || forceRegen) {
    const limitCheck = checkLimit(db, req.user.id, "resume_generate");
    if (!limitCheck.allowed) {
      return res.status(429).json({
        error: limitCheck.reason, limitReached: true,
        current: limitCheck.current, limit: limitCheck.limit, period: limitCheck.period,
      });
    }
  }
  if (existing && !forceRegen) {
    try {
      const cachedResumeText = existing.html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const jobDescription = job.description || job.title;
      const freshAtsDynamic = `JOB DESCRIPTION (extract keywords ONLY from this text):
Company: ${job.company}
Title: ${job.title}
Category: ${job.category || ""}
Full description:
${jobDescription}

RESUME TEXT (check which JD keywords appear here):
${cachedResumeText}`;

      const t0 = Date.now();
      const freshScore = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 900,
        system: ATS_SYSTEM_PROMPT,
        messages: [{ role:"user", content:freshAtsDynamic }],
      });
      const rawFresh = freshScore.content.map(b=>b.text||"").join("")
        .replace(/```json|```/g,"").trim();
      let freshReport = null, freshScoreVal = existing.ats_score;
      try {
        freshReport   = JSON.parse(rawFresh);
        freshScoreVal = freshReport.score;
        db.prepare(
          "UPDATE resumes SET ats_score=?,ats_report=?,updated_at=unixepoch() WHERE user_id=? AND job_id=?"
        ).run(freshScoreVal, JSON.stringify(freshReport), req.user.id, String(jobId));
      } catch {}
      trackApiCall(db, {
        userId: req.user.id, eventType: "ats_score", eventSubtype: mode,
        model: "claude-haiku-4-5-20251001", usage: freshScore.usage,
        durationMs: Date.now() - t0, jobId: String(jobId), company: job.company,
        atsScoreAfter: freshScoreVal,
      });
      return res.json({
        html:existing.html,
        atsScore:freshScoreVal,
        atsReport:freshReport || JSON.parse(existing.ats_report||"null"),
        cached:true,
      });
    } catch {
      return res.json({
        html:existing.html,
        atsScore:existing.ats_score,
        atsReport:JSON.parse(existing.ats_report||"null"),
        cached:true,
      });
    }
  }

  const profile = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(req.user.id)||{};
  // Phase 4A: always use stored base resume as authoritative source
  const storedResume = db.prepare("SELECT content FROM base_resume WHERE user_id=?").get(req.user.id);
  const authoritativeResumeText = storedResume?.content || resumeText;

  // DOMAIN MODULE SELECTION: active domain profile takes priority over classifier inference.
  // Profile domain + roleFamily → domainModuleKey directly, skipping the Haiku classify call.
  // Classifier runs only as fallback when no active profile is set.
  // To change priority: edit this block.
  const activeDomainProfile = db.prepare(
    "SELECT * FROM domain_profiles WHERE user_id=? AND is_active=1"
  ).get(req.user.id);

  try {
    // New layered prompt flow
    let domainModuleKey = "general";
    if (activeDomainProfile) {
      // Fast path: derive domainModuleKey directly from profile — no Haiku call
      domainModuleKey = getDomainModuleKey(null, activeDomainProfile.role_family, activeDomainProfile.domain);
      console.log(`[generate] domain from profile: ${activeDomainProfile.profile_name} → ${domainModuleKey}`);
    } else {
      try {
        const classifierResult = await classify(anthropic, authoritativeResumeText, job.description || "");
        const qualKey = resolveFromClassifier(classifierResult, profile?.qualification_key);
        domainModuleKey = getDomainModuleKey(qualKey, classifierResult.roleFamily, classifierResult.domain);
      } catch(e) {
        console.warn("[generate] classifier failed, using general domain:", e.message);
      }
    }
    const runtimeInputs = buildRuntimeInputs(profile, job, authoritativeResumeText, mode, employers, activeDomainProfile);
    const { systemBlocks } = assemblePrompt(domainModuleKey, mode, runtimeInputs);

    const genStart = Date.now();
    const resumeMsg = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemBlocks,
      messages: [{ role: "user", content: runtimeInputs }],
    });
    trackApiCall(db, {
      userId: req.user.id, eventType: "resume_generate", eventSubtype: mode,
      model: "claude-sonnet-4-20250514", usage: resumeMsg.usage,
      durationMs: Date.now() - genStart, jobId: String(jobId), company: job.company,
      domainModule: domainModuleKey,
    });
    const html = resumeMsg.content.map(b=>b.text||"").join("").replace(/```html|```/g,"").trim();

    // ── Formatting pass — apply visual design template via Haiku ──
    // The generation step produces content. This step applies the exact
    // CSS/HTML template spec as a deterministic formatting layer.
    let formattedHtml = html;
    try {
      const FORMATTING_SYSTEM = `You are a resume HTML formatter. You receive a resume in any HTML format and reformat it to exactly match the design specification below. You output ONLY the final HTML — no commentary, no markdown fences, no explanation.

DESIGN SPECIFICATION:

All CSS lives in a <style> block in <head>. No inline styles. No external fonts, CDN links, or JavaScript. Include @media print block.

CSS variables (use these — no hardcoded hex):
:root {
  --color-bg: #ffffff;
  --color-text: #1a1a1a;
  --color-muted: #3d3d3d;
  --color-rule: #6b6b6b;
  --fs-body: 8.5pt;
  --fs-name: 9pt;
  --fs-section: 8pt;
  --page-w: 8.5in;
  --margin-x: 0.55in;
  --margin-top: 0.45in;
  --margin-bot: 0.45in;
  --gap-section: 9pt;
  --gap-entry: 6pt;
  --gap-inline: 2pt;
  --lh-body: 1.42;
  --lh-bullets: 1.38;
}

Font: font-family: 'Garamond','EB Garamond',Georgia,serif — all text, no exceptions.

body { background: var(--color-bg); color: var(--color-text); font-family: 'Garamond','EB Garamond',Georgia,serif; font-size: var(--fs-body); line-height: var(--lh-body); margin: var(--margin-top) var(--margin-x) var(--margin-bot); max-width: var(--page-w); }

.header { text-align: center; margin-bottom: 6pt; }
.header .name { font-size: var(--fs-name); font-weight: bold; text-transform: uppercase; letter-spacing: 0.22em; line-height: 1.1; }
.header .tagline { color: var(--color-muted); letter-spacing: 0.04em; font-size: var(--fs-body); }
.header .contact { font-size: var(--fs-body); }
.header .contact a { color: inherit; text-decoration: none; }

.section-title { font-size: var(--fs-section); font-weight: bold; text-transform: uppercase; letter-spacing: 0.18em; color: var(--color-text); border-bottom: 0.5pt solid var(--color-rule); padding-bottom: 1pt; margin-top: var(--gap-section); margin-bottom: 4pt; }

.entry { margin-bottom: var(--gap-entry); page-break-inside: avoid; }
.entry-header { display: flex; justify-content: space-between; align-items: baseline; }
.entry-org { font-weight: bold; }
.entry-meta { font-style: italic; color: var(--color-muted); font-weight: normal; }
.sep { font-style: normal; font-weight: normal; color: var(--color-muted); }
.entry-date { color: var(--color-muted); white-space: nowrap; margin-left: 8pt; flex-shrink: 0; font-size: var(--fs-body); }
.entry-role { font-style: italic; color: var(--color-muted); margin-bottom: var(--gap-inline); }
.tech-line { font-size: calc(var(--fs-body) - 0.4pt); color: var(--color-muted); margin-bottom: var(--gap-inline); }

ul.bullets { list-style: none; padding-left: 0.9em; margin: var(--gap-inline) 0 0 0; }
ul.bullets li { position: relative; font-size: var(--fs-body); line-height: var(--lh-bullets); margin-bottom: 1.6pt; text-align: justify; }
ul.bullets li::before { content: "•"; position: absolute; left: -0.85em; }

.skills-table { width: 100%; border-collapse: collapse; font-size: var(--fs-body); }
.skill-label { font-weight: bold; white-space: nowrap; padding-right: 12pt; width: 1%; vertical-align: top; padding: 1.2pt 12pt 1.2pt 0; }
.skill-values { color: var(--color-text); padding: 1.2pt 0; }

@media print {
  body { margin: var(--margin-top) var(--margin-x) var(--margin-bot); }
  .entry { page-break-inside: avoid; }
  .section-title { page-break-after: avoid; }
}

RULES:
- Preserve ALL content exactly — every word, number, company name, date, bullet, skill
- Only restructure the HTML and CSS — never change the text content
- Apply the class names above to the correct elements
- Entry headers must be a single flex row — company on left, date on right
- Output only the complete HTML file, nothing else`;

      const fmtStart = Date.now();
      const formatMsg = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        system: [{ type: "text", text: FORMATTING_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: `Reformat this resume HTML to match the design specification exactly. Preserve all content:\n\n${html}` }],
      });
      trackApiCall(db, {
        userId: req.user.id, eventType: "resume_format", eventSubtype: mode,
        model: "claude-haiku-4-5-20251001", usage: formatMsg.usage,
        durationMs: Date.now() - fmtStart,
      });
      const formatted = formatMsg.content.map(b=>b.text||"").join("").replace(/```html|```/g,"").trim();
      if (formatted && formatted.includes("<html")) formattedHtml = formatted;
    } catch(e) {
      console.warn("[format] Formatting pass failed, using raw generation output:", e.message);
      // formattedHtml stays as original html — graceful fallback
    }

    const jobDescription = job.description || job.title;
    const resumeStripped = formattedHtml
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const atsDynamic = `JOB DESCRIPTION (extract keywords ONLY from this text):
Company: ${job.company}
Title: ${job.title}
Category: ${job.category || ""}
Full description:
${jobDescription}

RESUME TEXT (check which JD keywords appear here):
${resumeStripped}`;

    const atsStart = Date.now();
    const scoreMsg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 900,
      system: ATS_SYSTEM_PROMPT,
      messages: [{ role:"user", content:atsDynamic }],
    });
    let atsReport=null, atsScore=null;
    try {
      const raw = scoreMsg.content.map(b=>b.text||"").join("").replace(/```json|```/g,"").trim();
      atsReport = JSON.parse(raw); atsScore = atsReport.score;
    } catch {}
    trackApiCall(db, {
      userId: req.user.id, eventType: "ats_score", eventSubtype: mode,
      model: "claude-haiku-4-5-20251001", usage: scoreMsg.usage,
      durationMs: Date.now() - atsStart, jobId: String(jobId), company: job.company,
      atsScoreAfter: atsScore,
    });

    const version = existing
      ? (db.prepare("SELECT MAX(version) as v FROM resume_versions WHERE user_id=? AND job_id=?").get(req.user.id,String(jobId))?.v||0)+1
      : 1;
    db.prepare("INSERT INTO resume_versions (user_id,job_id,company,role,category,html,ats_score,ats_report,version) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(req.user.id,String(jobId),job.company,job.title,job.category,formattedHtml,atsScore,JSON.stringify(atsReport),version);
    db.prepare(`INSERT INTO resumes (user_id,job_id,company,role,category,apply_mode,html,ats_score,ats_report,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,unixepoch(),unixepoch())
      ON CONFLICT(user_id,job_id) DO UPDATE SET html=excluded.html,role=excluded.role,category=excluded.category,
      apply_mode=excluded.apply_mode,ats_score=excluded.ats_score,ats_report=excluded.ats_report,updated_at=excluded.updated_at`)
      .run(req.user.id,String(jobId),job.company,job.title,job.category,mode,formattedHtml,atsScore,JSON.stringify(atsReport));

    // Phase 1C: mark resume_generated in user_jobs
    const userJobProfileId = resolveUserJobDomainProfileId(req.user.id, String(jobId));
    db.prepare(`
      INSERT INTO user_jobs (user_id, job_id, domain_profile_id, resume_generated, updated_at)
      VALUES (?, ?, ?, 1, unixepoch())
      ON CONFLICT(user_id, job_id) DO UPDATE SET
        resume_generated = 1, updated_at = unixepoch()
    `).run(req.user.id, String(jobId), userJobProfileId);

    emitToUser(req.user.id, { type: "resume_generated", jobId: String(jobId), atsScore });
    insertNotification(req.user.id, "resume_generated",
      `Resume ready for ${job.company}${atsScore != null ? ` (ATS: ${atsScore})` : ""}`,
      { jobId: String(jobId), company: job.company, atsScore });
    res.json({ html: formattedHtml, atsScore, atsReport, cached:false, version });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// SANDBOX + PDF
// ═══════════════════════════════════════════════════════════════
app.post("/api/resumes/:jobId/html", requireAuth, (req, res) => {
  const { html } = req.body;
  if (!html) return res.status(400).json({ error:"html required" });
  db.prepare("UPDATE resumes SET html=?,updated_at=unixepoch() WHERE user_id=? AND job_id=?")
    .run(html, req.user.id, req.params.jobId);
  res.json({ ok:true });
});
app.post("/api/export-pdf", requireAuth, (_req, res) => {
  res.status(503).json({ error: "Server-side PDF export is not available. Use client-side print instead.", useClientSide: true });
});
app.get("/api/resumes/:jobId/pdf", requireAuth, (_req, res) => {
  res.status(503).json({ error: "Server-side PDF export is not available. Use client-side print instead.", useClientSide: true });
});

// ═══════════════════════════════════════════════════════════════
// RESUME HISTORY
// ═══════════════════════════════════════════════════════════════
app.get("/api/resumes", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.user_id, r.job_id, r.company, r.role, r.category,
           r.apply_mode, r.ats_score, r.ats_report, r.created_at, r.updated_at,
           COUNT(v.id) as versions
    FROM resumes r
    LEFT JOIN resume_versions v ON v.user_id=r.user_id AND v.job_id=r.job_id
    WHERE r.user_id=? GROUP BY r.id ORDER BY r.updated_at DESC
  `).all(req.user.id);
  res.json(rows.map(r => ({ ...r, atsReport: JSON.parse(r.ats_report || "null"), html: undefined })));
});
app.get("/api/resumes/:jobId", requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT r.*, COUNT(v.id) as versions
    FROM resumes r
    LEFT JOIN resume_versions v ON v.user_id=r.user_id AND v.job_id=r.job_id
    WHERE r.user_id=? AND r.job_id=?
    GROUP BY r.id
  `).get(req.user.id, req.params.jobId);
  if (!row) return res.status(404).json({ error: "Resume not found" });
  res.json({ ...row, atsReport: JSON.parse(row.ats_report || "null") });
});
app.get("/api/resumes/:jobId/versions", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM resume_versions WHERE user_id=? AND job_id=? ORDER BY version DESC").all(req.user.id, req.params.jobId);
  res.json(rows.map(r=>({...r,atsReport:JSON.parse(r.ats_report||"null")})));
});
app.delete("/api/resumes/:jobId", requireAuth, (req, res) => {
  db.prepare("DELETE FROM resumes WHERE user_id=? AND job_id=?").run(req.user.id, req.params.jobId);
  db.prepare("DELETE FROM resume_versions WHERE user_id=? AND job_id=?").run(req.user.id, req.params.jobId);
  res.json({ ok:true });
});
app.get("/api/history", requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT r.job_id,r.company,r.role,r.category,r.ats_score,r.apply_mode,r.updated_at,COUNT(v.id) as versions
    FROM resumes r LEFT JOIN resume_versions v ON v.user_id=r.user_id AND v.job_id=r.job_id
    WHERE r.user_id=? GROUP BY r.job_id ORDER BY r.updated_at DESC`).all(req.user.id);
  res.json(rows);
});

// ═══════════════════════════════════════════════════════════════
// JOB APPLICATIONS
// ═══════════════════════════════════════════════════════════════
app.post("/api/applications", requireAuth, (req, res) => {
  const { jobId,company,role,jobUrl,source,location,applyMode,resumeFile,notes } = req.body;
  if (!jobId||!company||!role) return res.status(400).json({ error:"jobId, company, role required" });
  try {
    db.prepare(`INSERT INTO job_applications (user_id,job_id,company,role,job_url,source,location,apply_mode,resume_file,notes,applied_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,unixepoch())
      ON CONFLICT(user_id,job_id) DO UPDATE SET
        resume_file=COALESCE(excluded.resume_file,resume_file),
        notes=COALESCE(excluded.notes,notes),
        applied_at=excluded.applied_at`)
      .run(req.user.id,jobId,company,role,jobUrl||null,source||null,location||null,applyMode||null,resumeFile||null,notes||null);
    // Sync applied flag to user_jobs
    const userJobProfileId = resolveUserJobDomainProfileId(req.user.id, jobId);
    db.prepare(`
      INSERT INTO user_jobs (user_id, job_id, domain_profile_id, applied, updated_at)
      VALUES (?, ?, ?, 1, unixepoch())
      ON CONFLICT(user_id, job_id) DO UPDATE SET applied = 1, updated_at = unixepoch()
    `).run(req.user.id, jobId, userJobProfileId);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.get("/api/applications", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT ja.*,
      sj.description      AS sj_description,
      sj.description_html AS sj_description_html,
      sj.url              AS sj_url,
      sj.apply_url        AS sj_apply_url,
      sj.salary_min       AS sj_salary_min,
      sj.salary_max       AS sj_salary_max,
      sj.salary_currency  AS sj_salary_currency,
      sj.applicant_count  AS sj_applicant_count,
      sj.min_years_exp    AS sj_min_years_exp,
      sj.max_years_exp    AS sj_max_years_exp,
      sj.exp_raw          AS sj_exp_raw,
      sj.category         AS sj_category,
      sj.work_type        AS sj_work_type,
      sj.company_icon_url AS sj_company_icon_url
    FROM job_applications ja
    LEFT JOIN scraped_jobs sj ON sj.job_id = ja.job_id
    WHERE ja.user_id = ?
    ORDER BY ja.applied_at DESC
  `).all(req.user.id);
  res.json(rows.map(r => ({
    ...r,
    description:     r.sj_description     || null,
    descriptionHtml: r.sj_description_html || null,
    url:             r.sj_url             || null,
    applyUrl:        r.sj_apply_url        || r.job_url || null,
    salaryMin:       r.sj_salary_min       || null,
    salaryMax:       r.sj_salary_max       || null,
    salaryCurrency:  r.sj_salary_currency  || null,
    applicantCount:  r.sj_applicant_count  || null,
    minYearsExp:     r.sj_min_years_exp    || null,
    maxYearsExp:     r.sj_max_years_exp    || null,
    expRaw:          r.sj_exp_raw          || null,
    category:        r.sj_category         || r.category || null,
    workType:        r.sj_work_type        || null,
    companyIconUrl:  r.sj_company_icon_url || null,
  })));
});
app.patch("/api/applications/:jobId", requireAuth, (req, res) => {
  const allowed = ["company","role","location","notes","applied_at"];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error:"No editable fields provided" });
  const set  = updates.map(([k]) => `${k}=?`).join(",");
  const vals = updates.map(([,v]) => v||null);
  db.prepare(`UPDATE job_applications SET ${set} WHERE user_id=? AND job_id=?`)
    .run(...vals, req.user.id, req.params.jobId);
  res.json({ ok:true });
});
app.delete("/api/applications/:jobId", requireAuth, (req, res) => {
  db.prepare("DELETE FROM job_applications WHERE user_id=? AND job_id=?").run(req.user.id, req.params.jobId);
  res.json({ ok:true });
});

// ═══════════════════════════════════════════════════════════════
// EXCEL EXPORT
// ═══════════════════════════════════════════════════════════════
app.get("/api/export/excel", requireAuth, async (req, res) => {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Resume Master";
  const hdrFill = { type:"pattern", pattern:"solid", fgColor:{ argb:"FF1E3A5F" } };
  const hdrFont = { bold:true, color:{ argb:"FFFFFFFF" } };
  const altFill = { type:"pattern", pattern:"solid", fgColor:{ argb:"FFF1F5F9" } };

  const ws1 = wb.addWorksheet("Job Applications");
  ws1.columns = [
    {header:"#",key:"n",width:5},{header:"Company",key:"company",width:22},
    {header:"Role",key:"role",width:30},{header:"Location",key:"location",width:18},
    {header:"Source",key:"source",width:12},{header:"Mode",key:"apply_mode",width:16},
    {header:"Date Applied",key:"applied_at",width:18},{header:"Resume File",key:"resume_file",width:40},
    {header:"Job URL",key:"job_url",width:50},{header:"Notes",key:"notes",width:30},
  ];
  ws1.getRow(1).font = hdrFont; ws1.getRow(1).fill = hdrFill;
  db.prepare("SELECT * FROM job_applications WHERE user_id=? ORDER BY applied_at DESC").all(req.user.id)
    .forEach((a,i) => {
      ws1.addRow({
        n:i+1,company:a.company,role:a.role,location:a.location||"",
        source:a.source||"",apply_mode:a.apply_mode||"",
        applied_at:a.applied_at?new Date(a.applied_at*1000).toLocaleDateString():"",
        resume_file:a.resume_file||"",job_url:a.job_url||"",notes:a.notes||"",
      });
      if (i%2===1) ws1.getRow(i+2).fill = altFill;
      if (a.job_url) {
        const c = ws1.getRow(i+2).getCell("job_url");
        c.value = { text:a.job_url.slice(0,60), hyperlink:a.job_url };
        c.font  = { color:{ argb:"FF2563EB" }, underline:true };
      }
    });

  const ws2 = wb.addWorksheet("Resume History");
  ws2.columns = [
    {header:"Company",key:"company",width:22},{header:"Role",key:"role",width:30},
    {header:"Category",key:"category",width:24},{header:"ATS Score",key:"ats_score",width:12},
    {header:"Mode",key:"apply_mode",width:16},{header:"Generated",key:"created_at",width:18},
    {header:"Updated",key:"updated_at",width:18},
  ];
  ws2.getRow(1).font = hdrFont; ws2.getRow(1).fill = hdrFill;
  db.prepare("SELECT * FROM resumes WHERE user_id=? ORDER BY updated_at DESC").all(req.user.id)
    .forEach((r,i) => {
      ws2.addRow({
        company:r.company,role:r.role,category:r.category||"",
        ats_score:r.ats_score??"",apply_mode:r.apply_mode||"",
        created_at:r.created_at?new Date(r.created_at*1000).toLocaleDateString():"",
        updated_at:r.updated_at?new Date(r.updated_at*1000).toLocaleDateString():"",
      });
      if (i%2===1) ws2.getRow(i+2).fill = altFill;
    });

  res.set({
    "Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition":`attachment; filename="ResuMaster_${req.user.username}_${new Date().toISOString().slice(0,10)}.xlsx"`,
  });
  await wb.xlsx.write(res);
  res.end();
});

// ═══════════════════════════════════════════════════════════════
// EXTENSION RELAY
// ═══════════════════════════════════════════════════════════════
app.get("/api/extension/autofill", requireAuth, (req, res) => {
  db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").run(req.user.id);
  const profile = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(req.user.id)||{};
  res.json({ ok:true, mode:req.user.applyMode, ...buildAutofillPayload(profile, req.user.applyMode) });
});

// ═══════════════════════════════════════════════════════════════
// SMART SEARCH
// ═══════════════════════════════════════════════════════════════
app.post("/api/smart-search", requireAuth, async (req, res) => {
  const { resumeText } = req.body;
  if (!resumeText) return res.status(400).json({ error: "resumeText required" });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_KEY not configured" });
  try {
    const classifierResult = await classify(anthropic, resumeText, "");
    const qualKey    = resolveFromClassifier(classifierResult);
    const qualTemplates = getSearchQueryTemplates(qualKey);
    const canonical  = normaliseRole(classifierResult.searchQueries?.[0] || "");
    const queries    = buildApifyQueries(canonical, classifierResult, qualTemplates);
    res.json({
      ok:              true,
      searchQuery:     queries[0] || canonical,
      searchQueries:   queries,
      roleFamily:      classifierResult.roleFamily,
      domain:          classifierResult.domain,
      seniority:       classifierResult.seniority,
      topTools:        classifierResult.topTools || [],
      yearsExperience: null,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// LINKEDIN SESSION COOKIES (AES-256-GCM encrypted at rest)
// Future: use stored cookies to skip re-auth in HarvestAPI actor
// ═══════════════════════════════════════════════════════════════
app.post("/api/linkedin/cookies", requireAuth, (req, res) => {
  const { cookies } = req.body;
  if (!cookies || typeof cookies !== "string") return res.status(400).json({ error:"cookies string required" });
  try {
    const { enc, iv, tag } = encryptCookies(cookies);
    db.prepare(`
      INSERT INTO user_linkedin_sessions (user_id, cookies_enc, iv, auth_tag, updated_at)
      VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(user_id) DO UPDATE SET cookies_enc=excluded.cookies_enc, iv=excluded.iv,
        auth_tag=excluded.auth_tag, updated_at=excluded.updated_at
    `).run(req.user.id, enc, iv, tag);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get("/api/linkedin/status", requireAuth, (req, res) => {
  const row = db.prepare(
    "SELECT updated_at FROM user_linkedin_sessions WHERE user_id=?"
  ).get(req.user.id);
  res.json({ connected: !!row, updatedAt: row?.updated_at || null });
});

app.delete("/api/linkedin/cookies", requireAuth, (req, res) => {
  db.prepare("DELETE FROM user_linkedin_sessions WHERE user_id=?").run(req.user.id);
  res.json({ ok:true });
});

// ═══════════════════════════════════════════════════════════════
// APPLY AUTOMATION (Playwright)
// ═══════════════════════════════════════════════════════════════
applyRoutes(app, db, requireAuth, buildAutofillPayload);

// ── Contact form (public — no auth required) ──────────────────
app.post("/api/contact", (req, res) => {
  const { name, email, subject, message } = req.body || {};
  if (!name?.trim() || !email?.trim() || !message?.trim())
    return res.status(400).json({ error: "name, email, and message are required" });
  db.prepare(`INSERT INTO contact_messages (name, email, subject, message) VALUES (?, ?, ?, ?)`)
    .run(name.trim(), email.trim(), subject?.trim() || null, message.trim());
  res.json({ ok: true });
});

app.get("/api/admin/contact-messages", requireAdmin, (req, res) => {
  const where = req.query.unread === "1" ? "WHERE read = 0" : "";
  const rows = db.prepare(`SELECT * FROM contact_messages ${where} ORDER BY created_at DESC`).all();
  res.json(rows);
});

app.patch("/api/admin/contact-messages/:id/read", requireAdmin, (req, res) => {
  db.prepare("UPDATE contact_messages SET read = 1 WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════
// STANDALONE TOOL PAGES — AUTH INFRASTRUCTURE (Phase 5B)
// ═══════════════════════════════════════════════════════════════
// Placeholder OTP store (in-memory; replace with Redis/DB in production)
const _otpStore = new Map(); // contact → { otp, expiresAt }

app.post("/api/standalone/auth/google", (_req, res) => {
  // TODO: validate Google ID token with google-auth-library
  res.json({ ok: true, mock: true });
});

app.post("/api/standalone/auth/email-otp/send", (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  _otpStore.set(email, { otp: "123456", expiresAt: Date.now() + 10 * 60 * 1000 });
  // TODO: send real email via SendGrid/Resend
  res.json({ ok: true, mock: true });
});

app.post("/api/standalone/auth/phone-otp/send", (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "phone required" });
  _otpStore.set(phone, { otp: "123456", expiresAt: Date.now() + 10 * 60 * 1000 });
  // TODO: send real SMS via Twilio
  res.json({ ok: true, mock: true });
});

app.post("/api/standalone/auth/otp/verify", (req, res) => {
  const { contact, otp } = req.body;
  if (!contact || !otp) return res.status(400).json({ error: "contact and otp required" });
  const stored = _otpStore.get(contact);
  if (!stored || stored.otp !== otp || Date.now() > stored.expiresAt) {
    return res.status(401).json({ error: "Invalid or expired OTP" });
  }
  _otpStore.delete(contact);
  // Find or create standalone user
  const isEmail = contact.includes("@");
  let user = isEmail
    ? db.prepare("SELECT * FROM standalone_users WHERE email=?").get(contact)
    : db.prepare("SELECT * FROM standalone_users WHERE phone=?").get(contact);
  if (!user) {
    const r = isEmail
      ? db.prepare("INSERT INTO standalone_users (email) VALUES (?)").run(contact)
      : db.prepare("INSERT INTO standalone_users (phone) VALUES (?)").run(contact);
    user = db.prepare("SELECT * FROM standalone_users WHERE id=?").get(r.lastInsertRowid);
  } else {
    db.prepare("UPDATE standalone_users SET last_seen_at=unixepoch() WHERE id=?").run(user.id);
  }
  req.session.standaloneUserId = user.id;
  res.json({ ok: true, user: { id: user.id, email: user.email, phone: user.phone } });
});

app.get("/api/standalone/auth/me", (req, res) => {
  const uid = req.session?.standaloneUserId;
  if (!uid) return res.json({ authenticated: false });
  const user = db.prepare("SELECT id, email, phone, display_name FROM standalone_users WHERE id=?").get(uid);
  res.json({ authenticated: !!user, user: user || null });
});

app.post("/api/standalone/auth/logout", (req, res) => {
  req.session.standaloneUserId = null;
  res.json({ ok: true });
});

// Standalone rate-limit middleware
// anonMax: max uses per session (anonymous); userMax: max per registered user per month
function standaloneRateLimit(service, anonMax, userMax) {
  return (req, res, next) => {
    const userId    = req.session?.standaloneUserId;
    const sessionId = req.sessionID;
    const since     = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;

    const count = userId
      ? db.prepare("SELECT COUNT(*) as c FROM standalone_usage WHERE standalone_user_id=? AND service=? AND used_at>?").get(userId, service, since).c
      : db.prepare("SELECT COUNT(*) as c FROM standalone_usage WHERE session_id=? AND service=? AND used_at>?").get(sessionId, service, since).c;

    const limit = userId ? userMax : anonMax;
    if (count >= limit) {
      return res.status(429).json({
        error: "limit_reached", service, count, limit,
        message: `You have used ${count} of ${limit} free ${service} runs this month.`,
      });
    }
    db.prepare("INSERT INTO standalone_usage (standalone_user_id, session_id, service) VALUES (?,?,?)")
      .run(userId || null, sessionId, service);
    next();
  };
}

// Multer for standalone uploads
const standaloneUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ═══════════════════════════════════════════════════════════════
// STANDALONE TOOL API ROUTES (Phase 5C)
// ═══════════════════════════════════════════════════════════════

// POST /api/standalone/ats — ATS scoring (no main-app auth required)
// Uses same ATS_SYSTEM_PROMPT and Haiku call as main app.
app.post("/api/standalone/ats", standaloneRateLimit("ats", 1, 3), standaloneUpload.single("resume"), async (req, res) => {
  const jdText = req.body?.jd_text || "";
  if (!req.file || !jdText.trim()) return res.status(400).json({ error: "resume PDF and jd_text required" });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_KEY not configured" });

  try {
    // Parse PDF text using pdf-parse (same path as /api/parse-pdf)
    const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
    const parsed = await pdfParse(req.file.buffer);
    const resumeText = parsed.text?.trim();
    if (!resumeText || resumeText.length < 50) return res.status(400).json({ error: "Could not extract text from PDF" });

    const atsDynamic = `JOB DESCRIPTION (extract keywords ONLY from this text):\n${jdText}\n\nRESUME TEXT (check which JD keywords appear here):\n${resumeText}`;
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 900,
      system: ATS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: atsDynamic }],
    });
    const raw = msg.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
    const report = JSON.parse(raw);
    res.json(report);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/standalone/generate — tailored resume (no main-app auth)
app.post("/api/standalone/generate", standaloneRateLimit("generate", 1, 2), standaloneUpload.single("resume"), async (req, res) => {
  const jdText = req.body?.jd_text || "";
  if (!req.file || !jdText.trim()) return res.status(400).json({ error: "resume PDF and jd_text required" });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_KEY not configured" });

  try {
    const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
    const parsed = await pdfParse(req.file.buffer);
    const resumeText = parsed.text?.trim();
    if (!resumeText || resumeText.length < 50) return res.status(400).json({ error: "Could not extract text from PDF" });

    // No domain profile for standalone users — use classifier
    let domainModuleKey = "general";
    try {
      const cr = await classify(anthropic, resumeText, jdText);
      const qk = resolveFromClassifier(cr, null);
      domainModuleKey = getDomainModuleKey(qk, cr.roleFamily, cr.domain);
    } catch {}

    const fakeJob = { title: "Role", company: "Company", description: jdText, category: "", stack: "" };
    const runtimeInputs = buildRuntimeInputs({}, fakeJob, resumeText, "TAILORED", []);
    const { systemBlocks } = assemblePrompt(domainModuleKey, "TAILORED", runtimeInputs);

    const resumeMsg = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemBlocks,
      messages: [{ role: "user", content: runtimeInputs }],
    });
    const html = resumeMsg.content.map(b => b.text || "").join("").trim();

    // Quick ATS score
    const cachedText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    let atsScore = null;
    try {
      const atsMsg = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001", max_tokens: 900,
        system: ATS_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `JOB DESCRIPTION:\n${jdText}\n\nRESUME TEXT:\n${cachedText}` }],
      });
      const atsRaw = atsMsg.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
      atsScore = JSON.parse(atsRaw).score;
    } catch {}

    res.json({ html, atsScore });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/standalone/apply — auto-apply (requires standalone auth)
app.post("/api/standalone/apply",
  (req, res, next) => { if (!req.session?.standaloneUserId) return res.status(401).json({ error: "Authentication required" }); next(); },
  standaloneRateLimit("apply", 0, 2),
  standaloneUpload.single("resume"),
  async (req, res) => {
    // Delegates to the same apply logic as the main app via applyRoutes
    // For now: return a structured response indicating the run was accepted
    res.json({ ok: true, results: [], message: "Apply automation not yet wired for standalone mode" });
  }
);

// ═══════════════════════════════════════════════════════════════
// HEALTH + SPA
// ═══════════════════════════════════════════════════════════════
app.get("/api/health", (_req,res) => res.json({ ok:true, time:new Date().toISOString() }));

app.get("*", (req, res) => {
  const index = path.join(CLIENT_DIST,"index.html");
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(404).send("Run: cd client && npm run build");
});

// ── Profile isolation diagnostic ─────────────────────────────
app.get("/api/debug/verify-isolation", requireAuth, (req, res) => {
  const userId  = req.user.id;
  const profile = db.prepare(
    "SELECT * FROM domain_profiles WHERE user_id=? AND is_active=1"
  ).get(userId);
  const wrongJobs = profile ? db.prepare(`
    SELECT sj.title, uj.domain_profile_id, sj.domain_profile_id as scraped_domain_profile_id
    FROM user_jobs uj JOIN scraped_jobs sj ON sj.job_id=uj.job_id
    WHERE uj.user_id=?
      AND (uj.domain_profile_id != ? OR sj.domain_profile_id != ?)
    LIMIT 10
  `).all(userId, profile.id, profile.id) : [];
  const totalJobs   = db.prepare("SELECT COUNT(*) as c FROM user_jobs WHERE user_id=?").get(userId);
  const profileJobs = profile
    ? db.prepare("SELECT COUNT(*) as c FROM user_jobs WHERE user_id=? AND domain_profile_id=?").get(userId, profile.id)
    : { c: 0 };
  res.json({
    activeProfile:        profile?.profile_name ?? null,
    totalJobsInPool:      totalJobs.c,
    jobsMatchingProfile:  profileJobs.c,
    wrongJobsStillPresent: wrongJobs.length,
    wrongJobSamples:      wrongJobs,
    isolated:             wrongJobs.length === 0,
  });
});

app.listen(PORT, () => console.log(`[server] Resume Master v5 on :${PORT}`));
