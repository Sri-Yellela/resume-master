#!/usr/bin/env node
/**
 * TASK G0 — does an `activeTab` grant survive a step transition inside a form flow?
 * ============================================================================================
 * WHY THIS EXISTS
 * docs/GATED_HANDOFF_ARCHITECTURE.md §5 calls this the largest unknown in the gated-handoff
 * design, and §8 lists it as an open decision. It is not answerable from documentation: Chrome's
 * rule is that a grant is revoked when the tab "navigates away", and whether a portal's own
 * pagination counts as navigating away depends on which mechanism that portal happens to use.
 * The answer decides the interaction model — one user gesture per application, or one per page —
 * so building G2 on an assumption risks a UX that has to be rebuilt.
 *
 * WHAT MAKES THIS A REAL MEASUREMENT AND NOT A SIMULATION
 * An activeTab grant can only be created by a genuine user invocation. There is no API, no CDP
 * command and no test hook that mints one — that is the entire security property. So this harness
 * drives a real headful Chrome, with a real unpacked extension loaded, and delivers a real
 * OS-level keyboard event (`keybd_event`) for the extension's chrome.commands hotkey to a focused
 * Chrome window. Nothing here fakes the grant.
 *
 *   NOTE: it therefore STEALS KEYBOARD FOCUS for a few seconds per trial. It verifies the
 *   foreground window is the Chrome window it launched before sending any key, and aborts rather
 *   than typing into whatever else is focused. If focus cannot be taken it falls back to asking
 *   for the keypress by hand.
 *
 * THE CONTROL CASE IS THE POINT
 * A probe that is silently broken reports "the grant survived everything". Trial C navigates to a
 * DIFFERENT origin (127.0.0.1 vs localhost, same fakeAts process), where Chrome must revoke. If
 * Trial C does not show a revocation, every other trial in the run is void and the harness says so
 * rather than reporting a result.
 *
 * The extension is NOT modified. extension/ is copied to a temp directory and the copy gets one
 * extra command plus a service worker that imports the real background.js. host_permissions are
 * copied verbatim and deliberately do NOT cover the test origins, so injection can only succeed
 * through activeTab — if localhost were in host_permissions every trial would pass for the wrong
 * reason. The harness asserts that before it launches.
 *
 * CAVEAT WORTH RECORDING: Chrome 137+ ignores --load-extension, so the extension is installed over
 * CDP (Extensions.loadUnpacked), which requires --enable-unsafe-extension-debugging. That flag
 * opens the Extensions CDP domain; it does not touch activeTab grant or revocation logic, and the
 * cross-origin control trial confirms revocation still happens normally under it.
 *
 * USAGE
 *   node scripts/g0ActiveTabSpike.mjs                     # fakeAts only (default)
 *   node scripts/g0ActiveTabSpike.mjs --real              # also probe one public careers page
 *   node scripts/g0ActiveTabSpike.mjs --real --real-url=<url>
 *   node scripts/g0ActiveTabSpike.mjs --keep              # leave the browser open at the end
 *
 * --real is READ-ONLY by construction: it navigates and counts controls. It never types into a
 * field, never clicks a submit control, and never touches an apply flow. G0 step 5 authorises
 * exactly this and nothing more.
 *
 * Writes the full probe log as JSON next to the summary so the findings note can cite it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const flag = (name) => ARGV.includes(`--${name}`);
const opt = (name, dflt) => ARGV.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? dflt;

const FAKE_ATS_PORT = Number(opt('port', 4599));
const HOTKEY_DESC = 'Ctrl+Shift+Y';
const OUT_DIR = path.join(os.tmpdir(), 'g0-activetab-spike');

// ── Instrumented copy of extension/ ──────────────────────────────────────────────────────────
// One added command and one added service worker that imports the real one. Everything else,
// including host_permissions, is byte-copied so the grant being measured is the grant the shipped
// extension would get.
function buildSpikeExtension() {
  const src = path.join(ROOT, 'extension');
  const dst = path.join(OUT_DIR, 'extension');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'submission' || entry.name === 'dist') continue; // build outputs
      fs.cpSync(path.join(src, entry.name), path.join(dst, entry.name), { recursive: true });
    } else {
      fs.copyFileSync(path.join(src, entry.name), path.join(dst, entry.name));
    }
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  const originalPermissions = [...manifest.permissions];
  const originalHosts = [...(manifest.host_permissions || [])];
  manifest.background.service_worker = 'g0-spike-sw.js';
  manifest.commands['g0-spike'] = {
    suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' },
    description: 'G0 spike: take the activeTab grant on this tab and start probing it',
  };
  fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dst, 'g0-spike-sw.js'), SPIKE_SW);
  fs.writeFileSync(path.join(dst, 'g0-report.html'),
    '<!DOCTYPE html><meta charset="utf-8"><title>G0 spike control surface</title>' +
    '<body><p>G0 spike control surface. Driven over CDP; nothing to see here.</p>');

  return { dir: dst, permissions: originalPermissions, hostPermissions: originalHosts };
}

// The probe. Runs INSIDE the extension service worker.
//
// Every tick mirrors the log into chrome.storage.local because an MV3 service worker is torn down
// without warning — the architecture doc's own §5 constraint. If the log lived only in worker
// memory, a teardown would look identical to a revoked grant, which is the one distinction this
// whole spike exists to make.
const SPIKE_SW = `// GENERATED by scripts/g0ActiveTabSpike.mjs — not part of the extension source.
import './background.js';

const LOG = [];
let state = { tabId: null, marker: null, timer: null };

function push(entry) {
  LOG.push(entry);
  chrome.storage.local.set({ g0log: LOG });
}

async function probeOnce(reason) {
  const tabId = state.tabId;
  if (tabId == null) return;

  let tabUrl = null;
  try { tabUrl = (await chrome.tabs.get(tabId)).url; }
  catch (e) { tabUrl = '<tabs.get failed: ' + e.message + '>'; }

  // The probe READS ONLY. It counts controls and reports the document identity stamp; it never
  // writes a value into the page. On the --real phase this is what keeps the run read-only.
  let result = null, error = null;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      // MAIN, not the default isolated world: the isolated world has its own window object, so the
      // page's __g0DocId stamp is invisible from it and every trial reports docId=null — the
      // same-document question would be unanswerable. G2 needs MAIN anyway for the native value
      // setter, so this also confirms activeTab is enough to reach it.
      world: 'MAIN',
      func: () => ({
        href: location.href,
        origin: location.origin,
        // Two independent document-identity signals. __g0DocId only exists on the fakeAts fixture;
        // timeOrigin is per-document, present everywhere, and requires writing nothing — which is
        // what keeps the --real phase read-only while still answering same-document-or-not.
        docId: window.__g0DocId || null,
        timeOrigin: performance.timeOrigin,
        controls: document.querySelectorAll('input:not([type=hidden]),select,textarea').length,
        forms: document.forms.length,
        title: document.title.slice(0, 80),
      }),
    });
    result = r ? r.result : null;
  } catch (e) { error = e.message; }

  let sessionMarker = null, sessionError = null;
  try {
    const got = await chrome.storage.session.get('g0Packet');
    sessionMarker = got && got.g0Packet ? got.g0Packet.marker : null;
  } catch (e) { sessionError = e.message; }

  push({ at: Date.now(), reason, tabUrl, injected: !!result, result, error, sessionMarker, sessionError });
}

// THE GESTURE. This listener firing is the grant; there is no other way in.
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'g0-spike') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { push({ at: Date.now(), reason: 'grant', error: 'no active tab' }); return; }
  state.tabId = tab.id;
  state.marker = 'PKT-' + Math.random().toString(36).slice(2, 10);
  await chrome.storage.session.set({ g0Packet: { marker: state.marker, mintedAt: Date.now() } });
  push({ at: Date.now(), reason: 'grant', tabId: tab.id, tabUrl: tab.url, marker: state.marker });
  await probeOnce('post-grant');
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => probeOnce('tick'), 400);
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg && msg.type === 'G0_RESET') {
    if (state.timer) clearInterval(state.timer);
    state = { tabId: null, marker: null, timer: null };
    LOG.length = 0;
    chrome.storage.session.remove('g0Packet')
      .then(() => chrome.storage.local.set({ g0log: [] }))
      .then(() => respond({ ok: true }));
    return true;
  }
  if (msg && msg.type === 'G0_PING') { respond({ ok: true, tabId: state.tabId }); return true; }
  return false;
});
`;

// ── fakeAts ──────────────────────────────────────────────────────────────────────────────────
function startFakeAts() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'fakeAts.js')], {
      env: { ...process.env, PORT: String(FAKE_ATS_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    child.stdout.on('data', d => {
      if (!settled && String(d).includes('listening')) { settled = true; resolve(child); }
    });
    child.on('error', reject);
    setTimeout(() => { if (!settled) reject(new Error('fakeAts did not start')); }, 8000);
  });
}

function ping(url) {
  return new Promise(resolve => {
    const req = http.get(url, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

// ── The keypress ─────────────────────────────────────────────────────────────────────────────
// Focus is verified before anything is sent: GetForegroundWindow must already equal the Chrome
// window we launched. Typing Ctrl+Shift+Y into whatever else happened to be focused is the one
// genuinely destructive thing this harness could do, so it refuses instead of guessing.
// Windows will not let a background process call SetForegroundWindow outright (foreground lock),
// which is why the first version of this only ever reported NOT_FOREGROUND. Three escalating
// mechanisms, each verified against GetForegroundWindow rather than assumed:
//   1. a synthetic ALT tap, which makes this thread the owner of the most recent input event and
//      lifts the lock for the call that follows
//   2. SwitchToThisWindow, which the shell itself uses for alt-tab
//   3. minimize + restore — restoring from minimized activates unconditionally
//
// The window is located by PROCESS, not by title. Matching on the page title worked on the fakeAts
// fixture (whose titles carry G0-SPIKE) and then reported NO_WINDOW for every real-site trial,
// because a real portal's title is its own. Titles are also the wrong thing to match on principle:
// the user's own Chrome is usually running too, and a title-based match that drifted could deliver
// Ctrl+Shift+Y into their window instead of ours.
const PS_SEND_HOTKEY = String.raw`
param([int]$BrowserPid)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace G0 -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(System.IntPtr h, bool alt);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Auto)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);
'@
function Title([System.IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][G0.Win]::GetWindowText($h, $sb, $sb.Capacity)
  $sb.ToString()
}
# The pid puppeteer reports is the browser process, which normally owns the window; if it does not,
# walk its descendants rather than falling back to a title guess that could hit another Chrome.
function Resolve-Handle([int]$rootPid) {
  $p = Get-Process -Id $rootPid -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0) { return $p.MainWindowHandle }
  $procs = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId
  $descendants = New-Object System.Collections.Generic.HashSet[int]
  $frontier = New-Object System.Collections.Generic.List[int]
  [void]$frontier.Add($rootPid)
  while ($frontier.Count -gt 0) {
    $cur = $frontier[0]; $frontier.RemoveAt(0)
    foreach ($c in $procs) {
      if ($c.ParentProcessId -eq $cur -and $descendants.Add([int]$c.ProcessId)) {
        [void]$frontier.Add([int]$c.ProcessId)
      }
    }
  }
  foreach ($d in $descendants) {
    $cp = Get-Process -Id $d -ErrorAction SilentlyContinue
    if ($cp -and $cp.MainWindowHandle -ne 0) { return $cp.MainWindowHandle }
  }
  return [System.IntPtr]::Zero
}

$h = Resolve-Handle $BrowserPid
if ($h -eq [System.IntPtr]::Zero) { Write-Output 'NO_WINDOW'; exit 3 }
$KEYUP = 2

for ($attempt = 1; $attempt -le 3; $attempt++) {
  if ($attempt -eq 1) {
    [G0.Win]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)     # ALT down — lifts the foreground lock
    [G0.Win]::keybd_event(0x12, 0, $KEYUP, [System.UIntPtr]::Zero)
    [void][G0.Win]::SetForegroundWindow($h)
  } elseif ($attempt -eq 2) {
    [G0.Win]::SwitchToThisWindow($h, $true)
  } else {
    [void][G0.Win]::ShowWindow($h, 6)                             # SW_MINIMIZE
    Start-Sleep -Milliseconds 250
    [void][G0.Win]::ShowWindow($h, 9)                             # SW_RESTORE
    [void][G0.Win]::SetForegroundWindow($h)
  }
  Start-Sleep -Milliseconds 500
  if ([G0.Win]::GetForegroundWindow() -eq $h) { break }
}

$fg = [G0.Win]::GetForegroundWindow()
if ($fg -ne $h) {
  Write-Output ('NOT_FOREGROUND want="' + (Title $h) + '" got="' + (Title $fg) + '"')
  exit 4
}
[G0.Win]::keybd_event(0x11, 0, 0, [System.UIntPtr]::Zero)      # Ctrl down
[G0.Win]::keybd_event(0x10, 0, 0, [System.UIntPtr]::Zero)      # Shift down
Start-Sleep -Milliseconds 40
[G0.Win]::keybd_event(0x59, 0, 0, [System.UIntPtr]::Zero)      # Y down
Start-Sleep -Milliseconds 40
[G0.Win]::keybd_event(0x59, 0, $KEYUP, [System.UIntPtr]::Zero)
[G0.Win]::keybd_event(0x10, 0, $KEYUP, [System.UIntPtr]::Zero)
[G0.Win]::keybd_event(0x11, 0, $KEYUP, [System.UIntPtr]::Zero)
Write-Output 'SENT'
`;

function sendHotkey(browserPid) {
  const script = path.join(OUT_DIR, 'sendHotkey.ps1');
  fs.writeFileSync(script, PS_SEND_HOTKEY);
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-BrowserPid', String(browserPid)],
    { encoding: 'utf8', timeout: 30000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: out.includes('SENT'), out };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const safeOrigin = (u) => { try { return new URL(u).origin; } catch { return String(u); } };

// ── Trials ───────────────────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = `http://localhost:${FAKE_ATS_PORT}`;

  console.log('=== G0 — activeTab grant lifetime spike ===\n');

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error('No Chrome binary found.'); process.exit(1); }
  console.log(`chrome        ${resolution.path} (${resolution.source})`);

  const spike = buildSpikeExtension();
  console.log(`extension     ${spike.dir}`);
  console.log(`permissions   ${spike.permissions.join(', ')}`);
  const coversLocalhost = spike.hostPermissions.some(h => /localhost|127\.0\.0\.1/.test(h));
  console.log(`host_perms    ${spike.hostPermissions.length} entries; covers test origin: ${coversLocalhost}`);
  if (coversLocalhost) {
    console.error('\nABORT: host_permissions cover the test origin. Injection would succeed without a');
    console.error('grant and every trial would pass for the wrong reason.');
    process.exit(1);
  }

  let ats = null;
  if (await ping(`${base}/multistep`)) {
    console.log(`fakeAts       already listening on ${base}`);
  } else {
    ats = await startFakeAts();
    console.log(`fakeAts       started on ${base}`);
  }

  const profile = path.join(OUT_DIR, 'profile');
  fs.rmSync(profile, { recursive: true, force: true });

  // Chrome 137+ ignores --load-extension. The supported automation route is the CDP Extensions
  // domain, which puppeteer reaches through enableExtensions + a pipe transport; it also hands back
  // the assigned extension id, so nothing has to guess it from a target URL or the profile.
  const browser = await puppeteer.launch({
    executablePath: resolution.path,
    headless: false,
    pipe: true,
    enableExtensions: true,
    userDataDir: profile,
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1100,900'],
    defaultViewport: null,
  });

  const results = [];
  try {
    const extensionId = await browser.installExtension(spike.dir);
    console.log(`extension id  ${extensionId}`);

    // Control surface: an extension page in its own tab, so the log survives service-worker
    // teardown. It is never the active tab when the hotkey is sent.
    const control = await browser.newPage();
    await control.goto(`chrome-extension://${extensionId}/g0-report.html`);

    // If the hotkey did not bind, no gesture can be delivered and every trial would be VOID for a
    // reason that has nothing to do with the question. Fail loudly here instead.
    const commands = await control.evaluate(() => chrome.commands.getAll());
    const bound = commands.find(c => c.name === 'g0-spike');
    console.log(`hotkey        ${bound?.shortcut || '<UNBOUND>'}`);
    if (!bound?.shortcut) {
      throw new Error('the g0-spike command has no keyboard binding — no gesture can be delivered');
    }

    const target = (await browser.pages())[0];
    await target.setViewport({ width: 1000, height: 800 });

    const readLog = async () => {
      const { g0log } = await control.evaluate(() => chrome.storage.local.get('g0log'));
      return g0log || [];
    };
    const reset = async () => {
      await control.evaluate(() => new Promise(res => chrome.runtime.sendMessage({ type: 'G0_RESET' }, res)));
    };

    // --only=A,C narrows the run while iterating on the harness itself. The summary refuses to draw
    // a conclusion without the control trial regardless of what was selected.
    const only = opt('only', null)?.split(',').map(s => s.trim().toUpperCase());

    const runTrial = async ({ name, mechanism, start, act, settleMs = 3200 }) => {
      const letter = /^Trial (\w+)/.exec(name)?.[1];
      if (only && !only.includes(letter)) return;
      console.log(`\n── ${name} ─────────────────────────────────────────`);
      await reset();
      await start(target);
      await target.bringToFront();
      await sleep(400);

      const key = sendHotkey(browser.process().pid);
      if (!key.ok) {
        console.log(`  hotkey: automated delivery failed (${key.out || 'no output'}).`);
        console.log(`  Press ${HOTKEY_DESC} in the Chrome window now — waiting up to 45s.`);
      }
      const grantDeadline = Date.now() + (key.ok ? 8000 : 45000);
      let log = [];
      while (Date.now() < grantDeadline) {
        log = await readLog();
        if (log.some(e => e.reason === 'grant' && !e.error)) break;
        await sleep(500);
      }
      const grant = log.find(e => e.reason === 'grant' && !e.error);
      if (!grant) {
        console.log('  RESULT: no grant was ever taken — trial VOID.');
        results.push({ name, mechanism, verdict: 'VOID', reason: 'grant never observed', log });
        return;
      }

      await sleep(1200);                                    // baseline ticks before the transition
      // Observed by the HARNESS, not through the extension. Once a grant is revoked, tabs.get().url
      // comes back undefined, so the probe's own view of where the tab went goes dark at exactly the
      // moment that information matters most — which is how the first real-site run left it unclear
      // whether a "same-origin" navigation had in fact redirected somewhere else.
      const urlBefore = target.url();
      const before = (await readLog()).filter(e => e.reason !== 'grant');
      const preOk = before.filter(e => e.injected);
      console.log(`  before: ${preOk.length}/${before.length} injections succeeded` +
                  `  docId=${preOk.at(-1)?.result?.docId}  controls=${preOk.at(-1)?.result?.controls}`);

      // A trial whose transition fails to happen must not take the rest of the run with it — the
      // control trial is what makes any of the others readable, so losing the run to an unrelated
      // timeout costs the whole measurement.
      let actError = null, note = null;
      try { note = (await act(target)) || null; }
      catch (e) { actError = e.message; console.log(`  transition FAILED: ${actError}`); }
      await sleep(settleMs);

      const urlAfter = target.url();
      const originBefore = safeOrigin(urlBefore);
      const originAfter = safeOrigin(urlAfter);
      const full = await readLog();
      const after = full.filter(e => e.reason !== 'grant' && e.at > before.at(-1)?.at);
      const afterOk = after.filter(e => e.injected);
      const afterFail = after.filter(e => !e.injected);
      const sameDoc = afterOk.length > 0
        && preOk.at(-1)?.result?.timeOrigin != null
        && afterOk.at(-1)?.result?.timeOrigin === preOk.at(-1)?.result?.timeOrigin;
      const sessionAlive = after.length > 0 && after.at(-1).sessionMarker === grant.marker;

      // No transition means nothing was tested. Reporting "SURVIVED" there would be a lie of the
      // most convenient kind, so it is VOID.
      //
      // The second check exists because the first real-portal trial reported SURVIVED after a click
      // that silently did nothing: same URL, same timeOrigin, same control count throughout. An act()
      // that throws is easy to catch; an act() that quietly has no effect looks exactly like a
      // surviving grant, and is the more likely failure against real markup.
      const survived = after.length > 0 && afterFail.length === 0;
      if (actError) {
        console.log('  RESULT: VOID — the transition never happened, so nothing was measured.');
        results.push({ name, mechanism, verdict: 'VOID', reason: `transition failed: ${actError}`, log: full });
        return;
      }
      const urlChanged = afterOk.at(-1)?.result?.href !== preOk.at(-1)?.result?.href;
      const docChanged = afterOk.at(-1)?.result?.timeOrigin !== preOk.at(-1)?.result?.timeOrigin;
      if (survived && !urlChanged && !docChanged) {
        console.log('  RESULT: VOID — no transition observed (same URL and same document throughout).');
        results.push({
          name, mechanism, verdict: 'VOID',
          reason: note || 'no transition observed — URL and document identity both unchanged',
          note, urlBefore, urlAfter,
          log: full,
        });
        return;
      }
      console.log(`  after:  ${afterOk.length}/${after.length} injections succeeded` +
                  `  docId=${afterOk.at(-1)?.result?.docId}` +
                  `  controls=${afterOk.at(-1)?.result?.controls}` +
                  `  url=${afterOk.at(-1)?.result?.href || after.at(-1)?.tabUrl}`);
      if (afterFail.length) console.log(`  first failure: ${afterFail[0].error}`);
      console.log(`  same document: ${sameDoc}   storage.session packet intact: ${sessionAlive}`);
      console.log(`  harness view: ${originBefore} -> ${originAfter}` +
                  `  (origin ${originBefore === originAfter ? 'UNCHANGED' : 'CHANGED'})`);
      console.log(`               ${urlBefore}\n            -> ${urlAfter}`);
      console.log(`  RESULT: grant ${survived ? 'SURVIVED' : 'was REVOKED'}`);

      results.push({
        name, mechanism,
        verdict: survived ? 'SURVIVED' : 'REVOKED',
        urlBefore, urlAfter, originBefore, originAfter,
        originChanged: originBefore !== originAfter,
        beforeOk: preOk.length, beforeTotal: before.length,
        afterOk: afterOk.length, afterTotal: after.length,
        firstFailure: afterFail[0]?.error || null,
        sameDocument: !!sameDoc,
        sessionPacketIntact: sessionAlive,
        finalUrl: afterOk.at(-1)?.result?.href || after.at(-1)?.tabUrl || null,
        log: full,
      });
    };

    const gotoStep1 = async (p) => {
      await p.goto(`${base}/multistep`, { waitUntil: 'domcontentloaded' });
    };

    await runTrial({
      name: 'Trial A — SPA advance (history.pushState + DOM rewrite)',
      mechanism: 'same-document, same-origin, URL changes',
      start: gotoStep1,
      act: async (p) => { await p.click('#adv-spa'); },
    });

    await runTrial({
      name: 'Trial B — real form POST to a new document, same origin',
      mechanism: 'new document, same origin',
      start: gotoStep1,
      act: async (p) => {
        await Promise.all([p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }), p.click('#adv-post')]);
      },
    });

    await runTrial({
      name: 'Trial C — CONTROL: navigation to a different origin',
      mechanism: 'new document, DIFFERENT origin (127.0.0.1 vs localhost)',
      start: gotoStep1,
      act: async (p) => {
        await Promise.all([p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }), p.click('#adv-cross')]);
      },
    });

    await runTrial({
      name: 'Trial D — reload of the same URL',
      mechanism: 'new document, same origin, same URL',
      start: gotoStep1,
      act: async (p) => { await p.reload({ waitUntil: 'domcontentloaded', timeout: 12000 }); },
    });

    await runTrial({
      name: 'Trial E — same-origin document navigation driven by script (location.assign)',
      mechanism: 'new document, same origin, different path',
      start: gotoStep1,
      act: async (p) => {
        await Promise.all([
          p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }),
          p.evaluate(() => { location.assign('/multistep/step2'); }),
        ]);
      },
    });

    // Added after the first --real run, which produced a genuine contradiction: on fakeAts a
    // same-origin document navigation KEPT the grant (Trials B/E), while the same thing on a real
    // portal LOST it. The one difference was who initiated the navigation — B and E were started by
    // the page (form submit, location.assign), the real-site one by CDP, which Chrome sees as
    // browser-initiated, the same class as typing in the omnibox. This isolates that variable on the
    // fixture, where nothing else differs.
    await runTrial({
      name: 'Trial F — same-origin document navigation initiated by the BROWSER (CDP goto)',
      mechanism: 'new document, same origin, browser-initiated rather than page-initiated',
      start: gotoStep1,
      act: async (p) => {
        await p.goto(`${base}/multistep/step2`, { waitUntil: 'domcontentloaded', timeout: 12000 });
      },
    });

    if (flag('real')) await realPhase({ runTrial, base });

  } finally {
    fs.writeFileSync(path.join(OUT_DIR, 'g0-results.json'), JSON.stringify(results, null, 2));
    if (!flag('keep')) await browser.close();
    if (ats) ats.kill();
  }

  summarise(results);
}

// ── Real-site phase (--real) ─────────────────────────────────────────────────────────────────
// G0 step 5: repeat against ONE public, non-gated careers page. Read-only: navigate, count
// controls. No field is typed into, no submit control is clicked, no apply flow is entered.
async function realPhase({ runTrial, base }) {
  const url = opt('real-url', 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite');
  console.log(`\n\n=== --real phase: ${url} ===`);
  console.log('READ-ONLY. Navigation and control counting only; nothing is typed or submitted.\n');

  const origin = new URL(url).origin;

  // A real tenant's job list is a heavy SPA; 6s was not enough on the first run and the trial
  // reported a grant surviving a transition that never happened.
  const openList = async (p) => {
    await p.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(14000);
  };

  await runTrial({
    name: 'Trial R1 — real portal, the portal\'s OWN route change (click a job link)',
    mechanism: 'real Workday tenant, same-document route change',
    start: openList,
    act: async (p) => {
      // Reports the candidate count rather than a bare boolean: the first attempt used
      // a[data-automation-id="jobTitle"], found nothing, and the trial then looked like a surviving
      // grant instead of a selector that had gone stale against live markup.
      //
      // The click is a real CDP mouse event, not element.click() from page script. A synthetic click
      // found 20 links, clicked one, and produced no route change at all — an SPA guarding on
      // event.isTrusted, or a handler bound to pointer events, will ignore the scripted kind.
      let picked = null, href = null, candidates = 0;
      for (const h of await p.$$('a[href]')) {
        const hv = await h.evaluate(a => a.getAttribute('href') || '');
        if (!/\/(details|job)\//.test(hv)) continue;
        candidates++;
        if (!picked) { picked = h; href = hv; }
      }
      console.log(`  job links found: ${candidates}`);
      if (!picked) return;

      const tabsBefore = (await p.browser().pages()).length;
      await picked.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
      console.log(`  clicking (trusted mouse event): ${href}`);
      await picked.click().catch(e => console.log(`  click failed: ${e.message}`));
      await sleep(4000);

      // A portal that opens its next step in a NEW TAB would defeat the handoff outright: the grant
      // is per-tab, so it would not travel there. Worth knowing either way.
      const tabsAfter = (await p.browser().pages()).length;
      if (tabsAfter > tabsBefore) {
        console.log(`  NOTE: the click opened a NEW TAB (${tabsBefore} -> ${tabsAfter} pages)`);
        return 'the portal opened the next step in a NEW TAB, so the granted tab never transitioned '
             + '— an activeTab grant is per-tab and does not travel to the new one';
      }
    },
    settleMs: 4000,
  });

  // The first version pointed these at `${origin}/en-US/`, which Workday 302s to
  // community.workday.com/invalid-url — a CROSS-origin redirect. Both trials duly reported a
  // revocation that was really just the control case again, and only the harness-side URL capture
  // made that visible. A query string on the tenant's own URL cannot redirect off-origin.
  await runTrial({
    name: 'Trial R2 — real portal, BROWSER-initiated same-origin navigation',
    mechanism: 'real Workday tenant, new document, browser-initiated',
    start: openList,
    act: async (p) => {
      await p.goto(`${url}?g0probe=1`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await sleep(2500);
    },
    settleMs: 4000,
  });

  // The one real-portal case the job-link click could not reach, because Workday sends job detail to
  // a new tab. Pagination is the portal's own same-document route change: it rewrites the result list
  // and the URL without a document load. Still read-only — it is browsing a public job list.
  await runTrial({
    name: 'Trial R4 — real portal, the portal\'s OWN same-document route change (pagination)',
    mechanism: 'real Workday tenant, same-document route change driven by the portal itself',
    start: openList,
    act: async (p) => {
      const clicked = await p.evaluate(() => {
        const cands = [...document.querySelectorAll('button,a[role="button"],a')];
        const next = cands.find(el => {
          const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.trim();
          return /^next|next page|next \d/i.test(label) || el.dataset.uxiWidgetType === 'stepToNextButton';
        });
        if (!next) return null;
        next.scrollIntoView({ block: 'center' });
        return next.getAttribute('aria-label') || (next.textContent || '').trim().slice(0, 40);
      });
      if (!clicked) { console.log('  no pagination control found'); return 'no pagination control found'; }
      console.log(`  paginating via: ${clicked}`);
      // Trusted click, for the same reason as R1.
      const handle = await p.evaluateHandle((label) => {
        const cands = [...document.querySelectorAll('button,a[role="button"],a')];
        return cands.find(el => `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.includes(label));
      }, clicked);
      await handle.asElement()?.click().catch(e => console.log(`  click failed: ${e.message}`));
      await sleep(4000);
    },
    settleMs: 4000,
  });

  await runTrial({
    name: 'Trial R3 — real portal, PAGE-initiated same-origin navigation',
    mechanism: 'real Workday tenant, new document, renderer-initiated (location.assign)',
    start: openList,
    act: async (p) => {
      await p.evaluate(u => { location.assign(u); }, `${url}?g0probe=2`);
      await sleep(5000);
    },
    settleMs: 4000,
  });
}

// ── Summary ──────────────────────────────────────────────────────────────────────────────────
function summarise(results) {
  console.log('\n\n=== FINDINGS ===\n');
  const w = Math.max(...results.map(r => r.name.length), 10);
  for (const r of results) {
    console.log(`${r.name.padEnd(w)}  ${r.verdict}` +
      (r.verdict === 'VOID' ? `  (${r.reason})`
        : `  [inject after: ${r.afterOk}/${r.afterTotal}` +
          `  same-doc: ${r.sameDocument}  session: ${r.sessionPacketIntact}]`));
  }

  const control = results.find(r => r.name.startsWith('Trial C'));
  console.log('');
  if (!control || control.verdict !== 'REVOKED') {
    console.log('RUN IS VOID. The cross-origin control did not show a revocation, so the probe');
    console.log('cannot distinguish a surviving grant from a broken measurement. Do not record a');
    console.log('finding from this run.');
    process.exitCode = 1;
    return;
  }
  console.log('Control OK: the cross-origin case was revoked, so revocation is observable.');

  // The three-way branch the task prompt anticipated (survives both / SPA only / neither) does not
  // fit what the trials found. The dividing line is not the navigation MECHANISM at all — a
  // pushState, a form POST, a reload, a scripted assign and a browser-initiated goto all behave
  // identically. It is the ORIGIN, plus one boundary nobody listed: the tab itself.
  const v = (prefix) => results.find(r => r.name.startsWith(`Trial ${prefix}`))?.verdict;
  const sameDocument   = [v('A')];
  const sameOrigin     = [v('B'), v('D'), v('E'), v('F'), v('R2'), v('R3')].filter(Boolean);
  const crossOrigin    = [v('C')];
  const held = (xs) => xs.length > 0 && xs.every(x => x === 'SURVIVED');

  console.log('');
  console.log(`same-document URL change      ${sameDocument.join(' ') || 'not measured'}`);
  console.log(`same-origin document load     ${sameOrigin.join(' ') || 'not measured'}  (${sameOrigin.length} trials)`);
  console.log(`cross-origin navigation       ${crossOrigin.join(' ') || 'not measured'}`);

  const newTab = results.find(r => /NEW TAB/.test(r.reason || ''));
  console.log('');
  if (held(sameDocument) && held(sameOrigin) && crossOrigin[0] === 'REVOKED') {
    console.log('INTERACTION MODEL: one gesture per application, for as long as the flow stays on one');
    console.log('origin IN THE SAME TAB. Neither a step transition nor a full page load costs a');
    console.log('re-invoke. Two things do:');
    console.log('  - leaving the origin (an SSO hop to a different host revokes the grant)');
    if (newTab) {
      console.log('  - the portal opening a step in a NEW TAB — observed on a real Workday tenant, whose');
      console.log('    job links are target=_blank. The grant is per-tab and does not follow.');
    }
  } else if (held(sameDocument) && !held(sameOrigin)) {
    console.log('INTERACTION MODEL: one gesture per REAL navigation. Design steps as same-document');
    console.log('transitions where we control them; expect a re-invoke at every document load.');
  } else if (!held(sameDocument)) {
    console.log("INTERACTION MODEL: one gesture per page. G3's overlay must make re-invoking");
    console.log('near-free, and G2 must be built to resume a partly filled form.');
  } else {
    console.log('INCONCLUSIVE — the trial set did not cover enough cases to name a model.');
  }

  const sessionAlways = results.filter(r => r.verdict !== 'VOID').every(r => r.sessionPacketIntact);
  if (sessionAlways) {
    console.log('\nchrome.storage.session survived EVERY transition, including the ones that revoked the');
    console.log('grant. So a packet outlives its grant: a re-invoke can resume without re-fetching, and');
    console.log('G2 requirement 6 must clear the packet deliberately because nothing else will.');
  }
  console.log(`\nFull log: ${path.join(OUT_DIR, 'g0-results.json')}`);
}

main().catch(e => { console.error('\nSPIKE FAILED:', e); process.exit(1); });
