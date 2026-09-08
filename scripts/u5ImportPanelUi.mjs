#!/usr/bin/env node
// scripts/u5ImportPanelUi.mjs
//
// U5.1 — DOES THE INJECTION CONTROL ACTUALLY EXIST IN THE ADMIN PANEL?
//
// The requirement this verifies is not "an import endpoint responds" — u5EnrichmentTransferVerify
// already proves that over real HTTP. It is that somebody standing in the Schema Explorer, where
// Export CSV and Download .sql live, can SEE the other half of the round trip and drive it. The
// owner went looking for exactly that and found nothing, so a passing endpoint test would have
// reported this feature as shipped while the gap that prompted the task remained.
//
// A node:test file cannot answer that question. It would assert that a source string appears in
// DBInspector.jsx, which is true of a component that is never rendered, is rendered behind a
// collapsed parent, or throws on mount. So this drives real Chrome against a real Vite build with
// /api/* stubbed, clicks the control, and reads the rendered DOM.
//
// ⛔ WHAT IT SPECIFICALLY GUARDS, beyond "the panel renders": that APPLY IS LOCKED until a dry run
// has passed for the exact text in the box, and that the two dangerous flags are not pre-armed.
// Those are safety properties of the UI, not of the endpoint — the endpoint will happily apply
// whatever a caller sends with apply=1 — so if they are only asserted in a comment they are not
// asserted at all.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'data', 'evidence', 'u5-import-panel');
const VITE_PORT = 5207;

let passes = 0, fails = 0;
const pass = (m) => { passes++; console.log(`PASS ${m}`); };
const fail = (m, d) => { fails++; console.log(`FAIL ${m}`); if (d !== undefined) console.log(`     ${d}`); };
const check = (c, m, d) => (c ? pass(m) : fail(m, d));

// ── the stub API ────────────────────────────────────────────────────────────────────────────────
//
// Served over HTTP rather than through page.setRequestInterception so the panel's own fetch() —
// which sends a raw application/x-ndjson body — is exercised as a real request with a real body.
// An intercepted request whose body is never read would let a broken upload path pass.

const state = { lastImport: null };

function stubApi() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === '/api/auth/me') {
      // The shape App.jsx actually branches on — `authenticated` and `user`, not a bare user
      // object. A bare user object leaves authStatus "unauthenticated" and AdminRouteGate
      // redirects to /admin/login, which looks exactly like a missing control.
      return send(200, {
        authenticated: true,
        user: { id: 1, username: 'admin', isAdmin: true, planTier: 'pro' },
      });
    }
    if (url.pathname === '/api/admin/db/pipeline-health') {
      // The default tab renders this unguarded (health.enrichment.activeTotal). With the generic
      // fallback it throws, React unmounts the whole tree, and the page goes blank — which reads
      // as "the import control is missing" rather than "the tab before it crashed".
      // Every field the tab dereferences without a guard: health.sources, health.dedup,
      // health.enrichment, health.hasRunLog.
      return send(200, {
        sources: [], hasRunLog: true, dedup: { multiSource: 0 },
        enrichment: { activeTotal: 1266, noDescription: 0, coverage: [], recentRuns: [] },
      });
    }
    if (url.pathname === '/api/admin/db/schema') {
      return send(200, {
        tables: [{ name: 'scraped_jobs', rowCount: 1266, columns: [], indexes: [], foreignKeys: [] }],
        dbSizeBytes: 115990528, walMode: true,
      });
    }
    if (url.pathname === '/api/admin/enrichment/import') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        // Recorded so the harness can assert what the PANEL sent, not what it displayed.
        state.lastImport = { query: Object.fromEntries(url.searchParams),
                             contentType: req.headers['content-type'], body };
        const apply = url.searchParams.get('apply') === '1';
        const plan = {
          rowsInFile: 2, matched: 2, wouldWrite: 2, unchanged: 0, perColumn: { skills_json: 2 },
          valid: true, rejected: [], skippedNonNull: [], mode: 'fill NULLs only', allowStale: false,
        };
        const coverage = [{ column: 'skills_json', before: 0, after: 2, delta: 2, sourceSilent: false }];
        return send(200, apply
          ? { applied: true, plan, written: 2, batchId: 77, coverage, columnsClimbed: 1,
              coverageClimbed: true, warning: null,
              revert: '/api/admin/enrichment/batches/77/revert' }
          : { applied: false, dryRun: true, plan, coverage, columnsWouldClimb: 1, warning: null,
              note: 'Nothing was written. POST again with apply: true to apply.' });
      });
      return;
    }
    send(200, { ok: true, jobs: [], items: [], results: [], data: [], count: 0, total: 0 });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

// ── vite ────────────────────────────────────────────────────────────────────────────────────────

