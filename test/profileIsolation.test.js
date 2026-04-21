import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import { isTitleRelevantToProfile } from "../services/searchQueryBuilder.js";

const jobClassifier = fs.readFileSync("services/jobClassifier.js", "utf8");

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

test("engineering title filter excludes ML/AI, PM, and data-specialty contamination", () => {
  assert.match(jobClassifier, /NOT LIKE '%machine learning%'/);
  assert.match(jobClassifier, /NOT LIKE '%ai engineer%'/);
  assert.match(jobClassifier, /NOT LIKE '%project manager%'/);
  assert.match(jobClassifier, /NOT LIKE '%product manager%'/);
  // data specialty titles must also be excluded from SWE pool
  assert.match(jobClassifier, /NOT LIKE '%data scientist%'/);
  assert.match(jobClassifier, /NOT LIKE '%data engineer%'/);
  assert.match(jobClassifier, /NOT LIKE '%analytics engineer%'/);
});

test("engineering title filter excludes firmware and embedded role contamination", () => {
  assert.match(jobClassifier, /NOT LIKE '%firmware%'/);
  assert.match(jobClassifier, /NOT LIKE '%embedded%'/);
  assert.match(jobClassifier, /NOT LIKE '%device driver%'/);
  assert.match(jobClassifier, /NOT LIKE '%bsp%'/);
  assert.match(jobClassifier, /NOT LIKE '%silicon validation%'/);
  assert.match(jobClassifier, /NOT LIKE '%post-silicon%'/);
  assert.match(jobClassifier, /NOT LIKE '%bootloader%'/);
  assert.match(jobClassifier, /NOT LIKE '%rtos%'/);
  assert.match(jobClassifier, /NOT LIKE '%uefi%'/);
});

test("roleTitleSql engineering_embedded_firmware case exists and covers firmware titles", () => {
  assert.match(jobClassifier, /roleKey === "engineering_embedded_firmware"/);
  assert.match(jobClassifier, /LIKE '%firmware%'/);
  assert.match(jobClassifier, /LIKE '%embedded%'/);
  assert.match(jobClassifier, /LIKE '%bsp%'/);
  assert.match(jobClassifier, /LIKE '%silicon validation%'/);
  assert.match(jobClassifier, /LIKE '%bootloader%'/);
  assert.match(jobClassifier, /LIKE '%hardware debug%'/);
});

test("roleKeyForProfile returns engineering_embedded_firmware for firmware domain profiles", () => {
  const server = fs.readFileSync("server.js", "utf8");

  assert.match(server, /domain === "engineering_embedded_firmware"/);
  assert.match(server, /return "engineering_embedded_firmware"/);
});

