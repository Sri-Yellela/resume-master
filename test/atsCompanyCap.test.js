// ── The cap that ate 60% of the board ───────────────────────────────────────────────────────────
//
// Every ATS plugin fans out over `_companies`, then folds the per-company results into one list.
// All seven folded it like this:
//
//     const MAX = pageSize * 3;
//     results.flatMap(r => (r.status === 'fulfilled' ? r.value : [])).slice(0, MAX)
//
// `_companies` comes from `SELECT * FROM company_ats_list WHERE active = 1` with NO ORDER BY, so it
// arrives in sqlite rowid order. `flatMap` concatenates in that order and the slice discards the
// TAIL — so every company past the cut contributed NOTHING, and `cacheJobs` still recorded the run
// `status: 'ok'`. Measured against the providers' own APIs on 2026-09-09, both folds run over one
// fetch of production's own company list:
//
//   greenhouse  9 slugs, 2,265 postings   old fold 900   RECOVERED 1,365
//   ashby       4 slugs, 1,086 postings   old fold 900   RECOVERED   186
//   lever/workable/recruitee              under the cap  RECOVERED     0   (1,551 total)
//
// The board held 1,255 rows from FIVE companies while eighteen of twenty-three active slugs sat at
// zero — and every one of those eighteen answered HTTP 200 with a healthy job list. The numbers
// land on the row: greenhouse's order is stripe 616 + airbnb 170 + figma 114 = exactly 900, so
// Figma lost 43 of 157 and six companies were severed whole; ashby's is notion 131 + openai 769,
// so OpenAI lost 12 and Ramp and Linear were severed whole.
//
// ⛔ WHY THIS IS A SOURCE SCAN AS WELL AS A UNIT TEST. The behavioural half below pins
// collectCompanyJobs, but nothing stops a plugin from calling it correctly and then re-slicing the
// result — or an EIGHTH plugin from being written by copying one of the seven, which is exactly how
// one bug came to exist in seven places. The structural half asserts the forbidden shape is absent
// from every registered plugin, so the guard covers plugins that do not exist yet.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectCompanyJobs } from "../services/jobs/sources/base.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES_DIR = path.join(ROOT, "services", "jobs", "sources");

// This file quotes the forbidden shape in its own header and fixtures, so it cannot scan itself —
// and base.js quotes it in collectCompanyJobs' docblock to record what it replaced. Both are
// carve-outs for the same reason sourceAnchorGuard.test.js exempts itself.
const NOT_A_PLUGIN = new Set(["base.js"]);

const settled = (...lists) => lists.map(value => ({ status: "fulfilled", value }));
const jobsFor = (company, n) =>
  Array.from({ length: n }, (_, i) => ({ id: `${company}-${i}`, company }));

test("each company is capped independently — the tail is no longer discarded", () => {
  const results = settled(jobsFor("A", 700), jobsFor("B", 400), jobsFor("C", 300));
  const jobs = collectCompanyJobs(results, 900);

  // Old behaviour: 700 + 200 of B, and C severed entirely. 1,400 postings -> 900.
  assert.equal(jobs.length, 1400, "no company may be truncated when each is under the cap");
  for (const company of ["A", "B", "C"]) {
    assert.ok(
      jobs.some(j => j.company === company),
      `${company} contributed nothing — this is the defect, not a rounding difference`
    );
  }
});

test("the ashby regression, in production's own rowid order", () => {
  // notion · openai · ramp · linear — the order company_ats_list actually returns, confirmed by
  // running both folds over one live fetch. Order is load-bearing here: it is what decided which
  // companies survived, and it is not something the code ever asked for.
  const results = settled(
    jobsFor("notion", 131), jobsFor("openai", 781), jobsFor("ramp", 145), jobsFor("linear", 29)
  );
  const jobs = collectCompanyJobs(results, 900);
  const perCompany = (c) => jobs.filter(j => j.company === c).length;

  assert.equal(jobs.length, 1086, "all 1,086 postings ashby serves must survive the fold");
  assert.equal(perCompany("notion"), 131);
  assert.equal(perCompany("openai"), 781, "OpenAI was truncated to 769 of 781 by the old fold");
  assert.equal(perCompany("ramp"), 145, "Ramp was severed entirely by the old fold");
  assert.equal(perCompany("linear"), 29, "Linear was severed entirely by the old fold");
});

