import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import applyRoutes from "../routes/apply.js";
import { buildAnswers, buildOpenQuestions, PROVENANCE } from "../services/applyAutomation.js";

// Validation-correction loop. `missingRequired` used to end a run: a list of label strings with no
// type, no options and no reason. These cover turning that into an answerable question set, and the
// precedence rule that lets the loop CONVERGE.
// End-to-end proof (real browser, real ATS): scripts/a6CorrectionLoop.mjs.

const field = (over = {}) => ({
  field_id: "f", name: "f", type: "text", label: "", is_required: false,
  options: [], handler_type: null, handler_source: null, current_value: "", ...over,
});

// ── The precedence that makes the loop terminate ─────────────────────────────

test("a stored answer beats a fuzzy guess — without this the loop cannot converge", () => {
  // "Legal Name" only token-matches `name`, so it resolves as a 0.3 guess and holds the run. The
  // loop then asks the user. If the fuzzy step ran BEFORE custom_answers, that 0.3 guess would keep
  // winning, the stored answer would never be reached, and the same question would be asked forever.
  const fields = [field({ field_id: "ln", name: "legal_name", label: "Legal Name" })];

  const guessed = buildAnswers(fields, { field_map: { name: "A. Lovelace" } });
  assert.equal(guessed[0].provenance, PROVENANCE.LABEL_FUZZY, "precondition: this is a guess");

  const answered = buildAnswers(fields, {
    field_map: { name: "A. Lovelace" },
    custom_answers: { "Legal Name": "Augusta Ada Lovelace" },
  });
  assert.equal(answered[0].provenance, PROVENANCE.CUSTOM_ANSWER,
    "the user's answer must win, or the loop never terminates");
  assert.equal(answered[0].value, "Augusta Ada Lovelace");
  assert.ok(answered[0].confidence >= 0.8, "and it must clear the auto-submit floor");
});

test("a stored answer does not override an exact handler or field_map hit", () => {
  // Ordering custom_answers above the fuzzy step must not promote it above the EXACT paths: an
  // attribute-derived handler is stronger evidence than free text typed into a question box.
  const fields = [field({ field_id: "e", name: "email", label: "Email", handler_type: "email", handler_source: "attr" })];
  const [a] = buildAnswers(fields, {
    handler_map: { email: "ada@handler.test" },
    field_map:   { email: "ada@fieldmap.test" },
    custom_answers: { "Email": "ada@custom.test" },
  });
  assert.equal(a.provenance, PROVENANCE.HANDLER_EXACT);
  assert.equal(a.value, "ada@handler.test");

  const [b] = buildAnswers(fields, {
    field_map: { email: "ada@fieldmap.test" },
    custom_answers: { "Email": "ada@custom.test" },
  });
  assert.equal(b.provenance, PROVENANCE.FIELD_MAP_EXACT);
});

// ── The question set ─────────────────────────────────────────────────────────

test("unanswered required fields become questions carrying type, options and eligibility", () => {
  const questions = buildOpenQuestions({
    missingFields: [
      { label: "Do you now or in the future require sponsorship for work authorization?",
        name: "job_application[requires_sponsorship]", type: "select", is_required: true,
        options: [{ value: "", label: "Select..." }, { value: "Yes", label: "Yes" }, { value: "No", label: "No" }],
        refusals: ["work_authorization:eligibility_class:sponsorship"] },
      { label: "How did you hear about us?", name: "hear", type: "text_area", is_required: true, options: [] },
    ],
  });

  assert.equal(questions.length, 2);
  const [sponsorship, free] = questions;

  assert.equal(sponsorship.eligibility, "sponsorship",
    "an attestation must be flagged as one, not shown as an ordinary field");
  assert.equal(sponsorship.type, "select");
  assert.deepEqual(sponsorship.options.map(o => o.value), ["Yes", "No"],
    "the placeholder option is dropped; a caller can render the real choices");
  assert.deepEqual(sponsorship.refusals, ["work_authorization:eligibility_class:sponsorship"],
    "the question must explain that the resolver REFUSED, not that it had nothing");
  assert.equal(sponsorship.reason, "unanswered");

  assert.equal(free.eligibility, null);
  assert.equal(free.type, "text_area");
});

test("low-confidence answers become confirmations that carry the proposal", () => {
  const [q] = buildOpenQuestions({
    lowConfidence: [{ field: "Legal Name", name: "legal_name", type: "text",
      value: "A. Lovelace", provenance: "label_fuzzy", confidence: 0.3 }],
  });
  assert.equal(q.reason, "low_confidence");
  assert.equal(q.proposed, "A. Lovelace", "accepting the proposal is the answer");
  assert.equal(q.provenance, "label_fuzzy");
  assert.equal(q.confidence, 0.3);
});

test("questions are deduplicated by text and skip nameless fields", () => {
  const questions = buildOpenQuestions({
    missingFields: [
      { label: "Email", name: "a", type: "text", is_required: true, options: [] },
      { label: "email", name: "b", type: "text", is_required: true, options: [] },   // same question
      { label: "", name: "", field_id: "", type: "text", is_required: true, options: [] }, // unusable
    ],
    lowConfidence: [{ field: "EMAIL", value: "x" }],  // still the same question
  });
  assert.equal(questions.length, 1, "one question per distinct text");
});

