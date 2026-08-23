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
  // AC3 reads the ManageJobProfiles card idiom and reuses its primitive. These fixtures let the
  // harness screenshot THAT panel before and after the extraction, so "reuse, do not clone" can be
  // held to the standard the task sets: the profile cards must look and behave identically.
  // The Database panel is driven too, for AC4's "the Database calendar must be unchanged for its
  // own use" regression. Both of these return ARRAYS from the real server; the generic FALLBACK
  // object hangs the panel's render, which is a fixture problem rather than a defect — but a
  // hung page is indistinguishable from a broken one, so it gets the real shape.
  '/api/applications': [
    { job_id: 'gh1', company: 'OpenAI', role: 'Staff Engineer', location: 'SF', source: 'greenhouse',
      apply_mode: 'AUTO', applied_at: Math.floor(now / 1000) - 86400, notes: '', job_url: 'https://x/1',
      auto_status: 'submitted' },
    { job_id: 'gh2', company: 'Stripe', role: 'Infra Engineer', location: 'NYC', source: 'greenhouse',
      apply_mode: 'MANUAL', applied_at: null, notes: '', job_url: 'https://x/2', auto_status: 'manual' },
  ],
  '/api/resumes': [],
  '/api/domain-profiles': [
    { id: 1, profile_name: 'Backend Engineer', seniority: 'senior', is_active: 1,
      has_base_resume: 1, base_resume_updated_at: Math.floor(now / 1000) - 86400,
      target_titles: ['Staff Engineer', 'Backend Engineer', 'Platform Engineer'], role_family: 'engineering' },
    { id: 2, profile_name: 'Data Platform', seniority: 'mid', is_active: 0,
      has_base_resume: 0, base_resume_updated_at: null,
      target_titles: ['Data Engineer'], role_family: 'data' },
    { id: 3, profile_name: 'ML Research', seniority: 'senior', is_active: 0,
      has_base_resume: 1, base_resume_updated_at: Math.floor(now / 1000) - 172800,
      // No titles AND no role family, so the card's empty body state renders — the branch that
      // would otherwise go unverified on both sides of the extraction.
      target_titles: [], role_family: null },
  ],
};

// ── AC4: the dated run history ───────────────────────────────────────────────────────────────
//
// Two days in the CURRENT month, because the picker opens on today. One has activity across all
// three outcome groups; the other has none, which is requirement 6's normal-not-an-error state.
const dayIso = (d) => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), d).toISOString().slice(0, 10);
};
const HISTORY_DAY = dayIso(10);
const EMPTY_DAY   = dayIso(11);

/** The mapping, in data: one of each kind, including the DEAD POSTING that makes a pending row aborted. */
const HISTORY_PAYLOAD = {
  date: HISTORY_DAY,
  total: 6,
  completed: [{ ...SUBMITTED[0], abortable: false, postingGone: false }],
  pending: [
    { ...IN_FLIGHT[0], abortable: true, postingGone: false },
    { ...ANTHROPIC_HELD[0], abortable: true, postingGone: false },
  ],
  aborted: [
    { ...STOPPED[0], abortable: false, postingGone: false },
    // status 'dismissed' with reason_code 'rejected' is what POST /api/apply/reject actually
    // writes. The old fixture used 'rejected' as a STATUS, which the server never writes — which
    // is how the vocabulary gap in BY_STATUS went unnoticed until AC4's mapping forced it out.
    { ...STOPPED[3], status: 'dismissed', reasonCode: 'rejected', abortable: false, postingGone: false },
    { ...DEAD_POSTING[0], status: 'held_review', abortable: false, postingGone: true },
  ],
};

/** Requirement 7: which days are dotted. Same month the picker opens on. */
const HISTORY_MONTHS = { days: { [HISTORY_DAY]: 6, [dayIso(3)]: 2 } };

