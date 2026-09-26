import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { collectRequiredFiles, bundleBytes } from "../scripts/buildExtension.mjs";

// Guards the exact failure this replaced. The hand-assembled v1.1.0 submission drifted so far
// from extension/ that it shipped a `saved-jobs-content.js` content script which no longer
// exists in the repo at all — the LinkedIn bulk saved-jobs scraper BYO-2 removed — while
// missing the options page and capture shortcut the source had since gained. Nothing detected
// it because the artifact was built by hand and there was nothing to diff it against.
//
// ✅ FROM 2026-09-24 TO 2026-09-26, TWO TESTS HERE FAILED ON PURPOSE. Both are green now, and the
// way they went green is the point worth keeping:
//
//     every file in the submission zip is byte-identical to extension/ source
//     every file the manifest references is present in the zip        (auth.js was new)
//
// `extension/` had moved ahead of the published v1.0.0 package — the session-identity fix added
// `extension/auth.js` — and these correctly reported it for three weeks while the package sat in
// Web Store review. No assertion was weakened and nothing was silenced. P4 bumped the manifest to
// v1.1.0 and rebuilt the zip, which is what they were always waiting for.
//
// ⛔ THE WAIT WAS SAFE AND THE REASON MATTERS: the security fix was SERVER-side.
// scripts/dx2ExtensionIdentity.mjs §8 loaded the published v1.0.0 build against the fixed server
// with a live admin cookie and measured 0/7 admin routes reached, so installs were protected
// without a store update. Red tests were the correct state to be in, not a cost being paid.
//
// Full history: docs/EXTENSION_DIAGNOSIS.md §6.6. The deliberate-failure count lives in CLAUDE.md
// and currently reads zero, so a red here is now a real failure.

const SRC = "extension";
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
const ZIP = path.join(SRC, "submission", `resume-master-extension-v${manifest.version}.zip`);

async function loadZip() {
  return JSZip.loadAsync(fs.readFileSync(ZIP));
}

test("a submission zip exists for the version in manifest.json", () => {
  // Bumping the manifest without rebuilding is the easiest way to reintroduce the drift.
  assert.ok(fs.existsSync(ZIP), `expected ${ZIP} — run: npm run build:extension`);
});

test("manifest.json carries no UTF-8 BOM", () => {
  // Chrome has historically rejected a BOM'd manifest as invalid JSON. The v1.1.0 bundle
  // shipped with one.
  const raw = fs.readFileSync(path.join(SRC, "manifest.json"));
  assert.ok(!(raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF), "manifest.json must not start with a BOM");
});

test("every file in the submission zip is byte-identical to extension/ source", async () => {
  const zip = await loadZip();
  const entries = Object.values(zip.files).filter(f => !f.dir);
  assert.ok(entries.length > 0, "zip must not be empty");

  for (const entry of entries) {
    const srcPath = path.join(SRC, entry.name);
    assert.ok(fs.existsSync(srcPath), `zip contains ${entry.name}, which does not exist in source`);
    const inZip = Buffer.from(await entry.async("uint8array"));
    // ⛔ THROUGH bundleBytes, NOT RAW — and it is the BUILDER'S function, not a copy.
    //
    // `.gitattributes` says `* text=auto`, so extension/*.js is CRLF on a Windows checkout and LF
    // on Linux, while the zip is stored verbatim. Comparing raw bytes therefore asserted something
    // about the machine rather than about the artifact: this test passed on Windows and would fail
    // on a Linux CI clone of the same commit, and did fail here the moment a branch merge
    // round-tripped the tree through git. The builder now writes LF-normalised text, so this reads
    // the source the same way.
    //
    // Importing it rather than reimplementing it is deliberate: this file already kept its own
    // copy of the reachability rules once, and the two drifted the moment the builder learned to
    // follow ES imports.
    assert.ok(inZip.equals(bundleBytes(entry.name, fs.readFileSync(srcPath))),
      `${entry.name} differs from extension/${entry.name}`);
  }
});

