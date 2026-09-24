import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

import {
  BRAND, LEGACY_BRAND,
  CANONICAL_HOST, CANONICAL_ORIGIN,
  LEGACY_HOST, LEGACY_ORIGIN,
  PRIVACY_POLICY_URL,
  EXTENSION_USER_AGENT, MOBILE_USER_AGENT,
  ANDROID_APPLICATION_ID, IOS_BUNDLE_IDENTIFIER,
} from "../shared/brand.js";

/**
 * P2's DELIVERABLE: the guard that makes shared/brand.js the single source in fact, not in intent.
 * ================================================================================================
 *
 * ⛔ THIS GUARD WAS VERIFIED TO FAIL BEFORE IT WAS COMMITTED, by reintroducing a literal into a
 * swept file and watching it name that file. Six guards have shipped inert in this project, and a
 * guard nobody has seen fail is a comment with a runtime cost. If you change the scanning logic
 * below, break it again on purpose and watch it fail before you trust it.
 *
 * WHAT IS FORBIDDEN, AND WHAT DELIBERATELY IS NOT
 *
 * Forbidden: `resumemaster` in any casing (which covers `resumemaster.one`, the stray
 * `resumemaster.app`, `ResumeMaster` and `com.resumemaster.*`) and `Resume Master` in any casing
 * (which covers the `RESUME MASTER` that the stamp logo and the admin schema export used to spell).
 *
 * NOT forbidden, on purpose: `resume-master`, `resume_master` and `RESUME_MASTER`. Those are the
 * IDENTIFIER spellings, and docs/BRAND.md decides they stay — npm package names, the two git repo
 * directories, `data/resume_master.db`, the `RESUME_MASTER_DB` and `RESUME_MASTER_LLM_FORMAT`
 * environment variables, the extension's `RESUME_MASTER_URL`, the `resume-master-extension-v*.zip`
 * artifact name, and the two wire values asserted at the bottom of this file. Renaming those is
 * cost without benefit, and a guard that fired on them would be noise — which is precisely how the
 * six inert guards got that way. Someone suppresses a guard that cries wolf, and then it is gone
 * for the case that mattered.
 */

const FORBIDDEN = [
  { label: "resumemaster",  re: /resumemaster/i },
  { label: '"Resume Master"', re: /resume[  ]master/i },
];

/** This file names every forbidden literal in order to search for it, so it must exclude itself. */
const SELF = "test/brandAndOriginGuard.test.js";

const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf",
  ".woff", ".woff2", ".ttf", ".zip", ".db", ".sqlite", ".webp",
]);

/**
 * ⛔ TRACKED FILES ONLY, AND THAT IS A TRAP WORTH NAMING. `git ls-files` does not return a file
 * that has never been staged, so a brand-new offender is invisible to this scan until it is added
 * — and so is this test, and so is shared/brand.js. test/productionOriginConsistency.test.js
 * learnt this the hard way: it passed while untracked and went red the moment it was committed.
 * Both new files in this change were `git add -N`'d before the guard was run for the first time.
 */
function trackedTextFiles() {
  const out = execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split(/\r?\n/).filter((f) => {
    if (!f) return false;
    const dot = f.lastIndexOf(".");
    if (dot > 0 && SKIP_EXT.has(f.slice(dot).toLowerCase())) return false;
    return fs.existsSync(f);
  });
}

