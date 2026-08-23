#!/usr/bin/env node
/**
 * TASKS AB2 / AB3 / AB4 — the Auto Apply panel, REAL-RUN verification by screenshot.
 * ============================================================================================
 * WHY THIS EXISTS
 * AB2, AB3 and AB4 are defects of PRESENTATION — how many cards one application produces, what a
 * row's Open is scoped to, and which section a thing lands in. A node test that reads the JSX as
 * text can prove the source says the right words; it passes happily over a card that renders
 * three times, a popup listing the wrong applications, or a section that never appears. Those are
 * exactly the defects being fixed, so they have to be seen.
 *
 * So this drives THE REAL APP — the real App.jsx, the real router, the real AutoApplyContext, the
 * real AutoApplyPanel — in a real Chrome, and reads the rendered DOM back.
 *
 * WHY THE API IS STUBBED RATHER THAN A REAL SERVER
 * The server writes to data/resume_master.db, whose path is not configurable, and seeding fixtures
 * into a developer's working database to take a screenshot is not a reasonable trade. Every /api/*
 * request is intercepted instead and answered from FIXTURES below. That is honest about what is
 * under test: the pipeline itself is verified against a real browser and a real ATS by
 * scripts/ab1HeldHandoff.mjs; what is under test HERE is what the panel does with a given response.
 *
 * THE FIXTURE IS THE BUG REPORT. `review` contains three run-job rows for ONE OpenAI application
 * with three different reason codes — which is what the server really returns after a job has been
 * held, re-run and held again, and is exactly the shape that produced three cards each claiming
 * "1 APPLICATION".
 *
 * Usage:  node scripts/abPanelUi.mjs            # starts its own vite dev server
 *         AB_KEEP_OPEN=1 node scripts/abPanelUi.mjs   # leave the browser open to poke at
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(os.tmpdir(), 'ab-panel-ui');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────
const now = Date.now();
const ago = (h) => now - h * 3600_000;

/** ONE application, THREE held run-job rows. The AB2 defect, in data. */
const OPENAI_HELD = [
  { id: 903, runId: 9, jobId: 'openai-staff', company: 'OpenAI', title: 'Staff Engineer',
    status: 'held_review', reasonCode: 'captcha_required', reasonDetail: null,
    startedAt: ago(2), finishedAt: ago(2), attemptCount: 1, atsScore: 84,
    resumeAvailable: true, screenshotAvailable: true,
    applyUrl: 'https://boards.greenhouse.io/openai/jobs/900' },
  { id: 902, runId: 8, jobId: 'openai-staff', company: 'OpenAI', title: 'Staff Engineer',
    status: 'held_review', reasonCode: 'manual_review', reasonDetail: null,
    startedAt: ago(20), finishedAt: ago(20), attemptCount: 1, atsScore: 84,
    resumeAvailable: true, screenshotAvailable: true,
    applyUrl: 'https://boards.greenhouse.io/openai/jobs/900' },
  { id: 901, runId: 7, jobId: 'openai-staff', company: 'OpenAI', title: 'Staff Engineer',
    status: 'held_review', reasonCode: null, reasonDetail: null,
    startedAt: ago(30), finishedAt: ago(30), attemptCount: 1, atsScore: null,
    resumeAvailable: false, screenshotAvailable: false, applyUrl: null },
];

/**
 * A second, unrelated application — so "one card" cannot pass by collapsing everything — and TWO
 * PROBLEMS ON ONE JOB (AC2). The modal used to render those as two entries; requirement 1 says it
 * must render one, as the card summary already does. One of the two is `manual_review`, which is
 * the hold the shared question below is the concrete form of.
 */
const ANTHROPIC_HELD = [
  { id: 910, runId: 9, jobId: 'anthropic-re', company: 'Anthropic', title: 'Research Engineer',
    status: 'held_review', reasonCode: 'incomplete_form', reasonDetail: 'Sponsorship question',
    startedAt: ago(1), finishedAt: ago(1), attemptCount: 2, atsScore: 91,
    resumeAvailable: true, screenshotAvailable: true,
    applyUrl: 'https://job-boards.greenhouse.io/anthropic/jobs/910' },
  { id: 911, runId: 8, jobId: 'anthropic-re', company: 'Anthropic', title: 'Research Engineer',
    status: 'held_review', reasonCode: 'manual_review', reasonDetail: null,
    startedAt: ago(26), finishedAt: ago(26), attemptCount: 1, atsScore: 91,
    resumeAvailable: true, screenshotAvailable: true,
    applyUrl: 'https://job-boards.greenhouse.io/anthropic/jobs/910' },
];

/** A held review whose posting the 7-day cleanup removed — AB1 requirement 6, on screen. */
const DEAD_POSTING = [
  { id: 920, runId: 9, jobId: '4369183334', company: null, title: null,
    status: 'held_review', reasonCode: 'no_submit_button', reasonDetail: null,
    startedAt: ago(50), finishedAt: ago(50), attemptCount: 1, atsScore: null,
    resumeAvailable: false, screenshotAvailable: true, applyUrl: null },
];

