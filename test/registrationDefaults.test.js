import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("registration defaults new users to Basic Simple Apply", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  const databasePanel = fs.readFileSync("client/src/panels/DatabasePanel.jsx", "utf8");

  assert.match(server, /apply_mode,plan_tier\) VALUES \(\?,\?,0,'SIMPLE','BASIC'\)/);
  assert.match(server, /applyMode:"SIMPLE", planTier:"BASIC"/);
  assert.match(topBar, /currentMode = user\?\.applyMode \|\| "SIMPLE"/);
  assert.match(jobsPanel, /applyMode = user\?\.applyMode \|\| "SIMPLE"/);
  assert.doesNotMatch(databasePanel, /applyMode=\{user\?\.applyMode \|\| "TAILORED"\}/);
});
