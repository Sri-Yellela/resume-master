// Semi / "Autofill for Review" — does a manual-review run leave behind anything you can review?
//
// Reported from production: a queued manual-review run said "7 fields filled", showed no resume,
// gave no way to see which fields, and the link opened an empty form. CASE B in processRunJob
// returned before the audit block, so it discarded the three things autoApply had just produced —
// the resolved answers with provenance, the resume artifact id, and the screenshot of the filled
// form. Nothing was broken about producing them; nothing read them.
//
// This drives the REAL route against scripts/fakeAts.js and then reads the row back. No existing
// test covered CASE B: a3GuardsIntegration deliberately steers around it because semi opens a
// browser.
//
// Requires: node scripts/fakeAts.js
// Usage:    A1_RESUME=/path/to/any.pdf node scripts/a10SemiReviewAudit.mjs
import express from "express";
import Database from "better-sqlite3";
import fs from "node:fs";
import applyRoutes from "../routes/apply.js";

const ATS = "http://localhost:4599";
const RESUME_PDF = process.env.A1_RESUME;
if (!RESUME_PDF || !fs.existsSync(RESUME_PDF)) {
  console.error("Set A1_RESUME to an existing PDF path."); process.exit(1);
}

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'PRO');
  CREATE TABLE domain_profiles (id INTEGER PRIMARY KEY, user_id INTEGER, profile_name TEXT,
    role_family TEXT, domain TEXT, is_active INTEGER DEFAULT 0,
    generate_at_queue INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE user_profile (user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
    full_name TEXT, email TEXT, phone TEXT, custom_answers TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE user_integrations (user_id INTEGER, provider TEXT, status TEXT, account_email TEXT,
    updated_at INTEGER, last_checked_at INTEGER);
  CREATE TABLE profile_base_resumes (profile_id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT,
    content TEXT, enhanced_content TEXT, enhanced_at INTEGER, enhanced_ats_delta REAL, updated_at INTEGER);
  CREATE TABLE base_resume (user_id INTEGER PRIMARY KEY, name TEXT, content TEXT,
    enhanced_content TEXT, enhanced_at INTEGER, enhanced_ats_delta REAL, updated_at INTEGER);
  CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, title TEXT, company TEXT, url TEXT,
    apply_url TEXT, source TEXT, location TEXT);
  CREATE TABLE resumes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, job_id TEXT,
    company TEXT, role TEXT, apply_mode TEXT, ats_score INTEGER, html TEXT,
    created_at INTEGER, updated_at INTEGER);
  CREATE TABLE apply_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, mode TEXT,
    approval_mode TEXT, tool_type TEXT, status TEXT, total_jobs INTEGER, held_count INTEGER DEFAULT 0,
    submitted_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()), started_at INTEGER, finished_at INTEGER);
  CREATE TABLE apply_run_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, user_id INTEGER,
    approved_at INTEGER, approved_from_run_job_id INTEGER, job_id TEXT, status TEXT, reason_code TEXT,
    reason_detail TEXT, started_at INTEGER, finished_at INTEGER, created_at INTEGER DEFAULT (unixepoch()),
    answers_json TEXT, open_questions_json TEXT, resume_artifact_id INTEGER, resume_ats_score INTEGER,
    base_ats_score INTEGER, base_ats_json TEXT,
    screenshot_path TEXT, submit_verified INTEGER, submit_evidence TEXT,
    ats_score INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0, fields_discovered INTEGER, corrections_json TEXT, blanks_json TEXT, gate_review_json TEXT, hidden_at INTEGER, locked_at INTEGER, resume_file TEXT, resume_id INTEGER, UNIQUE(run_id, job_id));
  CREATE TABLE apply_job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, run_job_id INTEGER,
    user_id INTEGER, job_id TEXT, level TEXT DEFAULT 'info', event TEXT, message TEXT,
    details_json TEXT, created_at INTEGER DEFAULT (unixepoch()));
  CREATE TABLE job_applications (user_id INTEGER, job_id TEXT, company TEXT, role TEXT, job_url TEXT,
    source TEXT, location TEXT, apply_mode TEXT, resume_file TEXT, applied_at INTEGER, notes TEXT,
    auto_status TEXT, UNIQUE(user_id, job_id));
  CREATE TABLE user_jobs (user_id INTEGER, job_id TEXT, domain_profile_id INTEGER, applied INTEGER DEFAULT 0,
    updated_at INTEGER, UNIQUE(user_id, job_id));
  CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT (unixepoch()));
  CREATE TABLE apply_idempotency (user_id INTEGER NOT NULL, idem_key TEXT NOT NULL, endpoint TEXT NOT NULL,
    status_code INTEGER NOT NULL DEFAULT 200, response_json TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (user_id, idem_key));
  INSERT INTO users (id, username, plan_tier) VALUES (1, 'ada', 'PRO');
  INSERT INTO domain_profiles (id, user_id, profile_name, is_active) VALUES (10, 1, 'SWE', 1);
  INSERT INTO user_profile (user_id, first_name, last_name, email) VALUES (1, 'Ada', 'Lovelace', 'ada@example.com');
  INSERT INTO profile_base_resumes (profile_id, user_id, name, content, updated_at)
    VALUES (10, 1, 'r.txt', 'real resume text', unixepoch());
