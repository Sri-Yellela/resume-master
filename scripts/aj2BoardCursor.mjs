#!/usr/bin/env node
/**
 * TASK AJ2 — the web board pages by CURSOR, verified in a real browser.
 * ============================================================================================
 *
 * THE DEFECT
 *
 * Disliking a job removes it from the server's result set — the default board excludes disliked
 * rows. So pressing Next after passing on four jobs asks for an offset four rows further into a
 * list that is four rows SHORTER, and four jobs are stepped over and never shown.
 *
 * On this board the skip is invisible twice over, which is why it survived: the list does not
 * visibly shrink (JobsPanel re-injects session-disliked rows so they stay on screen, faded), and
 * `total` still counts the skipped rows, so the pager's arithmetic looks right.
 *
 * WHY A BROWSER AND NOT A NODE TEST
 *
 * test/boardPagingCursor.test.js proves the DECISION — which mode answers which navigation. It
 * cannot prove the component asks for the right URL, threads the response's cursor back into the
 * next request, or that the rows a user actually sees are the right ones. Those are properties of
 * a running React tree, and a source-string test passes happily over all three. Same reasoning as
 * scripts/ae5BoardUi.mjs, which is where this harness's shape comes from.
 *
 * THE API IS STUBBED, AND THE STUB IMPLEMENTS A REAL KEYSET CURSOR
 *
 * Not a canned response. The stub orders its pool exactly as the server does (discovered_at DESC,
 * job_id ASC), issues a cursor holding the last row's SORT VALUES, and resumes strictly after them.
 * A stub that just returned "page 2" on demand would pass whatever the client sent and prove
 * nothing about the mechanism.
 *
 * HOW THE MUTATION IS INJECTED, STATED PLAINLY
 *
 * The four jobs are removed from the pool by the STUB between page 1 and page 2, rather than by
 * clicking Pass in the job detail panel. What is under test is the PAGING, and the essential
 * condition is "the server's result set shrank behind the reader" — which this reproduces exactly,
 * without depending on a detail-panel interaction that is not what changed. The dislike control
 * itself is covered by its own surfaces.
 *
 * Usage:  node scripts/aj2BoardCursor.mjs
 *         AJ2_KEEP_OPEN=1 node scripts/aj2BoardCursor.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(os.tmpdir(), 'aj2-board-cursor');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// ── The pool ─────────────────────────────────────────────────────────────────────────────────
// 60 jobs at the board's PAGE_SIZE of 25 gives three pages, so page 2 is a real middle page with
// pages on both sides of it. discovered_at DESCENDS with the index, so the natural order is
// j00, j01, ... j59 — which makes a skip readable at a glance rather than something to decode.
const now = Math.floor(Date.now() / 1000);
const POOL = Array.from({ length: 60 }, (_, i) => ({
  jobId: `j${String(i).padStart(2, '0')}`,
  id: `j${String(i).padStart(2, '0')}`,
  company: `Co${i % 5}`,
  title: `Software Engineer ${String(i).padStart(2, '0')}`,
  location: 'Remote', workType: 'Remote',
  url: `https://example.invalid/${i}`, applyUrl: `https://example.invalid/${i}`,
  source: 'ashby', sourcePlatform: 'ashby', automationTier: 'direct',
  postedAt: null,
  scrapedAt: now - i, discoveredAt: now - i,
  isActive: true, companyIconUrl: null, baseAtsScore: 70,
  visited: false, starred: false, disliked: false, alreadyApplied: false,
}));

/** Removed between page 1 and page 2 — i.e. jobs the user passed on while looking at page 1. */
const PASSED = ['j02', 'j05', 'j11', 'j19'];

const PAGE_SIZE_EXPECTED = 25;   // JobsPanel's PAGE_SIZE; asserted below rather than assumed

// ── A real keyset cursor, in the stub ────────────────────────────────────────────────────────
const encodeCursor = (row) =>
  Buffer.from(JSON.stringify([row.discoveredAt, row.jobId]), 'utf8').toString('base64url');
const decodeCursor = (token) => {
  try { return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); }
  catch { return null; }
};

/** discovered_at DESC, job_id ASC — the server's RECENCY tail, and a TOTAL order. */
const ordered = (pool) => [...pool].sort((a, b) =>
  b.discoveredAt - a.discoveredAt || (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));

function serveJobs(url, excluded) {
  const live = ordered(POOL.filter(j => !excluded.has(j.jobId)));
  const ps = Number(url.searchParams.get('pageSize')) || 25;
  const cursor = url.searchParams.get('cursor');
  const page = Number(url.searchParams.get('page')) || 1;

  let start;
  if (cursor) {
    const values = decodeCursor(cursor);
    if (!values) {
      return { status: 400, body: { success: false, error: 'Malformed cursor.', code: 'cursor_malformed', jobs: [], total: 0 } };
    }
    const [dAt, jid] = values;
    // Strictly after, in the same ordering: a lower discoveredAt, or the same one with a larger id.
    start = live.findIndex(j => j.discoveredAt < dAt || (j.discoveredAt === dAt && j.jobId > jid));
    if (start === -1) start = live.length;
  } else {
    start = (page - 1) * ps;
  }
  const slice = live.slice(start, start + ps);
  const more = start + ps < live.length;
  return {
    status: 200,
    body: {
      success: true,
      jobs: slice,
      total: live.length,
      page, pageSize: ps,
      totalPages: Math.ceil(live.length / ps),
      sources: ['scraped_jobs'], fromCache: true,
      nextCursor: more && slice.length ? encodeCursor(slice[slice.length - 1]) : null,
      paging: cursor ? 'cursor' : 'offset',
    },
  };
}

