import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import express from "express";
import { at } from "../test-support/sourceAnchors.js";

/**
 * THE GATE-PACKET QUEUE'S CAP, and the two ways it failed silently.
 * ================================================================================================
 *
 * GET /api/apply/gate-packets returned `ORDER BY created_at DESC LIMIT 100` over EVERY unconsumed
 * packet, for every portal, with nothing in the body saying the list had been cut.
 *
 * THE EXTENSION'S FAILURE, which is the one that matters. All three of its call sites fetch this
 * list and immediately discard every row whose expectedOrigin is not the tab's. They ask "what is
 * queued for THIS portal?" and were answered with "the newest 100 across all of them". With a long
 * queue, a portal whose packets all fall outside the newest 100 comes back empty — and
 * background.js reports `batch_empty`, stopping a run that has work left. A cap failing as a
 * COMPLETION is the worst shape it can take: the candidate is told there is nothing to do.
 *
 * THE PANEL'S FAILURE. The web client renders every portal from the same capped list, so past 100
 * it shows fewer portals than exist and every count on them is short — a queue surface that
 * under-reports the queue, with nothing distinguishing a truncated answer from a complete one.
 *
 * The fix is both halves: `?origin=` so the cap applies to the set the caller cares about, and
 * `total`/`truncated` so a cut list can say it was cut.
 */

// ── A queue past the cap ───────────────────────────────────────────────────────────────────────
//
// 140 unconsumed packets. The 20 for `slowportal` are the OLDEST, so under the old query they fall
// entirely outside the newest 100 — which is exactly the reported failure, not a contrived one: a
// candidate works through recent portals while an older batch waits.
function seed() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE apply_gate_packets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, job_id TEXT, run_id INTEGER,
      run_job_id INTEGER, apply_url TEXT, expected_origin TEXT, gate_reason TEXT,
      answers_json TEXT, resume_artifact_id INTEGER, consumed_at INTEGER, created_at INTEGER
    );
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, title TEXT, company TEXT);
  `);
  const ins = db.prepare(`INSERT INTO apply_gate_packets
    (user_id, job_id, apply_url, expected_origin, gate_reason, answers_json, consumed_at, created_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const job = db.prepare("INSERT OR IGNORE INTO scraped_jobs (job_id,title,company) VALUES (?,?,?)");

  let t = 1_700_000_000;
  // Oldest first, so these end up beneath the cap.
  for (let i = 0; i < 20; i++) {
    job.run(`slow${i}`, `Engineer ${i}`, "SlowCo");
    ins.run(1, `slow${i}`, "https://slowportal.example/apply", "https://slowportal.example",
            "login_required", JSON.stringify({ answers: [] }), null, t++);
  }
  for (let i = 0; i < 120; i++) {
    job.run(`fast${i}`, `Engineer ${i}`, "FastCo");
    ins.run(1, `fast${i}`, "https://fastportal.example/apply", "https://fastportal.example",
            "login_required", JSON.stringify({ answers: [] }), null, t++);
  }
  // Another user's packets, and a consumed one — neither may ever appear.
  job.run("other", "Engineer", "OtherCo");
  ins.run(2, "other", "https://slowportal.example/apply", "https://slowportal.example",
          "login_required", "{}", null, t++);
  ins.run(1, "slow0", "https://slowportal.example/apply", "https://slowportal.example",
          "login_required", "{}", t++, t++);
  return db;
}

/** The handler's query, read from source so this cannot drift from what actually runs. */
function queriesFromSource() {
  const src = fs.readFileSync("routes/apply.js", "utf8");
  const start = src.indexOf('app.get("/api/apply/gate-packets"');
  assert.notEqual(start, -1, "the gate-packets handler moved");
  return src.slice(start, at(src, "res.json({", start));
}

