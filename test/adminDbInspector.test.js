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
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY,
      title TEXT NOT NULL
    );
    CREATE TABLE job_role_map (
      job_id TEXT NOT NULL REFERENCES scraped_jobs(job_id) ON DELETE CASCADE,
      role_key TEXT NOT NULL,
      PRIMARY KEY (job_id, role_key)
    );
    INSERT INTO users VALUES (1, 'admin');
    INSERT INTO scraped_jobs VALUES ('j1', 'Software Engineer');
    INSERT INTO job_role_map VALUES ('j1', 'engineering');
  `);

  const app = express();
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
    assert.equal(rows.total, 1);
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
