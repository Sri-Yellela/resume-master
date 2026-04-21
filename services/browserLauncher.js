// services/browserLauncher.js — environment-aware Puppeteer browser launcher
//
// Shared by services/applyAutomation.js and server.js (htmlToPdf).
// Centralises browser resolution, launch args, and error classification so
// neither caller needs platform-specific logic.
//
// Resolution order:
//   1. BROWSER_EXECUTABLE_PATH env var   (explicit operator override)
//   2. Known Linux system paths          (/usr/bin/chromium-browser, etc.)
//   3. @sparticuz/chromium bundled path  (default for containers/Railway)
//   4. Windows system Chrome paths       (dev / local environments)
//
// Error reason codes emitted:
//   browser_binary_not_found            — no executable located
//   browser_runtime_missing_dependency  — binary present; shared lib missing (e.g. libnspr4)
//   browser_launch_failed               — other Puppeteer/Chromium startup error
//   browser_timeout                     — launch timed out

import puppeteer from "puppeteer-core";
import chromium  from "@sparticuz/chromium";
import fs        from "fs";
import path      from "path";

// ── Known system paths ────────────────────────────────────────────────────────

const LINUX_SYSTEM_PATHS = [
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/local/bin/chromium",
  "/usr/local/bin/chrome",
];

const WINDOWS_SYSTEM_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * Resolve the best available browser executable.
 * Returns { path, source } or null when nothing is found.
 */
export async function resolveBrowserExecutable() {
  // 1. Operator override — highest priority, no filesystem check required
  const envPath = process.env.BROWSER_EXECUTABLE_PATH;
  if (envPath) {
    return { path: envPath, source: "env:BROWSER_EXECUTABLE_PATH" };
  }

  const isWindows = process.platform === "win32";

  if (isWindows) {
    // Windows: system Chrome only — @sparticuz provides a Linux ELF binary that cannot run here
    const localAppData = process.env.LOCALAPPDATA || "";
    const candidates = [
      ...WINDOWS_SYSTEM_PATHS,
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    ];
    for (const p of candidates) {
      try { if (fs.existsSync(p)) return { path: p, source: "system:windows" }; } catch {}
    }
    return null;
  }

  // Linux/macOS: prefer system-installed browser (avoids @sparticuz extraction overhead)
  for (const p of LINUX_SYSTEM_PATHS) {
    try { if (fs.existsSync(p)) return { path: p, source: "system:linux" }; } catch {}
  }

  // Fallback: @sparticuz/chromium bundled binary (downloaded/extracted to /tmp on first use)
  try {
    const bundledPath = await chromium.executablePath();
    if (bundledPath) return { path: bundledPath, source: "sparticuz:bundled" };
  } catch {}

  return null;
}

// ── Launch args ───────────────────────────────────────────────────────────────

/**
 * Build container-safe Puppeteer launch arguments.
 * useChromiumArgs: true  → merge with @sparticuz curated set (Linux/containers)
 *                  false → minimal flag set (Windows / system Chrome)
 */
export function buildLaunchArgs({ useChromiumArgs = false } = {}) {
  const base = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
  ];
  if (!useChromiumArgs) return base;
  // Merge @sparticuz flags with base; deduplicate
  const merged = new Set([...chromium.args, ...base]);
  return [...merged];
}

// ── Error classification ──────────────────────────────────────────────────────

/**
 * Classify a raw Puppeteer launch error into a structured reason code.
 * Keeps raw OS-level detail out of user-facing messages.
 */
export function classifyLaunchError(err) {
  const msg      = String(err.message || "");
  const extra    = String(err.stderr   || "");
  const combined = (msg + " " + extra).toLowerCase();

  // Shared-library failures — the crash that prompted this module
  if (/cannot open shared object file|error while loading shared lib|\.so\b.*no such file/i.test(combined)) {
    return "browser_runtime_missing_dependency";
  }
  if (err.reasonCode === "browser_binary_not_found"
      || /chrome not found|no such file or directory|binary not found|could not find chromium/i.test(combined)) {
    return "browser_binary_not_found";
  }
  if (/timeout/i.test(combined)) {
    return "browser_timeout";
  }
  return "browser_launch_failed";
}

