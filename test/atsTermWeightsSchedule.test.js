// THE SCORER HAD A REFUSAL AND NO SCHEDULE, SO IT DEGRADED TO UNWEIGHTED AND CALLED THAT SAFETY.
//
// `MAX_WEIGHT_AGE_DAYS = 45` makes the scorer DROP weights it considers too old. That is a safety
// net — scripts/recomputeAtsTermWeights.js's own header says "That refusal is the safety net, not
// the schedule" — and nothing ever supplied the other half. Left alone, the table ages past 45
// days, every score silently loses its weighting, and the only signal is a console.warn.
//
// ⛔ AND THAT console.warn COULD NOT FIRE IN THE STATE THAT ACTUALLY MATTERED. It was gated on
// `loaded.stale && loaded.weights.size`, so it required a table that EXISTS and is old. An EMPTY
// table has size 0. Production's `ats_term_weights` had never been computed — 0 rows, no log line,
// no symptom — so every ATS score the product has ever served was computed unweighted, and nothing
// anywhere said so.
//
// Measured cost of unweighted scoring on this board: 20.4% of scores differ by up to 5 points,
// 2.8% land in a different band, and rho against the owner's own grades falls 0.476 -> 0.415. Not
// catastrophic. Entirely invisible, which is the actual defect.
//
// So: three states, all reported (absent | stale | fresh), a refresh threshold well inside the
// refusal threshold, and the rebuild wired to boot and to the nightly cron.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../scripts/migrations.js";
import { at } from "../test-support/sourceAnchors.js";
import {
  atsWeightStatus, weightsNeedRefresh, maybeRecomputeTermWeights,
  REFRESH_WEIGHT_AGE_DAYS, MAX_WEIGHT_AGE_DAYS, GLOBAL_FAMILY,
} from "../services/atsTermWeights.js";

const SERVER = fs.readFileSync("server.js", "utf8");
const DAY = 86400;
const NOW = 1789000000;

function freshDb() {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m.sql);
  return db;
}

/** Enriched postings, enough of them to clear MIN_DF and the thin-board guard. */
function seedCorpus(db, n = 120) {
  const ins = db.prepare(`INSERT INTO scraped_jobs (job_id,title,normalized_title,company,search_query,_hash,is_active,skills_json)
                          VALUES (?,?,?,?,'q',?,1,?)`);
  for (let i = 0; i < n; i++) {
    ins.run(`j${i}`, "Software Engineer", "software engineer", "Acme", `h${i}`,
      JSON.stringify(["python", "kubernetes", "sql", `unique term ${i}`]));
  }
}

const seedWeights = (db, { computedAt, terms = 10, family = GLOBAL_FAMILY }) => {
  const ins = db.prepare(`INSERT INTO ats_term_weights (role_family, term, df, corpus_size, weight, computed_at)
                          VALUES (?,?,?,?,?,?)`);
  for (let i = 0; i < terms; i++) ins.run(family, `t${i}`, 9, 500, 1.4, computedAt);
};

// ════════════════════════════════════════════════════════════════════════════════════════════
// THREE STATES, NOT TWO
// ════════════════════════════════════════════════════════════════════════════════════════════

test("⛔ 'absent' is its own state — the one that was invisible", () => {
  const db = freshDb();
  try {
    const s = atsWeightStatus(db, { now: NOW });
    assert.equal(s.state, "absent");
    assert.equal(s.terms, 0);
    assert.equal(s.computedAt, null);
    assert.equal(s.ageDays, null, "an absent table has no age, and must not report 0 days old");
  } finally { db.close(); }
});

test("fresh and stale are told apart at the REFUSAL threshold", () => {
  const db = freshDb();
  try {
    seedWeights(db, { computedAt: NOW - 10 * DAY });
    assert.equal(atsWeightStatus(db, { now: NOW }).state, "fresh");
    db.prepare("UPDATE ats_term_weights SET computed_at = ?").run(NOW - (MAX_WEIGHT_AGE_DAYS + 1) * DAY);
    assert.equal(atsWeightStatus(db, { now: NOW }).state, "stale");
  } finally { db.close(); }
});

