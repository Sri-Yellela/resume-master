#!/usr/bin/env node
/**
 * TASK AH6 — the Auto Apply panel opens on the day something last happened.
 * ============================================================================================
 * OBSERVED
 * "The date filter lands on today and shows an empty board when the last activity was earlier."
 *
 * WHAT IS ACTUALLY THERE, and it is worth being exact because the fix differs: the panel does not
 * land on today. It lands on NO DATE AT ALL and asks you to pick one — AD1's deliberate inversion,
 * which was right that a panel must not silently ship a day's applications nobody asked for, and
 * wrong about what to do instead. The commonest reason to open Auto Apply is to see what happened
 * on the last run, which is almost never today, and the panel was making the reader answer a
 * question it could answer itself.
 *
 * THE SHAPE OF THE FIX
 * One cheap request on mount — GET /api/apply/history/latest — returning a DATE, never a listing.
 * If there is one, that day is selected and loaded through the ordinary path, so there is still
 * exactly one way a day's rows arrive. If there is none, AD1's resting state is exactly right and
 * is what still renders; scripts/abPanelUi.mjs drives that case.
 *
 * WHAT IS ASSERTED HERE
 *   1  the last run was three days ago, and the panel opens ON THAT DAY, with its rows
 *   2  it SAYS why — naming the date, and offering today, which is the thing it did not choose
 *   3  today with no activity is still reachable, and still says nothing happened
 *   4  a date the USER picks stops claiming to be "your most recent activity"
 *   5  legibility: the three tabs explain themselves, and the standing work says it is not the
 *      date's
 *
 * Every request is served from a stub and every off-localhost request is aborted.
 *
 * Usage:  node scripts/ah6RecentRunDefault.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'data', 'screenshots', 'ah6');
const PORT = 5194;          // ah5 5195, ah4 5196, ah3 5197, ag1 5198, abPanelUi 5199
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
// THE PREMISE OF THE TASK: the last activity is not today.
const LAST_RUN = iso(daysAgo(3));
const TODAY = iso(new Date());
const label = (i) => { const [y, m, d] = i.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(); };

const ROWS = [
  { id: 901, runId: 5, jobId: 'gh1', title: 'Senior Engineer', company: 'Northwind', mode: 'semi',
    status: 'held_review', reasonCode: 'manual_review', atsScore: 84, resumeAvailable: true,
    screenshotAvailable: true, fillLogAvailable: true, missingRequired: ['Do you require sponsorship?'],
    startedAt: Date.now() - 3 * 86400000, finishedAt: Date.now() - 3 * 86400000 + 60000, attemptCount: 1 },
  { id: 902, runId: 5, jobId: 'lv1', title: 'Backend Engineer', company: 'Contoso', mode: 'semi',
    status: 'held_review', reasonCode: 'incomplete_form', atsScore: 77, resumeAvailable: true,
    screenshotAvailable: false, fillLogAvailable: true, missingRequired: ['How did you hear about us?'],
    startedAt: Date.now() - 3 * 86400000, finishedAt: Date.now() - 3 * 86400000 + 45000, attemptCount: 1 },
];
const COUNTS = { completed: 4, pending: 2, aborted: 1 };

const HARNESS_HTML = path.join(ROOT, 'client', 'ah6-harness.html');
const HARNESS_JSX = path.join(ROOT, 'client', 'src', 'ah6Harness.jsx');
const HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><title>AH6 — auto apply default date</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d0f12}
@keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body><div id="root"></div><script type="module" src="/src/ah6Harness.jsx"></script></body></html>
`;
const JSX = `// AH6 harness entry — written by scripts/ah6RecentRunDefault.mjs, deleted when it finishes.
import { createRoot } from "react-dom/client";
import "./index.css";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "./styles/theme.jsx";
import { AutoApplyProvider } from "./contexts/AutoApplyContext.jsx";
import { AutoApplyPanel } from "./panels/AutoApplyPanel.jsx";

// The panel calls useNavigate (a card can send you to Job Profiles), so it needs a Router. Memory
// rather than Browser: this harness is about the panel's own behaviour, not about routing.
createRoot(document.getElementById("root")).render(
  <MemoryRouter initialEntries={["/app/auto-apply"]}>
    <ThemeProvider>
      <AutoApplyProvider user={{ id: 1, username: "ada", planTier: "PRO" }}>
        <div style={{ width: 1100, background: "#0d0f12", padding: 16 }}>
          <AutoApplyPanel/>
        </div>
      </AutoApplyProvider>
    </ThemeProvider>
  </MemoryRouter>
);
`;

function startVite() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath,
      [path.join(ROOT, 'client', 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
      { cwd: path.join(ROOT, 'client'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b) => {
      out += b.toString().replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b/g, '');
      if (new RegExp(`localhost:${PORT}`).test(out)) resolve({ proc, url: `http://localhost:${PORT}` });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error(`vite did not start:\n${out.slice(-800)}`)), 60000);
  });
}

const FALLBACK = { ok: true, jobs: [], items: [], results: [], data: [], count: 0, total: 0 };
const FIXTURES = {
  '/api/auth/me': { authenticated: true, user: { id: 1, username: 'ada', planTier: 'PRO' } },
  '/api/apply/readiness': { ready: true, missing: [] },
  '/api/apply/runs': { runs: [] },
  // ONE pending approval, so the standing-work band actually renders. needsYouCount reads gate
  // portals + questions + pending + held applications + missing prerequisites; with none of them
  // there is no standing work, and a check for its scope note would be asserting the absence of a
  // section rather than the presence of an explanation.
  // `pending`, not `jobs` — loadApplyPending reads data.pending, and a fixture with the wrong key
  // renders an empty band that a scope-note check would report as "no standing work".
  '/api/apply/pending': { pending: [{ id: 77, jobId: 'gh9', title: 'Staff Engineer', company: 'Initech',
    status: 'awaiting_approval', reasonCode: 'awaiting_approval', atsScore: 81 }] },
  '/api/apply/questions': { questions: [] },
  '/api/apply/gate-packets': { packets: [], portals: [] },
};

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
    defaultViewport: { width: 1100, height: 900, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log(`      [page error] ${e.message}`));
  await page.evaluateOnNewDocument(() => {
    try { sessionStorage.setItem('rm_session_accent', 'sky'); } catch {}
  });

  const asked = [];
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url(), vite.url);
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return req.abort();
    if (!url.pathname.startsWith('/api/')) return req.continue();
    if (url.pathname === '/api/sync/events') return;
    asked.push(url.pathname + url.search);
    if (url.pathname === '/api/apply/history/latest') {
      return req.respond({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ date: LAST_RUN }) });
    }
    if (url.pathname === '/api/apply/history') {
      const date = url.searchParams.get('date');
      const group = url.searchParams.get('group') || 'pending';
      const live = date === LAST_RUN;
      const counts = live ? COUNTS : { completed: 0, pending: 0, aborted: 0 };
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
        date, group, jobs: live && group === 'pending' ? ROWS : [],
        counts, total: counts.completed + counts.pending + counts.aborted,
      }) });
    }
    if (url.pathname.startsWith('/api/apply/history/months')) {
      return req.respond({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ days: [LAST_RUN] }) });
    }
    req.respond({ status: 200, contentType: 'application/json',
      body: JSON.stringify(FIXTURES[url.pathname] ?? FALLBACK) });
  });

  console.log(`=== AH6 — last run ${LAST_RUN}, today is ${TODAY}\n`);
  await page.goto(`${vite.url}/ah6-harness.html`, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction(() => /your most recent activity/i.test(document.body.innerText),
    { timeout: 30000 }).catch(() => {});
  await sleep(800);

  // ── 1. it opens on the day something last happened ──────────────────────────────────────────
  console.log('── 1. IT OPENS ON THE LAST RUN, NOT ON NOTHING AND NOT ON TODAY ────────────────');
  const autoDate = await page.evaluate(() =>
    document.querySelector('[data-rm-auto-date]')?.dataset.rmAutoDate ?? null);
  check('the panel selected the date of the most recent run', autoDate === LAST_RUN,
    `${autoDate} (expected ${LAST_RUN})`);
  check('and it is NOT today — the premise of the task', autoDate !== TODAY, `${autoDate} vs ${TODAY}`);
  check('exactly ONE cheap latest-date request was made',
    asked.filter(u => u.startsWith('/api/apply/history/latest')).length === 1,
    asked.filter(u => u.startsWith('/api/apply/history/latest')).join(', '));
  const listings = asked.filter(u => u.startsWith('/api/apply/history?'));
  check('and the listing it loaded is for THAT day, not a speculative one',
    listings.length === 1 && listings[0].includes(`date=${LAST_RUN}`), listings.join(', '));

  const text0 = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  check('the day\'s applications are on screen, not an empty board',
    /Northwind/.test(text0) && /Contoso/.test(text0));
  check('the counts are the day\'s, and the label says which day',
    new RegExp(`Counts are for ${label(LAST_RUN).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text0),
    (text0.match(/Counts are for [^ ]+/) || ['absent'])[0]);

  // ── 2. it says why ───────────────────────────────────────────────────────────────────────────
  console.log('\n── 2. IT SAYS WHY THAT DAY IS ON SCREEN ────────────────────────────────────────');
  check('the panel names the date and calls it your most recent activity',
    new RegExp(`Showing ${label(LAST_RUN).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — your most recent activity`).test(text0),
    (text0.match(/Showing [^.]*activity\./) || ['absent'])[0]);
  check('and it offers today, which is the thing it did not choose',
    /Show today instead/.test(text0));
  await page.screenshot({ path: path.join(SHOTS, '1-opens-on-last-run.png'), fullPage: true });
  console.log(`  shot  ${path.relative(ROOT, path.join(SHOTS, '1-opens-on-last-run.png'))}`);

  // ── 3. legibility ────────────────────────────────────────────────────────────────────────────
  console.log('\n── 3. A FIRST-TIME VISITOR CAN READ IT ─────────────────────────────────────────');
  const tabNote = await page.evaluate(() =>
    document.querySelector('[data-rm-tab-note]')?.innerText.replace(/\s+/g, ' ') ?? null);
  check('the tab you are on explains itself IN TEXT, not in a tooltip',
    /Pending — queued, in flight, or waiting on you\./.test(tabNote || ''), tabNote);
  const standing = await page.evaluate(() =>
    document.querySelector('[data-rm-standing-scope]')?.innerText.replace(/\s+/g, ' ') ?? null);
  check('the standing work says it is NOT filtered by the date above',
    /not filtered by the date above/i.test(standing || ''), standing ?? '(no standing work rendered)');

  // ── 4. today is still reachable, and still honest ───────────────────────────────────────────
  console.log('\n── 4. TODAY, WITH NO ACTIVITY, IS STILL REACHABLE ──────────────────────────────');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /Show today instead/.test(x.innerText));
    if (b) b.click();
  });
  await sleep(1200);
  const text1 = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  const todayListing = asked.filter(u => u.startsWith('/api/apply/history?') && u.includes(`date=${TODAY}`));
  check('picking today loads today', todayListing.length === 1, todayListing.join(', '));
  // The shipped copy NAMES the day — "No applications on 8/25/2026" — rather than saying "this
  // date". That is better than the paraphrase in the task, so it is what is asserted.
  check('and it says nothing happened, naming the day, rather than showing the other day\'s rows',
    !/Northwind/.test(text1) && /No applications on \d/.test(text1),
    (text1.match(/No applications on [^\s]+/) || ['absent'])[0]);
  // The label described a choice the PANEL made. Once the user picks, it is no longer true.
  check('the "most recent activity" line is GONE once the user picks a day themselves',
    !/your most recent activity/i.test(text1));
  await page.screenshot({ path: path.join(SHOTS, '2-today-empty-and-honest.png'), fullPage: true });
  console.log(`  shot  ${path.relative(ROOT, path.join(SHOTS, '2-today-empty-and-honest.png'))}`);
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

console.log('');
console.log('='.repeat(96));
console.log(failures ? `${failures} FAILED` : `all checks passed — shots in ${path.relative(ROOT, SHOTS)}`);
console.log('='.repeat(96));
process.exit(failures ? 1 : 0);
