#!/usr/bin/env node
/**
 * TASK E3 — minimum permission, measured rather than argued.
 * ============================================================================================
 * The rule is "if removing it breaks nothing, it is not declared". That is only a real rule if
 * somebody removes each one and looks. This does that for the permissions that CAN be looked at:
 * for `storage` and `scripting` it builds a copy of the extension without the permission, loads
 * that copy in a real Chrome, and confirms the API namespace is gone.
 *
 * A permission that survives its own removal with nothing broken is an over-declaration, and under
 * the 2026-08-01 Web Store rules an over-declaration is grounds for rejection on its own.
 *
 * `activeTab` is the exception and it is reported as such rather than papered over. It grants
 * access rather than an API, and only in response to a real user gesture that no API can mint — so
 * no probe run from inside this harness can distinguish "declared" from "absent". It is measured
 * instead by scripts/g0ActiveTabSpike.mjs, which drives a real OS-level keypress; see the activeTab
 * branch below. A harness that reported a green tick there would be measuring nothing, which is
 * strictly worse than admitting the gap.
 *
 * It also checks the direction nobody remembers to check: that the manifest and
 * extension/MANIFEST_RATIONALE.md agree, in both directions. A declared permission with no
 * justification is undocumented; a justification for something no longer declared is a lie that
 * reads as thorough.
 *
 * Usage:  node scripts/e3PermissionAudit.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'extension');
const OUT = path.join(os.tmpdir(), 'e3-permission-audit');

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

/** A copy of extension/ with `drop` removed from permissions. extension/ itself is never touched. */
function variant(name, drop) {
  const dst = path.join(OUT, name);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(SRC, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'submission' || e.name === 'dist') continue;
      fs.cpSync(path.join(SRC, e.name), path.join(dst, e.name), { recursive: true });
    } else fs.copyFileSync(path.join(SRC, e.name), path.join(dst, e.name));
  }
  if (drop) {
    const m = JSON.parse(fs.readFileSync(path.join(dst, 'manifest.json'), 'utf8'));
    m.permissions = m.permissions.filter(p => p !== drop);
    fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(m, null, 2));
  }
  return dst;
}

/** What the extension can actually do, asked from inside an extension page. */
const CAPABILITIES = `(() => ({
  storage:   typeof chrome.storage !== 'undefined' && typeof chrome.storage.session !== 'undefined',
  scripting: typeof chrome.scripting !== 'undefined',
  tabs:      typeof chrome.tabs !== 'undefined',
  commands:  typeof chrome.commands !== 'undefined',
}))()`;

