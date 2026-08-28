// SCRAPING — SCHEDULED FOR REMOVAL AFTER MIGRATION
// ============================================================
// server.js â€” Resume Master v5
// ============================================================
import "dotenv/config";
import express        from "express";
import cors           from "cors";
import cron           from "node-cron";
import Database       from "better-sqlite3";
import Anthropic      from "@anthropic-ai/sdk";
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
import { createImportJobRouter } from "./routes/importJob.js";
import { createCompanyKbRouter } from "./routes/companyKb.js";
import { runOrgLayerRollup } from "./services/kb/orgLayer.js";
import { runHiringSignalsRollup } from "./services/jobs/hiringSignals.js";
// trackScrape dropped from this import in cleanup 5.8 — it was imported here and never called.
// Every model call goes through callModel, which records usage on one path — see
// services/modelCall.js. trackApiCall is no longer imported here: server.js called it
// directly at 4 of 14 call sites, which is how the other 10 went unrecorded.
import { callModel, SYSTEM_USER_ID } from "./services/modelCall.js";
import { drainInto as drainTrackingFailureSink } from "./services/trackingFailureSink.js";
import { MODEL_SONNET, MODEL_HAIKU } from "./shared/anthropicModels.js";
import { classifyGenerationError } from "./shared/failureAttribution.js";
import { checkLimit } from "./services/limitEnforcer.js";
import { loadAllPrompts, assemblePrompt } from "./services/promptAssembler.js";
import { classify } from "./services/classifier.js";
import { resolveFromClassifier, getDomainModuleKey, getSearchQueryTemplates } from "./services/qualificationResolver.js";
// buildApifyQueriesFromProfile and buildProfileSearchTerms dropped from this import in cleanup
// 5.1: both were imported here and never called. The functions themselves are KEPT — unlike
// 5.7's module they still have real callers, in scripts/tracePipeline.js, scripts/rawTrace.js and
// scripts/conditionTests.js (all three verified to still run) plus their own unit tests. Dead in
// the production path, live in tooling; only the server's unused reference goes.
import { normaliseRole, buildApifyQueries, isTitleRelevant as isTitleRelevantNew, isTitleRelevantToProfile } from "./services/searchQueryBuilder.js";
import { getRoleKeyForProfile as _getRoleKeyForProfile, classifyForIngest, getRoleFamilyDomainForKey } from "./services/jobClassifier.js";
import { inferWorkType, jobHash, normaliseItem, isFullTimeNorm, isEmploymentTypeWanted, parseYearsExperience, ghostJobScoreNorm, isReposted } from "./services/jobNormalization.js";
import { profileTitleSql } from "./services/profileTitleFilter.js";
import { resolveSponsorshipNeed } from "./services/applyAutomation.js";
import { readAnswerStore, effectiveCustomAnswers } from "./services/customAnswers.js";
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
  listProfileClaims,
  listProfileEnhancementHistory,
  markSelectedSuggestionsApplied,
} from "./services/profileSignalAggregator.js";
import {
  buildRuntimeAtsBasis,
  LOCAL_ATS_SOURCE,
  scoreAtsLocally,
} from "./services/localAtsScorer.js";
import {
  INTEGRATION_PROVIDERS,
  getAutomationReadiness,
  publicIntegrationRow,
} from "./services/integrationReadiness.js";
import { searchJobs, cacheJobs, cacheJoboFeed, reconcileFingerprint } from "./services/jobs/aggregator.js";
import { classifyJob as unifiedClassifyJob } from "./services/jobs/classifyJob.js";
// profileMatcher.js deleted in cleanup 5.7. filterAndRankForProfile was imported here and never
// called — the board has been ranked in SQL (ORDER BY in the /api/jobs query) since the pivot,
// so scoreJob's in-memory weighting had no call site. Flagged as dead in bb24241; removed now.
import { isResumeRelevant } from "./services/jobs/relevanceFilter.js";
import {
  buildJobFilters, buildSelectColumns, resolveFacetDimensions, computeSkillsFacet,
  FACET_DIMENSIONS,
} from "./services/jobs/jobQuery.js";
import { mapJobRow } from "./services/jobs/mapJobRow.js";
import { deriveAutomationTier } from "./services/jobs/automationTier.js";
import { backfillAutomationTier } from "./services/jobs/backfillAutomationTier.js";
import { deriveProfileFilters } from "./services/jobs/profileFilterBridge.js";
import { suggest } from "./services/jobs/searchSuggestions.js";
// The filter option contract — the ONE definition of every board filter's value vocabulary.
// GET /api/jobs validates against it (rejectInvalidFilterValues below) so an unknown value is a
// 400 rather than a board that silently matches nothing. See shared/jobFilterOptions.js.
import { FILTER_DIMENSIONS, invalidEntries, ageDaysMap } from "./shared/jobFilterOptions.js";
import { validateResumeClaims, checkCandidateConsistency } from "./services/kb/failsafe.js";
import { assertResumeClaims, profileContradictionFindings } from "./services/resumeClaimGuard.js";
import { getCompanyProfile } from "./services/kb/companyProfile.js";
import { artifactCurrency, currencySentence, modeForTool } from "./services/resumeCurrency.js";

console.log("[boot] server module loaded");

// â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PORT           = process.env.PORT           || 3001;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY  || "";
// NOTE: There is NO server-level APIFY_TOKEN.
// Each user stores their own token in the DB (users.apify_token).
// The cron job borrows the most recently active user's token.
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const SESSION_SECRET = process.env.SESSION_SECRET || (IS_PRODUCTION ? "" : "dev-session-secret-change-me");
if (IS_PRODUCTION && !process.env.SESSION_SECRET) {
  console.error("[auth] FATAL: SESSION_SECRET is not set");
  process.exit(1);
}
if (IS_PRODUCTION && process.env.COOKIE_DOMAIN) {
  console.warn("[auth] COOKIE_DOMAIN is set but ignored; host-only session cookies are used for domain migration safety");
}
const PASSWORD_RESET_SECRET = process.env.PASSWORD_RESET_SECRET || SESSION_SECRET;
const ADMIN_USER     = process.env.ADMIN_USER     || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const OAUTH_PROVIDER_CONFIG = {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
    redirectUri: process.env.GOOGLE_CALLBACK_URL || process.env.GOOGLE_OAUTH_REDIRECT_URI || "",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: ["openid", "email", "profile"],
  },
  linkedin: {
    clientId: process.env.LINKEDIN_CLIENT_ID || process.env.LINKEDIN_OAUTH_CLIENT_ID || "",
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET || process.env.LINKEDIN_OAUTH_CLIENT_SECRET || "",
    redirectUri: process.env.LINKEDIN_CALLBACK_URL || process.env.LINKEDIN_OAUTH_REDIRECT_URI || "",
    authUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    userInfoUrl: "https://api.linkedin.com/v2/userinfo",
    scopes: ["openid", "profile", "email"],
  },
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || "",
    clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
    redirectUri: process.env.GITHUB_CALLBACK_URL || "",
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user",
    emailsUrl: "https://api.github.com/user/emails",
    scopes: ["user:email"],
  },
};
const OAUTH_PROVIDERS = ["google", "linkedin", "github"];
const CACHE_TTL_MS        = 12 * 60 * 60 * 1000;
const MAX_JOBS_PER_REFRESH= 50;
// 64-char hex â†’ 32-byte AES-256 key.  Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// If not set, a random key is generated at startup (LinkedIn sessions won't survive restarts â€” acceptable for dev).
const COOKIE_ENCRYPTION_KEY = Buffer.from(
  process.env.COOKIE_ENCRYPTION_KEY
    ? process.env.COOKIE_ENCRYPTION_KEY.replace(/\s/g,"").slice(0,64)
    : crypto.randomBytes(32).toString("hex"),
  "hex"
);

// â”€â”€ Scaling notes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Current: single Node.js process + SQLite + @sparticuz/chromium.
// Appropriate for ~50-100 concurrent users.
//
// Migration order when scaling to SaaS:
//
// 1. PDF â†’ Gotenberg (see htmlToPdf() comment block above)
//    Add as Railway Docker sidecar: gotenberg/gotenberg:8
//    Set GOTENBERG_URL env var. Zero per-call RAM overhead.
//    Handles concurrent PDF exports natively.
//
// 2. SESSIONS â†’ Redis (connect-redis replaces connect-sqlite3)
//    npm install connect-redis ioredis
//    store: new RedisStore({ client: new Redis(process.env.REDIS_URL) })
//
// 3. DATABASE â†’ PostgreSQL (pg replaces better-sqlite3)
//    npm install pg
//    All db.prepare().get/all/run() become async pool.query()
//    Railway: add PostgreSQL plugin, use DATABASE_URL env var
//    Migration runner pattern stays the same
//
// 4. JOB SCRAPING â†’ Queue (BullMQ + Redis)
//    Move scrapeJobs() into a worker process
//    API enqueues job, client polls for completion
//    Prevents scrape timeouts on Railway's 30s request limit
//
// 5. STATIC FILES â†’ CDN
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

const ATS_SCORE_PROMPT_VERSION = "local-ats-v1";

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
ul.bullets li::before { content: "â€¢"; position: absolute; left: -0.85em; }
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