/**
 * TASK AC1, IN DATA: a held application with NO handoff packet.
 *
 * This shape is the whole reason a green harness sat on top of a live defect. The card's plain
 * "Open" button is rendered by exactly one combination — a packet that does not exist, a posting
 * that is still on the board, and nothing stale — because every other combination renders
 * "Open & fill", "Run it again", or the posting-gone text instead. No fixture had that combination,
 * so the arm that reached the unscoped handler was unreachable from this harness, and the AB3 check
 * clicked DETAILS (which was scoped) rather than OPEN (which was not).
 *
 * Deliberately a company that appears nowhere else in these fixtures, so "the popup shows only this
 * application" cannot pass by accident on a name that is also in another section.
 */
const VERCEL_NO_PACKET = [
  { id: 930, runId: 9, jobId: 'vercel-plat', company: 'Vercel', title: 'Platform Engineer',
    status: 'held_review', reasonCode: 'full_auto_disabled', reasonDetail: null,
    startedAt: ago(3), finishedAt: ago(3), attemptCount: 1, atsScore: 76,
    resumeAvailable: true, screenshotAvailable: true,
    applyUrl: 'https://vercel.com/careers/930' },
];

/** Queued and running. NOT one of the three outcome sections — the fixture proves it survives. */
const IN_FLIGHT = [
  { id: 500, runId: 9, jobId: 'openai-sec', company: 'OpenAI', title: 'Security Engineer',
    status: 'running', reasonCode: null, startedAt: ago(0.1), finishedAt: null, attemptCount: 1,
    resumeAvailable: false, screenshotAvailable: false, applyUrl: null },
  { id: 501, runId: 9, jobId: 'stripe-inf', company: 'Stripe', title: 'Infra Engineer',
    status: 'queued', reasonCode: null, startedAt: null, finishedAt: null, attemptCount: 1,
    resumeAvailable: false, screenshotAvailable: false, applyUrl: null },
];
const SUBMITTED = [
  { id: 800, runId: 6, jobId: 'openai-infra', company: 'OpenAI', title: 'Infrastructure Engineer',
    status: 'submitted', reasonCode: null, startedAt: ago(70), finishedAt: ago(70),
    attemptCount: 1, atsScore: 88, resumeAvailable: true, screenshotAvailable: true,
    submitVerified: true, submitEvidence: 'Thanks for applying', applyUrl: 'https://boards.greenhouse.io/openai/jobs/800' },
  { id: 801, runId: 6, jobId: 'openai-ml', company: 'OpenAI', title: 'ML Engineer',
    status: 'submitted', reasonCode: null, startedAt: ago(71), finishedAt: ago(71),
    attemptCount: 1, atsScore: 79, resumeAvailable: true, screenshotAvailable: true,
    submitVerified: false, submitEvidence: null, applyUrl: 'https://boards.greenhouse.io/openai/jobs/801' },
  { id: 802, runId: 6, jobId: 'stripe-be', company: 'Stripe', title: 'Backend Engineer',
    status: 'submitted', reasonCode: null, startedAt: ago(96), finishedAt: ago(96),
    attemptCount: 1, atsScore: 83, resumeAvailable: true, screenshotAvailable: true,
    submitVerified: true, submitEvidence: 'Application received', applyUrl: 'https://stripe.com/jobs/802' },
];

const STOPPED = [
  { id: 700, runId: 5, jobId: 'figma-fe', company: 'Figma', title: 'Frontend Engineer',
    status: 'failed', reasonCode: 'resume_unavailable', reasonDetail: null,
    startedAt: ago(120), finishedAt: ago(120), attemptCount: 1, atsScore: null,
    resumeAvailable: false, screenshotAvailable: false, applyUrl: 'https://figma.com/jobs/700' },
  { id: 701, runId: 5, jobId: 'figma-be', company: 'Figma', title: 'Backend Engineer',
    status: 'failed', reasonCode: 'browser_binary_not_found', reasonDetail: null,
    startedAt: ago(121), finishedAt: ago(121), attemptCount: 1, atsScore: null,
    resumeAvailable: false, screenshotAvailable: false, applyUrl: 'https://figma.com/jobs/701' },
  { id: 702, runId: 5, jobId: 'notion-fs', company: 'Notion', title: 'Fullstack Engineer',
    status: 'failed', reasonCode: 'internal_error', reasonDetail: 'timeout',
    startedAt: ago(130), finishedAt: ago(130), attemptCount: 3, atsScore: null,
    resumeAvailable: false, screenshotAvailable: false, applyUrl: 'https://notion.so/jobs/702' },
  // NOT a failure — the user rejected it. Terminal, so it belongs in PROBLEMS, but nothing went
  // wrong with it. Without a row like this the "held on purpose" half of the section cannot render,
  // and the distinction the requirement insists on would go unverified.
  { id: 703, runId: 5, jobId: 'notion-des', company: 'Notion', title: 'Design Engineer',
    status: 'rejected', reasonCode: null, reasonDetail: null,
    startedAt: ago(131), finishedAt: ago(131), attemptCount: 1, atsScore: 72,
    resumeAvailable: true, screenshotAvailable: true, applyUrl: 'https://notion.so/jobs/703' },
];

