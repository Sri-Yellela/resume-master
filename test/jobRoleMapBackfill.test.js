// THE BACKFILL AND THE INGEST PATH MUST AGREE, OR THE BOARD HAS TWO CLASSIFIERS.
//
// 277 active postings carried NO job_role_map row. Not a classifier failure — every row that goes
// through services/jobs/aggregator.js gets a bucket, the verdict's or the 'general' fallback. They
// came from scripts/am3RestoreBoard.mjs, which restores `scraped_jobs` and not `job_role_map`
// (docs/am1-recovery.md records that table losing 1,286 rows to the ON DELETE CASCADE).
//
// CC1b made those rows VISIBLE rather than hidden, which is why this was a follow-up and not an
// outage: the board's role join became a LEFT JOIN with a soft-null predicate. But visible-to-
// everyone is not correct — an unmapped posting appears on EVERY profile's board, and 26 of these
// were sales and 33 were PM, sitting on an engineering board because nobody had said what they
// were.
//
// ⛔ THE RISK THIS FILE EXISTS FOR IS DIVERGENCE, NOT CORRECTNESS OF ANY ONE VERDICT. A backfill
// that classifies by a different rule than ingest is a second classifier: the same posting gets
// one bucket from the backfill and a different one from the next re-crawl, and the board flickers
// between them. So the tests pin the RULE against aggregator.js's, not a list of expected buckets.
//
// ⛔ AND CC1B'S OWN NOTE NAMED THE WRONG FUNCTION. It said "a backfill at classifyForIngest's own
// 0.75 confidence gate". `classifyForIngest` returns null below the threshold and nothing else —
// it does NOT carry the strong-white-anchor → 'general' policy that the ingest path actually
// applies through `classifyJob`. Following the note literally would have left 70 rows unclassified
// and disagreed with every future crawl. Pinned below so the note cannot be re-followed.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../scripts/migrations.js";
import { at } from "../test-support/sourceAnchors.js";
import {
  backfillRoleMap, backfillDecision, UNMAPPED_SQL, MATCHED_BY, MATCHED_BY_UNCLASSIFIED,
} from "../services/jobs/backfillRoleMap.js";
import { ROLE_KEY_FALLBACK } from "../services/jobs/classifyJob.js";

const SCRIPT = fs.readFileSync("scripts/backfillJobRoleMap.mjs", "utf8");
const SERVICE = fs.readFileSync("services/jobs/backfillRoleMap.js", "utf8");
const SERVER = fs.readFileSync("server.js", "utf8");
const AGGREGATOR = fs.readFileSync("services/jobs/aggregator.js", "utf8");

/**
 * Lines that actually execute, with comments dropped.
 *
 * ⛔ THE FIRST VERSION OF THE TWO ASSERTIONS BELOW FAILED ON THE SCRIPT'S OWN PROSE. The comment
 * explaining why `classifyForIngest` is the wrong function has to name it, and the note about
 * reclassifyJobs.js deleting board rows has to say DELETE. A scan that cannot tell the explanation
 * from the code is satisfied by removing the explanation, which is the worst possible fix.
 */
const codeLines = (src) => src.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));

/**
 * The SQL this script actually hands to SQLite — the text inside every `db.prepare(...)`.
 *
 * A line-level ban would also catch the console.log that prints the one-line undo, which is
 * printed ADVICE and not a statement this script runs. Asserting on prepared statements says the
 * thing actually meant: the only write it can perform is the insert.
 */
