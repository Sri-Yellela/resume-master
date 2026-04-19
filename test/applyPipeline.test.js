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

test("auto apply gates ATS below 80 into review instead of submitting", () => {
  assert.match(applyRoute, /ATS_AUTO_APPLY_THRESHOLD = 80/);
  assert.match(applyRoute, /ats_below_threshold/);
  assert.match(applyRoute, /status='held_review'/);
  assert.match(applyRoute, /result\.status === "submitted"/);
});

test("manual apply uses semi automation and records review state", () => {
  assert.match(applyRoute, /run\.mode === "manual" \? "semi" : "full"/);
  assert.match(applyRoute, /reason_code='manual_review'/);
  assert.match(applyRoute, /Autofilled \$\{result\.fieldsFilled \?\? 0\} fields/);
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
