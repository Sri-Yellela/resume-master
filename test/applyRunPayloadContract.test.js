import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import applyRoutes from "../routes/apply.js";

// POST /api/apply/runs had three payload-contract mismatches with JobsPanel. All three were
// invisible to the existing static tests because each side was internally consistent — only the
// pairing was wrong — so these are exercised over real HTTP instead of by reading the source.
//
// The severe one was MODE: the client's "Manual review" button sends mode:"manual", the server
// mapped `mode === "semi" ? "semi" : "auto"`, and processRunJob passes
// `mode === "auto" ? "full" : "semi"` to autoApply. So asking to review first produced a real
// auto-submitted application.
//
// processRun is deliberately allowed to run: no row is inserted into scraped_jobs, so
// processRunJob fails fast with "job_not_found" and never reaches browser automation. These tests
// assert the run row and the HTTP response, which is where the contract lives.

function setupServer({ planTier = "PRO", withResume = true } = {}) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'BASIC');
    CREATE TABLE domain_profiles (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
      profile_name TEXT, role_family TEXT, domain TEXT, is_active INTEGER DEFAULT 0
    );
    CREATE TABLE user_profile (
      user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
      full_name TEXT, email TEXT, phone TEXT
    );
    CREATE TABLE user_integrations (
      user_id INTEGER, provider TEXT, status TEXT, account_email TEXT,
      updated_at INTEGER, last_checked_at INTEGER
    );
    CREATE TABLE profile_base_resumes (
      profile_id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, content TEXT,
      enhanced_content TEXT, enhanced_at INTEGER, enhanced_ats_delta REAL, updated_at INTEGER
    );
    CREATE TABLE base_resume (
      user_id INTEGER PRIMARY KEY, name TEXT, content TEXT,
      enhanced_content TEXT, enhanced_at INTEGER, enhanced_ats_delta REAL, updated_at INTEGER
    );
    -- Needed only when profile_base_resumes has no row: getBaseResumeRecord then runs
    -- seedScopedProfileFromLegacy, which reads these legacy tables to migrate old data forward.
    CREATE TABLE simple_apply_profiles (
      user_id INTEGER PRIMARY KEY, titles_json TEXT, keywords_json TEXT, skills_json TEXT,
      search_terms_json TEXT, source_hash TEXT, years_experience REAL, updated_at INTEGER
    );
    CREATE TABLE profile_simple_apply_profiles (
      profile_id INTEGER PRIMARY KEY, user_id INTEGER, titles_json TEXT, keywords_json TEXT,
      skills_json TEXT, search_terms_json TEXT, source_hash TEXT, years_experience REAL,
      updated_at INTEGER
    );
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, title TEXT, company TEXT, url TEXT, apply_url TEXT);
    CREATE TABLE apply_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, mode TEXT, tool_type TEXT,
      status TEXT, total_jobs INTEGER, held_count INTEGER DEFAULT 0,
      submitted_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()), started_at INTEGER, finished_at INTEGER,
      approval_mode TEXT
    );
    CREATE TABLE apply_run_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, user_id INTEGER, job_id TEXT,
      status TEXT, reason_code TEXT, reason_detail TEXT, started_at INTEGER, finished_at INTEGER,
      approved_at INTEGER, approved_from_run_job_id INTEGER,
      UNIQUE(run_id, job_id)
    );
    CREATE TABLE apply_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, run_job_id INTEGER, user_id INTEGER,
      job_id TEXT, event_type TEXT, message TEXT, meta TEXT, created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE job_applications (
      user_id INTEGER, job_id TEXT, company TEXT, role TEXT, job_url TEXT, source TEXT,
      location TEXT, apply_mode TEXT, resume_file TEXT, applied_at INTEGER, notes TEXT,
      auto_status TEXT, UNIQUE(user_id, job_id)
    );
    INSERT INTO users (id, username, plan_tier) VALUES (1, 'u1', '${planTier}');
    INSERT INTO domain_profiles (id, user_id, profile_name, is_active) VALUES (10, 1, 'SWE', 1);
    INSERT INTO user_profile (user_id, first_name, last_name, email)
      VALUES (1, 'Ada', 'Lovelace', 'ada@example.com');
  `);
  if (withResume) {
    db.prepare(`INSERT INTO profile_base_resumes (profile_id, user_id, name, content, updated_at)
                VALUES (10, 1, 'r.txt', 'real resume text', unixepoch())`).run();
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 1, planTier, applyMode: "CUSTOM_SAMPLER" };
    next();
  });
  const noop = async () => ({});
  applyRoutes(app, db, (req, _res, next) => next(), noop, noop, noop, noop);
  const server = app.listen(0);
  return { db, server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

const startRun = (baseUrl, body) =>
  fetch(`${baseUrl}/api/apply/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test('mode "manual" is stored as semi, not silently promoted to a full auto-submit run', async () => {
  const { db, server, baseUrl } = setupServer();
  try {
    const res = await startRun(baseUrl, { jobIds: ["j1"], mode: "manual" });
    assert.equal(res.status, 202);
    const body = await res.json();

    const run = db.prepare("SELECT mode FROM apply_runs WHERE id=?").get(body.runId);
    assert.equal(run.mode, "semi",
      'mode "manual" must persist as semi — processRunJob sends anything that is not "semi" to autoApply as "full"');
    assert.equal(body.mode, "semi", "the response must report the mode actually stored");
  } finally { server.close(); }
});