/** SEVEN gated jobs across TWO portals — the amortisation AB4's verify insists must survive. */
const GATED = [];
const GATE_PACKETS = [];
for (let i = 0; i < 4; i++) {
  GATED.push({ id: 600 + i, runId: 4, jobId: `wd${i}`, company: 'Salesforce', title: `Engineer ${i + 1}`,
    status: 'held_gate', reasonCode: 'login_required', startedAt: ago(6), finishedAt: ago(6),
    attemptCount: 1, resumeAvailable: true, screenshotAvailable: false,
    applyUrl: `https://salesforce.wd1.myworkdayjobs.com/apply/${i}` });
  GATE_PACKETS.push({ packetId: 600 + i, jobId: `wd${i}`, runId: 4, runJobId: 600 + i,
    title: `Engineer ${i + 1}`, company: 'Salesforce',
    applyUrl: `https://salesforce.wd1.myworkdayjobs.com/apply/${i}`,
    expectedOrigin: 'https://salesforce.wd1.myworkdayjobs.com', gateReason: 'login_required',
    createdAt: ago(6), kind: 'gate', ageMs: 6 * 3600_000, stale: false,
    staleAfterMs: 259200000, postingGone: false,
    answerCount: 11, unresolvedCount: 2, resumeAvailable: true });
}
for (let i = 0; i < 3; i++) {
  GATED.push({ id: 650 + i, runId: 4, jobId: `gh${i}`, company: 'Datadog', title: `SRE ${i + 1}`,
    status: 'held_gate', reasonCode: 'login_required', startedAt: ago(7), finishedAt: ago(7),
    attemptCount: 1, resumeAvailable: true, screenshotAvailable: false,
    applyUrl: `https://datadog.avature.net/apply/${i}` });
  GATE_PACKETS.push({ packetId: 650 + i, jobId: `gh${i}`, runId: 4, runJobId: 650 + i,
    title: `SRE ${i + 1}`, company: 'Datadog',
    applyUrl: `https://datadog.avature.net/apply/${i}`,
    expectedOrigin: 'https://datadog.avature.net', gateReason: 'login_required',
    createdAt: ago(7), kind: 'gate', ageMs: 7 * 3600_000, stale: false,
    staleAfterMs: 259200000, postingGone: false,
    answerCount: 11, unresolvedCount: 2, resumeAvailable: true });
}

// Per-application review packets, so the held cards can offer AB1's handoff on screen. The OpenAI
// one is fresh; the dead-posting one reports postingGone.
const REVIEW_PACKETS = [
  { packetId: 700, jobId: 'openai-staff', runId: 9, runJobId: 903, title: 'Staff Engineer',
    company: 'OpenAI', applyUrl: 'https://boards.greenhouse.io/openai/jobs/900',
    expectedOrigin: 'https://boards.greenhouse.io', gateReason: 'captcha_required',
    createdAt: ago(2), kind: 'review', ageMs: 2 * 3600_000, stale: false,
    staleAfterMs: 259200000, postingGone: false,
    answerCount: 9, unresolvedCount: 1, resumeAvailable: true },
  { packetId: 701, jobId: 'anthropic-re', runId: 9, runJobId: 910, title: 'Research Engineer',
    company: 'Anthropic', applyUrl: 'https://job-boards.greenhouse.io/anthropic/jobs/910',
    expectedOrigin: 'https://job-boards.greenhouse.io', gateReason: 'incomplete_form',
    createdAt: ago(1), kind: 'review', ageMs: 3600_000, stale: false,
    staleAfterMs: 259200000, postingGone: false,
    answerCount: 10, unresolvedCount: 1, resumeAvailable: true },
  { packetId: 702, jobId: '4369183334', runId: 9, runJobId: 920, title: null, company: null,
    applyUrl: 'https://boards.greenhouse.io/gone/jobs/920',
    expectedOrigin: 'https://boards.greenhouse.io', gateReason: 'no_submit_button',
    createdAt: ago(50), kind: 'review', ageMs: 50 * 3600_000, stale: false,
    staleAfterMs: 259200000, postingGone: true,
    answerCount: 8, unresolvedCount: 0, resumeAvailable: false },
];

const REVIEW = [...ANTHROPIC_HELD, ...OPENAI_HELD, ...DEAD_POSTING, ...VERCEL_NO_PACKET];

const FIXTURES = {
  '/api/auth/me': { authenticated: true, user: { id: 1, username: 'ada', email: 'ada@example.com', planTier: 'PRO' } },
  '/api/apply/runs': {
    runs: [
      { id: 9, status: 'completed', mode: 'auto', startedAt: ago(1), submittedCount: 0, heldCount: 5, failedCount: 0 },
      { id: 6, status: 'completed', mode: 'auto', startedAt: ago(70), submittedCount: 3, heldCount: 0, failedCount: 0 },
      { id: 5, status: 'completed', mode: 'auto', startedAt: ago(120), submittedCount: 0, heldCount: 0, failedCount: 3 },
    ],
    review: REVIEW, gated: GATED, inFlight: IN_FLIGHT, submitted: SUBMITTED, stopped: STOPPED,
    statusCounts: { held_review: REVIEW.length, held_gate: GATED.length, submitted: SUBMITTED.length, failed: STOPPED.length },
  },
  '/api/apply/gate-packets': {
    portals: [
      { origin: 'https://salesforce.wd1.myworkdayjobs.com', host: 'salesforce.wd1.myworkdayjobs.com',
        count: 4, packetIds: [600, 601, 602, 603], oldestAt: ago(6), gateReasons: ['login_required'] },
      { origin: 'https://datadog.avature.net', host: 'datadog.avature.net',
        count: 3, packetIds: [650, 651, 652], oldestAt: ago(7), gateReasons: ['login_required'] },
    ],
    packets: [...GATE_PACKETS, ...REVIEW_PACKETS],
  },
  // A SHARED QUESTION (AC2). Deduplicated across jobs by the server and blocking two different
  // applications, so one answer really does release both. The other genuine co-resolution.
  '/api/apply/questions': {
    questions: [
      { question: 'Are you legally authorised to work in the United States?',
        // buildOpenQuestions emits 'unanswered' or 'low_confidence'. This is the former:
        // the form asked and the resolver would not fill it. QUESTION_REASON_TO_HOLD binds it to
        // the manual_review hold, so that hold is not ALSO listed as a bare category beneath it.
        reason: 'unanswered', eligibility: true, type: 'select',
        options: [{ value: 'Yes' }, { value: 'No' }], proposed: '', answered: false,
        blocking: [
          { jobId: 'anthropic-re', runId: 9, title: 'Research Engineer', company: 'Anthropic' },
          { jobId: 'openai-staff', runId: 9, title: 'Staff Engineer', company: 'OpenAI' },
        ] },
    ],
    eligibilityCount: 1, blockedJobs: 2,
  },
  '/api/apply/pending': { pending: [] },
  '/api/apply/readiness': { available: true, reason: null },
  '/api/integrations/status': { apply: { missing: [] } },
};

