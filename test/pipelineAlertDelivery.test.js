// THE PIPELINE MONITOR WAS RIGHT ABOUT EVERYTHING AND TOLD NOBODY.
//
// On 2026-09-18 `GET /api/admin/db/pipeline-health` was simultaneously and correctly reporting an
// Anthropic credit outage, Jobo's HTTP 402 wallet, two sources fetching rows and writing none, and
// three companies silent for 234 hours. One alert names its own history:
//
//     "the last 2 enrichment runs wrote nothing — this is the shape that ran for three days
//      undetected"
//
// Five days of a dead API key passed with the monitor calling it correctly the whole time, behind a
// route nothing polls. Detection without delivery is a diary.
//
// ⛔ AND THE HARD PART IS NOT SENDING, IT IS NOT SENDING. Most of these are STANDING conditions —
// workday and smartrecruiters have no companies configured and will say so every night until
// somebody configures them. Six criticals delivered nightly is the one outcome this codebase keeps
// rediscovering: an alarm nobody reads, which is worse than no alarm because it looks like
// coverage. So the tests below spend more effort on silence than on sending.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../scripts/migrations.js";
import { getSetting } from "../services/appSettings.js";
import {
  deliverPipelineAlerts, diffAlerts, fingerprint, formatMessage, ALERT_STATE_KEY,
} from "../services/jobs/alertDelivery.js";

const A = (severity, kind, subject, detail = "something") => ({ severity, kind, subject, detail });
const CREDIT = A("critical", "enrichment", "last run", "recorded status 'ok' but wrote 0 of 25 fetched");
const JOBO   = A("critical", "source", "jobo", "last run failed: HTTP 402 — PAYMENT REQUIRED");
const STALE  = A("warn", "company", "lever/openx", "no row seen in 234h (threshold 48h)");

