import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import { createAdminDbRouter } from "../routes/adminDb.js";

function setupServer() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL
    );
    CREATE TABLE domain_profiles (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      profile_name TEXT,
      role_family TEXT,
      domain TEXT,
      is_active INTEGER DEFAULT 0
    );
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      company TEXT,
      search_query TEXT,
      source_platform TEXT,
      posted_at TEXT,
      scraped_at INTEGER,
      domain_profile_id INTEGER
    );
    CREATE TABLE user_jobs (
      user_id INTEGER,
      job_id TEXT,
      domain_profile_id INTEGER,
      applied INTEGER DEFAULT 0
    );
    CREATE TABLE job_role_map (
      job_id TEXT NOT NULL REFERENCES scraped_jobs(job_id) ON DELETE CASCADE,
      role_key TEXT NOT NULL,
      role_family TEXT,
      domain TEXT,
      source_profile_id INTEGER,
      confidence REAL,
      matched_by TEXT,
      PRIMARY KEY (job_id, role_key)
    );
    INSERT INTO users VALUES (1, 'admin');
    INSERT INTO domain_profiles VALUES (10, 1, 'Data', 'data', 'data', 1);
    INSERT INTO scraped_jobs VALUES ('j1', 'Software Engineer', 'Acme', 'software engineer', 'linkedin', '2026-04-01', 1000, NULL);
    INSERT INTO scraped_jobs VALUES ('j2', 'Machine Learning Engineer', 'MLCo', 'software engineer', 'linkedin', '2026-04-01', 1000, NULL);
    INSERT INTO job_role_map VALUES ('j1', 'engineering', 'engineering', 'engineering', NULL, 0.6, 'title_heuristic');
    INSERT INTO job_role_map VALUES ('j2', 'engineering', 'engineering', 'engineering', NULL, 0.6, 'title_heuristic');
  `);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 1, isAdmin: true };
    next();
  });
  app.use("/api/admin/db", createAdminDbRouter(db));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

test("admin DB inspector lists tables and paginated rows", async () => {
  const { server, baseUrl } = setupServer();
  try {
    const tables = await fetch(`${baseUrl}/api/admin/db/tables`).then(r => r.json());
    assert.ok(tables.tables.some(t => t.name === "job_role_map"));

    const rows = await fetch(`${baseUrl}/api/admin/db/table-data/job_role_map?page=1&pageSize=10`)
      .then(r => r.json());
    assert.equal(rows.total, 2);
    assert.equal(rows.rows[0].role_key, "engineering");
  } finally {
    server.close();
  }
});

test("admin DB inspector schema graph exposes PK and FK relationships", async () => {
  const { server, baseUrl } = setupServer();
  try {
    const graph = await fetch(`${baseUrl}/api/admin/db/schema/graph`).then(r => r.json());
    const roleMap = graph.tables.find(t => t.name === "job_role_map");
    assert.ok(roleMap.columns.some(c => c.name === "job_id" && c.primaryKey));
    assert.ok(graph.relationships.some(r =>
      r.fromTable === "job_role_map" &&
      r.fromColumn === "job_id" &&
      r.toTable === "scraped_jobs"
    ));
  } finally {
    server.close();
  }
});

test("admin job review suggests ML jobs as data and can reassign role maps", async () => {
  const { server, baseUrl } = setupServer();
  try {
    const review = await fetch(`${baseUrl}/api/admin/db/job-review?q=machine`).then(r => r.json());
    assert.equal(review.jobs[0].job_id, "j2");
    assert.equal(review.jobs[0].suggestedRoleKey, "data");

    const saved = await fetch(`${baseUrl}/api/admin/db/job-review/reassign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: "j2", roleKey: "data", domainProfileId: 10 }),
    }).then(r => r.json());
    assert.equal(saved.ok, true);

    const rows = await fetch(`${baseUrl}/api/admin/db/table-data/job_role_map?page=1&pageSize=10`)
      .then(r => r.json());
    const j2 = rows.rows.find(r => r.job_id === "j2");
    assert.equal(j2.role_key, "data");
    assert.equal(j2.matched_by, "manual_review");
  } finally {
    server.close();
  }
});
