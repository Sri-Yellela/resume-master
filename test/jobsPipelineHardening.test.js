// SCRAPING � SCHEDULED FOR REMOVAL AFTER MIGRATION
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync("server.js", "utf8");
const jobClassifier = fs.readFileSync("services/jobClassifier.js", "utf8");
const profileTitleFilter = fs.readFileSync("services/profileTitleFilter.js", "utf8");
const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
const simpleProfileSvc = fs.readFileSync("services/simpleApplyProfile.js", "utf8");

// Three tests here described the retired external-scraping flow: the /api/scrape route's
// profile guard and DB-first local count, its quota-exhaustion classification, and the client
// states that surfaced both. /api/scrape is now a tombstone returning HTTP 410 "External
// scraping has been removed. Job search now uses /api/jobs.", so none of them could pass again.
// Replaced with the guard that matters — the retirement must hold — plus the client-side setup
// gate, which IS still live and is what now blocks a user with no profile.
test("external scraping stays retired and the setup gate still blocks a profileless user", () => {
  assert.match(server, /app\.post\("\/api\/scrape",[\s\S]{0,200}?410/,
    "/api/scrape must remain a 410 tombstone");
  // The daily re-scrape cron is gone (§5.12). It selected its target from user_job_searches,
  // which has no writer anywhere in the repo, so it could never fire. Asserted absent because the
  // reason it was dead is invisible at the call site — it looked like a live scheduled job.
  assert.doesNotMatch(server, /cron\.schedule\("0 7 \* \* \*"/,
    "the dead daily re-scrape cron must not come back");
  // Not asserting that nothing reads user_job_searches at all: a legacy migration backfill
  // (server.js:911-916) joins it to domain_profiles legitimately, and an admin view reads it.
  // Reads are fine — the table having no WRITER is what made the cron unreachable.

  // isExternalScrapeQuotaError and scrapeJobs still EXIST and are still live, now via exactly one
  // entry point: POST /api/admin/db/force-scrape, which is a working HarvestAPI crawl. Removing
  // that is a product decision, not cleanup, so absence is deliberately NOT asserted for them.
  assert.match(server, /createAdminDbRouter\(db, \{ dbPath: DB_PATH, scrapeJobs \}\)/,
    "force-scrape is the one remaining scrapeJobs entry point — keep the wiring explicit");

  // The user-facing gate that replaced it is live.
  assert.match(jobsPanel, /setupBlock/);
  assert.match(jobsPanel, /SetupGateNotice/);
  assert.match(jobsPanel, /Create a job search profile/);
});

test("roleTitleSql engineering excludes all firmware/embedded keyword families", () => {
  // The server.js import assertion that stood here is gone: /api/jobs no longer applies
  // roleTitleSql (the job_role_map join is sufficient — see the phase6 tests in
  // profileIsolation), so server.js stopped importing it. The KEYWORD FAMILIES below are the
  // valuable part and are still intact in jobClassifier.js, which is what this test guards.
  const engStart = jobClassifier.indexOf('if (roleKey === "engineering") return');
  assert.ok(engStart > 0, "engineering roleTitleSql case must exist");
  // Find the closing of the engineering block by locating the next roleKey check
  const nextCase = jobClassifier.indexOf('if (roleKey === "engineering_embedded_firmware")', engStart);
  assert.ok(nextCase > engStart, "engineering_embedded_firmware case must follow engineering case");

  const engBlock = jobClassifier.slice(engStart, nextCase);
  assert.match(engBlock, /NOT LIKE '%firmware%'/, "must exclude firmware");
  assert.match(engBlock, /NOT LIKE '%embedded%'/, "must exclude embedded");
  assert.match(engBlock, /NOT LIKE '%device driver%'/, "must exclude device driver");
  assert.match(engBlock, /NOT LIKE '%bsp%'/, "must exclude bsp");
  assert.match(engBlock, /NOT LIKE '%silicon validation%'/, "must exclude silicon validation");
  assert.match(engBlock, /NOT LIKE '%post-silicon%'/, "must exclude post-silicon");
  assert.match(engBlock, /NOT LIKE '%bootloader%'/, "must exclude bootloader");
  assert.match(engBlock, /NOT LIKE '%rtos%'/, "must exclude rtos");
  assert.match(engBlock, /NOT LIKE '%uefi%'/, "must exclude uefi");
});

test("roleTitleSql engineering_embedded_firmware case covers the canonical firmware title set", () => {
  const fwStart = jobClassifier.indexOf('if (roleKey === "engineering_embedded_firmware") return');
  assert.ok(fwStart > 0, "engineering_embedded_firmware roleTitleSql case must exist");
  const pmCase = jobClassifier.indexOf('if (roleKey === "pm") return', fwStart);
  const fwBlock = jobClassifier.slice(fwStart, pmCase);

  assert.match(fwBlock, /LIKE '%firmware%'/);
  assert.match(fwBlock, /LIKE '%embedded%'/);
  assert.match(fwBlock, /LIKE '%bsp%'/);
  assert.match(fwBlock, /LIKE '%silicon validation%'/);
  assert.match(fwBlock, /LIKE '%bootloader%'/);
  assert.match(fwBlock, /LIKE '%rtos%'/);
  assert.match(fwBlock, /LIKE '%uefi%'/);
  assert.match(fwBlock, /LIKE '%hardware debug%'/);
});

test("roleKeyForProfile returns domain for engineering_embedded_firmware profiles", () => {
  assert.match(server, /domain === "engineering_embedded_firmware"/);
  assert.match(server, /return "engineering_embedded_firmware"/);
});

test("migration 045 firmware repair exists and includes title-heuristic cleanup", () => {
  assert.match(server, /045_firmware_role_map_repair/);
  assert.match(server, /firmware_profile_repair/);
  assert.match(server, /firmware_title_repair/);
  assert.match(server, /matched_by = 'title_heuristic'/);
});

test("migration 048 is idempotent — DELETE step removes conflicting engineering rows before UPDATE", () => {
  const m48start = server.indexOf("048_firmware_reclassify");
  assert.ok(m48start > 0, "048_firmware_reclassify migration must exist");
  const m48end   = server.indexOf("id:", m48start + 10);
  const block    = server.slice(m48start, m48end > m48start ? m48end : m48start + 4000);

  // Step 1: DELETE conflicts first
  assert.match(block, /DELETE FROM job_role_map/, "must DELETE stale rows before UPDATE");
  assert.match(block, /jrm2\.role_key = 'engineering_embedded_firmware'/, "DELETE must filter for existing firmware row");

  // Step 2: UPDATE remaining
  assert.match(block, /UPDATE job_role_map/, "must UPDATE remaining rows");
  assert.match(block, /matched_by\s*=\s*'firmware_reclassify'/, "must set matched_by to firmware_reclassify");

  // Must NOT be a bare UPDATE without the prior DELETE (the original bug)
  const bareUpdate = block.match(/UPDATE job_role_map[\s\S]*?WHERE role_key = 'engineering'/);
  const deleteFirst = block.match(/DELETE FROM job_role_map[\s\S]*?UPDATE job_role_map/);
  assert.ok(deleteFirst, "DELETE must appear before UPDATE in the same migration");
});

test("migration 048 DELETE step scopes to firmware-title jobs only", () => {
  const m48start = server.indexOf("048_firmware_reclassify");
  const block    = server.slice(m48start, m48start + 4000);
  const deleteBlock = block.slice(block.indexOf("DELETE FROM job_role_map"),
                                  block.indexOf("UPDATE job_role_map"));
  assert.match(deleteBlock, /LIKE '%firmware%'/);
  assert.match(deleteBlock, /LIKE '%embedded system%'/);
  assert.match(deleteBlock, /LIKE '%bootloader%'/);
});

test("migration 048 UPDATE step is safe after DELETE — no UNIQUE violation possible", () => {
  const m48start = server.indexOf("048_firmware_reclassify");
  const block    = server.slice(m48start, m48start + 4000);
  const updateBlock = block.slice(block.indexOf("UPDATE job_role_map"));
  // UPDATE must target only role_key='engineering' rows — after DELETE these have no
  // engineering_embedded_firmware counterpart, so no constraint conflict is possible
  assert.match(updateBlock, /WHERE role_key = 'engineering'/);
  assert.match(updateBlock, /matched_by IN \('profile_scrape'/);
  // Must NOT contain INSERT OR IGNORE (UPDATE is correct here, not insert)
  assert.ok(!updateBlock.includes("INSERT OR IGNORE"), "UPDATE is the right operation here");
});

// Was "triple filter — role_key + roleTitleSql + profileTitleSql". It is a DOUBLE filter now:
// roleTitleSql was deliberately dropped from the query paths because the job_role_map join
// already constrains the board to the right role family, making the title re-derivation
// redundant. profileIsolation.test.js asserts that removal as correct, so this file was
// contradicting a passing test elsewhere in the suite.
test("jobs board uses the role_key join plus profileTitleSql on every query", () => {
  const routeStart = server.indexOf('app.get("/api/jobs"');
  assert.ok(routeStart > 0, "/api/jobs route must exist");
  const routeEnd   = server.indexOf("\napp.", routeStart + 10);
  const block      = server.slice(routeStart, routeEnd);

  assert.match(block, /jrm\.role_key = \?/, "must filter by role_key");
  assert.match(block, /profileTitleSql\(/, "must apply profileTitleSql");
  assert.match(profileTitleFilter, /export function profileTitleSql\(column, profile\)/, "profile title filter must be extracted");
  // Profile filter must be first guard — no-profile returns empty immediately
  assert.match(block, /if \(!sessionActiveProfile\)/, "must guard on missing active profile");
});

test("poll board uses the same filters as the board to prevent wrong-profile jobs leaking", () => {
  const pollStart = server.indexOf('app.get("/api/jobs/poll"');
  assert.ok(pollStart > 0, "/api/jobs/poll route must exist");
  const pollEnd   = server.indexOf("\napp.", pollStart + 10);
  const block     = server.slice(pollStart, pollEnd);

  assert.match(block, /jrm\.role_key = \?/, "poll must filter by role_key");
  // roleTitleSql dropped here for the same reason as the board query above; profileIsolation
  // has a passing test asserting exactly that ("poll no longer applies roleTitleSql").
  assert.match(block, /pollProfileTitleFilter/, "poll must apply profileTitleSql");
  assert.match(block, /if \(!activeProfile\)/, "poll must guard on missing active profile");
});

test("poll completion triggers re-fetch via fetchJobsRef for correct sort order", () => {
  // After scrape completes, prepending new jobs without re-sorting leaves the board
  // in wrong order for atsScore/applicantCount sorts.  fetchJobsRef.current?.(1)
  // re-fetches from DB with the user's current sort.
  assert.match(jobsPanel, /fetchJobsRef = useRef\(null\)/, "fetchJobsRef must be declared");
  assert.match(jobsPanel, /fetchJobsRef\.current = fetchJobs/, "ref must be kept in sync with latest fetchJobs");
  // In startPollLoop, ref must be called when !pollData.scraping
  const pollStart = jobsPanel.indexOf("const startPollLoop");
  const pollEnd   = jobsPanel.indexOf("}, []); // eslint-disable-line react-hooks/exhaustive-deps", pollStart);
  const pollBlock = jobsPanel.slice(pollStart, pollEnd);
  assert.match(pollBlock, /fetchJobsRef\.current\?\.\(1\)/, "poll completion must call fetchJobsRef.current?.(1)");
});

// Was "manual search renders local board before profile-driven scrape starts" — it asserted the
// ORDERING of a local fetch against a subsequent api("/api/scrape") call. There is no scrape call
// any more, so the ordering it protected is moot: search now only ever reads the stored board.
// The surviving invariant is that searching does not attempt an outbound crawl at all.
test("manual search reads the stored board and never triggers an outbound scrape", () => {
  assert.doesNotMatch(jobsPanel, /api\("\/api\/scrape"/,
    "the client must not call the retired scrape endpoint");
  assert.match(jobsPanel, /const handleSetRole/, "search entry point must still exist");
  // The scrape-request builder that lingered here with zero callers is now removed (§5.12), so
  // this is asserted rather than merely noted. Comments are stripped first: the removal's own
  // explanatory note in JobsPanel names the outbound path it forbids.
  const jobsPanelCode = jobsPanel
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(jobsPanelCode, /buildProfileScrapeRequest/,
    "the scrape-request builder must not return — there is no outbound path to build for");
});

test("board filters stay local and are not sent as scrape parameters", () => {
  assert.match(jobsPanel, /Board UI filters stay local to \/api\/jobs and must not shape \/api\/scrape/);
  assert.doesNotMatch(jobsPanel, /buildScrapeParams/, "old UI-filter scrape parameter builder must be removed");
  assert.doesNotMatch(jobsPanel, /body:JSON\.stringify\(\{ query:q,[\s\S]*workType/, "scrape body must not include board workType filter");
  assert.doesNotMatch(jobsPanel, /body:JSON\.stringify\(\{ query:q,[\s\S]*ageFilter/, "scrape body must not include board age filter");
  assert.doesNotMatch(jobsPanel, /body:JSON\.stringify\(\{ query:q,[\s\S]*locationFilter/, "scrape body must not include board location filter");
  assert.doesNotMatch(jobsPanel, /body:JSON\.stringify\(\{ query:q,[\s\S]*employmentTypePrefs/, "scrape body must not include board employment filters");
});

test("polling includes same-second inserts and refreshes through local board filters", () => {
  const pollStart = server.indexOf('app.get("/api/jobs/poll"');
  const pollEnd = server.indexOf("\napp.", pollStart + 10);
  const pollBlock = server.slice(pollStart, pollEnd);
  assert.match(pollBlock, /Math\.floor\(\(since - 1000\) \/ 1000\)/, "poll must not miss same-second scrape inserts");
  assert.match(pollBlock, /sj\.scraped_at >= \?/, "poll query must include same-second rows");

  const loopStart = jobsPanel.indexOf("const startPollLoop");
  const loopEnd = jobsPanel.indexOf("const activateProfileForSearch", loopStart);
  const loopBlock = jobsPanel.slice(loopStart, loopEnd);
  assert.match(loopBlock, /fetchJobsRef\.current\?\.\(1\)/, "progressive poll updates must re-read filtered board state");
  assert.doesNotMatch(loopBlock, /\[\.\.\.toAdd, \.\.\.prev\]/, "poll must not blindly prepend unfiltered rows");
});

test("profile facts are hard constraints for local jobs, poll, and scrape ingestion", () => {
  assert.match(server, /function evaluateProfileFactEligibility/, "profile fact eligibility helper must exist");
  assert.match(server, /normaliseStructuredFacts/, "structured profile facts must be normalized before use");
  assert.match(server, /profileFactMismatch/, "scrape filter summary must track profile fact drops");
  assert.match(server, /profileFactsUsed/, "board/search logs must expose profile facts used for shaping");
  assert.match(server, /requiresSponsorship/, "sponsorship fact must be considered");
  assert.match(server, /hasClearance/, "clearance fact must be considered");
  assert.match(server, /citizenshipStatus/, "citizenship fact must be considered");
});

test("jobs board structured logs include profile, sort, and result count", () => {
  // Ensures the board-population log line exists for observability
  assert.match(server, /\[jobs\].*profile.*sort.*total.*returned/);
  assert.match(server, /\[poll\].*profile.*query.*scrape done/);
});

test("/api/jobs does not hard-filter by scrape age — no hidden 7-day cutoff in base conditions", () => {
  // Root cause of '0 SWE jobs despite 100+ local': a sevenDaysAgo filter in the
  // base conditions array silently removed every job scraped more than a week ago.
  // The fix: remove the hard freshness filter from the static conditions.
  // Recency filtering is opt-in via the ageFilter query param.
  const routeStart = server.indexOf('app.get("/api/jobs"');
  const routeEnd   = server.indexOf("\napp.", routeStart + 10);
  const block      = server.slice(routeStart, routeEnd);

  // The conditions array must no longer include a sevenDaysAgo cutoff
  assert.doesNotMatch(block, /sevenDaysAgo/, "/api/jobs must not use sevenDaysAgo in base conditions");
  // The existing optional ageFilter must still exist
  assert.match(block, /ageFilter/, "opt-in age filter must remain available");
  // Profile scoping must still be intact. roleTitleSql was deliberately dropped (the
  // job_role_map join covers it); the role_key join is asserted here in its place so this test
  // still proves the board stays profile-scoped without a freshness cutoff.
  assert.match(block, /jrm\.role_key = \?/, "role_key join must still scope the board");
  assert.match(block, /profileTitleSql\(/, "profileTitleSql must still be applied");
});

test("/api/jobs response maps scrapedAt so client can render staleness indicator", () => {
  const routeStart = server.indexOf('app.get("/api/jobs"');
  const routeEnd   = server.indexOf("\napp.", routeStart + 10);
  const block      = server.slice(routeStart, routeEnd);
  assert.match(block, /scrapedAt:\s*j\.scraped_at/, "response must expose scrapedAt for staleness UI");
});

// "scrape DB-first count uses 30-day window instead of 7-day" is gone with the route it measured.
// The DB-first count existed to decide whether a background crawl was worth starting; with
// /api/scrape a 410 tombstone there is no crawl to skip, so the window is meaningless. The
// underlying concern it protected — that a stale-date cutoff must not silently empty the board —
// is covered by "/api/jobs does not hard-filter by scrape age" above, which asserts against the
// LIVE board query rather than the retired scrape path.

test("normalizePostedAt converts relative age strings to ISO dates at ingest", () => {
  // Root of O1: LinkedIn returns "2 days ago" which new Date() can't parse.
  // normalizePostedAt converts these to ISO dates using scraped_at as anchor.
  assert.match(server, /function normalizePostedAt\(raw, scrapedAt\)/, "normalizePostedAt must be defined");
  assert.match(server, /minute.*hour.*day.*week.*month/, "must handle all relative time units");
  assert.match(server, /normalizePostedAt\(item\.postedAt, nowUnix\)/, "must be used at insert time");
  // ISO fallback must handle parseable dates already
  assert.match(server, /new Date\(str\)/, "must try to parse as date first");
});

test("job card age always renders using scrapedAt fallback when postedAt is absent", () => {
  const jobCard = fs.readFileSync("client/src/components/JobCard.jsx", "utf8");
  // ago() must accept a second argument (scrapedAt fallback)
  assert.match(jobCard, /function ago\(postedAt, scrapedAt\)/, "ago must accept scrapedAt fallback");
  // Fallback logic: use scrapedAt * 1000 when postedAt is not parseable
  assert.match(jobCard, /Number\(scrapedAt\) \* 1000/, "must convert Unix seconds to ms");
  // Both card views must pass scrapedAt
  assert.match(jobCard, /ago\(job\.postedAt, job\.scrapedAt\)/, "must pass scrapedAt to ago()");
});

test("7-day expiry cron is extracted into runExpiredJobsCleanup and called at startup", () => {
  // Startup call ensures missed cron windows don't leave stale jobs on the board.
  assert.match(server, /function runExpiredJobsCleanup\(\)/, "cleanup must be a named function");
  assert.match(server, /cron\.schedule.*runExpiredJobsCleanup/, "cron must call the named function");
  // Startup call via setImmediate in app.listen
  const listenBlock = server.slice(server.indexOf("app.listen(PORT"));
  assert.match(listenBlock, /runExpiredJobsCleanup\(\)/, "startup must call runExpiredJobsCleanup");
});

test("search suggestion panel clears after Enter/submit via searchCommitted state", () => {
  assert.match(jobsPanel, /searchCommitted.*useState\(false\)|useState\(false\).*searchCommitted/, "searchCommitted state must exist");
  assert.match(jobsPanel, /setSearchCommitted\(true\)/, "must set searchCommitted on submit");
  assert.match(jobsPanel, /setSearchCommitted\(false\)/, "must reset searchCommitted on input change");
  assert.match(jobsPanel, /!searchCommitted.*showPreview|showPreview.*searchCommitted/, "showPreview must respect searchCommitted");
});

test("simple_apply_profiles stores and exposes yearsExperience from base resume", () => {
  assert.match(server, /extractUserYearsExperience/, "server must import extractUserYearsExperience");
  // Migration adds the column
  assert.match(server, /049_simple_apply_profile_yoe/, "migration 049 must exist");
  assert.match(server, /ADD COLUMN years_experience INTEGER/, "migration must add years_experience column");
  // Service extracts, stores, and returns the field
  assert.match(simpleProfileSvc, /export function extractUserYearsExperience/, "service must export extractUserYearsExperience");
  assert.match(simpleProfileSvc, /years_experience.*excluded\.years_experience/, "upsert must persist years_experience");
  assert.match(simpleProfileSvc, /yearsExperience: row\.years_experience/, "load must return yearsExperience");
});

test("/api/jobs auto-applies YoE hard constraint from stored signals when no explicit maxYoe is set", () => {
  const routeStart = server.indexOf('app.get("/api/jobs"');
  const routeEnd   = server.indexOf("\napp.", routeStart + 10);
  const block      = server.slice(routeStart, routeEnd);

  // Must load signals and use yearsExperience
  assert.match(block, /loadSimpleApplyProfile/, "must call loadSimpleApplyProfile");
  assert.match(block, /signals\?\.yearsExperience/, "must check yearsExperience from signals");
  assert.match(block, /yearsExperience \+ 2/, "must use +2 year buffer for stretch goals");
  // Must only apply when the user hasn't set an explicit maxYoe. The check was extracted into an
  // `explicitMaxYoe` variable — same semantics, so the assertion follows the rename.
  assert.match(block, /explicitMaxYoe !== null/, "hard constraint must only apply when maxYoe is not set");
  // The constraint must exclude jobs requiring more than user's band
  assert.match(block, /sj\.min_years_exp IS NULL OR sj\.min_years_exp <= \?/, "must filter by min_years_exp");
});

// ── Phase 4: collar gate wired into every ingest point ───────────────────────
import { classifyJob } from "../services/jobs/classifyJob.js";

test("phase4: aggregator imports classifyJob (unified collar gate) not classifyForIngest", () => {
  const agg = fs.readFileSync("services/jobs/aggregator.js", "utf8");
  // The named-import list is matched loosely on purpose: the property under test is WHICH gate the
  // aggregator classifies through, not how many other symbols it happens to pull from the same
  // module. It now also imports ROLE_KEY_FALLBACK from there, for the unclassified-import bucket
  // (see upsertCanonicalJob) — pinning the exact one-symbol form made that a test failure with no
  // behavioural change behind it.
  assert.match(agg, /import \{[^}]*\bclassifyJob\b[^}]*\} from '\.\/classifyJob\.js'/, "aggregator must import classifyJob");
  assert.doesNotMatch(agg, /import \{ classifyForIngest \}/, "aggregator must not import classifyForIngest (replaced by classifyJob)");
});

test("phase4: aggregator cacheJobs ejects blue-collar into rejected_jobs", () => {
  const agg = fs.readFileSync("services/jobs/aggregator.js", "utf8");
  assert.match(agg, /INSERT OR REPLACE INTO rejected_jobs/, "cacheJobs must upsert rejected_jobs for blue-collar jobs");
  assert.match(agg, /blue_collar/, "rejection reason must be blue_collar");
  assert.match(agg, /collar === 'blue'/, "must check collar === 'blue'");
  assert.match(agg, /DELETE FROM scraped_jobs/, "must DELETE existing scraped_jobs row on eject");
  assert.match(agg, /DELETE FROM job_role_map/, "must DELETE existing job_role_map row on eject");
});

test("phase4: aggregator cacheJobs stores collar and confidence on every insert", () => {
  const agg = fs.readFileSync("services/jobs/aggregator.js", "utf8");
  assert.match(agg, /collar.*classification_confidence/, "INSERT must include collar and classification_confidence columns");
  assert.match(agg, /collar:\s*'white'/, "inserted jobs must carry collar='white'");
});

test("phase4: server.js LinkedIn ingest imports unifiedClassifyJob and gates on collar", () => {
  assert.match(server, /import \{ classifyJob as unifiedClassifyJob \} from "\.\/services\/jobs\/classifyJob\.js"/, "server.js must import unifiedClassifyJob");
  assert.match(server, /unifiedClassifyJob\(item\.title/, "insertMany must call unifiedClassifyJob per job");
  assert.match(server, /collar === 'blue'.*skip insert|skip insert.*collar === 'blue'/s, "insertMany must skip insert for blue-collar jobs");
});

test("phase4: classifyJob correctly ejects canonical blue-collar titles", () => {
  const blue = [
    ["Delivery Driver",        ""],
    ["Warehouse Associate",    ""],
    ["Warehouse Manager",      ""],   // Policy #1 — supervisory blue
    ["Line Cook",              ""],
    ["Restaurant Manager",     ""],   // Policy #1 — supervisory blue
    ["Store Manager",          ""],   // Policy #1 — supervisory blue
    ["Construction Superintendent", ""], // Policy #1
    ["Cashier",                ""],
    ["Forklift Operator",      ""],
    ["Home Health Aide",       ""],
  ];
  for (const [title, desc] of blue) {
    const r = classifyJob(title, desc, "");
    assert.equal(r.collar, "blue", `"${title}" should be blue-collar`);
    assert.equal(r.roleKey, null, `"${title}" should have null roleKey`);
  }
});

test("phase4: classifyJob keeps white-collar titles with a strong role anchor even when blue token present", () => {
  const white = [
    ["Warehouse Operations Analyst",  ""],  // blue token + strong white anchor
    ["Fleet Software Engineer",       ""],  // blue token + strong white anchor
    ["Security Engineer",             ""],  // "security" is blue-adjacent, but engineer rescues
    ["Field Service Engineer",        ""],  // service/field could be ambiguous; engineer rescues
  ];
  for (const [title, desc] of white) {
    const r = classifyJob(title, desc, "");
    assert.equal(r.collar, "white", `"${title}" should be white-collar`);
    assert.notEqual(r.roleKey, null, `"${title}" should have a non-null roleKey (got ${r.roleKey})`);
  }
});
