// ⛔ A DERIVATION MUST NOT OVERWRITE REAL OUTPUT WITH ONE COMPUTED FROM A PURGED BOARD.
//
// After cleanup_log id 85 the board holds 5 fixtures and every table derived from it still holds
// the REAL output — 8690 technographics, 697 org units, 856 term weights, 40 hiring signals. Stale
// but intact, and stale-but-intact is recoverable: the postings survive in a backup.
//
// The unrecoverable move is re-deriving. Task R2 requirement 6 forbids it by hand for exactly this
// reason ("the same shape as the enrichment poisoning that cost 120 rows"). But two of these run on
// server.js's 04:00 cron with nobody watching, and one is a single command away:
//
//   runHiringSignalsRollup  writes a row at window_end = now, and getHiringSignals reads the LATEST
//                           one. A pass over 5 fixtures makes "Stripe: 1 open role" the CURRENT
//                           answer while the true snapshot sits underneath it, unread. Live risk.
//   runOrgLayerRollup       no-op today (all 5 fixtures have org_unit_raw = NULL) — guarded anyway,
//                           because that is a fact about today's rows, not about the contract.
//   computeTermWeights      opens with `DELETE FROM ats_term_weights` inside the rebuild.
//
// ── EACH TEST INJECTS THE VIOLATION ────────────────────────────────────────────────────────────
//
// Task A's finding was that a guard extended by READING it ships inert and green. So every case
// here puts the system into the state the guard is supposed to catch and asserts the real function
// declines — and, for the destructive one, asserts the previous contents are still there
// afterwards. "It returned skipped: true" is not the claim; "the 856 rows survived" is.
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  assessBoardSufficiency, assessRebuildScope, boardSufficiency, thinBoardConfirmed,
  MIN_BOARD_FOR_DERIVATION, MIN_REBUILD_TABLE, MIN_REBUILD_RETAIN_SHARE,
} from "../services/jobs/boardSufficiency.js";
import { runHiringSignalsRollup, getHiringSignals } from "../services/jobs/hiringSignals.js";
import { computeTermWeights, loadTermWeights } from "../services/atsTermWeights.js";

// Quiet: every refusal logs to console.error by design, and a passing suite should not look like a
// failing one. The MESSAGE is asserted through the returned reason, not through the log.
function muted(fn) {
  const err = console.error, warn = console.warn, log = console.log;
  console.error = console.warn = console.log = () => {};
  try { return fn(); } finally { console.error = err; console.warn = warn; console.log = log; }
}

