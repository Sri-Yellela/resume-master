import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { CANONICAL_HOST, CANONICAL_ORIGIN, LEGACY_HOST } from "../shared/brand.js";

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

// ⛔ TWO HOSTS, AND THEY ARE NOT INTERCHANGEABLE WHILE THE MIGRATION IS IN FLIGHT.
//
// CANONICAL_HOST is where the app lives. LEGACY_HOST is where the PUBLISHED v1.0.0 extension
// still points, and will until the P4 update clears review and replaces every install. This test
// used to have one constant called CANONICAL, hardcoded to the legacy host, and asserted the
// extension referenced it — which meant that the moment the app moved, the test either failed for
// a correct state or, if someone "fixed" it by repointing the constant, started demanding that the
// frozen extension be edited mid-review. Both constants come from shared/brand.js, so the
// extension is asserted against the value it actually holds and P4 WAS the one-line change below.
const DEAD_HOST = "resume-master-production.up.railway.app";

/** Tracked files only — keeps node_modules and build output out of the scan, and stays fast. */
function trackedFiles(extensions) {
  const out = execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return out.split(/\r?\n/).filter(f => f && extensions.some(e => f.endsWith(e)));
}

// This file has to contain the dead hostname in order to search for it, so it must exclude
// itself. (The live hosts are imported, not written out, so only DEAD_HOST forces this.)
// It did not at first, and passed anyway — because it was still UNTRACKED when I ran it, so
// `git ls-files` never returned it. Committing it turned a green test red, which is the useful
// lesson: a guard whose result depends on whether it happens to be staged yet is not a guard.
const SELF = "test/productionOriginConsistency.test.js";

test("no code or config points at the retired Railway hostname", () => {
  // Also excludes .md: documentation.md names the dead host in a warning explaining that it IS
  // dead, which is the opposite of the problem. Code and config have no such excuse.
  const files = trackedFiles([".js", ".jsx", ".mjs", ".cjs", ".json", ".toml", ".html", ".yml", ".yaml"])
    .filter(f => f !== SELF);
  assert.ok(files.length > 50, `expected a real file list, got ${files.length}`);
  assert.ok(!files.includes(SELF), "this file must exclude itself or it reports its own constant");

  const offenders = files.filter(f => {
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { return false; }
    return text.includes(DEAD_HOST);
  });
  assert.deepEqual(offenders, [],
    `these point at a hostname that returns 404: ${offenders.join(", ")}`);
});

test("the extension targets ONE live domain in every place it declares an origin", () => {
  // Three files, and all three have to agree: two runtime constants plus the manifest, whose
  // host_permissions is the one the Chrome Web Store reviews.
  //
  // ⛔ FLIPPED AT P4 (2026-09-26), and the direction matters. Until P4 this read LEGACY_HOST,
  // because extension/ was frozen under review and repointing it would have shipped a manifest
  // contradicting the listing a reviewer was reading. The P4 package declares CANONICAL_HOST, so
  // the legacy host is now the FORBIDDEN one — a file that still names it is a half-migrated
  // build, which is the case OTHER below catches.
  const EXPECTED = CANONICAL_HOST;
  const OTHER    = EXPECTED === LEGACY_HOST ? CANONICAL_HOST : LEGACY_HOST;

  for (const f of ["extension/background.js", "extension/config.js", "extension/manifest.json"]) {
    const text = fs.readFileSync(f, "utf8");
    assert.ok(text.includes(EXPECTED), `${f} must reference ${EXPECTED}`);
    assert.ok(!text.includes(DEAD_HOST), `${f} must not reference the retired hostname`);
    // A HALF-MIGRATED EXTENSION IS WORSE THAN AN UNMIGRATED ONE: host_permissions is a match
    // pattern, so a build that fetches one host while declaring the other fails CORS silently in
    // production and passes every local test. Mixing the two is the failure this catches.
    assert.ok(!text.includes(OTHER),
      `${f} references ${OTHER} as well as ${EXPECTED} — the extension must name exactly one live ` +
      `origin, and all three files must name the same one`);
  }

  const manifest = JSON.parse(fs.readFileSync("extension/manifest.json", "utf8"));
  assert.ok(
    (manifest.host_permissions || []).some(p => p.includes(EXPECTED)),
    "host_permissions must grant the live domain — this is the field Chrome re-reviews",
  );
});

test("the two copies of the extension's URL constant are byte-identical", () => {
  // extension/config.js and extension/background.js hold DUPLICATE copies of the base URL BY
  // DESIGN — a service worker cannot share plain-script globals — and both files say so. The
  // duplication is fine; the DRIFT is not, and they have drifted before. A build whose popup
  // talks to one origin and whose service worker talks to another fails only in production.
  //
  // Compared as exact text rather than by parsing a URL out of each, because the dev switch is
  // the thing that actually drifts: someone uncomments line B in one file and ships it.
  const declFor = (text) => {
    // DECLARATION lines only. Matching every mention picks up the dozen `${RESUME_MASTER_URL}/api/…`
    // template uses in each file, which are not the thing that drifts.
    const m = text.match(/^(?:\/\/ )?const RESUME_MASTER_URL = .*$/gm);
    assert.ok(m && m.length === 2,
      `expected exactly two RESUME_MASTER_URL declarations (production + commented dev switch), got ${m ? m.length : 0}`);
    return m;
  };

  const config     = declFor(fs.readFileSync("extension/config.js", "utf8"));
  const background = declFor(fs.readFileSync("extension/background.js", "utf8"));
  assert.deepEqual(config, background,
    "extension/config.js and extension/background.js declare different base URLs — the pair is " +
    "duplicated on purpose but must never disagree");

  // And the LIVE one must be the production origin, not the commented-out dev switch. Compared by
  // prefix because the line carries a trailing `// A: production` marker.
  assert.ok(config[0].startsWith(`const RESUME_MASTER_URL = '${CANONICAL_ORIGIN}';`),
    `the uncommented constant must be the production origin, not localhost — got: ${config[0]}`);
});

test("the deploy docs do not tell you to repoint the extension at a Railway hostname", () => {
  // The specific instruction that made this a trap rather than a typo.
  const docs = fs.readFileSync("documentation.md", "utf8");
  assert.ok(!/change URL to Railway URL/i.test(docs),
    "the checklist step that breaks the shipped extension must stay removed");
  assert.match(docs, new RegExp(`${DEAD_HOST.replace(/\./g, "\\.")}[\\s\\S]{0,80}dead`, "i"),
    "the retired hostname should be documented as dead, so nobody reintroduces it");
});
