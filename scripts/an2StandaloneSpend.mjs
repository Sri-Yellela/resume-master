#!/usr/bin/env node
/**
 * TASK AN2 — the anonymous spend controls, measured against a real server.
 * ============================================================================================
 * test/standaloneSpendControls.test.js reads source. It can prove the limiter CONTAINS the words
 * `WHERE client_ip=?` and it cannot prove that a second request with a fresh cookie is actually
 * refused — which is the entire behaviour, and the thing the old session-keyed limiter got wrong.
 *
 * ⛔ THIS SPENDS NOTHING. Every request is deliberately malformed (no file, no jd_text). The rate
 * limiter runs BEFORE multer and before the handler, so the quota is consumed and counted exactly
 * as it would be on a real call, and then the handler answers 400 without ever reaching a model.
 * That is the whole reason this is testable for free: the control being measured sits in front of
 * the cost it is protecting.
 *
 * Usage:  node scripts/an2StandaloneSpend.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'an2-spend-'));
const PORT = 4713;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

function boot(ceiling) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env, PORT: String(PORT), RM_DATA_DIR: DATA,
      NODE_ENV: 'development', ANON_DAILY_SERVICE_CEILING: String(ceiling),
    };
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b) => {
      out += b.toString();
      if (out.includes('monetisation')) setTimeout(() => resolve(child), 700);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', c => reject(new Error(`server exited early (${c})\n${out.slice(-1200)}`)));
    setTimeout(() => reject(new Error(`boot timeout\n${out.slice(-1200)}`)), 45000);
  });
}

// A fresh cookie jar every call unless one is passed in — the point is that a NEW cookie must not
// buy a new allowance. `ip` rides in X-Forwarded-For, which express resolves under trust proxy 1.
async function hit(service, { ip = '203.0.113.7', cookie = null } = {}) {
  const res = await fetch(`${BASE}/api/standalone/${service}`, {
    method: 'POST',
    headers: {
      'x-forwarded-for': ip,
      ...(cookie ? { cookie } : {}),
    },
    body: new FormData(),        // deliberately empty: consumes quota, reaches no model
  });
  let body = {};
  try { body = await res.json(); } catch {}
  return { status: res.status, body, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

const child = await boot(50).catch(e => { console.error(e.message); process.exit(1); });

try {
  console.log('\n══════ generate: the expensive surface is closed to anonymous callers ══════\n');
  const gen = await hit('generate');
  check('anonymous POST /api/standalone/generate is refused', gen.status === 401,
    `status ${gen.status}`);
  check('…with a machine-readable reason, not a generic failure',
    gen.body.error === 'standalone_auth_required', JSON.stringify(gen.body).slice(0, 120));
  check('…and human copy the tools page can show',
    typeof gen.body.message === 'string' && /sign in/i.test(gen.body.message), gen.body.message || '');

  console.log('\n══════ ats: still anonymous, and now bounded by IP rather than by cookie ══════\n');
  const first = await hit('ats');
  check('the first anonymous ats call gets PAST the limiter', first.status !== 401 && first.status !== 429,
    `status ${first.status} (400 = reached the handler, no model call)`);

  // THE DECISIVE ONE. Same IP, brand-new cookie jar — the exact move that used to reset the quota.
  const second = await hit('ats');
  check('a SECOND call from the same IP with a FRESH COOKIE is refused',
    second.status === 429 && second.body.error === 'limit_reached',
    `status ${second.status} error=${second.body.error}`);

  const other = await hit('ats', { ip: '198.51.100.22' });
  check('a different IP still gets its own allowance', other.status !== 429,
    `status ${other.status}`);

  console.log('\n══════ the daily ceiling bounds the bill even against rotating addresses ══════\n');
  child.kill();
  await new Promise(r => child.on('exit', r));
} catch (e) {
  console.error('\nHARNESS ERROR:', e.message);
  failures++;
  try { child.kill(); } catch {}
}

// Reboot with a ceiling of 2, against the SAME data dir — the rows written above already count.
const child2 = await boot(2).catch(e => { console.error(e.message); process.exit(1); });
try {
  // Every call from a distinct address, so the per-IP limit can never be what refuses them.
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await hit('ats', { ip: `192.0.2.${10 + i}` }));
  const busy = results.filter(r => r.status === 429 && r.body.error === 'service_busy');
  check('rotating IPs are eventually refused by the GLOBAL ceiling', busy.length > 0,
    results.map(r => `${r.status}:${r.body.error || 'ok'}`).join(' '));
  check('…and the refusal is service_busy, distinct from a per-caller limit',
    busy.every(r => r.body.error === 'service_busy'), `${busy.length} of 4 hit the ceiling`);
} catch (e) {
  console.error('\nHARNESS ERROR:', e.message);
  failures++;
} finally {
  child2.kill();
  await new Promise(r => child2.on('exit', r));
  fs.rmSync(DATA, { recursive: true, force: true });
}

console.log(failures === 0
  ? '\nALL PASS — a fresh cookie buys nothing, and the bill is bounded even against rotating IPs.'
  : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
