import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import applyRoutes from "../routes/apply.js";
import { driftFromApproved } from "../services/applyAutomation.js";

// Queue-then-approve, over real HTTP against an in-memory DB.
//
// An 'auto' run used to submit to a real employer with nobody having seen what it filled. It now
// previews by default — every gate, no click — and parks for a decision. These cover the admission
// side of that (which runs preview, which submit, who can approve what) and the drift gate that
// makes an approval mean something specific rather than general.
//
// End-to-end proof with a real browser and a real ATS: scripts/a9ApprovalFlow.mjs.

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
    INSERT INTO domain_profiles (id, user_id, profile_name, is_active) VALUES (10, 1, 'SWE', 1);
    INSERT INTO user_profile (user_id, first_name, last_name, email) VALUES (1, 'Ada', 'Lovelace', 'ada@example.com');
    INSERT INTO profile_base_resumes (profile_id, user_id, name, content, updated_at)
      VALUES (10, 1, 'r.txt', 'real resume text', unixepoch());
    -- no scraped_jobs row: processRunJob fails fast with job_not_found and never opens a browser.
    -- These tests are about admission and approval bookkeeping, not automation.
  `);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
  const noop = async () => ({});
  applyRoutes(app, db, (req, _res, next) => next(), noop, noop, noop, noop);
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const post = (p, body) => fetch(`${baseUrl}${p}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  /** A previewed job parked for approval, as processRunJob would leave it. */
  const parkPending = ({ userId = 1, jobId = "gh1", answers = [{ name: "email", value: "a@b.c" }] } = {}) => {
    const runId = db.prepare(`INSERT INTO apply_runs (user_id, mode, approval_mode, status, total_jobs)
      VALUES (?, 'auto', 'required', 'completed', 1)`).run(userId).lastInsertRowid;
    return db.prepare(`INSERT INTO apply_run_jobs (run_id, user_id, job_id, status, reason_code, answers_json)
      VALUES (?, ?, ?, 'held_review', 'awaiting_approval', ?)`)
      .run(runId, userId, jobId, JSON.stringify(answers)).lastInsertRowid;
  };

  return { db, baseUrl, post, parkPending, close: () => { server.close(); db.close(); } };
}

const runRow = (t, id) => t.db.prepare("SELECT * FROM apply_runs WHERE id=?").get(id);

// ── the default ──────────────────────────────────────────────────────────────

test("an auto run previews by default — full-auto is now opt-in", async () => {
  const t = setup();
  try {
    const r = await t.post("/api/apply/runs", { jobIds: ["gh1"], mode: "auto" });
    assert.equal(r.status, 202);
    const { runId } = await r.json();
    assert.equal(runRow(t, runId).approval_mode, "required",
      "an auto run must not submit without anyone having seen what it filled");
  } finally { t.close(); }
});

test("approvalMode:'auto' is how a caller opts back into full-auto", async () => {
  const t = setup();
  try {
    const r = await t.post("/api/apply/runs", { jobIds: ["gh1"], mode: "auto", approvalMode: "auto" });
    const { runId } = await r.json();
    assert.equal(runRow(t, runId).approval_mode, "auto");
  } finally { t.close(); }
});

test("semi is exempt — a human is already at the browser", async () => {
  const t = setup();
  try {
    const r = await t.post("/api/apply/runs", { jobIds: ["gh1"], mode: "semi" });
    const { runId } = await r.json();
    assert.equal(runRow(t, runId).approval_mode, "auto",
      "approving a run a human is watching submit is friction with no safety gained");
  } finally { t.close(); }
});

test("a client cannot claim 'approved' and skip the preview entirely", async () => {
  const t = setup();
  try {
    for (const [path, body] of [
      ["/api/apply/runs", { jobIds: ["gh1"], approvalMode: "approved" }],
      ["/api/apply/answers", { answers: { q: "a" }, approvalMode: "approved" }],
    ]) {
      const r = await t.post(path, body);
      assert.equal(r.status, 400);
      assert.equal((await r.json()).error, "approval_mode_reserved");
    }
  } finally { t.close(); }
});

// ── approving ────────────────────────────────────────────────────────────────

test("approving supersedes the preview and starts a run that carries the approval", async () => {
  const t = setup();
  try {
    const pendingId = t.parkPending();
    const r = await t.post("/api/apply/approve", { runJobIds: [pendingId] });
    assert.equal(r.status, 202);
    const body = await r.json();
    assert.deepEqual(body.approved, [pendingId]);

    const preview = t.db.prepare("SELECT * FROM apply_run_jobs WHERE id=?").get(pendingId);
    assert.equal(preview.status, "superseded", "the preview stays as its own audit record");
    assert.ok(preview.approved_at > 0, "and records WHEN a human approved it");

    const newRun = runRow(t, body.run.runId);
    assert.equal(newRun.approval_mode, "approved",
      "this is the discriminator between a human-approved submission and a full-auto one");

    const queued = t.db.prepare("SELECT * FROM apply_run_jobs WHERE run_id=?").get(newRun.id);
    assert.equal(queued.approved_from_run_job_id, pendingId,
      "the submitting run must point at the answers that were approved");
  } finally { t.close(); }
});

