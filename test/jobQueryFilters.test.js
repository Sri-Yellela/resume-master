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
