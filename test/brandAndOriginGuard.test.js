import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

import {
  BRAND, WORDMARK, LEGACY_BRAND,
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
 * ⛔ THE SECOND PRODUCT WILL NEED A CARVE-OUT, AND IT CANNOT BE PRE-ADDED. The owner decided on
 * 2026-09-25 (docs/PRODUCT_MODEL.md) that Resume Master is a SEPARATE product keeping
 * resumemaster.one. Its own source files will legitimately spell its name, and this guard forbids
 * exactly that spelling. The reconciliation is written down in docs/BRAND.md § "Resume Master is a
 * SECOND PRODUCT" and comes to: add a PREFIX entry for that product's directory, in the same commit
 * as the first file that needs it, with a stated reason.
 *
 * It cannot be prepared in advance, because the self-pruning test below fails any allowlist entry
 * whose files do not currently match. That is the mechanism working. ⛔ Do NOT instead widen
 * FORBIDDEN to stop matching the name — that disarms the guard for THIS product's files, which is
 * the only thing it protects. Scope the permission to the directory.
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
 * extension/ WAS a pinned set of twelve files, and it is now empty. P4 landed 2026-09-26.
 *
 * The pinned list existed because the directory was frozen under Chrome Web Store review, and
 * "frozen" had to be enforced rather than trusted: a blanket `extension/` prefix would have let a
 * NEW file carrying the old brand slip in unnoticed, and P4 could then have cleaned eleven files,
 * missed the twelfth, and still gone green.
 *
 * It is kept as an empty array rather than deleted outright, because the assertion below is the
 * one that now does the work: with the list empty, ANY extension/ file carrying a legacy literal
 * fails. That is stricter than deleting both, which would leave extension/ unscanned-for-intent
 * and looking deliberate.
 *
 * ⛔ DO NOT re-add a file here to make a failure go away. A legacy literal under extension/ after
 * P4 means a half-migrated package — the manifest declaring one origin while a script fetches the
 * other is a CORS failure that is invisible locally and silent in production.
 */
const FROZEN_EXTENSION_FILES = [];

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

  // ── Written BY P4, and it names the old brand and origin because it is ABOUT the change ─────
  "extension/submission/STORE_LISTING.md":
    "The 'what changed since v1.0.0' block a Web Store reviewer reads. It has to say " +
    "'\"Resume Master\" → draft' and name the host permission's old value, because a rename plus a " +
    "host-permission change is exactly what triggers an in-depth review and the reviewer is " +
    "comparing the two packages. Stating the delta without naming the old side is not possible. " +
    "Removed when v1.1.0 is LIVE and the next release's listing describes a different delta.",

  // ── Written BY P5, and they name the old origin because the system still serves it ──────────
  // Not history: both describe live, current behaviour that a reader has to know about. Removing
  // the literal would make them wrong, and deriving it from LEGACY_ORIGIN inside prose would be
  // unreadable.
  //
  // ⚠ BOTH ENTRIES SAID "Removed at P4". P4 landed on 2026-09-26 and neither became removable,
  // which is worth recording rather than quietly re-dating: the removal event was predicated on
  // the old origin being RETIRED after the extension update, and that is no longer the plan. The
  // events below are the real ones.
  // HANDOFF.md's entry is GONE, pruned by the test below on the same day it stopped being needed.
  // P4 rewrote its Web Store bullet — the old text said the extension "still points at" the old
  // origin, which stopped being true of the package — and the replacement does not need the
  // literal at all. Recorded here rather than silently deleted because the self-pruning assertion
  // is the thing that caught it, which is the first time it has fired for real.
  "ARCHITECTURE.md":
    "§1, §7 and §10 document that BOTH origins serve one app, that the session cookie is host-only " +
    "so a Google sign-in started on the old origin lands its cookie on the new one, and that there " +
    "must be NO 301 on the old origin. Every one of those is a fact about the old host and cannot " +
    "be written without naming it. ⛔ The no-301 rule is now PERMANENT, not a migration-window " +
    "constraint, so this entry has no removal event — it goes only if the old origin stops serving.",
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

test("extension/ carries no legacy brand or origin — P4 cleaned it and it stays clean", () => {
  // Files with their own ALLOWED_FILES entry are excluded here, not exempted twice: STORE_LISTING.md
  // lives under extension/ and legitimately names the old brand, because its job is to tell a
  // reviewer what changed. Its reason and removal event are stated there, and the self-pruning test
  // above still holds it to them — so it cannot become a silent hole in this scan.
  const actual = offenders().map(h => h.file)
    .filter(f => f.startsWith("extension/") && !(f in ALLOWED_FILES)).sort();
  assert.deepEqual(actual, [...FROZEN_EXTENSION_FILES].sort(),
    "an extension/ file carries a legacy brand or origin literal. P4 moved the package to the " +
    "canonical origin on 2026-09-26, so this is either an un-swept file or a half-migrated build " +
    "— and a package that declares one origin while a script fetches the other fails CORS in " +
    "production while passing every local test");
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

test("WORDMARK and BRAND are the SAME NAME in two cases, and nothing else", () => {
  // The lowercase mark was decided 2026-09-26. The risk it introduces is not styling — it is that
  // a second constant holding a name drifts into a second NAME, which is the exact failure
  // docs/BRAND.md was written to prevent ("deciding per-file is how two names ship"). So the
  // relationship is asserted rather than trusted: same letters, different case, and the mark is
  // the lowercase one.
  assert.equal(WORDMARK, BRAND.toLowerCase(),
    "WORDMARK must be BRAND lowercased — if the mark needs to be a different WORD, that is a brand " +
    "decision for docs/BRAND.md, not a constant quietly diverging");
  assert.notEqual(WORDMARK, BRAND, "the whole point is that the mark is cased differently");
  assert.ok(!FORBIDDEN.some(p => p.re.test(WORDMARK)),
    "WORDMARK itself must not contain a forbidden literal");
});

test("the extension's user-visible name is the WORDMARK, and its prose is the BRAND", () => {
  // P4's specific trap: the manifest `name` is what Chrome shows in the toolbar, the store title
  // and chrome://extensions/shortcuts, and extension/options.js tells the user to look for that
  // exact string in that list. If the two disagree, the instruction sends them looking for
  // something that is not there.
  const manifest = JSON.parse(fs.readFileSync("extension/manifest.json", "utf8"));
  assert.equal(manifest.name, WORDMARK,
    "the manifest name is a wordmark surface — it is the label Chrome renders, not a sentence");

  const options = fs.readFileSync("extension/options.js", "utf8");
  assert.ok(options.includes(`Find "${WORDMARK}" in the list`),
    "options.js tells the user which name to look for in Chrome's shortcuts list; it must be the " +
    "manifest name, character for character");

  // And the prose direction: a sentence that names the product uses BRAND, not the mark.
  const gated = fs.readFileSync("extension/gated-handoff.js", "utf8");
  assert.ok(gated.includes(`Sign in to ${BRAND} first.`),
    "user-facing sentences use BRAND — a lowercase name mid-sentence reads as a typo");
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
