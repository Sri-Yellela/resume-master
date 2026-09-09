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
      provider TEXT,
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
    -- Mirrors the real shape from server.js. The active and bucket_role columns were missing here
    -- while nothing read them, and their absence made per-company health 500 rather than degrade
    -- — an under-specified fixture reporting a route defect that does not exist.
    -- (No backticks in this comment: the whole block is a JS template literal.)
    CREATE TABLE company_ats_list (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      company     TEXT NOT NULL,
      ats_type    TEXT NOT NULL,
      ats_slug    TEXT NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      bucket_role TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(ats_type, ats_slug)
    );
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

// ── THE AC RESIDUAL ─────────────────────────────────────────────────────────────────────────────
//
// Part 1's audit found this route already built and deployed, satisfying AC items 1, 3 and 4. What
// it did NOT do was the three things below, each corresponding to a failure that really happened
// and really went unseen:
//
//   1. it classified on `status`, and production recorded THREE CONSECUTIVE DAYS of enrichment as
//      `status: 'ok'` with `written: 0, failed: 25`
//   2. it aggregated per SOURCE, and greenhouse read `ok` with 621 active rows while SIX of its
//      nine active company slugs contributed zero
//   3. it reported adzuna and serpapi as `never_ran`, a warning indistinguishable from Jobo's real
//      months-long failure, when the crawl never calls them by design

function alertFor(body, kind, subject) {
  return (body.alerts || []).find(a => a.kind === kind && a.subject === subject);
}

