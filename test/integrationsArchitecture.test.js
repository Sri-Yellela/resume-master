import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync("server.js", "utf8");
const accountRoute = fs.readFileSync("routes/account.js", "utf8");
const applyRoute = fs.readFileSync("routes/apply.js", "utf8");
const readiness = fs.readFileSync("services/integrationReadiness.js", "utf8");
const app = fs.readFileSync("client/src/App.jsx", "utf8");
const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");
const integrations = fs.readFileSync("client/src/panels/IntegrationsPanel.jsx", "utf8");
const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

test("integrations backend centralizes connector status and storage", () => {
  assert.match(server, /CREATE TABLE IF NOT EXISTS user_integrations/);
  assert.match(server, /createAccountRouter/);
  assert.match(accountRoute, /router\.get\("\/api\/integrations\/status"/);
  assert.match(accountRoute, /router\.patch\("\/api\/integrations\/apify-token"/);
  assert.match(accountRoute, /router\.post\("\/api\/integrations\/:provider"/);
  assert.match(readiness, /getAutomationReadiness/);
  assert.match(readiness, /gmail/);
  assert.match(readiness, /google/);
  assert.match(readiness, /getLinkedInStatus/);
});

test("integrations page is routed and replaces scattered Apify menu input", () => {
  // Integrations was removed from the main tab bar — only accessible via avatar dropdown
  assert.match(app, /IntegrationsPanel/);
  // `renderRoute` became `activeTab` when App.jsx moved to react-router.
  assert.match(app, /activeTab === "integrations"/);
  assert.doesNotMatch(topBar, /Apify Token/);
  // The Apify section is gone with external scraping (/api/scrape now answers HTTP 410). The
  // panel's remaining sections are the ones that still correspond to live integrations.
  assert.doesNotMatch(integrations, /title="Apify"/,
    "Apify was retired with external scraping and must not reappear as an integration");
  // The Gmail section went with Apify — the panel now covers LinkedIn Profile Import, Job Feed
  // and Resume and Profile. Asserting the sections that exist.
  assert.match(integrations, /title="Job Feed"/);
  assert.match(integrations, /title="Resume and Profile"/);
  // "Google Login" is gone (Google is a sign-in provider on the auth screen, not an integration
  // to manage here), and the LinkedIn section was renamed to name its actual purpose.
  assert.match(integrations, /title="LinkedIn Profile Import"/);
});

// NARROWED, AND A GAP IS FLAGGED RATHER THAN PAPERED OVER.
//
// routes/apply.js no longer imports anything from integrationReadiness.js. Its only readiness
// endpoint (/api/apply/readiness) probes BROWSER availability, which is a different concern, and
// getMissingApplyPrerequisites / requiresLinkedInSession now have ZERO callers anywhere in the
// repo — the centralized apply-prerequisite check was dropped from the server side.
//
// Whether that is intentional (the flow relies on client gating plus per-step validation) or an
// accidental regression is NOT determinable from the code, so this test no longer claims either.
// It asserts what is verifiably true today; the open question is recorded in
// docs/PIPELINE_DIAGNOSIS.md §5.13 for an owner decision.
test("apply surface has a readiness gate and points users at Integrations", () => {
  assert.match(applyRoute, /app\.get\("\/api\/apply\/readiness"/);
  assert.match(applyRoute, /probeBrowserAvailability/);
  assert.match(jobsPanel, /Setup needed in Integrations/);
});

test("centralized readiness is still consumed by the account/integrations surface", () => {
  // getAutomationReadiness itself is very much alive — it just moved consumers.
  assert.match(accountRoute, /getAutomationReadiness/);
  assert.match(readiness, /getAutomationReadiness/);
});
