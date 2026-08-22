import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Was "search pipeline remains active-profile driven on the server". Every one of its six
// assertions described the removed Apify scrape route — buildApifyQueriesFromProfile(activeProfile),
// scrapeJobs(query, token, scrapeParams, ...), roleTitleSql("sj.title", roleKey). The route is
// gone: /api/scrape now answers HTTP 410 "External scraping has been removed. Job search now
// uses /api/jobs." So this could never pass again, and it was one of the failures keeping the
// baseline pinned to a pre-pivot architecture (see docs/PIPELINE_DIAGNOSIS.md §5.11).
// Replaced by the inverse guard: scraping must STAY retired.
test("external scraping stays retired", () => {
  const server = fs.readFileSync("server.js", "utf8");

  assert.match(server, /app\.post\("\/api\/scrape",[\s\S]{0,200}?410/,
    "/api/scrape must remain a 410 tombstone rather than being reimplemented");
  assert.doesNotMatch(server, /app\.post\("\/api\/jobs\/scrape"/,
    "the per-user scrape route must not return");
  // The board is served from the stored pool via buildJobFilters, not an outbound crawl.
  assert.match(server, /buildJobFilters\(filterParams, \{ derivedKeys: appliedDerivedKeys \}\)/,
    "/api/jobs must still compose its filters through buildJobFilters — and must hand it the " +
    "provenance of each key, which is what makes derived values rank instead of exclude");
});

test("frontend detects strong cross-profile search intent before scrape", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(jobsPanel, /SEARCH_PROFILE_INTENTS/);
  assert.match(jobsPanel, /ROLE_ALIAS_MAP/);
  assert.match(jobsPanel, /mergeIntentTerms\(BASE_SEARCH_PROFILE_INTENTS\)/);
  assert.match(jobsPanel, /engineering_embedded_firmware/);
  assert.match(jobsPanel, /"firmware"/);
  assert.match(jobsPanel, /intentDomainForAlias/);
  assert.match(jobsPanel, /detectSearchProfileIntent\(query, domainProfiles, activeDomainProfile\)/);
  assert.match(jobsPanel, /This search looks like \$\{intent\.label\}/);
  assert.match(jobsPanel, /Switch to "\$\{intent\.existingProfile\.profile_name\}" for this search/);
  assert.match(jobsPanel, /Add that profile before searching/);
  assert.match(jobsPanel, /SearchIntentDialog/);
  assert.doesNotMatch(jobsPanel, /confirm\(\s*`This search/);
});

test("confirmed profile-intent switch runs search after activation and declined prompts block wrong-profile search", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  const wizard = fs.readFileSync("client/src/components/DomainProfileWizard.jsx", "utf8");
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");

  assert.match(jobsPanel, /await activateProfileForSearch\(intent\.existingProfile\.id\)/);
  // handleSearch was renamed handleSetRole. This assertion was stale, NOT scraping-era — the
  // confirmed-switch-then-search behaviour it guards is live, so the name is corrected rather
  // than the test retired.
  assert.match(jobsPanel, /handleSetRole\(pendingQuery, \{ skipProfileIntent: true \}\)/);
  assert.match(jobsPanel, /Search canceled/);
  assert.match(jobsPanel, /profileWizardIntent\?\.domainKey/);
  assert.match(wizard, /initialDomainKey = null/);
  assert.match(wizard, /if \(initialDomainKey && !domainKey\) setDomainKey\(initialDomainKey\)/);
  assert.match(topBar, /profile_switched: \(\{ profileId \}\) =>/);
});

test("jobs search blocks missing setup states before running search", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(jobsPanel, /Create a job search profile before searching jobs/);
  assert.match(jobsPanel, /Upload the active profile's base resume before searching jobs/);
  assert.match(jobsPanel, /SetupGateNotice/);
});
