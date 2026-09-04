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
 *
 * AI2 — CHROME WEB STORE LISTING SCREENSHOTS
 * `npm run store:screenshots` runs this same harness with --screenshots and writes three
 * 1280x800, 24-bit, alpha-free PNGs to docs/store-screenshots/. Under that flag the whole run
 * happens on /gated/form?presentation=1 — the identical form with its didactic trap captions
 * removed — so the assertions below are made against the page that is photographed. The candidate
 * is the synthetic Ada Lovelace fixture, and every capture is checked against the developer's real
 * profile values before it is written.
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
import { toStorePng, readPngHeader, decodeToRgb, encodeRgbPng, compositeRgb } from '../services/pngTruecolor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(os.tmpdir(), 'g3-review-overlay');

// --screenshots also writes Chrome Web Store listing images (AF4 item 4).
//
// Captured HERE rather than in a script of their own, deliberately: the listing screenshot of the
// review overlay is a CLAIM about what the extension does, and this harness is the thing that proves
// the claim in the same breath. A screenshot taken by a separate script could be of an overlay that
// renders and does not work; one taken at this point in this run cannot be, because the assertions
// above and below it have to pass for the run to be green.
const SHOTS = process.argv.includes('--screenshots');
const SHOT_DIR = path.join(ROOT, 'docs', 'store-screenshots');
// The Chrome Web Store accepts 1280x800 or 640x400. 1280x800 for all three.
const SHOT_SIZE = { width: 1280, height: 800 };

// AI2. What a store screenshot must never contain, checked against the TEXT OF THE SURFACE at the
// moment it is captured rather than against the fixture's intent.
//
// - The owner's real details. The review overlay shows a home address, phone, email and
//   eligibility answers, and the fixture profile is synthetic (Ada Lovelace, example.com, a 555
//   number) — but "the fixture is synthetic" is a claim about the seed, not about the pixels. The
//   real values are read out of the developer's own database and looked for in what was rendered.
// - The trap captions. fakeAts names its traps in the markup on purpose; a reviewer seeing
//   "TRAP: sponsorship_inversion" reads a test rig. ?presentation=1 removes the captions and
//   nothing else, and this is the check that it worked.
const FORBIDDEN_IN_SHOTS = [/TRAP:/i, /sponsorship_inversion/i, /label-only match/i,
                            /required_unmapped/i, /name_ambiguity/i, /lowercase_yes/i, /G3-TRAPS/i,
                            // The fixture's other tell: /ashby-spa narrates its own mechanism
                            // ("Rendered by JavaScript 0ms after load ... transcribed from a live
                            // Ashby posting"), the right caption for a harness and a test rig to a
                            // reviewer.
                            /rendered by JavaScript/i, /as every real ATS does/i, /transcribed from/i,
                            // And a REAL EMPLOYER'S BRAND. /ashby-spa's shape was transcribed from
                            // a live posting, so the fixture inherited that company's name and role
                            // title. Putting another company in our own store listing is a
                            // different kind of wrong from an ugly caption, and worth its own line.
                            /\bOpenAI\b/, /Agent Productivity/i];
let REAL_VALUES = [];
function loadRealProfileValues() {
  // The developer's own database. Absent on a clean checkout, which is fine — but it must SAY so
  // rather than report a vacuous pass on an assertion whose whole job is to catch a real leak.
  const real = path.join(ROOT, 'data', 'resume_master.db');
  if (!fs.existsSync(real)) {
    console.log('  note  no data/resume_master.db — the "no real personal data" check has no values to look for');
    return [];
  }
  const rdb = new Database(real, { readonly: true, fileMustExist: true });
  try {
    const rows = rdb.prepare('SELECT full_name, first_name, last_name, email, phone, location FROM user_profile').all();
    const vals = new Set();
    for (const r of rows) for (const v of Object.values(r)) {
      const s = String(v ?? '').trim();
      // Short values ("MA", a blank) match everywhere and would fail every run on noise.
      if (s.length >= 5) vals.add(s);
    }
    return [...vals];
  } finally { rdb.close(); }
}

let shotCount = 0;
const shotReport = [];
/**
 * Capture, VALIDATE, then write — in that order.
 *
 * Nothing reaches disk until the image has been proved 1280x800 and alpha-free, because a silently
 * wrong file discovered by hand at the dashboard is the failure this exists to prevent. On any
 * failure it throws: the run dies, and the file that would have been wrong is simply not there.
 */