// Delegates to services/resumeCurrency.js, which needs the same mapping to decide whether a stored
// artifact was built by the tool this run wants. Two copies of it would drift the first time a
// third tool is added, and the currency rule would then quietly stop matching anything.
function legacyModeForTool(tool) {
  return modeForTool(tool);
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

// â”€â”€ Paths â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// RM_DATA_DIR exists so the auth stack can be exercised end to end against a THROWAWAY database.
// Sessions, auth contexts and requireAuth only exist as a whole — passport, the session store and
// bindAuthContext are wired together here in server.js and cannot be mounted piecemeal on a bare
// express app the way routes/*.js can. Verifying them therefore means booting this file, and
// booting this file used to mean writing to the developer's real database. Defaults to exactly the
// previous path, so nothing changes unless something asks it to.
const DATA_DIR  = process.env.RM_DATA_DIR || path.join(__dirname, "data");
const DB_PATH   = path.join(DATA_DIR, "resume_master.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
console.log(`[boot] data directory ready: ${path.dirname(DB_PATH)}`);

// â”€â”€ DB â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const db = new Database(DB_PATH);
// WAL mode: allows concurrent readers alongside a single writer.
// Critical for multi-user deployments â€” prevents SQLITE_BUSY lock errors.
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
console.log(`[boot] database ready: ${DB_PATH}`);

// â”€â”€ Inline migration runner (additive only â€” never drops data) â”€
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
        -- refresh_log removed from the bootstrap schema in cleanup 5.9: zero writers, zero
        -- readers, zero rows. Migration 071 drops it from databases that already have it.
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
    // â”€â”€ Phase 2A: Domain profiles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    // â”€â”€ Phase 5A: Standalone users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    // â”€â”€ Phase 6A: Profile-isolated job pools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    // â”€â”€ Phase 6B: ATS scoring at scrape time â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    {
      id: "017_scraped_jobs_ats",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN ats_score INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN ats_report TEXT;
      `,
    },
    // â”€â”€ Phase 6C: Resume Enhancer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    // â”€â”€ Phase 7: Profile isolation backfill â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        -- that user â€” safe to clear, they will re-populate
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
        -- and are not applied jobs (safe to drop â€” they'd never appear anyway).
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
    // Add future migrations here â€” never edit existing ones
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
      id: "053_github_auth_provider_link",
      sql: `
        ALTER TABLE users ADD COLUMN github_auth_id TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_auth_id
          ON users(github_auth_id) WHERE github_auth_id IS NOT NULL;
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
      //      generic title_heuristic for those same jobs â€” so SWE users never see
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
      // Only removes heuristic and profile-scrape engineering entries â€” manual_review
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
      // 047 â€” Repair existing orphaned jobs that have no job_role_map entry.
      //
      // These are jobs that were scraped without a domainProfile (admin scrapes,
      // profiles deleted post-scrape, or pre-046 legacy ingests) and therefore
      // fell through the assignJobRoleMap() guard.  The ingest-time classifier
      // now handles new orphans; this migration back-fills the historical gap
      // using the same high-confidence title patterns.
      //
      // Only assigns role_key when the title strongly matches a single family.
      // Preserves manual_review entries â€” admin overrides are never touched.
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
      // Migration 048 â€” Re-classify existing job_role_map entries that were assigned
      // role_key='engineering' via automated classifiers but whose title clearly indicates
      // firmware/embedded. Runs in two idempotent steps:
      //
      // Step 1: DELETE stale 'engineering' rows for jobs that already have an
      //   'engineering_embedded_firmware' row â€” these are duplicates from migration 047,
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
    {
      id: "054_aplus_resume_flag",
      sql: `ALTER TABLE users ADD COLUMN aplus_resume INTEGER NOT NULL DEFAULT 0;`,
    },
    {
      id: "055_user_profile_skills",
      sql: `
        ALTER TABLE user_profile ADD COLUMN confirmed_skills TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE user_profile ADD COLUMN target_skills    TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE user_profile ADD COLUMN target_domains   TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE user_profile ADD COLUMN target_locations TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE user_profile ADD COLUMN seniority_level  TEXT;
        ALTER TABLE user_profile ADD COLUMN onboarded        INTEGER NOT NULL DEFAULT 0;
      `,
    },
    {
      id: "056_company_ats_list",
      sql: `
        CREATE TABLE IF NOT EXISTS company_ats_list (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          company     TEXT NOT NULL,
          ats_type    TEXT NOT NULL,
          ats_slug    TEXT NOT NULL,
          active      INTEGER NOT NULL DEFAULT 1,
          bucket_role TEXT,
          created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(ats_type, ats_slug)
        );
        INSERT OR IGNORE INTO company_ats_list (company, ats_type, ats_slug, bucket_role) VALUES
          ('Stripe',     'greenhouse','stripe',        'software_engineer'),
          ('Airbnb',     'greenhouse','airbnb',        'software_engineer'),
          ('Figma',      'greenhouse','figma',         'software_engineer'),
          ('Notion',     'greenhouse','notionhq',      'software_engineer'),
          ('OpenAI',     'greenhouse','openai',        'software_engineer'),
          ('Anthropic',  'greenhouse','anthropic',     'software_engineer'),
          ('Rippling',   'greenhouse','rippling',      'software_engineer'),
          ('Brex',       'greenhouse','brex',          'software_engineer'),
          ('Duolingo',   'greenhouse','duolingo',      'software_engineer'),
          ('Scale AI',   'greenhouse','scaleai',       'software_engineer'),
          ('Ramp',       'lever',     'ramp',          'software_engineer'),
          ('Mercury',    'lever',     'mercury',       'software_engineer'),
          ('Retool',     'lever',     'retool',        'software_engineer'),
          ('Linear',     'ashby',     'linear',        'software_engineer'),
          ('Vercel',     'ashby',     'vercel',        'software_engineer');
      `,
    },
    {
      id: "057_scraped_jobs_buckets",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN bucket_role      TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN bucket_seniority TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN bucket_domain    TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN direct_apply     INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE scraped_jobs ADD COLUMN source_label     TEXT;
      `,
    },
    {
      id: "058_scraped_jobs_via",
      sql: `ALTER TABLE scraped_jobs ADD COLUMN via TEXT;`,
    },
    {
      // Adds collar + confidence columns to scraped_jobs and the rejected_jobs
      // audit table used by the blue-collar eject gate (Phase 4+).
      // ALTER TABLE ADD COLUMN runs once; idempotency is guaranteed by the
      // schema_migrations tracker (this id is never re-applied).
      // CREATE TABLE/INDEX IF NOT EXISTS are unconditionally idempotent.
      id: "059_jobs_segregation",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN collar TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN classification_confidence REAL;
        CREATE TABLE IF NOT EXISTS rejected_jobs (
          job_id      TEXT    PRIMARY KEY,
          title       TEXT,
          company     TEXT,
          source      TEXT,
          reason      TEXT,
          rejected_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_rejected_at ON rejected_jobs(rejected_at);
      `,
    },
    {
      id: "060_user_profile_extended",
      sql: `
        ALTER TABLE user_profile ADD COLUMN website_url TEXT;
        ALTER TABLE user_profile ADD COLUMN portfolio_url TEXT;
        ALTER TABLE user_profile ADD COLUMN desired_salary INTEGER;
        ALTER TABLE user_profile ADD COLUMN salary_currency TEXT;
        ALTER TABLE user_profile ADD COLUMN available_start_date TEXT;
        ALTER TABLE user_profile ADD COLUMN willing_to_relocate INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE user_profile ADD COLUMN highest_degree TEXT;
        ALTER TABLE user_profile ADD COLUMN field_of_study TEXT;
        ALTER TABLE user_profile ADD COLUMN university TEXT;
        ALTER TABLE user_profile ADD COLUMN graduation_year INTEGER;
        ALTER TABLE user_profile ADD COLUMN current_job_title TEXT;
        ALTER TABLE user_profile ADD COLUMN current_company TEXT;
        ALTER TABLE user_profile ADD COLUMN years_of_experience INTEGER;
        ALTER TABLE user_profile ADD COLUMN custom_answers TEXT NOT NULL DEFAULT '{}';
      `,
    },
    {
      id: "061_scraped_jobs_enrichment",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN normalized_title      TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN summary               TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN experience_level      TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN workplace_type        TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN valid_through         INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN salary_min_usd        INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN salary_max_usd        INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN salary_period         TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN skills_json           TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN is_h1b_sponsor        INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN requires_work_auth    INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN is_clearance_required INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN discovered_at         INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN updated_at            INTEGER;
      `,
    },
    {
      id: "062_incremental_sync",
      sql: `
        CREATE TABLE IF NOT EXISTS sync_state (
          source         TEXT    PRIMARY KEY,
          cursor         TEXT,
          last_watermark INTEGER,
          updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
        );
        ALTER TABLE scraped_jobs ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
      `,
    },
    {
      id: "063_cross_source_dedup",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN fingerprint   TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN sources_seen  TEXT;
        CREATE INDEX IF NOT EXISTS idx_scraped_jobs_fingerprint ON scraped_jobs(fingerprint);
      `,
    },
    {
      id: "064_job_enrichment",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN content_hash TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN enriched_at  INTEGER;
        CREATE TABLE IF NOT EXISTS company_technographics (
          company        TEXT    NOT NULL,
          skill          TEXT    NOT NULL,
          weight         REAL    NOT NULL DEFAULT 0,
          last_seen      INTEGER NOT NULL,
          posting_count  INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (company, skill)
        );
      `,
    },
    {
      id: "065_req_uid_fingerprint_hardening",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN req_uid TEXT;
        CREATE INDEX IF NOT EXISTS idx_scraped_jobs_req_uid ON scraped_jobs(req_uid);
      `,
    },
    {
      id: "066_company_org_units",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN org_unit_raw TEXT;
        CREATE TABLE IF NOT EXISTS company_org_units (
          company               TEXT    NOT NULL,
          org_unit              TEXT    NOT NULL,
          domain                TEXT,
          stacks_json           TEXT,
          seniority_json        TEXT,
          confidence            REAL    NOT NULL DEFAULT 0,
          corroboration_count   INTEGER NOT NULL DEFAULT 0,
          status                TEXT    NOT NULL DEFAULT 'proposed',
          first_seen            INTEGER NOT NULL,
          last_seen             INTEGER NOT NULL,
          source_postings_json  TEXT,
          PRIMARY KEY (company, org_unit)
        );
        CREATE INDEX IF NOT EXISTS idx_company_org_units_status ON company_org_units(company, status);
      `,
    },
    {
      id: "067_company_hiring_signals",
      sql: `
        CREATE TABLE IF NOT EXISTS company_hiring_signals (
          company               TEXT    NOT NULL,
          window_start          INTEGER NOT NULL,
          window_end            INTEGER NOT NULL,
          open_count            INTEGER NOT NULL DEFAULT 0,
          new_count             INTEGER NOT NULL DEFAULT 0,
          expired_count         INTEGER NOT NULL DEFAULT 0,
          domain_breakdown_json TEXT,
          growth_score          REAL,
          updated_at            INTEGER NOT NULL,
          PRIMARY KEY (company, window_end)
        );
        CREATE INDEX IF NOT EXISTS idx_company_hiring_signals_company ON company_hiring_signals(company);
      `,
    },
    {
      id: "068_profile_tracked_search",
      sql: `
        ALTER TABLE domain_profiles ADD COLUMN tracked_search_json TEXT;
      `,
    },
    {
      id: "069_pipeline_runs",
      sql: `
        CREATE TABLE IF NOT EXISTS pipeline_runs (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          run_kind     TEXT    NOT NULL,
          source       TEXT,
          status       TEXT    NOT NULL,
          started_at   INTEGER NOT NULL,
          finished_at  INTEGER,
          duration_ms  INTEGER,
          fetched      INTEGER NOT NULL DEFAULT 0,
          written      INTEGER NOT NULL DEFAULT 0,
          unchanged    INTEGER NOT NULL DEFAULT 0,
          merged       INTEGER NOT NULL DEFAULT 0,
          dropped      INTEGER NOT NULL DEFAULT 0,
          ejected      INTEGER NOT NULL DEFAULT 0,
          failed       INTEGER NOT NULL DEFAULT 0,
          skipped      INTEGER NOT NULL DEFAULT 0,
          expired      INTEGER NOT NULL DEFAULT 0,
          error_text   TEXT,
          details_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_kind_source ON pipeline_runs(run_kind, source, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started ON pipeline_runs(started_at DESC);
      `,
    },
    {
      // Four of the seeded ATS rows in 056 were wrong. Every company below was re-probed
      // against the live provider APIs before changing anything — no slug is guessed.
      //
      //   Notion    greenhouse/notionhq -> ashby/notion       (gh 404s; ashby returns 128)
      //   OpenAI    greenhouse/openai   -> ashby/openai       (gh 404s; ashby returns 732)
      //   Vercel    ashby/vercel        -> greenhouse/vercel  (ashby board is EMPTY, gh has 83)
      //   Rippling  greenhouse/rippling -> DEACTIVATED        (404 on greenhouse, ashby AND
      //                                                        lever; no board found)
      //
      // Identities confirmed from board content, not just a 200: OpenAI's departments include
      // Research/Safety Systems/Applied AI, and Vercel's postings resolve to
      // job-boards.greenhouse.io/vercel.
      //
      // Vercel is the subtlest of the four: ashby/vercel returns HTTP 200 with zero jobs, so it
      // never raised an error and never even logged the per-company warning a 404 produces — it
      // just silently contributed nothing to the board.
      //
      // Rippling is deactivated rather than deleted or guessed. active=0 is honoured by
      // cacheJobs (`WHERE active = 1`), so it stops costing a failed request every crawl while
      // the row survives as a record to reactivate once someone finds the real board. Guessing
      // a slug is exactly the failure this codebase already learned from twice.
      //
      // Corrected forward rather than by editing 056, which has already run everywhere. Each
      // guard is narrow enough to be idempotent and to not clobber a hand-fixed row.
      id: "070_fix_dead_ats_slugs",
      sql: `
        UPDATE company_ats_list
           SET ats_type = 'ashby', ats_slug = 'openai'
         WHERE company = 'OpenAI' AND ats_type = 'greenhouse';

        UPDATE company_ats_list
           SET ats_type = 'ashby', ats_slug = 'notion'
         WHERE company = 'Notion' AND ats_type = 'greenhouse';

        UPDATE company_ats_list
           SET ats_type = 'greenhouse', ats_slug = 'vercel'
         WHERE company = 'Vercel' AND ats_type = 'ashby';

        UPDATE company_ats_list
           SET active = 0
         WHERE company = 'Rippling' AND ats_type = 'greenhouse' AND ats_slug = 'rippling';
      `,
    },
    {
      // Cleanup 5.9. refresh_log had zero writers, zero readers and zero rows — grep-verified
      // across the repo, its only mention anywhere was its own CREATE TABLE in the bootstrap
      // schema, which this release also removes. Dropping it here clears it from databases that
      // already created it. Safe: no data is lost because none was ever written.
      //
      // NOT dropped, deliberately: scrape_events. Its writer (usageTracker.trackScrape) is gone
      // in the same release, but routes/admin.js still READS it in four analytics queries, so
      // dropping it would break the admin dashboard. Those panels now report a permanent zero,
      // which is accurate rather than broken. See docs/PIPELINE_DIAGNOSIS.md §5.12.
      id: "071_drop_refresh_log",
      sql: `
        DROP TABLE IF EXISTS refresh_log;
      `,
    },
    {
      id: "072_apply_submit_guards",
      sql: `
        CREATE TABLE IF NOT EXISTS app_settings (
          key        TEXT PRIMARY KEY,
          value      TEXT,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS apply_idempotency (
          user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          idem_key      TEXT    NOT NULL,
          endpoint      TEXT    NOT NULL,
          status_code   INTEGER NOT NULL DEFAULT 200,
          response_json TEXT    NOT NULL,
          created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (user_id, idem_key)
        );
        ALTER TABLE apply_run_jobs ADD COLUMN answers_json TEXT;
        ALTER TABLE apply_run_jobs ADD COLUMN resume_artifact_id INTEGER;
        ALTER TABLE apply_run_jobs ADD COLUMN resume_ats_score INTEGER;
        ALTER TABLE apply_run_jobs ADD COLUMN screenshot_path TEXT;
        ALTER TABLE apply_run_jobs ADD COLUMN submit_verified INTEGER;
        ALTER TABLE apply_run_jobs ADD COLUMN submit_evidence TEXT;
      `,
    },
    {
      id: "073_apply_open_questions",
      sql: `
        ALTER TABLE apply_run_jobs ADD COLUMN open_questions_json TEXT;
      `,
    },
    {
      // Queue-then-approve. approval_mode is left NULL on existing rows deliberately: those runs
      // predate the flow and were never approved by anyone, so backfilling them to 'required' would
      // put a claim in the audit trail that is not true. NULL reads as "predates approval".
      //   'required' — the run previews only and parks each job for a human decision
      //   'auto'     — full-auto, submitted without approval (now opt-in)
      //   'approved' — this run exists BECAUSE a human approved; it submits
      // approved_from_run_job_id points at the preview row whose answers were approved, which is what
      // lets the submitting run refuse if the form has changed since.
      id: "074_apply_approval_flow",
      sql: `
        ALTER TABLE apply_runs     ADD COLUMN approval_mode TEXT;
        ALTER TABLE apply_run_jobs ADD COLUMN approved_at INTEGER;
        ALTER TABLE apply_run_jobs ADD COLUMN approved_from_run_job_id INTEGER;
      `,
    },
    {
      // Cost observability. `purpose` names the FEATURE a model call served, separately from
      // event_type — which stays exactly as it is because services/limitEnforcer.js enforces
      // per-user quotas with `WHERE event_type = ?`, so repurposing that column would silently
      // change what counts against a limit.
      //
      // Additive and nullable on purpose: every row written before this migration was recorded by
      // a call site that had no notion of purpose, and inventing one for them would put a claim in
      // the cost history that nothing verified. NULL reads as "recorded before purpose existed" —
      // routes/admin.js groups it as 'unattributed' rather than dropping it.
      //
      // The 'system' user (id 0) is what background work — enrichment, import extraction, job
      // classification, the unauthenticated standalone endpoints — is attributed to.
      // usage_events.user_id is NOT NULL REFERENCES users(id), and better-sqlite3 turns
      // foreign_keys ON by default, so a bare sentinel id with no row is REJECTED: verified by a
      // real run, where every background insert failed with "FOREIGN KEY constraint failed" and
      // the largest untracked spender stayed untracked.
      // id 0 can never collide with a real account (users.id is AUTOINCREMENT, so it starts at 1)
      // and the password hash is a literal that no hash function can produce, so it is not a
      // login. INSERT OR IGNORE keeps this migration safe to re-run.
      id: "075_usage_events_purpose",
      sql: `
        ALTER TABLE usage_events ADD COLUMN purpose TEXT;
        CREATE INDEX IF NOT EXISTS idx_usage_events_purpose
          ON usage_events(purpose, created_at);
        INSERT OR IGNORE INTO users (id, username, password_hash, is_admin)
          VALUES (0, 'system', '!unusable', 0);
      `,
    },
    {
      // Persisted tracking failures. The in-process counters added with 075 reset on restart, so
      // a failure that happened and was then followed by a deploy left no trace at all: the cost
      // panel would report healthy coverage for a gap that really occurred.
      //
      // user_id carries NO foreign key, deliberately. The first real run of the wrapper failed
      // with "FOREIGN KEY constraint failed" on usage_events.user_id — an FK violation is one of
      // the reasons a usage insert fails, so putting an FK here would make the failure record
      // itself fail for exactly the cases most worth recording. Every column except created_at is
      // nullable for the same reason: a partial record beats no record.
      //
      // This still cannot capture a database that is entirely unreachable — that case degrades to
      // the in-process counter and the error log, and routes/admin.js says so rather than
      // implying the persisted count is complete.
      id: "076_usage_tracking_failures",
      sql: `
        CREATE TABLE IF NOT EXISTS usage_tracking_failures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          model TEXT,
          purpose TEXT,
          user_id INTEGER,
          error_text TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_usage_tracking_failures_created
          ON usage_tracking_failures(created_at);
      `,
    },
    {
      // Distinguishes a failure recorded LIVE from one recovered out of the out-of-process sink
      // (services/trackingFailureSink.js) after the database came back. Conflating them would hide
      // the more serious fact: a sink-recovered row means the database itself was unreachable at
      // the time, not merely that one insert was rejected.
      //
      // Nullable: rows written by 076 predate the distinction, and NULL reads as "recorded live,
      // before this column existed" rather than being backfilled with a claim nothing verified.
      id: "077_tracking_failure_source",
      sql: `
        ALTER TABLE usage_tracking_failures ADD COLUMN source TEXT;
      `,
    },
    {
      // Automation tier — what the candidate will face at the apply destination, decided at
      // browse time. services/jobs/automationTier.js owns the mapping; this column stores its
      // output so services/jobs/jobQuery.js can filter on it in SQL. Deriving it at read time
      // instead would force that mapping to be re-expressed as a CASE expression here, and a
      // second copy of a mapping is exactly what left model ids half-migrated across the
      // codebase.
      //
      // NULLABLE, AND NOT BACKFILLED BY THIS MIGRATION — deliberately. The backfill needs
      // deriveAutomationTier(), which is JavaScript; writing it as a SQL CASE would create the
      // duplicate this column exists to avoid. Existing rows are populated instead by the
      // boot-time backfill immediately below this runner and by
      // scripts/recomputeAutomationTier.js, both of which call that one function.
      //
      // So NULL is a state the board must survive: it means "written before this column
      // existed and not yet recomputed", which is indistinguishable from 'unknown' as far as
      // any promise to the user goes. jobQuery.js's tiers_include/tiers_exclude therefore
      // COALESCE it to 'unknown' rather than letting `NULL IN (...)` (which is NULL, not
      // false) silently drop the row from BOTH directions of the filter.
      id: "078_scraped_jobs_automation_tier",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN automation_tier TEXT;
        CREATE INDEX IF NOT EXISTS idx_scraped_jobs_automation_tier
          ON scraped_jobs(automation_tier, is_active);
      `,
    },
    {
      // The prepared packet for a gated portal (docs/GATED_HANDOFF_ARCHITECTURE.md §3 step 3). A run
      // that hits a login wall or a CAPTCHA cannot finish on the server, so everything already
      // decided is parked here for the human who will cross that gate, and handed to the extension
      // in exchange for a single-use token.
      //
      // expected_origin is stored SEPARATELY from apply_url rather than derived at read time. It is
      // the value the extension target-matches before releasing anything, and this packet carries a
      // home address and work-authorization answers — so the thing being compared has to be a stored
      // fact, decided once when the run observed the gate, not a re-parse of a URL that may have been
      // rewritten since.
      //
      // token_hash, not the token: a database read must not yield a usable credential. The token
      // exists only in the response that mints it. consumed_at is what makes it single-use, and it is
      // set in the same statement that claims the packet, so two concurrent exchanges cannot both win.
      //
      // exchange_attempts counts every attempt including rejected ones, so a packet being probed is
      // visible on the row itself and not only in the log.
      id: "079_apply_gate_packets",
      sql: `
        CREATE TABLE IF NOT EXISTS apply_gate_packets (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          run_id             INTEGER,
          run_job_id         INTEGER REFERENCES apply_run_jobs(id) ON DELETE CASCADE,
          job_id             TEXT    NOT NULL,
          apply_url          TEXT    NOT NULL,
          expected_origin    TEXT    NOT NULL,
          gate_reason        TEXT    NOT NULL,
          answers_json       TEXT    NOT NULL,
          resume_artifact_id INTEGER,
          token_hash         TEXT    NOT NULL UNIQUE,
          expires_at         INTEGER NOT NULL,
          consumed_at        INTEGER,
          exchange_attempts  INTEGER NOT NULL DEFAULT 0,
          created_at         INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_gate_packets_user_job
          ON apply_gate_packets(user_id, job_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_gate_packets_origin
          ON apply_gate_packets(user_id, expected_origin, consumed_at);
      `,
    },
    {
      // What a human actually saw before an application went out (TASK G3, §4's review-as-provenance).
      // The audit trail already records what was ANSWERED and with what provenance; this records what
      // was REVIEWED — which fields the candidate approved as-is, which they corrected, and which
      // low-confidence guesses they had to acknowledge before the overlay would call itself ready.
      //
      // Separate from answers_json rather than merged into it: those are two different claims made at
      // two different times by two different parties, and collapsing them would make it impossible to
      // say afterwards whether a value was the resolver's or the candidate's. For a gated application
      // this is the ONLY record of human review, because the submission itself happens in a browser we
      // never see.
      //
      // Nullable, not backfilled: a NULL means the application predates the overlay or was never
      // reviewed through it, which is not the same as "reviewed and nothing changed".
      id: "080_apply_gate_review",
      sql: `
        ALTER TABLE apply_run_jobs ADD COLUMN gate_review_json TEXT;
      `,
    },
    {
      // A company's application form, as a KB fact (TASK G4). Behind a gate is a place the server
      // can never reach, but the extension is standing inside it — so the form's STRUCTURE comes
      // back and the next candidate's packet arrives pre-mapped. It is the mechanism that replaces
      // hand-writing platformDetector's PLATFORM_LABEL_MAPS one ATS at a time.
      //
      // KEYED BY APPLY HOST, not by job. One careers page serves every posting behind it, so a
      // schema captured once from any of them serves all the others — which is the only reason this
      // compounds rather than being a per-application cache.
      //
      // STRUCTURE ONLY. fields_json holds labels, types, required flags, option lists and order.
      // Never a value, never anything about the candidate. discoverFields returns current_value and
      // this store must never receive it, which is enforced by a whitelist in formSchemaLayer.js and
      // asserted by test rather than promised by a comment.
      //
      // shape_hash is what makes a CHANGED form observable. Forms change; a stale schema that is
      // trusted is worse than no schema, so a differing hash is treated as a new claim about the
      // form — corroboration resets and a confirmed schema drops back to proposed. That last part
      // deliberately DIVERGES from company_org_units, which never demotes: an org unit that stops
      // appearing may simply not be hiring, whereas a form that comes back different is positive
      // evidence the stored one is now wrong.
      //
      // `source` distinguishes a capture made by a candidate standing behind a gate from one our own
      // crawl of a public careers page produced. Both write the same shape on purpose — this is the
      // store imported-careers-page support needs too, and a gated-only variant would have to be
      // merged into it later.
      //
      // users.form_schema_capture is the consent switch, DEFAULT 0. Capture reports on a page behind
      // that candidate's own authenticated session, and opt-in is the only answer to "what does it
      // send from behind my login?" that does not rest on trusting our filter.
      id: "081_company_form_schemas",
      sql: `
        CREATE TABLE IF NOT EXISTS company_form_schemas (
          apply_host           TEXT    NOT NULL PRIMARY KEY,
          company              TEXT,
          platform             TEXT,
          fields_json          TEXT    NOT NULL,
          field_count          INTEGER NOT NULL DEFAULT 0,
          unmapped_json        TEXT,
          unmapped_count       INTEGER NOT NULL DEFAULT 0,
          shape_hash           TEXT    NOT NULL,
          confidence           REAL    NOT NULL DEFAULT 0,
          corroboration_count  INTEGER NOT NULL DEFAULT 0,
          status               TEXT    NOT NULL DEFAULT 'proposed',
          source               TEXT    NOT NULL,
          first_seen           INTEGER NOT NULL,
          last_seen            INTEGER NOT NULL,
          changed_at           INTEGER,
          previous_shape_hash  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_company_form_schemas_company
          ON company_form_schemas(company, status);
        ALTER TABLE users ADD COLUMN form_schema_capture INTEGER NOT NULL DEFAULT 0;
      `,
    },
    {
      // H-1B sponsorship as a COMPANY fact, from DOL/OFLC LCA disclosure data (TASK X3).
      //
      // WHY THIS IS NOT ON scraped_jobs. The posting-level is_h1b_sponsor experiment is over and it
      // failed on the evidence: of 1,261 postings, 0 mention "H-1B", 36 mention sponsorship at all,
      // and the LLM backfill produced 3 non-null values, all false. The signal is not in the source
      // material. Every H-1B-sponsoring employer, by contrast, MUST file a Labor Condition
      // Application, and those filings are public and quarterly. So this is a fact the company emits
      // about itself, and it belongs beside company_technographics and company_org_units.
      //
      // is_h1b_sponsor SURVIVES UNCHANGED and is not populated from here. Two different claims:
      // "this employer filed 47 petitions last quarter" is not "this role sponsors". Nothing in this
      // migration touches scraped_jobs, by design and by test
      // (test/lcaPostingFlagUntouched.test.js).
      //
      // THREE TABLES, because they answer to three different owners:
      //
      //   lca_source_files     — the import ledger. One row per quarterly file, so a re-import
      //                          RECONCILES (delete-then-insert that period) instead of doubling
      //                          the counts, same discipline as the job pipeline's req_uid.
      //   lca_employer_periods — LCA employers as filed, one row per (employer, FEIN, quarter).
      //                          Keeping the whole employer universe rather than only the companies
      //                          we happen to know today is what lets a company added tomorrow be
      //                          matched without re-downloading ~2 GB of spreadsheets.
      //   company_lca_sponsorship — the derived KB fact for one of OUR company strings, carrying
      //                          the match tier and confidence, provenance and last_seen like every
      //                          other KB store.
      //
      // fein is NOT NULL with a '' sentinel rather than nullable: it is in a PRIMARY KEY, and SQLite
      // permits NULLs in a non-INTEGER primary key, which would silently stop de-duplicating the
      // rows this table exists to de-duplicate.
      //
      // match_status is the integrity mechanism, not decoration. 'ambiguous' means two or more
      // distinct FEINs answer to the same brand name (measured: 2.3% of reachable brands — Mercury
      // Insurance vs Mercury Technologies, and Mercury Insurance also files for "Senior Software
      // Engineer", so no title heuristic can separate them). An 'ambiguous' row renders NOTHING —
      // not a zero, not "no data" — because a wrong sponsor claim is worse than a missing one.
      //
      // periods_covered vs periods_with_filings is how staleness stays honest. Quora filed 1
      // certified LCA in FY2025 Q4 and 0 in FY2026 Q1; a single-quarter snapshot cannot tell "does
      // not sponsor" from "did not file last quarter", so the store records how many quarters were
      // SEARCHED alongside how many had filings, and latest_period carries the recency the UI
      // decays against.
      id: "082_company_lca_sponsorship",
      sql: `
        CREATE TABLE IF NOT EXISTS lca_source_files (
          file_name       TEXT    NOT NULL PRIMARY KEY,
          fiscal_period   TEXT    NOT NULL,
          fiscal_year     INTEGER NOT NULL,
          fiscal_quarter  INTEGER NOT NULL,
          period_start    INTEGER,
          period_end      INTEGER,
          sheet_rows      INTEGER NOT NULL DEFAULT 0,
          case_rows       INTEGER NOT NULL DEFAULT 0,
          employer_rows   INTEGER NOT NULL DEFAULT 0,
          byte_size       INTEGER,
          source_url      TEXT,
          ingested_at     INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lca_employer_periods (
          employer_key    TEXT    NOT NULL,
          fein            TEXT    NOT NULL,
          fiscal_period   TEXT    NOT NULL,
          employer_name   TEXT    NOT NULL,
          dba_keys_json   TEXT,
          state           TEXT,
          certified       INTEGER NOT NULL DEFAULT 0,
          denied          INTEGER NOT NULL DEFAULT 0,
          withdrawn       INTEGER NOT NULL DEFAULT 0,
          positions       INTEGER NOT NULL DEFAULT 0,
          top_titles_json TEXT,
          last_decision   INTEGER,
          PRIMARY KEY (employer_key, fein, fiscal_period)
        );
        CREATE INDEX IF NOT EXISTS idx_lca_employer_periods_key
          ON lca_employer_periods(employer_key);
        CREATE INDEX IF NOT EXISTS idx_lca_employer_periods_period
          ON lca_employer_periods(fiscal_period);
        CREATE TABLE IF NOT EXISTS company_lca_sponsorship (
          company              TEXT    NOT NULL PRIMARY KEY,
          match_status         TEXT    NOT NULL,
          match_tier           TEXT,
          match_confidence     REAL    NOT NULL DEFAULT 0,
          match_key            TEXT,
          match_reason         TEXT,
          matched_entities_json TEXT,
          candidate_count      INTEGER NOT NULL DEFAULT 0,
          certified_total      INTEGER NOT NULL DEFAULT 0,
          denied_total         INTEGER NOT NULL DEFAULT 0,
          positions_total      INTEGER NOT NULL DEFAULT 0,
          by_period_json       TEXT,
          by_fiscal_year_json  TEXT,
          top_titles_json      TEXT,
          latest_period        TEXT,
          latest_filing_at     INTEGER,
          periods_covered      INTEGER NOT NULL DEFAULT 0,
          periods_with_filings INTEGER NOT NULL DEFAULT 0,
          source               TEXT    NOT NULL DEFAULT 'dol_oflc_lca',
          provenance_json      TEXT,
          first_seen           INTEGER NOT NULL,
          last_seen            INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_company_lca_sponsorship_status
          ON company_lca_sponsorship(match_status, certified_total);
      `,
    },
    {
      // The OFLC record layout CHANGED, and the corpus has to be able to say where (TASK X3).
      //
      // EMPLOYER_FEIN does not exist in the FY2021, FY2022 or FY2023 disclosure files. Those sheets
      // are 96 columns with no employer tax ID anywhere in them; FY2024 Q1 onward is 98 columns with
      // it. That matters because FEIN is what services/kb/lcaMatch.js counts to decide whether a
      // brand-prefix (tier C) match is unambiguous — and counting FEINs over a file that has none
      // returns zero, which would have read as "one employer" and switched the ambiguity guard OFF
      // for twelve of the twenty-one available quarters. countDistinctEntities() falls back to
      // counting distinct legal names instead, which is strictly more cautious.
      //
      // Stored rather than derived. It IS derivable ("do all this period's rows have fein = ''?"),
      // but a derived answer cannot distinguish a file that had no FEIN column from a file whose
      // FEIN column happened to be empty, and the second would be a parser bug we would want to see
      // rather than absorb. One column in the import ledger, written from the header row itself.
      //
      // Nullable with no default: rows written before this migration predate the check and must not
      // claim either answer. Re-running the ingester for those periods fills them in.
      id: "083_lca_source_fein_presence",
      sql: `
        ALTER TABLE lca_source_files ADD COLUMN has_employer_fein INTEGER;
      `,
    },
    {
      // OFLC CHANGED WHAT A QUARTERLY FILE MEANS, and the corpus has to survive both conventions
      // (TASK X3). Measured from the decision dates in the files themselves:
      //
      //   FY2021 Q1   2020-10-01 → 2020-12-31     one quarter
      //   FY2021 Q2   2020-10-01 → 2021-03-31     TWO quarters — contains Q1
      //   FY2021 Q3   2020-10-01 → 2021-06-30     THREE quarters — contains Q2
      //   FY2025 Q1   2024-10-01 → 2024-12-31     one quarter
      //   FY2025 Q2   2025-01-01 → 2025-03-31     one quarter — disjoint from Q1
      //
      // The old files are FISCAL-YEAR CUMULATIVE; the new ones are per-quarter. Migration 082's
      // ingester summed across periods on the strength of the FY2025/FY2026 evidence, which is
      // correct there and TRIPLE-COUNTS FY2021 Q1. Nothing about the filename says which convention
      // a file follows, so the ingester now derives each file's true window from its own decision
      // dates and drops any period whose window is contained in another's.
      //
      // quarters_covered is that window expressed in quarters, and it is stored because two things
      // need it and neither can recompute it: periods_covered ("how long did we look?") must count
      // QUARTERS rather than files, or a four-year corpus reports as nine; and the per-period chips
      // must not label a full fiscal year "FY2021 Q4", which would claim a year's filings happened
      // in one quarter.
      //
      // Nullable: rows written before this migration have not had their window measured, and
      // guessing 1 would silently reassert the bug this exists to fix.
      id: "084_lca_period_span",
      sql: `
        ALTER TABLE lca_source_files ADD COLUMN quarters_covered INTEGER;
      `,
    },
    {
      // TASK AC4: a USER-SIDE DELETE that is a soft hide, and the index the dated history reads on.
      //
      // WHY SOFT, AND WHY FOR EVERYTHING. The requirement asks for the decision to be made and
      // stated. A submitted application is evidence that reached a real employer; that record is
      // exactly what the candidate needs when an interview lands three weeks later, and a hard
      // delete would destroy it on a click made while tidying up. So submitted rows are never
      // hard-deleted — and rather than two code paths, NOTHING is: `hidden_at` is set on any row
      // the user removes, and every user-facing feed filters it out. Three things fall out of that
      // which a DELETE would have cost:
      //
      //   - apply_job_logs.run_job_id and apply_gate_packets.run_job_id both cascade on DELETE, so
      //     hard-deleting one run-job would silently take its whole audit trail and its prepared
      //     handoff with it.
      //   - apply_runs.submitted_count / held_count / failed_count are stored counters, not
      //     derived. Removing a row would leave the run claiming work that no longer exists.
      //   - It is reversible. `UPDATE apply_run_jobs SET hidden_at=NULL` restores anything an
      //     operator is asked to restore; a DELETE is a support ticket that cannot be answered.
      //
      // Nullable with no default and no backfill: NULL means visible, which is what every existing
      // row is. A row written before this migration cannot have been hidden.
      //
      // The index is what makes the dated view a lookup rather than a scan. AC4 requirement 5 says
      // the history must be date-scoped AND user-scoped on the SERVER — "do not fetch all history
      // and filter client-side" — and (user_id, created_at) is the exact shape of that query. The
      // existing idx_apply_run_jobs_user_status leads with status, so it cannot serve a date range.
      id: "085_apply_run_jobs_hidden",
      sql: `
        ALTER TABLE apply_run_jobs ADD COLUMN hidden_at INTEGER;
        CREATE INDEX IF NOT EXISTS idx_apply_run_jobs_user_created
          ON apply_run_jobs(user_id, created_at);
      `,
    },
    {
      // The sponsorship SITUATION, replacing a stored ANSWER. `requires_sponsorship` is one
      // boolean, and the standard Greenhouse question is "do you NOW OR IN THE FUTURE require
      // sponsorship" — two tenses that disagree for anyone on a time-limited status. An F-1 STEM
      // OPT candidate needs no sponsorship today and will need H-1B when OPT expires, so the
      // boolean answered the future-tense question "No": a false material attestation, submitted
      // at confidence 1.0. See docs/auto-apply-a5-live-run.md §4.1.
      //
      // NULLABLE ON PURPOSE, with no default. 'none' is not a safe default — it is precisely the
      // wrong guess for the population this exists to protect — and resolveSponsorshipNeed refuses
      // (holding the run for a human) rather than inventing a situation it cannot derive. The
      // legacy boolean is left in place: it still answers the present tense, and it is what the
      // derivation falls back to.
      id: "086_user_profile_sponsorship_need",
      sql: `
        ALTER TABLE user_profile ADD COLUMN sponsorship_need TEXT;
      `,
    },
    {
      // Per-company overrides for a `{company}`-templated custom answer (AF1).
      //
      // A separate column rather than a reserved key inside custom_answers, because buildAnswers
      // iterates that map's values and stringifies them: a nested object there would be typed into
      // a real employer's form as "[object Object]". Shape is {companyKey: {question: answer}}.
      id: "087_user_profile_answer_overrides",
      sql: `
        ALTER TABLE user_profile ADD COLUMN custom_answer_overrides TEXT NOT NULL DEFAULT '{}';
      `,
    },
    {
      // AF5's campaign record. Two facts a semi run already had in hand and threw away:
      //
      //   fields_discovered — the DENOMINATOR for discovery reliability. answers_json says what was
      //     resolved; without the count of what was FOUND, "12 fields filled" cannot be read as good
      //     or bad, and per-ATS discovery reliability is not computable at all.
      //   corrections_json — what the HUMAN changed after the resolver filled it. Each entry is
      //     either a resolver defect or a missing custom answer, which makes this the most valuable
      //     output of a semi run and the one thing nothing recorded.
      id: "088_apply_run_jobs_campaign_record",
      sql: `
        ALTER TABLE apply_run_jobs ADD COLUMN fields_discovered INTEGER;
        ALTER TABLE apply_run_jobs ADD COLUMN corrections_json TEXT;
      `,
    },
    {
      // profile_signal_suggestions.status was doing two independent jobs at once.
      //
      //   QUEUE      is this skill queued for the base-resume enhancement rewrite?
      //   ASSERTION  has the candidate said this is true of them?
      //
      // One column cannot hold two orthogonal facts, so every value crowded out the others.
      // 'claimed' (added by AG2) and 'applied' had to pretend they were not queued, and
      // syncSelectedSkillSuggestions — which reconciles the QUEUE — reconciled the whole column and
      // silently withdrew claims it had never heard of. That was patched by teaching it which
      // values to avoid, which is a guard around a modelling error rather than a fix for it. The
      // next value added would have needed the same guard, in every reader, forever.
      //
      // status is KEPT and still written, derived from the two new columns, so anything reading it
      // — an old process mid-deploy, a manual query — keeps working. It is lossy by construction:
      // a row that is both queued AND claimed can only say one of those, and assertion wins. That
      // lossiness is the whole reason for the split, so the new columns are the source of truth and
      // status is a legacy projection.
      id: "089_profile_signal_queue_and_assertion",
      sql: `
        ALTER TABLE profile_signal_suggestions ADD COLUMN queue_state TEXT NOT NULL DEFAULT 'none';
        ALTER TABLE profile_signal_suggestions ADD COLUMN assertion TEXT NOT NULL DEFAULT 'none';
        ALTER TABLE profile_signal_suggestions ADD COLUMN claimed_at INTEGER;
        UPDATE profile_signal_suggestions SET queue_state = 'queued' WHERE status = 'selected';
        UPDATE profile_signal_suggestions SET assertion = 'applied' WHERE status = 'applied';
        UPDATE profile_signal_suggestions
           SET assertion = 'claimed', claimed_at = selected_at, selected_at = NULL
         WHERE status = 'claimed';
        CREATE INDEX IF NOT EXISTS idx_profile_signal_suggestions_axes
          ON profile_signal_suggestions(profile_id, signal_kind, queue_state, assertion, frequency DESC);
      `,
    },
    {
      // AH1 root cause: signing out did not sign you out.
      //
      // /api/auth/logout revoked the presenting tab's auth-context token and RETURNED EARLY,
      // leaving the connect.sid session — the durable, 7-day, rolling credential — alive in
      // sessions.db. Any request without a token then re-authenticated off that cookie, and a new
      // tab sends no token because sessionStorage is per-tab and starts empty. That is the
      // long-standing "a hard refresh auto-authenticates" report: not a refresh bug, a sign-out
      // that only ever signed out one tab's fallback credential.
      //
      // Revoking the browser's tokens on sign-out means knowing WHICH browser a token belongs to,
      // so one browser profile signing out cannot revoke another's. session_sid is the connect.sid
      // the context was issued under.
      //
      // NULL session_sid means either a row predating this migration or a deliberately
      // session-less credential (the extension token, which the user revokes separately via
      // /api/auth/revoke-extension-token). Neither is swept by a browser sign-out — a sign-out
      // revokes the presented token plus its session siblings, never an unattributable row.
      id: "090_auth_context_session_binding",
      sql: `
        ALTER TABLE auth_contexts ADD COLUMN session_sid TEXT;
        CREATE INDEX IF NOT EXISTS idx_auth_contexts_session
          ON auth_contexts(session_sid, revoked_at);
      `,
    },
    {
      // AH5. Two columns, for the two halves of "say what happened".
      //
      // apply_run_jobs.blanks_json — every discovered field the run did NOT fill, with why
      //   (low_confidence / no_answer / unmatched / fill_failed). Read off the POST-FILL discovery
      //   pass, so it is the state of the form and not a gate's opinion of it. answers_json has
      //   always held the filled half with its provenance; the blank half had nowhere to live, so a
      //   run could say "Autofilled 7 fields" and hold for review with no way to learn which 7 or
      //   what was still empty. missingRequired existed but only inside an apply_job_logs event,
      //   which no surface reads.
      //
      // resumes.domain_profile_id — which job profile an artifact was generated under.
      //   processRunJob reuses any `resumes` row for (user, job), newest first, and that is the
      //   right instinct: regenerating work already done costs a model call and minutes of the
      //   candidate's time. But with no record of the profile it also reuses an artifact built for
      //   a DIFFERENT profile, and there was no way to tell. Stamping it makes "is this current?"
      //   a question the code can answer instead of assume. NULL means an artifact written before
      //   this migration, and the reuse rule treats that as unknown-but-usable rather than
      //   forcing a regeneration of every existing artifact.
      id: "091_fill_log_and_artifact_provenance",
      sql: `
        ALTER TABLE apply_run_jobs ADD COLUMN blanks_json TEXT;
        ALTER TABLE resumes ADD COLUMN domain_profile_id INTEGER;
        CREATE INDEX IF NOT EXISTS idx_resumes_currency
          ON resumes(user_id, job_id, domain_profile_id, updated_at DESC);
      `,
    },
    {
      // AI1. The summary section becomes a per-profile choice, and its default is OFF.
      //
      // WHY A COLUMN AND NOT A SETTINGS BLOB
      // domain_profiles has no settings JSON to extend — every preference on it is its own typed
      // column (seniority, target_titles, selected_*). A blob added for one boolean would be the
      // odd one out and the first place a later setting hid from a query.
      //
      // DEFAULT 0 CHANGES WHAT EXISTING USERS GET, ON PURPOSE, AND THE UI SAYS SO.
      // Every resume generated before this had a summary, so a default of 0 means the next resume
      // an existing candidate generates will not. Backfilling 1 for existing rows was the other
      // option and was rejected: it would leave two populations with different defaults and no way
      // to tell them apart, and the product decision is that a summary is opt-in for everyone.
      // The cost of the change is a section the candidate can turn back on in one click; the cost
      // of hiding it is a resume that silently differs from the last one they read. So the toggle
      // states in the UI that it changes the next generated resume, rather than leaving it found.
      id: "092_profile_summary_opt_in",
      sql: `
        ALTER TABLE domain_profiles ADD COLUMN include_summary INTEGER NOT NULL DEFAULT 0;
      `,
    },
  ];

  console.log("[boot] migrations: checking schema");
  const applied = new Set(
    db.prepare("SELECT id FROM schema_migrations").all().map(r => r.id)
  );
  let migrationCount = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(m.id);
      console.log(`[migrate] âœ“ ${m.id}`);
      migrationCount++;
    } catch(e) {
      console.error(`[migrate] âœ— FAILED ${m.id}:`, e.message);
      process.exit(1);
    }
  }
  console.log(`[boot] migrations complete (${migrationCount} applied)`);

// Populate migration 078's automation_tier for rows written before it existed. This is here
// rather than inside the migration because the derivation is JavaScript
// (services/jobs/automationTier.js) and re-expressing it as a SQL CASE would create the second
// copy of the mapping the stored column exists to avoid.
//
// NULL-only by default, so it is a no-op on every boot after the first and costs one indexed
// scan. It does NOT re-derive existing values: a mapping change needs
// `node scripts/recomputeAutomationTier.js --all`, which is the documented admin action, because
// silently rewriting stored tiers on every restart would hide when the mapping moved.
//
// Never fatal. A board whose tiers are NULL still works — jobQuery.js reads NULL as 'unknown' in
// both directions of the tier filter — so failing the boot over it would trade a degraded label
// for an outage.
try {
  const tierFill = backfillAutomationTier(db);
  if (tierFill.updated > 0) {
    console.log(`[boot] automation_tier backfilled: ${tierFill.updated} of ${tierFill.scanned} rows ` +
      `(${Object.entries(tierFill.byTier).map(([t, n]) => `${t}=${n}`).join(" ")})`);
  }
} catch (e) {
  console.error("[boot] automation_tier backfill failed (board falls back to 'unknown'):", e.message);
}

// Drain the out-of-process failure sink now that the database is known reachable. Anything the
// sink caught while it was NOT reachable is imported as source='sink_recovered', so coverage
// becomes complete again instead of permanently short by however many calls happened during the
// outage. Runs after migrations so the source column (077) exists; never fatal — a sink that
// cannot be drained is left in place for the next boot rather than discarded.
try {
  const drain = drainTrackingFailureSink(db);
  if (drain.drained || drain.failed || drain.corrupt) {
    console.warn(`[boot] tracking-failure sink drained: recovered=${drain.drained} ` +
      `failed=${drain.failed} corrupt=${drain.corrupt}` + (drain.error ? ` error=${drain.error}` : "") +
      " — these are model calls whose spend was NOT recorded at the time.");
  }
} catch (e) {
  console.error("[boot] tracking-failure sink drain failed:", e.message);
}
}

// Load layered prompt system at startup
console.log("[boot] loading prompts");
loadAllPrompts();
console.log("[boot] prompts loaded");

// â”€â”€ Backfill: split full_name into first_name / last_name â”€â”€â”€â”€â”€
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

// â”€â”€ Seed admin user â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Cache cleanup — removes scraped_jobs older than 7 days, then re-warms if empty
function runCacheCleanup() {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    const removed = db.prepare("DELETE FROM scraped_jobs WHERE scraped_at < ?").run(cutoff);
    if (removed.changes > 0) {
      console.log(`[Cache] Removed ${removed.changes} expired jobs`);
      // Also clean orphaned job_role_map entries
      db.prepare("DELETE FROM job_role_map WHERE job_id NOT IN (SELECT job_id FROM scraped_jobs)").run();
    }
    const remaining = db.prepare("SELECT COUNT(*) as n FROM scraped_jobs WHERE is_active = 1").get()?.n || 0;
    if (remaining === 0) {
      console.log("[Cache] Empty after cleanup — re-warming from ATS...");
      cacheJobs(db, ANTHROPIC_KEY ? anthropic : null).then(n => console.log(`[Cache] Re-warm complete: ${n} jobs`))
                   .catch(e => console.error("[Cache] Re-warm failed:", e.message));
    }
  } catch (e) {
    console.error("[Cache cleanup]", e.message);
  }
}

