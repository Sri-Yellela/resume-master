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
  assert.match(jobCard, /active=\{done && !aPlusLoading\}/);
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
  assert.match(server, /sj\.ats_report as base_ats_report/);
  assert.match(server, /baseAtsReport:\s*parseJsonMaybe\(j\.base_ats_report, null\)/);
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
  assert.match(jobsPanel, /They stay separate from local starred jobs/);
  assert.match(jobsPanel, /No imported LinkedIn saved jobs yet/);
  assert.match(jobsPanel, /short-lived token/);
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
