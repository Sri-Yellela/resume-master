// ============================================================
// server.js — Resume Master v5
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
import bcrypt         from "bcryptjs";
import puppeteer      from "puppeteer";
import multer         from "multer";
import ExcelJS        from "exceljs";
import crypto         from "crypto";
import { fileURLToPath } from "url";
import path           from "path";
import fs             from "fs";
import { createBackup, listBackups, restoreBackup } from "./scripts/backup.js";

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
const MAX_REFRESH_PER_DAY = 4;
const MAX_JOBS_PER_REFRESH= 50;

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

// ── Multer ────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  preservePath: true,
});

// ── Static master prompt (loaded once at startup) ─────────────
const MASTER_PROMPT_PATH = path.join(__dirname, "resume_masterprompt.md");
let MASTER_PROMPT_STATIC = "";
try {
  MASTER_PROMPT_STATIC = fs.readFileSync(MASTER_PROMPT_PATH, "utf8");
  console.log(`[prompt] Loaded — ${MASTER_PROMPT_STATIC.length} chars`);
} catch(e) {
  console.error("[prompt] WARNING: Could not load master prompt:", e.message);
}

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

function normaliseItem(raw, source) {
  const company =
    raw.companyName ||
    raw.company ||
    raw.employer?.name ||
    raw.employerName ||
    "";

  const title = raw.title || raw.jobTitle || "";

  const description =
    raw.descriptionText ||
    raw.description?.text ||
    (typeof raw.description === "string" ? raw.description : "") ||
    "";

  const location =
    (raw.location?.city && raw.location?.state
      ? `${raw.location.city}, ${raw.location.state}`
      : raw.location?.city || raw.location?.state ||
        (typeof raw.location === "string" ? raw.location : "")) ||
    raw.jobLocation ||
    "United States";

  let workTypeHint = "";
  if (Array.isArray(raw.workplaceTypes) && raw.workplaceTypes.length > 0) {
    workTypeHint = raw.workplaceTypes[0].toLowerCase();
  } else if (raw.workType) {
    workTypeHint = String(raw.workType).toLowerCase();
  }

  const url =
    raw.applyUrl ||
    raw.externalApplyUrl ||
    raw.jobUrl ||
    raw.url ||
    null;

  const postedAt =
    raw.listedAt ||
    raw.postedAt ||
    raw.datePosted ||
    raw.date ||
    null;

  const jobType =
    raw.jobType ||
    raw.employmentType ||
    raw.contractType ||
    "";

  return { _source:source, company, title, description, location, workTypeHint, url, postedAt, jobType };
}

