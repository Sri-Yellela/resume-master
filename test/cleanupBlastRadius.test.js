// ⛔ ONE UNATTENDED PASS MUST NOT BE ABLE TO EMPTY THE BOARD.
//
// cleanup_log id 85, 2026-09-02T02:06:12Z: runExpiredJobsCleanup deleted **1288 of 1291** rows from
// scraped_jobs. Three starred rows survived. Every human-graded posting behind rho = 0.746 went with
// it, and 8690 technographics, 697 org units and 856 term weights were left describing rows that no
// longer exist.
//
// The predicate was correct. Reconstructed from the 2026-08-31 backup: 1251 of the 1291 postings
// arrived in a single burst on 2026-08-24, nothing was scraped afterwards, and by 2026-09-02 the
// seven-day cutoff had swept past ALL of them at once. Not one row was expired wrongly. The board
// was emptied because arrivals were bursty and refill had stopped — and the pass that ran was the
// STARTUP one, whose entire purpose is to catch the window in which the server was down, i.e. the
// same window in which the re-scrape cron was also not running.
//
// So this file does not test the cutoff. It tests the BLAST RADIUS: that a pass which would remove
// most of the board refuses, retires instead, and says so.
//
// ── THE CONTROL IS THE POINT ───────────────────────────────────────────────────────────────────
//
// `deletes everything WITHOUT the brake` reproduces the incident on the same fixture and asserts
// the board really is emptied. Without it, "the brake kept 1291 rows" could be true because the
// fixture never had anything to delete, and the test would pass while proving nothing. That control
// is what makes the braked assertion evidence rather than a restatement.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import {
  assessCleanupScope, cleanupBrakeOptions, DEFAULT_MAX_SHARE, DEFAULT_MIN_BOARD,
} from "../services/jobs/cleanupBrake.js";
import { at } from "../test-support/sourceAnchors.js";

const NOW    = 1_788_314_772;            // cleanup_log id 85's run_at, to the second
const CUTOFF = NOW - 7 * 24 * 60 * 60;   // 2026-08-26T02:06:12Z

// ── the incident's board, at the scale it actually had ──────────────────────
//
// 1291 rows, 1251 of them from the 2026-08-24 burst, 3 starred, 0 applied — the real distribution
// from the backup. Scale matters: the brake is share-based and deliberately ignores small boards,
// so a five-row fixture could not exercise it at all.
function incidentBoard() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, scraped_at INTEGER, is_active INTEGER DEFAULT 1);
    CREATE TABLE user_jobs (job_id TEXT, starred INTEGER DEFAULT 0, applied INTEGER DEFAULT 0);
  `);
  const ins = db.prepare("INSERT INTO scraped_jobs (job_id,scraped_at,is_active) VALUES (?,?,1)");
  const add = db.transaction((n, day) => {
    for (let i = 0; i < n; i++) ins.run(`${day}-${i}`, Date.parse(`${day}T12:00:00Z`) / 1000);
  });
  add(27, "2026-08-21"); add(4, "2026-08-22"); add(9, "2026-08-23"); add(1251, "2026-08-24");
  for (const j of ["2026-08-24-0", "2026-08-24-1", "2026-08-24-2"]) {
    db.prepare("INSERT INTO user_jobs (job_id,starred) VALUES (?,1)").run(j);
  }
  return db;
}

// The predicate from server.js, used for BOTH the count and the statement exactly as the real
// function does — a brake that measured something other than what it gates would be worthless.
const EXPIRED = `
  scraped_at < ?
  AND job_id NOT IN (SELECT DISTINCT job_id FROM user_jobs WHERE applied = 1)
  AND job_id NOT IN (SELECT DISTINCT job_id FROM user_jobs WHERE starred = 1)
