import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync("server.js", "utf8");

// Two tests stood here — "manual scrape builds outbound params from active profile plus stored
// user signals" and "active scrape tracking is profile-scoped and duplicate outbound work is
// deduped". Both described the retired external-scraping path:
//
//   - the first sliced the /api/scrape route and asserted Apify request params
//     (buildApifyQueriesFromProfile, maxItems, postedLimit, employmentTypes). That route is now
//     a 410 tombstone, so the slice was empty and the very first assertion could not pass.
//   - the second asserted a dedup mechanism that has been partly dismantled: scrapeStateKey
//     still exists, but `inFlightScrape` and `deduped:true` are both gone from server.js.
//
// Neither can be repaired without reinstating external scraping, which /api/scrape explicitly
// declares removed. They were part of the failure baseline that never moved
// (docs/PIPELINE_DIAGNOSIS.md §5.11). Replaced with the inverse guard.
test("outbound Apify scraping stays retired", () => {
  assert.match(server, /app\.post\("\/api\/scrape",[\s\S]{0,200}?410/,
    "/api/scrape must remain a 410 tombstone");
  assert.doesNotMatch(server, /scrapeParams\.threadId, "apify_payload"[\s\S]{0,80}?await scrapeJobs/,
    "no live path may build an Apify payload and then crawl");
});

test("ATS scoring reuses stored signal basis through the queue", () => {
  assert.match(server, /const atsScoreQueue = \[\]/);
  assert.match(server, /function enqueueAtsScoreWork\(label, worker\)/);
  assert.match(server, /enqueueAtsScoreWork\(`scrape:\$\{userId\}:\$\{query\}`/);
  assert.match(server, /buildRuntimeAtsBasis\(\{/);
  assert.match(server, /resumeText: baseResumeRow\?\.enhanced_content \|\| baseResumeText/);
  assert.match(server, /signalProfile: simpleProfile/);
  assert.match(server, /scoreAtsLocally\(\{/);
  assert.match(server, /enqueueAtsScoreWork\(`adopt-enhanced:\$\{userId\}:\$\{profileId\}`/);
  assert.match(server, /buildRuntimeAtsBasis\(\{\s*resumeText: newContent,\s*signalProfile,\s*domainProfile: profile/);
});

// "structured search thread logging includes outbound payload and filter summary" was removed
// rather than narrowed. Tracing its assertions showed the whole apparatus is scrape-only: the
// "db_first" and "background_complete" events are gone, and EVERY remaining logSearchThread call
// site (apify_payload, scrape_filter_summary, ats_enrichment, scrape_complete) passes
// scrapeParams.threadId — i.e. lives inside the retired crawl. There is no longer any
// logSearchThread(threadId, "request") on a live path. Keeping a test here would pin dead code
// alive, which is exactly what 5.1 and 5.7 were doing.
//
// searchThreadId / logSearchThread / scrapeJobs / activeScrapes / scrapeStateKey / mapPostedLimit
// are therefore a NEW cleanup candidate, recorded as §5.12 in docs/PIPELINE_DIAGNOSIS.md rather
// than deleted here.
//
// UPDATE: that cluster has since been traced. Of the two entry points named above, the cron path
// was PROVABLY DEAD — it chose its target from user_job_searches, a table with zero writers — and
// has been removed. The admin router's POST /api/admin/db/force-scrape is NOT dead: it still
// invokes a working HarvestAPI crawl, so scrapeJobs and everything it calls stays. The absence
// guard for the cron lives in jobsPipelineHardening.test.js.
