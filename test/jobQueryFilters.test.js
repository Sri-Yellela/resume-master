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
