// Fourth and last tier: database -> local sink -> webhook -> log line.
//
// This is the only tier that touches the network, and it runs in a path that exists because
// something is already broken. So these tests are mostly about what it must NOT do: block, throw,
// retry, flood, leak prompt content, or run at all when unconfigured.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import Database from "better-sqlite3";
import {
  notifyLostFailure, getWebhookStats, resetWebhookStats, isConfigured,
} from "../services/trackingFailureWebhook.js";
import { trackApiCall, getTrackingStats, resetTrackingStats } from "../services/usageTracker.js";

// The sink must ALSO fail for the webhook tier to be reached. Put the sink UNDER a regular file:
// mkdirSync then fails on every platform, so appendFailure reliably returns false. A path segment
// that merely looks invalid (one containing a space, say) is NOT reliable -- Windows will happily
// create it, the sink then succeeds, and the test silently stops covering the tier it exists for.
const sinkBlockerDir = fs.mkdtempSync(path.join(os.tmpdir(), "sink-blocked-"));
const sinkBlockerFile = path.join(sinkBlockerDir, "not-a-directory");
fs.writeFileSync(sinkBlockerFile, "x");
const unwritableSink = path.join(sinkBlockerFile, "failures.jsonl");
test.after(() => { try { fs.rmSync(sinkBlockerDir, { recursive: true, force: true }); } catch {} });

function receiver({ status = 200, hang = false } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      received.push({ method: req.method, contentType: req.headers["content-type"], body });
      if (hang) return;              // never responds -- the client timeout must handle it
      res.writeHead(status); res.end("ok");
    });
  });
  return new Promise(resolve => {
    server.listen(0, () => resolve({
      server, received,
      url: `http://127.0.0.1:${server.address().port}/hook`,
      // closeAllConnections is required: the hanging-endpoint case deliberately leaves a request
      // open, and server.close() alone waits for it, so teardown would otherwise block until the
      // client's abort timer fires.
      close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
    }));
  });
}

const settle = (ms = 100) => new Promise(r => setTimeout(r, ms));

/** Wait until a condition holds, rather than guessing a sleep length. */
async function waitFor(fn, deadlineMs = 5000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (fn()) return true;
    await settle(50);
  }
  return false;
}

test("unconfigured is completely inert", () => {
  delete process.env.USAGE_FAILURE_WEBHOOK_URL;
  resetWebhookStats();
  assert.equal(isConfigured(), false);
  assert.equal(notifyLostFailure({ model: "m", purpose: "p" }), "disabled");
  const s = getWebhookStats();
  assert.equal(s.configured, false);
  assert.equal(s.target, null);
  assert.equal(s.sent, 0);
  assert.equal(s.failed, 0);
});

test("a lost failure is posted, with metadata and no prompt content", async () => {
  const r = await receiver();
  process.env.USAGE_FAILURE_WEBHOOK_URL = r.url;
  resetWebhookStats();
  try {
    assert.equal(notifyLostFailure({
      model: "claude-sonnet-5", purpose: "resume_generate", userId: 7,
      errorText: "no such table: usage_events",
      persistError: "no such table: usage_tracking_failures",
      sinkError: "append to local sink failed",
    }), "attempted");
    assert.ok(await waitFor(() => r.received.length === 1), "the POST must arrive");

    assert.equal(r.received[0].method, "POST");
    assert.match(r.received[0].contentType, /application\/json/);
    const payload = JSON.parse(r.received[0].body);
    assert.equal(payload.type, "usage_tracking_failure_lost");
    assert.equal(payload.model, "claude-sonnet-5");
    assert.equal(payload.purpose, "resume_generate");
    assert.equal(payload.user_id, 7);
    assert.match(payload.error, /usage_events/);
    assert.match(payload.persist_error, /usage_tracking_failures/);
    assert.ok(payload.at > 0);
    // Metadata only. A cost-logging notification has no business carrying a resume or a prompt.
    assert.deepEqual(Object.keys(payload).sort(),
      ["at", "error", "message", "model", "persist_error", "purpose", "sink_error", "type", "user_id"]);

    assert.ok(await waitFor(() => getWebhookStats().sent === 1));
    assert.equal(getWebhookStats().failed, 0);
  } finally { await r.close(); delete process.env.USAGE_FAILURE_WEBHOOK_URL; }
});

test("the admin-facing status exposes the host but never the full URL", async () => {
  const r = await receiver();
  process.env.USAGE_FAILURE_WEBHOOK_URL = `${r.url}?token=SUPERSECRET`;
  resetWebhookStats();
  try {
    const s = getWebhookStats();
    assert.equal(s.configured, true);
    assert.match(s.target, /^127\.0\.0\.1:\d+$/);
    // A webhook URL can legitimately carry a token; echoing it into an admin response leaks it.
    assert.doesNotMatch(JSON.stringify(s), /SUPERSECRET/);
  } finally { await r.close(); delete process.env.USAGE_FAILURE_WEBHOOK_URL; }
});