test("a run that fetched rows and wrote NONE is not healthy, whatever its status says", async () => {
  // ⛔ THE TEST THAT WOULD HAVE CAUGHT THE THREE-DAY OUTAGE. status 'ok' is the trap.
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,company,source,discovered_at,is_active,description)
              VALUES ('a','Eng','Stripe','greenhouse',?,1,'text')`).run(now);
  recordPipelineRun(db, {
    runKind: "source_sync", source: "greenhouse", status: "ok", startedAt: now,
    fetched: 100, written: 0,
  });

  const { body } = await getHealth(db);
  const gh = sourceNamed(body, "greenhouse");
  assert.equal(gh.health, "wrote_nothing",
    "a status-keyed check reads this as ok — that is the defect, not a nuance");
  const alert = alertFor(body, "source", "greenhouse");
  assert.ok(alert, "it must also be an ALERT, not merely a differently-coloured cell");
  assert.equal(alert.severity, "critical");
  assert.match(alert.detail, /wrote 0 rows from 100 fetched/);
});

test("wrote_nothing outranks stale, so a source failing every run cannot hide behind quietness", async () => {
  const db = makeDb();
  const old = Math.floor(Date.now() / 1000) - 72 * HOUR;
  recordPipelineRun(db, {
    runKind: "source_sync", source: "greenhouse", status: "ok", startedAt: old,
    fetched: 50, written: 0,
  });
  const { body } = await getHealth(db);
  assert.equal(sourceNamed(body, "greenhouse").health, "wrote_nothing",
    "after 48h this would read merely 'stale', which describes the symptom and not the failure");
});

test("enrichment run health comes from written, not from the status it recorded", async () => {
  // Production's 2026-09-05/06/07 rows, verbatim.
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  for (const day of [3, 2, 1]) {
    recordPipelineRun(db, {
      runKind: "enrichment", status: "ok", startedAt: now - day * 24 * HOUR,
      fetched: 25, written: 0, failed: 25,
      errorText: "404 model not_found: claude-3-haiku-20240307",
    });
  }
  const { body } = await getHealth(db);
  const last = body.enrichment.recentRuns[0];
  assert.equal(last.status, "ok", "the recorded status is preserved — it is evidence");
  assert.equal(last.health, "failed", "but health must not believe it");

  assert.ok(alertFor(body, "enrichment", "last run"), "one failed run is an alert");
  const streak = alertFor(body, "enrichment", "consecutive failures");
  assert.ok(streak, "three in a row is the shape that ran for three days undetected");
  assert.match(streak.detail, /last 3 enrichment runs wrote nothing/);
});

test("an enrichment run that wrote everything it fetched is ok, and raises nothing", async () => {
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  recordPipelineRun(db, {
    runKind: "enrichment", status: "ok", startedAt: now, fetched: 25, written: 25, failed: 0,
  });
  const { body } = await getHealth(db);
  assert.equal(body.enrichment.recentRuns[0].health, "ok");
  assert.equal(alertFor(body, "enrichment", "last run"), undefined,
    "a healthy run must not raise an alert, or the alert list becomes noise nobody reads");
});

test("PER-COMPANY: a source reads ok while a company inside it produced nothing", async () => {
  // ⛔ THE GREENHOUSE CASE, EXACTLY. Two slugs configured, one producing, one silent. The source
  // grain cannot express this and reported `ok` throughout — which is how the 900-posting
  // cross-company cap survived undetected while discarding 1,365 postings a crawl.
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO company_ats_list (company,ats_type,ats_slug,active) VALUES
              ('Stripe','greenhouse','stripe',1), ('Anthropic','greenhouse','anthropic',1)`).run();
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,company,source,discovered_at,is_active,description)
              VALUES ('a','Eng','Stripe','greenhouse',?,1,'text')`).run(now);
  recordPipelineRun(db, {
    runKind: "source_sync", source: "greenhouse", status: "ok", startedAt: now,
    fetched: 900, written: 1,
  });

  const { body } = await getHealth(db);
  assert.equal(sourceNamed(body, "greenhouse").health, "ok",
    "the source is genuinely fine at its own grain — that is the point");

  const anthropic = body.companies.find(c => c.slug === "anthropic");
  assert.ok(anthropic, "per-company health must exist at all");
  assert.equal(anthropic.health, "no_rows");
  assert.equal(body.companies.find(c => c.slug === "stripe").health, "ok");

  const alert = alertFor(body, "company", "greenhouse/anthropic");
  assert.ok(alert, "an active company at zero rows must ALERT, not sit in a table");
  assert.equal(alert.severity, "critical");
  assert.match(alert.detail, /Anthropic/);
});

test("PER-COMPANY: rows that all lack a description are flagged, because they can never enrich", async () => {
  // Ubisoft (97), Bosch (334) and Adobe (217) were seeded INACTIVE for exactly this. If one is
  // ever switched on, this is the surface that says so.
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO company_ats_list (company,ats_type,ats_slug,active) VALUES
              ('Ubisoft','smartrecruiters','Ubisoft2',1)`).run();
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,company,source,discovered_at,is_active,description)
              VALUES ('u1','Eng','Ubisoft','smartrecruiters',?,1,NULL),
                     ('u2','Eng','Ubisoft','smartrecruiters',?,1,'')`).run(now, now);

  const { body } = await getHealth(db);
  const ubi = body.companies.find(c => c.slug === "Ubisoft2");
  assert.equal(ubi.health, "no_descriptions");
  assert.equal(ubi.active, 2);
  assert.equal(ubi.noDescription, 2);
  assert.match(alertFor(body, "company", "smartrecruiters/Ubisoft2").detail, /can ever be enriched/);
});

test("PER-COMPANY: the join is scoped by source, so a same-named row elsewhere cannot credit a slug", async () => {
  // scraped_jobs.company is written verbatim from company_ats_list.company by every ATS plugin,
  // which is what makes this join exact — but jobo, adzuna and imported rows carry the PROVIDER's
  // spelling, and an unscoped join would let one of those vouch for a dead ATS slug.
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  // created_at predates the crawl, and the crawl succeeded — so `awaiting_first_crawl` cannot be
  // what explains the result, and only the join scoping can.
  db.prepare(`INSERT INTO company_ats_list (company,ats_type,ats_slug,active,created_at) VALUES
              ('Anthropic','greenhouse','anthropic',1,?)`).run(now - 30 * 24 * HOUR);
  recordPipelineRun(db, {
    runKind: "source_sync", source: "greenhouse", status: "ok", startedAt: now - HOUR,
    fetched: 5, written: 5,
  });
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,company,source,discovered_at,is_active,description)
              VALUES ('j1','Eng','Anthropic','jobo',?,1,'text')`).run(now);

  const { body } = await getHealth(db);
  assert.equal(body.companies.find(c => c.slug === "anthropic").health, "no_rows",
    "a jobo row must not make a greenhouse slug look alive");
});