test('mode "semi" still works and an unknown mode still falls back to auto', async () => {
  const { db, server, baseUrl } = setupServer();
  try {
    const semi = await startRun(baseUrl, { jobIds: ["j1"], mode: "semi" }).then(r => r.json());
    assert.equal(db.prepare("SELECT mode FROM apply_runs WHERE id=?").get(semi.runId).mode, "semi");

    const bogus = await startRun(baseUrl, { jobIds: ["j2"], mode: "wat" }).then(r => r.json());
    assert.equal(db.prepare("SELECT mode FROM apply_runs WHERE id=?").get(bogus.runId).mode, "auto",
      "an unrecognised mode must not become semi");
  } finally { server.close(); }
});

test("the client's `tool` field reaches tool_type, so an A+ run is no longer downgraded", async () => {
  const { db, server, baseUrl } = setupServer({ planTier: "PRO" });
  try {
    // `tool` is the client's convention; the route previously read only `toolType`.
    const viaTool = await startRun(baseUrl, { jobIds: ["j1"], tool: "a_plus_resume" }).then(r => r.json());
    assert.equal(db.prepare("SELECT tool_type FROM apply_runs WHERE id=?").get(viaTool.runId).tool_type,
      "a_plus_resume", "`tool` must be honoured — this is the field JobsPanel actually sends");
    assert.equal(viaTool.toolType, "a_plus_resume", "the response must echo the stored tool");

    // toolType kept working for any caller already using it.
    const viaToolType = await startRun(baseUrl, { jobIds: ["j2"], toolType: "a_plus_resume" }).then(r => r.json());
    assert.equal(db.prepare("SELECT tool_type FROM apply_runs WHERE id=?").get(viaToolType.runId).tool_type,
      "a_plus_resume");

    // Default and unknown values both mean generate.
    const dflt = await startRun(baseUrl, { jobIds: ["j3"] }).then(r => r.json());
    assert.equal(db.prepare("SELECT tool_type FROM apply_runs WHERE id=?").get(dflt.runId).tool_type, "generate");
  } finally { server.close(); }
});

test("honouring `tool` does not open a plan-tier bypass for A+", async () => {
  const { db, server, baseUrl } = setupServer({ planTier: "BASIC" });
  try {
    const res = await startRun(baseUrl, { jobIds: ["j1"], tool: "a_plus_resume" });
    assert.equal(res.status, 403, "a BASIC user must not reach A+ generation by asking for it");
    const body = await res.json();
    assert.equal(body.error, "upgrade_required");
    assert.equal(body.requiredTier, "PRO");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM apply_runs").get().n, 0,
      "a rejected run must not be queued");

    // The same user can still start an ordinary generate run.
    const ok = await startRun(baseUrl, { jobIds: ["j1"], tool: "generate" });
    assert.equal(ok.status, 202);
  } finally { server.close(); }
});

test("the response reports the queued ids the client's success message counts", async () => {
  const { server, baseUrl } = setupServer();
  try {
    const body = await startRun(baseUrl, { jobIds: ["j1", "j2", "j3"], mode: "manual" }).then(r => r.json());
    // JobsPanel renders `${data.queued?.length || 0} job(s) started` — previously always "0".
    assert.deepEqual(body.queued, ["j1", "j2", "j3"]);
    assert.equal(body.totalJobs, 3, "totalJobs is kept alongside queued");
  } finally { server.close(); }
});

test("the restored prerequisite gate still fires and reports missing items", async () => {
  const { server, baseUrl } = setupServer({ withResume: false });
  try {
    const res = await startRun(baseUrl, { jobIds: ["j1"], mode: "manual" });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.ok(body.missingPrerequisites.includes("base_resume"),
      "the field name is the contract JobsPanel's catch block reads");
  } finally { server.close(); }
});
