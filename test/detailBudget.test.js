// THE BOUND ON THE DETAIL FETCH — the primitive, not the pass.
//
// The pass and its write invariants live in test/detailFetch.test.js. This file covers the
// allowance itself: the two caps, the refusal counting, the env parsing and the concurrency runner.
//
// ⛔ WHAT THIS FILE USED TO TEST AND NO LONGER CAN. Task Y's version asserted that the budget was
// OFF BY DEFAULT (`total: 0`) and that `attachDescriptions` spent it inside each plugin's crawl.
// Both are gone: the fetch moved into the enrichment pass, `attachDescriptions` was deleted, and
// the default is no longer zero. That is not a loosening, and the reasoning is worth keeping here
// because a future reader will notice the assertion disappear:
//
//   Off-by-default was RIGHT for a crawl-time fetch. "Off" had to mean zero outbound requests to
//   Ubisoft, Bosch and Adobe, because a daily cron that quietly starts making hundreds of
//   third-party requests is not a conservative default.
//
//   It is WRONG for the enrichment-side fetch, because the capability and the sources are separate
//   switches and the SOURCES are the ones that are off — all three companies are `active = 0` in
//   company_ats_list, so nothing is ingested from them and the selector finds no description-less
//   rows to act on. An enabled allowance over an empty candidate set makes exactly zero requests;
//   that is proved in detailFetch.test.js ("rows that already have text are never selected") and
//   is a property of the SELECTOR, which is where it belongs. Keeping `total: 0` would have meant
//   that enabling a source later ALSO silently required finding a second unrelated flag.
//
// The replacement guarantee — one kill switch, and it works — is the first test below.

import test from "node:test";
import assert from "node:assert/strict";
import {
  createDetailBudget, detailFetchFromEnv, mapWithConcurrency, DETAIL_FETCH_DEFAULTS,
} from "../services/jobs/detailBudget.js";

test("ENRICH_DETAIL_FETCH=0 is one kill switch and it zeroes the allowance", () => {
  for (const off of ["0", "false", "off", "no", "OFF", " 0 "]) {
    assert.equal(detailFetchFromEnv({ ENRICH_DETAIL_FETCH: off }).total, 0, String(off));
    assert.equal(createDetailBudget(detailFetchFromEnv({ ENRICH_DETAIL_FETCH: off })).enabled, false);
  }
  // Anything else is not a kill switch, including the empty string — "I could not read the
  // setting" must not silently become "make no requests", which is a different decision.
  for (const on of ["", "1", "true", undefined, null, "yes"]) {
    assert.equal(detailFetchFromEnv({ ENRICH_DETAIL_FETCH: on }).total,
      DETAIL_FETCH_DEFAULTS.total, String(on));
  }
});

test("an unparseable knob falls back to the MEASURED default, never to zero", () => {
  // The distinction this pins: a typo in ENRICH_DETAIL_MAX_ROWS must not disable the feature. The
  // old crawl-time parser deliberately read a bad value as OFF; here OFF has its own switch, so
  // reading a bad value as zero would be a silent outage with no operator behind it.
  for (const bad of ["", "abc", "-5", "NaN", undefined, null]) {
    const cfg = detailFetchFromEnv({ ENRICH_DETAIL_MAX_ROWS: bad });
    assert.equal(cfg.total, DETAIL_FETCH_DEFAULTS.total, String(bad));
  }
  assert.equal(detailFetchFromEnv({ ENRICH_DETAIL_MAX_ROWS: "42" }).total, 42);
  assert.equal(detailFetchFromEnv({ ENRICH_DETAIL_MAX_ROWS: "0" }).total, 0,
    "an explicit 0 IS a decision and must be honoured");
});

test("a zero concurrency or attempt cap is a broken value, not a decision", () => {
  // These two differ from `total` on purpose. A 0 total means "fetch nothing this pass", which is
  // a thing somebody might mean. A 0 concurrency leaves mapWithConcurrency with an empty runner
  // pool and a 0 attempt cap makes every row permanently ineligible — both silent, neither
  // anything anyone wants, and "turn it off" already has its own switch. So they fall back.
  const cfg = detailFetchFromEnv({ ENRICH_DETAIL_CONCURRENCY: "0", ENRICH_DETAIL_MAX_ATTEMPTS: "0" });
  assert.equal(cfg.concurrency, DETAIL_FETCH_DEFAULTS.concurrency);
  assert.equal(cfg.maxAttempts, DETAIL_FETCH_DEFAULTS.maxAttempts);
  assert.equal(detailFetchFromEnv({ ENRICH_DETAIL_CONCURRENCY: "-3" }).concurrency,
    DETAIL_FETCH_DEFAULTS.concurrency);
  // A real override still lands.
  assert.equal(detailFetchFromEnv({ ENRICH_DETAIL_CONCURRENCY: "4" }).concurrency, 4);
});

