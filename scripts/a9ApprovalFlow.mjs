// Queue-then-approve — real-run verification.
//
// The whole point of the flow is a negative: an 'auto' run must reach the end of a real form, with a
// real resume attached and every field filled, and then NOT submit. A unit test cannot prove that —
// only a run against a real ATS that records what it received can. Everything here is asserted
// against GET /_submissions, never against status.
//
//   1. an auto run PREVIEWS      — form filled, gates run, ATS count stays 0
//   2. rejecting                 — still 0, nothing queued
//   3. approving                 — submits, exactly 1, and the run records that a human approved
//   4. drift                     — if the answers change after approval, it refuses to submit
//
// Requires: node scripts/fakeAts.js
// Usage:    A1_RESUME=/path/to/any.pdf node scripts/a9ApprovalFlow.mjs
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
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'BASIC');
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
    apply_mode TEXT, ats_score INTEGER, html TEXT, updated_at INTEGER);
  CREATE TABLE apply_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, mode TEXT, approval_mode TEXT,
    tool_type TEXT, status TEXT, total_jobs INTEGER, held_count INTEGER DEFAULT 0,
    submitted_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()), started_at INTEGER, finished_at INTEGER);
  CREATE TABLE apply_run_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, user_id INTEGER,
    approved_at INTEGER, approved_from_run_job_id INTEGER,
    job_id TEXT, status TEXT, reason_code TEXT, reason_detail TEXT, started_at INTEGER,
    finished_at INTEGER, created_at INTEGER DEFAULT (unixepoch()),
    answers_json TEXT, resume_artifact_id INTEGER, resume_ats_score INTEGER,
    base_ats_score INTEGER, base_ats_json TEXT,
    screenshot_path TEXT, submit_verified INTEGER, submit_evidence TEXT,
    open_questions_json TEXT,
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

// Ashby: single step, and it SUBMITS cleanly when fully answered — so "did not submit" is a real
// result here rather than the form having stopped for some other reason.
const APPLY_URL = `${ATS}/ashby?ats=jobs.ashbyhq.com`;
const seedJob = (jobId) => {
  db.prepare(`INSERT OR IGNORE INTO scraped_jobs (job_id, title, company, url, apply_url, source, location)
              VALUES (?, 'Platform Engineer', 'FakeCo', ?, ?, 'ashby', 'Remote')`).run(jobId, APPLY_URL, APPLY_URL);
  db.prepare(`INSERT INTO resumes (user_id, job_id, apply_mode, ats_score, html, updated_at)
              VALUES (1, ?, 'TAILORED', 80, '<html><body>resume</body></html>', unixepoch())`).run(jobId);
};
for (const id of ["ash1", "ash2", "ash3"]) seedJob(id);

const buildAutofillPayload = () => ({
  field_map: {
    first_name: "Ada", last_name: "Lovelace", full_name: "Ada Lovelace",
    email: "ada@example.com", phone: "+1 555 0100", location: "Boston, MA",
    website_url: "https://ada.dev", available_start_date: "2026-09-01",
  },
  handler_map: {},
  custom_answers: { "I am authorized to work without sponsorship": "yes" },
});

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
applyRoutes(app, db, (q, r, n) => n(), buildAutofillPayload,
  async () => ({ error: "not_needed" }),
  async () => fs.readFileSync(RESUME_PDF),
  async () => ({}));
const server = app.listen(0);
const url = `http://127.0.0.1:${server.address().port}`;

