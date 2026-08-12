import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import Database from "better-sqlite3";
import applyRoutes from "../routes/apply.js";

const applySrc = fs.readFileSync("routes/apply.js", "utf8");

// The audit trail used to be one UPDATE over seven columns inside one try/catch. A single missing
// column — an un-migrated deployment, or a stale fixture — threw, the catch swallowed it, and EVERY
// audit field was discarded while the run still reported success. Found exactly that way: a fixture
// predating migration 073 lost artifact id, ATS score, screenshot, submit_verified and the answers.

const AUDIT_COLUMNS = [
  "answers_json", "resume_artifact_id", "resume_ats_score",
  "screenshot_path", "submit_verified", "submit_evidence", "open_questions_json",
];

/** Build a router over a schema that deliberately omits some audit columns. */
function setup({ omit = [] } = {}) {
  const db = new Database(":memory:");
  const auditCols = AUDIT_COLUMNS
    .filter(c => !omit.includes(c))
    .map(c => `${c} ${c.endsWith("_id") || c === "resume_ats_score" || c === "submit_verified" ? "INTEGER" : "TEXT"}`)
    .join(", ");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'PRO');
    CREATE TABLE apply_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, mode TEXT,
      tool_type TEXT, status TEXT, total_jobs INTEGER, held_count INTEGER DEFAULT 0,
      submitted_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()), started_at INTEGER, finished_at INTEGER);
    CREATE TABLE apply_run_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, user_id INTEGER,
      job_id TEXT, status TEXT, reason_code TEXT, reason_detail TEXT, started_at INTEGER,
      finished_at INTEGER, created_at INTEGER DEFAULT (unixepoch())
      ${auditCols ? ", " + auditCols : ""}, UNIQUE(run_id, job_id));
    CREATE TABLE apply_job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, run_job_id INTEGER,
      user_id INTEGER, job_id TEXT, level TEXT DEFAULT 'info', event TEXT, message TEXT,
      details_json TEXT, created_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
    CREATE TABLE apply_idempotency (user_id INTEGER, idem_key TEXT, endpoint TEXT,
      status_code INTEGER, response_json TEXT, created_at INTEGER, PRIMARY KEY (user_id, idem_key));
    INSERT INTO users (id, username) VALUES (1, 'ada');
  `);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
  const noop = async () => ({});
  applyRoutes(app, db, (q, r, n) => n(), noop, noop, noop, noop);
  return db;
}

/**
 * Replays the column-resolution the router performs. NOT the real persistAudit — reaching that needs
 * autoApply to resolve, which needs a browser. The real path is exercised against a deliberately
 * degraded schema by scripts/a3GuardsIntegration.mjs (see docs/auto-apply-non-greenhouse.md); these
 * cover the behaviour contract, and the source-shape tests above pin the implementation to it.
 */
function writeAudit(db, values) {
  const run = db.prepare("INSERT INTO apply_runs (user_id, mode, tool_type, status, total_jobs) VALUES (1,'auto','generate','completed',1)").run();
  const job = db.prepare("INSERT INTO apply_run_jobs (run_id, user_id, job_id, status) VALUES (?,1,'j1','submitted')").run(run.lastInsertRowid);
  const present = new Set(db.prepare("PRAGMA table_info(apply_run_jobs)").all().map(c => c.name));
  const cols = AUDIT_COLUMNS.filter(c => present.has(c));
  if (cols.length) {
    db.prepare(`UPDATE apply_run_jobs SET ${cols.map(c => `${c}=?`).join(", ")} WHERE id=?`)
      .run(...cols.map(c => values[c] ?? null), job.lastInsertRowid);
  }
  return { runJobId: job.lastInsertRowid, written: cols };
}

// ── Source-level guarantees ──────────────────────────────────────────────────

test("the audit UPDATE is built from columns that actually exist", () => {
  assert.match(applySrc, /PRAGMA table_info\(apply_run_jobs\)/,
    "the live schema must be consulted rather than assumed");
  assert.match(applySrc, /UPDATE apply_run_jobs SET \$\{cols\.map\(c => `\$\{c\}=\?`\)\.join\(", "\)\} WHERE id=\?/,
    "the SET list must be built from the resolved columns");
  // The old shape: one hardcoded seven-column UPDATE.
  assert.doesNotMatch(applySrc, /SET answers_json=\?, resume_artifact_id=\?/,
    "a hardcoded multi-column audit UPDATE reinstates the all-or-nothing failure");
});

test("a degraded schema is reported once, loudly, and names the missing columns", () => {
  assert.match(applySrc, /AUDIT DEGRADED — apply_run_jobs is missing: \$\{missing\.join\(", "\)\}/,
    "the operator must be told WHICH columns are missing");
  assert.match(applySrc, /run migrations \(073 adds open_questions_json\)/,
    "and what to do about it");
  assert.match(applySrc, /auditColumnsCache = present/, "resolved once per router, not per job");
});

test("the facts are also written to apply_job_logs, so no schema can lose them", () => {
  assert.match(applySrc, /"audit_recorded"/);
  for (const field of ["resumeArtifactId", "resumeAtsScore", "screenshotPath", "submitVerified", "submitEvidence"]) {
    assert.match(applySrc, new RegExp(`${field}:`), `${field} must be in the durable event`);
  }
  assert.match(applySrc, /columnsWritten:\s*audit\.written/);
  assert.match(applySrc, /columnsSkipped: audit\.skipped/);
});

test("the open_questions event is no longer inside the persistence try/catch", () => {
  // It used to be, so a failed UPDATE also swallowed the questions the correction loop depends on.
  const persistAt = applySrc.indexOf("const audit = persistAudit(runJobId, {");
  const questionsAt = applySrc.indexOf('"open_questions"', persistAt);
  assert.ok(persistAt > 0 && questionsAt > persistAt);
  const between = applySrc.slice(persistAt, questionsAt);
  assert.doesNotMatch(between, /\btry\s*\{/,
    "the open_questions event must not sit inside the audit try/catch");
});

// ── Behaviour on a degraded schema ───────────────────────────────────────────

test("with the full schema every audit column is written", () => {
  const db = setup();
  const { runJobId, written } = writeAudit(db, {
    answers_json: '[{"provenance":"custom_answer"}]', resume_artifact_id: 7, resume_ats_score: 81,
    screenshot_path: "/tmp/a.png", submit_verified: 1, submit_evidence: "confirmation_page",
    open_questions_json: '[{"question":"Q"}]',
  });
  assert.deepEqual(written, AUDIT_COLUMNS);
  const row = db.prepare("SELECT * FROM apply_run_jobs WHERE id=?").get(runJobId);
  assert.equal(row.resume_artifact_id, 7);
  assert.equal(row.submit_verified, 1);
  assert.equal(row.submit_evidence, "confirmation_page");
  assert.ok(row.answers_json && row.open_questions_json);
});

test("one missing column costs only that column — the rest still persist", () => {
  // The exact scenario that lost everything: a schema predating migration 073.
  const db = setup({ omit: ["open_questions_json"] });
  const { runJobId, written } = writeAudit(db, {
    answers_json: '[{"provenance":"field_map_exact"}]', resume_artifact_id: 3, resume_ats_score: 77,
    screenshot_path: "/tmp/b.png", submit_verified: 1, submit_evidence: "url_changed",
    open_questions_json: '[{"question":"Q"}]',
  });
  assert.ok(!written.includes("open_questions_json"));
  assert.equal(written.length, AUDIT_COLUMNS.length - 1);

  const row = db.prepare("SELECT * FROM apply_run_jobs WHERE id=?").get(runJobId);
  assert.equal(row.resume_artifact_id, 3, "the artifact id must survive a missing sibling column");
  assert.equal(row.resume_ats_score, 77);
  assert.equal(row.submit_verified, 1);
  assert.equal(row.submit_evidence, "url_changed");
  assert.equal(row.screenshot_path, "/tmp/b.png");
  assert.ok(row.answers_json, "and the answers must survive too");
});

test("a schema with NO audit columns still accepts the run without throwing", () => {
  const db = setup({ omit: AUDIT_COLUMNS });
  const { runJobId, written } = writeAudit(db, {});
  assert.deepEqual(written, [], "nothing to write");
  // The run row itself is intact — the audit degrading must never fail the application.
  const row = db.prepare("SELECT status FROM apply_run_jobs WHERE id=?").get(runJobId);
  assert.equal(row.status, "submitted");
});

test("the router constructs against a degraded schema without throwing", () => {
  // Not a no-op: applyRoutes registering successfully is what lets the run proceed and the audit
  // degrade, rather than the router failing to build at all.
  for (const omit of [[], ["open_questions_json"], AUDIT_COLUMNS]) {
    assert.doesNotThrow(() => setup({ omit }), `omitting ${omit.length} column(s) must not break setup`);
  }
});