// â”€â”€ Anthropic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Guard: if ANTHROPIC_KEY is missing, log a clear warning at startup
// (endpoints that call Anthropic will return 500 with a descriptive error)
// Declared here (before the ATS cache warm below) so cacheJobs() can pass it through for
// background job-description enrichment (services/jobs/enrichJob.js) at every call site.
if (!ANTHROPIC_KEY) {
  console.error("[startup] WARNING: ANTHROPIC_KEY is not set in .env â€” PDF parsing and resume generation will fail.");
}
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// Warm job cache from ATS sources (non-blocking — runs after server starts)
{
  const scraped = db.prepare("SELECT COUNT(*) as n FROM scraped_jobs WHERE is_active = 1").get()?.n || 0;
  if (scraped === 0) {
    console.log("[boot] scraped_jobs empty — warming ATS cache...");
    cacheJobs(db, ANTHROPIC_KEY ? anthropic : null).then(n => {
      console.log(`[boot] ATS cache warm complete: ${n} jobs cached`);
    }).catch(err => {
      console.error("[boot] ATS cache warm failed:", err.message);
    });
  } else {
    console.log(`[boot] scraped_jobs: ${scraped} rows already cached`);
  }
  // Schedule daily cleanup
  setInterval(runCacheCleanup, 24 * 60 * 60 * 1000);
}

const adminExists = db.prepare("SELECT id FROM users WHERE username=?").get(ADMIN_USER);
if (!adminExists) {
  db.prepare("INSERT INTO users (username,password_hash,is_admin) VALUES (?,?,1)")
    .run(ADMIN_USER, hashPassword(ADMIN_PASSWORD));
}

// PRICING lives in shared/anthropicModels.js — see that file to update per-token costs.
// This module used to carry its own ANTHROPIC_PRICING table plus a calculateCost() that had
// ZERO callers: the live cost path is services/usageTracker.js. Two tables that nothing kept
// in sync is how the Haiku entry ended up holding Haiku 3.5's prices, so the dead copy is gone
// rather than duplicated a third time.
//
// Historical cost calculations still use the price at insert time (stored in
// usage_events.cost_usd), so changing pricing does not retroactively alter past records.

// â”€â”€ Multer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  preservePath: true,
});

// â”€â”€ ATS scoring system prompt (module-level, defined once) â”€â”€â”€â”€
const ATS_SYSTEM_PROMPT = `You are an ATS (Applicant Tracking System) scoring engine.

Score the provided resume against the provided job description.
Extract keywords ONLY from the job description text provided in this message.
Do not use prior knowledge, assumptions, or memory of other calls.
Every keyword in tier1_matched and tier1_missing must appear verbatim
in the job description text provided below.

ACTION VERB RULES â€” critical:
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
  "best_possible_score": <integer â€” highest achievable score given candidate background. Account for: cloud provider mismatches, domain gaps, missing certifications, seniority gaps>,
  "best_possible_reason": "<one sentence: specific gaps preventing higher score>",
  "verdict": "<one sentence overall assessment>"
}`;

// â”€â”€ Helpers (extracted to services/jobNormalization.js) â”€â”€â”€â”€â”€â”€â”€
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
    const msg = await callModel({
      anthropic, db, purpose: "classify_job", userId: SYSTEM_USER_ID,
      model: MODEL_HAIKU,
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

// â”€â”€ Company icon helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Scraping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Actor: harvestapi/linkedin-job-search
// Returns real LinkedIn job IDs â€” INSERT OR IGNORE keeps first-write wins.
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
  console.log(`[scrape] "${query}" â€” HarvestAPI (${profileTitles ? profileTitles.length + " profile titles" : "single query"})`);
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
    // noExternalApplyUrl (Easy Apply) is counted but NOT dropped â€” many valid roles (PM, etc.) use Easy Apply
    if (item.applyUrl) {
      const applyDomain = extractDomain(item.applyUrl);
      if (applyDomain && applyDomain.includes("linkedin.com")) { cntNoApply++; return false; }
    }
    // Post-scrape contract filter â€” catches what Apify's filter misses
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
     employment_type, domain_profile_id, collar, classification_confidence,
     fingerprint, sources_seen, req_uid, automation_tier)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const rejectJobStmt  = db.prepare(`
    INSERT OR REPLACE INTO rejected_jobs (job_id, title, company, source, reason, rejected_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const deleteScrapedStmt  = db.prepare(`DELETE FROM scraped_jobs WHERE job_id = ?`);
  const deleteRoleMapStmt  = db.prepare(`DELETE FROM job_role_map  WHERE job_id = ?`);

  const insertMany = db.transaction((jobs) => {
    let inserted = 0;
    jobs.forEach(item => {
      const jobId   = item.jobId; // always a real LinkedIn job ID â€” synthetic IDs were removed
      const hash    = jobHash(item);
      const yoe     = parseYearsExperience(item.description);
      const wt      = inferWorkType(
        (item.workTypeHint || '') + ' ' + (item.location || '') + ' ' + (item.description || '')
      );
      const empType = item.jobType || null;

      // ── Collar gate (blue-collar eject) ───────────────────────────────────
      const collarVerdict = unifiedClassifyJob(item.title || '', item.description || '', item.company || '');
      if (collarVerdict.collar === 'blue') {
        deleteScrapedStmt.run(jobId);
        deleteRoleMapStmt.run(jobId);
        rejectJobStmt.run(jobId, item.title || '', item.company || '', 'linkedin', 'blue_collar',
          Math.floor(Date.now() / 1000));
        return; // skip insert
      }
      if (collarVerdict.roleKey === null) {
        return; // white-ish but no signal → drop
      }
      // ──────────────────────────────────────────────────────────────────────

      // Cross-source dedup: collapse this posting into an existing higher-(or-equal-)
      // priority canonical row (e.g. a direct-ATS listing of the same role) if one exists.
      const dedup = reconcileFingerprint(db, {
        id: jobId, url: item.applyUrl || item.url || jobId,
        title: item.title, company: item.company, location: item.location || 'United States',
        source: 'LinkedIn',
        description: item.description || null,
        company_icon_url: item.companyLogoUrl || null,
        workplace_type: wt || null,
        posted_at: normalizePostedAt(item.postedAt, nowUnix),
      });
      if (dedup.action === 'fold') {
        return; // superseded by an existing canonical row for this role — no separate row written
      }
      const canonical = dedup.job;

      const result = insertJob.run(
        jobId,
        query.toLowerCase(),
        item.company,
        item.title,
        item._category || 'Other',
        item.location  || 'United States',
        wt,
        'LinkedIn',
        item.url        || null,
        item.applyUrl   || null,
        canonical.posted_at,
        canonical.description || null,
        item.descriptionHtml || null,
        ghostJobScoreNorm({ ...item, url: item.applyUrl || item.url }),
        yoe.min,          // years_experience (compat col â€” use min)
        yoe.min,
        yoe.max,
        yoe.raw,
        isReposted(item) ? 1 : 0,
        hash,
        nowUnix,
        'linkedin',
        item.salaryMin      || null,
        item.salaryMax      || null,
        item.salaryCurrency || null,
        item.applicantCount || null,
        canonical.company_icon_url || null,
        empType,
        domainProfileId,
        'white',
        collarVerdict.confidence || 0,
        dedup.fingerprint,
        dedup.sourcesSeen,
        dedup.reqUid,
        // Same (source, apply_url ?? url) contract every other writer uses. This is the one path
        // that actually populates apply_url, and it is the destination that decides the tier —
        // item.url is the LinkedIn posting page, item.applyUrl is where the candidate lands.
        deriveAutomationTier('LinkedIn', item.applyUrl || item.url),
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

  // â”€â”€ Conservative ingest-time classification for orphaned jobs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ ATS scoring for newly inserted jobs (D1) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Score new jobs against the user's base resume using Haiku.
  // Non-fatal â€” job is still inserted if scoring fails.
  if (userId) {
    enqueueAtsScoreWork(`scrape:${userId}:${query}`, async () => {
      try {
        const baseResumeRow = domainProfile
          ? getBaseResumeRecord(db, { userId, profileId: domainProfile.id })
          : null;
        const baseResumeText = baseResumeRow?.content;
        if (!baseResumeText) return; // No base resume â€” skip scoring
        const profileTitles = domainProfile ? (() => {
          try { return JSON.parse(domainProfile.target_titles || "[]"); } catch { return []; }
        })() : [];
        const simpleProfile = domainProfile
          ? loadOrCreateSimpleApplyProfile(db, { userId, profileId: domainProfile.id, roleTitles: profileTitles })
          : null;
        const runtimeBasis = buildRuntimeAtsBasis({
          resumeText: baseResumeRow?.enhanced_content || baseResumeText,
          signalProfile: simpleProfile,
          domainProfile,
        });

        // Find newly inserted jobs that have no ats_score yet
        const newlyInserted = classified.filter(item => {
          const row = db.prepare("SELECT ats_score FROM scraped_jobs WHERE job_id=?").get(item.jobId);
          return row && row.ats_score === null;
        });

        if (!newlyInserted.length) return;

        const updateAts = db.prepare(
          "UPDATE scraped_jobs SET ats_score=?, ats_report=? WHERE job_id=?"
        );

        let attempted = 0;
        let failed = 0;
        for (let i = 0; i < newlyInserted.length; i += 25) {
          const batch = newlyInserted.slice(i, i + 25);
          await Promise.all(batch.map(async item => {
            try {
              attempted++;
              const report = scoreAtsLocally({
                job: item,
                runtimeBasis,
              });
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
            } catch(e) {
              failed++;
              console.warn(`[scrape] local ATS score failed for ${item.jobId}:`, e.message);
            }
          }));
        }
        if (scrapeParams.threadId) {
          logSearchThread(scrapeParams.threadId, "ats_enrichment", {
            candidateCount: newlyInserted.length,
            attempted,
            failed,
            scorer: LOCAL_ATS_SOURCE,
            status: "complete",
          });
        }
      } catch(e) {
        console.warn("[scrape] local ATS batch scoring failed:", e.message);
      }
    });
  }

  // â”€â”€ Async clearbit icon fallback (non-blocking, only for jobs without a logo) â”€â”€
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
  console.log(`[scrape] âœ“ "${query}" â€” ${inserted} inserted, ${classified.length} classified, ${eligible.length} passed filter of ${combined.length} total`);
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

// â”€â”€ Job expiry cleanup â€” runs at startup and daily at 03:00 â”€â”€â”€â”€â”€â”€
// Extracts into a named function so it can be called at startup (to
// catch any window missed if the server was down during the cron time)
// and also scheduled daily.
function runExpiredJobsCleanup() {
  const cutoff = Math.floor(Date.now()/1000) - 7*24*60*60;

  // STARRED ROWS ARE RETIRED, NEVER REMOVED.
  //
  // This DELETE exempted `applied = 1` and nothing else, so a job the user had explicitly saved —
  // or imported, since importJob.js stars every import for its importer — was hard-deleted seven
  // days later, and the cascade below then took its user_jobs star with it. The row did not become
  // inactive, it stopped existing: no is_active flag to inspect, no record that it had ever been
  // there, and nothing for the Saved tab to show. Observed on the local board (cleanup_log id 34):
  // 35 jobs and 35 user_jobs rows gone in one pass.
  //
  // "I saved this" is at least as strong a statement of intent as "I applied to this", and the whole
  // point of saving a posting is that it is still there tomorrow. So a starred row expires as a
  // LISTING — is_active = 0, out of discovery, which is true, it has not been re-seen in seven days
  // — while the row itself survives.
  //
  // Deliberately NOT extended to the un-starred majority: that stays a hard DELETE. Retiring
  // everything would grow scraped_jobs without bound for no one's benefit, and the reason to keep a
  // row is that somebody asked for it.
  //
  // Applied rows are untouched by BOTH statements, exactly as before — they stay active and present.
  const retiredStarred = db.prepare(`
    UPDATE scraped_jobs SET is_active = 0
    WHERE scraped_at < ? AND is_active = 1
      AND job_id IN     (SELECT DISTINCT job_id FROM user_jobs WHERE starred = 1)
      AND job_id NOT IN (SELECT DISTINCT job_id FROM user_jobs WHERE applied = 1)
  `).run(cutoff);

  // Delete jobs older than 7 days based on when they entered our DB.
  // Applied and starred jobs are exempt — see above.
  //
  // The cascades below key off `job_id NOT IN (SELECT job_id FROM scraped_jobs)`, i.e. on the row
  // having actually gone. A retired-but-present row therefore keeps its job_role_map entry, its
  // star, its views and its resumes with no extra guard needed — which is the reason to retire it
  // rather than delete it.
  const deletedJobs = db.prepare(`
    DELETE FROM scraped_jobs
    WHERE scraped_at < ?
    AND job_id NOT IN (
      SELECT DISTINCT job_id FROM user_jobs WHERE applied = 1
    )
    AND job_id NOT IN (
      SELECT DISTINCT job_id FROM user_jobs WHERE starred = 1
    )
  `).run(cutoff);

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
    // Counted separately from jobs_deleted on purpose: these rows are still here. Folding them into
    // the delete count would report a removal that did not happen, and this log is the only record
    // of what a cleanup pass did.
    starredRetired: retiredStarred.changes,
  });
  db.prepare(
    "INSERT INTO cleanup_log (jobs_deleted, orphans_cleaned, details) VALUES (?,?,?)"
  ).run(deletedJobs.changes, orphans, details);

  console.log(`[cleanup] Expired ${deletedJobs.changes} jobs (by DB age), retired ${retiredStarred.changes} starred jobs (kept, is_active=0), pruned ${orphans} orphaned rows`);
}

// â”€â”€ Cron: daily backup 02:00, re-scrape 07:00, cleanup 03:00 â”€â”€
cron.schedule("0 3 * * *", runExpiredJobsCleanup);

// Refresh ATS job cache daily at 04:00 ET
cron.schedule("0 4 * * *", async () => {
  console.log('[Cron] Daily ATS cache refresh starting...');
  try {
    const count = await cacheJobs(db, ANTHROPIC_KEY ? anthropic : null);
    console.log('[Cron] Daily ATS cache refresh complete —', count, 'jobs cached');
  } catch(e) {
    console.error('[Cron] ATS cache refresh error:', e.message);
  }
  // Jobo feed sync — cron-only (never on boot/restart) so it never burns wallet credits just
  // because the server restarted. Runs after the ATS refresh, sequentially, in the same tick.
  try {
    const jobo = await cacheJoboFeed(db, ANTHROPIC_KEY ? anthropic : null);
    // A provider that never ran must never again read as a healthy empty sync. The old line
    // logged "complete — 0 jobs cached" for an unconfigured key, a hard failure, and a genuine
    // no-op alike, which is why Jobo's absence went undetected.
    if (jobo.status === 'skipped_unconfigured') {
      console.error('[Cron] Jobo feed sync SKIPPED — JOBO_API_KEY is not set. The provider did NOT run; this is NOT a zero-result sync.');
    } else if (jobo.status === 'failed') {
      console.error(`[Cron] Jobo feed sync FAILED (${jobo.error}) — watermark not advanced; ${jobo.cached} cached before the error`);
    } else {
      console.log(
        `[Cron] Jobo feed sync complete (${jobo.mode}) — fetched ${jobo.fetched}, cached ${jobo.cached}, ` +
        `unchanged ${jobo.unchanged}, merged ${jobo.merged}, ejected ${jobo.ejected}, dropped ${jobo.dropped}, ` +
        `failed ${jobo.failed}, expired ${jobo.expired}`
      );
      // The specific blind spot that hid Jobo's real behaviour: rows CAN be fetched and then all
      // folded into ATS duplicates or dropped by the classifier, writing nothing. That is a very
      // different state from "the feed had nothing for us", and both used to print as 0.
      if (jobo.fetched && !jobo.cached) {
        console.warn(
          `[Cron] Jobo returned ${jobo.fetched} jobs but cached NONE — all were merged into existing ` +
          `rows (${jobo.merged}), dropped as unclassifiable (${jobo.dropped}), ejected as blue-collar ` +
          `(${jobo.ejected}) or malformed (${jobo.failed}). No source='jobo' rows will exist.`
        );
      }
    }
  } catch(e) {
    console.error('[Cron] Jobo feed sync error:', e.message);
  }
  // Company KB rollups (Tasks 9.5/9.7) — reuse this same cron tick, no new scheduler. Both are
  // read-only aggregations over scraped_jobs/its enrichment columns; org_unit_raw fills in via
  // runEnrichment's own background pass (fired above, inside cacheJobs/cacheJoboFeed), which can
  // lag behind same-tick crawls — the org rollup just sees whatever's enriched as of now and
  // picks up newly-enriched rows on the next day's run (an existing characteristic of the
  // enrichment pipeline, not something new).
  try {
    runOrgLayerRollup(db);
  } catch(e) {
    console.error('[Cron] Org layer rollup error:', e.message);
  }
  try {
    runHiringSignalsRollup(db);
  } catch(e) {
    console.error('[Cron] Hiring signals rollup error:', e.message);
  }
}, { timezone: 'America/New_York' });
console.log('[Cron] Daily ATS cache refresh scheduled: 04:00 ET');

cron.schedule("0 2 * * *", () => {
  try { createBackup("auto-daily"); }
  catch(e) { console.error("[backup-cron]", e.message); }
});

// The 07:00 daily re-scrape cron was removed here (§5.12). It picked what to re-crawl from the
// most recent `user_job_searches` row, and that table has ZERO writers anywhere in the repo —
// every remaining reference is its CREATE TABLE, two legacy migration backfills, one admin
// read-only view, and the cron's own SELECT. So `if (!last) return` fired on every single tick
// and the crawl could never run. Dead by data flow, not merely by absent callers, which is why
// it survived earlier caller-grep passes.
//
// `scrapeJobs` itself is deliberately KEPT: POST /api/admin/db/force-scrape still reaches it and
// it is still a working HarvestAPI crawl. Removing that is a product decision, not cleanup.
// See docs/PIPELINE_DIAGNOSIS.md §5.12.

// â”€â”€ Prompt injection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// domainProfile is the active domain_profiles row (or null).
// When supplied, profile keywords/verbs/tools are injected as Tier 1 signal.
function buildRuntimeInputs(profile, job, resumeText, mode, employers, domainProfile = null, claims = null) {
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

  // AF2. The summary is required to state total years, and before this the ONLY number in context
  // asking for a quantity was the JD's own "8+ years required" — so the prompt was being asked for
  // a figure while being shown nothing but the employer's demand. The profile's own figure is the
  // authority; when it is unset the base resume is, and the prompt is told so explicitly rather
  // than left to infer a ceiling.
  const profileYears = Number(profile?.years_of_experience);
  const yearsBlock = Number.isFinite(profileYears) && profileYears > 0
    ? `**Candidate years of experience (AUTHORITATIVE — the JD may not change this):** ${profileYears}\n`
    : `**Candidate years of experience:** not stated — derive from the base resume dates only, never from the JD\n`;

  // Domain profile block â€” injected when user has an active profile
  //
  // THE SENIORITY LINE CHANGED MEANING, ON PURPOSE.
  // It used to read "Seniority the user is TARGETING (an aspiration, not a level to claim)", which
  // matched a guard that took the BASE RESUME's wording as the only authority on level. Most base
  // resumes never write a level down, so that combination refused every seniority word in the
  // output — a candidate who had chosen "Senior" in their own profile could not have "Senior" on
  // their resume. The level is theirs to declare, so the prompt now says so, and the guard's
  // ceiling is the declaration. What neither permits is going ABOVE it because a JD asked.
  let domainProfileBlock = "";
  if (domainProfile) {
    const kw    = JSON.parse(domainProfile.selected_keywords || "[]").join(", ");
    const tools = JSON.parse(domainProfile.selected_tools    || "[]").join(", ");
    const verbs = JSON.parse(domainProfile.selected_verbs    || "[]").join(", ");
    domainProfileBlock = `
**User domain profile:** ${domainProfile.profile_name}
**Seniority the candidate states they are (their own declaration — you may use it, and may not exceed it):** ${domainProfile.seniority}
**Profile keywords:** ${kw || "â€”"}
**Profile tools:** ${tools || "â€”"}
**Profile action verbs:** ${verbs || "â€”"}
`;
  }

  // AG2. Terms the CANDIDATE has claimed from an ATS report — "yes, I have this".
  //
  // These are candidate-supplied facts, and the distinction from the block above matters: profile
  // keywords are a targeting preference, whereas a claim is an assertion about the person, made by
  // the person, which they will have to defend at interview. So they are named as such.
  //
  // The qualifier is not decoration. A claimed skill says the candidate HAS the skill; it says
  // nothing about where they used it, for how long, or to what result — and a model handed a bare
  // list will happily invent a bullet that supplies all three. The base resume remains the only
  // source for what they actually did, which is the same rule §7 and the AF2 years guard enforce.
  //
  // THE TITLE CARVE-OUT IS LOAD-BEARING, AND WAS ADDED AFTER MEASURING.
  // The first version of this block said the claims "license WORDING, never HISTORY". Against a JD
  // titled "Senior Platform Engineer", 6 of 8 real generations then put SENIOR PLATFORM ENGINEER in
  // the header tagline of a candidate whose base resume supports no seniority at all — and the AF2
  // guard refused all six. The same prompt with this block removed did it 0 times in 6. "Wording"
  // was read as licence to adopt the JD's language generally, including its title. So the scope is
  // now stated as skills and verbs, and titles are ruled out by name.
  let claimsBlock = "";
  const claimedSkills = (claims?.skills || []).join(", ");
  const claimedVerbs = (claims?.actionVerbs || []).join(", ");
  if (claimedSkills || claimedVerbs) {
    claimsBlock = `
**Skills the CANDIDATE has claimed (candidate-supplied — they assert these are true of them):** ${claimedSkills || "—"}
**Action verbs the CANDIDATE has claimed:** ${claimedVerbs || "—"}
**How to use the claims above:** they are SKILLS AND VERBS ONLY. They may change which technologies
a bullet names and which verb opens it, where the base resume already supports the work being
described. They are NOT a title, a level or a headline: never change the candidate's tagline, role
titles or seniority because of a claim — those come from the base resume alone. You may NOT invent
an employer, a project, a duration, a metric or a responsibility to justify a claim, and you may
NOT add a claimed term to a role that did not involve it. A claim the base resume cannot carry is
simply not used.
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
${yearsBlock}${employerBlock}${domainProfileBlock}${claimsBlock}
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

// â”€â”€ PDF generation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// CURRENT: @sparticuz/chromium + puppeteer-core
// Lightweight Chromium binary, single Railway service.
// Per-call RAM spike: ~70MB. Safe for low-to-medium traffic.
//
// â”€â”€ FUTURE MIGRATION PATH â†’ Gotenberg â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// When scaling to SaaS (concurrent PDF exports, 100+ users):
// Gotenberg runs Chromium as a persistent Docker sidecar â€” zero
// per-call RAM spike, handles concurrency natively.
//
// Migration steps (when ready):
//   1. In Railway: "+ New Service" â†’ Docker Image â†’ gotenberg/gotenberg:8
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
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
        top:    "0",
        bottom: "0",
        left:   "0",
        right:  "0",
      },
    });
    if (!pdf || pdf.length === 0) throw new Error("PDF generation produced empty output");
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// â”€â”€ Field normalisers (server-side, mirrors client normalisers) â”€â”€
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

