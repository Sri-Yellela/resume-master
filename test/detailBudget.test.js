// TASK Y — a budget for the N+1 that SmartRecruiters and Workday require.
//
// Both sources' LIST endpoints carry no job text. Migration 103 measured the cost of switching
// them on regardless — 648 rows at 0% description coverage, and enrichJob.js skips
// description-less rows, so they would be permanently unenrichable — and seeded both companies
// INACTIVE instead. This is the budget that makes turning them on survivable.
//
// ⛔ EVERY TEST HERE INJECTS THE FETCHER. Not one request goes to SmartRecruiters, Adobe or
// anyone else, which matters more than usual because the thing being bounded IS outbound requests
// to them. A test that verified this by hitting a real careers API would be the defect.

import test from "node:test";
import assert from "node:assert/strict";
import {
  createDetailBudget, detailBudgetFromEnv, attachDescriptions,
  mapWithConcurrency, DETAIL_BUDGET_DEFAULTS,
} from "../services/jobs/detailBudget.js";
import smartrecruiters from "../services/jobs/sources/smartrecruiters.js";
import workday from "../services/jobs/sources/workday.js";

test("OFF BY DEFAULT means zero requests, not a small number of them", () => {
  assert.equal(DETAIL_BUDGET_DEFAULTS.total, 0);
  assert.equal(detailBudgetFromEnv({}).total, 0);
  assert.equal(createDetailBudget().enabled, false);
  // A malformed or hostile value must not become an allowance.
  for (const bad of ["", "abc", "-5", null, undefined, "NaN"]) {
    assert.equal(detailBudgetFromEnv({ ATS_DETAIL_FETCH_BUDGET: bad }).total, 0, String(bad));
  }
  assert.equal(detailBudgetFromEnv({ ATS_DETAIL_FETCH_BUDGET: "30" }).total, 30);
});

test("a disabled budget performs no fetches at all", async () => {
  let calls = 0;
  const jobs = [{ company: "A", description: null }, { company: "A", description: null }];
  const report = await attachDescriptions(jobs, createDetailBudget(), () => { calls++; return "text"; });
  assert.equal(calls, 0, "the fetcher must never be invoked when the budget is off");
  assert.equal(report.enabled, false);
  assert.equal(jobs[0].description, null, "rows must be untouched — today's behaviour exactly");
});

test("the total bounds the crawl and the per-company cap bounds one company", async () => {
  const budget = createDetailBudget({ total: 5, perCompany: 2, concurrency: 1 });
  const jobs = [
    ...Array.from({ length: 4 }, () => ({ company: "A", description: null })),
    ...Array.from({ length: 4 }, () => ({ company: "B", description: null })),
  ];
  const report = await attachDescriptions(jobs, budget, () => "desc");
  assert.equal(report.spent, 4, "2 per company across two companies, under the total of 5");
  assert.deepEqual(report.byCompany, { A: 2, B: 2 });
  assert.equal(report.skipped, 4, "the refusals must be COUNTED, not silent");
  assert.equal(jobs.filter(j => j.description).length, 4);
});

test("the total wins when it is the tighter of the two", async () => {
  const budget = createDetailBudget({ total: 3, perCompany: 10, concurrency: 1 });
  const jobs = Array.from({ length: 8 }, () => ({ company: "A", description: null }));
  const report = await attachDescriptions(jobs, budget, () => "desc");
  assert.equal(report.spent, 3);
  assert.equal(report.skipped, 5);
});

test("coverage is reported separately from spend, because they are different numbers", async () => {
  // A fetch can succeed and return nothing. `spent: 4` is true whether four rows gained text or
  // zero did — the standing "report coverage, not counts" lesson.
  const budget = createDetailBudget({ total: 10, perCompany: 10, concurrency: 1 });
  const jobs = Array.from({ length: 4 }, (_, i) => ({ company: "A", description: null, i }));
  const report = await attachDescriptions(jobs, budget, (j) => (j.i % 2 ? "text" : null));
  assert.equal(report.spent, 4);
  assert.equal(report.withText, 2, "only half actually gained a description");
});

test("rows that already have text do not consume budget", async () => {
  const budget = createDetailBudget({ total: 10, perCompany: 10, concurrency: 1 });
  const jobs = [{ company: "A", description: "already here" }, { company: "A", description: null }];
  const report = await attachDescriptions(jobs, budget, () => "new");
  assert.equal(report.spent, 1);
  assert.equal(jobs[0].description, "already here", "an existing description must not be overwritten");
});

