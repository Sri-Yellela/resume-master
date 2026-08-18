import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

// TASK E3 — the manifest and its written justification must not drift apart.
//
// extension/MANIFEST_RATIONALE.md exists because manifest.json cannot carry comments: the builder,
// the publisher and two test files all JSON.parse it, and a first submission under the 2026-08-01
// Web Store rules is not the place to gamble on Chrome's tolerance for `//`. Splitting the
// justification into a second file buys that safety and creates a new failure mode — the two
// disagreeing — which is what this guards, in BOTH directions:
//
//   a declared permission with no row      → an over-declaration nobody has had to defend, and
//                                            over-declaration is on its own grounds for rejection
//   a row for something no longer declared → a lie that reads as thorough, which is worse than
//                                            no rationale at all
//
// The rationale is also cited verbatim by the store listing's permission justifications, so a
// drift here becomes a contradiction between the manifest, the policy and the dashboard — the
// exact three-way mismatch reviewers cross-check for.

const SRC = "extension";
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
const rationale = fs.readFileSync(path.join(SRC, "MANIFEST_RATIONALE.md"), "utf8");

/** Rows of the "## Permissions" / "## Host permissions" tables, first column only. */
function tableSubjects(heading) {
  // Split on headings rather than matching a lazy span up to `$`: under /m, `$` matches the end of
  // the FIRST line, so the section came back empty and every row silently looked unjustified — a
  // drift guard that passes by finding nothing is worse than no guard at all.
  const section = rationale.split(/^## /m).find(s => s.startsWith(`${heading}\n`));
  assert.ok(section, `MANIFEST_RATIONALE.md has no "## ${heading}" section`);
  return section
    .split("\n")
    .filter(l => l.startsWith("|") && !/^\|\s*-+/.test(l) && !/^\|\s*(Permission|Host)\s*\|/.test(l))
    .map(l => l.split("|")[1].trim().replace(/^`|`$/g, ""))
    .filter(Boolean);
}

test("every declared permission has a row in MANIFEST_RATIONALE.md", () => {
  const justified = tableSubjects("Permissions");
  for (const perm of manifest.permissions) {
    assert.ok(justified.includes(perm),
      `permission "${perm}" is declared but has no row in MANIFEST_RATIONALE.md — ` +
      `if removing it breaks nothing it should not be declared, and if it does, say what`);
  }
});

test("every justified permission is still declared", () => {
  for (const perm of tableSubjects("Permissions")) {
    assert.ok(manifest.permissions.includes(perm),
      `MANIFEST_RATIONALE.md justifies "${perm}", which the manifest no longer declares`);
  }
});

test("every declared host permission has a row in MANIFEST_RATIONALE.md", () => {
  const justified = tableSubjects("Host permissions");
  for (const host of manifest.host_permissions) {
    assert.ok(justified.includes(host),
      `host "${host}" is declared but unjustified in MANIFEST_RATIONALE.md`);
  }
});

test("every justified host permission is still declared", () => {
  for (const host of tableSubjects("Host permissions")) {
    assert.ok(manifest.host_permissions.includes(host),
      `MANIFEST_RATIONALE.md justifies host "${host}", which the manifest no longer declares`);
  }
});

test("the permissions documented as deliberately NOT declared are in fact not declared", () => {
  // The rationale's value is mostly in this list. `cookies` in particular was declared by the
  // retired v0.1.0 builds and nothing ever read one.
  for (const perm of ["cookies", "tabs", "notifications", "<all_urls>", "webNavigation", "history"]) {
    assert.ok(!manifest.permissions.includes(perm),
      `"${perm}" is documented as deliberately not declared, but the manifest declares it`);
    assert.ok(!(manifest.optional_permissions || []).includes(perm),
      `"${perm}" is declared as an optional permission, which the rationale does not cover`);
  }
});

test("no host permission is a bare-domain wildcard, and none is a gated portal", () => {
  // v1.3.0 declared https://*.linkedin.com/* — the whole site for the sake of six job-view paths.
  for (const host of manifest.host_permissions) {
    assert.doesNotMatch(host, /^https:\/\/\*\.(linkedin|indeed|glassdoor|lever|greenhouse|workable)\.[a-z.]+\/\*$/,
      `${host} is a bare-domain wildcard; narrow it to the paths the extractors actually need`);
  }
  // The gated handoff reaches portals through activeTab alone. A host permission for one would
  // silently convert a per-invocation grant into standing access.
  for (const host of manifest.host_permissions) {
    assert.doesNotMatch(host, /workday|myworkdayjobs|amazon\.jobs|metacareers|smartrecruiters|icims|taleo/i,
      `${host} is a gated portal origin — the handoff must depend on activeTab, not a host grant`);
  }
});

test("content script matches never exceed the declared host permissions", () => {
  // A content script matching a host the manifest does not grant is a permission the reviewer sees
  // as unexplained, and an extractor running somewhere the rationale does not cover.
  const hosts = manifest.host_permissions;
  for (const cs of manifest.content_scripts || []) {
    for (const m of cs.matches) {
      assert.ok(hosts.includes(m),
        `content script matches ${m}, which is not a declared host permission`);
    }
  }
});

test("THE EXTENSION DECLARES NO CONTENT SCRIPT", () => {
  // Not a stylistic preference — it is the property that removed six host permissions. A content
  // script needs a host permission for every origin it runs on, so re-adding one would drag the
  // job-board hosts back with it, and would give the extension standing access to pages the user
  // has not invoked it on. Capture injects on demand under activeTab instead.
  assert.ok(!manifest.content_scripts || manifest.content_scripts.length === 0,
    "a content script is declared again — see MANIFEST_RATIONALE.md, Content scripts");
});

test("the injected extractor is self-contained", () => {
  // executeScript serialises the FUNCTION, so anything at module scope is silently absent when it
  // runs in the page: no imports, no shared constants, no helpers defined outside the body. This is
  // invisible at build time and fails only in a real page, which is the worst place to find it.
  const src = fs.readFileSync(path.join(SRC, "extractor.js"), "utf8");

  assert.doesNotMatch(src, /^import\s/m,
    "extractor.js must not import — an injected function cannot carry its imports into the page");

  // Everything above the first export must be comment or blank; a module-scope const would not
  // survive serialisation.
  const beforeFirstExport = src.slice(0, src.indexOf("export function"));
  for (const line of beforeFirstExport.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    assert.fail(`extractor.js has module-scope code that will not reach the page: ${t.slice(0, 60)}`);
  }

  assert.match(src, /export function extractJobPayload\(\)/);
  assert.match(src, /export function showCaptureToast\(/);
});

test("the extractor still knows the named job boards, and still works without them", () => {
  const src = fs.readFileSync(path.join(SRC, "extractor.js"), "utf8");
  for (const board of ["linkedin.com", "indeed.com", "glassdoor.com", "lever.co", "greenhouse.io", "workable.com"]) {
    assert.match(src, new RegExp(`'${board.replace(".", "\\.")}'`),
      `the per-site selector map lost ${board}`);
  }
  // The fallback is what makes an unlisted site — an embedded Greenhouse board on an employer's own
  // domain — capturable at all. Without it the map would be a gate again, just a softer one.
  assert.match(src, /function genericDescription\(\)/,
    "the generic fallback is what makes an unnamed site work; it must not be removed");
});

test("externally_connectable stays absent", () => {
  // Deliberate security property, not an oversight: nothing may message the extension inward. The
  // extension pulls from our own server with the user's session. Also asserted from the handoff's
  // side in extensionGatedHandoff.test.js; duplicated here because this is the file someone edits
  // when they are adding manifest keys.
  assert.ok(!("externally_connectable" in manifest),
    "externally_connectable must stay absent — see MANIFEST_RATIONALE.md, Deliberate absences");
});

test("every manifest path resolves in source", () => {
  const refs = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_page,
    ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap(cs => cs.js || []),
  ].filter(Boolean);

  for (const ref of refs) {
    assert.ok(fs.existsSync(path.join(SRC, ref)), `manifest references ${ref}, which does not exist`);
  }
  for (const size of ["16", "48", "128"]) {
    const icon = manifest.action?.default_icon?.[size];
    assert.ok(icon, `no ${size}px icon declared`);
    assert.ok(fs.existsSync(path.join(SRC, icon)), `icon ${icon} is declared but missing`);
  }
});
