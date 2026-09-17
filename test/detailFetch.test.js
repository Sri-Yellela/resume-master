// TASK Y PHASE 2 — the detail fetch, its writes, and the invariants that keep a half-succeeded
// fetch from looking like a finished row.
//
// ⛔ EVERY TEST HERE INJECTS THE TRANSPORT. Not one request goes to SmartRecruiters, Adobe, Bosch
// or Ubisoft. That matters more than usual because the thing being exercised IS outbound requests
// to them, and Phase 1 already spent the real ones (deliberately, once, and it is written down in
// docs/DETAIL_FETCH_PHASE1_FINDINGS.md so nobody has to spend them again).
//
// The fixtures below are shaped from the REAL Phase 1 responses, not invented: SmartRecruiters'
// four named jobAd sections, Workday's single ld+json JobPosting block with `employmentType`, and
// the exact URL spellings both sources actually serve.

import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  fetchDescription, fillMissingDescriptions, persistDetailOutcome,
  titleUnionPriority, hasDetailFetcher, DETAIL_FETCH_SOURCES, _resetColumnCache,
} from "../services/jobs/detailFetch.js";
import { computeContentHash, selectCandidates } from "../services/jobs/enrichmentSelection.js";

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────

const SR_URL = "https://jobs.smartrecruiters.com/Ubisoft2/744000150164374-esports-communication-assistant";
const WD_URL = "https://adobe.wd5.myworkdayjobs.com/external_experienced/job/Bucharest/Staff-Incident-Response-Commander_R168701";

const srBody = (sections = {}) => JSON.stringify({
  id: "744000150164374",
  jobAd: { sections: {
    companyDescription:    { text: "<p>About Ubisoft</p>" },
    jobDescription:        { text: "<p>You will do the thing.</p>" },
    qualifications:        { text: "<p>Five years of thing.</p>" },
    additionalInformation: { text: "<p>Perks.</p>" },
    ...sections,
  } },
});

const wdBody = (node = {}) => `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org", "@type": "JobPosting",
  title: "Senior Cyber Incident Responder",
  description: "The Opportunity Our Adobe Cyber Defense Center seeks a skilled responder.",
  employmentType: "FULL_TIME", datePosted: "2026-08-26",
  ...node,
})}</script></head><body><div id="root"></div></body></html>`;

/** Backoff is asserted by the delay it COMPUTES, never by waiting for it. */
const noSleep = async () => {};

/** A transport whose every response is scripted, and which records what it was asked for. */
function stubHttp(script) {
  const calls = [];
  const http = async ({ url }) => {
    calls.push(url);
    const next = typeof script === "function" ? script(url, calls.length) : script;
    return { status: 200, body: "", headers: {}, ...next };
  };
  http.calls = calls;
  return http;
}

function freshDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, search_query TEXT DEFAULT '', company TEXT, title TEXT,
      source TEXT, url TEXT, description TEXT, employment_type TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      content_hash TEXT, enriched_at INTEGER, updated_at INTEGER,
      discovered_at INTEGER, scraped_at INTEGER, posted_at TEXT,
      detail_fetched_at INTEGER, detail_fetch_attempts INTEGER NOT NULL DEFAULT 0,
      detail_fetch_error TEXT,
      summary TEXT, normalized_title TEXT, experience_level TEXT, workplace_type TEXT,
      salary_min_usd INTEGER, salary_max_usd INTEGER, salary_period TEXT, skills_json TEXT,
      is_h1b_sponsor INTEGER, requires_work_auth INTEGER, is_clearance_required INTEGER,
      org_unit_raw TEXT
    );
    CREATE TABLE domain_profiles (
      id INTEGER PRIMARY KEY, user_id INTEGER, target_titles TEXT, is_active INTEGER DEFAULT 1
    );
  `);
  _resetColumnCache();
  return db;
}

const NOW = 1790000000;
function seed(db, rows) {
  const stmt = db.prepare(`
    INSERT INTO scraped_jobs (job_id, company, title, source, url, description, discovered_at, scraped_at, detail_fetch_attempts)
    VALUES (@job_id, @company, @title, @source, @url, @description, @discovered_at, @scraped_at, @attempts)
  `);
  rows.forEach((r, i) => stmt.run({
    job_id: r.job_id, company: r.company ?? "Ubisoft", title: r.title ?? `Job ${i}`,
    source: r.source ?? "smartrecruiters", url: r.url ?? SR_URL,
    description: r.description ?? null,
    discovered_at: r.discovered_at ?? (NOW - i), scraped_at: NOW, attempts: r.attempts ?? 0,
  }));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// THE FETCHER
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("a row addresses itself — no company_ats_list lookup, no slug threading", async () => {
  // This is what lets the enrichment pass and the user-opened-a-job route share one fetcher.
  // Task Y's Workday fetcher needed the tenant/wd#/site triple carried alongside the row, and its
  // first attempt lost it because normalizeJob is a field whitelist that silently drops what it
  // does not name. Both fetchers now read only the stored URL.
  const sr = stubHttp({ body: srBody() });
  const srOut = await fetchDescription({ source: "smartrecruiters", url: SR_URL }, { http: sr });
  assert.equal(srOut.ok, true);
  assert.equal(sr.calls[0],
    "https://api.smartrecruiters.com/v1/companies/Ubisoft2/postings/744000150164374");

  const wd = stubHttp({ body: wdBody() });
  const wdOut = await fetchDescription({ source: "workday", url: WD_URL }, { http: wd });
  assert.equal(wdOut.ok, true);
  assert.equal(wd.calls[0], WD_URL, "Workday's JSON-LD door is a GET of the URL already on the row");
});

test("SmartRecruiters' four sections are joined in reading order", async () => {
  const out = await fetchDescription({ source: "smartrecruiters", url: SR_URL },
    { http: stubHttp({ body: srBody() }) });
  assert.equal(out.text,
    "<p>About Ubisoft</p>\n\n<p>You will do the thing.</p>\n\n<p>Five years of thing.</p>\n\n<p>Perks.</p>");
});

test("a partial SmartRecruiters ad yields what is there, not nothing", async () => {
  // Bosch emits a `videos` section and some ads use only a subset. Phase 1 saw all four on every
  // posting probed, but an ad with one section must still produce text.
  const body = JSON.stringify({ jobAd: { sections: { jobDescription: { text: "Only this." } } } });
  const out = await fetchDescription({ source: "smartrecruiters", url: SR_URL }, { http: stubHttp({ body }) });
  assert.equal(out.ok, true);
  assert.equal(out.text, "Only this.");
});

test("the SmartRecruiters posting id is the LEADING DIGITS, not the first hyphen group", async () => {
  // SmartRecruiters' own postingUrl keeps a trailing hyphen that our slugify strips, so the two
  // URL spellings differ in the tail. Splitting on '-' would still work here but breaks on a
  // title that begins with a number; taking the digit run is what makes both spellings agree.
  const http = stubHttp({ body: srBody() });
  await fetchDescription({ source: "smartrecruiters", url: SR_URL + "-w-m-nb-" }, { http });
  assert.match(http.calls[0], /postings\/744000150164374$/);
});

test("Workday's JSON-LD is found by @type, not by position, and fills employment_type", async () => {
  // A page with an Organization block first must not defeat the extractor.
  const body = `<!doctype html><head>
    <script type="application/ld+json">${JSON.stringify({ "@type": "Organization", name: "Adobe" })}</script>
    ${wdBody().match(/<script[\s\S]*?<\/script>/)[0]}
  </head>`;
  const out = await fetchDescription({ source: "workday", url: WD_URL }, { http: stubHttp({ body }) });
  assert.equal(out.ok, true);
  assert.match(out.text, /Adobe Cyber Defense Center/);
  // ⛔ The dead read this fixes: workday.js maps contract_type from `timeType`, absent from
  // 100/100 live list postings. JSON-LD carries it in the request we already make.
  // Handed over RAW — normalizeEmploymentType owns the vocabulary, and the writer applies it.
  assert.equal(out.employmentType, "FULL_TIME");
});

test("a source with no detail door is NOT a failure and costs no attempt", async () => {
  const http = stubHttp({ body: "x" });
  const out = await fetchDescription({ source: "greenhouse", url: "https://boards.greenhouse.io/x/jobs/1" }, { http });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "no_fetcher");
  assert.equal(out.attempted, false, "it must not count as a request that was spent");
  assert.equal(http.calls.length, 0, "and it must not make one");
  assert.equal(hasDetailFetcher("greenhouse"), false);
  assert.deepEqual([...DETAIL_FETCH_SOURCES].sort(), ["smartrecruiters", "workday"]);
});

test("a 200 that carries no text is 'no_text', not a description", async () => {
  // THE YIELD CASE, and the one a request count hides: a fetch can succeed and return nothing.
  const out = await fetchDescription({ source: "workday", url: WD_URL },
    { http: stubHttp({ body: wdBody({ description: "" }) }) });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "no_text");
  assert.equal(out.attempted, true, "the request WAS spent, and the yield metric needs to know");
});

test("a 404 is terminal and a 500 is retried", async () => {
  const gone = stubHttp({ status: 404 });
  const out404 = await fetchDescription({ source: "workday", url: WD_URL }, { http: gone });
  assert.equal(out404.reason, "http_404");
  assert.equal(gone.calls.length, 1, "a deleted posting must not be retried — it will not come back");

  const flaky = stubHttp((_u, n) => (n < 3 ? { status: 500 } : { status: 200, body: wdBody() }));
  const recovered = await fetchDescription({ source: "workday", url: WD_URL }, { http: flaky, sleepFn: noSleep });
  assert.equal(recovered.ok, true);
  assert.equal(flaky.calls.length, 3);
});

test("Retry-After is honoured rather than retried blindly, and is capped", async () => {
  const waits = [];
  const http = stubHttp((_u, n) => (n === 1
    ? { status: 429, headers: { "retry-after": "2" } }
    : { status: 200, body: wdBody() }));
  const out = await fetchDescription({ source: "workday", url: WD_URL }, {
    http, sleepFn: noSleep,
    // The value handed to the backoff is the thing under test, so it is captured rather than
    // served — a test that really sleeps 30s to prove a cap is 30s teaches the suite to be skipped.
    onRetry: ({ waitMs }) => waits.push(waitMs),
  });
  assert.equal(out.ok, true);
  assert.deepEqual(waits, [2000], "2s from the header, not the 1s exponential default");

  const hostile = stubHttp({ status: 429, headers: { "retry-after": "999999" } });
  const capped = [];
  await fetchDescription({ source: "workday", url: WD_URL },
    { http: hostile, maxRetries: 1, sleepFn: noSleep, onRetry: ({ waitMs }) => capped.push(waitMs) });
  assert.deepEqual(capped, [30000], "a hostile or mistaken header must not park the pass for a week");
});

test("a body that is not the expected shape is 'unparseable', not 'no_text'", async () => {
  // Different findings want different responses: an empty ad is the source's choice, a
  // non-JSON body from a JSON endpoint means something changed underneath us.
  const out = await fetchDescription({ source: "smartrecruiters", url: SR_URL },
    { http: stubHttp({ body: "<html>maintenance</html>" }) });
  assert.equal(out.reason, "unparseable");
});

test("fetchDescription never throws, even when the transport does", async () => {
  // Callers rely on this: the enrichment pass would otherwise lose a concurrency slot's remaining
  // rows, and server.js's route would 500 because a third party hung up.
  const out = await fetchDescription({ source: "workday", url: WD_URL }, {
    http: async () => { throw new Error("socket hang up"); },
    maxRetries: 0, sleepFn: noSleep,
  });
  assert.ok(!(out instanceof Error), "it returned an Error instead of an outcome");
  assert.equal(out.ok, false);
  assert.equal(out.reason, "network");
  assert.equal(out.attempted, true, "a socket that hung up still consumed an attempt");
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// ⛔ THE WRITE INVARIANTS. These are the ones that matter most.
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("a FAILED fetch leaves the row fully retryable and stamps NOTHING", async () => {
  // ⛔ This is the 120-row bug, pointed at a new way of happening. enrichJob's failure path
  // deliberately leaves content_hash and enriched_at unset; a 429 or 404 on the detail fetch must
  // take the same path. A row marked done because its description could not be fetched can never
  // improve, and nothing would ever say so.
  const db = freshDb();
  seed(db, [{ job_id: "a" }]);

  persistDetailOutcome(db, "a", { ok: false, attempted: true, reason: "http_429" }, NOW);

  const row = db.prepare("SELECT * FROM scraped_jobs WHERE job_id='a'").get();
  assert.equal(row.content_hash, null, "content_hash must stay unset");
  assert.equal(row.enriched_at, null, "enriched_at must stay unset");
  assert.equal(row.description, null, "no description-shaped nothing");
  assert.equal(row.updated_at, null, "nothing about the posting changed, so updated_at must not move");
  assert.equal(row.detail_fetch_attempts, 1, "only the attempt counter moves");
  assert.equal(row.detail_fetch_error, "http_429", "with the reason, so a count is interpretable");
});

test("a SUCCESSFUL fetch stamps no completion signal either", async () => {
  // The row becomes an enrichment CANDIDATE, not a finished row. Writing content_hash here would
  // mark a row enrichment has never seen as already done, and it would leave the candidate set
  // for good — the same loss, arrived at from the success side.
  const db = freshDb();
  seed(db, [{ job_id: "a" }]);

  persistDetailOutcome(db, "a", { ok: true, attempted: true, text: "the text", employmentType: "FULL_TIME" }, NOW);

  const row = db.prepare("SELECT * FROM scraped_jobs WHERE job_id='a'").get();
  assert.equal(row.description, "the text");
  // Through the SAME normaliser aggregator.js:436 uses, so the column can only ever hold a
  // spelling its own filter recognises. "FULL_TIME" in, "full-time" stored.
  assert.equal(row.employment_type, "full-time");
  assert.equal(row.detail_fetched_at, NOW);
  assert.equal(row.updated_at, NOW, "the posting DID change — it has text now");
  assert.equal(row.content_hash, null, "but it has not been enriched, and must not claim to be");
  assert.equal(row.enriched_at, null);
});

test("employment_type is COALESCEd existing-first, so a fetch can only ever ADD", () => {
  const db = freshDb();
  seed(db, [{ job_id: "a" }]);
  db.prepare("UPDATE scraped_jobs SET employment_type='internship' WHERE job_id='a'").run();
  persistDetailOutcome(db, "a", { ok: true, attempted: true, text: "t", employmentType: "FULL_TIME" }, NOW);
  assert.equal(db.prepare("SELECT employment_type c FROM scraped_jobs WHERE job_id='a'").get().c, "internship",
    "ingestion's value must win — enrichment-adjacent writes here are additive only");
});

test("an unattempted outcome writes nothing at all", () => {
  const db = freshDb();
  seed(db, [{ job_id: "a" }]);
  const wrote = persistDetailOutcome(db, "a", { ok: false, attempted: false, reason: "no_fetcher" }, NOW);
  assert.equal(wrote, false);
  assert.equal(db.prepare("SELECT detail_fetch_attempts n FROM scraped_jobs WHERE job_id='a'").get().n, 0,
    "a greenhouse row must not accrue attempts for a request nobody made");
});

test("a fetched description makes the row an enrichment candidate, with NO new selector logic", () => {
  // This is the claim that makes this the right seam, so it is asserted rather than asserted-in-prose.
  const db = freshDb();
  seed(db, [{ job_id: "a", title: "Software Engineer" }]);
  // Before: no description, so enrichmentSelection excludes it — there is nothing to extract.
  assert.equal(selectCandidates(db, { maxLastSeenDays: 0 }).candidates.length, 0);

  persistDetailOutcome(db, "a", { ok: true, attempted: true, text: "real posting text" }, NOW);

  // After: content_hash is still null and the description is not, so the EXISTING predicate picks
  // it up. content_hash = sha1(title|description) is what makes this automatic.
  const after = selectCandidates(db, { maxLastSeenDays: 0 });
  assert.equal(after.candidates.length, 1);
  assert.equal(after.candidates[0].job_id, "a");
  assert.notEqual(computeContentHash("Software Engineer", "real posting text"), null);
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// THE PASS
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("the pass reports COVERAGE, not its request count", async () => {
  // `attempted: 4` is true whether four descriptions arrived or zero did. Both numbers are
  // reported because they are different numbers.
  const db = freshDb();
  seed(db, [{ job_id: "a" }, { job_id: "b" }, { job_id: "c" }, { job_id: "d" }]);
  const http = stubHttp((_u, n) => (n % 2 ? { status: 200, body: srBody() } : { status: 200, body: srBody({ jobDescription: { text: "" }, companyDescription: { text: "" }, qualifications: { text: "" }, additionalInformation: { text: "" } }) }));

  const r = await fillMissingDescriptions(db, { limit: 10, concurrency: 1, http, log: {} });
  assert.equal(r.attempted, 4);
  assert.equal(r.describedBefore, 0);
  assert.equal(r.describedAfter, 2);
  assert.equal(r.coverageDelta, 2, "the only number that answers 'did it work'");
  assert.equal(r.byReason.no_text, 2);
});

test("a fetch that cannot be STORED is not counted as text", async () => {
  // ⛔ THE REGRESSION THIS EXISTS FOR, found on the first live run rather than in review:
  // `withText++` sat before the UPDATE, the UPDATE threw on a missing column, mapWithConcurrency
  // CONTAINED the rejection exactly as designed — and the report claimed `withText: 6` over a
  // table holding zero descriptions. Success-shaped output over an empty result, inside the code
  // written to remove it.
  const db = freshDb();
  seed(db, [{ job_id: "a" }, { job_id: "b" }]);
  // Make the write fail the way a missing migration would, without removing the selector's columns.
  db.exec("ALTER TABLE scraped_jobs RENAME COLUMN employment_type TO employment_type_gone");

  const errors = [];
  const r = await fillMissingDescriptions(db, {
    limit: 10, concurrency: 1, http: stubHttp({ body: srBody() }),
    log: { error: (m) => errors.push(m), warn: () => {}, log: () => {} },
  });

  assert.equal(r.attempted, 2, "the requests WERE spent, and that must not be hidden");
  assert.equal(r.withText, 0, "nothing was stored, so nothing may be reported as stored");
  assert.equal(r.coverageDelta, 0);
  assert.equal(r.byReason.write_failed, 2);
  assert.equal(errors.length, 2, "a request spent for nothing is worth saying out loud");
});

test("withText and coverageDelta are derived independently, and disagreement is reported", async () => {
  // One comes from the loop, one from re-querying the table. Keeping them separate is what let the
  // bug above be caught by the code rather than by a person.
  const db = freshDb();
  seed(db, [{ job_id: "a" }]);
  const said = [];
  const r = await fillMissingDescriptions(db, {
    limit: 5, http: stubHttp({ body: srBody() }),
    log: { error: (m) => said.push(m), warn: () => {}, log: () => {} },
  });
  assert.equal(r.withText, 1);
  assert.equal(r.coverageDelta, 1);
  assert.deepEqual(said, [], "they agree on a healthy pass, so nothing is said");
});

test("rows that already have text are never selected, so no budget is spent re-buying", async () => {
  const db = freshDb();
  seed(db, [{ job_id: "a", description: "already here" }, { job_id: "b" }]);
  const http = stubHttp({ body: srBody() });
  const r = await fillMissingDescriptions(db, { limit: 10, http, log: {} });
  assert.equal(r.selected, 1);
  assert.equal(http.calls.length, 1);
  assert.equal(db.prepare("SELECT description d FROM scraped_jobs WHERE job_id='a'").get().d, "already here");
});

test("the attempt cap stops re-SPENDING without marking the row done", async () => {
  const db = freshDb();
  seed(db, [{ job_id: "spent", attempts: 3 }, { job_id: "fresh", attempts: 0 }]);
  const http = stubHttp({ body: srBody() });
  const r = await fillMissingDescriptions(db, { limit: 10, maxAttempts: 3, http, log: {} });

  assert.equal(r.selected, 1, "the exhausted row is not selected");
  assert.equal(http.calls.length, 1);
  // ⛔ But it is still a row with no description and no completion stamp — it has stopped being
  // worth a request, which is not the same as having been dealt with.
  const row = db.prepare("SELECT * FROM scraped_jobs WHERE job_id='spent'").get();
  assert.equal(row.content_hash, null);
  assert.equal(row.enriched_at, null);
  // And clearing the counter re-arms it, which is what makes the cap reversible.
  db.prepare("UPDATE scraped_jobs SET detail_fetch_attempts=0 WHERE job_id='spent'").run();
  const again = await fillMissingDescriptions(db, { limit: 10, maxAttempts: 3, http: stubHttp({ body: srBody() }), log: {} });
  assert.equal(again.selected, 1);
});

test("a 429 stops that source for the rest of the pass", async () => {
  // Phase 1 never produced a 429 from either API, so this path is unexercised against a real one.
  // That is exactly why it is conservative: stop asking, rather than keep going politely.
  const db = freshDb();
  seed(db, Array.from({ length: 6 }, (_, i) => ({ job_id: `j${i}` })));
  const http = stubHttp({ status: 429 });
  const r = await fillMissingDescriptions(db, { limit: 10, concurrency: 1, maxAttempts: 9, http, sleepFn: noSleep, log: {} });
  assert.deepEqual(r.throttledSources, ["smartrecruiters"]);
  assert.equal(r.withText, 0);
  assert.ok(r.attempted < 6, `the pass must stop early, spent ${r.attempted} of 6`);
});

test("the per-company cap stops one company monopolising the day", async () => {
  // Not hypothetical: Bosch alone offers 4,840 postings (900 after the crawl's cap), so without
  // this a single company consumes every day's allowance and the others never get one.
  const db = freshDb();
  seed(db, [
    ...Array.from({ length: 5 }, (_, i) => ({ job_id: `bosch${i}`, company: "Bosch" })),
    ...Array.from({ length: 5 }, (_, i) => ({ job_id: `ubi${i}`,  company: "Ubisoft" })),
  ]);
  const r = await fillMissingDescriptions(db, {
    limit: 10, perCompany: 2, concurrency: 1, http: stubHttp({ body: srBody() }), log: {},
  });
  assert.equal(r.withText, 4);
  assert.deepEqual(
    Object.fromEntries(Object.entries(r.byCompany).map(([k, v]) => [k, v.withText])),
    { Bosch: 2, Ubisoft: 2 });
});

test("the per-company cap does not WASTE the day's budget", async () => {
  // \u26d4 THE REGRESSION THIS EXISTS FOR. The cap used to live only in budget.take(): the SELECT
  // took `LIMIT n` rows by priority and the budget refused whatever was over a company's share.
  // With Bosch offering 900 of the 1,200 SmartRecruiters rows, a 300-row day would fill its LIMIT
  // almost entirely with Bosch, fetch its 100, and REFUSE ~200 slots that Ubisoft and Adobe rows
  // could have used. Budget silently discarded \u2014 the `0de67c8` shape one more time.
  //
  // Bosch's rows are the most recent here, so a recency-ordered LIMIT would take all six of them.
  const db = freshDb();
  seed(db, [
    ...Array.from({ length: 10 }, (_, i) => ({ job_id: `bosch${i}`, company: "Bosch",   discovered_at: NOW - i })),
    ...Array.from({ length: 10 }, (_, i) => ({ job_id: `ubi${i}`,   company: "Ubisoft", discovered_at: NOW - 500 - i })),
  ]);

  const r = await fillMissingDescriptions(db, {
    limit: 6, perCompany: 2, concurrency: 1, http: stubHttp({ body: srBody() }), log: {},
  });

  assert.equal(r.selected, 4, "2 per company across two companies — not 6 rows of one company");
  assert.equal(r.withText, 4, "and every selected row is fetched, so no slot is refused");
  assert.equal(r.budget.skipped, 0, "a refusal here would mean budget was thrown away");
  assert.deepEqual(
    Object.fromEntries(Object.entries(r.byCompany).map(([k, v]) => [k, v.withText])),
    { Bosch: 2, Ubisoft: 2 },
    "the older company still gets its share");
});

test("perCompany <= 0 means no per-company limit, not zero rows", async () => {
  // The SELECT's `@perCompany <= 0 OR rn <= @perCompany` guard. Zero must read as "unlimited",
  // matching createDetailBudget's own `cfg.perCompany > 0 &&` condition — two places agreeing
  // about one number, which is the only reason two places are tolerable.
  const db = freshDb();
  seed(db, Array.from({ length: 5 }, (_, i) => ({ job_id: `j${i}`, company: "Bosch" })));
  const r = await fillMissingDescriptions(db, {
    limit: 5, perCompany: 0, concurrency: 1, http: stubHttp({ body: srBody() }), log: {},
  });
  assert.equal(r.selected, 5);
  assert.equal(r.withText, 5);
});

test("the pass is INERT without migration 107 — no request, no write", async () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, company TEXT, title TEXT,
           source TEXT, url TEXT, description TEXT, is_active INTEGER DEFAULT 1,
           discovered_at INTEGER, scraped_at INTEGER);`);
  db.prepare("INSERT INTO scraped_jobs (job_id,company,title,source,url,is_active) VALUES ('a','Ubisoft','T','smartrecruiters',?,1)").run(SR_URL);
  _resetColumnCache();
  const http = stubHttp({ body: srBody() });
  const r = await fillMissingDescriptions(db, { limit: 10, http, log: {} });
  assert.equal(r.enabled, false);
  assert.equal(r.reason, "migration_107_missing");
  assert.equal(http.calls.length, 0, "observability must never break the work it observes");
  _resetColumnCache();
});

