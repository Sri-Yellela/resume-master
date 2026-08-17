#!/usr/bin/env node
/**
 * Chrome Web Store publisher.
 *
 * WHY THIS IS SHAPED THE WAY IT IS
 * Publishing is irreversible and outward-facing: once a version is live it is on real users'
 * machines, and the only remedy is another review cycle. So the default here is to UPLOAD A DRAFT
 * and stop. A draft can be replaced as often as you like and nobody sees it. Going live needs
 * --publish, typed deliberately.
 *
 * The preflight is the real content of this script. Every check below exists because the v1.3.0
 * submission was, at one point, genuinely ready to be uploaded with a listing that declared
 * "personally identifiable information — not collected" about a build that fills a candidate's
 * postal address into an employer's form. Nothing in the CWS API would have stopped that. These
 * checks run BEFORE any network write, and a failure means nothing has been touched remotely.
 *
 *   1. the zip exists for the version in manifest.json
 *   2. the zip is byte-identical to extension/ — using the BUILDER's own file list, not a copy
 *   3. no bundled script has an active localhost URL (the dev switch is not flipped)
 *   4. STORE_LISTING.md is written for THIS version — the guard against shipping a build whose
 *      disclosures describe the previous one
 *   5. the privacy policy URL in the manifest actually resolves
 *   6. the version is greater than every version previously built here
 *
 * CREDENTIALS (never printed, never committed)
 *   CWS_CLIENT_ID       OAuth client id, authorised for the Chrome Web Store API
 *   CWS_CLIENT_SECRET   its secret
 *   CWS_REFRESH_TOKEN   a refresh token for the account that OWNS the store item
 *   CWS_ITEM_ID         the 32-character item id from the dashboard URL
 *
 * USAGE
 *   node scripts/publishExtension.mjs --dry-run        preflight only; touches nothing, needs no creds
 *   node scripts/publishExtension.mjs                  preflight, then upload as a DRAFT
 *   node scripts/publishExtension.mjs --publish        ...and publish to everyone
 *   node scripts/publishExtension.mjs --publish --target=trustedTesters
 *   node scripts/publishExtension.mjs --publish --percent=10     staged rollout
 *
 * Exits non-zero on any failure, so it is safe to gate a release on.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { collectRequiredFiles, readTextNoBom, SRC_DIR } from './buildExtension.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUBMISSION_DIR = path.join(SRC_DIR, 'submission');
const LISTING = path.join(SUBMISSION_DIR, 'STORE_LISTING.md');

const TOKEN_URL  = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = (id) => `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${id}`;
const ITEM_URL   = (id) => `https://www.googleapis.com/chromewebstore/v1.1/items/${id}`;
const PUBLISH_URL = (id) => `https://www.googleapis.com/chromewebstore/v1.1/items/${id}/publish`;

// ── Pure guards (exported so they are unit-testable without a network or credentials) ────────

/** Compare dot-separated integer versions. Returns >0 when a is newer. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Versions of every zip previously built into extension/submission/. */
export function builtVersions(dir = SUBMISSION_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map(f => /^resume-master-extension-v(.+)\.zip$/.exec(f)?.[1])
    .filter(Boolean);
}

/**
 * The version STORE_LISTING.md is written for.
 *
 * The listing is prose and cannot be validated by machine, but the ONE thing that can be checked is
 * whether anybody looked at it this release — and a listing still headed with the previous version
 * is the specific failure this guards. See the header of that file.
 */
export function listingVersion(text) {
  return /^#\s+Chrome Web Store listing\s+—\s+Resume Master v(\S+)/m.exec(String(text))?.[1] ?? null;
}

/**
 * Everything that must be true before a byte leaves this machine.
 * @returns {{ ok: boolean, problems: string[], notes: string[] }}
 */
