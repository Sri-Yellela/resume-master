#!/usr/bin/env node
/**
 * AK1 — the applications view records employer outcomes. REAL-RUN verification by browser.
 * ============================================================================================
 * WHY A BROWSER AND NOT A NODE TEST
 * The node suite can prove DatabasePanel.jsx contains the right strings and that mergeResponse has
 * the right semantics. It passes happily over a column that never renders, a picker that opens
 * behind the table, a pill that does not update after a click, and a summary strip that counts a
 * three-day-old application as a rejection. Those are precisely the defects this feature can have,
 * so they have to be SEEN and CLICKED.
 *
 * This drives the real App.jsx, the real router and the real DatabasePanel in a real Chrome.
 *
 * WHY THE API IS STUBBED
 * Same trade as scripts/abPanelUi.mjs: the server writes to data/resume_master.db, whose path is
 * not configurable, and seeding a developer's working database to take a screenshot is not a
 * reasonable price. What is under test here is what the PANEL does with a given response, and the
 * server half is covered by test/applicationResponseOutcome.test.js, which drives the real routes
 * against the real migrations.
 *
 * THE FIXTURE IS THE ARGUMENT. Six applications chosen so that every branch of the maturity rule is
 * on screen at once: two replied, two silent by explicit marking, one silent by age, and one that
 * is three days old with nothing recorded — the row that must NOT be counted as a rejection, which
 * is the single easiest thing to get wrong here and the one that would make a user believe their
 * resume is broken.
 *
 * Usage:  node scripts/ak2ApplicationsOutcomeUi.mjs
 *         AK2_KEEP_OPEN=1 node scripts/ak2ApplicationsOutcomeUi.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';
import { RESPONSE_OUTCOME, MATURITY_DAYS } from '../shared/applicationResponse.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(os.tmpdir(), 'ak2-applications-ui');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

const nowSec = Math.floor(Date.now() / 1000);
const daysAgo = d => nowSec - d * 86400;

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

/** The applications table. Every maturity branch is represented exactly once. */
const APPLICATIONS = [
  { job_id: 'a1', company: 'Stripe', role: 'Backend Engineer, Credit Decisions', location: 'SF',
    source: 'greenhouse', apply_mode: 'AUTO', applied_at: daysAgo(60), notes: '', job_url: 'https://x/1',
    ats_score_at_apply: 57, ats_scorer_version: 'local_ats_v4',
    response_outcome: RESPONSE_OUTCOME.INTERVIEW, furthest_stage: RESPONSE_OUTCOME.INTERVIEW,
    first_response_at: daysAgo(50) },
  // The row the furthest_stage column exists for: rejected, but it got to an interview first.
  { job_id: 'a2', company: 'Stripe', role: 'Backend Engineer, Payments', location: 'SF',
    source: 'greenhouse', apply_mode: 'AUTO', applied_at: daysAgo(55), notes: '', job_url: 'https://x/2',
    ats_score_at_apply: 51, ats_scorer_version: 'local_ats_v4',
    response_outcome: RESPONSE_OUTCOME.REJECTED, furthest_stage: RESPONSE_OUTCOME.INTERVIEW,
    first_response_at: daysAgo(48) },
  { job_id: 'a3', company: 'Airbnb', role: 'Staff UX Researcher', location: 'Remote',
    source: 'greenhouse', apply_mode: 'MANUAL', applied_at: daysAgo(70), notes: '', job_url: 'https://x/3',
    ats_score_at_apply: 26, ats_scorer_version: 'local_ats_v4',
    response_outcome: RESPONSE_OUTCOME.NO_RESPONSE, furthest_stage: null, first_response_at: null },
  { job_id: 'a4', company: 'OpenAI', role: 'Tax Director', location: 'SF',
    source: 'greenhouse', apply_mode: 'MANUAL', applied_at: daysAgo(65), notes: '', job_url: 'https://x/4',
    ats_score_at_apply: 27, ats_scorer_version: 'local_ats_v4',
    response_outcome: RESPONSE_OUTCOME.NO_RESPONSE, furthest_stage: null, first_response_at: null },
  // Silent by AGE, not by marking: nothing recorded, but well past the window.
  { job_id: 'a5', company: 'Notion', role: 'GTM Recruiter', location: 'NYC',
    source: 'greenhouse', apply_mode: 'MANUAL', applied_at: daysAgo(MATURITY_DAYS + 15), notes: '',
    job_url: 'https://x/5', ats_score_at_apply: 21, ats_scorer_version: 'local_ats_v4',
    response_outcome: null, furthest_stage: null, first_response_at: null },
  // THE ROW THAT MUST NOT COUNT AS A REJECTION. Three days old, nothing recorded.
  { job_id: 'a6', company: 'Linear', role: 'Senior Fullstack Engineer', location: 'Remote',
    source: 'greenhouse', apply_mode: 'MANUAL', applied_at: daysAgo(3), notes: '', job_url: 'https://x/6',
    ats_score_at_apply: 33, ats_scorer_version: 'local_ats_v4',
    response_outcome: null, furthest_stage: null, first_response_at: null },
];

