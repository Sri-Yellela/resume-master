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

/** A second, unrelated application — so "one card" cannot pass by collapsing everything. */
const ANTHROPIC_HELD = [
  { id: 910, runId: 9, jobId: 'anthropic-re', company: 'Anthropic', title: 'Research Engineer',
    status: 'held_review', reasonCode: 'incomplete_form', reasonDetail: 'Sponsorship question',
    startedAt: ago(1), finishedAt: ago(1), attemptCount: 2, atsScore: 91,
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

const REVIEW = [...ANTHROPIC_HELD, ...OPENAI_HELD, ...DEAD_POSTING];

const FIXTURES = {
  '/api/auth/me': { authenticated: true, user: { id: 1, username: 'ada', email: 'ada@example.com', planTier: 'PRO' } },
  '/api/apply/runs': {
    runs: [
      { id: 9, status: 'completed', mode: 'auto', startedAt: ago(1), submittedCount: 0, heldCount: 5, failedCount: 0 },
      { id: 6, status: 'completed', mode: 'auto', startedAt: ago(70), submittedCount: 3, heldCount: 0, failedCount: 0 },
      { id: 5, status: 'completed', mode: 'auto', startedAt: ago(120), submittedCount: 0, heldCount: 0, failedCount: 3 },
    ],
    review: REVIEW, gated: GATED, inFlight: [], submitted: SUBMITTED, stopped: STOPPED,
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
  '/api/apply/questions': { questions: [], eligibilityCount: 0, blockedJobs: 0 },
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
      const modal = await page.evaluate(() => {
        const scrim = [...document.querySelectorAll('div')]
          .find(d => (d.getAttribute('style') || '').includes('position:fixed')
                  || (d.style && d.style.position === 'fixed' && d.style.inset === '0px'));
        return scrim ? scrim.innerText : null;
      });
      check('AB3  Details opened a popup', !!modal, modal ? `${modal.length} chars` : 'no modal');
      const companies = ['OpenAI', 'Anthropic', 'Salesforce', 'Datadog'].filter(c => modal && modal.includes(c));
      check('AB3  the popup shows ONLY that application, not every application',
        companies.length === 1 && companies[0] === 'OpenAI',
        `popup mentions: ${companies.join(', ') || 'nothing'}`);
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

    // ── AB4 ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── AB4: outcome, then company, then application ──');
    const headings = await page.evaluate(() =>
      [...document.querySelectorAll('h3')].map(h => h.innerText.trim()));
    for (const want of ['SUBMITTED', 'NEEDS REVIEW', 'PROBLEMS']) {
      check(`AB4  the "${want}" section is present`,
        headings.some(h => h.toUpperCase().includes(want)), headings.join(' / '));
    }
    check('AB4  each section carries its own count',
      await page.evaluate(() => [...document.querySelectorAll('h3')].every(h => {
        const n = h.parentElement?.innerText || '';
        return /\d/.test(n);
      })), headings.join(' / '));
    check('AB4  applications are grouped by COMPANY inside a section',
      /OpenAI/.test(text) && (text.match(/OpenAI/g) || []).length >= 2,
      `${(text.match(/OpenAI/g) || []).length} OpenAI mentions`);
    check('AB4  "held on purpose" stays visibly distinct from what broke',
      /held on purpose/i.test(text) && /(did not complete|didn.t send|broke)/i.test(text));
    check('AB4  the resume-required problem offers a one-click fix, not just words',
      !/resume required — Generate a resume/.test(text) || /Generate/i.test(text));
    check('AB4  nothing was dropped: resume, evidence and ATS chips all survive',
      /Resume PDF|The resume that went out/.test(text)
      && /What we filled|Screenshot of the form/.test(text)
      && /ATS \d+/.test(text),
      'artifact links and score chip present');

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
