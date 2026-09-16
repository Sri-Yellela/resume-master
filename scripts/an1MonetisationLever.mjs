#!/usr/bin/env node
/**
 * TASK AN1 — the monetisation lever, measured in both states against a real server.
 * ============================================================================================
 * The unit tests in test/monetisationLever.test.js read SOURCE. They can prove that every gate
 * contains the words `if (!MONETISATION_ENABLED) return true;` and they cannot prove that a BASIC
 * user actually gets served — a green source-string suite has already passed over three real
 * pipeline defects in this repo. So this boots server.js TWICE against a throwaway database, with
 * the flag off and then on, registers one real user, and asks the running process.
 *
 * The user is registered ONCE, in the first boot, and both boots share the data directory. That is
 * the point: the assertion is that THE SAME BASIC USER is served with the lever off and refused
 * with it on. Two different users would prove nothing about the lever.
 *
 * ⛔ Nothing here touches the developer's real database or the production deployment. RM_DATA_DIR
 * points at a temp directory that is deleted on the way out, and both boots take their own port.
 *
 * Usage:  node scripts/an1MonetisationLever.mjs [--screenshots]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'an1-lever-'));
const WANT_SHOTS = process.argv.includes('--screenshots');
const SHOT_DIR = path.join(ROOT, 'docs', 'monetisation-lever');

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

function boot(port, enabled) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(port), RM_DATA_DIR: DATA, NODE_ENV: 'development' };
    // Deleted rather than set to "0": the absent-variable case is the one that ships today, and a
    // harness that only ever tests an explicit "0" would never exercise the real default.
    if (enabled) env.MONETISATION_ENABLED = '1'; else delete env.MONETISATION_ENABLED;

    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b) => {
      out += b.toString();
      if (/listening|running|:\s*\d+/i.test(out) && out.includes('monetisation')) {
        // Give express a beat to finish binding before the first request.
        setTimeout(() => resolve({ child, log: out }), 600);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`server exited early (${code})\n${out.slice(-1500)}`)));
    setTimeout(() => reject(new Error(`boot timeout on :${port}\n${out.slice(-1500)}`)), 45000);
  });
}

const BASE = (p) => `http://127.0.0.1:${p}`;

async function jsonOf(res) {
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return { __nonJson: ct };
  return res.json().catch(() => ({}));
}

const USER = { username: `lever_${Date.now()}`, password: 'Lever-Test-99!' };
// /api/auth/register requires a profile block; the harness is not testing registration validation,
// it just needs one real BASIC account to exist.
const REGISTRATION = { ...USER, profile: { email: `${USER.username}@example.test`, first_name: 'Lever', last_name: 'Test' } };

async function run() {
  // ───────────────────────── LEVER OFF ─────────────────────────
  console.log('\n══════ LEVER OFF (variable absent — the state that ships today) ══════\n');
  let { child, log } = await boot(4711, false);
  check('boot announces the state', /monetisation: disabled/.test(log),
    (log.match(/\[boot\] monetisation:.*/) || [''])[0].trim());

  let cfg = await jsonOf(await fetch(`${BASE(4711)}/api/config`));
  check('GET /api/config says false', cfg.monetisationEnabled === false, JSON.stringify(cfg));

  // Register the ONE user both halves use. Defaults to BASIC by migration 033.
  const reg = await fetch(`${BASE(4711)}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(REGISTRATION),
  });
  const regBody = await jsonOf(reg);
  check('registered a real user', reg.status < 400, `status ${reg.status}`);
  check('and it defaulted to BASIC', (regBody.user?.planTier || regBody.planTier) === 'BASIC',
    JSON.stringify(regBody.user || regBody).slice(0, 120));

  const login = async (port) => {
    const r = await fetch(`${BASE(port)}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(USER),
    });
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    const body = await jsonOf(r);
    return { cookie, token: body.token, status: r.status };
  };
  const authed = (s) => ({ ...(s.cookie ? { cookie: s.cookie } : {}),
                           ...(s.token ? { authorization: `Bearer ${s.token}` } : {}),
                           'content-type': 'application/json' });

  let sess = await login(4711);
  check('logged in', sess.status === 200, `status ${sess.status}`);

  let plans = await jsonOf(await fetch(`${BASE(4711)}/api/plans`, { headers: authed(sess) }));
  check('GET /api/plans offers no upgrade', Array.isArray(plans.changeOptions) && plans.changeOptions.length === 0,
    `changeOptions=${JSON.stringify(plans.changeOptions)}`);
  check('…and reports every capability true', plans.capabilities?.canUseGenerate === true && plans.capabilities?.canUseAPlusResume === true,
    JSON.stringify(plans.capabilities));
  check('…while still reporting the REAL tier', plans.planTier === 'BASIC', `planTier=${plans.planTier}`);

  let up = await fetch(`${BASE(4711)}/api/plans/request-upgrade`, {
    method: 'POST', headers: authed(sess), body: JSON.stringify({ requestedTier: 'PRO' }),
  });
  check('POST /api/plans/request-upgrade is ABSENT (404, not a 403 upsell)', up.status === 404, `status ${up.status}`);

  // The decisive one: a PLUS-gated route, hit by a BASIC user.
  let kw = await fetch(`${BASE(4711)}/api/jobs/1/keywords`, {
    method: 'POST', headers: authed(sess), body: JSON.stringify({ resumeText: 'python sql' }),
  });
  let kwBody = await jsonOf(kw);
  // ⛔ 401 MUST NOT COUNT AS A PASS. The first run of this harness "passed" this check with a 401
  // because registration had failed and nobody was logged in — an unauthenticated refusal is not
  // evidence that the gate opened. The assertion therefore requires an AUTHENTICATED response that
  // is not the upsell, which only a real session can produce.
  check('a BASIC user is SERVED by a PLUS-gated route', kw.status !== 401 && kw.status !== 403 && kwBody.error !== 'upgrade_required',
    `status ${kw.status} error=${kwBody.error || 'none'}`);

  if (WANT_SHOTS) await shoot(4711, 'lever-off');
  child.kill();
  await new Promise(r => child.on('exit', r));

  // ───────────────────────── LEVER ON ─────────────────────────
  console.log('\n══════ LEVER ON (MONETISATION_ENABLED=1) ══════\n');
  ({ child, log } = await boot(4712, true));
  check('boot announces the state and the legal consequence', /monetisation: ENABLED/.test(log) && /trader/i.test(log),
    (log.match(/\[boot\] monetisation:.*/) || [''])[0].trim().slice(0, 130));

  cfg = await jsonOf(await fetch(`${BASE(4712)}/api/config`));
  check('GET /api/config says true', cfg.monetisationEnabled === true, JSON.stringify(cfg));

  sess = await login(4712);
  check('the SAME user logs in', sess.status === 200, `status ${sess.status}`);

  plans = await jsonOf(await fetch(`${BASE(4712)}/api/plans`, { headers: authed(sess) }));
  check('GET /api/plans offers upgrades again', (plans.changeOptions || []).length > 0,
    `changeOptions=${JSON.stringify(plans.changeOptions)}`);
  check('…and capabilities follow the real tier again', plans.capabilities?.canUseGenerate === false && plans.capabilities?.canUseAPlusResume === false,
    JSON.stringify(plans.capabilities));

  up = await fetch(`${BASE(4712)}/api/plans/request-upgrade`, {
    method: 'POST', headers: authed(sess), body: JSON.stringify({ requestedTier: 'PRO' }),
  });
  check('POST /api/plans/request-upgrade exists again', up.status === 200, `status ${up.status}`);

  kw = await fetch(`${BASE(4712)}/api/jobs/1/keywords`, {
    method: 'POST', headers: authed(sess), body: JSON.stringify({ resumeText: 'python sql' }),
  });
  kwBody = await jsonOf(kw);
  check('the SAME BASIC user is now REFUSED with upgrade_required', kw.status === 403 && kwBody.error === 'upgrade_required',
    `status ${kw.status} error=${kwBody.error} requiredTier=${kwBody.requiredTier}`);

  if (WANT_SHOTS) await shoot(4712, 'lever-on');
  child.kill();
  await new Promise(r => child.on('exit', r));
}