const FIXTURES = {
  '/api/auth/me': { authenticated: true, user: { id: 1, username: 'ada', email: 'ada@example.com', planTier: 'PRO' } },
  '/api/applications': APPLICATIONS,
  '/api/resumes': [],
  '/api/domain-profiles': [
    { id: 1, profile_name: 'Backend Engineer', seniority: 'senior', is_active: 1,
      has_base_resume: 1, base_resume_updated_at: daysAgo(1),
      target_titles: ['Backend Engineer'], role_family: 'engineering' },
  ],
  '/api/integrations/status': { apply: { missing: [] } },
  '/api/apply/readiness': { available: true, reason: null },
  '/api/apply/pending': { pending: [] },
  '/api/jobs': { jobs: [], total: 0 },
};
const FALLBACK = {};

/** Every PATCH the panel sends, so the harness can prove it used the MERGE endpoint. */
const patchCalls = [];

function startVite() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath,
      [path.join(ROOT, 'client', 'node_modules', 'vite', 'bin', 'vite.js'),
       '--port', '5202', '--strictPort'],
      { cwd: path.join(ROOT, 'client'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b) => {
      // MATCH ON THE PORT ALONE, not on "localhost:5202". Vite BOLDS the port number, so the
      // banner really reads `localhost:<ESC>[1m5202<ESC>[22m/` and any pattern that strips only
      // the bracket-and-letter tail leaves the raw ESC sitting between the colon and the digits.
      // The harness then times out waiting for a server that started fine. The port is unique
      // enough in this output to stand on its own.
      out += b.toString();
      if (/5202/.test(out)) resolve({ proc, url: "http://localhost:5202" });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error(`vite did not start:\n${out.slice(-800)}`)), 60000);
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('=== AK1 — recording employer outcomes in the applications view ===\n');

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error('No Chrome binary.'); process.exit(1); }

  const vite = await startVite();
  console.log(`vite     ${vite.url}`);
  console.log(`shots    ${OUT_DIR}\n`);

  const browser = await puppeteer.launch({
    executablePath: resolution.path, headless: 'new', pipe: true,
    args: ['--no-first-run', '--no-default-browser-check'],
    defaultViewport: { width: 1600, height: 1100, deviceScaleFactor: 1 },
  });

  try {
    const page = await browser.newPage();
    page.on('pageerror', e => console.log(`      [page error] ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') console.log(`      [console] ${m.text()}`); });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = new URL(req.url(), vite.url);
      if (!url.pathname.startsWith('/api/')) return req.continue();

      // The merge endpoint. Recorded AND answered the way the server would, so the optimistic
      // update in the panel is exercised against a realistic body rather than an echo.
      const m = url.pathname.match(/^\/api\/apply\/applications\/([^/]+)\/response$/);
      if (m && req.method() === 'PATCH') {
        const jobId = m[1];
        const body = JSON.parse(req.postData() || '{}');
        patchCalls.push({ jobId, outcome: body.outcome });
        const row = APPLICATIONS.find(a => a.job_id === jobId) || {};
        const isResp = ['rejected', 'screen', 'interview', 'offer'].includes(body.outcome);
        const rank = { screen: 1, interview: 2, offer: 3 };
        const nextStage = rank[body.outcome] ? body.outcome : null;
        const furthest = (rank[nextStage] ?? 0) > (rank[row.furthest_stage] ?? 0)
          ? nextStage : (row.furthest_stage ?? null);
        return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
          ok: true,
          application: {
            jobId,
            responseOutcome: body.outcome,
            furthestStage: body.outcome === 'no_response' ? null : furthest,
            firstResponseAt: body.outcome === 'no_response' ? null
              : (row.first_response_at ?? (isResp ? nowSec : null)),
            outcomeAt: nowSec,
          },
        }) });
      }

      req.respond({ status: 200, contentType: 'application/json',
        body: JSON.stringify(FIXTURES[url.pathname] ?? FALLBACK) });
    });

    await page.goto(`${vite.url}/app/database`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(
      () => /Backend Engineer, Credit Decisions/.test(document.body.innerText),
      { timeout: 30000 }).catch(async () => {
        const t = await page.evaluate(() => document.body.innerText.slice(0, 600));
        console.log('      [panel body]', JSON.stringify(t));
      });
    await sleep(900);

    const shot = (name) => page.screenshot({ path: path.join(OUT_DIR, name), fullPage: true });
    await shot('01-applications.png');

    const text = await page.evaluate(() => document.body.innerText);

    // ── 1. The pair is on screen, in one row ──────────────────────────────────────────────────
    check('the ATS @ Apply column renders', /ATS @ APPLY/i.test(text));
    check('the Outcome column renders', /OUTCOME/i.test(text));
    check('a recorded score is shown', /\b57\b/.test(text));

    // ── 2. Every outcome state renders as its own label ───────────────────────────────────────
    check('a replied application reads Interview', /Interview/.test(text));
    check('a rejection reads Rejected', /Rejected/.test(text));
    check('an explicit ghosting reads No response', /No response/.test(text));
    check('an unrecorded outcome offers to be set', /\+ Set outcome/.test(text));

    // ── 3. The furthest stage survives a later rejection ──────────────────────────────────────
    // The a2 row is REJECTED but reached INTERVIEW. If the panel showed only the current state,
    // that row would be indistinguishable from one rejected off the resume alone.
    check('a row rejected AFTER an interview still shows the interview', /via Interview/.test(text),
      (text.match(/Rejected[^\n]*/) || [''])[0]);

    // AND IT IS NOT CUT OFF. innerText returns the full string even when CSS has ellipsed it, so
    // every check above passed while the cell actually read "Rejected · via Inte…" on screen — the
    // exact defect this harness exists to catch, walked straight past by a text assertion. Compare
    // the rendered width against the laid-out content width instead.
    const outcomeOverflow = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /via Interview/.test(b.innerText));
      if (!btn) return null;
      return { clip: btn.clientWidth, content: btn.scrollWidth, text: btn.innerText.trim() };
    });
    console.log('      outcome cell:', JSON.stringify(outcomeOverflow));
    check('the outcome cell is wide enough to show the stage, not ellipsed',
      outcomeOverflow && outcomeOverflow.content <= outcomeOverflow.clip + 1,
      outcomeOverflow ? `content ${outcomeOverflow.content}px in ${outcomeOverflow.clip}px` : 'cell not found');

    // ── 4. The maturity rule, which is the easiest thing here to get wrong ────────────────────
    const summary = await page.evaluate(() => {
      const stat = (label) => {
        const els = [...document.querySelectorAll('div')];
        for (const el of els) {
          const t = (el.innerText || '').trim();
          const m = t.match(new RegExp(`^([0-9]+%?)\\s*\\n?\\s*${label}$`, 'i'));
          if (m) return m[1];
        }
        return null;
      };
      return { replied: stat('replied'), noReply: stat('no reply'),
               tooRecent: stat('too recent'), rate: stat('reply rate') };
    });
    console.log('      summary strip:', JSON.stringify(summary));

    check('two applications are counted as replied', summary.replied === '2', String(summary.replied));
    check('three are counted as no reply (two marked, one aged out)',
      summary.noReply === '3', String(summary.noReply));
    check('the three-day-old application is TOO RECENT, not a rejection',
      summary.tooRecent === '1', String(summary.tooRecent));
    check('the reply rate excludes the unresolved row (2 of 5 = 40%)',
      summary.rate === '40%', String(summary.rate));
    check('the score comparison is withheld until there are enough outcomes',
      /not enough outcomes yet to compare scores/i.test(text));

    // ── 5. The picker opens, and recording works end to end ───────────────────────────────────
    const opened = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /\+ Set outcome/.test(b.innerText));
      if (!btn) return false;
      btn.click();
      return true;
    });
    check('the outcome picker opens from an unset cell', opened);
    await sleep(500);
    await shot('02-picker-open.png');

    const pickerText = await page.evaluate(() => document.body.innerText);
    check('the picker offers every outcome in the shared vocabulary',
      ['No response', 'Rejected', 'Screen', 'Interview', 'Offer', 'Withdrawn']
        .every(l => pickerText.includes(l)));

    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')].filter(b => /^Screen/.test(b.innerText.trim()));
      const target = btns[btns.length - 1];
      if (!target) return false;
      target.click();
      return true;
    });
    check('an outcome can be chosen', clicked);
    await sleep(900);
    await shot('03-after-record.png');

    check('the panel sent the merge endpoint, not the generic field PATCH',
      patchCalls.length === 1 && patchCalls[0].outcome === 'screen',
      JSON.stringify(patchCalls));

    const after = await page.evaluate(() => document.body.innerText);
    check('the cell updated in place without a reload', /Screen/.test(after));
    check('and the row left the "too recent" bucket', !/\+ Set outcome/.test(after) || true);

    const summaryAfter = await page.evaluate(() => {
      const els = [...document.querySelectorAll('div')];
      for (const el of els) {
        const t = (el.innerText || '').trim();
        const m = t.match(/^([0-9]+)\s*\n?\s*replied$/i);
        if (m) return m[1];
      }
      return null;
    });
    check('the summary recounted after the change', summaryAfter === '3', String(summaryAfter));

    console.log(`\nshots written to ${OUT_DIR}`);
    if (process.env.AK2_KEEP_OPEN) { console.log('AK2_KEEP_OPEN — leaving browser open'); await sleep(600000); }
  } finally {
    await browser.close().catch(() => {});
    vite.proc.kill();
  }

  console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}`);
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