`);

// Greenhouse: multi-step, so the run genuinely fills fields across steps.
const APPLY_URL = `${ATS}/greenhouse?ats=boards.greenhouse.io`;
db.prepare(`INSERT INTO scraped_jobs (job_id, title, company, url, apply_url, source, location)
            VALUES ('gh1', 'Senior Engineer', 'FakeCo', ?, ?, 'greenhouse', 'Remote')`).run(APPLY_URL, APPLY_URL);

const buildAutofillPayload = () => ({
  field_map: {
    first_name: "Ada", last_name: "Lovelace", full_name: "Ada Lovelace",
    email: "ada@example.com", phone: "+1 555 0100", location: "Boston, MA",
    years_of_experience: "8", available_start_date: "2026-09-01",
  },
  handler_map: {},
  custom_answers: {},
});

// CASE B's own generation path: writes a `resumes` row and returns its id, exactly as the real
// generateResumeForApply does. Whether that id reaches apply_run_jobs is the thing under test.
const generateResumeForApply = async (userId, jobId) => {
  const html = "<html><body><h1>Ada Lovelace</h1><p>Generated for review.</p></body></html>";
  const id = db.prepare(`INSERT INTO resumes (user_id,job_id,company,role,apply_mode,ats_score,html,created_at,updated_at)
                         VALUES (?,?,?,?,'TAILORED',84,?,unixepoch(),unixepoch())`)
    .run(userId, jobId, "FakeCo", "Senior Engineer", html).lastInsertRowid;
  return { html, resumeId: id, atsScore: 84 };
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
applyRoutes(app, db, (q, r, n) => n(), buildAutofillPayload,
  generateResumeForApply,
  async () => fs.readFileSync(RESUME_PDF),          // htmlToPdf
  async () => ({ error: "not_needed" }));           // cover letter
const server = app.listen(0);
const url = `http://127.0.0.1:${server.address().port}`;

const post = (p, b) => fetch(`${url}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const get = (p) => fetch(`${url}${p}`).then(r => r.json());

async function waitForRuns(ms = 240000) {
  const t0 = Date.now();
  for (;;) {
    if (db.prepare("SELECT COUNT(*) n FROM apply_runs WHERE status IN ('queued','running')").get().n === 0) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise(r => setTimeout(r, 1000));
  }
}

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
};

console.log("=== a manual-review run, then what it left behind ===");
await fetch(`${ATS}/_reset`, { method: "POST" }).catch(() => {
  console.error(`Cannot reach ${ATS} — is scripts/fakeAts.js running?`); process.exit(1);
});

// "manual" is the client's word for review mode; startRun maps it to semi.
const run = await post("/api/apply/runs", { jobIds: ["gh1"], mode: "manual" }).then(r => r.json());
await waitForRuns();

const row = db.prepare("SELECT * FROM apply_run_jobs WHERE run_id=?").get(run.runId);
check("the job is held for review", row.status === "held_review" && row.reason_code === "manual_review",
  `status=${row.status} reason=${row.reason_code}`);
check("NOTHING was submitted", await fetch(`${ATS}/_submissions`).then(r => r.json()).then(j => j.count) === 0);

// The three things CASE B used to discard.
const answers = JSON.parse(row.answers_json || "[]");
check("the resolved answers are recorded, so you can see WHICH fields were filled",
  answers.length > 0, `${answers.length} answers`);
check("  ...each carrying the rule that produced it",
  answers.every(a => a.provenance !== undefined),
  answers.slice(0, 3).map(a => `${a.label || a.name}=${JSON.stringify(a.value)} (${a.provenance})`).join("; "));
check("the generated resume is linked to the run", row.resume_artifact_id != null,
  `artifact=${row.resume_artifact_id} ats=${row.resume_ats_score}`);
check("  ...and that row really exists in `resumes`",
  !!db.prepare("SELECT 1 FROM resumes WHERE id=?").get(row.resume_artifact_id));
check("a screenshot of the filled form is recorded", !!row.screenshot_path, row.screenshot_path || "(none)");
check("the screenshot file is actually on disk", !!row.screenshot_path && fs.existsSync(row.screenshot_path));

// And the surface a human reads it through.
const review = await get(`/api/apply/run-jobs/${row.id}/review`);
check("the review endpoint serves the answers", (review.answers || []).length === answers.length,
  `${(review.answers || []).length} answers`);
check("and reports the resume as available", review.resume?.available === true,
  JSON.stringify(review.resume));
check("and reports the screenshot as available", review.screenshotAvailable === true);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
server.close();
process.exit(failures === 0 ? 0 : 1);
