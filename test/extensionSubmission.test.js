import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import JSZip from "jszip";

// Guards the exact failure this replaced. The hand-assembled v1.1.0 submission drifted so far
// from extension/ that it shipped a `saved-jobs-content.js` content script which no longer
// exists in the repo at all — the LinkedIn bulk saved-jobs scraper BYO-2 removed — while
// missing the options page and capture shortcut the source had since gained. Nothing detected
// it because the artifact was built by hand and there was nothing to diff it against.

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
    assert.ok(inZip.equals(fs.readFileSync(srcPath)), `${entry.name} differs from extension/${entry.name}`);
  }
});

test("the submission zip ships nothing unreachable from the manifest", async () => {
  // The saved-jobs-content.js case: a ghost file bundled into the published extension long
  // after the capability it implemented was removed from the codebase.
  const reachable = new Set(["manifest.json"]);
  reachable.add(manifest.background.service_worker);
  reachable.add(manifest.action.default_popup);
  if (manifest.options_page) reachable.add(manifest.options_page);
  Object.values(manifest.action.default_icon || {}).forEach(p => reachable.add(p));
  for (const cs of manifest.content_scripts || []) (cs.js || []).forEach(f => reachable.add(f));
  for (const html of [manifest.action.default_popup, manifest.options_page].filter(Boolean)) {
    const text = fs.readFileSync(path.join(SRC, html), "utf8");
    for (const m of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
      if (!/^(https?:)?\/\//i.test(m[1])) reachable.add(m[1].replace(/^\.\//, ""));
    }
  }

  const zip = await loadZip();
  for (const entry of Object.values(zip.files).filter(f => !f.dir)) {
    assert.ok(reachable.has(entry.name),
      `${entry.name} is bundled but unreachable from the manifest — a removed capability may still be shipping`);
  }
});

test("every file the manifest references is present in the zip", async () => {
  const zip = await loadZip();
  const names = new Set(Object.values(zip.files).filter(f => !f.dir).map(f => f.name));
  const required = [
    "manifest.json",
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_page,
    ...Object.values(manifest.action.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap(cs => cs.js || []),
  ].filter(Boolean);

  for (const f of required) assert.ok(names.has(f), `manifest references ${f} but the zip does not contain it`);
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
