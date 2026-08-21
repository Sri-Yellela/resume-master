import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import Database from "better-sqlite3";
import applyRoutes from "../routes/apply.js";

// The auto-apply surface moved OUT of JobsPanel (W5): its markup is now panels/AutoApplyPanel.jsx
// and its state and requests are contexts/AutoApplyContext.jsx, both reached from the AUTO APPLY
// tab. The assertions below are about the apply UI, not about which file holds it, so this reads
// all three. JobsPanel stays in the list because the board still owns the queue button that feeds
// the pipeline — and because an assertion that silently stopped covering anything would be worse
// than one that fails.
const jobsPanel = [
  "client/src/panels/JobsPanel.jsx",
  "client/src/panels/AutoApplyPanel.jsx",
  "client/src/contexts/AutoApplyContext.jsx",
].map(f => fs.readFileSync(f, "utf8")).join("\n");

// GET /api/apply/runs and /runs/:id returned raw DB rows — snake_case, seconds-epoch timestamps,
// and no join to scraped_jobs. The panel reads camelCase and renders `new Date(...)`, so a review
// row showed a status pill and nothing else (no title, company, reason or ATS score) and the run
// chips rendered "undefined✓". Each side was self-consistent; only the pairing was wrong, which is
// why these are contract tests and not assertions on one side alone.

