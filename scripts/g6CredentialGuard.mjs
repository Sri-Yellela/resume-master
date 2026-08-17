#!/usr/bin/env node
/**
 * A portal's sign-in box is not an application field — REAL-RUN verification.
 * ============================================================================================
 * THE BUG
 * autoApply filled before it classified. A gated posting redirects to a sign-in page; discovery
 * walked it, found an input named `login_email` labelled "Email", resolved it to the `email` handler
 * and filled it with the candidate's address at field_map_exact — 0.9 confidence, the second-highest
 * tier. The run then correctly detected the gate and held, having already typed into a third party's
 * login form. Nothing was submitted, but on a real portal an email entered in a sign-in box is an
 * account-existence probe against that candidate's own identity.
 *
 * TWO DEFENCES, because either alone leaves a real hole:
 *   1. detectGate runs BEFORE the fill. A sign-in wall is never typed into at all.
 *   2. No credential CONTROL is ever answered. This still holds on a page the classifier does not
 *      flag as a gate — a login widget beside a real application form — and on the LEGACY IN-PAGE
 *      SWEEP, which bypasses buildAnswers entirely and which a resolver-side fix does not touch.
 *
 * The hard case is /gated/mixed: a sign-in form and an application form on one page, BOTH with a
 * control named `email`. Name and label are identical; the only thing telling them apart is which
 * form they belong to. The login side also carries the shapes the legacy sweep matches on — a bare
 * name="email", a placeholder, an autocomplete token.
 *
 * Usage:  node scripts/g6CredentialGuard.mjs
 *         (starts its own fakeAts if one is not already listening)
 */

import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../services/browserLauncher.js';
import {
  discoverFields, buildAnswers, fillContext, detectGate,
} from '../services/applyAutomation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ATS = `http://localhost:${process.env.PORT || 4599}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// `password` is in here deliberately. The legacy sweep's type exclusion list is
// hidden/submit/button/file/image — password is NOT on it — so a profile carrying this key would
// have had it typed straight into the page's password box by the sweep's first step.
const PAYLOAD = {
  field_map: {
    first_name: 'Ada', last_name: 'Lovelace', full_name: 'Ada Lovelace',
    email: 'ada@example.com', phone: '+1 555 0100', password: 'hunter2',
    current_company: 'Analytical Engines',
  },
  handler_map: {}, custom_answers: {}, dropdown_map: {},
};

