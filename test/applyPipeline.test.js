import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync("server.js", "utf8");
const applyRoute = fs.readFileSync("routes/apply.js", "utf8");
const automation = fs.readFileSync("services/applyAutomation.js", "utf8");
const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
const detailPanel = fs.readFileSync("client/src/components/JobDetailPanel.jsx", "utf8");
const adminDb = fs.readFileSync("routes/adminDb.js", "utf8");

test("apply pipeline has DB-backed runs, jobs, and structured logs", () => {
  assert.match(server, /CREATE TABLE IF NOT EXISTS apply_runs/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS apply_run_jobs/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS apply_job_logs/);
  assert.match(server, /idx_apply_runs_user_status/);
  assert.match(adminDb, /apply_runs/);
  assert.match(adminDb, /apply_run_jobs/);
  assert.match(adminDb, /apply_job_logs/);
});

test("apply queue routes expose async run, detail, and review endpoints", () => {
  assert.match(applyRoute, /app\.post\("\/api\/apply\/runs"/);
  assert.match(applyRoute, /res\.status\(202\)\.json/);
  assert.match(applyRoute, /app\.get\("\/api\/apply\/runs"/);
  assert.match(applyRoute, /app\.get\("\/api\/apply\/runs\/:runId"/);
  assert.match(applyRoute, /app\.get\("\/api\/apply\/review"/);
  assert.match(applyRoute, /const APPLY_WORKER_LIMIT = 2/);
});

test("apply queue duplicate list uses the defined variable consistently", () => {
  assert.match(applyRoute, /const duplicates = db\.prepare/);
  assert.match(applyRoute, /const duplicateSet = new Set\(duplicates\)/);
  assert.doesNotMatch(applyRoute, /const duplicate = db\.prepare/);
});

test("auto apply gates ATS below threshold into review instead of submitting", () => {
  // Threshold was lowered to 65 (was 80) — null ATS no longer blocks runs
  assert.match(applyRoute, /ATS_AUTO_APPLY_THRESHOLD = 65/);
  assert.match(applyRoute, /ats_below_threshold/);
  assert.match(applyRoute, /status='held_review'/);
  assert.match(applyRoute, /result\.status === "submitted"/);
});

test("manual apply uses semi automation and records review state", () => {
  // manual mode always uses "semi" browser mode; result handler uses 'manual_review' reason
  assert.match(applyRoute, /mode: "semi"/);
  assert.match(applyRoute, /reason_code='manual_review'/);
  assert.match(applyRoute, /Autofilled \$\{result\.fieldsFilled \?\? 0\} fields/);
});

test("manual apply does not fail early when no resume artifact exists", () => {
  // CASE B: no artifact + manual mode — generation and browser run in parallel.
  // The browser must start even when generateResumeForApply is still pending.
  // The pipeline must NOT hold/fail with resume_required before the browser opens.
  const caseB = applyRoute.slice(applyRoute.indexOf("CASE B:"), applyRoute.indexOf("CASE C:"));
  assert.match(caseB, /generation_started/, "must log generation_started status");
  assert.match(caseB, /site_visit_started/, "must log site_visit_started before browser");
  assert.match(caseB, /Promise\.allSettled/, "must run generation and browser in parallel");
  assert.match(caseB, /mode: "semi"/, "browser must start in semi mode");
  // Must NOT contain the old resume_required hold — that was the early-fail bug
  assert.doesNotMatch(caseB, /resume_required/, "must not hold with resume_required before browser opens");
});

test("auto apply triggers generation instead of failing when no resume artifact exists", () => {
  // CASE C: no artifact + auto mode — generation runs first (sequential) to get ATS score.
  // The pipeline must NOT fail immediately — it must attempt generation.
  const caseC = applyRoute.slice(applyRoute.indexOf("CASE C:"), applyRoute.indexOf("const processRun ="));
  assert.match(caseC, /generation_started/, "must log generation_started status");
  assert.match(caseC, /generateResumeForApply/, "must call generateResumeForApply");
  assert.match(caseC, /generation_failed/, "must handle generation failure gracefully");
  assert.match(caseC, /generation_timed_out/, "must handle generation timeout");
  assert.match(caseC, /ats_review/, "must still do ATS check after generation");
  assert.match(caseC, /ats_below_threshold/, "must still gate on ATS score");
  // Must NOT fail with 'resume_required' before attempting generation
  assert.doesNotMatch(caseC, /resume_required/, "must not use the old resume_required early-fail");
});

test("parallel apply pipeline: generation_ready event is logged when artifact completes", () => {
  // After generateResumeForApply resolves (both Case B and C), the pipeline logs generation_ready
  assert.match(applyRoute, /generation_ready/);
  assert.match(applyRoute, /Resume generation completed/);
  assert.match(applyRoute, /Resume generated/);
});

test("coreGenerateResume is extracted and callable from generateResumeForApply", () => {
  // The extraction from the HTTP handler into a standalone function must exist
  assert.match(server, /async function coreGenerateResume/);
  assert.match(server, /function generateResumeForApply/);
  assert.match(server, /const pendingGenerationPromises = new Map/);
  // generateResumeForApply must be passed to applyRoutes so the worker can call it
  assert.match(server, /applyRoutes\(app, db, requireAuth, buildAutofillPayload, generateResumeForApply\)/);
  // The apply routes must accept it as a parameter
  assert.match(applyRoute, /function applyRoutes\(app, db, requireAuth, buildAutofillPayload, generateResumeForApply\)/);
});

test("generateResumeForApply reuses existing artifact without triggering a new generation", () => {
  // If artifact already in DB → return immediately without a new API call
  const fn = server.slice(server.indexOf("function generateResumeForApply"), server.indexOf("\napp.post(\"/api/generate\""));
  assert.match(fn, /existing\.html/, "must check for existing artifact");
  assert.match(fn, /Promise\.resolve\(/, "must return resolved promise for cache hit");
  assert.match(fn, /fromCache: true/, "cache hit must be flagged");
});

test("generateResumeForApply attaches to in-flight HTTP generation instead of duplicating", () => {
  const fn = server.slice(server.indexOf("function generateResumeForApply"), server.indexOf("\napp.post(\"/api/generate\""));
  assert.match(fn, /generationInFlight\.has\(key\)/, "must check HTTP in-flight set");
  assert.match(fn, /pendingGenerationPromises\.has\(key\)/, "must check worker in-flight map");
  assert.match(fn, /generation_timed_out/, "must handle timeout for HTTP-triggered in-flight");
});

test("browser unavailable error is classified for graceful fallback", () => {
  assert.match(automation, /reasonCode = "browser_unavailable"/);
  assert.match(automation, /Chrome not found on Windows/);
  assert.match(automation, /reasonCode: e\.reasonCode/);
});

test("jobs UI can queue multiple jobs and start auto or manual apply runs", () => {
  assert.match(detailPanel, /onQueueApply/);
  assert.match(detailPanel, /Queue Auto/);
  assert.match(jobsPanel, /const \[applyQueue, setApplyQueue\]/);
  assert.match(jobsPanel, /Run Auto Apply/);
  assert.match(jobsPanel, /Autofill for Review/);
  assert.match(jobsPanel, /api\("\/api\/apply\/runs"/);
});
