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
import { launchBrowser, probeBrowserAvailability } from "./services/browserLauncher.js";
import multer         from "multer";
import ExcelJS        from "exceljs";
import crypto         from "crypto";
import { fileURLToPath } from "url";
import path           from "path";
import fs             from "fs";
import { createBackup, listBackups, restoreBackup } from "./scripts/backup.js";
import applyRoutes from "./routes/apply.js";
import { createAccountRouter } from "./routes/account.js";
import { createAdminRouter } from "./routes/admin.js";
import { createAdminDbRouter } from "./routes/adminDb.js";
import { createDomainProfilesRouter } from "./routes/domainProfiles.js";
import { createImportedJobsRouter } from "./routes/importedJobs.js";
import { createImportSourcesRouter } from "./routes/importSources.js";
import { trackApiCall, trackScrape } from "./services/usageTracker.js";
import { checkLimit } from "./services/limitEnforcer.js";
import { loadAllPrompts, assemblePrompt } from "./services/promptAssembler.js";
import { classify } from "./services/classifier.js";
import { resolveFromClassifier, getDomainModuleKey, getSearchQueryTemplates } from "./services/qualificationResolver.js";
import { normaliseRole, buildApifyQueries, buildApifyQueriesFromProfile, buildProfileSearchTerms, isTitleRelevant as isTitleRelevantNew, isTitleRelevantToProfile } from "./services/searchQueryBuilder.js";
import { getRoleKeyForProfile as _getRoleKeyForProfile, classifyForIngest, getRoleFamilyDomainForKey, roleTitleSql } from "./services/jobClassifier.js";
import { inferWorkType, jobHash, normaliseItem, isFullTimeNorm, isEmploymentTypeWanted, parseYearsExperience, ghostJobScoreNorm, isReposted } from "./services/jobNormalization.js";
import { profileTitleSql } from "./services/profileTitleFilter.js";
import { hashPassword, verifyPassword, validatePassword } from "./services/authSecurity.js";
import { createPasswordReset, consumePasswordReset, findUserForPasswordReset } from "./services/passwordResetService.js";
import { sendPasswordResetEmail } from "./services/emailService.js";
import { allowedModesForTier, canUseAPlusResume, canUseGenerate, canUseMode, hasPlanAtLeast, nextPlan, normalisePlanTier, planForMode } from "./services/entitlements.js";
import {
  normalizeResumeHtml as formatterNormalizeResumeHtml,
  stripResumeHtml as formatterStripResumeHtml,
} from "./services/resumeFormatter.js";
import {
  buildAtsResumeBasis,
  extractUserYearsExperience,
  getBaseResumeRecord,
  loadOrCreateSimpleApplyProfile,
  loadSimpleApplyProfile,
  normaliseStructuredFacts,
  profileHasBaseResume,
  saveBaseResumeRecord,
  upsertSimpleApplyProfile,
} from "./services/simpleApplyProfile.js";
import {
  aggregateAtsMissingSignals,
  buildSelectedEnhancementSkills,
  computeEnhancementStatus,
  insertProfileEnhancementHistory,
  listProfileEnhancementHistory,
  markSelectedSuggestionsApplied,
} from "./services/profileSignalAggregator.js";
import {
  INTEGRATION_PROVIDERS,
  getAutomationReadiness,
  publicIntegrationRow,
} from "./services/integrationReadiness.js";

// ── Config ────────────────────────────────────────────────────
const PORT           = process.env.PORT           || 3001;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY  || "";
// NOTE: There is NO server-level APIFY_TOKEN.
// Each user stores their own token in the DB (users.apify_token).
// The cron job borrows the most recently active user's token.
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-in-production";
const PASSWORD_RESET_SECRET = process.env.PASSWORD_RESET_SECRET || SESSION_SECRET;
const ADMIN_USER     = process.env.ADMIN_USER     || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const OAUTH_PROVIDER_CONFIG = {
  google: {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI || "",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: ["openid", "email", "profile"],
  },
  linkedin: {
    clientId: process.env.LINKEDIN_OAUTH_CLIENT_ID || "",
    clientSecret: process.env.LINKEDIN_OAUTH_CLIENT_SECRET || "",
    redirectUri: process.env.LINKEDIN_OAUTH_REDIRECT_URI || "",
    authUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    userInfoUrl: "https://api.linkedin.com/v2/userinfo",
    scopes: ["openid", "profile", "email"],
  },
};
const OAUTH_PROVIDERS = ["google", "linkedin"];
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

const ATS_SCORE_PROMPT_VERSION = "ats-score-v1";

const RESUME_STYLE_BLOCK = `<style>
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
</style>`;

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function stripResumeHtml(html) {
  return formatterStripResumeHtml(html);
}

function jobAtsSource(job = {}) {
  return [
    job.company || "",
    job.title || "",
    job.category || "",
    job.description || job.title || "",
  ].join("\n");
}

function buildAtsCacheKey(html, job) {
  return hashText([
    ATS_SCORE_PROMPT_VERSION,
    hashText(stripResumeHtml(html)),
    hashText(jobAtsSource(job)),
  ].join(":"));
}

function parseJsonMaybe(text, fallback = null) {
  try { return JSON.parse(text || "null"); } catch { return fallback; }
}

function legacyModeForTool(tool) {
  return tool === "a_plus_resume" ? "CUSTOM_SAMPLER" : "TAILORED";
}

function promptModeForTool(tool) {
  return tool === "a_plus_resume" ? "A_PLUS" : "GENERATE";
}

function eventSubtypeForTool(tool) {
  return tool === "a_plus_resume" ? "A_PLUS" : "GENERATE";
}

function displayModeForPrompt(mode) {
  const key = String(mode || "").toUpperCase();
  if (key === "CUSTOM_SAMPLER" || key === "A_PLUS") return "A+";
  return "Generate";
}

