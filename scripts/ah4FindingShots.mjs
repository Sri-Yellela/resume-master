#!/usr/bin/env node
/**
 * TASK AH4 — the KB finding strip, before and after. SCREENSHOTS.
 * ============================================================================================
 * The analysis half is scripts/ah4LocationClaims.mjs, which runs inside verifyHarnesses. This is
 * the other half: it renders the real SandboxPanel review strip with the real findings for the
 * reported claim and photographs it.
 *
 * EXCLUDED from the auto-discovered suite, with ah1IdentityShots, ah2MultiTab and
 * ah3TermPanelShots, for the reason recorded in ah3TermQuality.
 *
 * Usage:  node scripts/ah4FindingShots.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';
import { normalizeOrgUnitKey } from '../services/kb/orgLayer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'data', 'screenshots', 'ah4');
const PORT = 5196;                  // ah3 owns 5197, ag1 5198, abPanelUi 5199
const COMPANY = 'Stripe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// ── the pre-AH4 failsafe, so before/after is COMPUTED ─────────────────────────────────────────
function loadPreFix() {
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  let rev = 'HEAD';
  try {
    const introduced = git('log', '-S', 'looksLikeLocation', '--format=%H', '--',
      'services/kb/failsafe.js').toString().trim().split('\n').filter(Boolean).pop();
    if (introduced) rev = `${introduced}^`;
  } catch { /* uncommitted — HEAD is the BEFORE */ }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ah4-prefix-${process.pid}-`));
  // ONE file, with its imports POINTED AT THE CURRENT TREE rather than followed. Walking the graph
  // reaches ../resumeFormatter.js -> ./usageTracker.js -> ../shared/anthropicModels.js, outside
  // services/ entirely, and materialising that by hand died on "does not provide an export named
  // 'ANTHROPIC_PRICING'". Holding the formatter and org layer FIXED across both sides is also the
  // more correct comparison: AH4 changed failsafe.js and nothing else.
  const src = git('show', `${rev}:services/kb/failsafe.js`).toString();
  const resolved = src.replace(/from\s+(["'])(\.{1,2}\/[^"']+\.js)\1/g, (_m, q, rel) => {
    const abs = path.resolve(ROOT, 'services', 'kb', rel);
    return `from ${q}${pathToFileURL(abs).href}${q}`;
  });
  const out = path.join(dir, 'failsafe.mjs');
  fs.writeFileSync(out, resolved);
  return { url: pathToFileURL(out).href, tmp: dir, rev };
}

const db = new Database(path.join(ROOT, 'data', 'resume_master.db'), { readonly: true });
const preFix = loadPreFix();
const AFTER = await import(pathToFileURL(path.join(ROOT, 'services', 'kb', 'failsafe.js')).href);
const BEFORE = await import(preFix.url);
try { fs.rmSync(preFix.tmp, { recursive: true, force: true }); } catch {}

const resume = (role) =>
  `Ada Lovelace\nSoftware Engineer\n\nEXPERIENCE\n\n${COMPANY} | Jan 2021 - Present\n${role}\n` +
  `- Built payment rails serving millions of merchants.\n- Reduced authorization latency by 30%.\n`;
const msgs = (M, role) => M.validateResumeClaims(db, resume(role)).map(f => `[${f.type}] ${f.message}`);

const REPORTED = 'Software Engineer, Payments Infrastructure, Bangalore';

// ── the finding strip on screen ────────────────────────────────────────────────────────────
console.log('\n── 5. THE FINDING STRIP ────────────────────────────────────────────────────────');
const HARNESS_HTML = path.join(ROOT, 'client', 'ah4-harness.html');
const HARNESS_JSX = path.join(ROOT, 'client', 'src', 'ah4Harness.jsx');
const HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><title>AH4 — KB failsafe findings</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d0f12}
@keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body><div id="root"></div><script type="module" src="/src/ah4Harness.jsx"></script></body></html>
`;
const JSX = `// AH4 harness entry — written by scripts/ah4LocationClaims.mjs, deleted when it finishes.
import { createRoot } from "react-dom/client";
import "./index.css";
import { ThemeProvider } from "./styles/theme.jsx";
import SandboxPanel from "./panels/SandboxPanel.jsx";

const which = new URLSearchParams(location.search).get("v") || "after";
const entry = (window.__AH4_ENTRIES__ || {})[which] || null;

createRoot(document.getElementById("root")).render(
  <ThemeProvider>
    <div style={{ width: 1000, background: "#0d0f12" }}>
      <div style={{ padding: "14px 16px 8px", fontFamily: "system-ui, sans-serif", fontSize: 12,
                    letterSpacing: "0.12em", textTransform: "uppercase", color: "#8b95a1" }}>
        {which === "before"
          ? "BEFORE — the location reported as a team that does not exist"
          : "AFTER — the location is a location, and the real team is what was checked"}
      </div>
      <div style={{ height: 560 }}>
        <SandboxPanel entry={entry} onClose={() => {}} onSave={() => {}} onExport={() => {}} width={1000} />
      </div>
    </div>
  </ThemeProvider>
);
`;
function startVite() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath,
      [path.join(ROOT, 'client', 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
      { cwd: path.join(ROOT, 'client'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b) => {
      // \x1b rather than a raw ESC byte in the source: vite colours the port separately from the
      // host, so the bytes read "localhost:<ESC>[1m5196" and stripping only the bracket part
      // leaves the escape sitting between the colon and the number.
      out += b.toString().replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b/g, '');
      if (new RegExp(`localhost:${PORT}`).test(out)) resolve({ proc, url: `http://localhost:${PORT}` });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error(`vite did not start:\n${out.slice(-800)}`)), 60000);
  });
}