/** Runs the handler's SELECT the way the handler does, for a given scope. */
function fetchList(db, { origin = "" } = {}) {
  const where = origin ? "AND p.expected_origin = ?" : "";
  const args = origin ? [1, origin] : [1];
  const rows = db.prepare(`
    SELECT p.id, p.expected_origin, p.created_at
    FROM apply_gate_packets p
    LEFT JOIN scraped_jobs sj ON sj.job_id = p.job_id
    WHERE p.user_id=? AND p.consumed_at IS NULL ${where}
    ORDER BY p.created_at DESC LIMIT 100
  `).all(...args);
  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM apply_gate_packets p
    WHERE p.user_id=? AND p.consumed_at IS NULL ${where}
  `).get(...args).n;
  return { rows, total, truncated: total > rows.length };
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE DEFECT
// ════════════════════════════════════════════════════════════════════════════════════════════

test("THE BUG: unscoped, a whole portal's queue falls outside the cap and reads as empty", () => {
  const db = seed();
  try {
    const { rows } = fetchList(db);
    assert.equal(rows.length, 100, "precondition: the list is capped");

    // What the extension does with it: filter to the tab's origin, take the newest.
    const forSlow = rows.filter(r => r.expected_origin === "https://slowportal.example");
    assert.equal(forSlow.length, 0,
      "precondition: slowportal's 20 packets must fall outside the newest 100 on this fixture, " +
      "or the assertion below proves nothing");

    // That empty result is what background.js turns into `batch_empty` — a run stopped as complete
    // while 20 applications are still queued behind that portal.
    const { total } = fetchList(db, { origin: "https://slowportal.example" });
    assert.equal(total, 20, "the packets are really there; the cap simply hid them");
  } finally { db.close(); }
});

test("?origin= answers the question every caller actually asks", () => {
  const db = seed();
  try {
    const { rows, total, truncated } = fetchList(db, { origin: "https://slowportal.example" });
    assert.equal(rows.length, 20, "all 20 are returned once the cap applies to the right set");
    assert.equal(total, 20);
    assert.equal(truncated, false);
    assert.ok(rows.every(r => r.expected_origin === "https://slowportal.example"));
  } finally { db.close(); }
});

test("the scoped list is still ordered newest first, and still capped", () => {
  const db = seed();
  try {
    const { rows, total, truncated } = fetchList(db, { origin: "https://fastportal.example" });
    assert.equal(total, 120, "the count is over the whole scope, before the cap");
    assert.equal(rows.length, 100, "the cap still applies — scoping is not a licence to unbound it");
    assert.equal(truncated, true, "and a scoped list that IS cut still says so");
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].created_at >= rows[i].created_at, "newest first");
    }
  } finally { db.close(); }
});

test("TRUNCATION IS REPORTED — a cut list can no longer pass as a complete one", () => {
  const db = seed();
  try {
    const unscoped = fetchList(db);
    assert.equal(unscoped.total, 140, "the real number, over the same scope, before the cap");
    assert.equal(unscoped.rows.length, 100);
    assert.equal(unscoped.truncated, true);
    // The property that was missing: rows.length alone cannot tell a full list from a capped one.
    assert.notEqual(unscoped.rows.length, unscoped.total,
      "if these were equal the client would have no way to know it was looking at a subset");
  } finally { db.close(); }
});

test("scoping does not widen access: another user's packets and consumed ones stay out", () => {
  // The origin filter is ANDed onto the existing user and consumed predicates, not substituted for
  // them. A filter that replaced the scope rather than narrowing it would be a disclosure.
  const db = seed();
  try {
    const { rows, total } = fetchList(db, { origin: "https://slowportal.example" });
    assert.equal(total, 20, "20, not 21 — the other user's packet is not counted");
    assert.equal(rows.length, 20, "and not returned");
    const all = db.prepare("SELECT COUNT(*) n FROM apply_gate_packets WHERE expected_origin=?")
      .get("https://slowportal.example").n;
    assert.equal(all, 22, "the fixture really does contain rows that must be excluded");
  } finally { db.close(); }
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE HANDLER REALLY DOES THIS
// ════════════════════════════════════════════════════════════════════════════════════════════

test("the handler scopes BOTH statements identically", () => {
  // A `total` computed over a different scope than the rows would be worse than no total: it would
  // report truncation that is not there, or miss truncation that is.
  const body = queriesFromSource();
  assert.match(body, /const origin = String\(req\.query\.origin \|\| ""\)\.trim\(\)/);
  assert.match(body, /const where = origin \? "AND p\.expected_origin = \?" : ""/);
  assert.match(body, /const args = origin \? \[req\.user\.id, origin\] : \[req\.user\.id\]/);
  // Both the SELECT and the COUNT interpolate the same `where` and bind the same `args`.
  const uses = [...body.matchAll(/\$\{where\}/g)].length;
  assert.equal(uses, 2, `expected the scope on both statements, found ${uses}`);
  const binds = [...body.matchAll(/\.all\(\.\.\.args\)|\.get\(\.\.\.args\)/g)].length;
  assert.equal(binds, 2, "both statements must bind the same args");
});

test("the user and consumed predicates are still there, ahead of the origin filter", () => {
  const body = queriesFromSource();
  const clauses = [...body.matchAll(/WHERE p\.user_id=\? AND p\.consumed_at IS NULL \$\{where\}/g)];
  assert.equal(clauses.length, 2,
    "both statements must keep the ownership and unconsumed predicates and merely NARROW them");
});

test("the response carries the truncation signal, always", () => {
  const src = fs.readFileSync("routes/apply.js", "utf8");
  const start = src.indexOf('app.get("/api/apply/gate-packets"');
  const body = src.slice(start, at(src, "packets: rows.map", start));
  for (const field of ["origin", "total", "returned", "truncated", "limit"]) {
    assert.match(body, new RegExp(`\\b${field}[,:]`), `the response must carry \`${field}\``);
  }
  assert.match(body, /truncated: total > rows\.length/,
    "truncation must be derived from the count, not from whether rows.length hit the limit");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE CONSUMERS