// Renders the three commercial surfaces anonymously and records what a visitor sees.
async function shoot(port, tag) {
  const puppeteer = (await import('puppeteer-core')).default;
  const { resolveBrowserExecutable } = await import('../services/browserLauncher.js');
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const r = await resolveBrowserExecutable();
  const browser = await puppeteer.launch({ executablePath: r.path, headless: true, args: ['--no-sandbox'] });
  for (const [name, route] of [['pricing', '/pricing'], ['features', '/features'], ['how-it-works', '/how-it-works']]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${BASE(port)}${route}`, { waitUntil: 'networkidle2', timeout: 45000 });
    const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    const file = path.join(SHOT_DIR, `${tag}-${name}.png`);
    await page.screenshot({ path: file });
    const commercial = /pricing|upgrade|Plus unlocks|Pro unlocks|paid upgrades/i.test(text);
    console.log(`  shot ${path.relative(ROOT, file)}  commercial-copy:${commercial ? 'PRESENT' : 'absent'}`);
    if (tag === 'lever-off') check(`${route} carries no commercial copy with the lever off`, !commercial);
    await page.close();
  }
  await browser.close();
}

try {
  await run();
} catch (e) {
  console.error('\nHARNESS ERROR:', e.message);
  failures++;
} finally {
  fs.rmSync(DATA, { recursive: true, force: true });
}

console.log(failures === 0
  ? '\nALL PASS — the same BASIC user is served with the lever off and refused with it on.'
  : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
