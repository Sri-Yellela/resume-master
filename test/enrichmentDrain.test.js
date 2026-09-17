// ── The cron was a trickle, and the trickle was the whole daily throughput ──────────────────────
//
// There is no separate enrichment cron. runEnrichment is fired as a side effect inside cacheJobs
// and cacheJoboFeed (aggregator.js), both of which ride the single 04:00 ET tick — so ONE pass of
// ENRICH_BATCH_SIZE was the entire day's work.
//
// Measured against production on 2026-09-13: backlog 847 candidates, inflow ~25-32 rows/day,
// throughput 25/day. The queue drained at about the rate it filled, which is why 837 rows once
// accumulated with nothing surfacing it and why a manual trigger had to be built at all.
//
// drainEnrichment loops until the candidate set is empty or a DAILY BUDGET binds. The budget is
// the point: enrichment previously had no spend ceiling at all — ENRICH_BATCH_SIZE was the only
// bound on what a day could cost — so looping without adding one would have removed the single
// thing standing between a runaway pass and the wallet.
//
// ⛔ EVERY STOP REASON IS TESTED, because a loop whose exits are untested is a loop that runs
// until something else stops it.
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drainEnrichment, enrichBudget } from "../services/jobs/enrichJob.js";

function makeDb(rows = 0) {
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
      enriched_at INTEGER, content_hash TEXT, enrichment_batch_id INTEGER
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
    -- Mirrors the real shapes from server.js. usage_events.cached and company_technographics'
    -- column names (skill / last_seen, not skill_key / last_seen_at) were both wrong first time,
    -- and the failures surfaced as "Enriched 0/5" with five rows whose values had in fact been
    -- written — a fixture defect wearing a product defect's clothes. Worth the note: every column
    -- the enrichment path touches has to be right here, not just the ones under test.
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, event_type TEXT, event_subtype TEXT,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_creation_tokens INTEGER DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0, model TEXT, cost_usd REAL DEFAULT 0,
      ats_score_before INTEGER, ats_score_after INTEGER, duration_ms INTEGER,
      job_id TEXT, company TEXT, success INTEGER NOT NULL DEFAULT 1, error_text TEXT,
      provider TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS usage_tracking_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT, payload_json TEXT, error_text TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS company_technographics (
      company TEXT NOT NULL, skill TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0,
      last_seen INTEGER NOT NULL, posting_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (company, skill)
    );
  `);
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare(`INSERT INTO scraped_jobs
    (job_id, title, company, source, description, discovered_at, scraped_at, updated_at, is_active)
    VALUES (?, ?, 'Acme', 'greenhouse', ?, ?, ?, ?, 1)`);
  for (let i = 0; i < rows; i++) {
    ins.run(`j${i}`, `Engineer ${i}`, `We need someone who knows Python and SQL. Row ${i}.`,
      now - i, now, now);
  }
  return db;
}

/** An Anthropic stub that always extracts one skill, and counts the calls it was asked to make. */
function stubClient({ tokensPerCall = 1000, failAll = false } = {}) {
  const calls = { n: 0 };
  return {
    calls,
    client: {
      messages: {
        create: async () => {
          calls.n++;
          if (failAll) throw new Error("stub: model unavailable");
          return {
            content: [{ text: JSON.stringify({
              summary: "A role.", normalizedTitle: "engineer", experienceLevel: "mid",
              workplaceType: "remote", skillsHard: ["Python"], skillsSoft: [],
              salaryMinUsd: null, salaryMaxUsd: null, salaryPeriod: null,
              isH1bSponsor: null, requiresWorkAuth: null, isClearanceRequired: null, orgUnit: null,
            }) }],
            usage: { input_tokens: tokensPerCall, output_tokens: tokensPerCall },
          };
        },
      },
    },
  };
}

const BIG = { maxRows: 1e6, maxUsd: 1e6, maxMinutes: 1e6 };

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Y2A · STEP ZERO — the description fetch, and why it shares THIS budget
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("the fetch budget is the day's REMAINING rows, which is what makes it ONE budget", async () => {
  // ⛔ THE SUBTRACTION IS THE MECHANISM. Task Y had a budget in the crawl and a budget here,
  // with no way to notice they disagreed — and they could not have agreed even in principle: a
  // crawl wants 1,500 detail requests (Ubisoft 300 + Bosch 900 + Adobe 300, measured) while this
  // ceiling is 300 rows/day, so a crawl-time fetch buys 1,200 descriptions a day that nothing can
  // ever enrich. Asking for exactly `maxRows - alreadyQueued` is what collapses the two.
  const db = makeDb(4);                       // 4 rows already have text, so 4 are already queued
  const { client } = stubClient();
  const asked = [];
  await drainEnrichment(db, client, {
    batchSize: 10, budget: { ...BIG, maxRows: 10 },
    fillDescriptions: async (_db, opts) => { asked.push(opts.limit); return null; },
  });
  assert.deepEqual(asked, [6], "10-row ceiling minus 4 already-enrichable rows");
});

test("a full queue buys NO descriptions, because today could not use them", async () => {
  const db = makeDb(10);
  const { client } = stubClient();
  let called = 0;
  await drainEnrichment(db, client, {
    batchSize: 10, budget: { ...BIG, maxRows: 5 },   // 10 queued against a 5-row day
    fillDescriptions: async () => { called++; return null; },
  });
  assert.equal(called, 0,
    "there is no point owning a description the day's ceiling cannot reach");
});

test("no client means no descriptions are bought either", async () => {
  // Without a client runEnrichment refuses, so a description fetched now would sit unenriched —
  // which is exactly the waste this task removed, relocated one step later.
  const db = makeDb(4);
  let called = 0;
  const r = await drainEnrichment(db, null, {
    batchSize: 10, budget: { ...BIG, maxRows: 10 },
    fillDescriptions: async () => { called++; return null; },
  });
  assert.equal(called, 0);
  assert.equal(r.ran, false, "and the drain must still report that it did not run");
});

test("the drain reports the detail fetch as COVERAGE, and passes it through", async () => {
  const db = makeDb(2);
  const { client } = stubClient();
  const r = await drainEnrichment(db, client, {
    batchSize: 10, budget: { ...BIG, maxRows: 10 },
    fillDescriptions: async () => ({
      enabled: true, selected: 3, attempted: 3, withText: 2, failed: 1,
      byReason: { no_text: 1 }, describedBefore: 0, describedAfter: 2, coverageDelta: 2,
      prioritised: 1, throttledSources: [],
    }),
  });
  assert.equal(r.detail.coverageDelta, 2);
  const run = db.prepare("SELECT details_json FROM pipeline_runs WHERE run_kind='enrichment' ORDER BY id DESC LIMIT 1").get();
  const details = JSON.parse(run.details_json);
  assert.equal(details.detailFetch.coverageDelta, 2);
  assert.equal(details.detailFetch.attempted, 3,
    "requests spent and descriptions gained are both recorded, because they are different numbers");
});

test("the drain LOOPS past one batch — the defect was that it never did", async () => {
  const db = makeDb(12);
  const { client, calls } = stubClient();
  const r = await drainEnrichment(db, client, { batchSize: 5, budget: BIG });

  assert.equal(r.stopReason, "drained", "it must empty the queue, not stop after one bite");
  assert.ok(r.passes >= 3, `12 rows at batchSize 5 needs 3+ passes, got ${r.passes}`);
  assert.equal(r.enriched, 12, "every candidate must be enriched");
  assert.equal(calls.n, 12, "one model call per row");
  assert.equal(r.remainingCandidates, 0, "the queue must actually be empty at the end");
});

test("a single pass of the old size would have left the rest queued", async () => {
  // The counterfactual, so the fix is measured rather than asserted. batchSize 5, budget 5.
  const db = makeDb(12);
  const { client } = stubClient();
  const r = await drainEnrichment(db, client, { batchSize: 5, budget: { ...BIG, maxRows: 5 } });
  assert.equal(r.enriched, 5);
  assert.equal(r.stopReason, "max_rows");
  assert.equal(r.remainingCandidates, 7, "this is the trickle, reported rather than hidden");
});

test("STOP: max_rows binds, and the last pass does not overshoot it", async () => {
  // 7 is deliberately not a multiple of batchSize 5: a loop that asks for a full batch every time
  // would enrich 10 and blow through the budget by 3.
  const db = makeDb(20);
  const { client, calls } = stubClient();
  const r = await drainEnrichment(db, client, { batchSize: 5, budget: { ...BIG, maxRows: 7 } });

  assert.equal(r.stopReason, "max_rows");
  assert.equal(r.enriched, 7, "the budget is a ceiling, not a rounding hint");
  assert.equal(calls.n, 7, "and no row is PAID FOR beyond the ceiling either");
});

test("STOP: max_usd binds on spend, independently of the row count", async () => {
  // Each call is priced at 1M input + 1M output tokens = $1 + $5 = $6, so one pass of 2 rows
  // already exceeds a $1 ceiling. Rows alone would not have stopped this.
  const db = makeDb(20);
  const { client } = stubClient({ tokensPerCall: 1e6 });
  const r = await drainEnrichment(db, client, { batchSize: 2, budget: { ...BIG, maxUsd: 1.0 } });

  assert.equal(r.stopReason, "max_usd");
  assert.ok(r.enriched < 20, "it must not have drained the queue");
  assert.ok(r.estCostUsd >= 1.0, `spend must have reached the ceiling, got ${r.estCostUsd}`);
});

test("STOP: max_minutes binds on wall clock, for a pass that is merely slow", async () => {
  // Clock injected rather than slept: a test that takes 20 real minutes is a test nobody runs.
  const db = makeDb(20);
  const { client } = stubClient();
  let t = 0;
  const r = await drainEnrichment(db, client, {
    batchSize: 2, budget: { ...BIG, maxMinutes: 5 },
    now: () => { t += 2 * 60000; return t; },        // two minutes per check
  });
  assert.equal(r.stopReason, "max_minutes");
  assert.ok(r.enriched < 20);
});

test("STOP: no_progress, so a failing model cannot be paid for in a loop", async () => {
  // ⛔ THE EXPENSIVE FAILURE. During the retired-model-id outage every call failed for three days
  // at 25 rows a day. Without this exit a drain would retry until the budget ran out and bill for
  // every attempt — the same outage at 12x the cost.
  const db = makeDb(50);
  const { client, calls } = stubClient({ failAll: true });
  const r = await drainEnrichment(db, client, { batchSize: 5, budget: BIG });

  assert.equal(r.stopReason, "no_progress");
  assert.equal(r.enriched, 0);
  assert.equal(r.passes, 1, "it must give up after the FIRST fruitless pass, not keep paying");
  assert.equal(calls.n, 5, "exactly one batch was attempted");
});

test("STOP: drained is reported when there was nothing to do at all", async () => {
  const db = makeDb(0);
  const { client, calls } = stubClient();
  const r = await drainEnrichment(db, client, { batchSize: 5, budget: BIG });
  assert.equal(r.stopReason, "drained");
  assert.equal(r.enriched, 0);
  assert.equal(calls.n, 0, "an empty queue must cost nothing");
  assert.equal(r.ran, true, "and it DID run — zeros mean 'nothing to do' only when ran is true");
});

test("an unconfigured client is a refusal, not a completed drain", async () => {
  const db = makeDb(5);
  const r = await drainEnrichment(db, null, { batchSize: 5, budget: BIG });
  assert.equal(r.stopReason, "refused");
  assert.equal(r.skippedReason, "unconfigured");
  assert.equal(r.ran, false, "this pipeline's signature defect is success-shaped output over nothing");
  // Jobo's shape: a provider that never ran while everything downstream reported zeros. It MUST
  // leave a record, or it is invisible exactly the way Jobo was.
  const run = db.prepare("SELECT * FROM pipeline_runs WHERE run_kind='enrichment'").get();
  assert.ok(run, "an unconfigured drain must still record a run");
  assert.equal(run.status, "skipped_unconfigured");
});

test("coverage is reported PER COLUMN, because a row count cannot tell you it worked", async () => {
  // "enriched: 300" is compatible with 300 rows of nulls — task A2 saw 49 of 50 HTTP 200s return
  // an empty extraction.
  const db = makeDb(6);
  const { client } = stubClient();
  const r = await drainEnrichment(db, client, { batchSize: 3, budget: BIG });

  assert.equal(r.coverageGains.skills_json, 6, "skills_json must have climbed by every row");
  assert.equal(r.coverageGains.summary, 6);
  assert.ok(r.coverageBefore.columns.skills_json.filled === 0);
  assert.ok(r.coverageAfter.columns.skills_json.filled === 6);
});

test("ONE pipeline_runs record for the whole drain, carrying the day's totals", async () => {
  // Ten records a day would push the real history out of the recent-runs view, and the number an
  // operator needs is what the DAY achieved. Per-pass detail lives in enrichment_batches.
  const db = makeDb(12);
  const { client } = stubClient();
  const r = await drainEnrichment(db, client, { batchSize: 5, budget: BIG });

  const runs = db.prepare("SELECT * FROM pipeline_runs WHERE run_kind='enrichment'").all();
  assert.equal(runs.length, 1, `expected one aggregate run, got ${runs.length}`);
  assert.equal(runs[0].written, 12, "and it reports the drain's total, not the last pass's");
  const details = JSON.parse(runs[0].details_json);
  assert.equal(details.passes, r.passes);
  assert.equal(details.stopReason, "drained");
  assert.equal(details.remainingCandidates, 0);
  assert.ok(details.budget, "the budget in force must be recorded with the run that obeyed it");
});

test("an OVERLAPPED drain records nothing, or the panel alarms every single day", async () => {
  // cacheJobs and cacheJoboFeed both schedule a drain in the same 04:00 tick, so the second is
  // routinely refused while the first is still working. Recording that would write a
  // failed-looking enrichment run daily, and the AC health check alerts on exactly that shape —
  // a permanent false alarm, which is an alarm nobody reads.
  const db = makeDb(40);
  const { client } = stubClient();
  const first = drainEnrichment(db, client, { batchSize: 2, budget: BIG });
  const second = await drainEnrichment(db, client, { batchSize: 2, budget: BIG });
  await first;

  assert.equal(second.stopReason, "refused");
  assert.equal(second.skippedReason, "already_running");
  const runs = db.prepare("SELECT * FROM pipeline_runs WHERE run_kind='enrichment'").all();
  assert.equal(runs.length, 1, "only the drain that actually ran may record");
  assert.equal(runs[0].status, "ok");
});

test("the budget comes from the environment, with the measured defaults", async () => {
  const saved = { ...process.env };
  try {
    delete process.env.ENRICH_DAILY_MAX_ROWS;
    delete process.env.ENRICH_DAILY_MAX_USD;
    delete process.env.ENRICH_MAX_RUN_MINUTES;
    // Sized against measured production numbers: ~$0.002/row and ~2.8s/row, so 300 rows is ~$0.60
    // and ~14 minutes — inside all three bounds rather than merely under one of them.
    assert.deepEqual(enrichBudget(), { maxRows: 300, maxUsd: 1.0, maxMinutes: 20 });

    process.env.ENRICH_DAILY_MAX_ROWS = "50";
    process.env.ENRICH_DAILY_MAX_USD = "0.25";
    process.env.ENRICH_MAX_RUN_MINUTES = "3";
    assert.deepEqual(enrichBudget(), { maxRows: 50, maxUsd: 0.25, maxMinutes: 3 });

    // A nonsense value must fall back to the default rather than become 0 — a 0 budget would stop
    // enrichment dead, silently, which is the failure this whole task is about.
    process.env.ENRICH_DAILY_MAX_ROWS = "not-a-number";
    assert.equal(enrichBudget().maxRows, 300);
  } finally {
    for (const k of ["ENRICH_DAILY_MAX_ROWS", "ENRICH_DAILY_MAX_USD", "ENRICH_MAX_RUN_MINUTES"]) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});
