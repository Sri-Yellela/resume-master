// TASK AB1 — A HELD REVIEW MUST BE RESUMABLE, NOT A SNAPSHOT.
//
// The defect this pins was not cosmetic; it was the pipeline failing to complete. For a held
// application the panel offered "Filled form ↗", which opened a SCREENSHOT of a form in a Puppeteer
// context that had already closed, and beneath it the raw apply URL, which opened a brand-new empty
// application. So there was no route from held to submitted: the user had to redo by hand every
// answer the system had already resolved.
//
// No amount of link-fixing recovers a dead browser context. What survives a run is the ANSWERS, and
// the gated handoff (G0–G5) already exists to replay answers into a live form in the candidate's own
// browser: a prepared packet, a signed single-use short-TTL token, injection under an activeTab
// grant, and a provenance overlay to review before submitting. It was wired for GATE crossings only.
// A held review is the same problem — a form needing a human, in the human's browser — so it is
// routed through the same mechanism rather than given a second one.
//
// The end-to-end behaviour (real browser, real extension, real grant) is verified by
// scripts/ab1HeldHandoff.mjs. What is here is the contract: which held rows get a packet, that the
// portal amortisation is not corrupted by them, and the two states that cannot be resumed.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import Database from "better-sqlite3";
import applyRoutes from "../routes/apply.js";
import { MIGRATIONS } from "../scripts/migrations.js";
import {
  buildGatePacket, shouldBuildPacket, handoffKind, packetFreshness,
  PACKET_STALE_MS, RESUMABLE_HELD_REASONS, GATE_CROSSING_REASONS, HANDOFF_STATUSES,
} from "../services/applyGatePacket.js";

const read = (p) => fs.readFileSync(p, "utf8");
const panel = read("client/src/panels/AutoApplyPanel.jsx");
const sections = read("client/src/panels/AutoApplyPanelSections.jsx");
const ctx = read("client/src/contexts/AutoApplyContext.jsx");
const applyRoute = read("routes/apply.js");
const automation = read("services/applyAutomation.js");

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
      auto_status TEXT, UNIQUE(user_id, job_id));
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT (unixepoch()));
    INSERT INTO users (id, username) VALUES (1, 'ada');
    INSERT INTO apply_runs (id, user_id, mode, status, total_jobs) VALUES (1, 1, 'auto', 'completed', 8);
  `);
  for (const id of ["079_apply_gate_packets", "080_apply_gate_review"]) {
    db.exec(MIGRATIONS.find(m => m.id === id).sql);
  }

  /**
   * One held application with a prepared packet.
   * `posting: false` omits the scraped_jobs row — a posting removed by the 7-day cleanup.
   * `ageDays` backdates the packet, which is how staleness is exercised without waiting three days.
   */
  const seed = ({ jobId, origin = "https://boards.example.com", status = "held_review",
                  reason = "manual_review", posting = true, ageDays = 0, userId = 1 }) => {
    const applyUrl = `${origin}/apply/${jobId}`;
    if (posting) {
      db.prepare(`INSERT INTO scraped_jobs (job_id, title, company, url, apply_url, source)
                  VALUES (?, ?, 'OpenAI', ?, ?, 'greenhouse')`)
        .run(jobId, `Role ${jobId}`, applyUrl, applyUrl);
    }
    const rj = db.prepare(`INSERT INTO apply_run_jobs (run_id, user_id, job_id, status, reason_code)
                           VALUES (1, ?, ?, ?, ?)`).run(userId, jobId, status, reason);
    const runJobId = Number(rj.lastInsertRowid);
    const packet = buildGatePacket({
      autofillPayload: PAYLOAD, applyUrl, jobId, runId: 1, runJobId, gateReason: reason,
    });
    const created = Math.floor(Date.now() / 1000) - Math.round(ageDays * 86400);
    const p = db.prepare(`INSERT INTO apply_gate_packets
      (user_id, run_id, run_job_id, job_id, apply_url, expected_origin, gate_reason, answers_json,
       token_hash, expires_at, created_at)
      VALUES (?,1,?,?,?,?,?,?,?,0,?)`)
      .run(userId, runJobId, jobId, applyUrl, origin, reason,
           JSON.stringify(packet), `unminted:${jobId}`, created);
    return { packetId: Number(p.lastInsertRowid), runJobId };
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
  applyRoutes(app, db, (q, r, n) => n(), () => PAYLOAD,
    async () => ({ error: "x" }), async () => Buffer.from("pdf"), async () => ({}));
  const server = app.listen(0);
  return { db, server, base: `http://127.0.0.1:${server.address().port}`, seed };
}

