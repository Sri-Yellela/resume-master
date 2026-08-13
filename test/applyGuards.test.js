import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import applyRoutes from "../routes/apply.js";

// TASK A3 submit guards, exercised over real HTTP against an in-memory DB.
//
// No scraped_jobs row is inserted, so processRunJob fails fast with "job_not_found" and never
// reaches browser automation. These tests are about admission control — what gets INTO the queue —
// which is where every guard lives. The end-to-end "one Idempotency-Key produces one submission at
// the ATS" claim needs a browser and is verified by scripts/a3GuardsIntegration.mjs.

function setup({ planTier = "PRO", env = {} } = {}) {
  const prevEnv = {};
  for (const [k, v] of Object.entries(env)) { prevEnv[k] = process.env[k]; process.env[k] = v; }

  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'BASIC');
    CREATE TABLE domain_profiles (id INTEGER PRIMARY KEY, user_id INTEGER, profile_name TEXT,
      role_family TEXT, domain TEXT, is_active INTEGER DEFAULT 0);
    CREATE TABLE user_profile (user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
      full_name TEXT, email TEXT, phone TEXT);
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
    -- POST /api/apply reads source/location off this table to backfill a manual record.
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
      UNIQUE(run_id, job_id));
    CREATE TABLE apply_job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, run_job_id INTEGER,
      user_id INTEGER, job_id TEXT, level TEXT DEFAULT 'info', event TEXT, message TEXT,
      details_json TEXT, created_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE job_applications (user_id INTEGER, job_id TEXT, company TEXT, role TEXT, job_url TEXT,
      source TEXT, location TEXT, apply_mode TEXT, resume_file TEXT, applied_at INTEGER, notes TEXT,
      auto_status TEXT, UNIQUE(user_id, job_id));
    CREATE TABLE user_jobs (user_id INTEGER, job_id TEXT, domain_profile_id INTEGER, applied INTEGER DEFAULT 0,
      updated_at INTEGER, UNIQUE(user_id, job_id));
    -- migration 072
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE apply_idempotency (user_id INTEGER NOT NULL, idem_key TEXT NOT NULL, endpoint TEXT NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 200, response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (user_id, idem_key));
    INSERT INTO users (id, username, plan_tier) VALUES (1, 'u1', '${planTier}');
    INSERT INTO domain_profiles (id, user_id, profile_name, is_active) VALUES (10, 1, 'SWE', 1);
    INSERT INTO user_profile (user_id, first_name, last_name, email) VALUES (1, 'Ada', 'Lovelace', 'ada@example.com');
    INSERT INTO profile_base_resumes (profile_id, user_id, name, content, updated_at)
      VALUES (10, 1, 'r.txt', 'real resume text', unixepoch());
  `);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, planTier }; next(); });
  const noop = async () => ({});
  applyRoutes(app, db, (req, _res, next) => next(), noop, noop, noop, noop);
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const restore = () => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    server.close();
  };
  return { db, baseUrl, restore };
}

const post = (baseUrl, path, body, headers = {}) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

// ── Requirement 1: idempotency ───────────────────────────────────────────────

test("a repeated Idempotency-Key returns the original run instead of queueing a second one", async () => {
  const { db, baseUrl, restore } = setup();
  try {
    const key = "retry-storm-1";
    const first = await post(baseUrl, "/api/apply/runs", { jobIds: ["j1", "j2"], mode: "manual" }, { "Idempotency-Key": key });
    const a = await first.json();
    assert.equal(first.status, 202);

    const second = await post(baseUrl, "/api/apply/runs", { jobIds: ["j1", "j2"], mode: "manual" }, { "Idempotency-Key": key });
    const b = await second.json();
    assert.equal(second.status, 202, "a replay returns the ORIGINAL status, not an error");
    assert.equal(b.runId, a.runId, "the replay must report the original run");
    assert.equal(b.idempotentReplay, true, "and must say it is a replay");

    assert.equal(db.prepare("SELECT COUNT(*) n FROM apply_runs").get().n, 1,
      "duplicate applications are worse than none: exactly one run may exist");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM apply_run_jobs").get().n, 2);
  } finally { restore(); }
});

test("without a key, two identical posts are two runs — replay protection is opt-in", async () => {
  const { db, baseUrl, restore } = setup({ env: { APPLY_MAX_ACTIVE_RUNS_PER_USER: "5" } });
  try {
    await post(baseUrl, "/api/apply/runs", { jobIds: ["j1"], mode: "manual" });
    await post(baseUrl, "/api/apply/runs", { jobIds: ["j2"], mode: "manual" });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM apply_runs").get().n, 2);
  } finally { restore(); }
});

test("reusing a key against a different endpoint is a 409, not a wrong body", async () => {
  const { baseUrl, restore } = setup();
  try {
    const key = "shared-key";
    await post(baseUrl, "/api/apply/runs", { jobIds: ["j1"], mode: "manual" }, { "Idempotency-Key": key });
    const clash = await post(baseUrl, "/api/apply", { jobId: "j9", jobUrl: "https://x.test/j9" }, { "Idempotency-Key": key });
    assert.equal(clash.status, 409);
    const body = await clash.json();
    assert.match(body.error, /different endpoint/i);
    assert.equal(body.usedFor, "/api/apply/runs");
  } finally { restore(); }
});

test("POST /api/apply is idempotent too, and a rejected request is not cached", async () => {
  const { baseUrl, restore } = setup();
  try {
    const key = "manual-1";
    const a = await post(baseUrl, "/api/apply", { jobId: "m1", jobUrl: "https://x.test/m1" }, { "Idempotency-Key": key });
    assert.equal(a.status, 200);
    const b = await post(baseUrl, "/api/apply", { jobId: "m1", jobUrl: "https://x.test/m1" }, { "Idempotency-Key": key });
    assert.equal((await b.json()).idempotentReplay, true);

    // A 4xx must NOT be recorded: a transient rejection must not become the key's permanent answer.
    const badKey = "bad-1";
    const bad = await post(baseUrl, "/api/apply", {}, { "Idempotency-Key": badKey });
    assert.equal(bad.status, 400);
    const retry = await post(baseUrl, "/api/apply", { jobId: "m2", jobUrl: "https://x.test/m2" }, { "Idempotency-Key": badKey });
    assert.equal(retry.status, 200, "the same key must work once the request is valid");
    assert.notEqual((await retry.json()).idempotentReplay, true);
  } finally { restore(); }
});

// ── Requirement 2: cap and concurrency ───────────────────────────────────────

test("the per-user daily cap is enforced with a clear error, never a silent drop", async () => {
  const { db, baseUrl, restore } = setup({ env: { APPLY_DAILY_CAP: "3", APPLY_MAX_ACTIVE_RUNS_PER_USER: "9" } });
  try {
    // Two already submitted in the trailing 24h.
    const run = db.prepare("INSERT INTO apply_runs (user_id, mode, tool_type, status, total_jobs) VALUES (1,'auto','generate','completed',2)").run();
    for (const jid of ["old1", "old2"]) {
      db.prepare(`INSERT INTO apply_run_jobs (run_id, user_id, job_id, status, finished_at)
                  VALUES (?, 1, ?, 'submitted', unixepoch())`).run(run.lastInsertRowid, jid);
    }

    const over = await post(baseUrl, "/api/apply/runs", { jobIds: ["a", "b"], mode: "auto" });
    assert.equal(over.status, 429);
    const body = await over.json();
    assert.equal(body.error, "daily_cap_exceeded");
    assert.equal(body.submittedLast24h, 2);
    assert.equal(body.limit, 3);
    assert.equal(body.remaining, 1, "the caller is told exactly how much room is left");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM apply_runs WHERE status='queued'").get().n, 0,
      "nothing may be queued when the cap rejects");

    // Exactly at the limit is allowed.
    const ok = await post(baseUrl, "/api/apply/runs", { jobIds: ["c"], mode: "auto" });
    assert.equal(ok.status, 202);

    // A submission older than 24h does not count against the cap.
    db.prepare("UPDATE apply_run_jobs SET finished_at = unixepoch() - 90000 WHERE job_id IN ('old1','old2')").run();
    assert.equal((await post(baseUrl, "/api/apply/runs", { jobIds: ["d", "e"], mode: "auto" }).then(r => r.json())).ok, true);
  } finally { restore(); }
});

test("semi mode is not subject to the daily cap — a human submits those", async () => {
  const { db, baseUrl, restore } = setup({ env: { APPLY_DAILY_CAP: "1", APPLY_MAX_ACTIVE_RUNS_PER_USER: "9" } });
  try {
    const run = db.prepare("INSERT INTO apply_runs (user_id, mode, tool_type, status, total_jobs) VALUES (1,'auto','generate','completed',1)").run();
    db.prepare(`INSERT INTO apply_run_jobs (run_id, user_id, job_id, status, finished_at)
                VALUES (?, 1, 'old1', 'submitted', unixepoch())`).run(run.lastInsertRowid);
    const res = await post(baseUrl, "/api/apply/runs", { jobIds: ["a", "b", "c"], mode: "manual" });
    assert.equal(res.status, 202, "manual review must stay available when the auto cap is spent");
  } finally { restore(); }
});

test("a user may not stack concurrent runs", async () => {
  const { db, baseUrl, restore } = setup();
  try {
    db.prepare("INSERT INTO apply_runs (user_id, mode, tool_type, status, total_jobs) VALUES (1,'auto','generate','running',1)").run();
    const res = await post(baseUrl, "/api/apply/runs", { jobIds: ["a"], mode: "manual" });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error, "run_already_active");
    assert.equal(body.limit, 1);
  } finally { restore(); }
});

// ── Requirement 4: kill switch ───────────────────────────────────────────────

test("the env kill switch blocks full-auto while leaving semi mode working", async () => {
  const { db, baseUrl, restore } = setup({ env: { APPLY_FULL_AUTO_DISABLED: "1", APPLY_MAX_ACTIVE_RUNS_PER_USER: "9" } });
  try {
    const blocked = await post(baseUrl, "/api/apply/runs", { jobIds: ["a"], mode: "auto" });
    assert.equal(blocked.status, 503);
    const body = await blocked.json();
    assert.equal(body.error, "full_auto_disabled");
    assert.equal(body.retryWithMode, "manual");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM apply_runs").get().n, 0);

    const semi = await post(baseUrl, "/api/apply/runs", { jobIds: ["a"], mode: "manual" });
    assert.equal(semi.status, 202, "semi mode must survive the kill switch");
    assert.equal(db.prepare("SELECT mode FROM apply_runs WHERE id=?").get((await semi.json()).runId).mode, "semi");
  } finally { restore(); }
});

test("the DB setting overrides env, so the switch flips with no restart and no deploy", async () => {
  const { db, baseUrl, restore } = setup({ env: { APPLY_FULL_AUTO_DISABLED: "0", APPLY_MAX_ACTIVE_RUNS_PER_USER: "9" } });
  try {
    // env says enabled; auto is allowed.
    assert.equal((await post(baseUrl, "/api/apply/runs", { jobIds: ["a"], mode: "auto" })).status, 202);

    // Flip the row mid-process — no restart.
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('apply_full_auto_disabled','1')").run();
    const blocked = await post(baseUrl, "/api/apply/runs", { jobIds: ["b"], mode: "auto" });
    assert.equal(blocked.status, 503, "the DB row must take effect immediately");

    // And back off again.
    db.prepare("UPDATE app_settings SET value='0' WHERE key='apply_full_auto_disabled'").run();
    assert.equal((await post(baseUrl, "/api/apply/runs", { jobIds: ["c"], mode: "auto" })).status, 202);
  } finally { restore(); }
});

// ── Requirement 3: audit trail columns exist and are the right shape ─────────

test("migration 072 is present, additive, and byte-identical in both migration paths", async () => {
  const fs = await import("node:fs");
  const server = fs.readFileSync("server.js", "utf8");
  const script = fs.readFileSync("scripts/migrations.js", "utf8");
  const block = (src) => {
    const i = src.indexOf('id: "072_apply_submit_guards"');
    assert.ok(i > 0, "migration 072 must exist");
    return src.slice(i, src.indexOf("\n    },", i));
  };
  const a = block(server), b = block(script);
  assert.equal(a, b, "the migration must be byte-identical in server.js and scripts/migrations.js");

  // Additive only: no DROP/rename of existing apply tables.
  assert.doesNotMatch(a, /DROP\s+TABLE\s+apply_run_jobs|DROP\s+COLUMN/i);
  for (const col of ["answers_json", "resume_artifact_id", "resume_ats_score", "screenshot_path", "submit_verified", "submit_evidence"]) {
    assert.match(a, new RegExp(`ALTER TABLE apply_run_jobs ADD COLUMN ${col}`), `must add ${col}`);
  }
  assert.match(a, /CREATE TABLE IF NOT EXISTS apply_idempotency/);
  assert.match(a, /CREATE TABLE IF NOT EXISTS app_settings/);

  // 069 was already taken by pipeline_runs, so A3's prompt-suggested id would have collided.
  assert.match(server, /id: "069_pipeline_runs"/, "069 is not free — 072 is the correct next id");
});
