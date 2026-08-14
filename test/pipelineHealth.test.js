import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import { createAdminDbRouter } from "../routes/adminDb.js";
import { recordPipelineRun } from "../services/jobs/pipelineRunLog.js";

// The admin monitor showed 684 rows "existing and looking fine" while three independent
// failures ran undetected (docs/PIPELINE_DIAGNOSIS.md §4). These tests pin the specific
// distinctions the old surface could not make: a provider that never ran vs. one that ran and
// found nothing, a source that has rows but stopped writing days ago, and an enrichment column
// sitting at 0%.

const HOUR = 3600;

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT, location TEXT,
      source TEXT, source_label TEXT, posted_at TEXT,
      discovered_at INTEGER, scraped_at INTEGER, updated_at INTEGER, is_active INTEGER DEFAULT 1,
      description TEXT, summary TEXT, normalized_title TEXT, experience_level TEXT,
      workplace_type TEXT, skills_json TEXT, salary_min_usd INTEGER, salary_max_usd INTEGER,
      salary_period TEXT, is_h1b_sponsor INTEGER, requires_work_auth INTEGER,
      is_clearance_required INTEGER, org_unit_raw TEXT,
      enriched_at INTEGER, content_hash TEXT, sources_seen TEXT, req_uid TEXT
    );
    -- Enrichment now records usage through callModel (services/modelCall.js), so these fixtures
    -- have to carry the tracking tables. Without them every enriched job produced a tracking
    -- failure that fell through to the out-of-process sink and wrote into the real data/ directory
    -- — non-hermetic, and it hid the fact that enrichment spend was not being recorded here at all.
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, event_type TEXT NOT NULL,
      event_subtype TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_creation_tokens INTEGER DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0, model TEXT, cost_usd REAL DEFAULT 0,
      ats_score_before INTEGER, ats_score_after INTEGER, duration_ms INTEGER, job_id TEXT,
      company TEXT, success INTEGER NOT NULL DEFAULT 1, error_text TEXT, purpose TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS cache_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, event_type TEXT NOT NULL,
      layer TEXT, domain_module TEXT, tokens_in_cache INTEGER DEFAULT 0,
      tokens_saved INTEGER DEFAULT 0, cost_saved_usd REAL DEFAULT 0, model TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS usage_tracking_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT, purpose TEXT, user_id INTEGER,
      error_text TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()), source TEXT
    );
    CREATE TABLE pipeline_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_kind TEXT NOT NULL, source TEXT, status TEXT NOT NULL,
      started_at INTEGER NOT NULL, finished_at INTEGER, duration_ms INTEGER,
      fetched INTEGER NOT NULL DEFAULT 0, written INTEGER NOT NULL DEFAULT 0,
      unchanged INTEGER NOT NULL DEFAULT 0, merged INTEGER NOT NULL DEFAULT 0,
      dropped INTEGER NOT NULL DEFAULT 0, ejected INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
      expired INTEGER NOT NULL DEFAULT 0, error_text TEXT, details_json TEXT
    );
    CREATE TABLE company_ats_list (company TEXT, ats_type TEXT, ats_slug TEXT);
  `);
  return db;
}

async function getHealth(db) {
  const app = express();
  app.use((req, _res, next) => { req.user = { isAdmin: true }; next(); });
  app.use("/api/admin/db", createAdminDbRouter(db, {}));
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/db/pipeline-health`);
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

