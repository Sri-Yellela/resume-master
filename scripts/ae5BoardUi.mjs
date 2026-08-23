#!/usr/bin/env node
/**
 * TASK AE5 — the job board's listings, REAL-RUN verification by screenshot.
 * ============================================================================================
 * AE5 is entirely a defect of PRESENTATION: how many listings sit on a row, whether they carry a
 * logo, and which action occupies the last slot in the control strip. A node test that reads the JSX
 * as text can prove the source says the right words and will pass happily over a grid that renders
 * one column, a logo that 404s to a letter, or a button that is present but never reachable. So the
 * board is driven in a real Chrome and the rendered geometry is measured.
 *
 * The API is stubbed for the same reason scripts/abPanelUi.mjs stubs it: the server writes to
 * data/resume_master.db, whose path is not configurable, and seeding a developer's working database
 * to take a screenshot is not a reasonable trade. What is under test here is what the board DOES
 * with a given response.
 *
 * THE FIXTURE IS THE COMPLAINT. Ten listings, mixed: companies the logo table knows (so a real
 * image has to appear), a company it does not (so the lettered tile has to appear), one row that
 * already carries a feed-supplied companyIconUrl (so the precedence is visible), and one already in
 * the queue (so Queue Auto's state is visible).
 *
 * Usage:  node scripts/ae5BoardUi.mjs
 *         AE5_KEEP_OPEN=1 node scripts/ae5BoardUi.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';
import { getKnownLogoUrl } from '../shared/companyLogos.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(os.tmpdir(), 'ae5-board-ui');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────
const now = Math.floor(Date.now() / 1000);

// Companies the shared logo table knows, so getKnownLogoUrl must resolve an <img> for each; and one
// it does not, which must fall back to the lettered tile rather than to a broken image.
const KNOWN    = ['OpenAI', 'Stripe', 'Datadog', 'Figma', 'Notion', 'Cloudflare', 'Vercel', 'Anthropic'];
const UNKNOWN  = 'Brightmoor Analytics Group';

const JOBS = [
  ...KNOWN.map((company, i) => ({
    jobId: `k${i}`, id: `k${i}`, company, title: `Software Engineer ${i + 1}`,
    location: 'San Francisco, CA', workType: i % 2 ? 'Remote' : 'Hybrid',
    url: `https://jobs.ashbyhq.com/${company.toLowerCase()}/${i}`,
    applyUrl: `https://jobs.ashbyhq.com/${company.toLowerCase()}/${i}`,
    source: 'ashby', sourcePlatform: 'ashby', automationTier: 'direct',
    postedAt: null, scrapedAt: now - 3600 * (i + 1), discoveredAt: now - 3600 * (i + 1),
    isActive: true, companyIconUrl: null,
    baseAtsScore: 70 + i, salaryMin: 180000, salaryMax: 260000, salaryCurrency: 'USD',
    minYearsExp: 3, applicantCount: 40 + i,
    visited: i === 1, starred: false, disliked: false, alreadyApplied: false,
  })),
  // No entry in the logo table — the lettered tile is the correct answer, not a broken <img>.
  { jobId: 'u0', id: 'u0', company: UNKNOWN, title: 'Data Engineer',
    location: 'Remote', workType: 'Remote',
    url: 'https://boards.greenhouse.io/brightmoor/1', applyUrl: 'https://boards.greenhouse.io/brightmoor/1',
    source: 'greenhouse', sourcePlatform: 'greenhouse', automationTier: 'direct',
    postedAt: null, scrapedAt: now - 7200, discoveredAt: now - 7200, isActive: true,
    companyIconUrl: null, baseAtsScore: 66, minYearsExp: 2,
    visited: false, starred: false, disliked: false, alreadyApplied: false },
  // A feed that DID carry a logo. The row's own URL has to win over the table lookup.
  { jobId: 'f0', id: 'f0', company: 'Shopify', title: 'Backend Engineer',
    location: 'Toronto', workType: 'Remote',
    url: 'https://jobs.lever.co/shopify/1', applyUrl: 'https://jobs.lever.co/shopify/1',
    source: 'lever', sourcePlatform: 'lever', automationTier: 'direct',
    postedAt: null, scrapedAt: now - 10800, discoveredAt: now - 10800, isActive: true,
    companyIconUrl: 'https://logo.clearbit.com/shopify.com', baseAtsScore: 81, minYearsExp: 4,
    visited: false, starred: true, disliked: false, alreadyApplied: false },
];

const FALLBACK = {};
const FIXTURES = {
  '/api/auth/me': { authenticated: true, user: { id: 1, username: 'ada', email: 'ada@example.com', planTier: 'PRO' } },
  '/api/jobs': { success: true, jobs: JOBS, total: JOBS.length, page: 1, pageSize: 50, totalPages: 1 },
  // The board does not fetch a single job without an ACTIVE domain profile — without this it renders
  // "Create a job profile" and every check below would be measuring an empty page. `target_titles`
  // has to be populated too: an empty one produces "Showing 0 of N", which reads like a filter
  // regression rather than a fixture gap.
  '/api/domain-profiles': [{
    id: 1, profile_name: 'Software Engineering', is_active: 1,
    target_titles: JSON.stringify(['Software Engineer', 'Backend Engineer', 'Data Engineer']),
    seniority: null, work_type: null, location: null,
  }],
  // The second prerequisite notice: without a base resume the board renders "Upload a profile
  // resume" over the listings. Both gates are legitimate product behaviour and both have to be
  // satisfied for the listings to be on screen at all.
  '/api/domain-profiles/1/base-resume': { name: 'ada-resume.pdf', content:
    'Ada Lovelace — Software Engineer. Python, TypeScript, distributed systems. 6 years experience.' },
  '/api/domain-profiles/1/enhance-status': { enhanceUsed: false, enhancePaid: false },
  '/api/apply/runs': { runs: [], review: [], gated: [], inFlight: [], submitted: [], stopped: [],
                       statusCounts: {} },
  '/api/apply/gate-packets': { portals: [], packets: [] },
  '/api/apply/questions': { questions: [] },
  '/api/apply/pending': { pending: [] },
};

function startVite() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath,
      [path.join(ROOT, 'client', 'node_modules', 'vite', 'bin', 'vite.js'),
       '--port', '5198', '--strictPort'],
      { cwd: path.join(ROOT, 'client'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b) => {
      // Strip the ESC byte too, not just the bracket-and-letter. Vite colours the PORT
      // separately from the host, so a stripper that leaves the ESC behind turns
      // "localhost:5198" into "localhost:<ESC>5198" and the banner is never recognised — the
      // harness then times out on a dev server that started fine 400ms in.
      out += b.toString().replace(/\u001b?\[[0-9;]*m/g, '');
      if (/localhost:\D{0,4}5198/.test(out)) resolve({ proc, url: 'http://localhost:5198' });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error(`vite did not start:\n${out.slice(-800)}`)), 60000);
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('=== AE5 — the job board listings ===\n');

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

    await page.setRequestInterception(true);
    const served = new Set();
    // Clearbit is a real third party and this harness must not depend on it being reachable — nor
    // on the network at all. Logo requests are answered with a 1x1 PNG, so "an <img> rendered"
    // stays a claim about the BOARD rather than about clearbit.com's uptime.
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64');
    const logoRequests = [];
    page.on('request', (req) => {
      const raw = req.url();
      if (/logo\.clearbit\.com/.test(raw)) {
        logoRequests.push(raw);
        return req.respond({ status: 200, contentType: 'image/png', body: PNG });
      }
      const url = new URL(raw, vite.url);
      if (!url.pathname.startsWith('/api/')) return req.continue();
      served.add(url.pathname);
      const body = FIXTURES[url.pathname] ?? FALLBACK;
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    await page.goto(`${vite.url}/app/jobs`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(
      () => /Software Engineer 1/.test(document.body.innerText), { timeout: 30000 })
      .catch(async () => {
        console.log('      [body]', JSON.stringify(
          (await page.evaluate(() => document.body.innerText)).slice(0, 600)));
      });
    await sleep(1500);

    check('the board rendered against the stubbed API', served.has('/api/jobs'), [...served].join(' '));
    const shot = (name) => page.screenshot({ path: path.join(OUT_DIR, name), fullPage: true });

    // ── Requirement 1: TWO PER ROW, EQUAL WIDTH ──────────────────────────────────────────────
    //
    // Measured from the rendered boxes, not from the CSS: `grid-template-columns` can say whatever
    // it likes and still collapse to one column if a child has an intrinsic min-width. Cards are
    // grouped by their top edge, which is what a "row" actually is on screen.
    const measure = () => page.evaluate(() => {
      // The listing cards are the direct children of the grid. Found via a card's own content
      // rather than a class name, so this does not depend on an inline-style substring.
      const cards = [...document.querySelectorAll('div')]
        .filter(d => /Software Engineer \d|Data Engineer|Backend Engineer/.test(d.innerText || '')
                  && d.parentElement && getComputedStyle(d.parentElement).display === 'grid');
      const uniq = cards.filter(c => !cards.some(o => o !== c && o.contains(c)));
      const grid = uniq[0]?.parentElement || null;
      return {
        columns: grid ? getComputedStyle(grid).gridTemplateColumns : null,
        gap: grid ? getComputedStyle(grid).gap : null,
        cards: uniq.map(c => {
          const r = c.getBoundingClientRect();
          return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) };
        }),
      };
    });

    const wide = await measure();
    const rows = new Map();
    for (const c of wide.cards) {
      const key = [...rows.keys()].find(k => Math.abs(k - c.top) <= 4) ?? c.top;
      rows.set(key, [...(rows.get(key) || []), c]);
    }
    const perRow = [...rows.values()].map(r => r.length);
    console.log(`      grid-template-columns: ${wide.columns}`);
    console.log(`      cards: ${wide.cards.length}, per row: ${perRow.join(',')}`);

    check('AE5  the listings are laid out as a GRID, not a stack of full-width rows',
      wide.columns && wide.columns.split(' ').length === 2, wide.columns || 'no grid');
    check('AE5  TWO listings per row',
      perRow.length > 0 && perRow.filter(n => n === 2).length >= Math.floor(wide.cards.length / 2) - 1,
      `per row: ${perRow.join(',')}`);
    const widths = [...new Set(wide.cards.map(c => c.w))];
    check('AE5  at EQUAL width',
      widths.length > 0 && Math.max(...widths) - Math.min(...widths) <= 2,
      `widths: ${widths.join(', ')}`);
    check('AE5  and no longer full-width',
      wide.cards.every(c => c.w < 700), `max width ${Math.max(...wide.cards.map(c => c.w))}px`);
    await shot('ae5-two-per-row.png');
    console.log(`      screenshot: ${path.join(OUT_DIR, 'ae5-two-per-row.png')}`);

    // ── Requirement 1: STACKING AT NARROW WIDTHS ─────────────────────────────────────────────
    await page.setViewport({ width: 700, height: 1100, deviceScaleFactor: 1 });
    await sleep(900);
    const narrow = await measure();
    const narrowRows = new Map();
    for (const c of narrow.cards) {
      const key = [...narrowRows.keys()].find(k => Math.abs(k - c.top) <= 4) ?? c.top;
      narrowRows.set(key, [...(narrowRows.get(key) || []), c]);
    }
    check('AE5  they STACK at narrow widths — one per row, no breakpoint to maintain',
      [...narrowRows.values()].every(r => r.length === 1),
      `columns: ${narrow.columns}, per row: ${[...narrowRows.values()].map(r => r.length).join(',')}`);
    await shot('ae5-stacked-narrow.png');
    console.log(`      screenshot: ${path.join(OUT_DIR, 'ae5-stacked-narrow.png')}`);
    await page.setViewport({ width: 1400, height: 1200, deviceScaleFactor: 1 });
    await sleep(900);

    // ── Requirement 2: THE LOGO ──────────────────────────────────────────────────────────────
    const icons = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('img, div')) {
        const r = el.getBoundingClientRect();
        // The 48px company icon: an <img> with a logo src, or the lettered tile it falls back to.
        if (Math.round(r.width) !== 48 || Math.round(r.height) !== 48) continue;
        if (el.tagName === 'IMG') out.push({ kind: 'img', alt: el.alt, src: el.currentSrc || el.src, natural: el.naturalWidth });
        else if (/^[A-Z]$/.test((el.innerText || '').trim())) out.push({ kind: 'letter', letter: el.innerText.trim() });
      }
      return out;
    });
    const imgs = icons.filter(i => i.kind === 'img');
    const letters = icons.filter(i => i.kind === 'letter');
    console.log(`      icons: ${imgs.length} image(s), ${letters.length} lettered tile(s)`);

    check('AE5  a known company renders a real logo IMAGE, not a letter',
      KNOWN.every(c => imgs.some(i => i.alt === c)),
      `have images for: ${imgs.map(i => i.alt).join(', ')}`);
    check('AE5  resolved from the SHARED table — the same one the server enriches from',
      KNOWN.every(c => imgs.some(i => i.alt === c && i.src === getKnownLogoUrl(c))),
      `e.g. OpenAI -> ${imgs.find(i => i.alt === 'OpenAI')?.src}`);
    check('AE5  a feed-supplied companyIconUrl still wins over the table lookup',
      imgs.some(i => i.alt === 'Shopify' && i.src === 'https://logo.clearbit.com/shopify.com'),
      imgs.find(i => i.alt === 'Shopify')?.src || 'no Shopify icon');
    check('AE5  a company the table does NOT know falls back to the lettered tile, not a broken image',
      letters.some(l => l.letter === 'B') && !imgs.some(i => i.alt === UNKNOWN),
      `letters: ${letters.map(l => l.letter).join('')}`);
    check('AE5  and no request was made for a company we cannot resolve',
      !logoRequests.some(u => /brightmoor/i.test(u)), `${logoRequests.length} logo request(s)`);

    // ── Requirement 3: QUEUE AUTO REPLACES THE DISLIKE ───────────────────────────────────────
    const strip = await page.evaluate(() => {
      const card = [...document.querySelectorAll('div')]
        .filter(d => /Software Engineer 1/.test(d.innerText || '')
                  && d.parentElement && getComputedStyle(d.parentElement).display === 'grid')[0];
      if (!card) return null;
      return [...card.querySelectorAll('button')].map(b => ({
        title: b.title, text: (b.innerText || '').trim(), disabled: b.disabled,
      }));
    });
    console.log(`      control strip: ${JSON.stringify(strip)}`);
    check('AE5  the listing offers QUEUE AUTO',
      !!strip?.some(b => /auto-apply queue/i.test(b.title || '')),
      strip?.map(b => b.title).join(' | ') || 'no buttons');
    check('AE5  and the thumbs-down is gone from the listing',
      !strip?.some(b => /not interested|undo pass/i.test(b.title || '')),
      strip?.map(b => b.title).join(' | ') || '');

    // Requirement 4: everything else on the row survived.
    for (const [what, ok] of [
      ['the star',        strip?.some(b => /save job|remove from saved/i.test(b.title || ''))],
      ['the sparkle',     strip?.some(b => /generate resume|regenerate/i.test(b.title || ''))],
      ['open-in-new',     strip?.some(b => /open job listing/i.test(b.title || ''))],
    ]) {
      check(`AE5  ${what} is still on the row`, !!ok, strip?.map(b => b.title).join(' | ') || '');
    }
    const boardText = await page.evaluate(() => document.body.innerText);
    for (const [what, re] of [
      ['the ATS badge',   /\b7[0-9]\b/],
      ['freshness',       /\b\d+[hmd]\b|just now|ago/i],
      ['the meta chips',  /Remote|Hybrid/],
      ['the visited state', /visited/],
      ['the location',    /San Francisco/],
      ['salary',          /\$?18[05]/],
    ]) {
      check(`AE5  ${what} survived`, re.test(boardText), (boardText.match(re) || ['MISSING'])[0]);
    }

    // The action really queues, and says so — a button that fires nothing would pass every check
    // above.
    const clicked = await page.evaluate(() => {
      const card = [...document.querySelectorAll('div')]
        .filter(d => /Software Engineer 1/.test(d.innerText || '')
                  && d.parentElement && getComputedStyle(d.parentElement).display === 'grid')[0];
      const btn = card && [...card.querySelectorAll('button')].find(b => /auto-apply queue/i.test(b.title || ''));
      if (!btn) return false;
      btn.click();
      return true;
    });
    await sleep(700);
    const afterQueue = await page.evaluate(() => {
      const card = [...document.querySelectorAll('div')]
        .filter(d => /Software Engineer 1/.test(d.innerText || '')
                  && d.parentElement && getComputedStyle(d.parentElement).display === 'grid')[0];
      const btn = card && [...card.querySelectorAll('button')].find(b => /auto-apply queue/i.test(b.title || ''));
      return { title: btn?.title || null, disabled: !!btn?.disabled, body: document.body.innerText };
    });
    check('AE5  and the button then reports the job is already queued, rather than firing twice',
      clicked && afterQueue.disabled && /already in the auto-apply queue/i.test(afterQueue.title || ''),
      `${afterQueue.title} disabled=${afterQueue.disabled}`);

    // CROSS-SURFACE PROOF. The board itself shows no toast — `applyQueueMsg` is rendered by the Auto
    // Apply panel, and JobDetailPanel's existing "Queue Auto" is equally quiet there — so the button
    // flipping to ✓ is the only feedback on this screen. That state is read from the shared context,
    // which means it could in principle be local optimism. Navigating to the panel that OWNS the
    // queue and finding the job in it is what makes "pressing it actually queues the job" a claim
    // about the queue rather than about one component's useState.
    // Navigated by CLICKING THE NAV, not with page.goto. A goto is a full document load, which tears
    // down the React tree and with it the queue — AutoApplyContext holds it in useState with no
    // persistence, so a hard reload legitimately empties it. The user moves between panels through
    // the router, and that is the path this has to exercise; using goto here would have reported a
    // working feature as broken.
    await page.evaluate(() => {
      const link = [...document.querySelectorAll('a,button')]
        .find(el => /^AUTO APPLY/i.test((el.innerText || '').trim()));
      link?.click();
    });
    await sleep(1400);
    const queuePanel = await page.evaluate(() => document.body.innerText);
    check('AE5  pressing it actually queues the job — the Auto Apply panel lists it',
      // The queue strip names the EMPLOYER, not the role — so the assertion follows the panel's own
      // vocabulary rather than insisting on the board's.
      /READY TO START/.test(queuePanel) && !/Nothing queued/i.test(queuePanel)
      && /OpenAI/.test(queuePanel) && /picked on the board, not started yet/.test(queuePanel),
      (queuePanel.match(/READY TO START[\s\S]{0,90}/) || ['queue not listed'])[0].split(/\r?\n/).join(' | '));
    await shot('ae5-queued-in-panel.png');
    console.log(`      screenshot: ${path.join(OUT_DIR, 'ae5-queued-in-panel.png')}`);

    // And back to the board, client-side, because the queue is the one piece of state that has to
    // survive the trip: it is picked on one surface and dispatched from another.
    await page.evaluate(() => {
      const link = [...document.querySelectorAll('a,button')].find(el => /^JOBS$/i.test((el.innerText || '').trim()));
      link?.click();
    });
    await sleep(1200);
    const backOnBoard = await page.evaluate(() => {
      const card = [...document.querySelectorAll('div')]
        .filter(d => /Software Engineer 1/.test(d.innerText || '')
                  && d.parentElement && getComputedStyle(d.parentElement).display === 'grid')[0];
      const btn = card && [...card.querySelectorAll('button')].find(b => /auto-apply queue/i.test(b.title || ''));
      return btn ? { disabled: btn.disabled, title: btn.title } : null;
    });
    check('AE5  and the listing still shows it as queued after a round trip',
      backOnBoard?.disabled === true, JSON.stringify(backOnBoard));

    await shot('ae5-controls.png');
    console.log(`      screenshot: ${path.join(OUT_DIR, 'ae5-controls.png')}`);

    if (process.env.AE5_KEEP_OPEN) {
      console.log('\nAE5_KEEP_OPEN set — leaving the browser open. Ctrl+C to finish.');
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
