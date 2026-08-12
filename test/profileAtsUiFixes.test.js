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
  // The A+ action is no longer a JobCard button — only Generate is. `aPlusLoading` survives at
  // JobCard.jsx:328 as a computed-but-unused local (a small dead-code item, recorded in
  // docs/PIPELINE_DIAGNOSIS.md §5.14). Asserting the active-aware helper contract on the button
  // that exists rather than requiring one that does not.
  assert.match(jobCard, /const aPlusLoading = st === "a_plus_resume"/);
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

test("saved jobs section renders imported LinkedIn jobs inside Starred with instructions", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(jobsPanel, /function StarredLinkedInSection/);
  assert.match(jobsPanel, /showImportedLinkedInSection=\{boardTab === "saved"\}/);
  // The section's copy was rewritten in cleanup 5.3 (7a88522). It used to describe the LinkedIn
  // bulk saved-jobs import — a flow whose bridge functions had been stubs since BYO-2 and whose
  // extension-side script v1.2.0 deleted, so the instructions told users to do something that
  // could not work. It now describes the live single-job capture path.
  assert.match(jobsPanel, /Open a LinkedIn job and capture it with the Resume Master extension/);
  assert.match(jobsPanel, /No captured LinkedIn jobs yet/);
  // Comments stripped first: the removal's own explanatory note in JobsPanel quotes the old CTA.
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