function preparedSql(src) {
  const out = [];
  for (const m of src.matchAll(/db\.prepare\(\s*(`)([\s\S]*?)`/g)) out.push(m[2]);
  for (const m of src.matchAll(/db\.prepare\(\s*"([^"]*)"/g)) out.push(m[1]);
  return out;
}

// A blue-collar title, a confidently-bucketed one, and one that is unmistakably white-collar but
// places in no family. Chosen to exercise all three branches of classifyJob rather than to assert
// any particular family.
const CONFIDENT = { title: "Senior Backend Software Engineer", company: "Acme", description: "Build APIs in Python on Kubernetes." };
const BLUE      = { title: "Forklift Operator", company: "Acme", description: "Operate a forklift in our warehouse. Lifting 50lbs required." };

test("a confident verdict is written as its own bucket", () => {
  const d = backfillDecision(CONFIDENT);
  assert.equal(d.action, "bucket");
  assert.equal(d.roleKey, "engineering");
  assert.ok(d.verdict.confidence >= 0.75, "and it cleared the ingest threshold");
});

test("⛔ a blue-collar posting gets NO row, rather than being filed under 'general'", () => {
  // At ingest a blue-collar posting is rejected before the map write is reached, so filing one
  // under 'general' would be a claim the ingest classifier never makes. The remedy for one sitting
  // on the board is ejection — a destructive decision with its own script, which must not be
  // smuggled into a backfill. Zero of the 277 were blue, so this branch is untested by the data
  // and is exactly the kind that rots without a test.
  const d = backfillDecision(BLUE);
  assert.equal(d.verdict.collar, "blue");
  assert.equal(d.action, "skip");
  assert.equal(d.roleKey, null);
});

test("white-collar with no confident family falls back to 'general', as ingest does", () => {
  // Constructed rather than borrowed from the board: the branch is what matters, and a real title
  // would re-classify the day SIGNALS changes.
  const d = backfillDecision({
    title: "Strategic Sourcing Manager", company: "Acme",
    description: "Own supplier relationships and negotiate contracts across the organisation.",
  });
  assert.ok(["bucket", "fallback"].includes(d.action), "a white-collar row must always get a bucket");
  if (d.action === "fallback") assert.equal(d.roleKey, ROLE_KEY_FALLBACK);
});

test("⛔ the backfill applies INGEST's rule, not classifyForIngest's", () => {
  // The two differ exactly on the strong-white-anchor case, which is 70 of the 277 rows.
  assert.match(SERVICE, /import \{ classifyJob, ROLE_KEY_FALLBACK \} from "\.\/classifyJob\.js"/,
    "it must classify with the same function the ingest path calls");
  assert.deepEqual(
    codeLines(SCRIPT).filter(l => /\bclassifyForIngest\b/.test(l)), [],
    "classifyForIngest drops the 'general' policy and would disagree with every future crawl — "
    + "the comment explaining that is allowed to name it; a call is not");

  // And the shape of the rule is the aggregator's. Pinned against the aggregator's own source so
  // that changing ingest's branching without changing the backfill fails here.
  const write = AGGREGATOR.slice(
    at(AGGREGATOR, "if (verdict.roleKey != null) {"),
    at(AGGREGATOR, "// Picks which (if any) of the rows sharing a fingerprint"),
  );
  assert.match(write, /if \(verdict\.roleKey != null\) \{/, "ingest: a verdict writes its own bucket");
  assert.match(write, /role_key:\s*ROLE_KEY_FALLBACK/, "ingest: otherwise the general fallback");
  const decide = SERVICE.slice(
    at(SERVICE, "export function backfillDecision(row)"),
    at(SERVICE, "@param {import('better-sqlite3').Database} db"),
  );
  assert.match(decide, /verdict\.roleKey != null/);
  assert.match(decide, /ROLE_KEY_FALLBACK/);
});

test("⛔ it never touches scraped_jobs, and never deletes anything", () => {
  // scripts/reclassifyJobs.js — the existing, similarly-named script — DELETEs board rows: it
  // ejects blue-collar postings and drops no-signal ones. On a board restored from a backup that
  // is a second purge, not a backfill. The distinction is the whole safety property here.
  const statements = preparedSql(SERVICE).concat(preparedSql(SCRIPT));
  assert.ok(statements.length > 0, "the extractor must actually find the statements");
  const writes = statements.filter(s => /\b(DELETE|UPDATE|REPLACE|DROP|ALTER)\b/i.test(s));
  assert.deepEqual(writes, [],
    "the only write this script may perform is a plain INSERT into job_role_map");
  assert.ok(statements.some(s => /INSERT INTO job_role_map/.test(s)));
  assert.deepEqual(statements.filter(s => /INSERT INTO scraped_jobs|UPDATE scraped_jobs/i.test(s)), [],
    "scraped_jobs is read-only to this script");
});

test("the candidate set is exactly 'active, and carries no bucket of any kind'", () => {
  const db = new Database(":memory:");
  try {
    for (const m of MIGRATIONS) db.exec(m.sql);
    const job = db.prepare("INSERT INTO scraped_jobs (job_id,title,company,search_query,_hash,is_active) VALUES (?,?,?,'q',?,?)");
    job.run("unmapped",  "Software Engineer", "Acme", "h1", 1);
    job.run("mapped",    "Software Engineer", "Acme", "h2", 1);
    job.run("inactive",  "Software Engineer", "Acme", "h3", 0);
    job.run("other_role","Software Engineer", "Acme", "h4", 1);
    db.prepare("INSERT INTO job_role_map (job_id, role_key, matched_by) VALUES ('mapped','engineering','ats_cache')").run();
    // A row bucketed as something ELSE is still mapped: the backfill must not add a second opinion.
    db.prepare("INSERT INTO job_role_map (job_id, role_key, matched_by) VALUES ('other_role','sales','ats_cache')").run();

    const ids = db.prepare(UNMAPPED_SQL).all().map(r => r.job_id);
    assert.deepEqual(ids, ["unmapped"],
      "mapped rows, differently-mapped rows and inactive rows are all out of scope");
  } finally { db.close(); }
});

test("a backfilled row is a CLASSIFIER row, so a later crawl can retire it", () => {
  // aggregator.js's retireOtherClassifierBuckets deletes competing buckets with
  // `source_profile_id IS NULL`, and its comment says that column — not the matched_by string — is
  // what separates a classifier row from a profile-derived one, precisely so a new matched_by
  // value cannot quietly opt out. A backfilled row must be retireable like any other.
  assert.match(SERVICE, /VALUES \(\?, \?, \?, \?, NULL, \?, \?\)/,
    "source_profile_id must be written NULL, not left to a default");
  assert.match(AGGREGATOR, /WHERE job_id = \? AND role_key != \? AND source_profile_id IS NULL/);
});

test("the provenance is attributable and the run is reversible", () => {
  // 277 rows appearing in a scoping table with no way to tell them from the crawler's is how a
  // backfill becomes permanent by accident.
  assert.equal(MATCHED_BY, "backfill_classifier");
  assert.equal(MATCHED_BY_UNCLASSIFIED, "backfill_classifier_unclassified");
  assert.match(SCRIPT, /DELETE FROM job_role_map WHERE matched_by LIKE/,
    "the script must print how to undo itself");
  assert.match(SERVER, /DELETE FROM job_role_map WHERE matched_by LIKE/,
    "and so must the boot hook, where nobody is watching a terminal");
});

test("dry run is the default; writing takes --apply", () => {
  assert.match(SCRIPT, /const APPLY\s*=\s*process\.argv\.includes\("--apply"\)/);
  assert.match(SCRIPT, /new Database\(DB_PATH, \{ readonly: !APPLY \}\)/,
    "a dry run must open the database READ-ONLY, so a coding error cannot write during one");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE SERVICE, BEHAVIOURALLY — and the boot hook, which is the only path that reaches production
// ════════════════════════════════════════════════════════════════════════════════════════════

/** A board with one confidently-bucketed posting, one blue-collar, and one already mapped. */
function seedBoard() {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m.sql);
  const job = db.prepare(`INSERT INTO scraped_jobs (job_id,title,company,description,search_query,_hash,is_active)
                          VALUES (?,?,?,?,'q',?,?)`);
  job.run("eng",     CONFIDENT.title, CONFIDENT.company, CONFIDENT.description, "h1", 1);
  job.run("blue",    BLUE.title,      BLUE.company,      BLUE.description,      "h2", 1);
  job.run("already", CONFIDENT.title, CONFIDENT.company, CONFIDENT.description, "h3", 1);
  job.run("gone",    CONFIDENT.title, CONFIDENT.company, CONFIDENT.description, "h4", 0);
  db.prepare("INSERT INTO job_role_map (job_id, role_key, matched_by) VALUES ('already','sales','ats_cache')").run();
  return db;
}

test("the backfill inserts a bucket, leaves blue alone, and touches nothing already mapped", () => {
  const db = seedBoard();
  try {
    const r = backfillRoleMap(db);
    assert.equal(r.scanned, 2, "only the two unmapped ACTIVE rows are candidates");
    assert.equal(r.inserted, 1);
    assert.equal(r.skippedBlue, 1);
    assert.deepEqual(r.byBucket, { engineering: 1 });

    const rows = db.prepare("SELECT job_id, role_key, matched_by, source_profile_id FROM job_role_map ORDER BY job_id").all();
    assert.deepEqual(rows, [
      { job_id: "already", role_key: "sales",       matched_by: "ats_cache",  source_profile_id: null },
      { job_id: "eng",     role_key: "engineering", matched_by: MATCHED_BY,   source_profile_id: null },
    ], "the pre-existing 'sales' bucket is untouched, and the new row is a classifier row");
    // The blue-collar posting and the inactive one got nothing.
    assert.equal(db.prepare("SELECT COUNT(*) n FROM job_role_map WHERE job_id IN ('blue','gone')").get().n, 0);
  } finally { db.close(); }
});

test("running it twice inserts nothing the second time", () => {
  const db = seedBoard();
  try {
    assert.equal(backfillRoleMap(db).inserted, 1);
    const second = backfillRoleMap(db);
    assert.equal(second.inserted, 0);
    assert.equal(second.scanned, 1, "only the blue-collar row is still a candidate, forever");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM job_role_map").get().n, 2, "no duplicate row");
  } finally { db.close(); }
});

test("a dry run writes nothing but still reports what it would do", () => {
  const db = seedBoard();
  try {
    const r = backfillRoleMap(db, { dryRun: true });
    assert.equal(r.candidates, 1, "it says what it WOULD insert");
    assert.equal(r.inserted, 0, "and reports honestly that it inserted nothing");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM job_role_map").get().n, 1, "only the seeded row");
  } finally { db.close(); }
});

test("⛔ the boot hook runs it, logs it, and can be switched off", () => {
  // The boot hook is the ONLY path that reaches production — a script runs against whatever
  // database the operator can reach, which is a laptop's. Without this, the fix is permanently
  // local, which is how these rows got into this state to begin with.
  const hook = SERVER.slice(
    at(SERVER, "// ── job_role_map backfill (CC1b's follow-up)"),
    at(SERVER, "// Repair company_icon_url rows still pointing at a retired logo provider"),
  );
  assert.match(hook, /backfillRoleMap\(db\)/, "it must actually run");
  assert.match(hook, /roleFill\.inserted > 0/, "and log only when it did something");
  assert.match(hook, /byBucket/, "the log must carry the bucket breakdown, not just a count");
  assert.match(hook, /roleFill\.skippedBlue > 0/, "a blue-collar row left on every board is a warning");
  assert.match(hook, /ROLE_MAP_BACKFILL/, "an operator needs a way to stop it without a revert");
  assert.match(hook, /catch \(e\)/, "never fatal — an unbucketed board still works");
  // ⛔ It must not be able to take the boot down. The board is degraded without it, not broken:
  // CC1b's soft-null keeps unbucketed rows visible.
  assert.doesNotMatch(hook, /process\.exit/);
});
