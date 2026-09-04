#!/usr/bin/env node
/**
 * TASK AB1 — a held review is RESUMABLE, real-run verification.
 * ============================================================================================
 * THE DEFECT
 * For a held application the panel offered "Filled form ↗", which opened a SCREENSHOT of a form in
 * a Puppeteer context that had already closed, and beneath it the raw apply URL, which opened a
 * brand-new EMPTY application. There was no route from held to submitted. The user had to redo by
 * hand every answer the system had already resolved. That is the pipeline failing to complete, not
 * a cosmetic problem, and no amount of link-fixing recovers a dead browser context.
 *
 * WHAT IS VERIFIED HERE, AND WHY IT HAS TO BE A REAL RUN
 * A unit test can assert that shouldBuildPacket() returns true. It cannot assert that a REAL apply
 * run, holding on a REAL form, leaves behind a packet that a REAL extension can replay into that
 * same form in a REAL browser under a REAL activeTab grant — which is the only claim that matters.
 * So this drives the actual pipeline against scripts/fakeAts.js and then drives the actual
 * extension, and asserts against what the ATS RECORDS RECEIVING, never against a status.
 *
 * Stage A — the pipeline (real browser, headless, via routes/apply.js)
 *   A1  an auto run on a real form HOLDS, and leaves a packet behind
 *   A2  the packet carries the answers the run actually resolved, not a profile-only fallback
 *   A3  the held review stays OUT of the portal sign-in batches
 *   A4  a stale packet reports expiry at the mint, with a remedy, and mints nothing
 *   A5  a packet whose posting is gone says so as a state
 *
 * Stage B — the handoff (real Chrome, real extension, real OS keypress)
 *   B1  ORIGIN MISMATCH RELEASES NOTHING, and does not spend the token
 *   B2  invoking on the prepared form fills it with the SAME answers the run resolved
 *   B3  the provenance overlay renders, naming where each value came from
 *   B4  the human answers what only they can answer, submits, and the ATS RECORDS THE APPLICATION
 *
 * B4 is the whole point: the pipeline completes. Before this task it could not.
 *
 * ORIGIN SPLIT (inherited from G2, and load-bearing)
 * The API runs on 127.0.0.1 and the portal on localhost. Those are DIFFERENT ORIGINS to Chrome even
 * though both are this machine. The extension gets a host permission for the API only, so the portal
 * is reachable ONLY through the activeTab grant — which is the property under test. If a host
 * permission ever covered the portal, every assertion below would pass without the grant.
 *
 * Usage:  A1_RESUME=/path/to/any.pdf node scripts/ab1HeldHandoff.mjs
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
import { PACKET_STALE_MS } from '../services/applyGatePacket.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(os.tmpdir(), 'ab1-held-handoff');
const ATS_PORT = 4599;
const PORTAL = `http://localhost:${ATS_PORT}`;   // the application's origin — activeTab only
// The lever form is the target: single step, and its ONE unanswerable control is an eligibility
// attestation the resolver refuses to guess. That is what makes it hold, and it is exactly the
// obstacle AB1 is about — "the form asked something only you can answer".
const FORM_PATH = '/lever?ats=jobs.lever.co';
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

// The exact values the packet should carry into the form. Asserted by IDENTITY later: a fill that
// puts something plausible in a field is not the same as a fill that puts OUR answer there.
const FIELD_MAP = {
  first_name: 'Ada', last_name: 'Lovelace', full_name: 'Ada Lovelace',
  email: 'ada@example.com', phone: '+1 555 0100', location: 'Boston, MA',
  address_line1: '12 Analytical Way', city: 'Boston', state: 'MA', zip: '02115',
  country: 'United States', linkedin_url: 'https://linkedin.com/in/ada',
};

// ── API server on 127.0.0.1 ──────────────────────────────────────────────────────────────────
function startApi() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'PRO');
    CREATE TABLE domain_profiles (id INTEGER PRIMARY KEY, user_id INTEGER, profile_name TEXT,
      role_family TEXT, domain TEXT, is_active INTEGER DEFAULT 0,
    generate_at_queue INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE user_profile (user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
      full_name TEXT, email TEXT, phone TEXT, custom_answers TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE user_integrations (user_id INTEGER, provider TEXT, status TEXT, account_email TEXT,
      updated_at INTEGER, last_checked_at INTEGER);
    CREATE TABLE profile_base_resumes (profile_id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT,
      content TEXT, enhanced_content TEXT, enhanced_at INTEGER, enhanced_ats_delta REAL, updated_at INTEGER);
    CREATE TABLE base_resume (user_id INTEGER PRIMARY KEY, name TEXT, content TEXT,
      enhanced_content TEXT, enhanced_at INTEGER, enhanced_ats_delta REAL, updated_at INTEGER);
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
      base_ats_score INTEGER, base_ats_json TEXT,
      open_questions_json TEXT,
    -- gate_review_json is deliberately NOT declared here: migration 080_apply_gate_review, applied
    -- a few lines below, ALTERs it in. Declaring it too makes that ALTER a duplicate-column error
    -- and the harness dies before its first assertion.
    ats_score INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0, fields_discovered INTEGER, corrections_json TEXT, blanks_json TEXT, hidden_at INTEGER,
    locked_at INTEGER, resume_file TEXT, resume_id INTEGER, UNIQUE(run_id, job_id));
    CREATE TABLE apply_job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, run_job_id INTEGER,
      user_id INTEGER, job_id TEXT, level TEXT DEFAULT 'info', event TEXT, message TEXT,
      details_json TEXT, created_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE apply_idempotency (user_id INTEGER NOT NULL, idem_key TEXT NOT NULL, endpoint TEXT NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 200, response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (user_id, idem_key));
    CREATE TABLE job_applications (user_id INTEGER, job_id TEXT, company TEXT, role TEXT, job_url TEXT,
      source TEXT, location TEXT, apply_mode TEXT, resume_file TEXT, applied_at INTEGER, notes TEXT,
      auto_status TEXT, UNIQUE(user_id, job_id));
    CREATE TABLE user_jobs (user_id INTEGER, job_id TEXT, domain_profile_id INTEGER,
      applied INTEGER DEFAULT 0, updated_at INTEGER, UNIQUE(user_id, job_id));
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT (unixepoch()));
    INSERT INTO users (id, username, plan_tier) VALUES (1, 'ada', 'PRO');
    INSERT INTO domain_profiles (id, user_id, profile_name, is_active) VALUES (10, 1, 'SWE', 1);
    INSERT INTO user_profile (user_id, first_name, last_name, email)
      VALUES (1, 'Ada', 'Lovelace', 'ada@example.com');
    INSERT INTO profile_base_resumes (profile_id, user_id, name, content, updated_at)
      VALUES (10, 1, 'r.txt', 'real resume text', unixepoch());
  `);
  for (const id of ['079_apply_gate_packets', '080_apply_gate_review', '081_company_form_schemas']) {
    db.exec(MIGRATIONS.find(m => m.id === id).sql);
  }
  // Two jobs on the SAME form: one is resumed end to end, the other is aged into staleness. Seeded
  // with a pre-existing artifact so the run takes the "existing resume" path and does not need a
  // model call.
  for (const jobId of ['ab1live', 'ab1stale', 'ab1gone']) {
    const u = `${PORTAL}${FORM_PATH}`;
    db.prepare(`INSERT INTO scraped_jobs (job_id, title, company, url, apply_url, source, location)
                VALUES (?, 'Backend Engineer', 'OpenAI', ?, ?, 'lever', 'Remote')`).run(jobId, u, u);
    db.prepare(`INSERT INTO resumes (user_id, job_id, apply_mode, ats_score, html, updated_at)
                VALUES (1, ?, 'TAILORED', 88, '<html><body>resume</body></html>', unixepoch())`).run(jobId);
  }

  const app = express();
  app.use(express.json());
  // CORS for the extension's credentialed fetches: its origin is chrome-extension://<id>, which a
  // same-site deployment never has to reflect.
  app.use((req, res, next) => {
    const o = req.headers.origin;
    if (o) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Access-Control-Allow-Credentials', 'true'); }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use((req, _res, next) => { req.user = { id: 1, planTier: 'PRO' }; next(); });
  applyRoutes(app, db, (q, r, n) => n(),
    () => ({ field_map: FIELD_MAP, handler_map: {}, custom_answers: {} }),
    async () => ({ error: 'not_needed' }),
    async () => fs.readFileSync(RESUME_PDF),
    async () => ({}));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ db, server }));
  });
}

// ── The extension copy, with the dev switch flipped ──────────────────────────────────────────
// extension/ is NOT modified. The copy points at the local API and gains a host permission for
// 127.0.0.1 ONLY — never for localhost, which is the portal.
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
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(
      /const RESUME_MASTER_URL = 'https:\/\/resumemaster\.one';/,
      `const RESUME_MASTER_URL = '${apiOrigin}';`));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dst, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [...manifest.host_permissions, `${apiOrigin}/*`];
  fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const coversPortal = manifest.host_permissions.some(
    h => /\/\/(\*\.)?localhost/.test(h) || h.includes('<all_urls>'));
  return { dir: dst, manifest, coversPortal };
}

// ── The gesture ──────────────────────────────────────────────────────────────────────────────
// Ctrl+Shift+Y as a real OS key event to the Chrome window we launched, located by process rather
// than by title, and refusing to send unless that window is already foreground. Same approach as
// scripts/g0ActiveTabSpike.mjs and g2ExtensionHandoff.mjs — there is no way to fake an activeTab
// grant, so the gesture has to be real.
const PS_SEND_HOTKEY = String.raw`
param([int]$BrowserPid)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace AB1 -Name Win -MemberDefinition @'
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
    [AB1.Win]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)
    [AB1.Win]::keybd_event(0x12, 0, $KEYUP, [System.UIntPtr]::Zero)
    [void][AB1.Win]::SetForegroundWindow($h)
  } elseif ($a -eq 2) { [AB1.Win]::SwitchToThisWindow($h, $true) }
  else {
    [void][AB1.Win]::ShowWindow($h, 6); Start-Sleep -Milliseconds 250
    [void][AB1.Win]::ShowWindow($h, 9); [void][AB1.Win]::SetForegroundWindow($h)
  }
  Start-Sleep -Milliseconds 500
  if ([AB1.Win]::GetForegroundWindow() -eq $h) { break }
}
if ([AB1.Win]::GetForegroundWindow() -ne $h) { Write-Output 'NOT_FOREGROUND'; exit 4 }
[AB1.Win]::keybd_event(0x11, 0, 0, [System.UIntPtr]::Zero)
[AB1.Win]::keybd_event(0x10, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[AB1.Win]::keybd_event(0x59, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[AB1.Win]::keybd_event(0x59, 0, $KEYUP, [System.UIntPtr]::Zero)
[AB1.Win]::keybd_event(0x10, 0, $KEYUP, [System.UIntPtr]::Zero)
[AB1.Win]::keybd_event(0x11, 0, $KEYUP, [System.UIntPtr]::Zero)
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

/**
 * IS ANYONE THERE?
 *
 * This harness delivers a REAL Ctrl+Shift+Y, because chrome.commands + activeTab only grants on a
 * genuine user gesture and a synthetic one would grant nothing — that is the property under test,
 * so it cannot be stubbed. Windows can refuse SetForegroundWindow (the foreground lock), and when
 * it does, the script below used to print "press Ctrl+Shift+Y manually, 45s" and WAIT.
 *
 * Interactively that is the right behaviour. Inside verifyHarnesses there is nobody to press it, so
 * the run burned 45s per invoke and then failed thirteen downstream assertions — which read as the
 * handoff being broken. Measured once: 128s and 13 failures in the suite, 35/35 and 16s alone.
 * A harness that blames the product for the absence of a human is worse than one that does not run.
 *
 * verifyHarnesses sets RM_UNATTENDED so every harness with a human-in-the-loop path can tell.
 */
