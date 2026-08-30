import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import Database from "better-sqlite3";
import applyRoutes from "../routes/apply.js";
import { buildOpenQuestions } from "../services/applyAutomation.js";

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

// The question-prompt UI. These are CONTRACT tests: every field the panel reads off a question must
// exist in the payload the server really sends. That pairing is where this session's worst bugs lived
// — `tool` vs `toolType` silently dropped the A+ selection, and `data.queued` made every run report
// "0 jobs started" — and both sides were individually self-consistent, so only the pairing caught it.

/** A real router over a held job whose questions come from the real producer. */
function setup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'PRO');
    CREATE TABLE user_profile (user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
      full_name TEXT, email TEXT, phone TEXT, custom_answers TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE domain_profiles (id INTEGER PRIMARY KEY, user_id INTEGER, profile_name TEXT,
      role_family TEXT, domain TEXT, is_active INTEGER DEFAULT 0);
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
    CREATE TABLE apply_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, mode TEXT, approval_mode TEXT,
      tool_type TEXT, status TEXT, total_jobs INTEGER, held_count INTEGER DEFAULT 0,
      submitted_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()), started_at INTEGER, finished_at INTEGER);
    CREATE TABLE apply_run_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, user_id INTEGER, approved_at INTEGER, approved_from_run_job_id INTEGER,
      job_id TEXT, status TEXT, reason_code TEXT, reason_detail TEXT, started_at INTEGER,
      finished_at INTEGER, created_at INTEGER DEFAULT (unixepoch()), answers_json TEXT,
      resume_artifact_id INTEGER, resume_ats_score INTEGER, screenshot_path TEXT,
      submit_verified INTEGER, submit_evidence TEXT, open_questions_json TEXT, hidden_at INTEGER, UNIQUE(run_id, job_id));
    CREATE TABLE apply_job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, run_job_id INTEGER,
      user_id INTEGER, job_id TEXT, level TEXT DEFAULT 'info', event TEXT, message TEXT,
      details_json TEXT, created_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE job_applications (user_id INTEGER, job_id TEXT, company TEXT, role TEXT, job_url TEXT,
      source TEXT, location TEXT, apply_mode TEXT, resume_file TEXT, applied_at INTEGER, notes TEXT,
      auto_status TEXT,
      ats_score_at_apply INTEGER, ats_scorer_version TEXT, ats_report_at_apply TEXT, ats_scored_at INTEGER,
      UNIQUE(user_id, job_id));
    CREATE TABLE user_jobs (user_id INTEGER, job_id TEXT, domain_profile_id INTEGER,
      applied INTEGER DEFAULT 0, updated_at INTEGER, UNIQUE(user_id, job_id));
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
    CREATE TABLE apply_idempotency (user_id INTEGER, idem_key TEXT, endpoint TEXT, status_code INTEGER,
      response_json TEXT, created_at INTEGER, PRIMARY KEY (user_id, idem_key));
    INSERT INTO users (id, username) VALUES (1, 'ada');
    INSERT INTO domain_profiles (id, user_id, profile_name, is_active) VALUES (10, 1, 'SWE', 1);
    INSERT INTO user_profile (user_id, first_name, last_name, email) VALUES (1, 'Ada', 'Lovelace', 'ada@example.com');
    INSERT INTO profile_base_resumes (profile_id, user_id, name, content, updated_at)
      VALUES (10, 1, 'r.txt', 'resume text', unixepoch());
    INSERT INTO scraped_jobs (job_id, title, company) VALUES ('gh1', 'Senior Engineer', 'FakeCo');
  `);

  // Produced by the real buildOpenQuestions, so a change to its shape breaks this test rather than
  // the UI at runtime. Covers all three renderable kinds: select, free text, and a confirmation.
  const questions = buildOpenQuestions({
    missingFields: [
      { label: "Do you now or in the future require sponsorship for work authorization?",
        name: "job_application[requires_sponsorship]", type: "select", is_required: true,
        options: [{ value: "", label: "Select..." }, { value: "Yes", label: "Yes" }, { value: "No", label: "No" }],
        refusals: ["work_authorization:eligibility_class:sponsorship"] },
      { label: "How did you hear about us?", name: "hear", type: "text_area", is_required: true, options: [] },
    ],
    lowConfidence: [
      { field: "Legal Name", name: "legal_name", type: "text", value: "A. Lovelace",
        provenance: "label_fuzzy", confidence: 0.3 },
    ],
  });

  const run = db.prepare("INSERT INTO apply_runs (user_id, mode, tool_type, status, total_jobs) VALUES (1,'auto','generate','completed',1)").run();
  db.prepare(`INSERT INTO apply_run_jobs (run_id, user_id, job_id, status, reason_code, open_questions_json)
              VALUES (?, 1, 'gh1', 'held_review', 'incomplete_form', ?)`)
    .run(run.lastInsertRowid, JSON.stringify(questions));

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

// ── The read contract ────────────────────────────────────────────────────────

test("every question field the panel reads exists in the real payload", async () => {
  const { server, url } = setup();
  try {
    const body = await fetch(`${url}/api/apply/questions`).then(r => r.json());
    assert.ok(body.questions.length >= 3, "fixture must produce questions");

    // Read off the response envelope.
    for (const key of ["questions", "eligibilityCount", "blockedJobs"]) {
      assert.ok(key in body, `panel reads data.${key}`);
    }
    assert.match(jobsPanel, /data\.eligibilityCount \|\| 0/);
    assert.match(jobsPanel, /data\.blockedJobs \|\| 0/);

    // Read off each question. A missing key here renders `undefined` in the UI.
    const FIELDS = ["question", "type", "options", "eligibility", "reason", "answered", "blocking"];
    for (const q of body.questions) {
      for (const f of FIELDS) assert.ok(f in q, `question ${JSON.stringify(q.question)} lacks ${f}`);
      assert.ok(Array.isArray(q.options), "options must always be an array — the panel maps it");
      assert.ok(Array.isArray(q.blocking), "blocking must always be an array");
    }

    // A confirmation must carry the value being confirmed, or the copy says "a guess" with nothing.
    const confirm = body.questions.find(q => q.reason === "low_confidence");
    assert.ok(confirm, "fixture must include a confirmation");
    assert.equal(confirm.proposed, "A. Lovelace");

    // The select question must carry renderable options with value + label.
    const select = body.questions.find(q => q.type === "select");
    assert.ok(select.options.every(o => "value" in o && "label" in o),
      "the panel renders <option value={o.value}>{o.label}</option>");
    assert.ok(select.options.every(o => o.value !== ""),
      "the placeholder is dropped server-side; the panel supplies its own");

    // blocking entries must carry what the panel displays.
    for (const b of select.blocking) {
      for (const f of ["jobId", "company", "title"]) assert.ok(f in b, `blocking entry lacks ${f}`);
    }
  } finally { server.close(); }
});

test("an eligibility question is flagged so the UI can present it as an attestation", async () => {
  const { server, url } = setup();
  try {
    const body = await fetch(`${url}/api/apply/questions`).then(r => r.json());
    const elig = body.questions.filter(q => q.eligibility);
    assert.equal(elig.length, 1);
    assert.equal(elig[0].eligibility, "sponsorship");
    assert.equal(body.eligibilityCount, 1);

    // The panel must render the attestation treatment off that field, not treat it as an ordinary
    // input. This is the safety property the whole resolution layer is built around.
    assert.match(jobsPanel, /const isEligibility = !!q\.eligibility;/);
    assert.match(jobsPanel, /ATTESTATION/);
    assert.match(jobsPanel, /You are stating this to the employer yourself/);
  } finally { server.close(); }
});

// ── The write contract ───────────────────────────────────────────────────────

test("the panel's POST body is the shape the endpoint accepts, and its reads match the reply", async () => {
  const { db, server, url } = setup();
  try {
    // Exactly what submitApplyAnswers sends.
    const res = await post(url, "/api/apply/answers", {
      answers: {
        "Do you now or in the future require sponsorship for work authorization?": "No",
        "How did you hear about us?": "Your engineering blog",
        "Legal Name": "Augusta Ada Lovelace",
      },
      retryJobIds: ["gh1"],
      mode: "auto",
    });
    const body = await res.json();
    assert.equal(res.status, 202, JSON.stringify(body));

    // Fields the panel reads off the success reply.
    assert.ok(Array.isArray(body.saved), "panel reads data.saved?.length");
    assert.ok(Array.isArray(body.unblocked), "panel reads data.unblocked?.length");
    assert.ok(Array.isArray(body.retry?.queued), "panel reads data.retry?.queued?.length");
    assert.match(jobsPanel, /data\.retry\?\.queued\?\.length \|\| 0/);
    assert.match(jobsPanel, /data\.unblocked\?\.length/);

    // And the answers really landed where the resolver will read them on retry.
    const stored = JSON.parse(db.prepare("SELECT custom_answers FROM user_profile WHERE user_id=1").get().custom_answers);
    assert.equal(stored["Legal Name"], "Augusta Ada Lovelace");
  } finally { server.close(); }
});

test("a refused retry still reports the saved answers, which is what the panel says", async () => {
  const { db, server, url } = setup();
  try {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('apply_full_auto_disabled','1')").run();
    const res = await post(url, "/api/apply/answers", {
      answers: {
        "Do you now or in the future require sponsorship for work authorization?": "No",
        "How did you hear about us?": "Blog",
        "Legal Name": "Augusta Ada Lovelace",
      },
      retryJobIds: ["gh1"],
      mode: "auto",
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    // The panel reads e.payload.saved to say "saved N answers, but the retry did not start".
    assert.ok(Array.isArray(body.saved) && body.saved.length === 3,
      "the answers must be reported as saved even when the retry is refused");
    assert.equal(body.error, "full_auto_disabled");
    assert.ok(body.message, "and a human sentence, which api.js now prefers over the code");
    assert.match(jobsPanel, /e\.payload\?\.saved\?\.length/);
    assert.match(jobsPanel, /but the retry did not start/);
  } finally { server.close(); }
});

// ── Panel wiring ─────────────────────────────────────────────────────────────

test("the panel loads questions, seeds confirmations, and offers both save paths", () => {
  assert.match(jobsPanel, /api\("\/api\/apply\/questions"\)/);
  assert.match(jobsPanel, /api\("\/api\/apply\/answers", \{/);
  // A confirmation is seeded with the value being confirmed — accepting it IS the answer.
  assert.match(jobsPanel, /next\[q\.question\] = q\.proposed \?\? ""/);
  // Both paths exist: saving without retrying must be possible when the cap is spent.
  assert.match(jobsPanel, /submitApplyAnswers\(true\)/);
  assert.match(jobsPanel, /submitApplyAnswers\(false\)/);
  assert.match(jobsPanel, /Save & retry/);
  assert.match(jobsPanel, /Save only/);
  // The retry list is the union of blocked jobs; the SERVER decides which are actually retryable.
  assert.match(jobsPanel, /\(q\.blocking \|\| \[\]\)\.map\(b => b\.jobId\)/);
});

test("the questions surface uses the modal conventions and its own CTA", () => {
  // Rendered inside the existing review modal, which uses the opaque modal token — the board must
  // not read through it.
  assert.match(jobsPanel, /background:theme\.modalSurface \|\| theme\.surface/);
  // Its own entry point, because answering is the actionable step rather than just "needs review".
  //
  // Reads the SCOPED list since AB3. The surface and its CTA are unchanged; what it lists is now
  // whatever the user opened the popup from, instead of every question regardless of the card
  // clicked. The assertion follows the rename rather than pinning the old identifier, because the
  // capability is what must survive — not the variable's name.
  assert.match(jobsPanel, /Answer \{scopedQuestions\.length\} question/);
  // Only on the review view, not when inspecting one run's detail.
  assert.match(jobsPanel, /!applyRunDetail && scopedQuestions\.length > 0/);
  // The empty state must not contradict a visible question list — nor a visible pending list, which
  // renders in the same place and would otherwise sit under "No jobs in this run yet."
  assert.match(jobsPanel,
    /\(applyRunDetail \|\| \(scopedQuestions\.length === 0 && scopedPending\.length === 0\)\)/);
});
