#!/usr/bin/env node
/**
 * TASK AH5 — the fill log and the named hold, on screen. SCREENSHOTS.
 * ============================================================================================
 * The behavioural half is scripts/ah5ReuseAndFillLog.mjs, which drives the real route and a real
 * browser and counts the generator's own invocations. This renders what the candidate actually
 * sees: an attempt row that NAMES the fields still theirs to answer, and the fill log it opens.
 *
 * The payload is the REAL SHAPE the endpoint returns — taken from a run of the behavioural
 * harness — rather than a hand-written mock of what it might look like.
 *
 * EXCLUDED from the auto-discovered suite, with the other screenshot harnesses.
 *
 * Usage:  node scripts/ah5FillLogShots.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'data', 'screenshots', 'ah5');
const PORT = 5195;                 // ah4 owns 5196, ah3 5197, ag1 5198, abPanelUi 5199
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// The shape scripts/ah5ReuseAndFillLog.mjs observed on the fixture Greenhouse form.
const FILL_LOG = {
  runJobId: 1, jobId: 'gh1', status: 'held_review', reasonCode: 'manual_review',
  fieldsDiscovered: 9,
  filled: [
    { field: 'first_name', label: 'First Name', value: 'Ada', provenance: 'field_map_exact', confidence: 1 },
    { field: 'last_name', label: 'Last Name', value: 'Lovelace', provenance: 'field_map_exact', confidence: 1 },
    { field: 'email', label: 'Email', value: 'ada@example.com', provenance: 'field_map_exact', confidence: 1 },
    { field: 'phone', label: 'Phone', value: '+1 555 0100', provenance: 'field_map_exact', confidence: 1 },
    { field: 'legal_name', label: 'Legal Name', value: 'Ada Lovelace', provenance: 'field_map_exact', confidence: 1 },
    { field: 'preferred', label: 'Preferred Name', value: 'Ada', provenance: 'field_map_exact', confidence: 1 },
    { field: 'yoe', label: 'Years of professional experience', value: '8', provenance: 'field_map_exact', confidence: 1 },
    { field: 'start', label: 'Earliest start date', value: '2026-09-01', provenance: 'field_map_exact', confidence: 1 },
  ],
  blanks: [
    { field: 'sponsorship', label: 'Do you now or in the future require sponsorship for work authorization?',
      required: true, reason: 'needs_you', eligibility: 'sponsorship',
      detail: 'an eligibility question (sponsorship) — only you can answer this' },
    { field: 'work_auth', label: 'Are you legally authorized to work in the country of employment?',
      required: true, reason: 'needs_you', eligibility: 'work_auth',
      detail: 'an eligibility question (work_auth) — only you can answer this' },
    { field: 'linkedin', label: 'LinkedIn Profile', required: false, reason: 'unmatched', detail: null },
    { field: 'source', label: 'How did you hear about us? (free text, no standard mapping)',
      required: true, reason: 'unmatched', detail: null },
  ],
  corrections: [],
  resume: {
    artifactId: 1, atsScore: 84,
    reuse: { reused: true, reason: 'reused',
      summary: 'Reused the resume already generated for this job — nothing was regenerated.' },
  },
};
const ATTEMPT = {
  id: 1, jobId: 'gh1', title: 'Senior Engineer', company: 'FakeCo', mode: 'semi',
  status: 'held_review', reasonCode: 'manual_review', atsScore: 84,
  resumeAvailable: true, screenshotAvailable: true, fillLogAvailable: true,
  missingRequired: FILL_LOG.blanks.filter(b => b.required).map(b => b.label),
  startedAt: Date.now() - 60000, finishedAt: Date.now(), attemptCount: 1,
  applyUrl: 'http://localhost:4599/greenhouse?ats=boards.greenhouse.io',
};

const HARNESS_HTML = path.join(ROOT, 'client', 'ah5-harness.html');
const HARNESS_JSX = path.join(ROOT, 'client', 'src', 'ah5Harness.jsx');
const HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><title>AH5 — fill log</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d0f12}
@keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body><div id="root"></div><script type="module" src="/src/ah5Harness.jsx"></script></body></html>
`;
const JSX = `// AH5 harness entry — written by scripts/ah5FillLogShots.mjs, deleted when it finishes.
import { createRoot } from "react-dom/client";
import "./index.css";
import { ThemeProvider } from "./styles/theme.jsx";
import { AttemptRow } from "./panels/AutoApplyPanelSections.jsx";
import { useTheme } from "./styles/theme.jsx";

function Harness() {
  const { theme } = useTheme();
  return (
    <div style={{ width: 940, background: "#0d0f12", padding: 16 }}>
      <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, letterSpacing: "0.12em",
                    textTransform: "uppercase", color: "#8b95a1", marginBottom: 10 }}>
        AH5 — the hold names its fields, and the fill log says what was filled
      </div>
      <AttemptRow job={window.__AH5_ATTEMPT__} theme={theme}
        artifactUrl={(id, kind) => "#" + kind} packetFor={() => null}
        onHandoff={() => {}} onRerun={() => {}} />
    </div>
  );
}
createRoot(document.getElementById("root")).render(
  <ThemeProvider><Harness/></ThemeProvider>
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
    defaultViewport: { width: 940, height: 700, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log(`      [page error] ${e.message}`));
  await page.evaluateOnNewDocument((attempt) => {
    window.__AH5_ATTEMPT__ = attempt;
    try { sessionStorage.setItem('rm_session_accent', 'sky'); } catch {}
  }, ATTEMPT);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url(), vite.url);
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return req.abort();
    if (!url.pathname.startsWith('/api/')) return req.continue();
    if (url.pathname === '/api/sync/events') return;
    const body = url.pathname.endsWith('/fill-log') ? FILL_LOG : { ok: true };
    req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto(`${vite.url}/ah5-harness.html`, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction(() => /Still yours to answer/.test(document.body.innerText),
    { timeout: 30000 }).catch(() => {});
  await sleep(500);

  const named = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  check('the hold NAMES the fields still outstanding, on the row itself',
    /Still yours to answer/.test(named) && /require sponsorship/.test(named));
  check('and does not merely say "required fields were left empty"',
    !/Required fields were left empty[^:]*$/.test(named));
  await page.screenshot({ path: path.join(SHOTS, '1-hold-names-its-fields.png') });
  console.log(`  shot  ${path.relative(ROOT, path.join(SHOTS, '1-hold-names-its-fields.png'))}`);

  // Open the log — it is ON REQUEST, so nothing is fetched until this click.
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /What was filled/.test(x.innerText));
    if (!b) return false;
    b.click();
    return true;
  });
  check('the row offers a fill log', clicked);
  await page.waitForFunction(() => document.querySelector('[data-rm-fill-log]') != null,
    { timeout: 15000 }).catch(() => {});
  await sleep(600);

  const log = await page.evaluate(() => {
    const el = document.querySelector('[data-rm-fill-log]');
    return el ? el.innerText.replace(/\s+/g, ' ') : null;
  });
  check('the log says whether anything was regenerated',
    /nothing was regenerated/i.test(log || ''), (log || '').slice(0, 80));
  check('every filled field is shown with the rule that produced it',
    /First Name/.test(log || '') && /field_map_exact/.test(log || ''));
  check('every blank is shown with a reason a human can read',
    /only you can answer this/i.test(log || '') && /we did not recognise the field/i.test(log || ''),
    (log || '').slice(-140));
  check('the OPTIONAL blank is in the record too — this is the form, not a gate',
    /LinkedIn Profile/.test(log || ''));
  await page.screenshot({ path: path.join(SHOTS, '2-fill-log.png'), fullPage: true });
  console.log(`  shot  ${path.relative(ROOT, path.join(SHOTS, '2-fill-log.png'))}`);
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