test("engineering pool with role_key=engineering excludes firmware-titled jobs via title filter", () => {
  const db = setupDb();
  db.exec(`
    INSERT INTO users VALUES (1, 'a');
    INSERT INTO scraped_jobs VALUES
      ('swe-ok',      'Software Engineer',          'Acme', 'software engineer', 10, 1000, NULL),
      ('fe-ok',       'Frontend Developer',          'Acme', 'frontend developer', 10, 1000, NULL),
      ('fw-bad',      'Firmware Engineer',           'Acme', 'software engineer', 10, 1000, NULL),
      ('emb-bad',     'Embedded Systems Engineer',   'Acme', 'software engineer', 10, 1000, NULL),
      ('bsp-bad',     'BSP Engineer',                'Acme', 'software engineer', 10, 1000, NULL),
      ('bios-bad',    'BIOS Software Engineer',      'Acme', 'software engineer', 10, 1000, NULL),
      ('driver-bad',  'Device Driver Engineer',      'Acme', 'software engineer', 10, 1000, NULL);
    INSERT INTO job_role_map VALUES
      ('swe-ok',      'engineering', 'engineering', 'engineering'),
      ('fe-ok',       'engineering', 'engineering', 'engineering'),
      ('fw-bad',      'engineering', 'engineering', 'engineering'),
      ('emb-bad',     'engineering', 'engineering', 'engineering'),
      ('bsp-bad',     'engineering', 'engineering', 'engineering'),
      ('bios-bad',    'engineering', 'engineering', 'engineering'),
      ('driver-bad',  'engineering', 'engineering', 'engineering');
  `);

  // Simulate the server-side query for a SWE user:
  // role_key = 'engineering' AND roleTitleSql exclusions applied
  const rows = db.prepare(`
    SELECT sj.job_id
    FROM scraped_jobs sj
    JOIN job_role_map jrm ON jrm.job_id = sj.job_id AND jrm.role_key = 'engineering'
    WHERE (
      LOWER(sj.title) LIKE '%engineer%'
      OR LOWER(sj.title) LIKE '%developer%'
      OR LOWER(sj.title) LIKE '%software%'
      OR LOWER(sj.title) LIKE '%backend%'
      OR LOWER(sj.title) LIKE '%frontend%'
      OR LOWER(sj.title) LIKE '%platform%'
    )
      AND LOWER(sj.title) NOT LIKE '%firmware%'
      AND LOWER(sj.title) NOT LIKE '%embedded%'
      AND LOWER(sj.title) NOT LIKE '%device driver%'
      AND LOWER(sj.title) NOT LIKE '%bsp%'
      AND LOWER(sj.title) NOT LIKE '% bios %'
      AND LOWER(sj.title) NOT LIKE 'bios %'
      AND LOWER(sj.title) NOT LIKE '%uefi%'
    ORDER BY sj.job_id
  `).all();

  const ids = rows.map(r => r.job_id);
  assert.ok(ids.includes("swe-ok"),  "SWE job should be visible");
  assert.ok(ids.includes("fe-ok"),   "Frontend job should be visible");
  assert.ok(!ids.includes("fw-bad"),     "Firmware Engineer must be excluded");
  assert.ok(!ids.includes("emb-bad"),    "Embedded Systems Engineer must be excluded");
  assert.ok(!ids.includes("bsp-bad"),    "BSP Engineer must be excluded");
  assert.ok(!ids.includes("bios-bad"),   "BIOS Software Engineer must be excluded");
  assert.ok(!ids.includes("driver-bad"), "Device Driver Engineer must be excluded");
});

test("firmware pool with role_key=engineering_embedded_firmware surfaces firmware jobs only", () => {
  const db = setupDb();
  db.exec(`
    INSERT INTO users VALUES (1, 'a');
    INSERT INTO scraped_jobs VALUES
      ('swe-job',  'Software Engineer',        'Acme', 'software engineer', 10, 1000, NULL),
      ('fw-job',   'Firmware Engineer',         'Acme', 'firmware engineer', 20, 1000, NULL),
      ('emb-job',  'Embedded Systems Engineer', 'Acme', 'firmware engineer', 20, 1000, NULL),
      ('bsp-job',  'BSP Engineer',              'Acme', 'firmware engineer', 20, 1000, NULL);
    INSERT INTO job_role_map VALUES
      ('swe-job', 'engineering',                'engineering', 'it_digital'),
      ('fw-job',  'engineering_embedded_firmware', 'engineering', 'engineering_embedded_firmware'),
      ('emb-job', 'engineering_embedded_firmware', 'engineering', 'engineering_embedded_firmware'),
      ('bsp-job', 'engineering_embedded_firmware', 'engineering', 'engineering_embedded_firmware');
  `);

  const rows = db.prepare(`
    SELECT sj.job_id
    FROM scraped_jobs sj
    JOIN job_role_map jrm ON jrm.job_id = sj.job_id
      AND jrm.role_key = 'engineering_embedded_firmware'
    WHERE (
      LOWER(sj.title) LIKE '%firmware%'
      OR LOWER(sj.title) LIKE '%embedded%'
      OR LOWER(sj.title) LIKE '%bsp%'
    )
    ORDER BY sj.job_id
  `).all();

  const ids = rows.map(r => r.job_id);
  assert.ok(!ids.includes("swe-job"), "SWE job must not appear in firmware pool");
  assert.ok(ids.includes("fw-job"),   "Firmware job must appear in firmware pool");
  assert.ok(ids.includes("emb-job"),  "Embedded job must appear in firmware pool");
  assert.ok(ids.includes("bsp-job"),  "BSP job must appear in firmware pool");
});
