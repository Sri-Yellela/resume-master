import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("app routes users into one shared jobs console", () => {
  const app = fs.readFileSync("client/src/App.jsx", "utf8");
  const consoles = fs.readFileSync("client/src/consoles/PlanConsoles.jsx", "utf8");

  assert.match(app, /CONSOLE_ROUTE = "jobs"/);
  assert.match(app, /LEGACY_CONSOLE_ROUTES/);
  assert.match(app, /label:"Jobs"/);
  assert.match(app, /<Route path="\/app\/\*"/);
  assert.match(consoles, /function JobsConsole/);
  assert.match(consoles, /consoleKind="jobs"/);
  assert.doesNotMatch(consoles, /Shared console|ATS Search, ATS Sort, saved jobs/);
  assert.doesNotMatch(consoles, /Generate Console|A\+ Console|Baseline Console/);
});

test("plan updates refresh console state without mode switching", () => {
  const app = fs.readFileSync("client/src/App.jsx", "utf8");
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");
  const plans = fs.readFileSync("client/src/panels/PlansPanel.jsx", "utf8");
  const server = fs.readFileSync("server.js", "utf8");
  const accountRoute = fs.readFileSync("routes/account.js", "utf8");

  assert.match(app, /plan_updated/);
  assert.match(app, /navigate\(consolePath/);
  assert.match(plans, /requestPlanChange/);
  assert.match(plans, /Request \{tier === "BASIC" \? "downgrade" : "upgrade"\}/);
  assert.match(server, /createAccountRouter/);
  assert.match(accountRoute, /changeOptions/);
  assert.match(server, /function requireToolEntitlement/);
  assert.match(server, /function legacyModeForTool/);
  assert.doesNotMatch(server, /Next available upgrade|Already on highest plan/);
  assert.doesNotMatch(topBar, /APPLY_MODES|Apply Mode|\/api\/settings\/apply-mode/);
});

test("data repair migration protects tier and profile integrity", () => {
  const server = fs.readFileSync("server.js", "utf8");

  assert.match(server, /036_console_tier_profile_repair/);
  assert.match(server, /UPDATE users\s+SET plan_tier = 'BASIC'/);
  assert.match(server, /UPDATE users\s+SET apply_mode = CASE plan_tier/);
  assert.match(server, /DELETE FROM job_role_map\s+WHERE job_id NOT IN/);
  assert.match(server, /DELETE FROM user_jobs\s+WHERE applied = 0/);
  assert.match(server, /uj\.domain_profile_id = \?/);
  assert.match(server, /Job not available for active profile/);
});