function isFullTimeNorm(item) {
  const text = [item.title, item.jobType, item.description].join(" ").toLowerCase();
  return !NON_FULLTIME_TERMS.some(t => text.includes(t));
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
Description: ${description.slice(0,400)}

Reply with the category name only. No explanation.` }],
    });
    const raw = msg.content.map(b => b.text||"").join("").trim();
    const match = INDUSTRY_CATEGORIES.find(c => raw.toLowerCase().includes(c.toLowerCase()));
    return match || "Other";
  } catch { return "Other"; }
}

// ── Search query normaliser ───────────────────────────────────
const ROLE_ALIASES = {
  "swe":                      "Software Engineer",
  "software dev":             "Software Engineer",
  "software developer":       "Software Engineer",
  "mle":                      "Machine Learning Engineer",
  "ml engineer":              "Machine Learning Engineer",
  "ml":                       "Machine Learning Engineer",
  "ds":                       "Data Scientist",
  "data science":             "Data Scientist",
  "mle intern":               "Machine Learning Engineer",
  "sde":                      "Software Engineer",
  "sde2":                     "Software Engineer II",
  "sde1":                     "Software Engineer I",
  "frontend":                 "Frontend Engineer",
  "front end":                "Frontend Engineer",
  "front-end":                "Frontend Engineer",
  "backend":                  "Backend Engineer",
  "back end":                 "Backend Engineer",
  "back-end":                 "Backend Engineer",
  "fullstack":                "Full Stack Engineer",
  "full stack":               "Full Stack Engineer",
  "full-stack":               "Full Stack Engineer",
  "devops":                   "DevOps Engineer",
  "dev ops":                  "DevOps Engineer",
  "sre":                      "Site Reliability Engineer",
  "site reliability":         "Site Reliability Engineer",
  "pm":                       "Product Manager",
  "tpm":                      "Technical Program Manager",
  "em":                       "Engineering Manager",
  "de":                       "Data Engineer",
  "data eng":                 "Data Engineer",
  "nlp engineer":             "NLP Engineer",
  "cv engineer":              "Computer Vision Engineer",
  "computer vision":          "Computer Vision Engineer",
  "ai engineer":              "AI Engineer",
  "genai":                    "Generative AI Engineer",
  "gen ai":                   "Generative AI Engineer",
  "llm":                      "LLM Engineer",
  "rl engineer":              "Reinforcement Learning Engineer",
};

function normaliseSearchQuery(raw) {
  if (!raw) return "";
  const trimmed = raw.trim().replace(/\s+/g, " ");
  const lower   = trimmed.toLowerCase();
  if (ROLE_ALIASES[lower]) return ROLE_ALIASES[lower];
  return trimmed.replace(/\b\w/g, c => c.toUpperCase());
}

function checkRefreshQuota(userId) {
  const first = db.prepare(
    "SELECT MIN(refreshed_at) as first FROM refresh_log WHERE user_id=?"
  ).get(userId);
  if (!first?.first) return { allowed:true, used:0, remaining:MAX_REFRESH_PER_DAY };
  const windowStart = first.first;
  const windowEnd   = windowStart + 24 * 60 * 60;
  const now         = Math.floor(Date.now() / 1000);
  if (now > windowEnd) {
    db.prepare("DELETE FROM refresh_log WHERE user_id=?").run(userId);
    return { allowed:true, used:0, remaining:MAX_REFRESH_PER_DAY };
  }
  const count = db.prepare(
    "SELECT COUNT(*) as cnt FROM refresh_log WHERE user_id=? AND refreshed_at >= ?"
  ).get(userId, windowStart);
  const used = count?.cnt || 0;
  return { allowed:used < MAX_REFRESH_PER_DAY, used, remaining:MAX_REFRESH_PER_DAY - used, windowEnds:windowEnd };
}

// ── Scraping ──────────────────────────────────────────────────
function buildLinkedInUrl(query) {
  return `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(query)}&location=United%20States&f_TPR=r86400&f_JT=F&sortBy=DD`;
}

async function scrapeLinkedIn(query, token) {
  if (!token) throw new Error("No Apify token");
  const urls = [buildLinkedInUrl(query), buildLinkedInUrl(`${query} engineer`)];
  const res = await fetch(
    `https://api.apify.com/v2/acts/curious_coder~linkedin-jobs-scraper/runs?token=${token}`,
    { method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ urls, count:MAX_JOBS_PER_REFRESH, scrapeCompany:false }) }
  );
  if (!res.ok) throw new Error(`Apify LinkedIn: ${res.status}`);
  const { data } = await res.json();
  return pollApify(data?.id, data?.defaultDatasetId, token);
}

async function scrapeIndeed(query, token) {
  if (!token) throw new Error("No Apify token");
  // Actor: valig~indeed-jobs-scraper (correct slug — curious_coder/indeed-scraper does not exist)
  const res = await fetch(
    `https://api.apify.com/v2/acts/valig~indeed-jobs-scraper/runs?token=${token}`,
    { method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ query, country:"us", location:"United States", postedWithinDays:"1", count:MAX_JOBS_PER_REFRESH }) }
  );
  if (!res.ok) throw new Error(`Apify Indeed: ${res.status}`);
  const { data } = await res.json();
  return pollApify(data?.id, data?.defaultDatasetId, token);
}

