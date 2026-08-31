// SCRAPING — SCHEDULED FOR REMOVAL AFTER MIGRATION
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
  //
  // ONE deliberate exemption, added with the Saved-tab fix: the board's own path applies the title
  // filter unless `savedTab`. The Saved ★ tab lists jobs the user explicitly starred, so narrowing it
  // by the profile's target titles hid the user's own saved jobs from them — measured at 1 of 3.
  // The exemption is asserted here, rather than the test simply being relaxed, so that it stays a
  // named exception to a live invariant instead of quietly becoming the rule.
  assert.match(server, /const titleFilter = savedTab \? \{ sql: "1 = 1", params: \[\] \}\s*\n\s*: profileTitleSql\("sj\.title", sessionActiveProfile\)/);
  assert.match(server, /const savedTab = starred === '1'/,
    "the exemption must be keyed off the Saved tab alone, not off any broader condition");
  assert.match(server, /const pollProfileTitleFilter = profileTitleSql\("sj\.title", activeProfile\)/);
  assert.match(server, /const pendingProfileTitleFilter = profileTitleSql\("sj\.title", activeProfile\)/);
});

test("the Saved tab is exempt from discovery narrowing, and only the Saved tab is", () => {
  // The three narrowings the Saved tab drops — role_key join, profileTitleSql, profile bridge — and
  // the proof that each drop is conditional on savedTab rather than removed outright. A regression
  // here is invisible in behaviour until someone stars a job the classifier bucketed elsewhere.
  assert.match(server, /\$\{savedTab \? '' : 'JOIN job_role_map jrm ON jrm\.job_id = sj\.job_id AND jrm\.role_key = \?'\}/,
    "the role_key INNER JOIN must still be present for every non-Saved board");
  assert.match(server, /const derivedFilters = \(req\.query\.curate === 'off' \|\| savedTab\)/,
    "the profile bridge must not curate the user's own saved jobs");
  // The args list has to track the join, or every bound parameter after it shifts by one.
  assert.match(server, /\.\.\.\(savedTab \? \[\] : \[roleKey\]\)/,
    "no role_key placeholder on the Saved tab means no roleKey argument either");
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
