import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

// The project's original Railway-generated hostname,
// https://resume-master-production.up.railway.app, is no longer attached to the service — Railway's
// edge answers {"status":"error","code":404,"message":"Application not found"}. The service lives at
// the custom domain instead.
//
// This matters more than a stale link. The Chrome extension declares its origin in
// `host_permissions`, which the Chrome Web Store reviews; shipping a build pointed at a dead host
// means a broken extension AND a re-review to correct it. documentation.md's deploy checklist used
// to instruct exactly that ("Update Chrome extension popup → change URL to Railway URL"), so the
// trap was written down as a step. These tests keep it from coming back.

const CANONICAL = "resumemaster.one";
const DEAD_HOST = "resume-master-production.up.railway.app";

/** Tracked files only — keeps node_modules and build output out of the scan, and stays fast. */
function trackedFiles(extensions) {
  const out = execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return out.split(/\r?\n/).filter(f => f && extensions.some(e => f.endsWith(e)));
}

test("no code or config points at the retired Railway hostname", () => {
  // Deliberately excludes .md: documentation.md names the dead host in a warning explaining that it
  // is dead, which is the opposite of the problem. Code and config have no such excuse.
  const files = trackedFiles([".js", ".jsx", ".mjs", ".cjs", ".json", ".toml", ".html", ".yml", ".yaml"]);
  assert.ok(files.length > 50, `expected a real file list, got ${files.length}`);

  const offenders = files.filter(f => {
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { return false; }
    return text.includes(DEAD_HOST);
  });
  assert.deepEqual(offenders, [],
    `these point at a hostname that returns 404: ${offenders.join(", ")}`);
});

test("the extension targets the canonical domain in every place it declares an origin", () => {
  // Three files, and all three have to agree: two runtime constants plus the manifest, whose
  // host_permissions is the one the Chrome Web Store reviews.
  for (const f of ["extension/background.js", "extension/config.js", "extension/manifest.json"]) {
    const text = fs.readFileSync(f, "utf8");
    assert.ok(text.includes(CANONICAL), `${f} must reference ${CANONICAL}`);
    assert.ok(!text.includes(DEAD_HOST), `${f} must not reference the retired hostname`);
  }

  const manifest = JSON.parse(fs.readFileSync("extension/manifest.json", "utf8"));
  assert.ok(
    (manifest.host_permissions || []).some(p => p.includes(CANONICAL)),
    "host_permissions must grant the canonical domain — this is the field Chrome re-reviews",
  );
});

test("the deploy docs do not tell you to repoint the extension at a Railway hostname", () => {
  // The specific instruction that made this a trap rather than a typo.
  const docs = fs.readFileSync("documentation.md", "utf8");
  assert.ok(!/change URL to Railway URL/i.test(docs),
    "the checklist step that breaks the shipped extension must stay removed");
  assert.match(docs, new RegExp(`${DEAD_HOST.replace(/\./g, "\\.")}[\\s\\S]{0,80}dead`, "i"),
    "the retired hostname should be documented as dead, so nobody reintroduces it");
});
