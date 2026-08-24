#!/usr/bin/env node
/**
 * AF5 — the correction watcher, against a real browser.
 * ============================================================================================
 * WHY THIS EXISTS
 * AF5's campaign asks for "anything the human corrected" per run, and calls the corrections the
 * signal: each one is either a resolver defect or a missing custom answer. Nothing recorded them.
 * A semi run RETURNS while the browser is still open — `awaiting_user` means the human has not
 * finished — so their edits happen after the only moment autoApply could have reported anything.
 *
 * installCorrectionWatcher closes that. This proves it does, in a real Chrome, against real
 * controls: a text input, a select, a checkbox and a radio group, which are the four shapes an
 * answer can be typed into.
 *
 * THE FALSE POSITIVES MATTER MORE THAN THE TRUE ONES. A correction record that reports edits nobody
 * made turns the campaign's most valuable output into noise, so the cases below include a field
 * changed and changed BACK, a field the resolver never filled, and a control removed from the page.
 *
 * Self-contained: it serves its own form rather than using scripts/fakeAts.js, because what is under
 * test is the watcher, not a fixture's shape.
 *
 * Usage: node scripts/af5CorrectionWatch.mjs
 */
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';
import { installCorrectionWatcher } from '../services/applyAutomation.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// Bracketed name on purpose: `job_application[requires_sponsorship]` is how a real ATS namespaces a
// field, and it goes into an attribute selector inside the in-page probe.
const FORM = `<!doctype html><html><body>
<form id="f">
  <label for="full_name">Full Name</label>
  <input id="full_name" name="full_name" value="">
  <label for="org">Current Company</label>
  <input id="org" name="org" value="">
  <label for="start">Earliest start date</label>
  <input id="start" name="start" value="">
  <select id="sp" name="job_application[requires_sponsorship]">
    <option value=""></option><option value="Yes">Yes</option><option value="No">No</option>
  </select>
  <input type="checkbox" id="agree" name="agree">
  <input type="radio" name="pref" id="pref_a" value="Remote">
  <input type="radio" name="pref" id="pref_b" value="Onsite">
  <input id="untouched" name="untouched" value="left alone">
  <input id="doomed" name="doomed" value="filled by us">
</form></body></html>`;