test("⛔ the zip is a function of the COMMIT, not of the machine that built it", async () => {
  // The property the normalisation buys, asserted directly rather than implied. A published
  // artifact that cannot be regenerated from its commit is the hand-assembled bundle problem in a
  // new hat — and that bundle shipped a content script the repo no longer contained.
  const zip = await loadZip();
  for (const entry of Object.values(zip.files).filter(f => !f.dir && /\.(js|json|html|css)$/.test(f.name))) {
    const bytes = Buffer.from(await entry.async("uint8array"));
    assert.ok(!bytes.includes(Buffer.from("\r\n")),
      `${entry.name} carries CRLF inside the zip — the bundle now depends on which platform built ` +
      `it, so the same commit produces two different artifacts`);
  }

  // And binary assets must NOT have been through the normaliser: a "normalised" PNG is a corrupt
  // PNG, and it would be corrupt identically everywhere, which is the worst kind of reproducible.
  for (const entry of Object.values(zip.files).filter(f => !f.dir && f.name.endsWith(".png"))) {
    const bytes = Buffer.from(await entry.async("uint8array"));
    assert.ok(bytes.equals(fs.readFileSync(path.join(SRC, entry.name))),
      `${entry.name} was altered on the way into the zip — icons must pass through untouched`);
  }
});

test("the submission zip ships nothing unreachable from the manifest", async () => {
  // The saved-jobs-content.js case: a ghost file bundled into the published extension long
  // after the capability it implemented was removed from the codebase.
  //
  // Reachability comes from the BUILDER's own collectRequiredFiles rather than a copy of the rules
  // kept here. The copy drifted the moment the builder learned to follow ES imports: the zip
  // correctly contained gated-handoff.js, which background.js imports, and this test called it an
  // unreachable file that should not be shipping.
  const reachable = new Set(collectRequiredFiles(manifest));
  const zip = await loadZip();
  for (const entry of Object.values(zip.files).filter(f => !f.dir)) {
    assert.ok(reachable.has(entry.name),
      `${entry.name} is bundled but unreachable from the manifest — a removed capability may still be shipping`);
  }
});

test("every file the manifest references is present in the zip", async () => {
  const zip = await loadZip();
  const names = new Set(Object.values(zip.files).filter(f => !f.dir).map(f => f.name));
  // Same one definition as above, so "shipped" and "required" cannot disagree about what counts.
  for (const f of collectRequiredFiles(manifest)) {
    assert.ok(names.has(f), `manifest references ${f} but the zip does not contain it`);
  }
});

test("no bundled script points at localhost — the dev switch must not ship flipped", async () => {
  // config.js and background.js each carry a commented DEV SWITCH. Shipping the flipped form
  // would point every installed extension at a machine that isn't there.
  const zip = await loadZip();
  for (const entry of Object.values(zip.files).filter(f => !f.dir && f.name.endsWith(".js"))) {
    const text = await entry.async("string");
    for (const line of text.split("\n")) {
      assert.ok(
        !/^\s*(?:const|let|var)\s+\w+\s*=\s*["']https?:\/\/(localhost|127\.)/.test(line),
        `${entry.name} has an ACTIVE localhost URL: ${line.trim().slice(0, 80)}`
      );
    }
  }
});

test("the shipped bundle does not reintroduce bulk saved-jobs scraping", async () => {
  // BYO-2 removed this capability, and the README's privacy section states plainly that the
  // extension does not read saved-jobs lists. The published v1.1.0 bundle contradicted that.
  const zip = await loadZip();
  const names = Object.values(zip.files).map(f => f.name);
  assert.ok(!names.some(n => /saved-jobs/i.test(n)), "saved-jobs scraping must not be in the bundle");

  const matches = (manifest.content_scripts || []).flatMap(cs => cs.matches || []);
  assert.ok(!matches.some(m => /my-items|saved-jobs/i.test(m)),
    "no content script may target LinkedIn's saved-jobs pages");
});
