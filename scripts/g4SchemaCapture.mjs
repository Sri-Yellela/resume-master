#!/usr/bin/env node
/**
 * TASK G4 — schema capture through the gate. REAL-RUN verification.
 * ============================================================================================
 * Behind a gate is a place our server can never reach. The extension is standing inside it, so the
 * form's STRUCTURE comes back and the next candidate's packet arrives pre-mapped. It is the
 * mechanism that replaces hand-writing PLATFORM_LABEL_MAPS one ATS at a time.
 *
 * G4 WAS BLOCKED ON DISCOVERY RELIABILITY, and this harness measures that blocker first rather than
 * assuming it is gone: an immediate DOM walk of the JS-rendered route must find ZERO fields — the
 * exact reported failure — and the readiness-aware path must then find the whole form. Building the
 * store on a discovery pass that returns nothing would persist EMPTY schemas and cache the bug into
 * the asset that is supposed to compound, which is what the ⛔ existed to prevent.
 *
 * What must hold:
 *   0. the blocker: 0 fields without a readiness wait, the full form with one
 *   1. a captured schema reproduces the REAL field set of the JS-rendered form
 *   2. NO user answer is ever stored — asserted against a form that is filled in first
 *   3. a second capture of a CHANGED form RECONCILES rather than duplicating
 *   4. unmapped fields are known in advance, at queue time
 *   5. capture is refused without consent, server-side
 *   6. the same store takes a server-side capture of a public page — one store, two consumers
 *
 * Usage:  node scripts/g4SchemaCapture.mjs
 */