// ── The endpoints ────────────────────────────────────────────────────────────

function setup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'PRO');
    CREATE TABLE domain_profiles (id INTEGER PRIMARY KEY, user_id INTEGER, profile_name TEXT,
      role_family TEXT, domain TEXT, is_active INTEGER DEFAULT 0);
    CREATE TABLE user_profile (user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
      full_name TEXT, email TEXT, phone TEXT, custom_answers TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE user_integrations (user_id INTEGER, provider TEXT, status TEXT, account_email TEXT,
      updated_at INTEGER, last_checked_at INTEGER);
    CREATE TABLE profile_base_resumes (profile_id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT,
      content TEXT, enhanced_content TEXT, enhanced_at INTEGER, enhanced_ats_delta REAL, updated_at INTEGER);
    CREATE TABLE base_resume (user_id INTEGER PRIMARY KEY, name TEXT, content TEXT,
      enhanced_content TEXT, enhanced_at INTEGER, enhanced_ats_delta REAL, updated_at INTEGER);
    CREATE TABLE simple_apply_profiles (user_id INTEGER PRIMARY KEY, titles_json TEXT, keywords_json TEXT,
      skills_json TEXT, search_terms_json TEXT, source_hash TEXT, years_experience REAL, updated_at INTEGER);
    CREATE TABLE profile_simple_apply_profiles (profile_id INTEGER PRIMARY KEY, user_id INTEGER,
      titles_json TEXT, keywords_json TEXT, skills_json TEXT, search_terms_json TEXT, source_hash TEXT,
      years_experience REAL, updated_at INTEGER);
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, title TEXT, company TEXT, url TEXT,
      apply_url TEXT, source TEXT, location TEXT);
    CREATE TABLE resumes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, job_id TEXT,
      apply_mode TEXT, ats_score INTEGER, html TEXT, updated_at INTEGER);
    CREATE TABLE apply_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, mode TEXT, approval_mode TEXT,
      tool_type TEXT, status TEXT, total_jobs INTEGER, held_count INTEGER DEFAULT 0,
      submitted_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()), started_at INTEGER, finished_at INTEGER);
    CREATE TABLE apply_run_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, user_id INTEGER, approved_at INTEGER, approved_from_run_job_id INTEGER,
      job_id TEXT, status TEXT, reason_code TEXT, reason_detail TEXT, started_at INTEGER,
      finished_at INTEGER, created_at INTEGER DEFAULT (unixepoch()),
      answers_json TEXT, resume_artifact_id INTEGER, resume_ats_score INTEGER,
      screenshot_path TEXT, submit_verified INTEGER, submit_evidence TEXT,
      open_questions_json TEXT, hidden_at INTEGER, UNIQUE(run_id, job_id));
    CREATE TABLE apply_job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, run_job_id INTEGER,
      user_id INTEGER, job_id TEXT, level TEXT DEFAULT 'info', event TEXT, message TEXT,
      details_json TEXT, created_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE job_applications (user_id INTEGER, job_id TEXT, company TEXT, role TEXT, job_url TEXT,
      source TEXT, location TEXT, apply_mode TEXT, resume_file TEXT, applied_at INTEGER, notes TEXT,
      auto_status TEXT,
      ats_score_at_apply INTEGER, ats_scorer_version TEXT, ats_report_at_apply TEXT, ats_scored_at INTEGER,
      UNIQUE(user_id, job_id));
    CREATE TABLE user_jobs (user_id INTEGER, job_id TEXT, domain_profile_id INTEGER, applied INTEGER DEFAULT 0,
      updated_at INTEGER, UNIQUE(user_id, job_id));
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE apply_idempotency (user_id INTEGER NOT NULL, idem_key TEXT NOT NULL, endpoint TEXT NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 200, response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (user_id, idem_key));
    INSERT INTO users (id, username) VALUES (1, 'ada');
    INSERT INTO domain_profiles (id, user_id, profile_name, is_active) VALUES (10, 1, 'SWE', 1);
    INSERT INTO user_profile (user_id, first_name, last_name, email) VALUES (1, 'Ada', 'Lovelace', 'ada@example.com');
    INSERT INTO profile_base_resumes (profile_id, user_id, name, content, updated_at)
      VALUES (10, 1, 'r.txt', 'resume text', unixepoch());
  `);

  const heldQuestions = [
    { question: "Do you now or in the future require sponsorship?", type: "select",
      options: [{ value: "Yes", label: "Yes" }, { value: "No", label: "No" }],
      eligibility: "sponsorship", reason: "unanswered" },
    { question: "How did you hear about us?", type: "text_area", options: [], eligibility: null, reason: "unanswered" },
  ];
  const run = db.prepare("INSERT INTO apply_runs (user_id, mode, tool_type, status, total_jobs) VALUES (1,'auto','generate','completed',1)").run();
  db.prepare(`INSERT INTO apply_run_jobs (run_id, user_id, job_id, status, reason_code, open_questions_json)
              VALUES (?, 1, 'gh1', 'held_review', 'incomplete_form', ?)`)
    .run(run.lastInsertRowid, JSON.stringify(heldQuestions));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
  const noop = async () => ({});
  applyRoutes(app, db, (q, r, n) => n(), noop, noop, noop, noop);
  const server = app.listen(0);
  return { db, server, url: `http://127.0.0.1:${server.address().port}` };
}

