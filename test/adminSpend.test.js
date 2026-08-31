// U2: one place to see LLM spend.
//
// The failure this guards against is not an error — it is a confident number. Before U1 the cost
// panel aggregated 4 of 14 call sites and showed the result as if it were the total, so the gap
// was invisible. These tests pin the two things that make a total trustworthy: that it reconciles
// with the table it claims to summarise, and that an absence of DATA never renders as $0 spend.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createAdminRouter } from "../routes/admin.js";
import { at } from "../test-support/sourceAnchors.js";

// Point the out-of-process sink at a scratch directory: these tests assert that nothing is
// pending, and an ambient sink file left by any other run would make that assertion about the
// machine rather than about the code.
const tmpSink = fs.mkdtempSync(path.join(os.tmpdir(), "sink-spend-"));
process.env.USAGE_FAILURE_SINK_PATH = path.join(tmpSink, "failures.jsonl");
test.after(() => { try { fs.rmSync(tmpSink, { recursive: true, force: true }); } catch {} });

function setup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
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
      ats_score_before INTEGER, ats_score_after INTEGER,
      duration_ms INTEGER, job_id TEXT, company TEXT,
      success INTEGER NOT NULL DEFAULT 1, error_text TEXT,
      purpose TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE cache_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL, event_type TEXT NOT NULL,
      layer TEXT, domain_module TEXT,
      tokens_in_cache INTEGER DEFAULT 0, tokens_saved INTEGER DEFAULT 0,
      cost_saved_usd REAL DEFAULT 0, model TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE usage_tracking_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT, purpose TEXT, user_id INTEGER, error_text TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    INSERT INTO users (id, username) VALUES (1,'admin'), (0,'system');
  `);
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1, isAdmin: true }; next(); });
  app.use("/api/admin/analytics", createAdminRouter(db));
  const server = app.listen(0);
  const baseUrl = `http://localhost:${server.address().port}`;
  return { db, server, baseUrl };
}

const addRow = (db, o = {}) => db.prepare(`
  INSERT INTO usage_events (user_id,event_type,purpose,model,input_tokens,output_tokens,
    cache_read_tokens,cache_creation_tokens,cached,cost_usd,success,created_at)
  VALUES (@user_id,@event_type,@purpose,@model,@input_tokens,@output_tokens,
    @cache_read_tokens,@cache_creation_tokens,@cached,@cost_usd,@success,@created_at)`).run({
  user_id: 1, event_type: "resume_generate", purpose: "resume_generate",
  model: "claude-sonnet-5", input_tokens: 100, output_tokens: 50,
  cache_read_tokens: 0, cache_creation_tokens: 0, cached: 0, cost_usd: 0.001,
  success: 1, created_at: Math.floor(Date.now() / 1000), ...o,
});

test("spend totals reconcile with a hand-run aggregate over usage_events", async () => {
  const { db, server, baseUrl } = setup();
  try {
    addRow(db, { model: "claude-sonnet-5", purpose: "resume_generate", input_tokens: 200, output_tokens: 100, cost_usd: 0.0014 });
    addRow(db, { model: "claude-haiku-4-5-20251001", purpose: "enrich_job", user_id: 0, input_tokens: 50, output_tokens: 20, cost_usd: 0.00015 });
    addRow(db, { model: "claude-haiku-4-5-20251001", purpose: "classifier", user_id: 0, input_tokens: 30, output_tokens: 10, cache_read_tokens: 40, cost_usd: 0.00008 });

    const r = await fetch(`${baseUrl}/api/admin/analytics/spend`).then(x => x.json());
    const { from, to } = r.range;
    const hand = db.prepare(`SELECT COUNT(*) calls, SUM(cost_usd) cost, SUM(input_tokens) i,
      SUM(output_tokens) o, SUM(cache_read_tokens) cr, SUM(cache_creation_tokens) cc
      FROM usage_events WHERE created_at BETWEEN ? AND ?`).get(from, to);

    assert.equal(r.totals.calls, hand.calls);
    assert.ok(Math.abs(r.totals.cost_usd - hand.cost) < 1e-9);
    assert.equal(r.totals.input_tokens, hand.i);
    assert.equal(r.totals.output_tokens, hand.o);
    assert.equal(r.totals.total_tokens, hand.i + hand.o + hand.cr + hand.cc);
    // A breakdown that does not add up to its own total is the exact defect being guarded.
    assert.equal(r.byModel.reduce((s, m) => s + m.calls, 0), hand.calls);
    assert.equal(r.byPurpose.reduce((s, p) => s + p.calls, 0), hand.calls);
    assert.equal(r.byDay.reduce((s, d) => s + d.calls, 0), hand.calls);
  } finally { server.close(); }
});