function normalizeResumeHtml(html) {
  return formatterNormalizeResumeHtml(html);
}

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
          apply_mode TEXT NOT NULL DEFAULT 'SIMPLE',
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
          apply_mode TEXT NOT NULL DEFAULT 'SIMPLE',
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
    {
      id: "031_shared_job_role_map",
      sql: `
        CREATE TABLE IF NOT EXISTS job_role_map (
          job_id TEXT NOT NULL REFERENCES scraped_jobs(job_id) ON DELETE CASCADE,
          role_key TEXT NOT NULL,
          role_family TEXT,
          domain TEXT,
          source_profile_id INTEGER REFERENCES domain_profiles(id) ON DELETE SET NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          matched_by TEXT NOT NULL DEFAULT 'profile_scrape',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (job_id, role_key)
        );
        CREATE INDEX IF NOT EXISTS idx_job_role_map_role
          ON job_role_map(role_key, job_id);
        CREATE INDEX IF NOT EXISTS idx_job_role_map_job
          ON job_role_map(job_id);

        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, source_profile_id, confidence, matched_by)
        SELECT sj.job_id,
               LOWER(COALESCE(NULLIF(dp.role_family, ''), dp.domain)),
               dp.role_family,
               dp.domain,
               dp.id,
               0.8,
               'legacy_domain_profile_id'
        FROM scraped_jobs sj
        JOIN domain_profiles dp ON dp.id = sj.domain_profile_id;

        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, confidence, matched_by)
        SELECT job_id, 'engineering', 'engineering', 'engineering', 0.6, 'title_heuristic'
        FROM scraped_jobs
        WHERE LOWER(title) LIKE '%engineer%'
           OR LOWER(title) LIKE '%developer%'
           OR LOWER(title) LIKE '%software%'
           OR LOWER(title) LIKE '%devops%'
           OR LOWER(title) LIKE '%sre%'
           OR LOWER(title) LIKE '%backend%'
           OR LOWER(title) LIKE '%frontend%'
           OR LOWER(title) LIKE '%full stack%'
           OR LOWER(title) LIKE '%fullstack%';

        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, confidence, matched_by)
        SELECT job_id, 'pm', 'pm', 'pm_general', 0.6, 'title_heuristic'
        FROM scraped_jobs
        WHERE LOWER(title) LIKE '%project%'
           OR LOWER(title) LIKE '%program%'
           OR LOWER(title) LIKE '%product%'
           OR LOWER(title) LIKE '%scrum%'
           OR LOWER(title) LIKE '%pmo%'
           OR LOWER(title) LIKE '%delivery manager%';

        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, confidence, matched_by)
        SELECT job_id, 'data', 'data', 'data', 0.6, 'title_heuristic'
        FROM scraped_jobs
        WHERE LOWER(title) LIKE '%data%'
           OR LOWER(title) LIKE '%analytics%'
           OR LOWER(title) LIKE '%analyst%'
           OR LOWER(title) LIKE '%scientist%'
           OR LOWER(title) LIKE '%machine learning%'
           OR LOWER(title) LIKE '%business intelligence%';
      `,
    },
    {
      id: "032_password_reset_tokens",
      sql: `
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          email TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          otp_hash TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          used_at INTEGER,
          requested_at INTEGER NOT NULL DEFAULT (unixepoch()),
          request_ip TEXT,
          user_agent TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_password_reset_user
          ON password_reset_tokens(user_id, used_at, expires_at);
        CREATE INDEX IF NOT EXISTS idx_password_reset_expires
          ON password_reset_tokens(expires_at);
      `,
    },
    {
      id: "033_plan_tiers_and_simple_apply_profile",
      sql: `
        ALTER TABLE users ADD COLUMN plan_tier TEXT NOT NULL DEFAULT 'BASIC';
        UPDATE users
        SET plan_tier = CASE
          WHEN apply_mode = 'CUSTOM_SAMPLER' THEN 'PRO'
          WHEN apply_mode = 'TAILORED' THEN 'PLUS'
          ELSE 'BASIC'
        END;

        CREATE TABLE IF NOT EXISTS plan_upgrade_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          requested_tier TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          requested_at INTEGER NOT NULL DEFAULT (unixepoch()),
          decided_at INTEGER,
          decided_by INTEGER REFERENCES users(id),
          notes TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_plan_upgrade_requests_status
          ON plan_upgrade_requests(status, requested_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_upgrade_one_pending
          ON plan_upgrade_requests(user_id) WHERE status = 'pending';

        CREATE TABLE IF NOT EXISTS simple_apply_profiles (
          user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          titles_json TEXT NOT NULL DEFAULT '[]',
          keywords_json TEXT NOT NULL DEFAULT '[]',
          skills_json TEXT NOT NULL DEFAULT '[]',
          search_terms_json TEXT NOT NULL DEFAULT '[]',
          source_hash TEXT,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `,
    },
    {
      id: "034_plan_reset_and_profile_repair",
      sql: `
        UPDATE users
        SET plan_tier = 'BASIC'
        WHERE plan_tier IS NULL
           OR plan_tier NOT IN ('BASIC','PLUS','PRO');

        UPDATE users
        SET apply_mode = CASE plan_tier
          WHEN 'PRO' THEN 'CUSTOM_SAMPLER'
          WHEN 'PLUS' THEN 'TAILORED'
          ELSE 'SIMPLE'
        END
        WHERE apply_mode IS NULL
           OR apply_mode NOT IN ('SIMPLE','TAILORED','CUSTOM_SAMPLER')
           OR (plan_tier = 'BASIC' AND apply_mode != 'SIMPLE')
           OR (plan_tier = 'PLUS' AND apply_mode != 'TAILORED')
           OR (plan_tier = 'PRO' AND apply_mode != 'CUSTOM_SAMPLER');

        DELETE FROM password_reset_tokens
        WHERE used_at IS NOT NULL
           OR expires_at <= unixepoch() - 86400;

        DELETE FROM user_jobs
        WHERE applied = 0
          AND (
            domain_profile_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM domain_profiles dp
              WHERE dp.id = user_jobs.domain_profile_id
                AND dp.user_id = user_jobs.user_id
            )
          );
      `,
    },
    {
      id: "035_prune_stale_role_maps",
      sql: `
        DELETE FROM job_role_map
        WHERE role_key = 'engineering'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%engineer%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%developer%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%software%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%programmer%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%devops%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%sre%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%architect%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%backend%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%frontend%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%fullstack%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%full stack%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%platform%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%infrastructure%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%cloud%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%systems%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%security%';

        DELETE FROM user_jobs
        WHERE applied = 0
          AND NOT EXISTS (
            SELECT 1 FROM job_role_map jrm
            JOIN domain_profiles dp
              ON dp.id = user_jobs.domain_profile_id
             AND jrm.role_key = LOWER(COALESCE(NULLIF(dp.role_family, ''), dp.domain))
            WHERE jrm.job_id = user_jobs.job_id
          );
      `,
    },
    {
      id: "036_console_tier_profile_repair",
      sql: `
        UPDATE users
        SET plan_tier = 'BASIC'
        WHERE plan_tier IS NULL
           OR plan_tier NOT IN ('BASIC','PLUS','PRO');

        UPDATE users
        SET apply_mode = CASE plan_tier
          WHEN 'PRO' THEN 'CUSTOM_SAMPLER'
          WHEN 'PLUS' THEN 'TAILORED'
          ELSE 'SIMPLE'
        END
        WHERE apply_mode IS NULL
           OR apply_mode NOT IN ('SIMPLE','TAILORED','CUSTOM_SAMPLER')
           OR (plan_tier = 'BASIC' AND apply_mode != 'SIMPLE')
           OR (plan_tier = 'PLUS' AND apply_mode != 'TAILORED')
           OR (plan_tier = 'PRO' AND apply_mode != 'CUSTOM_SAMPLER');

        DELETE FROM job_role_map
        WHERE job_id NOT IN (SELECT job_id FROM scraped_jobs);

        DELETE FROM job_role_map
        WHERE role_key = 'engineering'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%engineer%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%developer%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%software%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%programmer%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%devops%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%sre%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%architect%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%backend%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%frontend%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%fullstack%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%full stack%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%platform%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%infrastructure%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%cloud%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%systems%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%security%';

        DELETE FROM job_role_map
        WHERE role_key = 'pm'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%project%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%program%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%product%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%manager%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%coordinator%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%director%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%agile%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%scrum%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%pmo%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%delivery%';

        DELETE FROM job_role_map
        WHERE role_key = 'data'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%data%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%analytics%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%analyst%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%scientist%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%machine learning%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%ml%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%ai%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%business intelligence%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%bi%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%research%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%quantitative%';

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
              SELECT 1
              FROM domain_profiles dp
              JOIN job_role_map jrm
                ON jrm.job_id = user_jobs.job_id
               AND jrm.role_key = LOWER(COALESCE(NULLIF(dp.role_family, ''), dp.domain))
              WHERE dp.id = user_jobs.domain_profile_id
                AND dp.user_id = user_jobs.user_id
            )
          );
      `,
    },
    {
      id: "037_domain_profile_requests",
      sql: `
        CREATE TABLE IF NOT EXISTS domain_profile_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          desired_title TEXT NOT NULL,
          role_family TEXT,
          target_titles_json TEXT NOT NULL DEFAULT '[]',
          skills_json TEXT NOT NULL DEFAULT '[]',
          tools_json TEXT NOT NULL DEFAULT '[]',
          industries_json TEXT NOT NULL DEFAULT '[]',
          keywords_json TEXT NOT NULL DEFAULT '[]',
          seniority TEXT,
          work_preference TEXT,
          notes TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_domain_profile_requests_status
          ON domain_profile_requests(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_domain_profile_requests_user
          ON domain_profile_requests(user_id, created_at);
      `,
    },
    {
      id: "038_role_map_ml_pm_repair",
      sql: `
        DELETE FROM job_role_map
        WHERE role_key = 'engineering'
          AND job_id IN (
            SELECT job_id FROM scraped_jobs
            WHERE LOWER(title) LIKE '%machine learning%'
               OR LOWER(title) LIKE '%ml engineer%'
               OR LOWER(title) LIKE '%ai engineer%'
               OR LOWER(title) LIKE '%artificial intelligence%'
               OR LOWER(title) LIKE '%llm%'
               OR LOWER(title) LIKE '%genai%'
               OR LOWER(title) LIKE '%generative ai%'
               OR LOWER(title) LIKE '%project manager%'
               OR LOWER(title) LIKE '%program manager%'
               OR LOWER(title) LIKE '%product manager%'
               OR LOWER(title) LIKE '%project coordinator%'
               OR LOWER(title) LIKE '%scrum master%'
               OR LOWER(title) LIKE '%pmo%'
          );

        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, confidence, matched_by)
        SELECT job_id, 'data', 'data', 'data', 0.95, 'ml_ai_repair'
        FROM scraped_jobs
        WHERE LOWER(title) LIKE '%machine learning%'
           OR LOWER(title) LIKE '%ml engineer%'
           OR LOWER(title) LIKE '%ai engineer%'
           OR LOWER(title) LIKE '%artificial intelligence%'
           OR LOWER(title) LIKE '%llm%'
           OR LOWER(title) LIKE '%genai%'
           OR LOWER(title) LIKE '%generative ai%';

        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, confidence, matched_by)
        SELECT job_id, 'pm', 'pm', 'pm_general', 0.95, 'pm_repair'
        FROM scraped_jobs
        WHERE LOWER(title) LIKE '%project manager%'
           OR LOWER(title) LIKE '%program manager%'
           OR LOWER(title) LIKE '%product manager%'
           OR LOWER(title) LIKE '%project coordinator%'
           OR LOWER(title) LIKE '%scrum master%'
           OR LOWER(title) LIKE '%pmo%';
      `,
    },
    {
      id: "039_resume_version_tool_artifacts",
      sql: `
        ALTER TABLE resume_versions ADD COLUMN tool_type TEXT NOT NULL DEFAULT 'generate';
        ALTER TABLE resume_versions ADD COLUMN is_kept INTEGER NOT NULL DEFAULT 0;
        UPDATE resume_versions
        SET tool_type = CASE
          WHEN EXISTS (
            SELECT 1 FROM resumes r
            WHERE r.user_id = resume_versions.user_id
              AND r.job_id = resume_versions.job_id
              AND r.apply_mode = 'CUSTOM_SAMPLER'
          ) THEN 'a_plus_resume'
          ELSE 'generate'
        END
        WHERE tool_type IS NULL OR tool_type = '';
      `,
    },
    {
      id: "040_tab_scoped_auth_contexts",
      sql: `
        CREATE TABLE IF NOT EXISTS auth_contexts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token_hash TEXT NOT NULL UNIQUE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER,
          user_agent TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_auth_contexts_user
          ON auth_contexts(user_id, revoked_at, expires_at);
        CREATE INDEX IF NOT EXISTS idx_auth_contexts_expiry
          ON auth_contexts(expires_at, revoked_at);
      `,
    },
    {
      id: "041_resume_ats_cache_metadata",
      sql: `
        ALTER TABLE resumes ADD COLUMN ats_cache_key TEXT;
        ALTER TABLE resumes ADD COLUMN ats_prompt_version TEXT;
        ALTER TABLE resume_versions ADD COLUMN ats_cache_key TEXT;
        ALTER TABLE resume_versions ADD COLUMN ats_prompt_version TEXT;
        CREATE INDEX IF NOT EXISTS idx_resume_versions_ats_cache
          ON resume_versions(user_id, job_id, tool_type, ats_cache_key);
      `,
    },
    {
      id: "042_apply_runs_queue",
      sql: `
        CREATE TABLE IF NOT EXISTS apply_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          mode TEXT NOT NULL DEFAULT 'auto',
          tool_type TEXT,
          status TEXT NOT NULL DEFAULT 'queued',
          total_jobs INTEGER NOT NULL DEFAULT 0,
          submitted_count INTEGER NOT NULL DEFAULT 0,
          held_count INTEGER NOT NULL DEFAULT 0,
          failed_count INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER,
          finished_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS apply_run_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES apply_runs(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          reason_code TEXT,
          reason_detail TEXT,
          ats_score INTEGER,
          resume_id INTEGER,
          resume_file TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          locked_at INTEGER,
          started_at INTEGER,
          finished_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(run_id, job_id)
        );
        CREATE TABLE IF NOT EXISTS apply_job_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER,
          run_job_id INTEGER,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_id TEXT,
          level TEXT NOT NULL DEFAULT 'info',
          event TEXT NOT NULL,
          message TEXT,
          details_json TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_apply_runs_user_status ON apply_runs(user_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_apply_run_jobs_user_status ON apply_run_jobs(user_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_apply_logs_run ON apply_job_logs(run_id, run_job_id, created_at);
      `,
    },
    {
      id: "043_user_integrations",
      sql: `
        CREATE TABLE IF NOT EXISTS user_integrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          account_email TEXT,
          status TEXT NOT NULL DEFAULT 'connected',
          scopes_json TEXT NOT NULL DEFAULT '[]',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          secret_enc TEXT,
          iv TEXT,
          auth_tag TEXT,
          expires_at INTEGER,
          last_checked_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(user_id, provider)
        );
        CREATE INDEX IF NOT EXISTS idx_user_integrations_user_provider
          ON user_integrations(user_id, provider, status);
      `,
    },
    {
      id: "044_auth_provider_links",
      sql: `
        ALTER TABLE users ADD COLUMN google_auth_id TEXT;
        ALTER TABLE users ADD COLUMN linkedin_auth_id TEXT;
        ALTER TABLE user_integrations ADD COLUMN provider_user_id TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_auth_id
          ON users(google_auth_id) WHERE google_auth_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_linkedin_auth_id
          ON users(linkedin_auth_id) WHERE linkedin_auth_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_user_integrations_provider_identity
          ON user_integrations(provider, provider_user_id);
      `,
    },
    {
      // Repair: firmware/embedded jobs were bulk-assigned role_key='engineering' by
      // the title_heuristic in migration 031 and were never corrected.  This migration:
      //   1. Adds role_key='engineering_embedded_firmware' for jobs scraped under
      //      firmware domain profiles.
      //   2. Adds role_key='engineering_embedded_firmware' for jobs whose title
      //      clearly indicates firmware/embedded work (title heuristic).
      //   3. Removes the stale role_key='engineering' entries that arrived via the
      //      generic title_heuristic for those same jobs — so SWE users never see
      //      them even if roleKeyForProfile returns 'engineering'.
      //   Jobs that were explicitly scraped under a SWE profile (matched_by =
      //   'profile_scrape') keep their 'engineering' entry so they remain visible
      //   to the scraping user; the roleTitleSql firmware exclusions still prevent
      //   them from surfacing in SWE results for other users.
      id: "045_firmware_role_map_repair",
      sql: `
        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, confidence, matched_by)
        SELECT jrm.job_id,
               'engineering_embedded_firmware',
               'engineering',
               'engineering_embedded_firmware',
               0.95,
               'firmware_profile_repair'
        FROM job_role_map jrm
        JOIN domain_profiles dp ON dp.id = jrm.source_profile_id
        WHERE jrm.role_key = 'engineering'
          AND dp.domain = 'engineering_embedded_firmware';

        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, confidence, matched_by)
        SELECT job_id,
               'engineering_embedded_firmware',
               'engineering',
               'engineering_embedded_firmware',
               0.9,
               'firmware_title_repair'
        FROM scraped_jobs
        WHERE LOWER(title) LIKE '%firmware%'
           OR LOWER(title) LIKE '%embedded%'
           OR LOWER(title) LIKE '%bsp%'
           OR LOWER(title) LIKE '%device driver%'
           OR LOWER(title) LIKE '%silicon validation%'
           OR LOWER(title) LIKE '%post-silicon%'
           OR LOWER(title) LIKE '%post silicon%'
           OR LOWER(title) LIKE '%soc bring%'
           OR LOWER(title) LIKE '%board bring%'
           OR LOWER(title) LIKE '%chip bring%'
           OR LOWER(title) LIKE '%bootloader%'
           OR LOWER(title) LIKE '%rtos%'
           OR LOWER(title) LIKE '% bios %'
           OR LOWER(title) LIKE 'bios %'
           OR LOWER(title) LIKE '%uefi%';

        DELETE FROM job_role_map
        WHERE role_key = 'engineering'
          AND matched_by = 'title_heuristic'
          AND job_id IN (
            SELECT job_id FROM scraped_jobs
            WHERE LOWER(title) LIKE '%firmware%'
               OR LOWER(title) LIKE '%embedded%'
               OR LOWER(title) LIKE '%bsp%'
               OR LOWER(title) LIKE '%device driver%'
               OR LOWER(title) LIKE '%silicon validation%'
               OR LOWER(title) LIKE '%post-silicon%'
               OR LOWER(title) LIKE '%post silicon%'
               OR LOWER(title) LIKE '%soc bring%'
               OR LOWER(title) LIKE '%board bring%'
               OR LOWER(title) LIKE '%chip bring%'
               OR LOWER(title) LIKE '%bootloader%'
               OR LOWER(title) LIKE '%rtos%'
               OR LOWER(title) LIKE '% bios %'
               OR LOWER(title) LIKE 'bios %'
               OR LOWER(title) LIKE '%uefi%'
          );
      `,
    },
    {
      // Repair: data scientist / data engineer / analytics engineer titles
      // were incorrectly assigned role_key='engineering' in two ways:
      //   1. Scraped under an engineering profile (assignJobRoleMap => 'engineering')
      //   2. Title matched '%engineer%' / '%developer%' in migration 031 heuristic
      // Migration 038 already handled ML/AI/PM titles.  This migration extends that
      // repair to cover data-family specialty titles that were missed.
      //
      // Only removes heuristic and profile-scrape engineering entries — manual_review
      // entries are preserved (admin override must win).
      id: "046_data_specialty_role_repair",
      sql: `
        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, confidence, matched_by)
        SELECT job_id, 'data', 'data', 'data', 0.95, 'data_specialty_repair'
        FROM scraped_jobs
        WHERE LOWER(title) LIKE '%data scientist%'
           OR LOWER(title) LIKE '%data engineer%'
           OR LOWER(title) LIKE '%analytics engineer%'
           OR LOWER(title) LIKE '%research scientist%'
           OR LOWER(title) LIKE '%applied scientist%'
           OR LOWER(title) LIKE '%ml platform engineer%'
           OR LOWER(title) LIKE '%mlops engineer%';

        DELETE FROM job_role_map
        WHERE role_key = 'engineering'
          AND matched_by IN ('title_heuristic', 'legacy_domain_profile_id',
                             'duplicate_profile_scrape', 'profile_scrape')
          AND job_id IN (
            SELECT job_id FROM scraped_jobs
            WHERE LOWER(title) LIKE '%data scientist%'
               OR LOWER(title) LIKE '%data engineer%'
               OR LOWER(title) LIKE '%analytics engineer%'
               OR LOWER(title) LIKE '%research scientist%'
               OR LOWER(title) LIKE '%applied scientist%'
               OR LOWER(title) LIKE '%ml platform engineer%'
               OR LOWER(title) LIKE '%mlops engineer%'
          );
      `,
    },
    {
      // 047 — Repair existing orphaned jobs that have no job_role_map entry.
      //
      // These are jobs that were scraped without a domainProfile (admin scrapes,
      // profiles deleted post-scrape, or pre-046 legacy ingests) and therefore
      // fell through the assignJobRoleMap() guard.  The ingest-time classifier
      // now handles new orphans; this migration back-fills the historical gap
      // using the same high-confidence title patterns.
      //
      // Only assigns role_key when the title strongly matches a single family.
      // Preserves manual_review entries — admin overrides are never touched.
      id: "047_orphaned_job_classifier_repair",
      sql: `
        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, confidence, matched_by)
        SELECT sj.job_id,
               CASE
                 WHEN LOWER(sj.title) LIKE '%firmware engineer%'
                   OR LOWER(sj.title) LIKE '%embedded systems engineer%'
                   OR LOWER(sj.title) LIKE '%bsp engineer%'
                   OR LOWER(sj.title) LIKE '%uefi engineer%'
                   OR LOWER(sj.title) LIKE '%device driver engineer%'
                   OR LOWER(sj.title) LIKE '%bootloader engineer%'
                   OR LOWER(sj.title) LIKE '%rtos engineer%'
                 THEN 'engineering_embedded_firmware'
                 WHEN LOWER(sj.title) LIKE '%machine learning engineer%'
                   OR LOWER(sj.title) LIKE '%data scientist%'
                   OR LOWER(sj.title) LIKE '%data engineer%'
                   OR LOWER(sj.title) LIKE '%analytics engineer%'
                   OR LOWER(sj.title) LIKE '%ml engineer%'
                   OR LOWER(sj.title) LIKE '%ai engineer%'
                   OR LOWER(sj.title) LIKE '%research scientist%'
                   OR LOWER(sj.title) LIKE '%applied scientist%'
                 THEN 'data'
                 WHEN LOWER(sj.title) LIKE '%product manager%'
                   OR LOWER(sj.title) LIKE '%project manager%'
                   OR LOWER(sj.title) LIKE '%program manager%'
                   OR LOWER(sj.title) LIKE '%scrum master%'
                   OR LOWER(sj.title) LIKE '%product owner%'
                 THEN 'pm'
                 WHEN LOWER(sj.title) LIKE '%software engineer%'
                   OR LOWER(sj.title) LIKE '%backend engineer%'
                   OR LOWER(sj.title) LIKE '%frontend engineer%'
                   OR LOWER(sj.title) LIKE '%full stack engineer%'
                   OR LOWER(sj.title) LIKE '%devops engineer%'
                   OR LOWER(sj.title) LIKE '%site reliability engineer%'
                   OR LOWER(sj.title) LIKE '%software developer%'
                   OR LOWER(sj.title) LIKE '%platform engineer%'
                   OR LOWER(sj.title) LIKE '%mobile engineer%'
                 THEN 'engineering'
               END AS role_key,
               CASE
                 WHEN LOWER(sj.title) LIKE '%firmware engineer%'
                   OR LOWER(sj.title) LIKE '%embedded systems engineer%'
                   OR LOWER(sj.title) LIKE '%bsp engineer%'
                   OR LOWER(sj.title) LIKE '%uefi engineer%'
                   OR LOWER(sj.title) LIKE '%device driver engineer%'
                   OR LOWER(sj.title) LIKE '%bootloader engineer%'
                   OR LOWER(sj.title) LIKE '%rtos engineer%'
                 THEN 'engineering'
                 WHEN LOWER(sj.title) LIKE '%machine learning engineer%'
                   OR LOWER(sj.title) LIKE '%data scientist%'
                   OR LOWER(sj.title) LIKE '%data engineer%'
                   OR LOWER(sj.title) LIKE '%analytics engineer%'
                   OR LOWER(sj.title) LIKE '%ml engineer%'
                   OR LOWER(sj.title) LIKE '%ai engineer%'
                   OR LOWER(sj.title) LIKE '%research scientist%'
                   OR LOWER(sj.title) LIKE '%applied scientist%'
                 THEN 'data'
                 ELSE role_key
               END AS role_family,
               CASE
                 WHEN LOWER(sj.title) LIKE '%firmware engineer%'
                   OR LOWER(sj.title) LIKE '%embedded systems engineer%'
                   OR LOWER(sj.title) LIKE '%bsp engineer%'
                   OR LOWER(sj.title) LIKE '%uefi engineer%'
                   OR LOWER(sj.title) LIKE '%device driver engineer%'
                   OR LOWER(sj.title) LIKE '%bootloader engineer%'
                   OR LOWER(sj.title) LIKE '%rtos engineer%'
                 THEN 'engineering_embedded_firmware'
                 WHEN LOWER(sj.title) LIKE '%software engineer%'
                   OR LOWER(sj.title) LIKE '%backend engineer%'
                   OR LOWER(sj.title) LIKE '%frontend engineer%'
                   OR LOWER(sj.title) LIKE '%full stack engineer%'
                   OR LOWER(sj.title) LIKE '%devops engineer%'
                   OR LOWER(sj.title) LIKE '%site reliability engineer%'
                   OR LOWER(sj.title) LIKE '%software developer%'
                   OR LOWER(sj.title) LIKE '%platform engineer%'
                   OR LOWER(sj.title) LIKE '%mobile engineer%'
                 THEN 'it_digital'
                 ELSE role_key
               END AS domain,
               0.85 AS confidence,
               'orphan_repair' AS matched_by
        FROM scraped_jobs sj
        LEFT JOIN job_role_map jrm ON jrm.job_id = sj.job_id
        WHERE jrm.job_id IS NULL
          AND (
            LOWER(sj.title) LIKE '%firmware engineer%'
            OR LOWER(sj.title) LIKE '%embedded systems engineer%'
            OR LOWER(sj.title) LIKE '%bsp engineer%'
            OR LOWER(sj.title) LIKE '%uefi engineer%'
            OR LOWER(sj.title) LIKE '%device driver engineer%'
            OR LOWER(sj.title) LIKE '%bootloader engineer%'
            OR LOWER(sj.title) LIKE '%rtos engineer%'
            OR LOWER(sj.title) LIKE '%machine learning engineer%'
            OR LOWER(sj.title) LIKE '%data scientist%'
            OR LOWER(sj.title) LIKE '%data engineer%'
            OR LOWER(sj.title) LIKE '%analytics engineer%'
            OR LOWER(sj.title) LIKE '%ml engineer%'
            OR LOWER(sj.title) LIKE '%ai engineer%'
            OR LOWER(sj.title) LIKE '%research scientist%'
            OR LOWER(sj.title) LIKE '%applied scientist%'
            OR LOWER(sj.title) LIKE '%product manager%'
            OR LOWER(sj.title) LIKE '%project manager%'
            OR LOWER(sj.title) LIKE '%program manager%'
            OR LOWER(sj.title) LIKE '%scrum master%'
            OR LOWER(sj.title) LIKE '%product owner%'
            OR LOWER(sj.title) LIKE '%software engineer%'
            OR LOWER(sj.title) LIKE '%backend engineer%'
            OR LOWER(sj.title) LIKE '%frontend engineer%'
            OR LOWER(sj.title) LIKE '%full stack engineer%'
            OR LOWER(sj.title) LIKE '%devops engineer%'
            OR LOWER(sj.title) LIKE '%site reliability engineer%'
            OR LOWER(sj.title) LIKE '%software developer%'
            OR LOWER(sj.title) LIKE '%platform engineer%'
            OR LOWER(sj.title) LIKE '%mobile engineer%'
          );
      `,
    },
    {
      // Migration 048 — Re-classify existing job_role_map entries that were assigned
      // role_key='engineering' via automated classifiers but whose title clearly indicates
      // firmware/embedded. Runs in two idempotent steps:
      //
      // Step 1: DELETE stale 'engineering' rows for jobs that already have an
      //   'engineering_embedded_firmware' row — these are duplicates from migration 047,
      //   the ingest classifier, or a prior partial run of 048. Updating them would hit
      //   the UNIQUE(job_id, role_key) constraint. Deleting them is safe because the
      //   correct mapping already exists.
      //
      // Step 2: UPDATE remaining 'engineering' firmware-title rows to
      //   'engineering_embedded_firmware'. After Step 1, no conflict is possible.
      //   Both steps are no-ops on a clean or already-processed database.
      id: "048_firmware_reclassify",
      sql: `
        DELETE FROM job_role_map
        WHERE role_key = 'engineering'
          AND matched_by IN ('profile_scrape','orphan_repair','strong_anchor','strong_anchor+desc')
          AND job_id IN (
            SELECT jrm2.job_id FROM job_role_map jrm2
            WHERE jrm2.role_key = 'engineering_embedded_firmware'
          )
          AND job_id IN (
            SELECT sj.job_id FROM scraped_jobs sj
            WHERE LOWER(sj.title) LIKE '%firmware%'
               OR LOWER(sj.title) LIKE '%embedded system%'
               OR LOWER(sj.title) LIKE '% bsp %'
               OR LOWER(sj.title) LIKE 'bsp %'
               OR LOWER(sj.title) LIKE '%bsp engineer%'
               OR LOWER(sj.title) LIKE '% uefi %'
               OR LOWER(sj.title) LIKE '%uefi engineer%'
               OR LOWER(sj.title) LIKE '%device driver%'
               OR LOWER(sj.title) LIKE '%bootloader%'
               OR LOWER(sj.title) LIKE '% rtos %'
               OR LOWER(sj.title) LIKE '%rtos engineer%'
          );

        UPDATE job_role_map
        SET role_key    = 'engineering_embedded_firmware',
            role_family = 'engineering',
            domain      = 'engineering_embedded_firmware',
            confidence  = 0.88,
            matched_by  = 'firmware_reclassify'
        WHERE role_key = 'engineering'
          AND matched_by IN ('profile_scrape','orphan_repair','strong_anchor','strong_anchor+desc')
          AND job_id IN (
            SELECT sj.job_id FROM scraped_jobs sj
            WHERE LOWER(sj.title) LIKE '%firmware%'
               OR LOWER(sj.title) LIKE '%embedded system%'
               OR LOWER(sj.title) LIKE '% bsp %'
               OR LOWER(sj.title) LIKE 'bsp %'
               OR LOWER(sj.title) LIKE '%bsp engineer%'
               OR LOWER(sj.title) LIKE '% uefi %'
               OR LOWER(sj.title) LIKE '%uefi engineer%'
               OR LOWER(sj.title) LIKE '%device driver%'
               OR LOWER(sj.title) LIKE '%bootloader%'
               OR LOWER(sj.title) LIKE '% rtos %'
               OR LOWER(sj.title) LIKE '%rtos engineer%'
          );
      `,
    },
    {
      id: "049_simple_apply_profile_yoe",
      sql: `
        ALTER TABLE simple_apply_profiles ADD COLUMN years_experience INTEGER;
      `,
    },
    {
      id: "050_profile_scoped_resume_signals",
      sql: `
        CREATE TABLE IF NOT EXISTS profile_base_resumes (
          profile_id INTEGER PRIMARY KEY REFERENCES domain_profiles(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT,
          content TEXT NOT NULL,
          enhanced_content TEXT,
          enhanced_at INTEGER,
          enhanced_ats_delta INTEGER,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_profile_base_resumes_user
          ON profile_base_resumes(user_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS profile_simple_apply_profiles (
          profile_id INTEGER PRIMARY KEY REFERENCES domain_profiles(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          titles_json TEXT NOT NULL DEFAULT '[]',
          keywords_json TEXT NOT NULL DEFAULT '[]',
          skills_json TEXT NOT NULL DEFAULT '[]',
          search_terms_json TEXT NOT NULL DEFAULT '[]',
          source_hash TEXT,
          years_experience INTEGER,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_profile_simple_apply_profiles_user
          ON profile_simple_apply_profiles(user_id, updated_at DESC);
      `,
    },
    {
      id: "051_imported_saved_jobs",
      sql: `
        CREATE TABLE IF NOT EXISTS imported_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          source_key TEXT NOT NULL,
          source_label TEXT NOT NULL,
          source_platform TEXT NOT NULL,
          external_job_id TEXT,
          dedupe_key TEXT NOT NULL,
          title TEXT NOT NULL,
          company TEXT NOT NULL,
          location TEXT,
          job_url TEXT,
          apply_url TEXT,
          work_type TEXT,
          employment_type TEXT,
          compensation TEXT,
          posted_at TEXT,
          description TEXT,
          company_icon_url TEXT,
          payload_json TEXT,
          visited INTEGER NOT NULL DEFAULT 0,
          starred INTEGER NOT NULL DEFAULT 0,
          disliked INTEGER NOT NULL DEFAULT 0,
          applied INTEGER NOT NULL DEFAULT 0,
          import_count INTEGER NOT NULL DEFAULT 1,
          first_imported_at INTEGER NOT NULL DEFAULT (unixepoch()),
          last_imported_at INTEGER NOT NULL DEFAULT (unixepoch()),
          last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(user_id, source_key, dedupe_key)
        );
        CREATE INDEX IF NOT EXISTS idx_imported_jobs_user_source
          ON imported_jobs(user_id, source_key, last_imported_at DESC);
        CREATE INDEX IF NOT EXISTS idx_imported_jobs_user_flags
          ON imported_jobs(user_id, disliked, starred, applied);

        CREATE TABLE IF NOT EXISTS import_extension_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token_hash TEXT NOT NULL UNIQUE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          source_key TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          expires_at INTEGER NOT NULL,
          last_used_at INTEGER,
          consumed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_import_extension_tokens_user
          ON import_extension_tokens(user_id, source_key, expires_at);
      `,
    },
    {
      id: "052_profile_enhancement_signals",
      sql: `
        ALTER TABLE profile_simple_apply_profiles ADD COLUMN citizenship_status TEXT;
        ALTER TABLE profile_simple_apply_profiles ADD COLUMN work_authorization TEXT;
        ALTER TABLE profile_simple_apply_profiles ADD COLUMN requires_sponsorship INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE profile_simple_apply_profiles ADD COLUMN has_clearance INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE profile_simple_apply_profiles ADD COLUMN clearance_level TEXT;
        ALTER TABLE profile_simple_apply_profiles ADD COLUMN degree_level TEXT;
        ALTER TABLE profile_simple_apply_profiles ADD COLUMN enhancement_notified_at INTEGER;

        CREATE TABLE IF NOT EXISTS profile_signal_suggestions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES domain_profiles(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          signal_key TEXT NOT NULL,
          signal_label TEXT NOT NULL,
          signal_kind TEXT NOT NULL,
          structured_field TEXT,
          frequency INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'inactive',
          first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
          last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
          selected_at INTEGER,
          applied_at INTEGER,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(profile_id, signal_key)
        );
        CREATE INDEX IF NOT EXISTS idx_profile_signal_suggestions_profile
          ON profile_signal_suggestions(profile_id, status, signal_kind, frequency DESC);

        CREATE TABLE IF NOT EXISTS profile_resume_enhancements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES domain_profiles(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          base_resume_content TEXT NOT NULL,
          enhanced_content TEXT NOT NULL,
          selected_skills_json TEXT NOT NULL DEFAULT '[]',
          ats_delta INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          adopted_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_profile_resume_enhancements_profile
          ON profile_resume_enhancements(profile_id, created_at DESC);
      `,
    },
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
    .run(ADMIN_USER, hashPassword(ADMIN_PASSWORD));
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

