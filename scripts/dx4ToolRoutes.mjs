#!/usr/bin/env node
/**
 * DX4 — THE EXTENSION'S TWO TOOL LINKS, REAL-RUN VERIFICATION.
 * ============================================================================================
 * The published extension opens `/resume` and `/ats-score?jd=…`. NEITHER WAS EVER A ROUTE, so
 * both fell through to the SPA catch-all — which redirects an authenticated admin to /admin. That
 * is the whole "the resume builder opened an admin session" report (docs/EXTENSION_DIAGNOSIS.md
 * §4), and it is a dead link, not a session bug.
 *
 * ⛔ THERE WERE THREE DEFECTS BEHIND ONE BUTTON, and a URL-only check finds exactly one of them:
 *   1. the path did not exist                         -> legacy aliases in App.jsx
 *   2. ATSToolPage never read ?jd=                    -> useSearchParams, so the job text arrives
 *   3. BOTH tool pages used <Link> without importing it, so they threw ReferenceError on render
 *      and had NEVER worked. `vite build` exits 0 on that, because JSX resolves the identifier at
 *      runtime. Found only by opening the page.
 *
 * So this asserts the pages RENDER, not merely that the URL is right — checking the URL alone
 * passed over a blank crashed page for the whole first run of this harness.
 *
 * Requires a built client (`npm run build`), because it drives client/dist through server.js.
 *
 * DX4_BASE points it at an ALREADY-RUNNING deployment instead of booting its own server. That is
 * how this gets used against production, which is the only place the fix actually matters: the
 * installed extension opens these two paths on the live site, not on a developer's machine. The
 * assertions are identical either way, and it writes nothing, so it is safe against production.
 *
 * Usage:  node scripts/dx4ToolRoutes.mjs
 *         DX4_BASE=https://jobsviadraft.com node scripts/dx4ToolRoutes.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4620;
const REMOTE = process.env.DX4_BASE || null;
const BASE = REMOTE || `http://127.0.0.1:${PORT}`;
const OUT = path.join(os.tmpdir(), 'verify-a');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (l, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? '  — ' + x : ''}`); if (!c) fail++; };

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });

console.log(REMOTE ? `target: ${BASE}  (remote — read-only)` : `target: ${BASE}  (local server.js)`);
const server = REMOTE ? null : spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, RM_DATA_DIR: path.join(OUT, 'data'), PORT: String(PORT),
         NODE_ENV: 'development', SESSION_SECRET: 'verify-a' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server?.stdout.on('data', () => {}); server?.stderr.on('data', () => {});
for (let i = 0; i < 90; i++) {
  if (await fetch(`${BASE}/api/health`).then(r => r.ok).catch(() => false)) break;
  await sleep(1000);
}

const resolution = await resolveBrowserExecutable();
const browser = await puppeteer.launch({
  executablePath: resolution.path, headless: 'new', pipe: true,
  userDataDir: path.join(OUT, 'profile'), args: ['--no-first-run'],
});

try {
  const JD = 'Senior Backend Engineer at Northwind Systems. Node, Postgres, payments.';
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

  // 1 · /resume — what the extension's "Open Resume Builder" opens
  await page.goto(`${BASE}/resume`, { waitUntil: 'networkidle2' });
  await sleep(900);
  check('/resume lands on the real generator, not a 404 or /admin',
    new URL(page.url()).pathname === '/tools/generate', page.url());
  // Landing on the right URL is not the same as the page WORKING. Both tool pages used <Link>
  // without importing it, so they threw on render and showed nothing — a URL-only check passed
  // over a blank page.
  check('/tools/generate actually renders (no pageerror)',
    consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ').slice(0, 160));
  check('/tools/generate rendered real content, not an empty root',
    (await page.evaluate(() => document.body.innerText.trim().length)) > 40);
  consoleErrors.length = 0;

  // 2 · /ats-score?jd= — the ATS button, both halves
  await page.goto(`${BASE}/ats-score?jd=${encodeURIComponent(JD)}`, { waitUntil: 'networkidle2' });
  await sleep(700);
  check('/ats-score lands on the real ATS tool',
    new URL(page.url()).pathname === '/tools/ats', page.url());
  check('the query string survived the redirect',
    new URL(page.url()).searchParams.get('jd') === JD,
    (new URL(page.url()).searchParams.get('jd') || '(dropped)').slice(0, 40));

  // 3 · THE SECOND HALF: the job text must actually be IN the textarea, not merely in the URL.
  // Wait for the element rather than sleeping — a fixed delay is why this reported "no textarea"
  // on a page that renders one unconditionally.
  await page.waitForSelector('textarea', { timeout: 10000 }).catch(() => {});
  const ta = await page.evaluate(() => {
    const el = document.querySelector('textarea');
    return el ? el.value : null;
  });
  check('/tools/ats actually renders (no pageerror)',
    consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ').slice(0, 160));
  check('the job text is prefilled into the textarea', ta === JD,
    ta === null ? 'no textarea found' : JSON.stringify((ta || '').slice(0, 40)));

  // 4 · an unknown path is still a 404 — the aliases must not have widened anything
  await page.goto(`${BASE}/definitely-not-a-route`, { waitUntil: 'networkidle2' });
  await sleep(500);
  check('an unrelated unknown path is untouched by the aliases',
    !/tools\/(ats|generate)/.test(page.url()), page.url());
} finally {
  await browser.close().catch(() => {});
  server?.kill();
}
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
