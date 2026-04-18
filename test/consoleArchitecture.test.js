import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("app routes users into dedicated plan consoles", () => {
  const app = fs.readFileSync("client/src/App.jsx", "utf8");
  const consoles = fs.readFileSync("client/src/consoles/PlanConsoles.jsx", "utf8");

  assert.match(app, /CONSOLE_BY_PLAN/);
  assert.match(app, /route:"simple-apply"/);
  assert.match(app, /route:"tailored"/);
  assert.match(app, /route:"custom-sampler"/);
  assert.match(app, /<Route path="\/app\/\*"/);
  assert.match(app, /CONSOLE_ROUTES\.has\(routeKey\) && routeKey !== consoleConfig\.route/);
  assert.match(consoles, /function SimpleApplyConsole/);
  assert.match(consoles, /function TailoredConsole/);
  assert.match(consoles, /function CustomSamplerConsole/);
  assert.match(consoles, /user=\{consoleUser\(props\.user, "SIMPLE"\)\}/);
  assert.match(consoles, /user=\{consoleUser\(props\.user, "TAILORED"\)\}/);
  assert.match(consoles, /user=\{consoleUser\(props\.user, "CUSTOM_SAMPLER"\)\}/);
});

test("plan updates refresh console state without mode switching", () => {
  const app = fs.readFileSync("client/src/App.jsx", "utf8");
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");
  const plans = fs.readFileSync("client/src/panels/PlansPanel.jsx", "utf8");
  const server = fs.readFileSync("server.js", "utf8");

  assert.match(app, /plan_updated/);
  assert.match(app, /allowedModes:\[applyMode\]/);
  assert.match(plans, /requestPlanChange/);
  assert.match(plans, /Request \{tier === "BASIC" \? "downgrade" : "change"\}/);
  assert.match(server, /changeOptions/);
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