// ── Readiness probe ───────────────────────────────────────────────────────────

// Cache result — browser availability does not change within a process lifetime.
let _readinessCache = null;

/**
 * Probe whether a browser can actually launch in this environment.
 * Cached after first successful or failed attempt.
 *
 * Returns { available, reasonCode, resolvedPath, source, error }
 */
export async function probeBrowserAvailability() {
  if (_readinessCache) return _readinessCache;

  const resolution = await resolveBrowserExecutable();
  if (!resolution) {
    _readinessCache = {
      available: false,
      reasonCode: "browser_binary_not_found",
      resolvedPath: null,
      source: null,
      error: "No browser binary located on this system. Install Chrome/Chromium or set BROWSER_EXECUTABLE_PATH.",
    };
    return _readinessCache;
  }

  const isWindows = process.platform === "win32";
  const args = buildLaunchArgs({ useChromiumArgs: !isWindows });
  let browser;
  try {
    console.log(`[browserLauncher] probing — source=${resolution.source} path=${resolution.path}`);
    browser = await puppeteer.launch({ args, executablePath: resolution.path, headless: true });
    await browser.close();
    _readinessCache = {
      available: true,
      reasonCode: null,
      resolvedPath: resolution.path,
      source: resolution.source,
      error: null,
    };
  } catch (e) {
    const reasonCode = classifyLaunchError(e);
    console.warn(`[browserLauncher] probe failed — ${reasonCode}: ${e.message}`);
    _readinessCache = {
      available: false,
      reasonCode,
      resolvedPath: resolution.path,
      source: resolution.source,
      error: e.message,
    };
  }
  return _readinessCache;
}

// ── Main launch API ───────────────────────────────────────────────────────────

/**
 * Launch a Puppeteer browser — environment-aware.
 * Resolves the best binary, builds container-safe args, classifies errors.
 * Throws with err.reasonCode set on failure.
 *
 * @param {object}  options
 * @param {boolean} options.headless    Run headless (default: true)
 * @param {object}  options.viewport    defaultViewport override
 * @param {boolean} options.isWindows   Override platform detection
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
export async function launchBrowser({ headless = true, viewport = null, isWindows = null } = {}) {
  if (isWindows === null) isWindows = process.platform === "win32";

  const resolution = await resolveBrowserExecutable();
  if (!resolution) {
    const err = new Error(
      "No browser binary found. Install Chrome/Chromium or set BROWSER_EXECUTABLE_PATH."
    );
    err.reasonCode = "browser_binary_not_found";
    throw err;
  }

  const args = buildLaunchArgs({ useChromiumArgs: !isWindows });
  const defaultVp = viewport || (isWindows
    ? { width: 1280, height: 800 }
    : chromium.defaultViewport);

  console.log(`[browserLauncher] launching — source=${resolution.source} headless=${headless}`);

  try {
    return await puppeteer.launch({
      args,
      executablePath:  resolution.path,
      defaultViewport: defaultVp,
      headless,
    });
  } catch (e) {
    const reasonCode = classifyLaunchError(e);
    console.error(`[browserLauncher] launch failed — ${reasonCode}: ${e.message}`);
    const classified = new Error(
      reasonCode === "browser_runtime_missing_dependency"
        ? "Browser is missing required system libraries (e.g. libnspr4). Check server dependencies."
        : reasonCode === "browser_binary_not_found"
          ? "Browser binary not found. Install Chrome or set BROWSER_EXECUTABLE_PATH."
          : `Browser launch failed: ${e.message}`
    );
    classified.reasonCode = reasonCode;
    classified.originalError = e.message;
    throw classified;
  }
}
