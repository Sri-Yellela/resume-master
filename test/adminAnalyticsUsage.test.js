import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import Database from "better-sqlite3";
import { createAdminRouter } from "../routes/admin.js";
import { trackApiCall } from "../services/usageTracker.js";

function setupServer() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL
    );
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      event_subtype TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      cost_usd REAL DEFAULT 0,
      ats_score_before INTEGER,
      ats_score_after INTEGER,
      duration_ms INTEGER,
      job_id TEXT,
      company TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      error_text TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE cache_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      layer TEXT,
      domain_module TEXT,
      tokens_in_cache INTEGER DEFAULT 0,
      tokens_saved INTEGER DEFAULT 0,
      cost_saved_usd REAL DEFAULT 0,
      model TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE scrape_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      search_query TEXT NOT NULL,
      raw_count INTEGER DEFAULT 0,
      filtered_count INTEGER DEFAULT 0,
      inserted_count INTEGER DEFAULT 0,
      duplicate_count INTEGER DEFAULT 0,
      ghost_count INTEGER DEFAULT 0,
      irrelevant_count INTEGER DEFAULT 0,
      duration_ms INTEGER,
      success INTEGER NOT NULL DEFAULT 1,
      error_text TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE user_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      monthly_resumes INTEGER,
      monthly_ats_scores INTEGER,
      monthly_job_scrapes INTEGER,
      monthly_pdf_exports INTEGER,
      monthly_apply_runs INTEGER,
      monthly_token_budget INTEGER,
      daily_resumes INTEGER,
      daily_job_scrapes INTEGER,
      warning_threshold REAL DEFAULT 0.8,
      notes TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_by INTEGER
    );
    INSERT INTO users VALUES (1, 'admin');
  `);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 1, isAdmin: true };
    next();
  });
  app.use("/api/admin/analytics", createAdminRouter(db));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { db, server, baseUrl };
}

test("admin analytics exposes recent model-call token usage", async () => {
  const { db, server, baseUrl } = setupServer();
  const originalInfo = console.info;
  const logs = [];
  console.info = (...args) => logs.push(args.join(" "));
  try {
    trackApiCall(db, {
      userId: 1,
      eventType: "resume_generate",
      eventSubtype: "CUSTOM_SAMPLER",
      model: "claude-sonnet-4-20250514",
      usage: {
        input_tokens: 1200,
        output_tokens: 800,
        cache_read_input_tokens: 24000,
        cache_creation_tokens: 0,
      },
      durationMs: 1500,
      jobId: "job-1",
      company: "Acme",
      domainModule: "engineering",
    });

    const data = await fetch(`${baseUrl}/api/admin/analytics/model-calls?pageSize=10`).then(r => r.json());
    assert.equal(data.rows.length, 1);
    assert.equal(data.rows[0].username, "admin");
    assert.equal(data.rows[0].event_type, "resume_generate");
    assert.equal(data.rows[0].event_subtype, "CUSTOM_SAMPLER");
    assert.equal(data.rows[0].input_tokens, 1200);
    assert.equal(data.rows[0].output_tokens, 800);
    assert.equal(data.rows[0].cache_read_tokens, 24000);
    assert.equal(data.rows[0].cache_state, "partial");
    assert.equal(data.rows[0].model, "claude-sonnet-4-20250514");
    assert.ok(data.rows[0].cost_usd > 0);
    assert.ok(logs.some(line => line.includes("[usage] model_call") && line.includes('"cacheState":"partial"')));

    const cacheRows = db.prepare("SELECT event_type FROM cache_events ORDER BY id").all();
    assert.deepEqual(cacheRows.map(r => r.event_type), ["cache_partial"]);
  } finally {
    console.info = originalInfo;
    server.close();
  }
});

test("admin cache analytics distinguish warm partial writes and cold misses", async () => {
  const { db, server, baseUrl } = setupServer();
  const originalInfo = console.info;
  console.info = () => {};
  try {
    trackApiCall(db, {
      userId: 1,
      eventType: "resume_generate",
      eventSubtype: "TAILORED",
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_tokens: 0 },
    });
    trackApiCall(db, {
      userId: 1,
      eventType: "resume_generate",
      eventSubtype: "TAILORED",
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 0, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_tokens: 0 },
    });
    trackApiCall(db, {
      userId: 1,
      eventType: "resume_format",
      eventSubtype: "TAILORED",
      model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 600, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_tokens: 400 },
    });
    trackApiCall(db, {
      userId: 1,
      eventType: "ats_score",
      eventSubtype: "TAILORED",
      model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 300, output_tokens: 90, cache_read_input_tokens: 0, cache_creation_tokens: 0 },
    });

    const cache = await fetch(`${baseUrl}/api/admin/analytics/cache`).then(r => r.json());
    assert.equal(cache.totalCacheHits, 1);
    assert.equal(cache.totalCachePartials, 1);
    assert.equal(cache.totalCacheWrites, 1);
    assert.equal(cache.totalCacheMisses, 1);
    assert.equal(cache.hitRate, 0.5);
    assert.equal(cache.fullHitRate, 0.25);
    assert.equal(cache.partialHitRate, 0.25);
    assert.ok(cache.cacheReadTokenRatio > 0);

    const overview = await fetch(`${baseUrl}/api/admin/analytics/overview`).then(r => r.json());
    assert.ok(overview.actionCosts.some(row => row.event_type === "resume_generate"));
    assert.ok(overview.actionCosts.some(row => row.event_type === "resume_format"));
    assert.ok(overview.actionCosts.some(row => row.event_type === "ats_score"));
  } finally {
    console.info = originalInfo;
    server.close();
  }
});

test("classifier tracking is wired into generation classifier call sites", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const classifier = fs.readFileSync("services/classifier.js", "utf8");
  assert.match(classifier, /options\.onUsage/);
  assert.match(server, /eventType:\s*"classifier"/);
  assert.match(server, /eventSubtype:\s*mode/);
  assert.match(server, /eventSubtype:\s*"profile_setup"/);
});

test("admin usage panel includes model-call token ledger", () => {
  const panel = fs.readFileSync("client/src/panels/AdminPanel.jsx", "utf8");
  assert.match(panel, /\/api\/admin\/analytics\/model-calls/);
  assert.match(panel, /Generation \/ Model Call Usage/);
  assert.match(panel, /Cost by Generation Action/);
  assert.match(panel, /Cache Read/);
  assert.match(panel, /Cache Create/);
  assert.match(panel, /Partial cache calls/);
});
