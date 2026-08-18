// SCRAPING � SCHEDULED FOR REMOVAL AFTER MIGRATION
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("job card hover preview uses shared active-aware icon helpers for save and pass actions", () => {
  const jobCard = fs.readFileSync("client/src/components/JobCard.jsx", "utf8");

  assert.match(jobCard, /function IconBtn\(\{/);
  assert.match(jobCard, /active = false/);
  assert.match(jobCard, /preview = hov && !disabled/);
  assert.match(jobCard, /function ToggleIconBtn/);
  assert.match(jobCard, /activeLabel="Remove from saved"/);
  assert.match(jobCard, /activeLabel="Undo pass"/);
  assert.match(jobCard, /active=\{done && !generateLoading\}/);
  // The A+ action is no longer a JobCard button — only Generate is — and the dead `aPlusLoading`
  // local that lingered alongside it has now been removed too (§5.14). The card must not grow a
  // second loading flag back without a button to use it; while a job is in the a_plus_resume
  // state the generic `disabled={!!st}` guard still covers it.
  // Comments stripped first — the removal's own explanatory note names the deleted identifier.
  const jobCardCode = jobCard
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(jobCardCode, /aPlusLoading/,
    "an unused second loading flag must not return — !!st already covers that state");
  assert.match(jobCardCode, /disabled=\{!!st\}/, "the generic in-flight guard must stay");

  // JobDetailPanel's action bar carried an IDENTICAL orphan, removed in the same change. It was
  // found only because an unrelated test happened to pin the JobCard line — nothing guarded this
  // surface, so guard it here rather than leave the pair half-covered. Neither surface has a
  // dedicated A+ button; both rely on the same generic in-flight guard.
  const detailPanelCode = fs.readFileSync("client/src/components/JobDetailPanel.jsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(detailPanelCode, /aPlusLoading/,
    "the detail panel's action bar must not regrow the unused flag either");
  assert.match(detailPanelCode, /disabled=\{!!st\}/,
    "the detail panel's generic in-flight guard must stay");
});

test("jobs UI opens ATS panel from stored base ATS reports without requiring regeneration", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  const detailPanel = fs.readFileSync("client/src/components/JobDetailPanel.jsx", "utf8");
  const server = fs.readFileSync("server.js", "utf8");

  assert.match(jobsPanel, /function buildAtsPayload\(job, artifact = null\)/);
  assert.match(jobsPanel, /job\?\.baseAtsScore/);
  assert.match(jobsPanel, /job\?\.baseAtsReport/);
  assert.match(jobsPanel, /openAtsPanel\(buildAtsPayload\(job, g\)\)/);
  assert.match(detailPanel, /const atsScore = g\?\.atsScore \?\? job\?\.baseAtsScore \?\? null/);
  // The SQL alias was dropped — the row mapper now reads sj.ats_report directly rather than
  // renaming it to base_ats_report in the SELECT. Same data reaching the client under the same
  // baseAtsReport key, one fewer indirection.
  assert.match(server, /baseAtsReport:\s*parseJsonMaybe\(j\.ats_report, null\)/);
  assert.match(server, /SELECT ats_report FROM scraped_jobs WHERE job_id=\?/);
});

test("profile selector exposes direct manage-profiles access from the jobs flow", () => {
  const selector = fs.readFileSync("client/src/components/ProfileSelectorDropdown.jsx", "utf8");
  assert.match(selector, /Manage Profiles/);
  assert.match(selector, /href="\/app\/profile"/);
});

test("the imported-LinkedIn section is gone, and the bulk-import CTA stays gone (E2)", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  // The section is removed — see jobsUiProfileFilters for the full symbol sweep and the reason.
  assert.doesNotMatch(jobsPanel, /function StarredLinkedInSection/);
  // The original point of this test survives the removal: the retired bulk-import CTA must not
  // reappear under any surface. Comments stripped, since the removal notes quote the old copy.
  const jobsPanelCode = jobsPanel
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(jobsPanelCode, /Import from LinkedIn/,
    "the removed bulk-import CTA must not come back");
});

test("scrape and poll enforce stored profile experience constraints before surfacing new jobs", () => {
  const server = fs.readFileSync("server.js", "utf8");

  assert.match(server, /const maxAllowedYoe = signalProfile\?\.yearsExperience != null/);
  assert.match(server, /const eligible = filtered\.filter/);
  assert.match(server, /yoeMismatch: cntYoeMismatch/);
  assert.match(server, /const pollSignals = loadSimpleApplyProfile/);
  assert.match(server, /const pollMaxYoe = pollSignals\?\.yearsExperience != null \? pollSignals\.yearsExperience \+ 2 : null/);
  assert.match(server, /\(\? IS NULL OR sj\.min_years_exp IS NULL OR sj\.min_years_exp <= \?\)/);
});
