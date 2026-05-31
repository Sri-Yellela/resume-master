// Tests for the LinkedIn extension import pipeline:
// write side (source_key normalization in server.js) + read side (importedJobs router)
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import fs from "node:fs";
import { createImportedJobsRouter } from "../routes/importedJobs.js";

const serverSrc = fs.readFileSync("server.js", "utf8");

// ── Source-code assertions: write-side contract ───────────────────────────────

test("save-jobs-bulk endpoint normalizes source_key to linkedin_extension", () => {
  // The bulk endpoint must write 'linkedin_extension', not 'linkedin_saved',
  // so that the read route (which filters WHERE source_key='linkedin_extension') can return them.
  const bulkBlock = serverSrc.slice(
    serverSrc.indexOf("/api/extension/save-jobs-bulk"),
    serverSrc.indexOf("/api/domain-metadata"),
  );
  assert.match(bulkBlock, /sourceKey:\s*["']linkedin_extension["']/, "bulk must write sourceKey='linkedin_extension'");
  assert.doesNotMatch(bulkBlock, /sourceKey:\s*["']linkedin_saved["']/, "bulk must NOT write linkedin_saved");
});

test("save-job single endpoint also writes source_key=linkedin_extension", () => {
  const singleBlock = serverSrc.slice(
    serverSrc.indexOf("/api/extension/save-job"),
    serverSrc.indexOf("/api/extension/save-jobs-bulk"),
  );
  assert.match(singleBlock, /"linkedin_extension"/, "single save must hardcode linkedin_extension");
});

test("save-jobs-bulk bumpSeen uses linkedin_extension not linkedin_saved", () => {
  const bulkBlock = serverSrc.slice(
    serverSrc.indexOf("/api/extension/save-jobs-bulk"),
    serverSrc.indexOf("/api/domain-metadata"),
  );
  // bumpSeen.run(userId, <sourceKey>, dedupeKey) — second arg must be linkedin_extension
  assert.match(bulkBlock, /bumpSeen\.run\(userId,\s*["']linkedin_extension["']/, "bumpSeen must use linkedin_extension");
});

// ── Integration test: seeded rows read back via GET /api/imported-jobs/linkedin ──

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE imported_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      source_key TEXT NOT NULL,
      source_label TEXT NOT NULL,
      source_platform TEXT NOT NULL,
      external_job_id TEXT,
      dedupe_key TEXT NOT NULL,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      location TEXT,
      job_url TEXT,
      apply_url TEXT,
      work_type TEXT,
      employment_type TEXT,
      compensation TEXT,
      posted_at TEXT,
      description TEXT,
      company_icon_url TEXT,
      payload_json TEXT,
      visited INTEGER NOT NULL DEFAULT 0,
      starred INTEGER NOT NULL DEFAULT 0,
      disliked INTEGER NOT NULL DEFAULT 0,
      applied INTEGER NOT NULL DEFAULT 0,
      import_count INTEGER NOT NULL DEFAULT 1,
      first_imported_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_imported_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(user_id, source_key, dedupe_key)
    );
  `);
  return db;
}

function seedBulkImport(db, userId, jobs) {
  // Mirrors the logic the save-jobs-bulk endpoint uses after the B1 fix:
  // sourceKey is normalized to 'linkedin_extension'
  const insert = db.prepare(`
    INSERT OR IGNORE INTO imported_jobs
      (user_id, source_key, source_label, source_platform, external_job_id, dedupe_key,
       title, company, location, work_type, description, job_url, apply_url, company_icon_url, posted_at)
    VALUES
      (@userId, @sourceKey, @sourceLabel, @sourcePlatform, @externalJobId, @dedupeKey,
       @title, @company, @location, @workType, @description, @jobUrl, @applyUrl, @companyIconUrl, @postedAt)
  `);
  const bumpSeen = db.prepare(
    "UPDATE imported_jobs SET import_count=import_count+1, last_seen_at=unixepoch() WHERE user_id=? AND source_key=? AND dedupe_key=?"
  );
  const insertMany = db.transaction((jobList) => {
    let imported = 0, skipped = 0;
    for (const j of jobList) {
      const jobUrl = (j.jobUrl || "").slice(0, 2000);
      const externalJobId = j.externalJobId || null;
      const dedupeKey = externalJobId
        ? `linkedin_ext_saved_${externalJobId}`
        : `linkedin_ext_saved_${Buffer.from((jobUrl || j.title + j.company).slice(0, 200)).toString("base64").slice(0, 64)}`;
      const info = insert.run({
        userId,
        sourceKey: "linkedin_extension",   // normalized — the B1 fix
        sourceLabel: "LinkedIn (Extension)",
        sourcePlatform: "linkedin",
        externalJobId,
        dedupeKey,
        title: j.title,
        company: j.company,
        location: j.location || null,
        workType: j.workType || null,
        description: j.description || null,
        jobUrl,
        applyUrl: j.applyUrl || jobUrl,
        companyIconUrl: j.companyLogo || null,
        postedAt: null,
      });
      if (info.changes > 0) imported++;
      else { bumpSeen.run(userId, "linkedin_extension", dedupeKey); skipped++; }
    }
    return { imported, skipped };
  });
  return insertMany(jobs);
}

async function makeServer(db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.use("/api/imported-jobs", createImportedJobsRouter(db));
  return app;
}

async function getJson(app, path) {
  const { default: http } = await import("node:http");
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const req = http.get(`http://localhost:${port}${path}`, res => {
        let body = "";
        res.on("data", c => body += c);
        res.on("end", () => {
          server.close();
          try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
        });
      });
      req.on("error", reject);
    });
  });
}