// ════════════════════════════════════════════════════════════════════════════════════════════

test("all three extension call sites ask for their origin", () => {
  const bg = fs.readFileSync("extension/background.js", "utf8");
  const gh = fs.readFileSync("extension/gated-handoff.js", "utf8");
  // The negative lookahead excludes /gate-packets/:id/token, which is a different endpoint that
  // merely shares this prefix. Filtering the MATCHED text instead does not work: the match stops at
  // the prefix, so the token path arrives here looking identical to a bare list call.
  const calls = [...(bg + gh).matchAll(/\/api\/apply\/gate-packets(?!\/)(\?[^`'"]*)?/g)]
    .map(m => m[0]);
  assert.ok(calls.length >= 3, `expected the three list call sites, found ${calls.length}`);
  for (const c of calls) {
    assert.match(c, /\?origin=\$\{encodeURIComponent\(/,
      `this call still fetches the whole queue and filters client-side: ${c}`);
  }
});

test("the extension STILL filters by origin itself — it ships separately from the server", () => {
  // An extension updates independently of the server it talks to. A build that trusted ?origin= to
  // have been honoured would fill against the wrong portal on a server that predates it. Filtering
  // twice costs nothing; assuming version parity is how a skew becomes a wrong-portal fill.
  const gh = fs.readFileSync("extension/gated-handoff.js", "utf8");
  const matches = [...gh.matchAll(/p\.expectedOrigin === origin/g)];
  assert.ok(matches.length >= 2,
    "the client-side origin filter must remain as well as the server-side one");
  const bg = fs.readFileSync("extension/background.js", "utf8");
  assert.match(bg, /p\.expectedOrigin === batch\.origin/);
});

test("the panel surfaces truncation, and only when truncated", () => {
  const panel = fs.readFileSync("client/src/panels/AutoApplyPanel.jsx", "utf8");
  assert.match(panel, /applyGateTruncated = false, applyGateTotal = null,/,
    "the panel must accept the flags, defaulting to 'not truncated' for an older server");
  assert.match(panel, /\{applyGateTruncated && \(/,
    "the notice must be GUARDED — an unconditional one would claim every queue is cut");
  assert.match(panel, /applyGateTotal \?\? "many"/,
    "an older server sends no total; the notice must still read as a sentence");

  const ctx = fs.readFileSync("client/src/contexts/AutoApplyContext.jsx", "utf8");
  assert.match(ctx, /setApplyGateTruncated\(gates\.truncated \?\? false\)/,
    "undefined from an older server must mean 'no truncation reported', not 'unknown, so warn'");
  assert.match(ctx, /applyGateTruncated, applyGateTotal,/, "and both must reach the panel");
});
