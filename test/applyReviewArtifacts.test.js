import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import applyRoutes from "../routes/apply.js";

// Review artifacts, over real HTTP against an in-memory DB.
//
// A3 persisted the whole record of an application — answers with A2's provenance, the resume artifact
// id, the screenshot, the submit evidence — and none of it was reachable over HTTP, so an application
// could not actually be reviewed. These cover the three read endpoints that serve it, and the two
// things that make serving it safe: ownership on every row, and confining screenshot_path to the
// screenshot directory.

const SCREENSHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "screenshots");

const ANSWERS = [
  { name: "email", label: "Email", value: "ada@example.com", provenance: "field_map_exact", confidence: 0.9 },
  { name: "legal_name", label: "Legal Name", value: "A. Lovelace", provenance: "label_fuzzy", confidence: 0.3 },
];

function setup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'PRO');
    CREATE TABLE user_profile (user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
      full_name TEXT, email TEXT, phone TEXT);
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
    CREATE TABLE apply_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, mode TEXT, approval_mode TEXT,
      tool_type TEXT, status TEXT, total_jobs INTEGER, created_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE apply_run_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, user_id INTEGER, approved_at INTEGER, approved_from_run_job_id INTEGER,
      job_id TEXT, status TEXT, reason_code TEXT, reason_detail TEXT, created_at INTEGER DEFAULT (unixepoch()),
      answers_json TEXT, open_questions_json TEXT, resume_artifact_id INTEGER, resume_ats_score INTEGER,
      screenshot_path TEXT, submit_verified INTEGER, submit_evidence TEXT, hidden_at INTEGER, UNIQUE(run_id, job_id));
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

    INSERT INTO users (id, username) VALUES (1, 'u1'), (2, 'u2');
    INSERT INTO scraped_jobs (job_id, title, company) VALUES ('gh1', 'Senior Engineer', 'Figma');
    INSERT INTO resumes (id, user_id, job_id, ats_score, html) VALUES (7, 1, 'gh1', 82, '<h1>Ada</h1>');
    -- artifact belonging to SOMEONE ELSE, referenced by user 1's run job below
    INSERT INTO resumes (id, user_id, job_id, ats_score, html) VALUES (8, 2, 'gh1', 70, '<h1>Not yours</h1>');
    INSERT INTO apply_runs (id, user_id, mode, status, total_jobs) VALUES (1, 1, 'auto', 'finished', 1);
  `);

  const insertJob = (over = {}) => {
    const row = {
      run_id: 1, user_id: 1, job_id: "gh1", status: "submitted", reason_code: null,
      answers_json: JSON.stringify(ANSWERS), open_questions_json: null,
      resume_artifact_id: 7, resume_ats_score: 82, screenshot_path: null,
      submit_verified: 1, submit_evidence: "confirmation_page,url_changed", ...over,
    };
    return db.prepare(`
      INSERT INTO apply_run_jobs (run_id, user_id, job_id, status, reason_code, answers_json,
        open_questions_json, resume_artifact_id, resume_ats_score, screenshot_path,
        submit_verified, submit_evidence)
      VALUES (@run_id, @user_id, @job_id, @status, @reason_code, @answers_json,
        @open_questions_json, @resume_artifact_id, @resume_ats_score, @screenshot_path,
        @submit_verified, @submit_evidence)
    `).run(row).lastInsertRowid;
  };

  let pdfShouldThrow = false;
  const htmlToPdf = async (html) => {
    if (pdfShouldThrow) throw new Error("Could not find Chromium");
    return Buffer.from("%PDF-1.4\n" + html);
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
  const noop = async () => ({});
  applyRoutes(app, db, (req, _res, next) => next(), noop, noop, htmlToPdf, noop);
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    db, baseUrl, insertJob,
    setPdfThrows: (v) => { pdfShouldThrow = v; },
    close: () => { server.close(); db.close(); },
  };
}

// ── the record of what was sent ──────────────────────────────────────────────

test("the review record exposes every answer with the rule that produced it", async () => {
  const t = setup();
  try {
    const id = t.insertJob();
    const r = await fetch(`${t.baseUrl}/api/apply/run-jobs/${id}/review`);
    assert.equal(r.status, 200);
    const body = await r.json();

    assert.equal(body.answers.length, 2);
    // The whole reason for surfacing this: a guess and an exact mapping must not look alike.
    assert.equal(body.answers[0].provenance, "field_map_exact");
    assert.equal(body.answers[1].provenance, "label_fuzzy");
    assert.equal(body.answers[1].confidence, 0.3);

    assert.deepEqual(body.resume, { artifactId: 7, atsScore: 82, available: true });
    assert.deepEqual(body.submission, { verified: true, evidence: "confirmation_page,url_changed" });
    assert.equal(body.company, "Figma");
    assert.equal(body.title, "Senior Engineer");
    assert.equal(body.screenshotAvailable, false);
  } finally { t.close(); }
});

test("a run job belonging to another user is not readable", async () => {
  const t = setup();
  try {
    const id = t.insertJob({ user_id: 2 });
    for (const suffix of ["review", "resume", "screenshot"]) {
      const r = await fetch(`${t.baseUrl}/api/apply/run-jobs/${id}/${suffix}`);
      assert.equal(r.status, 404, `${suffix} must not leak another user's application`);
    }
  } finally { t.close(); }
});

