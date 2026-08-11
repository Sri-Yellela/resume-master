import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildJobFilters } from "../services/jobs/jobQuery.js";

// Regression: diagnosed live in production — 0 of 178 active engineering-role rows had
// skills_json set (enrichJob.js's background enrichment lagging entirely, not a rare edge
// case). skills_include had no null-safety, so any profile with skills in its
// simple_apply_profile (the common case, derived by default via profileFilterBridge.js)
// silently zeroed the ENTIRE board for that user — the reported "0 jobs" symptom.
test("skills_include is soft-null: a row with skills_json IS NULL is never excluded", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, title TEXT, skills_json TEXT);
    INSERT INTO scraped_jobs VALUES ('a', 'Software Engineer', NULL);
    INSERT INTO scraped_jobs VALUES ('b', 'Software Engineer', '["python","react"]');
    INSERT INTO scraped_jobs VALUES ('c', 'Software Engineer', '["java","go"]');
  `);
  const { sql, params } = buildJobFilters({ skills_include: ["python"] });
  const rows = db.prepare(`SELECT job_id FROM scraped_jobs sj WHERE 1=1 ${sql}`).all(...params);
  const ids = rows.map(r => r.job_id).sort();
  assert.deepEqual(ids, ["a", "b"], "row 'a' (null skills_json) and 'b' (matching skill) must both pass; 'c' (non-null, non-matching) must be excluded");
});

test("skills_include still excludes a row with a populated, non-matching skills_json", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, skills_json TEXT);
    INSERT INTO scraped_jobs VALUES ('only-java', '["java"]');
  `);
  const { sql, params } = buildJobFilters({ skills_include: ["python"] });
  const rows = db.prepare(`SELECT job_id FROM scraped_jobs sj WHERE 1=1 ${sql}`).all(...params);
  assert.deepEqual(rows, [], "a row with a real, non-matching skills_json must still be excluded");
});

// Same root cause as skills_include above, and MORE severe: experience_level is also written
// by enrichJob.js's lagging pass, and experience_levels is likewise derived BY DEFAULT via
// profileFilterBridge.js (for any profile with yearsExperience set). Fixing skills_include
// alone left the board at zero for those users. Note this is `NULL IN (...)` rather than a
// LIKE chain — same NULL-propagation, different operator, so it needs its own coverage.
test("experience_levels is soft-null: a row with experience_level IS NULL is never excluded", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, experience_level TEXT);
    INSERT INTO scraped_jobs VALUES ('unenriched', NULL);
    INSERT INTO scraped_jobs VALUES ('mid', 'mid');
    INSERT INTO scraped_jobs VALUES ('executive', 'executive');
  `);
  const { sql, params } = buildJobFilters({ experience_levels: ["mid", "senior"] });
  const rows = db.prepare(`SELECT job_id FROM scraped_jobs sj WHERE 1=1 ${sql}`).all(...params);
  const ids = rows.map(r => r.job_id).sort();
  assert.deepEqual(ids, ["mid", "unenriched"], "the unenriched row must survive; 'executive' (enriched, out of range) must be excluded");
});

// Guards the specific false belief that shipped in profileFilterBridge.js: that widening the
// bucket one level up mitigated the under-enriched case. It never could — NULL matches no
// IN-list, however wide. Without the IS NULL guard this passes zero rows no matter the widening.
test("experience_levels widening does not rescue NULL: guard must be the IS NULL clause", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, experience_level TEXT);
    INSERT INTO scraped_jobs VALUES ('a', NULL);
    INSERT INTO scraped_jobs VALUES ('b', NULL);
  `);
  const { sql, params } = buildJobFilters({ experience_levels: ["entry", "mid", "senior", "lead", "executive"] });
  const rows = db.prepare(`SELECT job_id FROM scraped_jobs sj WHERE 1=1 ${sql}`).all(...params);
  assert.equal(rows.length, 2, "an all-levels IN-list still matches no NULL row without the IS NULL guard");
});

test("work_models is soft-null: an unenriched workplace_type is never excluded", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, workplace_type TEXT);
    INSERT INTO scraped_jobs VALUES ('unenriched', NULL);
    INSERT INTO scraped_jobs VALUES ('remote', 'remote');
    INSERT INTO scraped_jobs VALUES ('onsite', 'onsite');
  `);
  const { sql, params } = buildJobFilters({ work_models: ["remote"] });
  const rows = db.prepare(`SELECT job_id FROM scraped_jobs sj WHERE 1=1 ${sql}`).all(...params);
  const ids = rows.map(r => r.job_id).sort();
  assert.deepEqual(ids, ["remote", "unenriched"], "filtering to remote must not read as 'no remote jobs exist' while enrichment lags");
});

// Diagnosis item 3.5. Production carries 10 adzuna rows with discovered_at NULL — orphans from
// the pre-pivot architecture, since no current write path produces adzuna at all (cacheJobs
// crawls only DIRECT_ATS_SOURCES, cacheJoboFeed only jobo, searchJobs never writes, and
// discovered_at is set by upsertCanonicalJob which they never went through). The recency filter
// hard-excluded NULL, so those rows were invisible to every date filter and the NEW<24h pill,
// permanently and silently.
test("discovered_after falls back to scraped_at when discovered_at is missing", () => {
  const db = new Database(":memory:");
  const now = Math.floor(Date.now() / 1000);
  db.exec(`
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, discovered_at INTEGER, scraped_at INTEGER);
    INSERT INTO scraped_jobs VALUES ('orphan_recent', NULL, ${now - 3600});
    INSERT INTO scraped_jobs VALUES ('orphan_old',    NULL, ${now - 60 * 86400});
    INSERT INTO scraped_jobs VALUES ('normal_recent', ${now - 7200}, ${now - 7200});
  `);
  const { sql, params } = buildJobFilters({ discovered_after: now - 86400 });
  const ids = db.prepare(`SELECT job_id FROM scraped_jobs sj WHERE 1=1 ${sql}`).all(...params)
    .map(r => r.job_id).sort();
  assert.deepEqual(ids, ["normal_recent", "orphan_recent"],
    "a row with no discovered_at should be judged on scraped_at, not dropped");
});

test("discovered_after still excludes genuinely old rows — this is not a soft-null filter", () => {
  // Unlike the enrichment-backed filters, a recency filter must NOT admit rows of unknown age.
  // The COALESCE works because scraped_at is written on every upsert, so there is always a real
  // timestamp to judge against rather than a null to wave through.
  const db = new Database(":memory:");
  const now = Math.floor(Date.now() / 1000);
  db.exec(`
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, discovered_at INTEGER, scraped_at INTEGER);
    INSERT INTO scraped_jobs VALUES ('no_dates_at_all', NULL, NULL);
    INSERT INTO scraped_jobs VALUES ('old', NULL, ${now - 60 * 86400});
  `);
  const { sql, params } = buildJobFilters({ discovered_after: now - 86400 });
  const rows = db.prepare(`SELECT job_id FROM scraped_jobs sj WHERE 1=1 ${sql}`).all(...params);
  assert.deepEqual(rows, [], "unknown-age and genuinely-old rows must both stay excluded");
});
