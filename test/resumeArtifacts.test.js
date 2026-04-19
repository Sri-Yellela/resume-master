import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Generate and A+ artifacts are tracked independently in the sandbox", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  const sandbox = fs.readFileSync("client/src/panels/SandboxPanel.jsx", "utf8");
  const jobCard = fs.readFileSync("client/src/components/JobCard.jsx", "utf8");
  const detail = fs.readFileSync("client/src/components/JobDetailPanel.jsx", "utf8");

  assert.match(jobsPanel, /const TOOL_LABELS = \{ \[GENERATE_TOOL\]: "Generate", \[A_PLUS_TOOL\]: "A\+ Resume" \}/);
  assert.match(jobsPanel, /function mergeArtifact/);
  assert.match(jobsPanel, /variants\[tool\]/);
  assert.match(sandbox, /variantKeys\.length > 1/);
  assert.match(sandbox, /setSelectedTool\(tool\)/);
  assert.match(jobCard, /const generateLoading = st === "generate"/);
  assert.match(jobCard, /const aPlusLoading = st === "a_plus_resume"/);
  assert.match(detail, /disabled=\{!!st\}/);
});

test("download/export marks the selected artifact as kept for downstream use", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(server, /039_resume_version_tool_artifacts/);
  assert.match(server, /tool_type TEXT NOT NULL DEFAULT 'generate'/);
  assert.match(server, /is_kept INTEGER NOT NULL DEFAULT 0/);
  assert.match(server, /app\.post\("\/api\/resumes\/:jobId\/keep"/);
  assert.match(server, /const keptExists = !!db\.prepare/);
  assert.match(server, /UPDATE resume_versions SET is_kept=1/);
  assert.match(jobsPanel, /\/api\/resumes\/\$\{current\.jobId\}\/keep/);
  assert.match(jobsPanel, /applyMode: current\?\.tool === A_PLUS_TOOL \? "CUSTOM_SAMPLER" : applyMode/);
});

test("A+ prompt overlay requires stronger honest ATS coverage", () => {
  const standalone = fs.readFileSync("custom_sampler_system_prompt.md", "utf8");
  const layered = fs.readFileSync("prompts/layer3_modes/custom_sampler.md", "utf8");

  assert.match(standalone, /A\+ coverage mandate/);
  assert.match(standalone, /missing-keyword ledger/);
  assert.match(standalone, /Semantic bridge/);
  assert.match(layered, /CUSTOM_SAMPLER is the A\+ Resume tool/);
  assert.match(layered, /more aggressive than TAILORED/);
  assert.match(layered, /Technical Skills placement/);
});

test("admin job review remains narrow to classification reassignment", () => {
  const adminDb = fs.readFileSync("routes/adminDb.js", "utf8");
  const dbInspector = fs.readFileSync("client/src/pages/admin/DBInspector.jsx", "utf8");

  assert.match(adminDb, /\/job-review\/reassign/);
  assert.match(dbInspector, /JobReviewTab/);
  assert.doesNotMatch(adminDb, /UPDATE scraped_jobs SET title|UPDATE scraped_jobs SET company|UPDATE scraped_jobs SET description/);
  assert.doesNotMatch(dbInspector, /textarea[^>]+description|name="title"|name="company"/);
});