async function getRows(db, qs = "") {
  const app = express();
  app.use((req, _res, next) => { req.user = { isAdmin: true }; next(); });
  app.use("/api/admin/db", createAdminDbRouter(db, {}));
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/db/scrape-monitor?${qs}`);
    return await res.json();
  } finally { server.close(); }
}

function sourceNamed(body, name) {
  return body.sources.find(s => s.name === name);
}

test("recordPipelineRun persists a run and never throws when the table is absent", () => {
  const db = makeDb();
  recordPipelineRun(db, {
    runKind: "source_sync", source: "greenhouse", status: "ok",
    startedAt: Math.floor(Date.now() / 1000) - 5,
    fetched: 100, written: 40, merged: 2, details: { companies: 10 },
  });
  const row = db.prepare("SELECT * FROM pipeline_runs").get();
  assert.equal(row.source, "greenhouse");
  assert.equal(row.written, 40);
  assert.equal(JSON.parse(row.details_json).companies, 10);
  assert.ok(row.duration_ms >= 0, "duration must be non-negative");

  // Observability must never be able to break ingestion — including before migration 069 has
  // been applied on a given deployment.
  const noTable = new Database(":memory:");
  assert.doesNotThrow(() => recordPipelineRun(noTable, {
    runKind: "enrichment", status: "ok", startedAt: 1,
  }), "a missing pipeline_runs table must be swallowed, not thrown");
});

test("pipeline health flags a source that has rows but stopped writing", async () => {
  // Ashby's real failure: 21 healthy-looking rows, last written three days earlier, nothing
  // anywhere asserting freshness.
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  const old = now - 72 * HOUR;
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,source,discovered_at,is_active,description)
              VALUES ('a','Eng','ashby',?,1,'text')`).run(old);
  recordPipelineRun(db, { runKind: "source_sync", source: "ashby", status: "ok", startedAt: old, written: 21 });

  const { body } = await getHealth(db);
  const ashby = sourceNamed(body, "ashby");
  assert.equal(ashby.health, "stale");
  assert.ok(ashby.staleHours >= 71, `expected >=71h stale, got ${ashby.staleHours}`);
});

test("a configured provider that never ran is not reported as a healthy empty sync", async () => {
  // Jobo logged "sync complete — 0 jobs cached" for its entire lifetime. "Never ran" and
  // "ran and found nothing" must be different states.
  const db = makeDb();
  const { body } = await getHealth(db);
  const greenhouse = sourceNamed(body, "greenhouse");
  assert.ok(["never_ran", "not_configured"].includes(greenhouse.health),
    `a source with no rows and no runs must not read as ok (got ${greenhouse.health})`);
  assert.notEqual(greenhouse.health, "ok");
});

test("pipeline health distinguishes a hard failure from a quiet zero", async () => {
  // Uses greenhouse because its isConfigured() is unconditionally true; jobo's depends on
  // JOBO_API_KEY being present in the environment, and an unset key correctly outranks the
  // failure in the severity ordering (a missing key IS the primary problem, not a symptom).
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  recordPipelineRun(db, {
    runKind: "source_sync", source: "greenhouse", status: "failed", startedAt: now,
    errorText: "HTTP 402 — PAYMENT REQUIRED: wallet exhausted",
  });
  const { body } = await getHealth(db);
  const gh = sourceNamed(body, "greenhouse");
  assert.equal(gh.health, "failed");
  assert.match(gh.lastRun.error, /402/, "the operator-facing reason must survive to the UI");
  assert.equal(gh.lastSuccessAt, null, "a failed run must not count as a success");
});

test("an unset API key outranks a downstream failure in the health ordering", async () => {
  // Jobo's key was believed set for months while the provider never ran. If a misconfiguration
  // is present it must be the reported cause, never masked by the error it produces.
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  const hadKey = process.env.JOBO_API_KEY;
  delete process.env.JOBO_API_KEY;
  try {
    recordPipelineRun(db, {
      runKind: "source_sync", source: "jobo", status: "failed", startedAt: now,
      errorText: "some downstream error",
    });
    const { body } = await getHealth(db);
    assert.equal(sourceNamed(body, "jobo").health, "not_configured");
  } finally {
    if (hadKey !== undefined) process.env.JOBO_API_KEY = hadKey;
  }
});

test("enrichment coverage reports 0% for a column nothing has populated", async () => {
  // skills_json sat at 0/684 in production with no surface showing it.
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 4; i++) {
    db.prepare(`INSERT INTO scraped_jobs (job_id,title,source,discovered_at,is_active,description,normalized_title)
                VALUES (?,?,'greenhouse',?,1,'real text','eng')`).run(`j${i}`, `Job ${i}`, now);
  }
  const { body } = await getHealth(db);
  const by = Object.fromEntries(body.enrichment.coverage.map(c => [c.column, c]));
  assert.equal(by.skills_json.pct, 0, "an entirely unpopulated column must read 0%");
  assert.equal(by.normalized_title.pct, 100);
  assert.equal(by.description.pct, 100);
  assert.equal(body.enrichment.activeTotal, 4);
});