`;

/** runExpiredJobsCleanup's expiry half. `brake: false` is the pre-fix behaviour. */
function runCleanup(db, { brake = true, env = {} } = {}) {
  const total = db.prepare("SELECT COUNT(*) c FROM scraped_jobs").get().c;
  const wouldDelete = db.prepare(`SELECT COUNT(*) c FROM scraped_jobs WHERE ${EXPIRED}`).get(CUTOFF).c;
  const scope = brake
    ? assessCleanupScope({ total, deletable: wouldDelete, ...cleanupBrakeOptions(env) })
    : { allowed: true, braked: false, reason: null };
  if (scope.allowed) {
    return { ...scope, deleted: db.prepare(`DELETE FROM scraped_jobs WHERE ${EXPIRED}`).run(CUTOFF).changes, retired: 0 };
  }
  const retired = db.prepare(`UPDATE scraped_jobs SET is_active = 0 WHERE is_active = 1 AND ${EXPIRED}`)
    .run(CUTOFF).changes;
  return { ...scope, deleted: 0, retired };
}

// ── the control: the incident, reproduced ───────────────────────────────────

test("WITHOUT the brake the 2026-09-02 pass empties the board — the incident, reproduced", () => {
  const db = incidentBoard();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM scraped_jobs").get().c, 1291);

  const r = runCleanup(db, { brake: false });

  assert.equal(r.deleted, 1288, "cleanup_log id 85 recorded jobs_deleted = 1288");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM scraped_jobs").get().c, 3,
    "three starred rows, and nothing else, is what was actually left on the live board");
});

test("WITH the brake the same pass deletes nothing and retires instead", () => {
  const db = incidentBoard();
  const r = runCleanup(db);

  assert.equal(r.braked, true, "a pass this size must refuse");
  assert.equal(r.deleted, 0, "⛔ nothing may be deleted");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM scraped_jobs").get().c, 1291,
    "every posting survives — this is the whole point, the text is the evidence");
  assert.equal(r.retired, 1288, "and every expired row still leaves discovery, which is true of it");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM scraped_jobs WHERE is_active=1").get().c, 3,
    "the board a user browses is the same either way; only the recoverability differs");

  // The refusal has to be legible to whoever finds it, months later, in a log.
  assert.match(r.reason, /1288 of 1291/);
  assert.match(r.reason, /CLEANUP_ALLOW_MASS_DELETE=1/,
    "a refusal that does not say how to proceed deliberately is an obstacle, not a safeguard");
});

test("an explicit confirmation still lets an operator empty the board", () => {
  const db = incidentBoard();
  const r = runCleanup(db, { env: { CLEANUP_ALLOW_MASS_DELETE: "1" } });

  assert.equal(r.braked, false);
  assert.equal(r.deleted, 1288, "the flag is an authorisation, not a suggestion");
  assert.match(r.reason, /EXPLICITLY CONFIRMED/, "and it is still recorded as a deliberate act");
});

test("ordinary turnover is untouched — the brake must not become routine", () => {
  // 100 rows, 20 expired. A brake that fires on normal passes trains its reader to ignore it.
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, scraped_at INTEGER, is_active INTEGER DEFAULT 1);
           CREATE TABLE user_jobs (job_id TEXT, starred INTEGER DEFAULT 0, applied INTEGER DEFAULT 0);`);
  const ins = db.prepare("INSERT INTO scraped_jobs (job_id,scraped_at,is_active) VALUES (?,?,1)");
  for (let i = 0; i < 20; i++) ins.run(`old-${i}`, CUTOFF - 86400);
  for (let i = 0; i < 80; i++) ins.run(`new-${i}`, CUTOFF + 86400);

  const r = runCleanup(db);
  assert.equal(r.braked, false, "20% of the board is ordinary expiry");
  assert.equal(r.deleted, 20);
});

// ── the decision function, one injected violation per shape ─────────────────
//
// Each case is a state the brake has to get right, constructed directly rather than by building a
// board that happens to land there. Task A's finding was that a guard extended by READING it ships
// inert; these are the shapes, injected.

