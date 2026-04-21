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
