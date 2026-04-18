import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

function atsSortRows(db, userId, roleKey) {
  return db.prepare(`
    SELECT sj.job_id, sj.ats_score as base_ats_score, r.ats_score as resume_ats_score
    FROM scraped_jobs sj
    JOIN job_role_map jrm ON jrm.job_id = sj.job_id AND jrm.role_key = ?
    LEFT JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ?
    LEFT JOIN resumes r ON r.user_id = ? AND r.job_id = sj.job_id
    WHERE (
        LOWER(sj.title) LIKE '%engineer%'
        OR LOWER(sj.title) LIKE '%developer%'
        OR LOWER(sj.title) LIKE '%software%'
        OR LOWER(sj.title) LIKE '%backend%'
        OR LOWER(sj.title) LIKE '%frontend%'
        OR LOWER(sj.title) LIKE '%platform%'
      )
      AND (uj.applied IS NULL OR uj.applied = 0)
      AND (uj.disliked IS NULL OR uj.disliked = 0)
    ORDER BY CASE WHEN sj.ats_score IS NULL THEN 1 ELSE 0 END ASC, sj.ats_score DESC
  `).all(roleKey, userId, userId);
}

test("ATS Sort uses stored ATS score and preserves profile/state filtering", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY,
      title TEXT,
      ats_score INTEGER
    );
    CREATE TABLE job_role_map (
      job_id TEXT NOT NULL,
      role_key TEXT NOT NULL
    );
    CREATE TABLE user_jobs (
      user_id INTEGER NOT NULL,
      job_id TEXT NOT NULL,
      applied INTEGER DEFAULT 0,
      disliked INTEGER DEFAULT 0
    );
    CREATE TABLE resumes (
      user_id INTEGER NOT NULL,
      job_id TEXT NOT NULL,
      ats_score INTEGER
    );
  `);
  db.exec(`
    INSERT INTO scraped_jobs VALUES
      ('job-a', 'Software Engineer', 82),
      ('job-b', 'Backend Engineer', 94),
      ('job-c', 'Project Manager', 99),
      ('job-d', 'Frontend Engineer', 88),
      ('job-e', 'Unclassified Software Engineer', NULL),
      ('job-f', 'Project Manager', 97),
      ('job-g', 'Software Developer', NULL);
    INSERT INTO job_role_map VALUES
      ('job-a', 'engineering'),
      ('job-b', 'engineering'),
      ('job-c', 'pm'),
      ('job-d', 'engineering'),
      ('job-f', 'engineering'),
      ('job-g', 'engineering');
    INSERT INTO resumes VALUES (1, 'job-a', 99);
    INSERT INTO user_jobs VALUES (1, 'job-d', 0, 1);
  `);

  const rows = atsSortRows(db, 1, "engineering");
  assert.deepEqual(rows.map(r => r.job_id), ["job-b", "job-a", "job-g"]);
  assert.equal(rows[0].base_ats_score, 94);
  assert.equal(rows[1].resume_ats_score, 99);
  assert.equal(rows[2].base_ats_score, null);
});