async function main() {
  console.log('=== the candidate\'s details never enter a login form ===\n');

  let ats = null;
  const alive = await new Promise(res => {
    const rq = http.get(`${ATS}/gated/mixed`, r => { r.resume(); res(r.statusCode === 200); });
    rq.on('error', () => res(false));
    rq.setTimeout(1500, () => { rq.destroy(); res(false); });
  });
  if (!alive) {
    ats = spawn(process.execPath, [path.join(ROOT, 'scripts', 'fakeAts.js')], { stdio: 'ignore' });
    await sleep(1500);
  }

  const browser = await launchBrowser({ headless: 'new' });
  try {
    // ── 1. the sign-in wall ────────────────────────────────────────────────
    console.log('── a sign-in wall ──');
    const signin = await browser.newPage();
    await signin.goto(`${ATS}/gated/signin`, { waitUntil: 'domcontentloaded' });

    check('the gate is detected on the page as it stands, before anything is filled',
      await detectGate(signin) === 'login_required');

    const signinFields = await discoverFields(signin, 'generic');
    const credential = signinFields.filter(f => f.credential).map(f => f.name);
    check('every control on it is marked as a credential control',
      credential.length === signinFields.length && signinFields.length > 0,
      `${credential.join(', ')} of ${signinFields.length}`);
    check('none of them kept a handler',
      signinFields.every(f => f.handler_type === null),
      signinFields.map(f => `${f.name}=${f.handler_type}`).join(' '));

    const resolved = buildAnswers(signinFields, PAYLOAD).filter(a => !a.skipped && a.value);
    check('THE RESOLVER FILLS NOTHING', resolved.length === 0,
      resolved.length ? resolved.map(a => `${a.name}=${a.value}`).join(', ') : 'nothing');

    // The legacy sweep runs against the same page. It is a separate code path with separate guards.
    await fillContext(signin, PAYLOAD, {});
    const signinState = await signin.evaluate(() =>
      [...document.querySelectorAll('input')].map(el => ({ name: el.name, value: el.value })));
    check('THE LEGACY SWEEP FILLS NOTHING EITHER',
      signinState.every(f => f.value === ''), JSON.stringify(signinState));
    await signin.close();

    // ── 2. the hard case: both forms on one page ───────────────────────────
    console.log('\n── a sign-in form and an application form on ONE page ──');
    const mixed = await browser.newPage();
    await mixed.goto(`${ATS}/gated/mixed`, { waitUntil: 'domcontentloaded' });

    const mixedFields = await discoverFields(mixed, 'generic');
    const loginEmail = mixedFields.find(f => f.field_id === 'login_email');
    const applyEmail = mixedFields.find(f => f.name === 'applicant_email');
    check('the login form\'s email is marked credential', loginEmail?.credential === true,
      `in_credential_form=${loginEmail?.in_credential_form}`);
    check('the application form\'s email is NOT', !applyEmail?.credential,
      `credential=${applyEmail?.credential}`);
    check('the two are told apart by their FORM, not their name — both are called "email"',
      loginEmail?.label === 'Email' && loginEmail?.name === 'email',
      `login name=${loginEmail?.name} label=${loginEmail?.label}`);

    const mixedAnswers = buildAnswers(mixedFields, PAYLOAD).filter(a => !a.skipped && a.value);
    check('the resolver fills the application and not the sign-in',
      mixedAnswers.some(a => a.name === 'applicant_email') &&
      !mixedAnswers.some(a => a.field_id === 'login_email'),
      mixedAnswers.map(a => a.name).join(', '));

    const swept = await fillContext(mixed, PAYLOAD, {});
    const state = await mixed.evaluate(() => {
      const v = (sel) => document.querySelector(sel)?.value ?? null;
      return {
        LOGIN_email:    v('#loginform [name="email"]'),
        LOGIN_password: v('#loginform [name="password"]'),
        apply_first:    v('#applyform [name="first_name"]'),
        apply_last:     v('#applyform [name="last_name"]'),
        apply_email:    v('#applyform [name="applicant_email"]'),
        apply_phone:    v('#applyform [name="phone"]'),
      };
    });
    console.log(`      sweep filled ${swept} control(s): ${JSON.stringify(state)}`);
    check('NOTHING reached the login email, though it is named `email` and the payload has one',
      state.LOGIN_email === '', `value=${JSON.stringify(state.LOGIN_email)}`);
    check('NOTHING reached the password box, though the payload carries a `password` key',
      state.LOGIN_password === '', `value=${JSON.stringify(state.LOGIN_password)}`);
    check('the APPLICATION was still filled — the guard is not a blanket refusal',
      state.apply_first === 'Ada' && state.apply_last === 'Lovelace' &&
      state.apply_email === 'ada@example.com' && state.apply_phone === '+1 555 0100',
      JSON.stringify(state));
    await mixed.close();

    // ── 3. ordinary forms are untouched by all of this ─────────────────────
    console.log('\n── the ordinary forms still fill exactly as before ──');
    for (const [route, expected] of [
      ['/greenhouse', ['job_application[first_name]', 'job_application[last_name]', 'job_application[email]']],
      ['/lever', ['name', 'email']],
      ['/ashby', ['_systemfield_name', '_systemfield_email']],
      ['/gated/form', ['first_name', 'last_name', 'email']],
    ]) {
      const p = await browser.newPage();
      await p.goto(`${ATS}${route}`, { waitUntil: 'domcontentloaded' });
      const f = await discoverFields(p, 'generic');
      const a = buildAnswers(f, PAYLOAD).filter(x => !x.skipped && x.value).map(x => x.name);
      check(`${route} still fills its fields`, expected.every(n => a.includes(n)),
        a.join(', '));
      check(`${route} has no field wrongly marked as a credential`,
        f.every(x => !x.credential), f.filter(x => x.credential).map(x => x.name).join(', ') || 'none');
      await p.close();
    }

  } finally {
    await browser.close().catch(() => {});
    if (ats) ats.kill();
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('\nHARNESS FAILED:', e); process.exit(1); });
