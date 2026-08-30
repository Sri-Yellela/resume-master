// TASK G5 — amortise the gate per PORTAL, not per application.
//
// The end-to-end behaviour is verified in scripts/g5PortalBatch.mjs, with a real browser working
// through a real batch. What is here is the contract between the server's grouping and the client
// that renders it, and the recovery path for a session that dies mid-batch — including the one
// property that matters most about it: reopening a handoff must not un-spend a single-use token.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import Database from "better-sqlite3";
import applyRoutes from "../routes/apply.js";
import { MIGRATIONS } from "../scripts/migrations.js";
import { buildGatePacket } from "../services/applyGatePacket.js";

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

const PAYLOAD = {
  field_map: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" },
  handler_map: {}, custom_answers: {},
};

function setup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'PRO');
    CREATE TABLE user_profile (user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
      full_name TEXT, email TEXT, phone TEXT, custom_answers TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, title TEXT, company TEXT, url TEXT,
      apply_url TEXT, source TEXT, location TEXT);
    CREATE TABLE resumes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, job_id TEXT,
      apply_mode TEXT, ats_score INTEGER, html TEXT, updated_at INTEGER);
    CREATE TABLE apply_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, mode TEXT,
      approval_mode TEXT, tool_type TEXT, status TEXT, total_jobs INTEGER, held_count INTEGER DEFAULT 0,
      submitted_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()), started_at INTEGER, finished_at INTEGER);
    CREATE TABLE apply_run_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, user_id INTEGER,
      approved_at INTEGER, approved_from_run_job_id INTEGER, job_id TEXT, status TEXT,
      reason_code TEXT, reason_detail TEXT, started_at INTEGER, finished_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()), answers_json TEXT, resume_artifact_id INTEGER,
      resume_ats_score INTEGER, screenshot_path TEXT, submit_verified INTEGER, submit_evidence TEXT,
      open_questions_json TEXT, hidden_at INTEGER, UNIQUE(run_id, job_id));
    CREATE TABLE apply_job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, run_job_id INTEGER,
      user_id INTEGER, job_id TEXT, level TEXT DEFAULT 'info', event TEXT, message TEXT,
      details_json TEXT, created_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE apply_idempotency (user_id INTEGER NOT NULL, idem_key TEXT NOT NULL, endpoint TEXT NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 200, response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (user_id, idem_key));
    CREATE TABLE job_applications (user_id INTEGER, job_id TEXT, company TEXT, role TEXT, job_url TEXT,
      source TEXT, location TEXT, apply_mode TEXT, resume_file TEXT, applied_at INTEGER, notes TEXT,
      auto_status TEXT,
      ats_score_at_apply INTEGER, ats_scorer_version TEXT, ats_report_at_apply TEXT, ats_scored_at INTEGER,
      UNIQUE(user_id, job_id));
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT (unixepoch()));
    INSERT INTO users (id, username) VALUES (1, 'ada');
    INSERT INTO users (id, username) VALUES (2, 'grace');
    INSERT INTO apply_runs (id, user_id, mode, status, total_jobs) VALUES (1, 1, 'auto', 'completed', 4);
  `);
  for (const id of ["079_apply_gate_packets", "080_apply_gate_review"]) {
    db.exec(MIGRATIONS.find(m => m.id === id).sql);
  }

  const seed = (origin, jobId, userId = 1) => {
    const applyUrl = `${origin}/apply/${jobId}`;
    db.prepare(`INSERT INTO scraped_jobs (job_id, title, company, url, apply_url, source)
                VALUES (?, ?, 'Co', ?, ?, 'ashby')`).run(jobId, `Role ${jobId}`, applyUrl, applyUrl);
    const rj = db.prepare(`INSERT INTO apply_run_jobs (run_id, user_id, job_id, status, reason_code)
                           VALUES (1, ?, ?, 'held_gate', 'login_required')`).run(userId, jobId);
    const packet = buildGatePacket({
      autofillPayload: PAYLOAD, applyUrl, jobId, runId: 1,
      runJobId: Number(rj.lastInsertRowid), gateReason: "login_required",
    });
    const p = db.prepare(`INSERT INTO apply_gate_packets
      (user_id, run_id, run_job_id, job_id, apply_url, expected_origin, gate_reason, answers_json,
       token_hash, expires_at)
      VALUES (?,1,?,?,?,?,'login_required',?,?,0)`)
      .run(userId, Number(rj.lastInsertRowid), jobId, applyUrl, origin,
           JSON.stringify(packet), `unminted:${jobId}`);
    return { packetId: Number(p.lastInsertRowid), runJobId: Number(rj.lastInsertRowid) };
  };

  const app = express();
  app.use(express.json());
  let currentUser = 1;
  app.use((req, _res, next) => { req.user = { id: currentUser, planTier: "PRO" }; next(); });
  applyRoutes(app, db, (q, r, n) => n(), () => PAYLOAD,
    async () => ({ error: "x" }), async () => Buffer.from("pdf"), async () => ({}));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base, seed, asUser: (id) => { currentUser = id; } };
}

const get = (base, p) => fetch(`${base}${p}`).then(async r => ({ status: r.status, body: await r.json() }));
const post = (base, p, b) => fetch(`${base}${p}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}),
}).then(async r => ({ status: r.status, body: await r.json() }));

