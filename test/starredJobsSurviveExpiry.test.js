// A job the user saved must still be there tomorrow.
//
// runExpiredJobsCleanup deletes any scraped_jobs row whose scraped_at is older than 7 days, and it
// exempted `applied = 1` and nothing else. So:
//
//   - a posting the user starred was HARD DELETED seven days later, not deactivated — no row, no
//     is_active flag to inspect, no evidence it had ever existed;
//   - the cascade then deleted its user_jobs row too (`AND applied != 1`), so the star went with it;
//   - and every import is starred for its importer by importJob.js's attachImportToUser, which makes
//     this the default fate of every imported job nobody applied to.
//
// Observed on the local board in cleanup_log id 34: 35 jobs and 35 user_jobs rows removed in a single
// pass, which is how a board went from full to empty between sessions.
//
// Starred rows are now RETIRED (is_active = 0) and kept. Two halves, and the first is worthless
// without the second: the board's `is_active = 1` predicate would have left the preserved row
// invisible to its owner, which is the same disappearance with extra steps. So the Saved tab admits
// inactive rows, and the card labels them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { mapJobRow } from "../services/jobs/mapJobRow.js";

const server   = fs.readFileSync("server.js", "utf8");
const jobCard  = fs.readFileSync("client/src/components/JobCard.jsx", "utf8");

const NOW    = 1_787_000_000;
const CUTOFF = NOW - 7 * 24 * 60 * 60;

