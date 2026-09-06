#!/usr/bin/env node
/**
 * TASK Q requirement 3 — REAL-RUN verification that the approval budget REACHES PIXELS.
 * ============================================================================================
 * "Both caps stay SURFACEABLE — the schemas carry limit and remaining, and the client renders
 * them. Do not let a cap fail as a silent drop."
 *
 * test/approvalCap.test.js proves the server sends it and that the JSX contains the branches. That
 * is not the same claim. A source-string test passes over a card that never renders, a `detail`
 * prop the component ignores, a context value that never arrives, and a cap that is present in the
 * payload and invisible on the screen — which is exactly "a cap that fails as a silent drop", the
 * one outcome the requirement names.
 *
 * So this drives the REAL App, the REAL AutoApplyContext and the REAL AutoApplyPanel in a real
 * Chrome, three times, and reads the rendered text back. Same approach and same vite-with-stubbed-
 * /api mechanism as scripts/abPanelUi.mjs; see that file for why the API is stubbed rather than a
 * real server (the server's DB path is not configurable, and seeding a developer's working database
 * to take a screenshot is not a reasonable trade). What is under test here is what the panel does
 * with a given response — which is the whole of the claim being made.
 *
 * THREE STATES, because they are three different sentences and the middle one is the one that
 * matters most:
 *
 *   HEADROOM   3 waiting, 27 of 30 left    — says the number, nothing alarming
 *   SHORTFALL  6 waiting,  2 of 30 left    — ⛔ must say more are waiting than can be approved,
 *                                            BEFORE the user selects all six
 *   EXHAUSTED  4 waiting,  0 of 30 left    — must say they are stuck and that the queue is kept
 *
 * Usage:  node scripts/am2ApprovalCapUi.mjs
 *         AM2_KEEP_OPEN=1 node scripts/am2ApprovalCapUi.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(os.tmpdir(), 'am2-approval-cap');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

const now = Date.now();
const pendingRows = (n) => Array.from({ length: n }, (_, i) => ({
  runJobId: 100 + i, runId: 9, jobId: `gh-${i}`,
  title: 'Software Engineer', company: ['OpenAI', 'Stripe', 'Figma', 'Linear', 'Notion', 'Airbnb'][i % 6],
  applyUrl: `https://example.test/${i}`,
  createdAt: Math.floor(now / 1000) - i * 600,
  answerCount: 9, guessCount: 0,
  resume: { artifactId: null, atsScore: null, available: false },
  baseAts: { score: 41, band: 'moderate', scorable: true, declineReasons: [],
             matched: ['python'], missing: ['go'], matchedCount: 1, missingCount: 1, resumeDepth: null },
  generationDeferred: true,
  screenshotAvailable: false,
}));

const SCENARIOS = [
  { key: 'headroom',  waiting: 3, cap: { limit: 30, approvedLast24h: 3,  remaining: 27 } },
  { key: 'shortfall', waiting: 6, cap: { limit: 30, approvedLast24h: 28, remaining: 2 } },
  { key: 'exhausted', waiting: 4, cap: { limit: 30, approvedLast24h: 30, remaining: 0 } },
  // ⛔ THE COMPATIBILITY STATE. An older server sends no approvalCap at all. The panel must fall
  // back to its original sentence rather than rendering "0 of undefined approvals left" — a client
  // that invents a limit it was not told is worse than one that says nothing.
  { key: 'no-cap',    waiting: 3, cap: null },
];

const FIXTURES = {
  '/api/auth/me': { authenticated: true, user: { id: 1, username: 'ada', email: 'ada@example.com', planTier: 'PRO' } },
  '/api/apply/readiness': { available: true, reason: null },
  '/api/apply/questions': { questions: [], eligibilityCount: 0, blockedJobs: 0 },
  '/api/apply/runs': { runs: [] },
  '/api/apply/review-queue': { jobs: [], gated: [], origin: null, total: 0, returned: 0, truncated: false, limit: 100 },
  '/api/apply/history/latest': { date: null },
  '/api/integrations/status': { apply: { missing: [] } },
  '/api/domain-profiles': [
    { id: 1, profile_name: 'Backend Engineer', seniority: 'senior', is_active: 1, has_base_resume: 1,
      base_resume_updated_at: Math.floor(now / 1000) - 86400,
      target_titles: ['Software Engineer'], role_family: 'engineering' },
  ],
  '/api/applications': [],
  '/api/resumes': [],
};
const FALLBACK = { ok: true, jobs: [], items: [], results: [], data: [], count: 0, total: 0 };

function startVite() {
  return new Promise((resolve, reject) => {
    // vite's own bin under this node, not npx — see abPanelUi.mjs. A different port so the two
    // harnesses can never collide in the same suite run.
    const proc = spawn(process.execPath,
      [path.join(ROOT, 'client', 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '5203', '--strictPort'],
      { cwd: path.join(ROOT, 'client'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b) => {
      // ⛔ THE ESC BYTE HAS TO GO TOO. Stripping only `[36m` and leaving the ESC byte in front of it
      // puts an invisible byte between "localhost:" and the port, so /localhost:5203/ never matches
      // and this rejects after 60s with the banner — showing the port — in the error text. Vite
      // bolds the port, which is exactly where the leftover byte lands.
      out += b.toString().replace(/?\[[0-9;]*m/g, '');
      if (/localhost:5203/.test(out)) resolve({ proc, url: 'http://localhost:5203' });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error(`vite did not start:\n${out.slice(-800)}`)), 60000);
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('=== TASK Q — does the approval budget reach the screen? ===\n');

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error('No Chrome binary.'); process.exit(1); }
  const vite = await startVite();
  console.log(`vite     ${vite.url}`);
  console.log(`shots    ${OUT_DIR}\n`);

  const browser = await puppeteer.launch({
    executablePath: resolution.path, headless: 'new', pipe: true,
    args: ['--no-first-run', '--no-default-browser-check'],
    defaultViewport: { width: 1400, height: 1400, deviceScaleFactor: 1 },
  });

  let scenario = SCENARIOS[0];
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => console.log(`      [page error] ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') console.log(`      [console] ${m.text()}`); });

    await page.setRequestInterception(true);
    let pendingServed = 0;
    page.on('request', (req) => {
      const url = new URL(req.url(), vite.url);
      if (!url.pathname.startsWith('/api/')) return req.continue();
      if (url.pathname === '/api/apply/pending') {
        pendingServed++;
        // The endpoint's real shape: the queue AND the budget that decides how much of it can be
        // acted on. Omitting approvalCap entirely is the `no-cap` scenario, not a key set to null —
        // an older server does not send the key.
        const body = { pending: pendingRows(scenario.waiting) };
        if (scenario.cap) body.approvalCap = scenario.cap;
        return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      }
      const body = FIXTURES[url.pathname] ?? FALLBACK;
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    for (const s of SCENARIOS) {
      scenario = s;
      console.log(`\n── ${s.key.toUpperCase()}  (${s.waiting} waiting, ` +
                  `${s.cap ? `${s.cap.remaining} of ${s.cap.limit} left` : 'server sends no cap'})`);

      // A FULL RELOAD per scenario, not a client-side nav. page.goto wipes React context state,
      // which is the WRONG thing to do when carrying state between panels — here it is the right
      // thing, because each scenario must start from a mount that has never seen another fixture.
      await page.goto(`${vite.url}/app/auto-apply`, { waitUntil: 'networkidle2', timeout: 60000 });
      await page.waitForFunction(
        () => /waiting for your approval/i.test(document.body.innerText),
        { timeout: 30000 }
      ).catch(async () => {
        const t = await page.evaluate(() => document.body.innerText.slice(0, 600));
        console.log('      [panel body]', JSON.stringify(t));
      });
      await sleep(600);

      const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
      await page.screenshot({ path: path.join(OUT_DIR, `${s.key}.png`), fullPage: true });

      // The card itself must be there in every scenario, or every check below would be vacuous.
      check(`${s.key}: the approval card renders`,
        new RegExp(`${s.waiting} applications? waiting for your approval`, 'i').test(text));

      if (!s.cap) {
        check(`${s.key}: no invented limit`, !/of undefined/i.test(text) && !/NaN/.test(text),
          'an older server must leave the panel silent about a budget it was not told');
        check(`${s.key}: the original sentence survives`,
          /approving submits it to the employer and cannot be undone/i.test(text));
        check(`${s.key}: and it says nothing about approvals left`, !/approvals left today/i.test(text));
        continue;
      }

      if (s.cap.remaining === 0) {
        check(`${s.key}: says the budget is spent`,
          new RegExp(`used all ${s.cap.limit} of today's approvals`, 'i').test(text));
        // ⛔ THE PART THAT MATTERS. A user at the ceiling must be told their queue is KEPT. Without
        // it, "you cannot approve" reads as "these are lost", which is the shape of a silent drop.
        check(`${s.key}: promises the queue is kept`,
          /stay here until the limit resets/i.test(text));
      } else {
        check(`${s.key}: states the remaining budget`,
          new RegExp(`${s.cap.remaining} of ${s.cap.limit} approvals left today`, 'i').test(text));
      }

      if (s.cap.remaining > 0 && s.cap.remaining < s.waiting) {
        check(`${s.key}: warns that fewer are approvable than are waiting`,
          new RegExp(`fewer than the ${s.waiting} waiting`, 'i').test(text),
          'this is the sentence the user needs before selecting all of them');
      }
      if (s.cap.remaining >= s.waiting) {
        check(`${s.key}: does NOT warn when the whole queue is approvable`,
          !/fewer than the/i.test(text),
          'a warning that fires when nothing is wrong is a warning people stop reading');
      }
    }

    check('the panel actually fetched /api/apply/pending', pendingServed >= SCENARIOS.length,
      `${pendingServed} request(s) across ${SCENARIOS.length} loads`);

    if (process.env.AM2_KEEP_OPEN) { console.log('\nAM2_KEEP_OPEN — leaving the browser open.'); await sleep(600000); }
  } finally {
    await browser.close().catch(() => {});
    vite.proc.kill();
  }

  console.log(`\n${failures ? `⛔ ${failures} check(s) FAILED` : '✓ every check passed'}`);
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
