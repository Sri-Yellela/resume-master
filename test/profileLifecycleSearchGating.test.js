// SCRAPING � SCHEDULED FOR REMOVAL AFTER MIGRATION
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync("server.js", "utf8");
const profileTitleFilter = fs.readFileSync("services/profileTitleFilter.js", "utf8");
const domainProfiles = fs.readFileSync("routes/domainProfiles.js", "utf8");
const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

test("jobs and scrape endpoints expose controlled no-profile and no-resume states", () => {
  assert.match(server, /needsProfileSetup: true/);
  assert.match(server, /function getOrRepairActiveProfile\(userId\)/);
  assert.match(server, /UPDATE domain_profiles SET is_active=1/);
  assert.match(server, /function userHasBaseResume\(userId\)/);
  assert.match(server, /profileHasBaseResume\(db, \{ userId, profileId: activeProfile\.id \}\)/);
  assert.match(server, /needsBaseResume: true/);
  assert.match(server, /reason: "no_base_resume"/);
  // The user-facing copy lives in the CLIENT, not server.js — the server exposes the state
  // (needsBaseResume / reason: "no_base_resume", both asserted above) and JobsPanel renders the
  // message. This assertion was simply pointed at the wrong file; the gate itself is fully live.
  assert.match(jobsPanel, /Upload the active profile's base resume before searching jobs/);
});

test("job grouping requires selected profile title predicates in addition to role family", () => {
  assert.match(server, /import \{ profileTitleSql \} from "\.\/services\/profileTitleFilter\.js"/);
  assert.match(profileTitleFilter, /export function profileTitleSql\(column, profile\)/);
  // The board's filter was renamed activeProfileTitleFilter -> titleFilter, and
  // scrapeProfileTitleFilter went with the retired scrape route. The three query paths that
  // still exist must each apply it — that is the invariant this test is for (wrong-profile jobs
  // must not leak into any of them), and it holds.
  assert.match(server, /const titleFilter = profileTitleSql\("sj\.title", sessionActiveProfile\)/);
  assert.match(server, /const pollProfileTitleFilter = profileTitleSql\("sj\.title", activeProfile\)/);
  assert.match(server, /const pendingProfileTitleFilter = profileTitleSql\("sj\.title", activeProfile\)/);
});

test("domain profile API repairs zero-active profile state and marks empty profile setup incomplete", () => {
  assert.match(domainProfiles, /!rows\.some\(r => r\.is_active\)/);
  assert.match(domainProfiles, /UPDATE domain_profiles SET is_active=1/);
  assert.match(domainProfiles, /domain_profile_complete=\?/);
});

test("jobs UI does not keep a stale active profile id when there are no profiles", () => {
  assert.match(jobsPanel, /const activeProfileKey = activeDomainProfile\?\.id \|\| null/);
  assert.match(jobsPanel, /Create a job profile/);
  assert.match(jobsPanel, /Upload a profile resume/);
});