// â”€â”€ Autofill payload builder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * @param {object} profile  the user_profile row
 * @param {string} mode     "APPLY" | "CUSTOM_SAMPLER"
 * @param {string=} company the employer this payload is for. OPTIONAL, and its absence is
 *   meaningful rather than a default: `{company}`-templated custom answers are DROPPED when the
 *   employer is unknown (the gate packet's profile-only case), because expanding a template
 *   against nothing would misstate the question that was asked. See services/customAnswers.js.
 */
function buildAutofillPayload(profile, mode, company = null) {
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
    // The tri-state the resolver answers sponsorship questions FROM. The yes/no strings below are
    // kept for the extension's autofill payload and for non-sponsorship consumers, but buildAnswers
    // deliberately ignores them for sponsorship-class fields: a stored answer cannot be right for
    // both "do you require sponsorship now" and "now or in the future". See
    // docs/auto-apply-a5-live-run.md §4.1 and resolveSponsorshipNeed.
    sponsorship_need:resolveSponsorshipNeed(profile),
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
      // No fallback to github/linkedin. A "Website" field receiving the candidate's GitHub — or
      // worse, their LinkedIn — is wrong information submitted to an employer, and it made this
      // field_map entry contradict handler_map's 'website', which was always strict. Since
      // handler_map is consulted first, the fallback only ever fired when website_url was EMPTY,
      // i.e. exactly when there was nothing true to say. Blank is the honest answer; the
      // completeness gate holds the run if the form requires it.
      website:normaliseUrl(profile?.website_url||""),
      portfolio:normaliseUrl(profile?.portfolio_url||""),
      gender:profile?.gender||"", ethnicity:profile?.ethnicity||"", race:profile?.ethnicity||"",
      veteran_status:profile?.veteran_status||"", veteranStatus:profile?.veteran_status||"",
      disability_status:profile?.disability_status||"", disabilityStatus:profile?.disability_status||"",
      visa_type:profile?.visa_type||"", visaType:profile?.visa_type||"",
      work_authorization:profile?.work_auth||"", workAuthorization:profile?.work_auth||"",
      requires_sponsorship:profile?.requires_sponsorship?"Yes":"No",
      sponsorship:profile?.requires_sponsorship?"Yes":"No",
      clearance_level:profile?.clearance_level||"", clearanceLevel:profile?.clearance_level||"",
      has_clearance:profile?.has_clearance?"Yes":"No",
      // New fields
      desired_salary:profile?.desired_salary ? String(profile.desired_salary) : "",
      available_start_date:profile?.available_start_date||"",
      willing_to_relocate:profile?.willing_to_relocate ? "Yes" : "No",
      highest_degree:profile?.highest_degree||"",
      field_of_study:profile?.field_of_study||"",
      university:profile?.university||"",
      graduation_year:profile?.graduation_year ? String(profile.graduation_year) : "",
      current_job_title:profile?.current_job_title||"",
      current_company:profile?.current_company||"",
      years_of_experience:profile?.years_of_experience ? String(profile.years_of_experience) : "",
    },
    handler_map:{
      'first-name': firstName,
      'last-name': lastName,
      'full-name': profile?.full_name || '',
      'email': profile?.email || '',
      'phone': phone,
      'linkedin': linkedinUrl,
      'github': githubUrl,
      'website': normaliseUrl(profile?.website_url || ''),
      'portfolio': normaliseUrl(profile?.portfolio_url || ''),
      'address1': profile?.address_line1 || '',
      'address2': profile?.address_line2 || '',
      'city': city,
      'state': state,
      'zip': profile?.zip || '',
      'country': profile?.country || 'United States',
      'location': loc,
      'sponsorship': profile?.requires_sponsorship ? 'Yes' : 'No',
      'work-auth': profile?.work_auth || '',
      'gender': profile?.gender || '',
      'ethnicity': profile?.ethnicity || '',
      'veteran': profile?.veteran_status || '',
      'disability': profile?.disability_status || '',
      'salary': profile?.desired_salary ? String(profile.desired_salary) : '',
      'start-date': profile?.available_start_date || '',
      'relocate': profile?.willing_to_relocate ? 'Yes' : 'No',
      'degree': profile?.highest_degree || '',
      'field-of-study': profile?.field_of_study || '',
      'school': profile?.university || '',
      'grad-year': profile?.graduation_year ? String(profile.graduation_year) : '',
      'years-experience': profile?.years_of_experience ? String(profile.years_of_experience) : '',
      'current-title': profile?.current_job_title || '',
      'current-company': profile?.current_company || '',
    },
    // Resolved for THIS employer: templates expanded, per-company overrides applied, and motivation
    // templates withheld so the run holds on them instead of interpolating a company name into
    // borrowed enthusiasm. buildAnswers still receives nothing but literal question text, so its
    // exact-match tier is unchanged.
    custom_answers: effectiveCustomAnswers(readAnswerStore(profile), company),
    dropdown_map:{
      gender:   profile?.gender          ? [profile.gender]          : [],
      work_auth:profile?.work_auth       ? [profile.work_auth]        : [],
      clearance:profile?.clearance_level ? [profile.clearance_level]  : [],
    },
  };
}

// â”€â”€ Auth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const SQLiteStore = SQLiteStoreFactory(session);
// Same DATA_DIR as the main database: a throwaway boot must not share the real sessions.db, or the
// session-revocation assertions would be destroying the developer's own sessions.
const SStore = new SQLiteStore({ db:"sessions.db", dir:DATA_DIR });

