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

test("filter panel uses an opaque modal surface", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(jobsPanel, /background:isDark \? "rgba\(0,0,0,0\.42\)" : "rgba\(15,23,42,0\.18\)"/);
  assert.match(jobsPanel, /background:theme\.modalSurface \|\| \(isDark \? "#111827" : "#ffffff"\)/);
  assert.match(jobsPanel, /boxShadow:theme\.shadowXl/);
});

test("LinkedIn import CTA is only rendered from the Starred LinkedIn section", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  const starredSectionStart = jobsPanel.indexOf("function StarredLinkedInSection");
  const mainToolbar = jobsPanel.slice(0, starredSectionStart);

  assert.ok(starredSectionStart > 0);
  assert.doesNotMatch(mainToolbar, /Import LinkedIn Saved Jobs/);
  assert.match(jobsPanel.slice(starredSectionStart), /Import LinkedIn Saved Jobs/);
  assert.match(jobsPanel, /showImportedLinkedInSection=\{boardTab === "saved"\}/);
});

test("job profiles have a dedicated app section and menu entry", () => {
  const app = fs.readFileSync("client/src/App.jsx", "utf8");
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");
  const panel = fs.readFileSync("client/src/panels/JobProfilesPanel.jsx", "utf8");
  const profile = fs.readFileSync("client/src/panels/ProfilePanel.jsx", "utf8");

  assert.match(app, /JobProfilesPanel/);
  assert.match(app, /id:"job-profiles", label:"Job Profiles"/);
  assert.match(app, /renderRoute === "job-profiles"/);
  assert.match(topBar, /Manage Job Profiles/);
  assert.match(topBar, /onTabChange\?\.\("job-profiles"\)/);
  assert.match(panel, /export function JobProfilesPanel/);
  assert.match(profile, /Open Job Profiles/);
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