// ── Grouping ─────────────────────────────────────────────────────────────────

test("held gates group by the portal you have to sign in to, biggest batch first", async () => {
  const t = setup();
  try {
    t.seed("https://portal-a.example.com", "a1");
    t.seed("https://portal-a.example.com", "a2");
    t.seed("https://portal-a.example.com", "a3");
    t.seed("https://portal-b.example.com", "b1");

    const { body } = await get(t.base, "/api/apply/gate-packets");
    assert.equal(body.portals.length, 2);
    assert.equal(body.portals[0].count, 3, "the biggest batch is where crossing a gate once buys most");
    assert.equal(body.portals[0].host, "portal-a.example.com");
    assert.equal(body.portals[1].count, 1);
    assert.deepEqual(body.portals[0].packetIds.length, 3);
  } finally { t.server.close(); t.db.close(); }
});

test("the grouping is by ORIGIN, which is the unit the activeTab grant is scoped to", async () => {
  // G0 §9: the grant survives every same-origin navigation and dies when it leaves. Grouping by
  // company or by host-without-scheme would put packets in one batch that a single session cannot
  // actually serve.
  const t = setup();
  try {
    t.seed("https://portal.example.com", "s1");
    t.seed("http://portal.example.com", "s2");            // same host, different origin
    const { body } = await get(t.base, "/api/apply/gate-packets");
    assert.equal(body.portals.length, 2, "http and https are different origins and different sessions");
  } finally { t.server.close(); t.db.close(); }
});

test("a consumed packet leaves its portal group", async () => {
  const t = setup();
  try {
    const a = t.seed("https://p.example.com", "a1");
    t.seed("https://p.example.com", "a2");
    t.db.prepare("UPDATE apply_gate_packets SET consumed_at=unixepoch() WHERE id=?").run(a.packetId);
    const { body } = await get(t.base, "/api/apply/gate-packets");
    assert.equal(body.portals[0].count, 1, "a released handoff is no longer waiting");
  } finally { t.server.close(); t.db.close(); }
});

test("the grouping never carries an answer value", async () => {
  const t = setup();
  try {
    t.seed("https://p.example.com", "a1");
    const { body } = await get(t.base, "/api/apply/gate-packets");
    const asText = JSON.stringify(body.portals);
    assert.ok(!asText.includes("ada@example.com"), "opening a queue must not spray answers into a list");
    assert.ok(!asText.includes("Lovelace"));
  } finally { t.server.close(); t.db.close(); }
});

test("one user's portals are invisible to another", async () => {
  const t = setup();
  try {
    t.seed("https://p.example.com", "mine", 1);
    t.seed("https://p.example.com", "theirs", 2);
    t.asUser(1);
    const { body } = await get(t.base, "/api/apply/gate-packets");
    assert.equal(body.portals[0].count, 1);
    assert.equal(body.packets.length, 1);
  } finally { t.server.close(); t.db.close(); }
});

// ── A session that went stale mid-batch (requirement 4) ──────────────────────

test("REOPENING A HANDOFF ISSUES A NEW PACKET RATHER THAN UN-SPENDING A TOKEN", async () => {
  // The property that matters. Clearing consumed_at would make "single use" conditional on our own
  // bookkeeping being right; a fresh packet keeps it absolute and leaves the original auditable.
  const t = setup();
  try {
    const a = t.seed("https://p.example.com", "a1");
    t.db.prepare("UPDATE apply_gate_packets SET consumed_at=unixepoch() WHERE id=?").run(a.packetId);

    const { status, body } = await post(t.base, `/api/apply/gate-packets/${a.packetId}/reopen`);
    assert.equal(status, 200);
    assert.equal(body.reopened, true);
    assert.notEqual(body.packetId, a.packetId, "a NEW row");

    const original = t.db.prepare("SELECT consumed_at, token_hash FROM apply_gate_packets WHERE id=?").get(a.packetId);
    assert.notEqual(original.consumed_at, null, "the original stays consumed");

    const fresh = t.db.prepare("SELECT * FROM apply_gate_packets WHERE id=?").get(body.packetId);
    assert.equal(fresh.consumed_at, null);
    assert.ok(String(fresh.token_hash).startsWith("unminted:"), "no outstanding token on a fresh packet");
    assert.equal(fresh.expected_origin, "https://p.example.com", "same portal");
    assert.equal(fresh.job_id, "a1", "same job");
  } finally { t.server.close(); t.db.close(); }
});