const post = (url, p, b) => fetch(`${url}${p}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
});

test("GET /api/apply/questions exposes the outstanding questions and what they block", async () => {
  const { server, url } = setup();
  try {
    const body = await fetch(`${url}/api/apply/questions`).then(r => r.json());
    assert.equal(body.questions.length, 2);
    assert.equal(body.eligibilityCount, 1);
    assert.equal(body.blockedJobs, 1);
    assert.deepEqual(body.questions[0].blocking.map(b => b.jobId), ["gh1"]);
    assert.equal(body.questions.every(q => q.answered === false), true);
  } finally { server.close(); }
});

test("answers are merged into custom_answers, and the questions then read as answered", async () => {
  const { db, server, url } = setup();
  try {
    db.prepare("UPDATE user_profile SET custom_answers=? WHERE user_id=1")
      .run(JSON.stringify({ "Pre-existing question": "kept" }));

    const res = await post(url, "/api/apply/answers", {
      answers: { "How did you hear about us?": "Your engineering blog" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.saved, ["How did you hear about us?"]);
    assert.deepEqual(body.unblocked, [], "one of two answered — not yet retryable");

    const stored = JSON.parse(db.prepare("SELECT custom_answers FROM user_profile WHERE user_id=1").get().custom_answers);
    assert.equal(stored["How did you hear about us?"], "Your engineering blog");
    assert.equal(stored["Pre-existing question"], "kept", "merge, never replace");

    const after = await fetch(`${url}/api/apply/questions`).then(r => r.json());
    assert.equal(after.questions.find(q => /hear about us/.test(q.question)).answered, true);
    assert.equal(after.questions.find(q => /sponsorship/.test(q.question)).answered, false);
  } finally { server.close(); }
});

test("a job is only retryable once EVERY question it was blocked on is answered", async () => {
  const { server, url } = setup();
  try {
    // Half-answered: retrying would just burn a run and hold again.
    const partial = await post(url, "/api/apply/answers", {
      answers: { "How did you hear about us?": "Blog" },
      retryJobIds: ["gh1"],
    });
    assert.equal(partial.status, 409);
    const pb = await partial.json();
    assert.equal(pb.error, "no_retryable_jobs");
    assert.deepEqual(pb.skipped, ["gh1"]);

    // Completing the set makes it retryable.
    const full = await post(url, "/api/apply/answers", {
      answers: { "Do you now or in the future require sponsorship?": "No" },
      retryJobIds: ["gh1"],
    });
    assert.equal(full.status, 202);
    const fb = await full.json();
    assert.deepEqual(fb.unblocked, ["gh1"]);
    assert.ok(fb.retry?.runId, "a retry run must be created");
  } finally { server.close(); }
});

test("the retry goes through startRun, so the guards still apply", async () => {
  const { db, server, url } = setup();
  try {
    // Kill switch on: the answers must still be SAVED, but no run may start.
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('apply_full_auto_disabled','1')").run();
    const res = await post(url, "/api/apply/answers", {
      answers: {
        "Do you now or in the future require sponsorship?": "No",
        "How did you hear about us?": "Blog",
      },
      retryJobIds: ["gh1"],
      mode: "auto",
    });
    assert.equal(res.status, 503, "the retry must not bypass the kill switch");
    const body = await res.json();
    assert.equal(body.error, "full_auto_disabled");
    assert.deepEqual(body.saved.length, 2, "the answers are still saved — they are not lost");
    const stored = JSON.parse(db.prepare("SELECT custom_answers FROM user_profile WHERE user_id=1").get().custom_answers);
    assert.equal(Object.keys(stored).length, 2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM apply_runs WHERE status='queued'").get().n, 0);
  } finally { server.close(); }
});

test("empty or malformed answer payloads are rejected", async () => {
  const { server, url } = setup();
  try {
    assert.equal((await post(url, "/api/apply/answers", {})).status, 400);
    assert.equal((await post(url, "/api/apply/answers", { answers: [] })).status, 400);
    assert.equal((await post(url, "/api/apply/answers", { answers: { "  ": "x" } })).status, 400);
    assert.equal((await post(url, "/api/apply/answers", { answers: { "Q": "   " } })).status, 400,
      "a blank answer is not an answer");
  } finally { server.close(); }
});

test("held jobs on /api/apply/review carry their questions", async () => {
  const { server, url } = setup();
  try {
    const body = await fetch(`${url}/api/apply/review`).then(r => r.json());
    assert.equal(body.jobs.length, 1);
    assert.equal(body.jobs[0].openQuestions.length, 2, "additive on the existing review payload");
  } finally { server.close(); }
});
