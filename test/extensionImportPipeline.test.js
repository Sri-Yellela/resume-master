// The extension's capture pipeline, after convergence (E2).
//
// This file used to test imported_jobs end to end: seeded rows read back through
// GET /api/imported-jobs/linkedin, dedupe by source_key, import_count bumping. All of that is gone,
// because the path it tested is gone.
//
// The extension had TWO capture paths wearing one promise. The popup's "Save job" wrote to
// imported_jobs keyed by dedupe_key; the Ctrl+Shift+K hotkey wrote to scraped_jobs keyed by req_uid.
// Same button-shaped intent, two destinations, two dedup identities — so a job captured both ways
// existed twice and neither copy knew about the other, and only one of them participated in the
// cross-source reconciler (direct ATS > provider > aggregator > import).
//
// They are now one path: /api/import/job into scraped_jobs. What remains to test is that the retired
// half STAYS retired, because every assertion below was once a live behaviour somebody could
// reasonably paste back.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

const serverSrc = fs.readFileSync("server.js", "utf8");
const contentSrc = fs.readFileSync("extension/linkedin-content.js", "utf8");
const popupSrc = fs.readFileSync("extension/popup.js", "utf8");
const bgSrc = fs.readFileSync("extension/background.js", "utf8");

// ── The retired endpoints stay retired ───────────────────────────────────────

test("the orphaned save-jobs-bulk endpoint stays removed", () => {
  // Its only client was saved-jobs-content.js, removed in v1.2.0 with the LinkedIn bulk-scraping
  // capability. The endpoint outlived its caller and still accepted bulk writes.
  assert.doesNotMatch(serverSrc, /app\.(post|options)\(\s*["']\/api\/extension\/save-jobs-bulk["']/,
    "save-jobs-bulk must not be re-registered — its client no longer exists");
});

test("SAVE-JOB IS A TOMBSTONE, NOT A DELETION", () => {
  // 410 rather than 404, following the /api/scrape precedent: a caller that still exists learns what
  // happened instead of getting an ambiguous not-found.
  const i = serverSrc.indexOf('app.all("/api/extension/save-job"');
  assert.ok(i > 0, "the route must still be registered, as a tombstone");
  const block = serverSrc.slice(i, i + 700);
  assert.match(block, /status\(410\)/);
  assert.match(block, /\/api\/import\/job/, "it must name the path that replaced it");
});

test("nothing writes to imported_jobs any more", () => {
  // The whole point of the convergence. One writer existed; it is gone.
  assert.doesNotMatch(serverSrc, /INSERT INTO imported_jobs/,
    "imported_jobs must have no writer — captures go to scraped_jobs via /api/import/job");
  assert.doesNotMatch(serverSrc, /UPDATE imported_jobs/);
});

test("the imported-jobs read surface is a tombstone too", () => {
  assert.doesNotMatch(serverSrc, /createImportedJobsRouter/,
    "the router was deleted along with the panel that consumed it");
  // Matched on the response, not the path: the route is registered with a RegExp literal, so the
  // path appears escaped in source and a plain-string search for it silently finds nothing.
  const i = serverSrc.indexOf("Imported jobs have been merged into the main board");
  assert.ok(i > 0, "a tombstone must remain so the retirement is visible");
  assert.match(serverSrc.slice(i - 300, i + 200), /status\(410\)/);
  assert.ok(serverSrc.includes("app.all(/^\\/api\\/imported-jobs"),
    "and it must cover the sub-paths the panel used to call, not just the bare mount");
});

test("the table itself is NOT dropped", () => {
  // Migrations here are additive-only. Retiring a path does not license destroying its data, even
  // when there is none — a dropped table cannot be inspected later to confirm that.
  const migrations = fs.readFileSync("scripts/migrations.js", "utf8");
  assert.doesNotMatch(migrations, /DROP TABLE[^\n]*imported_jobs/i);
  assert.doesNotMatch(serverSrc, /DROP TABLE[^\n]*imported_jobs/i);
});

// ── One capture path, two triggers ───────────────────────────────────────────

test("THE EXTENSION HAS EXACTLY ONE CAPTURE IMPLEMENTATION", () => {
  assert.doesNotMatch(contentSrc, /function saveJob/,
    "saveJob() was deleted, not left unreferenced — an orphaned second path is how this diverged");
  assert.doesNotMatch(contentSrc, /api\/extension\/save-job/,
    "the content script must not call the retired endpoint");
  assert.equal((contentSrc.match(/async function captureAndImport/g) || []).length, 1,
    "exactly one capture function");
});

test("both triggers send the SAME message", () => {
  assert.doesNotMatch(contentSrc, /'SAVE_JOB'/,
    "SAVE_JOB is gone rather than aliased — zero users means no compatibility is owed");
  assert.doesNotMatch(popupSrc, /SAVE_JOB/);
  assert.match(popupSrc, /type: 'CAPTURE_AND_IMPORT'/,
    "the popup button routes to the same message the hotkey does");
  assert.match(bgSrc, /command !== 'capture-job'\) return/,
    "the hotkey command still routes to the content script's capture message");
  assert.match(bgSrc, /type: 'CAPTURE_AND_IMPORT'/);
});

test("the outcome is worded in ONE place, so the triggers cannot disagree", () => {
  // If the popup and the toast phrased results separately, users would still perceive two features.
  assert.match(bgSrc, /async function importCapturedJob/,
    "the request and its message live in the service worker");
  assert.match(popupSrc, /result\?\.message/,
    "the popup displays the message it was given rather than composing its own");
  assert.match(contentSrc, /showCaptureToast\(result\.message, result\.success\)/,
    "the toast displays the same message");
});

// ── The production CORS trap this convergence had to clear ───────────────────

test("THE CAPTURE REQUEST IS MADE FROM THE SERVICE WORKER, NOT THE CONTENT SCRIPT", () => {
  // A content script's fetch carries the PAGE's origin — https://www.linkedin.com — not the
  // extension's. server.js's corsOrigin admits only APP_BASE_ORIGIN/FRONTEND_ORIGIN in production,
  // and corsOriginExtension additionally admits chrome-extension:// but not a job board. So a
  // capture posted from the content script is refused the moment NODE_ENV=production — and passes in
  // development, where corsOrigin returns true for everything, which is why it was never noticed.
  //
  // A service-worker fetch is not subject to CORS for a host in host_permissions, and
  // https://resumemaster.one/* is declared.
  assert.doesNotMatch(contentSrc, /fetch\(/,
    "the content script must not make network requests — it extracts and hands off");
  assert.match(bgSrc, /fetch\(`\$\{RESUME_MASTER_URL\}\/api\/import\/job`/);
  assert.match(bgSrc, /credentials: 'include'/);
});

test("the popup's auth probe goes through the service worker for the same reason", () => {
  assert.doesNotMatch(popupSrc, /fetch\(/,
    "a popup fetch carries chrome-extension://, which corsOrigin refuses in production");
  assert.match(popupSrc, /type: 'PROBE_AUTH'/);
  assert.match(bgSrc, /\/api\/auth\/me/);
});

test("the extracted text travels with the capture", () => {
  // importJob() returns needsClientCapture for login-walled hosts when it has to fetch the page
  // itself. Sending the text we already hold means that round-trip cannot come back to the client
  // that has the content.
  assert.match(contentSrc, /const payload = \{ url: [^\n]*text: buildCaptureText\(data\) \}/);
  assert.match(bgSrc, /needsClientCapture/,
    "and it is still handled if it somehow arrives, rather than silently succeeding");
});