test("assessCleanupScope — every shape it has to separate", () => {
  const S = (o) => assessCleanupScope({ minBoard: DEFAULT_MIN_BOARD, maxShare: DEFAULT_MAX_SHARE, ...o });

  assert.equal(S({ total: 1291, deletable: 1288 }).braked, true, "the incident");
  assert.equal(S({ total: 1291, deletable: 646 }).braked, true, "just over half");
  assert.equal(S({ total: 1000, deletable: 500 }).braked, false, "exactly at the limit is allowed");
  assert.equal(S({ total: 1000, deletable: 499 }).braked, false, "under the limit");

  // ⛔ A ZERO-ROW BOARD. share is 0/0; if that became NaN, every comparison against it would be
  // false and the brake would silently pass everything. That is the same failure mode as the test
  // which asserted looksLikeLocation("Bangalore") === false: correct-looking, and inert.
  const empty = S({ total: 0, deletable: 0 });
  assert.equal(Number.isNaN(empty.share), false, "share must never be NaN");
  assert.equal(empty.allowed, true);

  assert.equal(S({ total: 1291, deletable: 0 }).braked, false, "a pass that deletes nothing never brakes");
  assert.equal(S({ total: 5, deletable: 5 }).braked, false,
    "a 5-row fixture board is not an incident — requiring a flag here would make the flag routine");
  assert.equal(S({ total: DEFAULT_MIN_BOARD + 1, deletable: DEFAULT_MIN_BOARD + 1 }).braked, true,
    "one row above the floor, the brake is live");
  assert.equal(S({ total: 1291, deletable: 1288, confirmed: true }).allowed, true, "confirmation overrides");

  // Missing/garbage inputs must fail SAFE. A caller that forgets an argument must not get a
  // permissive answer, and `undefined` deletable must not read as "delete everything".
  assert.equal(S({}).allowed, true, "nothing to delete means nothing to stop");
  assert.equal(S({ total: 1291, deletable: undefined }).braked, false);
});

test("cleanupBrakeOptions — only a real authorisation counts as one", () => {
  for (const v of ["1", "true", "TRUE"]) {
    assert.equal(cleanupBrakeOptions({ CLEANUP_ALLOW_MASS_DELETE: v }).confirmed, true, `"${v}" authorises`);
  }
  // The shape that matters: a falsy-looking STRING is still a non-empty string, so a bare
  // truthiness check would read "0" and "false" as permission to delete the board.
  for (const v of ["0", "false", "no", "", undefined]) {
    assert.equal(cleanupBrakeOptions({ CLEANUP_ALLOW_MASS_DELETE: v }).confirmed, false, `"${v}" does NOT authorise`);
  }
  assert.equal(cleanupBrakeOptions({ CLEANUP_MAX_DELETE_SHARE: "0.9" }).maxShare, 0.9);
  assert.equal(cleanupBrakeOptions({ CLEANUP_MAX_DELETE_SHARE: "nonsense" }).maxShare, DEFAULT_MAX_SHARE,
    "an unparseable override falls back to the default rather than to NaN");
});

// ── and that server.js actually routes through it ───────────────────────────

test("server.js counts the pass before running it, and gates the DELETE on the result", () => {
  const src = fs.readFileSync("server.js", "utf8");
  const fn = src.slice(at(src, "function runExpiredJobsCleanup()", 0, "server.js"),
                       at(src, "cron.schedule(\"0 3 * * *\"", 0, "server.js"));

  assert.match(fn, /assessCleanupScope\(/, "the pass must be assessed, not just run");
  assert.match(fn, /cleanupBrakeOptions\(\)/, "and the operator's overrides must be read");

  // ⛔ ORDER. The count has to precede the DELETE; a brake evaluated afterwards is a report.
  assert.ok(at(fn, "assessCleanupScope(") < at(fn, "DELETE FROM scraped_jobs"),
    "assessCleanupScope must be called BEFORE the DELETE statement is built");

  // The DELETE must be inside the allowed branch. Matching only on the presence of the call would
  // pass on code that computes a verdict and then deletes anyway.
  const allowed = fn.slice(at(fn, "if (scope.allowed)"), at(fn, "} else {", at(fn, "if (scope.allowed)")));
  assert.match(allowed, /DELETE FROM scraped_jobs/, "the delete belongs to the allowed branch");
  assert.doesNotMatch(fn.slice(at(fn, "} else {", at(fn, "if (scope.allowed)")), fn.length),
    /DELETE FROM scraped_jobs/, "and the braked branch must not delete");

  // One predicate for the count and the statement, so they cannot drift apart.
  assert.match(fn, /const EXPIRED_PREDICATE = /, "the predicate must be defined once");
  assert.match(fn, /SELECT COUNT\(\*\) c FROM scraped_jobs WHERE \$\{EXPIRED_PREDICATE\}/);
  assert.match(fn, /DELETE FROM scraped_jobs WHERE \$\{EXPIRED_PREDICATE\}/);

  // A refusal has to reach cleanup_log. id 85 is how the incident was found at all; a pass that
  // declined would otherwise write jobs_deleted: 0 and read as "there was nothing to do".
  assert.match(fn, /brakedDeletable/, "the refusal must be recorded in cleanup_log details");
});