async function pollApify(runId, datasetId, token) {
  if (!runId) throw new Error("No run ID");
  let status = "RUNNING", tries = 0;
  while (["RUNNING","READY"].includes(status)) {
    await new Promise(r => setTimeout(r, 6000));
    tries++;
    const poll = await (await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`)).json();
    status = poll.data?.status;
    if (tries > 70) throw new Error("Apify timeout");
  }
  if (status !== "SUCCEEDED") throw new Error(`Apify ended: ${status}`);
  const items = await (await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&limit=${MAX_JOBS_PER_REFRESH}&format=json`
  )).json();
  return Array.isArray(items) ? items : [];
}

async function scrapeJobs(query, apifyToken) {
  console.log(`[scrape] "${query}"`);
  const [liRes, inRes] = await Promise.allSettled([
    scrapeLinkedIn(query, apifyToken),
    scrapeIndeed(query, apifyToken),
  ]);

  const rawLi = liRes.status === "fulfilled" ? liRes.value : [];
  const rawIn = inRes.status === "fulfilled" ? inRes.value : [];

  if (liRes.status === "rejected") console.warn("[scrape] LinkedIn:", liRes.reason?.message);
  if (inRes.status === "rejected") console.warn("[scrape] Indeed:",   inRes.reason?.message);

  console.log(`[scrape] raw: LinkedIn=${rawLi.length} Indeed=${rawIn.length}`);

  const combined = [
    ...rawLi.map(j => normaliseItem(j, "LinkedIn")),
    ...rawIn.map(j => normaliseItem(j, "Indeed")),
  ];

  const seenHashes = new Set();
  const dbRows = db.prepare(
    "SELECT jobs_json FROM job_cache WHERE search_query=? ORDER BY scraped_at DESC LIMIT 3"
  ).all(query);
  for (const row of dbRows) {
    try {
      const prev = JSON.parse(row.jobs_json);
      if (Array.isArray(prev)) prev.forEach(j => { if (j._hash) seenHashes.add(j._hash); });
    } catch {}
  }

  const thisRunHashes = new Set();
  const filtered = combined.filter(item => {
    if (!item.title || !item.company) return false;
    if (!isFullTimeNorm(item)) return false;
    if (item.description.toLowerCase().includes("reposted")) return false;
    if (ghostJobScoreNorm(item) >= 4) return false;
    const h = jobHash(item);
    if (thisRunHashes.has(h)) return false;
    thisRunHashes.add(h);
    if (seenHashes.has(h)) return false;
    return true;
  });

  console.log(`[scrape] after filter: ${filtered.length} / ${combined.length}`);

  const classified = [];
  for (let i = 0; i < Math.min(filtered.length, MAX_JOBS_PER_REFRESH); i += 5) {
    const batch = filtered.slice(i, i + 5);
    const cats  = await Promise.all(
      batch.map(item => classifyJob(item.title, item.description))
    );
    batch.forEach((item, idx) => classified.push({ ...item, _category: cats[idx] }));
  }

  const repostCounts = {};
  for (const row of dbRows) {
    try {
      JSON.parse(row.jobs_json).forEach(j => {
        if (j._hash) repostCounts[j._hash] = (repostCounts[j._hash] || 0) + 1;
      });
    } catch {}
  }

  const now  = Date.now();
  const jobs = classified.map((item, i) => {
    const h = jobHash(item);
    return {
      id:        i + 1,
      jobId:     `scraped_${now}_${i}`,
      _hash:     h,
      company:   item.company,
      title:     item.title,
      category:  item._category,
      location:  item.location || "United States",
      workType:  inferWorkType(item.workTypeHint + " " + item.location + " " + item.description),
      source:    item._source,
      url:       item.url,
      postedAt:  item.postedAt,
      description: item.description.slice(0, 500),
      ghostScore:  ghostJobScoreNorm(item),
      isFrequentRepost: (repostCounts[h] || 0) >= 2,
    };
  });

  if (jobs.length > 0) {
    db.prepare("INSERT INTO job_cache (search_query,source,scraped_at,jobs_json) VALUES (?,?,?,?)")
      .run(query, "combined", now, JSON.stringify(jobs));
  }

  console.log(`[scrape] ✓ ${jobs.length} jobs saved`);
  return jobs;
}