function startVite(apiPort) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath,
      [path.join(ROOT, 'client', 'node_modules', 'vite', 'bin', 'vite.js'),
       '--port', String(VITE_PORT), '--strictPort'],
      { cwd: path.join(ROOT, 'client'),
        env: { ...process.env, VITE_API_PROXY: `http://127.0.0.1:${apiPort}` },
        stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b) => {
      // Vite colours its banner: "Local:" and the port are separated by escape sequences, and the
      // ESC byte survives a naive /\[[0-9;]*m/ strip, so a literal match on "Local:.*PORT" never
      // fires and the harness times out on a server that started fine.
      out += b.toString().replace(/\x1b\[[0-9;]*m/g, '');
      if (new RegExp(`localhost:${VITE_PORT}`).test(out)) resolve({ proc, url: `http://localhost:${VITE_PORT}` });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error(`vite did not start:\n${out.slice(-800)}`)), 60000);
  });
}

const SAMPLE = [
  JSON.stringify({ job_id: 'u5-0', content_hash: 'a'.repeat(64),
                   enrichment: { skills_json: [{ skill: 'Python', type: 'hard' }] } }),
  JSON.stringify({ job_id: 'u5-1', content_hash: 'b'.repeat(64),
                   enrichment: { skills_json: [{ skill: 'Go', type: 'hard' }] } }),
].join('\n');

