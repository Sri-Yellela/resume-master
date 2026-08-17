#!/usr/bin/env node
/**
 * TASK G2 — the extension handoff, REAL-RUN verification.
 * ============================================================================================
 * The candidate has crossed a gate themselves and is standing on the application form. They invoke
 * the extension; everything the server prepared lands in the form. Nothing here submits.
 *
 * This is a real browser, the real extension, and a real activeTab grant taken by a real OS-level
 * keypress — the same machinery G0 built, for the same reason: there is no way to fake the grant.
 *
 * WHAT THE ORIGIN SPLIT IS FOR
 * The API server runs on 127.0.0.1 and the portal on localhost. Those are DIFFERENT ORIGINS to
 * Chrome even though both are this machine. That matters: the extension needs a host permission to
 * call our API, and if the API and the portal shared an origin, that permission would also grant
 * access to the portal — and every assertion below would pass without activeTab being involved at
 * all. The portal stays reachable ONLY through the grant, which is the property under test.
 *
 * Assertions:
 *   1. invoking on the prepared portal fills the mapped fields
 *   2. the resume registers in the PAGE's own file input, not merely as a property we set
 *   3. an ORIGIN MISMATCH releases NOTHING — and does not spend the token
 *   4. values survive a React-style re-render (the native setter path)
 *   5. eligibility answers are never placed by a fuzzy label match
 *   6. the packet is gone from chrome.storage.session after the tab closes
 *   7. the existing capture path and the popup are untouched
 *
 * Usage:  A1_RESUME=/path/to/any.pdf node scripts/g2ExtensionHandoff.mjs
 *         (starts its own fakeAts and its own API server)
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(os.tmpdir(), 'g2-extension-handoff');
const ATS_PORT = 4599;
const PORTAL = `http://localhost:${ATS_PORT}`;          // the "gated portal" — activeTab only
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

// ── API server on 127.0.0.1 ──────────────────────────────────────────────────────────────────
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
      VALUES ('g2job', 'Senior Engineer', 'GatedCo', '${PORTAL}/multistep', '${PORTAL}/multistep', 'ashby');
    INSERT INTO resumes (user_id, job_id, apply_mode, ats_score, html, updated_at)
      VALUES (1, 'g2job', 'TAILORED', 80, '<html><body>resume</body></html>', unixepoch());
    INSERT INTO apply_runs (id, user_id, mode, status, total_jobs) VALUES (1, 1, 'auto', 'completed', 1);
    INSERT INTO apply_run_jobs (id, run_id, user_id, job_id, status, reason_code, resume_artifact_id)
      VALUES (1, 1, 1, 'g2job', 'held_gate', 'login_required', 1);
  `);
  db.exec(MIGRATIONS.find(m => m.id === '079_apply_gate_packets').sql);

  const app = express();
  app.use(express.json());
  // CORS for the extension's credentialed fetches. A real deployment is same-site; here the
  // extension origin is chrome-extension://<id>, so it has to be reflected explicitly.
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

  // Resolved on 'listening': address() is null until then, and reading .port straight after
  // listen() returns null rather than throwing, so the failure surfaces far from its cause.
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ db, server }));
  });
}

// ── The extension copy, with the dev switch flipped ──────────────────────────────────────────
// extension/ is NOT modified. The copy points at the local API and gains a host permission for
// 127.0.0.1 ONLY — never for localhost, which is the portal. If that line ever reads `localhost`,
// every assertion below passes for the wrong reason and the run is void.
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
    let t = fs.readFileSync(p, 'utf8');
    t = t.replace(/const RESUME_MASTER_URL = 'https:\/\/resumemaster\.one';/,
                  `const RESUME_MASTER_URL = '${apiOrigin}';`);
    fs.writeFileSync(p, t);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(dst, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [...manifest.host_permissions, `${apiOrigin}/*`];
  fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const coversPortal = manifest.host_permissions.some(h => /\/\/(\*\.)?localhost/.test(h) || h.includes('<all_urls>'));
  return { dir: dst, manifest, coversPortal };
}

// ── The gesture ──────────────────────────────────────────────────────────────────────────────
// Ctrl+Shift+Y, delivered as a real OS key event to the Chrome window we launched, located by
// process rather than by title. Same approach and same safety check as scripts/g0ActiveTabSpike.mjs:
// it refuses to send if that window is not already foreground.
const PS_SEND_HOTKEY = String.raw`
param([int]$BrowserPid)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace G2 -Name Win -MemberDefinition @'
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
    foreach ($c in $procs) {
      if ($c.ParentProcessId -eq $cur -and $desc.Add([int]$c.ProcessId)) { [void]$frontier.Add([int]$c.ProcessId) }
    }
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
    [G2.Win]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)
    [G2.Win]::keybd_event(0x12, 0, $KEYUP, [System.UIntPtr]::Zero)
    [void][G2.Win]::SetForegroundWindow($h)
  } elseif ($a -eq 2) { [G2.Win]::SwitchToThisWindow($h, $true) }
  else {
    [void][G2.Win]::ShowWindow($h, 6); Start-Sleep -Milliseconds 250
    [void][G2.Win]::ShowWindow($h, 9); [void][G2.Win]::SetForegroundWindow($h)
  }
  Start-Sleep -Milliseconds 500
  if ([G2.Win]::GetForegroundWindow() -eq $h) { break }
}
if ([G2.Win]::GetForegroundWindow() -ne $h) { Write-Output 'NOT_FOREGROUND'; exit 4 }
[G2.Win]::keybd_event(0x11, 0, 0, [System.UIntPtr]::Zero)
[G2.Win]::keybd_event(0x10, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[G2.Win]::keybd_event(0x59, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[G2.Win]::keybd_event(0x59, 0, $KEYUP, [System.UIntPtr]::Zero)
[G2.Win]::keybd_event(0x10, 0, $KEYUP, [System.UIntPtr]::Zero)
[G2.Win]::keybd_event(0x11, 0, $KEYUP, [System.UIntPtr]::Zero)
Write-Output 'SENT'
`;

function sendHotkey(browserPid) {
  const script = path.join(OUT_DIR, 'sendHotkey.ps1');
  fs.writeFileSync(script, PS_SEND_HOTKEY);
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-BrowserPid', String(browserPid)],
    { encoding: 'utf8', timeout: 30000 });
  return { ok: `${r.stdout || ''}`.includes('SENT'), out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

// ── Run ──────────────────────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('=== G2 — extension handoff via activeTab ===\n');

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error('No Chrome binary.'); process.exit(1); }

  const { db, server: apiServer } = await startApi();
  const apiOrigin = `http://127.0.0.1:${apiServer.address().port}`;
  console.log(`api      ${apiOrigin}   (host permission granted — NOT the portal)`);
  console.log(`portal   ${PORTAL}   (activeTab only — no host permission)\n`);

  let ats = null;
  const alive = await new Promise(res => {
    const rq = http.get(`${PORTAL}/multistep`, r => { r.resume(); res(r.statusCode === 200); });
    rq.on('error', () => res(false)); rq.setTimeout(1500, () => { rq.destroy(); res(false); });
  });
  if (!alive) {
    ats = spawn(process.execPath, [path.join(ROOT, 'scripts', 'fakeAts.js')],
      { env: { ...process.env, PORT: String(ATS_PORT) }, stdio: 'ignore' });
    await sleep(1500);
  }

  const ext = buildTestExtension(apiOrigin);
  if (ext.coversPortal) {
    console.error('ABORT: a host permission covers the portal origin. activeTab would not be exercised.');
    process.exit(1);
  }
  check('the extension asks for NO host permission on the portal origin', !ext.coversPortal,
    ext.manifest.host_permissions.join(' '));
  check('externally_connectable is still absent — nothing pushes inward',
    !('externally_connectable' in ext.manifest));
  check('the manifest still asks only for activeTab, scripting and storage',
    JSON.stringify(ext.manifest.permissions) === JSON.stringify(['activeTab', 'scripting', 'storage']),
    ext.manifest.permissions.join(', '));

  // Seed a packet through the real endpoint path by inserting the row the server would have written.
  const { buildGatePacket } = await import('../services/applyGatePacket.js');
  const packet = buildGatePacket({
    autofillPayload: {
      field_map: {
        first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', phone: '+1 555 0100',
        address_line1: '12 Analytical Way', city: 'Boston', state: 'MA', zip: '02115',
        country: 'United States', linkedin_url: 'https://linkedin.com/in/ada',
        requires_sponsorship: 'No', work_authorization: 'Yes',
      },
      handler_map: {}, custom_answers: {},
    },
    applyUrl: `${PORTAL}/multistep`, jobId: 'g2job', runId: 1, runJobId: 1, resumeArtifactId: 1,
    gateReason: 'login_required',
  });
  db.prepare(`INSERT INTO apply_gate_packets
    (user_id, run_id, run_job_id, job_id, apply_url, expected_origin, gate_reason, answers_json,
     resume_artifact_id, token_hash, expires_at)
    VALUES (1,1,1,'g2job',?,?,'login_required',?,1,'unminted:seed',0)`)
    .run(`${PORTAL}/multistep`, PORTAL, JSON.stringify(packet));
  console.log(`\nseeded packet: ${packet.answers.length} answers for ${PORTAL}\n`);

  // Wiped every run. A reused profile keeps the PREVIOUSLY installed copy of the extension, so a
  // source change silently does not take effect and the run reports on code that is no longer here.
  const profile = path.join(OUT_DIR, 'profile');
  fs.rmSync(profile, { recursive: true, force: true });

  const browser = await puppeteer.launch({
    executablePath: resolution.path, headless: false, pipe: true, enableExtensions: true,
    userDataDir: profile,
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1200,950'],
    defaultViewport: null,
  });

  try {
    const extensionId = await browser.installExtension(ext.dir);
    // Surface the service worker's own console: a failed fetch inside it is otherwise invisible.
    const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 }).catch(() => null);
    const sw = swTarget ? await swTarget.worker().catch(() => null) : null;
    if (sw) sw.on('console', m => console.log(`      [sw] ${m.text()}`));
    const control = await browser.newPage();
    await control.goto(`chrome-extension://${extensionId}/g2-noop.html`).catch(() => {});
    // The options page is a real extension page and needs no new file to act as a control surface.
    await control.goto(`chrome-extension://${extensionId}/options.html`);
    const cmds = await control.evaluate(() => chrome.commands.getAll());
    const bound = cmds.find(c => c.name === 'fill-gated-application');
    check('the new command is bound to a key', !!bound?.shortcut, bound?.shortcut || 'UNBOUND');
    check('the existing capture-job command still exists',
      !!cmds.find(c => c.name === 'capture-job')?.shortcut);
    if (!bound?.shortcut) throw new Error('no keyboard binding — no gesture can be delivered');

    const page = (await browser.pages())[0];
    const lastResult = async () =>
      (await control.evaluate(() => chrome.storage.session.get('lastGatedHandoff')))?.lastGatedHandoff;
    const invoke = async () => {
      await control.evaluate(() => chrome.storage.session.remove('lastGatedHandoff'));
      await page.bringToFront();
      await sleep(400);
      const key = sendHotkey(browser.process().pid);
      if (!key.ok) { console.log(`  hotkey failed (${key.out}) — press Ctrl+Shift+Y manually, 45s`); }
      const deadline = Date.now() + (key.ok ? 15000 : 45000);
      while (Date.now() < deadline) {
        const r = await lastResult();
        if (r) return r;
        await sleep(400);
      }
      return null;
    };

    // ── 3. origin mismatch releases NOTHING ────────────────────────────────
    // Run FIRST, while the packet is still unconsumed: if a mismatch spent the token, everything
    // after would fail and the cause would be invisible.
    console.log('\n── origin mismatch ──');
    await page.goto(`http://127.0.0.1:${ATS_PORT}/multistep`, { waitUntil: 'domcontentloaded' });
    const mismatch = await invoke();
    // The REASON matters, not just the refusal: an unreachable server also refuses, and a harness
    // that accepts any refusal here would report a passing origin check that never ran.
    check('a mismatched origin refuses because of the ORIGIN, not for some other reason',
      mismatch?.ok === false && mismatch.reason === 'origin_mismatch',
      mismatch ? `${mismatch.reason}: ${mismatch.message} ${mismatch.detail || ''}` : 'no result');
    const leaked = await page.evaluate(() =>
      [...document.querySelectorAll('input,select,textarea')].map(e => e.value).join('|'));
    check('NOTHING was written into the page on a mismatch', !/Ada|Lovelace|Analytical|ada@/.test(leaked),
      `values=${JSON.stringify(leaked).slice(0, 80)}`);
    check('the token was NOT spent on a mismatch',
      db.prepare('SELECT consumed_at c FROM apply_gate_packets WHERE id=1').get().c === null);

    // ── 1 & 2. the real handoff ────────────────────────────────────────────
    console.log('\n── the handoff ──');
    await page.goto(`${PORTAL}/multistep`, { waitUntil: 'domcontentloaded' });
    const result = await invoke();
    check('the handoff ran', !!result && result.ok === true,
      result ? `${result.reason || ''} ${result.message || ''} ${result.detail || ''}`.trim() : 'no result');
    check('fields were filled', (result?.filled?.length || 0) > 0, `${result?.filled?.length} filled`);

    const values = await page.evaluate(() => {
      const g = n => document.querySelector(`[name="${n}"]`)?.value ?? null;
      return { first: g('first_name'), last: g('last_name'), email: g('email') };
    });
    check('first name reached the real input', values.first === 'Ada', JSON.stringify(values));
    check('last name reached the real input', values.last === 'Lovelace');
    check('email reached the real input', values.email === 'ada@example.com');
    check('the packet was consumed exactly once',
      db.prepare('SELECT consumed_at c FROM apply_gate_packets WHERE id=1').get().c !== null);

    // ── 4. the native setter survives a re-render ──────────────────────────
    console.log('\n── React-style re-render ──');
    // Simulates what a controlled component does on re-render: read the node's value back. A fill
    // that only set a JS property, or that left a framework's tracker stale, loses it here.
    const afterRerender = await page.evaluate(() => {
      const el = document.querySelector('[name="first_name"]');
      const snapshot = el.value;                                   // what a framework would read
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { snapshot, still: el.value };
    });
    check('the value is readable by the page itself, not just set as a property',
      afterRerender.snapshot === 'Ada' && afterRerender.still === 'Ada', JSON.stringify(afterRerender));

    // ── 5. eligibility is never fuzzy-matched ──────────────────────────────
    console.log('\n── eligibility ──');
    // /multistep step 1 has no eligibility control, so both eligibility answers must come back
    // unmatched rather than being pushed into some field whose label merely looked similar.
    const eligUnmatched = (result?.unmatched || []).filter(u => u.eligibility);
    check('eligibility answers with no exact control are reported, not placed',
      eligUnmatched.length === 2, eligUnmatched.map(u => `${u.name}:${u.reason}`).join(', '));

    // ── 2. the resume in the page's own UI ─────────────────────────────────
    console.log('\n── resume attachment ──');
    // /multistep has no file input, so the correct answer is a reported no_file_input rather than a
    // silent success. The real attachment is checked on /greenhouse, which has one.
    check('a form with no file input says so instead of claiming success',
      result?.resume?.attached === false && result.resume.reason === 'no_file_input',
      JSON.stringify(result?.resume));

    // Seed a second packet for the greenhouse form, which has a real file input.
    db.prepare(`INSERT INTO apply_gate_packets
      (user_id, run_id, run_job_id, job_id, apply_url, expected_origin, gate_reason, answers_json,
       resume_artifact_id, token_hash, expires_at)
      VALUES (1,1,1,'g2job2',?,?,'login_required',?,1,'unminted:seed2',0)`)
      .run(`${PORTAL}/greenhouse`, PORTAL, JSON.stringify(packet));
    await page.goto(`${PORTAL}/greenhouse`, { waitUntil: 'domcontentloaded' });
    // A fresh tab-scoped packet is needed: the first one is cached against this tab.
    await control.evaluate(() => chrome.storage.session.get(null).then(all =>
      chrome.storage.session.remove(Object.keys(all).filter(k => k.startsWith('gate:')))));
    const gh = await invoke();
    check('the greenhouse form filled', gh?.ok === true, gh?.message || gh?.reason);
    const fileState = await page.evaluate(() => {
      const el = document.querySelector('input[type="file"]');
      return el ? { count: el.files.length, name: el.files[0]?.name || null } : null;
    });
    check('the resume is in the PAGE\'s own file input, readable by the page',
      fileState?.count === 1 && /\.pdf$/.test(fileState?.name || ''), JSON.stringify(fileState));
    check('the handoff reports the attachment as verified',
      gh?.resume?.attached === true, JSON.stringify(gh?.resume));

    // ── 6. the packet is cleared when the tab closes ───────────────────────
    console.log('\n── session state ──');
    const before = await control.evaluate(() => chrome.storage.session.get(null)
      .then(a => Object.keys(a).filter(k => k.startsWith('gate:'))));
    check('a packet is held against the tab while the handoff is live', before.length >= 1, before.join(','));
    const doomed = await browser.newPage();
    await doomed.goto(`${PORTAL}/multistep`, { waitUntil: 'domcontentloaded' });
    await page.close();
    await sleep(1200);
    const after = await control.evaluate(() => chrome.storage.session.get(null)
      .then(a => Object.keys(a).filter(k => k.startsWith('gate:'))));
    check('closing the tab clears its packet', after.length < before.length,
      `${before.length} -> ${after.length}`);

    // ── 7. regression ──────────────────────────────────────────────────────
    console.log('\n── regression ──');
    const src = fs.readFileSync(path.join(ROOT, 'extension', 'linkedin-content.js'), 'utf8');
    check('the existing capture path is untouched',
      src.includes('CAPTURE_AND_IMPORT') && src.includes('/api/import/job'));
    check('the popup SAVE_JOB path is untouched',
      fs.readFileSync(path.join(ROOT, 'extension', 'popup.js'), 'utf8').includes("type: 'SAVE_JOB'"));
    check('saved-jobs-content.js is still gone from the source tree',
      !fs.existsSync(path.join(ROOT, 'extension', 'saved-jobs-content.js')));

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