// ── Cron: daily backup 02:00, re-scrape 07:00 ─────────────────
cron.schedule("0 2 * * *", () => {
  try { createBackup("auto-daily"); }
  catch(e) { console.error("[backup-cron]", e.message); }
});

cron.schedule("0 7 * * *", async () => {
  const last = db.prepare("SELECT search_query FROM job_cache ORDER BY scraped_at DESC LIMIT 1").get();
  if (!last) return;
  // Borrow the most recently active user's token for the daily background refresh
  const recent = db.prepare(
    "SELECT u.apify_token FROM refresh_log rl JOIN users u ON u.id=rl.user_id WHERE u.apify_token IS NOT NULL ORDER BY rl.refreshed_at DESC LIMIT 1"
  ).get();
  if (!recent?.apify_token) {
    console.log("[cron] Skipping daily re-scrape — no user Apify token available");
    return;
  }
  try { await scrapeJobs(last.search_query, recent.apify_token); }
  catch(e) { console.error("[cron]", e.message); }
});

// ── Prompt injection ──────────────────────────────────────────
function buildRuntimeInputs(profile, job, resumeText, mode, employers) {
  const userLocation = mode === "CUSTOM_SAMPLER" ? "" : (profile?.location||"");
  let employerBlock  = "";
  if (mode === "TAILORED" && employers?.length >= 2)
    employerBlock = `**Employer 1 (fixed):** ${employers[0]}\n**Employer 2 (fixed):** ${employers[1]}\n`;

  return `## RUNTIME INPUTS

**Mode:** ${mode}
**Candidate full name:** ${profile?.full_name||""}
**Phone:** ${profile?.phone||""}
**Email:** ${profile?.email||""}
**LinkedIn URL:** ${profile?.linkedin_url||""}
**GitHub URL:** ${profile?.github_url||""}
**User location (City, State):** ${userLocation}
${employerBlock}
**Target role / job title:** ${job.title}
**Target industry / domain:** ${job.category||"Software Engineering"}
**Target company:** ${job.company}
**Known tech stack of target company:** ${job.stack||"unknown"}

---

**TARGET JOB DESCRIPTION**
${job.description||job.title}

---

**BASE RESUME TEXT**
${resumeText}`;
}

function buildFullPrompt(profile, job, resumeText, mode, employers) {
  const runtimeInputs = buildRuntimeInputs(profile, job, resumeText, mode, employers);
  return MASTER_PROMPT_STATIC.replace(
    /## RUNTIME INPUTS[\s\S]*?---\n\n## SECTION 0/,
    runtimeInputs + "\n\n---\n\n## SECTION 0"
  );
}

function buildATSPrompt(html, job) {
  const text = html.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().slice(0,3000);
  return `Score this resume against the job. Reply ONLY with valid JSON, no markdown:
{"score":<0-100>,"tier1_matched":[...],"tier1_missing":[...],"strengths":[...],"improvements":[...],"verdict":"<one sentence>"}
JOB: ${job.company} — ${job.title} (${job.category})
RESUME: ${text}`;
}

// ── PDF ───────────────────────────────────────────────────────
async function htmlToPdf(html) {
  const browser = await puppeteer.launch({ args:["--no-sandbox","--disable-setuid-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil:"networkidle0" });
    return await page.pdf({
      format:"Letter", printBackground:true,
      margin:{ top:"0.4in", bottom:"0.4in", left:"0.4in", right:"0.4in" },
    });
  } finally { await browser.close(); }
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

  const nameParts = (profile?.full_name||"").trim().split(/\s+/).filter(Boolean);
  const firstName  = nameParts[0]  || "";
  const lastName   = nameParts.length > 1 ? nameParts[nameParts.length - 1] : "";
  const middleName = nameParts.length > 2 ? nameParts.slice(1, -1).join(" ") : "";

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
  return done(null, { id:user.id, username:user.username, isAdmin:!!user.is_admin, applyMode:user.apply_mode });
}));
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const user = db.prepare("SELECT id,username,is_admin,apply_mode FROM users WHERE id=?").get(id);
  user ? done(null, { id:user.id, username:user.username, isAdmin:!!user.is_admin, applyMode:user.apply_mode })
       : done(new Error("User not found"));
});