passport.use(new LocalStrategy((username, password, done) => {
  const login = String(username || "").trim();
  const user = db.prepare(`
    SELECT u.*
    FROM users u
    LEFT JOIN user_profile up ON up.user_id = u.id
    WHERE LOWER(u.username) = LOWER(?)
       OR LOWER(up.email) = LOWER(?)
    LIMIT 1
  `).get(login, login);
  const passwordOk = user ? verifyPassword(password, user.password_hash) : false;
  if (!user || !passwordOk) {
    // TEMPORARY DIAGNOSTIC: remove after production login is confirmed stable.
    console.warn("[auth-login-debug] local login rejected", {
      hasIdentifier: !!login,
      matchedUser: !!user,
      passwordOk,
    });
    return done(null, false, { message:"Invalid credentials." });
  }
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
      // done(null, false) cleanly de-authenticates â€” Passport calls req.logout() internally.
      // done(new Error(...)) would propagate to the global error handler and return 500.
      console.warn(`[auth] deserializeUser: user id=${id} not found â€” session will be cleared`);
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
    done(null, false); // safe fallback â€” don't crash the request
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

// ── AUTH CONTEXT LIFETIME — AJ1 decision 6a ──────────────────────────────────────────────────
//
// TWO windows, not one, and they answer different questions.
//
//   IDLE       how long a token survives with NOBODY USING IT. Unchanged at 7 days, so an
//              abandoned token still dies in a week exactly as before.
//   ABSOLUTE   how long a token can live AT ALL, however active. New, and it is what makes the
//              renewal below safe: a stolen token cannot be kept alive forever by using it.
//
// WHY THIS CHANGED. Until now expires_at was set once at issue and never moved, so the idle window
// was really a HARD window: a user of a native mobile app — which, unlike a browser, has no rolling
// connect.sid cookie to fall back on — was signed out every seventh day no matter how much they
// used it. For the extension that is tolerable. For a phone it is the single worst thing an app
// can do, and it would have been discovered from a store review.
//
// WHY SLIDING RENEWAL RATHER THAN A REFRESH ENDPOINT. A refresh endpoint means a SECOND credential
// kind with its own rotation, replay and revocation story, and a second thing every one of the four
// clients has to implement correctly. Sliding renewal gets the same result by moving a column that
// bindAuthContext ALREADY WRITES on every request (last_seen_at) — no new endpoint, no new token
// kind, nothing for a client to do, and it applies to the extension and the browser too.
const AUTH_CONTEXT_IDLE_SECONDS = 7 * 24 * 60 * 60;        // 7 days without a request
const AUTH_CONTEXT_ABSOLUTE_SECONDS = 90 * 24 * 60 * 60;   // 90 days from issue, whatever happens

function issueAuthContext(userId, req, options = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  db.prepare("DELETE FROM auth_contexts WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(now - 86400);
  db.prepare(`
    INSERT INTO auth_contexts (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent, session_sid)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    authContextHash(token),
    userId,
    now,
    now,
    now + AUTH_CONTEXT_IDLE_SECONDS,
    options.userAgent || req.get("user-agent") || null,
    // The browser session this token belongs to, so signing out of THIS browser revokes this
    // browser's tokens and nobody else's. sessionLess:true is for the extension token, which is
    // deliberately not tied to a browser session and is revoked on its own endpoint.
    options.sessionLess ? null : (req.sessionID || null),
  );
  return token;
}

// Revoke every credential belonging to ONE browser: the token the request presented, plus every
// other auth context issued under the same connect.sid. A different browser profile has a
// different sid and is untouched, which is the whole point of keying on it.
//
// Deliberately does NOT sweep session_sid IS NULL rows: those are extension tokens and pre-090
// rows, and revoking on a NULL match would revoke every such row for every browser at once.
function revokeBrowserAuthContexts(sid, presentedToken) {
  const now = Math.floor(Date.now() / 1000);
  if (presentedToken) {
    db.prepare("UPDATE auth_contexts SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL")
      .run(now, authContextHash(presentedToken));
  }
  if (!sid) return;
  db.prepare("UPDATE auth_contexts SET revoked_at=? WHERE session_sid=? AND revoked_at IS NULL")
    .run(now, sid);
}

// Revoke EVERYTHING for a user, across every browser and the extension: every auth context, and
// every cookie session in the session store that deserialises to them.
//
// A password change is the one moment a user is telling us a credential may be compromised, so
// leaving a 7-day rolling cookie and a fleet of tokens alive is the opposite of what they asked
// for.
//
// The store's public all() is unusable here: connect-sqlite3 returns `rows.map(r => JSON.parse(
// r.sess))` and so DROPS the sid, which is the one thing destroy() needs. So the sid comes from a
// SELECT on the store's own connection — deliberately not a second better-sqlite3 handle on
// sessions.db, which connect-sqlite3 opens without WAL and would give us SQLITE_BUSY writes.
// Deletion still goes through the store's destroy() so the table name stays its business.
//
// AWAITED by its callers, deliberately. The token revocation below is a synchronous better-sqlite3
// write, but the cookie sweep runs on the store's async node-sqlite3 connection — so returning
// before it finished would answer "your password is changed" while the old session was still, for a
// few milliseconds, a working credential. On this path that window is the whole point of the call.
function revokeAllUserSessions(userId, reason) {
  const now = Math.floor(Date.now() / 1000);
  const revoked = db.prepare(
    "UPDATE auth_contexts SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL"
  ).run(now, userId).changes;
  return new Promise((resolve) => {
    const done = (destroyed) => {
      console.log(`[auth] revoked all credentials for user ${userId} (${reason}): ${revoked} tokens, ${destroyed} cookie sessions`);
      resolve({ revokedTokens: revoked, destroyedSessions: destroyed });
    };
    try {
      SStore.db.all(`SELECT sid, sess FROM ${SStore.table}`, (err, rows) => {
        if (err || !Array.isArray(rows)) {
          console.warn("[auth] session sweep query failed:", err?.message || "no rows");
          return done(0);
        }
        const mine = rows.filter(row => {
          try { return Number(JSON.parse(row.sess)?.passport?.user) === Number(userId); }
          catch { return false; }
        });
        if (!mine.length) return done(0);
        let outstanding = mine.length;
        for (const row of mine) {
          SStore.destroy(row.sid, () => { if (--outstanding === 0) done(mine.length); });
        }
      });
    } catch(e) {
      console.warn("[auth] session sweep failed:", e.message);
      done(0);
    }
  });
}

function getRequestAuthContextToken(req) {
  const header = req.get("x-rm-auth-context");
  const authHeader = req.get("authorization") || "";
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1] || null;
  return header || bearer || req.query?.authContext || null;
}

function requestCookieNames(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map(part => part.trim().split("=")[0])
    .filter(Boolean);
}

function requestCookieMap(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const idx = part.indexOf("=");
        return idx === -1 ? [part, ""] : [part.slice(0, idx), part.slice(idx + 1)];
      })
  );
}

function bindAuthContext(req, _res, next) {
  const token = getRequestAuthContextToken(req);
  if (!token) return next();
  try {
    const now = Math.floor(Date.now() / 1000);
    const row = db.prepare(`
      SELECT ac.user_id, ac.created_at, ac.expires_at
      FROM auth_contexts ac
      WHERE ac.token_hash = ?
        AND ac.revoked_at IS NULL
        AND ac.expires_at > ?
      LIMIT 1
    `).get(authContextHash(token), now);
    if (!row) {
      // Token was sent but is expired, revoked, or unknown.
      // Log so we can diagnose "session expired" reports without leaking the token itself.
      console.warn(`[auth-context] token not found/expired â€” ${req.method} ${req.path} | ua:${(req.get("user-agent")||"").slice(0,60)}`);
      return next();
    }
    const user = hydrateAuthUser(row.user_id);
    if (!user) {
      console.warn(`[auth-context] token valid but user_id=${row.user_id} not in users table`);
      return next();
    }
    req.user = user;
    req.authContextToken = token;
    // AJ1 6a — SLIDING RENEWAL, in the write that was already happening.
    //
    // The new expiry is the idle window from now, CLAMPED to the absolute window from issue. The
    // clamp is the whole safety property: without it "active" would mean "immortal", and a leaked
    // token in the hands of anything that polls would never expire.
    //
    // Guarded by `> expires_at` so this only ever moves the deadline FORWARD. A clock skew or a
    // token already past its absolute cap can therefore shorten nothing — Math.min could otherwise
    // hand back a value BEHIND the stored one and quietly expire a live session early, which would
    // be a worse bug than the one this fixes.
    const slidTo = Math.min(now + AUTH_CONTEXT_IDLE_SECONDS,
                            (row.created_at || now) + AUTH_CONTEXT_ABSOLUTE_SECONDS);
    if (slidTo > row.expires_at) {
      db.prepare("UPDATE auth_contexts SET last_seen_at=?, expires_at=? WHERE token_hash=?")
        .run(now, slidTo, authContextHash(token));
    } else {
      db.prepare("UPDATE auth_contexts SET last_seen_at=? WHERE token_hash=?").run(now, authContextHash(token));
    }
  } catch(e) {
    console.warn("[auth-context] bind failed:", e.message);
  }
  next();
}

function requireAuth(req, res, next) {
  // TEMPORARY DIAGNOSTIC: remove after Railway session-cookie issue is resolved.
  const debugCookies = req.cookies || requestCookieMap(req);
  console.log("[auth-debug]", {
    env: process.env.NODE_ENV,
    hasCookie: !!req.cookies?.token || !!debugCookies["connect.sid"],
    cookieKeys: Object.keys(debugCookies || {}),
    hasAuthHeader: !!req.headers?.authorization,
    secure: req.secure,
    protocol: req.protocol,
  });
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

function envOrigin(value) {
  try { return value ? new URL(value).origin : ""; }
  catch { return ""; }
}

const APP_BASE_ORIGIN = envOrigin(process.env.APP_BASE_URL);
const FRONTEND_ORIGIN = envOrigin(process.env.FRONTEND_URL) || APP_BASE_ORIGIN;
const ALLOWED_CORS_ORIGINS = new Set([APP_BASE_ORIGIN, FRONTEND_ORIGIN].filter(Boolean));
const CROSS_ORIGIN_FRONTEND = APP_BASE_ORIGIN && FRONTEND_ORIGIN && APP_BASE_ORIGIN !== FRONTEND_ORIGIN;
if (IS_PRODUCTION && !ALLOWED_CORS_ORIGINS.size) {
  console.warn("[auth] APP_BASE_URL or FRONTEND_URL should be set in production for credentialed CORS");
}

function corsOrigin(origin, callback) {
  if (!origin) return callback(null, true);
  if (!IS_PRODUCTION) return callback(null, true);
  if (ALLOWED_CORS_ORIGINS.has(origin)) return callback(null, true);
  return callback(null, false);
}

function corsOriginExtension(origin, callback) {
  if (!origin) return callback(null, true);
  if (!IS_PRODUCTION) return callback(null, true);
  if (ALLOWED_CORS_ORIGINS.has(origin)) return callback(null, true);
  if (/^chrome-extension:\/\//.test(origin)) return callback(null, true);
  return callback(null, false);
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

function providerColumnFor(provider) {
  if (provider === "linkedin") return "linkedin_auth_id";
  if (provider === "github") return "github_auth_id";
  return "google_auth_id";
}

function findUserByAuthProvider(provider, providerUserId, email, { allowEmailMatch = true } = {}) {
  const providerColumn = providerColumnFor(provider);
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

function profileParts(displayName) {
  const parts = String(displayName || "").split(/\s+/).filter(Boolean);
  return {
    first: parts[0] || null,
    last: parts.length > 1 ? parts[parts.length - 1] : null,
  };
}

async function findOrCreateOAuthUser({ provider, providerId, email, name, emailVerified = undefined, picture = null, tokenSet = null, linkUserId = null }) {
  const providerColumn = providerColumnFor(provider);
  const providerUserId = String(providerId || "").trim();
  const emailForStorage = String(email || "").trim().toLowerCase() || null;
  const displayName = String(name || emailForStorage || provider).trim();
  const emailForMatch = emailVerified === false ? null : emailForStorage;
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
      const username = makeUniqueUsername(emailForStorage || displayName || provider);
      const password = hashPassword(crypto.randomBytes(24).toString("base64url"));
      db.prepare(`INSERT INTO users (username,password_hash,is_admin,apply_mode,plan_tier,${providerColumn}) VALUES (?,?,0,'SIMPLE','BASIC',?)`)
        .run(username, password, providerUserId);
      user = db.prepare("SELECT * FROM users WHERE username=?").get(username);
      const { first, last } = profileParts(displayName);
      db.prepare(`
        INSERT OR IGNORE INTO user_profile (user_id, full_name, first_name, last_name, email)
        VALUES (?, ?, ?, ?, ?)
      `).run(user.id, displayName || null, first, last, emailForStorage);
      created = true;
    } else if (user[providerColumn] !== providerUserId) {
      db.prepare(`UPDATE users SET ${providerColumn}=? WHERE id=?`).run(providerUserId, user.id);
      user = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
      linked = true;
    }
  }

  if (emailForStorage) {
    db.prepare("INSERT OR IGNORE INTO user_profile (user_id, email) VALUES (?, ?)").run(user.id, emailForStorage);
    db.prepare("UPDATE user_profile SET email=COALESCE(email, ?) WHERE user_id=?").run(emailForStorage, user.id);
  }

  const obtainedAt = Math.floor(Date.now() / 1000);
  const expiresAt = tokenSet?.expires_in ? obtainedAt + Number(tokenSet.expires_in) : null;
  upsertAuthIntegration(user.id, provider, {
    providerUserId,
    email: emailForStorage,
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
    scopes: OAUTH_PROVIDER_CONFIG[provider]?.scopes || [],
    expiresAt,
    metadata: {
      oauth: true,
      emailVerified: emailVerified ?? null,
      picture: picture || null,
    },
  });

  return { user, created, linked };
}

function completeProviderAuth(provider, identity, { linkUserId = null, tokenSet = null } = {}) {
  return findOrCreateOAuthUser({
    provider,
    providerId: identity.providerUserId,
    email: identity.email,
    name: identity.displayName,
    emailVerified: identity.emailVerified,
    picture: identity.picture,
    tokenSet,
    linkUserId,
  });
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
  return cfg?.redirectUri || `${appBaseUrl(req)}/auth/${provider}/callback`;
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
  if (provider !== "github" && (!cfg.scopes?.includes("openid") || !cfg.scopes?.includes("email"))) warnings.push("openid_email_scopes_missing");
  const configured = missing.length === 0;
  const envPrefix = provider.toUpperCase();
  return {
    provider,
    configured,
    healthy: configured && warnings.length === 0,
    status: configured ? (warnings.length ? "configured_with_warnings" : "configured") : (missing.length === 3 ? "missing" : "partial"),
    missing,
    warnings,
    redirectUri: redirectUri || null,
    requiredEnv: [
      `${envPrefix}_CLIENT_ID`,
      `${envPrefix}_CLIENT_SECRET`,
      `${envPrefix}_CALLBACK_URL or APP_BASE_URL`,
    ],
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
  const displayName = String(claims.name || claims.login || [claims.given_name, claims.family_name].filter(Boolean).join(" ") || email || provider).trim();
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
    headers: { Authorization: `Bearer ${tokenSet.access_token}`, Accept: "application/json", "User-Agent": "resume-master" },
  });
  const claims = await infoResponse.json().catch(() => ({}));
  if (!infoResponse.ok) {
    const err = new Error(claims.error_description || claims.message || `${provider} userinfo lookup failed.`);
    err.status = 502;
    throw err;
  }
  if (provider === "github" && !claims.email && cfg.emailsUrl) {
    const emailResponse = await fetch(cfg.emailsUrl, {
      headers: { Authorization: `Bearer ${tokenSet.access_token}`, Accept: "application/json", "User-Agent": "resume-master" },
    });
    const emails = await emailResponse.json().catch(() => []);
    if (emailResponse.ok && Array.isArray(emails)) {
      const primary = emails.find(row => row?.primary && row?.verified) || emails.find(row => row?.verified) || emails[0];
      if (primary?.email) {
        claims.email = primary.email;
        claims.email_verified = !!primary.verified;
      }
    }
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

// assertUserOwns â€” use this when fetching a record by ID WITHOUT user_id in the
// WHERE clause, then verifying ownership. Returns the row on success; sends the
// appropriate error response and returns null if the check fails.
// NOTE: Most routes in this file use the safer pattern:
//   WHERE user_id=? AND id=?  â† returns null for both "not found" and "not yours"
// which leaks no information about whether the record exists. assertUserOwns is
// most useful for admin-adjacent lookups or any future route that must fetch a
// shared resource then check whether the caller may mutate it.
function assertUserOwns(row, userId, res) {
  if (!row) { res.status(404).json({ error:"Not found" }); return null; }
  if (row.user_id !== userId) { res.status(403).json({ error:"Forbidden" }); return null; }
  return row;
}

// Canonical role-key derivation â€” delegates to services/jobClassifier.js.
// To change the mapping logic, edit getRoleKeyForProfile() in that module.
function roleKeyForProfile(profile) {
  const family = String(profile?.role_family || "").trim().toLowerCase();
  const domain = String(profile?.domain    || "").trim().toLowerCase();
  // engineering_embedded_firmware is the only engineering sub-domain with a
  // strict, non-overlapping title set.  Use the domain itself as the role key
  // so firmware profiles get their own isolated bucket in job_role_map and
  // never share the broad "engineering" key with standard SWE profiles.
  // engineering_systems_low_level and engineering_specialist intentionally
  // stay on the shared "engineering" key â€” their title sets overlap too much
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
  `).get(activeRoleKey, userId, String(jobId));
  if (existing?.domain_profile_id) return existing.domain_profile_id;

  const activeProfile = db.prepare(`
    SELECT dp.*
    FROM domain_profiles dp
    JOIN job_role_map jrm ON jrm.role_key = LOWER(COALESCE(NULLIF(dp.role_family, ''), dp.domain))
    JOIN scraped_jobs sj ON sj.job_id = jrm.job_id
    WHERE dp.user_id = ? AND dp.is_active = 1 AND jrm.job_id = ?
  `).get(userId, String(jobId));
  if (activeProfile?.id) return activeProfile.id;

  return null;
}

// â”€â”€ Express â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
// trust proxy: required for Railway/Render â€” without this, secure: true cookies
// fail behind their HTTPS reverse proxy and all sessions silently break.
app.set("trust proxy", 1);
app.use(cors({ origin:corsOrigin, credentials:true }));
app.use(express.json({ limit:"4mb" }));
// TODO: reduce cookie maxAge to 30 min + implement sliding renewal
// once useInactivityLogout (30-min idle) is deployed on the client.
app.use(session({
  store: SStore,
  secret:SESSION_SECRET, resave:false, saveUninitialized:false,
  // rolling:true resets the cookie maxAge on every response so active users never
  // hit session expiry mid-session (the 7-day clock restarts on each request).
  rolling: true,
  cookie:{
    httpOnly:true,
    secure:process.env.NODE_ENV === "production",
    sameSite:process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge:7*24*60*60*1000,
  },
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(bindAuthContext);

const CLIENT_DIST = path.join(__dirname,"client","dist");
app.use(express.static(CLIENT_DIST));

function xmlEscape(value) {
  return String(value).replace(/[<>&'"]/g, ch => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  }[ch]));
}

app.get("/sitemap.xml", (req, res) => {
  const base = appBaseUrl(req);
  const routes = [
    { path: "/", changefreq: "weekly", priority: "1.0" },
    { path: "/login", changefreq: "monthly", priority: "0.8" },
    { path: "/features", changefreq: "monthly", priority: "0.6" },
    { path: "/pricing", changefreq: "monthly", priority: "0.6" },
    { path: "/about", changefreq: "monthly", priority: "0.5" },
    { path: "/contact", changefreq: "monthly", priority: "0.5" },
  ];
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes.map(route => `  <url>
    <loc>${xmlEscape(`${base}${route.path === "/" ? "" : route.path}`)}</loc>
    <changefreq>${route.changefreq}</changefreq>
    <priority>${route.priority}</priority>
  </url>`).join("\n")}
</urlset>`;
  res.type("application/xml").send(body);
});

app.get("/robots.txt", (req, res) => {
  const base = appBaseUrl(req);
  res.type("text/plain").send([
    "User-agent: *",
    "Disallow: /api/",
    "Disallow: /jobs",
    "Disallow: /profile",
    "Allow: /",
    "Allow: /login",
    `Sitemap: ${base}/sitemap.xml`,
    "",
  ].join("\n"));
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// AUTH
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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

app.get(["/api/auth/oauth/:provider/start", "/auth/:provider"], (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  if (!OAUTH_PROVIDERS.includes(provider)) return res.status(400).json({ error: "Unsupported auth provider" });
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

app.get(["/api/auth/oauth/:provider/callback", "/auth/:provider/callback"], async (req, res, next) => {
  const provider = String(req.params.provider || "").toLowerCase();
  const state = String(req.query?.state || "");
  const code = String(req.query?.code || "");
  const stored = req.session.oauthStates?.[state];
  const fail = (message, returnTo = stored?.mode === "link" ? stored.returnTo : "/login") =>
    res.redirect(oauthReturnUrl(req, returnTo, { oauthError: message, oauthProvider: provider }));

  if (!OAUTH_PROVIDERS.includes(provider)) return fail("Unsupported auth provider.");
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
    const { user, created, linked } = await completeProviderAuth(provider, identity, {
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

app.post("/api/auth/provider/:provider", async (req, res, next) => {
  const provider = String(req.params.provider || "").toLowerCase();
  if (!OAUTH_PROVIDERS.includes(provider)) return res.status(400).json({ error: "Unsupported auth provider" });
  const email = String(req.body?.email || req.body?.accountEmail || "").trim().toLowerCase() || null;
  const providerUserId = String(req.body?.providerUserId || req.body?.id || "").trim() || (email ? `${provider}:${email}` : null);
  const displayName = String(req.body?.displayName || req.body?.name || "").trim() || email || provider;
  if (!providerUserId && !email) return res.status(400).json({ error: "Provider identity or email required" });

  try {
    const { user, created, linked } = await completeProviderAuth(provider, {
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
        scopes: OAUTH_PROVIDER_CONFIG[provider]?.scopes || [],
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

app.post("/api/auth/password-reset/confirm", async (req, res) => {
  const result = consumePasswordReset(db, {
    token: req.body?.token,
    otp: req.body?.otp,
    password: req.body?.password,
  }, {
    pepper: PASSWORD_RESET_SECRET,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  // A password reset is a statement that the old credential may be compromised. Changing the hash
  // while leaving the 7-day rolling cookie and every issued token alive would have changed nothing
  // for whoever was already signed in.
  await revokeAllUserSessions(result.userId, "password_reset");
  res.json({ ok: true });
});

// Signing out signs out THIS BROWSER.
//
// The old handler revoked the presenting tab's token and returned early, so the connect.sid
// session survived. The cookie is the durable credential: it is what a reopened tab, a hard
// refresh, or any request with an empty sessionStorage authenticates with. Leaving it alive meant
// "Sign out" only ever discarded the fallback, and the next page load signed the user straight
// back in — for up to seven more days, because the session is rolling.
//
// There is no coherent middle ground here. The cookie is shared by every tab in the browser
// profile, so a sign-out either destroys it (and signs the profile's tabs out) or it does not
// (and signs nobody out). Signing out is a deliberate act at a machine, so it takes the machine:
// the cookie session, and every auth context issued under it.
//
// A DIFFERENT browser profile keeps its own cookie jar and its own sid, so it is unaffected —
// that is the guarantee that matters, not per-tab scoping within one profile.
app.post("/api/auth/logout", (req, res) => {
  const token = getRequestAuthContextToken(req);
  // req.logout() regenerates the session, so read the sid we are revoking against BEFORE it runs.
  const sid = req.sessionID;
  revokeBrowserAuthContexts(sid, token);
  req.logout(() => {
    // Destroy rather than leave the regenerated-but-empty session behind, so nothing survives
    // this request that could be replayed.
    req.session?.destroy?.(() => {
      res.clearCookie("connect.sid", {
        httpOnly:true,
        secure:process.env.NODE_ENV === "production",
        sameSite:process.env.NODE_ENV === "production" ? "none" : "lax",
      });
      res.json({ ok:true, scope:"browser" });
    });
  });
});

app.get("/api/auth/me", (req, res) =>
  req.isAuthenticated() || req.authContextToken
    ? res.json({ authenticated:true, user:publicUser(req.user) })
    : res.json({ authenticated:false })
);

app.get("/api/auth/extension-token", requireAuth, (req, res) => {
  // sessionLess: the extension is not a tab of this browser profile, so signing out of the
  // browser must not silently kill it. It has its own revoke endpoint below.
  const token = issueAuthContext(req.user.id, req, { userAgent: "resume-master-extension", sessionLess: true });
  res.json({ token });
});

app.post("/api/auth/revoke-extension-token", requireAuth, (req, res) => {
  db.prepare(`
    UPDATE auth_contexts
    SET revoked_at=unixepoch()
    WHERE user_id=? AND revoked_at IS NULL AND user_agent='resume-master-extension'
  `).run(req.user.id);
  res.json({ ok: true });
});

// ── AJ1 decision 6b — THE MOBILE CREDENTIAL ──────────────────────────────────────────────────
//
// A native app is not a tab. It keeps no cookie jar, so the connect.sid session that a browser
// falls back on does not exist for it, and the token IS the whole credential.
//
// THE DEFECT THIS AVOIDS. POST /api/auth/login issues a token bound to `req.sessionID`. For a
// cookie-less caller that sid is a throwaway the client will never present again, so the binding
// is meaningless — and worse than meaningless, because revokeBrowserAuthContexts() revokes every
// token sharing a sid. A phone's token would be filed under a session nobody can sign out of and
// nobody can audit. That is the same class of defect as a row written under the wrong
// domain_profile_id: self-consistent on both sides, and joined to the wrong thing.
//
// So mobile does what the extension does: signs in once to get a session-bound token, exchanges it
// HERE for a sessionLess one, and discards the first. sessionLess:true stores session_sid NULL,
// which revokeBrowserAuthContexts deliberately never sweeps.
//
// WHY A SECOND ENDPOINT RATHER THAN REUSING THE EXTENSION'S. The revoke below keys on user_agent,
// so a shared endpoint would mean "sign out my phone" also killing the extension, and vice versa.
// Two independent credentials must be independently revocable. The two handlers are deliberately
// near-identical rather than folded into one helper: test/authCredentialLifecycle.test.js asserts
// the extension's guarantees as source strings INSIDE its route block, and hiding them behind a
// shared helper would weaken a guard in order to save four lines.
app.get("/api/auth/mobile-token", requireAuth, (req, res) => {
  const token = issueAuthContext(req.user.id, req, { userAgent: "resume-master-mobile", sessionLess: true });
  res.json({ token, idleSeconds: AUTH_CONTEXT_IDLE_SECONDS, absoluteSeconds: AUTH_CONTEXT_ABSOLUTE_SECONDS });
});

app.post("/api/auth/revoke-mobile-token", requireAuth, (req, res) => {
  db.prepare(`
    UPDATE auth_contexts
    SET revoked_at=unixepoch()
    WHERE user_id=? AND revoked_at IS NULL AND user_agent='resume-master-mobile'
  `).run(req.user.id);
  res.json({ ok: true });
});

app.get("/api/auth/active-profile", requireAuth, (req, res) => {
  const activeProfile = getOrRepairActiveProfile(req.user.id);
  if (!activeProfile) return res.status(404).json({ error: "No active profile" });
  res.json({
    profileId: activeProfile.id,
    targetRole: activeProfile.profile_name || "",
    name: activeProfile.profile_name || "",
    location: activeProfile.location || "",
  });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// DOMAIN PROFILES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// /api/domain-profiles        â€” CRUD + activate
// /api/domain-profiles/metadata[/:domain]  â€” registry (no auth)
// /api/domain-profiles/generate-chips      â€” AI chip generation
app.use("/api/domain-profiles", requireAuth, createDomainProfilesRouter(db, anthropic, emitToUser));
app.use("/api/import", requireAuth, createImportJobRouter(db, anthropic));
app.use("/api/company-kb", requireAuth, createCompanyKbRouter(db, requireAdmin));
// RETIRED (E2). imported_jobs had exactly one writer — save-job, above — and zero rows. Its reading
// surface was a board panel promising that captured jobs "appear here", which they never did: the
// hotkey has always written to scraped_jobs. Converged captures are starred into user_jobs by
// importJob's attachImportToUser, so they now appear in the board's own "Saved" tab, which already
// queries starred=1. One populated surface instead of two, one of which was always empty.
app.all(/^\/api\/imported-jobs(\/.*)?$/, (_req, res) => {
  res.status(410).json({
    error: "Imported jobs have been merged into the main board. Captured jobs appear under Saved.",
  });
});

// FE-4 company view — aggregates technographics (Task 5) + org units (9.5) + hiring signals
// (9.7) into one read-only payload. Same auth tier as /api/company-kb (session only, no admin
// gate — these are all evidence-labeled reads, not ground truth).
app.get("/api/company/:company", requireAuth, (req, res) => {
  res.json(getCompanyProfile(db, req.params.company));
});

// FE-6 recruiter surface — candidate-claim consistency check. Reuses the 9.6 failsafe
// validator; advisory only (consistent / flagged / no_claim + evidence), never a verdict on
// the person. Stateless: resumeText is read from the request body and never persisted —
// no INSERT anywhere in this path.
app.post("/api/company/:company/consistency-check", requireAuth, (req, res) => {
  const { resumeText } = req.body || {};
  if (!resumeText || typeof resumeText !== "string") {
    return res.status(400).json({ error: "resumeText is required" });
  }
  res.json(checkCandidateConsistency(db, req.params.company, resumeText));
});

// ─── CHROME EXTENSION — save-job, RETIRED (E2) ───────────────────────────────
// The extension had two capture paths: this one wrote to imported_jobs keyed by dedupe_key, while
// the hotkey wrote to scraped_jobs keyed by req_uid. Same button-shaped promise, two destinations,
// two dedup identities — so a job captured both ways existed twice and neither copy knew about the
// other. They are now one path: /api/import/job into scraped_jobs, which is the BYO-1 reconciler and
// the only writer that participates in cross-source dedup (direct ATS > provider > aggregator >
// import).
//
// 410 rather than deletion, following the /api/scrape precedent: a caller that still exists learns
// what happened instead of getting an ambiguous 404. imported_jobs itself is left in place —
// migrations here are additive-only — but nothing writes to it any more.
app.all("/api/extension/save-job",
  cors({ origin: corsOriginExtension, credentials: true }),
  (_req, res) => {
    res.status(410).json({
      error: "The save-job endpoint has been removed. Capture now uses /api/import/job, which is " +
             "the same path the capture shortcut uses.",
    });
  });

// /api/extension/save-jobs-bulk REMOVED (cleanup 5.4). Its only client was the extension's
// saved-jobs-content.js, deleted in v1.2.0 along with the LinkedIn bulk-scraping capability
// BYO-2 retired. The endpoint outlived its caller and still accepted bulk writes into
// imported_jobs. The single-job save-job endpoint above is now retired too (E2), so nothing
// writes to imported_jobs at all.

// Metadata is also public â€” mount without requireAuth at a sub-path so
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ADMIN BACKUP / RESTORE
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ADMIN USER MANAGEMENT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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
app.patch("/api/admin/users/:id/password", requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error:"password required" });
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error:passwordError });
  const targetId = parseInt(req.params.id);
  db.prepare("UPDATE users SET password_hash=? WHERE id=?")
    .run(hashPassword(password), targetId);
  // Same reasoning as the self-service reset: an admin resetting someone's password is locking an
  // account, and it does not lock anything if the existing sessions keep working.
  await revokeAllUserSessions(targetId, "admin_password_change");
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
// (quota reset routes removed â€” no refresh cap)

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// â”€â”€ /api/jobs/facets â€” live counts for filter UI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    WHERE sj.is_active = 1
      AND (uj.disliked IS NULL OR uj.disliked = 0)
      AND (uj.applied  IS NULL OR uj.applied  = 0)
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


// ── /api/jobs/suggest — typeahead for the search bar ──────────────
// Titles and locations DERIVED FROM scraped_jobs, scoped to the caller's active role and ranked by
// how often each actually occurs. There is no hand-maintained list of roles behind this: if a title
// is not on the board it is not offered, and when the board changes the suggestions change with it.
//
// Additive. Nothing else calls it, no existing response shape changes, and search BEHAVIOUR is
// untouched — this only proposes text for the input; the double-click local->live pattern still
// decides what actually happens with it.
//
// Cached in services/jobs/searchSuggestions.js: one query per role scope per TTL, then in-memory
// filtering. That is the requirement that this must not become a query per keystroke against the
// jobs table — with the client's debounce on top, a fast typist costs zero additional queries.
app.get("/api/jobs/suggest", requireAuth, (req, res) => {
  try {
    const field = req.query.field === "location" ? "location" : "title";
    const q     = String(req.query.q || "").slice(0, 100);
    const limit = Math.min(10, Math.max(1, parseInt(req.query.limit, 10) || 8));

    const profile = getOrRepairActiveProfile(req.user.id);
    // No profile is not an error here. The board itself reports needsProfileSetup and says so
    // properly; a typeahead has nothing useful to add and must not put an error under the input.
    if (!profile) return res.json({ suggestions: [] });

    const suggestions = suggest(db, {
      roleKey: roleKeyForProfile(profile),
      field, q, limit,
    });
    // An empty array is a normal result, not a failure — the client renders nothing for it.
    res.json({ suggestions });
  } catch (err) {
    console.error('[GET /api/jobs/suggest]', err.message);
    // Degrade to "no suggestions" rather than surfacing a failure on a purely additive convenience.
    res.json({ suggestions: [] });
  }
});

// JOBS â€” shared pool with pagination, filters, sort
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
/**
 * Reject a filter value the vocabulary does not contain — LOUDLY.
 *
 * The failure this replaces is the one shared/jobFilterOptions.js exists for: a select emitting
 * 'mid level' at a column holding 'mid' did not error, it returned zero rows. To the user that is
 * indistinguishable from "there are no mid-level jobs", and it stayed shipped through two rounds of
 * filter fixes because nothing anywhere said the value was wrong.
 *
 * WHAT IS CHECKED. Every dimension in FILTER_DIMENSIONS, under every param name it answers to — its
 * own `param`, plus `excludeParam` and `legacyParam` where it has them, so `sources_exclude=LinkedIn`
 * is caught as surely as `sources_include=LinkedIn`.
 *
 * WHAT IS NOT CHECKED, DELIBERATELY:
 *   - An ABSENT or EMPTY param. "No opinion on this dimension" is the default board, and 400ing it
 *     would break every caller.
 *   - The PROFILE-DERIVED defaults. Those come from deriveProfileFilters, i.e. from our own code, so
 *     an invalid one is an internal bug and not the caller's fault — a 400 would blame the user for
 *     it. test/filterOptionContract.test.js covers that direction instead, by asserting the bridge's
 *     own level table only emits values this contract knows.
 *   - Free-text and numeric params (q, role, location, salary_min_usd, skills_include...). They have
 *     no enumerated vocabulary to check against.
 *
 * Returns a problem string, or null when everything present is recognised.
 */
function rejectInvalidFilterValues(query) {
  for (const [name, dim] of Object.entries(FILTER_DIMENSIONS)) {
    const params = [dim.param, dim.excludeParam, dim.legacyParam].filter(Boolean);
    for (const key of params) {
      const bad = invalidEntries(dim, query[key]);
      if (bad.length) {
        // Name the offending VALUES, not just the dimension. A multi-valued param arrives as
        // "remote,hybrid" and "invalid work_models" with no indication of which entry is wrong is
        // the same dead end as the silent empty board.
        return `Unknown ${name} value${bad.length === 1 ? "" : "s"} for "${key}": ${bad.join(", ")}`;
      }
    }
  }
  return null;
}

app.get("/api/jobs", requireAuth, async (req, res) => {
  try {
    // Validate the enumerated filter vocabularies BEFORE any work — a bad value must not reach the
    // query builder and come back as an empty board. 400 rather than 200-with-nothing: the caller
    // sent something this endpoint does not understand, and saying so is the whole point.
    const filterProblem = rejectInvalidFilterValues(req.query);
    if (filterProblem) {
      return res.status(400).json({ success: false, error: filterProblem, jobs: [], total: 0 });
    }

    const {
      q              = '',
      role           = '',
      location       = '',
      page           = '1',
      pageSize       = '10',
      sort           = '',
      employmentType = '',
      workType       = '',
      ageFilter      = '',
      maxYoe         = null,
      minYoe         = null,
      category       = '',
      source         = '',
      maxApplicants  = null,
      visited        = '',
      localSearch    = '',
      starred        = '',
      domain         = '',
      applied        = '',
    } = req.query;

    // NOTE: bare `q` is not consumed here — no existing caller sends it (checked: the
    // frontend only ever sends role/localSearch for this), so it's reserved below for the
    // new rich query vocabulary (OR terms / "-"-exclude / "quoted"-exact-title) instead of
    // the legacy simple-substring behavior, without changing any real existing call.
    const rawQuery = (role || localSearch || '').slice(0, 200).trim();
    const pg       = Math.max(1, parseInt(page, 10) || 1);
    const ps       = Math.min(50, Math.max(1, parseInt(req.query.page_size || pageSize, 10) || 10));

    // Phase 6: board is profile-scoped via job_role_map join — profile required
    const sessionActiveProfile = getOrRepairActiveProfile(req.user.id);
    if (!sessionActiveProfile) {
      return res.json({
        success:           true,
        jobs:              [],
        total:             0,
        page:              pg,
        pageSize:          ps,
        totalPages:        0,
        needsProfileSetup: true,
        reason:            'no_active_profile',
      });
    }

    const roleKey = roleKeyForProfile(sessionActiveProfile);

    // The Saved ★ tab is a record of what the user already chose, not a discovery surface — so none
    // of the DISCOVERY narrowing applies to it: not the job_role_map role_key join, not
    // profileTitleSql, not the profile bridge. Their own explicit filters still do; those are
    // deliberate acts too.
    //
    // Measured before this: user 14 had starred three imports (a Quora req, a Figma AE req, a
    // RemoteOK posting) and the Saved tab returned ONE. The other two were bucketed 'sales' and
    // 'general' by the classifier, and this board joins job_role_map with an INNER JOIN on the ACTIVE
    // PROFILE's role_key — so a job the user explicitly saved was hidden from the tab whose entire
    // meaning is "the jobs I picked", on the strength of a classifier guess they never saw and
    // cannot change. For an imported job that is the reported bug all over again: the import
    // succeeds, the row is starred, and it is nowhere. ROLE_KEY_FALLBACK ('general') makes an
    // unclassifiable import reachable in principle, but only to a profile whose own role_key is
    // 'general' — which is nobody's.
    const savedTab = starred === '1';

    // profileTitleSql: additive narrowing within the already role-correct board. Skipped on the
    // Saved tab (see above) — a saved job must not have to match the profile's target titles.
    const titleFilter = savedTab ? { sql: "1 = 1", params: [] }
                                 : profileTitleSql("sj.title", sessionActiveProfile);

    // Keyword + location (opt-in)
    const keyFilter = rawQuery ? `AND (sj.title LIKE ? OR sj.company LIKE ? OR sj.description LIKE ?)` : '';
    const keyArgs   = rawQuery ? [`%${rawQuery}%`, `%${rawQuery}%`, `%${rawQuery}%`] : [];
    const locFilter = location ? `AND sj.location LIKE ?` : '';
    const locArgs   = location ? [`%${location}%`] : [];

    // Work-type / employment-type / category (opt-in) — SOFT-NULL, the same pattern and for the
    // same reason as services/jobs/jobQuery.js's workplace_type / experience_level / skills_json
    // clauses; read those comments alongside these. These three columns are written only by paths
    // that have the value to write, and on a real ATS-crawled board that is none of them: all 35
    // active rows in production carry NULL in all three. A hard `= ?` makes `NULL = 'Remote'` NULL,
    // i.e. not-true, so each of these three controls took the board to exactly 0 rows and read as
    // "no remote jobs exist" rather than "not classified yet". A row must never be hidden purely
    // because we have not classified it — only on an explicit mismatch once we have.
    const wtFilter = workType ? `AND (sj.work_type IS NULL OR sj.work_type = ?)` : '';
    const wtArgs   = workType ? [workType]                                      : [];

    // employmentType additionally had a SHAPE bug independent of the NULL one: buildParams sends a
    // comma-joined multi-select (employmentTypePrefs.join(",")) and this bound it to a scalar `= ?`,
    // so "full-time,contract" could not match a row even with data present. Split to an IN list —
    // the shape services/jobs/jobQuery.js already uses for its own `employment_types` key.
    const etValues = String(employmentType).split(',').map(v => v.trim()).filter(Boolean);
    const etFilter = etValues.length
      ? `AND (sj.employment_type IS NULL OR sj.employment_type IN (${etValues.map(() => '?').join(',')}))`
      : '';
    const etArgs   = etValues;

    const catSql  = category ? `AND (sj.category IS NULL OR sj.category = ?)` : '';
    const catArgs = category ? [category]                                    : [];

    // Domain — sj.bucket_domain, written by classifyJob's detectDomain. This is the column the
    // Category note above already named as "a domain filter worth having": sj.category is dead
    // (nothing writes it, and /api/categories' marketing taxonomy never matched its vocabulary
    // even in principle), while bucket_domain carries real values on every row — measured on this
    // database: general 714, fintech 439, edtech 43, ai_ml 25, saas 12, devtools 10, healthtech 9,
    // ecommerce 1, and zero NULLs across all 1,253 rows.
    //
    // It exists because the search bar's "Any Domain" select has always rendered exactly this
    // vocabulary and been wired to nothing at all. Soft-null, the same call as work_type /
    // employment_type / category beside it: bucket_domain has no NULLs today, but the rule this
    // codebase applies is that a row is never hidden purely because we have not classified it —
    // only on an explicit mismatch once we have.
    const domSql  = domain ? `AND (sj.bucket_domain IS NULL OR sj.bucket_domain = ?)` : '';
    const domArgs = domain ? [domain]                                                 : [];

    // source stays a HARD match, deliberately, for the reason jobQuery.js's sources_include comment
    // already records: every scraped_jobs writer sets `source`, so there is no "not classified yet"
    // state to protect, and a soft-null escape would make the filter unable to exclude anything the
    // moment a NULL appeared.
    const srcSql  = source   ? `AND sj.source   = ?` : '';
    const srcArgs = source   ? [source]              : [];

    // Starred (opt-in) — the Saved ★ tab. buildParams has always emitted starred=1 for
    // boardTab === "saved"; this handler destructured it nowhere and built no clause for it, so the
    // Saved tab silently returned the ENTIRE unfiltered board. Measured against production before
    // this fix: starred=1 returned 27 of 27 rows for a user with zero starred rows. `uj` is already
    // LEFT JOINed per (user, profile) below, so this reads that user's own flag and nobody else's.
    // Any value other than '1' emits nothing, so the default board querystring is unchanged.
    const starredSql = savedTab ? `AND uj.starred = 1` : '';

    // Applied — the search bar's Status > "Applied". Reads uj.applied, the per-(user, profile) flag
    // on the LEFT JOIN already in place, for the same reason starredSql reads uj.starred and not
    // sj.*: it is one user's own record of what they did, and must never surface another's.
    // Parameterless, so like starredSql it can sit anywhere in the WHERE clause without shifting
    // baseArgs.
    const appliedSql = applied === '1' ? `AND uj.applied = 1` : '';

    // Applicant count cap (opt-in)
    const maxAppVal = maxApplicants !== null && maxApplicants !== '' ? parseInt(maxApplicants, 10) : null;
    const maxAppSql  = maxAppVal !== null ? `AND (sj.applicant_count IS NULL OR sj.applicant_count <= ?)` : '';
    const maxAppArgs = maxAppVal !== null ? [maxAppVal] : [];

    // Visited filter (opt-in)
    const visitedSql  = visited === '1' ? `AND uj.visited = 1`
                      : visited === '0' ? `AND (uj.visited IS NULL OR uj.visited = 0)` : '';

    // Age filter — support named intervals ("1d","2d","3d","1w","1m") + raw day counts
    let ageSql  = '', ageArgs = [];
    // The second copy of this table lived in JobsPanel's AGE_DAYS_MAP. Both read the shared
    // POSTING_AGE definition now, so the client's derived `posted_after` and this clause cannot
    // come to disagree about how many days "past week" is.
    const AGE_MAP = ageDaysMap();
    const ageDays = AGE_MAP[ageFilter] ?? parseInt(ageFilter, 10);
    if (ageFilter && !isNaN(ageDays) && ageDays > 0) {
      ageSql  = `AND sj.scraped_at >= ?`;
      ageArgs = [Math.floor(Date.now() / 1000) - ageDays * 86400];
    }

    // YoE range: auto-apply from stored signals when no explicit maxYoe is set
    const signals = loadSimpleApplyProfile(db, { userId: req.user.id, profileId: sessionActiveProfile.id });
    const explicitMaxYoe = maxYoe !== null && maxYoe !== '' ? parseInt(maxYoe, 10) : null;
    const effectiveMaxYoe = explicitMaxYoe !== null
      ? explicitMaxYoe
      : (signals?.yearsExperience != null ? signals.yearsExperience + 2 : null);
    const yoeSql  = effectiveMaxYoe !== null ? `AND (sj.min_years_exp IS NULL OR sj.min_years_exp <= ?)` : '';
    const yoeArgs = effectiveMaxYoe !== null ? [effectiveMaxYoe] : [];
    const minYoeVal = minYoe !== null && minYoe !== '' ? parseInt(minYoe, 10) : null;
    const minYoeSql  = minYoeVal !== null ? `AND (sj.min_years_exp IS NULL OR sj.min_years_exp >= ?)` : '';
    const minYoeArgs = minYoeVal !== null ? [minYoeVal] : [];

    // Rich filter vocabulary (all optional/default-off — see services/jobs/jobQuery.js).
    // Every param it reads defaults to absent, so richFilters.sql/.params are '' / [] and
    // this branch is byte-identical to before whenever none of these are passed.
    //
    // Profile→Board Bridge: derives DEFAULTS for a handful of these dimensions (q, skills,
    // experience level, sponsorship-friendliness) from the active profile's stored signals —
    // reusing `signals` already loaded above for the YoE constraint, no extra DB call. An
    // explicit query param for the same dimension always wins (checked per-key below);
    // ?curate=off skips derivation entirely, reproducing pre-bridge behavior exactly.
    const baseFilterParams = { q, ...req.query };
    const derivedFilters = (req.query.curate === 'off' || savedTab)
      ? {}
      : deriveProfileFilters(sessionActiveProfile, signals);
    const filterParams = { ...baseFilterParams };
    // Which derived keys ACTUALLY took effect (an explicit query param for the same dimension wins,
    // so a derived key can be computed and then not used). Only these are reported to the client,
    // and only these are removed to compute the uncurated total below — reporting the ones that
    // lost to an explicit value would blame the profile for the user's own filter.
    const appliedDerivedKeys = [];
    for (const key of Object.keys(derivedFilters)) {
      const explicitVal = baseFilterParams[key];
      const isExplicit  = explicitVal !== undefined && explicitVal !== null && explicitVal !== '';
      if (!isExplicit) { filterParams[key] = derivedFilters[key]; appliedDerivedKeys.push(key); }
    }
    // PROVENANCE, carried rather than re-derived. buildJobFilters cannot tell a value the user typed
    // from one this bridge inferred — the merged object looks identical either way — and X2's rule
    // turns entirely on that distinction: a filter the USER SET excludes rows, a filter DERIVED on
    // their behalf ranks them. appliedDerivedKeys is already the authoritative answer, computed by
    // the merge loop directly above from the only place that knows. Passing it down is what makes
    // the rule structural; having the query builder guess again would be a second opinion that can
    // disagree with this one.
    const richFilters = buildJobFilters(filterParams, { derivedKeys: appliedDerivedKeys });
    // THE UNCURATED SECOND QUERY IS GONE, because the quantity it measured no longer exists.
    //
    // It used to build the same board minus the profile-derived defaults, so the response could say
    // how many rows the bridge was HIDING — disclosure being the previous pass's answer to a bridge
    // that narrowed silently. Every key the bridge derives now ranks instead of excluding, so the
    // curated and uncurated row SETS are identical by construction and that count is always zero.
    // Keeping the query would be paying for a COUNT to learn a constant.
    //
    // What is worth disclosing changed with it: not "N are hidden" but "N are further down". That is
    // richFilters.rank.demotedSql — rows explicitly outside at least one derived window, i.e.
    // precisely the rows this endpoint used to delete from the answer. Counted below, and only when
    // something actually ranks.
    const rankApplied = !!richFilters.rank.sql;
    const selectCols  = buildSelectColumns(req.query.include_fields);
    const facetDims   = resolveFacetDimensions(req.query.include_facets);

    const cacheCount = db.prepare("SELECT COUNT(*) as n FROM scraped_jobs WHERE is_active = 1").get()?.n || 0;
    if (cacheCount > 0) {
      // "compHigh"/"compLow" ("Pay high to low"/"Pay low to high") are existing options in
      // JobsPanel's sort <select> (client already sends sort=compHigh/compLow via
      // buildParams) that this ternary never had a case for — they silently fell through to
      // the recency default, so picking "Pay high to low" did nothing. This is that fix, not
      // a new feature. Sorts by the same salary_min/salary_max columns the client displays
      // (mapJobRow's salaryMin/salaryMax) rather than the enrichment-only
      // salary_min_usd/salary_max_usd — sorting by a field the UI doesn't show would look
      // broken whenever they disagree, and the *_usd columns depend on enrichment having run
      // (Task 5's LLM pass), which isn't guaranteed for every row. Caveat carried over from
      // the source columns themselves: unnormalized currency, so a listing quoted in a weaker
      // currency can rank above a stronger one at the same face value — a real cross-currency
      // fix belongs on salary_min_usd/salary_max_usd once enrichment coverage is reliable
      // enough to sort by, not invented here. NULL salaries always sort last in both
      // directions rather than being treated as zero.
      // Every sort ended in `sj.scraped_at DESC` with nothing after it, and a crawl writes its
      // whole batch within a second or two — so on a real board scraped_at has a handful of
      // distinct values across thousands of rows and cannot order them. Two consequences, one
      // visible and one silent:
      //
      //   - The tie group comes back in query-plan order, i.e. roughly insert order, so whichever
      //     employer the crawler happened to write first owns the top of the board. Observed in
      //     production: 1,275 rows across 9 companies sharing 2 distinct scraped_at values, 505 of
      //     them OpenAI — at the default page size of 10 that is up to 50 consecutive pages of one
      //     employer before any other appears. The other 770 jobs were never missing, just buried.
      //   - SQLite guarantees no consistent order between separate queries when rows tie, so
      //     LIMIT/OFFSET paging could return the same row on two pages and skip others entirely.
      //     Nothing surfaces that as an error; the board just quietly lies.
      //
      // posted_at breaks the tie with something meaningful rather than arbitrary — within a crawl
      // batch the genuinely newest postings lead, which is what "Newest" claims to mean, and it
      // interleaves employers as a side effect because posting dates vary. NULLs sort last instead
      // of counting as epoch 0 and hiding real postings beneath undated ones. job_id is the final
      // key: it is the primary key, so the order is total and paging is reproducible.
      //
      // The leading key is discovered_at (first seen), NOT scraped_at (last touched by a writer).
      // These are different facts and the column names say so: upsertCanonicalJob writes
      // `scraped_at: now` on EVERY write, while deliberately preserving `discovered_at` as
      // first-seen. So the nightly 04:00 crawl rewrites scraped_at on all ~1,250 crawled rows, and
      // any job that did not arrive in that batch sinks below all of them — regardless of how new
      // it actually is.
      //
      // A user-imported job is exactly that job. Measured on the reproduction board: an import made
      // minutes earlier ranked LAST, page 34 of 34, under 1,252 crawled rows the crawl had merely
      // re-touched. "Newest" was sorting by when we last looked at a posting, which is a fact about
      // our crawler, not about the posting — and it buried the one row the user had personally put
      // there. discovered_at is what the label already claims to mean, and it is the same column the
      // NEW<24h pill and the discovered_after filter already trust.
      //
      // COALESCE onto scraped_at because rows CAN lack discovered_at (production carries 10 adzuna
      // orphans from the pre-pivot architecture), matching what the discovered_after filter does
      // rather than dropping those rows to the bottom forever.
      //
      // Deliberate consequence: a re-crawled posting no longer jumps to the top just because the
      // crawler touched it again. That was never information the user asked to be ranked by.
      const RECENCY = 'COALESCE(sj.discovered_at, sj.scraped_at) DESC, (sj.posted_at IS NULL) ASC, sj.posted_at DESC, sj.job_id';
      // "Oldest" is a real option in the sort <select> (value "dateAsc") that had no case here, so
      // it fell through to the default and rendered identically to "Newest" — the same silent
      // fall-through that compHigh/compLow suffered before, fixed there and missed here. Undated
      // postings stay last in BOTH directions: they have no date, so leading the "oldest" list with
      // them would be an ordering by absence rather than by age.
      // Mirrors RECENCY's leading key for the same reason — "Oldest" must mean the posting we have
      // known about longest, not the one our crawler happened to touch least recently.
      const OLDEST = 'COALESCE(sj.discovered_at, sj.scraped_at) ASC, (sj.posted_at IS NULL) ASC, sj.posted_at ASC, sj.job_id';
      // NULLs last on every keyed sort, matching what the salary sorts already did. Without it a
      // column that is only partly populated ranks its unscored rows among the scored ones, and a
      // column that is entirely NULL makes the sort a silent no-op that looks like a broken control.
      // "Exp low to high" / "Exp high to low" were dead too. The obvious column, min_years_exp, is
      // the one the YoE FILTERS use — but nothing on the ATS crawl path ever writes it (it comes
      // from the extension capture), so sorting on it alone would have left both controls doing
      // nothing on any crawled board. experience_level IS populated, by enrichment, from a fixed
      // ordered vocabulary — so rank that, and let min_years_exp win wherever the precise number
      // exists. NULLs last on both keys.
      const LEVEL_RANK = `CASE sj.experience_level
        WHEN 'intern' THEN 0 WHEN 'entry' THEN 1 WHEN 'mid' THEN 2
        WHEN 'senior' THEN 3 WHEN 'lead' THEN 4 WHEN 'executive' THEN 5 END`;
      const EXP = (dir) =>
        `(sj.min_years_exp IS NULL) ASC, sj.min_years_exp ${dir}, ` +
        `((${LEVEL_RANK}) IS NULL) ASC, (${LEVEL_RANK}) ${dir}, ${RECENCY}`;

      const chosenSort = sort === 'atsScore'       ? `(sj.ats_score IS NULL) ASC, sj.ats_score DESC, ${RECENCY}`
                    : sort === 'applicantCount'  ? `(sj.applicant_count IS NULL) ASC, sj.applicant_count ASC, ${RECENCY}`
                    : sort === 'compHigh'        ? `(sj.salary_max IS NULL) ASC, sj.salary_max DESC, ${RECENCY}`
                    : sort === 'compLow'         ? `(sj.salary_min IS NULL) ASC, sj.salary_min ASC, ${RECENCY}`
                    : sort === 'yoeLow'          ? EXP('ASC')
                    : sort === 'yoeHigh'         ? EXP('DESC')
                    : sort === 'dateAsc'         ? OLDEST
                    :                             RECENCY;

      // Profile relevance leads the DEFAULT order only — the same user-set-vs-derived rule the
      // filters now follow, applied to ordering.
      //
      // Picking "Pay high to low" is a user-set instruction about ORDER, so it wins outright: a
      // derived relevance key in front of it would put an in-band $80k role above an out-of-band
      // $300k one and read as a broken control, which is exactly the complaint the compHigh/compLow
      // fix above existed to settle. Leaving the sort alone is not an instruction, so the derived
      // ranking may lead there.
      //
      // 'dateDesc' counts as "left alone": the client always sends a sort (JobsPanel's buildParams
      // does `p.set("sort", sortBy)`) and its initial value is 'dateDesc', which is also the value
      // that falls through this ternary to RECENCY. So absence and 'dateDesc' are the same state and
      // both have to be treated as the default, or relevance would never apply to anyone.
      const sortIsDefault = !sort || sort === 'dateDesc';
      const rankPrefix = (sortIsDefault && richFilters.rank.sql) ? `${richFilters.rank.sql}, ` : '';
      const orderBy = `${rankPrefix}${chosenSort}`;
      // Bound to ORDER BY, so they sit after every WHERE param and before LIMIT/OFFSET — placeholder
      // binding is positional in SQL text order, and the COUNT/facet queries below carry no ORDER BY
      // and therefore must NOT receive these.
      const orderArgs = rankPrefix ? richFilters.rank.params : [];
      const offset  = (pg - 1) * ps;

      // The role_key join is what makes this board profile-scoped, and it is an INNER JOIN — so it
      // is also what can make a row unreachable. On the Saved tab it is dropped entirely (see
      // savedTab above): the user's own star already answers "does this belong on your board?", and
      // no classifier bucket may overrule it. Everywhere else it stays exactly as it was.
      const joinClause = `
        FROM scraped_jobs sj
        ${savedTab ? '' : 'JOIN job_role_map jrm ON jrm.job_id = sj.job_id AND jrm.role_key = ?'}
        LEFT JOIN user_jobs uj
          ON uj.job_id = sj.job_id AND uj.user_id = ? AND uj.domain_profile_id = ?
      `;
      // Parameterised over the rich-filter fragment alone so the curated and uncurated counts are
      // guaranteed to differ in nothing else — a hand-copied second WHERE would drift the first time
      // any clause above changes.
      // `is_active = 1` is a DISCOVERY predicate — "this listing is still live" — and on every other
      // board it stays. The Saved tab relaxes it for the same reason it drops the role join: these
      // are the user's own picks, and a saved posting that has since closed must be shown as closed,
      // not quietly removed from the list they built.
      //
      // This is the half that makes runExpiredJobsCleanup's retirement mean anything. That pass now
      // sets is_active = 0 on an expired starred row instead of deleting it — but with a hard
      // `is_active = 1` here the row would have been preserved in the database and still invisible to
      // its owner, which is the same disappearance with extra steps. mapJobRow exposes isActive so
      // the card can label it.
      const whereClauseFor = (rich) => `
        WHERE ${savedTab ? '1 = 1' : 'sj.is_active = 1'}
          ${keyFilter}
          ${locFilter}
          AND ${titleFilter.sql}
          ${wtFilter}
          ${etFilter}
          ${catSql}
          ${domSql}
          ${srcSql}
          ${maxAppSql}
          ${visitedSql}
          ${starredSql}
          ${appliedSql}
          ${ageSql}
          ${yoeSql}
          ${minYoeSql}
          ${rich.sql}
          AND (uj.disliked IS NULL OR uj.disliked = 0)
      `;
      const argsFor = (rich) => [
        // Must track joinClause exactly: no role_key placeholder on the Saved tab, so no roleKey arg.
        ...(savedTab ? [] : [roleKey]),
        req.user.id, sessionActiveProfile.id,
        ...keyArgs, ...locArgs, ...titleFilter.params,
        ...wtArgs, ...etArgs, ...catArgs, ...domArgs, ...srcArgs,
        ...maxAppArgs, ...ageArgs, ...yoeArgs, ...minYoeArgs,
        ...rich.params,
      ];
      const whereClause = whereClauseFor(richFilters);
      const baseArgs    = argsFor(richFilters);

      const rows  = db.prepare(`SELECT ${selectCols}, uj.visited, uj.applied, uj.starred, uj.disliked ${joinClause} ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...baseArgs, ...orderArgs, ps, offset);
      const total = db.prepare(`SELECT COUNT(*) as n ${joinClause} ${whereClause}`).get(...baseArgs)?.n || 0;

      console.log(JSON.stringify({ msg: '[jobs]', profile: sessionActiveProfile.profile_name, sort, total, returned: rows.length }));

      const responseBody = {
        success:    true,
        jobs:       rows.map(j => ({ ...mapJobRow(j), scrapedAt: j.scraped_at })),
        total,
        page:       pg,
        pageSize:   ps,
        totalPages: Math.ceil(total / ps),
        sources:    ['scraped_jobs'],
        fromCache:  true,
      };

      // Curation disclosure — now a statement about ORDER, not about a withheld remainder.
      //
      // The old shape (total / uncuratedTotal / hidden) said "Showing 210 of 241". Under ranking that
      // sentence would be a lie in the only way that matters: all 241 are on the board, and claiming
      // otherwise would send users to hunt for rows that are two screens down rather than missing.
      // `demoted` replaces `hidden` and counts the rows explicitly outside a derived window — the
      // same rows the old `hidden` counted, now described by where they went instead of by their
      // absence. `applied` is unchanged so a client that has not been updated still renders something
      // truthful rather than throwing.
      //
      // Only emitted when something actually ranked AND something is actually demoted, so a profile
      // with no signals still gets a byte-identical response to before.
      if (rankApplied) {
        const demotedRows = db.prepare(
          `SELECT COUNT(*) as n ${joinClause} ${whereClause} AND ${richFilters.rank.demotedSql}`
        ).get(...baseArgs, ...richFilters.rank.demotedParams)?.n || 0;
        if (demotedRows > 0) {
          responseBody.curation = {
            applied:    true,
            ranked:     true,
            rankedKeys: richFilters.rankedKeys,
            total,
            demoted:    demotedRows,
          };
        }
      }

      // include_facets (optional, default-off): facet counts over the SAME filtered result
      // set, using the identical joinClause/whereClause/baseArgs as the main query.
      if (facetDims.length) {
        const facets = {};
        for (const dim of facetDims) {
          if (dim === 'skills') continue; // computed separately below (JSON column, not a plain GROUP BY)
          const { column } = FACET_DIMENSIONS[dim];
          const facetRows = db.prepare(`
            SELECT ${column} as value, COUNT(*) as count
            ${joinClause} ${whereClause}
            GROUP BY ${column}
          `).all(...baseArgs);
          facets[dim] = facetRows.filter(r => r.value != null).map(r => ({ value: r.value, count: r.count }));
        }
        if (facetDims.includes('skills')) {
          const skillsRows = db.prepare(`SELECT sj.skills_json as skills_json ${joinClause} ${whereClause}`).all(...baseArgs);
          facets.skills = computeSkillsFacet(skillsRows.map(r => r.skills_json));
        }
        responseBody.facets = facets;
      }

      return res.json(responseBody);
    }

    // --- Empty cache: an explained empty board, NOT a live aggregator feed ---
    //
    // This used to fall through to searchJobs() — an unauthenticated-shaped, global Adzuna/SerpAPI
    // query. Everything that makes this endpoint "your board" was skipped on that path: the
    // job_role_map role_key scoping, profileTitleSql, the profile bridge, every key in
    // buildJobFilters, the Saved (starred) tab, visited, and the disliked exclusion. `sanitized`
    // forwarded exactly five of them (query/location/country/employmentType/remote) and dropped the
    // rest silently.
    //
    // Measured on a real run with an empty cache and an ENGINEERING profile: the default board, the
    // Saved tab, tiers_include=gated, experience_levels=executive and sources_include=ashby all
    // returned the SAME 6,213,918-row result led by "Occupational Therapist" — which is precisely
    // the reported "the same set of listings renders regardless of search or filters". A Saved tab
    // showing 6.2M jobs the user never saved is the read-side twin of the write-side defect this
    // codebase keeps hitting: a surface reporting something it did not do.
    //
    // Live search is still available and is unaffected — it has its own endpoint (POST
    // /api/jobs/search), which the client already calls, plus the public GET /api/jobs/generic.
    // What is removed is the silent substitution of a global feed for a profile-scoped board.
    console.warn(`[jobs] cache empty — returning explained empty board for profile ${sessionActiveProfile.id}`);
    return res.json({
      success:    true,
      jobs:       [],
      total:      0,
      page:       pg,
      pageSize:   ps,
      totalPages: 0,
      sources:    ['scraped_jobs'],
      fromCache:  true,
      reason:     'cache_empty',
    });
  } catch (err) {
    console.error('[GET /api/jobs] Error:', err.message);
    res.status(500).json({
      success: false,
      error:   'Failed to fetch jobs. Please try again.',
      jobs:    [],
    });
  }
});

// GET /api/jobs/generic -- public cached feed (no auth, no personalization)
app.get("/api/jobs/generic", async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
    const ps     = Math.min(20, parseInt(req.query.pageSize, 10) || 12);
    const offset = (page - 1) * ps;

    const rows = db.prepare(`
      SELECT job_id, title, company, location, work_type, url, source, source_label,
             bucket_role, bucket_seniority, bucket_domain, posted_at, scraped_at,
             salary_min, salary_max, salary_currency, compensation,
             company_icon_url, via
      FROM scraped_jobs
      WHERE direct_apply = 1 AND is_active = 1
      ORDER BY scraped_at DESC
      LIMIT ? OFFSET ?
    `).all(ps, offset);

    const total = db.prepare("SELECT COUNT(*) as n FROM scraped_jobs WHERE direct_apply = 1 AND is_active = 1").get()?.n || 0;
    const filteredRows = rows.filter(r => isResumeRelevant(r.title));

    res.json({ success: true, jobs: filteredRows.map(mapJobRow), total, page, pageSize: ps });
  } catch (err) {
    console.error('[GET /api/jobs/generic]', err.message);
    res.status(500).json({ success: false, error: 'Failed to load jobs.', jobs: [] });
  }
});

// -- POST /api/jobs/search -- live search (auth required) ----------------------
app.post("/api/jobs/search", requireAuth, async (req, res) => {
  try {
    const {
      query = '', location = '', experience, domain,
      contractType, remote, page = 1, pageSize = 20,
    } = req.body || {};

    if (!query.trim() && !location.trim()) {
      return res.status(400).json({ success: false, error: 'Enter a job title or location to search.', jobs: [] });
    }

    // Load ATS company lists for direct-ATS plugins
    const atsCos = db.prepare("SELECT * FROM company_ats_list WHERE active = 1").all();
    const _ghCompanies    = atsCos.filter(r => r.ats_type === 'greenhouse');
    const _leverCompanies = atsCos.filter(r => r.ats_type === 'lever');
    const _ashbyCompanies = atsCos.filter(r => r.ats_type === 'ashby');

    // `domain` and `experience` arrive as the UI's ENUM values (bucket_domain /
    // experience_level), and this endpoint folds them into a free-text aggregator query rather
    // than filtering on them — so they have to be humanised first. Without this, the search bar's
    // AI / ML option contributes the literal token `ai_ml`, which matches nothing any job board
    // has ever written. Underscores become spaces and nothing else; every other value in both
    // vocabularies is already an ordinary word.
    const asKeywords = (v) => String(v || '').replace(/_/g, ' ').trim();

    const result = await searchJobs({
      query: [query.trim(), asKeywords(domain), asKeywords(experience)].filter(Boolean).join(' '),
      location, contractType, remote, page, pageSize,
      sort: 'dateDesc',
      _ghCompanies, _leverCompanies, _ashbyCompanies,
    });

    // Attach user interaction state for returned jobs
    const interactionMap = {};
    if (result.jobs.length) {
      const placeholders = result.jobs.map(() => '?').join(',');
      const jobIds = result.jobs.map(j => j.id);
      const rows = db.prepare(
        `SELECT job_id, starred, disliked FROM user_jobs WHERE user_id=? AND job_id IN (${placeholders})`
      ).all(req.user.id, ...jobIds);
      rows.forEach(r => { interactionMap[r.job_id] = r; });
    }

    const jobs = result.jobs.map(j => mapJobRow({
      ...j,
      starred:  !!(interactionMap[j.id]?.starred),
      disliked: !!(interactionMap[j.id]?.disliked),
    }));

    res.json({ ...result, jobs, success: true });

    // Non-blocking write-back of live search results to scraped_jobs
    if (result.jobs.length > 0) {
      setImmediate(() => {
        try {
          const insert = db.prepare(`
            INSERT OR IGNORE INTO scraped_jobs
              (job_id, _hash, title, company, location, url, source, source_label,
               via, bucket_role, bucket_seniority, bucket_domain,
               company_icon_url, direct_apply, posted_at, scraped_at,
               fingerprint, sources_seen, req_uid, automation_tier)
            VALUES
              (@job_id, @_hash, @title, @company, @location, @url, @source, @source_label,
               @via, @bucket_role, @bucket_seniority, @bucket_domain,
               @company_icon_url, @direct_apply, @posted_at, strftime('%s','now'),
               @fingerprint, @sources_seen, @req_uid, @automation_tier)
          `);
          const insertMany = db.transaction((jobs) => {
            for (const j of jobs) {
              const id = j.id || j.url || '';
              if (!id) continue;

              // Cross-source dedup: collapse into an existing higher-(or-equal-)priority
              // canonical row (e.g. this same role's direct-ATS listing) if one exists.
              const dedup = reconcileFingerprint(db, {
                id, url: j.url || '', title: j.title || '', company: j.company || '',
                location: j.location || '', source: j.source || 'serpapi',
                description:      j.description || null,
                company_icon_url: j.companyIconUrl || j.company_icon_url || j.thumbnail || null,
                workplace_type:   j.workplaceType || j.workplace_type || null,
                posted_at:        j.postedAt || j.posted_at || null,
              });
              if (dedup.action === 'fold') continue; // no separate row for this duplicate
              const canonical = dedup.job;

              insert.run({
                job_id:           id,
                _hash:            id,
                title:            j.title        || '',
                company:          j.company       || '',
                location:         j.location      || '',
                url:              j.url           || '',
                source:           j.source        || 'serpapi',
                source_label:     j.sourceLabel || j.source_label || '',
                via:              j.via           || null,
                bucket_role:      j.bucketRole  || j.bucket_role  || 'other',
                bucket_seniority: j.bucketSeniority || j.bucket_seniority || null,
                bucket_domain:    j.bucketDomain || j.bucket_domain || null,
                company_icon_url: canonical.company_icon_url || null,
                direct_apply:     (j.directApply ?? j.direct_apply) ? 1 : 0,
                posted_at:        canonical.posted_at || null,
                fingerprint:      dedup.fingerprint,
                sources_seen:     dedup.sourcesSeen,
                req_uid:          dedup.reqUid,
                // This insert writes no apply_url column at all, so `url` IS the apply
                // destination — the same value mapJobRow will hand the client as applyUrl.
                automation_tier:  deriveAutomationTier(j.source || 'serpapi', j.url || ''),
              });
            }
          });
          const relevantJobs = result.jobs.filter(j => isResumeRelevant(j.title));
          insertMany(relevantJobs);
          console.log(`[Search] Persisted ${relevantJobs.length} live results (skipped ${result.jobs.length - relevantJobs.length} irrelevant)`);
        } catch(e) {
          console.warn('[Search] Write-back non-fatal:', e.message);
        }
      });
    }
  } catch (err) {
    console.error('[POST /api/jobs/search]', err.message);
    res.status(500).json({ success: false, error: 'Search failed.', jobs: [] });
  }
});

// -- PATCH /api/profile/skills -- toggle confirmed/target skill -----------------
app.patch("/api/profile/skills", requireAuth, (req, res) => {
  const { skill, action } = req.body || {};
  if (!skill || !action) return res.status(400).json({ error: 'skill and action required' });

  const validActions = ['add_confirmed', 'add_target', 'remove'];
  if (!validActions.includes(action)) return res.status(400).json({ error: 'invalid action' });

  try {
    const row = db.prepare("SELECT confirmed_skills, target_skills FROM user_profile WHERE user_id=?").get(req.user.id);
    const confirmed = JSON.parse(row?.confirmed_skills || '[]');
    const target    = JSON.parse(row?.target_skills    || '[]');
    const key       = skill.toLowerCase();

    const remove = arr => arr.filter(s => s.toLowerCase() !== key);

    let newConfirmed = remove(confirmed);
    let newTarget    = remove(target);

    if (action === 'add_confirmed') newConfirmed = [...newConfirmed, key];
    if (action === 'add_target')    newTarget    = [...newTarget,    key];

    db.prepare(
      "UPDATE user_profile SET confirmed_skills=?, target_skills=?, updated_at=unixepoch() WHERE user_id=?"
    ).run(JSON.stringify(newConfirmed), JSON.stringify(newTarget), req.user.id);

    res.json({ success: true, confirmed_skills: newConfirmed, target_skills: newTarget });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/jobs/interact -- unified star/dislike/status persist for board jobs
/**
 * Star or dislike a job from a card that has no parent handler.
 *
 * THIS ENDPOINT HAS NEVER ONCE SUCCEEDED. It was added in a55151d selecting a `status` column that
 * user_jobs has never had, in any migration, so every call threw SqliteError("no such column:
 * status") and returned 500. JobCard's caller wraps it in `catch (e) { console.warn(...) }`, so the
 * failure was invisible: the star filled in optimistically and reverted on the next load.
 *
 * It is reachable. JobsPanel passes onStar so the board uses its own handler, but BOTH JobCard call
 * sites in DatabasePanel pass only onDislike — so starring on the Database panel, and unstarring a
 * job in Saved Jobs, fell through to here and did nothing.
 *
 * WHAT `status` WAS FOR: nothing. It was read into `newStatus`, which was never referenced again
 * and was never written to any column. The request body's `status`, `title`, `company` and `source`
 * were all accepted and silently discarded in the same way. Dead input is removed rather than
 * wired up, because there is no column for it and inventing one to justify a parameter nobody
 * sends would be the wrong direction.
 *
 * THE JOB IS RESOLVED, NEVER INVENTED. The old insert used the URL as the job_id, and every other
 * writer of this table uses a real job_id — so simply deleting the `status` reference would have
 * traded a loud crash for a silent one: a second, URL-keyed row for the same job, which no board
 * query joins to and no user could ever see. A URL is accepted (the card has one to hand) but it is
 * resolved against scraped_jobs; a job we do not know is a 404, not a phantom row.
 */
app.patch("/api/jobs/interact", requireAuth, (req, res) => {
  const { jobId, url, starred, disliked } = req.body || {};
  if (!jobId && !url) return res.status(400).json({ error: "jobId or url required" });
  if (starred == null && disliked == null) {
    return res.status(400).json({ error: "nothing to change: send starred or disliked" });
  }
  try {
    // jobId first — the caller usually has it, and it needs no lookup. A URL is matched against
    // both columns because scraped_jobs stores the posting URL and the apply URL separately and a
    // card carries whichever it has.
    const resolved = jobId
      ? db.prepare("SELECT job_id FROM scraped_jobs WHERE job_id=?").get(String(jobId))
      : db.prepare("SELECT job_id FROM scraped_jobs WHERE url=? OR apply_url=? LIMIT 1").get(url, url);
    if (!resolved?.job_id) return res.status(404).json({ error: "Job not found" });
    const resolvedJobId = resolved.job_id;

    const existing = db.prepare(
      "SELECT starred, disliked FROM user_jobs WHERE user_id=? AND job_id=?"
    ).get(req.user.id, resolvedJobId);

    const newStarred  = starred  != null ? (starred  ? 1 : 0) : (existing?.starred  ?? 0);
    const newDisliked = disliked != null ? (disliked ? 1 : 0) : (existing?.disliked ?? 0);

    // The SAME resolution the sibling endpoints use (/api/jobs/:id/starred and /disliked), rather
    // than a looser "whatever profile is active" lookup of its own. The board filters on
    // domain_profile_id, so a row written under a different one is a star the user cannot see.
    const profileId = resolveUserJobDomainProfileId(req.user.id, resolvedJobId);

    db.prepare(`
      INSERT INTO user_jobs (user_id, job_id, domain_profile_id, starred, disliked, updated_at)
      VALUES (?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(user_id, job_id) DO UPDATE SET
        starred    = excluded.starred,
        disliked   = excluded.disliked,
        updated_at = unixepoch()
    `).run(req.user.id, resolvedJobId, profileId, newStarred, newDisliked);

    // Same as the siblings: other tabs showing this job update instead of going stale. AH2 made
    // several tabs on one session an ordinary thing to do, which makes this worth more than it was.
    emitToUser(req.user.id, { type: "job_flag", jobId: resolvedJobId, starred: !!newStarred });

    res.json({ success: true, jobId: resolvedJobId, starred: !!newStarred, disliked: !!newDisliked });
  } catch (err) {
    console.error(`[jobs/interact] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/poll -- returns new jobs since <since> ms timestamp + scraping status
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
    WHERE sj.is_active = 1
      AND LOWER(sj.search_query) = ?
      AND ${pollProfileTitleFilter.sql}
      AND (? IS NULL OR sj.min_years_exp IS NULL OR sj.min_years_exp <= ?)
      AND sj.scraped_at >= ?
      AND (uj.disliked  IS NULL OR uj.disliked  = 0)
      AND (uj.applied   IS NULL OR uj.applied   = 0)
    -- Same ordering as the board (see /api/jobs' RECENCY): a crawl writes its batch within a second
    -- or two, so scraped_at alone leaves these 50 slots to whichever employer was inserted first —
    -- and it ranks by when we last TOUCHED a row rather than when we first saw it, which buries
    -- anything that did not arrive in the newest crawl batch. The WHERE clause above still gates on
    -- scraped_at, which is correct there: "changed since you last polled" is genuinely a
    -- last-touched question. Only the ORDER BY changes.
    ORDER BY COALESCE(sj.discovered_at, sj.scraped_at) DESC, (sj.posted_at IS NULL) ASC, sj.posted_at DESC, sj.job_id
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
    sourcePlatform:  j.source || j.source_label || 'direct',
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
    via:             j.via || null,
    isFrequentRepost: !!j.is_frequent_repost,
    visited:         !!j.visited,
    alreadyApplied:  !!j.applied,
    starred:         !!j.starred,
    disliked:        !!j.disliked,
  }));

  if (!stillScraping && scrapeState?.done) {
    // [poll] profile query scrape done â€” keep this diagnostic shape searchable in tests.
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

// VALID_EMP_TYPES / VALID_WORKPLACE_TYPES / VALID_POSTED_LIMITS were removed here.
//
// All three were DECLARED AND NEVER READ — grep-proven, zero references in this file or any other.
// Apify left them behind. They mattered because they looked exactly like the validation this
// endpoint was missing while being a decoy: VALID_WORKPLACE_TYPES said "office" where every live
// definition of that dimension says "onsite", and VALID_EMP_TYPES listed "temporary", which
// schema.js's synonym table folds into "contract" and the column therefore can never hold. A
// validation set nothing reads does not stay correct; it just stays convincing.
//
// The real validation is rejectInvalidFilterValues() on GET /api/jobs, which reads
// shared/jobFilterOptions.js — the same definition the controls render from.

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

// Map UI workType string â†’ Apify workplaceType array
function mapWorkplaceTypes(workType) {
  const map = { Remote:"remote", Hybrid:"hybrid", Onsite:"office", "On-site":"office",
                remote:"remote", hybrid:"hybrid", office:"office" };
  if (!workType) return ["remote","hybrid","office"];
  const mapped = map[workType];
  return mapped ? [mapped] : ["remote","hybrid","office"];
}

// Map UI ageFilter string â†’ Apify postedLimit
function mapPostedLimit(ageFilter) {
  const map = { "1d":"24h","2d":"24h","3d":"24h","1w":"1w","1m":"1m","1mo":"1m" };
  return map[ageFilter] || "24h";
}

app.post("/api/scrape", requireAuth, (_req, res) => {
  res.status(410).json({ error: "External scraping has been removed. Job search now uses /api/jobs." });
});

// Visited / Starred flags
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

// â”€â”€ Keyword analysis for a job (no generated resume needed) â”€â”€â”€â”€â”€â”€
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
    try {
      const parsed = JSON.parse(existingResume.ats_report);
      if (parsed?.source === LOCAL_ATS_SOURCE) return res.json(parsed);
    } catch {}
  }

  // Priority 2: reuse scrape-time ATS report when it already exists for this job.
  const scrapeTimeReport = db.prepare(
    "SELECT ats_report FROM scraped_jobs WHERE job_id=?"
  ).get(jobId);
  if (scrapeTimeReport?.ats_report) {
    try {
      const parsed = JSON.parse(scrapeTimeReport.ats_report);
      if (parsed?.source === LOCAL_ATS_SOURCE) return res.json(parsed);
    } catch {}
  }

  // Priority 3: return cached ats_only_reports entry (avoids re-running Haiku)
  const cached = db.prepare(
    "SELECT ats_report FROM ats_only_reports WHERE user_id=? AND job_id=?"
  ).get(userId, jobId);
  if (cached?.ats_report) {
    try {
      const parsed = JSON.parse(cached.ats_report);
      if (parsed?.source === LOCAL_ATS_SOURCE) return res.json(parsed);
    } catch {}
  }

  // Priority 4: fetch job + run the in-house deterministic scorer.
  const job = db.prepare("SELECT * FROM scraped_jobs WHERE job_id=?").get(jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const activeProfile = getOrRepairActiveProfile(userId);
  const signalProfile = activeProfile
    ? loadOrCreateSimpleApplyProfile(db, { userId, profileId: activeProfile.id })
    : null;
  try {
    const runtimeBasis = buildRuntimeAtsBasis({
      resumeText,
      signalProfile,
      domainProfile: activeProfile,
    });
    const result = scoreAtsLocally({ job, runtimeBasis });

    // Save to cache â€” INSERT OR REPLACE via ON CONFLICT
    db.prepare(`
      INSERT INTO ats_only_reports (user_id, job_id, ats_report, ats_score)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, job_id) DO UPDATE SET
        ats_report=excluded.ats_report,
        ats_score=excluded.ats_score,
        created_at=unixepoch()
    `).run(userId, jobId, JSON.stringify(result), result.score ?? null);

    res.json(result);
  } catch (e) {
    console.error("[keywords]", e.message);
    res.status(500).json({ error: "Keyword analysis failed" });
  }
});

// â”€â”€ Pending jobs (resume generated but not yet applied or disliked) â”€â”€
// GET /api/jobs/by-id/:jobId — resolve ONE posting, for a deep link.
//
// AH2 made a job detail addressable (/app/jobs?job=<id>), which needs a way to answer "give me that
// one job" for a tab that was opened straight onto the link. The board's own query cannot do it: it
// is paginated, profile-scoped and filtered, so whether a given posting is in the response depends
// on which page and which filters the tab happens to have restored. A deep link that resolves only
// when the job is coincidentally on the current page is the "wired to a no-op" failure mode, so it
// gets its own read.
//
// DELIBERATELY NOT profile-scoped and NOT is_active-filtered. The caller has named a specific
// posting; refusing it because the active profile classifies it into a different role, or because
// the listing has since closed, would answer a question nobody asked. mapJobRow exposes isActive so
// the panel can label a closed posting as closed. The user's own flags still come from the
// user_jobs row for the ACTIVE profile, which is the same join the board uses.
//
// `by-id` rather than /api/jobs/:id so it cannot be confused with the interaction routes that
// already own that shape (/api/jobs/:id/starred, /:id/visited, /:id/keywords).
app.get("/api/jobs/by-id/:jobId", requireAuth, (req, res) => {
  const userId  = req.user.id;
  const jobId   = String(req.params.jobId || "");
  if (!jobId) return res.status(400).json({ error: "jobId required" });
  const profile = getOrRepairActiveProfile(userId);
  const row = db.prepare(`
    SELECT ${buildSelectColumns(req.query.include_fields)},
           uj.visited, uj.applied, uj.starred, uj.disliked
    FROM scraped_jobs sj
    LEFT JOIN user_jobs uj
      ON uj.job_id = sj.job_id AND uj.user_id = ? AND uj.domain_profile_id = ?
    WHERE sj.job_id = ?
  `).get(userId, profile?.id ?? null, jobId);
  if (!row) return res.status(404).json({ error: "Job not found" });
  res.json({ success: true, job: { ...mapJobRow(row), scrapedAt: row.scraped_at } });
});

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
    WHERE sj.is_active = 1
      AND uj.resume_generated = 1
      AND r.html IS NOT NULL
      AND (uj.applied IS NULL OR uj.applied = 0)
      AND (uj.disliked IS NULL OR uj.disliked = 0)
      AND ${pendingProfileTitleFilter.sql}
    ORDER BY uj.updated_at DESC
  `).all(roleKey, userId, activeProfile.id, userId, ...pendingProfileTitleFilter.params);
  res.json(rows);
});

app.get("/api/categories", requireAuth, (_req,res) => res.json(INDUSTRY_CATEGORIES));

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// BASE RESUME
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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
    const enhanceMsg = await callModel({
      anthropic, db, purpose: "resume_enhance", userId: req.user.id,
      eventType: "resume_enhance", eventSubtype: "enhance",
      model: MODEL_SONNET,
      // thinking is explicit: Sonnet 5 runs ADAPTIVE thinking when the field is omitted, and
      // max_tokens caps thinking + response text together — so an omitted field would silently
      // spend this budget on reasoning and truncate the resume. This is a deterministic rewrite
      // task that ran with no thinking on Sonnet 4; keep that behaviour.
      thinking: { type: "disabled" },
      // 4000 -> 8000: Sonnet 5's tokenizer emits ~30% more tokens for the same text, so a
      // resume that fit in 4000 output tokens on Sonnet 4 can now overrun and truncate.
      max_tokens: 8000,
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
    const templateJd = "Software Engineer, Product Manager, Data Scientist, Data Engineer, Machine Learning Engineer";
    const scoreSignalProfile = loadOrCreateSimpleApplyProfile(db, {
      userId: req.user.id,
      profileId: profile.id,
    });
    const scoreFor = (resumeContent) => {
      try {
        const runtimeBasis = buildRuntimeAtsBasis({
          resumeText: resumeContent,
          signalProfile: scoreSignalProfile,
          domainProfile: profile,
        });
        return scoreAtsLocally({ job: { title: profile.profile_name, description: templateJd }, runtimeBasis });
      } catch { return null; }
    };

    const [origReport, enhReport] = [scoreFor(originalText), scoreFor(enhancedText)];
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

  // ADOPTING IS ONE ACT, so it is one transaction.
  //
  // These four writes used to run loose, in this order, with the destructive one first. When
  // markSelectedSuggestionsApplied threw — it called an undefined symbol and did so for every
  // adoption that had skills selected, which is every adoption the UI can reach — the base resume
  // had ALREADY been replaced. The candidate got a 500 for an operation that had half happened:
  // their resume overwritten, the suggestions still sitting at 'selected'.
  //
  // The symbol is fixed, but the ordering was what turned a typo into data loss. All of this is
  // synchronous better-sqlite3 work, so a transaction is available and nothing here can half-apply
  // again.
  const adopt = db.transaction(() => {
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
  });
  adopt();

  const userId = req.user.id;
  const profileId = profile.id;
  enqueueAtsScoreWork(`adopt-enhanced:${userId}:${profileId}`, async () => {
    try {
      const newContent = getBaseResumeRecord(db, { userId, profileId })?.content;
      if (!newContent) return;
      const signalProfile = loadOrCreateSimpleApplyProfile(db, { userId, profileId });
      const runtimeBasis = buildRuntimeAtsBasis({
        resumeText: newContent,
        signalProfile,
        domainProfile: profile,
      });

      const jobsToRescore = db.prepare(`
        SELECT sj.job_id, sj.description, sj.title, sj.company FROM scraped_jobs sj
        JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ? AND uj.domain_profile_id = ?
        WHERE sj.description IS NOT NULL
      `).all(userId, profileId);

      const updateAts = db.prepare("UPDATE scraped_jobs SET ats_score=?, ats_report=? WHERE job_id=?");

      for (let i = 0; i < jobsToRescore.length; i += 25) {
        const batch = jobsToRescore.slice(i, i + 25);
        await Promise.all(batch.map(async job => {
          try {
            const report = scoreAtsLocally({ job, runtimeBasis });
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

// POST /api/base-resume/enhance â€” legacy wrapper for the active profile
app.post("/api/base-resume/enhance", requireAuth, async (req, res) => {
  return await enhanceProfileResume(req, res);
});

// PATCH /api/base-resume/adopt-enhanced â€” legacy wrapper for the active profile
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
    const msg = await callModel({
      anthropic, db, purpose: "parse_pdf", userId: req.user.id,
      model: MODEL_SONNET,
      // See the enhance call site: explicit thinking:disabled + doubled budget, because Sonnet 5
      // thinks by default and its tokenizer is denser. A truncated extraction here silently
      // yields a partial resume, which is why this must not be left implicit.
      thinking: { type: "disabled" },
      max_tokens: 8000,
      messages:[{ role:"user", content:[
        { type:"document", source:{ type:"base64", media_type:"application/pdf", data:base64 } },
        { type:"text", text:"Extract all text from this resume PDF preserving section structure. Return plain text only, no commentary." },
      ]}],
    });
    const text = msg.content.map(b=>b.text||"").join("").trim();
    res.json({ text, chars:text.length });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// GENERATE
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const generationInFlight = new Set();
// Tracks in-flight apply-worker-triggered generations: key â†’ Promise<{html,atsScore,resumeId}|{error}>
const pendingGenerationPromises = new Map();

// â”€â”€ coreGenerateResume â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Shared generation kernel used by the HTTP /api/generate handler AND the apply
// worker via generateResumeForApply().  Does NOT do HTTP req/res or rate-limit
// checks â€” those live in the caller.  Throws on error; returns artifact on success.
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
    console.log(`[generate] domain from profile: ${activeDomainProfile.profile_name} â†’ ${domainModuleKey}`);
  } else {
    try {
      const classifierResult = await classify(anthropic, authoritativeResumeText, job.description || "", {
        db, userId, eventSubtype, jobId: String(jobId), company: job.company,
      });
      const qualKey = resolveFromClassifier(classifierResult, profile?.qualification_key);
      domainModuleKey = getDomainModuleKey(qualKey, classifierResult.roleFamily, classifierResult.domain);
    } catch(e) {
      console.warn("[generate] classifier failed, using general domain:", e.message);
    }
  }

  // AG2. Read fresh on every generation, so a claim made after an earlier resume was produced
  // affects the NEXT one and never reaches back into an artifact already saved.
  const profileClaims = activeDomainProfile
    ? listProfileClaims(db, { userId, profileId: activeDomainProfile.id })
    : null;

  // AI1. The summary is opt-in per job profile and defaults OFF, so a profile that predates the
  // column (or a generation with no active profile at all) gets no summary — the documented
  // default, not an accident of a NULL. The flag reaches the MODEL, not a post-processor: with it
  // off the SUMMARY rules are absent from the assembled prompt, so no summary is generated to
  // strip. Both tools route through here, so A+ and Generate honour it identically.
  const includeSummary = activeDomainProfile?.include_summary === 1;
  const runtimeInputs = buildRuntimeInputs(profile, job, authoritativeResumeText, promptMode, employers, activeDomainProfile, profileClaims);
  const { systemBlocks } = assemblePrompt(domainModuleKey, promptMode, runtimeInputs, { SUMMARY: includeSummary });

  const genStart = Date.now();
  const resumeMsg = await callModel({
    anthropic, db, purpose: "resume_generate", userId,
    eventType: "resume_generate", eventSubtype,
    jobId: String(jobId), company: job.company, domainModule: domainModuleKey,
    model: MODEL_SONNET,
    // See the enhance call site: Sonnet 5 thinks by default and max_tokens covers thinking +
    // output, so leaving this implicit would eat the HTML budget. Truncated HTML is especially
    // bad here — downstream code parses this into the submitted resume.
    thinking: { type: "disabled" },
    max_tokens: 8192,
    system: systemBlocks,
    messages: [{ role: "user", content: runtimeInputs }],
  });
  const html = resumeMsg.content.map(b => b.text || "").join("").replace(/```html|```/g, "").trim();

  let formattedHtml = normalizeResumeHtml(html);
  if (process.env.RESUME_MASTER_LLM_FORMAT === "1") {
    try {
      const FORMATTING_SYSTEM = `You are a resume HTML formatter. You receive a resume in any HTML format and reformat it to exactly match the design specification below. You output ONLY the final HTML â€” no commentary, no markdown fences, no explanation.

DESIGN SPECIFICATION:

All CSS lives in a <style> block in <head>. No inline styles. No external fonts, CDN links, or JavaScript. Include @media print block.

CSS variables (use these â€” no hardcoded hex):
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

Font: font-family: 'Garamond','EB Garamond',Georgia,serif â€” all text, no exceptions.

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
ul.bullets li::before { content: "â€¢"; position: absolute; left: -0.85em; }

.skills-table { width: 100%; border-collapse: collapse; font-size: var(--fs-body); }
.skill-label { font-weight: bold; white-space: nowrap; padding-right: 12pt; width: 1%; vertical-align: top; padding: 1.2pt 12pt 1.2pt 0; }
.skill-values { color: var(--color-text); padding: 1.2pt 0; }

@media print {
  body { margin: var(--margin-top) var(--margin-x) var(--margin-bot); }
  .entry { page-break-inside: avoid; }
  .section-title { page-break-after: avoid; }
}

RULES:
- Preserve ALL content exactly â€” every word, number, company name, date, bullet, skill
- Only restructure the HTML and CSS â€” never change the text content
- Apply the class names above to the correct elements
- Entry headers must be a single flex row â€” company on left, date on right
- Output only the complete HTML file, nothing else`;

      const fmtStart = Date.now();
      const formatMsg = await callModel({
        anthropic, db, purpose: "resume_format", userId,
        eventType: "resume_format", eventSubtype,
        jobId: String(jobId), company: job.company, domainModule: domainModuleKey,
        model: MODEL_HAIKU,
        max_tokens: 4096,
        system: [{ type: "text", text: FORMATTING_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: `Reformat this resume HTML to match the design specification exactly. Preserve all content:\n\n${html}` }],
      });
      const formatted = formatMsg.content.map(b => b.text || "").join("").replace(/```html|```/g, "").trim();
      if (formatted) formattedHtml = normalizeResumeHtml(formatted);
    } catch(e) {
      console.warn("[format] Formatting pass failed, using raw generation output:", e.message);
    }
  }

  // ── AF2: the JD may steer emphasis, never a quantity ───────────────────────────────────────────
  // Asserted HERE, before the artifact is persisted, scored or returned, so it covers BOTH callers:
  // the /api/generate handler where a human reads the result, and the apply worker where under
  // full-auto nobody does. A violation throws — see services/resumeClaimGuard.js on why this is a
  // failure and not a warning. The artifact is never written, so no later step can pick it up.
  // activeDomainProfile carries the seniority the candidate chose for this profile, which is the
  // authority on their level — without it the guard falls back to the base resume's wording, which
  // most resumes never state, and refuses every seniority word in the output.
  //
  // AI1. With the summary opt-in, the shape of the document this reads is no longer fixed, so what
  // the guard INSPECTED is logged next to what it found. The inflation check reads the whole
  // document and is unaffected by the summary's absence; the under-claim check reads the headline
  // region, which is the summary when there is one and the header block when there is not.
  // assertResumeClaims itself throws when the document text is empty, so "no violation" can never
  // mean "nothing was read".
  const claimCheck = assertResumeClaims({
    html: formattedHtml, profile, baseResumeText: authoritativeResumeText,
    domainProfile: activeDomainProfile,
  });
  console.log(
    `[generate] claim guard: inspected ${claimCheck.checked.inspected.documentChars} chars, ` +
    `headline region "${claimCheck.checked.inspected.headlineRegion}" ` +
    `(${claimCheck.checked.inspected.headlineChars} chars), summary ${includeSummary ? "on" : "off"}`
  );

  const resumeStripped = stripResumeHtml(formattedHtml);
  const activeProfile = getOrRepairActiveProfile(userId);
  const signalProfile = activeProfile
    ? loadOrCreateSimpleApplyProfile(db, { userId, profileId: activeProfile.id })
    : null;
  const runtimeBasis = buildRuntimeAtsBasis({
    resumeText: resumeStripped,
    signalProfile,
    domainProfile: activeProfile,
  });
  const atsReport = scoreAtsLocally({ job, runtimeBasis });
  const atsScore = atsReport.score;
  const atsCacheKey = buildAtsCacheKey(formattedHtml, job);

  const version = (db.prepare("SELECT MAX(version) as v FROM resume_versions WHERE user_id=? AND job_id=?")
    .get(userId, String(jobId))?.v || 0) + 1;
  const keptExists = !!db.prepare("SELECT 1 FROM resume_versions WHERE user_id=? AND job_id=? AND is_kept=1 LIMIT 1")
    .get(userId, String(jobId));
  db.prepare("INSERT INTO resume_versions (user_id,job_id,company,role,category,html,ats_score,ats_report,tool_type,is_kept,version,ats_cache_key,ats_prompt_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(userId, String(jobId), job.company, job.title, job.category, formattedHtml, atsScore, JSON.stringify(atsReport), tool, 0, version, atsCacheKey, ATS_SCORE_PROMPT_VERSION);
  if (!keptExists) {
    // AH5: domain_profile_id is STAMPED, so "was this artifact built for the profile that is
    // active now?" becomes a question the reuse rule can answer instead of assume.
    db.prepare(`INSERT INTO resumes (user_id,job_id,company,role,category,apply_mode,html,ats_score,ats_report,ats_cache_key,ats_prompt_version,domain_profile_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,unixepoch(),unixepoch())
      ON CONFLICT(user_id,job_id) DO UPDATE SET html=excluded.html,role=excluded.role,category=excluded.category,
      apply_mode=excluded.apply_mode,ats_score=excluded.ats_score,ats_report=excluded.ats_report,
      ats_cache_key=excluded.ats_cache_key,ats_prompt_version=excluded.ats_prompt_version,
      domain_profile_id=excluded.domain_profile_id,updated_at=excluded.updated_at`)
      .run(userId, String(jobId), job.company, job.title, job.category, mode, formattedHtml, atsScore, JSON.stringify(atsReport), atsCacheKey, ATS_SCORE_PROMPT_VERSION, activeDomainProfile?.id ?? null);
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

// â”€â”€ generateResumeForApply â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Called by the apply worker to resolve or trigger a resume artifact in the
// background.  Returns a Promise that resolves to { html, atsScore, resumeId }
// or { error: string }.  Multiple callers for the same (userId, jobId, tool)
// share the same in-flight Promise to prevent duplicate generation.
function generateResumeForApply(userId, jobId, toolType) {
  const tool = toolType === "a_plus_resume" ? "a_plus_resume" : "generate";
  const key  = `${userId}:${String(jobId)}:${tool}`;

  // 1. Existing artifact in DB — reused only when it is still CURRENT (AH5). It used to be reused
  //    unconditionally, so an artifact built for another profile, or before the base resume was
  //    rewritten, was silently sent to an employer.
  const currency = artifactCurrency(db, { userId, jobId, tool });
  if (currency.current) {
    return Promise.resolve({
      html: currency.artifact.html,
      atsScore: currency.artifact.ats_score ?? null,
      resumeId: currency.artifact.id,
      fromCache: true,
      reuse: { reused: true, reason: currency.reason },
    });
  }
  if (currency.artifact) {
    console.log(`[generateResumeForApply] regenerating job=${jobId}: ${currency.reason}` +
      (currency.detail ? ` (${currency.detail})` : ""));
  }

  // 2. In-flight Promise from another worker call â€” share it
  if (pendingGenerationPromises.has(key)) return pendingGenerationPromises.get(key);

  // 3. HTTP handler is already generating (generationInFlight) â€” poll DB until done
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

  // PER-USER GENERATION LIMIT, on the apply path too.
  //
  // checkLimit's LIMIT_MAP has carried `resume_generate` (daily_resumes / monthly_resumes) all
  // along, but it had exactly ONE call site — the HTTP /api/generate route — and this function
  // calls coreGenerateResume directly. coreGenerateResume's own header says it does no rate-limit
  // checks because "those live in the caller", and on this path the caller did not. So the apply
  // pipeline was the one generation path a user's plan limits did not apply to, and queueing is
  // what makes that expensive: a queued job generates a resume AND a cover letter before anything
  // is submitted or even approved.
  //
  // Deliberately placed AFTER the reuse and in-flight checks above: reusing a current artifact
  // costs nothing and must never be refused, and attaching to a generation already running is not
  // a new generation either. Only a genuinely new model call is metered.
  //
  // Returned in the SAME structured shape as an upstream failure, with errorPermanent:true — a
  // limit does not clear on retry the way a 529 does. processRunJob reads errorCode/errorDetail
  // into genFailure and files the job as held_review, so the run reports "you are at your limit"
  // against the job it happened to, instead of dying as a browser or generator error.
  const applyLimit = checkLimit(db, userId, "resume_generate");
  if (!applyLimit.allowed) {
    console.warn(`[generateResumeForApply] limit reached for user=${userId} job=${jobId}: ${applyLimit.reason}`);
    return Promise.resolve({
      error: applyLimit.reason,
      errorCode: "generation_limit_reached",
      errorDetail: applyLimit.reason,
      errorPermanent: true,
      limitReached: true,
      limitCurrent: applyLimit.current ?? null,
      limitValue: applyLimit.limit ?? null,
      limitPeriod: applyLimit.period ?? null,
    });
  }

  console.log(`[generateResumeForApply] starting background generation for user=${userId} job=${jobId} tool=${tool}`);
  const p = coreGenerateResume({ userId, jobId: String(jobId), job: jobRow, tool })
    .then(r => ({ html: r.html, atsScore: r.atsScore, resumeId: r.resumeId, fromCache: false }))
    // Keep the upstream failure STRUCTURED. This used to be `{ error: e.message }`, which threw
    // away the HTTP status, the API error type and the request_id — so a 404 on a retired model
    // and a transient 529 overload were the same opaque string to every caller downstream, and
    // nothing could tell "retrying is pointless" from "retry in a moment".
    .catch(e => {
      const f = classifyGenerationError(e);
      return {
        error: f.message,
        errorCode: f.code,
        errorStatus: f.status,
        errorType: f.apiType,
        errorRequestId: f.requestId,
        errorPermanent: f.permanent,
        errorIsDeadModel: f.isDeadModel,
        errorDetail: f.detail,
      };
    })
    .finally(() => pendingGenerationPromises.delete(key));
  pendingGenerationPromises.set(key, p);
  return p;
}

// ── generateCoverLetterForApply ───────────────────────────────────────────────
// Called by the apply worker to produce a JD-tailored cover letter for a job.
// Returns { html, text } on success, or { error } on any failure.
// Non-fatal: the worker logs cover_letter_unavailable and proceeds without it.
async function generateCoverLetterForApply(userId, jobId) {
  if (!ANTHROPIC_KEY) return { error: 'no_api_key' };

  const jobRow = db.prepare("SELECT * FROM scraped_jobs WHERE job_id=?").get(String(jobId));
  if (!jobRow) return { error: 'job_not_found' };

  const resumeRow = db.prepare(
    "SELECT html FROM resumes WHERE user_id=? ORDER BY updated_at DESC LIMIT 1"
  ).get(userId);
  const resumeText = resumeRow?.html
    ? resumeRow.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000)
    : '';
  if (!resumeText || resumeText.length < 50) return { error: 'no_resume_text' };

  const jd = (jobRow.description || '').slice(0, 2000);
  const targetLine = [jobRow.title, jobRow.company].filter(Boolean).join(' at ');

  const prompt = `You are an expert cover letter writer. Write a compelling, specific cover letter.

CANDIDATE RESUME:
${resumeText}

TARGET ROLE: ${targetLine || 'not specified'}

JOB DESCRIPTION:
${jd || 'Not provided — write a strong general cover letter based on the resume.'}

TONE: formal and professional

REQUIREMENTS:
- 3–4 paragraphs, under 400 words total
- Opening: hook that references the specific role or company (if known)
- Middle: 2 most relevant achievements from the resume, tied to the job requirements
- Closing: clear call to action and gratitude
- Do NOT repeat the resume verbatim — add context and personality
- Do NOT use clichés like "I am writing to express my interest"
- Do NOT use placeholders like [Company Name] or [Your Name]
- Begin directly with "Dear Hiring Manager," unless a name appears in the job description
- Plain text output only — no markdown, no bullet points`;

  try {
    const message = await callModel({
      anthropic, db, purpose: "cover_letter_apply", userId, jobId: String(jobId),
      model: MODEL_HAIKU,
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });
    const text = message.content?.[0]?.text || '';
    if (!text) return { error: 'empty_response' };
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:650px;margin:40px auto;line-height:1.6;font-size:14px;color:#222"><div style="white-space:pre-wrap">${escaped}</div></body></html>`;
    return { html, text };
  } catch (e) {
    console.error('[generateCoverLetterForApply] error:', e.message);
    return { error: e.message };
  }
}

app.post("/api/generate", requireAuth, async (req, res) => {
  const { jobId, job, resumeText, forceRegen } = req.body;
  // Strip excluded companies from employer list before any processing
  const employers = sanitiseEmployers(req.body.employers);
  if (!job||!resumeText) return res.status(400).json({ error:"job and resumeText required" });
  let tool = req.body?.tool === "a_plus_resume" ? "a_plus_resume" : "generate";
  // If the user has the admin-granted A+ flag, silently upgrade "generate" to A+ pipeline
  if (tool === "generate") {
    const userFlags = db.prepare("SELECT aplus_resume FROM users WHERE id=?").get(req.user.id);
    if (userFlags?.aplus_resume) tool = "a_plus_resume";
  }
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
    return res.status(400).json({ error:"Base resume data failed to load â€” placeholder text detected. Please re-upload your resume and try again." });
  }

  const existing = db.prepare("SELECT * FROM resumes WHERE user_id=? AND job_id=?").get(req.user.id, String(jobId));
  const existingVersion = db.prepare(`
    SELECT * FROM resume_versions
    WHERE user_id=? AND job_id=? AND tool_type=?
    ORDER BY version DESC, created_at DESC
    LIMIT 1
  `).get(req.user.id, String(jobId), tool);
  const cachedArtifact = existingVersion || (existing?.apply_mode === mode ? existing : null);

  // Company KB failsafe gate (Task 9.6) — additive only: flags/suggests, never rewrites the
  // resume, never blocks generation. Never let a validator bug break a real generate response.
  //
  // AF2 extends it INWARD: the same rule that flags a resume contradicting a company's KB flags one
  // contradicting the candidate's own profile. These findings are belt to the generation-time
  // assertion's braces — the assertion refuses a fresh violation, and this catches one in an
  // artifact CACHED before the assertion existed, which would otherwise be served unexamined.
  const kbFindingsFor = (html) => {
    let findings = [];
    try { findings = validateResumeClaims(db, html); }
    catch (e) { console.warn('[kb-failsafe] validation failed:', e.message); }
    try {
      const profile = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(req.user.id) || {};
      const activeDomainProfile = db.prepare(
        "SELECT * FROM domain_profiles WHERE user_id=? AND is_active=1"
      ).get(req.user.id);
      const base = activeDomainProfile
        ? getBaseResumeRecord(db, { userId: req.user.id, profileId: activeDomainProfile.id })
        : null;
      findings = findings.concat(
        profileContradictionFindings({
          html, profile, baseResumeText: base?.content || "", domainProfile: activeDomainProfile,
        })
      );
    } catch (e) { console.warn('[kb-failsafe] profile contradiction check failed:', e.message); }
    return findings;
  };

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
        kbFindings: kbFindingsFor(cachedArtifact.html),
      });
    }
    try {
      const cachedResumeText = stripResumeHtml(cachedArtifact.html);
      const activeProfile = getOrRepairActiveProfile(req.user.id);
      const signalProfile = activeProfile
        ? loadOrCreateSimpleApplyProfile(db, { userId: req.user.id, profileId: activeProfile.id })
        : null;
      const runtimeBasis = buildRuntimeAtsBasis({
        resumeText: cachedResumeText,
        signalProfile,
        domainProfile: activeProfile,
      });
      const freshReport = scoreAtsLocally({ job, runtimeBasis });
      const freshScoreVal = freshReport.score;
        db.prepare(
          "UPDATE resumes SET ats_score=?,ats_report=?,ats_cache_key=?,ats_prompt_version=?,updated_at=unixepoch() WHERE user_id=? AND job_id=?"
        ).run(freshScoreVal, JSON.stringify(freshReport), cachedAtsKey, ATS_SCORE_PROMPT_VERSION, req.user.id, String(jobId));
        if (existingVersion) {
          db.prepare("UPDATE resume_versions SET ats_score=?,ats_report=?,ats_cache_key=?,ats_prompt_version=? WHERE id=?")
            .run(freshScoreVal, JSON.stringify(freshReport), cachedAtsKey, ATS_SCORE_PROMPT_VERSION, existingVersion.id);
        }
      return res.json({
        html:cachedArtifact.html,
        atsScore:freshScoreVal,
        atsReport:freshReport,
        cached:true,
        atsCached:false,
        tool,
        toolLabel: tool === "a_plus_resume" ? "A+ Resume" : "Generate",
        version: cachedArtifact.version || existingVersion?.version || null,
        kbFindings: kbFindingsFor(cachedArtifact.html),
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
        kbFindings: kbFindingsFor(cachedArtifact.html),
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
    res.json({ html: result.html, atsScore: result.atsScore, atsReport: result.atsReport, cached:false, version: result.version, tool, toolLabel: tool === "a_plus_resume" ? "A+ Resume" : "Generate", kbFindings: kbFindingsFor(result.html) });
  } catch(e) { res.status(500).json({ error:e.message }); }
  finally { generationInFlight.delete(inFlightKey); }
});


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SANDBOX + PDF
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// RESUME HISTORY
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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
  // The DELETE was always correctly SCOPED — it could never remove another user's resume. What it
  // did do was answer {ok:true} for a job_id it had not touched, so a request aimed at somebody
  // else's resume was indistinguishable from a successful deletion of your own. Nothing leaked, but
  // nothing said so either, and "did that work?" is exactly the question an ownership check answers.
  const removed = db.prepare("DELETE FROM resumes WHERE user_id=? AND job_id=?")
    .run(req.user.id, req.params.jobId).changes;
  const removedVersions = db.prepare("DELETE FROM resume_versions WHERE user_id=? AND job_id=?")
    .run(req.user.id, req.params.jobId).changes;
  if (!removed && !removedVersions) return res.status(404).json({ error:"Resume not found" });
  res.json({ ok:true });
});
app.get("/api/history", requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT r.job_id,r.company,r.role,r.category,r.ats_score,r.apply_mode,r.updated_at,COUNT(v.id) as versions
    FROM resumes r LEFT JOIN resume_versions v ON v.user_id=r.user_id AND v.job_id=r.job_id
    WHERE r.user_id=? GROUP BY r.job_id ORDER BY r.updated_at DESC`).all(req.user.id);
  res.json(rows);
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// JOB APPLICATIONS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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
  // Same reasoning as DELETE /api/resumes/:jobId — scoped all along, but silent about whether the
  // row it was scoped to actually exists.
  const changed = db.prepare(`UPDATE job_applications SET ${set} WHERE user_id=? AND job_id=?`)
    .run(...vals, req.user.id, req.params.jobId).changes;
  if (!changed) return res.status(404).json({ error:"Application not found" });
  res.json({ ok:true });
});
app.delete("/api/applications/:jobId", requireAuth, (req, res) => {
  const removed = db.prepare("DELETE FROM job_applications WHERE user_id=? AND job_id=?")
    .run(req.user.id, req.params.jobId).changes;
  if (!removed) return res.status(404).json({ error:"Application not found" });
  res.json({ ok:true });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// EXCEL EXPORT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SMART SEARCH
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.post("/api/smart-search", requireAuth, async (req, res) => {
  const { resumeText } = req.body;
  if (!resumeText) return res.status(400).json({ error: "resumeText required" });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_KEY not configured" });
  try {
    const classifierResult = await classify(anthropic, resumeText, "", {
      db, userId: req.user.id, eventSubtype: "profile_setup",
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// LINKEDIN SESSION COOKIES (AES-256-GCM encrypted at rest)
// Future: use stored cookies to skip re-auth in HarvestAPI actor
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// APPLY AUTOMATION (Playwright)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
applyRoutes(app, db, requireAuth, buildAutofillPayload, generateResumeForApply, htmlToPdf, generateCoverLetterForApply);

// â”€â”€ Contact form (public â€” no auth required) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STANDALONE TOOL PAGES â€” AUTH INFRASTRUCTURE (Phase 5B)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Placeholder OTP store (in-memory; replace with Redis/DB in production)
const _otpStore = new Map(); // contact â†’ { otp, expiresAt }

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STANDALONE TOOL API ROUTES (Phase 5C)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// POST /api/standalone/ats â€” ATS scoring (no main-app auth required)
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
    const msg = await callModel({
      anthropic, db, purpose: "standalone_ats", userId: SYSTEM_USER_ID,
      model: MODEL_HAIKU,
      max_tokens: 900,
      system: ATS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: atsDynamic }],
    });
    const raw = msg.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
    const report = JSON.parse(raw);
    res.json(report);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/standalone/generate â€” Generate resume (no main-app auth)
app.post("/api/standalone/generate", standaloneRateLimit("generate", 1, 2), standaloneUpload.single("resume"), async (req, res) => {
  const jdText = req.body?.jd_text || "";
  if (!req.file || !jdText.trim()) return res.status(400).json({ error: "resume PDF and jd_text required" });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_KEY not configured" });

  try {
    const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
    const parsed = await pdfParse(req.file.buffer);
    const resumeText = parsed.text?.trim();
    if (!resumeText || resumeText.length < 50) return res.status(400).json({ error: "Could not extract text from PDF" });

    // No domain profile for standalone users â€” use classifier
    let domainModuleKey = "general";
    try {
      // Was the third classify() caller and the only one that passed no tracking context, so
      // its spend was invisible. Unauthenticated route — attributed to the system sentinel.
      const cr = await classify(anthropic, resumeText, jdText, {
        db, userId: SYSTEM_USER_ID, eventSubtype: "standalone",
      });
      const qk = resolveFromClassifier(cr, null);
      domainModuleKey = getDomainModuleKey(qk, cr.roleFamily, cr.domain);
    } catch {}

    const fakeJob = { title: "Role", company: "Company", description: jdText, category: "", stack: "" };
    // AI1. Standalone has no account and therefore no job profile to hold the preference, so the
    // request carries it and the DEFAULT IS THE SAME as the per-profile column's: off. Anything
    // else would give the two entry points different resumes for the same candidate. The value is
    // read strictly — only an explicit true turns the section on, so a client that omits the field
    // or sends something unexpected lands on the documented default rather than on a guess.
    const includeSummary = req.body?.include_summary === true || req.body?.include_summary === "true";
    const runtimeInputs = buildRuntimeInputs({}, fakeJob, resumeText, "GENERATE", []);
    const { systemBlocks } = assemblePrompt(domainModuleKey, "GENERATE", runtimeInputs, { SUMMARY: includeSummary });

    const resumeMsg = await callModel({
      anthropic, db, purpose: "standalone_generate", userId: SYSTEM_USER_ID,
      model: MODEL_SONNET,
      // See the enhance call site: explicit thinking:disabled + denser-tokenizer headroom.
      thinking: { type: "disabled" },
      max_tokens: 8192,
      system: systemBlocks,
      messages: [{ role: "user", content: runtimeInputs }],
    });
    const html = resumeMsg.content.map(b => b.text || "").join("").trim();

    // Quick ATS score
    const cachedText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    let atsScore = null;
    try {
      const atsMsg = await callModel({
        anthropic, db, purpose: "standalone_ats", userId: SYSTEM_USER_ID,
        model: MODEL_HAIKU, max_tokens: 900,
        system: ATS_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `JOB DESCRIPTION:\n${jdText}\n\nRESUME TEXT:\n${cachedText}` }],
      });
      const atsRaw = atsMsg.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
      atsScore = JSON.parse(atsRaw).score;
    } catch {}

    res.json({ html, atsScore });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/standalone/apply â€” auto-apply (requires standalone auth)
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ── Cover Letter Generation ────────────────────────────────────────────────────
app.post("/api/cover-letter/generate", requireAuth, async (req, res) => {
  const { resumeText, jobDescription, tone = "professional", jobTitle, company } = req.body;
  if (!resumeText) return res.status(400).json({ error: "resumeText is required" });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_KEY not configured on server." });

  const resumeTrimmed = resumeText.trim();
  if (resumeTrimmed.length < 50) {
    return res.status(400).json({ error: "Resume is too short to generate a cover letter." });
  }

  const toneMap = {
    professional: "formal and professional",
    conversational: "warm and personable while remaining professional",
    enthusiastic: "energetic and passionate about the opportunity",
  };
  const toneDesc = toneMap[tone] || toneMap.professional;

  const targetLine = [jobTitle, company].filter(Boolean).join(" at ");

  const prompt = `You are an expert cover letter writer. Write a compelling, specific cover letter.

CANDIDATE RESUME:
${resumeTrimmed.slice(0, 3000)}

TARGET ROLE: ${targetLine || "not specified"}

JOB DESCRIPTION:
${jobDescription ? String(jobDescription).slice(0, 2000) : "Not provided — write a strong general cover letter based on the resume."}

TONE: ${toneDesc}

REQUIREMENTS:
- 3–4 paragraphs, under 400 words total
- Opening: hook that references the specific role or company (if known)
- Middle: 2 most relevant achievements from the resume, tied to the job requirements
- Closing: clear call to action and gratitude
- Do NOT repeat the resume verbatim — add context and personality
- Do NOT use clichés like "I am writing to express my interest"
- Do NOT use placeholders like [Company Name] or [Your Name]
- Begin directly with "Dear Hiring Manager," unless a name appears in the job description
- Plain text output only — no markdown, no bullet points`;

  try {
    const message = await callModel({
      anthropic, db, purpose: "cover_letter", userId: req.user.id, company: company || null,
      model: MODEL_HAIKU,
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });
    const text = message.content?.[0]?.text || "";
    res.json({ success: true, coverLetter: text });
  } catch (err) {
    console.error("[cover-letter] Anthropic error:", err.message);
    res.status(500).json({ error: "Failed to generate cover letter. Please try again." });
  }
});

// HEALTH + SPA
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.get("/api/health", (_req,res) => res.json({ ok:true, time:new Date().toISOString() }));


// â”€â”€ Profile isolation diagnostic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

app.get("*", (_req, res) => {
  res.sendFile(path.join(CLIENT_DIST, "index.html"));
});

console.log(`[boot] binding HTTP listener on :${PORT}`);
app.listen(PORT, () => {
  console.log(`[server] Resume Master v5 on :${PORT}`);
  // Warm up browser availability probe in background so /api/integrations/status
  // returns a cached result without delay on first user request.
  console.log("[boot] scheduling background browser probe");
  probeBrowserAvailability().then(r => {
    if (r.available) console.log(`[server] browser ready â€” source=${r.source}`);
    else console.warn(`[server] browser unavailable â€” ${r.reasonCode}: ${r.error}`);
  }).catch(() => {});
  // Run startup cleanup to expire any stale jobs that accumulated while server was
  // down and the 03:00 cron window was missed.
  setImmediate(() => {
    console.log("[boot] running startup expired-jobs cleanup");
    try { runExpiredJobsCleanup(); }
    catch(e) { console.warn("[cleanup] startup cleanup failed:", e.message); }
  });
});