function setup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'PRO');
    CREATE TABLE user_profile (user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
      full_name TEXT, email TEXT, phone TEXT, custom_answers TEXT);
    CREATE TABLE domain_profiles (id INTEGER PRIMARY KEY, user_id INTEGER, profile_name TEXT,
      role_family TEXT, domain TEXT, is_active INTEGER DEFAULT 0);
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
    CREATE TABLE apply_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, mode TEXT,
      approval_mode TEXT, tool_type TEXT, status TEXT, total_jobs INTEGER, held_count INTEGER DEFAULT 0,
      submitted_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()), started_at INTEGER, finished_at INTEGER);
    CREATE TABLE apply_run_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, user_id INTEGER,
      approved_at INTEGER, approved_from_run_job_id INTEGER, job_id TEXT, status TEXT, reason_code TEXT,
      reason_detail TEXT, started_at INTEGER, finished_at INTEGER, created_at INTEGER DEFAULT (unixepoch()),
      answers_json TEXT, open_questions_json TEXT, resume_artifact_id INTEGER, resume_ats_score INTEGER,
      screenshot_path TEXT, submit_verified INTEGER, submit_evidence TEXT, UNIQUE(run_id, job_id));
    CREATE TABLE apply_job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, run_job_id INTEGER,
      user_id INTEGER, job_id TEXT, level TEXT, event TEXT, message TEXT, details_json TEXT,
      created_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE job_applications (user_id INTEGER, job_id TEXT, company TEXT, role TEXT, job_url TEXT,
      source TEXT, location TEXT, apply_mode TEXT, resume_file TEXT, applied_at INTEGER, notes TEXT,
      auto_status TEXT, UNIQUE(user_id, job_id));
    CREATE TABLE user_jobs (user_id INTEGER, job_id TEXT, domain_profile_id INTEGER, applied INTEGER DEFAULT 0,
      updated_at INTEGER, UNIQUE(user_id, job_id));
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE apply_idempotency (user_id INTEGER NOT NULL, idem_key TEXT NOT NULL, endpoint TEXT NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 200, response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (user_id, idem_key));

    INSERT INTO users (id, username) VALUES (1, 'u1');
    INSERT INTO scraped_jobs (job_id, title, company, apply_url)
      VALUES ('gh1', 'Forward Deployed Engineer', 'Figma', 'https://boards.greenhouse.io/figma/jobs/1');
    INSERT INTO apply_runs (id, user_id, mode, status, total_jobs, submitted_count, held_count,
      failed_count, created_at, started_at, finished_at)
      VALUES (1, 1, 'auto', 'completed', 2, 1, 1, 0, 1700000000, 1700000010, 1700000200);
    INSERT INTO apply_run_jobs (id, run_id, user_id, job_id, status, reason_code, reason_detail,
      resume_artifact_id, resume_ats_score, screenshot_path, submit_verified, submit_evidence,
      started_at, finished_at)
      VALUES (1, 1, 1, 'gh1', 'held_review', 'incomplete_form', 'missing 2 fields',
        7, 82, '/tmp/shot.png', 0, NULL, 1700000010, 1700000100);
    -- an application whose posting has since been expired by the 7-day cleanup
    INSERT INTO apply_run_jobs (id, run_id, user_id, job_id, status, reason_code)
      VALUES (2, 1, 1, 'gone-from-board', 'held_review', 'low_confidence_answers');
    INSERT INTO apply_job_logs (run_id, run_job_id, user_id, job_id, level, event, message, created_at)
      VALUES (1, 1, 1, 'gh1', 'info', 'fields_filled', '7 fields filled', 1700000050);
  `);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
  const noop = async () => ({});
  applyRoutes(app, db, (req, _res, next) => next(), noop, noop, noop, noop);
  const server = app.listen(0);
  return { db, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => { server.close(); db.close(); } };
}

test("every review-row field the panel renders exists in the payload", async () => {
  const t = setup();
  try {
    const { review } = await (await fetch(`${t.baseUrl}/api/apply/runs`)).json();
    const row = review.find(r => r.jobId === "gh1");

    // Each of these is read by name in the row renderer. Before the fix all of them were undefined
    // and the row rendered as a bare status pill.
    assert.equal(row.title, "Forward Deployed Engineer");
    assert.equal(row.company, "Figma");
    assert.equal(row.reasonCode, "incomplete_form");
    assert.equal(row.reasonDetail, "missing 2 fields");
    assert.equal(row.atsScore, 82);
    assert.equal(row.applyUrl, "https://boards.greenhouse.io/figma/jobs/1");
    assert.equal(row.resumeAvailable, true, "the row offers a Resume PDF link off this flag");
    assert.equal(row.screenshotAvailable, true);
  } finally { t.close(); }
});

test("timestamps are milliseconds, because the panel calls new Date() on them", async () => {
  const t = setup();
  try {
    const { review, runs } = await (await fetch(`${t.baseUrl}/api/apply/runs`)).json();
    const row = review.find(r => r.jobId === "gh1");
    // Seconds would render as 1970 — a plausible-looking date that is silently wrong.
    assert.equal(row.startedAt, 1700000010 * 1000);
    assert.equal(new Date(row.startedAt).getUTCFullYear(), 2023);
    assert.equal(runs[0].startedAt, 1700000010 * 1000);
  } finally { t.close(); }
});

test("an application outlives its posting rather than rendering as a blank row", async () => {
  // The 7-day cleanup deletes scraped_jobs rows; the applications that targeted them remain. A
  // JOIN would drop these entirely, and the old payload left them with no identifying field at all.
  const t = setup();
  try {
    const { review } = await (await fetch(`${t.baseUrl}/api/apply/runs`)).json();
    const orphan = review.find(r => r.jobId === "gone-from-board");
    assert.ok(orphan, "the application must still be listed");
    assert.equal(orphan.title, null);
    assert.equal(orphan.jobId, "gone-from-board", "the panel falls back to this so the row is never blank");
  } finally { t.close(); }
});

test("run summary counts use the names the chips read", async () => {
  const t = setup();
  try {
    const { runs } = await (await fetch(`${t.baseUrl}/api/apply/runs`)).json();
    const run = runs[0];
    // `{run.submittedCount}✓` rendered "undefined✓" against snake_case rows.
    assert.equal(run.submittedCount, 1);
    assert.equal(run.heldCount, 1);
    assert.equal(run.failedCount, 0);
    assert.equal(run.status, "completed");
  } finally { t.close(); }
});

test("the panel checks the status string the server actually writes", () => {
  // The server writes 'completed'; the chip tested for 'complete', so the dot never turned green.
  assert.match(jobsPanel, /run\.status === "completed"/);
  assert.ok(!/run\.status === "complete"[^d]/.test(jobsPanel), "the truncated spelling must be gone");
});

test("run detail names the job on every log line", async () => {
  const t = setup();
  try {
    const body = await (await fetch(`${t.baseUrl}/api/apply/runs/1`)).json();
    const log = body.logs[0];
    assert.equal(log.message, "7 fields filled");
    // Without these the line said "7 fields filled" and nothing about which application.
    assert.equal(log.company, "Figma");
    assert.equal(log.title, "Forward Deployed Engineer");
    assert.equal(log.createdAt, 1700000050 * 1000);
    assert.equal(body.run.submittedCount, 1, "run detail uses the same shape as the list");
    assert.equal(body.jobs[0].title, "Forward Deployed Engineer");
  } finally { t.close(); }
});

// ── the surface ──────────────────────────────────────────────────────────────

test("the panel polls while a run is in flight, and only then", () => {
  assert.match(jobsPanel, /runInFlight/);
  assert.match(jobsPanel, /r\.status === "queued" \|\| r\.status === "running"/);
  // An unconditional interval would poll an idle board forever.
  assert.match(jobsPanel, /if \(!user \|\| !runInFlight\) return;/);
});

test("a row says whether a resume exists, either way", () => {
  assert.match(jobsPanel, /job\.resumeAvailable/);
  assert.match(jobsPanel, /no resume generated/);
  assert.match(jobsPanel, /artifactUrl\(job\.id, "resume"\)/);
});