/** Anything not named above answers with a benign empty shape rather than a 404 storm. */
const FALLBACK = { ok: true, jobs: [], items: [], results: [], data: [], count: 0, total: 0 };

// ── Vite dev server ──────────────────────────────────────────────────────────────────────────
function startVite() {
  return new Promise((resolve, reject) => {
    // vite's own bin, run under this node. Not `npx`: node on Windows refuses to spawn a .cmd
    // shim without shell:true, and shell:true would mean concatenating arguments into a command
    // line. This needs neither.
    const proc = spawn(process.execPath,
      [path.join(ROOT, 'client', 'node_modules', 'vite', 'bin', 'vite.js'),
       '--port', '5199', '--strictPort'],
      { cwd: path.join(ROOT, 'client'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b) => {
      // Vite colours its banner, so "Local:" and the port are separated by escape codes and a
      // literal /Local:.*5199/ never matches. Strip them before looking.
      out += b.toString().replace(/\[[0-9;]*m/g, '');
      if (/localhost:5199/.test(out)) resolve({ proc, url: 'http://localhost:5199' });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error(`vite did not start:\n${out.slice(-800)}`)), 60000);
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('=== AB2/AB3/AB4 — the Auto Apply panel ===\n');

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error('No Chrome binary.'); process.exit(1); }

  const vite = await startVite();
  console.log(`vite     ${vite.url}\n`);

  const browser = await puppeteer.launch({
    executablePath: resolution.path, headless: 'new', pipe: true,
    args: ['--no-first-run', '--no-default-browser-check'],
    defaultViewport: { width: 1400, height: 1200, deviceScaleFactor: 1 },
  });

  try {
    const page = await browser.newPage();
    page.on('pageerror', e => console.log(`      [page error] ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') console.log(`      [console] ${m.text()}`); });

    // Every /api/* answered from the fixtures. Match on PATHNAME so query strings (the artifact
    // links carry an authContext) do not miss.
    await page.setRequestInterception(true);
    const served = new Set();
    page.on('request', (req) => {
      const url = new URL(req.url(), vite.url);
      if (!url.pathname.startsWith('/api/')) return req.continue();
      served.add(url.pathname);
      const body = FIXTURES[url.pathname] ?? FALLBACK;
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    await page.goto(`${vite.url}/app/auto-apply`, { waitUntil: 'networkidle2', timeout: 60000 });
    // The panel's data arrives over three requests; wait for the section headings rather than a
    // fixed sleep, so a slow machine does not screenshot an empty panel and call it a defect.
    await page.waitForFunction(
      () => /AUTO APPLY/i.test(document.body.innerText) && document.body.innerText.length > 400,
      { timeout: 30000 });
    await sleep(1200);

    check('the panel rendered against the stubbed API',
      served.has('/api/apply/runs') && served.has('/api/apply/gate-packets'),
      [...served].join(' '));

    const text = await page.evaluate(() => document.body.innerText);
    const shot = (name) => page.screenshot({ path: path.join(OUT_DIR, name), fullPage: true });

    await shot('panel.png');
    console.log(`      screenshot: ${path.join(OUT_DIR, 'panel.png')}\n`);

    // ── AB2 ────────────────────────────────────────────────────────────────────────────────
    console.log('── AB2: one card per application ──');
    // Three held rows for one OpenAI application must render as ONE card. Read off the card's own
    // data hook, not an inline-style substring: the assertion has to be able to say WHICH
    // application each card is for, or "one card" passes by finding none at all.
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('[data-rm-card="application"]')].map(el => ({
        company: el.dataset.rmCompany, job: el.dataset.rmJob,
        obstacles: Number(el.dataset.rmObstacles), text: el.innerText,
      })));
    const summary = cards.map(c => `${c.company || c.job}:${c.obstacles}`).join(' ');
    const openai = cards.filter(c => c.job === 'openai-staff');
    check('AB2  three held rows for ONE application render as ONE card',
      openai.length === 1, `${openai.length} cards for openai-staff — all cards: ${summary}`);
    check('AB2  and that card lists all THREE of its blocking reasons',
      openai[0]?.obstacles === 3 && /3 things to resolve/.test(openai[0]?.text || ''),
      `obstacles=${openai[0]?.obstacles}`);
    check('AB2  no card claims to be "1 APPLICATION" beside a single job any more',
      !/\n1\nAPPLICATION\n/.test(text), 'the per-problem count is gone');
    check('AB2  the card names the company AND the role',
      /OpenAI/.test(openai[0]?.text || '') && /Staff Engineer/.test(openai[0]?.text || ''),
      (openai[0]?.text || '').split('\n').slice(0, 2).join(' | '));
    check('AB2  a DIFFERENT application is still its own card',
      cards.some(c => c.job === 'anthropic-re'), summary);
    check('AB2  each held application appears EXACTLY once',
      new Set(cards.map(c => c.job)).size === cards.length, summary);
    check('AB2  the per-portal batch SURVIVES — 4 and 3 across two portals',
      /Sign in to salesforce\.wd1\.myworkdayjobs\.com once/.test(text)
      && /Sign in to datadog\.avature\.net once/.test(text)
      && /4 applications ready/.test(text) && /3 applications ready/.test(text),
      'one action unblocking many is still grouped by obstacle');
    check('AB2  a vanished posting says so instead of offering a broken link',
      /posting gone — cannot be resumed/.test(text));

    // ── AB3 ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── AB3: Open is scoped to the card ──');
    const openedFor = await page.evaluate(() => {
      // Click the OpenAI card's OWN Details button. Which card the click came from is the whole
      // question, so it is selected by job id rather than by position.
      const card = document.querySelector('[data-rm-card="application"][data-rm-job="openai-staff"]');
      const btn = [...(card?.querySelectorAll('button') || [])].find(b => /Details/i.test(b.innerText));
      if (!btn) return { clicked: false };
      btn.click();
      return { clicked: true };
    });
    if (openedFor.clicked) {
      await sleep(700);
      const shown = await page.evaluate(() => {
        const scrim = [...document.querySelectorAll('div')]
          .find(d => (d.getAttribute('style') || '').includes('position:fixed')
                  || (d.style && d.style.position === 'fixed' && d.style.inset === '0px'));
        if (!scrim) return null;
        return {
          text: scrim.innerText,
          // THE APPLICATION ENTRIES, by their own data hook. This used to be a substring search for
          // company names over the whole popup — which stopped being able to tell a leaked
          // application from a legitimately NAMED one the moment AC2 landed: a shared question
          // reports the other applications it blocks ("Blocks: Anthropic, OpenAI"), and that
          // sentence IS the co-resolution being offered, not a scope leak. Counting entries
          // answers the question the check is actually asking.
          entries: [...scrim.querySelectorAll('[data-rm-card="application"]')].map(e => e.dataset.rmJob),
        };
      });
      const modal = shown?.text ?? null;
      check('AB3  Details opened a popup', !!modal, modal ? `${modal.length} chars` : 'no modal');
      check('AB3  the popup shows ONLY that application, not every application',
        !!shown && shown.entries.length === 1 && shown.entries[0] === 'openai-staff',
        `popup lists: ${(shown?.entries || []).join(', ') || 'nothing'}`);
      await shot('scoped-open.png');
      console.log(`      screenshot: ${path.join(OUT_DIR, 'scoped-open.png')}`);
      await page.keyboard.press('Escape').catch(() => {});
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => /^Close$/i.test(b.innerText.trim()));
        if (btn) btn.click();
      });
      await sleep(400);
    } else {
      check('AB3  Details opened a popup', false, 'no Details button on the card');
    }

    // ── AC1 ────────────────────────────────────────────────────────────────────────────────
    //
    // THE ASSERTION THE HALF-FIX NEEDED. AB3's check above clicks DETAILS. Details was scoped; OPEN,
    // on the same card, was not — its handler was the unscoped "everything" entry point, reached
    // through a call-site shape AB3 did not rewrite. So this clicks the control the user clicks, on
    // a card that HAS a plain Open (no packet), and reads back what the popup actually contains.
    console.log('\n── AC1: Open receives and honours a scope ──');

    const vercelBtn = await page.evaluate(() => {
      const card = document.querySelector('[data-rm-card="application"][data-rm-job="vercel-plat"]');
      if (!card) return { found: false };
      return { found: true, btns: [...card.querySelectorAll('button')].map(b => b.innerText.trim()) };
    });
    check('AC1  a packet-less held application renders a plain "Open" (the arm that was unscoped)',
      vercelBtn.found && vercelBtn.btns.includes('Open'),
      vercelBtn.found ? vercelBtn.btns.join(' / ') : 'no Vercel card rendered');

    const readModal = () => page.evaluate(() => {
      const scrim = [...document.querySelectorAll('div')]
        .find(d => d.style && d.style.position === 'fixed' && d.style.inset === '0px');
      return scrim ? scrim.innerText : null;
    });
    const closeModal = async () => {
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => /^Close$/i.test(b.innerText.trim()));
        if (btn) btn.click();
      });
      await sleep(400);
    };

    const openClicked = await page.evaluate(() => {
      const card = document.querySelector('[data-rm-card="application"][data-rm-job="vercel-plat"]');
      const btn = [...(card?.querySelectorAll('button') || [])].find(b => b.innerText.trim() === 'Open');
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (openClicked) {
      await sleep(700);
      const modal = await readModal();
      check('AC1  Open opened the popup', !!modal, modal ? `${modal.length} chars` : 'no modal');
      // The bug report exactly: Open on one card listed three entries across two other jobs, one of
      // them a dead posting. Counted off the entries' own data hook rather than by searching the
      // popup text for company names — a shared question legitimately NAMES the other applications
      // it unblocks, and a text search cannot tell that apart from a scope leak.
      const entries = await page.evaluate(() => {
        const scrim = [...document.querySelectorAll('div')]
          .find(d => d.style && d.style.position === 'fixed' && d.style.inset === '0px');
        return scrim ? [...scrim.querySelectorAll('[data-rm-card="application"]')].map(e => e.dataset.rmJob) : [];
      });
      check("AC1  Open shows ONLY that card's application — no other job, no dead posting",
        entries.length === 1 && entries[0] === 'vercel-plat',
        entries.length === 1 ? 'scoped to Vercel alone' : `listed: ${entries.join(', ') || 'nothing'}`);
      check('AC1  and the popup is TITLED with that application, not "Every application"',
        // Case-insensitive: the title is `text-transform: uppercase`, and innerText returns
        // the RENDERED text — a case-sensitive match reads a string the DOM never has.
        !!modal && /vercel/i.test(modal.split("\n")[0] || "") && !/Every application/i.test(modal),
        (modal || '').split('\n')[0]);
      await shot('ac1-open-scoped.png');
      console.log(`      screenshot: ${path.join(OUT_DIR, 'ac1-open-scoped.png')}`);
      await closeModal();
    } else {
      check('AC1  Open opened the popup', false, 'no plain Open button to click');
    }

    // REVIEW ALL remains the ONE unscoped path, and must still BE unscoped.
    const reviewAllClicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /^Review all /.test(b.innerText.trim()));
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (reviewAllClicked) {
      await sleep(700);
      const modal = await readModal();
      const seen = ['OpenAI', 'Anthropic', 'Vercel'].filter(c => modal && modal.includes(c));
      check('AC1  "Review all" is still the deliberate UNSCOPED path — it shows everything',
        seen.length === 3, `popup mentions: ${seen.join(', ') || 'nothing'}`);
      await shot('ac1-review-all.png');
      console.log(`      screenshot: ${path.join(OUT_DIR, 'ac1-review-all.png')}`);
      await closeModal();
    } else {
      check('AC1  "Review all" is still the deliberate UNSCOPED path', false, 'no Review all control');
    }

    // ── AC2 ────────────────────────────────────────────────────────────────────────────────
    //
    // The modal, restructured: COMPANY → APPLICATION → PROBLEMS, with co-resolvable problems
    // grouped. Read out of the real DOM, because "how many entries does one application produce"
    // is precisely the kind of defect a source-string test passes over.
    console.log('\n── AC2: company → application → problems ──');

    const openAnthropic = await page.evaluate(() => {
      const card = document.querySelector('[data-rm-card="application"][data-rm-job="anthropic-re"]');
      const btn = [...(card?.querySelectorAll('button') || [])].find(b => /Details/i.test(b.innerText));
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (openAnthropic) {
      await sleep(700);
      const m = await page.evaluate(() => {
        const scrim = [...document.querySelectorAll('div')]
          .find(d => d.style && d.style.position === 'fixed' && d.style.inset === '0px');
        if (!scrim) return null;
        return {
          text: scrim.innerText,
          entries: [...scrim.querySelectorAll('[data-rm-card="application"]')].map(el => ({
            job: el.dataset.rmJob,
            groups: el.querySelectorAll('[data-rm-plan="group"]').length,
            singles: el.querySelectorAll('[data-rm-plan="single"]').length,
            unblocks: [...el.querySelectorAll('[data-rm-plan="group"]')].map(g => Number(g.dataset.rmUnblocks)),
            text: el.innerText,
          })),
          companyHeadings: [...scrim.querySelectorAll('span')]
            .map(s => s.innerText.trim())
            .filter(t => /^(ANTHROPIC|OPENAI|VERCEL|POSTING NO LONGER ON THE BOARD)$/i.test(t)),
          attempts: scrim.querySelectorAll('[data-rm-card="attempt"]').length,
        };
      });

      check('AC2  two problems on ONE job render as ONE application entry, not two',
        !!m && m.entries.length === 1 && m.entries[0].job === 'anthropic-re',
        m ? m.entries.map(e => e.job).join(', ') : 'no modal');
      // The grouped item is the shared question: one answer, two applications. The single is
      // incomplete_form, which nothing else shares — so the entry has exactly two items.
      check('AC2  its two problems are listed TOGETHER inside that one entry',
        !!m && (m.entries[0]?.groups + m.entries[0]?.singles) === 2,
        m ? `${m.entries[0]?.groups} grouped + ${m.entries[0]?.singles} single` : 'no modal');
      check('AC2  the co-resolvable one is presented as ONE action with the count it unblocks',
        !!m && m.entries[0]?.groups === 1 && m.entries[0]?.unblocks[0] === 2
          && /one action, 2 applications/i.test(m.entries[0]?.text || ''),
        m ? `unblocks=${m.entries[0]?.unblocks.join(',')}` : 'no modal');
      check('AC2  and it names the shared question rather than the bare category beneath it',
        !!m && /legally authorised to work/i.test(m.entries[0]?.text || '')
          && !/The form asked something only you can answer/i.test(m.entries[0]?.text || ''),
        'the specific statement replaces the category it is the form of');
      check('AC2  a COMPANY tier sits above the application',
        !!m && m.companyHeadings.some(h => /ANTHROPIC/i.test(h)), (m?.companyHeadings || []).join(' / '));
      check('AC2  HELD ON PURPOSE is still distinguished from BROKEN inside the modal',
        !!m && /held on purpose/i.test(m.text), (m?.text || '').split('\n')[1]);
      // Collapsing run-jobs into one application is only honest if the attempts stay reachable.
      check('AC2  the per-attempt detail is not lost — it is one disclosure away',
        !!m && m.attempts === 0 && /show 2 attempts/i.test(m.text),
        (m?.text.match(/Show \d+ attempts?/i) || ['absent'])[0]);

      const attemptsShown = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => /Show \d+ attempts?/i.test(b.innerText));
        if (!btn) return -1;
        btn.click();
        return 1;
      });
      if (attemptsShown === 1) {
        await sleep(400);
        const after = await page.evaluate(() => {
          const scrim = [...document.querySelectorAll('div')]
            .find(d => d.style && d.style.position === 'fixed' && d.style.inset === '0px');
          return {
            attempts: scrim ? scrim.querySelectorAll('[data-rm-card="attempt"]').length : 0,
            text: scrim ? scrim.innerText : '',
          };
        });
        check('AC2  opening it shows every attempt, with its own status and evidence',
          after.attempts === 2 && /Review/.test(after.text) && /What we filled/.test(after.text),
          `${after.attempts} attempt rows`);
      } else {
        check('AC2  opening it shows every attempt', false, 'no attempts disclosure');
      }
      await shot('ac2-application-entry.png');
      console.log(`      screenshot: ${path.join(OUT_DIR, 'ac2-application-entry.png')}`);
      await closeModal();
    } else {
      check('AC2  two problems on ONE job render as ONE application entry, not two', false,
        'no Anthropic card');
    }

    // Requirement 4: a dead posting is its OWN STATE, not a reviewable item with a dead Review
    // button. Reached through Review-all, which is where it used to sit beside unrelated jobs.
    const deadOpened = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /^Review all /.test(b.innerText.trim()));
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (deadOpened) {
      await sleep(700);
      const dead = await page.evaluate(() => {
        const scrim = [...document.querySelectorAll('div')]
          .find(d => d.style && d.style.position === 'fixed' && d.style.inset === '0px');
        const el = scrim?.querySelector('[data-rm-card="application"][data-rm-job="4369183334"]');
        if (!el) return null;
        return {
          text: el.innerText,
          buttons: [...el.querySelectorAll('button')].map(b => b.innerText.trim()),
        };
      });
      check('AC2  the dead posting is its OWN state inside the modal, not a "Review" row',
        !!dead && /the posting is gone/i.test(dead.text)
          && /posting gone — cannot be resumed/i.test(dead.text)
          && !dead.buttons.some(b => /^(Open|Open & fill|Sign in)$/i.test(b)),
        dead ? `buttons: ${dead.buttons.join(' / ') || 'none'}` : 'no dead-posting entry');
      // Requirement 5: nothing was dropped on the way.
      const controls = await page.evaluate(() => {
        const scrim = [...document.querySelectorAll('div')]
          .find(d => d.style && d.style.position === 'fixed' && d.style.inset === '0px');
        return scrim ? scrim.innerText : '';
      });
      check('AC2  every control survives in the modal: resume, evidence, ATS, posting, Open, Details',
        /Resume PDF/.test(controls) && /What we filled/.test(controls) && /ATS \d+/.test(controls)
        && /The posting/.test(controls) && /Open/.test(controls) && /attempts?/i.test(controls),
        'artifact links, score chip, posting link, resolve action and the attempts disclosure');
      await shot('ac2-dead-posting.png');
      console.log(`      screenshot: ${path.join(OUT_DIR, 'ac2-dead-posting.png')}`);
      await closeModal();
    } else {
      check('AC2  the dead posting is its OWN state inside the modal', false, 'no Review all control');
    }

    // ── AB4 ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── AB4: outcome, then company, then application ──');
    const headings = await page.evaluate(() =>
      [...document.querySelectorAll('h3')].map(h => h.innerText.trim()));
    for (const want of ['SUBMITTED', 'NEEDS REVIEW', 'PROBLEMS']) {
      check(`AB4  the "${want}" section is present`,
        headings.some(h => h.toUpperCase().includes(want)), headings.join(' / '));
    }
    // The three sections, in the order they are rendered. NEEDS REVIEW leads because it is the only
    // one where anything is waiting on a human.
    const outcomeOrder = headings.filter(h => /NEEDS REVIEW|SUBMITTED|PROBLEMS/.test(h.toUpperCase()))
      .map(h => h.toUpperCase());
    check('AB4  NEEDS REVIEW leads — the only section where anything waits on a human',
      outcomeOrder[0] === 'NEEDS REVIEW', outcomeOrder.join(' / '));

    // Each section's own count, read from the heading's own row rather than from the whole page.
    const counts = await page.evaluate(() =>
      [...document.querySelectorAll('h3')].map(h => {
        const sib = h.nextElementSibling;
        return { name: h.innerText.trim(), count: sib ? sib.innerText.trim() : null };
      }));
    for (const want of ['NEEDS REVIEW', 'SUBMITTED', 'PROBLEMS']) {
      const row = counts.find(c => c.name.toUpperCase().includes(want));
      check(`AB4  "${want}" carries its own count`, !!row && /^\d+$/.test(row.count || ''),
        `${row?.name} -> ${row?.count}`);
    }

    // ── The COMPANY tier ──
    // Read as a tier: the company headings that appear, and how many roles each claims. A user with
    // two submitted OpenAI roles must see them under ONE OpenAI heading saying "2 roles".
    const companyTier = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        if (el.children.length !== 0) continue;
        const t = (el.textContent || '').trim();
        if (/^\d+ roles$/.test(t)) out.push({
          roles: Number(t.split(' ')[0]),
          company: el.previousElementSibling?.textContent?.trim() || null,
        });
      }
      return out;
    });
    check('AB4  applications are grouped by COMPANY, with the role count on the group',
      companyTier.some(g => g.company === 'OpenAI' && g.roles === 2),
      companyTier.map(g => `${g.company}:${g.roles}`).join(' ') || 'no company tier rendered');
    check('AB4  a company with ONE role is not labelled with a count it does not have',
      !companyTier.some(g => g.roles === 1),
      companyTier.map(g => `${g.company}:${g.roles}`).join(' '));

    // ── Held on purpose vs broke ──
    // Asserted separately, so a fixture missing one kind reports THAT rather than blaming the split.
    // Case-insensitive on purpose: these labels are `text-transform: uppercase`, and innerText
    // returns the RENDERED text — so a case-sensitive match here reads a string the DOM never has.
    check('AB4  PROBLEMS labels what BROKE', /These broke — 3 applications/i.test(text),
      (text.match(/These broke[^\n]*/i) || ['absent'])[0]);
    check('AB4  PROBLEMS labels what was held on purpose, separately',
      /Held on purpose — 1 application\b/i.test(text),
      (text.match(/Held on purpose[^\n]*/i) || ['absent'])[0]);
    check('AB4  and says plainly that nothing went wrong with the held ones',
      /Nothing went wrong with these/.test(text));
    check('AB4  a rejected application is NOT presented as a failure',
      /You rejected this one/.test(text));

    // ── Requirement 5 ──
    const genBtn = await page.evaluate(() =>
      [...document.querySelectorAll('button')].filter(b => /Generate a resume/.test(b.innerText)).length);
    check('AB4  a missing resume is a BUTTON, not the dead "no resume generated" chip',
      genBtn > 0, `${genBtn} Generate-a-resume buttons`);
    check('AB4  and the dead chip is gone from the rows that now have the button',
      !/no resume generated/.test(text));
    // Only where a resume is actually the blocker. Three fixture rows have no resume; only ONE of
    // them stopped because of it. A button beside "the apply browser is not installed on the server"
    // contradicts the sentence directly above it.
    const genRows = await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .filter(b => /Generate a resume/.test(b.innerText))
        .map(b => b.closest('[data-rm-card]')?.innerText || ''));
    check('AB4  the button appears ONLY where a missing resume is the problem',
      genRows.length === 1 && /No resume was generated/.test(genRows[0]),
      genRows.map(r => r.split('\n')[1] || r.slice(0, 40)).join(' | ') || 'none');
    check('AB4  and never beside a problem no resume can fix',
      !genRows.some(r => /apply browser is not installed|something went wrong on our side/i.test(r)),
      `${genRows.length} rows offer it`);

    // ── Requirement 3: what each application row must carry ──
    const submittedRow = await page.evaluate(() => {
      const h = [...document.querySelectorAll('h3')].find(x => /SUBMITTED/i.test(x.innerText));
      let el = h?.parentElement?.nextElementSibling;
      while (el && !/Infrastructure Engineer/.test(el.innerText || '')) el = el.nextElementSibling;
      return el ? el.innerText : null;
    });
    check('AB4  a submitted row carries role, date, the exact resume and the evidence',
      /Infrastructure Engineer/.test(submittedRow || '')
      && /\d{1,2}\/\d{1,2}\/\d{4}/.test(submittedRow || '')
      && /The resume that went out/.test(submittedRow || '')
      && /Screenshot of the form/.test(submittedRow || '')
      && /confirmed by the site|sent, not confirmed/.test(submittedRow || ''),
      (submittedRow || 'row not found').replace(/\n/g, ' | ').slice(0, 150));

    // ── Requirement 4: nothing dropped ──
    check('AB4  nothing was dropped: resume, evidence, ATS chip, apply URL, resolve action',
      /Resume PDF|The resume that went out/.test(text)
      && /What we filled|Screenshot of the form/.test(text)
      && /ATS \d+/.test(text)
      && /The posting ↗/.test(text)
      && /Open & fill/.test(text) && /Retry/.test(text),
      'artifact links, score chip, posting link and resolve actions all present');
    check('AB4  IN FLIGHT survives — it is not an outcome, so it is not a fourth section',
      /IN FLIGHT/i.test(text) && /Security Engineer/.test(text)
      && !outcomeOrder.includes('IN FLIGHT'),
      headings.join(' / '));
    check('AB4  the queue and the run history both survive',
      /RUN HISTORY/i.test(text));
    check('AB4  attempts are still reported on an application',
      /attempts/i.test(text));

    await shot('sections.png');
    console.log(`      screenshot: ${path.join(OUT_DIR, 'sections.png')}`);

    if (process.env.AB_KEEP_OPEN) {
      console.log('\nAB_KEEP_OPEN set — leaving the browser open. Ctrl+C to finish.');
      await new Promise(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
    vite.proc.kill();
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('\nHARNESS FAILED:', e); process.exit(1); });