// ── the run ─────────────────────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('=== U5 — the import control in the admin panel ===\n');

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.log('FAIL no Chrome binary available'); process.exit(1); }

  const api = await stubApi();
  const apiPort = api.address().port;
  const vite = await startVite(apiPort);
  console.log(`vite ${vite.url}  api :${apiPort}\n`);

  const browser = await puppeteer.launch({
    executablePath: resolution.path, headless: 'new', pipe: true,
    args: ['--no-first-run', '--no-default-browser-check'],
    defaultViewport: { width: 1400, height: 1300, deviceScaleFactor: 1 },
  });

  try {
    const page = await browser.newPage();
    page.on('pageerror', e => console.log(`      [page error] ${e.message}`));

    // Every /api/* to the stub, whatever origin the app asks for.
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const u = new URL(r.url(), vite.url);
      if (u.pathname.startsWith('/api/')) {
        return r.continue({ url: `http://127.0.0.1:${apiPort}${u.pathname}${u.search}` });
      }
      r.continue();
    });

    await page.goto(`${vite.url}/admin/db`, { waitUntil: 'networkidle2', timeout: 60000 });
    // The Schema Explorer is tab 2 — click it rather than deep-linking. page.goto between panels
    // would remount the tree and is how a working control gets reported as missing.
    await page.evaluate(() => {
      const t = [...document.querySelectorAll('button')].find(b => /^schema/i.test(b.textContent.trim()));
      if (t) t.click();
    });
    await new Promise(r => setTimeout(r, 1200));

    const findBtn = (re) => page.evaluateHandle((src) => {
      const rx = new RegExp(src, 'i');
      return [...document.querySelectorAll('button,a')].find(b => rx.test(b.textContent)) || null;
    }, re.source);

    // ── 1 · the control is visible where the exports are ──────────────────────────────────────
    const bar = await page.evaluate(() => {
      const labels = [...document.querySelectorAll('button,a')].map(b => b.textContent.trim());
      return {
        hasExportCsv: labels.some(l => /Export CSV/i.test(l)),
        hasDownloadSql: labels.some(l => /Download \.sql/i.test(l)),
        hasImport: labels.some(l => /Import Enrichment/i.test(l)),
      };
    });
    if (!bar.hasDownloadSql) {
      // A blank admin route is the likely failure and it looks identical to a missing control, so
      // print what actually rendered rather than leaving the next reader to guess.
      const dbg = await page.evaluate(() => ({
        url: location.href,
        buttons: [...document.querySelectorAll('button,a')].map(b => b.textContent.trim()).slice(0, 30),
        text: document.body.innerText.slice(0, 400),
      }));
      console.log(`     [diagnostic] ${JSON.stringify(dbg, null, 2)}`);
    }
    check(bar.hasDownloadSql, 'the Schema Explorer rendered (Download .sql present)');
    check(bar.hasImport,
      '⛔ an Import Enrichment control EXISTS in the admin panel — the gap that prompted this task',
      JSON.stringify(bar));

    const importBtn = await findBtn(/Import Enrichment/);
    await importBtn.asElement().click();
    await new Promise(r => setTimeout(r, 500));

    // ── 2 · the panel opens with both dangerous flags DISARMED ────────────────────────────────
    const opened = await page.evaluate(() => ({
      text: document.body.innerText,
      hasTextarea: !!document.querySelector('textarea'),
      hasFileInput: !!document.querySelector('input[type=file]'),
    }));
    check(opened.hasTextarea && opened.hasFileInput,
      'the panel offers both a file picker and a paste box');
    check(/Fill empty columns only/i.test(opened.text),
      '⛔ OVERWRITE IS DISARMED BY DEFAULT — fill-nulls-only is the resting state');
    check(/Refuse changed postings/i.test(opened.text),
      '⛔ the staleness refusal is the resting state too');
    check(!/OVERWRITE existing values/i.test(opened.text) && !/APPLY to changed postings/i.test(opened.text),
      'neither armed label is showing before anything is clicked');
    check(/JSONL, not CSV/i.test(opened.text),
      'the panel says WHY the format is JSONL rather than the CSV sitting next to it');

    // ── 3 · Apply is locked until a dry run has passed for THIS text ───────────────────────────
    const applyState = async () => page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /Apply Import/i.test(x.textContent));
      return b ? { disabled: b.disabled } : null;
    });
    check((await applyState())?.disabled === true,
      'Apply is DISABLED on an empty panel');

    await page.type('textarea', SAMPLE.slice(0, 60));   // partial, then replace wholesale below
    await page.evaluate((t) => {
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, t);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, SAMPLE);
    await new Promise(r => setTimeout(r, 300));
    check((await applyState())?.disabled === true,
      '⛔ Apply is STILL disabled with a file loaded but no dry run');

    const dryBtn = await findBtn(/Dry Run/);
    await dryBtn.asElement().click();
    await new Promise(r => setTimeout(r, 900));

    const afterDry = await page.evaluate(() => document.body.innerText);
    check(/DRY RUN — nothing was written/i.test(afterDry),
      'the dry run result is rendered and says nothing was written');
    check(/PROJECTED FILL RATE/i.test(afterDry) && /skills_json/.test(afterDry),
      '⛔ the panel shows the per-column FILL DELTA, not just a row count');
    check(state.lastImport?.contentType === 'application/x-ndjson',
      'the panel uploaded the file as a raw application/x-ndjson body',
      state.lastImport?.contentType);
    check(state.lastImport?.body === SAMPLE,
      'the bytes the server received are exactly the bytes in the box');
    check(state.lastImport?.query.apply === undefined,
      '⛔ THE DRY RUN IS THE DEFAULT — the panel sent no apply flag',
      JSON.stringify(state.lastImport?.query));
    check((await applyState())?.disabled === false,
      'Apply unlocks once a clean plan exists for this exact file');

    // ── 4 · editing the file RE-LOCKS Apply and disarms the flags ─────────────────────────────
    const armBtn = await findBtn(/Fill empty columns only/);
    await armBtn.asElement().click();
    await new Promise(r => setTimeout(r, 250));
    check(/OVERWRITE existing values/i.test(await page.evaluate(() => document.body.innerText)),
      'arming overwrite states the consequence in the label');
    // The armed state is the whole safety argument, so it is captured rather than only asserted:
    // a red switch reading "⛔ OVERWRITE existing values" is the evidence that this is a decision
    // and not a checkbox someone ticked past.
    await page.screenshot({ path: path.join(OUT_DIR, 'overwrite-armed.png'), fullPage: false });
    const armedColour = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /OVERWRITE existing values/i.test(x.textContent));
      return b ? getComputedStyle(b).borderTopColor : null;
    });
    check(armedColour === 'rgb(220, 38, 38)',
      'the armed switch turns red — visible from across the panel, not a tick in a box', armedColour);

    await page.evaluate((t) => {
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, t);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, SAMPLE + '\n');
    await new Promise(r => setTimeout(r, 300));
    const afterEdit = await page.evaluate(() => document.body.innerText);
    check((await applyState())?.disabled === true,
      '⛔ CHANGING THE FILE RE-LOCKS APPLY — a verdict belongs to the bytes it was computed from');
    check(/Fill empty columns only/i.test(afterEdit) && !/OVERWRITE existing values/i.test(afterEdit),
      '⛔ changing the file also DISARMS overwrite — an arming decision does not carry over');

    // ── 5 · apply reports coverage and offers the revert ──────────────────────────────────────
    const dry2 = await findBtn(/Dry Run/);
    await dry2.asElement().click();
    await new Promise(r => setTimeout(r, 900));
    const applyBtn = await findBtn(/Apply Import/);
    await applyBtn.asElement().click();
    await new Promise(r => setTimeout(r, 900));

    const applied = await page.evaluate(() => document.body.innerText);
    check(state.lastImport?.query.apply === '1', 'apply sent the explicit apply flag');
    check(/IMPORTED — 2 row\(s\) written/i.test(applied),
      'the result states what was written', applied.slice(0, 200));
    check(/batch #77/i.test(applied) && /Revert batch #77/i.test(applied),
      '⛔ the import is presented as a REVERTIBLE BATCH, with the control right there');

    await page.screenshot({ path: path.join(OUT_DIR, 'import-panel.png'), fullPage: true });
    console.log(`\nscreenshot ${path.join(OUT_DIR, 'import-panel.png')}`);
  } finally {
    await browser.close();
    vite.proc.kill();
    api.close();
  }

  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.log(`FAIL harness threw: ${e.stack}`); process.exit(1); });