// ── Helpers (extracted to services/jobNormalization.js) ───────
// inferWorkType, jobHash, normaliseItem, isFullTimeNorm,
// isEmploymentTypeWanted, parseYearsExperience, ghostJobScoreNorm,
// isReposted are now imported from services/jobNormalization.js

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
    maxItems:       scrapeParams.maxItems || MAX_JOBS_PER_REFRESH * 3,
  };
  if (scrapeParams.threadId) {
    logSearchThread(scrapeParams.threadId, "apify_payload", {
      jobTitles,
      workplaceType: input.workplaceType,
      employmentType: input.employmentType,
      postedLimit: input.postedLimit,
      location: input.locations[0],
      maxItems: input.maxItems,
    });
  }
  console.log(`[scrape] Apify input: titles=[${jobTitles.join(",")}] workplaceType=${input.workplaceType} empType=${input.employmentType} postedLimit=${input.postedLimit} location=${input.locations[0]} maxItems=${input.maxItems}`);
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
  const domainProfile = domainProfileId
    ? db.prepare("SELECT * FROM domain_profiles WHERE id=?").get(domainProfileId)
    : null;
  // Derive userId from domainProfileId for ATS scoring and usage tracking
  const userId = domainProfile?.user_id ?? null;
  console.log(`[scrape] "${query}" — HarvestAPI (${profileTitles ? profileTitles.length + " profile titles" : "single query"})`);
  let rawItems = [];
  try {
    rawItems = await scrapeHarvestAPI(query, apifyToken, scrapeParams);
    console.log(`[scrape] HarvestAPI: ${rawItems.length} raw items`);
  } catch(e) {
    if (isExternalScrapeQuotaError(e)) {
      console.warn("[scrape] HarvestAPI quota exhausted:", e.message);
    } else {
      console.warn("[scrape] HarvestAPI failed:", e.message);
    }
    throw e;
  }

  const combined = rawItems.map(j => normaliseItem(j));

  let cntNoTitle = 0, cntNoApply = 0, cntNotFT = 0, cntIrrelevant = 0, cntRepost = 0, cntGhost = 0, cntDup = 0, cntYoeMismatch = 0, cntProfileFactMismatch = 0;
  const profileFactDrops = { clearance: 0, citizenship: 0, sponsorship: 0 };
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
          return tokens.length > 0 && tokens.every(t => titleLower.includes(t));
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

  const profileTitlesForSignals = domainProfile ? (() => {
    try { return JSON.parse(domainProfile.target_titles || "[]"); } catch { return []; }
  })() : [];
  const signalProfile = domainProfile
    ? loadOrCreateSimpleApplyProfile(db, {
        userId,
        profileId: domainProfile.id,
        roleTitles: profileTitlesForSignals,
      })
    : null;
  const maxAllowedYoe = signalProfile?.yearsExperience != null
    ? signalProfile.yearsExperience + 2
    : null;
  const eligible = filtered.filter(item => {
    if (maxAllowedYoe != null) {
      const yoe = parseYearsExperience(item.description || "");
      if (yoe.min != null && yoe.min > maxAllowedYoe) {
        cntYoeMismatch++;
        return false;
      }
    }
    const factCheck = evaluateProfileFactEligibility(item, signalProfile);
    if (!factCheck.ok) {
      cntProfileFactMismatch++;
      if (factCheck.reason && profileFactDrops[factCheck.reason] != null) {
        profileFactDrops[factCheck.reason] += 1;
      }
      return false;
    }
    return true;
  });
  if (scrapeParams.threadId) {
    logSearchThread(scrapeParams.threadId, "scrape_filter_summary", {
      rawCount: rawItems.length,
      normalisedCount: combined.length,
      filteredCount: eligible.length,
      dropped: {
        missingTitleOrCompany: cntNoTitle,
        noExternalApplyUrl: cntNoApply,
        notFullTime: cntNotFT,
        titleIrrelevant: cntIrrelevant,
        yoeMismatch: cntYoeMismatch,
        profileFactMismatch: cntProfileFactMismatch,
        profileFactReasons: profileFactDrops,
        repost: cntRepost,
        ghostScore: cntGhost,
        duplicate: cntDup,
      },
    });
  }
  console.log(
    `[scrape] filtered: ${eligible.length}/${combined.length}` +
    ` (missingTitleOrCompany:${cntNoTitle} noExternalApplyUrl:${cntNoApply} notFullTime:${cntNotFT}` +
    ` titleIrrelevant:${cntIrrelevant} yoeMismatch:${cntYoeMismatch} profileFactMismatch:${cntProfileFactMismatch} repost:${cntRepost} ghostScore:${cntGhost} duplicate:${cntDup})`
  );

  const nowUnix = Math.floor(Date.now() / 1000);

  // Convert raw posting string to ISO date so the cron cleanup and age display work reliably.
  // LinkedIn returns relative strings ("2 days ago", "3 weeks ago") or ISO dates.
  function normalizePostedAt(raw, scrapedAt) {
    if (!raw) return null;
    const str = String(raw).trim();
    // Already a parseable date (ISO, RFC2822, etc.)
    const d = new Date(str);
    if (!isNaN(d.getTime()) && d.getFullYear() > 2010) return d.toISOString().slice(0, 10);
    // Relative string: "X minutes/hours/days/weeks/months ago"
    const m = str.match(/^(\d+)\s+(minute|hour|day|week|month)s?\s+ago$/i);
    if (m) {
      const n = parseInt(m[1]);
      const unit = m[2].toLowerCase();
      const offsets = { minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000 };
      return new Date((scrapedAt - n * (offsets[unit] || 86400)) * 1000).toISOString().slice(0, 10);
    }
    return null;
  }

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
        normalizePostedAt(item.postedAt, nowUnix),
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
      assignJobRoleMap(jobId, domainProfile, result.changes > 0 ? "profile_scrape" : "duplicate_profile_scrape");
    });
    return inserted;
  });

  const classified = [];
  let inserted = 0;
  for (let i = 0; i < Math.min(eligible.length, MAX_JOBS_PER_REFRESH); i += 5) {
    const batch = eligible.slice(i, i + 5);
    const cats  = await Promise.all(batch.map(item => classifyJob(item.title, item.description)));
    const classifiedBatch = batch.map((item, idx) => ({ ...item, _category: cats[idx] }));
    classified.push(...classifiedBatch);
    inserted += insertMany(classifiedBatch);
  }

  // ── Conservative ingest-time classification for orphaned jobs ─────────────
  // Jobs scraped without a domainProfile (admin scrapes, deleted profiles, etc.)
  // have no job_role_map entry and are invisible to profile-based search flows.
  // Assign a role_key only when classifyForIngest() returns >= 0.75 confidence.
  // Low-confidence jobs remain unclassified for later LLM scoring or admin review.
  {
    const orphanInsert = db.prepare(`
      INSERT OR IGNORE INTO job_role_map
        (job_id, role_key, role_family, domain, confidence, matched_by)
      VALUES (?, ?, ?, ?, ?, 'ingest_classifier')
    `);
    const classifyOrphans = db.transaction((jobs) => {
      let cnt = 0;
      for (const item of jobs) {
        if (item._domainProfileId) continue; // already handled by assignJobRoleMap
        const existing = db.prepare(
          "SELECT 1 FROM job_role_map WHERE job_id = ?"
        ).get(item.jobId);
        if (existing) continue; // already has a role_map entry
        const result = classifyForIngest(item.title, item.description || "");
        if (!result) continue;
        const { role_family, domain } = getRoleFamilyDomainForKey(result.roleKey);
        orphanInsert.run(item.jobId, result.roleKey, role_family, domain, result.confidence);
        cnt++;
      }
      return cnt;
    });
    // Only run for scrapes that had no domainProfile
    if (!domainProfileId) {
      const orphansClassified = classifyOrphans(classified.map(it => ({ ...it, _domainProfileId: domainProfileId })));
      if (orphansClassified > 0) {
        console.log(`[scrape] ingest_classifier assigned role_key to ${orphansClassified} orphaned jobs`);
      }
    }
  }

  // ── ATS scoring for newly inserted jobs (D1) ──────────────────────────────
  // Score new jobs against the user's base resume using Haiku.
  // Non-fatal — job is still inserted if scoring fails.
  if (userId && ANTHROPIC_KEY && Date.now() < anthropicAtsUnavailableUntil) {
    if (scrapeParams.threadId) logSearchThread(scrapeParams.threadId, "ats_enrichment", {
      status: "ats_unavailable_due_to_credits",
      skipped: true,
      retryAfterMs: anthropicAtsUnavailableUntil - Date.now(),
    });
  } else if (userId && ANTHROPIC_KEY) {
    enqueueAtsScoreWork(`scrape:${userId}:${query}`, async () => {
      try {
        const baseResumeRow = domainProfile
          ? getBaseResumeRecord(db, { userId, profileId: domainProfile.id })
          : null;
        const baseResumeText = baseResumeRow?.content;
        if (!baseResumeText) return; // No base resume — skip scoring
        const profileTitles = domainProfile ? (() => {
          try { return JSON.parse(domainProfile.target_titles || "[]"); } catch { return []; }
        })() : [];
        const simpleProfile = domainProfile
          ? loadOrCreateSimpleApplyProfile(db, { userId, profileId: domainProfile.id, roleTitles: profileTitles })
          : null;
        const atsResumeBasis = buildAtsResumeBasis(baseResumeText, simpleProfile);

        // Find newly inserted jobs that have no ats_score yet
        const newlyInserted = classified.filter(item => {
          const row = db.prepare("SELECT ats_score FROM scraped_jobs WHERE job_id=?").get(item.jobId);
          return row && row.ats_score === null;
        });

        if (!newlyInserted.length) return;

        const updateAts = db.prepare(
          "UPDATE scraped_jobs SET ats_score=?, ats_report=? WHERE job_id=?"
        );

        let creditsUnavailable = false;
        let attempted = 0;
        let failed = 0;
        for (let i = 0; i < newlyInserted.length && !creditsUnavailable; i += 5) {
          const batch = newlyInserted.slice(i, i + 5);
          await Promise.all(batch.map(async item => {
            if (creditsUnavailable) return;
            try {
              attempted++;
              const start = Date.now();
              const scoreMsg = await anthropic.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 900,
                system: ATS_SYSTEM_PROMPT,
                messages: [{ role: "user", content:
                  `JOB DESCRIPTION:\n${item.description || item.title}\n\n${atsResumeBasis}` }],
              });
              const raw = scoreMsg.content.map(b => b.text || "").join("")
                .replace(/```json|```/g, "").trim();
              const report = JSON.parse(raw);
              updateAts.run(report.score, JSON.stringify(report), item.jobId);
              if (domainProfile?.id) {
                const aggregation = aggregateAtsMissingSignals(db, {
                  userId,
                  profileId: domainProfile.id,
                  report,
                });
                if (aggregation.eligibleNow) {
                  insertNotification(
                    userId,
                    "enhance_ready",
                    `Enhance Base Resume is ready for ${domainProfile.profile_name}. Review profile ATS suggestions and select new skills.`,
                    { profileId: domainProfile.id, source: "ats_missing_signals" },
                  );
                }
              }
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
              failed++;
              if (isAnthropicCreditError(e)) {
                creditsUnavailable = true;
                anthropicAtsUnavailableUntil = Date.now() + 15 * 60 * 1000;
                console.warn(`[scrape] ATS score unavailable due to Anthropic credits for ${item.jobId}:`, e.message);
              } else {
                console.warn(`[scrape] ATS score failed for ${item.jobId}:`, e.message);
              }
            }
          }));
        }
        if (scrapeParams.threadId) {
          logSearchThread(scrapeParams.threadId, "ats_enrichment", {
            candidateCount: newlyInserted.length,
            attempted,
            failed,
            skippedRemaining: creditsUnavailable,
            status: creditsUnavailable ? "ats_unavailable_due_to_credits" : "complete",
          });
        }
      } catch(e) {
        if (isAnthropicCreditError(e)) {
          anthropicAtsUnavailableUntil = Date.now() + 15 * 60 * 1000;
          console.warn("[scrape] ATS batch scoring unavailable due to Anthropic credits:", e.message);
          if (scrapeParams.threadId) logSearchThread(scrapeParams.threadId, "ats_enrichment", {
            status: "ats_unavailable_due_to_credits",
            error: e.message,
          });
        } else {
          console.warn("[scrape] ATS batch scoring failed:", e.message);
        }
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

  if (scrapeParams.threadId) {
    logSearchThread(scrapeParams.threadId, "scrape_complete", {
      query,
      insertedCount: inserted,
      classifiedCount: classified.length,
      filteredCount: eligible.length,
      rawCount: combined.length,
    });
  }
  console.log(`[scrape] ✓ "${query}" — ${inserted} inserted, ${classified.length} classified, ${eligible.length} passed filter of ${combined.length} total`);
  return {
    classified,
    rawCount: rawItems.length,
    filteredCount: eligible.length,
    insertedCount: inserted,
    duplicateCount: cntDup,
    ghostCount: cntGhost,
    irrelevantCount: cntIrrelevant,
  };
}

// ── Job expiry cleanup — runs at startup and daily at 03:00 ──────
// Extracts into a named function so it can be called at startup (to
// catch any window missed if the server was down during the cron time)
// and also scheduled daily.
function runExpiredJobsCleanup() {
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
  const deletedRoleMap = db.prepare(
    "DELETE FROM job_role_map WHERE job_id NOT IN (SELECT job_id FROM scraped_jobs)"
  ).run();
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

  const orphans = deletedRoleMap.changes + deletedViews.changes + deletedUserJobs.changes
                + deletedResumes.changes + deletedVersions.changes;

  const details = JSON.stringify({
    jobRoleMap: deletedRoleMap.changes,
    resumes: deletedResumes.changes,
    resumeVersions: deletedVersions.changes,
    userJobs: deletedUserJobs.changes,
    userJobViews: deletedViews.changes,
  });
  db.prepare(
    "INSERT INTO cleanup_log (jobs_deleted, orphans_cleaned, details) VALUES (?,?,?)"
  ).run(deletedJobs.changes, orphans, details);

  console.log(`[cleanup] Expired ${deletedJobs.changes} jobs (by posting date), pruned ${orphans} orphaned rows`);
}

// ── Cron: daily backup 02:00, re-scrape 07:00, cleanup 03:00 ──
cron.schedule("0 3 * * *", runExpiredJobsCleanup);

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
  catch(e) {
    if (isExternalScrapeQuotaError(e)) {
      console.warn("[cron] Daily re-scrape skipped: external scrape quota exhausted");
    } else {
      console.error("[cron]", e.message);
    }
  }
});

// ── Prompt injection ──────────────────────────────────────────
// domainProfile is the active domain_profiles row (or null).
// When supplied, profile keywords/verbs/tools are injected as Tier 1 signal.
function buildRuntimeInputs(profile, job, resumeText, mode, employers, domainProfile = null) {
  const isAPlus = mode === "CUSTOM_SAMPLER" || mode === "A_PLUS";
  const isGenerate = mode === "TAILORED" || mode === "GENERATE";
  const userLocation = isAPlus ? "" : (profile?.location||"");
  let employerBlock  = "";
  // Apply exclusion list before injecting employer names into prompt
  const safeEmployers = sanitiseEmployers(employers);
  if (isGenerate && safeEmployers?.length >= 2)
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

**Mode:** ${displayModeForPrompt(mode)}
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
  if (!html.trimStart().toLowerCase().startsWith("<!doctype")) {
    html = "<!DOCTYPE html>" + html;
  }
  // launchBrowser resolves the best available binary and applies container-safe args.
  // On failure it throws with a structured reasonCode (browser_runtime_missing_dependency, etc.)
  const browser = await launchBrowser({
    headless: true,
    viewport: { width:1240, height:1754 },
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
  const login = String(username || "").trim();
  const user = db.prepare(`
    SELECT u.*
    FROM users u
    LEFT JOIN user_profile up ON up.user_id = u.id
    WHERE u.username = ?
       OR LOWER(up.email) = LOWER(?)
    LIMIT 1
  `).get(login, login);
  if (!user || !verifyPassword(password, user.password_hash))
    return done(null, false, { message:"Invalid credentials." });
  return done(null, {
    id:user.id,
    username:user.username,
    isAdmin:!!user.is_admin,
    applyMode:user.apply_mode,
    planTier:normalisePlanTier(user.plan_tier),
    domainProfileComplete:!!user.domain_profile_complete,
  });
}));
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  try {
    const user = db.prepare("SELECT id,username,is_admin,apply_mode,plan_tier,domain_profile_complete FROM users WHERE id=?").get(id);
    if (!user) {
      // User was deleted or session references a stale ID from another environment.
      // done(null, false) cleanly de-authenticates — Passport calls req.logout() internally.
      // done(new Error(...)) would propagate to the global error handler and return 500.
      console.warn(`[auth] deserializeUser: user id=${id} not found — session will be cleared`);
      return done(null, false);
    }
    done(null, {
      id:user.id,
      username:user.username,
      isAdmin:!!user.is_admin,
      applyMode:user.apply_mode,
      planTier:normalisePlanTier(user.plan_tier),
      domainProfileComplete:!!user.domain_profile_complete,
    });
  } catch(e) {
    console.error("[auth] deserializeUser error:", e.message);
    done(null, false); // safe fallback — don't crash the request
  }
});

