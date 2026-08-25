#!/usr/bin/env node
/**
 * TASK AH3 — the ATS panel, before and after the term-category split. SCREENSHOTS.
 * ============================================================================================
 * The analysis half is scripts/ah3TermQuality.mjs, which asserts term quality across all 1,291
 * enriched postings and runs inside verifyHarnesses. This is the other half: it renders the real
 * ATSPanel with the real report for the reported posting and photographs it, because a category
 * that exists only in the JSON is not a fix.
 *
 * EXCLUDED from the auto-discovered suite, along with ah1IdentityShots and ah2MultiTab, for the
 * reason recorded there: a 28th Chrome-launching harness pushed this box past its desktop-heap
 * limit and every harness after it died with STATUS_DLL_INIT_FAILED having run no assertions.
 *
 * Every request is served from a stub and every off-localhost request is aborted: no model is
 * called and no font is fetched.
 *
 * Usage:  node scripts/ah3TermPanelShots.mjs
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
const SHOTS = path.join(ROOT, 'data', 'screenshots', 'ah3');
const PORT = 5197;                                   // ag1 owns 5198, abPanelUi owns 5199
const JOB_KEY = 'ashby::e32799d2-8ef8-4803-8189-c72514afa816';  // Notion, Software Engineer, New Grad
const PROFILE_ID = 6;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// ── the pre-AH3 scorer, for a before/after that is COMPUTED, never transcribed ────────────────
function loadPreFixScorer() {
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  // Named by the change itself: the parent of the commit that introduced the competencies bucket.
  // While AH3 is uncommitted that commit does not exist and HEAD is still the BEFORE, which is
  // exactly what "the revision before this change" means in both states.
  let rev = 'HEAD';
  try {
    const introduced = git('log', '-S', 'competencies_matched', '--format=%H', '--',
      'services/localAtsScorer.js').toString().trim().split('\n').filter(Boolean).pop();
    if (introduced) rev = `${introduced}^`;
  } catch { /* no history yet — HEAD is the pre-fix revision */ }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ah3-prefix-${process.pid}-`));
  const written = new Set();
  const materialise = (name) => {
    if (written.has(name)) return;
    written.add(name);
    const src = git('show', `${rev}:services/${name}`).toString();
    fs.writeFileSync(path.join(dir, name.replace(/\.js$/, '.mjs')),
      src.replace(/(from\s+["']\.\/[^"']+)\.js(["'])/g, '$1.mjs$2'));
    for (const m of src.matchAll(/from\s+["']\.\/([^"']+\.js)["']/g)) materialise(m[1]);
  };
  materialise('localAtsScorer.js');
  return { url: pathToFileURL(path.join(dir, 'localAtsScorer.mjs')).href, tmp: dir, rev };
}

function openDb() {
  const dbPath = path.join(ROOT, 'data', 'resume_master.db');
  if (!fs.existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  return new Database(dbPath, { readonly: true });
}

const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();
const softOf = (job) => {
  let list = []; try { list = JSON.parse(job.skills_json || '[]'); } catch {}
  return new Set(list.filter(e => e?.type === 'soft').map(e => norm(e.skill)).filter(Boolean));
};
const hardOf = (job) => {
  let list = []; try { list = JSON.parse(job.skills_json || '[]'); } catch {}
  return new Set(list.filter(e => e?.type !== 'soft').map(e => norm(e.skill)).filter(Boolean));
};

const db = openDb();
const job = db.prepare('SELECT * FROM scraped_jobs WHERE job_id=?').get(JOB_KEY);
if (!job) {
  console.log(`FAIL  the reported posting ${JOB_KEY} is not in scraped_jobs — nothing to verify`);
  process.exit(1);
}
const domainProfile = db.prepare('SELECT * FROM domain_profiles WHERE id=?').get(PROFILE_ID);
const base = db.prepare('SELECT content FROM profile_base_resumes WHERE profile_id=?').get(PROFILE_ID);
if (!domainProfile || !base?.content) {
  console.log(`FAIL  profile ${PROFILE_ID} or its base resume is missing`);
  process.exit(1);
}
// The REAL extracted signals for this profile. This is the half that produced "provided" and
// "science", so scoring against an empty signal set would verify the fix on inputs that never
// showed the defect.
const sig = db.prepare('SELECT * FROM profile_simple_apply_profiles WHERE profile_id=?').get(PROFILE_ID);
const signalProfile = sig ? {
  skills: JSON.parse(sig.skills_json || '[]'),
  keywords: JSON.parse(sig.keywords_json || '[]'),
  titles: JSON.parse(sig.titles_json || '[]'),
  yearsExperience: sig.years_experience,
} : { skills: [], keywords: [], yearsExperience: 4, structuredFacts: {} };

const preFix = loadPreFixScorer();
const AFTER = await import(pathToFileURL(path.join(ROOT, 'services', 'localAtsScorer.js')).href);
const BEFORE = await import(preFix.url);
try { fs.rmSync(preFix.tmp, { recursive: true, force: true }); } catch {}

const scoreWith = (M, j) => M.scoreAtsLocally({
  job: j,
  runtimeBasis: M.buildRuntimeAtsBasis({ resumeText: base.content, signalProfile, domainProfile }),
});
const before = scoreWith(BEFORE, job);
const after = scoreWith(AFTER, job);

// ── the panel ──────────────────────────────────────────────────────────────────────────────
console.log('── THE PANEL RENDERS THE NEW BUCKETS ───────────────────────────────────────────');
const HARNESS_HTML = path.join(ROOT, 'client', 'ah3-harness.html');
const HARNESS_JSX = path.join(ROOT, 'client', 'src', 'ah3Harness.jsx');
const HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><title>AH3 — ATS term quality</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d0f12}
@keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body><div id="root"></div><script type="module" src="/src/ah3Harness.jsx"></script></body></html>
`;
const JSX = `// AH3 harness entry — written by scripts/ah3TermQuality.mjs, deleted when it finishes.
import { createRoot } from "react-dom/client";
import "./index.css";
import { ThemeProvider } from "./styles/theme.jsx";
import { ATSPanel } from "./panels/ATSPanel.jsx";

const which = new URLSearchParams(location.search).get("v") || "after";
const report = (window.__AH3_REPORTS__ || {})[which] || null;

createRoot(document.getElementById("root")).render(
  <ThemeProvider>
    <div data-ah3-variant={which} style={{ width: 900, background: "#0d0f12", paddingBottom: 24 }}>
      <div style={{ padding: "14px 16px 0", fontFamily: "system-ui, sans-serif", fontSize: 12,
                    letterSpacing: "0.12em", textTransform: "uppercase", color: "#8b95a1" }}>
        {which === "before"
          ? "BEFORE — competencies filed as skills, generic verbs as gaps"
          : "AFTER — skills, competencies and generic language, each in its own bucket"}
        {" \\u00b7 "}{window.__AH3_JOB__ || ""}
      </div>
      <ATSPanel report={report} score={report && report.score} activeProfileId={${PROFILE_ID}} />
    </div>
  </ThemeProvider>
);
`;

