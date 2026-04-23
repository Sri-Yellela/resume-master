import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync("server.js", "utf8");
const jobClassifier = fs.readFileSync("services/jobClassifier.js", "utf8");
const profileTitleFilter = fs.readFileSync("services/profileTitleFilter.js", "utf8");
const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
const simpleProfileSvc = fs.readFileSync("services/simpleApplyProfile.js", "utf8");

test("scrape route guards missing active profile before profile-scoped local count", () => {
  const routeStart = server.indexOf('app.post("/api/scrape"');
  assert.ok(routeStart > 0, "scrape route should exist");
  const localCount = server.indexOf("DB-first: count unvisited quality jobs scraped in the last 30 days for this role", routeStart);
  assert.ok(localCount > routeStart, "DB-first local count should exist");

  const preCount = server.slice(routeStart, localCount);
  assert.match(preCount, /if \(!activeProfile\)/);
  assert.match(preCount, /needsProfileSetup: true/);
  assert.match(preCount, /reason: "no_active_profile"/);
});

test("scrape quota exhaustion is classified and surfaced through poll state", () => {
  assert.match(server, /function isExternalScrapeQuotaError/);
  assert.match(server, /monthly usage hard limit exceeded/);
  assert.match(server, /scrape_quota_exhausted/);
  assert.match(server, /scrapeUnavailable/);
  assert.match(server, /Daily re-scrape skipped: external scrape quota exhausted/);
});

test("frontend handles missing profile and local-only scrape unavailable responses", () => {
  // fetchJobs (d.*) no longer sets scrapeError for needsProfileSetup — setupBlock gate handles it
  assert.match(jobsPanel, /setupBlock/);
  assert.match(jobsPanel, /SetupGateNotice/);
  // scrape start (result.*) and poll (pollData.*) still check needsProfileSetup
  assert.match(jobsPanel, /result\.needsProfileSetup/);
  assert.match(jobsPanel, /pollData\.needsProfileSetup/);
  assert.match(jobsPanel, /pollData\.scrapeUnavailable/);
  assert.match(jobsPanel, /Create a job search profile/);
});

test("roleTitleSql engineering excludes all firmware/embedded keyword families", () => {
  assert.match(server, /import \{ getRoleKeyForProfile as _getRoleKeyForProfile, classifyForIngest, getRoleFamilyDomainForKey, roleTitleSql \} from "\.\/services\/jobClassifier\.js"/);
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

test("jobs board uses triple filter — role_key + roleTitleSql + profileTitleSql on every query", () => {
  // All three filters must appear together in the /api/jobs GET conditions array
  const routeStart = server.indexOf('app.get("/api/jobs"');
  assert.ok(routeStart > 0, "/api/jobs route must exist");
  const routeEnd   = server.indexOf("\napp.", routeStart + 10);
  const block      = server.slice(routeStart, routeEnd);

  assert.match(block, /jrm\.role_key = \?/, "must filter by role_key");
  assert.match(block, /roleTitleSql\(/, "must apply roleTitleSql");
  assert.match(block, /profileTitleSql\(/, "must apply profileTitleSql");
  assert.match(profileTitleFilter, /export function profileTitleSql\(column, profile\)/, "profile title filter must be extracted");
  // Profile filter must be first guard — no-profile returns empty immediately
  assert.match(block, /if \(!sessionActiveProfile\)/, "must guard on missing active profile");
});

test("poll board uses same triple filter to prevent wrong-profile jobs leaking", () => {
  const pollStart = server.indexOf('app.get("/api/jobs/poll"');
  assert.ok(pollStart > 0, "/api/jobs/poll route must exist");
  const pollEnd   = server.indexOf("\napp.", pollStart + 10);
  const block     = server.slice(pollStart, pollEnd);

  assert.match(block, /jrm\.role_key = \?/, "poll must filter by role_key");
  assert.match(block, /roleTitleSql\(/, "poll must apply roleTitleSql");
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

test("manual search renders local board before profile-driven scrape starts", () => {
  const searchStart = jobsPanel.indexOf("const handleSearch");
  assert.ok(searchStart > 0, "handleSearch must exist");
  const searchEnd = jobsPanel.indexOf("// -- Pull / Check-for-new", searchStart);
  const block = jobsPanel.slice(searchStart, searchEnd);

  const localFetch = block.indexOf("await fetchJobs(1, false, { overrides: { role: immediateRoleQ } })");
  const scrapeCall = block.indexOf('api("/api/scrape"');
  assert.ok(localFetch > 0, "search must explicitly fetch local board rows first");
  assert.ok(scrapeCall > localFetch, "scrape must start after the local board fetch");
  assert.match(block, /buildProfileScrapeRequest\(q\)/, "scrape body must be profile-driven only");
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
  // Triple filter must still be intact
  assert.match(block, /roleTitleSql\(/, "roleTitleSql must still be applied");
  assert.match(block, /profileTitleSql\(/, "profileTitleSql must still be applied");
});

test("/api/jobs response maps scrapedAt so client can render staleness indicator", () => {
  const routeStart = server.indexOf('app.get("/api/jobs"');
  const routeEnd   = server.indexOf("\napp.", routeStart + 10);
  const block      = server.slice(routeStart, routeEnd);
  assert.match(block, /scrapedAt:\s*j\.scraped_at/, "response must expose scrapedAt for staleness UI");
});

test("scrape DB-first count uses 30-day window instead of 7-day", () => {
  // The 7-day window caused the DB-first count to always return 0 if the last scrape
  // was more than a week ago, forcing an unnecessary background scrape every time.
  // A 30-day window matches a realistic job-posting lifecycle.
  const scrapeStart = server.indexOf('app.post("/api/scrape"');
  const scrapeEnd   = server.indexOf("\napp.", scrapeStart + 10);
  const block       = server.slice(scrapeStart, scrapeEnd);

  assert.match(block, /thirtyDaysAgo/, "DB-first count must use thirtyDaysAgo");
  assert.match(block, /30 \* 24 \* 60 \* 60/, "30-day window constant must be present");
  assert.doesNotMatch(block, /sevenDaysAgo/, "7-day variable must not appear in scrape DB-first path");
});

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
  // Must only apply when user hasn't set explicit maxYoe
  assert.match(block, /maxYoe === null/, "hard constraint must only apply when maxYoe is not set");
  // The constraint must exclude jobs requiring more than user's band
  assert.match(block, /sj\.min_years_exp IS NULL OR sj\.min_years_exp <= \?/, "must filter by min_years_exp");
});