export function preflight({ manifest, zipEntries, sourceFiles, listingText, priorVersions }) {
  const problems = [], notes = [];
  const version = manifest.version;

  // 2. The artifact is the source. buildExtension proves this at build time; this proves it again
  //    at publish time, because the two can be separated by any amount of editing.
  const required = new Set(sourceFiles.map(f => f.name));
  for (const entry of zipEntries) {
    if (!required.has(entry.name)) {
      problems.push(`zip contains ${entry.name}, which the manifest does not reach`);
      continue;
    }
    const src = sourceFiles.find(f => f.name === entry.name);
    if (!entry.bytes.equals(src.bytes)) problems.push(`${entry.name} in the zip differs from extension/${entry.name}`);
  }
  for (const f of sourceFiles) {
    if (!zipEntries.some(e => e.name === f.name)) problems.push(`the manifest reaches ${f.name} but the zip omits it`);
  }

  // 3. A dev-switched URL in a store build points real users at localhost.
  for (const f of sourceFiles.filter(f => f.name.endsWith('.js'))) {
    for (const line of f.bytes.toString('utf8').split('\n')) {
      if (/^\s*(?:const|let|var)\s+\w+\s*=\s*['"]https?:\/\/(localhost|127\.)/.test(line)) {
        problems.push(`${f.name} has an ACTIVE localhost URL — the dev switch is flipped`);
      }
    }
  }

  // 4. The listing describes THIS build.
  const lv = listingVersion(listingText);
  if (!lv) problems.push('STORE_LISTING.md has no recognisable version header');
  else if (lv !== version) {
    problems.push(
      `STORE_LISTING.md is written for v${lv} but this build is v${version}. ` +
      `The dashboard copy — single purpose, permission justifications, data disclosures — has not ` +
      `been revisited for this release.`
    );
  }

  // 6. The version moves forward.
  const newer = priorVersions.filter(v => compareVersions(v, version) >= 0 && v !== version);
  if (newer.length) problems.push(`version ${version} is not newer than already-built ${newer.join(', ')}`);
  if (!/^\d+(\.\d+){0,3}$/.test(String(version || ''))) problems.push(`"${version}" is not a valid version string`);

  if (!manifest.privacy_policy_url) notes.push('manifest has no privacy_policy_url');

  return { ok: problems.length === 0, problems, notes };
}

// ── CWS API ───────────────────────────────────────────────────────────────────────────────────

async function accessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: 'refresh_token',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Google's error body can echo request parameters; report the code only.
    throw new Error(`token exchange failed (${res.status} ${body.error || 'unknown'}). ` +
      `Check CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN.`);
  }
  return body.access_token;
}

const api = (token) => ({
  'Authorization': `Bearer ${token}`,
  'x-goog-api-version': '2',
});