test("a zero budget makes zero requests", async () => {
  const db = freshDb();
  seed(db, [{ job_id: "a" }]);
  const http = stubHttp({ body: srBody() });
  const r = await fillMissingDescriptions(db, { limit: 0, http, log: {} });
  assert.equal(r.enabled, false);
  assert.equal(r.reason, "no_budget");
  assert.equal(http.calls.length, 0);
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 2C · TITLE-UNION PRIORITISATION
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("the union ORDERS the queue and never filters it", async () => {
  // ⛔ The board is a global pool by design. A row nobody's profile matches must still be
  // fetchable — it is LAST, not absent.
  const db = freshDb();
  db.prepare("INSERT INTO domain_profiles (id,user_id,target_titles,is_active) VALUES (1,1,?,1)")
    .run(JSON.stringify(["Software Engineer"]));
  seed(db, [
    { job_id: "chef",    title: "Sous Chef",                    discovered_at: NOW },
    { job_id: "swe",     title: "Senior Software Engineer",     discovered_at: NOW - 999 },
    { job_id: "sde",     title: "Software Development Engineer", discovered_at: NOW - 998 },
  ]);
  const http = stubHttp({ body: srBody() });
  const r = await fillMissingDescriptions(db, { limit: 10, concurrency: 1, http, log: {} });

  assert.equal(r.selected, 3, "every row is still selected — this is a ranking, not a filter");
  const order = db.prepare(
    "SELECT job_id FROM scraped_jobs ORDER BY detail_fetched_at, job_id").all().map(r => r.job_id);
  assert.ok(order.indexOf("chef") === 2 || r.withText === 3,
    "the unmatched row must not be dropped");
  assert.equal(r.prioritised, 1);
});

test("the union reuses the BOARD's matcher, so it reaches 'Software Development Engineer'", () => {
  // Phase 1 measured 15 of 1,500 rows (1.0%) using the plugins' naive substring matcher, under
  // which "software engineer" does NOT match "Software Development Engineer". profileTitleSql
  // tokenises, so it does. That is why the 1% figure is a floor and is encoded nowhere.
  const db = freshDb();
  db.prepare("INSERT INTO domain_profiles (id,user_id,target_titles,is_active) VALUES (1,1,?,1)")
    .run(JSON.stringify(["Software Engineer"]));
  const p = titleUnionPriority(db, "title");
  assert.ok(p, "a profile with titles must produce a priority clause");
  const matches = (title) =>
    db.prepare(`SELECT ${p.sql} AS m FROM (SELECT @t AS title)`).get({ ...p.params, t: title }).m;
  assert.equal(matches("Software Development Engineer"), 1);
  assert.equal(matches("Senior Software Engineer II"), 1);
  assert.equal(matches("Sous Chef"), 0);
});

test("a profile with EMPTY target_titles contributes nothing, not everything", () => {
  // ⛔ profileTitleSql returns `1 = 1` for an empty list — correct for a filter, catastrophic for
  // a prioritiser, where it silently makes every row top priority and the ranking a no-op. One of
  // the two active profiles on the real board is in exactly this state.
  const db = freshDb();
  db.prepare("INSERT INTO domain_profiles (id,user_id,target_titles,is_active) VALUES (1,1,'[]',1)").run();
  assert.equal(titleUnionPriority(db, "title"), null);

  db.prepare("INSERT INTO domain_profiles (id,user_id,target_titles,is_active) VALUES (2,1,?,1)")
    .run(JSON.stringify(["Software Engineer"]));
  const p = titleUnionPriority(db, "title");
  assert.equal(p.profiles, 1, "only the profile that named a title contributes");
  assert.doesNotMatch(p.sql, /1 = 1/);
});

test("inactive profiles do not steer the spend", () => {
  const db = freshDb();
  db.prepare("INSERT INTO domain_profiles (id,user_id,target_titles,is_active) VALUES (1,1,?,0)")
    .run(JSON.stringify(["Sous Chef"]));
  assert.equal(titleUnionPriority(db, "title"), null);
});

test("no domain_profiles table degrades to recency, not to an error", async () => {
  // A fixture DB or an older checkout must still be able to fetch descriptions.
  const db = freshDb();
  db.exec("DROP TABLE domain_profiles");
  seed(db, [{ job_id: "a" }]);
  assert.equal(titleUnionPriority(db, "title"), null);
  const r = await fillMissingDescriptions(db, { limit: 5, http: stubHttp({ body: srBody() }), log: {} });
  assert.equal(r.withText, 1);
  assert.equal(r.prioritised, 0);
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// THE CRAWL NO LONGER SPENDS
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("neither plugin fetches detail any more, and neither reads a crawl-time budget env", async () => {
  // The whole point of 2A: the crawl writes description-less rows cheaply. A plugin that quietly
  // regained a detail fetch would recreate the second budget, and at 1,500 requests/crawl against
  // a 300-row/day enrichment ceiling it would do so invisibly.
  const sr = (await import("../services/jobs/sources/smartrecruiters.js")).default;
  const wd = (await import("../services/jobs/sources/workday.js")).default;
  for (const [name, plugin] of [["smartrecruiters", sr], ["workday", wd]]) {
    const src = plugin.search.toString();
    assert.doesNotMatch(src, /attachDescriptions|fetchPostingDescription/,
      `${name} must not fetch descriptions during a crawl`);
    assert.doesNotMatch(src, /ATS_DETAIL_FETCH|detailBudgetFromEnv|createDetailBudget/,
      `${name} must not carry a crawl-time detail budget`);
    assert.doesNotMatch(src, /_fetchDetail|_detailBudget/,
      `${name}'s detail-fetch injection points should be gone, not merely unused`);
  }
});
