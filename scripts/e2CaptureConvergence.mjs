#!/usr/bin/env node
/**
 * TASK E2 — one capture path, two triggers. REAL-RUN verification.
 * ============================================================================================
 * The extension had two capture implementations wearing one promise: the popup's button wrote to
 * imported_jobs keyed by dedupe_key, the hotkey wrote to scraped_jobs keyed by req_uid. A job
 * captured both ways existed twice, and only one copy participated in the cross-source reconciler.
 *
 * What must hold now:
 *   1. the HOTKEY capture lands one row in scraped_jobs (source='import'; req_uid stays null for
 *      a generic text capture, deliberately — see the assertion for why)
 *   2. the POPUP capture of the SAME posting reconciles to that row — one row, not two
 *   3. both triggers report the SAME message
 *   4. nothing reaches imported_jobs, from either
 *   5. the extracted TEXT travels, so the server never asks the client for what it already sent
 *
 * A real Chrome, the real extension and the real /api/import/job router. TWO THINGS ARE NOT DRIVEN
 * BY REAL INPUT, and both are named rather than hidden, because neither can be:
 *
 *   - The popup's toolbar button. Browser chrome is not a page, so automation cannot click it. The
 *     popup page is opened as a tab and the button's handler body is run against the job tab — the
 *     same chrome.tabs.sendMessage(tabId, {type:'CAPTURE_AND_IMPORT'}) the click performs. Untested:
 *     getCurrentTab(), two lines, covered by a source assertion in extensionImportPipeline.test.js.
 *   - The hotkey, IF the workstation is locked. A real Ctrl+Shift+K is attempted first and used when
 *     it lands; Windows refuses SetForegroundWindow while locked, and the run says so with the
 *     offending window's title. The fallback runs the chrome.commands handler's body in the service
 *     worker, which is that handler's entire content. Untested: Chrome's delivery of the key event.
 *
 * Everything downstream of both triggers — content script, service worker, CORS path, the real
 * import router, the reconciler, user_jobs starring — is exercised for real, twice.
 *
 * Usage:  node scripts/e2CaptureConvergence.mjs
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
import { createImportJobRouter } from '../routes/importJob.js';
import { MIGRATIONS } from './migrations.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(os.tmpdir(), 'e2-capture-convergence');
const ATS_PORT = 4599;
const ATS = `http://localhost:${ATS_PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// ── The API the extension talks to ───────────────────────────────────────────
function startApi() {
  // Built from the REAL migration list, not a hand-rolled subset. The import path reaches further
  // than it looks — usage_events for spend tracking, job_role_map for classification — and every
  // table hand-copied here would be a second definition free to drift from the one that ships.
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()));`);
  for (const m of MIGRATIONS) db.exec(m.sql);
  db.exec(`
    INSERT INTO users (id, username, password_hash) VALUES (1, 'ada', 'x');
    INSERT INTO domain_profiles (id, user_id, profile_name, role_family, domain, is_active)
      VALUES (10, 1, 'SWE', 'engineering', 'software', 1);
  `);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => {
    const o = req.headers.origin;
    if (o) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Access-Control-Allow-Credentials', 'true'); }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.get('/api/auth/me', (_q, r) => r.json({ authenticated: true }));

  // THE REAL ROUTER. Not a stand-in — this is what production mounts at /api/import.
  //
  // The MODEL is stubbed and nothing else is. /api/import/job is LLM-backed: it hands the page text
  // to Haiku to extract title/company/location. Calling the real model here would bill a token spend
  // per harness run and make the result non-deterministic, while proving nothing this task is about.
  // Everything that E2 actually changed — routing, req_uid identity, the cross-source reconciler,
  // attachImportToUser's starring, dedup on the second capture — is the real code path.
  //
  // The stub echoes what it was given, so "the extracted text reached the server" stays a real
  // assertion rather than a fixture reading itself back.
  const anthropicStub = {
    messages: {
      create: async ({ messages }) => {
        const prompt = messages[0].content;
        const title = /Senior Engineer/i.test(prompt) ? 'Senior Engineer' : 'Unknown Role';
        return {
          content: [{ text: JSON.stringify({
            title, company: 'FakeCo', location: 'Remote', workType: 'onsite',
            // Echoed back, so the stored description is evidence the page text travelled.
            description: prompt.slice(0, 4000),
            salary: null, postedDate: null, externalJobId: null,
          }) }],
          usage: { input_tokens: 10, output_tokens: 10 },
        };
      },
    },
  };
  app.use('/api/import', createImportJobRouter(db, anthropicStub));

  // The two tombstones, mirroring server.js. Their real registration is asserted from source in
  // test/extensionImportPipeline.test.js; what is checked here is that a client hitting them gets a
  // 410 rather than a hang or an ambiguous 404.
  app.all('/api/extension/save-job', (_q, r) =>
    r.status(410).json({ error: 'The save-job endpoint has been removed. Capture now uses /api/import/job, which is the same path the capture shortcut uses.' }));
  app.all(/^\/api\/imported-jobs(\/.*)?$/, (_q, r) =>
    r.status(410).json({ error: 'Imported jobs have been merged into the main board. Captured jobs appear under Saved.' }));

  return new Promise(res => {
    const server = app.listen(0, '127.0.0.1', () => res({ db, server }));
  });
}

// ── The extension copy ───────────────────────────────────────────────────────
// extension/ is NOT modified. The copy points at the local API and adds ONE content-script match so
// the script injects on the fixture. The shipped matches are left in place — this adds a test target
// rather than widening what the real build touches.
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
  const m = JSON.parse(fs.readFileSync(path.join(dst, 'manifest.json'), 'utf8'));
  m.content_scripts[0].matches.push(`${ATS}/*`);
  // Two host permissions for the fixture, for two different reasons: the API one lets the service
  // worker's fetch bypass CORS, and the ATS one lets the extension SEE the tab's url — without it
  // tab.url is undefined and popup.js's init() returns before showing the capture button. That is
  // exactly why the six shipped job-board host_permissions cannot be dropped.
  m.host_permissions = [...m.host_permissions, `${apiOrigin}/*`, `${ATS}/*`];
  fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(m, null, 2));
  return { dir: dst, manifest: m };
}

// ── The hotkey, as a real OS key event ───────────────────────────────────────
const PS = String.raw`
param([int]$BrowserPid)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace E2 -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(System.IntPtr h, bool alt);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Auto)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);
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
    [E2.Win]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)
    [E2.Win]::keybd_event(0x12, 0, $KEYUP, [System.UIntPtr]::Zero)
    [void][E2.Win]::SetForegroundWindow($h)
  } elseif ($a -eq 2) { [E2.Win]::SwitchToThisWindow($h, $true) }
  else {
    [void][E2.Win]::ShowWindow($h, 6); Start-Sleep -Milliseconds 250
    [void][E2.Win]::ShowWindow($h, 9); [void][E2.Win]::SetForegroundWindow($h)
  }
  Start-Sleep -Milliseconds 500
  if ([E2.Win]::GetForegroundWindow() -eq $h) { break }
}
$fg = [E2.Win]::GetForegroundWindow()
if ($fg -ne $h) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][E2.Win]::GetWindowText($fg, $sb, $sb.Capacity)
  Write-Output ("NOT_FOREGROUND want=" + $h + " got=" + $fg + " title='" + $sb.ToString() + "'")
  exit 4
}
[E2.Win]::keybd_event(0x11, 0, 0, [System.UIntPtr]::Zero)
[E2.Win]::keybd_event(0x10, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[E2.Win]::keybd_event(0x4B, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[E2.Win]::keybd_event(0x4B, 0, $KEYUP, [System.UIntPtr]::Zero)
[E2.Win]::keybd_event(0x10, 0, $KEYUP, [System.UIntPtr]::Zero)
[E2.Win]::keybd_event(0x11, 0, $KEYUP, [System.UIntPtr]::Zero)
Write-Output 'SENT'
`;

function sendHotkey(pid) {
  const s = path.join(OUT_DIR, 'k.ps1');
  fs.writeFileSync(s, PS);
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', s, '-BrowserPid', String(pid)],
    { encoding: 'utf8', timeout: 30000 });
  return { ok: `${r.stdout || ''}`.includes('SENT'), out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('=== E2 — one capture path, two triggers ===\n');

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error('No Chrome binary.'); process.exit(1); }

  const { db, server } = await startApi();
  const apiOrigin = `http://127.0.0.1:${server.address().port}`;
  console.log(`api     ${apiOrigin}`);
  console.log(`fixture ${ATS}/greenhouse\n`);

  let ats = null;
  const alive = await new Promise(res => {
    const rq = http.get(`${ATS}/greenhouse`, r => { r.resume(); res(r.statusCode === 200); });
    rq.on('error', () => res(false)); rq.setTimeout(1500, () => { rq.destroy(); res(false); });
  });
  if (!alive) {
    ats = spawn(process.execPath, [path.join(ROOT, 'scripts', 'fakeAts.js')], { stdio: 'ignore' });
    await sleep(1500);
  }

  // The tombstones, over real HTTP.
  const gone1 = await fetch(`${apiOrigin}/api/extension/save-job`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('/api/extension/save-job returns 410', gone1.status === 410, `${gone1.status}: ${(await gone1.json()).error}`);
  const gone2 = await fetch(`${apiOrigin}/api/imported-jobs/linkedin`);
  check('/api/imported-jobs/* returns 410', gone2.status === 410, `${gone2.status}: ${(await gone2.json()).error}`);

  const ext = buildTestExtension(apiOrigin);
  const profile = path.join(OUT_DIR, 'profile');
  fs.rmSync(profile, { recursive: true, force: true });

  const browser = await puppeteer.launch({
    executablePath: resolution.path, headless: false, pipe: true, enableExtensions: true,
    userDataDir: profile,
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1200,900'],
    defaultViewport: null,
  });

  try {
    const extensionId = await browser.installExtension(ext.dir);
    const page = (await browser.pages())[0];
    await page.goto(`${ATS}/greenhouse`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await sleep(600);

    const rows = () => db.prepare('SELECT job_id, title, company, req_uid, source FROM scraped_jobs').all();
    const lastCapture = async (ctl) =>
      (await ctl.evaluate(() => chrome.storage.local.get('lastCapture')))?.lastCapture;

    const control = await browser.newPage();
    await control.goto(`chrome-extension://${extensionId}/options.html`);
    const jobTabId = await control.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find(t => t.url && t.url.startsWith(url))?.id ?? null;
    }, `${ATS}/greenhouse`);
    check('the job tab is addressable', jobTabId != null, `tabId=${jobTabId}`);

    // ── Trigger 1: the hotkey path ─────────────────────────────────────────
    console.log('\n── trigger 1: Ctrl+Shift+K ──');
    await control.evaluate(() => chrome.storage.local.remove('lastCapture'));
    await page.bringToFront();
    await sleep(400);

    let key = { ok: false, out: '' };
    for (let attempt = 1; attempt <= 3 && !key.ok; attempt++) {
      await page.bringToFront();
      await sleep(400);
      key = sendHotkey(browser.process().pid);
      if (!key.ok) console.log(`  key attempt ${attempt}: ${key.out}`);
    }

    let hotkeyResult = null;
    if (key.ok) {
      console.log('  delivered as a real OS key event');
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !hotkeyResult) {
        hotkeyResult = await lastCapture(control);
        if (!hotkeyResult) await sleep(400);
      }
    } else {
      // A real key event cannot be delivered while the workstation is LOCKED — SetForegroundWindow
      // is refused, which is what the diagnostic above reports. Rather than skip the leg, run the
      // command handler's own body from the service worker: chrome.commands.onCommand does exactly
      // chrome.tabs.sendMessage(tab.id, {type:'CAPTURE_AND_IMPORT'}) and nothing else. What goes
      // untested is Chrome's delivery of the key event to the handler; the entire code path the
      // handler runs is exercised.
      console.log('  OS key delivery unavailable — running the command handler body in the worker');
      const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
      const sw = await swTarget.worker();
      hotkeyResult = await sw.evaluate(async (tabId) =>
        chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_AND_IMPORT' }), jobTabId);
    }
    check('the hotkey path captured', hotkeyResult?.success === true, hotkeyResult?.message || 'no result');
    const afterHotkey = rows();
    check('ONE row in scraped_jobs', afterHotkey.length === 1, `${afterHotkey.length} row(s)`);
    // NOT req_uid, and that is correct rather than a gap. importJob.js:22-29 is explicit: req_uid is
    // namespaced by `source`, so it is computed only when the posting carries a REAL ATS requisition
    // id. A generic text capture has none, and tagging it source:'import' with a synthesised req_uid
    // would permanently stop a later real crawl of the same company from reconciling with it — two
    // non-null req_uids read as genuinely distinct sibling reqs. So identity here comes from
    // reconcileFingerprint, which is what the "still one row" assertion below actually proves.
    check('a generic text capture is tagged source=import with no synthesised req_uid',
      afterHotkey[0]?.source === 'import' && !afterHotkey[0]?.req_uid,
      `source=${afterHotkey[0]?.source} req_uid=${afterHotkey[0]?.req_uid ?? 'null'}`);
    console.log(`      ${afterHotkey[0]?.title} @ ${afterHotkey[0]?.company}  source=${afterHotkey[0]?.source}`);

    // ── Trigger 2: the popup button path ───────────────────────────────────
    console.log('\n── trigger 2: the popup button path ──');
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await sleep(500);
    // The button's handler body, verbatim: the same message to the same tab.
    const popupResult = await popup.evaluate(async (tabId) =>
      chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_AND_IMPORT' }), jobTabId);
    check('the popup path captured', popupResult?.success === true, popupResult?.message || 'no result');

    // ── The convergence claims ─────────────────────────────────────────────
    console.log('\n── convergence ──');
    const afterBoth = rows();
    check('STILL ONE ROW — the second capture reconciled, it did not duplicate',
      afterBoth.length === 1, `${afterBoth.length} row(s)`);
    check('same job_id both times', afterBoth[0]?.job_id === afterHotkey[0]?.job_id);
    check('BOTH TRIGGERS REPORTED THE SAME MESSAGE',
      popupResult?.message === hotkeyResult?.message,
      `hotkey="${hotkeyResult?.message}"  popup="${popupResult?.message}"`);
    check('nothing reached imported_jobs',
      db.prepare('SELECT COUNT(*) n FROM imported_jobs').get().n === 0);
    check('the capture is starred into user_jobs, so it lands in the board\'s Saved tab',
      db.prepare('SELECT starred FROM user_jobs WHERE user_id=1').get()?.starred === 1);

    // ── The text travelled ─────────────────────────────────────────────────
    const stored = db.prepare('SELECT description FROM scraped_jobs LIMIT 1').get();
    check('the extracted TEXT was stored, so the server never had to fetch the page itself',
      (stored?.description || '').length > 50, `${(stored?.description || '').length} chars`);
    check('no needsClientCapture round-trip', !/needsClientCapture/i.test(hotkeyResult?.message || ''));

  } finally {
    await browser.close().catch(() => {});
    server.close();
    db.close();
    if (ats) ats.kill();
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('\nHARNESS FAILED:', e); process.exit(1); });
