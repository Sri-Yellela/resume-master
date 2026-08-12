// TASK A4 verification — browser resolution, and the probe/launch divergence signature.
//
// A4 restates a bug in launchBrowser: `process.env.PUPPETEER_EXECUTABLE_PATH || resolution.path`,
// discarding the existsSync-validated fallback, with the signature "readiness reports healthy via
// fallback while real launches fail". That code is NOT present — it was fixed in 76910ed, and the
// resolver's own existsSync guard landed in 8479220. This script proves the SIGNATURE cannot occur,
// rather than only proving the line is absent.
//
// Each case runs in its own child process: probeBrowserAvailability() caches in module state, so
// two cases in one process would not be independent.
//
// Usage: node scripts/a4BrowserResolution.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CASE = process.env.A4_CASE;

// ── Child: run one case and print a single JSON line ─────────────────────────
if (CASE) {
  const { resolveBrowserExecutable, probeBrowserAvailability, launchBrowser } =
    await import("../services/browserLauncher.js");

  const out = { case: CASE, env: process.env.PUPPETEER_EXECUTABLE_PATH ?? null };
  try {
    const resolution = await resolveBrowserExecutable();
    out.resolvedPath = resolution?.path ?? null;
    out.resolvedSource = resolution?.source ?? null;
    out.resolvedExists = resolution ? fs.existsSync(resolution.path) : false;

    if (CASE !== "resolve_only") {
      const probe = await probeBrowserAvailability();
      out.probeAvailable = probe.available;
      out.probePath = probe.resolvedPath ?? null;
      out.probeSource = probe.source ?? null;

      const browser = await launchBrowser({ headless: "new" });
      out.launchOk = true;
      // Faithful replica of server.js htmlToPdf's Chromium usage (A5 precondition: PDF must work).
      if (CASE === "pdf") {
        const page = await browser.newPage();
        await page.setViewport({ width: 1240, height: 1754 });
        await page.setContent("<!DOCTYPE html><html><body><h1>Ada Lovelace</h1><p>Resume</p></body></html>",
          { waitUntil: "networkidle0", timeout: 30000 });
        const pdf = await page.pdf({
          format: "Letter", printBackground: true, preferCSSPageSize: false,
          margin: { top: "0", bottom: "0", left: "0", right: "0" },
        });
        const buf = Buffer.from(pdf);
        out.pdfBytes = buf.length;
        out.pdfMagic = buf.subarray(0, 5).toString("latin1");
        const p = path.join(os.tmpdir(), `a4_pdf_${Date.now()}.pdf`);
        fs.writeFileSync(p, buf);
        out.pdfPath = p;
      }
      await browser.close();
    }
  } catch (e) {
    out.error = e.message;
    out.reasonCode = e.reasonCode ?? null;
  }
  console.log("__RESULT__" + JSON.stringify(out));
  process.exit(0);
}

// ── Parent: drive the cases ──────────────────────────────────────────────────
function runCase(name, env) {
  const r = spawnSync(process.execPath, [import.meta.filename], {
    encoding: "utf8",
    env: { ...process.env, A4_CASE: name, ...env },
  });
  const line = (r.stdout || "").split("\n").find(l => l.startsWith("__RESULT__"));
  if (!line) {
    console.log(`  (no result from child)\n${(r.stdout || "").trim()}\n${(r.stderr || "").trim()}`);
    return null;
  }
  return JSON.parse(line.slice("__RESULT__".length));
}

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
};

// The value .env actually sets. It does not exist on Windows, which is precisely the condition the
// A4 bug needed in order to bite.
const STALE = process.platform === "win32" ? "/usr/bin/chromium" : "/nonexistent/chromium-xyz";

console.log("=== 1. env var UNSET — baseline resolution ===");
const c1 = runCase("baseline", { PUPPETEER_EXECUTABLE_PATH: "", BROWSER_EXECUTABLE_PATH: "" });
check("resolves to an existing binary", !!c1?.resolvedPath && c1.resolvedExists, `${c1?.resolvedSource} ${c1?.resolvedPath}`);
check("probe reports available", c1?.probeAvailable === true);
check("launch succeeds", c1?.launchOk === true, c1?.error || "");

console.log(`\n=== 2. env var SET to a path that does NOT exist (${STALE}) — the failure signature ===`);
const c2 = runCase("stale_env", { PUPPETEER_EXECUTABLE_PATH: STALE });
check("resolver does NOT return the stale env path", c2?.resolvedPath !== STALE, `resolved=${c2?.resolvedPath}`);
check("resolver falls back to an existing binary", !!c2?.resolvedPath && c2.resolvedExists, `${c2?.resolvedSource}`);
check("fallback source is NOT the env var", c2?.resolvedSource !== "env:PUPPETEER_EXECUTABLE_PATH", `${c2?.resolvedSource}`);
check("probe reports available", c2?.probeAvailable === true);
check("probe path is the fallback, not the stale env path", c2?.probePath === c2?.resolvedPath, `${c2?.probePath}`);
check("LAUNCH SUCCEEDS — probe and launch cannot diverge", c2?.launchOk === true, c2?.error || "");

console.log("\n=== 3. env var SET to a real path — the operator override still wins ===");
const real = c1?.resolvedPath;
const c3 = real ? runCase("real_env", { PUPPETEER_EXECUTABLE_PATH: real }) : null;
check("resolver honours a valid override", c3?.resolvedPath === real, `${c3?.resolvedPath}`);
check("source reports the override", c3?.resolvedSource === "env:PUPPETEER_EXECUTABLE_PATH", `${c3?.resolvedSource}`);
check("launch succeeds", c3?.launchOk === true, c3?.error || "");

console.log("\n=== 4. PDF generation end to end (A5 precondition) ===");
const c4 = runCase("pdf", { PUPPETEER_EXECUTABLE_PATH: STALE });
check("PDF produced through the launcher, with the stale env var set", c4?.pdfBytes > 0, `${c4?.pdfBytes} bytes`);
check("output is a real PDF (%PDF- magic)", c4?.pdfMagic === "%PDF-", JSON.stringify(c4?.pdfMagic));
if (c4?.pdfPath) { try { fs.unlinkSync(c4.pdfPath); } catch {} }

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exitCode = failures === 0 ? 0 : 1;