const post = (p, b) => fetch(`${url}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const get  = (p) => fetch(`${url}${p}`).then(r => r.json());
const resetAts = () => fetch(`${ATS}/_reset`, { method: "POST" }).then(r => r.json());
const atsCount = () => fetch(`${ATS}/_submissions`).then(r => r.json()).then(j => j.count);

async function waitForRuns(ms = 180000) {
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

await resetAts();

// ── 1. an auto run previews and does NOT submit ──────────────────────────────
console.log("\n=== 1. an 'auto' run fills the whole form and stops ===");
const run1 = await post("/api/apply/runs", { jobIds: ["ash1"], mode: "auto" }).then(r => r.json());
await waitForRuns();
const previewed = db.prepare("SELECT * FROM apply_run_jobs WHERE run_id=?").get(run1.runId);

check("the run recorded that approval is required",
  db.prepare("SELECT approval_mode m FROM apply_runs WHERE id=?").get(run1.runId).m === "required");
check("the job is parked awaiting approval",
  previewed.status === "held_review" && previewed.reason_code === "awaiting_approval",
  `status=${previewed.status} reason=${previewed.reason_code}`);
check("NOTHING reached the ATS", await atsCount() === 0, `count=${await atsCount()}`);
const previewAnswers = JSON.parse(previewed.answers_json || "[]");
check("the answers that WOULD be sent are recorded for review", previewAnswers.length > 0,
  `${previewAnswers.length} answers`);
check("the resume artifact is recorded", previewed.resume_artifact_id != null,
  `id=${previewed.resume_artifact_id}`);

const { pending } = await get("/api/apply/pending");
check("it appears in the pending list", pending.length === 1 && pending[0].runJobId === previewed.id,
  JSON.stringify(pending.map(p => ({ id: p.runJobId, answers: p.answerCount, guesses: p.guessCount }))));

// ── 2. rejecting submits nothing ─────────────────────────────────────────────
console.log("\n=== 2. rejecting ===");
const run2 = await post("/api/apply/runs", { jobIds: ["ash2"], mode: "auto" }).then(r => r.json());
await waitForRuns();
const toReject = db.prepare("SELECT * FROM apply_run_jobs WHERE run_id=?").get(run2.runId);
const rejected = await post("/api/apply/reject", { runJobIds: [toReject.id] });
check("reject succeeds", rejected.status === 200, `status=${rejected.status}`);
check("the job is dismissed",
  db.prepare("SELECT status FROM apply_run_jobs WHERE id=?").get(toReject.id).status === "dismissed");
check("still NOTHING reached the ATS", await atsCount() === 0, `count=${await atsCount()}`);

// ── 3. approving submits, exactly once ───────────────────────────────────────
console.log("\n=== 3. approving ===");
const approved = await post("/api/apply/approve", { runJobIds: [previewed.id] });
const approvedBody = await approved.json();
check("approve starts a run", approved.status === 202, `status=${approved.status}`);
await waitForRuns();

check("EXACTLY ONE submission reached the ATS", await atsCount() === 1, `count=${await atsCount()}`);
const submittedRun = db.prepare("SELECT * FROM apply_runs WHERE id=?").get(approvedBody.run.runId);
check("the run is marked as existing BECAUSE a human approved it",
  submittedRun.approval_mode === "approved", `approval_mode=${submittedRun.approval_mode}`);
const submittedJob = db.prepare("SELECT * FROM apply_run_jobs WHERE run_id=?").get(submittedRun.id);
check("the job submitted", submittedJob.status === "submitted",
  `status=${submittedJob.status} reason=${submittedJob.reason_code}`);
check("and the submission is VERIFIED, not merely clicked", submittedJob.submit_verified === 1,
  submittedJob.submit_evidence || "");
check("the preview row survives as the record of what was approved",
  db.prepare("SELECT status, approved_at FROM apply_run_jobs WHERE id=?").get(previewed.id).approved_at > 0);

// ── 4. drift — approval is about specific answers, not the job in general ────
console.log("\n=== 4. the answers change after approval ===");
await resetAts();
const run3 = await post("/api/apply/runs", { jobIds: ["ash3"], mode: "auto" }).then(r => r.json());
await waitForRuns();
const drifted = db.prepare("SELECT * FROM apply_run_jobs WHERE run_id=?").get(run3.runId);

// Rewrite what was "approved" so the submitting run resolves the form differently. This stands in
// for the real case: an employer editing the form between the preview and the submission.
const tampered = JSON.parse(drifted.answers_json).map(a =>
  a.name === "_systemfield_email" ? { ...a, value: "someone.else@example.com" } : a);
db.prepare("UPDATE apply_run_jobs SET answers_json=? WHERE id=?")
  .run(JSON.stringify(tampered), drifted.id);

const approved2 = await post("/api/apply/approve", { runJobIds: [drifted.id] }).then(r => r.json());
await waitForRuns();
const refused = db.prepare("SELECT * FROM apply_run_jobs WHERE run_id=?").get(approved2.run.runId);
check("the run REFUSES to submit what was not approved",
  refused.status === "held_review" && refused.reason_code === "answers_changed_since_approval",
  `status=${refused.status} reason=${refused.reason_code}`);
check("and nothing reached the ATS", await atsCount() === 0, `count=${await atsCount()}`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
server.close();
process.exit(failures === 0 ? 0 : 1);