const get = (base, p) => fetch(`${base}${p}`).then(async r => ({ status: r.status, body: await r.json() }));
const post = (base, p, b) => fetch(`${base}${p}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}),
}).then(async r => ({ status: r.status, body: await r.json() }));

// ── The root cause: only a gate ever got a packet ─────────────────────────────────────────────

test("EVERY held terminal state gets a packet, not just a gate — that one condition was the defect", () => {
  // The requirement names these six. `held_review` is the status the pipeline actually writes for
  // most of them, so both halves of the pair are asserted.
  for (const reason of ["manual_review", "low_confidence_answers", "incomplete_form",
                        "no_submit_button", "submit_unverified", "ats_below_threshold"]) {
    assert.equal(shouldBuildPacket({ status: "held_review", reasonCode: reason }), true,
      `a held review for "${reason}" gets no packet, so it has no route to submission`);
  }
  for (const reason of ["login_required", "captcha_required"]) {
    assert.equal(shouldBuildPacket({ status: "held_gate", reasonCode: reason }), true);
  }
  // filled_not_submitted is the automation's status for "we filled it and found nothing to click";
  // routes/apply.js maps it to held_review / no_submit_button, and that pairing must qualify.
  assert.match(applyRoute, /result\.status === "filled_not_submitted" \? "no_submit_button"/);
  assert.equal(shouldBuildPacket({ status: "held_review", reasonCode: "no_submit_button" }), true);
});

test("the call site is the terminal state, no longer the literal held_gate", () => {
  assert.match(applyRoute, /if \(shouldBuildPacket\(\{ status: finalStatus, reasonCode \}\)\) \{/);
  assert.ok(!/if \(finalStatus === "held_gate"\) \{\s*\n\s*createGatePacket/.test(applyRoute),
    "the packet is still gated on held_gate alone — held reviews remain dead ends");
});

test("an application that is COMPLETE is not handed off — approval is a click here, not a form there", () => {
  // awaiting_approval has its own surface and the server submits it. Handing it off would put a
  // second, divergent copy of the application in front of the candidate.
  assert.equal(shouldBuildPacket({ status: "held_review", reasonCode: "awaiting_approval" }), false);
  assert.ok(!RESUMABLE_HELD_REASONS.has("awaiting_approval"));
  // And nothing that did not stop at a form is handed off either.
  assert.equal(shouldBuildPacket({ status: "submitted", reasonCode: null }), false);
  assert.equal(shouldBuildPacket({ status: "failed", reasonCode: "internal_error" }), false);
  assert.equal(shouldBuildPacket({ status: "queued", reasonCode: null }), false);
  // An undescribed hold gets no packet rather than an unusable one: a queue that never empties is
  // worse than an honest absence.
  assert.equal(shouldBuildPacket({ status: "held_review", reasonCode: "a_reason_from_next_year" }), false);
});

test("the URL a held form was actually on is recorded before the browser closes", () => {
  // This is what makes the packet target-matchable. Without it the only URL available was the
  // posting's apply_url, which is frequently a redirector — so the extension would correctly refuse
  // to fill a form it had itself prepared.
  const held = automation.match(/landedUrl:\s+page\.url\(\),/g) || [];
  assert.ok(held.length >= 8,
    `only ${held.length} terminal returns record where the form was; every held one must`);
  assert.match(applyRoute,
    /const applyUrl = result\.gate\?\.applyUrl \|\| result\.landedUrl \|\| result\.gate\?\.startedFrom \|\| jobUrl \|\| null;/);
});

test("a held review's packet carries the SAME answers a submission would have used", async () => {
  const t = setup();
  try {
    t.seed({ jobId: "h1" });
    const { body } = await get(t.base, "/api/apply/gate-packets");
    const p = body.packets.find(x => x.jobId === "h1");
    assert.ok(p, "the held review has no prepared packet");
    assert.ok(p.answerCount > 0, "a packet with no answers resumes nothing");
    // Counts only on the list — the values stay behind the token exchange.
    assert.equal(JSON.stringify(body).includes("ada@example.com"), false,
      "the list response leaked an answer value");
  } finally { t.server.close(); t.db.close(); }
});

// ── The amortisation is not corrupted by the widening ────────────────────────────────────────

test("held reviews stay OUT of the portal batches — one sign-in cannot clear four different answers", async () => {
  // The rule the panel is built on: group by OBSTACLE when one action unblocks MANY, by APPLICATION
  // when many obstacles block ONE. Grouping held reviews by origin would promise that signing in to
  // a portal clears applications that each need a different answer from the candidate.
  const t = setup();
  try {
    t.seed({ jobId: "g1", origin: "https://portal.example.com", status: "held_gate", reason: "login_required" });
    t.seed({ jobId: "g2", origin: "https://portal.example.com", status: "held_gate", reason: "login_required" });
    t.seed({ jobId: "r1", origin: "https://portal.example.com", reason: "manual_review" });
    t.seed({ jobId: "r2", origin: "https://portal.example.com", reason: "incomplete_form" });

    const { body } = await get(t.base, "/api/apply/gate-packets");
    assert.equal(body.portals.length, 1);
    assert.equal(body.portals[0].count, 2,
      "the sign-in batch counted held reviews, which signing in does not release");
    assert.equal(body.packets.length, 4, "every packet is still individually addressable");
    assert.deepEqual(body.packets.filter(p => p.kind === "review").map(p => p.jobId).sort(), ["r1", "r2"]);
    assert.deepEqual(body.packets.filter(p => p.kind === "gate").map(p => p.jobId).sort(), ["g1", "g2"]);
  } finally { t.server.close(); t.db.close(); }
});

test("the two kinds are decided by the reason alone, in ONE place", () => {
  for (const r of GATE_CROSSING_REASONS) assert.equal(handoffKind(r), "gate");
  for (const r of RESUMABLE_HELD_REASONS) assert.equal(handoffKind(r), "review");
  // Disjoint, or a reason would be both a batch and an individual.
  for (const r of RESUMABLE_HELD_REASONS) assert.ok(!GATE_CROSSING_REASONS.has(r));
  assert.match(applyRoute, /rows\.filter\(r => handoffKind\(r\.gate_reason\) === "gate"\)/);
});

test("a held review's packet is labelled with its OWN reason, never defaulted to a login wall", async () => {
  const t = setup();
  try {
    t.seed({ jobId: "h2", reason: "low_confidence_answers" });
    const { body } = await get(t.base, "/api/apply/gate-packets");
    const p = body.packets.find(x => x.jobId === "h2");
    assert.equal(p.gateReason, "low_confidence_answers");
    assert.equal(p.kind, "review");
    // The old default would have made this a gate, and put it in a sign-in batch.
    assert.notEqual(p.gateReason, "login_required");
  } finally { t.server.close(); t.db.close(); }
});

// ── Requirement 3: target match before release stays absolute ────────────────────────────────

test("TARGET MATCH IS UNCHANGED — the packet carries a home address, and origin still gates release", () => {
  const handoff = read("extension/gated-handoff.js");
  // Order is the security design: origin read -> packet located by origin -> form confirmed present
  // -> only then a token minted and spent. Widening WHICH packets exist must not touch it.
  assert.match(handoff, /const forOrigin = \(list\.packets \|\| \[\]\)\.filter\(p => p\.expectedOrigin === origin\)/);
  assert.match(handoff, /if \(forOrigin\.length === 0\)/);
  // Once MANY packets share one origin, choosing the newest without checking freshness would fail a
  // whole handoff on an expired packet while a usable one sat behind it.
  assert.match(handoff, /const fresh = forOrigin\.filter\(p => !p\.stale\)/);
  assert.match(handoff, /reason: 'packet_stale'/);
  assert.match(handoff, /\(a\.postingGone \? 1 : 0\) - \(b\.postingGone \? 1 : 0\)/);
  assert.match(handoff, /if \(!shape\?\.hasForm \|\| shape\.fields\.length === 0\)/);
  assert.match(handoff, /if \(shape\.origin !== origin\)/);
  assert.match(handoff, /if \(released\.expectedOrigin !== origin\)/);
  // And the refusals happen BEFORE the mint, so a mismatch never spends a token.
  const mintAt = handoff.indexOf("/token`, { method: 'POST' }");
  assert.ok(handoff.indexOf("reason: 'origin_mismatch'") < mintAt,
    "the origin refusal moved after the mint — a mismatch now costs a token");
  assert.ok(handoff.indexOf("reason: 'no_form'") < mintAt,
    "the form check moved after the mint");
});

