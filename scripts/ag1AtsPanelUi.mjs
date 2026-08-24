#!/usr/bin/env node
/**
 * TASK AG1 — the local ATS report, REAL-RUN verification by screenshot.
 * ============================================================================================
 * WHY THIS EXISTS
 * The defect was never in a number. `scoreAtsLocally` mined candidate terms by sliding a 1-3 word
 * window across the job description, so the panel told the user their resume was missing
 * "and scalable. We", "s core productivity" and "employees and agents". Every unit test the module
 * had passed throughout: the scores were arithmetically correct, the arrays were the right length,
 * and the strings inside them were sentence fragments. A test that asserts on shape cannot see
 * that, because the shape was never wrong — what was wrong was what a person READ.
 *
 * So this renders the REAL client/src/panels/ATSPanel.jsx, in a real Chrome, with a report computed
 * by the REAL scorer from the REAL database row, and reads the chips back out of the DOM. Twice:
 * once against HEAD's scorer and once against the working tree's, so the screenshots are a
 * before/after of the same posting rather than a claim about one.
 *
 * WHY TWO MODULES RATHER THAN TWO FIXTURES
 * Hand-writing the "before" report would make this harness a test of my own transcription. The
 * BEFORE report is produced by `git show HEAD:services/localAtsScorer.js` — the actual pre-fix
 * module — dropped in os.tmpdir() and imported. HEAD has no imports of its own, which is what makes
 * that legal; the fixed module imports ./skillVocabulary.js and could not be relocated this way.
 * If HEAD ever stops being the pre-fix version (i.e. once this is committed) the script still runs
 * and simply shows whatever HEAD produces — the assertions below would then fail loudly on
 * check 1, which is honest: the harness would no longer be demonstrating a difference.
 *
 * WHY THE PANEL IS MOUNTED ON ITS OWN RATHER THAN THROUGH App.jsx
 * ATSPanel only reaches its report body when a job is selected, a profile is active and a base
 * resume is uploaded — three prerequisites that would have to be faked through the API layer, and
 * each of which fails by rendering a DIFFERENT, plausible-looking panel. A stubbed board that shows
 * "Upload a profile resume" would screenshot cleanly and prove nothing. The component takes
 * `report` as a prop and does not fetch when it is given one, so it is mounted directly under the
 * real ThemeProvider — which is where the .rm-badge and .rm-section-label rules come from, so the
 * chips are the real chips.
 *
 * The two harness files it needs live in client/ for the duration of the run only, and are deleted
 * in the finally block. They are not part of the app.
 *
 * COSTS NOTHING, TOUCHES NOTHING. The database is opened readonly, every /api/* request is answered
 * from a stub, and every off-localhost request is aborted — no model is called and no font is
 * fetched. That is what makes it safe for scripts/verifyHarnesses.mjs to auto-discover.
 *
 * Usage:  node scripts/ag1AtsPanelUi.mjs
 *         AG1_KEEP_OPEN=1 node scripts/ag1AtsPanelUi.mjs   # leave the browser open to poke at
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'data', 'screenshots');
const PORT = 5198;                                   // abPanelUi owns 5199; these must not collide
const JOB_ID = 1974;                                 // OpenAI, "Software Engineer, Agent Productivity"
const PROFILE_ID = 6;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// The shapes that give a sentence fragment away. Taken from the fix's own rejector, deliberately:
// if the two ever disagree, the one that matters is the one a reader would apply, and this is it.
const PROSE_SHAPES = [
  /[;:!?]/,        // sentence punctuation inside a chip
  /\.\s/,          // a full stop with more sentence after it
  /[.,]$/,         // a chip that ends where the clause was cut
  /^(and|the|a|s)\s/i,  // the leading half of a phrase, or a possessive's orphaned "s"
];
const isProse = (chip) => PROSE_SHAPES.some(re => re.test(chip));

// ── The two reports, computed — never transcribed ─────────────────────────────────────────────
/**
 * The PRE-FIX scorer, relocated so it can be imported alongside the working tree's copy.
 *
 * WHICH REVISION, AND WHY NOT SIMPLY HEAD
 * "HEAD" was right for exactly as long as the fix was uncommitted. The moment it landed, HEAD's
 * scorer became the fixed one — and worse, it now imports ./skillVocabulary.js, which does not
 * exist beside a lone file dropped in the temp directory, so this crashed with ERR_MODULE_NOT_FOUND
 * instead of comparing anything. The BEFORE has to name the revision it means.
 *
 * So: the parent of the commit that introduced services/skillVocabulary.js — that file is the fix,
 * and its first appearance is the boundary. If it has no history yet (the fix is still
 * uncommitted), HEAD is the pre-fix revision and is used.
 *
 * Relative imports are followed and materialised from the SAME revision, so this keeps working
 * whichever side of the boundary the chosen revision falls on.
 */
