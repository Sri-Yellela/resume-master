// SCRAPING � SCHEDULED FOR REMOVAL AFTER MIGRATION
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
  // generateResumeForApply, htmlToPdf, AND generateCoverLetterForApply must be passed to applyRoutes
  assert.match(server, /applyRoutes\(app, db, requireAuth, buildAutofillPayload, generateResumeForApply, htmlToPdf, generateCoverLetterForApply\)/);
  // The apply routes must accept all as parameters
  assert.match(applyRoute, /function applyRoutes\(app, db, requireAuth, buildAutofillPayload, generateResumeForApply, htmlToPdf, generateCoverLetterForApply\)/);
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
  // Classification now lives in browserLauncher; applyAutomation delegates to it.
  const launcher = fs.readFileSync("services/browserLauncher.js", "utf8");
  // Structured reason codes emitted by classifyLaunchError
  assert.match(launcher, /browser_runtime_missing_dependency/);
  assert.match(launcher, /browser_binary_not_found/);
  assert.match(launcher, /browser_launch_failed/);
  // autoApply error handler still propagates the structured reasonCode
  assert.match(automation, /reasonCode: e\.reasonCode/);
  // autoApply uses launchBrowser (no direct puppeteer.launch)
  assert.match(automation, /launchBrowser/);
  assert.doesNotMatch(automation, /puppeteer\.launch/);
});

