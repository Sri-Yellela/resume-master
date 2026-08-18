#!/usr/bin/env node
/**
 * E5 — the extractor, run against REAL job pages including ones no manifest could ever name.
 * ============================================================================================
 * Two findings drove this file, and it now guards both.
 *
 * First: Greenhouse moved. boards.greenhouse.io 301-redirects to job-boards.greenhouse.io for every
 * board, including for a job id that does not exist, and `#content` — the selector the extractor
 * used — exists on neither. Capture there was doubly broken.
 *
 * Second, and larger: plenty of Greenhouse postings are not on a greenhouse.io host at all. They are
 * embedded on the employer's own careers domain, and there is no list of employer domains to add to
 * a manifest. While capture ran from a content script it could only ever work on hosts the manifest
 * named, so those pages were not merely unsupported — the extension was absent on them. Capture now
 * injects under the activeTab grant, so the reachable set is "whatever page you invoke on", and the
 * per-site selector map is an optimisation rather than a gate.
 *
 * What this checks is the EXTRACTOR against real markup — whether the payload it builds is the
 * posting or the page furniture. It evaluates the real exported function in the real page, which is
 * the same serialisation executeScript performs, so what runs here is what runs in production.
 *
 * The grant mechanism is NOT re-proven here; e2CaptureConvergence.mjs captures end to end from an
 * origin with no host permission, and e6PopupGrant.mjs measures the grant itself.
 *
 * Read-only: no capture, no server, nothing written to any account.
 *
 * Usage:  node scripts/e5GreenhouseHost.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';
import { extractJobPayload } from '../extension/extractor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Real postings. The first two are the greenhouse host the manifest used to name; the last two are
// Greenhouse-powered listings on the EMPLOYER's own domain — the case that was impossible before.
const PAGES = [
  { label: 'job-boards.greenhouse.io (vercel)',  url: 'https://job-boards.greenhouse.io/vercel/jobs/6136160004', named: true },
  { label: 'job-boards.greenhouse.io (airtable)', url: 'https://job-boards.greenhouse.io/airtable/jobs/8403127002', named: true },
  { label: 'EMBEDDED — stripe.com',   url: 'https://stripe.com/jobs/search?gh_jid=8077887', named: false },
  { label: 'EMBEDDED — databricks.com', url: 'https://www.databricks.com/company/careers/open-positions/job?gh_jid=8559344002', named: false },
];

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};
const soft = (label, extra = '') => console.log(`NOTE  ${label}${extra ? '  — ' + extra : ''}`);

async function main() {
  console.log('=== E5 — the extractor against real job pages ===\n');

  // ── The retired host still redirects, so dropping it cost nothing ──────────
  const legacy = await fetch('https://boards.greenhouse.io/vercel/jobs/6136160004', { redirect: 'manual' });
  check('boards.greenhouse.io still 301s to the new host',
    legacy.status === 301 && /job-boards\.greenhouse\.io/.test(legacy.headers.get('location') || ''),
    `${legacy.status} -> ${legacy.headers.get('location')}`);

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  const siteHosts = manifest.host_permissions.filter(h => !h.includes('resumemaster.one'));
  check('the manifest names NO job site at all', siteHosts.length === 0,
    siteHosts.length ? siteHosts.join(', ') : 'capture reaches pages through activeTab alone');
  check('and declares no content script', !manifest.content_scripts,
    'nothing runs on page load, anywhere');

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error('No Chrome binary.'); process.exit(1); }

  const browser = await puppeteer.launch({
    executablePath: resolution.path, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    for (const { label, url, named } of PAGES) {
      console.log(`\n── ${label} ──`);
      const page = await browser.newPage();
      let loaded = true;
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      } catch (_) { loaded = false; }

      if (!loaded) {
        // A live third-party site is allowed to be slow or to move. Say so rather than failing the
        // run on someone else's uptime — but never quietly treat it as a pass.
        soft(`${label} did not load; skipped`, 'not counted either way');
        await page.close();
        continue;
      }

      // The REAL exported function, serialised into the page exactly as executeScript does it.
      const payload = await page.evaluate(extractJobPayload);
      await page.close();

      const desc = (payload.text || '').length;
      console.log(`      title="${(payload.title || '').slice(0, 60)}"  company="${(payload.company || '').slice(0, 30)}"  text=${desc} chars`);

      if (named) {
        check(`${label}: extracted a posting`, payload.ok === true,
          payload.ok ? `${desc} chars` : 'ok=false — the selector map missed');
        // Check the greenhouse ENTRY, not the whole file: the retired selector is named in a comment
        // explaining why it went, and matching that comment made this fail while the code was right.
        const entry = /'greenhouse\.io':[^\n]*/.exec(
          fs.readFileSync(path.join(ROOT, 'extension', 'extractor.js'), 'utf8'))?.[0] || '';
        check(`${label}: the greenhouse selectors are the current ones`,
          entry.includes('.job__description') && !entry.includes('#content'), entry.trim().slice(0, 70));
      } else {
        // THE POINT OF THE REARCHITECTURE. These hosts are on no list and never will be.
        check(`${label}: capturable despite being on NO declared host`, payload.ok === true,
          payload.ok ? `${desc} chars via the generic fallback` : 'ok=false — the generic path missed');
        check(`${label}: got a title`, !!payload.title, payload.title || 'none');
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('\nE5 FAILED:', e); process.exit(1); });