function loadPreFixScorer() {
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });

  let rev = 'HEAD';
  try {
    const introduced = git('log', '--diff-filter=A', '--format=%H', '--', 'services/skillVocabulary.js')
      .toString().trim().split('\n').filter(Boolean).pop();
    if (introduced) rev = `${introduced}^`;
  } catch { /* no history for it — the fix is uncommitted, so HEAD is still the BEFORE */ }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ag1-prefix-${process.pid}-`));
  const written = new Set();

  const materialise = (name) => {
    if (written.has(name)) return;
    written.add(name);
    const src = git('show', `${rev}:services/${name}`).toString();
    // Imported as .mjs so node treats it as a module wherever the temp directory lives.
    fs.writeFileSync(path.join(dir, name.replace(/\.js$/, '.mjs')), src.replace(/(from\s+["']\.\/[^"']+)\.js(["'])/g, '$1.mjs$2'));
    for (const m of src.matchAll(/from\s+["']\.\/([^"']+\.js)["']/g)) materialise(m[1]);
  };
  materialise('localAtsScorer.js');

  return { url: pathToFileURL(path.join(dir, 'localAtsScorer.mjs')).href, tmp: dir, rev };
}

function loadInputs() {
  const dbPath = path.join(ROOT, 'data', 'resume_master.db');
  if (!fs.existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    const job = db.prepare('SELECT * FROM scraped_jobs WHERE id=?').get(JOB_ID);
    // An absent row would leave the panel rendering a report built from an empty description —
    // a blank, passing-looking screenshot. That is precisely the failure this harness exists to
    // rule out, so it is fatal rather than tolerated.
    if (!job) throw new Error(
      `scraped_jobs id=${JOB_ID} is missing. This harness screenshots the REAL OpenAI ` +
      `"Software Engineer, Agent Productivity" posting; without it there is nothing to verify. ` +
      `Re-import it, or point JOB_ID at another enriched posting with a long description.`);
    if (!job.description || job.description.length < 500) throw new Error(
      `scraped_jobs id=${JOB_ID} has no usable description (${(job.description || '').length} chars).`);
    const domainProfile = db.prepare('SELECT * FROM domain_profiles WHERE id=?').get(PROFILE_ID);
    if (!domainProfile) throw new Error(`domain_profiles id=${PROFILE_ID} is missing.`);
    const base = db.prepare('SELECT content FROM profile_base_resumes WHERE profile_id=?').get(PROFILE_ID);
    if (!base?.content) throw new Error(`profile_base_resumes for profile ${PROFILE_ID} is missing.`);
    return { job, domainProfile, resumeText: base.content };
  } finally { db.close(); }
}

async function buildReports() {
  const { job, domainProfile, resumeText } = loadInputs();
  // Deliberately EMPTY skills and keywords: the whole question is what the JOB DESCRIPTION
  // contributes to the term list, and a populated profile would seed the list from the other side.
  const signalProfile = { skills: [], keywords: [], yearsExperience: 4, structuredFacts: {} };

  const preFix = loadPreFixScorer();
  console.log(`before   scorer from ${preFix.rev}`);
  const modules = {
    before: await import(preFix.url),
    after: await import(pathToFileURL(path.join(ROOT, 'services', 'localAtsScorer.js')).href),
  };
  try { fs.rmSync(preFix.tmp, { recursive: true, force: true }); } catch {}

  const reports = {};
  for (const [which, M] of Object.entries(modules)) {
    // The SAME module builds the basis and scores against it. Crossing them would compare a
    // report neither version of the code has ever produced.
    const runtimeBasis = M.buildRuntimeAtsBasis({ resumeText, signalProfile, domainProfile });
    reports[which] = M.scoreAtsLocally({ job, runtimeBasis });
  }
  return { reports, job };
}

// ── The harness page: written into client/ for this run, deleted in the finally block ─────────
const HARNESS_HTML = path.join(ROOT, 'client', 'ag1-harness.html');
const HARNESS_JSX = path.join(ROOT, 'client', 'src', 'ag1Harness.jsx');

const HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>AG1 — ATS panel harness</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      /* The app's own body is transparent — it sits on a page background the shell paints. This
         page has no shell, and a transparent body screenshots as white behind dark-on-dark chips. */
      body { background: #0d0f12; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/ag1Harness.jsx"></script>
  </body>
</html>
`;