test("the default concurrency is Workday's MEASURED knee, not a guess", () => {
  // Phase 1: zero 429s from either API in 124 requests at up to 32 concurrent, and no
  // RateLimit-*/Retry-After header exists on either to read. The one thing that showed a limit was
  // Workday's backpressure — throughput plateaus near 8 while tail latency triples (584ms ->
  // 1882ms). This project has already paid for pacing on a guess once: it paced Groq on 30
  // requests/minute against a binding limit of 8,000 TOKENS/minute.
  assert.equal(DETAIL_FETCH_DEFAULTS.concurrency, 8);
});

test("the total bounds the pass and the per-company cap bounds one company", () => {
  const budget = createDetailBudget({ total: 5, perCompany: 2 });
  const taken = [];
  for (const co of ["A", "A", "A", "A", "B", "B", "B", "B"]) {
    taken.push(budget.take(co));
  }
  const report = budget.report(4);
  assert.equal(report.spent, 4, "2 per company across two companies, under the total of 5");
  assert.deepEqual(report.byCompany, { A: 2, B: 2 });
  assert.equal(report.skipped, 4, "the refusals must be COUNTED, not silent");
  assert.equal(taken.filter(Boolean).length, 4);
});

test("the total wins when it is the tighter of the two", () => {
  const budget = createDetailBudget({ total: 3, perCompany: 10 });
  for (let i = 0; i < 8; i++) budget.take("A");
  const report = budget.report(3);
  assert.equal(report.spent, 3);
  assert.equal(report.skipped, 5);
  assert.equal(budget.remaining, 0);
});

test("a refusal is counted rather than silent, which is the whole point", () => {
  // ⛔ A budget that silently declines is indistinguishable from a source that has no descriptions
  // — which is the exact state this task exists to fix, so the fix must not be able to imitate it.
  const budget = createDetailBudget({ total: 0 });
  assert.equal(budget.take("A"), false);
  assert.equal(budget.report(0).skipped, 1);
  assert.equal(budget.report(0).enabled, false);
});

test("coverage is reported separately from spend, because they are different numbers", () => {
  // `spent: 4` is true whether four rows gained text or zero did — the standing "report coverage,
  // not counts" lesson. The budget cannot know, so the caller supplies it.
  const budget = createDetailBudget({ total: 10 });
  for (let i = 0; i < 4; i++) budget.take("A");
  assert.equal(budget.report(2).spent, 4);
  assert.equal(budget.report(2).withText, 2);
});

test("concurrency is respected, so a pass cannot stampede a third party", async () => {
  let inFlight = 0, peak = 0;
  await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
  });
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded the limit`);
});

test("one rejecting worker does not abort the rest of the pass", async () => {
  // The list row is already good and a missing description is the status quo, not a regression —
  // so one posting's failure must never cost the other 299 their fetch.
  const done = [];
  await mapWithConcurrency([0, 1, 2, 3, 4], 2, async (i) => {
    if (i === 2) throw new Error("third-party 500");
    done.push(i);
  });
  assert.deepEqual(done.sort(), [0, 1, 3, 4]);
});

test("the crawl-time env vars are gone from the parser, not merely unread", () => {
  // ATS_DETAIL_FETCH_BUDGET and friends configured a path that no longer exists. Leaving them
  // parseable would be a lever that appears to work and does nothing — the shape of
  // `_ghCompanies`, which capped live search at three of seven sources invisibly.
  const cfg = detailFetchFromEnv({
    ATS_DETAIL_FETCH_BUDGET: "999",
    ATS_DETAIL_FETCH_PER_COMPANY: "999",
    ATS_DETAIL_FETCH_CONCURRENCY: "999",
    ATS_DETAIL_FETCH_TIMEOUT_MS: "999",
  });
  assert.deepEqual(cfg, {
    total: DETAIL_FETCH_DEFAULTS.total,
    perCompany: DETAIL_FETCH_DEFAULTS.perCompany,
    concurrency: DETAIL_FETCH_DEFAULTS.concurrency,
    timeoutMs: DETAIL_FETCH_DEFAULTS.timeoutMs,
    maxAttempts: DETAIL_FETCH_DEFAULTS.maxAttempts,
  }, "a retired env var must have no effect at all");
});