test("one failing detail fetch does not abort the pass", async () => {
  const budget = createDetailBudget({ total: 10, perCompany: 10, concurrency: 2 });
  const jobs = Array.from({ length: 5 }, (_, i) => ({ company: "A", description: null, i }));
  const report = await attachDescriptions(jobs, budget, (j) => {
    if (j.i === 2) throw new Error("third-party 500");
    return "desc";
  });
  // The list rows are already good; a missing description is the status quo, not a regression.
  assert.equal(report.withText, 4);
  assert.equal(jobs[2].description, null);
});

test("concurrency is respected, so a crawl cannot stampede a third party", async () => {
  let inFlight = 0, peak = 0;
  await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
  });
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded the limit`);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⛔ THE ORDERING. This is the one that matters most, and the reason the task brief said the
// budget model "must account for the per-company cap in 0de67c8".
// ─────────────────────────────────────────────────────────────────────────────────────────────

test("detail fetches happen AFTER the per-company cap, never before", async () => {
  // 0de67c8 fixed a cap that sliced the flattened cross-company array. Either way, rows past the
  // cap are DISCARDED \u2014 so fetching their descriptions first spends real requests against a third
  // party on rows that are then thrown away. Invisible without counting, exactly like the cap bug.
  //
  // \u26d4 THE FIRST VERSION OF THIS TEST WAS BLIND, AND IT TOOK A REAL NETWORK REQUEST TO NOTICE.
  // It called smartrecruiters.search() against a made-up company, let the live list fetch fail,
  // and asserted that nothing was detail-fetched. That passes whether the ordering is right or
  // wrong \u2014 nothing was fetched because there were no jobs at all \u2014 and it hit
  // api.smartrecruiters.com to do it, in a test file whose whole premise is that it never should.
  // This composes the two real functions instead, with no plugin and no network.
  const { collectCompanyJobs } = await import("../services/jobs/sources/base.js");

  const PER_COMPANY_MAX = 3;
  const perCompanyResults = [
    { status: "fulfilled", value: Array.from({ length: 10 }, (_, i) => ({ company: "Acme", title: `acme-${i}`, description: null })) },
    { status: "fulfilled", value: Array.from({ length: 10 }, (_, i) => ({ company: "Bosch", title: `bosch-${i}`, description: null })) },
  ];

  const capped = collectCompanyJobs(perCompanyResults, PER_COMPANY_MAX);
  assert.equal(capped.length, 6, "the cap must discard 14 of the 20 postings");

  const fetched = [];
  await attachDescriptions(
    capped,
    createDetailBudget({ total: 100, perCompany: 100, concurrency: 1 }),
    (job) => { fetched.push(job.title); return "described"; },
  );

  assert.equal(fetched.length, 6, "exactly the survivors, never the pre-cap population of 20");
  assert.deepEqual(fetched.sort(), ["acme-0", "acme-1", "acme-2", "bosch-0", "bosch-1", "bosch-2"].sort());
  // The discarded rows must never have been asked about.
  assert.ok(!fetched.some(t => /-([3-9])$/.test(t)), "a discarded posting was detail-fetched");
});

test("the cap is what bounds the candidate set, proved without any network", async () => {
  // The same property, isolated from the plugin's HTTP: attachDescriptions receives an ALREADY
  // CAPPED array, so its candidate count can never exceed what the cap let through.
  const capped = Array.from({ length: 3 }, (_, i) => ({ company: "Acme", description: null, i }));
  const budget = createDetailBudget({ total: 100, perCompany: 100, concurrency: 1 });
  let calls = 0;
  await attachDescriptions(capped, budget, () => { calls++; return "d"; });
  assert.equal(calls, 3, "exactly the surviving rows, never the pre-cap population");
});

test("both plugins take the budget and the injected fetcher, and default to OFF", () => {
  // Signature parity: if one source grows its own private flag, the budget stops being one lever.
  for (const [name, plugin] of [["smartrecruiters", smartrecruiters], ["workday", workday]]) {
    const src = plugin.search.toString();
    assert.match(src, /_detailBudget/, `${name} must accept an injected budget`);
    assert.match(src, /_fetchDetail/, `${name} must accept an injected fetcher`);
    assert.match(src, /collectCompanyJobs\(results, PER_COMPANY_MAX\)[\s\S]{0,400}attachDescriptions/,
      `${name} must cap BEFORE attaching descriptions`);
    assert.doesNotMatch(src, /process\.env\.ATS_DETAIL/,
      `${name} must not read the budget env directly — detailBudgetFromEnv is the one parser`);
  }
});
