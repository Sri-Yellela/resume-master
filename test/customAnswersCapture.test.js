/**
 * AF1's capture loop, end to end through the real router.
 *
 * The unit tests in customAnswers.test.js prove the resolution rules. These prove the loop the
 * candidate actually experiences: a run holds on a question, they answer it once, and the next run
 * resolves it — including the case the store exists for, where the question names the employer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import applyRoutes from "../routes/apply.js";
import { buildOpenQuestions, buildAnswers, PROVENANCE } from "../services/applyAutomation.js";
import { readAnswerStore, effectiveCustomAnswers } from "../services/customAnswers.js";

const TEMPLATE = "Have you ever worked for {company} before?";
const MOTIVATION = "Why do you want to join {company}?";

/** Two held jobs at DIFFERENT employers, both blocked on the same two templated questions. */
function setup({ answers = {}, overrides = {} } = {}) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'PRO');
    CREATE TABLE user_profile (user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
      full_name TEXT, email TEXT, phone TEXT,
      custom_answers TEXT NOT NULL DEFAULT '{}',
      custom_answer_overrides TEXT NOT NULL DEFAULT '{}');
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
    CREATE TABLE apply_run_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, user_id INTEGER,
      approved_at INTEGER, approved_from_run_job_id INTEGER,
      job_id TEXT, status TEXT, reason_code TEXT, reason_detail TEXT, started_at INTEGER,
      finished_at INTEGER, created_at INTEGER DEFAULT (unixepoch()), answers_json TEXT,
      resume_artifact_id INTEGER, resume_ats_score INTEGER, screenshot_path TEXT,
      submit_verified INTEGER, submit_evidence TEXT, open_questions_json TEXT, hidden_at INTEGER,
      UNIQUE(run_id, job_id));
    CREATE TABLE apply_job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, run_job_id INTEGER,
      user_id INTEGER, job_id TEXT, level TEXT DEFAULT 'info', event TEXT, message TEXT,
      details_json TEXT, created_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE job_applications (user_id INTEGER, job_id TEXT, company TEXT, role TEXT, job_url TEXT,
      source TEXT, location TEXT, apply_mode TEXT, resume_file TEXT, applied_at INTEGER, notes TEXT,
      auto_status TEXT, UNIQUE(user_id, job_id));
    CREATE TABLE user_jobs (user_id INTEGER, job_id TEXT, domain_profile_id INTEGER,
      applied INTEGER DEFAULT 0, updated_at INTEGER, UNIQUE(user_id, job_id));
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
    CREATE TABLE apply_idempotency (user_id INTEGER, idem_key TEXT, endpoint TEXT, status_code INTEGER,
      response_json TEXT, created_at INTEGER, PRIMARY KEY (user_id, idem_key));
    INSERT INTO users (id, username) VALUES (1, 'ada');
    INSERT INTO domain_profiles (id, user_id, profile_name, is_active) VALUES (10, 1, 'SWE', 1);
    INSERT INTO profile_base_resumes (profile_id, user_id, name, content, updated_at)
      VALUES (10, 1, 'r.txt', 'resume text', unixepoch());
    INSERT INTO scraped_jobs (job_id, title, company) VALUES ('fig1', 'Product Engineer', 'Figma');
    INSERT INTO scraped_jobs (job_id, title, company) VALUES ('lin1', 'Product Engineer', 'Linear');
  `);
  db.prepare("INSERT INTO user_profile (user_id, first_name, last_name, email, custom_answers, custom_answer_overrides) VALUES (1,'Ada','Lovelace','ada@example.com',?,?)")
    .run(JSON.stringify(answers), JSON.stringify(overrides));

  // The real producer, so a change to its shape breaks this rather than the UI at runtime.
  const forCompany = (company) => buildOpenQuestions({
    missingFields: [
      { label: `Have you ever worked for ${company} before?`, name: "former", type: "select",
        is_required: true,
        options: [{ value: "", label: "Select..." }, { value: "Yes", label: "Yes" }, { value: "No", label: "No" }] },
      { label: `Why do you want to join ${company}?`, name: "why", type: "text_area",
        is_required: true, options: [] },
    ],
  });

  const run = db.prepare("INSERT INTO apply_runs (user_id, mode, tool_type, status, total_jobs) VALUES (1,'auto','generate','completed',2)").run();
  for (const [jobId, company] of [["fig1", "Figma"], ["lin1", "Linear"]]) {
    db.prepare(`INSERT INTO apply_run_jobs (run_id, user_id, job_id, status, reason_code, open_questions_json)
                VALUES (?, 1, ?, 'held_review', 'incomplete_form', ?)`)
      .run(run.lastInsertRowid, jobId, JSON.stringify(forCompany(company)));
  }

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
const getQuestions = (url) => fetch(`${url}/api/apply/questions`).then(r => r.json());
const storeOf = (db) => readAnswerStore(db.prepare("SELECT * FROM user_profile WHERE user_id=1").get());

// ── The loop ─────────────────────────────────────────────────────────────────

test("a question the run could not answer is offered, then resolves from the store on the next run", async () => {
  const { db, server, url } = setup();
  try {
    const before = await getQuestions(url);
    const q = before.questions.find(x => x.question === "Have you ever worked for Figma before?");
    assert.ok(q, "the held run must surface the question");
    assert.equal(q.answered, false, "nothing is stored yet");

    // The candidate answers it ONCE, as a template.
    const saved = await post(url, "/api/apply/answers", { answers: { [TEMPLATE]: "No" } })
      .then(r => r.json());
    assert.deepEqual(saved.saved, [TEMPLATE]);

    // Next run: the resolver now has a literal answer for this employer's exact wording.
    const resolved = effectiveCustomAnswers(storeOf(db), "Figma");
    assert.equal(resolved["Have you ever worked for Figma before?"], "No");
    const [a] = buildAnswers(
      [{ field_id: "f", name: "former", type: "select", label: "Have you ever worked for Figma before?",
         handler_type: null, is_required: true,
         options: [{ value: "Yes", label: "Yes" }, { value: "No", label: "No" }] }],
      { field_map: {}, handler_map: {}, custom_answers: resolved },
    );
    assert.equal(a.value, "No");
    assert.equal(a.provenance, PROVENANCE.CUSTOM_ANSWER, "exact tier, not the fuzzy path");
  } finally { server.close(); }
});

test("ONE template answers the same question at an employer never seen before", async () => {
  const { db, server, url } = setup();
  try {
    await post(url, "/api/apply/answers", { answers: { [TEMPLATE]: "No" } });
    // Linear was in the fixture, but the point holds for any company: the answer was never written
    // for it, and it still resolves.
    for (const company of ["Linear", "Stripe", "Some Startup Inc"]) {
      const resolved = effectiveCustomAnswers(storeOf(db), company);
      assert.equal(resolved[`Have you ever worked for ${company} before?`], "No", company);
    }
  } finally { server.close(); }
});

test("a captured answer shows as answered for EVERY employer still blocked on it", async () => {
  const { server, url } = setup();
  try {
    await post(url, "/api/apply/answers", { answers: { [TEMPLATE]: "No" } });
    const after = await getQuestions(url);
    const figma = after.questions.find(x => x.question === "Have you ever worked for Figma before?");
    const linear = after.questions.find(x => x.question === "Have you ever worked for Linear before?");
    assert.equal(figma.answered, true);
    assert.equal(linear.answered, true, "one template covers both");
  } finally { server.close(); }
});

// ── The motivation question ──────────────────────────────────────────────────

test("a motivation template is offered as a DRAFT, never as an answer", async () => {
  const { db, server, url } = setup({ answers: { [MOTIVATION]: "I admire {company}'s craft." } });
  try {
    const body = await getQuestions(url);
    const q = body.questions.find(x => x.question === "Why do you want to join Figma?");
    assert.equal(q.answered, false, "a generic motivation answer does not answer anything");
    assert.equal(q.needsOwnWords, true);
    assert.equal(q.draft, "I admire Figma's craft.", "the draft is expanded for this employer");
    assert.equal(q.template, MOTIVATION, "so saving it can become a per-company override");
    assert.equal(body.ownWordsCount, 2, "one per blocked employer");

    // And it reaches no form.
    assert.deepEqual(effectiveCustomAnswers(storeOf(db), "Figma"), {});
  } finally { server.close(); }
});

test("A PER-COMPANY OVERRIDE WINS, and is the only thing that answers a motivation question", async () => {
  const { db, server, url } = setup({ answers: { [MOTIVATION]: "Generic." } });
  try {
    const saved = await post(url, "/api/apply/answers", {
      overrides: { Figma: { [MOTIVATION]: "I have shipped against the plugin API since 2023." } },
    }).then(r => r.json());
    assert.deepEqual(saved.savedOverrides, [{ company: "figma", question: MOTIVATION }]);

    assert.equal(
      effectiveCustomAnswers(storeOf(db), "Figma")["Why do you want to join Figma?"],
      "I have shipped against the plugin API since 2023.",
    );
    // Linear gets no borrowed words.
    assert.deepEqual(effectiveCustomAnswers(storeOf(db), "Linear"), {});

    const after = await getQuestions(url);
    assert.equal(after.questions.find(x => x.question === "Why do you want to join Figma?").answered, true);
    assert.equal(after.questions.find(x => x.question === "Why do you want to join Linear?").answered, false);
  } finally { server.close(); }
});

test("an override overwrites a factual template for that employer only", async () => {
  const { db, server, url } = setup({ answers: { [TEMPLATE]: "No" } });
  try {
    await post(url, "/api/apply/answers", { overrides: { Figma: { [TEMPLATE]: "Yes" } } });
    assert.equal(effectiveCustomAnswers(storeOf(db), "Figma")["Have you ever worked for Figma before?"], "Yes");
    assert.equal(effectiveCustomAnswers(storeOf(db), "Linear")["Have you ever worked for Linear before?"], "No");
  } finally { server.close(); }
});

// ── Unblocking ───────────────────────────────────────────────────────────────

test("a job is unblocked only when every question it held on resolves FOR ITS EMPLOYER", async () => {
  const { server, url } = setup();
  try {
    // The factual template alone leaves the motivation question open, so neither job is retryable.
    let r = await post(url, "/api/apply/answers", { answers: { [TEMPLATE]: "No" } }).then(x => x.json());
    assert.deepEqual(r.unblocked, [], "the motivation question is still open");

    // Figma's own words complete Figma, and only Figma.
    r = await post(url, "/api/apply/answers", {
      overrides: { Figma: { [MOTIVATION]: "Specific and mine." } },
    }).then(x => x.json());
    assert.deepEqual(r.unblocked, ["fig1"], "Linear is still missing its own answer");

    r = await post(url, "/api/apply/answers", {
      overrides: { Linear: { [MOTIVATION]: "Also specific and mine." } },
    }).then(x => x.json());
    assert.deepEqual(r.unblocked.sort(), ["fig1", "lin1"]);
  } finally { server.close(); }
});

test("a generic motivation answer never unblocks a job, however it is phrased", async () => {
  const { server, url } = setup();
  try {
    const r = await post(url, "/api/apply/answers", {
      answers: { [TEMPLATE]: "No", [MOTIVATION]: "I love your mission and culture." },
    }).then(x => x.json());
    assert.deepEqual(r.unblocked, [],
      "interpolating a company name into this is exactly what must not count as answered");
  } finally { server.close(); }
});

// ── Request validation ───────────────────────────────────────────────────────

test("overrides alone are a valid save; junk is rejected", async () => {
  const { server, url } = setup();
  try {
    assert.equal((await post(url, "/api/apply/answers", { overrides: { Figma: { Q: "A" } } })).status, 200);
    assert.equal((await post(url, "/api/apply/answers", { overrides: [] })).status, 400);
    assert.equal((await post(url, "/api/apply/answers", { answers: {}, overrides: {} })).status, 400);
    // A company that normalises to nothing cannot key an override.
    assert.equal((await post(url, "/api/apply/answers", { overrides: { "   ": { Q: "A" } } })).status, 400);
  } finally { server.close(); }
});

test("saving twice merges rather than replaces, across both maps", async () => {
  const { db, server, url } = setup();
  try {
    await post(url, "/api/apply/answers", { answers: { "How did you hear about us?": "LinkedIn" } });
    await post(url, "/api/apply/answers", { answers: { [TEMPLATE]: "No" } });
    await post(url, "/api/apply/answers", { overrides: { Figma: { [MOTIVATION]: "Mine." } } });
    await post(url, "/api/apply/answers", { overrides: { Linear: { [MOTIVATION]: "Also mine." } } });
    const store = storeOf(db);
    assert.deepEqual(Object.keys(store.answers).sort(), ["Have you ever worked for {company} before?", "How did you hear about us?"]);
    assert.deepEqual(Object.keys(store.overrides).sort(), ["figma", "linear"]);
  } finally { server.close(); }
});
