import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync("server.js", "utf8");

test("manual scrape builds outbound params from active profile plus stored user signals", () => {
  const routeStart = server.indexOf('app.post("/api/scrape"');
  assert.ok(routeStart > 0, "scrape route should exist");
  const scrapeRoute = server.slice(routeStart, server.indexOf("app.post(\"/api/jobs/:id/keywords\"", routeStart));

  assert.match(scrapeRoute, /buildApifyQueriesFromProfile\(activeProfile\)/);
  assert.match(scrapeRoute, /loadOrCreateSimpleApplyProfile\(db, \{/);
  assert.match(scrapeRoute, /profileId: activeProfile\.id/);
  assert.match(scrapeRoute, /roleTitles: activeProfileTitles/);
  assert.match(scrapeRoute, /simpleProfile\?\.searchTerms/);
  assert.match(scrapeRoute, /buildProfileSearchTerms\(activeProfile, terms\)/);
  assert.match(scrapeRoute, /maxItems: activeProfile\.domain === "engineering_embedded_firmware" \? 75 : undefined/);
  assert.match(scrapeRoute, /employmentTypes/);
  assert.match(scrapeRoute, /workplaceTypes/);
  assert.match(scrapeRoute, /postedLimit/);
  assert.match(scrapeRoute, /location/);
});

test("active scrape tracking is profile-scoped and duplicate outbound work is deduped", () => {
  assert.match(server, /function scrapeStateKey\(userId, profileId, query\)/);
  assert.match(server, /scrapeStateKey\(userId, activeProfile\.id, qRaw\)/);
  assert.match(server, /scrapeStateKey\(scrapeUserId, activeProfile\.id, query\)/);
  assert.match(server, /const inFlightScrape = activeScrapes\.get\(scrapeKey\)/);
  assert.match(server, /deduped:true/);
});

test("ATS scoring reuses stored signal basis through the queue", () => {
  assert.match(server, /const atsScoreQueue = \[\]/);
  assert.match(server, /let anthropicAtsUnavailableUntil = 0/);
  assert.match(server, /function enqueueAtsScoreWork\(label, worker\)/);
  assert.match(server, /enqueueAtsScoreWork\(`scrape:\$\{userId\}:\$\{query\}`/);
  assert.match(server, /buildAtsResumeBasis\(baseResumeText, simpleProfile\)/);
  assert.match(server, /isAnthropicCreditError/);
  assert.match(server, /ats_unavailable_due_to_credits/);
  assert.match(server, /enqueueAtsScoreWork\(`adopt-enhanced:\$\{userId\}:\$\{profileId\}`/);
  assert.match(server, /buildAtsResumeBasis\(newContent, signalProfile\)/);
});

test("structured search thread logging includes outbound payload and filter summary", () => {
  assert.match(server, /function searchThreadId\(\)/);
  assert.match(server, /function logSearchThread\(threadId, event, details = \{\}\)/);
  assert.match(server, /logSearchThread\(threadId, "request"/);
  assert.match(server, /logSearchThread\(scrapeParams\.threadId, "apify_payload"/);
  assert.match(server, /logSearchThread\(scrapeParams\.threadId, "scrape_filter_summary"/);
  assert.match(server, /logSearchThread\(threadId, "db_first"/);
  assert.match(server, /logSearchThread\(threadId, "background_complete"/);
});