test("a packet with no parseable apply URL is still REFUSED rather than stored unmatched", () => {
  assert.throws(() => buildGatePacket({ autofillPayload: PAYLOAD, applyUrl: "not a url", jobId: "x" }),
    /parseable apply URL/);
});

// ── Requirement 5: expiry says so, rather than filling nothing ───────────────────────────────

test("a stale packet is refused AT THE MINT, with the remedy, not dropped from the list", async () => {
  const t = setup();
  try {
    const { packetId } = t.seed({ jobId: "old1", ageDays: 4 });

    // Still listed — a packet that has gone off must be able to SAY so. Filtering it out is the
    // "silently fill nothing" failure: the user would click Open and watch an empty form.
    const list = await get(t.base, "/api/apply/gate-packets");
    const p = list.body.packets.find(x => x.jobId === "old1");
    assert.ok(p, "the stale packet vanished from the list instead of reporting itself");
    assert.equal(p.stale, true);
    assert.ok(p.ageMs > PACKET_STALE_MS);

    const mint = await post(t.base, `/api/apply/gate-packets/${packetId}/token`);
    assert.equal(mint.status, 410);
    assert.equal(mint.body.error, "packet_stale");
    assert.match(mint.body.message, /prepared 4 days ago/);
    assert.match(mint.body.message, /again/i, "an expiry with no remedy leaves the user stuck");
    assert.equal(mint.body.remedy, "rerun");
    assert.equal(mint.body.jobId, "old1");
    // No token was issued, so nothing usable was left behind.
    const row = t.db.prepare("SELECT token_hash FROM apply_gate_packets WHERE id=?").get(packetId);
    assert.match(row.token_hash, /^unminted:/);
  } finally { t.server.close(); t.db.close(); }
});