/** Every request the page made for history, so requirement 2 can be checked on the NETWORK. */
const historyRequests = [];
const abortCalls = [];
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
      // The history paths are answered dynamically — the whole point of AC4 is WHICH date was
      // asked for and WHEN, so the query string is recorded rather than discarded.
      if (url.pathname === '/api/apply/history') {
        historyRequests.push(url.pathname + url.search);
        const asked = url.searchParams.get('date');
        const body = asked === HISTORY_DAY
          ? HISTORY_PAYLOAD
          : { date: asked, total: 0, completed: [], pending: [], aborted: [] };
        return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      }
      if (url.pathname.startsWith('/api/apply/history/months')) {
        historyRequests.push(url.pathname + url.search);
        return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(HISTORY_MONTHS) });
      }
      if (/\/api\/apply\/run-jobs\/\d+\/abort$/.test(url.pathname)) {
        abortCalls.push(url.pathname);
        return req.respond({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ ok: true, status: 'cancelled', packetsVoided: 1 }) });
      }
      const body = FIXTURES[url.pathname] ?? FALLBACK;
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    await page.goto(`${vite.url}/app/auto-apply`, { waitUntil: 'networkidle2', timeout: 60000 });
    // The panel's data arrives over three requests; wait for the section headings rather than a
    // fixed sleep, so a slow machine does not screenshot an empty panel and call it a defect.
    await page.waitForFunction(
      () => /AUTO APPLY/i.test(document.body.innerText) && document.body.innerText.length > 400,
      { timeout: 30000 }).catch(async () => {
        const t = await page.evaluate(() => document.body.innerText.slice(0, 500));
        console.log("      [db panel body]", JSON.stringify(t));
      });
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
    // AC3 compacted the panel's application rows into company tiles: the COUNT of problems stays on
    // the row (it is what a user triages on) and the problem SENTENCES moved into the modal, which
    // AC2 restructured for exactly that. So the count is checked here and the sentences are checked
    // where they now live — see the AC2 block below, which opens the modal and reads them back.
    check('AB2  and that card reports all THREE of its blocking reasons',
      openai[0]?.obstacles === 3 && /3 to resolve/.test(openai[0]?.text || ''),
      `obstacles=${openai[0]?.obstacles}, row says "${(openai[0]?.text || '').match(/\d+ to resolve/)?.[0]}"`);
    check('AB2  no card claims to be "1 APPLICATION" beside a single job any more',
      !/\n1\nAPPLICATION\n/.test(text), 'the per-problem count is gone');
    // The COMPANY is on the tile and the ROLE is on the row inside it — that is the tier AC3 builds.
    // Read as a pair rather than off one element, or this stops covering anything the moment the
    // hierarchy changes shape again.
    const openaiTileText = await page.evaluate(() => {
      const row = document.querySelector('[data-rm-card="application"][data-rm-job="openai-staff"]');
      return row?.closest('[data-rm-tile="company"]')?.innerText || null;
    });
    check('AB2  the application is named by company AND role',
      /OpenAI/.test(openaiTileText || '') && /Staff Engineer/.test(openai[0]?.text || ''),
      `tile: ${(openaiTileText || 'none').split('\n')[0]} | row: ${(openai[0]?.text || '').split('\n')[0]}`);
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
    // Read as a tier: which companies appear, and how many applications each claims. A user with two
    // submitted OpenAI roles must see them in ONE OpenAI group that says so.
    //
    // AC3 made the group a TILE rather than a heading followed by full-width rows, so this reads the
    // tile's own count instead of hunting for a loose "N roles" text node. It is the same question —
    // is the grouping real, and does it state its size — asked of the element that now answers it.
    // Counting the application rows INSIDE each tile also makes the claim self-checking: a tile that
    // says 2 and contains 3 fails, where a text-node search could not have noticed.
    const companyTier = await page.evaluate(() =>
      [...document.querySelectorAll('[data-rm-tile="company"]')].map(t => ({
        company: t.dataset.rmCompany || null,
        section: t.dataset.rmSection,
        claims: Number(t.dataset.rmApps),
        contains: t.querySelectorAll('[data-rm-card]').length,
        text: t.innerText,
      })));
    const openaiSubmitted = companyTier.find(g => g.company === 'OpenAI' && g.section === 'submitted');
    check('AB4  applications are grouped by COMPANY, with the count on the group',
      !!openaiSubmitted && openaiSubmitted.claims === 2 && /2 applications/.test(openaiSubmitted.text),
      companyTier.map(g => `${g.company || '(none)'}/${g.section}:${g.claims}`).join(' ') || 'no company tier rendered');
    check('AB4  and a group\'s count matches what it actually contains',
      companyTier.every(g => g.claims === g.contains),
      companyTier.filter(g => g.claims !== g.contains)
        .map(g => `${g.company} claims ${g.claims} contains ${g.contains}`).join('; ') || 'every tile is honest');

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

    // ── AC3 ────────────────────────────────────────────────────────────────────────────────
    //
    // Company cards in the ManageJobProfiles idiom, and the PROOF THAT THE IDIOM WAS REUSED rather
    // than cloned: the Job Profiles panel is driven here too, so its cards can be shown to look and
    // behave exactly as they did before the primitive was lifted out of it. A "reuse" that quietly
    // restyles the panel it was taken from is a clone with extra steps.
    console.log('\n── AC3: company cards in the Job Profiles idiom ──');

    await page.goto(`${vite.url}/app/job-profiles`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => /Manage Job Profiles/i.test(document.body.innerText), { timeout: 30000 });
    await sleep(800);
    const profiles = await page.evaluate(() => {
      const titles = [...document.querySelectorAll('div')]
        .filter(d => d.children.length === 0 && /^(Backend Engineer|Data Platform|ML Research)$/.test(d.textContent.trim()));
      const cards = titles.map(t => t.closest('[data-rm-tile], div[style*="border-radius: 16px"]'));
      return {
        names: titles.map(t => t.textContent.trim()),
        // Two cards on the same visual ROW share a top edge. That is what "side by side" means.
        rows: [...new Set(cards.map(c => c ? Math.round(c.getBoundingClientRect().top) : -1))].length,
        controls: [...document.querySelectorAll('button, label')].map(b => b.innerText.trim()).filter(Boolean),
        text: document.body.innerText,
      };
    });
    check('AC3  the Job Profiles panel still renders all three profile cards',
      profiles.names.length === 3, profiles.names.join(' / '));
    check('AC3  its cards still sit side by side, and its controls are unchanged',
      profiles.rows === 1
      // Case-insensitive: these controls are  and innerText returns
      // the RENDERED text, so a case-sensitive match reads a string the DOM never has.
      && ['Edit', 'Switch', 'Delete', 'Active', 'Upload', 'Replace', 'Add Profile']
           .every(c => profiles.controls.some(x => x.toUpperCase().includes(c.toUpperCase()))),
      profiles.controls.join(' / '));
    check('AC3  and every piece of its card content survives',
      /Base Resume/i.test(profiles.text) && /resume linked/i.test(profiles.text)
      && /resume missing/i.test(profiles.text) && /No target titles yet/i.test(profiles.text)
      && /Required before search, ATS, and enhancement/i.test(profiles.text),
      'title, status pill, metadata line, inset sub-block and footer row all present');
    await shot('ac3-job-profiles.png');
    console.log(`      screenshot: ${path.join(OUT_DIR, 'ac3-job-profiles.png')}`);

    // Back to the panel under test.
    await page.goto(`${vite.url}/app/auto-apply`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => /AUTO APPLY/i.test(document.body.innerText), { timeout: 30000 });
    await sleep(1000);

    const companyTiles = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll('[data-rm-tile="company"]')];
      return tiles.map(t => ({
        company: t.dataset.rmCompany,
        section: t.dataset.rmSection,
        apps: Number(t.dataset.rmApps),
        top: Math.round(t.getBoundingClientRect().top),
        left: Math.round(t.getBoundingClientRect().left),
        width: Math.round(t.getBoundingClientRect().width),
        text: t.innerText,
      }));
    });
    check('AC3  the company grouping renders as company TILES',
      companyTiles.length > 0, `${companyTiles.length} tiles`);
    // Requirement 3: side by side at desktop width. Two tiles sharing a top edge is the test; a
    // stacked layout gives every tile its own row and would fail it.
    const held = companyTiles.filter(t => t.section === 'needsReview');
    const sameRow = held.filter(t => held.some(o => o !== t && o.top === t.top));
    check('AC3  multiple company cards sit SIDE BY SIDE at desktop width',
      sameRow.length >= 2 && held.every(t => t.width < 700),
      held.map(t => `${t.company}@${t.left}x${t.top}:${t.width}`).join(' '));
    // Requirement 2: name, count, a compact list of its applications, a footer action row.
    const openaiTile = companyTiles.find(t => t.company === 'OpenAI' && t.section === 'needsReview');
    check('AC3  a tile names the company and counts the applications needing action',
      !!openaiTile && /OpenAI/.test(openaiTile.text) && /1 application/.test(openaiTile.text),
      (openai?.text || 'no OpenAI tile').split('\n').slice(0, 3).join(' | '));
    check('AC3  and lists its applications compactly — role plus count to resolve',
      !!openaiTile && /Staff Engineer/.test(openaiTile.text) && /3 to resolve/.test(openaiTile.text),
      (openai?.text || '').replace(/\n/g, ' | ').slice(0, 140));
    // Requirement 4: triage without opening anything.
    check('AC3  HELD ON PURPOSE vs a problem is visible at CARD level, without opening anything',
      companyTiles.some(t => /held on purpose/i.test(t.text))
      && companyTiles.some(t => /did not complete|broke/i.test(t.text)),
      'both states are readable on the tiles themselves');
    // Requirement 2's footer action row, asserted on the tiles the requirement is about — the ones
    // counting "applications needing action". A submitted tile and a broke tile carry their actions
    // per row (the evidence links, Retry) because there is no honest company-level action for them:
    // "retry all of Figma" is a capability this task did not ask for and would be inventing.
    check('AC3  every NEEDS-REVIEW tile has a footer action row scoped to that company',
      held.length > 0 && held.every(t => /Review all \d+ →/.test(t.text)),
      held.map(t => (t.text.match(/Review all \d+ →/) || ['none'])[0]).join(' / '));
    check('AC3  a tile whose postings were all cleaned up says THAT, not "held on purpose"',
      companyTiles.some(t => t.company === '' && /posting gone/i.test(t.text)
                          && !/held on purpose/i.test(t.text.split('\n')[1] || '')),
      (companyTiles.find(t => t.company === '')?.text || 'no such tile').split('\n').slice(0, 2).join(' | '));
    await shot('ac3-company-tiles.png');
    console.log(`      screenshot: ${path.join(OUT_DIR, 'ac3-company-tiles.png')}`);

    // Requirement 3, the other half: STACK at narrow widths.
    await page.setViewport({ width: 560, height: 1200, deviceScaleFactor: 1 });
    await sleep(600);
    const narrow = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll('[data-rm-tile="company"]')]
        .filter(t => t.dataset.rmSection === 'needsReview');
      return tiles.map(t => Math.round(t.getBoundingClientRect().top));
    });
    check('AC3  and they STACK at narrow widths — one per row',
      narrow.length >= 2 && new Set(narrow).size === narrow.length,
      `${narrow.length} tiles on ${new Set(narrow).size} rows`);
    await shot('ac3-company-tiles-narrow.png');
    console.log(`      screenshot: ${path.join(OUT_DIR, 'ac3-company-tiles-narrow.png')}`);
    await page.setViewport({ width: 1400, height: 1200, deviceScaleFactor: 1 });
    await sleep(600);

    // ── AC4 ────────────────────────────────────────────────────────────────────────────────
    //
    // The dated run history. The first check is the one the requirement is most explicit about, and
    // it is a NETWORK check rather than a DOM one: "ON DEMAND, NOT PRELOADED — this is explicit.
    // Nothing loads until a date is selected. The panel's initial render issues no history query."
    // The only honest way to verify that is to watch what the page asked for.
    console.log('\n── AC4: run history, date-driven and on demand ──');

    check('AC4  the panel\'s initial render issues NO history request',
      ![...served].some(p => p.startsWith('/api/apply/history')),
      `history paths requested on load: ${[...served].filter(p => p.startsWith('/api/apply/history')).join(', ') || 'none'}`);
    check('AC4  and the resting state SAYS to pick a date, rather than spinning',
      /Pick a date to see the applications you added to auto-apply that day/i.test(text)
      && !/Loading…/.test(text),
      (text.match(/Pick a date[^\n]*/i) || ['absent'])[0]);
    check('AC4  the old run-history chip list is gone as the organising idea',
      !/RUN HISTORY \(\d+\)/.test(text) && /RUN HISTORY/i.test(text),
      'replaced by the dated view, and still present as a section');

    // Opening the CALENDAR may fetch markers — that is a user action, not the initial render, and
    // requirement 7 allows it on exactly that condition.
    const openedCal = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /Pick a date/i.test(b.innerText));
      if (!btn) return false;
      btn.click();
      return true;
    });
    check('AC4  a date picker is offered', openedCal);
    await sleep(700);
    const cal = await page.evaluate(() => {
      const el = document.querySelector('[data-rm-calendar="1"]');
      if (!el) return null;
      return {
        marked: [...el.querySelectorAll('[data-rm-marked]')]
          .filter(d => d.dataset.rmMarked).map(d => d.dataset.rmDay),
        days: [...el.querySelectorAll('[data-rm-day]')].filter(d => d.dataset.rmDay).length,
      };
    });
    check('AC4  it is the DATABASE PANEL\'S calendar, not a second date picker',
      !!cal && cal.days >= 28, cal ? `${cal.days} day cells` : 'no calendar rendered');
    check('AC4  dates WITH activity are marked, so the user is not hunting blindly',
      !!cal && cal.marked.length > 0, `marked: ${(cal?.marked || []).join(', ') || 'none'}`);
    check('AC4  the marker query fires on OPENING the calendar, not on the panel\'s first render',
      [...served].some(p => p.startsWith('/api/apply/history/months')),
      'requirement 7, inside requirement 2');
    await shot('ac4-calendar.png');
    console.log(`      screenshot: ${path.join(OUT_DIR, 'ac4-calendar.png')}`);

    // Selecting a date loads that date.
    const picked = await page.evaluate((day) => {
      const cell = document.querySelector(`[data-rm-calendar="1"] [data-rm-day="${day}"]`);
      if (!cell) return false;
      cell.click();
      return true;
    }, HISTORY_DAY);
    check('AC4  a date can be selected', picked, HISTORY_DAY);
    await sleep(900);

    check('AC4  selecting a date issues the history request, date-scoped',
      historyRequests.some(u => u.includes(`date=${HISTORY_DAY}`)),
      historyRequests.join(' | ') || 'no history request');
    // The DAY requests specifically — the month-marker request is an aggregate and carries no date,
    // which is the point of it being separate.
    const dayRequests = historyRequests.filter(u => u.startsWith('/api/apply/history?'));
    check('AC4  and it is scoped on the SERVER, not fetched whole and filtered here',
      dayRequests.length > 0 && dayRequests.every(u => /[?&]date=/.test(u) && /[?&]tzOffset=/.test(u)),
      dayRequests.join(' | ') || 'no day request');

    const groups = await page.evaluate(() =>
      [...document.querySelectorAll('[data-rm-history-group]')].map(g => ({
        group: g.dataset.rmHistoryGroup,
        count: Number(g.dataset.rmCount),
        rows: g.querySelectorAll('[data-rm-history-row]').length,
        text: g.innerText,
      })));
    check('AC4  the day loads into THREE groups',
      groups.length === 3 && groups.map(g => g.group).join(',') === 'completed,pending,aborted',
      groups.map(g => `${g.group}:${g.count}`).join(' '));
    check('AC4  and each group holds the rows it claims',
      groups.every(g => g.count === g.rows),
      groups.map(g => `${g.group} claims ${g.count} holds ${g.rows}`).join('; '));
    // The mapping, on screen: one submitted, the pending ones, and the aborted ones — including the
    // dead posting, which is the requirement's one non-status input.
    const byGroup = Object.fromEntries(groups.map(g => [g.group, g]));
    check('AC4  COMPLETED holds the submitted application',
      byGroup.completed?.count === 1 && /Infrastructure Engineer/.test(byGroup.completed.text),
      (byGroup.completed?.text || '').replace(/\n/g, ' | ').slice(0, 90));
    check('AC4  PENDING holds what is queued, in flight or waiting on you',
      byGroup.pending?.count === 2
      && /Security Engineer/.test(byGroup.pending.text) && /Research Engineer/.test(byGroup.pending.text),
      (byGroup.pending?.text || '').replace(/\n/g, ' | ').slice(0, 110));
    check('AC4  ABORTED holds what ended without being sent — including the DEAD POSTING',
      byGroup.aborted?.count === 3
      && /posting was removed from the board/i.test(byGroup.aborted.text),
      (byGroup.aborted?.text || '').replace(/\n/g, ' | ').slice(0, 140));
    check('AC4  and ABORTED is not called "failed" — three of its four members did not fail',
      /ABORTED/i.test(byGroup.aborted?.text || '') && /ended without being sent/i.test(byGroup.aborted?.text || ''),
      (byGroup.aborted?.text || '').split('\n').slice(0, 2).join(' | '));

    // Requirement 4: per-item actions, and only where they apply.
    const actions = await page.evaluate(() =>
      [...document.querySelectorAll('[data-rm-history-row]')].map(r => ({
        group: r.dataset.rmGroup,
        buttons: [...r.querySelectorAll('button')].map(b => b.innerText.trim()),
      })));
    check('AC4  ABORT is offered on pending rows',
      actions.filter(a => a.group === 'pending').every(a => a.buttons.includes('Abort')),
      actions.filter(a => a.group === 'pending').map(a => a.buttons.join('/')).join(' '));
    check('AC4  and NEVER on a submitted or already-ended one',
      actions.filter(a => a.group !== 'pending').every(a => !a.buttons.includes('Abort')),
      actions.filter(a => a.group !== 'pending' && a.buttons.includes('Abort'))
        .map(a => a.group).join(', ') || 'none offer it');
    check('AC4  every row can be removed, and the copy says it is a soft hide',
      actions.length > 0 && actions.every(a => a.buttons.includes('Remove')),
      `${actions.length} rows`);
    const removeTitle = await page.evaluate(() => {
      const b = [...document.querySelectorAll('[data-rm-history-row] button')]
        .find(x => x.innerText.trim() === 'Remove');
      return b?.title || '';
    });
    check('AC4  and the copy does not imply an erasure that does not happen',
      /hidden, not deleted|never erased|record is KEPT/i.test(removeTitle), removeTitle.slice(0, 110));
    await shot('ac4-history-groups.png');
    console.log(`      screenshot: ${path.join(OUT_DIR, 'ac4-history-groups.png')}`);

    // Requirement 4, the abort itself: it posts, and it does not submit.
    const abortPosted = await page.evaluate(() => {
      const b = [...document.querySelectorAll('[data-rm-history-row] button')]
        .find(x => x.innerText.trim() === 'Abort');
      if (!b) return false;
      b.click();
      return true;
    });
    await sleep(900);
    check('AC4  Abort posts to the per-run-job abort endpoint',
      abortPosted && abortCalls.length > 0, abortCalls.join(', ') || 'no abort request');
    check('AC4  and it never posts to anything that submits',
      !served.has('/api/apply/approve') && ![...served].some(p => /\/api\/apply$/.test(p)),
      'no approve and no apply call was made by an abort');
    const afterAbort = await page.evaluate(() => document.body.innerText);
    check('AC4  the panel says what the abort actually did',
      /Nothing was submitted/i.test(afterAbort),
      (afterAbort.match(/[^\n]*Nothing was submitted[^\n]*/i) || ['absent'])[0]);

    // Requirement 6: an empty date is a normal state.
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /Date:|Pick a date/i.test(b.innerText));
      if (btn) btn.click();
    });
    await sleep(600);
    const pickedEmpty = await page.evaluate((day) => {
      const cell = document.querySelector(`[data-rm-calendar="1"] [data-rm-day="${day}"]`);
      if (!cell) return false;
      cell.click();
      return true;
    }, EMPTY_DAY);
    await sleep(800);
    const emptyText = await page.evaluate(() => document.body.innerText);
    check('AC4  an EMPTY date reports emptiness — not an error, not a spinner',
      pickedEmpty && /No applications on/i.test(emptyText)
      && !/Loading…/.test(emptyText) && !/Could not load/i.test(emptyText),
      (emptyText.match(/No applications on[^\n]*/i) || ['absent'])[0]);
    await shot('ac4-empty-date.png');
    console.log(`      screenshot: ${path.join(OUT_DIR, 'ac4-empty-date.png')}`);

    // ── AC4 REGRESSION: the Database panel's calendar, UNCHANGED for its own use ─────────────
    //
    // The requirement is explicit that reusing this widget must not change it where it came from.
    // A source check cannot see that — the component is shared, so both sides read identically
    // whatever it renders. So the panel it was taken from is driven here, and its date filter is
    // opened and used.
    console.log('\n── AC4 regression: the Database panel\'s calendar ──');

    // domcontentloaded, not networkidle2: this panel keeps an SSE connection open, so the network
    // never goes idle and the navigation would time out waiting for a quiet it will never reach.
    await page.goto(`${vite.url}/app/database`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // The panel's sheet tabs render as soon as it mounts; the date filter belongs to the
    // Applications sheet, which is its default.
    await page.waitForFunction(
      () => /RESUMES/i.test(document.body.innerText) && /SAVED JOBS/i.test(document.body.innerText),
      { timeout: 20000 },
    ).catch(async () => {
      const t = await page.evaluate(() => document.body.innerText.slice(0, 400));
      console.log('      [db panel body]', JSON.stringify(t));
    });
    await sleep(1200);

    const dbFilter = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /Filter by date/i.test(b.innerText));
      if (!btn) return { found: false, buttons: [...document.querySelectorAll('button')].map(b => b.innerText.trim()).slice(0, 20) };
      btn.click();
      return { found: true };
    });
    check('AC4  the Database panel still offers its date filter',
      dbFilter.found, dbFilter.found ? '' : `buttons: ${(dbFilter.buttons || []).join(' / ')}`);
    await sleep(700);

    const dbCal = await page.evaluate(() => {
      const el = document.querySelector('[data-rm-calendar="1"]');
      if (!el) return null;
      return {
        days: [...el.querySelectorAll('[data-rm-day]')].filter(d => d.dataset.rmDay).length,
        // The Database panel passes no `markers`, so NOTHING may be dotted there. That is the
        // whole test of "unchanged for its own use": the one thing added for AC4 is opt-in, and
        // this panel did not opt in.
        marked: [...el.querySelectorAll('[data-rm-marked]')].filter(d => d.dataset.rmMarked).length,
        text: el.innerText,
        // Portalled, not nested — the sheet's root is `flex:1; overflow:hidden` and an
        // absolutely-positioned popover inside it is CLIPPED, which no z-index can fix.
        portalled: el.closest('[data-rm-calendar]') === el && !el.closest('table'),
      };
    });
    check('AC4  and it renders the SAME calendar the Auto Apply panel now uses',
      !!dbCal && dbCal.days >= 28, dbCal ? `${dbCal.days} day cells` : 'no calendar rendered');
    check('AC4  with its own controls intact — month nav, Clear date, Today',
      !!dbCal && /Clear date/i.test(dbCal.text) && /Today/i.test(dbCal.text)
      && /\d{4}/.test(dbCal.text),
      (dbCal?.text || '').split('\n').slice(0, 2).join(' | '));
    check('AC4  and NOTHING dotted — the markers prop is opt-in and this panel did not opt in',
      !!dbCal && dbCal.marked === 0, `${dbCal?.marked} marked cells in the Database panel`);
    check('AC4  the popover is still portalled out of its clipping ancestor',
      !!dbCal && dbCal.portalled);

    // And it still FILTERS. Picking a date must change the toolbar's label, which is what the
    // Database panel does with the value — the behaviour, not just the rendering.
    const dbPicked = await page.evaluate(() => {
      const cell = [...document.querySelectorAll('[data-rm-calendar="1"] [data-rm-day]')]
        .find(d => d.dataset.rmDay);
      if (!cell) return null;
      const iso = cell.dataset.rmDay;
      cell.click();
      return iso;
    });
    await sleep(600);
    const dbAfter = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /Date:|Filter by date/i.test(b.innerText));
      return btn ? btn.innerText.trim() : '';
    });
    check('AC4  picking a date still drives the Database panel\'s own filter',
      !!dbPicked && /^📅?\s*Date:/.test(dbAfter), `picked ${dbPicked} -> "${dbAfter}"`);
    await shot('ac4-database-calendar.png');
    console.log(`      screenshot: ${path.join(OUT_DIR, 'ac4-database-calendar.png')}`);

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
