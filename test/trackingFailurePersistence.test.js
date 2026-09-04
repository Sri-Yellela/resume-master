// The in-process failure counters added with the wrapper reset on restart, so a tracking failure
// followed by a deploy left NO trace: coverage read healthy for a gap that really happened.
// Migration 076 persists each failure. These tests pin that, and pin the one case persistence
// cannot cover — because a coverage number that overstates itself is the original defect.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import Database from "better-sqlite3";
import { createAdminRouter } from "../routes/admin.js";
import { trackApiCall, getTrackingStats, resetTrackingStats } from "../services/usageTracker.js";

// A failure the database cannot record falls through to the out-of-process sink, which defaults to
// data/ next to the production database. Redirect it: a test must not write into the app's data
// directory, and one that did would make every later assertion about sink contents order-dependent.
const tmpSink = fs.mkdtempSync(path.join(os.tmpdir(), "sink-persist-"));
process.env.USAGE_FAILURE_SINK_PATH = path.join(tmpSink, "failures.jsonl");
test.after(() => { try { fs.rmSync(tmpSink, { recursive: true, force: true }); } catch {} });

const FAILURES_DDL = `
  CREATE TABLE usage_tracking_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT, purpose TEXT, user_id INTEGER, error_text TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );`;

function setup({ withFailuresTable = true, withUsageEvents = true } = {}) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    INSERT INTO users (id, username) VALUES (1,'admin'), (0,'system');
    CREATE TABLE cache_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL, layer TEXT, domain_module TEXT,
      tokens_in_cache INTEGER DEFAULT 0, tokens_saved INTEGER DEFAULT 0,
      cost_saved_usd REAL DEFAULT 0, model TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    ${withFailuresTable ? FAILURES_DDL : ""}
  `);
  if (withUsageEvents) {
    db.exec(`CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL, event_subtype TEXT,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_creation_tokens INTEGER DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0, model TEXT, cost_usd REAL DEFAULT 0,
      ats_score_before INTEGER, ats_score_after INTEGER, duration_ms INTEGER,
      job_id TEXT, company TEXT, success INTEGER NOT NULL DEFAULT 1, error_text TEXT,
      purpose TEXT, provider TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );`);
  }
  return db;
}

const quiet = fn => {
  const e = console.error, i = console.info;
  console.error = () => {}; console.info = () => {};
  try { return fn(); } finally { console.error = e; console.info = i; }
};

const track = (db, over = {}) => trackApiCall(db, {
  userId: 1, eventType: "resume_generate", purpose: "resume_generate",
  model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 5 }, ...over,
});

test("a failed usage insert is written to usage_tracking_failures", () => {
  // usage_events is absent, so the insert throws — the exact shape of the real-run probe that
  // renamed the table out from under the tracker.
  const db = setup({ withUsageEvents: false });
  resetTrackingStats();
  quiet(() => track(db));

  const rows = db.prepare("SELECT * FROM usage_tracking_failures").all();
  assert.equal(rows.length, 1, "the gap must be persisted, not only counted in memory");
  assert.equal(rows[0].model, "claude-sonnet-5");
  assert.equal(rows[0].purpose, "resume_generate");
  assert.match(rows[0].error_text, /usage_events/);
  assert.ok(rows[0].created_at > 0);

  const t = getTrackingStats();
  assert.equal(t.failed, 1);
  assert.equal(t.persistedFailures, 1);
  assert.equal(t.unpersistedFailures, 0);
});

test("the persisted record survives a process restart", () => {
  const db = setup({ withUsageEvents: false });
  resetTrackingStats();
  quiet(() => track(db));
  assert.equal(getTrackingStats().failed, 1);

  // Simulate the restart that used to erase all evidence: in-process counters go to zero while
  // the database keeps the row.
  resetTrackingStats();
  assert.equal(getTrackingStats().failed, 0, "counters reset, as they do on a deploy");
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM usage_tracking_failures").get().c, 1,
    "the failure must still be visible after the counters are gone — this is the whole point"
  );
});

test("tracking a failure never throws, even when it cannot be persisted", () => {
  // Neither table exists: the usage insert fails AND the failure record fails. trackApiCall must
  // still not throw into the caller, because a model call already succeeded and its result is owed
  // to the user.
  const db = setup({ withUsageEvents: false, withFailuresTable: false });
  resetTrackingStats();
  assert.doesNotThrow(() => quiet(() => track(db)));

  const t = getTrackingStats();
  assert.equal(t.failed, 1);
  assert.equal(t.persistedFailures, 0);
  assert.equal(t.unpersistedFailures, 1, "an unpersistable failure must be counted separately");
  assert.ok(t.lastPersistError, "and the reason it could not be persisted must be kept");
});

test("a failure record has no FK on user_id, so an FK violation is still recordable", () => {
  // A FOREIGN KEY violation on usage_events.user_id was the first real failure the wrapper hit.
  // If this table carried an FK too, the record would fail for exactly that case.
  const db = setup();
  db.exec(`DROP TABLE usage_events;
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      event_type TEXT NOT NULL, event_subtype TEXT,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_creation_tokens INTEGER DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0, model TEXT, cost_usd REAL DEFAULT 0,
      ats_score_before INTEGER, ats_score_after INTEGER, duration_ms INTEGER,
      job_id TEXT, company TEXT, success INTEGER NOT NULL DEFAULT 1, error_text TEXT,
      purpose TEXT, provider TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );`);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1, "better-sqlite3 enforces FKs by default");

  resetTrackingStats();
  quiet(() => track(db, { userId: 987654, purpose: "enrich_job" }));

  const row = db.prepare("SELECT * FROM usage_tracking_failures ORDER BY id DESC LIMIT 1").get();
  assert.ok(row, "an FK violation must still produce a failure record");
  assert.equal(row.user_id, 987654, "the offending user_id is kept, unconstrained");
  assert.match(row.error_text, /FOREIGN KEY/i);
  assert.equal(getTrackingStats().persistedFailures, 1);
});

test("the spend endpoint reports persisted failures and stops claiming healthy", async () => {
  const db = setup({ withUsageEvents: false });
  resetTrackingStats();
  quiet(() => track(db, { purpose: "enrich_job" }));

  // Recreate usage_events so the endpoint's own reads work, leaving the failure row behind.
  db.exec(`CREATE TABLE usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    event_type TEXT NOT NULL, event_subtype TEXT,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0, cache_creation_tokens INTEGER DEFAULT 0,
    cached INTEGER NOT NULL DEFAULT 0, model TEXT, cost_usd REAL DEFAULT 0,
    ats_score_before INTEGER, ats_score_after INTEGER, duration_ms INTEGER,
    job_id TEXT, company TEXT, success INTEGER NOT NULL DEFAULT 1, error_text TEXT,
    purpose TEXT, provider TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );`);
  // Counters cleared, as after a deploy — only the persisted row remains.
  resetTrackingStats();

  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1, isAdmin: true }; next(); });
  app.use("/api/admin/analytics", createAdminRouter(db));
  const server = app.listen(0);
  try {
    const r = await fetch(`http://localhost:${server.address().port}/api/admin/analytics/spend`)
      .then(x => x.json());
    assert.equal(r.coverage.sinceBoot.failed, 0, "the in-process counter has been reset");
    assert.equal(r.coverage.failuresInRange, 1, "but the persisted failure is still reported");
    assert.equal(r.coverage.failuresAllTime, 1);
    assert.equal(r.coverage.healthy, false,
      "coverage must NOT claim healthy on the strength of a counter that was wiped by a restart");
    assert.match(r.coverage.note, /NOT in these totals/);
    assert.equal(r.coverage.recentFailures[0].purpose, "enrich_job");
  } finally { server.close(); }
});

test("a pre-076 database is reported as unavailable, not counted as zero", async () => {
  const db = setup({ withFailuresTable: false });
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1, isAdmin: true }; next(); });
  app.use("/api/admin/analytics", createAdminRouter(db));
  const server = app.listen(0);
  try {
    const r = await fetch(`http://localhost:${server.address().port}/api/admin/analytics/spend`)
      .then(x => x.json());
    assert.equal(r.coverage.persistedHistory.available, false);
    assert.match(r.coverage.persistedHistory.reason, /076/);
    assert.equal(r.coverage.failuresInRange, null,
      "null, not 0 — an older schema has no answer, and 0 would be a claim it cannot support");
  } finally { server.close(); }
});