test("a non-numeric run job id is rejected rather than reaching the query", async () => {
  const t = setup();
  try {
    const r = await fetch(`${t.baseUrl}/api/apply/run-jobs/not-an-id/review`);
    assert.equal(r.status, 404);
  } finally { t.close(); }
});

// ── the resume ───────────────────────────────────────────────────────────────

test("the resume is served as a PDF, re-rendered from the stored artifact", async () => {
  const t = setup();
  try {
    const id = t.insertJob();
    const r = await fetch(`${t.baseUrl}/api/apply/run-jobs/${id}/resume`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/pdf");
    assert.match(r.headers.get("content-disposition"), /^inline; filename="resume-gh1\.pdf"$/);
    const body = Buffer.from(await r.arrayBuffer());
    assert.ok(body.toString().startsWith("%PDF-1.4"), "must be a PDF");
    assert.ok(body.toString().includes("<h1>Ada</h1>"), "rendered from THIS user's artifact");
  } finally { t.close(); }
});

test("?download switches the disposition to an attachment", async () => {
  const t = setup();
  try {
    const id = t.insertJob();
    const r = await fetch(`${t.baseUrl}/api/apply/run-jobs/${id}/resume?download=1`);
    assert.match(r.headers.get("content-disposition"), /^attachment;/);
  } finally { t.close(); }
});

test("an application with no recorded artifact says so, rather than serving nothing", async () => {
  const t = setup();
  try {
    const id = t.insertJob({ resume_artifact_id: null });
    const r = await fetch(`${t.baseUrl}/api/apply/run-jobs/${id}/resume`);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, "no_resume_artifact");
  } finally { t.close(); }
});

test("a foreign-key to another user's resume does not serve that resume", async () => {
  const t = setup();
  try {
    // artifact 8 belongs to user 2. Trusting the foreign key alone would hand it over.
    const id = t.insertJob({ resume_artifact_id: 8 });
    const r = await fetch(`${t.baseUrl}/api/apply/run-jobs/${id}/resume`);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, "resume_artifact_missing");
  } finally { t.close(); }
});

test("a browser-less host reports the render as unavailable, not the resume as missing", async () => {
  const t = setup();
  try {
    const id = t.insertJob();
    t.setPdfThrows(true);
    const r = await fetch(`${t.baseUrl}/api/apply/run-jobs/${id}/resume`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, "pdf_render_failed");
  } finally { t.close(); }
});

// ── the screenshot ───────────────────────────────────────────────────────────

test("a screenshot inside the store is served as a PNG", async () => {
  const t = setup();
  const file = path.join(SCREENSHOT_DIR, `test_review_${process.pid}_${Date.now()}.png`);
  try {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    writeFileSync(file, Buffer.from("89504e470d0a1a0a", "hex"));
    const id = t.insertJob({ screenshot_path: file });

    const meta = await (await fetch(`${t.baseUrl}/api/apply/run-jobs/${id}/review`)).json();
    assert.equal(meta.screenshotAvailable, true);

    const r = await fetch(`${t.baseUrl}/api/apply/run-jobs/${id}/screenshot`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
  } finally {
    if (existsSync(file)) rmSync(file, { force: true });
    t.close();
  }
});

test("a screenshot_path pointing outside the store is refused", async () => {
  // The column is written by our own takeScreenshot(), so this can only happen if something upstream
  // changes — which is exactly when an unguarded sendFile becomes an arbitrary-file read.
  const t = setup();
  try {
    for (const evil of [
      path.join(SCREENSHOT_DIR, "..", "..", "server.js"),
      path.join(SCREENSHOT_DIR + "-elsewhere", "x.png"),
      "/etc/passwd",
    ]) {
      const id = t.insertJob({ job_id: `gh-${Math.random()}`, screenshot_path: evil });
      const r = await fetch(`${t.baseUrl}/api/apply/run-jobs/${id}/screenshot`);
      assert.equal(r.status, 403, `must refuse ${evil}`);
      assert.equal((await r.json()).error, "screenshot_outside_store");
    }
  } finally { t.close(); }
});

test("a recorded screenshot whose file is gone reports missing, not a server error", async () => {
  const t = setup();
  try {
    const id = t.insertJob({ screenshot_path: path.join(SCREENSHOT_DIR, "definitely_not_here.png") });
    const r = await fetch(`${t.baseUrl}/api/apply/run-jobs/${id}/screenshot`);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, "screenshot_missing");
  } finally { t.close(); }
});
