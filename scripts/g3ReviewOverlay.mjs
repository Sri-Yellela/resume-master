#!/usr/bin/env node
/**
 * TASK G3 — the provenance overlay, REAL-RUN verification.
 * ============================================================================================
 * The overlay's whole claim is that reviewing an application becomes ten seconds on three uncertain
 * fields instead of two minutes on thirty certain ones. That claim is about ORDER and about what
 * blocks "ready", so it can only be checked by rendering it over a real form and reading what a
 * candidate would actually see.
 *
 * Run against fakeAts's /gated/form — the page behind the sign-in wall, carrying the traps:
 *   - job_application[requires_sponsorship]   eligibility under an ATS's real namespacing
 *   - work_authorization                      eligibility, bare canonical name
 *   - org / "Current Company"                 fillable only by a LABEL match, i.e. a guess
 *   - authorized_no_sponsorship               the inversion trap: nothing may fill it
 *
 * Assertions:
 *   1. eligibility answers pin to the TOP, above lower-confidence non-eligibility ones
 *   2. a guess blocks "ready" until it is explicitly acknowledged
 *   3. acknowledging it unblocks, one field at a time
 *   4. an edit persists in the REAL input after the page re-reads it
 *   5. the inversion trap is never filled
 *   6. the overlay never submits, and nothing reaches the ATS
 *
 * Usage:  A1_RESUME=/path/to/any.pdf node scripts/g3ReviewOverlay.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';
import applyRoutes from '../routes/apply.js';
import { MIGRATIONS } from './migrations.js';
import { buildGatePacket } from '../services/applyGatePacket.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(os.tmpdir(), 'g3-review-overlay');
const ATS_PORT = 4599;
const PORTAL = `http://localhost:${ATS_PORT}`;
const RESUME_PDF = process.env.A1_RESUME;
if (!RESUME_PDF || !fs.existsSync(RESUME_PDF)) {
  console.error('Set A1_RESUME to an existing PDF path.'); process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

function startApi() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'PRO');
    CREATE TABLE user_profile (user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
      full_name TEXT, email TEXT, phone TEXT, custom_answers TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, title TEXT, company TEXT, url TEXT,
      apply_url TEXT, source TEXT, location TEXT);
    CREATE TABLE resumes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, job_id TEXT,
      apply_mode TEXT, ats_score INTEGER, html TEXT, updated_at INTEGER);
    CREATE TABLE apply_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, mode TEXT,
      approval_mode TEXT, tool_type TEXT, status TEXT, total_jobs INTEGER, held_count INTEGER DEFAULT 0,
      submitted_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()), started_at INTEGER, finished_at INTEGER);
    CREATE TABLE apply_run_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, user_id INTEGER,
      approved_at INTEGER, approved_from_run_job_id INTEGER, job_id TEXT, status TEXT,
      reason_code TEXT, reason_detail TEXT, started_at INTEGER, finished_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()), answers_json TEXT, resume_artifact_id INTEGER,
      resume_ats_score INTEGER, screenshot_path TEXT, submit_verified INTEGER, submit_evidence TEXT,
      open_questions_json TEXT, UNIQUE(run_id, job_id));
    CREATE TABLE apply_job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, run_job_id INTEGER,
      user_id INTEGER, job_id TEXT, level TEXT DEFAULT 'info', event TEXT, message TEXT,
      details_json TEXT, created_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE apply_idempotency (user_id INTEGER NOT NULL, idem_key TEXT NOT NULL, endpoint TEXT NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 200, response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (user_id, idem_key));
    CREATE TABLE job_applications (user_id INTEGER, job_id TEXT, company TEXT, role TEXT, job_url TEXT,
      source TEXT, location TEXT, apply_mode TEXT, resume_file TEXT, applied_at INTEGER, notes TEXT,
      auto_status TEXT, UNIQUE(user_id, job_id));
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT (unixepoch()));
    INSERT INTO users (id, username) VALUES (1, 'ada');
    INSERT INTO scraped_jobs (job_id, title, company, url, apply_url, source)
      VALUES ('g3job', 'Senior Engineer', 'GatedCo', '${PORTAL}/gated', '${PORTAL}/gated', 'ashby');
    INSERT INTO resumes (user_id, job_id, apply_mode, ats_score, html, updated_at)
      VALUES (1, 'g3job', 'TAILORED', 80, '<html><body>resume</body></html>', unixepoch());
    INSERT INTO apply_runs (id, user_id, mode, status, total_jobs) VALUES (1, 1, 'auto', 'completed', 1);
    INSERT INTO apply_run_jobs (id, run_id, user_id, job_id, status, reason_code, resume_artifact_id)
      VALUES (1, 1, 1, 'g3job', 'held_gate', 'login_required', 1);
  `);
  for (const id of ['079_apply_gate_packets', '080_apply_gate_review']) {
    db.exec(MIGRATIONS.find(m => m.id === id).sql);
  }

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const o = req.headers.origin;
    if (o) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Access-Control-Allow-Credentials', 'true'); }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use((req, _res, next) => { req.user = { id: 1, planTier: 'PRO' }; next(); });
  applyRoutes(app, db, (q, r, n) => n(), () => ({ field_map: {}, handler_map: {}, custom_answers: {} }),
    async () => ({ error: 'not_needed' }), async () => fs.readFileSync(RESUME_PDF), async () => ({}));
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ db, server }));
  });
}

function buildTestExtension(apiOrigin) {
  const src = path.join(ROOT, 'extension');
  const dst = path.join(OUT_DIR, 'extension');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'submission' || e.name === 'dist') continue;
      fs.cpSync(path.join(src, e.name), path.join(dst, e.name), { recursive: true });
    } else fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
  for (const f of ['background.js', 'config.js']) {
    const p = path.join(dst, f);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8')
      .replace(/const RESUME_MASTER_URL = 'https:\/\/resumemaster\.one';/, `const RESUME_MASTER_URL = '${apiOrigin}';`));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dst, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [...manifest.host_permissions, `${apiOrigin}/*`];
  fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { dir: dst, manifest };
}

const PS_SEND_HOTKEY = String.raw`
param([int]$BrowserPid)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace G3 -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(System.IntPtr h, bool alt);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
'@
function Resolve-Handle([int]$rootPid) {
  $p = Get-Process -Id $rootPid -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0) { return $p.MainWindowHandle }
  $procs = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId
  $desc = New-Object System.Collections.Generic.HashSet[int]
  $frontier = New-Object System.Collections.Generic.List[int]
  [void]$frontier.Add($rootPid)
  while ($frontier.Count -gt 0) {
    $cur = $frontier[0]; $frontier.RemoveAt(0)
    foreach ($c in $procs) { if ($c.ParentProcessId -eq $cur -and $desc.Add([int]$c.ProcessId)) { [void]$frontier.Add([int]$c.ProcessId) } }
  }
  foreach ($d in $desc) {
    $cp = Get-Process -Id $d -ErrorAction SilentlyContinue
    if ($cp -and $cp.MainWindowHandle -ne 0) { return $cp.MainWindowHandle }
  }
  return [System.IntPtr]::Zero
}
$h = Resolve-Handle $BrowserPid
if ($h -eq [System.IntPtr]::Zero) { Write-Output 'NO_WINDOW'; exit 3 }
$KEYUP = 2
for ($a = 1; $a -le 3; $a++) {
  if ($a -eq 1) {
    [G3.Win]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)
    [G3.Win]::keybd_event(0x12, 0, $KEYUP, [System.UIntPtr]::Zero)
    [void][G3.Win]::SetForegroundWindow($h)
  } elseif ($a -eq 2) { [G3.Win]::SwitchToThisWindow($h, $true) }
  else {
    [void][G3.Win]::ShowWindow($h, 6); Start-Sleep -Milliseconds 250
    [void][G3.Win]::ShowWindow($h, 9); [void][G3.Win]::SetForegroundWindow($h)
  }
  Start-Sleep -Milliseconds 500
  if ([G3.Win]::GetForegroundWindow() -eq $h) { break }
}
if ([G3.Win]::GetForegroundWindow() -ne $h) { Write-Output 'NOT_FOREGROUND'; exit 4 }
[G3.Win]::keybd_event(0x11, 0, 0, [System.UIntPtr]::Zero)
[G3.Win]::keybd_event(0x10, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[G3.Win]::keybd_event(0x59, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[G3.Win]::keybd_event(0x59, 0, $KEYUP, [System.UIntPtr]::Zero)
[G3.Win]::keybd_event(0x10, 0, $KEYUP, [System.UIntPtr]::Zero)
[G3.Win]::keybd_event(0x11, 0, $KEYUP, [System.UIntPtr]::Zero)
Write-Output 'SENT'
`;

function sendHotkey(pid) {
  const script = path.join(OUT_DIR, 'sendHotkey.ps1');
  fs.writeFileSync(script, PS_SEND_HOTKEY);
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-BrowserPid', String(pid)],
    { encoding: 'utf8', timeout: 30000 });
  return { ok: `${r.stdout || ''}`.includes('SENT'), out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('=== G3 — provenance overlay ===\n');

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error('No Chrome binary.'); process.exit(1); }

  const { db, server: apiServer } = await startApi();
  const apiOrigin = `http://127.0.0.1:${apiServer.address().port}`;

  let ats = null;
  const alive = await new Promise(res => {
    const rq = http.get(`${PORTAL}/gated/form`, r => { r.resume(); res(r.statusCode === 200); });
    rq.on('error', () => res(false)); rq.setTimeout(1500, () => { rq.destroy(); res(false); });
  });
  if (!alive) {
    ats = spawn(process.execPath, [path.join(ROOT, 'scripts', 'fakeAts.js')],
      { env: { ...process.env, PORT: String(ATS_PORT) }, stdio: 'ignore' });
    await sleep(1500);
  }
  await fetch(`${PORTAL}/_reset`, { method: 'POST' }).catch(() => {});

  // A profile that answers the eligibility questions and the label-only one, so the overlay has
  // something in every band.
  const packet = buildGatePacket({
    autofillPayload: {
      field_map: {
        first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', phone: '+1 555 0100',
        requires_sponsorship: 'No', work_authorization: 'Yes', current_company: 'Analytical Engines',
      },
      handler_map: {}, custom_answers: {},
    },
    applyUrl: `${PORTAL}/gated/form`, jobId: 'g3job', runId: 1, runJobId: 1, resumeArtifactId: 1,
    gateReason: 'login_required',
  });
  db.prepare(`INSERT INTO apply_gate_packets
    (user_id, run_id, run_job_id, job_id, apply_url, expected_origin, gate_reason, answers_json,
     resume_artifact_id, token_hash, expires_at)
    VALUES (1,1,1,'g3job',?,?,'login_required',?,1,'unminted:seed',0)`)
    .run(`${PORTAL}/gated/form`, PORTAL, JSON.stringify(packet));

  const ext = buildTestExtension(apiOrigin);
  const profile = path.join(OUT_DIR, 'profile');
  fs.rmSync(profile, { recursive: true, force: true });

  const browser = await puppeteer.launch({
    executablePath: resolution.path, headless: false, pipe: true, enableExtensions: true,
    userDataDir: profile,
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,1000'],
    defaultViewport: null,
  });

  try {
    const extensionId = await browser.installExtension(ext.dir);
    const control = await browser.newPage();
    await control.goto(`chrome-extension://${extensionId}/options.html`);

    const page = (await browser.pages())[0];
    await page.goto(`${PORTAL}/gated/form`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await sleep(400);

    const key = sendHotkey(browser.process().pid);
    if (!key.ok) console.log(`  hotkey failed (${key.out}) — press Ctrl+Shift+Y manually, 45s`);
    let result = null;
    const deadline = Date.now() + (key.ok ? 20000 : 45000);
    while (Date.now() < deadline && !result) {
      result = (await control.evaluate(() => chrome.storage.session.get('lastGatedHandoff')))?.lastGatedHandoff;
      if (!result) await sleep(400);
    }
    check('the handoff ran', result?.ok === true, result?.message || result?.reason || 'no result');
    check('the overlay rendered', result?.overlay?.rendered === true, JSON.stringify(result?.overlay));

    // ── 1. order ───────────────────────────────────────────────────────────
    console.log('\n── order is the feature ──');
    const sections = await page.evaluate(() => {
      const root = document.getElementById('rm-gate-review-overlay');
      if (!root) return null;
      return [...root.querySelectorAll('.rm-sec')].map(sec => ({
        title: sec.querySelector('.rm-lbl')?.textContent?.trim()
            || sec.querySelector('summary')?.textContent?.trim().replace(/\s+/g, ' ') || '(disclosure)',
        fields: [...sec.querySelectorAll('.rm-row .rm-f')].map(f => f.textContent.trim()),
      }));
    });
    check('the overlay is on the page', !!sections, sections ? `${sections.length} sections` : 'absent');
    console.log(JSON.stringify(sections, null, 1));

    const firstSection = sections?.[0];
    check('ELIGIBILITY IS THE FIRST SECTION, above everything else',
      /eligibility/i.test(firstSection?.title || ''), firstSection?.title);
    check('both eligibility answers are in it', (firstSection?.fields.length || 0) === 2,
      firstSection?.fields.join(' | '));
    check('the low-confidence band comes next',
      /worth checking/i.test(sections?.[1]?.title || ''), sections?.[1]?.title);
    check('the certain fields are collapsed behind a disclosure',
      sections?.some(s => /resolved exactly/i.test(s.title)),
      sections?.map(s => s.title).join(' / '));

    // ── 2 & 3. a guess blocks ready until acknowledged ─────────────────────
    console.log('\n── readiness ──');
    const stateOf = () => page.evaluate(() =>
      document.querySelector('#rm-gate-review-overlay [data-role="state"]')?.textContent?.trim());
    const before = await stateOf();
    check('a guess blocks "ready"', /not ready/i.test(before || ''), before);
    check('the blocking count is reported', /\d+\s+guess/i.test(before || ''), before);

    const ackCount = await page.evaluate(() =>
      document.querySelectorAll('#rm-gate-review-overlay [data-role="ack"]').length);
    check('every guess has its own acknowledge control', ackCount >= 1, `${ackCount} acknowledge buttons`);

    // Acknowledge them one at a time — approving in bulk is exactly what the overlay replaces.
    for (let i = 0; i < ackCount; i++) {
      await page.evaluate(() => {
        const b = document.querySelector('#rm-gate-review-overlay [data-role="ack"]:not([disabled])');
        b?.click();
      });
      await sleep(250);
    }
    const after = await stateOf();
    check('acknowledging every guess makes it ready', /^ready/i.test(after || ''), after);

    // ── 4. an edit reaches the real input ──────────────────────────────────
    console.log('\n── editing ──');
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#rm-gate-review-overlay .rm-row')];
      const row = rows.find(r => /first name/i.test(r.querySelector('.rm-f')?.textContent || ''));
      row.querySelector('[data-role="edit"]').click();
      const input = row.querySelector('[data-role="input"]');
      input.value = 'Augusta';
      row.querySelector('[data-role="edit"]').click();
    });
    await sleep(1200);
    const edited = await page.evaluate(() => {
      const el = document.querySelector('[name="first_name"]');
      // Read it the way the page's own code would, after prodding it to re-read.
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    });
    check('the edit reached the REAL input and survived a re-read', edited === 'Augusta', `value=${edited}`);

    // ── 5. the inversion trap ──────────────────────────────────────────────
    console.log('\n── the inversion trap ──');
    const trap = await page.evaluate(() => {
      const el = document.querySelector('[name="authorized_no_sponsorship"]');
      return { checked: el?.checked, exists: !!el };
    });
    check('the inverted checkbox was never touched', trap.exists && trap.checked === false,
      JSON.stringify(trap));
    const sponsorship = await page.evaluate(() =>
      document.querySelector('[name="job_application[requires_sponsorship]"]')?.value);
    check('the sponsorship question itself WAS answered, under its ATS namespacing',
      sponsorship === 'No', `value=${sponsorship}`);

    // ── 6. nothing was submitted ───────────────────────────────────────────
    console.log('\n── the overlay never submits ──');
    const subs = await fetch(`${PORTAL}/_submissions`).then(r => r.json());
    check('NOTHING reached the ATS', subs.count === 0, `count=${subs.count}`);

    // ── req 6. the review is on the audit row ──────────────────────────────
    console.log('\n── the audit record ──');
    await sleep(800);
    const row = db.prepare('SELECT gate_review_json FROM apply_run_jobs WHERE id=1').get();
    const review = row?.gate_review_json ? JSON.parse(row.gate_review_json) : null;
    check('the candidate\'s review is recorded against the application', !!review,
      review ? `ready=${review.ready} ack=${review.acknowledgedCount} edited=${review.editedCount}` : 'absent');
    check('it records what was acknowledged', (review?.acknowledgedCount || 0) >= 1);
    check('it records that a field was corrected', (review?.editedCount || 0) >= 1);
    check('it does NOT store the corrected VALUE, only that it changed',
      !JSON.stringify(review || {}).includes('Augusta'),
      'the value goes to the employer either way; the audit question is what changed');

  } finally {
    await browser.close().catch(() => {});
    apiServer.close();
    db.close();
    if (ats) ats.kill();
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('\nHARNESS FAILED:', e); process.exit(1); });