async function shoot(page, name, note) {
  if (!SHOTS) return;
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.setViewport({ ...SHOT_SIZE, deviceScaleFactor: 1 });
  await sleep(500);

  const text = await page.evaluate(() => document.body?.innerText || '');
  for (const re of FORBIDDEN_IN_SHOTS) {
    if (re.test(text)) throw new Error(`${name}: a trap caption is visible in the capture — ${re}`);
  }
  for (const v of REAL_VALUES) {
    if (text.includes(v)) throw new Error(`${name}: REAL personal data is visible in the capture — ${JSON.stringify(v)}`);
  }

  const raw = await page.screenshot({ clip: { x: 0, y: 0, ...SHOT_SIZE } });
  return writeShot(name, note, Buffer.from(raw));
}

/**
 * Validate an already-captured PNG buffer and write it. Split out of shoot() so the composited
 * popup shot goes through the SAME gate — a second write path is how one of the three ends up
 * unchecked.
 */
function writeShot(name, note, buffer) {
  const file = path.join(SHOT_DIR, `${name}.png`);
  const { png, width, height, nonOpaque } = toStorePng(buffer);

  // Asserted on the ENCODED BYTES, not on what the capture was asked for. A viewport that did not
  // take, a device scale factor, a clip clamped by a shorter page — each produces a wrongly sized
  // image from a correct-looking request, and the header is the only thing that settles it.
  const h = readPngHeader(png);
  if (h.width !== SHOT_SIZE.width || h.height !== SHOT_SIZE.height) {
    throw new Error(`${name}: captured ${h.width}x${h.height}, the store needs ${SHOT_SIZE.width}x${SHOT_SIZE.height}`);
  }
  if (h.hasAlpha || h.colorType !== 2) throw new Error(`${name}: PNG colour type ${h.colorType} carries alpha`);
  if (h.bitDepth !== 8 || h.bitsPerPixel !== 24) throw new Error(`${name}: ${h.bitsPerPixel}-bit, the store needs 24-bit`);

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(file, png);

  // Re-read from disk. Everything above validated a buffer; this validates the FILE, which is the
  // artefact that gets uploaded.
  const onDisk = readPngHeader(fs.readFileSync(file));
  if (onDisk.width !== width || onDisk.height !== height || onDisk.hasAlpha) {
    throw new Error(`${name}: the file on disk does not match what was validated`);
  }

  shotCount++;
  shotReport.push({ name, file: path.relative(ROOT, file).replace(/\\/g, '/'),
    width: onDisk.width, height: onDisk.height, colorType: onDisk.colorType,
    bits: onDisk.bitsPerPixel, bytes: png.length, nonOpaque, note });
  console.log(`  shot  ${path.relative(ROOT, file)} — ${width}x${height}, 24-bit, no alpha — ${note}`);
}
const ATS_PORT = 4599;
const PORTAL = `http://localhost:${ATS_PORT}`;
// AI2. Under --screenshots the WHOLE run happens on the presentation variant of the form, not just
// the capture. Same fields, same names, same traps — only the didactic captions differ (see
// gatedForm() in fakeAts.js). Running the assertions on the page that gets photographed is what
// makes the screenshot evidence rather than decoration: the image cannot be of an overlay that
// renders and does not work, because the run is only green if it worked on this exact page.
const FORM_URL = `${PORTAL}/gated/form${SHOTS ? '?presentation=1' : ''}`;
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
  // The popup's auth probe (via the service worker's PROBE_AUTH). Without it the probe fails closed
  // and the popup renders its SIGN-IN wall — which is the wrong fixture state for a harness whose
  // whole scenario is a candidate who has already signed in to reach a gated form, and which was
  // also giving the store screenshots a signed-out popup.
  app.get('/api/auth/me', (_req, res) => res.json({ authenticated: true, username: 'ada' }));
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

  if (SHOTS) {
    // Deterministic and re-runnable: the directory is emptied first, so a shot that fails to be
    // produced this run cannot be silently satisfied by last run's file. Combined with shoot()
    // writing nothing until it has validated, a failed run leaves an obviously incomplete
    // directory rather than a plausible and stale one.
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    REAL_VALUES = loadRealProfileValues();
    console.log(`  store screenshots -> ${path.relative(ROOT, SHOT_DIR)} ` +
      `(guarding ${REAL_VALUES.length} real profile value(s), ${FORBIDDEN_IN_SHOTS.length} trap captions)`);
  }

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
    // Polled rather than slept. A fixed 1500ms was enough on a warm machine and not on a cold one,
    // and the failure it produced was an ECONNREFUSED from the next line up — a confusing way to
    // learn that the fixture had simply not finished booting.
    const deadline = Date.now() + 15000;
    let up = false;
    while (Date.now() < deadline && !up) {
      up = await fetch(`${PORTAL}/gated/form`).then(r => r.ok).catch(() => false);
      if (!up) await sleep(200);
    }
    if (!up) throw new Error(`fakeAts did not come up on ${PORTAL} within 15s`);
  }
  await fetch(`${PORTAL}/_reset`, { method: 'POST' }).catch(() => {});

  // The harness REUSES a fakeAts already listening on this port rather than starting its own. A
  // server started before ?presentation=1 existed answers that URL with the trap captions still in
  // it, and the run would go on to photograph them. So the fixture is asked what it actually
  // serves, and the run dies here if it is the wrong one — before a browser is launched.
  if (SHOTS) {
    const served = await fetch(FORM_URL).then(r => r.text());
    if (/TRAP:/.test(served)) {
      throw new Error(`the fakeAts on ${PORTAL} still serves trap captions at ?presentation=1 — it predates the ` +
        `presentation flag. Stop it and re-run so this harness starts a current one.`);
    }
    if (!/authorized_no_sponsorship/.test(served) || !/job_application\[requires_sponsorship\]/.test(served)) {
      throw new Error('the presentation form is missing the traps — the screenshot would not depict real behaviour');
    }
  }

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
    applyUrl: FORM_URL, jobId: 'g3job', runId: 1, runJobId: 1, resumeArtifactId: 1,
    gateReason: 'login_required',
  });
  db.prepare(`INSERT INTO apply_gate_packets
    (user_id, run_id, run_job_id, job_id, apply_url, expected_origin, gate_reason, answers_json,
     resume_artifact_id, token_hash, expires_at)
    VALUES (1,1,1,'g3job',?,?,'login_required',?,1,'unminted:seed',0)`)
    .run(FORM_URL, PORTAL, JSON.stringify(packet));

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
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' });
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

    // The listing's most important image, captured BEFORE anything is acknowledged: the overlay is
    // showing the uncertain fields and the state is not-ready. That is the whole pitch to a store
    // reviewer — this extension fills a form and hands it back for review, it does not submit.
    if (SHOTS) {
      await page.bringToFront();
      await shoot(page, '1-review-overlay',
        'the review overlay over a real form, before anything is acknowledged');
    }

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

    // ── listing screenshots (AF4 item 4) ───────────────────────────────────
    // Taken last so nothing above is disturbed by a viewport change, and only after every
    // assertion has already run against this same extension build.
    if (SHOTS) {
      console.log('\n── store listing screenshots ──');
      // The popup, ON a real posting. /ashby-spa is the measured shape of a live Ashby posting, so
      // the tab behind the popup is a genuine application page rather than a mock-up. The popup is
      // rendered from the extension's own popup.html by the extension itself.
      const posting = await browser.newPage();
      await posting.goto(`${PORTAL}/ashby-spa?delay=0&presentation=1`, { waitUntil: 'domcontentloaded' });
      await sleep(800);

      // ORDER MATTERS. popup.js asks the service worker for the ACTIVE TAB and only offers to
      // capture when that tab holds a posting. So the popup tab is created blank, the POSTING is
      // brought to the front, and only then is popup.html navigated to — so its init() sees the
      // posting, exactly as the real popup does when opened from the toolbar over a job page.
      // Screenshotting it while it is backgrounded is the price of that, and is what makes the
      // image show the capture surface rather than "Open a job posting to capture it".
      const popup = await browser.newPage();
      await posting.bringToFront();
      await sleep(300);
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await sleep(1200);

      // ── The popup OVER the posting ──────────────────────────────────────────
      //
      // Chrome cannot capture a toolbar popup together with the page beneath it — the popup is a
      // separate top-level surface, and a page capture does not contain it. Photographing the
      // popup alone produced a 244px panel on a 1280x800 field of white, which shows the popup and
      // not what using it looks like. So the two REAL captures are placed in the relationship the
      // user sees: the posting as served, and the popup as the extension rendered it having
      // genuinely resolved that posting as the active tab. Neither half is mocked or redrawn.
      // MEASURED AT A SMALL VIEWPORT, then applied. Measuring scrollWidth while the tab is still
      // 1280 wide reports 1280 — the body stretches to the viewport — and the popup ends up
      // photographed at Chrome's 800px clamp, four times its real width, covering the posting it
      // is supposed to be sitting over. popup.html declares `width: 260px`, so the intrinsic size
      // is only visible once the viewport is smaller than the content it should shrink to.
      await popup.bringToFront();
      await popup.setViewport({ width: 420, height: 720, deviceScaleFactor: 1 });
      await sleep(300);
      const popupBox = await popup.evaluate(() => {
        const r = document.body.getBoundingClientRect();
        const cs = getComputedStyle(document.body);
        return {
          w: Math.ceil(r.width + parseFloat(cs.marginLeft) + parseFloat(cs.marginRight)),
          h: Math.ceil(r.height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom)),
        };
      });
      // Chrome clamps a toolbar popup to 800x600; the real one is nowhere near either bound.
      const pw = Math.min(Math.max(popupBox.w, 240), 800);
      const ph = Math.min(Math.max(popupBox.h, 160), 600);
      // Chrome does not composite a backgrounded tab, so a resize-then-capture on one hangs in
      // Page.captureScreenshot until the protocol times out — which is why the popup was brought
      // to the front above, only to be photographed. init() had already run and resolved the
      // posting; foregrounding does not re-run it, and the assertion below re-reads the popup after
      // the move so a state that DID change would fail rather than be photographed.
      await popup.setViewport({ width: pw, height: ph, deviceScaleFactor: 1 });
      await sleep(500);

      const popupText = await popup.evaluate(() => document.body?.innerText || '');
      for (const v of REAL_VALUES) {
        if (popupText.includes(v)) throw new Error(`2-popup: REAL personal data in the popup — ${JSON.stringify(v)}`);
      }
      // The popup only offers to capture when the service worker reports a posting in the active
      // tab. If it is showing anything else, the image would claim a state the run did not reach.
      if (!/Capture job/i.test(popupText)) {
        throw new Error(`2-popup: the popup is not in its capture state — it reads ${JSON.stringify(popupText.slice(0, 120))}`);
      }

      const popupShot = decodeToRgb(Buffer.from(await popup.screenshot({ clip: { x: 0, y: 0, width: pw, height: ph } })));
      await posting.bringToFront();
      await posting.setViewport({ ...SHOT_SIZE, deviceScaleFactor: 1 });
      await sleep(400);
      const postingText = await posting.evaluate(() => document.body?.innerText || '');
      for (const re of FORBIDDEN_IN_SHOTS) {
        if (re.test(postingText)) throw new Error(`2-popup: a trap caption is visible on the posting — ${re}`);
      }
      const base = decodeToRgb(Buffer.from(await posting.screenshot({ clip: { x: 0, y: 0, ...SHOT_SIZE } })));

      // Top right, below where the toolbar would be — where Chrome actually anchors it.
      const merged = compositeRgb(base, popupShot, SHOT_SIZE.width - pw - 28, 16);
      writeShot('2-popup', 'the popup as the extension rendered it, over the posting it resolved',
        encodeRgbPng(merged));

      // BOTH shortcuts, with real keys in them (AI2 shot 3). options.js builds these rows from
      // chrome.commands.getAll(), and a command Chrome declined to bind renders as "Not set" —
      // which is a true rendering of a real state and a bad listing image, so it fails the run
      // rather than shipping. Read out of the DOM, so the assertion is about what the picture
      // shows and not about what the manifest declares.
      await control.bringToFront();
      await sleep(400);
      const shortcuts = await control.evaluate(() =>
        [...document.querySelectorAll('.shortcut-row')].map(r => ({
          label: r.querySelector('label')?.textContent?.trim() || '',
          key: r.querySelector('input')?.value?.trim() || '',
        })));
      check('the options page lists both shortcuts', shortcuts.length === 2,
        shortcuts.map(s => `${s.label}=${s.key}`).join(' | '));
      check('both shortcuts show a real key, not "Not set"',
        shortcuts.length === 2 && shortcuts.every(s => s.key && !/not set/i.test(s.key)),
        shortcuts.map(s => s.key).join(' | '));
      check('and they came from chrome.commands.getAll(), not a hand-kept list',
        /chrome\.commands\.getAll\(\)/.test(fs.readFileSync(path.join(ROOT, 'extension', 'options.js'), 'utf8')));

      await shoot(control, '3-options', 'the options page — both shortcuts, and who submits');

      // The store wants exactly three, and a run that produced two is a run that failed. Asserted
      // rather than left to whoever opens the directory.
      check('all three store screenshots were produced', shotCount === 3, `${shotCount} of 3`);
      const onDisk = fs.readdirSync(SHOT_DIR).filter(f => f.endsWith('.png')).sort();
      check('the directory holds exactly the three, and nothing stale',
        onDisk.length === 3 && onDisk.join(',') === '1-review-overlay.png,2-popup.png,3-options.png',
        onDisk.join(', '));
      console.log('');
      for (const s of shotReport) {
        console.log(`  ${s.file}  ${s.width}x${s.height}  colour type ${s.colorType} (24-bit truecolour, no alpha)  ` +
          `${s.bytes} bytes  ${s.nonOpaque} non-opaque source pixels flattened`);
      }
    }

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