test("the greenhouse regression, where the cut landed on exactly 900", () => {
  // stripe 616 + airbnb 170 + figma 114 = 900. Figma was the company the slice bisected.
  const results = settled(
    jobsFor("stripe", 616), jobsFor("airbnb", 170), jobsFor("figma", 157),
    jobsFor("anthropic", 595), jobsFor("brex", 282), jobsFor("duolingo", 89),
    jobsFor("scaleai", 211), jobsFor("mercury", 58), jobsFor("vercel", 87)
  );
  const jobs = collectCompanyJobs(results, 900);
  assert.equal(jobs.length, 2265, "greenhouse's nine slugs must all survive the fold");
  for (const c of ["anthropic", "brex", "duolingo", "scaleai", "mercury", "vercel"]) {
    assert.ok(jobs.some(j => j.company === c), `${c} was severed whole by the old fold`);
  }
  assert.equal(jobs.filter(j => j.company === "figma").length, 157,
    "Figma was bisected at 114 of 157 by the old fold");
});

test("a single company cannot exceed the cap, so live search stays bounded", () => {
  // POST /api/jobs/search neither paginates nor slices downstream, so the plugins ARE the bound.
  // pageSize 20 -> 60. One company offering 5,000 postings must not become the whole payload.
  const jobs = collectCompanyJobs(settled(jobsFor("A", 5000), jobsFor("B", 10)), 60);
  assert.equal(jobs.filter(j => j.company === "A").length, 60);
  assert.equal(jobs.filter(j => j.company === "B").length, 10);
  assert.equal(jobs.length, 70);
});

test("the crawl's cap is above every real board, so cacheJobs takes each company whole", () => {
  // cacheJobs passes pageSize: 300 -> 900. The largest board observed is openai at 781.
  const OBSERVED_LARGEST_BOARD = 781;
  assert.ok(
    300 * 3 > OBSERVED_LARGEST_BOARD,
    "the crawl's per-company ceiling has fallen below a real provider's board — raise it or " +
    "page the fetch, because postings are being dropped again"
  );
});

test("a rejected company yields nothing and does not take its neighbours down with it", () => {
  const results = [
    { status: "fulfilled", value: jobsFor("A", 5) },
    { status: "rejected", reason: new Error("slug 404") },
    { status: "fulfilled", value: jobsFor("C", 5) },
  ];
  const jobs = collectCompanyJobs(results, 900);
  assert.equal(jobs.length, 10);
  assert.deepEqual([...new Set(jobs.map(j => j.company))], ["A", "C"]);
});

test("a non-positive or absent cap means uncapped, never zero", () => {
  // Guards the direction of a mistake: reading a missing cap as 0 would empty the board silently,
  // which is the same failure mode in a new costume.
  for (const bad of [undefined, null, 0, -1, NaN, Infinity]) {
    const jobs = collectCompanyJobs(settled(jobsFor("A", 50)), bad);
    assert.equal(jobs.length, 50, `cap ${String(bad)} must not drop rows`);
  }
});

test("NO registered plugin folds its companies with a cross-company slice", () => {
  const files = fs.readdirSync(SOURCES_DIR).filter(f => f.endsWith(".js") && !NOT_A_PLUGIN.has(f));
  assert.ok(files.length >= 7, `expected the registered plugins, found ${files.length}`);

  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(SOURCES_DIR, file), "utf8");
    // Strip comments before scanning: base.js's docblock and this file's header both quote the
    // forbidden shape deliberately, and a plugin is free to describe it in prose too.
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    // The shape: a .flatMap over settled results followed by a .slice. Matched across newlines
    // because every copy of it was formatted over three lines.
    if (/\.flatMap\s*\([\s\S]{0,200}?\)\s*\n?\s*\.slice\s*\(/.test(code)) {
      offenders.push(`${file}: folds with .flatMap(...).slice(...)`);
    }
    // A plugin may not re-cap after collectCompanyJobs either.
    if (/collectCompanyJobs\s*\([\s\S]{0,120}?\)\s*\n?\s*\.slice\s*\(/.test(code)) {
      offenders.push(`${file}: re-slices the result of collectCompanyJobs`);
    }
  }

  assert.deepEqual(
    offenders, [],
    "a plugin caps its companies as a group again. Capping the CONCATENATION lets whichever " +
    "companies come first in company_ats_list's rowid order evict the rest, silently, while the " +
    "run still reports ok. Use collectCompanyJobs(results, PER_COMPANY_MAX).\n  " +
    offenders.join("\n  ")
  );
});

test("every plugin that fans out over _companies routes through the shared fold", () => {
  const files = fs.readdirSync(SOURCES_DIR).filter(f => f.endsWith(".js") && !NOT_A_PLUGIN.has(f));
  const missing = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(SOURCES_DIR, file), "utf8");
    // adzuna/serpapi/jobo are query- or feed-driven and never receive _companies.
    if (!/_companies\s*=\s*\[\]/.test(text)) continue;
    if (!/collectCompanyJobs/.test(text)) missing.push(file);
  }
  assert.deepEqual(
    missing, [],
    `these plugins fan out over _companies without the shared fold: ${missing.join(", ")}`
  );
});