test("a fresh packet still mints — the staleness gate is not a blanket refusal", async () => {
  const t = setup();
  try {
    const { packetId } = t.seed({ jobId: "new1", ageDays: 0 });
    const mint = await post(t.base, `/api/apply/gate-packets/${packetId}/token`);
    assert.equal(mint.status, 200, `fresh mint refused: ${JSON.stringify(mint.body)}`);
    assert.ok(mint.body.token);
    assert.equal(mint.body.expectedOrigin, "https://boards.example.com");
  } finally { t.server.close(); t.db.close(); }
});

test("staleness is measured in DAYS and is not the token's TTL — they protect different things", () => {
  // The token's minutes protect a home address in flight. This protects the ANSWERS' relevance.
  assert.equal(PACKET_STALE_MS, 72 * 60 * 60 * 1000);
  assert.equal(packetFreshness(Date.now()).stale, false);
  assert.equal(packetFreshness(Date.now() - PACKET_STALE_MS - 1).stale, true);
  // Never negative, and never NaN for a missing timestamp.
  assert.equal(packetFreshness(Date.now() + 10_000).ageMs, 0);
  assert.equal(Number.isFinite(packetFreshness(null).ageMs), true);
});

// ── Requirement 6: a vanished posting is its own state ───────────────────────────────────────

test("a held review for a posting that is GONE reports that, rather than offering a broken link", async () => {
  const t = setup();
  try {
    t.seed({ jobId: "4369183334", posting: false });
    t.seed({ jobId: "alive1", posting: true });

    const { body } = await get(t.base, "/api/apply/gate-packets");
    const gone = body.packets.find(p => p.jobId === "4369183334");
    const alive = body.packets.find(p => p.jobId === "alive1");
    assert.equal(gone.postingGone, true, "the row that reads '(posting no longer on the board)' must say so as a state");
    assert.equal(gone.title, null);
    assert.equal(alive.postingGone, false);
    assert.equal(alive.company, "OpenAI");
  } finally { t.server.close(); t.db.close(); }
});

test("the client refuses the two unresumable states BEFORE opening a tab that cannot work", () => {
  assert.match(ctx, /if \(packet\.postingGone\)/);
  assert.match(ctx, /if \(packet\.stale\)/);
  assert.match(ctx, /no longer on the board/);
  // Each refusal names what to do instead, and neither silently opens a window.
  const open = ctx.slice(ctx.indexOf("const openHandoff"), ctx.indexOf("// The resume and screenshot"));
  assert.ok(open.indexOf("if (packet.postingGone)") < open.indexOf("window.open"),
    "a gone posting opens a tab before it refuses");
  assert.ok(open.indexOf("if (packet.stale)") < open.indexOf("window.open"),
    "a stale packet opens a tab before it refuses");
});