test("with no successful crawl on record, every company awaits it rather than each failing", async () => {
  // The source-level `never_ran` already says the one true thing. Repeating it per company would
  // turn one finding into N, which is how the worst alert gets buried.
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO company_ats_list (company,ats_type,ats_slug,active,created_at) VALUES
              ('Stripe','greenhouse','stripe',1,?), ('Airbnb','greenhouse','airbnb',1,?)`)
    .run(now - 90 * 24 * HOUR, now - 90 * 24 * HOUR);

  const { body } = await getHealth(db);
  for (const slug of ["stripe", "airbnb"]) {
    assert.equal(body.companies.find(c => c.slug === slug).health, "awaiting_first_crawl");
    assert.equal(alertFor(body, "company", `greenhouse/${slug}`), undefined);
  }
  assert.ok(alertFor(body, "source", "greenhouse"), "the source-level finding must still fire");
});

test("PER-COMPANY: inactive companies are not alerted on, because inactive is a decision", async () => {
  const db = makeDb();
  db.prepare(`INSERT INTO company_ats_list (company,ats_type,ats_slug,active) VALUES
              ('Veeva Systems','lever','veeva',0)`).run();
  const { body } = await getHealth(db);
  assert.equal(body.companies.find(c => c.slug === "veeva"), undefined,
    "a deliberately-disabled company producing nothing is the intended outcome, not a finding");
  assert.equal(alertFor(body, "company", "lever/veeva"), undefined);
});

test("a live-search-only source is not reported as never having run", async () => {
  // adzuna and serpapi are configured, healthy, and outside the crawl. Reading them as `never_ran`
  // put two permanent warnings next to Jobo's real one, and a warning that is always there is a
  // warning nobody reads.
  //
  // ⛔ THE KEYS ARE SET HERE ON PURPOSE. serpapi's isConfigured() is `!!process.env.SERPAPI_KEY`
  // and adzuna's needs both of its own, none of which exist in a test process — so the first
  // version of this test read `configured: false` and skipped every assertion it contained. It
  // passed against the OLD route and against the new one identically, which makes it a guard that
  // cannot fail: this project's Shape 5, and the exact defect ae5BoardUi shipped.
  const saved = {
    SERPAPI_KEY: process.env.SERPAPI_KEY,
    ADZUNA_APP_ID: process.env.ADZUNA_APP_ID,
    ADZUNA_APP_KEY: process.env.ADZUNA_APP_KEY,
  };
  process.env.SERPAPI_KEY = "test-key";
  process.env.ADZUNA_APP_ID = "test-id";
  process.env.ADZUNA_APP_KEY = "test-key";
  try {
    const db = makeDb();
    const { body } = await getHealth(db);
    for (const name of ["adzuna", "serpapi"]) {
      const s = sourceNamed(body, name);
      assert.ok(s, `${name} must appear in the source list at all`);
      assert.equal(s.configured, true, `${name}'s key was set for this test and must be seen`);
      assert.equal(s.inCrawl, false, `${name} must not claim to be in the crawl`);
      assert.equal(s.health, "live_search_only",
        `${name} read as ${s.health}, which is indistinguishable from a real failure`);
      assert.equal(alertFor(body, "source", name), undefined,
        `${name} must not raise an alert for not doing something it never does`);
    }
    // And the distinction has to be real in the other direction, or every source is exempt.
    const gh = sourceNamed(body, "greenhouse");
    assert.equal(gh.inCrawl, true);
    assert.notEqual(gh.health, "live_search_only");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("alerts is empty when everything is healthy, so an empty list MEANS something", async () => {
  // A panel that shows nothing because it computed nothing looks identical to one that checked and
  // found nothing. Every enrichment column must carry a value here or a 0% coverage alert fires.
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO company_ats_list (company,ats_type,ats_slug,active) VALUES
              ('Stripe','greenhouse','stripe',1)`).run();
  db.prepare(`INSERT INTO scraped_jobs
    (job_id,title,company,source,discovered_at,is_active,description,summary,normalized_title,
     experience_level,workplace_type,skills_json,salary_max_usd,is_h1b_sponsor,requires_work_auth,
     enriched_at)
    VALUES ('a','Eng','Stripe','greenhouse',?,1,'text','s','eng','senior','remote','[]',1,1,1,?)`)
    .run(now, now);
  recordPipelineRun(db, {
    runKind: "source_sync", source: "greenhouse", status: "ok", startedAt: now,
    fetched: 1, written: 1,
  });
  recordPipelineRun(db, {
    runKind: "enrichment", status: "ok", startedAt: now, fetched: 1, written: 1, failed: 0,
  });

  const { body } = await getHealth(db);
  // Other SOURCES are legitimately unhealthy in this fixture (nothing ran for them), so this
  // asserts on everything that is not a source finding — the coverage, company and enrichment
  // checks all had real data to look at and must be silent.
  const nonSource = (body.alerts || []).filter(a => a.kind !== "source");
  assert.deepEqual(nonSource, [],
    `a healthy board must raise nothing: ${JSON.stringify(nonSource)}`);
  assert.equal(sourceNamed(body, "greenhouse").health, "ok");
  assert.equal(body.companies.find(c => c.slug === "stripe").health, "ok");
});

test("alerts are ranked critical-first and counted, so the panel cannot bury the worst one", async () => {
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  const old = now - 72 * HOUR;
  db.prepare(`INSERT INTO company_ats_list (company,ats_type,ats_slug,active) VALUES
              ('Stripe','greenhouse','stripe',1), ('Anthropic','greenhouse','anthropic',1)`).run();
  // Stripe: rows exist but are old -> warn. Anthropic: no rows at all -> critical.
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,company,source,discovered_at,is_active,description)
              VALUES ('a','Eng','Stripe','greenhouse',?,1,'text')`).run(old);

  const { body } = await getHealth(db);
  assert.ok(body.alertCounts.critical >= 1, "the zero-row company must be counted critical");
  const severities = body.alerts.map(a => a.severity);
  const firstWarn = severities.indexOf("warn");
  const lastCritical = severities.lastIndexOf("critical");
  if (firstWarn !== -1 && lastCritical !== -1) {
    assert.ok(lastCritical < firstWarn, `criticals must precede warns: ${severities.join(",")}`);
  }
});

