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
  const engStart = server.indexOf('if (roleKey === "engineering") return');
  assert.ok(engStart > 0, "engineering roleTitleSql case must exist");
  // Find the closing of the engineering block by locating the next roleKey check
  const nextCase = server.indexOf('if (roleKey === "engineering_embedded_firmware")', engStart);
  assert.ok(nextCase > engStart, "engineering_embedded_firmware case must follow engineering case");

  const engBlock = server.slice(engStart, nextCase);
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
  const fwStart = server.indexOf('if (roleKey === "engineering_embedded_firmware") return');
  assert.ok(fwStart > 0, "engineering_embedded_firmware roleTitleSql case must exist");
  const pmCase = server.indexOf('if (roleKey === "pm") return', fwStart);
  const fwBlock = server.slice(fwStart, pmCase);

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
