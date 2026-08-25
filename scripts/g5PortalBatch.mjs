#!/usr/bin/env node
/**
 * TASK G5 — amortise the gate per PORTAL, REAL-RUN verification.
 * ============================================================================================
 * The architecture doc calls this the highest-leverage item in the design: one gate crossing that
 * releases a batch is a different product from N separate reviews. It is mostly a reframing of data
 * G1 already stores — so what has to be proved is that the reframing is honest.
 *
 * Two portals, several held jobs on each. What must hold:
 *   1. the queue groups by portal, biggest batch first
 *   2. ONE session releases ONE portal's batch and leaves the other's completely alone
 *   3. batching the GATE does not batch the REVIEW — every application is target-matched and
 *      approved on its own, with its own overlay
 *   4. moving to the next application in a batch costs NO second gesture (G0: the grant survives
 *      same-origin navigation)
 *   5. leaving the origin ends the batch, and the untouched jobs stay held rather than failing
 *   6. a released-but-incomplete handoff can be reopened without un-spending a single-use token
 *
 * The two "portals" are localhost and 127.0.0.1 on the same fakeAts — different origins to Chrome,
 * which is exactly what "a different portal" means to this design.
 *
 * Usage:  A1_RESUME=/path/to/any.pdf node scripts/g5PortalBatch.mjs
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
const OUT_DIR = path.join(os.tmpdir(), 'g5-portal-batch');
const ATS_PORT = 4599;
const PORTAL_A = `http://localhost:${ATS_PORT}`;      // three applications waiting
const PORTAL_B = `http://127.0.0.1:${ATS_PORT}`;      // two, and they must stay untouched
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

const PACKET_PAYLOAD = {
  field_map: {
    first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', phone: '+1 555 0100',
    requires_sponsorship: 'No', work_authorization: 'Yes', current_company: 'Analytical Engines',
  },
  handler_map: {}, custom_answers: {},
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
    INSERT INTO apply_runs (id, user_id, mode, status, total_jobs) VALUES (1, 1, 'auto', 'completed', 5);
  `);
  for (const id of ['079_apply_gate_packets', '080_apply_gate_review']) {
    db.exec(MIGRATIONS.find(m => m.id === id).sql);
  }

  // Three at portal A, two at portal B. Every one of them a real packet row through the real builder.
  // Each job gets its OWN apply URL, as real postings do. The first version pointed all three at
  // one URL, so advancing the batch navigated to the page already showing — a no-op that fired no
  // navigation event and made a working batch look broken.
  const seed = (n, origin, jobId, title) => {
    const applyUrl = `${origin}/gated/form?job=${jobId}`;
    db.prepare(`INSERT INTO scraped_jobs (job_id, title, company, url, apply_url, source)
                VALUES (?, ?, ?, ?, ?, 'ashby')`)
      .run(jobId, title, origin.includes('127.') ? 'PortalB' : 'PortalA', applyUrl, applyUrl);
    db.prepare(`INSERT INTO resumes (user_id, job_id, apply_mode, ats_score, html, updated_at)
                VALUES (1, ?, 'TAILORED', 80, '<html><body>r</body></html>', unixepoch())`).run(jobId);
    const rj = db.prepare(`INSERT INTO apply_run_jobs (run_id, user_id, job_id, status, reason_code, resume_artifact_id)
                           VALUES (1, 1, ?, 'held_gate', 'login_required', ?)`).run(jobId, n);
    const packet = buildGatePacket({
      autofillPayload: PACKET_PAYLOAD, applyUrl, jobId,
      runId: 1, runJobId: Number(rj.lastInsertRowid), resumeArtifactId: n, gateReason: 'login_required',
    });
    db.prepare(`INSERT INTO apply_gate_packets
      (user_id, run_id, run_job_id, job_id, apply_url, expected_origin, gate_reason, answers_json,
       resume_artifact_id, token_hash, expires_at)
      VALUES (1,1,?,?,?,?,'login_required',?,?,?,0)`)
      .run(Number(rj.lastInsertRowid), jobId, applyUrl, origin,
           JSON.stringify(packet), n, `unminted:seed${n}`);
  };
  seed(1, PORTAL_A, 'a1', 'Senior Engineer');
  seed(2, PORTAL_A, 'a2', 'Staff Engineer');
  seed(3, PORTAL_A, 'a3', 'Principal Engineer');
  seed(4, PORTAL_B, 'b1', 'Backend Engineer');
  seed(5, PORTAL_B, 'b2', 'Platform Engineer');

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
  // The API is on a DIFFERENT PORT from both portals, so this host permission cannot reach either.
  manifest.host_permissions = [...manifest.host_permissions, `${apiOrigin}/*`];
  fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { dir: dst, manifest };
}

const PS_SEND_HOTKEY = String.raw`
param([int]$BrowserPid)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace G5 -Name Win -MemberDefinition @'
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
    [G5.Win]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)
    [G5.Win]::keybd_event(0x12, 0, $KEYUP, [System.UIntPtr]::Zero)
    [void][G5.Win]::SetForegroundWindow($h)
  } elseif ($a -eq 2) { [G5.Win]::SwitchToThisWindow($h, $true) }
  else {
    [void][G5.Win]::ShowWindow($h, 6); Start-Sleep -Milliseconds 250
    [void][G5.Win]::ShowWindow($h, 9); [void][G5.Win]::SetForegroundWindow($h)
  }
  Start-Sleep -Milliseconds 500
  if ([G5.Win]::GetForegroundWindow() -eq $h) { break }
}
if ([G5.Win]::GetForegroundWindow() -ne $h) { Write-Output 'NOT_FOREGROUND'; exit 4 }
[G5.Win]::keybd_event(0x11, 0, 0, [System.UIntPtr]::Zero)
[G5.Win]::keybd_event(0x10, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[G5.Win]::keybd_event(0x59, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[G5.Win]::keybd_event(0x59, 0, $KEYUP, [System.UIntPtr]::Zero)
[G5.Win]::keybd_event(0x10, 0, $KEYUP, [System.UIntPtr]::Zero)
[G5.Win]::keybd_event(0x11, 0, $KEYUP, [System.UIntPtr]::Zero)
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
  console.log('=== G5 — one gate crossing, a batch of applications ===\n');

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error('No Chrome binary.'); process.exit(1); }

  const { db, server: apiServer } = await startApi();
  const apiOrigin = `http://127.0.0.1:${apiServer.address().port}`;
  console.log(`portal A  ${PORTAL_A}  (3 waiting)`);
  console.log(`portal B  ${PORTAL_B}  (2 waiting — must stay untouched)`);
  console.log(`api       ${apiOrigin}\n`);

  let ats = null;
  const alive = await new Promise(res => {
    const rq = http.get(`${PORTAL_A}/gated/form`, r => { r.resume(); res(r.statusCode === 200); });
    rq.on('error', () => res(false)); rq.setTimeout(1500, () => { rq.destroy(); res(false); });
  });
  if (!alive) {
    ats = spawn(process.execPath, [path.join(ROOT, 'scripts', 'fakeAts.js')],
      { env: { ...process.env, PORT: String(ATS_PORT) }, stdio: 'ignore' });
    await sleep(1500);
  }

  // ── 1. grouping (server-side, before any browser) ──────────────────────────
  console.log('── the queue groups by portal ──');
  const listed = await fetch(`${apiOrigin}/api/apply/gate-packets`).then(r => r.json());
  check('both portals are listed as groups', listed.portals?.length === 2,
    listed.portals?.map(p => `${p.host}:${p.count}`).join(' '));
  check('the biggest batch is offered first', listed.portals?.[0]?.count === 3,
    `${listed.portals?.[0]?.host} has ${listed.portals?.[0]?.count}`);
  check('each group names the host you sign in to',
    listed.portals?.every(p => typeof p.host === 'string' && p.host.length > 0),
    listed.portals?.map(p => p.host).join(', '));
  check('the flat packet list is still there for callers that want it',
    listed.packets?.length === 5, `${listed.packets?.length} packets`);
  check('the grouping still leaks no answer values',
    !JSON.stringify(listed.portals).includes('ada@example.com'));

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
    const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 }).catch(() => null);
    const sw = swTarget ? await swTarget.worker().catch(() => null) : null;
    if (sw) sw.on('console', m => console.log(`      [sw] ${m.text()}`));
    const control = await browser.newPage();
    await control.goto(`chrome-extension://${extensionId}/options.html`);
    const page = (await browser.pages())[0];

    const lastResult = () => control.evaluate(() =>
      chrome.storage.session.get('lastGatedHandoff').then(r => r.lastGatedHandoff));
    const clearResult = () => control.evaluate(() => chrome.storage.session.remove('lastGatedHandoff'));
    const waitForResult = async (ms = 20000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const r = await lastResult();
        if (r) return r;
        await sleep(400);
      }
      return null;
    };

    // ── 2 & 4. one gesture, then the batch continues without another ────────
    console.log('\n── one gesture at portal A ──');
    await clearResult();
    await page.goto(`${PORTAL_A}/gated/form?job=a1`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await sleep(400);
    const key = sendHotkey(browser.process().pid);
    if (!key.ok) console.log(`  hotkey failed (${key.out}) — press Ctrl+Shift+Y manually, 45s`);
    const first = await waitForResult(key.ok ? 20000 : 45000);
    check('the first application filled', first?.ok === true, first?.message || first?.reason);
    check('it knows 2 more are waiting on THIS portal', first?.portal?.remaining === 2,
      `remaining=${first?.portal?.remaining} host=${first?.portal?.host}`);
    check('the overlay offers the batch', await page.evaluate(() =>
      !!document.querySelector('#rm-gate-review-overlay [data-role="next"]')));
    const offer = await page.evaluate(() =>
      document.querySelector('#rm-gate-review-overlay .rm-next')?.textContent?.replace(/\s+/g, ' ').trim());
    check('and says so in the candidate\'s terms', /more ready at/.test(offer || ''), offer?.slice(0, 90));

    // Requirement 3: batching the gate must not batch the review.
    check('this application still got its OWN overlay to approve',
      first?.overlay?.rendered === true && first?.review?.eligibilityCount >= 1,
      `elig=${first?.review?.eligibilityCount} uncertain=${first?.review?.uncertainCount}`);

    console.log('\n── advancing, with NO second gesture ──');
    await clearResult();
    await page.evaluate(() =>
      document.querySelector('#rm-gate-review-overlay [data-role="next"]').click());
    await sleep(3000);
    const nextErr = await page.evaluate(() => {
      const b = document.querySelector('#rm-gate-review-overlay [data-role="next"]');
      return b ? { text: b.textContent.trim(), error: b.dataset.error || null } : null;
    });
    console.log(`      page url after next: ${page.url()}   button: ${JSON.stringify(nextErr)}`);
    const second = await waitForResult(25000);
    check('the NEXT application filled without another keypress', second?.ok === true,
      second?.message || second?.reason || 'no result');
    check('it is a different packet from the first', second?.packetId !== first?.packetId,
      `${first?.packetId} -> ${second?.packetId}`);
    check('one fewer is now waiting', second?.portal?.remaining === 1,
      `remaining=${second?.portal?.remaining}`);
    check('the second application ALSO got its own overlay — the review is not batched',
      second?.overlay?.rendered === true, JSON.stringify(second?.overlay));

    // ── 2. the other portal is untouched ────────────────────────────────────
    console.log('\n── portal B is untouched ──');
    const afterA = await fetch(`${apiOrigin}/api/apply/gate-packets`).then(r => r.json());
    const bGroup = afterA.portals?.find(p => p.origin === PORTAL_B);
    check('portal B still has both of its applications waiting', bGroup?.count === 2,
      `B=${bGroup?.count}`);
    const consumedB = db.prepare(
      `SELECT COUNT(*) n FROM apply_gate_packets WHERE expected_origin=? AND consumed_at IS NOT NULL`
    ).get(PORTAL_B).n;
    check('not one of portal B\'s packets was released', consumedB === 0, `consumed=${consumedB}`);
    const consumedA = db.prepare(
      `SELECT COUNT(*) n FROM apply_gate_packets WHERE expected_origin=? AND consumed_at IS NOT NULL`
    ).get(PORTAL_A).n;
    check('exactly the two worked through at portal A were released', consumedA === 2, `consumed=${consumedA}`);

    // ── 5. leaving the origin ends the batch ────────────────────────────────
    console.log('\n── leaving the portal ──');
    const batchBefore = await control.evaluate(() => chrome.storage.session.get(null)
      .then(a => Object.keys(a).filter(k => k.startsWith('batch:'))));
    check('a batch is being tracked while on the portal', batchBefore.length === 1, batchBefore.join(','));
    await clearResult();
    await page.goto(`${PORTAL_B}/gated/form`, { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const batchAfter = await control.evaluate(() => chrome.storage.session.get(null)
      .then(a => Object.keys(a).filter(k => k.startsWith('batch:'))));
    check('leaving the origin ends the batch', batchAfter.length === 0, batchAfter.join(','));
    const strayFill = await page.evaluate(() =>
      document.querySelector('[name="first_name"]')?.value || '');
    check('and NOTHING was auto-filled at the other portal without a gesture', strayFill === '',
      `value=${JSON.stringify(strayFill)}`);
    const stillHeld = db.prepare(
      `SELECT COUNT(*) n FROM apply_run_jobs WHERE status='held_gate'`).get().n;
    check('every untouched job is still HELD, not failed', stillHeld === 5, `held_gate=${stillHeld}`);

    // ── 6. reopening an incomplete handoff ──────────────────────────────────
    console.log('\n── a session that went stale mid-batch ──');
    // The real stale-session shape: a packet RELEASED (token spent) and then abandoned before the
    // candidate ever reviewed anything — the portal signed them out on the way. Constructed directly
    // rather than reusing one of the batch's packets, whose overlays did record a review.
    const stale = db.prepare(
      `SELECT id FROM apply_gate_packets WHERE expected_origin=? AND consumed_at IS NULL ORDER BY id LIMIT 1`
    ).get(PORTAL_B).id;
    db.prepare('UPDATE apply_gate_packets SET consumed_at=unixepoch() WHERE id=?').run(stale);

    const reopen = await fetch(`${apiOrigin}/api/apply/gate-packets/${stale}/reopen`, { method: 'POST' });
    const reopened = await reopen.json();
    check('a released-but-unfinished handoff can be reopened', reopen.status === 200 && reopened.reopened === true,
      JSON.stringify(reopened));
    check('the ORIGINAL packet stays consumed — single use is not undone',
      db.prepare('SELECT consumed_at c FROM apply_gate_packets WHERE id=?').get(stale).c !== null);
    check('the reopened one is a NEW packet with no outstanding token',
      String(db.prepare('SELECT token_hash t FROM apply_gate_packets WHERE id=?')
        .get(reopened.packetId).t).startsWith('unminted:'));
    check('and it is for the same job at the same portal',
      db.prepare('SELECT expected_origin o FROM apply_gate_packets WHERE id=?').get(reopened.packetId).o === PORTAL_B);

    // And it refuses once the candidate has actually seen the form: at that point the application is
    // in front of them and a second copy would be a duplicate, not a recovery.
    const reviewed = db.prepare(
      `SELECT p.id, p.run_job_id FROM apply_gate_packets p
       JOIN apply_run_jobs rj ON rj.id = p.run_job_id
       WHERE p.consumed_at IS NOT NULL AND rj.gate_review_json IS NOT NULL LIMIT 1`
    ).get();
    check('a reviewed handoff exists to test the refusal against', !!reviewed,
      reviewed ? `packet ${reviewed.id}` : 'none — the overlay recorded no review');
    if (reviewed) {
      const refused = await fetch(`${apiOrigin}/api/apply/gate-packets/${reviewed.id}/reopen`, { method: 'POST' });
      check('but NOT once the candidate has already reviewed it', refused.status === 409,
        `status=${refused.status} ${(await refused.json()).error}`);
    }

    // ── nothing was submitted, anywhere ─────────────────────────────────────
    const subs = await fetch(`${PORTAL_A}/_submissions`).then(r => r.json());
    check('NOTHING was submitted to any portal', subs.count === 0, `count=${subs.count}`);

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