test("bulk-imported jobs (source_key=linkedin_extension) appear in GET /api/imported-jobs/linkedin", async () => {
  const db = makeDb();
  const batch = [
    { title: "Senior Engineer", company: "Acme", location: "Remote", externalJobId: "ext-001", jobUrl: "https://jobs.example.com/1" },
    { title: "Staff Eng",       company: "Globex", location: "NYC",    externalJobId: "ext-002", jobUrl: "https://jobs.example.com/2" },
  ];
  const counts = seedBulkImport(db, 1, batch);
  assert.equal(counts.imported, 2, "both jobs should be imported");
  assert.equal(counts.skipped, 0, "no duplicates on first insert");

  const app = await makeServer(db);
  const result = await getJson(app, "/api/imported-jobs/linkedin");
  assert.ok(Array.isArray(result.jobs), "response must have jobs array");
  assert.equal(result.jobs.length, 2, "both bulk-imported jobs must appear");
  const titles = result.jobs.map(j => j.title);
  assert.ok(titles.includes("Senior Engineer"), "first job must be present");
  assert.ok(titles.includes("Staff Eng"), "second job must be present");
  assert.ok(result.jobs.every(j => j.source === "linkedin_extension"), "all must show source=linkedin_extension");
});

test("linkedin_saved rows (pre-B1-fix source_key) are NOT visible in GET /api/imported-jobs/linkedin", async () => {
  const db = makeDb();
  // Seed a row with the OLD wrong source_key to prove the read route filters it out
  db.prepare(`
    INSERT INTO imported_jobs
      (user_id, source_key, source_label, source_platform, dedupe_key, title, company)
    VALUES (1, 'linkedin_saved', 'LinkedIn Saved', 'linkedin', 'old_key_1', 'Old Job', 'OldCo')
  `).run();

  const app = await makeServer(db);
  const result = await getJson(app, "/api/imported-jobs/linkedin");
  assert.equal(result.jobs.length, 0, "linkedin_saved rows must be invisible to the read route");
});

test("duplicate bulk imports are skipped (idempotent), import_count bumped", async () => {
  const db = makeDb();
  const batch = [{ title: "Eng", company: "Co", externalJobId: "ext-dup", jobUrl: "https://x.com/1" }];
  const first = seedBulkImport(db, 1, batch);
  const second = seedBulkImport(db, 1, batch);
  assert.equal(first.imported, 1);
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 1, "re-import should be counted as skipped");
  const row = db.prepare("SELECT import_count FROM imported_jobs WHERE user_id=1").get();
  assert.equal(row.import_count, 2, "import_count should increment on re-import");
});
