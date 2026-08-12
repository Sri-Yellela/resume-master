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

// §5.13 RESOLVED — it was a regression, and the client is what proved it.
//
// This test used to record an undecidable gap: routes/apply.js imported nothing from
// integrationReadiness.js, and getMissingApplyPrerequisites had zero callers. What settled it was
// JobsPanel's startApplyRun catch block, which already reads `missingPrerequisites` off the error
// payload to render "Setup needed in Integrations: …". The client was honouring a contract whose
// server half had been deleted, so the run endpoint could never send what the UI was waiting for.
// The gate is restored at POST /api/apply/runs and asserted on both sides below.
//
// (`requiresLinkedInSession`, which this note used to name alongside it, does not exist at all —
// see the correction in docs/PIPELINE_DIAGNOSIS.md §5.13.)
test("apply surface has a readiness gate and points users at Integrations", () => {
  assert.match(applyRoute, /app\.get\("\/api\/apply\/readiness"/);
  assert.match(applyRoute, /probeBrowserAvailability/);
  assert.match(jobsPanel, /Setup needed in Integrations/);
});

test("starting an apply run is gated server-side on the centralized prerequisites", () => {
  assert.match(applyRoute, /import \{ getAutomationReadiness, getMissingApplyPrerequisites \}/,
    "the run endpoint must use the centralized readiness helpers, not a local re-check");

  // RE-POINTED: the gate now lives in startRun(), the shared run-admission function, rather than
  // inline in POST /api/apply/runs. That extraction is what makes the validation-correction retry
  // go through the SAME admission control as a fresh run — so asserting on the shared function is
  // now the stronger check: it covers both entry points at once.
  const runsStart = applyRoute.indexOf("function startRun(");
  assert.ok(runsStart > 0, "startRun must exist as the single run-admission path");
  const runsEnd = applyRoute.indexOf('app.post("/api/apply/runs"', runsStart);
  const runsBlock = applyRoute.slice(runsStart, runsEnd);

  assert.match(runsBlock, /getMissingApplyPrerequisites\(getAutomationReadiness\(db, userId\)\)/);
  const gateAt = runsBlock.indexOf("missingPrerequisites.length");
  const insertAt = runsBlock.indexOf("INSERT INTO apply_runs");
  assert.ok(gateAt > 0 && insertAt > 0 && gateAt < insertAt,
    "the prerequisite check must precede the apply_runs insert");

  // Every caller of startRun must go through it rather than inserting a run itself.
  const inserts = applyRoute.match(/INSERT INTO apply_runs/g) || [];
  assert.equal(inserts.length, 1, "apply_runs must be written in exactly one place");
  assert.match(applyRoute, /const r = startRun\(req\.user\.id, normalisePlanTier\(req\.user\?\.planTier\), jobIds/,
    "POST /api/apply/runs must delegate to startRun");
  assert.match(applyRoute, /const retry = startRun\(req\.user\.id, normalisePlanTier\(req\.user\?\.planTier\), toRetry/,
    "the correction-loop retry must delegate to startRun too, so no guard is bypassed");

  // The response shape is the contract the client already implements — assert the field name,
  // since renaming it would silently degrade the message back to a generic failure.
  assert.match(runsBlock, /respond\(409, \{[\s\S]*?missingPrerequisites,/);
  assert.match(jobsPanel, /e\.payload\?\.missingPrerequisites/,
    "client must keep reading the field the server sends");
});

test("centralized readiness is still consumed by the account/integrations surface", () => {
  // getAutomationReadiness itself is very much alive — it just moved consumers.
  assert.match(accountRoute, /getAutomationReadiness/);
  assert.match(readiness, /getAutomationReadiness/);
});