test("rows with a blank description are counted as unenrichable, not merely unenriched", async () => {
  // The distinction that matters: an empty description means the row can NEVER gain skills,
  // summary, salary or visa signals, however many enrichment passes run.
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,source,discovered_at,is_active,description) VALUES ('a','A','greenhouse',?,1,NULL)`).run(now);
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,source,discovered_at,is_active,description) VALUES ('b','B','greenhouse',?,1,'   ')`).run(now);
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,source,discovered_at,is_active,description) VALUES ('c','C','greenhouse',?,1,'real')`).run(now);

  const { body } = await getHealth(db);
  assert.equal(body.enrichment.noDescription, 2, "NULL and whitespace-only both count as missing");
  assert.equal(sourceNamed(body, "greenhouse").noDescription, 2);
});

test("the row list exposes post-pivot fields and no longer leaks pre-pivot columns", async () => {
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,company,source,discovered_at,is_active,description,skills_json)
              VALUES ('a','Eng','Acme','greenhouse',?,1,'a real description','["go"]')`).run(now);

  const body = await getRows(db, "limit=10");
  const job = body.jobs[0];
  assert.equal(job.source, "greenhouse");
  assert.equal(job.has_description, 1);
  assert.equal(job.description_len, "a real description".length);
  // The pre-pivot columns drove the old panel's "Tagged / No Tag" status, which stayed green
  // throughout the outage.
  assert.ok(!("domain_profile_id" in job), "domain_profile_id must no longer be selected");
  assert.ok(!("ats_score" in job), "ats_score must no longer be selected");
  assert.ok(!("search_query" in job), "search_query must no longer be selected");
  assert.deepEqual(body.sources, [{ source: "greenhouse", n: 1 }]);
});

test("the row list can be sliced by source", async () => {
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,source,discovered_at,is_active,description) VALUES ('a','A','greenhouse',?,1,'x')`).run(now);
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,source,discovered_at,is_active,description) VALUES ('b','B','jobo',?,1,'y')`).run(now);

  const body = await getRows(db, "limit=10&source=jobo");
  assert.equal(body.jobs.length, 1);
  assert.equal(body.jobs[0].source, "jobo");
});

test("dedup folding is visible", async () => {
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,source,discovered_at,is_active,description,sources_seen)
              VALUES ('a','A','greenhouse',?,1,'x','["greenhouse","jobo"]')`).run(now);
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,source,discovered_at,is_active,description,sources_seen)
              VALUES ('b','B','greenhouse',?,1,'x','["greenhouse"]')`).run(now);

  const { body } = await getHealth(db);
  assert.equal(body.dedup.multiSource, 1, "only the row seen from 2+ sources counts as folded");
  assert.equal(body.dedup.total, 2);
});

test("user-triggered enrichment passes are excluded from the run log", async () => {
  // importJob.js fires enrichment on every single-URL import. pipeline_runs answers "is the
  // SCHEDULED pipeline healthy?", so incidental user-triggered passes must not interleave with
  // the cron history and push real runs out of the recent-runs view.
  const { runEnrichment } = await import("../services/jobs/enrichJob.js");
  const db = makeDb();
  db.exec(`CREATE TABLE company_technographics (
    company TEXT, skill TEXT, weight REAL, last_seen INTEGER, posting_count INTEGER,
    PRIMARY KEY (company, skill)
  );`);
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,company,source,discovered_at,is_active,description)
              VALUES ('a','Eng','Acme','import',1,1,'Real description text.')`).run();

  const stub = { messages: { create: async () => ({
    content: [{ text: JSON.stringify({
      summary: "A role.", normalizedTitle: null, experienceLevel: null, workplaceType: null,
      skillsHard: [], skillsSoft: [], salaryMinUsd: null, salaryMaxUsd: null, salaryPeriod: null,
      isH1bSponsor: null, requiresWorkAuth: null, isClearanceRequired: null, orgUnit: null,
    }) }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }) } };

  await runEnrichment(db, stub, { recordRun: false });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM pipeline_runs").get().n, 0,
    "an opted-out pass must leave no run record");
  assert.ok(db.prepare("SELECT summary FROM scraped_jobs WHERE job_id='a'").get().summary,
    "the enrichment work itself must still happen");

  // The scheduled path still records.
  db.prepare("UPDATE scraped_jobs SET content_hash=NULL, enriched_at=NULL, summary=NULL WHERE job_id='a'").run();
  await runEnrichment(db, stub);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM pipeline_runs").get().n, 1,
    "the default (cron) path must still record");
});