// What "this run filled", with the provenance a real resolver would have attached. `doomed` is
// filled and then deleted from the page; `untouched` is never filled at all.
const RESOLVED = [
  { field_id: 'full_name', name: 'full_name', label: 'Full Name', value: 'Ada Lovelace',
    provenance: 'field_map_exact', confidence: 0.9 },
  { field_id: 'org', name: 'org', label: 'Current Company', value: 'Analytical Engines',
    provenance: 'label_fuzzy', confidence: 0.3 },
  { field_id: 'start', name: 'start', label: 'Earliest start date', value: '2026-09-15',
    provenance: 'custom_answer', confidence: 0.85 },
  { field_id: 'sp', name: 'job_application[requires_sponsorship]', label: 'Sponsorship',
    value: 'No', provenance: 'sponsorship_derived', confidence: 1.0 },
  { field_id: 'agree', name: 'agree', label: 'I agree', value: 'true',
    provenance: 'handler_exact', confidence: 1.0 },
  { field_id: 'pref_a', name: 'pref', label: 'Work preference', value: 'Remote',
    provenance: 'field_map_exact', confidence: 0.9 },
  { field_id: 'doomed', name: 'doomed', label: 'Doomed', value: 'filled by us',
    provenance: 'field_map_exact', confidence: 0.9 },
  // Skipped and refused entries must be IGNORED: a human answering a question we declined to guess
  // is not correcting us, and missingRequired already reports it.
  { field_id: 'untouched', name: 'untouched', label: 'Untouched', value: null,
    skipped: true, refusals: ['eligibility_class:sponsorship'] },
];

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(FORM);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/`;

const resolution = await resolveBrowserExecutable();
if (!resolution?.path) { console.error('no browser available'); process.exit(1); }

const browser = await puppeteer.launch({
  executablePath: resolution.path, headless: 'new', pipe: true,
  args: ['--no-first-run', '--no-default-browser-check'],
});

// Every report the watcher makes, in order. The watcher reports the FULL current correction set each
// time, so the last entry is the current truth.
const reports = [];

try {
  const page = await browser.newPage();
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });

  // Fill exactly what RESOLVED claims was filled, so the watcher's baseline is real.
  await page.evaluate((answers) => {
    for (const a of answers) {
      if (a.skipped || a.value === null) continue;
      const el = document.getElementById(a.field_id);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = a.value === 'true';
      else if (el.type === 'radio') el.checked = true;
      else el.value = a.value;
    }
  }, RESOLVED);

  const watched = await installCorrectionWatcher(page, RESOLVED, (c) => reports.push(c));
  check('the watcher watches only the fields that were FILLED', watched === 7, `watched=${watched}`);

  const latest = () => (reports.length ? reports[reports.length - 1] : []);
  const fieldsIn = (r) => r.map(c => c.field).sort();

  // ── nothing changed yet ────────────────────────────────────────────────────
  await sleep(2600);
  check('a form nobody has touched reports NO corrections',
    latest().length === 0, JSON.stringify(latest()));

  // ── a text edit ────────────────────────────────────────────────────────────
  console.log('\n── the human corrects a guess ──');
  await page.evaluate(() => {
    const el = document.getElementById('org');
    el.value = 'Analytical Engines Ltd';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(600);
  let c = latest().find(x => x.field === 'Current Company');
  check('the correction is reported', !!c, JSON.stringify(latest()));
  check('it carries what WE put there', c?.was === 'Analytical Engines', c?.was);
  check('and what the HUMAN put there', c?.now === 'Analytical Engines Ltd', c?.now);
  check('and the provenance that produced the wrong value — the defect being reported',
    c?.provenance === 'label_fuzzy' && c?.confidence === 0.3,
    `${c?.provenance}/${c?.confidence}`);

  // ── changed and changed BACK ───────────────────────────────────────────────
  console.log('\n── a change reverted is NOT a correction ──');
  await page.evaluate(() => {
    const el = document.getElementById('org');
    el.value = 'Analytical Engines';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(600);
  check('reverting removes it from the record',
    !latest().some(x => x.field === 'Current Company'), JSON.stringify(latest()));

  // ── a select, a checkbox and a radio ───────────────────────────────────────
  console.log('\n── the other three control shapes ──');
  await page.evaluate(() => {
    const sp = document.getElementById('sp');
    sp.value = 'Yes';
    sp.dispatchEvent(new Event('change', { bubbles: true }));
    const ag = document.getElementById('agree');
    ag.checked = false;
    ag.dispatchEvent(new Event('change', { bubbles: true }));
    const pb = document.getElementById('pref_b');
    pb.checked = true;
    pb.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(600);
  const sel = latest().find(x => x.field === 'Sponsorship');
  check('a SELECT correction is caught', sel?.was === 'No' && sel?.now === 'Yes',
    JSON.stringify(sel));
  const box = latest().find(x => x.field === 'I agree');
  check('a CHECKBOX being unticked is caught', box?.was === 'true' && box?.now === 'false',
    JSON.stringify(box));
  const rad = latest().find(x => x.field === 'Work preference');
  check('a RADIO group moving is caught, by reading the checked member',
    rad?.was === 'Remote' && rad?.now === 'Onsite', JSON.stringify(rad));

  // ── the false positives ───────────────────────────────────────────────────
  console.log('\n── what must NOT be reported ──');
  check('a field the resolver never filled is not a correction',
    !latest().some(x => x.field === 'Untouched'), JSON.stringify(fieldsIn(latest())));

  await page.evaluate(() => {
    const el = document.getElementById('untouched');
    el.value = 'the human typed this';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(600);
  check('...even after the human types into it — that is them answering, not correcting us',
    !latest().some(x => x.field === 'Untouched'), JSON.stringify(fieldsIn(latest())));

  await page.evaluate(() => document.getElementById('doomed').remove());
  await sleep(2600);
  check('a control REMOVED from the page is not reported as emptied',
    !latest().some(x => x.field === 'Doomed'), JSON.stringify(fieldsIn(latest())));

  // ── the polled path ───────────────────────────────────────────────────────
  // A click-driven submit can navigate before a listener runs, and an SPA can swap a control
  // without firing input or change on it. So the watcher polls as well as listens.
  console.log('\n── a silent change, with no event fired at all ──');
  await page.evaluate(() => { document.getElementById('full_name').value = 'A. Lovelace'; });
  await sleep(2600);
  const silent = latest().find(x => x.field === 'Full Name');
  check('a change that fired NO event is still caught by the poll',
    silent?.now === 'A. Lovelace', JSON.stringify(silent));

  // ── the shape the campaign report consumes ────────────────────────────────
  console.log('\n── the record ──');
  for (const c of latest()) {
    check(`  ${c.field}: has every field the report needs`,
      ['field', 'was', 'now', 'provenance'].every(k => k in c), JSON.stringify(c));
  }
  check('the run never submitted anything — this only ever reads',
    await page.evaluate(() => !window.__submitted));

} finally {
  await browser.close().catch(() => {});
  server.close();
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
