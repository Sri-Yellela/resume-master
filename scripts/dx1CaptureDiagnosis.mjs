#!/usr/bin/env node
/**
 * DX1 — DIAGNOSIS ONLY. Reproduces the reported capture failure in a real browser, with the real
 * extension, a real activeTab grant from a real OS keypress, and the REAL server.js.
 *
 * It changes nothing. It answers one question per symptom with an observation:
 *   1. which origin the extension talks to, and whether that origin answers
 *   2. whether the extension is authenticated at all (PROBE_AUTH)
 *   3. whether extractor.js RAN and what it found            <- separates parse from network
 *   4. the ACTUAL HTTP status and error text from /api/import/job
 *   5. how long the whole capture took                       <- the "under a second" claim
 *   6. whether an extension-origin credentialed fetch reaches an ADMIN route
 *
 * The service worker's console is mirrored to stdout, which is where a failed fetch inside it
 * would otherwise die silently.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';
import { LEGACY_ORIGIN } from '../shared/brand.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(os.tmpdir(), 'dx1-capture-diagnosis');
const API_PORT = 4613;
const JOBS_PORT = 4601;
const API = `http://127.0.0.1:${API_PORT}`;
const JOBS = `http://localhost:${JOBS_PORT}`;
const DATA_DIR = path.join(OUT, 'data');
const PASSWORD = 'Dx1-Harness-pass!9';
const LEGACY_URL_DECL = `const RESUME_MASTER_URL = '${LEGACY_ORIGIN}';`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const line = s => console.log(s);
const obs = (label, value) => console.log(`  ${label.padEnd(46)} ${value}`);

// ── Two job pages on an origin the extension has NO host permission for ──────────────────────
// Extraction must be able to SUCCEED here, so that a failure downstream is provably not parsing.
const DESC = 'We are looking for a senior backend engineer to own our payments platform. You will '
  + 'design and ship services in Node.js and Postgres, work with product and design, and mentor '
  + 'other engineers. Five plus years of professional experience required. Remote friendly.';

function jobPage({ title, company, location, linkedinShaped }) {
  const ld = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'JobPosting', title,
    hiringOrganization: { '@type': 'Organization', name: company },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: location } },
    description: DESC,
  });
  // The LinkedIn-shaped page deliberately uses LinkedIn's own class names and NO JSON-LD, which is
  // the harder of the two paths and the one reported as failing.
  if (linkedinShaped) {
    return `<!doctype html><html><head><title>${title} | ${company} | LinkedIn</title></head><body>
      <h1 class="top-card-layout__title">${title}</h1>
      <a class="topcard__org-name-link">${company}</a>
      <span class="topcard__flavor--bullet">${location}</span>
      <div class="description__text"><p>${DESC}</p></div></body></html>`;
  }
  return `<!doctype html><html><head><title>${title} — ${company}</title>
    <script type="application/ld+json">${ld}</script></head><body>
    <h1>${title}</h1><div class="company">${company}</div><div class="location">${location}</div>
    <div class="content"><p>${DESC}</p></div></body></html>`;
}

function startJobsSite() {
  const pages = {
    '/careers': jobPage({ title: 'Senior Backend Engineer', company: 'Northwind Systems', location: 'Boston, MA', linkedinShaped: false }),
    '/linkedin': jobPage({ title: 'Staff Software Engineer', company: 'Contoso', location: 'Seattle, WA', linkedinShaped: true }),
  };
  const srv = http.createServer((req, res) => {
    const body = pages[req.url.split('?')[0]];
    if (!body) { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(body);
  });
  return new Promise(r => srv.listen(JOBS_PORT, 'localhost', () => r(srv)));
}

// ── The extension copy, dev switch flipped at the API origin ─────────────────────────────────
function buildTestExtension(apiOrigin) {
  const src = path.join(ROOT, 'extension');
  const dst = path.join(OUT, 'extension');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name === 'submission') continue;
      fs.cpSync(path.join(src, e.name), path.join(dst, e.name), { recursive: true }); }
    else fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
  for (const f of ['background.js', 'config.js']) {
    const p = path.join(dst, f);
    const t = fs.readFileSync(p, 'utf8');
    if (!t.includes(LEGACY_URL_DECL)) throw new Error(`${f}: URL constant not found — the rewrite would be a silent no-op`);
    fs.writeFileSync(p, t.replace(LEGACY_URL_DECL, `const RESUME_MASTER_URL = '${apiOrigin}';`));
  }
  const mf = JSON.parse(fs.readFileSync(path.join(dst, 'manifest.json'), 'utf8'));
  mf.host_permissions = [...mf.host_permissions, `${apiOrigin}/*`];
  fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(mf, null, 2));
  const coversJobs = mf.host_permissions.some(h => /\/\/(\*\.)?localhost/.test(h) || h.includes('<all_urls>'));
  if (coversJobs) throw new Error('ABORT: a host permission covers the job site; activeTab would not be exercised');
  return dst;
}

// ── A real OS-level hotkey, delivered to the Chrome window we launched ───────────────────────
const PS_HOTKEY = `param([int]$BrowserPid,[int]$VKey)
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class DX { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h,bool f);
[DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,int f,UIntPtr e);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb,IntPtr p);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
public delegate bool EnumProc(IntPtr h,IntPtr p); }
"@
$found=[IntPtr]::Zero
$cb=[DX+EnumProc]{param($h,$p) $pid2=0; [void][DX]::GetWindowThreadProcessId($h,[ref]$pid2)
  if($pid2 -eq $BrowserPid -and [DX]::IsWindowVisible($h)){$script:found=$h;return $false} return $true}
[void][DX]::EnumWindows($cb,[IntPtr]::Zero)
if($found -eq [IntPtr]::Zero){Write-Output 'NO_WINDOW';exit 3}
$KEYUP=2
for($a=1;$a -le 3;$a++){
  if($a -eq 1){[DX]::keybd_event(0x12,0,0,[UIntPtr]::Zero);[DX]::keybd_event(0x12,0,$KEYUP,[UIntPtr]::Zero);[void][DX]::SetForegroundWindow($found)}
  elseif($a -eq 2){[DX]::SwitchToThisWindow($found,$true)}
  else{[void][DX]::ShowWindow($found,6);Start-Sleep -Milliseconds 250;[void][DX]::ShowWindow($found,9);[void][DX]::SetForegroundWindow($found)}
  Start-Sleep -Milliseconds 500
  if([DX]::GetForegroundWindow() -eq $found){break}}
if([DX]::GetForegroundWindow() -ne $found){Write-Output 'NOT_FOREGROUND';exit 4}
[DX]::keybd_event(0x11,0,0,[UIntPtr]::Zero);[DX]::keybd_event(0x10,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[DX]::keybd_event($VKey,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 40
[DX]::keybd_event($VKey,0,$KEYUP,[UIntPtr]::Zero)
[DX]::keybd_event(0x10,0,$KEYUP,[UIntPtr]::Zero);[DX]::keybd_event(0x11,0,$KEYUP,[UIntPtr]::Zero)
Write-Output 'SENT'`;

function sendHotkey(browserPid, vkey) {
  const script = path.join(OUT, 'hotkey.ps1');
  fs.writeFileSync(script, PS_HOTKEY);
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-BrowserPid', String(browserPid), '-VKey', String(vkey)],
    { encoding: 'utf8', timeout: 30000 });
  return `${r.stdout || ''}`.includes('SENT');
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  line('=== DX1 — capture failure, diagnosed in a real browser ===\n');

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error('No Chrome binary.'); process.exit(1); }

  // The REAL server, with the REAL Anthropic key from .env, on a throwaway data dir.
  const envFile = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
    .split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ...envFile, RM_DATA_DIR: DATA_DIR, PORT: String(API_PORT),
           NODE_ENV: 'development', SESSION_SECRET: 'dx1-secret',
           ADMIN_USER: 'dx1_admin', ADMIN_PASSWORD: 'Dx1-Admin-pass!9' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', d => serverLog.push(String(d)));
  server.stderr.on('data', d => serverLog.push(String(d)));

  for (let i = 0; i < 90; i++) {
    const up = await fetch(`${API}/api/health`).then(r => r.ok).catch(() => false);
    if (up) break; await sleep(1000);
  }
  line(`server   ${API}   (real server.js, throwaway data dir)`);
  const jobs = await startJobsSite();
  line(`jobs     ${JOBS}   (activeTab only — no host permission)\n`);

  const extDir = buildTestExtension(API);
  const profile = path.join(OUT, 'profile');
  const browser = await puppeteer.launch({
    executablePath: resolution.path, headless: false, pipe: true, enableExtensions: true,
    userDataDir: profile, args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,1000'],
    defaultViewport: null,
  });

  try {
    const extensionId = await browser.installExtension(extDir);
    const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 20000 }).catch(() => null);
    const sw = swTarget ? await swTarget.worker().catch(() => null) : null;
    const swLog = [];
    if (sw) sw.on('console', m => { swLog.push(m.text()); console.log(`      [sw] ${m.text()}`); });

    // Sign in FROM A PAGE ON THE API ORIGIN, so the cookie is a real browser cookie on that host.
    const api = await browser.newPage();
    await api.goto(`${API}/api/health`);
    const signup = await api.evaluate(async (pw) => {
      const reg = await fetch('/api/auth/register', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'dx1user', password: pw, profile: { email: 'dx1@example.com', first_name: 'Dx', last_name: 'One' } }) });
      const me = await fetch('/api/auth/me', { credentials: 'include' }).then(r => r.json());
      return { reg: reg.status, me };
    }, PASSWORD);
    line(`\n── 0 · the browser now holds a session on the API origin ──`);
    obs('register status', signup.reg);
    obs('/api/auth/me says', JSON.stringify(signup.me));

    const control = await browser.newPage();
    await control.goto(`chrome-extension://${extensionId}/options.html`);

    line(`\n── 1 · what the extension is configured to talk to ──`);
    const cfg = await control.evaluate(() => fetch(chrome.runtime.getURL('config.js')).then(r => r.text()));
    obs('config.js origin', (cfg.match(/RESUME_MASTER_URL = '([^']+)'/) || [])[1]);
    const mf = await control.evaluate(() => chrome.runtime.getManifest());
    obs('host_permissions', mf.host_permissions.join('  '));
    obs('version', mf.version);

    line(`\n── 2 · is the extension authenticated? (PROBE_AUTH, from the worker) ──`);
    const probe = await control.evaluate(() => chrome.runtime.sendMessage({ type: 'PROBE_AUTH' }));
    obs('PROBE_AUTH', JSON.stringify(probe));

    line(`\n── 3 · are the commands registered at RUNTIME? ──`);
    const cmds = await control.evaluate(() => chrome.commands.getAll());
    for (const c of cmds) obs(c.name, c.shortcut || 'UNBOUND');

    line(`\n── 4 · capture, on each page, with a real grant ──`);
    const page = (await browser.pages())[0];
    for (const [label, url] of [['employer careers page', `${JOBS}/careers`], ['LinkedIn-shaped page', `${JOBS}/linkedin`]]) {
      await control.evaluate(() => chrome.storage.local.remove('lastCapture'));
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.bringToFront();
      await sleep(500);

      // Did the extractor itself work? Run it in the page directly — no network, no grant needed
      // from here, because this is puppeteer's own evaluate, not the extension.
      const extractorSrc = fs.readFileSync(path.join(ROOT, 'extension', 'extractor.js'), 'utf8');
      const fnSrc = extractorSrc.slice(extractorSrc.indexOf('export function extractJobPayload'))
        .replace('export function', 'function');
      const body = fnSrc.slice(0, fnSrc.indexOf('\n}\n') + 3);
      const extracted = await page.evaluate(`(() => { ${body}; return extractJobPayload(); })()`).catch(e => ({ err: e.message }));

      const t0 = Date.now();
      const sent = sendHotkey(browser.process().pid, 0x4B); // K
      let last = null;
      for (let i = 0; i < 60; i++) {
        last = (await control.evaluate(() => chrome.storage.local.get('lastCapture')))?.lastCapture;
        if (last) break; await sleep(100);
      }
      const ms = Date.now() - t0;

      line(`\n  ${label}  (${url})`);
      obs('hotkey delivered', sent);
      obs('extractor ran and found', extracted?.err ? `ERROR ${extracted.err}`
        : `ok=${extracted.ok} title=${JSON.stringify(extracted.title)} desc=${(extracted.text || '').length}ch`);
      obs('capture outcome', last ? `success=${last.success}  "${last.message}"` : 'NOTHING RECORDED');
      obs('elapsed', `${ms} ms`);
    }

    line(`\n── 5 · the raw HTTP answer /api/import/job gives, same cookie ──`);
    const raw = await api.evaluate(async () => {
      const t0 = performance.now();
      const r = await fetch('/api/import/job', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'http://localhost:4601/careers', text: document.title + ' '.repeat(1) + 'Senior Backend Engineer at Northwind Systems. ' + 'x'.repeat(400) }) });
      return { status: r.status, body: (await r.text()).slice(0, 300), ms: Math.round(performance.now() - t0) };
    });
    obs('status', raw.status); obs('body', raw.body); obs('elapsed', `${raw.ms} ms`);

    line(`\n── 6 · can an EXTENSION-origin credentialed fetch reach an ADMIN route? ──`);
    const adminProbe = await control.evaluate(async (origin) => {
      const out = {};
      for (const p of ['/api/auth/me', '/api/admin/db/tables', '/api/admin/users', '/api/admin/stats']) {
        try { const r = await fetch(origin + p, { credentials: 'include' });
          out[p] = r.status; } catch (e) { out[p] = 'threw:' + e.message; }
      }
      return out;
    }, API);
    for (const [k, v] of Object.entries(adminProbe)) obs(k, v);

    line(`\n── 7 · what the popup shows about WHO it is acting as ──`);
    const popupHtml = fs.readFileSync(path.join(ROOT, 'extension', 'popup.html'), 'utf8');
    obs('popup names an identity?', /signed in as/i.test(popupHtml) ? 'yes' : 'NO — no identity element in popup.html');

    fs.writeFileSync(path.join(OUT, 'server.log'), serverLog.join(''));
    const anth = serverLog.join('').match(/.*(credit balance|invalid_request_error|anthropic|401|authentication).*/gi) || [];
    line(`\n── 8 · what the SERVER logged during the captures ──`);
    for (const l of anth.slice(-8)) line(`  ${l.trim().slice(0, 200)}`);
    line(`\n  (full server log: ${path.join(OUT, 'server.log')})`);
    line(`  (service worker console lines captured: ${swLog.length})`);
  } finally {
    await browser.close().catch(() => {});
    jobs.close();
    server.kill();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