function hydrateAuthUser(id) {
  const user = db.prepare("SELECT id,username,is_admin,apply_mode,plan_tier,domain_profile_complete FROM users WHERE id=?").get(id);
  if (!user) return null;
  return {
    id:user.id,
    username:user.username,
    isAdmin:!!user.is_admin,
    applyMode:user.apply_mode,
    planTier:normalisePlanTier(user.plan_tier),
    domainProfileComplete:!!user.domain_profile_complete,
  };
}

function authContextHash(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function issueAuthContext(userId, req) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  db.prepare("DELETE FROM auth_contexts WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(now - 86400);
  db.prepare(`
    INSERT INTO auth_contexts (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(authContextHash(token), userId, now, now, now + 7 * 24 * 60 * 60, req.get("user-agent") || null);
  return token;
}

function getRequestAuthContextToken(req) {
  const header = req.get("x-rm-auth-context");
  return header || req.query?.authContext || null;
}

function bindAuthContext(req, _res, next) {
  const token = getRequestAuthContextToken(req);
  if (!token) return next();
  try {
    const now = Math.floor(Date.now() / 1000);
    const row = db.prepare(`
      SELECT ac.user_id
      FROM auth_contexts ac
      WHERE ac.token_hash = ?
        AND ac.revoked_at IS NULL
        AND ac.expires_at > ?
      LIMIT 1
    `).get(authContextHash(token), now);
    if (!row) {
      // Token was sent but is expired, revoked, or unknown.
      // Log so we can diagnose "session expired" reports without leaking the token itself.
      console.warn(`[auth-context] token not found/expired — ${req.method} ${req.path} | ua:${(req.get("user-agent")||"").slice(0,60)}`);
      return next();
    }
    const user = hydrateAuthUser(row.user_id);
    if (!user) {
      console.warn(`[auth-context] token valid but user_id=${row.user_id} not in users table`);
      return next();
    }
    req.user = user;
    req.authContextToken = token;
    db.prepare("UPDATE auth_contexts SET last_seen_at=? WHERE token_hash=?").run(now, authContextHash(token));
  } catch(e) {
    console.warn("[auth-context] bind failed:", e.message);
  }
  next();
}

function requireAuth(req, res, next) {
  // Accept either a valid Passport session OR a valid auth context token.
  // bindAuthContext (which runs before this) sets req.authContextToken only when the
  // token is non-expired, non-revoked, and the user exists in the DB.
  // Without this second check, users whose Passport session was wiped (e.g. server
  // restart on ephemeral storage) but whose auth context token is still valid in
  // resume.db would always receive 401 even though they are authenticated.
  if (req.isAuthenticated() || req.authContextToken) return next();
  const hasCookie = !!req.headers.cookie?.includes("connect.sid");
  const hasToken  = !!getRequestAuthContextToken(req);
  console.warn(`[auth] 401 ${req.method} ${req.path} | cookie:${hasCookie} token_sent:${hasToken} ip:${req.ip}`);
  res.status(401).json({ error:"Unauthorized." });
}
function requireAdmin(req, res, next) {
  if ((req.isAuthenticated() || req.authContextToken) && req.user?.isAdmin) return next();
  res.status(403).json({ error:"Forbidden." });
}

logOAuthReadiness();

function publicUser(user) {
  const planTier = normalisePlanTier(user.planTier || user.plan_tier);
  const allowedModes = allowedModesForTier(planTier);
  const applyMode = allowedModes.includes(user.applyMode || user.apply_mode)
    ? (user.applyMode || user.apply_mode)
    : allowedModes[0];
  return {
    id:user.id,
    username:user.username,
    isAdmin:!!(user.isAdmin ?? user.is_admin),
    applyMode,
    planTier,
    allowedModes,
    capabilities: {
      canUseGenerate: canUseGenerate(planTier),
      canUseAPlusResume: canUseAPlusResume(planTier),
    },
    domainProfileComplete:!!(user.domainProfileComplete ?? user.domain_profile_complete),
  };
}

function makeUniqueUsername(base) {
  const stem = String(base || "user").toLowerCase()
    .replace(/@.*/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28) || "user";
  let candidate = stem;
  let n = 1;
  while (db.prepare("SELECT 1 FROM users WHERE username=?").get(candidate)) {
    candidate = `${stem}-${++n}`;
  }
  return candidate;
}

function findUserByAuthProvider(provider, providerUserId, email, { allowEmailMatch = true } = {}) {
  const providerColumn = provider === "linkedin" ? "linkedin_auth_id" : "google_auth_id";
  if (providerUserId) {
    const byProvider = db.prepare(`SELECT * FROM users WHERE ${providerColumn}=?`).get(providerUserId);
    if (byProvider) return byProvider;
    const byIntegration = db.prepare(`
      SELECT u.*
      FROM user_integrations ui
      JOIN users u ON u.id = ui.user_id
      WHERE ui.provider=? AND ui.provider_user_id=?
      LIMIT 1
    `).get(provider, providerUserId);
    if (byIntegration) return byIntegration;
  }
  if (email && allowEmailMatch) {
    return db.prepare(`
      SELECT u.*
      FROM user_profile up
      JOIN users u ON u.id = up.user_id
      WHERE LOWER(up.email)=LOWER(?)
      LIMIT 1
    `).get(email);
  }
  return null;
}

function upsertAuthIntegration(userId, provider, { providerUserId, email, displayName, sessionState, scopes = [], expiresAt = null, metadata = {} }) {
  const encrypted = saveIntegrationSecret(sessionState || null);
  const mergedMetadata = { authLinked: true, displayName: displayName || null, ...metadata };
  db.prepare(`
    INSERT INTO user_integrations
      (user_id, provider, provider_user_id, account_email, status, scopes_json, metadata_json,
       secret_enc, iv, auth_tag, expires_at, last_checked_at, updated_at)
    VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
    ON CONFLICT(user_id, provider) DO UPDATE SET
      provider_user_id=COALESCE(excluded.provider_user_id, user_integrations.provider_user_id),
      account_email=COALESCE(excluded.account_email, user_integrations.account_email),
      status='connected',
      scopes_json=excluded.scopes_json,
      metadata_json=excluded.metadata_json,
      secret_enc=COALESCE(excluded.secret_enc, user_integrations.secret_enc),
      iv=COALESCE(excluded.iv, user_integrations.iv),
      auth_tag=COALESCE(excluded.auth_tag, user_integrations.auth_tag),
      expires_at=COALESCE(excluded.expires_at, user_integrations.expires_at),
      last_checked_at=excluded.last_checked_at,
      updated_at=excluded.updated_at
  `).run(
    userId, provider, providerUserId || null, email || null,
    JSON.stringify(scopes), JSON.stringify(mergedMetadata),
    encrypted.enc, encrypted.iv, encrypted.tag, expiresAt,
  );
}

function providerColumnFor(provider) {
  return provider === "linkedin" ? "linkedin_auth_id" : "google_auth_id";
}

function profileParts(displayName) {
  const parts = String(displayName || "").split(/\s+/).filter(Boolean);
  return {
    first: parts[0] || null,
    last: parts.length > 1 ? parts[parts.length - 1] : null,
  };
}

function completeProviderAuth(provider, identity, { linkUserId = null, tokenSet = null } = {}) {
  const providerColumn = providerColumnFor(provider);
  const providerUserId = String(identity.providerUserId || "").trim();
  const email = String(identity.email || "").trim().toLowerCase() || null;
  const displayName = String(identity.displayName || email || provider).trim();
  const emailForMatch = identity.emailVerified === false ? null : email;
  if (!providerUserId) throw new Error("OAuth provider did not return a stable user id.");

  let user = null;
  let created = false;
  let linked = false;

  if (linkUserId) {
    const existing = findUserByAuthProvider(provider, providerUserId, null, { allowEmailMatch: false });
    if (existing && existing.id !== linkUserId) {
      const err = new Error(`${provider} is already linked to another account.`);
      err.status = 409;
      throw err;
    }
    user = db.prepare("SELECT * FROM users WHERE id=?").get(linkUserId);
    if (!user) {
      const err = new Error("Authenticated account no longer exists.");
      err.status = 401;
      throw err;
    }
    db.prepare(`UPDATE users SET ${providerColumn}=? WHERE id=?`).run(providerUserId, user.id);
    user = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
    linked = true;
  } else {
    user = findUserByAuthProvider(provider, providerUserId, emailForMatch, { allowEmailMatch: !!emailForMatch });
    if (!user) {
      const username = makeUniqueUsername(email || displayName || provider);
      const password = hashPassword(crypto.randomBytes(24).toString("base64url"));
      db.prepare(`INSERT INTO users (username,password_hash,is_admin,apply_mode,plan_tier,${providerColumn}) VALUES (?,?,0,'SIMPLE','BASIC',?)`)
        .run(username, password, providerUserId);
      user = db.prepare("SELECT * FROM users WHERE username=?").get(username);
      const { first, last } = profileParts(displayName);
      db.prepare(`
        INSERT OR IGNORE INTO user_profile (user_id, full_name, first_name, last_name, email)
        VALUES (?, ?, ?, ?, ?)
      `).run(user.id, displayName || null, first, last, email);
      created = true;
    } else if (user[providerColumn] !== providerUserId) {
      db.prepare(`UPDATE users SET ${providerColumn}=? WHERE id=?`).run(providerUserId, user.id);
      user = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
      linked = true;
    }
  }

  if (email) {
    db.prepare("INSERT OR IGNORE INTO user_profile (user_id, email) VALUES (?, ?)").run(user.id, email);
    db.prepare("UPDATE user_profile SET email=COALESCE(email, ?) WHERE user_id=?").run(email, user.id);
  }

  const obtainedAt = Math.floor(Date.now() / 1000);
  const expiresAt = tokenSet?.expires_in ? obtainedAt + Number(tokenSet.expires_in) : null;
  upsertAuthIntegration(user.id, provider, {
    providerUserId,
    email,
    displayName,
    sessionState: tokenSet ? {
      provider,
      tokenType: tokenSet.token_type || "Bearer",
      accessToken: tokenSet.access_token || null,
      refreshToken: tokenSet.refresh_token || null,
      idToken: tokenSet.id_token || null,
      scope: tokenSet.scope || null,
      obtainedAt,
    } : null,
    scopes: provider === "google" ? ["openid", "email", "profile", "google_login_session"] : ["openid", "profile", "email", "linkedin_login_session"],
    expiresAt,
    metadata: {
      oauth: true,
      emailVerified: identity.emailVerified ?? null,
      picture: identity.picture || null,
    },
  });

  return { user, created, linked };
}

function authUserFromDbRow(row) {
  return {
    id: row.id,
    username: row.username,
    isAdmin: !!row.is_admin,
    applyMode: row.apply_mode,
    planTier: normalisePlanTier(row.plan_tier),
    domainProfileComplete: !!row.domain_profile_complete,
  };
}

function appBaseUrl(req) {
  return (process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
}

function isHttpsOrLocalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function oauthRedirectUri(req, provider) {
  const cfg = OAUTH_PROVIDER_CONFIG[provider];
  return cfg?.redirectUri || `${appBaseUrl(req)}/api/auth/oauth/${provider}/callback`;
}

function oauthProviderReadiness(provider, req = null) {
  const cfg = OAUTH_PROVIDER_CONFIG[provider];
  if (!cfg) return { provider, configured: false, status: "unsupported", missing: ["provider"], warnings: [] };
  const missing = [];
  const warnings = [];
  if (!cfg.clientId) missing.push("client_id");
  if (!cfg.clientSecret) missing.push("client_secret");
  if (!process.env.APP_BASE_URL && process.env.NODE_ENV === "production") warnings.push("app_base_url_missing");
  const base = req ? appBaseUrl(req) : (process.env.APP_BASE_URL || "");
  const redirectUri = req || cfg.redirectUri ? oauthRedirectUri(req, provider) : "";
  if (!redirectUri) missing.push("redirect_uri_or_app_base_url");
  if (redirectUri && !isHttpsOrLocalUrl(redirectUri)) warnings.push("redirect_uri_not_https_or_localhost");
  if (base && !isHttpsOrLocalUrl(base)) warnings.push("app_base_url_not_https_or_localhost");
  if (!cfg.scopes?.includes("openid") || !cfg.scopes?.includes("email")) warnings.push("openid_email_scopes_missing");
  const configured = missing.length === 0;
  return {
    provider,
    configured,
    healthy: configured && warnings.length === 0,
    status: configured ? (warnings.length ? "configured_with_warnings" : "configured") : (missing.length === 3 ? "missing" : "partial"),
    missing,
    warnings,
    redirectUri: redirectUri || null,
    requiredEnv: provider === "google"
      ? ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI or APP_BASE_URL"]
      : ["LINKEDIN_OAUTH_CLIENT_ID", "LINKEDIN_OAUTH_CLIENT_SECRET", "LINKEDIN_OAUTH_REDIRECT_URI or APP_BASE_URL"],
  };
}

function oauthReadiness(req = null) {
  return Object.fromEntries(OAUTH_PROVIDERS.map(provider => [provider, oauthProviderReadiness(provider, req)]));
}

function logOAuthReadiness() {
  for (const provider of OAUTH_PROVIDERS) {
    const status = oauthProviderReadiness(provider);
    if (status.configured) {
      console.log(`[oauth:${provider}] ${status.status}${status.warnings.length ? ` (${status.warnings.join(", ")})` : ""}`);
    } else {
      console.warn(`[oauth:${provider}] ${status.status}; missing ${status.missing.join(", ")}`);
    }
  }
}

function oauthReturnUrl(req, returnTo, params = {}) {
  const fallback = req.user ? "/app/integrations" : "/app";
  const rawPath = String(returnTo || fallback);
  let safePath = fallback;
  try {
    const parsed = new URL(rawPath, appBaseUrl(req));
    const sameOrigin = parsed.origin === new URL(appBaseUrl(req)).origin;
    if (sameOrigin && rawPath.startsWith("/") && !rawPath.startsWith("//")) {
      safePath = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {}
  const url = new URL(safePath, appBaseUrl(req));
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function oauthConfigFor(provider, req) {
  const cfg = OAUTH_PROVIDER_CONFIG[provider];
  const readiness = oauthProviderReadiness(provider, req);
  if (!readiness.configured) {
    const err = new Error(`${provider} OAuth is not configured (${readiness.missing.join(", ")} missing).`);
    err.status = 503;
    err.oauthReadiness = readiness;
    throw err;
  }
  return { ...cfg, redirectUri: oauthRedirectUri(req, provider) };
}

function normalizeOAuthIdentity(provider, claims) {
  const email = String(claims.email || claims.emailAddress || "").trim().toLowerCase() || null;
  const displayName = String(claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(" ") || email || provider).trim();
  return {
    providerUserId: String(claims.sub || claims.id || "").trim(),
    email,
    emailVerified: claims.email_verified === undefined ? undefined : !!claims.email_verified,
    displayName,
    picture: claims.picture || null,
  };
}

async function exchangeOAuthCode(provider, code, req) {
  const cfg = oauthConfigFor(provider, req);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  const tokenResponse = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body,
  });
  const tokenSet = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenSet.access_token) {
    const err = new Error(tokenSet.error_description || tokenSet.error || `${provider} token exchange failed.`);
    err.status = 502;
    throw err;
  }
  return tokenSet;
}

async function fetchOAuthUserInfo(provider, tokenSet, req) {
  const cfg = oauthConfigFor(provider, req);
  const infoResponse = await fetch(cfg.userInfoUrl, {
    headers: { Authorization: `Bearer ${tokenSet.access_token}`, Accept: "application/json" },
  });
  const claims = await infoResponse.json().catch(() => ({}));
  if (!infoResponse.ok) {
    const err = new Error(claims.error_description || claims.message || `${provider} userinfo lookup failed.`);
    err.status = 502;
    throw err;
  }
  return normalizeOAuthIdentity(provider, claims);
}

function requireModeEntitlement(req, res, mode = req.user?.applyMode) {
  const planTier = normalisePlanTier(req.user?.planTier);
  if (canUseMode(planTier, mode)) return true;
  res.status(403).json({
    error: "upgrade_required",
    message: `${mode} requires the ${planForMode(mode)} plan.`,
    requiredTier: planForMode(mode),
    planTier,
  });
  return false;
}

function requireToolEntitlement(req, res, tool) {
  const planTier = normalisePlanTier(req.user?.planTier);
  const allowed = tool === "a_plus_resume"
    ? canUseAPlusResume(planTier)
    : canUseGenerate(planTier);
  if (allowed) return true;
  const requiredTier = tool === "a_plus_resume" ? "PRO" : "PLUS";
  res.status(403).json({
    error: "upgrade_required",
    message: `${tool === "a_plus_resume" ? "A+ Resume" : "Generate"} requires the ${requiredTier} plan.`,
    requiredTier,
    planTier,
  });
  return false;
}

function requirePlan(req, res, requiredTier) {
  const planTier = normalisePlanTier(req.user?.planTier);
  if (hasPlanAtLeast(planTier, requiredTier)) return true;
  res.status(403).json({
    error: "upgrade_required",
    message: `This feature requires the ${requiredTier} plan.`,
    requiredTier,
    planTier,
  });
  return false;
}

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

// Canonical role-key derivation — delegates to services/jobClassifier.js.
// To change the mapping logic, edit getRoleKeyForProfile() in that module.
function roleKeyForProfile(profile) {
  const family = String(profile?.role_family || "").trim().toLowerCase();
  const domain = String(profile?.domain    || "").trim().toLowerCase();
  // engineering_embedded_firmware is the only engineering sub-domain with a
  // strict, non-overlapping title set.  Use the domain itself as the role key
  // so firmware profiles get their own isolated bucket in job_role_map and
  // never share the broad "engineering" key with standard SWE profiles.
  // engineering_systems_low_level and engineering_specialist intentionally
  // stay on the shared "engineering" key — their title sets overlap too much
  // with SWE to warrant a separate bucket without a full re-scrape.
  if (family === "engineering" && domain === "engineering_embedded_firmware") {
    return "engineering_embedded_firmware";
  }
  return _getRoleKeyForProfile(profile);
}

function userHasBaseResume(userId) {
  const activeProfile = getOrRepairActiveProfile(userId);
  if (!activeProfile) return false;
  return profileHasBaseResume(db, { userId, profileId: activeProfile.id });
}

function getOrRepairActiveProfile(userId) {
  let active = db.prepare("SELECT * FROM domain_profiles WHERE user_id=? AND is_active=1").get(userId);
  if (active) return active;
  const fallback = db.prepare("SELECT * FROM domain_profiles WHERE user_id=? ORDER BY updated_at DESC, created_at ASC LIMIT 1").get(userId);
  if (!fallback) {
    try { db.prepare("UPDATE users SET domain_profile_complete=0 WHERE id=?").run(userId); } catch {}
    return null;
  }
  db.prepare("UPDATE domain_profiles SET is_active=0 WHERE user_id=?").run(userId);
  db.prepare("UPDATE domain_profiles SET is_active=1, updated_at=unixepoch() WHERE id=? AND user_id=?").run(fallback.id, userId);
  try { db.prepare("UPDATE users SET domain_profile_complete=1 WHERE id=?").run(userId); } catch {}
  return db.prepare("SELECT * FROM domain_profiles WHERE id=? AND user_id=?").get(fallback.id, userId);
}

function assignJobRoleMap(jobId, profile, matchedBy = "profile_scrape", confidence = 1.0) {
  if (!jobId || !profile) return;
  db.prepare(`
    INSERT OR IGNORE INTO job_role_map
      (job_id, role_key, role_family, domain, source_profile_id, confidence, matched_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(jobId),
    roleKeyForProfile(profile),
    profile.role_family || null,
    profile.domain || null,
    profile.id || null,
    confidence,
    matchedBy,
  );
}

function resolveUserJobDomainProfileId(userId, jobId) {
  const userActiveProfile = getOrRepairActiveProfile(userId);
  if (!userActiveProfile) return null;
  const activeRoleKey = roleKeyForProfile(userActiveProfile);

  const existing = db.prepare(`
    SELECT uj.domain_profile_id
    FROM user_jobs uj
    JOIN domain_profiles dp ON dp.id = uj.domain_profile_id AND dp.user_id = uj.user_id AND dp.is_active = 1
    JOIN job_role_map jrm ON jrm.job_id = uj.job_id AND jrm.role_key = ?
    JOIN scraped_jobs sj ON sj.job_id = uj.job_id
    WHERE uj.user_id=? AND uj.job_id=?
      AND ${roleTitleSql("sj.title", activeRoleKey)}
  `).get(activeRoleKey, userId, String(jobId));
  if (existing?.domain_profile_id) return existing.domain_profile_id;

  const activeProfile = db.prepare(`
    SELECT dp.*
    FROM domain_profiles dp
    JOIN job_role_map jrm ON jrm.role_key = LOWER(COALESCE(NULLIF(dp.role_family, ''), dp.domain))
    JOIN scraped_jobs sj ON sj.job_id = jrm.job_id
    WHERE dp.user_id = ? AND dp.is_active = 1 AND jrm.job_id = ?
      AND ${roleTitleSql("sj.title", activeRoleKey)}
  `).get(userId, String(jobId));
  if (activeProfile?.id) return activeProfile.id;

  return null;
}

// ── Express ───────────────────────────────────────────────────
const app = express();
// Active scrapes: key = "userId:profileId:query", value = { startedAt, done }
// Polled by GET /api/jobs/poll to determine if a background scrape is still running.
const activeScrapes = new Map();
const atsScoreQueue = [];
let atsScoreQueueRunning = false;
let anthropicAtsUnavailableUntil = 0;

function enqueueAtsScoreWork(label, worker) {
  atsScoreQueue.push({ label, worker });
  if (atsScoreQueueRunning) return;
  atsScoreQueueRunning = true;
  setImmediate(async () => {
    while (atsScoreQueue.length) {
      const item = atsScoreQueue.shift();
      try {
        await item.worker();
      } catch(e) {
        console.warn(`[ats-queue] ${item.label || "job"} failed:`, e.message);
      }
    }
    atsScoreQueueRunning = false;
  });
}

function scrapeStateKey(userId, profileId, query) {
  return `${userId}:${profileId || "none"}:${String(query || "").toLowerCase()}`;
}

function searchThreadId() {
  return `search_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

function logSearchThread(threadId, event, details = {}) {
  console.log(`[search:${threadId}] ${event} ${JSON.stringify(details)}`);
}

function getProfileSearchFacts(signalProfile = null) {
  return normaliseStructuredFacts(signalProfile?.structuredFacts || {});
}

function evaluateProfileFactEligibility(jobLike = {}, signalProfile = null) {
  const facts = getProfileSearchFacts(signalProfile);
  const text = [
    jobLike.title || "",
    jobLike.location || "",
    jobLike.description || "",
    jobLike.descriptionHtml || "",
  ].join(" ").toLowerCase();

  const requiresClearance = /\b(ts\/sci|top secret|secret clearance|security clearance required|active clearance|clearance required|public trust)\b/i.test(text);
  if (requiresClearance && !facts.hasClearance) {
    return { ok: false, reason: "clearance", facts };
  }

  const citizenOnly = /\b(u\.?s\.?\s+citizen(ship)?\s+(required|only)|must be a u\.?s\.?\s+citizen|citizens only)\b/i.test(text);
  const hasCitizenEligibility = /\b(citizen|permanent resident|green card)\b/i.test(String(facts.citizenshipStatus || ""));
  if (citizenOnly && !hasCitizenEligibility) {
    return { ok: false, reason: "citizenship", facts };
  }

  const noSponsorship = /\b(no (visa )?sponsorship|unable to sponsor|cannot sponsor|sponsorship not available|must be authorized to work in the united states)\b/i.test(text);
  if (noSponsorship && facts.requiresSponsorship) {
    return { ok: false, reason: "sponsorship", facts };
  }

  return { ok: true, reason: null, facts };
}

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
  // rolling:true resets the cookie maxAge on every response so active users never
  // hit session expiry mid-session (the 7-day clock restarts on each request).
  rolling: true,
  cookie:{ maxAge:7*24*60*60*1000, httpOnly:true, secure:process.env.NODE_ENV==="production", sameSite:"lax" },
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(bindAuthContext);

const CLIENT_DIST = path.join(__dirname,"client","dist");
if (fs.existsSync(CLIENT_DIST)) app.use(express.static(CLIENT_DIST));

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════
app.post("/api/auth/login", (req, res, next) => {
  passport.authenticate("local", (err, user, info) => {
    if (err)   return next(err);
    if (!user) return res.status(401).json({ error:info?.message||"Invalid credentials." });
    req.logIn(user, e => e ? next(e) : res.json({ ok:true, user:publicUser(user), authContext:issueAuthContext(user.id, req) }));
  })(req, res, next);
});

app.post("/api/auth/register", (req, res) => {
  const { username, password, profile={}, apifyToken } = req.body;
  if (!username||!password) return res.status(400).json({ error:"username and password required" });
  const passwordError = validatePassword(password);
  if (passwordError)       return res.status(400).json({ error:passwordError });
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
    db.prepare("INSERT INTO users (username,password_hash,is_admin,apply_mode,plan_tier) VALUES (?,?,0,'SIMPLE','BASIC')")
      .run(username, hashPassword(password));
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
    const sessionUser = { id:newUser.id, username, isAdmin:false, applyMode:"SIMPLE", planTier:"BASIC", domainProfileComplete:false };
    req.logIn(sessionUser, e => {
      if (e) return res.status(500).json({ error:"Account created but login failed. Please sign in." });
      res.json({ ok:true, user:publicUser(sessionUser), authContext:issueAuthContext(newUser.id, req) });
    });
  } catch(e) {
    res.status(400).json({ error:e.message.includes("UNIQUE")?"Username already taken.":e.message });
  }
});

app.get("/api/auth/oauth/status", (req, res) => {
  res.json({ providers: oauthReadiness(req) });
});

app.get("/api/auth/oauth/:provider/start", (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  if (!["google", "linkedin"].includes(provider)) return res.status(400).json({ error: "Unsupported auth provider" });
  const mode = req.query?.mode === "link" ? "link" : "login";
  const returnTo = String(req.query?.returnTo || (mode === "link" ? "/app/integrations" : "/app"));
  if (mode === "link" && !req.isAuthenticated()) {
    return res.redirect(oauthReturnUrl(req, "/login", {
      oauthError: "Sign in before linking an OAuth provider.",
      oauthProvider: provider,
    }));
  }
  try {
    const cfg = oauthConfigFor(provider, req);
    const state = crypto.randomBytes(32).toString("base64url");
    req.session.oauthStates = req.session.oauthStates || {};
    for (const [key, entry] of Object.entries(req.session.oauthStates)) {
      if (Date.now() - Number(entry?.createdAt || 0) > 10 * 60 * 1000) delete req.session.oauthStates[key];
    }
    req.session.oauthStates[state] = {
      provider,
      mode,
      returnTo,
      linkUserId: mode === "link" && req.isAuthenticated() ? req.user.id : null,
      createdAt: Date.now(),
    };
    const authUrl = new URL(cfg.authUrl);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", cfg.clientId);
    authUrl.searchParams.set("redirect_uri", cfg.redirectUri);
    authUrl.searchParams.set("scope", cfg.scopes.join(" "));
    authUrl.searchParams.set("state", state);
    if (provider === "google") {
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", mode === "link" ? "consent" : "select_account");
    }
    res.redirect(authUrl.toString());
  } catch(e) {
    console.warn(`[oauth:${provider}] start blocked:`, e.message);
    const target = oauthReturnUrl(req, mode === "link" ? returnTo : "/login", { oauthError: e.message, oauthProvider: provider });
    res.redirect(target);
  }
});

app.get("/api/auth/oauth/:provider/callback", async (req, res, next) => {
  const provider = String(req.params.provider || "").toLowerCase();
  const state = String(req.query?.state || "");
  const code = String(req.query?.code || "");
  const stored = req.session.oauthStates?.[state];
  const fail = (message, returnTo = stored?.mode === "link" ? stored.returnTo : "/login") =>
    res.redirect(oauthReturnUrl(req, returnTo, { oauthError: message, oauthProvider: provider }));

  if (!["google", "linkedin"].includes(provider)) return fail("Unsupported auth provider.");
  if (req.query?.error) {
    console.warn(`[oauth:${provider}] provider returned error:`, String(req.query.error));
    return fail(String(req.query.error_description || req.query.error));
  }
  if (!state || !stored || stored.provider !== provider) {
    console.warn(`[oauth:${provider}] callback rejected: invalid state`);
    return fail("OAuth session expired. Try again.");
  }
  if (Date.now() - Number(stored.createdAt || 0) > 10 * 60 * 1000) {
    delete req.session.oauthStates[state];
    console.warn(`[oauth:${provider}] callback rejected: expired state`);
    return fail("OAuth session expired. Try again.");
  }
  if (!code) {
    console.warn(`[oauth:${provider}] callback rejected: missing authorization code`);
    return fail("OAuth callback did not include an authorization code.");
  }

  try {
    delete req.session.oauthStates[state];
    const tokenSet = await exchangeOAuthCode(provider, code, req);
    const identity = await fetchOAuthUserInfo(provider, tokenSet, req);
    const { user, created, linked } = completeProviderAuth(provider, identity, {
      linkUserId: stored.linkUserId || null,
      tokenSet,
    });
    const sessionUser = authUserFromDbRow(user);
    req.logIn(sessionUser, e => {
      if (e) return next(e);
      const authContext = issueAuthContext(user.id, req);
      res.redirect(oauthReturnUrl(req, stored.returnTo, {
        authContext,
        oauthProvider: provider,
        oauthStatus: stored.linkUserId ? "linked" : created ? "created" : linked ? "linked" : "signed_in",
      }));
    });
  } catch(e) {
    const status = e.status || 500;
    if (status >= 500) console.error(`[oauth:${provider}] callback failed:`, e.message);
    return fail(e.message || "OAuth sign-in failed.");
  }
});

app.post("/api/auth/provider/:provider", (req, res, next) => {
  const provider = String(req.params.provider || "").toLowerCase();
  if (!["google", "linkedin"].includes(provider)) return res.status(400).json({ error: "Unsupported auth provider" });
  const email = String(req.body?.email || req.body?.accountEmail || "").trim().toLowerCase() || null;
  const providerUserId = String(req.body?.providerUserId || req.body?.id || "").trim() || (email ? `${provider}:${email}` : null);
  const displayName = String(req.body?.displayName || req.body?.name || "").trim() || email || provider;
  if (!providerUserId && !email) return res.status(400).json({ error: "Provider identity or email required" });

  try {
    const { user, created, linked } = completeProviderAuth(provider, {
      providerUserId,
      email,
      displayName,
      emailVerified: true,
    }, {
      linkUserId: req.isAuthenticated() ? req.user.id : null,
      tokenSet: null,
    });
    if (req.body?.sessionState || req.body?.cookies) {
      upsertAuthIntegration(user.id, provider, {
        providerUserId,
        email,
        displayName,
        sessionState: req.body.sessionState || req.body.cookies,
        scopes: provider === "google" ? ["google_login_session"] : ["linkedin_login_session"],
      });
    }

    const sessionUser = authUserFromDbRow(user);
    req.logIn(sessionUser, e => {
      if (e) return next(e);
      res.json({
        ok: true,
        created,
        linked,
        provider,
        user: publicUser(sessionUser),
        authContext: issueAuthContext(user.id, req),
        readiness: getAutomationReadiness(db, user.id),
      });
    });
  } catch(e) {
    next(e);
  }
});

app.post("/api/auth/password-reset/request", async (req, res) => {
  const email = String(req.body?.email || "").trim();
  const generic = {
    ok: true,
    message: "If an account exists for that email, a reset link and OTP have been sent.",
  };
  if (!email) return res.json(generic);

  try {
    const throttleSince = Math.floor(Date.now() / 1000) - 10 * 60;
    const recentRequests = db.prepare(`
      SELECT COUNT(*) as c
      FROM password_reset_tokens
      WHERE requested_at > ?
        AND (request_ip = ? OR email = LOWER(?))
    `).get(throttleSince, req.ip, email).c;
    if (recentRequests >= 5) return res.json(generic);

    const user = findUserForPasswordReset(db, email);
    if (user) {
      const reset = createPasswordReset(db, user, {
        pepper: PASSWORD_RESET_SECRET,
        requestIp: req.ip,
        userAgent: req.get("user-agent") || null,
      });
      const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
      const resetUrl = `${baseUrl.replace(/\/$/, "")}/login?resetToken=${encodeURIComponent(reset.token)}`;
      let mailResult = null;
      try {
        mailResult = await sendPasswordResetEmail({
          to: user.email,
          resetUrl,
          otp: reset.otp,
          expiresAt: reset.expiresAt,
        });
      } catch(e) {
        console.error("[password-reset] email send failed:", e.message);
      }
      if (!mailResult?.ok) {
        db.prepare("UPDATE password_reset_tokens SET used_at=unixepoch() WHERE id=?").run(reset.id);
        console.warn("[password-reset] email send skipped or failed for configured user");
      }
    }
  } catch(e) {
    console.error("[password-reset] request failed:", e.message);
  }
  res.json(generic);
});

app.post("/api/auth/password-reset/confirm", (req, res) => {
  const result = consumePasswordReset(db, {
    token: req.body?.token,
    otp: req.body?.otp,
    password: req.body?.password,
  }, {
    pepper: PASSWORD_RESET_SECRET,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  const token = getRequestAuthContextToken(req);
  if (token) {
    db.prepare("UPDATE auth_contexts SET revoked_at=unixepoch() WHERE token_hash=?")
      .run(authContextHash(token));
    return res.json({ ok:true, scoped:true });
  }
  req.logout(() => res.json({ ok:true }));
});

app.get("/api/auth/me", (req, res) =>
  req.isAuthenticated()
    ? res.json({ authenticated:true, user:publicUser(req.user) })
    : res.json({ authenticated:false })
);

// ═══════════════════════════════════════════════════════════════
// DOMAIN PROFILES
// ═══════════════════════════════════════════════════════════════
// /api/domain-profiles        — CRUD + activate
// /api/domain-profiles/metadata[/:domain]  — registry (no auth)
// /api/domain-profiles/generate-chips      — AI chip generation
app.use("/api/domain-profiles", requireAuth, createDomainProfilesRouter(db, anthropic, emitToUser));
app.use(createImportSourcesRouter({ db, requireAuth, emitToUser }));
app.use("/api/imported-jobs", requireAuth, createImportedJobsRouter(db));
// Metadata is also public — mount without requireAuth at a sub-path so
// the chip registry is accessible from the wizard before login
app.get("/api/domain-metadata",       (_req, res) => res.redirect(307, "/api/domain-profiles/metadata"));
app.get("/api/domain-metadata/:key",  (req, res) => res.redirect(307, `/api/domain-profiles/metadata/${req.params.key}`));

// Mark onboarding complete (called by wizard on profile save, also done inside createDomainProfilesRouter)
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
  res.json(db.prepare("SELECT id,username,is_admin,apply_mode,plan_tier,created_at FROM users ORDER BY created_at DESC").all());
});
app.post("/api/admin/users", requireAdmin, (req, res) => {
  const { username, password, isAdmin, planTier } = req.body;
  if (!username||!password) return res.status(400).json({ error:"username and password required" });
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error:passwordError });
  const tier = normalisePlanTier(planTier || "BASIC");
  try {
    db.prepare("INSERT INTO users (username,password_hash,is_admin,apply_mode,plan_tier) VALUES (?,?,?,?,?)")
      .run(username, hashPassword(password), isAdmin?1:0, allowedModesForTier(tier)[0], tier);
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
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error:passwordError });
  db.prepare("UPDATE users SET password_hash=? WHERE id=?")
    .run(hashPassword(password), parseInt(req.params.id));
  res.json({ ok:true });
});
app.patch("/api/admin/users/:id/plan", requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id);
  const rawTier = String(req.body?.planTier || "").toUpperCase();
  if (!["BASIC","PLUS","PRO"].includes(rawTier)) return res.status(400).json({ error:"Invalid plan tier" });
  const tier = normalisePlanTier(rawTier);
  const mode = allowedModesForTier(tier)[0];
  db.prepare("UPDATE users SET plan_tier=?, apply_mode=? WHERE id=?").run(tier, mode, userId);
  db.prepare(`
    UPDATE plan_upgrade_requests
    SET status='approved', decided_at=unixepoch(), decided_by=?
    WHERE user_id=? AND status='pending'
  `).run(req.user.id, userId);
  emitToUser(userId, { type:"plan_updated", planTier:tier, applyMode:mode });
  res.json({ ok:true, planTier:tier, applyMode:mode });
});
app.get("/api/admin/upgrade-requests", requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT pur.*, u.username, u.plan_tier
    FROM plan_upgrade_requests pur
    JOIN users u ON u.id = pur.user_id
    ORDER BY pur.status = 'pending' DESC, pur.requested_at DESC
  `).all();
  res.json(rows);
});
app.patch("/api/admin/upgrade-requests/:id/grant", requireAdmin, (req, res) => {
  const request = db.prepare("SELECT * FROM plan_upgrade_requests WHERE id=? AND status='pending'").get(parseInt(req.params.id));
  if (!request) return res.status(404).json({ error:"Not found" });
  const tier = normalisePlanTier(request.requested_tier);
  const mode = allowedModesForTier(tier)[0];
  db.prepare("UPDATE users SET plan_tier=?, apply_mode=? WHERE id=?").run(tier, mode, request.user_id);
  db.prepare(`
    UPDATE plan_upgrade_requests
    SET status='approved', decided_at=unixepoch(), decided_by=?
    WHERE id=?
  `).run(req.user.id, request.id);
  db.prepare(`
    UPDATE plan_upgrade_requests
    SET status='superseded', decided_at=unixepoch(), decided_by=?
    WHERE user_id=? AND status='pending'
  `).run(req.user.id, request.user_id);
  emitToUser(request.user_id, { type:"plan_updated", planTier:tier, applyMode:mode });
  res.json({ ok:true, userId:request.user_id, planTier:tier, applyMode:mode });
});
app.get("/api/admin/domain-profile-requests", requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT dpr.*, u.username
    FROM domain_profile_requests dpr
    JOIN users u ON u.id = dpr.user_id
    ORDER BY dpr.status = 'pending' DESC, dpr.created_at DESC
  `).all();
  res.json(rows.map(r => ({
    ...r,
    target_titles: JSON.parse(r.target_titles_json || "[]"),
    skills: JSON.parse(r.skills_json || "[]"),
    tools: JSON.parse(r.tools_json || "[]"),
    industries: JSON.parse(r.industries_json || "[]"),
    keywords: JSON.parse(r.keywords_json || "[]"),
  })));
});
app.patch("/api/admin/domain-profile-requests/:id/status", requireAdmin, (req, res) => {
  const status = String(req.body?.status || "").trim();
  if (!["pending","reviewing","resolved","dismissed"].includes(status)) {
    return res.status(400).json({ error:"Invalid status" });
  }
  const result = db.prepare(`
    UPDATE domain_profile_requests
    SET status=?, updated_at=unixepoch()
    WHERE id=?
  `).run(status, parseInt(req.params.id));
  if (!result.changes) return res.status(404).json({ error:"Not found" });
  res.json({ ok:true, status });
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

app.use(createAccountRouter({
  db,
  requireAuth,
  emitToUser,
  syncClients,
  buildAutofillPayload,
  requireModeEntitlement,
  normalisePlanTier,
  allowedModesForTier,
  canUseGenerate,
  canUseAPlusResume,
  nextPlan,
  getAutomationReadiness,
  oauthReadiness,
  probeBrowserAvailability,
  encryptSecret: encryptCookies,
  INTEGRATION_PROVIDERS,
  publicIntegrationRow,
  providerColumnFor,
  INDUSTRY_CATEGORIES,
}));

// ═══════════════════════════════════════════════════════════════
// ── /api/jobs/facets — live counts for filter UI ──────────────
// Returns grouped counts over the current user's job pool (7-day window,
// non-disliked, non-applied). Used to show "Remote (23)" labels and hide
// zero-count filter options. Re-fetch after each scrape completes.
app.get("/api/jobs/facets", requireAuth, (req, res) => {
  const userId = req.user.id;
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  const facetProfile = getOrRepairActiveProfile(userId);
  if (!facetProfile) {
    return res.json({ workType:{}, employmentType:{}, category:{}, postedAge:{}, salaryRange:null, total:0 });
  }
  const roleKey = roleKeyForProfile(facetProfile);
  const rows = db.prepare(`
    SELECT sj.work_type, sj.employment_type, sj.category,
           sj.scraped_at, sj.posted_at, sj.salary_min, sj.salary_max
    FROM scraped_jobs sj
    JOIN job_role_map jrm ON jrm.job_id = sj.job_id AND jrm.role_key = ?
    LEFT JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ? AND uj.domain_profile_id = ?
    WHERE (uj.disliked IS NULL OR uj.disliked = 0)
      AND (uj.applied  IS NULL OR uj.applied  = 0)
      AND ${roleTitleSql("sj.title", roleKey)}
      AND ((sj.posted_at IS NOT NULL AND sj.posted_at != ''
            AND CAST(strftime('%s', sj.posted_at) AS INTEGER) > ?)
           OR ((sj.posted_at IS NULL OR sj.posted_at = '') AND sj.scraped_at > ?))
  `).all(roleKey, userId, facetProfile.id, thirtyDaysAgo, thirtyDaysAgo);

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

  // ── Session sync: populate user_jobs — strictly isolated to the active profile ──
  // IMPORTANT: use domain_profile_id = ? (not IN all profiles) so jobs scraped under
  // another profile never bleed into this board.  No active profile → return empty immediately.
  const sessionActiveProfile = getOrRepairActiveProfile(userId);

  if (!sessionActiveProfile) {
    console.warn(`[jobs] user ${userId} requested jobs without an active profile`);
    return res.json({
      jobs: [],
      total: 0,
      totalPages: 0,
      page,
      pageSize,
      needsProfileSetup: true,
      reason: "no_active_profile",
    });
  }
  if (!userHasBaseResume(userId)) {
    return res.json({
      jobs: [],
      total: 0,
      totalPages: 0,
      page,
      pageSize,
      needsBaseResume: true,
      reason: "no_base_resume",
    });
  }

  // ── Session sync: populate user_jobs from active
  // domain profile only ──────────────────────────────────
  // IMPORTANT: uses domain_profile_id not search_query.
  // Only jobs scraped for the user's active profile
  // enter their pool. This prevents cross-profile and
  // cross-user job bleeding.
  // To change: update the domain_profiles WHERE clause.
  // ────────────────────────────────────────────────────
  const roleKey = roleKeyForProfile(sessionActiveProfile);

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
  const activeProfile = sessionActiveProfile;
  const activeProfileTitleFilter = profileTitleSql("sj.title", activeProfile);

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
    `jrm.role_key = ?`,
    roleTitleSql("sj.title", roleKey),
    activeProfileTitleFilter.sql,
    `(uj.disliked IS NULL OR uj.disliked = 0)`,
    `(uj.applied IS NULL OR uj.applied = 0)`,
    `(uj.resume_generated IS NULL OR uj.resume_generated = 0)`,
  ];
  const filterParams = [roleKey, ...activeProfileTitleFilter.params];

  // req.query.role is legacy search-query state. Visibility is now governed by
  // the shared job_role_map role key, not by the exact query that first scraped it.

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

  // Hard constraint: when no explicit maxYoe filter is set, auto-apply the user's stored
  // experience level so jobs requiring far more experience are excluded by default.
  // Uses a +2 year buffer to allow reasonable stretch-goal jobs through.
  // If user YoE is unknown (null) — no constraint is applied (graceful degradation).
  if (maxYoe === null) {
    const signals = loadSimpleApplyProfile(db, { userId, profileId: activeProfile.id });
    if (signals?.yearsExperience != null) {
      conditions.push(`(sj.min_years_exp IS NULL OR sj.min_years_exp <= ?)`);
      filterParams.push(signals.yearsExperience + 2);
    }
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
    atsScore: "CASE WHEN sj.ats_score IS NULL THEN 1 ELSE 0 END ASC, sj.ats_score DESC, sj.scraped_at DESC",
  };
  const orderBy = sortMap[sort] || sortMap.dateDesc;

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const baseJoin = `
    FROM scraped_jobs sj
    JOIN job_role_map jrm ON jrm.job_id = sj.job_id
    LEFT JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ? AND uj.domain_profile_id = ?
  `;

  const countRow = db.prepare(
    `SELECT COUNT(*) as cnt ${baseJoin} ${where}`
  ).get(userId, activeProfile.id, ...filterParams);
  const total = countRow?.cnt || 0;

  let rows = db.prepare(
    `SELECT sj.*, uj.visited, uj.applied, uj.starred, uj.disliked,
       sj.ats_score as base_ats_score,
       sj.ats_report as base_ats_report,
       r.ats_score as resume_ats_score,
       r.html as resume_html, r.ats_report
     ${baseJoin}
     LEFT JOIN resumes r ON r.user_id = ? AND r.job_id = sj.job_id
     ${where}
     ORDER BY CASE WHEN (uj.visited IS NOT NULL AND uj.visited = 1) THEN 1 ELSE 0 END ASC, ${orderBy}
     LIMIT ? OFFSET ?`
  ).all(userId, activeProfile.id, userId, ...filterParams, pageSize, offset);

  const signalProfile = loadSimpleApplyProfile(db, { userId, profileId: activeProfile.id });
  const profileFacts = getProfileSearchFacts(signalProfile);
  const localCandidateCount = rows.length;
  rows = rows.filter(j => evaluateProfileFactEligibility({
    title: j.title,
    location: j.location,
    description: j.description,
    descriptionHtml: j.description_html,
  }, signalProfile).ok);
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
    scrapedAt:            j.scraped_at,
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
    baseAtsReport:        parseJsonMaybe(j.base_ats_report, null),
    resumeAtsScore:       j.resume_ats_score ?? null, // ATS of generated resume vs JD
    recruiterData:        null,
    enrichmentAvailable:  false,
  }));

  // [jobs] profile sort total returned — keep this diagnostic shape searchable in tests.
  console.log(`[jobs] ${JSON.stringify({
    userId,
    profileId: activeProfile.id,
    profile: activeProfile.profile_name,
    sort,
    localCandidateCount,
    boardVisibleCount: jobs.length,
    total,
    returned: jobs.length,
    page,
    pageSize,
    filters: {
      role: !!req.query.role,
      source: !!src,
      workType: !!workType,
      employmentType: !!empTypeParam,
      category: !!cat,
      location: !!loc,
      ageFilter: !!ageFilter,
      minYoe: minYoe != null,
      maxYoe: maxYoe != null,
      maxApplicants: maxApplicants != null,
      visited: !!visitedParam,
      localSearch: !!localSearch,
      starred: req.query.starred === "1",
    },
    profileFactsUsed: {
      citizenship: !!profileFacts.citizenshipStatus,
      workAuthorization: !!profileFacts.workAuthorization,
      requiresSponsorship: !!profileFacts.requiresSponsorship,
      hasClearance: !!profileFacts.hasClearance,
      clearanceLevel: !!profileFacts.clearanceLevel,
      yearsExperience: signalProfile?.yearsExperience != null,
    },
    payloadSource: "local_only",
  })}`);
  res.json({ jobs, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
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

  const sinceSeconds = Math.max(0, Math.floor((since - 1000) / 1000));
  const userId = req.user.id;
  const activeProfile = getOrRepairActiveProfile(userId);
  if (!activeProfile) {
    console.warn(`[jobs] poll for "${qRaw}" has no active profile for user ${userId}`);
    return res.json({
      jobs: [],
      scraping: false,
      total: 0,
      needsProfileSetup: true,
      reason: "no_active_profile",
    });
  }
  if (!userHasBaseResume(userId)) {
    return res.json({
      jobs: [],
      scraping: false,
      total: 0,
      needsBaseResume: true,
      reason: "no_base_resume",
    });
  }
  const roleKey = roleKeyForProfile(activeProfile);
  const pollProfileTitleFilter = profileTitleSql("sj.title", activeProfile);
  const pollSignals = loadSimpleApplyProfile(db, { userId, profileId: activeProfile.id });
  const pollMaxYoe = pollSignals?.yearsExperience != null ? pollSignals.yearsExperience + 2 : null;
  const pollProfileFacts = getProfileSearchFacts(pollSignals);
  const scrapeKey = scrapeStateKey(userId, activeProfile.id, qRaw);
  const scrapeState  = activeScrapes.get(scrapeKey);
  const stillScraping = !!(scrapeState && !scrapeState.done);

  const rows = db.prepare(`
    SELECT sj.*, uj.visited, uj.applied, uj.starred, uj.disliked
    FROM scraped_jobs sj
    JOIN job_role_map jrm ON jrm.job_id = sj.job_id AND jrm.role_key = ?
    LEFT JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ? AND uj.domain_profile_id = ?
    WHERE LOWER(sj.search_query) = ?
      AND ${roleTitleSql("sj.title", roleKey)}
      AND ${pollProfileTitleFilter.sql}
      AND (? IS NULL OR sj.min_years_exp IS NULL OR sj.min_years_exp <= ?)
      AND sj.scraped_at >= ?
      AND (uj.disliked  IS NULL OR uj.disliked  = 0)
      AND (uj.applied   IS NULL OR uj.applied   = 0)
    ORDER BY sj.scraped_at DESC
    LIMIT 50
  `).all(roleKey, userId, activeProfile.id, qRaw, ...pollProfileTitleFilter.params, pollMaxYoe, pollMaxYoe, sinceSeconds);

  const profileSafeRows = rows.filter(j => evaluateProfileFactEligibility({
    title: j.title,
    location: j.location,
    description: j.description,
    descriptionHtml: j.description_html,
  }, pollSignals).ok);

  const jobs = profileSafeRows.map(j => ({
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
    baseAtsScore:    j.ats_score ?? null,
    baseAtsReport:   parseJsonMaybe(j.ats_report, null),
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

  if (!stillScraping && scrapeState?.done) {
    // [poll] profile query scrape done — keep this diagnostic shape searchable in tests.
    console.log(`[poll] ${JSON.stringify({
      userId,
      profileId: activeProfile.id,
      profile: activeProfile.profile_name,
      query: qRaw,
      status: "scrape done",
      pollSinceMs: since,
      rowsMatched: rows.length,
      returned: jobs.length,
      profileFactsUsed: {
        citizenship: !!pollProfileFacts.citizenshipStatus,
        workAuthorization: !!pollProfileFacts.workAuthorization,
        requiresSponsorship: !!pollProfileFacts.requiresSponsorship,
        hasClearance: !!pollProfileFacts.hasClearance,
        clearanceLevel: !!pollProfileFacts.clearanceLevel,
        yearsExperience: pollSignals?.yearsExperience != null,
      },
    })}`);
  }
  res.json({
    jobs,
    scraping: stillScraping,
    total: jobs.length,
    scrapeUnavailable: !!scrapeState?.error,
    scrapeError: scrapeState?.error || null,
    message: scrapeState?.message || null,
  });
});

const VALID_EMP_TYPES       = new Set(["full-time","part-time","contract","internship","temporary"]);
const VALID_WORKPLACE_TYPES = new Set(["remote","hybrid","office"]);
const VALID_POSTED_LIMITS   = new Set(["24h","1w","1m"]);

function isExternalScrapeQuotaError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("monthly usage hard limit exceeded")
      || msg.includes("usage hard limit exceeded")
      || msg.includes("quota")
      || msg.includes("limit exceeded");
}

function isAnthropicCreditError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("credit balance is too low")
      || msg.includes("insufficient credit")
      || msg.includes("billing")
      || msg.includes("payment required")
      || msg.includes("quota exceeded");
}

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
  const activeProfile = getOrRepairActiveProfile(req.user.id);
  if (!activeProfile) {
    const query = normaliseRole(rawQuery);
    console.warn(`[jobs] user ${req.user.id} requested scrape for "${query}" without an active profile`);
    return res.json({
      ok: false,
      jobs: [],
      total: 0,
      needsProfileSetup: true,
      reason: "no_active_profile",
      error: "Create a job search profile before searching for jobs.",
      query,
      scraping: false,
    });
  }
  if (!userHasBaseResume(req.user.id)) {
    const query = normaliseRole(rawQuery);
    return res.json({
      ok: false,
      jobs: [],
      total: 0,
      needsBaseResume: true,
      reason: "no_base_resume",
      error: "Upload the active profile's base resume before searching jobs.",
      query,
      scraping: false,
    });
  }
  const threadId = searchThreadId();
  let profileJobTitles = activeProfile
    ? buildApifyQueriesFromProfile(activeProfile)
    : null;
  const query = normaliseRole(rawQuery);
  const activeProfileTitles = (() => {
    try { return JSON.parse(activeProfile.target_titles || "[]"); } catch { return []; }
  })();
  const simpleProfile = loadOrCreateSimpleApplyProfile(db, {
    userId: req.user.id,
    profileId: activeProfile.id,
    roleTitles: activeProfileTitles,
  });
  const terms = (simpleProfile?.searchTerms || []).slice(0, 4);
  profileJobTitles = buildProfileSearchTerms(activeProfile, terms);
  const structuredFacts = getProfileSearchFacts(simpleProfile);
  const userProfile = db.prepare("SELECT location FROM user_profile WHERE user_id=?").get(req.user.id);

  // Scrape shaping is profile-driven. UI board filters stay local-only.
  const employmentTypes = ["full-time"];
  const workplaceTypes = ["remote", "hybrid", "office"];
  const postedLimit = "24h";
  const location = String(userProfile?.location || "").trim() || "United States";

  const scrapeParams = {
    employmentTypes, workplaceTypes, postedLimit, location, threadId,
    maxItems: activeProfile.domain === "engineering_embedded_firmware" ? 75 : undefined,
    ...(profileJobTitles ? { jobTitles: profileJobTitles } : {}),
    profileFacts: structuredFacts,
  };

  logSearchThread(threadId, "request", {
    userId: req.user.id,
    rawQuery,
    normalizedQuery: query,
    activeProfile: {
      id: activeProfile.id,
      name: activeProfile.profile_name,
      roleFamily: activeProfile.role_family,
      domain: activeProfile.domain,
    },
    outbound: scrapeParams,
    storedSignalTerms: terms,
    profileFactsUsed: {
      citizenship: structuredFacts.citizenshipStatus || null,
      workAuthorization: structuredFacts.workAuthorization || null,
      requiresSponsorship: !!structuredFacts.requiresSponsorship,
      hasClearance: !!structuredFacts.hasClearance,
      clearanceLevel: structuredFacts.clearanceLevel || null,
      yearsExperience: simpleProfile?.yearsExperience ?? null,
    },
  });

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

  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  const scrapeRoleKey = roleKeyForProfile(activeProfile);
  const scrapeProfileTitleFilter = profileTitleSql("sj.title", activeProfile);
  const scrapeUserId = req.user.id;
  const scrapeKey = scrapeStateKey(scrapeUserId, activeProfile.id, query);

  // DB-first: count unvisited quality jobs scraped in the last 30 days for this role
  const existingCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM scraped_jobs sj
    JOIN job_role_map jrm ON jrm.job_id = sj.job_id AND jrm.role_key = ?
    LEFT JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ? AND uj.domain_profile_id = ?
    WHERE sj.scraped_at > ?
      AND ${roleTitleSql("sj.title", scrapeRoleKey)}
      AND ${scrapeProfileTitleFilter.sql}
      AND (uj.visited IS NULL OR uj.visited = 0)
      AND (uj.applied IS NULL OR uj.applied = 0)
      AND (uj.disliked IS NULL OR uj.disliked = 0)
      AND sj.ghost_score < 4
  `).get(scrapeRoleKey, req.user.id, activeProfile.id, thirtyDaysAgo, ...scrapeProfileTitleFilter.params);

  const THRESHOLD = 50;
  const hasEnough = (existingCount?.cnt || 0) >= THRESHOLD;
  const inFlightScrape = activeScrapes.get(scrapeKey);
  logSearchThread(threadId, "db_first", {
    query,
    roleKey: scrapeRoleKey,
    activeProfileId: activeProfile.id,
    localCandidateCount: existingCount?.cnt || 0,
    threshold: THRESHOLD,
    hasEnough,
    inFlight: !!(inFlightScrape && !inFlightScrape.done),
  });

  if (hasEnough) {
    console.log(`[scrape] DB-first: ${existingCount.cnt} jobs for "${query}" — skipping scrape`);
    // Sync pool jobs not yet in user_jobs (profile-isolated)
    // Only sync if user has an active profile — no fallback to search_query matching
    return res.json({
      ok:true,
      count:0,
      localCount: existingCount.cnt,
      scrapedAt:Date.now(),
      query,
      fromCache:true,
      searchThreadId: threadId,
    });
  }

  if (inFlightScrape && !inFlightScrape.done) {
    console.log(`[scrape] Reusing active scrape for "${query}" on profile ${activeProfile.id}`);
    return res.json({
      ok:true,
      count:0,
      localCount: existingCount?.cnt || 0,
      scrapedAt: inFlightScrape.startedAt,
      query,
      scraping:true,
      queued:true,
      deduped:true,
      searchThreadId: threadId,
    });
  }

  console.log(`[scrape] DB-first: only ${existingCount?.cnt||0} jobs for "${query}" — triggering background scrape`);

  // Respond immediately — HarvestAPI takes 2–5 min; Railway timeout is 30s
  res.json({
    ok:true,
    count:0,
    localCount: existingCount?.cnt || 0,
    scrapedAt:Date.now(),
    query,
    scraping:true,
    searchThreadId: threadId,
  });

  activeScrapes.set(scrapeKey, { startedAt: Date.now(), done: false, threadId });

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
      logSearchThread(threadId, "background_complete", {
        query,
        rawCount: scrapeResult.rawCount,
        filteredCount: scrapeResult.filteredCount,
        insertedCount: scrapeResult.insertedCount,
        durationMs: Date.now() - scrapeStart,
      });
      console.log(`[scrape] Background scrape complete for "${query}"`);
    } catch(e) {
      const quotaExceeded = isExternalScrapeQuotaError(e);
      trackScrape(db, {
        userId: scrapeUserId, searchQuery: query,
        rawCount: 0, filteredCount: 0, insertedCount: 0,
        duplicateCount: 0, ghostCount: 0, irrelevantCount: 0,
        durationMs: Date.now() - scrapeStart,
        success: false, errorText: e.message,
      });
      if (quotaExceeded) {
        console.warn(`[scrape] External scrape quota exhausted for "${query}": ${e.message}`);
        activeScrapes.set(scrapeKey, {
          ...(activeScrapes.get(scrapeKey) || {}),
          done: true,
          error: "scrape_quota_exhausted",
          message: "Search is running local-only because the external scrape quota is exhausted.",
        });
      } else {
        console.error(`[scrape] Background scrape failed for "${query}":`, e.message);
        activeScrapes.set(scrapeKey, {
          ...(activeScrapes.get(scrapeKey) || {}),
          done: true,
          error: "scrape_failed",
          message: "External scrape failed. Local jobs remain available.",
        });
      }
      logSearchThread(threadId, "background_failed", {
        query,
        error: quotaExceeded ? "scrape_quota_exhausted" : "scrape_failed",
        message: e.message,
        durationMs: Date.now() - scrapeStart,
      });
    } finally {
      const existing = activeScrapes.get(scrapeKey) || {};
      activeScrapes.set(scrapeKey, {
        ...existing,
        done: true,
      });
    }
  });
});

