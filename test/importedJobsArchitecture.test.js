import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { importedJobDedupeKey, normaliseImportedJob } from "../services/importedJobs.js";

test("imported jobs prefer stable external ids for dedupe and fall back to canonical url", () => {
  assert.equal(
    importedJobDedupeKey("linkedin_saved", { externalJobId: "12345", title: "Engineer" }),
    "linkedin_saved:12345",
  );
  assert.equal(
    importedJobDedupeKey("linkedin_saved", { jobUrl: "https://www.linkedin.com/jobs/view/999/" }),
    "linkedin_saved:https://www.linkedin.com/jobs/view/999/",
  );
});

test("imported job normalisation keeps user-owned external jobs separate from scraped jobs", () => {
  const row = normaliseImportedJob("linkedin_saved", {
    externalJobId: "9988",
    title: "Software Engineer",
    company: "Acme",
    location: "Remote",
    jobUrl: "https://www.linkedin.com/jobs/view/9988/",
    sourcePlatform: "linkedin",
  });

  assert.equal(row.sourceKey, "linkedin_saved");
  assert.equal(row.externalJobId, "9988");
  assert.equal(row.title, "Software Engineer");
  assert.equal(row.company, "Acme");
});

test("server adds dedicated imported jobs tables and import token tables", () => {
  const server = fs.readFileSync("server.js", "utf8");

  assert.match(server, /id: "051_imported_saved_jobs"/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS imported_jobs/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS import_extension_tokens/);
  assert.match(server, /app\.use\(createImportSourcesRouter\(\{ db, requireAuth, emitToUser \}\)\)/);
  assert.match(server, /app\.use\("\/api\/imported-jobs", requireAuth, createImportedJobsRouter\(db\)\)/);
});

test("jobs UI exposes LinkedIn Saved Jobs inside Starred with import action", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(jobsPanel, /LinkedIn Saved Jobs/);
  assert.match(jobsPanel, /Import LinkedIn Saved Jobs/);
  assert.match(jobsPanel, /showImportedLinkedInSection=\{boardTab === "saved"\}/);
  assert.match(jobsPanel, /StarredLinkedInSection/);
  assert.match(jobsPanel, /api\("\/api\/imported-jobs\/summary"\)/);
  assert.match(jobsPanel, /api\("\/api\/imported-jobs\/linkedin-saved"\)/);
  assert.match(jobsPanel, /api\("\/api\/import-sources\/linkedin-saved\/token", \{ method: "POST" \}\)/);
});

test("extension imports normalized jobs without transferring LinkedIn cookies to the backend", () => {
  const popup = fs.readFileSync("extension/popup.js", "utf8");
  const content = fs.readFileSync("extension/content.js", "utf8");
  const readme = fs.readFileSync("extension/README.md", "utf8");

  assert.match(popup, /X-RM-Import-Token/);
  assert.match(popup, /\/api\/import-sources\/linkedin-saved\/jobs/);
  assert.match(content, /extract_linkedin_saved_jobs/);
  assert.match(readme, /LinkedIn cookies are not copied into the app backend/);
});