function db0() {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m.sql);
  return db;
}
/** Collects what each channel was handed. */
function harness(alerts, { webhookUrl = null } = {}) {
  const sent = [];
  return {
    sent,
    opts: {
      readHealth: () => ({ alerts }),
      notify: (summary, message, payload) => sent.push({ summary, message, payload }),
      webhookUrl,
      log: { log() {}, warn() {}, error() {} },
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// NOT SENDING
// ════════════════════════════════════════════════════════════════════════════════════════════

test("⛔ a STANDING alert is delivered once, not every night", () => {
  const db = db0();
  return (async () => {
    try {
      const h1 = harness([CREDIT, JOBO]);
      const first = await deliverPipelineAlerts(db, h1.opts);
      assert.equal(first.delivered, true);
      assert.equal(h1.sent.length, 1);

      for (let night = 0; night < 5; night++) {
        const h = harness([CREDIT, JOBO]);
        const r = await deliverPipelineAlerts(db, h.opts);
        assert.equal(r.delivered, false, `night ${night + 2} must be silent`);
        assert.equal(h.sent.length, 0);
      }
    } finally { db.close(); }
  })();
});

test("⛔ the fingerprint ignores the DETAIL, or an ageing alert re-fires forever", () => {
  // "no row seen in 234h" becomes 258h tomorrow. Keying on the message would make every standing
  // staleness alert a nightly notification — the exact noise this is built to avoid.
  const today    = A("warn", "company", "lever/openx", "no row seen in 234h (threshold 48h)");
  const tomorrow = A("warn", "company", "lever/openx", "no row seen in 258h (threshold 48h)");
  assert.equal(fingerprint(today), fingerprint(tomorrow));
  assert.equal(diffAlerts([tomorrow], [fingerprint(today)]).changed, false);
});

test("an unchanged set writes nothing and reports why", async () => {
  const db = db0();
  try {
    await deliverPipelineAlerts(db, harness([CREDIT]).opts);
    const again = await deliverPipelineAlerts(db, harness([CREDIT]).opts);
    assert.equal(again.delivered, false);
    assert.match(again.reason, /no change/);
  } finally { db.close(); }
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// SENDING
// ════════════════════════════════════════════════════════════════════════════════════════════

test("a NEW alert beside a standing one delivers only the new one", async () => {
  const db = db0();
  try {
    await deliverPipelineAlerts(db, harness([CREDIT]).opts);
    const h = harness([CREDIT, JOBO]);
    const r = await deliverPipelineAlerts(db, h.opts);
    assert.equal(r.delivered, true);
    assert.equal(r.appeared, 1);
    assert.match(h.sent[0].message, /jobo/);
    assert.doesNotMatch(h.sent[0].message, /wrote 0 of 25/, "the standing alert must not be repeated");
  } finally { db.close(); }
});

test("⛔ RECOVERY is delivered too — one-directional alerting cannot tell fixed from forgotten", async () => {
  const db = db0();
  try {
    await deliverPipelineAlerts(db, harness([CREDIT, JOBO]).opts);
    const h = harness([CREDIT]);                       // jobo topped up
    const r = await deliverPipelineAlerts(db, h.opts);
    assert.equal(r.delivered, true);
    assert.equal(r.cleared, 1);
    assert.match(h.sent[0].message, /RECOVERED/);
    assert.match(h.sent[0].message, /source\/jobo/);
  } finally { db.close(); }
});

test("everything clearing is itself a message", async () => {
  const db = db0();
  try {
    await deliverPipelineAlerts(db, harness([CREDIT, JOBO, STALE]).opts);
    const h = harness([]);
    const r = await deliverPipelineAlerts(db, h.opts);
    assert.equal(r.delivered, true);
    assert.equal(r.cleared, 3);
    assert.equal(r.appeared, 0);
  } finally { db.close(); }
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// FAILURE MODES — a monitor that takes the cron down is worse than one that misses a night
// ════════════════════════════════════════════════════════════════════════════════════════════

test("a health read that throws is reported, not propagated", async () => {
  const db = db0();
  try {
    const r = await deliverPipelineAlerts(db, {
      readHealth: () => { throw new Error("pipeline_runs is missing"); },
      notify: () => {}, log: { log() {}, warn() {}, error() {} },
    });
    assert.equal(r.delivered, false);
    assert.match(r.reason, /health read failed/);
  } finally { db.close(); }
});

test("a throwing notifier does not stop the webhook, and neither stops the run", async () => {
  const db = db0();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(url); return { ok: true, status: 200 }; };
  try {
    const r = await deliverPipelineAlerts(db, {
      readHealth: () => ({ alerts: [CREDIT] }),
      notify: () => { throw new Error("notifications table is gone"); },
      webhookUrl: "https://hooks.example.test/x",
      log: { log() {}, warn() {}, error() {} },
    });
    assert.equal(r.delivered, true);
    assert.deepEqual(calls, ["https://hooks.example.test/x"]);
  } finally { globalThis.fetch = realFetch; db.close(); }
});

test("⛔ state is written even when a channel fails, so a broken webhook cannot repeat nightly", async () => {
  const db = db0();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  try {
    const r1 = await deliverPipelineAlerts(db, {
      readHealth: () => ({ alerts: [CREDIT] }), notify: () => {},
      webhookUrl: "https://down.example.test/x", log: { log() {}, warn() {}, error() {} },
    });
    assert.equal(r1.delivered, true);
    assert.ok(getSetting(db, ALERT_STATE_KEY), "the delivered set is remembered regardless");
    const h = harness([CREDIT]);
    assert.equal((await deliverPipelineAlerts(db, h.opts)).delivered, false,
      "retrying forever would turn a broken webhook into the nightly noise this avoids");
  } finally { globalThis.fetch = realFetch; db.close(); }
});

test("no webhook configured is a normal configuration, not a failure", async () => {
  const db = db0();
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200 }; };
  try {
    const r = await deliverPipelineAlerts(db, harness([CREDIT]).opts);
    assert.equal(r.delivered, true);
    assert.equal(called, false);
  } finally { globalThis.fetch = realFetch; db.close(); }
});

test("an unreadable stored state means DELIVER, not crash", async () => {
  const db = db0();
  try {
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)")
      .run(ALERT_STATE_KEY, "{not json");
    const r = await deliverPipelineAlerts(db, harness([CREDIT]).opts);
    assert.equal(r.delivered, true);
  } finally { db.close(); }
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// WIRING
// ════════════════════════════════════════════════════════════════════════════════════════════

test("⛔ the cron reads the ROUTE's alerts, not a second implementation", () => {
  // Two ATS caches, two classifiers, two migration loops — all repaired this week. A second
  // "what is wrong with the pipeline" would be the fourth.
  const admin = fs.readFileSync("routes/adminDb.js", "utf8");
  assert.match(admin, /function pipelineHealth\(\)/);
  assert.match(admin, /router\.pipelineHealth = pipelineHealth;/);
  assert.match(admin, /res\.json\(pipelineHealth\(\)\)/, "the route must serve that same function");

  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /readHealth: \(\) => adminDbRouter\.pipelineHealth\(\)/);
  assert.match(server, /deliverPipelineAlerts\(db, \{/);
  assert.match(server, /PIPELINE_ALERT_WEBHOOK/);
  assert.match(server, /SELECT id FROM users WHERE is_admin = 1/,
    "these name providers and spend — admins only");
});

test("the message is legible in one line per alert", () => {
  const msg = formatMessage({ appeared: [CREDIT, STALE], cleared: [fingerprint(JOBO)] });
  const lines = msg.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^🔴 enrichment\/last run: /);
  assert.match(lines[1], /^🟠 company\/lever\/openx: /);
  assert.match(lines[2], /^✅ RECOVERED — source\/jobo$/);
});