test("a company added since the last crawl is awaiting it, not failing", async () => {
  // Migration 103 seeded TEN companies at 2026-09-09 04:27Z while the last crawl had run at
  // 2026-09-08 08:00Z — twenty hours EARLIER. Calling those ten failures would have put ten false
  // positives at the top of the alert list on the day they shipped, and an alert list with ten
  // false positives in it is one that gets closed.
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  const crawledAt = now - 20 * HOUR;
  db.prepare(`INSERT INTO company_ats_list (company,ats_type,ats_slug,active,created_at) VALUES
              ('Spotify','lever','spotify',1,?)`).run(now - HOUR);          // added AFTER the crawl
  db.prepare(`INSERT INTO company_ats_list (company,ats_type,ats_slug,active,created_at) VALUES
              ('Retool','lever','retool',1,?)`).run(crawledAt - 30 * 24 * HOUR); // long-standing
  recordPipelineRun(db, {
    runKind: "source_sync", source: "lever", status: "ok", startedAt: crawledAt,
    fetched: 10, written: 10,
  });

  const { body } = await getHealth(db);
  const spotify = body.companies.find(c => c.slug === "spotify");
  assert.equal(spotify.health, "awaiting_first_crawl");
  assert.equal(alertFor(body, "company", "lever/spotify"), undefined,
    "a company that has never had a chance to run must not be reported as a failure");

  // ⛔ AND THE SUPPRESSION MUST NOT BE BLANKET. A company that predates the crawl and still has
  // nothing is the real finding, and it has to survive alongside the exemption.
  assert.equal(body.companies.find(c => c.slug === "retool").health, "no_rows");
  assert.ok(alertFor(body, "company", "lever/retool"),
    "a long-standing company at zero rows is exactly what this panel exists to say");
});

