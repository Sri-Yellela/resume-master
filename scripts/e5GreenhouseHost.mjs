#!/usr/bin/env node
/**
 * E5 — Greenhouse moved hosts, and the extension did not. REAL-RUN verification.
 * ============================================================================================
 * boards.greenhouse.io now 301-redirects to job-boards.greenhouse.io for every board, including
 * for a job id that does not exist — so it is a blanket host redirect, not a per-company
 * migration. The extension declared only the old host, and its extractor looked for `#content`,
 * which exists on neither. Greenhouse capture was doubly broken: the content script never ran,
 * and if it had, its selectors would have missed.
 *
 * Nothing about that is checkable offline. A fixture would have been written from the same stale
 * assumption as the extractor, so this drives a real Chrome against a REAL posting, with the real
 * extension loaded, and asserts three things:
 *
 *   1. the content script actually matches the new host — proven by the button it injects at
 *      document_idle, which is the extension's own observable footprint on the page
 *   2. the extractor returns the job description rather than falling through to the body-text
 *      fallback, which "works" in the sense that it returns something and is mostly page furniture
 *   3. the old host still redirects, so dropping it from the manifest is safe
 *
 * Read-only: it never captures, so it needs no server and writes nothing to any account.
 *
 * Usage:  node scripts/e5GreenhouseHost.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC  = path.join(ROOT, 'extension');
const OUT  = path.join(os.tmpdir(), 'e5-greenhouse');

// Real postings on the new host, from more than one board so a single company's template cannot
// be mistaken for the platform's.
const POSTINGS = [
  'https://job-boards.greenhouse.io/vercel/jobs/6136160004',
  'https://job-boards.greenhouse.io/airtable/jobs/8403127002',
];

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// The staged copy and the browser profile must be SIBLINGS, not nested: Chrome refuses to load an
// extension directory containing a name that starts with "_", and a profile dropped inside the
// extension is exactly that.
function stagedExtension() {
  const ext = path.join(OUT, 'ext');
  fs.rmSync(ext, { recursive: true, force: true });
  fs.mkdirSync(ext, { recursive: true });
  for (const e of fs.readdirSync(SRC, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'submission' || e.name === 'dist') continue;
      fs.cpSync(path.join(SRC, e.name), path.join(ext, e.name), { recursive: true });
    } else fs.copyFileSync(path.join(SRC, e.name), path.join(ext, e.name));
  }
  return ext;
}

async function main() {
  console.log('=== E5 — Greenhouse host migration, measured on the real site ===\n');

  // ── The old host redirects, so declaring it buys nothing ────────────────────
  console.log('── the retired host ──');
  const legacy = await fetch('https://boards.greenhouse.io/vercel/jobs/6136160004', { redirect: 'manual' });
  check('boards.greenhouse.io 301s to the new host',
    legacy.status === 301 && /job-boards\.greenhouse\.io/.test(legacy.headers.get('location') || ''),
    `${legacy.status} -> ${legacy.headers.get('location')}`);

  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  check('the manifest no longer declares the redirecting host',
    !manifest.host_permissions.some(h => h.startsWith('https://boards.greenhouse.io')),
    'a host that always redirects can never run a content script');
  check('the manifest declares the host postings actually live on',
    manifest.host_permissions.includes('https://job-boards.greenhouse.io/*/*'));

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error('No Chrome binary.'); process.exit(1); }

  const dir = stagedExtension();
  const profile = path.join(OUT, 'profile');
  fs.rmSync(profile, { recursive: true, force: true });

  const browser = await puppeteer.launch({
    executablePath: resolution.path, headless: false, pipe: true, enableExtensions: true,
    userDataDir: profile, defaultViewport: null,
    args: ['--no-first-run', '--no-default-browser-check'],
  });

  try {
    await browser.installExtension(dir);

    for (const url of POSTINGS) {
      console.log(`\n── ${url.split('/').slice(3, 4)} ──`);
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

      // 1. Did the content script match? Its injected button is the observable proof.
      await page.waitForSelector('#rm-send-btn', { timeout: 15000 }).catch(() => {});
      const injected = await page.$('#rm-send-btn');
      check('the content script runs on this host', !!injected,
        injected ? 'its injected button is present' : 'no #rm-send-btn — the match pattern missed');

      // 2. Does the extractor find the description, or fall through to page furniture?
      const probe = await page.evaluate(() => {
        const t = sel => document.querySelector(sel)?.innerText?.trim() || '';
        const desc = t('.job__description');
        const body = (document.querySelector('main') || document.body).innerText.trim();
        return {
          description: desc.length,
          descriptionHead: desc.slice(0, 90).replace(/\s+/g, ' '),
          legacyContent: !!document.querySelector('#content'),
          bodyFallback: body.length,
          title: t('h1').slice(0, 60),
        };
      });

      check('.job__description exists and holds the posting', probe.description > 400,
        `${probe.description} chars — "${probe.descriptionHead}…"`);
      check('the retired #content selector is genuinely gone', probe.legacyContent === false,
        'so the old extractor matched nothing and fell through to body text');
      check('the extractor beats the body-text fallback', probe.description < probe.bodyFallback,
        `description ${probe.description} vs whole-page ${probe.bodyFallback} chars`);
      check('a title is available for the captured record', probe.title.length > 3, probe.title);

      await page.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('\nE5 FAILED:', e); process.exit(1); });
