import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const launcher   = fs.readFileSync("services/browserLauncher.js",   "utf8");
const automation = fs.readFileSync("services/applyAutomation.js",   "utf8");
const server     = fs.readFileSync("server.js",                      "utf8");
const account    = fs.readFileSync("routes/account.js",              "utf8");
const applyRoute = fs.readFileSync("routes/apply.js",                "utf8");
const nixpacks   = fs.readFileSync("nixpacks.toml",                  "utf8");

// ── Resolution strategy ───────────────────────────────────────────────────────

test("browserLauncher exports all required functions", () => {
  assert.match(launcher, /export async function launchBrowser/);
  assert.match(launcher, /export async function probeBrowserAvailability/);
  assert.match(launcher, /export function classifyLaunchError/);
  assert.match(launcher, /export async function resolveBrowserExecutable/);
  assert.match(launcher, /export function buildLaunchArgs/);
});

test("browserLauncher checks BROWSER_EXECUTABLE_PATH env var first", () => {
  assert.match(launcher, /BROWSER_EXECUTABLE_PATH/);
  // env var check must precede system and bundled path checks
  const envPos    = launcher.indexOf("BROWSER_EXECUTABLE_PATH");
  const sysPos    = launcher.indexOf("LINUX_SYSTEM_PATHS");
  const spartiPos = launcher.indexOf("sparticuz");
  assert.ok(envPos < sysPos,    "env var check must precede Linux system paths");
  assert.ok(envPos < spartiPos, "env var check must precede @sparticuz bundled path");
});

test("browserLauncher tries system paths before @sparticuz bundled path on Linux", () => {
  const linuxSysPos = launcher.indexOf("LINUX_SYSTEM_PATHS");
  const spartiPos   = launcher.indexOf("sparticuz:bundled");
  assert.ok(linuxSysPos < spartiPos, "system paths must be checked before sparticuz bundled");
});

test("browserLauncher lists known Linux system Chromium paths", () => {
  assert.match(launcher, /\/usr\/bin\/chromium-browser/);
  assert.match(launcher, /\/usr\/bin\/chromium/);
  assert.match(launcher, /\/usr\/bin\/google-chrome/);
});

// ── Error classification ──────────────────────────────────────────────────────

test("classifyLaunchError maps shared-library failure to browser_runtime_missing_dependency", () => {
  // The crash that prompted this module: libnspr4.so missing
  assert.match(launcher, /browser_runtime_missing_dependency/);
  assert.match(launcher, /cannot open shared object file|error while loading shared lib/i);
});

test("classifyLaunchError maps missing binary to browser_binary_not_found", () => {
  assert.match(launcher, /browser_binary_not_found/);
  assert.match(launcher, /No browser binary|binary not found/i);
});

test("classifyLaunchError emits browser_launch_failed as catch-all", () => {
  assert.match(launcher, /browser_launch_failed/);
});

test("launchBrowser emits structured error message for each failure type", () => {
  assert.match(launcher, /missing required system libraries.*libnspr4|libnspr4.*missing required system libraries/i);
  assert.match(launcher, /Install Chrome.*BROWSER_EXECUTABLE_PATH|BROWSER_EXECUTABLE_PATH.*Install Chrome/);
});

// ── Launch args ───────────────────────────────────────────────────────────────

test("buildLaunchArgs always includes container-safe no-sandbox flags", () => {
  assert.match(launcher, /--no-sandbox/);
  assert.match(launcher, /--disable-setuid-sandbox/);
  assert.match(launcher, /--disable-dev-shm-usage/);
  assert.match(launcher, /--disable-gpu/);
});

// ── Readiness probe ───────────────────────────────────────────────────────────

test("probeBrowserAvailability caches result to avoid repeated launches", () => {
  assert.match(launcher, /_readinessCache/);
  assert.match(launcher, /if \(_readinessCache\)/);
});

test("probeBrowserAvailability distinguishes all failure modes", () => {
  // Result object must carry reasonCode covering all documented failure types
  assert.match(launcher, /browser_binary_not_found/);
  assert.match(launcher, /browser_runtime_missing_dependency/);
  assert.match(launcher, /browser_launch_failed/);
});

// ── Integration with apply automation ────────────────────────────────────────

test("applyAutomation uses launchBrowser — no direct puppeteer.launch call", () => {
  assert.match(automation, /launchBrowser/);
  assert.match(automation, /browserLauncher/);
  assert.doesNotMatch(automation, /puppeteer\.launch/);
  assert.doesNotMatch(automation, /chromium\.executablePath/);
});

test("server htmlToPdf uses launchBrowser — no direct puppeteer.launch call", () => {
  // Find the real (unindented) function declaration, not the commented-out Gotenberg block
  const fnStart = server.indexOf("\nasync function htmlToPdf");
  assert.ok(fnStart > 0, "htmlToPdf function must exist in server.js");
  const fnEnd = server.indexOf("\nasync function ", fnStart + 10);
  const fn    = server.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 2000);
  assert.match(fn, /launchBrowser/, "htmlToPdf must use launchBrowser");
  assert.doesNotMatch(fn, /puppeteer\.launch/, "htmlToPdf must not call puppeteer.launch directly");
  assert.doesNotMatch(fn, /chromium\.executablePath/, "htmlToPdf must not call chromium.executablePath directly");
});

test("server imports launchBrowser and probeBrowserAvailability from browserLauncher", () => {
  assert.match(server, /launchBrowser.*browserLauncher|browserLauncher.*launchBrowser/);
  assert.match(server, /probeBrowserAvailability/);
});

// ── Integrations status endpoint ─────────────────────────────────────────────

test("integrations status endpoint includes browser availability in response", () => {
  assert.match(server, /probeBrowserAvailability/);
  assert.match(server, /createAccountRouter/);
  const statusRoute = account.slice(account.indexOf('"/api/integrations/status"'), account.indexOf('"/api/integrations/apify-token"'));
  assert.match(statusRoute, /browser:/);
  assert.match(statusRoute, /available/);
  assert.match(statusRoute, /reasonCode/);
});

test("server probes browser availability on startup", () => {
  // Startup probe warms the cache so /api/integrations/status is fast on first request
  const listenBlock = server.slice(server.indexOf("app.listen(PORT"));
  assert.match(listenBlock, /probeBrowserAvailability/);
});

// ── Manual apply fallback ────────────────────────────────────────────────────

test("manual apply route returns fallbackUrl on browser launch failure", () => {
  assert.match(applyRoute, /fallbackUrl/);
  assert.match(applyRoute, /browser_runtime_missing_dependency/);
  assert.match(applyRoute, /browser_binary_not_found/);
  assert.match(applyRoute, /BROWSER_FAILURE_CODES/);
});

test("manual apply route returns HTTP 503 for browser failures instead of 500", () => {
  assert.match(applyRoute, /503/);
  assert.match(applyRoute, /isBrowserFailure/);
});

// ── Deployment config ─────────────────────────────────────────────────────────

test("nixpacks.toml includes libnspr4 — the library that caused the crash", () => {
  assert.match(nixpacks, /libnspr4/, "libnspr4 must be present — caused 'cannot open shared object file'");
});

test("nixpacks.toml includes other commonly missing Chromium dependencies", () => {
  assert.match(nixpacks, /libdbus-1-3/);
  assert.match(nixpacks, /libexpat1/);
  assert.match(nixpacks, /libfontconfig1/);
  assert.match(nixpacks, /libxi6/);
  assert.match(nixpacks, /libxcursor1/);
  assert.match(nixpacks, /libxtst6/);
  assert.match(nixpacks, /libx11-xcb1/);
});