function requireAuth(req, res, next)  { if (req.isAuthenticated()) return next(); res.status(401).json({ error:"Unauthorized." }); }
function requireAdmin(req, res, next) { if (req.isAuthenticated()&&req.user.isAdmin) return next(); res.status(403).json({ error:"Forbidden." }); }

// ── Express ───────────────────────────────────────────────────
const app = express();
// trust proxy: required for Railway/Render — without this, secure: true cookies
// fail behind their HTTPS reverse proxy and all sessions silently break.
app.set("trust proxy", 1);
app.use(cors({ origin:true, credentials:true }));
app.use(express.json({ limit:"4mb" }));
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
    req.logIn(user, e => e ? next(e) : res.json({ ok:true, user:{ id:user.id, username:user.username, isAdmin:user.isAdmin, applyMode:user.applyMode } }));
  })(req, res, next);
});

app.post("/api/auth/register", (req, res) => {
  const { username, password, profile={}, apifyToken } = req.body;
  if (!username||!password) return res.status(400).json({ error:"username and password required" });
  if (password.length < 8)  return res.status(400).json({ error:"password must be at least 8 characters" });
  if (!profile.full_name)   return res.status(400).json({ error:"full name is required" });
  if (!profile.email)       return res.status(400).json({ error:"email is required" });
  try {
    db.prepare("INSERT INTO users (username,password_hash,is_admin,apply_mode) VALUES (?,?,0,'TAILORED')")
      .run(username, bcrypt.hashSync(password, 10));
    const newUser = db.prepare("SELECT id FROM users WHERE username=?").get(username);
    db.prepare(`INSERT INTO user_profile
      (user_id,full_name,email,phone,linkedin_url,github_url,location,
       address_line1,address_line2,city,state,zip,country,
       gender,ethnicity,veteran_status,disability_status,
       requires_sponsorship,has_clearance,clearance_level,visa_type,work_auth)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        newUser.id,
        profile.full_name||null, profile.email||null, profile.phone||null,
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
    res.json({ ok:true });
  } catch(e) {
    res.status(400).json({ error:e.message.includes("UNIQUE")?"Username already taken.":e.message });
  }
});

app.post("/api/auth/logout", (req, res) => req.logout(() => res.json({ ok:true })));

app.get("/api/auth/me", (req, res) =>
  req.isAuthenticated()
    ? res.json({ authenticated:true, user:{ id:req.user.id, username:req.user.username, isAdmin:req.user.isAdmin, applyMode:req.user.applyMode } })
    : res.json({ authenticated:false })
);

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
// Reset quota for any user by ID (admin only)
app.delete("/api/admin/users/:id/refresh-quota", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM refresh_log WHERE user_id=?").run(parseInt(req.params.id));
  res.json({ ok:true });
});
// Admin self-service quota reset (resets own quota without needing to know own ID)
app.delete("/api/admin/refresh-quota/reset", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM refresh_log WHERE user_id=?").run(req.user.id);
  res.json({ ok:true });
});

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
// JOBS
// ═══════════════════════════════════════════════════════════════
app.get("/api/jobs", requireAuth, (req, res) => {
  const raw        = (req.query.query||"").trim();
  const q          = normaliseSearchQuery(raw).toLowerCase();
  const ageFilter = req.query.ageFilter;
  const hideGhost = req.query.hideGhost === "true";
  const hideFlag  = req.query.hideFlag  === "true";

  const row = q
    ? db.prepare("SELECT * FROM job_cache WHERE LOWER(search_query)=? ORDER BY scraped_at DESC LIMIT 1").get(q)
    : db.prepare("SELECT * FROM job_cache ORDER BY scraped_at DESC LIMIT 1").get();
  if (!row) return res.json({ jobs:[], cacheValid:false, query:q });

  let jobs = JSON.parse(row.jobs_json);

  if (ageFilter) {
    const limits = { "1d":86400000,"2d":172800000,"3d":259200000,"1w":604800000,"1m":2592000000 };
    const limit  = limits[ageFilter];
    if (limit) jobs = jobs.filter(j => !j.postedAt||(Date.now()-new Date(j.postedAt).getTime())<=limit);
  }
  if (hideGhost) jobs = jobs.filter(j => (j.ghostScore||0) < 4);
  if (hideFlag)  jobs = jobs.filter(j => !j.isFrequentRepost);

  const profile = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(req.user.id)||{};
  if (!profile.has_clearance) {
    jobs = jobs.filter(j => {
      const d = (j.description||"").toLowerCase();
      return !d.includes("security clearance required")&&!d.includes("ts/sci")&&!d.includes("secret clearance");
    });
  }

  const appliedSet   = new Set(db.prepare("SELECT job_id FROM job_applications WHERE user_id=?").all(req.user.id).map(a=>a.job_id));
  const appliedCoSet = new Set(db.prepare("SELECT LOWER(company) as co FROM job_applications WHERE user_id=?").all(req.user.id).map(a=>a.co));
  jobs = jobs.map(j => ({
    ...j,
    alreadyApplied:       appliedSet.has(j.jobId),
    companyAppliedBefore: appliedCoSet.has((j.company||"").toLowerCase()),
  }));

  const age = Date.now() - row.scraped_at;
  res.json({ jobs, scrapedAt:row.scraped_at, cacheValid:age<CACHE_TTL_MS, expiresIn:Math.max(0,CACHE_TTL_MS-age), query:row.search_query });
});

app.post("/api/scrape", requireAuth, async (req, res) => {
  const raw   = (req.body.query||"").trim();
  const query = normaliseSearchQuery(raw);
  if (!query) return res.status(400).json({ error:"query required" });

  const quota = checkRefreshQuota(req.user.id);
  if (!quota.allowed) return res.status(429).json({
    error:`Daily refresh limit reached (${MAX_REFRESH_PER_DAY}/day).`, quota,
  });

  // Each user supplies their own Apify token — no server-level fallback
  const user  = db.prepare("SELECT apify_token FROM users WHERE id=?").get(req.user.id);
  const token = user?.apify_token;
  if (!token) return res.status(400).json({
    error:"No Apify token set. Open ☰ → API Keys and paste your personal Apify token. Get one free at console.apify.com → Settings → Integrations.",
    missingToken: true,
  });

  try {
    const jobs = await scrapeJobs(query, token);
    // Only charge a quota slot when the scrape actually returned results.
    // This prevents wasting daily refreshes on transient scraper errors.
    if (jobs.length > 0) {
      db.prepare("INSERT INTO refresh_log (user_id,query) VALUES (?,?)").run(req.user.id, query);
    }
    res.json({ ok:true, count:jobs.length, scrapedAt:Date.now(), query, quota:checkRefreshQuota(req.user.id) });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.get("/api/scrape/quota", requireAuth, (req, res) => res.json(checkRefreshQuota(req.user.id)));
app.get("/api/categories",   requireAuth, (_req,res) => res.json(INDUSTRY_CATEGORIES));

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
  const { jobId, job, resumeText, forceRegen, employers } = req.body;
  if (!job||!resumeText) return res.status(400).json({ error:"job and resumeText required" });
  const mode = req.user.applyMode;
  if (mode==="SIMPLE") return res.status(400).json({ error:"Generate not available in SIMPLE mode" });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error:"ANTHROPIC_KEY not configured on server." });

  const existing = db.prepare("SELECT * FROM resumes WHERE user_id=? AND job_id=?").get(req.user.id, String(jobId));
  if (existing&&!forceRegen)
    return res.json({ html:existing.html, atsScore:existing.ats_score, atsReport:JSON.parse(existing.ats_report||"null"), cached:true });

  const profile = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(req.user.id)||{};
  try {
    const fullPrompt = buildFullPrompt(profile, job, resumeText, mode, employers);
    const resumeMsg  = await anthropic.messages.create({
      model:"claude-sonnet-4-20250514", max_tokens:4096,
      messages:[{ role:"user", content:fullPrompt }],
    });
    const html = resumeMsg.content.map(b=>b.text||"").join("").replace(/```html|```/g,"").trim();

    const scoreMsg = await anthropic.messages.create({
      model:"claude-haiku-4-5-20251001", max_tokens:600,
      messages:[{ role:"user", content:buildATSPrompt(html,job) }],
    });
    let atsReport=null, atsScore=null;
    try {
      const raw = scoreMsg.content.map(b=>b.text||"").join("").replace(/```json|```/g,"").trim();
      atsReport = JSON.parse(raw); atsScore = atsReport.score;
    } catch {}

    const version = existing
      ? (db.prepare("SELECT MAX(version) as v FROM resume_versions WHERE user_id=? AND job_id=?").get(req.user.id,String(jobId))?.v||0)+1
      : 1;
    db.prepare("INSERT INTO resume_versions (user_id,job_id,company,role,category,html,ats_score,ats_report,version) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(req.user.id,String(jobId),job.company,job.title,job.category,html,atsScore,JSON.stringify(atsReport),version);
    db.prepare(`INSERT INTO resumes (user_id,job_id,company,role,category,apply_mode,html,ats_score,ats_report,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,unixepoch(),unixepoch())
      ON CONFLICT(user_id,job_id) DO UPDATE SET html=excluded.html,role=excluded.role,category=excluded.category,
      apply_mode=excluded.apply_mode,ats_score=excluded.ats_score,ats_report=excluded.ats_report,updated_at=excluded.updated_at`)
      .run(req.user.id,String(jobId),job.company,job.title,job.category,mode,html,atsScore,JSON.stringify(atsReport));

    res.json({ html, atsScore, atsReport, cached:false, version });
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
app.post("/api/export-pdf", requireAuth, async (req, res) => {
  const { html, filename } = req.body;
  if (!html) return res.status(400).json({ error:"html required" });
  try {
    const pdf = await htmlToPdf(html);
    res.set({
      "Content-Type":"application/pdf",
      "Content-Disposition":`attachment; filename="${filename||"resume"}.pdf"`,
      "Content-Length":pdf.length,
    });
    res.send(pdf);
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.get("/api/resumes/:jobId/pdf", requireAuth, async (req, res) => {
  const row = db.prepare("SELECT * FROM resumes WHERE user_id=? AND job_id=?").get(req.user.id, req.params.jobId);
  if (!row) return res.status(404).json({ error:"Not found" });
  try {
    const pdf = await htmlToPdf(row.html);
    res.set({
      "Content-Type":"application/pdf",
      "Content-Disposition":`attachment; filename="Resume_${row.company.replace(/\s+/g,"_")}.pdf"`,
      "Content-Length":pdf.length,
    });
    res.send(pdf);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// RESUME HISTORY
// ═══════════════════════════════════════════════════════════════
app.get("/api/resumes", requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT r.*,COUNT(v.id) as versions FROM resumes r
    LEFT JOIN resume_versions v ON v.user_id=r.user_id AND v.job_id=r.job_id
    WHERE r.user_id=? GROUP BY r.id ORDER BY r.updated_at DESC`).all(req.user.id);
  res.json(rows.map(r=>({...r,atsReport:JSON.parse(r.ats_report||"null")})));
});
app.get("/api/resumes/:jobId", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM resumes WHERE user_id=? AND job_id=?").get(req.user.id, req.params.jobId);
  if (!row) return res.status(404).json({ error:"Not found" });
  res.json({...row,atsReport:JSON.parse(row.ats_report||"null")});
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
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.get("/api/applications", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM job_applications WHERE user_id=? ORDER BY applied_at DESC").all(req.user.id));
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
// HEALTH + SPA
// ═══════════════════════════════════════════════════════════════
app.get("/api/health", (_req,res) => res.json({ ok:true, time:new Date().toISOString() }));

app.get("*", (req, res) => {
  const index = path.join(CLIENT_DIST,"index.html");
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(404).send("Run: cd client && npm run build");
});

app.listen(PORT, () => console.log(`[server] Resume Master v5 on :${PORT}`));