const UNATTENDED = process.env.RM_UNATTENDED === '1' || !process.stdout.isTTY;

/**
 * Press it, and mean it. The PowerShell side already escalates through three ways of taking
 * foreground WITHIN one call; this retries the whole call, because a foreground lock is usually
 * transient and a fresh bringToFront between attempts is what clears it.
 */
async function pressHandoffKey(browser, page) {
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.bringToFront().catch(() => {});
    await sleep(attempt === 1 ? 400 : 900);
    const key = sendHotkey(browser.process().pid);
    if (key.ok) return { ok: true, attempts: attempt };
    last = key.out;
    if (attempt < 3) console.log(`  hotkey attempt ${attempt} failed (${key.out}) — retrying`);
  }
  return { ok: false, out: last };
}

// ── Run ──────────────────────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('=== AB1 — a held review is resumable ===\n');

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error('No Chrome binary.'); process.exit(1); }

  let ats = null;
  const alive = await new Promise(res => {
    const rq = http.get(`${PORTAL}/lever`, r => { r.resume(); res(r.statusCode === 200); });
    rq.on('error', () => res(false)); rq.setTimeout(1500, () => { rq.destroy(); res(false); });
  });
  if (!alive) {
    ats = spawn(process.execPath, [path.join(ROOT, 'scripts', 'fakeAts.js')],
      { env: { ...process.env, PORT: String(ATS_PORT) }, stdio: 'ignore' });
    await sleep(1500);
  }
  await fetch(`${PORTAL}/_reset`, { method: 'POST' });

  const { db, server: apiServer } = await startApi();
  const apiOrigin = `http://127.0.0.1:${apiServer.address().port}`;
  const api = (p, init) => fetch(`${apiOrigin}${p}`, {
    headers: { 'content-type': 'application/json' }, ...init,
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const atsSubs = () => fetch(`${PORTAL}/_submissions`).then(r => r.json());

  console.log(`api      ${apiOrigin}   (host permission granted — NOT the portal)`);
  console.log(`portal   ${PORTAL}   (activeTab only)\n`);

  let browser = null;
  try {
    // ══ STAGE A — the pipeline holds, and leaves something behind ═════════════════════════════
    console.log('── A. the pipeline ──');
    const runIds = {};
    for (const jobId of ['ab1live', 'ab1stale', 'ab1gone']) {
      const r = await api('/api/apply/runs', { method: 'POST', body: JSON.stringify({ jobIds: [jobId], mode: 'auto' }) });
      runIds[jobId] = r.body.runId;
      // Serialised: the pipeline refuses concurrent runs, and a refused run is not a held one.
      const t0 = Date.now();
      while (Date.now() - t0 < 240000) {
        if (db.prepare("SELECT COUNT(*) n FROM apply_runs WHERE status IN ('queued','running')").get().n === 0) break;
        await sleep(800);
      }
    }

    const live = db.prepare('SELECT * FROM apply_run_jobs WHERE job_id=?').get('ab1live');
    check('A1  a real run on a real form HOLDS rather than submitting',
      live?.status === 'held_review', `${live?.status} / ${live?.reason_code}`);
    check('A1  and nothing was sent to the employer while it was held',
      (await atsSubs()).count === 0, `ats recorded ${(await atsSubs()).count}`);

    const packets = (await api('/api/apply/gate-packets')).body;
    const livePacket = packets.packets.find(p => p.jobId === 'ab1live');
    check('A1  THE HELD REVIEW LEFT A PACKET BEHIND — this is the defect, and the fix',
      !!livePacket, livePacket ? `packet #${livePacket.packetId}` : 'NO PACKET — the hold is a dead end');
    if (!livePacket) throw new Error('no packet for the held review; nothing downstream can be verified');
    check('A1  the packet points at the form, not at the posting listing',
      livePacket.expectedOrigin === PORTAL, livePacket.applyUrl);
    check('A1  it is labelled a per-application review, not a portal crossing',
      livePacket.kind === 'review', `kind=${livePacket.kind} reason=${livePacket.gateReason}`);

    const stored = JSON.parse(db.prepare('SELECT answers_json a FROM apply_gate_packets WHERE id=?')
      .get(livePacket.packetId).a);
    check('A2  the packet carries what the run ACTUALLY resolved against the form',
      stored.source === 'discovered_form', `source=${stored.source}`);
    check('A2  with real per-field provenance, not an invented confidence',
      stored.answers.length > 0 && stored.answers.every(a => 'provenance' in a),
      `${stored.answers.length} answers`);
    check('A2  and the resume that was generated travels with it',
      livePacket.resumeAvailable === true);

    check('A3  a held review is NOT offered as a portal sign-in batch',
      packets.portals.length === 0,
      `portals=${JSON.stringify(packets.portals.map(p => `${p.host}:${p.count}`))}`);

    // A4 — staleness. Backdated rather than waited for; the clock is the only thing being faked.
    const stalePacket = packets.packets.find(p => p.jobId === 'ab1stale');
    db.prepare('UPDATE apply_gate_packets SET created_at=? WHERE id=?')
      .run(Math.floor((Date.now() - PACKET_STALE_MS - 86400_000) / 1000), stalePacket.packetId);
    const relisted = (await api('/api/apply/gate-packets')).body
      .packets.find(p => p.packetId === stalePacket.packetId);
    check('A4  a stale packet is still LISTED, so it can report itself',
      !!relisted && relisted.stale === true, `stale=${relisted?.stale} age=${relisted?.ageMs}`);
    const staleMint = await api(`/api/apply/gate-packets/${stalePacket.packetId}/token`, { method: 'POST' });
    check('A4  minting a stale packet is REFUSED with expiry, not silently filled',
      staleMint.status === 410 && staleMint.body.error === 'packet_stale',
      `${staleMint.status} ${staleMint.body.error}`);
    check('A4  the refusal offers a re-run rather than leaving the user stuck',
      staleMint.body.remedy === 'rerun' && /again/i.test(staleMint.body.message || ''),
      staleMint.body.message);
    check('A4  and no token was issued',
      /^unminted:/.test(db.prepare('SELECT token_hash t FROM apply_gate_packets WHERE id=?')
        .get(stalePacket.packetId).t));

    // A5 — the posting is gone. This is the row that reads "(posting no longer on the board)".
    db.prepare('DELETE FROM scraped_jobs WHERE job_id=?').run('ab1gone');
    const gonePacket = (await api('/api/apply/gate-packets')).body.packets.find(p => p.jobId === 'ab1gone');
    check('A5  a held review for a vanished posting reports THAT, as its own state',
      gonePacket?.postingGone === true && gonePacket?.title === null,
      `postingGone=${gonePacket?.postingGone}`);

    // ══ STAGE B — the handoff, in a real browser ══════════════════════════════════════════════
    console.log('\n── B. the handoff ──');
    const ext = buildTestExtension(apiOrigin);
    if (ext.coversPortal) {
      console.error('ABORT: a host permission covers the portal origin. activeTab would not be exercised.');
      process.exit(1);
    }
    check('B0  the extension still asks for NO host permission on the portal',
      !ext.coversPortal, ext.manifest.host_permissions.join(' '));

    const profile = path.join(OUT_DIR, 'profile');
    fs.rmSync(profile, { recursive: true, force: true });
    browser = await puppeteer.launch({
      executablePath: resolution.path, headless: false, pipe: true, enableExtensions: true,
      userDataDir: profile,
      args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,1000'],
      defaultViewport: null,
    });
    const extensionId = await browser.installExtension(ext.dir);
    const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 }).catch(() => null);
    const sw = swTarget ? await swTarget.worker().catch(() => null) : null;
    if (sw) sw.on('console', m => console.log(`      [sw] ${m.text()}`));

    const control = await browser.newPage();
    await control.goto(`chrome-extension://${extensionId}/options.html`);
    const bound = (await control.evaluate(() => chrome.commands.getAll()))
      .find(c => c.name === 'fill-gated-application');
    check('B0  the handoff command is bound to a key', !!bound?.shortcut, bound?.shortcut || 'UNBOUND');
    if (!bound?.shortcut) throw new Error('no keyboard binding — no gesture can be delivered');

    const page = (await browser.pages())[0];
    // Distinguishable from `null`. `null` means the gesture was delivered and the extension did
    // nothing — a real finding. FOCUS_FAILED means the gesture never happened, which is a fact
    // about this machine and must never be reported as a fact about the product.
    const FOCUS_FAILED = Symbol('focus_failed');
    const invoke = async () => {
      await control.evaluate(() => chrome.storage.session.remove('lastGatedHandoff'));
      const key = await pressHandoffKey(browser, page);
      if (!key.ok) {
        if (UNATTENDED) return FOCUS_FAILED;
        console.log(`  hotkey failed (${key.out}) — press Ctrl+Shift+Y manually, 45s`);
      }
      const deadline = Date.now() + (key.ok ? 15000 : 45000);
      while (Date.now() < deadline) {
        const r = (await control.evaluate(() => chrome.storage.session.get('lastGatedHandoff')))?.lastGatedHandoff;
        if (r) return r;
        await sleep(400);
      }
      return null;
    };
    /**
     * ONE failure, naming the environment, instead of every dependent assertion naming the product.
     *
     * Stage B's remaining checks all read the result of a gesture that never happened, so asserting
     * them would produce thirteen confident statements about a handoff nobody invoked. Throwing
     * stops the stage; the run still FAILS (this counts a failure, and the pass count lands under
     * the baseline, which verifyHarnesses reports as truncated) — but it fails saying the one true
     * thing.
     */
    const requireGesture = (r) => {
      if (r !== FOCUS_FAILED) return r;
      check('B  the browser window could be brought to the foreground to receive the real hotkey',
        false, 'Windows refused foreground after 3 attempts — the gesture was never delivered, so ' +
        'Stage B verified NOTHING. Re-run with the desktop unlocked and no window stealing focus.');
      throw new Error('FOCUS_UNAVAILABLE');
    };
    const consumedAt = () => db.prepare('SELECT consumed_at c FROM apply_gate_packets WHERE id=?')
      .get(livePacket.packetId).c;

    // B1 — FIRST, while the packet is unconsumed. If a mismatch spent the token, everything after
    // would fail and the cause would be invisible.
    console.log('\n  origin mismatch');
    await page.goto(`http://127.0.0.1:${ATS_PORT}/lever`, { waitUntil: 'domcontentloaded' });
    const mismatch = requireGesture(await invoke());
    check('B1  a mismatched origin refuses BECAUSE OF THE ORIGIN, not for some other reason',
      mismatch?.ok === false && mismatch.reason === 'origin_mismatch',
      mismatch ? `${mismatch.reason}: ${mismatch.message}` : 'no result');
    // COUNTED, not just concatenated. "Nothing was written" is a negative assertion, and a negative
    // assertion over an empty haystack is a tautology: if this route ever stopped serving a form,
    // `leaked` would be '' and this would keep passing while testing nothing. The field count is
    // what makes it a real claim — there WERE places to write, and none was written to.
    const leakProbe = await page.evaluate(() => {
      const els = [...document.querySelectorAll('input,select,textarea')];
      return { count: els.length, values: els.map(e => e.value).join('|') };
    });
    const leaked = leakProbe.values;
    check('B1  the mismatched page really had fields to leak into',
      leakProbe.count > 0, `${leakProbe.count} control(s)`);
    check('B1  NOTHING was written into the page — no name, no address, no eligibility answer',
      leakProbe.count > 0 && !/Ada|Lovelace|Analytical|ada@|Boston/.test(leaked),
      `${leakProbe.count} controls, values=${JSON.stringify(leaked).slice(0, 70)}`);
    check('B1  and the token was NOT spent', consumedAt() === null);

    // B2 — the real handoff.
    console.log('\n  the real handoff');
    await page.goto(`${PORTAL}${FORM_PATH}`, { waitUntil: 'domcontentloaded' });
    const result = requireGesture(await invoke());
    check('B2  the handoff ran', result?.ok === true,
      result ? `${result.reason || ''} ${result.message || ''}`.trim() : 'no result');
    check('B2  fields were filled', (result?.filled?.length || 0) > 0, `${result?.filled?.length} filled`);
    const values = await page.evaluate(() => {
      const g = n => document.querySelector(`[name="${n}"]`)?.value ?? null;
      return { name: g('name'), email: g('email'), location: g('location') };
    });
    check('B2  the SAME answers the run resolved reached the real inputs',
      values.name === 'Ada Lovelace' && values.email === 'ada@example.com',
      JSON.stringify(values));
    check('B2  the resume is in the PAGE\'s own file input, readable by the page',
      (await page.evaluate(() => {
        const el = document.querySelector('input[type="file"]');
        return el ? el.files.length : 0;
      })) === 1, JSON.stringify(result?.resume));
    check('B2  the packet was consumed exactly once', consumedAt() !== null,
      `live packet #${livePacket.packetId} consumed_at=${consumedAt()}`);
    check('B2  and it chose the LIVE packet over the stale and the vanished one at the same origin',
      result?.packetId === livePacket.packetId,
      `chose #${result?.packetId}, live is #${livePacket.packetId}`);
    check('B2  the stale packet at that origin was never touched',
      db.prepare('SELECT consumed_at c FROM apply_gate_packets WHERE id=?').get(stalePacket.packetId).c === null);

    // B3 — provenance overlay.
    console.log('\n  the provenance overlay');
    check('B3  the overlay reports itself rendered', result?.overlay?.rendered !== false,
      JSON.stringify(result?.overlay));
    const overlay = await page.evaluate(() => {
      const host = document.getElementById('rm-gate-review-overlay');
      if (!host) return null;
      // Skip the injected <style>: its CSS was dominating textContent, so this assertion was
      // reading a stylesheet and calling it provenance.
      const parts = [...host.children].filter(el => el.tagName !== 'STYLE');
      const text = parts.map(el => el.textContent || '').join(' ');
      return { present: true, len: text.length, text };
    });
    check('B3  a real overlay element is on the real page', overlay?.present === true,
      overlay ? `${overlay.len} chars` : 'ABSENT');
    check('B3  and it names where the values came from, per field',
      /profile|handler|field map|exact|label|guess/i.test(overlay?.text || ''),
      (overlay?.text || '').replace(/\s+/g, ' ').slice(0, 140));

    // B4 — the human finishes it. THE POINT OF THE WHOLE TASK.
    console.log('\n  the human finishes it');
    // This form held because of ONE control the resolver refuses to answer on the candidate's
    // behalf: an eligibility attestation. Answering it is the human's job, by design — so the
    // "human" here answers it, and submits.
    const attested = await page.evaluate(() => {
      const sel = document.querySelector('select[name="cards[authorized_to_work]"]');
      if (!sel) return { found: false };
      const before = sel.value;
      sel.value = 'yes';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, before, after: sel.value };
    });
    check('B4  the attestation was left for the human, not guessed by us',
      attested.found === true && attested.before === '', JSON.stringify(attested));

    const shot = path.join(OUT_DIR, 'ab1-filled-form.png');
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`      screenshot: ${shot}`);

    const before = (await atsSubs()).count;
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
      page.evaluate(() => document.querySelector('form').requestSubmit()),
    ]);
    await sleep(800);
    const subs = await atsSubs();
    check('B4  THE EMPLOYER RECEIVED THE APPLICATION — the pipeline completed',
      subs.count === before + 1, `ats recorded ${subs.count} (was ${before})`);
    const rec = subs.submissions?.[subs.submissions.length - 1];
    check('B4  and what arrived is OUR answers, not a form the user retyped',
      rec?.fields?.name === 'Ada Lovelace' && rec?.fields?.email === 'ada@example.com',
      JSON.stringify(rec?.fields || {}).slice(0, 160));
    check('B4  with the resume attached',
      !!rec?.files && Object.values(rec.files).some(f => f && /\.pdf$/i.test(f.filename || '')),
      JSON.stringify(rec?.files || {}));
    check('B4  and the eligibility answer is the HUMAN\'s, made on the page',
      rec?.fields?.['cards[authorized_to_work]'] === 'yes',
      String(rec?.fields?.['cards[authorized_to_work]']));

    const after = path.join(OUT_DIR, 'ab1-submitted.png');
    await page.screenshot({ path: after, fullPage: true });
    console.log(`      screenshot: ${after}`);

  } catch (e) {
    // FOCUS_UNAVAILABLE has already reported itself as one clear FAIL line naming the environment.
    // Re-raising it would bury that under a stack trace and invite the reader to hunt for a product
    // bug. Every other error is genuinely unexpected and is re-raised.
    if (e?.message !== 'FOCUS_UNAVAILABLE') throw e;
    console.log('\n  Stage B stopped: the real gesture could not be delivered on this machine.');
  } finally {
    if (browser) await browser.close().catch(() => {});
    apiServer.close();
    db.close();
    if (ats) ats.kill();
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('\nHARNESS FAILED:', e); process.exit(1); });