test("reopening is refused once the candidate has already reviewed the application", async () => {
  const t = setup();
  try {
    const a = t.seed("https://p.example.com", "a1");
    t.db.prepare("UPDATE apply_gate_packets SET consumed_at=unixepoch() WHERE id=?").run(a.packetId);
    t.db.prepare("UPDATE apply_run_jobs SET gate_review_json=? WHERE id=?")
      .run('{"ready":true}', a.runJobId);
    const { status, body } = await post(t.base, `/api/apply/gate-packets/${a.packetId}/reopen`);
    assert.equal(status, 409);
    assert.equal(body.error, "already_reviewed");
  } finally { t.server.close(); t.db.close(); }
});

test("an unconsumed packet is left alone rather than duplicated", async () => {
  const t = setup();
  try {
    const a = t.seed("https://p.example.com", "a1");
    const { status, body } = await post(t.base, `/api/apply/gate-packets/${a.packetId}/reopen`);
    assert.equal(status, 200);
    assert.equal(body.reopened, false);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM apply_gate_packets").get().n, 1,
      "reopening something that is not broken must not litter the queue");
  } finally { t.server.close(); t.db.close(); }
});

test("a job that has moved on cannot be reopened", async () => {
  const t = setup();
  try {
    const a = t.seed("https://p.example.com", "a1");
    t.db.prepare("UPDATE apply_gate_packets SET consumed_at=unixepoch() WHERE id=?").run(a.packetId);
    t.db.prepare("UPDATE apply_run_jobs SET status='submitted' WHERE id=?").run(a.runJobId);
    const { status, body } = await post(t.base, `/api/apply/gate-packets/${a.packetId}/reopen`);
    assert.equal(status, 409);
    assert.equal(body.error, "not_held");
  } finally { t.server.close(); t.db.close(); }
});

test("another account cannot reopen a packet", async () => {
  const t = setup();
  try {
    const a = t.seed("https://p.example.com", "a1", 1);
    t.db.prepare("UPDATE apply_gate_packets SET consumed_at=unixepoch() WHERE id=?").run(a.packetId);
    t.asUser(2);
    const { status } = await post(t.base, `/api/apply/gate-packets/${a.packetId}/reopen`);
    assert.equal(status, 404, "not-found and not-yours read the same, so neither confirms the other");
  } finally { t.server.close(); t.db.close(); }
});

// ── The client renders the offer, not the list ───────────────────────────────

test("the panel offers one sign-in per portal, with the count as the point", async () => {
  assert.match(jobsPanel, /applyGatePortals/, "the panel must read the grouping");
  assert.match(jobsPanel, /Sign in to \{p\.host\} once/,
    "the offer is 'sign in once', not 'N items need review'");
  assert.match(jobsPanel, /application\{p\.count === 1 \? "" : "s"\} ready/);
  // Requirement 3: the gate is batched, the review is not, and the UI must not imply otherwise.
  assert.match(jobsPanel, /reviewed one at a time/,
    "the panel must not suggest one approval covers the batch");
});

test("the batch never advances by submitting anything", async () => {
  const bg = fs.readFileSync("extension/background.js", "utf8");
  const overlay = fs.readFileSync("extension/review-overlay.js", "utf8");
  for (const [name, src] of [["background.js", bg], ["review-overlay.js", overlay]]) {
    assert.doesNotMatch(src, /\.submit\s*\(/, `${name} must never submit`);
    assert.doesNotMatch(src, /requestSubmit/, `${name} must never submit`);
  }
  assert.match(overlay, /Submit this one first/,
    "moving to the next application must read as the candidate's choice, after they submit this one");
});

test("losing sight of a tab's URL ends its batch", async () => {
  // Without the tabs permission a tab's url is readable only while we hold access to it, so an
  // undefined url IS the signal that the grant is gone. Skipping instead of clearing left a batch
  // pinned to a tab the candidate had already navigated away from.
  const bg = fs.readFileSync("extension/background.js", "utf8");
  assert.match(bg, /if \(!tab\?\.url\) \{ await clearBatchForTab\(tabId\); return; \}/);
});