// ── Visited / Starred flags ────────────────────────────────────
app.patch("/api/jobs/:id/visited", requireAuth, (req, res) => {
  const jobId = req.params.id;
  const profileId = resolveUserJobDomainProfileId(req.user.id, jobId);
  if (!profileId) return res.status(404).json({ error:"Job not available for active profile" });
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
  if (!profileId) return res.status(404).json({ error:"Job not available for active profile" });
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
  if (!profileId) return res.status(404).json({ error:"Job not available for active profile" });
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
  if (!requirePlan(req, res, "PLUS")) return;
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

  // Priority 2: reuse scrape-time ATS report when it already exists for this job.
  const scrapeTimeReport = db.prepare(
    "SELECT ats_report FROM scraped_jobs WHERE job_id=?"
  ).get(jobId);
  if (scrapeTimeReport?.ats_report) {
    try { return res.json(JSON.parse(scrapeTimeReport.ats_report)); } catch {}
  }

  // Priority 3: return cached ats_only_reports entry (avoids re-running Haiku)
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

  // Priority 4: fetch job + run Haiku call
  const job = db.prepare("SELECT * FROM scraped_jobs WHERE job_id=?").get(jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const activeProfile = getOrRepairActiveProfile(userId);
  const signalProfile = activeProfile
    ? loadOrCreateSimpleApplyProfile(db, { userId, profileId: activeProfile.id })
    : null;
  const resumeBasis = buildAtsResumeBasis(resumeText, signalProfile);
  const jobDescription = job.description || job.title;
  const atsDynamic = `JOB DESCRIPTION (extract keywords ONLY from this text):
Company: ${job.company}
Title: ${job.title}
Category: ${job.category || ""}
Full description:
${jobDescription}

RESUME TEXT (check which JD keywords appear here):
${resumeBasis}`;

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
  const activeProfile = getOrRepairActiveProfile(userId);
  if (!activeProfile) return res.json([]);
  const roleKey = roleKeyForProfile(activeProfile);
  const pendingProfileTitleFilter = profileTitleSql("sj.title", activeProfile);
  const rows = db.prepare(`
    SELECT sj.*, uj.starred, uj.applied, uj.disliked, uj.visited, uj.resume_generated,
           r.ats_score, r.ats_report, r.html as resume_html, r.apply_mode
    FROM scraped_jobs sj
    JOIN job_role_map jrm ON jrm.job_id = sj.job_id AND jrm.role_key = ?
    JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ? AND uj.domain_profile_id = ?
    LEFT JOIN resumes r ON r.user_id = ? AND r.job_id = sj.job_id
    WHERE uj.resume_generated = 1
      AND r.html IS NOT NULL
      AND (uj.applied IS NULL OR uj.applied = 0)
      AND (uj.disliked IS NULL OR uj.disliked = 0)
      AND ${roleTitleSql("sj.title", roleKey)}
      AND ${pendingProfileTitleFilter.sql}
    ORDER BY uj.updated_at DESC
  `).all(roleKey, userId, activeProfile.id, userId, ...pendingProfileTitleFilter.params);
  res.json(rows);
});

app.get("/api/categories", requireAuth, (_req,res) => res.json(INDUSTRY_CATEGORIES));

// ═══════════════════════════════════════════════════════════════
// BASE RESUME
// ═══════════════════════════════════════════════════════════════
app.get("/api/base-resume", requireAuth, (req, res) => {
  const activeProfile = getOrRepairActiveProfile(req.user.id);
  if (!activeProfile) return res.json({ content: null, profileId: null });
  const row = getBaseResumeRecord(db, { userId: req.user.id, profileId: activeProfile.id });
  res.json(row ? {
    content: row.content,
    name: row.name,
    updatedAt: row.updated_at,
    profileId: activeProfile.id,
  } : {
    content: null,
    profileId: activeProfile.id,
  });
});
app.post("/api/base-resume", requireAuth, (req, res) => {
  const activeProfile = getOrRepairActiveProfile(req.user.id);
  if (!activeProfile) return res.status(400).json({ error: "No active profile" });
  const { content, name } = req.body;
  if (content===undefined) return res.status(400).json({ error:"content required" });
  saveBaseResumeRecord(db, { userId: req.user.id, profileId: activeProfile.id }, content, name || "resume.txt");
  const roleTitles = (() => {
    try { return JSON.parse(activeProfile.target_titles || "[]"); } catch { return []; }
  })();
  upsertSimpleApplyProfile(db, { userId: req.user.id, profileId: activeProfile.id }, content, roleTitles);
  res.json({ ok:true, profileId: activeProfile.id });
});
app.get("/api/simple-apply/profile", requireAuth, (req, res) => {
  const activeProfile = getOrRepairActiveProfile(req.user.id);
  if (!activeProfile) {
    return res.json({ titles: [], keywords: [], skills: [], searchTerms: [], profileId: null });
  }
  const profile = loadOrCreateSimpleApplyProfile(db, { userId: req.user.id, profileId: activeProfile.id });
  res.json(profile || { titles: [], keywords: [], skills: [], searchTerms: [] });
});
app.post("/api/simple-apply/profile/refresh", requireAuth, (req, res) => {
  const activeProfile = getOrRepairActiveProfile(req.user.id);
  if (!activeProfile) return res.status(400).json({ error: "No active profile" });
  const base = getBaseResumeRecord(db, { userId: req.user.id, profileId: activeProfile.id });
  if (!base?.content) return res.status(400).json({ error:"No base resume uploaded for the active profile" });
  const roleTitles = (() => {
    try { return JSON.parse(activeProfile.target_titles || "[]"); } catch { return []; }
  })();
res.json(upsertSimpleApplyProfile(db, {
    userId: req.user.id,
    profileId: activeProfile.id,
  }, base.content, roleTitles));
});

function getResumeRouteProfile(req, res) {
  const rawProfileId = req.params.id;
  if (rawProfileId != null) {
    const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=? AND user_id=?")
      .get(rawProfileId, req.user.id);
    if (!profile) {
      res.status(404).json({ error: "Profile not found" });
      return null;
    }
    return profile;
  }
  const activeProfile = getOrRepairActiveProfile(req.user.id);
  if (!activeProfile) {
    res.status(400).json({ error: "No active profile" });
    return null;
  }
  return activeProfile;
}

function sendEnhanceStatus(req, res) {
  const profile = getResumeRouteProfile(req, res);
  if (!profile) return;
  const status = computeEnhancementStatus(db, { userId: req.user.id, profileId: profile.id });
  res.json({
    enhanceUsed: !status.eligible,
    enhancePaid: false,
    ...status,
    history: listProfileEnhancementHistory(db, { userId: req.user.id, profileId: profile.id, limit: 5 }),
  });
}

async function enhanceProfileResume(req, res) {
  const profile = getResumeRouteProfile(req, res);
  if (!profile) return;
  if (!requirePlan(req, res, "PLUS")) return;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_KEY not configured" });

  const baseResumeRow = getBaseResumeRecord(db, { userId: req.user.id, profileId: profile.id });
  if (!baseResumeRow?.content) return res.status(400).json({ error: "No base resume uploaded for this profile" });
  const enhanceStatus = computeEnhancementStatus(db, { userId: req.user.id, profileId: profile.id });
  if (!enhanceStatus.eligible) {
    return res.status(400).json({
      error: "enhance_not_ready",
      message: `Select at least ${enhanceStatus.threshold} ATS-backed profile suggestions before enhancing this resume.`,
      status: enhanceStatus,
    });
  }

  const originalText = baseResumeRow.content;
  const selectedAdditions = buildSelectedEnhancementSkills(db, {
    userId: req.user.id,
    profileId: profile.id,
  });
  const selectedLabels = selectedAdditions.map(item => item.label);

  try {
    const ENHANCE_SYSTEM = `You are a professional resume writer specialising in ATS optimisation.
Rewrite the provided resume to significantly improve its ATS score by:
- Strengthening action verbs (replace weak verbs with domain-specific strong ones)
- Improving keyword density and placement without keyword stuffing
- Selectively incorporating the highest-value ATS additions only when they are realistic for the candidate
- Restructuring bullet points to lead with impact (action -> outcome -> metric)
- Removing filler adjectives and generic phrases
- Ensuring consistent past tense and clean formatting
- Keeping all facts, dates, companies, job titles, and metrics exactly as provided
Do NOT fabricate any information. Do NOT change employment dates, company names, or job titles.
Do NOT keyword-dump. Omit low-value or duplicative additions.
Return ONLY the improved resume text with no commentary, preamble, or explanation.`;

    const t0 = Date.now();
    const enhanceMsg = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: ENHANCE_SYSTEM,
      messages: [{ role: "user", content: `PROFILE NAME: ${profile.profile_name}
ROLE FAMILY: ${profile.role_family}
DOMAIN: ${profile.domain}
SELECTED ATS ADDITIONS TO CONSIDER:
${selectedLabels.map((label, idx) => `${idx + 1}. ${label}`).join("\n")}

RESUME TO ENHANCE:

${originalText}` }],
    });
    const enhancedText = enhanceMsg.content.map(b => b.text || "").join("").trim();
    trackApiCall(db, {
      userId: req.user.id, eventType: "resume_enhance", eventSubtype: "enhance",
      model: "claude-sonnet-4-20250514", usage: enhanceMsg.usage,
      durationMs: Date.now() - t0,
    });

    const templateJd = "Software Engineer, Product Manager, Data Scientist, Data Engineer, Machine Learning Engineer";
    const scoreSignalProfile = loadOrCreateSimpleApplyProfile(db, {
      userId: req.user.id,
      profileId: profile.id,
    });
    const scoreFor = async (resumeContent) => {
      try {
        const resumeBasis = buildAtsResumeBasis(resumeContent, scoreSignalProfile);
        const scoreMsg = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 900,
          system: ATS_SYSTEM_PROMPT,
          messages: [{ role: "user", content:
            `JOB DESCRIPTION:\n${templateJd}\n\n${resumeBasis}` }],
        });
        const raw = scoreMsg.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
        return JSON.parse(raw);
      } catch { return null; }
    };

    const [origReport, enhReport] = await Promise.all([scoreFor(originalText), scoreFor(enhancedText)]);
    const delta = (enhReport?.score ?? 0) - (origReport?.score ?? 0);

    db.prepare(`
      UPDATE profile_base_resumes
      SET enhanced_content=?, enhanced_at=unixepoch(), enhanced_ats_delta=?
      WHERE profile_id=? AND user_id=?
    `).run(enhancedText, delta, profile.id, req.user.id);
    insertProfileEnhancementHistory(db, {
      userId: req.user.id,
      profileId: profile.id,
      baseResumeContent: originalText,
      enhancedContent: enhancedText,
      selectedSkills: selectedLabels,
      atsDelta: delta,
    });

    insertNotification(req.user.id, "enhance_ready",
      `Enhanced resume ready${delta > 0 ? ` (+${delta} ATS pts)` : ""}`,
      { delta, profileId: profile.id, selectedSkills: selectedLabels });
    res.json({
      profileId: profile.id,
      selectedSkills: selectedLabels,
      original: { text: originalText, atsScore: origReport?.score ?? null },
      enhanced: { text: enhancedText, atsScore: enhReport?.score ?? null },
      delta,
      improvements: enhReport?.improvements || [],
    });
  } catch(e) {
    console.error("[enhance]", e.message);
    res.status(500).json({ error: "Enhancement failed: " + e.message });
  }
}