/** What OFFSET paging would have returned for the same navigation — the precondition. */
function offsetPage2(excluded) {
  const live = ordered(POOL.filter(j => !excluded.has(j.jobId)));
  return live.slice(PAGE_SIZE_EXPECTED, PAGE_SIZE_EXPECTED * 2).map(j => j.jobId);
}

const FALLBACK = {};
const FIXTURES = {
  '/api/auth/me': { authenticated: true, user: { id: 1, username: 'ada', planTier: 'PRO' } },
  // Both board prerequisites. Without an ACTIVE profile the board renders "Create a job profile";
  // without a base resume it renders "Upload a profile resume". Either way every check below would
  // be measuring an empty page rather than a paging defect.
  '/api/domain-profiles': [{
    id: 1, profile_name: 'Software Engineering', is_active: 1,
    target_titles: JSON.stringify(['Software Engineer']),
    seniority: null, work_type: null, location: null,
  }],
  '/api/domain-profiles/1/base-resume': { name: 'ada.pdf', content: 'Ada Lovelace — Software Engineer. 6 years.' },
  '/api/domain-profiles/1/enhance-status': { enhanceUsed: false, enhancePaid: false },
  '/api/apply/runs': { runs: [], review: [], gated: [], inFlight: [], submitted: [], stopped: [], statusCounts: {} },
  '/api/apply/gate-packets': { portals: [], packets: [] },
  '/api/apply/questions': { questions: [] },
  '/api/apply/pending': { pending: [] },
};

function startVite() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath,
      [path.join(ROOT, 'client', 'node_modules', 'vite', 'bin', 'vite.js'),
       '--port', '5199', '--strictPort'],
      { cwd: path.join(ROOT, 'client'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b) => {
      // Strip the ESC byte too: vite colours the PORT separately from the host, so a stripper that
      // leaves ESC behind never matches the banner and the harness times out on a dev server that
      // started fine.
      out += b.toString().replace(/?\[[0-9;]*m/g, '');
      if (/localhost:\D{0,4}5199/.test(out)) resolve({ proc, url: 'http://localhost:5199' });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error(`vite did not start:\n${out.slice(-800)}`)), 60000);
  });
}

