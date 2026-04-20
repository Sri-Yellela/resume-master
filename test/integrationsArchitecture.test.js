import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync("server.js", "utf8");
const applyRoute = fs.readFileSync("routes/apply.js", "utf8");
const readiness = fs.readFileSync("services/integrationReadiness.js", "utf8");
const app = fs.readFileSync("client/src/App.jsx", "utf8");
const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");
const integrations = fs.readFileSync("client/src/panels/IntegrationsPanel.jsx", "utf8");
const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

test("integrations backend centralizes connector status and storage", () => {
  assert.match(server, /CREATE TABLE IF NOT EXISTS user_integrations/);
  assert.match(server, /app\.get\("\/api\/integrations\/status"/);
  assert.match(server, /app\.patch\("\/api\/integrations\/apify-token"/);
  assert.match(server, /app\.post\("\/api\/integrations\/:provider"/);
  assert.match(readiness, /getAutomationReadiness/);
  assert.match(readiness, /gmail/);
  assert.match(readiness, /google/);
  assert.match(readiness, /getLinkedInStatus/);
});

test("integrations page is routed and replaces scattered Apify menu input", () => {
  assert.match(app, /IntegrationsPanel/);
  assert.match(app, /id:"integrations"/);
  assert.match(topBar, /onTabChange\?\.\("integrations"\)/);
  assert.doesNotMatch(topBar, /Apify Token/);
  assert.match(integrations, /title="Apify"/);
  assert.match(integrations, /title="Gmail"/);
  assert.match(integrations, /title="Google Login"/);
  assert.match(integrations, /title="LinkedIn"/);
  assert.match(integrations, /title="Resume and Profile"/);
});

test("apply and search surfaces consume centralized integration readiness", () => {
  assert.match(applyRoute, /getAutomationReadiness/);
  assert.match(applyRoute, /getMissingApplyPrerequisites/);
  assert.match(applyRoute, /requiresLinkedInSession/);
  assert.match(applyRoute, /integrationsPath: "\/app\/integrations"/);
  assert.match(jobsPanel, /open Integrations to add it/i);
  assert.match(jobsPanel, /Setup needed in Integrations/);
});
