import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync("server.js", "utf8");
const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

test("scrape route guards missing active profile before profile-scoped local count", () => {
  const routeStart = server.indexOf('app.post("/api/scrape"');
  assert.ok(routeStart > 0, "scrape route should exist");
  const localCount = server.indexOf("DB-first: count fresh unvisited quality jobs", routeStart);
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
  assert.match(jobsPanel, /d\.needsProfileSetup/);
  assert.match(jobsPanel, /result\.needsProfileSetup/);
  assert.match(jobsPanel, /pollData\.needsProfileSetup/);
  assert.match(jobsPanel, /pollData\.scrapeUnavailable/);
  assert.match(jobsPanel, /Create a job search profile/);
});