const resumeHtml =
  `<div class="section"><div class="section-title">EXPERIENCE</div>` +
  `<div class="entry"><div class="entry-header"><div class="entry-meta">${COMPANY} <span class="sep">|</span> ` +
  `Payments Infrastructure, Bangalore</div><div class="dates">Jan 2021 - Present</div></div>` +
  `<ul class="bullets"><li>Built payment rails serving millions of merchants.</li></ul></div></div>`;
const entries = {
  before: { company: COMPANY, title: 'Software Engineer', html: resumeHtml,
    kbFindings: BEFORE.validateResumeClaims(db, resume(REPORTED)) },
  after: { company: COMPANY, title: 'Software Engineer', html: resumeHtml,
    kbFindings: AFTER.validateResumeClaims(db, resume(REPORTED)) },
};
db.close();

fs.mkdirSync(SHOTS, { recursive: true });
fs.writeFileSync(HARNESS_HTML, HTML);
fs.writeFileSync(HARNESS_JSX, JSX);
let vite = null, browser = null;
try {
  const resolution = await resolveBrowserExecutable();
  if (!resolution) throw new Error('No Chrome binary.');
  vite = await startVite();
  browser = await puppeteer.launch({
    executablePath: resolution.path, headless: 'new', pipe: true,
    args: ['--no-first-run', '--no-default-browser-check'],
    defaultViewport: { width: 1000, height: 700, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log(`      [page error] ${e.message}`));
  await page.evaluateOnNewDocument((payload) => {
    window.__AH4_ENTRIES__ = payload;
    try { sessionStorage.setItem('rm_session_accent', 'sky'); } catch {}
  }, entries);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url(), vite.url);
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return req.abort();
    if (!url.pathname.startsWith('/api/')) return req.continue();
    if (url.pathname === '/api/sync/events') return;
    req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  for (const which of ['before', 'after']) {
    await page.goto(`${vite.url}/ah4-harness.html?v=${which}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(2500);
    const strip = await page.evaluate(() => {
      const el = [...document.querySelectorAll('div')].find(d => /KB finding/.test(d.innerText || ''));
      return el ? el.parentElement.innerText.replace(/\s+/g, ' ').trim() : null;
    });
    console.log(`  ${which}: ${strip || '(no finding strip — nothing to review)'}`);
    if (which === 'before') {
      check('the BEFORE strip shows the Bangalore flag on screen', /Bangalore/.test(strip || ''), String(strip));
    } else {
      check('the AFTER strip does not mention Bangalore', !/Bangalore/.test(strip || ''), String(strip));
    }
    const file = path.join(SHOTS, `${which === 'before' ? '1-before' : '2-after'}.png`);
    await page.screenshot({ path: file });
    console.log(`  shot  ${path.relative(ROOT, file)}`);
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (vite?.proc?.pid) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(vite.proc.pid), '/T', '/F'], { stdio: 'ignore' });
      else vite.proc.kill();
    } catch { try { vite.proc.kill(); } catch {} }
  }
  for (const f of [HARNESS_HTML, HARNESS_JSX]) { try { fs.rmSync(f, { force: true }); } catch {} }
}

console.log('\n' + '='.repeat(96));
console.log(failures ? `${failures} FAILED` : `all checks passed — shots in ${path.relative(ROOT, SHOTS)}`);
console.log('='.repeat(96));
process.exit(failures ? 1 : 0);