function db0() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT,
      scraped_at INTEGER, discovered_at INTEGER, posted_at TEXT, is_active INTEGER DEFAULT 1
    );
    CREATE TABLE job_role_map (job_id TEXT, role_key TEXT, PRIMARY KEY (job_id, role_key));
    CREATE TABLE user_jobs (user_id INTEGER, job_id TEXT, domain_profile_id INTEGER,
                            starred INTEGER DEFAULT 0, applied INTEGER DEFAULT 0,
                            disliked INTEGER DEFAULT 0, visited INTEGER DEFAULT 0);
    CREATE TABLE user_job_views (job_id TEXT);
    CREATE TABLE resumes (job_id TEXT);
    CREATE TABLE resume_versions (job_id TEXT);
  `);
  const add = (jobId, ageDays, { starred = 0, applied = 0 } = {}) => {
    const at = NOW - ageDays * 86400;
    db.prepare("INSERT INTO scraped_jobs (job_id,title,company,scraped_at,discovered_at,is_active) VALUES (?,?,?,?,?,1)")
      .run(jobId, "Engineer", "Acme", at, at);
    db.prepare("INSERT INTO job_role_map (job_id,role_key) VALUES (?, 'engineering')").run(jobId);
    if (starred || applied) {
      db.prepare("INSERT INTO user_jobs (user_id,job_id,domain_profile_id,starred,applied) VALUES (14,?,5,?,?)")
        .run(jobId, starred, applied);
      db.prepare("INSERT INTO resumes (job_id) VALUES (?)").run(jobId);
    }
  };
  add("fresh",          1);                        // recent, nobody's
  add("stale",         30);                        // expired, nobody's -> must be deleted
  add("stale-starred", 30, { starred: 1 });        // expired, SAVED    -> must be retired, kept
  add("stale-applied", 30, { applied: 1 });        // expired, applied  -> untouched, stays active
  add("fresh-starred",  1, { starred: 1 });        // recent, saved     -> untouched
  return db;
}

/** The two statements from runExpiredJobsCleanup, plus the cascade that used to eat the star. */
function runCleanup(db) {
  const retired = db.prepare(`
    UPDATE scraped_jobs SET is_active = 0
    WHERE scraped_at < ? AND is_active = 1
      AND job_id IN     (SELECT DISTINCT job_id FROM user_jobs WHERE starred = 1)
      AND job_id NOT IN (SELECT DISTINCT job_id FROM user_jobs WHERE applied = 1)
  `).run(CUTOFF);
  const deleted = db.prepare(`
    DELETE FROM scraped_jobs
    WHERE scraped_at < ?
    AND job_id NOT IN (SELECT DISTINCT job_id FROM user_jobs WHERE applied = 1)
    AND job_id NOT IN (SELECT DISTINCT job_id FROM user_jobs WHERE starred = 1)
  `).run(CUTOFF);
  // Existence-keyed cascades, verbatim in shape.
  db.prepare("DELETE FROM job_role_map WHERE job_id NOT IN (SELECT job_id FROM scraped_jobs)").run();
  db.prepare("DELETE FROM user_job_views WHERE job_id NOT IN (SELECT job_id FROM scraped_jobs)").run();
  db.prepare("DELETE FROM user_jobs WHERE job_id NOT IN (SELECT job_id FROM scraped_jobs) AND applied != 1").run();
  db.prepare("DELETE FROM resumes WHERE job_id NOT IN (SELECT job_id FROM scraped_jobs) AND job_id NOT IN (SELECT DISTINCT job_id FROM user_jobs WHERE applied = 1)").run();
  return { retired: retired.changes, deleted: deleted.changes };
}

const ids = (db, sql, ...a) => db.prepare(sql).all(...a).map(r => r.job_id).sort();

test("an expired starred job is retired, not deleted — and its star survives", () => {
  const db = db0();
  const { retired, deleted } = runCleanup(db);

  assert.equal(retired, 1, "exactly the expired starred row is retired");
  assert.equal(deleted, 1, "and only the expired un-starred row is deleted");

  assert.deepEqual(ids(db, "SELECT job_id FROM scraped_jobs"),
    ["fresh", "fresh-starred", "stale-applied", "stale-starred"],
    "the saved job must still exist; only the row nobody asked for is gone");

  assert.equal(db.prepare("SELECT is_active FROM scraped_jobs WHERE job_id='stale-starred'").get().is_active, 0,
    "it has expired as a LISTING — that part is true and must be recorded");

  // The half that actually bit: the cascade is keyed on the row being gone, so a retired row keeps
  // everything hanging off it. This is the reason to retire rather than delete.
  assert.deepEqual(ids(db, "SELECT job_id FROM user_jobs WHERE starred = 1"),
    ["fresh-starred", "stale-starred"], "the user's star must not be cascaded away");
  assert.deepEqual(ids(db, "SELECT job_id FROM job_role_map WHERE job_id='stale-starred'"),
    ["stale-starred"], "its role bucket survives, so it stays reachable");
  assert.deepEqual(ids(db, "SELECT job_id FROM resumes WHERE job_id='stale-starred'"),
    ["stale-starred"], "and any resume generated for it is not orphaned");
});

test("applied jobs are still fully exempt — active and present, exactly as before", () => {
  const db = db0();
  runCleanup(db);
  const row = db.prepare("SELECT is_active FROM scraped_jobs WHERE job_id='stale-applied'").get();
  assert.ok(row, "an applied job is never removed");
  assert.equal(row.is_active, 1, "and is never retired either — this behaviour must not change");
});

test("the un-starred majority is still hard-deleted, so the table cannot grow without bound", () => {
  const db = db0();
  runCleanup(db);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM scraped_jobs WHERE job_id='stale'").get().c, 0,
    "retiring EVERYTHING would keep rows nobody asked for; the reason to keep one is that someone did");
});

test("the pass is idempotent — a second run neither re-retires nor deletes the kept row", () => {
  const db = db0();
  runCleanup(db);
  const second = runCleanup(db);
  assert.equal(second.retired, 0, "is_active = 1 in the WHERE stops it being re-counted every night");
  assert.equal(second.deleted, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM scraped_jobs WHERE job_id='stale-starred'").get().c, 1);
});

// ── the row has to be reachable, or retiring it changed nothing ──────────────

test("the Saved tab returns retired rows; every other board still filters them out", () => {
  const db = db0();
  runCleanup(db);

  // The board's two WHERE shapes, as server.js builds them off `savedTab`.
  const discovery = `
    FROM scraped_jobs sj
    JOIN job_role_map jrm ON jrm.job_id = sj.job_id AND jrm.role_key = ?
    LEFT JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ? AND uj.domain_profile_id = ?
    WHERE sj.is_active = 1 AND (uj.disliked IS NULL OR uj.disliked = 0)`;
  const saved = `
    FROM scraped_jobs sj
    LEFT JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ? AND uj.domain_profile_id = ?
    WHERE 1 = 1 AND uj.starred = 1 AND (uj.disliked IS NULL OR uj.disliked = 0)`;

  const onDiscovery = ids(db, `SELECT sj.job_id ${discovery}`, "engineering", 14, 5);
  assert.ok(!onDiscovery.includes("stale-starred"),
    "a closed listing must not be offered to anyone as something to apply for");

  const onSaved = ids(db, `SELECT sj.job_id ${saved}`, 14, 5);
  assert.deepEqual(onSaved, ["fresh-starred", "stale-starred"],
    "but its owner keeps it — without this, retiring the row preserved it and still hid it");
});

test("mapJobRow reports isActive so the card can say the listing has closed", () => {
  assert.equal(mapJobRow({ job_id: "a", is_active: 0 }).isActive, false);
  assert.equal(mapJobRow({ job_id: "a", is_active: 1 }).isActive, true);
  // A live-search result has no is_active column at all. Absent must not read as closed — it was
  // just fetched from the source, so it is as live as anything gets.
  assert.equal(mapJobRow({ job_id: "a" }).isActive, true);
});

// ── the source ───────────────────────────────────────────────────────────────

test("the cleanup retires starred rows and exempts them from the DELETE", () => {
  const fn = server.slice(server.indexOf("function runExpiredJobsCleanup()"),
                          server.indexOf("cron.schedule(\"0 3 * * *\""));
  assert.match(fn, /UPDATE scraped_jobs SET is_active = 0/, "starred rows are retired, not removed");
  // Both exemptions must be on the DELETE, or the UPDATE is immediately undone by it.
  const del = fn.slice(fn.indexOf("DELETE FROM scraped_jobs"));
  assert.match(del, /user_jobs WHERE applied = 1/, "applied stays exempt");
  assert.match(del, /user_jobs WHERE starred = 1/, "starred is now exempt too");
  assert.match(fn, /starredRetired/, "the log must count retirements separately from deletions");
});

test("the Saved tab's relaxed is_active is scoped to the Saved tab alone", () => {
  assert.match(server, /WHERE \$\{savedTab \? '1 = 1' : 'sj\.is_active = 1'\}/,
    "every non-Saved board must keep the discovery predicate");
});

test("the card labels a closed listing instead of showing it as ordinary", () => {
  assert.match(jobCard, /NO LONGER LISTED/);
  assert.match(jobCard, /job\.isActive === false && <ClosedPill\/>/,
    "must be an explicit === false so an absent isActive never reads as closed");
});

test("a closed listing is never also labelled NEW", () => {
  // Seen on a real card during verification: "NO LONGER LISTED" and "NEW" together, because the two
  // pills read different columns (is_active vs discoveredAt) and nothing tied them. A contradiction
  // the user has to resolve is worse than either label alone.
  assert.match(jobCard, /job\.isActive !== false && isNewJob\(job\.discoveredAt\) && <NewPill\/>/,
    "the NEW pill must be gated on the listing still being live");
});
