/**
 * Builds the Chrome Web Store submission zip from extension/ source.
 *
 * This exists because there wasn't one. The committed v1.1.0 submission zip had drifted so far
 * from extension/ that it shipped a content script (saved-jobs-content.js, the LinkedIn bulk
 * saved-jobs scraper BYO-2 removed) which no longer exists in the repo at all, while missing the
 * options page and capture shortcut the source had since gained. Nobody could tell, because the
 * artifact was hand-assembled and there was nothing to diff it against.
 *
 * The file list is DERIVED from manifest.json and the HTML entry points rather than hardcoded,
 * so a newly referenced script can never be silently left out of the bundle, and a file that
 * stops being referenced stops being shipped. Anything present in extension/ but unreachable
 * from the manifest is reported and excluded.
 *
 *   node scripts/buildExtension.mjs            → writes extension/submission/…-v<version>.zip
 *   node scripts/buildExtension.mjs --check     → validate only, write nothing
 *
 * Exits non-zero on any validation failure, so this is safe to gate a release on.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import JSZip from 'jszip';

const ROOT    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SRC_DIR = path.join(ROOT, 'extension');
const OUT_DIR = path.join(SRC_DIR, 'submission');

const problems = [];
function fail(msg) { problems.push(msg); }

export function readTextNoBom(file) {
  const raw = fs.readFileSync(file);
  const hasBom = raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF;
  return { text: (hasBom ? raw.subarray(3) : raw).toString('utf8'), hasBom };
}

// ── Collect every file the extension can actually reach ──────────────────────────────────────
export function collectRequiredFiles(manifest) {
  const need = new Set(['manifest.json']);

  if (manifest.background?.service_worker) need.add(manifest.background.service_worker);
  if (manifest.action?.default_popup)      need.add(manifest.action.default_popup);
  if (manifest.options_page)               need.add(manifest.options_page);
  Object.values(manifest.action?.default_icon || {}).forEach(p => need.add(p));
  Object.values(manifest.icons || {}).forEach(p => need.add(p));

  for (const cs of manifest.content_scripts || []) {
    (cs.js  || []).forEach(f => need.add(f));
    (cs.css || []).forEach(f => need.add(f));
  }
  for (const res of manifest.web_accessible_resources || []) {
    (res.resources || []).forEach(f => need.add(f));
  }

  // Follow the HTML entry points one level: a popup/options page pulls in its own scripts and
  // stylesheets, and those are not listed anywhere in the manifest.
  for (const entry of [...need].filter(f => f.endsWith('.html'))) {
    const file = path.join(SRC_DIR, entry);
    if (!fs.existsSync(file)) continue;
    const { text } = readTextNoBom(file);
    for (const m of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
      const ref = m[1];
      // Skip absolute/remote refs — only local bundle assets matter here.
      if (/^(https?:)?\/\//i.test(ref) || ref.startsWith('data:') || ref.startsWith('#')) continue;
      need.add(ref.replace(/^\.\//, ''));
    }
  }

  // Follow ES import graphs, transitively.
  //
  // The header above claims a newly referenced script can never be silently left out of the bundle.
  // That was true of anything the manifest or an HTML page named, and false of anything a MODULE
  // imported: background.js is declared "type": "module", so `import './x.js'` is a real dependency
  // that nothing here looked at. The build would have shipped a service worker whose first import
  // 404s — a bundle that validates, zips cleanly, and is dead on load, discoverable only after a
  // Web Store review had already been spent on it.
  const seen = new Set();
  const queue = [...need].filter(f => f.endsWith('.js'));
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const file = path.join(SRC_DIR, rel);
    if (!fs.existsSync(file)) continue;
    const { text } = readTextNoBom(file);
    // Static `import ... from 'x'`, bare `import 'x'`, and `export ... from 'x'`. Dynamic import()
    // with a computed specifier is unresolvable by construction and is reported as unreferenced
    // rather than guessed at.
    for (const m of text.matchAll(/(?:^|[\s;}])(?:import|export)\s+(?:[^'"()]*?\sfrom\s+)?["']([^"']+)["']/g)) {
      const spec = m[1];
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;   // bare/remote: not ours
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      need.add(resolved);
      queue.push(resolved);
    }
  }
  return [...need].sort();
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
// Guarded so collectRequiredFiles can be imported without building anything. test/
// extensionSubmission.test.js used to carry its OWN copy of the reachability rules, and the two
// drifted the moment the bundler learned to follow ES imports: the build shipped gated-handoff.js
// and the test called it an unreachable file that should not be there. One definition, imported.
async function main() {
  const manifestPath = path.join(SRC_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('[buildExtension] No extension/manifest.json');
    process.exit(1);
  }

  const manifestRead = readTextNoBom(manifestPath);
  if (manifestRead.hasBom) {
    // Chrome has historically rejected a BOM'd manifest as invalid JSON. Never ship one.
    fail('manifest.json starts with a UTF-8 BOM — strip it before building');
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestRead.text);
  } catch (err) {
    console.error('[buildExtension] manifest.json is not valid JSON:', err.message);
    process.exit(1);
  }

  const version = manifest.version;
  if (!/^\d+(\.\d+){0,3}$/.test(String(version || ''))) {
    fail(`manifest version "${version}" is not a valid Chrome extension version string`);
  }

  const required = collectRequiredFiles(manifest);

  for (const rel of required) {
    if (!fs.existsSync(path.join(SRC_DIR, rel))) fail(`referenced file is missing from source: ${rel}`);
  }

  // A dev-switched URL in a store build points real users at localhost. Cheap to check, fatal to miss.
  for (const rel of required.filter(f => f.endsWith('.js'))) {
    const file = path.join(SRC_DIR, rel);
    if (!fs.existsSync(file)) continue;
    const { text } = readTextNoBom(file);
    for (const line of text.split('\n')) {
      if (/^\s*(?:const|let|var)\s+\w+\s*=\s*['"]https?:\/\/localhost|^\s*(?:const|let|var)\s+\w+\s*=\s*['"]https?:\/\/127\./.test(line)) {
        fail(`${rel} has an ACTIVE localhost URL — the dev switch is flipped: ${line.trim().slice(0, 80)}`);
      }
    }
  }

  // Report reachable-but-unshipped files so dead weight is visible rather than silently bundled.
  const onDisk = [];
  (function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (rel === 'submission' || rel === 'dist') continue; // build outputs, never inputs
        walk(path.join(dir, entry.name), rel);
      } else {
        onDisk.push(rel);
      }
    }
  })(SRC_DIR);

  const unreferenced = onDisk.filter(f => !required.includes(f));

  console.log(`[buildExtension] ${manifest.name} v${version}`);
  console.log(`[buildExtension] ${required.length} files reachable from the manifest:`);
  for (const f of required) console.log(`    ${f}`);
  if (unreferenced.length) {
    console.log(`[buildExtension] excluded (not reachable from the manifest): ${unreferenced.join(', ')}`);
  }

  if (problems.length) {
    console.error('\n[buildExtension] VALIDATION FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  if (process.argv.includes('--check')) {
    console.log('\n[buildExtension] --check passed; nothing written.');
    process.exit(0);
  }

  const zip = new JSZip();
  for (const rel of required) {
    // Store POSIX-separated paths; a zip built on Windows must not carry backslash entry names.
    zip.file(rel.split(path.sep).join('/'), fs.readFileSync(path.join(SRC_DIR, rel)));
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `resume-master-extension-v${version}.zip`);
  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  fs.writeFileSync(outFile, buf);

  console.log(`\n[buildExtension] wrote ${path.relative(ROOT, outFile)} (${buf.length} bytes)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
