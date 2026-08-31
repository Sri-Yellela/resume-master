// SCRAPING — SCHEDULED FOR REMOVAL AFTER MIGRATION
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { at } from "../test-support/sourceAnchors.js";

const launcher   = fs.readFileSync("services/browserLauncher.js",   "utf8");
const automation = fs.readFileSync("services/applyAutomation.js",   "utf8");
const server     = fs.readFileSync("server.js",                      "utf8");
const account    = fs.readFileSync("routes/account.js",              "utf8");
const applyRoute = fs.readFileSync("routes/apply.js",                "utf8");

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

test("launchBrowser uses resolveBrowserExecutable's validated path, not a raw env re-read", () => {
  // Regression guard: launchBrowser previously did
  //   executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || resolution.path
  // which discards resolveBrowserExecutable's existsSync-validated fallback whenever the env
  // var is SET but points at a path that doesn't exist — probeBrowserAvailability (which
  // correctly uses resolution.path only) would report healthy via the fallback while real
  // launches kept failing on the stale env path.
  const fnStart = launcher.indexOf("export async function launchBrowser");
  assert.ok(fnStart > 0, "launchBrowser function must exist");
  const fnEnd = launcher.indexOf("\nexport async function launchBrowserPage");
  const fn    = launcher.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 3000);
  assert.match(fn, /executablePath:\s*resolution\.path/, "launchBrowser must pass resolution.path to puppeteer.launch");
  assert.doesNotMatch(fn, /executablePath:\s*process\.env\.PUPPETEER_EXECUTABLE_PATH/,
    "launchBrowser must not re-read the raw env var, bypassing resolution's existsSync check");
});

test("the readiness probe resolves the same way launchBrowser does — they cannot diverge", () => {
  // A4 restates the bug as "readiness reports healthy via fallback while real launches fail". That
  // signature requires the probe and the launch to resolve DIFFERENTLY. The guard above covers
  // launchBrowser only, so this covers the other half: the probe must also take resolution.path,
  // and both must derive it from the one resolver. Verified behaviourally, with a stale env var, by
  // scripts/a4BrowserResolution.mjs.
  const probeStart = launcher.indexOf("export async function probeBrowserAvailability");
  assert.ok(probeStart > 0, "probeBrowserAvailability must exist");
  const probeEnd = launcher.indexOf("\n// ── Main launch API", probeStart);
  const probeFn  = launcher.slice(probeStart, probeEnd > probeStart ? probeEnd : probeStart + 3000);

  assert.match(probeFn, /await resolveBrowserExecutable\(\)/,
    "the probe must resolve through resolveBrowserExecutable, not its own logic");
  assert.match(probeFn, /executablePath:\s*resolution\.path/,
    "the probe must launch the resolved path");
  assert.doesNotMatch(probeFn, /executablePath:\s*process\.env\./,
    "the probe must not re-read a raw env var either");

  const launchStart = launcher.indexOf("export async function launchBrowser");
  const launchFn = launcher.slice(launchStart, at(launcher, "\nexport async function launchBrowserPage"));
  assert.match(launchFn, /await resolveBrowserExecutable\(\)/,
    "launchBrowser must resolve through the same function as the probe");
});

test("a set-but-nonexistent executable path falls back instead of being trusted", () => {
  // This existsSync guard inside the resolver is what makes the fallback possible at all: without
  // it, a stale env var (a container package renaming chromium-browser -> chromium, which is the
  // actual history here) would be returned as-is and every launch would fail with no recovery.
  const resStart = launcher.indexOf("export async function resolveBrowserExecutable");
  const resEnd   = launcher.indexOf("\n// ── Launch args", resStart);
  const resFn    = launcher.slice(resStart, resEnd > resStart ? resEnd : resStart + 3000);

  assert.match(resFn, /const envPath = process\.env\.PUPPETEER_EXECUTABLE_PATH \|\| process\.env\.BROWSER_EXECUTABLE_PATH/);
  assert.match(resFn, /if \(fs\.existsSync\(envPath\)\) return/,
    "the env path must be existence-checked before it is returned");
  assert.match(resFn, /falling back to system paths/,
    "and the fallback must be logged, so a stale override is diagnosable");
  // The env branch must not be a bare early return that skips the rest of the search.
  assert.doesNotMatch(resFn, /if \(envPath\) return \{ path: envPath/,
    "an unchecked early return would reinstate the bug");
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
  const statusRoute = account.slice(at(account, '"/api/integrations/status"'), at(account, '"/api/integrations/apify-token"'));
  assert.match(statusRoute, /browser:/);
  assert.match(statusRoute, /available/);
  assert.match(statusRoute, /reasonCode/);
});

test("server probes browser availability on startup", () => {
  // Startup probe warms the cache so /api/integrations/status is fast on first request
  const listenBlock = server.slice(at(server, "app.listen(PORT"));
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
// Railway's actual builder for this service is Docker (confirmed via dashboard);
// nixpacks.toml was a leftover from an unrelated earlier experiment (never installed the
// chromium package itself, only runtime libraries) and has been deleted. These checks moved
// from nixpacks.toml to the Dockerfile, which is what actually builds the deployed image.

const dockerfile = fs.readFileSync("Dockerfile", "utf8");

test("nixpacks.toml has been removed (Docker is the confirmed Railway builder)", () => {
  assert.equal(fs.existsSync("nixpacks.toml"), false,
    "nixpacks.toml must not exist — it never installed the chromium package itself " +
    "(only runtime libraries) and Docker is the real builder for this service");
});

test("Dockerfile installs chromium and libnspr4 — the library that caused the crash", () => {
  assert.match(dockerfile, /\bchromium\b/, "chromium package itself must be installed");
  assert.match(dockerfile, /libnspr4/, "libnspr4 must be present — caused 'cannot open shared object file'");
});

test("Dockerfile installs other commonly missing Chromium dependencies", () => {
  assert.match(dockerfile, /libdbus-1-3/);
  assert.match(dockerfile, /libexpat1/);
  assert.match(dockerfile, /libfontconfig1/);
  assert.match(dockerfile, /libxi6/);
  assert.match(dockerfile, /libxtst6/);
  assert.match(dockerfile, /libx11-xcb1/);
});

test("Dockerfile sets PUPPETEER_EXECUTABLE_PATH matching the chromium package's install path", () => {
  assert.match(dockerfile, /PUPPETEER_EXECUTABLE_PATH=\/usr\/bin\/chromium\b/);
});