async function getItem(token, itemId) {
  const res = await fetch(`${ITEM_URL(itemId)}?projection=DRAFT`, { headers: api(token) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function uploadDraft(token, itemId, zipBytes) {
  const res = await fetch(UPLOAD_URL(itemId), {
    method: 'PUT',
    headers: { ...api(token), 'Content-Type': 'application/zip' },
    body: zipBytes,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function publish(token, itemId, { target = 'default', percent = null }) {
  const url = new URL(PUBLISH_URL(itemId));
  url.searchParams.set('publishTarget', target);
  if (percent != null) url.searchParams.set('deployPercentage', String(percent));
  const res = await fetch(url, { method: 'POST', headers: { ...api(token), 'Content-Length': '0' } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(`--${f}`);
  const opt = (f, d = null) => argv.find(a => a.startsWith(`--${f}=`))?.split('=')[1] ?? d;

  const dryRun  = has('dry-run');
  const doPublish = has('publish');
  const target  = opt('target', 'default');
  const percent = opt('percent') ? Number(opt('percent')) : null;

  if (!['default', 'trustedTesters'].includes(target)) {
    console.error(`[publish] --target must be default or trustedTesters, got "${target}"`);
    return 1;
  }

  const manifest = JSON.parse(readTextNoBom(path.join(SRC_DIR, 'manifest.json')).text);
  const version = manifest.version;
  const zipPath = path.join(SUBMISSION_DIR, `resume-master-extension-v${version}.zip`);

  console.log(`[publish] ${manifest.name} v${version}`);
  console.log(`[publish] artifact  ${path.relative(ROOT, zipPath)}`);
  console.log(`[publish] mode      ${dryRun ? 'DRY RUN (nothing is sent)' : doPublish ? `UPLOAD + PUBLISH -> ${target}${percent != null ? ` @ ${percent}%` : ''}` : 'UPLOAD DRAFT ONLY'}`);

  if (!fs.existsSync(zipPath)) {
    console.error(`\n[publish] no artifact for v${version}. Run: npm run build:extension`);
    return 1;
  }

  // ── Preflight ───────────────────────────────────────────────────────────────
  const zipBytes = fs.readFileSync(zipPath);
  const zip = await JSZip.loadAsync(zipBytes);
  const zipEntries = await Promise.all(
    Object.values(zip.files).filter(f => !f.dir)
      .map(async f => ({ name: f.name, bytes: Buffer.from(await f.async('uint8array')) }))
  );
  const sourceFiles = collectRequiredFiles(manifest)
    .filter(rel => fs.existsSync(path.join(SRC_DIR, rel)))
    .map(rel => ({ name: rel, bytes: fs.readFileSync(path.join(SRC_DIR, rel)) }));

  const result = preflight({
    manifest, zipEntries, sourceFiles,
    listingText: fs.existsSync(LISTING) ? fs.readFileSync(LISTING, 'utf8') : '',
    priorVersions: builtVersions(),
  });

  // 5. The privacy policy has to actually resolve — a dead URL is an automatic rejection, and it is
  //    the one preflight check that cannot be done offline.
  if (manifest.privacy_policy_url) {
    try {
      const res = await fetch(manifest.privacy_policy_url, { method: 'GET', redirect: 'follow' });
      if (!res.ok) result.problems.push(`privacy policy ${manifest.privacy_policy_url} returned ${res.status}`);
      else console.log(`[publish] privacy  ${manifest.privacy_policy_url} -> ${res.status}`);
    } catch (e) {
      result.problems.push(`privacy policy ${manifest.privacy_policy_url} is unreachable: ${e.message}`);
    }
  }

  for (const n of result.notes) console.log(`[publish] note: ${n}`);
  if (result.problems.length) {
    console.error('\n[publish] PREFLIGHT FAILED — nothing was sent:');
    for (const p of result.problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log(`[publish] preflight OK — ${zipEntries.length} files, byte-identical to extension/`);

  if (dryRun) {
    console.log('\n[publish] dry run: preflight passed, nothing sent.');
    return;
  }

  // ── Credentials ─────────────────────────────────────────────────────────────
  const creds = {
    clientId:     process.env.CWS_CLIENT_ID,
    clientSecret: process.env.CWS_CLIENT_SECRET,
    refreshToken: process.env.CWS_REFRESH_TOKEN,
  };
  const itemId = process.env.CWS_ITEM_ID;
  const missing = [
    ['CWS_CLIENT_ID', creds.clientId], ['CWS_CLIENT_SECRET', creds.clientSecret],
    ['CWS_REFRESH_TOKEN', creds.refreshToken], ['CWS_ITEM_ID', itemId],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`\n[publish] missing credentials: ${missing.join(', ')}`);
    console.error('[publish] see extension/README.md for how to obtain them; --dry-run needs none.');
    return 1;
  }

  const token = await accessToken(creds);
  console.log('[publish] authenticated');

  const before = await getItem(token, itemId);
  if (before.status === 200) {
    console.log(`[publish] current draft: v${before.body.crxVersion ?? '?'} state=${before.body.uploadState}`);
    if (before.body.crxVersion && compareVersions(version, before.body.crxVersion) <= 0) {
      console.error(`\n[publish] v${version} is not newer than the store's v${before.body.crxVersion}. Bump manifest.json.`);
      return 1;
    }
  } else {
    console.warn(`[publish] could not read the item (${before.status}) — continuing to upload.`);
  }

  // ── Upload ──────────────────────────────────────────────────────────────────
  const up = await uploadDraft(token, itemId, zipBytes);
  const state = up.body.uploadState;
  if (up.status !== 200 || state === 'FAILURE') {
    console.error(`\n[publish] UPLOAD FAILED (${up.status} ${state ?? ''})`);
    for (const e of up.body.itemError || []) console.error(`  - ${e.error_code}: ${e.error_detail}`);
    return 1;
  }
  console.log(`[publish] uploaded as draft — state=${state}`);

  if (!doPublish) {
    console.log('\n[publish] Draft uploaded and NOT published. Nobody sees it yet.');
    console.log('[publish] Review the listing in the dashboard, then re-run with --publish.');
    return 0;
  }

  // ── Publish ─────────────────────────────────────────────────────────────────
  const pub = await publish(token, itemId, { target, percent });
  if (pub.status !== 200) {
    console.error(`\n[publish] PUBLISH FAILED (${pub.status})`);
    console.error(JSON.stringify(pub.body, null, 2));
    return 1;
  }
  console.log(`[publish] published -> ${target}: ${(pub.body.status || []).join(', ') || 'OK'}`);
  for (const d of pub.body.statusDetail || []) console.log(`  ${d}`);
  console.log('\n[publish] Live after Google\'s review. Track it in the dashboard.');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  // exitCode rather than exit(): tearing the process down while undici still has a socket closing
  // raises a libuv assertion on Windows, which reads as a crash in CI output even on a clean refusal.
  // main() returns the code so every refusal path is a plain `return`, and none of them can forget.
  main()
    .then(code => { process.exitCode = code ?? 0; })
    .catch(e => { console.error(`\n[publish] ${e.message}`); process.exitCode = 1; });
}