function offenders() {
  const hits = [];
  for (const f of trackedTextFiles()) {
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    if (text.includes("\u0000")) continue;               // a binary we did not list
    const matched = FORBIDDEN.filter(p => p.re.test(text)).map(p => p.label);
    if (matched.length) hits.push({ file: f.replace(/\\/g, "/"), matched });
  }
  return hits;
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE ALLOWLIST — every entry carries the reason it is here and the event that removes it.
// ════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Directory prefixes. Each is asserted to be NON-EMPTY below, so a prefix whose files have all
 * been cleaned fails and has to be deleted from this list rather than lingering as dead
 * permission. That is the whole anti-rot mechanism: the allowlist cannot outlive its reason.
 */
const ALLOWED_PREFIXES = [
  {
    prefix: ".cinematic/",
    reason:
      "Archived session prompts and before/after logs. Historical record of what was asked at the " +
      "time; rewriting them would falsify the archive. Never cleaned.",
  },
  {
    prefix: "docs/",
    reason:
      "P5 owns the documentation reset, and it runs LAST so that it documents the end state. " +
      "docs/BRAND.md and docs/MIGRATION_AND_REBRAND.md must name the old values to be about them " +
      "at all, and docs/CORRECTIONS_REGISTER.md + docs/FINDINGS_ARCHIVE.md are institutional " +
      "memory that docs/BRAND.md explicitly exempts. Removed when P5 lands.",
  },
];

/**
 * extension/ is a PINNED SET rather than a prefix.
 *
 * The directory is frozen for P4 — the package is under Chrome Web Store review, and editing it
 * now either resets the queue position or ships a package that contradicts the listing a reviewer
 * is reading. But "frozen" has to be enforced, not trusted: a blanket `extension/` prefix would
 * let a NEW file carrying the old brand slip in unnoticed, and P4 could then clean eleven files,
 * miss the twelfth, and still be green. Pinning the exact set means any addition OR removal fails
 * here and has to be acknowledged.
 *
 * ⛔ WHEN P4 LANDS: this list empties. Delete it and the block that uses it.
 */
const FROZEN_EXTENSION_FILES = [
  "extension/MANIFEST_RATIONALE.md",
  "extension/README.md",
  "extension/background.js",
  "extension/config.js",
  "extension/gated-handoff.js",
  "extension/manifest.json",
  "extension/options.html",
  "extension/options.js",
  "extension/popup.html",
  "extension/review-overlay.js",
  "extension/submission/PRIVACY_RECONCILIATION.md",
  "extension/submission/STORE_LISTING.md",
];

/** Individual files, each with its own reason. */
const ALLOWED_FILES = {
  "shared/brand.js":
    "THE SINGLE SOURCE. It has to hold the legacy values in order to be the place they are held.",
  [SELF]:
    "This guard. It names the forbidden literals in order to search for them.",
  "documentation.md":
    "The repository's long-form history and deploy log, written in the past tense about a service " +
    "that WAS at the old address. P5 ran on 2026-09-24 and deliberately did NOT touch it — the " +
    "reset produced README/HANDOFF/ARCHITECTURE as new documents and left doc retirement to its " +
    "own pass. Removed when that pass classifies this file.",
  "deploy_guide.md":
    "Same: a historical deploy record, left in place by P5 for the same reason. Removed when the " +
    "doc-retirement pass classifies it.",

  // ── Written BY P5, and they name the old origin because the system still serves it ──────────
  // Not history: both describe live, current behaviour that a reader has to know about. Removing
  // the literal would make them wrong, and deriving it from LEGACY_ORIGIN inside prose would be
  // unreadable. Both go when P4 lands — at which point the statements themselves stop being true.
  "HANDOFF.md":
    "States that the published extension still talks to the old origin, and that funding/Web Store " +
    "work is the owner's. Removed at P4, when the extension update goes live and the old origin " +
    "can be retired.",
  "ARCHITECTURE.md":
    "§1, §7 and §10 document that BOTH origins serve one app, that the session cookie is host-only " +
    "so a Google sign-in started on the old origin lands its cookie on the new one, and that there " +
    "must be NO 301 on the old origin while the reviewed extension points at it. Every one of " +
    "those is a fact about the old host and cannot be written without naming it. Removed at P4.",
};

// ════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE GUARD
// ════════════════════════════════════════════════════════════════════════════════════════════

test("no user-visible legacy brand or origin survives outside the single source", () => {
  const hits = offenders();

  // Sanity: if the scan silently stopped finding anything it would pass vacuously forever.
  assert.ok(trackedTextFiles().length > 50,
    "expected a real tracked-file list — the scan found almost nothing, which means it is broken");
  assert.ok(hits.length > 0,
    "expected at least the allowlisted files to match; a zero-hit scan is a broken scan, not a " +
    "clean tree");

  const allowed = (f) =>
    f in ALLOWED_FILES ||
    FROZEN_EXTENSION_FILES.includes(f) ||
    ALLOWED_PREFIXES.some(p => f.startsWith(p.prefix));

  const unexplained = hits.filter(h => !allowed(h.file));
  assert.deepEqual(unexplained.map(h => `${h.file} [${h.matched.join(", ")}]`), [],
    "these carry a legacy brand or origin literal and are not on the allowlist. Derive the value " +
    "from shared/brand.js, or add the file with a stated reason and the event that removes it");
});

test("the allowlist prunes itself — no entry outlives the reason it was added for", () => {
  // The failure mode this exists for: a file gets cleaned, its allowlist entry stays, and years
  // later the entry is silently protecting a REGRESSION in that same file.
  const hitFiles = new Set(offenders().map(h => h.file));

  for (const f of Object.keys(ALLOWED_FILES)) {
    assert.ok(hitFiles.has(f),
      `${f} is allowlisted but no longer contains a legacy literal — remove its ALLOWED_FILES ` +
      `entry, or it will silently permit a regression here`);
  }

  for (const { prefix, reason } of ALLOWED_PREFIXES) {
    assert.ok([...hitFiles].some(f => f.startsWith(prefix)),
      `the "${prefix}" prefix is allowlisted (${reason}) but nothing under it matches any more — ` +
      `delete the entry`);
  }
});

test("extension/ is frozen for P4, and the frozen set is exactly what was pinned", () => {
  const actual = offenders().map(h => h.file).filter(f => f.startsWith("extension/")).sort();
  assert.deepEqual(actual, [...FROZEN_EXTENSION_FILES].sort(),
    "the set of extension/ files carrying the legacy brand changed. If P4 is under way, update " +
    "FROZEN_EXTENSION_FILES in the same commit; if it is not, something edited a package that is " +
    "supposed to be under review");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE PLACES THAT CANNOT IMPORT THE CONSTANT, so the guard asserts the agreement instead
// ════════════════════════════════════════════════════════════════════════════════════════════

test("client/index.html's <title> is the brand — it is static HTML and cannot import", () => {
  // The one legitimate hardcoded copy of the name. It is in the SPA shell, outside the module
  // graph, so there is nothing to import from. This assertion is what keeps it single-sourced.
  const html = fs.readFileSync("client/index.html", "utf8");
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
  assert.equal(title, BRAND,
    "client/index.html's <title> must equal BRAND — it is the first thing a browser tab shows");
});

test("the two wire values in server.js are the ones shared/brand.js records", () => {
  // ⛔ NOT a brand string. These are written into auth_contexts.user_agent and matched by the
  // revoke statements; renaming either orphans live rows so revoke stops revoking. They are
  // hardcoded in server.js on purpose — test/authCredentialLifecycle.test.js asserts them as
  // SOURCE STRINGS inside the route block, and hiding them behind an import would weaken that
  // guard. So the constant does not replace the literal; this asserts the two agree.
  const server = fs.readFileSync("server.js", "utf8");

  for (const [name, value] of [["extension", EXTENSION_USER_AGENT], ["mobile", MOBILE_USER_AGENT]]) {
    assert.ok(server.includes(`userAgent: "${value}"`),
      `server.js must issue the ${name} credential with userAgent "${value}"`);
    assert.ok(server.includes(`user_agent='${value}'`),
      `server.js's ${name} revoke must key on user_agent='${value}' — an issue/revoke mismatch ` +
      `is a revoke that silently does nothing`);
  }

  assert.notEqual(EXTENSION_USER_AGENT, MOBILE_USER_AGENT,
    "the extension and mobile credentials are independently revocable ONLY while these differ");
});

test("the published mobile contract serves the canonical origin", () => {
  // contract/ is vendored into two repositories that are not in this tree, so a stale origin here
  // ships to both of them and nothing in either would notice.
  const contract = JSON.parse(fs.readFileSync("contract/mobile-api.v1.json", "utf8"));
  assert.equal(contract.servers?.[0]?.url, CANONICAL_ORIGIN,
    "contract/mobile-api.v1.json's production server must be the canonical origin — regenerate " +
    "with `node scripts/generateMobileContract.mjs` and re-vendor both mobile repos");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE SINGLE SOURCE'S OWN INVARIANTS
// ════════════════════════════════════════════════════════════════════════════════════════════

test("the canonical origin is the BARE APEX — no www, no trailing slash", () => {
  // ⛔ host_permissions is a MATCH PATTERN. `https://jobsviadraft.com/*` does NOT match a www
  // host, so the moment any code path emits www, the extension's credentialed fetch is blocked and
  // fails silently. docs/BRAND.md asks for this to be asserted during the sweep rather than
  // assumed, and www.jobsviadraft.com cannot even be activated yet — the Railway plan allows two
  // custom domains and both slots are in use until the old one is retired.
  assert.ok(!CANONICAL_HOST.startsWith("www."), "the canonical host must be the bare apex");
  assert.equal(CANONICAL_ORIGIN, `https://${CANONICAL_HOST}`);
  assert.ok(!CANONICAL_ORIGIN.endsWith("/"), "origins must not carry a trailing slash");
  assert.ok(!LEGACY_HOST.startsWith("www."));
  assert.equal(LEGACY_ORIGIN, `https://${LEGACY_HOST}`);
  assert.equal(PRIVACY_POLICY_URL, `${CANONICAL_ORIGIN}/privacy`);
});

test("the new brand and the old one are actually different, and neither is empty", () => {
  // Guards against the silliest possible regression: someone "fixes" a failure by setting
  // BRAND = LEGACY_BRAND, which makes every assertion above pass and undoes the rebrand.
  for (const [name, v] of Object.entries({ BRAND, LEGACY_BRAND, CANONICAL_HOST, LEGACY_HOST })) {
    assert.ok(typeof v === "string" && v.length > 0, `${name} must be a non-empty string`);
  }
  assert.notEqual(BRAND, LEGACY_BRAND);
  assert.notEqual(CANONICAL_HOST, LEGACY_HOST);
  assert.ok(!FORBIDDEN.some(p => p.re.test(BRAND)),
    "BRAND itself must not contain a forbidden literal");
  assert.ok(!FORBIDDEN.some(p => p.re.test(CANONICAL_ORIGIN)),
    "CANONICAL_ORIGIN itself must not contain a forbidden literal");
});

test("the store identifiers are allowlisted BY VALUE, not by blanket suppression", () => {
  // docs/BRAND.md: the guard must treat the bundle identifier as an allowed exception "whatever
  // value it holds at the time" — otherwise a lingering com.resumemaster.android fails a test
  // asserting no "resumemaster" survives, and someone suppresses the guard to make the build pass.
  //
  // Recording them here as values means the exception is visible and checkable rather than being
  // a hole in the scan. ⚠ AVAILABILITY WAS NOT VERIFIED and cannot be from this repository — see
  // the note in shared/brand.js. Both are immutable after first publish; neither app is published.
  assert.match(ANDROID_APPLICATION_ID, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
    "an Android applicationId must be a valid lowercase reverse-DNS identifier");
  assert.match(IOS_BUNDLE_IDENTIFIER, /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/,
    "an iOS bundle identifier must be reverse-DNS and may not contain underscores");
  assert.notEqual(ANDROID_APPLICATION_ID, IOS_BUNDLE_IDENTIFIER);
});