import path from 'node:path';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../services/browserLauncher.js';
import { discoverFields, waitForFormReady } from '../services/applyAutomation.js';
import { MIGRATIONS } from './migrations.js';
import { formSchemaSummary, mapFormSchemaRow } from '../services/kb/formSchemaLayer.js';
import applyRoutes from '../routes/apply.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ATS = `http://localhost:${process.env.PORT || 4599}`;

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
  `);
  for (const id of ['079_apply_gate_packets', '080_apply_gate_review', '081_company_form_schemas']) {
    db.exec(MIGRATIONS.find(m => m.id === id).sql);
  }
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = { id: 1, planTier: 'PRO' }; next(); });
  applyRoutes(app, db, (q, r, n) => n(), () => ({ field_map: {}, handler_map: {}, custom_answers: {} }),
    async () => ({ error: 'x' }), async () => Buffer.from('pdf'), async () => ({}));
  return new Promise(res => {
    const server = app.listen(0, '127.0.0.1', () => res({ db, server }));
  });
}

async function main() {
  console.log('=== G4 — the form a company publishes, learned once and reused ===\n');

  let ats = null;
  const alive = await new Promise(res => {
    const rq = http.get(`${ATS}/spa?delay=0`, r => { r.resume(); res(r.statusCode === 200); });
    rq.on('error', () => res(false));
    rq.setTimeout(1500, () => { rq.destroy(); res(false); });
  });
  if (!alive) {
    ats = spawn(process.execPath, [path.join(ROOT, 'scripts', 'fakeAts.js')], { stdio: 'ignore' });
    await sleep(1500);
  }

  const { db, server } = await startApi();
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b) => fetch(`${base}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}),
  }).then(async r => ({ status: r.status, body: await r.json() }));
  const get = (p) => fetch(`${base}${p}`).then(async r => ({ status: r.status, body: await r.json() }));

  const browser = await launchBrowser({ headless: 'new' });
  try {
    // ── 0. the blocker this task was held on ────────────────────────────────
    console.log('── the blocker G4 was held on ──');
    const probe = await browser.newPage();
    await probe.goto(`${ATS}/spa`, { waitUntil: 'domcontentloaded' });
    const immediate = await discoverFields(probe, 'generic');
    check('an immediate walk finds ZERO fields — the reported failure, reproduced',
      immediate.length === 0, `${immediate.length} fields`);
    const readiness = await waitForFormReady(probe);
    const afterWait = await discoverFields(probe, 'generic');
    check('the readiness-aware path finds the WHOLE form',
      afterWait.length === 8, `${afterWait.length} fields in ${readiness.waitedMs}ms`);
    console.log(`      ${afterWait.map(f => f.name).join(', ')}`);
    if (afterWait.length === 0) {
      console.log('\nSTOP: discovery is still returning nothing. Capturing now would persist empty');
      console.log('schemas, which is exactly what G4\'s block exists to prevent.');
      failures++;
    }

    // ── 2. no user answer is ever stored ────────────────────────────────────
    // The form is FILLED IN before it is captured. If anything the candidate typed can reach the
    // store, this is where it happens — and a capture from an empty form could never prove it.
    console.log('\n── the form is filled in, then captured ──');
    await probe.evaluate(() => {
      const set = (n, v) => { const el = document.querySelector(`[name="${n}"]`); if (el) el.value = v; };
      set('name', 'Ada Lovelace');
      set('email', 'ada@example.com');
      set('phone', '+1 555 0100');
      set('address1', '12 Analytical Way');
      set('linkedin', 'https://linkedin.com/in/ada');
      const cb = document.querySelector('[name="authorized_no_sponsorship"]');
      if (cb) cb.checked = true;
    });
    const filledFields = await discoverFields(probe, 'generic');
    const carriedValues = filledFields.filter(f => f.current_value).map(f => f.name);
    check('discovery itself DOES carry the typed values — so stripping is a real requirement',
      carriedValues.length > 0, `${carriedValues.join(', ')}`);

    // ── 5. consent is enforced server-side ──────────────────────────────────
    console.log('\n── consent ──');
    const denied = await post('/api/apply/form-schema', {
      applyUrl: `${ATS}/spa`, fields: filledFields,
    });
    check('capture is REFUSED by default — opt-in, and enforced on the server',
      denied.status === 403 && denied.body.error === 'capture_not_enabled',
      `${denied.status} ${denied.body.error}`);
    check('nothing was stored on a refused capture',
      db.prepare('SELECT COUNT(*) n FROM company_form_schemas').get().n === 0);

    const consentOff = await get('/api/apply/form-schema/consent');
    check('the setting reads as off before anyone turns it on', consentOff.body.enabled === false);
    await post('/api/apply/form-schema/consent', { enabled: true });
    check('it can be turned on', (await get('/api/apply/form-schema/consent')).body.enabled === true);

    // ── 1. the schema reproduces the real field set ─────────────────────────
    console.log('\n── the capture ──');
    const first = await post('/api/apply/form-schema', {
      applyUrl: `${ATS}/spa`, company: 'SpaCo', platform: 'generic', fields: filledFields,
    });
    check('the capture is accepted', first.status === 200, JSON.stringify(first.body));
    check('it reproduces the real field set', first.body.fieldCount === 8,
      `${first.body.fieldCount} of ${filledFields.length} discovered`);

    const stored = mapFormSchemaRow(
      db.prepare('SELECT * FROM company_form_schemas WHERE apply_host = ?').get('localhost:4599'));
    const storedText = JSON.stringify(stored);
    check('NO TYPED VALUE REACHED THE STORE',
      !/Ada Lovelace|ada@example\.com|Analytical Way|linkedin\.com\/in\/ada|555 0100/.test(storedText),
      'none of the five values typed into the form appear anywhere in the row');
    check('and no current_value property survived at all',
      !storedText.includes('current_value'),
      `stored keys: ${[...new Set(stored.fields.flatMap(Object.keys))].join(', ')}`);
    check('the labels the form asks with ARE kept — that is the point',
      stored.fields.some(f => f.label === 'Full name') && stored.fields.some(f => f.label === 'Resume'),
      stored.fields.map(f => f.label).join(' | '));
    check('required flags are kept', stored.fields.filter(f => f.required).length >= 3,
      `${stored.fields.filter(f => f.required).length} required`);

    // ── 4. unmapped known in advance ────────────────────────────────────────
    console.log('\n── what it tells us in advance ──');
    const summary = await get(`/api/apply/form-schema?url=${encodeURIComponent(`${ATS}/spa`)}`);
    check('the form behind this URL is now known at queue time', summary.body.known === true);
    check('it says how much of the form we can answer',
      typeof summary.body.unmappedCount === 'number',
      `${summary.body.fieldCount} fields, ${summary.body.unmappedCount} unanswerable`);
    check('a fresh capture is NOT reported as stale',
      summary.body.stale === false, `stale=${summary.body.stale}`);

    // ── 3. a CHANGED form reconciles ────────────────────────────────────────
    console.log('\n── the form changes ──');
    // Corroborate twice more first, so the change demotes something that had been confirmed.
    await post('/api/apply/form-schema', { applyUrl: `${ATS}/spa`, fields: filledFields });
    const third = await post('/api/apply/form-schema', { applyUrl: `${ATS}/spa`, fields: filledFields });
    check('repeat sightings corroborate and promote',
      third.body.corroborationCount === 3 && third.body.status === 'confirmed',
      `n=${third.body.corroborationCount} status=${third.body.status}`);

    const changedPage = await browser.newPage();
    await changedPage.goto(`${ATS}/spa?variant=2`, { waitUntil: 'domcontentloaded' });
    await waitForFormReady(changedPage);
    const changedFields = await discoverFields(changedPage, 'generic');
    check('the changed form really is different',
      changedFields.some(f => f.name === 'portfolio') && !changedFields.some(f => f.name === 'github'),
      changedFields.map(f => f.name).join(', '));

    const fourth = await post('/api/apply/form-schema', { applyUrl: `${ATS}/spa`, fields: changedFields });
    check('the change is DETECTED, not absorbed', fourth.body.changed === true);
    check('IT RECONCILES — one row, not two',
      db.prepare('SELECT COUNT(*) n FROM company_form_schemas').get().n === 1,
      `${db.prepare('SELECT COUNT(*) n FROM company_form_schemas').get().n} row(s)`);
    check('corroboration resets — the old evidence was for a form that no longer exists',
      fourth.body.corroborationCount === 1, `n=${fourth.body.corroborationCount}`);
    check('and a CONFIRMED schema drops back to proposed',
      fourth.body.status === 'proposed', `status=${fourth.body.status}`);
    const after = db.prepare('SELECT * FROM company_form_schemas').get();
    check('the previous shape is remembered, so the change is auditable',
      !!after.previous_shape_hash && after.previous_shape_hash !== after.shape_hash);
    check('the company is not lost when a later capture omits it', after.company === 'SpaCo');
    const reread = mapFormSchemaRow(after);
    check('the stored fields are now the NEW ones',
      reread.fields.some(f => f.name === 'portfolio') && !reread.fields.some(f => f.name === 'github'),
      reread.fields.map(f => f.name).join(', '));

    // ── an empty capture is refused, not stored ─────────────────────────────
    console.log('\n── the failure the ⛔ existed to prevent ──');
    const empty = await post('/api/apply/form-schema', { applyUrl: 'https://empty.example.com', fields: [] });
    check('an EMPTY schema is refused rather than persisted',
      empty.status === 422 && empty.body.error === 'form_schema_empty',
      `${empty.status} ${empty.body.error}`);
    check('and nothing was written for that host',
      db.prepare('SELECT COUNT(*) n FROM company_form_schemas WHERE apply_host=?')
        .get('empty.example.com').n === 0);

    // ── 6. one store, two consumers ─────────────────────────────────────────
    console.log('\n── the same store serves a public careers page ──');
    const publicPage = await browser.newPage();
    await publicPage.goto(`${ATS}/greenhouse`, { waitUntil: 'domcontentloaded' });
    const ghFields = await discoverFields(publicPage, 'greenhouse');
    const { recordFormSchema } = await import('../services/kb/formSchemaLayer.js');
    const serverSide = recordFormSchema(db, {
      applyHost: 'boards.greenhouse.io', company: 'FakeCo', platform: 'greenhouse',
      fields: ghFields, source: 'server_discovery',
    });
    check('a server-side discovery writes the same shape into the same table',
      serverSide.fieldCount === ghFields.length, `${serverSide.fieldCount} fields`);
    const bothRows = db.prepare('SELECT apply_host, source FROM company_form_schemas ORDER BY apply_host').all();
    check('both producers coexist, distinguished only by source',
      bothRows.length === 2 && new Set(bothRows.map(r => r.source)).size === 2,
      bothRows.map(r => `${r.apply_host}=${r.source}`).join(' '));
    const ghSummary = formSchemaSummary(db, 'https://boards.greenhouse.io/fakeco/jobs/1');
    check('the KB read surface returns it for the company', ghSummary?.known === true);

    // Requirement 4, on a real unanswerable question rather than a contrived one. "Name of Referrer"
    // is a third-party subject: the resolver refuses to put the candidate's name in it by design, so
    // it is a question the run WILL have to stop and ask — and knowing that at queue time is worth
    // more than discovering it at submit time.
    check('a REAL unanswerable question is known in advance',
      ghSummary.unmappedCount >= 1 && ghSummary.unmapped.includes('Name of Referrer'),
      `${ghSummary.unmappedCount} unanswerable: ${ghSummary.unmapped.join(' | ')}`);
    check('and the queue is told this one will hold', ghSummary.willLikelyHold === true);

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