async function adoptEnhancedProfileResume(req, res) {
  const profile = getResumeRouteProfile(req, res);
  if (!profile) return;
  const row = getBaseResumeRecord(db, { userId: req.user.id, profileId: profile.id });
  if (!row?.enhanced_content) return res.status(400).json({ error: "No enhanced resume available" });
  const latestEnhancement = db.prepare(`
    SELECT id, selected_skills_json
    FROM profile_resume_enhancements
    WHERE user_id = ? AND profile_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(req.user.id, profile.id);

  db.prepare(`
    UPDATE profile_base_resumes
    SET content = enhanced_content, updated_at = unixepoch()
    WHERE profile_id = ? AND user_id = ?
  `).run(profile.id, req.user.id);
  upsertSimpleApplyProfile(db, {
    userId: req.user.id,
    profileId: profile.id,
  }, row.enhanced_content);
  if (latestEnhancement?.id) {
    db.prepare(`
      UPDATE profile_resume_enhancements
      SET adopted_at = unixepoch()
      WHERE id = ?
    `).run(latestEnhancement.id);
  }
  markSelectedSuggestionsApplied(db, {
    userId: req.user.id,
    profileId: profile.id,
    selectedLabels: (() => {
      try { return JSON.parse(latestEnhancement?.selected_skills_json || "[]"); } catch { return []; }
    })(),
  });

  const userId = req.user.id;
  const profileId = profile.id;
  enqueueAtsScoreWork(`adopt-enhanced:${userId}:${profileId}`, async () => {
    try {
      const newContent = getBaseResumeRecord(db, { userId, profileId })?.content;
      if (!newContent) return;
      const signalProfile = loadOrCreateSimpleApplyProfile(db, { userId, profileId });
      const atsResumeBasis = buildAtsResumeBasis(newContent, signalProfile);

      const jobsToRescore = db.prepare(`
        SELECT sj.job_id, sj.description, sj.title, sj.company FROM scraped_jobs sj
        JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ? AND uj.domain_profile_id = ?
        WHERE sj.description IS NOT NULL
      `).all(userId, profileId);

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
                `JOB DESCRIPTION:\n${job.description}\n\n${atsResumeBasis}` }],
            });
            const raw = scoreMsg.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
            const report = JSON.parse(raw);
            updateAts.run(report.score, JSON.stringify(report), job.job_id);
          } catch(e) {
            console.warn(`[adopt-enhanced] rescore failed for ${job.job_id}:`, e.message);
          }
        }));
      }
      console.log(`[adopt-enhanced] Re-scored ${jobsToRescore.length} jobs for user ${userId}, profile ${profileId}`);
    } catch(e) {
      console.warn("[adopt-enhanced] background rescore failed:", e.message);
    }
  });

  res.json({ ok: true, profileId });
}
// ENHANCE GATING: profile-scoped and ATS-signal-driven.
// Eligibility depends on selected, broadly useful profile suggestions rather than a one-time user flag.

// GET /api/base-resume/enhance-status
app.get("/api/base-resume/enhance-status", requireAuth, (req, res) => {
  sendEnhanceStatus(req, res);
});

// POST /api/base-resume/enhance — legacy wrapper for the active profile
app.post("/api/base-resume/enhance", requireAuth, async (req, res) => {
  return await enhanceProfileResume(req, res);
});

// PATCH /api/base-resume/adopt-enhanced — legacy wrapper for the active profile
app.patch("/api/base-resume/adopt-enhanced", requireAuth, async (req, res) => {
  return await adoptEnhancedProfileResume(req, res);
});

app.get("/api/domain-profiles/:id/enhance-status", requireAuth, (req, res) => {
  sendEnhanceStatus(req, res);
});

app.post("/api/domain-profiles/:id/enhance", requireAuth, async (req, res) => {
  await enhanceProfileResume(req, res);
});

app.patch("/api/domain-profiles/:id/adopt-enhanced", requireAuth, async (req, res) => {
  await adoptEnhancedProfileResume(req, res);
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
const generationInFlight = new Set();
// Tracks in-flight apply-worker-triggered generations: key → Promise<{html,atsScore,resumeId}|{error}>
const pendingGenerationPromises = new Map();

// ── coreGenerateResume ─────────────────────────────────────────────────────────
// Shared generation kernel used by the HTTP /api/generate handler AND the apply
// worker via generateResumeForApply().  Does NOT do HTTP req/res or rate-limit
// checks — those live in the caller.  Throws on error; returns artifact on success.
async function coreGenerateResume({ userId, jobId, job, tool, resumeText = "", employers = [] }) {
  const mode         = legacyModeForTool(tool);
  const promptMode   = promptModeForTool(tool);
  const eventSubtype = eventSubtypeForTool(tool);

  const profile = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(userId) || {};
  const activeDomainProfile = db.prepare(
    "SELECT * FROM domain_profiles WHERE user_id=? AND is_active=1"
  ).get(userId);
  const storedResume = activeDomainProfile
    ? getBaseResumeRecord(db, { userId, profileId: activeDomainProfile.id })
    : null;
  const authoritativeResumeText = storedResume?.content || resumeText;

  let domainModuleKey = "general";
  if (activeDomainProfile) {
    domainModuleKey = getDomainModuleKey(null, activeDomainProfile.role_family, activeDomainProfile.domain);
    console.log(`[generate] domain from profile: ${activeDomainProfile.profile_name} → ${domainModuleKey}`);
  } else {
    try {
      const classifierStart = Date.now();
      const classifierResult = await classify(anthropic, authoritativeResumeText, job.description || "", {
        onUsage: (usage, model) => trackApiCall(db, {
          userId, eventType: "classifier", eventSubtype, model, usage,
          durationMs: Date.now() - classifierStart, jobId: String(jobId), company: job.company,
        }),
      });
      const qualKey = resolveFromClassifier(classifierResult, profile?.qualification_key);
      domainModuleKey = getDomainModuleKey(qualKey, classifierResult.roleFamily, classifierResult.domain);
    } catch(e) {
      console.warn("[generate] classifier failed, using general domain:", e.message);
    }
  }

  const runtimeInputs = buildRuntimeInputs(profile, job, authoritativeResumeText, promptMode, employers, activeDomainProfile);
  const { systemBlocks } = assemblePrompt(domainModuleKey, promptMode, runtimeInputs);

  const genStart = Date.now();
  const resumeMsg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemBlocks,
    messages: [{ role: "user", content: runtimeInputs }],
  });
  trackApiCall(db, {
    userId, eventType: "resume_generate", eventSubtype,
    model: "claude-sonnet-4-20250514", usage: resumeMsg.usage,
    durationMs: Date.now() - genStart, jobId: String(jobId), company: job.company,
    domainModule: domainModuleKey,
  });
  const html = resumeMsg.content.map(b => b.text || "").join("").replace(/```html|```/g, "").trim();

  let formattedHtml = normalizeResumeHtml(html);
  if (process.env.RESUME_MASTER_LLM_FORMAT === "1") {
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
        userId, eventType: "resume_format", eventSubtype,
        model: "claude-haiku-4-5-20251001", usage: formatMsg.usage,
        durationMs: Date.now() - fmtStart,
      });
      const formatted = formatMsg.content.map(b => b.text || "").join("").replace(/```html|```/g, "").trim();
      if (formatted) formattedHtml = normalizeResumeHtml(formatted);
    } catch(e) {
      console.warn("[format] Formatting pass failed, using raw generation output:", e.message);
    }
  }

  const jobDescription = job.description || job.title;
  const resumeStripped = stripResumeHtml(formattedHtml);
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
    messages: [{ role: "user", content: atsDynamic }],
  });
  let atsReport = null, atsScore = null;
  try {
    const raw = scoreMsg.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
    atsReport = JSON.parse(raw); atsScore = atsReport.score;
  } catch {}
  const atsCacheKey = buildAtsCacheKey(formattedHtml, job);
  trackApiCall(db, {
    userId, eventType: "ats_score", eventSubtype,
    model: "claude-haiku-4-5-20251001", usage: scoreMsg.usage,
    durationMs: Date.now() - atsStart, jobId: String(jobId), company: job.company,
    atsScoreAfter: atsScore,
  });

  const version = (db.prepare("SELECT MAX(version) as v FROM resume_versions WHERE user_id=? AND job_id=?")
    .get(userId, String(jobId))?.v || 0) + 1;
  const keptExists = !!db.prepare("SELECT 1 FROM resume_versions WHERE user_id=? AND job_id=? AND is_kept=1 LIMIT 1")
    .get(userId, String(jobId));
  db.prepare("INSERT INTO resume_versions (user_id,job_id,company,role,category,html,ats_score,ats_report,tool_type,is_kept,version,ats_cache_key,ats_prompt_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(userId, String(jobId), job.company, job.title, job.category, formattedHtml, atsScore, JSON.stringify(atsReport), tool, 0, version, atsCacheKey, ATS_SCORE_PROMPT_VERSION);
  if (!keptExists) {
    db.prepare(`INSERT INTO resumes (user_id,job_id,company,role,category,apply_mode,html,ats_score,ats_report,ats_cache_key,ats_prompt_version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,unixepoch(),unixepoch())
      ON CONFLICT(user_id,job_id) DO UPDATE SET html=excluded.html,role=excluded.role,category=excluded.category,
      apply_mode=excluded.apply_mode,ats_score=excluded.ats_score,ats_report=excluded.ats_report,
      ats_cache_key=excluded.ats_cache_key,ats_prompt_version=excluded.ats_prompt_version,updated_at=excluded.updated_at`)
      .run(userId, String(jobId), job.company, job.title, job.category, mode, formattedHtml, atsScore, JSON.stringify(atsReport), atsCacheKey, ATS_SCORE_PROMPT_VERSION);
  }

  const userJobProfileId = resolveUserJobDomainProfileId(userId, String(jobId));
  if (userJobProfileId) {
    db.prepare(`
      INSERT INTO user_jobs (user_id, job_id, domain_profile_id, resume_generated, updated_at)
      VALUES (?, ?, ?, 1, unixepoch())
      ON CONFLICT(user_id, job_id) DO UPDATE SET
        resume_generated = 1, updated_at = unixepoch()
    `).run(userId, String(jobId), userJobProfileId);
  }

  emitToUser(userId, { type: "resume_generated", jobId: String(jobId), atsScore });
  insertNotification(userId, "resume_generated",
    `Resume ready for ${job.company}${atsScore != null ? ` (ATS: ${atsScore})` : ""}`,
    { jobId: String(jobId), company: job.company, atsScore });

  const savedResume = db.prepare("SELECT id FROM resumes WHERE user_id=? AND job_id=?").get(userId, String(jobId));
  return { html: formattedHtml, atsScore, atsReport, version, resumeId: savedResume?.id ?? null };
}

// ── generateResumeForApply ─────────────────────────────────────────────────────
// Called by the apply worker to resolve or trigger a resume artifact in the
// background.  Returns a Promise that resolves to { html, atsScore, resumeId }
// or { error: string }.  Multiple callers for the same (userId, jobId, tool)
// share the same in-flight Promise to prevent duplicate generation.
function generateResumeForApply(userId, jobId, toolType) {
  const tool = toolType === "a_plus_resume" ? "a_plus_resume" : "generate";
  const mode = legacyModeForTool(tool);
  const key  = `${userId}:${String(jobId)}:${tool}`;

  // 1. Existing artifact in DB — reuse immediately
  const existing = db.prepare(
    "SELECT id, ats_score, html FROM resumes WHERE user_id=? AND job_id=? ORDER BY CASE WHEN apply_mode=? THEN 0 ELSE 1 END, updated_at DESC LIMIT 1"
  ).get(userId, String(jobId), mode);
  if (existing?.html) {
    return Promise.resolve({ html: existing.html, atsScore: existing.ats_score ?? null, resumeId: existing.id, fromCache: true });
  }

  // 2. In-flight Promise from another worker call — share it
  if (pendingGenerationPromises.has(key)) return pendingGenerationPromises.get(key);

  // 3. HTTP handler is already generating (generationInFlight) — poll DB until done
  if (generationInFlight.has(key)) {
    console.log(`[generateResumeForApply] attaching to in-flight HTTP generation for key=${key}`);
    const waitP = new Promise(resolve => {
      const POLL_MS = 2500, MAX_MS = 120_000, start = Date.now();
      const poll = () => {
        const row = db.prepare(
          "SELECT id, ats_score, html FROM resumes WHERE user_id=? AND job_id=? ORDER BY updated_at DESC LIMIT 1"
        ).get(userId, String(jobId));
        if (row?.html) return resolve({ html: row.html, atsScore: row.ats_score ?? null, resumeId: row.id });
        if (Date.now() - start > MAX_MS) return resolve({ error: "generation_timed_out" });
        setTimeout(poll, POLL_MS);
      };
      poll();
    });
    return waitP;
  }

  // 4. Trigger new generation
  const jobRow = db.prepare("SELECT * FROM scraped_jobs WHERE job_id=?").get(String(jobId));
  if (!jobRow) return Promise.resolve({ error: "job_not_found" });

  console.log(`[generateResumeForApply] starting background generation for user=${userId} job=${jobId} tool=${tool}`);
  const p = coreGenerateResume({ userId, jobId: String(jobId), job: jobRow, tool })
    .then(r => ({ html: r.html, atsScore: r.atsScore, resumeId: r.resumeId, fromCache: false }))
    .catch(e => ({ error: e.message }))
    .finally(() => pendingGenerationPromises.delete(key));
  pendingGenerationPromises.set(key, p);
  return p;
}

app.post("/api/generate", requireAuth, async (req, res) => {
  const { jobId, job, resumeText, forceRegen } = req.body;
  // Strip excluded companies from employer list before any processing
  const employers = sanitiseEmployers(req.body.employers);
  if (!job||!resumeText) return res.status(400).json({ error:"job and resumeText required" });
  const tool = req.body?.tool === "a_plus_resume" ? "a_plus_resume" : "generate";
  if (!requireToolEntitlement(req, res, tool)) return;
  const mode = legacyModeForTool(tool);
  const promptMode = promptModeForTool(tool);
  const eventSubtype = eventSubtypeForTool(tool);
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
  const existingVersion = db.prepare(`
    SELECT * FROM resume_versions
    WHERE user_id=? AND job_id=? AND tool_type=?
    ORDER BY version DESC, created_at DESC
    LIMIT 1
  `).get(req.user.id, String(jobId), tool);
  const cachedArtifact = existingVersion || (existing?.apply_mode === mode ? existing : null);

  // Limit check only applies to new generation (not cache hits)
  if (!cachedArtifact || forceRegen) {
    const limitCheck = checkLimit(db, req.user.id, "resume_generate");
    if (!limitCheck.allowed) {
      return res.status(429).json({
        error: limitCheck.reason, limitReached: true,
        current: limitCheck.current, limit: limitCheck.limit, period: limitCheck.period,
      });
    }
  }
  if (cachedArtifact && !forceRegen) {
    const cachedAtsKey = buildAtsCacheKey(cachedArtifact.html, job);
    const cachedReport = parseJsonMaybe(cachedArtifact.ats_report, null);
    const hasStoredScore = cachedArtifact.ats_score != null && cachedReport;
    if (hasStoredScore && (!cachedArtifact.ats_cache_key || (
      cachedArtifact.ats_cache_key === cachedAtsKey &&
      (!cachedArtifact.ats_prompt_version || cachedArtifact.ats_prompt_version === ATS_SCORE_PROMPT_VERSION)
    ))) {
      if (!cachedArtifact.ats_cache_key) {
        db.prepare("UPDATE resumes SET ats_cache_key=?,ats_prompt_version=?,updated_at=unixepoch() WHERE user_id=? AND job_id=?")
          .run(cachedAtsKey, ATS_SCORE_PROMPT_VERSION, req.user.id, String(jobId));
        if (existingVersion) {
          db.prepare("UPDATE resume_versions SET ats_cache_key=?,ats_prompt_version=? WHERE id=?")
            .run(cachedAtsKey, ATS_SCORE_PROMPT_VERSION, existingVersion.id);
        }
      }
      return res.json({
        html:cachedArtifact.html,
        atsScore:cachedArtifact.ats_score,
        atsReport:cachedReport,
        cached:true,
        atsCached:true,
        tool,
        toolLabel: tool === "a_plus_resume" ? "A+ Resume" : "Generate",
        version: cachedArtifact.version || existingVersion?.version || null,
      });
    }
    try {
      const cachedResumeText = stripResumeHtml(cachedArtifact.html);
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
      let freshReport = null, freshScoreVal = cachedArtifact.ats_score;
      try {
        freshReport   = JSON.parse(rawFresh);
        freshScoreVal = freshReport.score;
        db.prepare(
          "UPDATE resumes SET ats_score=?,ats_report=?,ats_cache_key=?,ats_prompt_version=?,updated_at=unixepoch() WHERE user_id=? AND job_id=?"
        ).run(freshScoreVal, JSON.stringify(freshReport), cachedAtsKey, ATS_SCORE_PROMPT_VERSION, req.user.id, String(jobId));
        if (existingVersion) {
          db.prepare("UPDATE resume_versions SET ats_score=?,ats_report=?,ats_cache_key=?,ats_prompt_version=? WHERE id=?")
            .run(freshScoreVal, JSON.stringify(freshReport), cachedAtsKey, ATS_SCORE_PROMPT_VERSION, existingVersion.id);
        }
      } catch {}
      trackApiCall(db, {
        userId: req.user.id, eventType: "ats_score", eventSubtype,
        model: "claude-haiku-4-5-20251001", usage: freshScore.usage,
        durationMs: Date.now() - t0, jobId: String(jobId), company: job.company,
        atsScoreAfter: freshScoreVal,
      });
      return res.json({
        html:cachedArtifact.html,
        atsScore:freshScoreVal,
        atsReport:freshReport || JSON.parse(cachedArtifact.ats_report||"null"),
        cached:true,
        atsCached:false,
        tool,
        toolLabel: tool === "a_plus_resume" ? "A+ Resume" : "Generate",
        version: cachedArtifact.version || existingVersion?.version || null,
      });
    } catch {
      return res.json({
        html:cachedArtifact.html,
        atsScore:cachedArtifact.ats_score,
        atsReport:JSON.parse(cachedArtifact.ats_report||"null"),
        cached:true,
        atsCached:true,
        tool,
        toolLabel: tool === "a_plus_resume" ? "A+ Resume" : "Generate",
        version: cachedArtifact.version || existingVersion?.version || null,
      });
    }
  }

  const inFlightKey = `${req.user.id}:${String(jobId)}:${tool}`;
  if (generationInFlight.has(inFlightKey)) {
    return res.status(409).json({ error:"Resume generation already in progress for this job and tool.", inFlight:true, tool });
  }
  generationInFlight.add(inFlightKey);

  try {
    const result = await coreGenerateResume({ userId: req.user.id, jobId: String(jobId), job, tool, resumeText, employers });
    res.json({ html: result.html, atsScore: result.atsScore, atsReport: result.atsReport, cached:false, version: result.version, tool, toolLabel: tool === "a_plus_resume" ? "A+ Resume" : "Generate" });
  } catch(e) { res.status(500).json({ error:e.message }); }
  finally { generationInFlight.delete(inFlightKey); }
});


// ═══════════════════════════════════════════════════════════════
// SANDBOX + PDF
// ═══════════════════════════════════════════════════════════════
app.post("/api/resumes/:jobId/html", requireAuth, (req, res) => {
  const { html, tool, version } = req.body;
  if (!html) return res.status(400).json({ error:"html required" });
  db.prepare("UPDATE resumes SET html=?,ats_cache_key=NULL,ats_prompt_version=NULL,updated_at=unixepoch() WHERE user_id=? AND job_id=?")
    .run(html, req.user.id, req.params.jobId);
  if (tool || version) {
    db.prepare(`
      UPDATE resume_versions SET html=?, ats_cache_key=NULL, ats_prompt_version=NULL
      WHERE user_id=? AND job_id=?
        AND (? IS NULL OR tool_type=?)
        AND (? IS NULL OR version=?)
    `).run(html, req.user.id, req.params.jobId, tool || null, tool || null, version || null, version || null);
  }
  res.json({ ok:true });
});
app.post("/api/resumes/:jobId/keep", requireAuth, (req, res) => {
  const tool = req.body?.tool === "a_plus_resume" ? "a_plus_resume" : "generate";
  const version = Number.isFinite(Number(req.body?.version)) ? Number(req.body.version) : null;
  const row = db.prepare(`
    SELECT * FROM resume_versions
    WHERE user_id=? AND job_id=? AND tool_type=?
      AND (? IS NULL OR version=?)
    ORDER BY version DESC, created_at DESC
    LIMIT 1
  `).get(req.user.id, req.params.jobId, tool, version, version);
  if (!row) return res.status(404).json({ error:"Resume artifact not found" });
  const mode = legacyModeForTool(tool);
  db.prepare("UPDATE resume_versions SET is_kept=0 WHERE user_id=? AND job_id=?")
    .run(req.user.id, req.params.jobId);
  db.prepare("UPDATE resume_versions SET is_kept=1 WHERE id=?").run(row.id);
  db.prepare(`INSERT INTO resumes (user_id,job_id,company,role,category,apply_mode,html,ats_score,ats_report,ats_cache_key,ats_prompt_version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,unixepoch(),unixepoch())
    ON CONFLICT(user_id,job_id) DO UPDATE SET company=excluded.company,role=excluded.role,category=excluded.category,
    apply_mode=excluded.apply_mode,html=excluded.html,ats_score=excluded.ats_score,ats_report=excluded.ats_report,
    ats_cache_key=excluded.ats_cache_key,ats_prompt_version=excluded.ats_prompt_version,updated_at=excluded.updated_at`)
    .run(req.user.id, req.params.jobId, row.company, row.role, row.category, mode, row.html, row.ats_score, row.ats_report, row.ats_cache_key, row.ats_prompt_version);
  res.json({ ok:true, tool, version: row.version, applyMode: mode });
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
    if (userJobProfileId) {
      db.prepare(`
        INSERT INTO user_jobs (user_id, job_id, domain_profile_id, applied, updated_at)
        VALUES (?, ?, ?, 1, unixepoch())
        ON CONFLICT(user_id, job_id) DO UPDATE SET applied = 1, updated_at = unixepoch()
      `).run(req.user.id, jobId, userJobProfileId);
    }
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
// SMART SEARCH
// ═══════════════════════════════════════════════════════════════
app.post("/api/smart-search", requireAuth, async (req, res) => {
  const { resumeText } = req.body;
  if (!resumeText) return res.status(400).json({ error: "resumeText required" });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_KEY not configured" });
  try {
    const classifierStart = Date.now();
    const classifierResult = await classify(anthropic, resumeText, "", {
      onUsage: (usage, model) => trackApiCall(db, {
        userId: req.user.id,
        eventType: "classifier",
        eventSubtype: "profile_setup",
        model,
        usage,
        durationMs: Date.now() - classifierStart,
      }),
    });
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
    res.json({ ok:true, linkedin: getAutomationReadiness(db, req.user.id).linkedin });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get("/api/linkedin/status", requireAuth, (req, res) => {
  const row = db.prepare(
    "SELECT updated_at FROM user_linkedin_sessions WHERE user_id=?"
  ).get(req.user.id);
  res.json({ connected: !!row, updatedAt: row?.updated_at || null, readiness: getAutomationReadiness(db, req.user.id).linkedin });
});

app.delete("/api/linkedin/cookies", requireAuth, (req, res) => {
  db.prepare("DELETE FROM user_linkedin_sessions WHERE user_id=?").run(req.user.id);
  res.json({ ok:true, linkedin: getAutomationReadiness(db, req.user.id).linkedin });
});

// ═══════════════════════════════════════════════════════════════
// APPLY AUTOMATION (Playwright)
// ═══════════════════════════════════════════════════════════════
applyRoutes(app, db, requireAuth, buildAutofillPayload, generateResumeForApply, htmlToPdf);

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

// POST /api/standalone/generate — Generate resume (no main-app auth)
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
    const runtimeInputs = buildRuntimeInputs({}, fakeJob, resumeText, "GENERATE", []);
    const { systemBlocks } = assemblePrompt(domainModuleKey, "GENERATE", runtimeInputs);

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

app.listen(PORT, () => {
  console.log(`[server] Resume Master v5 on :${PORT}`);
  // Warm up browser availability probe in background so /api/integrations/status
  // returns a cached result without delay on first user request.
  probeBrowserAvailability().then(r => {
    if (r.available) console.log(`[server] browser ready — source=${r.source}`);
    else console.warn(`[server] browser unavailable — ${r.reasonCode}: ${r.error}`);
  }).catch(() => {});
  // Run startup cleanup to expire any stale jobs that accumulated while server was
  // down and the 03:00 cron window was missed.
  setImmediate(() => {
    try { runExpiredJobsCleanup(); }
    catch(e) { console.warn("[cleanup] startup cleanup failed:", e.message); }
  });
});