// ── Requirement 2 & 4: the route is the handoff, the screenshot is evidence ──────────────────

test("the held card's action is the HANDOFF, not the review modal", () => {
  // AB2 replaced the obstacle-keyed card with a per-application one; the action is unchanged in
  // substance — resume via the handoff when a packet exists, re-run when it has gone off.
  // The fallback arm used to be `openReview`, the UNSCOPED handler — so this very assertion
  // pinned AC1's defect in place: Open on a packet-less card listed every application needing
  // review, and the test insisted on it verbatim. The arm is now the SCOPED handler, which
  // ApplicationObstacleCard invokes as onResolve(app).
  assert.match(panel, /onResolve=\{resumable \? \(\) => openHandoff\(packet, app\) : openApplicationReview\}/);
  assert.match(panel, /resolveLabel=\{resumable \? "Open & fill" : "Open"\}/);
  assert.match(panel, /const resumable = !!packet && !packet\.postingGone && !packet\.stale && !app\.postingGone/);
  assert.match(panel, /onRerun=\{rerunJob\}/);
  // The handoff lands the user on the REAL apply URL, in their own browser.
  assert.match(ctx, /window\.open\(packet\.applyUrl, "_blank", "noopener,noreferrer"\)/);
  // And says what happens next, because the fill happens in another tab by another process.
  assert.match(ctx, /Click the Resume Master extension there/);
  assert.match(panel, /handoffMsg/);
});

test("the screenshot survives as EVIDENCE, labelled as such, and is no longer the route", () => {
  // Requirement 4: distinguish evidence from action. It is still reachable — nothing is dropped.
  //
  // Read across the panel AND its sections module. AC2 moved the modal's per-attempt row into
  // AutoApplyPanelSections.jsx as AttemptRow when the modal was restructured; the label and the
  // route beside it are unchanged, and this assertion is about the LABEL, not about which file
  // renders it. Pinning it to one file made it fail on a move that changed nothing it cares about.
  const surface = panel + "\n" + sections;
  assert.match(surface, /What we filled ↗/);
  assert.match(sections, /"Screenshot of the form ↗" : "What we filled ↗"/);
  assert.ok(!/>\s*Filled form ↗\s*</.test(surface),
    "a held application still offers 'Filled form ↗' as though the form could be reopened");
  assert.match(surface, /it cannot be submitted from here/);
  // The action beside it is what actually continues the application.
  assert.match(surface, /Open & fill ↗/);
});

test("reopening an abandoned handoff works for a held review too, not only for a gate", async () => {
  // Keying this on held_gate alone would make every held review permanently unresumable the moment
  // its first session was abandoned.
  const t = setup();
  try {
    const { packetId, runJobId } = t.seed({ jobId: "re1", reason: "manual_review" });
    t.db.prepare("UPDATE apply_gate_packets SET consumed_at=unixepoch() WHERE id=?").run(packetId);

    const r = await post(t.base, `/api/apply/gate-packets/${packetId}/reopen`);
    assert.equal(r.status, 200, `reopen refused: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.reopened, true);
    assert.notEqual(r.body.packetId, packetId, "reopening must issue a NEW packet, not un-spend a token");

    // Single use still holds absolutely: the original stays consumed.
    const old = t.db.prepare("SELECT consumed_at FROM apply_gate_packets WHERE id=?").get(packetId);
    assert.ok(old.consumed_at != null);
    assert.ok(HANDOFF_STATUSES.has("held_review") && HANDOFF_STATUSES.has("held_gate"));
    assert.equal(runJobId > 0, true);
  } finally { t.server.close(); t.db.close(); }
});

test("Retry no longer throws before it reaches the queue", () => {
  // setApplyQueueMsg was called by retryJob and never destructured from the context — a
  // ReferenceError on every click, the same "handler wired to nothing" class as W1's no-op callbacks.
  const destructured = panel.slice(panel.indexOf("} = useAutoApply()") - 2000, panel.indexOf("} = useAutoApply()"));
  assert.match(destructured, /setApplyQueueMsg/,
    "retryJob calls setApplyQueueMsg but the panel never takes it from the context");
  assert.match(destructured, /setHandoffMsg/);
  assert.match(ctx, /applyQueueMsg, setApplyQueueMsg,/);
});
