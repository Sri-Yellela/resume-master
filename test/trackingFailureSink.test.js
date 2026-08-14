// Third fallback: database -> out-of-process sink -> log line.
//
// Migration 076 made a tracking failure survive a restart, but that record needs the same database
// that just refused a write, so an UNREACHABLE database still lost the evidence. This sink is an
// append-only file: no service, no network, no working database. What it must never do is let
// coverage claim healthy while it holds unimported failures.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import Database from "better-sqlite3";
import { createAdminRouter } from "../routes/admin.js";
import { trackApiCall, getTrackingStats, resetTrackingStats } from "../services/usageTracker.js";
import { appendFailure, readPending, pendingCount, drainInto, sinkPath } from "../services/trackingFailureSink.js";

let tmpDir;
function useTempSink() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sink-"));
  process.env.USAGE_FAILURE_SINK_PATH = path.join(tmpDir, "failures.jsonl");
  return process.env.USAGE_FAILURE_SINK_PATH;
}
function cleanup() {
  delete process.env.USAGE_FAILURE_SINK_PATH;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

// A db with the failures table but NO usage_events, and made unwritable for the failures table too
// by simply not creating it — the shape of an unreachable database from trackApiCall's view.
function brokenDb({ withFailuresTable = false } = {}) {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
           INSERT INTO users (id, username) VALUES (1,'admin');`);
  if (withFailuresTable) {
    db.exec(`CREATE TABLE usage_tracking_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT, purpose TEXT, user_id INTEGER,
      error_text TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()), source TEXT);`);
  }
  return db;
}

const quiet = fn => {
  const e = console.error, i = console.info, w = console.warn;
  console.error = () => {}; console.info = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.error = e; console.info = i; console.warn = w; }
};

test("a failure the database cannot record reaches the sink", () => {
  const file = useTempSink();
  try {
    const db = brokenDb();                 // neither usage_events nor usage_tracking_failures
    resetTrackingStats();
    quiet(() => trackApiCall(db, {
      userId: 1, eventType: "resume_generate", purpose: "resume_generate",
      model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 5 },
    }));

    const t = getTrackingStats();
    assert.equal(t.failed, 1);
    assert.equal(t.persistedFailures, 0, "the database could not record it");
    assert.equal(t.unpersistedFailures, 1);
    assert.equal(t.sinkedFailures, 1, "so it must have gone to the sink");
    assert.equal(t.lostFailures, 0);

    const { records } = readPending();
    assert.equal(records.length, 1);
    assert.equal(records[0].model, "claude-sonnet-5");
    assert.equal(records[0].purpose, "resume_generate");
    assert.match(records[0].error_text, /usage_events/);
    // Why it could not be persisted is kept separately from the original failure.
    assert.match(records[0].persist_error, /usage_tracking_failures/);
    assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"), "JSONL lines must be newline-terminated");
  } finally { cleanup(); }
});

test("the sink survives a restart and is drained into the database", () => {
  useTempSink();
  try {
    resetTrackingStats();
    quiet(() => trackApiCall(brokenDb(), {
      userId: 7, eventType: "enrich_job", purpose: "enrich_job",
      model: "claude-haiku-4-5-20251001", usage: { input_tokens: 1, output_tokens: 1 },
    }));
    assert.equal(pendingCount(), 1);

    // Restart: counters gone, file remains.
    resetTrackingStats();
    assert.equal(getTrackingStats().sinkedFailures, 0);
    assert.equal(pendingCount(), 1, "the sink is out of process — it does not reset");

    // Database is back.
    const db = brokenDb({ withFailuresTable: true });
    const result = drainInto(db);
    assert.equal(result.drained, 1);
    assert.equal(result.failed, 0);

    const row = db.prepare("SELECT * FROM usage_tracking_failures").get();
    assert.equal(row.purpose, "enrich_job");
    assert.equal(row.user_id, 7);
    assert.equal(row.source, "sink_recovered",
      "recovered rows must be distinguishable from ones recorded live — it means the DB was down");
    assert.match(row.error_text, /db persist failed/, "the reason it went to the sink is kept");
    assert.equal(pendingCount(), 0, "a drained sink must be cleared, or the next boot re-imports");
  } finally { cleanup(); }
});

test("a drain that cannot import leaves the evidence in place", () => {
  useTempSink();
  try {
    appendFailure({ model: "m", purpose: "p", userId: 1, errorText: "boom", persistError: "db down" });
    // Pre-077 database: the insert names a `source` column that does not exist.
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE usage_tracking_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT, purpose TEXT, user_id INTEGER,
      error_text TEXT, created_at INTEGER);`);
    const r = drainInto(db);
    assert.equal(r.drained, 0);
    assert.ok(r.error, "a drain that cannot run must say so");
    // Losing the evidence would be worse than leaving a stray staging file.
    assert.ok(fs.existsSync(`${sinkPath()}.draining`), "the staged sink must be kept for a retry");
  } finally { cleanup(); }
});

