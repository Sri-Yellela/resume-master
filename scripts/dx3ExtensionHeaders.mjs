#!/usr/bin/env node
// DX3 — MEASUREMENT ONLY. What headers does Chrome actually attach to a credentialed fetch issued
// from an extension page to a host in host_permissions? Two guesses have now been wrong; this
// reads the request as the SERVER sees it, which is the only view that matters for a guard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';
import { CANONICAL_ORIGIN } from '../shared/brand.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(os.tmpdir(), 'dx3-headers');
const PORT = 4615;
const API = `http://127.0.0.1:${PORT}`;
const APP_URL_DECL = `const RESUME_MASTER_URL = '${CANONICAL_ORIGIN}';`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const seen = [];

function startEcho() {
  const srv = http.createServer((req, res) => {
    seen.push({ path: req.url, headers: { ...req.headers } });
    res.writeHead(200, { 'content-type': 'application/json',
      'access-control-allow-origin': req.headers.origin || '*',
      'access-control-allow-credentials': 'true' });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise(r => srv.listen(PORT, '127.0.0.1', () => r(srv)));
}

function buildExt(apiOrigin) {
  const src = path.join(ROOT, 'extension');
  const dst = path.join(OUT, 'extension');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name === 'submission') continue;
      fs.cpSync(path.join(src, e.name), path.join(dst, e.name), { recursive: true }); }
    else fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
  for (const f of ['background.js', 'config.js']) {
    const p = path.join(dst, f);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8')
      .replace(APP_URL_DECL, `const RESUME_MASTER_URL = '${apiOrigin}';`));
  }
  const mf = JSON.parse(fs.readFileSync(path.join(dst, 'manifest.json'), 'utf8'));
  mf.host_permissions = [...mf.host_permissions, `${apiOrigin}/*`];
  fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(mf, null, 2));
  return dst;
}

const echo = await startEcho();
const resolution = await resolveBrowserExecutable();
const browser = await puppeteer.launch({
  executablePath: resolution.path, headless: false, pipe: true, enableExtensions: true,
  userDataDir: path.join(OUT, 'profile'),
  args: ['--no-first-run', '--no-default-browser-check'], defaultViewport: null,
});
const id = await browser.installExtension(buildExt(API));
await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 20000 }).catch(() => {});
const page = await browser.newPage();
await page.goto(`chrome-extension://${id}/options.html`);

// Seed a cookie on the API origin so 'include' has something to send.
const site = await browser.newPage();
await site.goto(`${API}/seed`);
await site.evaluate(() => { document.cookie = 'connect.sid=fake-session-value; path=/'; });

await page.evaluate(async (o) => {
  await fetch(o + '/from-extension-page-include', { credentials: 'include' });
  await fetch(o + '/from-extension-page-omit', { credentials: 'omit' });
}, API);

const swT = await browser.waitForTarget(t => t.type() === 'service_worker');
const sw = await swT.worker();
await sw.evaluate(async (o) => { await fetch(o + '/from-service-worker', { credentials: 'include' }); }, API);

await sleep(600);
await browser.close();
echo.close();

const INTERESTING = ['origin', 'cookie', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest',
                     'referer', 'user-agent', 'x-rm-auth-context'];
for (const r of seen) {
  console.log(`\n── ${r.path} ──`);
  for (const h of INTERESTING) {
    const v = r.headers[h];
    console.log(`   ${h.padEnd(20)} ${v === undefined ? '(absent)' : String(v).slice(0, 70)}`);
  }
}