const JSX = `// AG1 harness entry — written by scripts/ag1AtsPanelUi.mjs, deleted when it finishes.
import { createRoot } from "react-dom/client";
import "./index.css";
import { ThemeProvider } from "./styles/theme.jsx";
import { ATSPanel } from "./panels/ATSPanel.jsx";

const which = new URLSearchParams(location.search).get("v") || "after";
const report = (window.__AG1_REPORTS__ || {})[which] || null;

createRoot(document.getElementById("root")).render(
  <ThemeProvider>
    <div data-ag1-variant={which} style={{ width: 900, background: "#0d0f12", paddingBottom: 24 }}>
      <div style={{ padding: "14px 16px 0", fontFamily: "system-ui, sans-serif",
                    fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase",
                    color: "#8b95a1" }}>
        {which === "before" ? "BEFORE — window-mined terms" : "AFTER — vocabulary-matched terms"}
        {" · "}{window.__AG1_JOB__ || ""}
      </div>
      <ATSPanel report={report} score={report && report.score} activeProfileId={${PROFILE_ID}} />
    </div>
  </ThemeProvider>
);
`;

// ── Vite dev server ──────────────────────────────────────────────────────────────────────────
function startVite() {
  return new Promise((resolve, reject) => {
    // vite's own bin, run under this node. Not `npx`: node on Windows refuses to spawn a .cmd shim
    // without shell:true, and shell:true would mean concatenating arguments into a command line.
    const proc = spawn(process.execPath,
      [path.join(ROOT, 'client', 'node_modules', 'vite', 'bin', 'vite.js'),
        '--port', String(PORT), '--strictPort'],
      { cwd: path.join(ROOT, 'client'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b) => {
      // Vite colours its banner, and it colours the PORT separately from the host — so the raw
      // bytes read "localhost:<ESC>[1m5198". Stripping only the bracket part leaves the ESC itself
      // sitting between the colon and the number, and /localhost:5198/ never matches. The escape
      // character has to go too.
      out += b.toString().replace(/\[[0-9;]*m/g, '').replace(//g, '');
      if (new RegExp(`localhost:${PORT}`).test(out)) resolve({ proc, url: `http://localhost:${PORT}` });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error(`vite did not start:\n${out.slice(-800)}`)), 60000);
  });
}

/** Anything not named here answers with a benign empty shape rather than a 404 storm. */
const API_FIXTURES = {
  [`/api/domain-profiles/${PROFILE_ID}/suggestions`]: { skills: [], action_verbs: [] },
  '/api/domain-profiles': [],
  '/api/auth/me': { authenticated: true, user: { id: 1, username: 'ada' } },
};
const API_FALLBACK = { ok: true, items: [], results: [], data: [] };

async function main() {
  console.log('=== AG1 — the local ATS report, on screen ===\n');
  fs.mkdirSync(SHOTS, { recursive: true });

  const { reports, job } = await buildReports();
  const label = `${job.company} — ${job.title}`;
  console.log(`posting  scraped_jobs #${JOB_ID}: ${label}`);
  const count = (r, k) => (r[k] || []).length;
  for (const which of ['before', 'after']) {
    const r = reports[which];
    console.log(`${which.padEnd(8)} score ${r.score}` +
      `  skills matched ${count(r, 'tier1_matched')}` +
      `  skills missing ${count(r, 'tier1_missing')}` +
      `  verbs matched ${count(r, 'action_verbs_matched')}` +
      `  verbs missing ${count(r, 'action_verbs_missing')}`);
  }
  console.log('');

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error('No Chrome binary.'); process.exit(1); }

  fs.writeFileSync(HARNESS_HTML, HTML);
  fs.writeFileSync(HARNESS_JSX, JSX);

  let vite = null;
  let browser = null;
  try {
    vite = await startVite();
    console.log(`vite     ${vite.url}\n`);

    browser = await puppeteer.launch({
      executablePath: resolution.path, headless: 'new', pipe: true,
      args: ['--no-first-run', '--no-default-browser-check'],
      defaultViewport: { width: 900, height: 1400, deviceScaleFactor: 2 },
    });

    const page = await browser.newPage();
    page.on('pageerror', e => console.log(`      [page error] ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') console.log(`      [console] ${m.text()}`); });

    await page.evaluateOnNewDocument((payload, jobLabel) => {
      window.__AG1_REPORTS__ = payload;
      window.__AG1_JOB__ = jobLabel;
      // The accent is picked at RANDOM per session, so two loads differ by a hue for reasons that
      // have nothing to do with the scorer. Pinning it makes the two PNGs comparable by eye.
      try { sessionStorage.setItem('rm_session_accent', 'sky'); } catch {}
    }, reports, label);

    await page.setRequestInterception(true);
    const served = new Set();
    page.on('request', (req) => {
      const url = new URL(req.url(), vite.url);
      // OFF-ORIGIN IS ABORTED, not continued. index.css opens with a Google Fonts @import, and a
      // harness that reaches the public internet is neither fast nor honest about what it tested.
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return req.abort();
      if (!url.pathname.startsWith('/api/')) return req.continue();
      served.add(url.pathname);
      // THE SSE STREAM IS LEFT HANGING, deliberately. useSyncEvents opens an EventSource that never
      // completes by design; answering it with JSON makes the browser reject the MIME type and the
      // hook reconnect on a timer, which floods the console for the whole run. An unanswered
      // request is what a healthy stream looks like from here.
      if (url.pathname === '/api/sync/events') return;
      const body = API_FIXTURES[url.pathname] ?? API_FALLBACK;
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    /** Read the chips out of the DOM, grouped by the section heading above them. */
    const readChips = () => page.evaluate(() => {
      const sections = {};
      const all = [];
      for (const heading of document.querySelectorAll('.rm-section-label')) {
        const chips = [...(heading.parentElement?.querySelectorAll('button.rm-badge') || [])]
          .map(b => b.innerText.trim()).filter(Boolean);
        if (!chips.length) continue;
        // Keyed by the LETTERS of the heading, lowercased. innerText returns the RENDERED text and
        // .rm-section-label is text-transform:uppercase, so a key of "Skills Missing" matches
        // nothing the DOM has ever contained — which reads as four zero counts over chips that are
        // plainly on screen.
        sections[heading.innerText.replace(/[^A-Za-z ]/g, '').trim().toLowerCase()] = chips;
        all.push(...chips);
      }
      return { sections, all };
    });

    const render = async (which) => {
      await page.goto(`${vite.url}/ag1-harness.html?v=${which}`,
        { waitUntil: 'networkidle2', timeout: 60000 });
      // Wait for the SECTION, not for a timer. An empty page screenshots perfectly happily, and a
      // harness that captures one has verified nothing at all — which is the single failure mode
      // this whole script is built to make impossible.
      const rendered = await page.waitForFunction(
        () => /Skills Missing/i.test(document.body.innerText), { timeout: 30000 })
        .then(() => true).catch(() => false);
      check(`AG1  the ${which.toUpperCase()} report actually rendered in the real panel`, rendered,
        rendered ? 'the "Skills Missing" section is on screen'
          : `body was: ${JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 200))}`);
      await sleep(400);
      const file = path.join(SHOTS, `ag1-ats-${which}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`      screenshot: ${file}`);
      return { chips: await readChips(), file };
    };

    const before = await render('before');
    const after = await render('after');
    check('AG1  the panel was driven against the stubbed API, not a live server',
      served.has(`/api/domain-profiles/${PROFILE_ID}/suggestions`), [...served].join(' '));

    // ── The counts, side by side ────────────────────────────────────────────────────────────
    const SECTIONS = ['skills matched', 'skills missing', 'verbs matched', 'verbs missing'];
    const sec = (side, s) => (side.chips.sections[s] || []);
    console.log('\n── chips on screen, by section ──');
    console.log(`${''.padEnd(16)}${'BEFORE'.padStart(8)}${'AFTER'.padStart(8)}`);
    for (const s of SECTIONS) {
      console.log(`${s.padEnd(16)}${String(sec(before, s).length).padStart(8)}` +
        `${String(sec(after, s).length).padStart(8)}`);
    }
    console.log('');

    // ── The assertions ──────────────────────────────────────────────────────────────────────
    console.log('── what the user reads ──');
    const beforeProse = before.chips.all.filter(isProse);
    const afterProse = after.chips.all.filter(isProse);

    // 1. THE HARNESS IS SHOWING THE DEFECT. Without this the other three checks would pass just as
    //    happily against a panel that renders nothing on either side.
    check('AG1  BEFORE really does put sentence fragments on screen',
      beforeProse.length > 0,
      beforeProse.length
        ? `${beforeProse.length} of ${before.chips.all.length}: ` +
          beforeProse.slice(0, 5).map(c => JSON.stringify(c)).join(', ')
        : 'no prose chips found — HEAD may no longer be the pre-fix scorer');

    // 2. and it is gone.
    check('AG1  AFTER shows no sentence fragment anywhere in the report',
      afterProse.length === 0,
      afterProse.length ? afterProse.map(c => JSON.stringify(c)).join(', ')
        : `all ${after.chips.all.length} chips are term-shaped`);

    // 3. The employer's own name was the most-read fragment of the lot — "missing: OpenAI" told a
    //    candidate to put the company they are applying to on their resume.
    const afterCompany = after.chips.all.filter(c => /openai/i.test(c));
    const beforeCompany = before.chips.all.filter(c => /openai/i.test(c));
    check('AG1  AFTER never reports the employer\'s own name as a missing skill',
      afterCompany.length === 0,
      afterCompany.length ? afterCompany.map(c => JSON.stringify(c)).join(', ')
        : `BEFORE had ${beforeCompany.length}: ` +
          (beforeCompany.slice(0, 3).map(c => JSON.stringify(c)).join(', ') || 'none'));

    // 4. PRECISION IS NOT SILENCE. Rejecting everything would satisfy checks 2 and 3 perfectly, and
    //    would be a worse panel than the one being fixed.
    check('AG1  AFTER still fills the report — the fix filters, it does not empty',
      after.chips.all.length > 0
      && sec(after, 'skills missing').length > 0
      && sec(after, 'verbs missing').length > 0,
      `${after.chips.all.length} chips across ${Object.keys(after.chips.sections).length} sections`);

    console.log(`\nBEFORE chips: ${JSON.stringify(before.chips.all)}`);
    console.log(`AFTER  chips: ${JSON.stringify(after.chips.all)}`);
    console.log(`\n  ${before.file}\n  ${after.file}`);

    if (process.env.AG1_KEEP_OPEN) {
      console.log('\nAG1_KEEP_OPEN set — leaving the browser open. Ctrl+C to finish.');
      await new Promise(() => {});
    }
  } finally {
    // The harness files are not part of the app and must not survive the run — including when it
    // throws, which is when a stray client/ag1-harness.html would be easiest to commit by accident.
    for (const f of [HARNESS_HTML, HARNESS_JSX]) { try { fs.unlinkSync(f); } catch {} }
    if (browser) await browser.close().catch(() => {});
    if (vite) vite.proc.kill();
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('\nHARNESS FAILED:', e); process.exit(1); });