test("an interrupted drain is recovered on the next attempt, without double-importing", () => {
  useTempSink();
  try {
    appendFailure({ model: "m1", purpose: "p1", userId: 1, errorText: "a" });
    const stuck = new Database(":memory:");
    stuck.exec(`CREATE TABLE usage_tracking_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT, purpose TEXT, user_id INTEGER,
      error_text TEXT, created_at INTEGER);`);
    drainInto(stuck);                               // fails, leaves .draining
    assert.ok(fs.existsSync(`${sinkPath()}.draining`));

    const db = brokenDb({ withFailuresTable: true });
    const r = drainInto(db);                        // picks the staging file up
    assert.equal(r.drained, 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_tracking_failures").get().c, 1,
      "exactly once — the staging rename is what prevents a re-import");
    assert.equal(fs.existsSync(`${sinkPath()}.draining`), false);
  } finally { cleanup(); }
});

test("a corrupt line is counted, not allowed to block the rest", () => {
  const file = useTempSink();
  try {
    appendFailure({ model: "good", purpose: "p", userId: 1, errorText: "x" });
    fs.appendFileSync(file, "{ this is not json\n");
    appendFailure({ model: "also-good", purpose: "p", userId: 2, errorText: "y" });

    assert.equal(readPending().corrupt, 1);
    const db = brokenDb({ withFailuresTable: true });
    const r = drainInto(db);
    assert.equal(r.drained, 2, "one bad line must not cost the good records");
    assert.equal(r.corrupt, 1);
  } finally { cleanup(); }
});

test("coverage does not claim healthy while the sink holds unimported failures", async () => {
  useTempSink();
  try {
    appendFailure({ model: "claude-haiku-4-5-20251001", purpose: "enrich_job", userId: 0, errorText: "db gone" });
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
      INSERT INTO users (id, username) VALUES (1,'admin');
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, event_type TEXT NOT NULL,
        event_subtype TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0, cache_creation_tokens INTEGER DEFAULT 0,
        cached INTEGER NOT NULL DEFAULT 0, model TEXT, cost_usd REAL DEFAULT 0,
        ats_score_before INTEGER, ats_score_after INTEGER, duration_ms INTEGER, job_id TEXT,
        company TEXT, success INTEGER NOT NULL DEFAULT 1, error_text TEXT, purpose TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE cache_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, event_type TEXT NOT NULL,
        layer TEXT, domain_module TEXT, tokens_in_cache INTEGER DEFAULT 0,
        tokens_saved INTEGER DEFAULT 0, cost_saved_usd REAL DEFAULT 0, model TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE usage_tracking_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT, purpose TEXT, user_id INTEGER,
        error_text TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()), source TEXT);
      INSERT INTO usage_events (user_id,event_type,purpose,model,cost_usd) VALUES (1,'x','x','claude-sonnet-5',0.01);
    `);
    resetTrackingStats();

    const app = express();
    app.use((req, _res, next) => { req.user = { id: 1, isAdmin: true }; next(); });
    app.use("/api/admin/analytics", createAdminRouter(db));
    const server = app.listen(0);
    try {
      const r = await fetch(`http://localhost:${server.address().port}/api/admin/analytics/spend`)
        .then(x => x.json());
      // The database sees no failure at all, and the counters are clean. Only the file knows.
      assert.equal(r.coverage.failuresInRange, 0);
      assert.equal(r.coverage.sinceBoot.failed, 0);
      assert.equal(r.coverage.sink.pendingNotYetImported, 1);
      assert.equal(r.coverage.healthy, false,
        "a pending sink is a known gap; claiming healthy here is the original defect");
      assert.match(r.coverage.note, /pending in the out-of-process sink/);
      // Structural, not prose: the webhook tier must be reported, and the remaining limit stated.
      assert.equal(typeof r.coverage.webhook.configured, "boolean");
      assert.ok(r.coverage.limitation && r.coverage.limitation.length > 40);
    } finally { server.close(); }
  } finally { cleanup(); }
});

test("a recovered failure is reported as recovered, not as a live record", async () => {
  useTempSink();
  try {
    appendFailure({ model: "claude-sonnet-5", purpose: "resume_generate", userId: 1, errorText: "db gone" });
    const db = brokenDb({ withFailuresTable: true });
    db.exec(`
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, event_type TEXT NOT NULL,
        event_subtype TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0, cache_creation_tokens INTEGER DEFAULT 0,
        cached INTEGER NOT NULL DEFAULT 0, model TEXT, cost_usd REAL DEFAULT 0,
        ats_score_before INTEGER, ats_score_after INTEGER, duration_ms INTEGER, job_id TEXT,
        company TEXT, success INTEGER NOT NULL DEFAULT 1, error_text TEXT, purpose TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE cache_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, event_type TEXT NOT NULL,
        layer TEXT, domain_module TEXT, tokens_in_cache INTEGER DEFAULT 0,
        tokens_saved INTEGER DEFAULT 0, cost_saved_usd REAL DEFAULT 0, model TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()));
    `);
    assert.equal(drainInto(db).drained, 1);

    const app = express();
    app.use((req, _res, next) => { req.user = { id: 1, isAdmin: true }; next(); });
    app.use("/api/admin/analytics", createAdminRouter(db));
    const server = app.listen(0);
    try {
      const r = await fetch(`http://localhost:${server.address().port}/api/admin/analytics/spend`)
        .then(x => x.json());
      assert.equal(r.coverage.failuresInRange, 1);
      assert.equal(r.coverage.recoveredFromSinkInRange, 1,
        "recovered-after-an-outage must not read the same as recorded-live");
      assert.equal(r.coverage.sink.pendingNotYetImported, 0, "and the sink is now clear");
      assert.equal(r.coverage.healthy, false, "the gap still happened");
    } finally { server.close(); }
  } finally { cleanup(); }
});