test("per-company stale is suppressed only when the SOURCE already said it", async () => {
  // A stale source makes every company under it stale, which produced one identical warning per
  // slug and buried the per-company findings. But the suppression must not swallow a company that
  // has gone quiet while its source is healthy — that is a per-company finding and nothing else
  // reports it.
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO company_ats_list (company,ats_type,ats_slug,active,created_at) VALUES
              ('Stripe','greenhouse','stripe',1,?), ('Airbnb','greenhouse','airbnb',1,?)`)
    .run(now - 90 * 24 * HOUR, now - 90 * 24 * HOUR);
  // Source is healthy and just wrote. Stripe is current; Airbnb's newest row is 72h old.
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,company,source,discovered_at,is_active,description)
              VALUES ('a','Eng','Stripe','greenhouse',?,1,'text'),
                     ('b','Eng','Airbnb','greenhouse',?,1,'text')`).run(now, now - 72 * HOUR);
  recordPipelineRun(db, {
    runKind: "source_sync", source: "greenhouse", status: "ok", startedAt: now,
    fetched: 2, written: 2,
  });

  const { body } = await getHealth(db);
  assert.equal(sourceNamed(body, "greenhouse").health, "ok", "the source itself is fine");
  assert.equal(alertFor(body, "source", "greenhouse"), undefined);
  assert.equal(body.companies.find(c => c.slug === "airbnb").health, "stale");
  assert.ok(alertFor(body, "company", "greenhouse/airbnb"),
    "one company gone quiet under a healthy source must still alert — nothing else says it");
  assert.equal(alertFor(body, "company", "greenhouse/stripe"), undefined);
});

test("not_configured says which KIND of misconfiguration it is", async () => {
  // The state is reached two ways and they need different words: no API KEY versus no active
  // COMPANIES. One shared sentence told workday, smartrecruiters, workable and recruitee they
  // were missing a key none of them uses. AC item 3 is specifically about not blurring
  // configuration states together.
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  recordPipelineRun(db, {
    runKind: "source_sync", source: "workable", status: "skipped_unconfigured", startedAt: now,
    errorText: "No companies configured for this source",
  });
  const { body } = await getHealth(db);

  const workable = sourceNamed(body, "workable");
  assert.equal(workable.configured, true, "workable's isConfigured() is unconditionally true");
  assert.equal(workable.health, "not_configured");
  assert.match(alertFor(body, "source", "workable").detail, /no active companies/,
    "a source with the key and no companies must not be told to go find a key");

  // And the other branch, on a source whose isConfigured() really is false without its key.
  const saved = process.env.SERPAPI_KEY;
  delete process.env.SERPAPI_KEY;
  try {
    const { body: b2 } = await getHealth(makeDb());
    const serpapi = sourceNamed(b2, "serpapi");
    assert.equal(serpapi.configured, false);
    assert.match(alertFor(b2, "source", "serpapi").detail, /API key is missing/);
  } finally {
    if (saved === undefined) delete process.env.SERPAPI_KEY; else process.env.SERPAPI_KEY = saved;
  }
});

test("per-company health degrades to empty rather than 500ing when the column set is older", async () => {
  // This panel's entire job is to be the thing that notices. It must never be the thing that
  // breaks — a deployment predating company_ats_list.active should lose ONE table, not the view.
  const db = makeDb();
  db.exec("DROP TABLE company_ats_list");
  db.exec("CREATE TABLE company_ats_list (company TEXT, ats_type TEXT, ats_slug TEXT)");
  const { status, body } = await getHealth(db);
  assert.equal(status, 200, "a missing column must not take the whole health view down");
  assert.deepEqual(body.companies, []);
  assert.ok(Array.isArray(body.sources), "every other signal must survive");
  assert.ok(Array.isArray(body.enrichment.coverage));
});