test("a non-2xx response is counted as failed, never retried", async () => {
  const r = await receiver({ status: 500 });
  process.env.USAGE_FAILURE_WEBHOOK_URL = r.url;
  resetWebhookStats();
  try {
    notifyLostFailure({ model: "m", purpose: "p" });
    assert.ok(await waitFor(() => getWebhookStats().failed === 1));
    assert.equal(getWebhookStats().sent, 0);
    assert.match(getWebhookStats().lastError, /HTTP 500/);
    // A retry loop in a failure path is how an outage becomes an incident.
    await settle(200);
    assert.equal(r.received.length, 1, "exactly one attempt");
  } finally { await r.close(); delete process.env.USAGE_FAILURE_WEBHOOK_URL; }
});

test("a hanging endpoint does not block the caller", async () => {
  const r = await receiver({ hang: true });
  process.env.USAGE_FAILURE_WEBHOOK_URL = r.url;
  resetWebhookStats();
  try {
    const started = Date.now();
    const outcome = notifyLostFailure({ model: "m", purpose: "p" });
    const elapsed = Date.now() - started;
    assert.equal(outcome, "attempted");
    // The whole point: returns immediately even though the remote end never answers.
    assert.ok(elapsed < 250, `notify blocked for ${elapsed}ms -- it must be fire-and-forget`);
  } finally {
    // Close, then let the aborted request settle HERE. Otherwise its late .catch() lands during a
    // later test, after that test has reset the counters, and corrupts its assertions -- real
    // cross-test bleed, caused by fire-and-forget being genuinely asynchronous.
    await r.close();
    await waitFor(() => getWebhookStats().failed > 0, 2000);
    delete process.env.USAGE_FAILURE_WEBHOOK_URL;
  }
});

test("an unreachable endpoint is counted, and does not throw or crash the process", async () => {
  // Nothing is listening on this port. Poll rather than sleep: how fast a connection is refused is
  // an OS behaviour, not something to hard-code.
  process.env.USAGE_FAILURE_WEBHOOK_URL = "http://127.0.0.1:1/hook";
  resetWebhookStats();
  try {
    assert.doesNotThrow(() => notifyLostFailure({ model: "m", purpose: "p" }));
    assert.ok(await waitFor(() => getWebhookStats().failed >= 1), "the failure must be counted");
    assert.ok(getWebhookStats().lastError, "and the reason kept");
    assert.equal(getWebhookStats().sent, 0);
  } finally { delete process.env.USAGE_FAILURE_WEBHOOK_URL; }
});

test("a non-http URL is rejected before any socket is opened", () => {
  process.env.USAGE_FAILURE_WEBHOOK_URL = "file:///etc/passwd";
  resetWebhookStats();
  try {
    assert.equal(notifyLostFailure({ model: "m", purpose: "p" }), "invalid_url");
    assert.match(getWebhookStats().lastError, /http\(s\)/);
  } finally { delete process.env.USAGE_FAILURE_WEBHOOK_URL; }
});

test("sends are throttled so one outage cannot become a request per model call", async () => {
  const r = await receiver();
  process.env.USAGE_FAILURE_WEBHOOK_URL = r.url;
  resetWebhookStats();
  try {
    const outcomes = [];
    for (let i = 0; i < 25; i++) outcomes.push(notifyLostFailure({ model: "m", purpose: "p" }));
    assert.equal(outcomes.filter(o => o === "attempted").length, 10, "the per-window cap must hold");
    assert.equal(outcomes.filter(o => o === "throttled").length, 15);
    // Suppressed is counted, not silently dropped -- otherwise the throttle hides the volume.
    assert.equal(getWebhookStats().suppressed, 15);
  } finally { await r.close(); delete process.env.USAGE_FAILURE_WEBHOOK_URL; }
});

test("end to end: a call whose usage reaches neither the DB nor the sink notifies the webhook", async () => {
  const r = await receiver();
  process.env.USAGE_FAILURE_WEBHOOK_URL = r.url;
  process.env.USAGE_FAILURE_SINK_PATH = unwritableSink;
  resetWebhookStats();
  resetTrackingStats();
  const errLog = console.error, infoLog = console.info;
  console.error = () => {}; console.info = () => {};
  try {
    // No usage_events and no usage_tracking_failures: the database can record nothing.
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
             INSERT INTO users (id, username) VALUES (1,'admin');`);

    assert.doesNotThrow(() => trackApiCall(db, {
      userId: 1, eventType: "enrich_job", purpose: "enrich_job",
      model: "claude-haiku-4-5-20251001", usage: { input_tokens: 3, output_tokens: 2 },
    }));

    const t = getTrackingStats();
    assert.equal(t.persistedFailures, 0, "the database could not record it");
    assert.equal(t.sinkedFailures, 0, "the sink could not either");
    assert.equal(t.lostFailures, 1, "so it is lost as far as local storage goes");
    assert.equal(t.webhookAttempts, 1, "and the webhook is the only route left off the box");

    assert.ok(await waitFor(() => r.received.length === 1), "the notification must arrive");
    const payload = JSON.parse(r.received[0].body);
    assert.equal(payload.purpose, "enrich_job");
    assert.equal(payload.model, "claude-haiku-4-5-20251001");
    assert.match(payload.sink_error, /sink/i);
  } finally {
    console.error = errLog; console.info = infoLog;
    await r.close();
    delete process.env.USAGE_FAILURE_WEBHOOK_URL;
    delete process.env.USAGE_FAILURE_SINK_PATH;
  }
});
