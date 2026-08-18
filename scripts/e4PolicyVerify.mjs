#!/usr/bin/env node
/**
 * TASK E4 — the hosted privacy policy, verified where it actually lives.
 * ============================================================================================
 * A policy that is correct in the repo and stale on the server is the version a reviewer reads.
 * The two can differ by a whole deploy, and the failure is invisible from inside the repo: every
 * test passes, the file says the right thing, and resumemaster.one/privacy still describes the
 * extension from three releases ago.
 *
 * So this checks the deployed page, not the source. Anonymously — no cookies, no session — because
 * a policy behind auth is a rejection, and because a reviewer is not signed in.
 *
 * It renders the page rather than curling it: the policy is client-rendered, so the raw HTML is an
 * empty shell and a text search against it would pass or fail for reasons unrelated to the prose.
 *
 * Usage:  node scripts/e4PolicyVerify.mjs
 */

import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';

const URL_ = 'https://resumemaster.one/privacy';

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
  ['effective date',            /Effective:\s*August 18, 2026/i],
  ['ONE capture action',        /one capture action/i],
  ['no job lists collected',    /does not collect lists of jobs/i],
  ['saved-jobs capability gone',/saved-jobs list.{0,80}removed|capability was removed/i],
  ['ATS Score Tool disclosed',  /ATS Score Tool/],
  ['in-page ATS button named',  /ATS Score this job/],
  ['only page change stated',   /only change the extension makes to a job page/i],
  ['server logs admitted',      /server logs/i],
  ['browser storage section',   /What the Extension Stores in Your Browser/i],
  ['ten minute expiry',         /ten minutes/i],
  ['no browsing history',       /not\s*collect your browsing history/i],
  ['no remotely hosted code',   /no remotely hosted code/i],
  ['six boards named',          /LinkedIn, Indeed, Glassdoor, Lever, Greenhouse and Workable/i],
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
