import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("search pipeline remains active-profile driven on the server", () => {
  const server = fs.readFileSync("server.js", "utf8");

  assert.match(server, /const query = normaliseRole\(rawQuery\)/);
  assert.match(server, /buildApifyQueriesFromProfile\(activeProfile\)/);
  assert.match(server, /\.\.\.\(profileJobTitles \? \{ jobTitles: profileJobTitles \} : \{\}\)/);
  assert.match(server, /scrapeJobs\(query, token, scrapeParams, activeProfile\?\.id \?\? null\)/);
  assert.match(server, /jrm\.role_key = \?/);
  assert.match(server, /roleTitleSql\("sj\.title", roleKey\)/);
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
  assert.match(jobsPanel, /handleSearch\(pendingQuery, \{ skipProfileIntent: true \}\)/);
  assert.match(jobsPanel, /Search canceled/);
  assert.match(jobsPanel, /profileWizardIntent\?\.domainKey/);
  assert.match(wizard, /initialDomainKey = null/);
  assert.match(wizard, /if \(initialDomainKey && !domainKey\) setDomainKey\(initialDomainKey\)/);
  assert.match(topBar, /profile_switched: \(\{ profileId \}\) =>/);
});

test("jobs search blocks missing setup states before running search", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(jobsPanel, /Create a job search profile before searching jobs/);
  assert.match(jobsPanel, /Upload your base resume before searching jobs/);
  assert.match(jobsPanel, /SetupGateNotice/);
});
