import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { isTitleRelevantToProfile } from "../services/searchQueryBuilder.js";

function setupDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT
    );
    CREATE TABLE domain_profiles (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      profile_name TEXT NOT NULL,
      role_family TEXT NOT NULL,
      domain TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      search_query TEXT NOT NULL,
      domain_profile_id INTEGER,
      scraped_at INTEGER NOT NULL,
      posted_at TEXT
    );
    CREATE TABLE job_role_map (
      job_id TEXT NOT NULL,
      role_key TEXT NOT NULL,
      role_family TEXT,
      domain TEXT,
      PRIMARY KEY (job_id, role_key)
    );
    CREATE TABLE user_jobs (
      user_id INTEGER NOT NULL,
      job_id TEXT NOT NULL,
      domain_profile_id INTEGER,
      visited INTEGER DEFAULT 0,
      applied INTEGER DEFAULT 0,
      starred INTEGER DEFAULT 0,
      disliked INTEGER DEFAULT 0,
      resume_generated INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, job_id)
    );
  `);
  return db;
}

function activeProfileRows(db, userId, activeProfileId) {
  const profile = db.prepare("SELECT * FROM domain_profiles WHERE id = ?").get(activeProfileId);
  const roleKey = (profile.role_family || profile.domain).toLowerCase();
  return db.prepare(`
    SELECT sj.job_id, sj.title, uj.starred, uj.disliked
    FROM scraped_jobs sj
    JOIN job_role_map jrm ON jrm.job_id = sj.job_id AND jrm.role_key = ?
    LEFT JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ?
    WHERE 1 = 1
      AND (
        LOWER(sj.title) LIKE '%engineer%'
        OR LOWER(sj.title) LIKE '%developer%'
        OR LOWER(sj.title) LIKE '%software%'
        OR LOWER(sj.title) LIKE '%backend%'
        OR LOWER(sj.title) LIKE '%frontend%'
        OR LOWER(sj.title) LIKE '%platform%'
      )
      AND (uj.applied IS NULL OR uj.applied = 0)
      AND (uj.disliked IS NULL OR uj.disliked = 0)
    ORDER BY sj.job_id
  `).all(roleKey, userId);
}

function engineeringTitleRows(db, userId) {
  return db.prepare(`
    SELECT sj.job_id
    FROM scraped_jobs sj
    JOIN job_role_map jrm ON jrm.job_id = sj.job_id AND jrm.role_key = 'engineering'
    LEFT JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ?
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
    ORDER BY sj.job_id
  `).all(userId);
}

test("active profile query uses shared role map instead of user-owned scraped tags", () => {
  const db = setupDb();
  db.exec(`
    INSERT INTO users VALUES (1, 'a');
    INSERT INTO domain_profiles VALUES (10, 1, 'Software Engineering', 'engineering', 'engineering', 1);
    INSERT INTO domain_profiles VALUES (11, 1, 'Project Manager', 'pm', 'pm_general', 0);
    INSERT INTO scraped_jobs VALUES
      ('swe-ok', 'Software Engineer', 'Acme', 'software engineer', 10, 1000, NULL),
      ('pm-contaminated', 'Project Manager', 'Acme', 'project manager', 11, 1000, NULL),
      ('null-contaminated', 'Data Analyst', 'Acme', 'data analyst', NULL, 1000, NULL);
    INSERT INTO job_role_map VALUES
      ('swe-ok', 'engineering', 'engineering', 'engineering'),
      ('pm-contaminated', 'pm', 'pm', 'pm_general'),
      ('null-contaminated', 'data', 'data', 'data');
    INSERT INTO user_jobs (user_id, job_id, domain_profile_id) VALUES
      (1, 'swe-ok', 10),
      (1, 'pm-contaminated', 10),
      (1, 'null-contaminated', 10);
  `);

  const rows = activeProfileRows(db, 1, 10);
  assert.deepEqual(rows.map(r => r.job_id), ["swe-ok"]);
});

test("job state remains isolated by user", () => {
  const db = setupDb();
  db.exec(`
    INSERT INTO users VALUES (1, 'a'), (2, 'b');
    INSERT INTO domain_profiles VALUES
      (10, 1, 'Software Engineering', 'engineering', 'engineering', 1),
      (20, 2, 'Software Engineering', 'engineering', 'engineering', 1);
    INSERT INTO scraped_jobs VALUES
      ('shared-title-a', 'Software Engineer', 'Acme', 'software engineer', 10, 1000, NULL),
      ('shared-title-b', 'Software Engineer', 'Acme', 'software engineer', 20, 1000, NULL);
    INSERT INTO job_role_map VALUES
      ('shared-title-a', 'engineering', 'engineering', 'engineering'),
      ('shared-title-b', 'engineering', 'engineering', 'engineering');
    INSERT INTO user_jobs (user_id, job_id, domain_profile_id, starred, disliked) VALUES
      (1, 'shared-title-a', 10, 1, 0),
      (2, 'shared-title-b', 20, 0, 1);
  `);

  const userOne = activeProfileRows(db, 1, 10);
  const userTwo = activeProfileRows(db, 2, 20);

  assert.deepEqual(userOne.map(r => r.job_id), ["shared-title-a", "shared-title-b"]);
  assert.equal(userOne.find(r => r.job_id === "shared-title-a").starred, 1);
  assert.equal(userOne.find(r => r.job_id === "shared-title-b").starred, null);
  assert.deepEqual(userTwo.map(r => r.job_id), ["shared-title-a"]);
});

test("shared jobs are visible without precreating user_jobs state rows", () => {
  const db = setupDb();
  db.exec(`
    INSERT INTO users VALUES (1, 'a'), (2, 'b');
    INSERT INTO domain_profiles VALUES
      (10, 1, 'Software Engineering', 'engineering', 'engineering', 1),
      (20, 2, 'Software Engineering', 'engineering', 'engineering', 1);
    INSERT INTO scraped_jobs VALUES
      ('shared-job', 'Software Engineer', 'Acme', 'software engineer', NULL, 1000, NULL);
    INSERT INTO job_role_map VALUES
      ('shared-job', 'engineering', 'engineering', 'engineering');
    INSERT INTO user_jobs (user_id, job_id, domain_profile_id, visited) VALUES
      (1, 'shared-job', 10, 1);
  `);

  const userOne = activeProfileRows(db, 1, 10);
  const userTwo = activeProfileRows(db, 2, 20);

  assert.deepEqual(userOne.map(r => [r.job_id, r.starred ?? 0]), [["shared-job", 0]]);
  assert.deepEqual(userTwo.map(r => r.job_id), ["shared-job"]);
  assert.equal(userTwo[0].starred, null);
});

test("profile title relevance rejects obvious cross-domain titles", () => {
  assert.equal(
    isTitleRelevantToProfile("Senior Software Engineer", ["Software Engineer", "Backend Engineer"]),
    true
  );
  assert.equal(
    isTitleRelevantToProfile("Clinical Nurse Educator", ["Software Engineer", "Backend Engineer"]),
    false
  );
  assert.equal(
    isTitleRelevantToProfile("Data Scientist", ["Data Scientist", "Data Analyst"]),
    true
  );
});

test("engineering pool excludes stale PM jobs even if legacy role map is wrong", () => {
  const db = setupDb();
  db.exec(`
    INSERT INTO users VALUES (1, 'a');
    INSERT INTO scraped_jobs VALUES
      ('swe-ok', 'Backend Software Engineer', 'Acme', 'software engineer', 10, 1000, NULL),
      ('pm-stale', 'Project Manager', 'Acme', 'project manager', 11, 1000, NULL);
    INSERT INTO job_role_map VALUES
      ('swe-ok', 'engineering', 'engineering', 'engineering'),
      ('pm-stale', 'engineering', 'engineering', 'engineering');
  `);

  assert.deepEqual(engineeringTitleRows(db, 1).map(r => r.job_id), ["swe-ok"]);
});