// ── the purged board, with its derived output still in place ────────────────
function purgedBoard() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, company TEXT, title TEXT, normalized_title TEXT,
      skills_json TEXT, bucket_domain TEXT, discovered_at INTEGER, updated_at INTEGER,
      is_active INTEGER DEFAULT 1
    );
    CREATE TABLE company_hiring_signals (
      company TEXT, window_start INTEGER, window_end INTEGER, open_count INTEGER,
      new_count INTEGER, expired_count INTEGER, domain_breakdown_json TEXT,
      growth_score REAL, updated_at INTEGER, PRIMARY KEY (company, window_end)
    );
    CREATE TABLE ats_term_weights (
      role_family TEXT, term TEXT, df INTEGER, corpus_size INTEGER, weight REAL, computed_at INTEGER
    );
  `);
  // The five survivors, as they actually are on the live board.
  const ins = db.prepare(
    "INSERT INTO scraped_jobs (job_id,company,title,normalized_title,skills_json,bucket_domain,discovered_at,updated_at,is_active) VALUES (?,?,?,?,?,?,?,?,1)");
  const skills = JSON.stringify(["python", "kubernetes", "postgresql"]);
  for (const [id, co] of [["a", "Stripe"], ["b", "Block"], ["c", "Datadog"], ["d", "Figma"], ["e", "Physical Superintelligence"]]) {
    ins.run(id, co, "Software Engineer", "software engineer", skills, "backend", 1_788_000_000, 1_788_000_000);
  }
  // The TRUE snapshot the rollup would bury: Stripe with a real board behind it.
  db.prepare(`INSERT INTO company_hiring_signals
    (company,window_start,window_end,open_count,new_count,expired_count,domain_breakdown_json,growth_score,updated_at)
    VALUES ('Stripe', 1785400000, 1787900000, 275, 40, 3, '{}', 0.13, 1787900000)`).run();
  // 856 real term weights.
  const w = db.prepare("INSERT INTO ats_term_weights VALUES (?,?,?,?,?,?)");
  for (let i = 0; i < 856; i++) w.run("__global__", `term-${i}`, 12, 1289, 1.4, 1787900000);
  return db;
}

// ── the guards, exercised through the real functions ────────────────────────

test("hiring signals rollup refuses a 5-row board, and the true snapshot stays current", () => {
  const db = purgedBoard();
  const before = getHiringSignals(db, "Stripe");
  assert.equal(before.openCount ?? before.open_count, 275, "the real snapshot is what is stored now");

  const r = muted(() => runHiringSignalsRollup(db));

  assert.equal(r.skipped, true, "the pass must decline");
  assert.equal(r.count, 0, "and write nothing");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM company_hiring_signals").get().c, 1,
    "⛔ no fixture-derived row may be added — window_end = now would make it the latest");

  // The assertion that actually matters. A new row would not delete the old one; it would HIDE it,
  // because the read surface takes the newest window_end.
  const after = getHiringSignals(db, "Stripe");
  assert.equal(after.openCount ?? after.open_count, 275,
    "Stripe must not now read as having 1 open role");
});

test("a real board is rolled up exactly as before — the guard must not block normal operation", () => {
  const db = purgedBoard();
  const ins = db.prepare(
    "INSERT INTO scraped_jobs (job_id,company,title,skills_json,bucket_domain,discovered_at,updated_at,is_active) VALUES (?,?,?,?,?,?,?,1)");
  for (let i = 0; i < MIN_BOARD_FOR_DERIVATION; i++) {
    ins.run(`real-${i}`, "Stripe", "Software Engineer", "[]", "backend", 1_788_200_000, 1_788_200_000);
  }
  const r = muted(() => runHiringSignalsRollup(db));
  assert.notEqual(r.skipped, true, "a board over the floor rolls up normally");
  assert.ok(r.count >= 1);
});

test("an explicit ALLOW_THIN_BOARD_DERIVATION still lets an operator proceed", () => {
  const prev = process.env.ALLOW_THIN_BOARD_DERIVATION;
  process.env.ALLOW_THIN_BOARD_DERIVATION = "1";
  try {
    const db = purgedBoard();
    const r = muted(() => runHiringSignalsRollup(db));
    assert.notEqual(r.skipped, true, "the flag is an authorisation, not a suggestion");
    assert.equal(r.count, 5, "all five fixture companies");
  } finally {
    if (prev === undefined) delete process.env.ALLOW_THIN_BOARD_DERIVATION;
    else process.env.ALLOW_THIN_BOARD_DERIVATION = prev;
  }
});

test("computeTermWeights refuses to trade 856 measured weights for a handful", () => {
  const db = purgedBoard();
  const before = loadTermWeights(db);
  assert.equal(before.weights.size, 856, "the real table is what is stored now");

  const r = muted(() => computeTermWeights(db, { now: 1_788_600_000 }));

  assert.equal(r.skipped, true, "the rebuild must decline");
  assert.match(r.reason, /856 rows with/, "and say what it was about to trade away");

  // ⛔ THE CLAIM. Not "it returned skipped" — that the table is still there. The DELETE and the
  // rebuild share a transaction, so a guard that fired one statement too late would leave nothing.
  assert.equal(db.prepare("SELECT COUNT(*) c FROM ats_term_weights").get().c, 856,
    "every weight survives");
  assert.equal(loadTermWeights(db).weights.size, 856, "and the scorer still loads them");
});

test("computeTermWeights still rebuilds freely when there is nothing to lose", () => {
  // The case that would otherwise force this guard to be opted out of in tests: a fresh table. A
  // guard that has to be disabled where it is first exercised is not a guard.
  const db = purgedBoard();
  db.prepare("DELETE FROM ats_term_weights").run();
  const r = muted(() => computeTermWeights(db, { now: 1_788_600_000 }));
  assert.notEqual(r.skipped, true, "an empty table is not an asset to protect");
  assert.ok(db.prepare("SELECT COUNT(*) c FROM ats_term_weights").get().c > 0,
    "and the rebuild really wrote weights from the fixtures");
});

// ── the decision functions, one injected shape at a time ────────────────────

test("assessBoardSufficiency — every shape", () => {
  const S = (o) => assessBoardSufficiency({ operation: "test", ...o });
  assert.equal(S({ active: 5 }).sufficient, false, "the purged board");
  assert.equal(S({ active: MIN_BOARD_FOR_DERIVATION - 1 }).sufficient, false, "one under the floor");
  assert.equal(S({ active: MIN_BOARD_FOR_DERIVATION }).sufficient, true, "exactly at the floor is enough");
  assert.equal(S({ active: 1291 }).sufficient, true, "the real board");
  assert.equal(S({ active: 5, confirmed: true }).sufficient, true, "confirmation overrides");
  assert.equal(S({}).sufficient, false, "a missing count must fail SAFE, not permissively");
  assert.match(S({ active: 5 }).reason, /ALLOW_THIN_BOARD_DERIVATION=1/,
    "a refusal that does not say how to proceed deliberately is an obstacle, not a safeguard");
});

test("assessRebuildScope — every shape", () => {
  const S = (o) => assessRebuildScope({ operation: "test", ...o });
  assert.equal(S({ existing: 856, incoming: 3 }).braked, true, "the incident's shape");
  assert.equal(S({ existing: 856, incoming: 856 }).braked, false, "a steady rebuild");
  assert.equal(S({ existing: 856, incoming: 2000 }).braked, false, "a growing one");
  assert.equal(S({ existing: 100, incoming: 50 }).braked, false, "exactly at the retain floor is allowed");
  assert.equal(S({ existing: 100, incoming: 49 }).braked, true, "one row under it is not");
  assert.equal(S({ existing: MIN_REBUILD_TABLE, incoming: 0 }).braked, false,
    "a table at the size floor is not yet an asset — the guard must not fire on a fresh install");
  assert.equal(S({ existing: MIN_REBUILD_TABLE + 1, incoming: 0 }).braked, true, "one row above it, live");
  assert.equal(S({ existing: 856, incoming: 3, confirmed: true }).allowed, true, "confirmation overrides");

  // ⛔ 0/0. If `retained` became NaN every comparison against it would be false and the guard would
  // silently allow everything — the same inert-but-green shape as the test that asserted
  // looksLikeLocation("Bangalore") === false.
  const empty = S({ existing: 0, incoming: 0 });
  assert.equal(Number.isNaN(empty.retained), false, "retained must never be NaN");
  assert.equal(empty.allowed, true);
  assert.equal(S({}).allowed, true, "missing counts mean nothing is at risk");
  assert.equal(MIN_REBUILD_RETAIN_SHARE > 0 && MIN_REBUILD_RETAIN_SHARE < 1, true);
});

test("thinBoardConfirmed — only a real authorisation counts as one", () => {
  for (const v of ["1", "true", "TRUE"]) assert.equal(thinBoardConfirmed({ ALLOW_THIN_BOARD_DERIVATION: v }), true, v);
  // A falsy-LOOKING string is still a non-empty string, so a bare truthiness check would read "0"
  // and "false" as permission.
  for (const v of ["0", "false", "no", "", undefined]) {
    assert.equal(thinBoardConfirmed({ ALLOW_THIN_BOARD_DERIVATION: v }), false, String(v));
  }
});

test("boardSufficiency treats a missing scraped_jobs table as the thinnest board there is", () => {
  // Not as an error to swallow into a permissive default. A derivation that cannot even see the
  // board must not proceed as though the board were fine.
  const db = new Database(":memory:");
  const r = boardSufficiency(db, "test", { env: {} });
  assert.equal(r.sufficient, false);
  assert.equal(r.active, 0);
});
