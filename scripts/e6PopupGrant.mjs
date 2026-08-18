#!/usr/bin/env node
/**
 * E6 — does opening the popup grant activeTab? Measured, because the answer decides an architecture.
 * ============================================================================================
 * Capture currently reaches the page by messaging a CONTENT SCRIPT, which needs a host permission
 * for every origin it runs on. That is why the extension cannot capture a Greenhouse posting
 * embedded on stripe.com: you cannot enumerate every company's careers domain.
 *
 * The alternative is the architecture the gated handoff already uses — `activeTab` + `scripting`,
 * which G0 measured reaching a real Workday tenant with no host permission for it. If capture used
 * that, it would work on ANY job page and the six job-board host permissions could be dropped.
 *
 * Everything turns on one unmeasured question. popup.js gates the capture button on being able to
 * read `tab.url`, and `popup.js:188`'s ATS injection needs access to the tab. Today both are paid
 * for by the six host permissions. If an action invocation grants `activeTab` to the popup, they
 * are paid for by the grant instead and the hosts are redundant. If it does not, dropping the hosts
 * takes the popup's capture button with it.
 *
 * E2 concluded the hosts were load-bearing — but its harness opens popup.html AS A TAB, which is
 * not an action invocation and therefore never grants activeTab. That conclusion may be an artifact
 * of the measurement, the same shape as the vacuous activeTab probe found in E3. So this measures
 * both arms:
 *
 *   INVOKED  — `_execute_action` bound to a key, delivered as a real OS keypress. Opening the popup
 *              this way IS an action invocation, which is the only automatable way to produce one.
 *   CONTROL  — the same page opened as an ordinary tab, i.e. what E2 did.
 *
 * If the two differ, the grant is real and E2's conclusion was an artifact.
 *
 * The probe is a THROWAWAY popup, not our popup.js: the question is about the browser's behaviour,
 * not our code, and measuring through our own gating logic would confound the two.
 *
 * The keypress is delivered to the window belonging to THIS browser's process tree, and refuses to
 * fire if that window is not foreground — so it cannot land in another Chrome you have open.
 *
 * Usage:  node scripts/e6PopupGrant.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC  = path.join(ROOT, 'extension');
const OUT  = path.join(os.tmpdir(), 'e6-popup-grant');

// A page the manifest covers nowhere. If the URL is readable here, it was the grant that did it.
const TARGET = 'https://example.com/';

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// ── A real Ctrl+Shift+U, delivered only to this browser's own window ─────────────────────────
// Lifted from e2CaptureConvergence.mjs, which established the safe shape: resolve the window from
// the browser's process tree, and refuse rather than type into whatever happens to be focused.
const PS = String.raw`
param([int]$BrowserPid)
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
namespace E6 { public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool b);
} }
"@
function Resolve-Handle([int]$rootPid) {
  $procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $desc = New-Object System.Collections.Generic.HashSet[int]
  $frontier = New-Object System.Collections.ArrayList
  [void]$desc.Add($rootPid); [void]$frontier.Add($rootPid)
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
    [E6.Win]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)
    [E6.Win]::keybd_event(0x12, 0, $KEYUP, [System.UIntPtr]::Zero)
    [void][E6.Win]::SetForegroundWindow($h)
  } elseif ($a -eq 2) { [E6.Win]::SwitchToThisWindow($h, $true) }
  else {
    [void][E6.Win]::ShowWindow($h, 6); Start-Sleep -Milliseconds 250
    [void][E6.Win]::ShowWindow($h, 9); [void][E6.Win]::SetForegroundWindow($h)
  }
  Start-Sleep -Milliseconds 500
  if ([E6.Win]::GetForegroundWindow() -eq $h) { break }
}
$fg = [E6.Win]::GetForegroundWindow()
if ($fg -ne $h) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][E6.Win]::GetWindowText($fg, $sb, $sb.Capacity)
  Write-Output ("NOT_FOREGROUND want=" + $h + " got=" + $fg + " title='" + $sb.ToString() + "'")
  exit 4
}
[E6.Win]::keybd_event(0x11, 0, 0, [System.UIntPtr]::Zero)
[E6.Win]::keybd_event(0x10, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[E6.Win]::keybd_event(0x55, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[E6.Win]::keybd_event(0x55, 0, $KEYUP, [System.UIntPtr]::Zero)
[E6.Win]::keybd_event(0x10, 0, $KEYUP, [System.UIntPtr]::Zero)
[E6.Win]::keybd_event(0x11, 0, $KEYUP, [System.UIntPtr]::Zero)
Write-Output 'SENT'
`;

function sendExecuteAction(pid) {
  const s = path.join(OUT, 'k.ps1');
  fs.writeFileSync(s, PS);
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', s, '-BrowserPid', String(pid)],
    { encoding: 'utf8', timeout: 30000 });
  return { ok: `${r.stdout || ''}`.includes('SENT'), out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

const PROBE_JS = `(async () => {
  const out = {};
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    out.tabUrlVisible = !!(tab && tab.url);
    out.tabUrl = (tab && tab.url) || null;
    if (tab && tab.id != null) {
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.title });
        out.inject = 'OK:' + r.result;
      } catch (e) { out.inject = 'FAIL:' + e.message.slice(0, 70); }
    } else out.inject = 'no-tab-id';
  } catch (e) { out.error = e.message; }
  await chrome.storage.local.set({ e6probe: out });
})();`;

/** extension/ with NO job-board hosts, a probe popup, and _execute_action bound to Ctrl+Shift+U. */
function stage() {
  const ext = path.join(OUT, 'ext');
  fs.rmSync(ext, { recursive: true, force: true });
  fs.mkdirSync(ext, { recursive: true });
  for (const e of fs.readdirSync(SRC, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'submission' || e.name === 'dist') continue;
      fs.cpSync(path.join(SRC, e.name), path.join(ext, e.name), { recursive: true });
    } else fs.copyFileSync(path.join(SRC, e.name), path.join(ext, e.name));
  }

  const m = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  // The whole point: no host permission for anything but our own origin, and no content script.
  m.host_permissions = ['https://resumemaster.one/*'];
  delete m.content_scripts;
  m.action.default_popup = 'probe-popup.html';
  m.commands = { ...(m.commands || {}), _execute_action: { suggested_key: { default: 'Ctrl+Shift+U' } } };
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(m, null, 2));

  fs.writeFileSync(path.join(ext, 'probe-popup.html'),
    '<!doctype html><meta charset="utf-8"><body style="width:200px">E6 probe<script src="probe.js"></script></body>');
  fs.writeFileSync(path.join(ext, 'probe.js'), PROBE_JS);
  return ext;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('=== E6 — does an action invocation grant activeTab to the popup? ===\n');
  console.log(`target ${TARGET}  (no host permission declared for it)\n`);

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error('No Chrome binary.'); process.exit(1); }

  const ext = stage();
  const profile = path.join(OUT, 'profile');
  fs.rmSync(profile, { recursive: true, force: true });

  const browser = await puppeteer.launch({
    executablePath: resolution.path, headless: false, pipe: true, enableExtensions: true,
    userDataDir: profile, defaultViewport: null,
    args: ['--no-first-run', '--no-default-browser-check'],
  });

  try {
    const extensionId = await browser.installExtension(ext);
    const page = (await browser.pages())[0];
    await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await sleep(800);

    const control = await browser.newPage();
    await control.goto(`chrome-extension://${extensionId}/options.html`);
    const read = async () =>
      (await control.evaluate(() => chrome.storage.local.get('e6probe')))?.e6probe ?? null;
    const clear = () => control.evaluate(() => chrome.storage.local.remove('e6probe'));

    // ── CONTROL: the probe opened as an ordinary tab. This is what E2 did. ──
    console.log('── CONTROL: popup page opened as a tab (no invocation) ──');
    await clear();
    const asTab = await browser.newPage();
    await asTab.goto(`chrome-extension://${extensionId}/probe-popup.html`);
    await sleep(1200);
    const controlResult = await read();
    console.log(`      ${JSON.stringify(controlResult)}`);
    await asTab.close();

    // ── INVOKED: _execute_action via a real keypress opens the popup ──
    console.log('\n── INVOKED: _execute_action delivered as a real OS keypress ──');
    await clear();
    await page.bringToFront();
    await sleep(600);
    const key = sendExecuteAction(browser.process().pid);
    check('the keypress was delivered to this browser', key.ok, key.out.slice(0, 120));
    await sleep(2500);
    const invokedResult = await read();
    console.log(`      ${JSON.stringify(invokedResult)}`);

    // ── The comparison is the finding ──
    console.log('\n── verdict ──');
    if (!key.ok) {
      console.log('SKIP  the keypress never landed, so nothing can be concluded');
      failures++;
    } else if (!invokedResult) {
      check('the popup ran on invocation', false,
        'no probe result — _execute_action may not have opened the popup');
    } else {
      const grantedUrl    = invokedResult.tabUrlVisible === true;
      const grantedInject = String(invokedResult.inject || '').startsWith('OK');
      const controlUrl    = controlResult?.tabUrlVisible === true;

      check('INVOKED: the popup can read tab.url with no host permission', grantedUrl,
        invokedResult.tabUrl || 'hidden');
      check('INVOKED: the popup can inject into that tab', grantedInject,
        String(invokedResult.inject));
      check('CONTROL differs — so the grant, not ambient access, is what did it',
        grantedUrl && !controlUrl,
        `invoked=${grantedUrl} control=${controlUrl}`);

      console.log('');
      if (grantedUrl && grantedInject) {
        console.log('FINDING: an action invocation DOES grant activeTab to the popup.');
        console.log('         Capture can move to activeTab + executeScript, work on any job page,');
        console.log('         and the six job-board host permissions become redundant.');
      } else {
        console.log('FINDING: an action invocation does NOT give the popup usable access.');
        console.log('         E2 was right: the host permissions are load-bearing for the popup,');
        console.log('         and dropping them would remove the capture button. Hotkey capture');
        console.log('         could still move to executeScript; the popup could not.');
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('\nE6 FAILED:', e); process.exit(1); });