test("jobs UI can queue multiple jobs and start auto or manual apply runs", () => {
  assert.match(detailPanel, /onQueueApply/);
  assert.match(detailPanel, /Queue Auto/);
  assert.match(jobsPanel, /const \[applyQueue, setApplyQueue\]/);
  assert.match(jobsPanel, /Run Auto Apply/);
  assert.match(jobsPanel, /Autofill for Review/);
  assert.match(jobsPanel, /api\("\/api\/apply\/runs"/);
});

test("autoApply accepts resumePathPromise and awaits it before first upload", () => {
  // New option enables true parallel: browser navigates while generation runs,
  // then waits at the upload step for the PDF path.
  assert.match(automation, /resumePathPromise/);
  assert.match(automation, /effectiveResumePath/);
  // Must set waiting_for_resume status while awaiting the promise
  assert.match(automation, /waiting_for_resume/);
  // Must return ats_held (not submit) when resumePathPromise resolves to null in full-auto mode
  assert.match(automation, /status:\s*"ats_held"/);
  assert.match(automation, /isFullAuto && resumePathPromise && !effectiveResumePath/);
});

test("auto apply Case C launches browser in parallel with generation via resumePathPromise", () => {
  // Case C must no longer be sequential: browser launches before generation completes.
  const caseC = applyRoute.slice(applyRoute.indexOf("CASE C:"), applyRoute.indexOf("const processRun ="));
  assert.match(caseC, /resumePathPromise/, "must pass resumePathPromise to autoApply for parallel gating");
  assert.match(caseC, /site_visit_started/, "must log site_visit_started before browser launch");
  assert.match(caseC, /Promise\.allSettled/, "must await both tracks together via Promise.allSettled");
  // The ATS gate must be embedded in resumePathPromise (not a top-level await before browser launch)
  assert.match(caseC, /ATS_AUTO_APPLY_THRESHOLD/, "ATS gate must be inside resumePathPromise chain");
});

test("apply routes convert generated HTML to PDF via htmlToPdf for actual file upload", () => {
  // htmlToPdf must be wired through: server → applyRoutes → used in processRunJob
  assert.match(applyRoute, /htmlToPdf/, "apply routes must use htmlToPdf");
  assert.match(applyRoute, /os\.tmpdir\(\)/, "must write PDF to a temp file via os.tmpdir()");
  assert.match(applyRoute, /unlinkSync/, "must clean up temp PDF after apply completes");
  // resumePathPromise must be passed to autoApply in all cases that generate a resume
  assert.match(applyRoute, /resumePathPromise/, "must pass resumePathPromise to autoApply");
});

test("job detail panel has single Apply action and no redundant Manual button", () => {
  // Single "Apply" action — no ↗ icon prefix, no separate ✎ Manual button
  assert.match(detailPanel, /: "Apply"/, "Apply button label must be exactly 'Apply'");
  assert.doesNotMatch(detailPanel, /✎ Manual/, "redundant Manual button must be removed");
  // Semi-auto apply mechanism must remain intact
  assert.match(detailPanel, /handleAutoApply/, "semi-auto apply handler must still be present");
  assert.match(detailPanel, /mode.*semi|semi.*mode/, "Apply action must use semi mode");
});

test("worker generates cover letter in parallel and passes coverLetterPath to autoApply", () => {
  // generateCoverLetterForApply must exist in server.js and be wired into applyRoutes
  assert.match(server, /async function generateCoverLetterForApply/);
  assert.match(server, /generateCoverLetterForApply\(userId, jobId\)/);
  // Routes must pass coverLetterPath (CASE A) and coverLetterPathPromise (CASE B/C) to autoApply
  assert.match(applyRoute, /coverLetterPath/);
  assert.match(applyRoute, /coverLetterPathPromise/);
  assert.match(applyRoute, /cover_letter_unavailable/);
  // Cover letter temp file must be cleaned up alongside resume temp file
  assert.match(applyRoute, /coverLetterTmpPath/);
  assert.match(applyRoute, /unlinkSync\(coverLetterTmpPath\)/);
});

test("autoApply accepts coverLetterPath and coverLetterPathPromise options", () => {
  // The engine must destructure both new options from the options object
  assert.match(automation, /coverLetterPath\s*=/);
  assert.match(automation, /coverLetterPathPromise\s*=/);
  assert.match(automation, /effectiveCoverLetterPath/);
});

test("handler-typed file upload routes resume and cover-letter inputs by handler_type", () => {
  // handleTypedFileUploads must classify file inputs via label/name/id keywords
  assert.match(automation, /handleTypedFileUploads/);
  assert.match(automation, /isCover.*cover|cover.*isCover/);
  assert.match(automation, /isResume.*resume|resume.*isResume/);
  // uploadToFileInput must keep the DataTransfer dispatch intact
  assert.match(automation, /uploadToFileInput/);
  assert.match(automation, /DataTransfer/);
  // Fallback: resume goes to first file input when no typed slot is found
  assert.match(automation, /slots\[0\]/);
});

test("completeness gate holds full-auto submit when required fields are still empty", () => {
  // DISCOVER_FN_SRC must capture current_value so the gate can read page state
  assert.match(automation, /current_value/, "DISCOVER_FN_SRC must record current_value");
  // Gate must re-discover fields after fill using discoverFields across all frames
  assert.match(automation, /postFillFields/, "must re-discover fields post-fill");
  assert.match(automation, /missingRequired/, "must collect unfilled required fields");
  // Gate must fire only in full-auto mode and only for non-file required fields
  assert.match(automation, /f\.is_required.*f\.type !== 'file'|is_required.*type !== 'file'/, "must skip file fields in completeness check");
  // Gate must return held_review / incomplete_form when required fields are unfilled
  assert.match(automation, /reasonCode:\s*'incomplete_form'/, "must return incomplete_form reason code");
  assert.match(automation, /status:\s*'held_review'/, "must return held_review status on incompleteness");
  // Gate must not submit (must return early) before submit button loop
  const gateIdx = automation.indexOf("missingRequired.length > 0");
  const submitLoopIdx = automation.indexOf("SUBMIT_RE = /^(submit|apply");
  assert.ok(gateIdx < submitLoopIdx, "completeness gate must appear before submit button loop");
});

test("filled_not_submitted is explicitly mapped to no_submit_button reason code", () => {
  // Worker must record 'no_submit_button' when autoApply finds no submit button (not generic null)
  assert.match(applyRoute, /filled_not_submitted.*no_submit_button|no_submit_button.*filled_not_submitted/,
    "apply worker must map filled_not_submitted to no_submit_button reason code");
});