/** The job ids currently rendered, read in DOM order off the card titles. */
const renderedIds = (page) => page.evaluate(() => {
  const seen = [];
  for (const el of document.querySelectorAll('*')) {
    const t = (el.textContent || '').trim();
    const m = /^Software Engineer (\d{2})$/.exec(t);
    if (m && el.children.length === 0) {
      const id = `j${m[1]}`;
      if (!seen.includes(id)) seen.push(id);
    }
  }
  return seen;
});

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('=== AJ2 — the board pages by cursor ===\n');

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.log('FAIL  no Chrome binary'); process.exit(1); }

  const vite = await startVite();
  console.log(`vite     ${vite.url}\n`);

  const browser = await puppeteer.launch({
    executablePath: resolution.path, headless: 'new', pipe: true,
    args: ['--no-first-run', '--no-default-browser-check'],
    defaultViewport: { width: 1500, height: 1400, deviceScaleFactor: 1 },
  });

  const excluded = new Set();
  const jobRequests = [];

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

      if (url.pathname === '/api/jobs') {
        jobRequests.push(url.search);
        const { status, body } = serveJobs(url, excluded);
        return req.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
      }
      // The board's Pass action. Present so a real dislike is not a 404, though the mutation this
      // harness measures is injected directly into the pool — see the header.
      const dis = /^\/api\/jobs\/([^/]+)\/disliked$/.exec(url.pathname);
      if (dis) {
        const id = decodeURIComponent(dis[1]);
        excluded.has(id) ? excluded.delete(id) : excluded.add(id);
        return req.respond({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ ok: true, disliked: excluded.has(id) }) });
      }
      req.respond({ status: 200, contentType: 'application/json',
        body: JSON.stringify(FIXTURES[url.pathname] ?? FALLBACK) });
    });

    await page.goto(`${vite.url}/app/jobs`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => /Software Engineer 00/.test(document.body.innerText), { timeout: 30000 })
      .catch(async () => console.log('      [body]',
        JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 500))));
    await sleep(1200);

    // ── page 1 ────────────────────────────────────────────────────────────────────────────────
    const p1 = await renderedIds(page);
    check('the board rendered against the stubbed API', p1.length > 0, `${p1.length} cards`);
    check(`page 1 is the first ${PAGE_SIZE_EXPECTED} jobs in order`,
      p1.length === PAGE_SIZE_EXPECTED && p1[0] === 'j00' && p1[PAGE_SIZE_EXPECTED - 1] === 'j24',
      `${p1[0]}..${p1[p1.length - 1]} (${p1.length})`);
    check('the first request paged by OFFSET — there is no cursor to use yet',
      jobRequests.length > 0 && !jobRequests[jobRequests.length - 1].includes('cursor='),
      jobRequests[jobRequests.length - 1]);

    await page.screenshot({ path: path.join(OUT_DIR, '1-page1.png'), fullPage: false });

    // ── the mutation ──────────────────────────────────────────────────────────────────────────
    for (const id of PASSED) excluded.add(id);
    console.log(`\n      passed on ${PASSED.join(', ')} — all of them on page 1\n`);

    // What offset paging WOULD now return. Asserted FIRST: without it, the cursor check below is a
    // walk over an unchanging board and proves nothing.
    const wouldBe = offsetPage2(excluded);
    const expectedNext = ordered(POOL.filter(j => !excluded.has(j.jobId)))
      .filter(j => j.discoveredAt < POOL.find(p => p.jobId === 'j24').discoveredAt
                || (j.discoveredAt === POOL.find(p => p.jobId === 'j24').discoveredAt && j.jobId > 'j24'))
      .slice(0, PAGE_SIZE_EXPECTED).map(j => j.jobId);
    const skippedByOffset = expectedNext.filter(id => !wouldBe.includes(id));
    check(`PRECONDITION — offset paging would skip ${skippedByOffset.length} job(s) here`,
      skippedByOffset.length === PASSED.length,
      skippedByOffset.length ? `would never be shown: ${skippedByOffset.join(', ')}` :
        'offset lost nothing, so this fixture does not reproduce the defect');

    // ── Next ──────────────────────────────────────────────────────────────────────────────────
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => (b.textContent || '').trim() === 'Next' && !b.disabled);
      if (!btn) return false;
      btn.click();
      return true;
    });
    check('the Next button is present and enabled', clicked);
    await sleep(1800);

    const lastReq = jobRequests[jobRequests.length - 1] || '';
    check('NEXT SENT A CURSOR — the wiring is real, not just the policy',
      lastReq.includes('cursor='), lastReq.slice(0, 120));
    check('...and did NOT also send a page number, which the server would ignore',
      lastReq.includes('cursor=') && !/[?&]page=/.test(lastReq), lastReq.slice(0, 120));

    const p2 = await renderedIds(page);
    check('page 2 rendered', p2.length > 0, `${p2.length} cards`);
    const skipped = expectedNext.filter(id => !p2.includes(id));
    check('NOTHING WAS SKIPPED — every job after the last one seen is on page 2',
      skipped.length === 0,
      skipped.length ? `missing: ${skipped.join(', ')}` : `${p2[0]}..${p2[p2.length - 1]}`);
    check('page 2 starts exactly where page 1 ended, not four rows past it',
      p2[0] === 'j25', `starts at ${p2[0]}, offset paging would have started at ${wouldBe[0]}`);
    check('no job from page 1 reappears on page 2',
      !p2.some(id => p1.includes(id)));

    await page.screenshot({ path: path.join(OUT_DIR, '2-page2.png'), fullPage: false });

    // ── Prev ──────────────────────────────────────────────────────────────────────────────────
    const clickedPrev = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => (b.textContent || '').trim() === 'Prev' && !b.disabled);
      if (!btn) return false;
      btn.click();
      return true;
    });
    check('the Prev button is present and enabled on page 2', clickedPrev);
    await sleep(1800);
    const backTo1 = await renderedIds(page);
    check('PREV returns to the page the user came from',
      backTo1[0] === 'j00', `starts at ${backTo1[0]}`);
    check('...and the four passed jobs are gone from it, because the server now excludes them',
      PASSED.every(id => !backTo1.includes(id)),
      `still present: ${PASSED.filter(id => backTo1.includes(id)).join(', ') || 'none'}`);

    // ── a JUMP still works, by offset ─────────────────────────────────────────────────────────
    const jumped = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => (b.textContent || '').trim() === '3');
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (jumped) {
      await sleep(1800);
      const jumpReq = jobRequests[jobRequests.length - 1] || '';
      check('A JUMP to page 3 uses OFFSET — a cursor cannot answer "page 3"',
        /[?&]page=3/.test(jumpReq) && !jumpReq.includes('cursor='), jumpReq.slice(0, 120));
      const p3 = await renderedIds(page);
      check('page 3 rendered by offset', p3.length > 0, `${p3.length} cards, starts ${p3[0]}`);
      await page.screenshot({ path: path.join(OUT_DIR, '3-page3-jump.png'), fullPage: false });
    } else {
      check('the numbered pager offers page 3', false, 'no "3" button found');
    }

    console.log(`\n      screenshots: ${OUT_DIR}`);
    if (process.env.AJ2_KEEP_OPEN) { console.log('      AJ2_KEEP_OPEN set — leaving browser open'); await sleep(600000); }
  } finally {
    await browser.close().catch(() => {});
    vite.proc.kill();
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.log(`FAIL  harness threw: ${e.message}`); console.log(e.stack); process.exit(1); });