test("rows predating the purpose column are shown, not dropped", async () => {
  const { db, server, baseUrl } = setup();
  try {
    addRow(db, { purpose: "resume_generate" });
    addRow(db, { purpose: null, event_type: "legacy_event", cost_usd: 0.02 });

    const r = await fetch(`${baseUrl}/api/admin/analytics/spend`).then(x => x.json());
    const unattributed = r.byPurpose.find(p => p.purpose === "unattributed");
    assert.ok(unattributed, "a NULL purpose must surface as 'unattributed'");
    assert.equal(unattributed.calls, 1);
    // Silently omitting them is how a partial total passes for a complete one.
    assert.equal(r.byPurpose.reduce((s, p) => s + p.calls, 0), r.totals.calls);
  } finally { server.close(); }
});

test("an empty table reads as NO DATA, never as no spend", async () => {
  const { server, baseUrl } = setup();
  try {
    const r = await fetch(`${baseUrl}/api/admin/analytics/spend`).then(x => x.json());
    assert.equal(r.empty, true);
    assert.equal(r.totals.calls, 0);
    assert.match(r.emptyReason, /no model call has ever been recorded/i);
    assert.match(r.emptyReason, /absence of DATA, not an absence of spend/i);
    assert.equal(r.dataSpan.totalRowsAllTime, 0);
    // null, not 0 — a 0% hit rate is a claim about calls that did not happen.
    assert.equal(r.cache.hitRate, null);
  } finally { server.close(); }
});

test("an empty RANGE is distinguished from an empty table", async () => {
  const { db, server, baseUrl } = setup();
  try {
    addRow(db);
    const r = await fetch(`${baseUrl}/api/admin/analytics/spend?from=1000000&to=1000001`).then(x => x.json());
    assert.equal(r.empty, true);
    assert.match(r.emptyReason, /in this date range/i);
    assert.equal(r.dataSpan.totalRowsAllTime, 1, "must say data exists outside the range");
  } finally { server.close(); }
});

test("coverage is reported explicitly, with its scope stated", async () => {
  const { db, server, baseUrl } = setup();
  try {
    addRow(db);
    const r = await fetch(`${baseUrl}/api/admin/analytics/spend`).then(x => x.json());
    assert.equal(typeof r.coverage.sinceBoot.recorded, "number");
    assert.equal(typeof r.coverage.sinceBoot.failed, "number");
    assert.equal(typeof r.coverage.healthy, "boolean");
    assert.ok(r.coverage.note, "coverage must carry a plain-language verdict");
    // Persisted history is the figure that survives a restart.
    assert.equal(r.coverage.persistedHistory.available, true);
    assert.equal(r.coverage.failuresInRange, 0);
    assert.equal(r.coverage.failuresAllTime, 0);
    // Assert the SHAPE of the escalation chain, not its prose. Matching wording here has broken
    // three times as the text was refined, which teaches people to delete the assertion.
    assert.equal(r.coverage.sink.available, true);
    assert.equal(r.coverage.sink.pendingNotYetImported, 0);
    assert.equal(typeof r.coverage.webhook.configured, "boolean");
    assert.equal(typeof r.coverage.sinceBoot.lost, "number");
    assert.equal(typeof r.coverage.sinceBoot.webhookAttempts, "number");
    // The limit that none of the tiers covers must be stated somewhere non-empty.
    assert.ok(r.coverage.limitation && r.coverage.limitation.length > 40);
  } finally { server.close(); }
});

test("the endpoint is read-only and admin-gated", async () => {
  const { db, server, baseUrl } = setup();
  try {
    addRow(db);
    const before = db.prepare("SELECT COUNT(*) c FROM usage_events").get().c;
    await fetch(`${baseUrl}/api/admin/analytics/spend`).then(x => x.json());
    assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_events").get().c, before,
      "an analytics read must not write");

    const admin = fs.readFileSync("routes/admin.js", "utf8");
    const spendBlock = admin.slice(at(admin, 'router.get("/spend"'), at(admin, 'router.get("/limits/:userId"'));
    assert.match(spendBlock, /requireAdmin/, "the spend endpoint must be admin-gated");
    // Match actual SQL statements, not bare keywords: the endpoint's own coverage message
    // contains the word "insert", and a guard that trips on prose is a guard people delete.
    assert.doesNotMatch(
      spendBlock,
      /\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(TABLE|INDEX)|ALTER\s+TABLE)\b/i,
      "the spend endpoint must be a read-only aggregation");
    assert.doesNotMatch(spendBlock, /messages\.create|callModel/,
      "an analytics read must never call a model");
  } finally { server.close(); }
});

