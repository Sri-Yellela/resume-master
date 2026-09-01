#!/usr/bin/env node
/**
 * AK2 task 4 — the bands, rendered by the REAL board in a REAL browser.
 * ============================================================================================
 *
 * The VERIFY clause asks for a screenshot of every surface and for "Not enough signal" to render
 * distinctly from "Weak". A source-string test cannot answer either: it can prove the component
 * calls atsBandFor and it cannot prove anything reached a pixel. A totally broken panel once passed
 * this repository's build and 1460 source tests.
 *
 * So this drives client/src/components/JobCard.jsx as the board actually mounts it, against a
 * stubbed /api/jobs whose scores are placed ON the cutpoints — 44 and 43, 26 and 25 — plus a null.
 * A boundary that renders the wrong side is the failure this shape of fixture catches and a
 * mid-band fixture does not.
 *
 * Excluded from verify:harness: screenshots, and it needs a built client + a browser.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';
import { ATS_BAND_CUTPOINTS, atsBandFor, atsBandLabel } from '../shared/atsBands.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const OUT_DIR = path.join(os.tmpdir(), 'ak2-band-surfaces');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// Scores placed ON the cutpoints, plus a null for the decline.
const CASES = [
  { score: 60,   expect: 'Strong'    },
  { score: ATS_BAND_CUTPOINTS.strong,       expect: 'Strong'   },  // 44, inclusive lower bound
  { score: ATS_BAND_CUTPOINTS.strong - 1,   expect: 'Moderate' },  // 43
  { score: ATS_BAND_CUTPOINTS.moderate,     expect: 'Moderate' },  // 26
  { score: ATS_BAND_CUTPOINTS.moderate - 1, expect: 'Weak'     },  // 25
  { score: null, expect: 'No signal' },
];

const now = Math.floor(Date.now() / 1000);
const POOL = CASES.map((c, i) => ({
  jobId: `b${i}`, id: `b${i}`,
  company: `Co${i}`,
  title: `${c.expect} case — score ${c.score === null ? 'null (declined)' : c.score}`,
  location: 'Remote', workType: 'Remote',
  url: `https://example.invalid/${i}`, applyUrl: `https://example.invalid/${i}`,
  source: 'ashby', sourcePlatform: 'ashby', automationTier: 'direct',
  postedAt: null, scrapedAt: now - i, discoveredAt: now - i,
  isActive: true, companyIconUrl: null,
  baseAtsScore: c.score,
  visited: false, starred: false, disliked: false, alreadyApplied: false,
}));

const FIXTURES = {
  '/api/auth/me': { authenticated: true, user: { id: 1, username: 'ada', planTier: 'PRO' } },
  '/api/domain-profiles': [{
    id: 1, profile_name: 'Software Engineering', is_active: 1,
    target_titles: JSON.stringify(['Software Engineer']),
    seniority: 'mid', work_type: null, location: null,
  }],
  '/api/domain-profiles/1/base-resume': { name: 'ada.pdf', content: 'Ada Lovelace — Software Engineer. 6 years.' },
  '/api/domain-profiles/1/enhance-status': { enhanceUsed: false, enhancePaid: false },
  '/api/apply/runs': { runs: [], review: [], gated: [], inFlight: [], submitted: [], stopped: [], statusCounts: {} },
  '/api/jobs': { jobs: POOL, total: POOL.length, totalPages: 1, nextCursor: null, attribution: [] },
};
const FALLBACK = {};

function startVite() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath,
      [path.join(ROOT, 'client', 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '5207', '--strictPort'],
      { cwd: path.join(ROOT, 'client'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b) => { out += b.toString(); if (/5207/.test(out)) resolve({ proc, url: 'http://localhost:5207' }); };
    proc.stdout.on('data', onData); proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error(`vite did not start:\n${out.slice(-600)}`)), 60000);
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('=== AK2 — ATS bands on the real board ===\n');
  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error('No Chrome binary.'); process.exit(1); }
  const vite = await startVite();
  console.log(`vite     ${vite.url}`);
  console.log(`shots    ${OUT_DIR}\n`);

  const browser = await puppeteer.launch({
    executablePath: resolution.path, headless: 'new', pipe: true,
    args: ['--no-first-run', '--no-default-browser-check'],
    defaultViewport: { width: 1500, height: 1200, deviceScaleFactor: 1 },
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => console.log(`      [page error] ${e.message}`));
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const raw = req.url();
      if (/logo\.clearbit\.com/.test(raw)) {
        return req.respond({ status: 200, contentType: 'image/png', body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64') });
      }
      const url = new URL(raw, vite.url);
      if (!url.pathname.startsWith('/api/')) return req.continue();
      req.respond({ status: 200, contentType: 'application/json',
        body: JSON.stringify(FIXTURES[url.pathname] ?? FALLBACK) });
    });

    await page.goto(`${vite.url}/app/jobs`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => /case — score/.test(document.body.innerText), { timeout: 30000 })
      .catch(async () => console.log('      [body]',
        JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 400))));
    await sleep(1200);
    await page.screenshot({ path: path.join(OUT_DIR, '1-board-all-bands.png'), fullPage: true });

    // Read the badge next to each card, WITH its colours, from the rendered DOM.
    const seen = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        const t = (el.textContent || '').trim();
        if (!/case — score/.test(t)) continue;
        if (el.children.length > 12) continue;
        const card = el.closest('div');
        if (!card) continue;
        const chips = [...card.querySelectorAll('span')]
          .map(s => ({ text: (s.textContent || '').trim(), bg: getComputedStyle(s).backgroundColor,
                       fg: getComputedStyle(s).color }))
          .filter(s => ['Strong', 'Moderate', 'Weak', 'No signal'].includes(s.text));
        if (chips.length) out.push({ title: t.slice(0, 60), chip: chips[0] });
      }
      return out;
    });

    console.log(`      rendered ${seen.length} band chips\n`);
    for (const c of CASES) {
      const label = c.score === null ? 'null (declined)' : String(c.score);
      const hit = seen.find(s => s.title.includes(`score ${label}`));
      check(`score ${label.padEnd(15)} renders "${c.expect}"`, hit?.chip?.text === c.expect,
        hit ? `got "${hit.chip.text}"` : 'no chip found');
    }

    const weak = seen.find(s => s.chip.text === 'Weak')?.chip;
    const none = seen.find(s => s.chip.text === 'No signal')?.chip;
    check('"Not enough signal" is VISUALLY distinct from "Weak"',
      !!weak && !!none && (weak.bg !== none.bg || weak.fg !== none.fg),
      weak && none ? `weak ${weak.bg}/${weak.fg} vs none ${none.bg}/${none.fg}` : 'one of them did not render');
    check('the raw number is nowhere on the board',
      !/ATS \d/.test(await page.evaluate(() => document.body.innerText)));

    // The expected mapping, computed from the shared module, must agree with the DOM — so this
    // harness fails if the module and the surface ever disagree, not merely if the surface breaks.
    for (const c of CASES) {
      const expected = atsBandLabel(atsBandFor(c.score)).short;
      check(`shared module agrees for ${c.score === null ? 'null' : c.score}`, expected === c.expect,
        `module says "${expected}"`);
    }

    console.log(`\n      screenshots: ${OUT_DIR}`);
  } finally {
    await browser.close();
    vite.proc.kill();
  }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
