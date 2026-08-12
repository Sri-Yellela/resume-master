import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("jobs filters are staged and only committed by Apply", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(jobsPanel, /function defaultFilterSnapshot/);
  assert.match(jobsPanel, /const \[pendingFilters, setPendingFilters\]/);
  assert.match(jobsPanel, /const applyPendingFilters = useCallback/);
  assert.match(jobsPanel, /onApply=\{applyPendingFilters\}/);
  assert.match(jobsPanel, /setRole=\{value => stageFilter\("roleFilter", value\)\}/);
  assert.match(jobsPanel, /setEmploymentTypePrefs=\{value => stageFilter\("employmentTypePrefs", value\)\}/);
  assert.doesNotMatch(jobsPanel, /role=\{roleFilter\}\s+setRole=\{setRoleFilter\}/);
});

// The two `isDark ? <light> : <dark>` ternaries this asserted are gone: there is exactly one
// theme now (themes/cinematic.js) and isDark is hardcoded true, so the light halves were dead
// branches and were collapsed. The INTENT — the filter drawer must be opaque, not the translucent
// card surface, or the board reads straight through it — is unchanged and still worth pinning.
test("filter panel uses an opaque modal surface", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  // A real dim behind the drawer.
  assert.match(jobsPanel, /background:"rgba\(0,0,0,0\.42\)"/);
  // The drawer itself uses the dedicated modal token, never theme.surface (var(--bg-card), 0.68).
  assert.match(jobsPanel, /background:theme\.modalSurface \|\| "#111827"/);
  assert.match(jobsPanel, /boxShadow:theme\.shadowXl/);
});

// Replaces "LinkedIn import CTA is only rendered from the Starred LinkedIn section", which
// pinned a CTA string that no longer existed even before cleanup 5.3 — it had been failing for
// that reason. The bulk saved-jobs import is now removed outright: its bridge functions were
// stubs returning false/no-op since BYO-2, so the CTA could only ever open an install modal that
// no install could satisfy, and v1.2.0 deleted the extension-side script entirely.
test("the dead LinkedIn bulk-import flow stays removed", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  // Strip comments so the explanatory notes left behind don't satisfy these assertions.
  const code = jobsPanel
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  for (const symbol of [
    "startLinkedInImport", "openLinkedInExtensionPopup", "closeLinkedInImportTab",
    "sendExtensionRequest", "isLinkedInExtensionInstalled", "getLinkedInExtensionInstallUrl",
    "LinkedInInstallDialog", "linkedinInstallModalOpen", "linkedinExtensionNotice",
  ]) {
    assert.doesNotMatch(code, new RegExp(symbol),
      `${symbol} belongs to the removed bulk-import flow and must not return`);
  }
});

test("the Starred LinkedIn section still renders captured jobs", () => {
  // The DISPLAY is live and must survive the cleanup — it is fed by the single-job capture path
  // (/api/extension/save-job), which extension/linkedin-content.js still calls.
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  assert.ok(jobsPanel.indexOf("function StarredLinkedInSection") > 0,
    "the section component must still exist");
  assert.match(jobsPanel, /showImportedLinkedInSection=\{boardTab === "saved"\}/);
  assert.match(jobsPanel, /api\("\/api\/imported-jobs\/linkedin"\)/,
    "it must still read back captured LinkedIn jobs");
});

test("job profiles have a dedicated app section and menu entry", () => {
  const app = fs.readFileSync("client/src/App.jsx", "utf8");
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");
  const panel = fs.readFileSync("client/src/panels/JobProfilesPanel.jsx", "utf8");
  const profile = fs.readFileSync("client/src/panels/ProfilePanel.jsx", "utf8");

  assert.match(app, /JobProfilesPanel/);
  // Whitespace-tolerant: App.jsx formats this as `{ id: "job-profiles", label: "Job Profiles" }`.
  assert.match(app, /id:\s*"job-profiles",\s*label:\s*"Job Profiles"/);
  // `renderRoute` became `activeTab` when App.jsx moved to react-router — the panel is still
  // gated on the same key, only the variable was renamed.
  assert.match(app, /activeTab === "job-profiles"/);
  assert.match(topBar, /Manage Job Profiles/);
  assert.match(topBar, /onTabChange\?\.\("job-profiles"\)/);
  assert.match(panel, /export function JobProfilesPanel/);
  assert.match(profile, /Open Job Profiles/);
});

test("base resume management is profile-card scoped, not a global menu control", () => {
  const app = fs.readFileSync("client/src/App.jsx", "utf8");
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");
  const panel = fs.readFileSync("client/src/panels/JobProfilesPanel.jsx", "utf8");
  const database = fs.readFileSync("client/src/panels/DatabasePanel.jsx", "utf8");

  assert.doesNotMatch(app, /resumeWidget/);
  assert.doesNotMatch(topBar, /resumeWidget/);
  assert.doesNotMatch(topBar, /Upload Resume/);
  assert.match(panel, /Base Resume/);
  assert.match(panel, /\/api\/domain-profiles\/\$\{profile\.id\}\/base-resume/);
  assert.match(panel, /Required before search, ATS, and enhancement/);
  assert.match(database, /\/api\/domain-profiles\/\$\{profileId\}\/base-resume/);
  assert.doesNotMatch(database, /api\("\/api\/base-resume"\)/);
});

test("domain profile wizard supports shared create and edit modes", () => {
  const wizard = fs.readFileSync("client/src/components/DomainProfileWizard.jsx", "utf8");
  const panel = fs.readFileSync("client/src/panels/JobProfilesPanel.jsx", "utf8");

  assert.match(wizard, /mode = "create"/);
  assert.match(wizard, /initialProfile = null/);
  assert.match(wizard, /const isEditMode = mode === "edit"/);
  assert.match(wizard, /method: isEditMode \? "PUT" : "POST"/);
  assert.match(wizard, /Edit Job Search Profile/);
  assert.match(panel, /mode=\{wizardMode\}/);
  assert.match(panel, /initialProfile=\{editingProfile\}/);
});
