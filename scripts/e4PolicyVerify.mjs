#!/usr/bin/env node
/**
 * TASK E4 — the hosted privacy policy, verified where it actually lives.
 * ============================================================================================
 * A policy that is correct in the repo and stale on the server is the version a reviewer reads.
 * The two can differ by a whole deploy, and the failure is invisible from inside the repo: every
 * test passes, the file says the right thing, and the deployed /privacy still describes the
 * extension from three releases ago.
 *
 * So this checks the deployed page, not the source. Anonymously — no cookies, no session — because
 * a policy behind auth is a rejection, and because a reviewer is not signed in.
 *
 * It renders the page rather than curling it: the policy is client-rendered, so the raw HTML is an
 * empty shell and a text search against it would pass or fail for reasons unrelated to the prose.
 *
 * ⛔ DURING THE DOMAIN MIGRATION, RUN THIS TWICE. Both origins serve the same application, but
 * they are separate deploys as far as a reviewer is concerned, and the Web Store holds a URL on
 * whichever one the shipped manifest names. Passing on the new origin says nothing about the old
 * one, which is the only origin the reviewed extension knows about.
 *
 * Usage:  node scripts/e4PolicyVerify.mjs                 # the URL the shipped manifest declares
 *         node scripts/e4PolicyVerify.mjs <origin>        # e.g. the other origin, mid-migration
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';
import { CANONICAL_ORIGIN, PRIVACY_POLICY_PATH } from '../shared/brand.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ⛔ THE DEFAULT ORIGIN COMES FROM THE MANIFEST, NOT FROM A CONSTANT.
 *
 * What this script is for is checking the page A REVIEWER WILL FETCH, and the URL a reviewer
 * fetches is whatever extension/manifest.json declares — today the legacy origin, because the
 * package is frozen under review, and the canonical one the moment P4 ships. Reading it from the
 * manifest means this is correct on both sides of that change with nothing to remember to flip.
 *
 * Defaulting to CANONICAL_ORIGIN instead would have pointed this at a domain whose certificate has
 * not issued yet, turning a green check red for a reason that has nothing to do with the policy.
 */
const manifestUrl = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'extension/manifest.json'), 'utf8'),
).privacy_policy_url;
const ORIGIN = (process.argv[2] || (manifestUrl ? new URL(manifestUrl).origin : CANONICAL_ORIGIN))
  .replace(/\/$/, '');
const URL_ = `${ORIGIN}${PRIVACY_POLICY_PATH}`;
console.log(`target   ${URL_}${process.argv[2] ? ' (overridden)' : ' (from extension/manifest.json)'}`);

// The effective date is read from the page that renders it, never written down twice. Hardcoding it
// here meant the check failed on 2026-09-15 for the one reason it is not supposed to catch: the
// policy had been updated correctly and deployed correctly, and only this file still believed in
// August 19. A copy of the date here tests whether somebody remembered to edit two files; reading
// the constant tests what the docstring above actually promises — that the deploy has caught up
// with the source.
const SOURCE = path.join(ROOT, 'client/src/pages/marketing/PrivacyPage.jsx');
const dateMatch = fs.readFileSync(SOURCE, 'utf8').match(/^const EFFECTIVE_DATE\s*=\s*'([^']+)'/m);
if (!dateMatch) {
  console.error(`FAIL  could not read EFFECTIVE_DATE from ${path.relative(ROOT, SOURCE)}`);
  console.error('      The constant was renamed or restyled; this check cannot assert a date it');
  console.error('      cannot find, and silently skipping it would be worse than stopping.');
  process.exit(1);
}
const EFFECTIVE_DATE = dateMatch[1];
console.log(`source   EFFECTIVE_DATE = ${EFFECTIVE_DATE}`);

// 1. Anonymous HTTP fetch — no cookies, no session, no redirect.
const res = await fetch(URL_, { redirect: 'manual' });
console.log(`HTTP     ${res.status} ${res.statusText}`);
console.log(`redirect ${res.headers.get('location') || 'none'}`);
console.log(`type     ${res.headers.get('content-type')}`);

// 2. Render it, because the policy is client-rendered and prose is the deliverable.
const r = await resolveBrowserExecutable();
const browser = await puppeteer.launch({
  executablePath: r.path, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
// A brand-new incognito-equivalent context: no storage, no cookies, nothing signed in.
const resp = await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 60000 });
console.log(`rendered ${resp.status()}`);
const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
await browser.close();

console.log(`length   ${text.length} chars of rendered prose\n`);

const MUST = [
  ['effective date matches source', new RegExp(`Effective:\\s*${EFFECTIVE_DATE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')],
  ['ONE capture action',        /one capture action/i],
  ['no job lists collected',    /does not collect lists of jobs/i],
  ['saved-jobs capability gone',/saved-jobs list.{0,80}removed|capability was removed/i],
  ['ATS Score Tool disclosed',  /ATS Score Tool/],
  ['in-page button removed',    /that button has been removed/i],
  ['no page modification',      /no longer changes the appearance of any page/i],
  ['per-invocation rule',       /reads nothing until you invoke it/i],
  ['no standing site access',   /holds no standing permission for any site/i],
  ['server logs admitted',      /server logs/i],
  ['browser storage section',   /What the Extension Stores in Your Browser/i],
  ['ten minute expiry',         /ten minutes/i],
  ['no browsing history',       /not\s*collect your browsing history/i],
  ['no remotely hosted code',   /no remotely hosted code/i],
  // The policy used to have to name the six job boards, because those were the only pages the
  // extension could read and the list WAS the limit. There is no such list now, and reprinting one
  // would imply a boundary that does not exist — so what is checked instead is the claim that
  // replaced it: that access is momentary and tied to an invocation.
  ['access is momentary',       /access to that tab ends when you navigate away/i],
  ['both directions stated',    /trades constant access to six sites for momentary access/i],
  ['Apify disclosed',           /Apify/],
  ['proactive change notice',   /before that change takes effect/i],
  ['account-linked PII',        /captured job data is personal information/i],
];
const MUST_NOT = [
  ['stale saved-jobs claim', /other than job listings and your saved jobs list/i],
  ['stale last-updated',     /Last updated:\s*May 19, 2026/i],
];

let bad = 0;
for (const [label, re] of MUST) {
  const ok = re.test(text);
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}
for (const [label, re] of MUST_NOT) {
  const ok = !re.test(text);
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  absent: ${label}`);
}
console.log(bad === 0 ? '\nHOSTED POLICY MATCHES THE COMMITTED POLICY'
                      : `\n${bad} MISMATCH(ES) — the deploy has not caught up, or content drifted`);
process.exit(bad === 0 ? 0 : 1);