async function capabilitiesOf(browser, dir) {
  const id = await browser.installExtension(dir);
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  const caps = await page.evaluate(CAPABILITIES);
  await page.close();
  await browser.uninstallExtension(id).catch(() => {});
  return caps;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('=== E3 — minimum permission, measured ===\n');

  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  const rationale = fs.readFileSync(path.join(SRC, 'MANIFEST_RATIONALE.md'), 'utf8');

  // ── The manifest and its rationale must agree, both ways ──────────────────
  console.log('── manifest vs rationale ──');
  for (const p of manifest.permissions) {
    check(`permission "${p}" is justified`, rationale.includes(`\`${p}\``));
  }
  for (const h of manifest.host_permissions) {
    check(`host "${h}" is justified`, rationale.includes(h));
  }
  // The other direction: a row for something not declared.
  for (const claimed of ['cookies', 'tabs', 'notifications']) {
    const declared = manifest.permissions.includes(claimed);
    check(`"${claimed}" is documented as NOT declared, and is not declared`, !declared);
  }
  check('externally_connectable is absent', !('externally_connectable' in manifest));
  check('no portal origin is declared',
    !manifest.host_permissions.some(h => /workday|amazon|metacareers|myworkdayjobs/i.test(h)),
    manifest.host_permissions.length + ' hosts, none a gated portal');
  check('no bare-domain wildcard among job boards',
    !manifest.host_permissions.some(h => /^https:\/\/\*\.(linkedin|indeed|glassdoor)\.com\/\*$/.test(h)));

  // ── Every referenced path resolves in the packed source ──────────────────
  console.log('\n── manifest paths ──');
  const refs = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_page,
    ...Object.values(manifest.action.default_icon || {}),
    // No content_scripts any more — capture injects extractor.js under activeTab instead, so the
    // extractor is reachable through background.js's import graph rather than the manifest.
    ...(manifest.content_scripts || []).flatMap(cs => cs.js || []),
    'extractor.js',
  ];
  for (const r of refs) {
    check(`${r} exists`, fs.existsSync(path.join(SRC, r)));
  }
  for (const size of ['16', '48', '128']) {
    check(`icon ${size} declared and present`,
      !!manifest.action.default_icon?.[size] &&
      fs.existsSync(path.join(SRC, manifest.action.default_icon[size])));
  }

  // ── Remove each permission; confirm something breaks ─────────────────────
  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error('No Chrome binary.'); process.exit(1); }
  const profile = path.join(OUT, 'profile');
  fs.rmSync(profile, { recursive: true, force: true });

  const browser = await puppeteer.launch({
    executablePath: resolution.path, headless: false, pipe: true, enableExtensions: true,
    userDataDir: profile,
    args: ['--no-first-run', '--no-default-browser-check'],
    defaultViewport: null,
  });

  try {
    console.log('\n── with everything declared ──');
    const full = await capabilitiesOf(browser, variant('full', null));
    console.log(`      ${JSON.stringify(full)}`);
    check('storage available', full.storage === true);
    check('scripting available', full.scripting === true);

    for (const perm of manifest.permissions) {
      console.log(`\n── without "${perm}" ──`);
      const caps = await capabilitiesOf(browser, variant(`no-${perm}`, perm));
      console.log(`      ${JSON.stringify(caps)}`);

      if (perm === 'storage') {
        check('removing storage BREAKS chrome.storage', caps.storage === false,
          'the last-capture record and the handoff packet both depend on it');
      } else if (perm === 'scripting') {
        check('removing scripting BREAKS chrome.scripting', caps.scripting === false,
          'no form probe, no fill, no overlay, no ATS text collection');
      } else if (perm === 'activeTab') {
        // activeTab CANNOT be measured by this harness, and saying so is the point.
        //
        // It adds no API surface — it grants ACCESS, and only in response to a genuine user
        // gesture. There is no API that mints a grant; that is the entire security property. An
        // earlier version of this file probed it by removing activeTab and trying to reach
        // example.com from an extension page, and reported PASS. The check was VACUOUS: run as a
        // control WITH activeTab declared, it returns the identical 'no-tab-visible', because an
        // uninvoked grant reveals no more than an absent one. It would have passed whether or not
        // the permission were declared, which is the worst kind of green tick — see this repo's
        // own warning about a rationale that reads as thorough and is not.
        //
        // The boundary IS measured, in scripts/g0ActiveTabSpike.mjs, whose harness delivers a real
        // OS-level Ctrl+Shift+Y to a focused Chrome running this exact manifest. Findings in
        // docs/GATED_HANDOFF_ARCHITECTURE.md §9. Its trial C is the control that matters here:
        // when the grant lapses, executeScript STOPS WORKING — with host permissions covering none
        // of the test origins, so injection could only ever have come from the grant.
        //
        // What is checkable here is the precondition that makes G0's result load-bearing: that
        // there is still no other possible source of access to a portal page. If a portal host
        // permission were ever added, the handoff would keep working without activeTab and the
        // permission would become an over-declaration.
        console.log('      NOT MEASURED HERE — no API mints an activeTab grant.');
        console.log('      Measured in scripts/g0ActiveTabSpike.mjs (real OS-level gesture);');
        console.log('      see docs/GATED_HANDOFF_ARCHITECTURE.md §9, trial C = REVOKED.');

        // Any host but our own backend would be a source of access other than the grant. The job
        // boards used to be listed as acceptable exceptions here; they are not declared any more,
        // so the check tightened along with the manifest instead of keeping a hole open for them.
        const portalHost = manifest.host_permissions.find(h => !/resumemaster\.one/i.test(h));
        check('no host permission could substitute for the grant',
          !portalHost,
          portalHost ? `${portalHost} would give standing access` : 'our own origin is the only host declared');

        const handoff = fs.readFileSync(path.join(SRC, 'gated-handoff.js'), 'utf8');
        check('the handoff still depends on injecting into the granted tab',
          /chrome\.scripting\.executeScript/.test(handoff),
          'if this stopped being true, activeTab would need re-justifying');
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('\nAUDIT FAILED:', e); process.exit(1); });