function startVite() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath,
      [path.join(ROOT, 'client', 'node_modules', 'vite', 'bin', 'vite.js'),
        '--port', String(PORT), '--strictPort'],
      { cwd: path.join(ROOT, 'client'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b) => {
      out += b.toString().replace(/\[[0-9;]*m/g, '').replace(//g, '');
      if (new RegExp(`localhost:${PORT}`).test(out)) resolve({ proc, url: `http://localhost:${PORT}` });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error(`vite did not start:\n${out.slice(-800)}`)), 60000);
  });
}
const API_FIXTURES = {
  [`/api/domain-profiles/${PROFILE_ID}/suggestions`]: { skills: [], action_verbs: [] },
  '/api/domain-profiles': [],
  '/api/auth/me': { authenticated: true, user: { id: 1, username: 'ada' } },
};
const API_FALLBACK = { ok: true, items: [], results: [], data: [] };

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
    // fullPage captures the whole report regardless, so the viewport only sets the width. A tall
    // one here produced 1800x3000 PNGs that were mostly empty space below the content.
    defaultViewport: { width: 900, height: 900, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log(`      [page error] ${e.message}`));
  await page.evaluateOnNewDocument((payload, label) => {
    window.__AH3_REPORTS__ = payload;
    window.__AH3_JOB__ = label;
    try { sessionStorage.setItem('rm_session_accent', 'sky'); } catch {}
  }, { before, after }, `${job.company} — ${job.title}`);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url(), vite.url);
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return req.abort();
    if (!url.pathname.startsWith('/api/')) return req.continue();
    if (url.pathname === '/api/sync/events') return;
    req.respond({ status: 200, contentType: 'application/json',
      body: JSON.stringify(API_FIXTURES[url.pathname] ?? API_FALLBACK) });
  });

  const readSections = () => page.evaluate(() => {
    const out = {};
    for (const heading of document.querySelectorAll('.rm-section-label')) {
      const chips = [...(heading.parentElement?.querySelectorAll('button.rm-badge') || [])]
        .map(b => b.innerText.trim()).filter(Boolean);
      if (!chips.length) continue;
      out[heading.innerText.replace(/[^A-Za-z ]/g, '').trim().toLowerCase()] = chips;
    }
    return out;
  });

  for (const which of ['before', 'after']) {
    await page.goto(`${vite.url}/ah3-harness.html?v=${which}`, { waitUntil: 'networkidle2', timeout: 60000 });
    // Wait for a SECTION, not a timer. An empty page screenshots perfectly happily.
    await page.waitForFunction(() => document.querySelectorAll('.rm-section-label').length > 0,
      { timeout: 30000 }).catch(() => {});
    await sleep(600);
    const sections = await readSections();
    if (which === 'after') {
      const keys = Object.keys(sections);
      check('the panel renders a COMPETENCIES section', keys.some(k => k.includes('competencies')), keys.join(', '));
      check('the panel renders a GENERIC LANGUAGE section', keys.some(k => k.includes('generic language')), keys.join(', '));
      const skillsMissing = sections['skills missing'] || [];
      check('no competency is left in the on-screen Skills Missing list',
        !skillsMissing.some(c => /problem|curiosity|collaboration/i.test(c)), skillsMissing.join(' | '));
      const verbsMissing = sections['verbs missing'] || [];
      check('no generic verb is left in the on-screen Verbs Missing list',
        !verbsMissing.some(c => /^(deliver|manage|own|drove|drive|partner)/i.test(c)), verbsMissing.join(' | '));
      // A category the JSON has and the panel does not is the same defect as not fixing it.
      const compChips = Object.entries(sections).filter(([k]) => k.includes('competencies')).flatMap(([, v]) => v);
      check('the competencies on screen are the ones the report computed',
        compChips.length === (after.competencies_matched.length + after.competencies_missing.length),
        `${compChips.length} on screen`);
    }
    const file = path.join(SHOTS, `${which === 'before' ? '1-before' : '2-after'}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`  shot  ${path.relative(ROOT, file)}`);
  }

  // ── AG2's copy, untouched ────────────────────────────────────────────────────────────────
  const panelSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'panels', 'ATSPanel.jsx'), 'utf8');
  for (const sentence of [
    'Claiming a term says it is true of you',
    'never rewrites one you already have',
    'It does not change this score',
  ]) {
    check(`AG2 copy kept: "${sentence}"`, panelSrc.includes(sentence));
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  // Kill the TREE. vite spawns esbuild children, and killing only the node parent orphans them;
  // enough orphans and the next process to start fails with a Windows DLL-init error rather than
  // anything that names the cause.
  if (vite?.proc?.pid) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(vite.proc.pid), '/T', '/F'], { stdio: 'ignore' });
      else vite.proc.kill();
    } catch { try { vite.proc.kill(); } catch {} }
  }
  for (const f of [HARNESS_HTML, HARNESS_JSX]) { try { fs.rmSync(f, { force: true }); } catch {} }
}

console.log('\n' + '='.repeat(96));
console.log(failures ? `${failures} FAILED` : `all checks passed — shots in ${path.relative(ROOT, SHOTS)}`);
console.log('='.repeat(96));
process.exit(failures ? 1 : 0);