test("⛔ the REFRESH threshold sits well inside the REFUSAL threshold", () => {
  // The entire design. If these were equal, the schedule would fire only once the scorer had
  // already stopped using the weights — a rebuild triggered by the damage it exists to prevent.
  assert.ok(REFRESH_WEIGHT_AGE_DAYS < MAX_WEIGHT_AGE_DAYS,
    "refresh must happen before refusal, or the net catches nothing");
  assert.ok(MAX_WEIGHT_AGE_DAYS / REFRESH_WEIGHT_AGE_DAYS >= 2,
    "and with room for at least one failed nightly run before the cliff");
});

test("a refresh is due when absent or past the refresh age, not merely when stale", () => {
  const db = freshDb();
  try {
    assert.equal(weightsNeedRefresh(atsWeightStatus(db, { now: NOW }), { now: NOW }), true, "absent");

    seedWeights(db, { computedAt: NOW - (REFRESH_WEIGHT_AGE_DAYS - 1) * DAY });
    assert.equal(weightsNeedRefresh(atsWeightStatus(db, { now: NOW }), { now: NOW }), false, "young enough");

    db.prepare("UPDATE ats_term_weights SET computed_at = ?").run(NOW - (REFRESH_WEIGHT_AGE_DAYS + 1) * DAY);
    const s = atsWeightStatus(db, { now: NOW });
    assert.equal(s.state, "fresh", "still USABLE by the scorer...");
    assert.equal(weightsNeedRefresh(s, { now: NOW }), true, "...and already due for rebuild");
  } finally { db.close(); }
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE REBUILD
// ════════════════════════════════════════════════════════════════════════════════════════════

test("an absent table is rebuilt, and the caller's cache is invalidated", () => {
  // ⛔ THE INVALIDATION IS THE TRAP. server.js caches loaded weights per role family in a
  // module-level Map — INCLUDING the null entry meaning "unweighted". A rebuild that does not
  // clear it writes a perfectly good table that nothing reads until the next restart, which is
  // indistinguishable from a rebuild that never happened. CC3 hit this exact shape with the
  // synonym cache.
  const db = freshDb();
  try {
    seedCorpus(db);
    let invalidated = 0;
    const r = maybeRecomputeTermWeights(db, { now: NOW, onInvalidate: () => invalidated++ });
    assert.equal(r.ran, true);
    assert.equal(r.before.state, "absent");
    assert.equal(r.after.state, "fresh");
    assert.ok(r.after.terms > 0, "it wrote weights");
    assert.equal(invalidated, 1, "and told the caller to drop its cached Maps");
  } finally { db.close(); }
});

test("a table that does not need refreshing is left alone, and does NOT invalidate", () => {
  const db = freshDb();
  try {
    seedCorpus(db);
    seedWeights(db, { computedAt: NOW - 1 * DAY });
    let invalidated = 0;
    const r = maybeRecomputeTermWeights(db, { now: NOW, onInvalidate: () => invalidated++ });
    assert.equal(r.ran, false);
    assert.match(r.reason, /fresh/);
    assert.equal(invalidated, 0, "clearing a cache nothing rebuilt would just cost a reload");
    assert.equal(atsWeightStatus(db, { now: NOW }).terms, 10, "the existing table is untouched");
  } finally { db.close(); }
});

test("force rebuilds a table that is not yet due", () => {
  const db = freshDb();
  try {
    seedCorpus(db);
    seedWeights(db, { computedAt: NOW - 1 * DAY });
    const r = maybeRecomputeTermWeights(db, { now: NOW, force: true });
    assert.equal(r.ran, true);
    assert.equal(r.reason, "forced");
  } finally { db.close(); }
});

test("⛔ a thin-board REFUSAL is reported as refused, keeps the old table, and does not invalidate", () => {
  // assessRebuildScope exists because cleanup_log id 85 took scraped_jobs from 1,291 rows to 5.
  // A scheduled rebuild must not be the thing that finally destroys a good weight table when the
  // corpus is momentarily gone — and "0 terms written" must not read as a successful recompute.
  const db = freshDb();
  try {
    seedCorpus(db, 3);                                   // a board that has been purged
    seedWeights(db, { computedAt: NOW - 30 * DAY, terms: 800 });
    let invalidated = 0;
    const r = maybeRecomputeTermWeights(db, { now: NOW, onInvalidate: () => invalidated++,
                                              log: { warn() {}, error() {} } });
    assert.equal(r.ran, false);
    assert.match(r.reason, /^refused: /, "a refusal is not a success and not a failure");
    assert.equal(invalidated, 0);
    assert.equal(atsWeightStatus(db, { now: NOW }).terms, 800, "the existing weights survive");
  } finally { db.close(); }
});

test("a recompute that throws is reported, and never propagates", () => {
  // A scorer on old weights beats a dead cron tick, and both beat a boot that fails over a
  // ranking refinement.
  const db = freshDb();
  db.close();                                            // every query will now throw
  const r = maybeRecomputeTermWeights(db, { now: NOW, log: { warn() {}, error() {} } });
  assert.equal(r.ran, false);
  assert.match(r.reason, /^failed: /);
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// WIRING — a schedule nothing calls is not a schedule
// ════════════════════════════════════════════════════════════════════════════════════════════

test("⛔ the per-job warning covers ABSENT, not only stale", () => {
  const fn = SERVER.slice(at(SERVER, "function atsTermWeightsForJob(job)"),
                          at(SERVER, "const atsScoreQueue = []"));
  assert.match(fn, /if \(!loaded \|\| !loaded\.weights\.size\)/,
    "an empty table must warn — that was production's state and it was silent");
  assert.match(fn, /NO term weights/);
  assert.match(fn, /STALE/);
  // The old gate required a non-empty table to say anything at all.
  assert.doesNotMatch(fn, /if \(loaded && loaded\.stale && loaded\.weights\.size\)/);
});

test("both boot and the nightly cron run the refresh, through one function", () => {
  assert.match(SERVER, /function runTermWeightRefresh\(trigger\)/);
  assert.match(SERVER, /setImmediate\(\(\) => runTermWeightRefresh\("boot"\)\)/,
    "boot, deferred past module evaluation so the weight cache exists");
  assert.match(SERVER, /runTermWeightRefresh\("cron"\)/, "and the nightly pass, after the crawl");
  // One implementation, so the two cannot report the same event differently.
  assert.equal((SERVER.match(/maybeRecomputeTermWeights\(/g) || []).length, 1);
});

test("the refresh is invoked with the cache invalidator, not without it", () => {
  // ⛔ The end anchor is the NEXT function, not a distant one. It used to be `atsClaims`, and
  // `termWeightRefreshHealth` was later inserted between the two — which silently widened this
  // slice to cover a function the assertion was never about. A source-anchored slice is only as
  // precise as its narrower end.
  const fn = SERVER.slice(at(SERVER, "function runTermWeightRefresh(trigger)"),
                          at(SERVER, "function termWeightRefreshHealth()"));
  assert.match(fn, /onInvalidate: invalidateAtsWeightCache/,
    "without this the rebuild is invisible until the next restart");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE LAST OPEN ITEM — a refresh that fails EVERY night is still silent
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// docs/ATS_TERM_WEIGHTS_SCHEDULE.md §7 named this and did not build it: "if the 45-day refusal is
// ever hit, that means the nightly pass has failed three times running, which is worth a louder
// signal than this task builds."
//
// The refresh is never-fatal on purpose — a scorer on 20-day-old weights beats a dead cron tick —
// but never-fatal plus console-only means a pass failing every single night is indistinguishable
// from one that simply has not been due. The table reads "fresh" until 14 days, then "stale", and
// at 45 days the scorer silently drops to unweighted. Nothing in between ever says "the thing that
// prevents this has not worked in three weeks".

test("a refresh that ran, refused, or failed is RECORDED — the nightly no-op is not", () => {
  const fn = SERVER.slice(at(SERVER, "function runTermWeightRefresh(trigger)"),
                          at(SERVER, "function termWeightRefreshHealth()"));
  assert.match(fn, /runKind: "term_weights", source: trigger, status: "ok"/,
    "a successful rebuild is recorded");
  assert.match(fn, /status: r\.reason\.startsWith\("refused"\) \? "no_results" : "failed"/,
    "a refusal and a failure are recorded as DIFFERENT statuses — conflating them would make the " +
    "consecutive-failure count fire on the thin-board guard doing its job");
  assert.match(fn, /status: "failed", startedAt,\s*\n?\s*errorText: `threw/,
    "and a throw is recorded rather than only logged");

  // ⛔ The skip is NOT recorded, and that is deliberate: "not due yet" is the expected state on 13
  // nights out of 14. A row per night would bury the failures the table exists to surface.
  const recordCalls = (fn.match(/recordPipelineRun\(/g) || []).length;
  assert.equal(recordCalls, 3, "exactly three outcomes are recorded: ok, refused, failed");
});

test("⛔ consecutive failures are counted, and a REFUSAL neither increments nor resets", () => {
  const fn = SERVER.slice(at(SERVER, "function termWeightRefreshHealth()"),
                          at(SERVER, "function atsClaims(profile)"));
  assert.match(fn, /if \(r\.status === "failed"\) consecutiveFailures\+\+/);
  assert.match(fn, /else if \(r\.status === "ok"\) break/,
    "only a success resets the streak");
  assert.doesNotMatch(fn, /no_results".*(break|\+\+)/,
    "a refusal is the thin-board guard keeping a good table — it is not evidence either way " +
    "about whether the pass works, so it must neither break the loop nor count");
});

test("the streak reaches the cliff in THREE, and the number is derived from the thresholds", () => {
  // Not a taste call. With REFRESH at 14 and REFUSAL at 45 there are two further nightly chances
  // after the first miss, so three consecutive failures is when the refusal becomes reachable.
  assert.ok(MAX_WEIGHT_AGE_DAYS - REFRESH_WEIGHT_AGE_DAYS >= 2 * 3,
    "three nightly retries must fit between the refresh threshold and the refusal, or the " +
    "reported number is describing a cliff that arrives sooner than it claims");
  assert.match(SERVER, /failuresBeforeCliff: 3/);
});

test("a failing refresh is LOUD at boot, and silent when healthy", () => {
  const boot = SERVER.slice(at(SERVER, "const before = atsWeightStatus(db);"),
                            at(SERVER, 'setImmediate(() => runTermWeightRefresh("boot"))'));
  assert.match(boot, /if \(health\.consecutiveFailures > 0\)/,
    "nothing is printed in the healthy case — '0 consecutive failures' on every boot forever is " +
    "how a warning stops being read");
  assert.match(boot, /console\.error/, "and a failing streak goes to stderr, not stdout");
  assert.match(boot, /REFRESH HAS FAILED/);
});

test("/api/version carries the refresh health, not only the table's freshness", () => {
  const route = SERVER.slice(at(SERVER, 'app.get("/api/version"'),
                             at(SERVER, "// ── Profile isolation diagnostic"));
  assert.match(route, /refresh: termWeightRefreshHealth\(\)/,
    "'fresh' answers whether the TABLE is usable; it says nothing about whether the mechanism " +
    "that keeps it that way still works");
});

test("pipeline_runs needs no migration for the new grain, and the log says why", () => {
  // The table is generic — run_kind is a bare TEXT column with no CHECK — so a third grain costs
  // nothing. Asserting it here means a later CHECK constraint fails loudly rather than making
  // every weight rebuild silently unrecorded.
  const db = freshDb();
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'pipeline_runs'").get()?.sql || "";
  assert.ok(sql, "pipeline_runs must exist by migration 069");
  assert.doesNotMatch(sql, /CHECK\s*\(\s*run_kind/i,
    "a CHECK on run_kind would reject 'term_weights' and the refresh log would vanish silently");

  const log = fs.readFileSync("services/jobs/pipelineRunLog.js", "utf8");
  assert.match(log, /'term_weights'/, "the third grain is documented where the other two are");
});

test("/api/version answers 'is the scorer weighted?' without auth", () => {
  // The question that could not be asked from outside, and whose true answer in production was no.
  const route = SERVER.slice(at(SERVER, 'app.get("/api/version"'),
                             at(SERVER, "// ── Profile isolation diagnostic"));
  assert.match(route, /atsWeightStatus\(db\)/);
  assert.match(route, /weightedScoring: w\.state === "fresh"/);
  assert.match(route, /refreshAtDays/);
  assert.match(route, /refusedAtDays/);
  assert.match(route, /atsWeights,/, "and it must actually be in the response body");
});