test("only jobs actually awaiting approval can be approved", async () => {
  const t = setup();
  try {
    // Another user's pending job, and a job of ours that is held for a different reason.
    const theirs = t.parkPending({ userId: 2, jobId: "gh2" });
    const runId = t.db.prepare(`INSERT INTO apply_runs (user_id, mode, approval_mode, status, total_jobs)
      VALUES (1, 'auto', 'required', 'completed', 1)`).run().lastInsertRowid;
    const otherHold = t.db.prepare(`INSERT INTO apply_run_jobs (run_id, user_id, job_id, status, reason_code)
      VALUES (?, 1, 'gh3', 'held_review', 'incomplete_form')`).run(runId).lastInsertRowid;

    const r = await t.post("/api/apply/approve", { runJobIds: [theirs, otherHold, 9999] });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, "no_approvable_jobs");
    assert.equal(t.db.prepare("SELECT status FROM apply_run_jobs WHERE id=?").get(theirs).status,
      "held_review", "another user's application must be untouched");
  } finally { t.close(); }
});

test("a refused run puts the approval back rather than swallowing it", async () => {
  const t = setup();
  try {
    // Kill switch on: the approved run is full-auto, so startRun refuses it.
    t.db.prepare("INSERT INTO app_settings (key, value) VALUES ('apply_full_auto_disabled', '1')").run();
    const pendingId = t.parkPending();

    const r = await t.post("/api/apply/approve", { runJobIds: [pendingId] });
    assert.equal(r.status, 503);
    assert.deepEqual((await r.json()).approved, []);

    const row = t.db.prepare("SELECT * FROM apply_run_jobs WHERE id=?").get(pendingId);
    assert.equal(row.status, "held_review", "an approval that fails must remain approvable");
    assert.equal(row.approved_at, null);
  } finally { t.close(); }
});

// ── rejecting ────────────────────────────────────────────────────────────────

test("rejecting dismisses the application and starts nothing", async () => {
  const t = setup();
  try {
    const pendingId = t.parkPending();
    const before = t.db.prepare("SELECT COUNT(*) n FROM apply_runs").get().n;

    const r = await t.post("/api/apply/reject", { runJobIds: [pendingId] });
    assert.equal(r.status, 200);

    const row = t.db.prepare("SELECT * FROM apply_run_jobs WHERE id=?").get(pendingId);
    assert.equal(row.status, "dismissed");
    assert.equal(row.reason_code, "rejected");
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM apply_runs").get().n, before,
      "rejecting must not queue anything");
  } finally { t.close(); }
});

// ── the pending list ─────────────────────────────────────────────────────────

test("the pending list separates guesses from exact mappings", async () => {
  const t = setup();
  try {
    t.parkPending({ answers: [
      { name: "email", value: "a@b.c", provenance: "field_map_exact", confidence: 0.9 },
      { name: "legal_name", value: "A. L", provenance: "label_fuzzy", confidence: 0.3 },
      { name: "skipped_one", value: null, skipped: true },
    ] });
    const { pending } = await (await fetch(`${t.baseUrl}/api/apply/pending`)).json();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].answerCount, 2, "skipped answers are not going to the employer");
    assert.equal(pending[0].guessCount, 1, "a reviewer must see which need attention");
  } finally { t.close(); }
});

test("the pending list is scoped to its owner", async () => {
  const t = setup();
  try {
    t.parkPending({ userId: 2, jobId: "gh9" });
    const { pending } = await (await fetch(`${t.baseUrl}/api/apply/pending`)).json();
    assert.deepEqual(pending, []);
  } finally { t.close(); }
});

// ── the drift gate ───────────────────────────────────────────────────────────
// An approval is a decision about a specific set of answers. The submitting run resolves the form
// again, so it must refuse if what it gets back is not what was approved.

test("identical answers are not drift", () => {
  const approved = [{ name: "email", value: "a@b.c" }, { name: "phone", value: "555" }];
  assert.deepEqual(driftFromApproved(approved, [...approved]), []);
});

test("a changed value is drift", () => {
  const drift = driftFromApproved(
    [{ name: "requires_sponsorship", label: "Sponsorship?", value: "No" }],
    [{ name: "requires_sponsorship", label: "Sponsorship?", value: "Yes" }]);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].change, "changed");
  assert.equal(drift[0].approved, "No");
  assert.equal(drift[0].now, "Yes");
});

test("a field that was not approved is drift — reviewing five answers does not authorise a sixth", () => {
  const drift = driftFromApproved(
    [{ name: "email", value: "a@b.c" }],
    [{ name: "email", value: "a@b.c" }, { name: "salary", label: "Desired salary", value: "1" }]);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].change, "added");
  assert.equal(drift[0].field, "Desired salary");
});

test("an approved answer that is no longer being sent is drift", () => {
  const drift = driftFromApproved(
    [{ name: "email", value: "a@b.c" }, { name: "phone", value: "555" }],
    [{ name: "email", value: "a@b.c" }]);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].change, "missing");
});

test("skipped and policy-rejected answers are ignored on both sides", () => {
  // Neither is submitted, so neither can make a submission differ from what was approved.
  assert.deepEqual(driftFromApproved(
    [{ name: "email", value: "a@b.c" }, { name: "x", value: null, skipped: true }],
    [{ name: "email", value: "a@b.c" }, { name: "y", value: "g", policy_rejected: true }]), []);
});

test("no approval recorded means no drift check — it does not block ordinary runs", () => {
  assert.deepEqual(driftFromApproved(null, [{ name: "email", value: "a@b.c" }]), []);
});
