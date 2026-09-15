import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { LOGO_HOST } from "../shared/companyLogos.js";
import { at } from "../test-support/sourceAnchors.js";

// TASK E4 — the manifest, the privacy policy and the store listing must not contradict each other.
//
// The 2026-08-01 Web Store rules are enforced by cross-checking three documents: the manifest, the
// hosted privacy policy, and the dashboard's Privacy practices tab. A contradiction between any two
// is the rejection, and all three drift independently — the manifest changes when a feature lands,
// the policy changes when someone remembers, and the dashboard changes once a release.
//
// Three orphan directions, all rejections:
//   a permission with no code        → over-declaration
//   code with no policy paragraph    → undisclosed practice
//   a policy claim with no code      → false disclosure
//
// This guards the two that are machine-checkable: that the reconciliation table covers exactly the
// permissions the manifest declares, and that the policy's specific claims still match the code.
// The third — that a paragraph is honest prose — is what the table in PRIVACY_RECONCILIATION.md is
// for, and a human has to read it.

const manifest  = JSON.parse(fs.readFileSync("extension/manifest.json", "utf8"));
const recon     = fs.readFileSync("extension/submission/PRIVACY_RECONCILIATION.md", "utf8");
const listing   = fs.readFileSync("extension/submission/STORE_LISTING.md", "utf8");
const policy    = fs.readFileSync("client/src/pages/marketing/PrivacyPage.jsx", "utf8");

/**
 * The policy is JSX. Reduce it to the prose a reader actually sees.
 *
 * ⛔ SOURCE COMMENTS FIRST, AND THIS ORDER MATTERS. Stripping only tags left the file's own
 * comments in the "prose" — 1,099 characters of them — so any assertion here could be satisfied by
 * a code comment explaining the thing instead of by text a user can read. Found by deleting a
 * user-facing sentence and watching the matching assertion still pass, because the comment above
 * EFFECTIVE_DATE happened to describe the same change.
 */
const policyText = policy
  .replace(/\/\*[\s\S]*?\*\//g, " ")   // block comments
  .replace(/^\s*\/\/[^\n]*$/gm, " ")   // line comments
  .replace(/<[^>]+>/g, " ")        // tags
  .replace(/\{"\s*"\}/g, " ")      // {" "} spacers
  .replace(/\s+/g, " ");

test("the reconciliation table covers every declared permission, and no others", () => {
  for (const perm of manifest.permissions) {
    assert.match(recon, new RegExp("\\|\\s*`" + perm + "`\\s*\\|"),
      `PRIVACY_RECONCILIATION.md has no row for the declared permission "${perm}"`);
  }
  // The other direction: a row for something that is no longer declared reads as thorough and is a
  // false statement to a reviewer who checks it.
  const rows = [...recon.matchAll(/^\|\s*`([a-zA-Z]+)`\s*\|/gm)].map(m => m[1]);
  for (const row of rows) {
    assert.ok(manifest.permissions.includes(row),
      `PRIVACY_RECONCILIATION.md documents "${row}", which the manifest does not declare`);
  }
});

test("every declared host permission appears in the reconciliation table", () => {
  for (const host of manifest.host_permissions) {
    assert.ok(recon.includes(host), `no reconciliation row for host ${host}`);
  }
});

test("EVERY SYMBOL THE RECONCILIATION CITES ACTUALLY EXISTS", () => {
  // The table used to cite file:line. Those line numbers were wrong twice in a day — once when
  // capture moved into the service worker, again when it moved to injection — and nothing caught
  // either, because a stale line number still looks precise. Citing symbols only helps if the
  // symbols are real, so this checks them.
  //
  // Parses "`file.js` `symbol()`" pairs: a backticked filename, then the backticked identifiers
  // attributed to it up to the next filename.
  const cited = [];
  let current = null;
  for (const m of recon.matchAll(/`([A-Za-z0-9_.\-/]+\.(?:js|jsx))`|`([A-Za-z_$][\w$]*)\(\)`/g)) {
    if (m[1]) current = m[1];
    else if (current && m[2]) cited.push([current, m[2]]);
  }
  assert.ok(cited.length >= 8, `expected the table to cite real symbols, found ${cited.length}`);

  const roots = ["extension", "client/src/pages/marketing", "scripts", "routes", "services", "."];
  const seen = new Set();
  for (const [file, symbol] of cited) {
    const key = `${file}::${symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const found = roots.map(r => `${r}/${file}`).find(p => fs.existsSync(p));
    assert.ok(found, `PRIVACY_RECONCILIATION.md cites ${file}, which does not exist`);
    const src = fs.readFileSync(found, "utf8");
    assert.ok(src.includes(symbol),
      `PRIVACY_RECONCILIATION.md attributes "${symbol}()" to ${file}, which does not contain it — ` +
      `the citation rotted, which is exactly what replacing line numbers with symbols was meant to stop`);
  }
});

test("the policy's account of WHAT the extension can read matches the manifest", () => {
  // The old rule was "every declared job board must be named in the policy". There are no declared
  // job boards now, so that rule passes vacuously and would keep passing if a host crept back in.
  // The real invariant is the other way round: the policy claims access is per-invocation, and that
  // claim is only true while no site is declared.
  const jobHosts = manifest.host_permissions.filter(h => !h.includes("resumemaster.one"));
  assert.deepEqual(jobHosts, [],
    `the policy says the extension holds no standing permission for any site, but the manifest ` +
    `declares ${jobHosts.join(", ")} — narrow the code or widen the claim, and prefer the first`);

  assert.match(policyText, /reads nothing until you invoke it/i,
    "the policy must state the per-invocation rule it now depends on");
  assert.match(policyText, /only that one tab|only the one tab/i,
    "and that access is limited to the invoked tab");
});

test("THE POLICY DOES NOT CLAIM A CAPABILITY THAT WAS REMOVED", () => {
  // The saved-jobs scraper was removed as a POLICY COMMITMENT, not as cleanup. The policy went on
  // saying the extension reads "your saved jobs list" for three releases after the code that did it
  // was deleted — a disclosed practice the extension does not perform, which is a false disclosure
  // in the one direction people forget to check.
  assert.doesNotMatch(policyText, /other than job listings and your saved jobs list/i,
    "the policy still claims the extension reads your saved-jobs list; that capability was removed");
  assert.match(policyText, /does\s*not\s*collect lists of jobs/i,
    "the policy should state plainly that no job lists are collected");
});

test("the policy discloses the ATS Score Tool's page-text transmission", () => {
  // popup.js collects the page's visible text and background.js puts it in a URL. It is the second
  // path by which page content leaves the browser, and it was undisclosed.
  const popup = fs.readFileSync("extension/popup.js", "utf8");
  const background = fs.readFileSync("extension/background.js", "utf8");
  const collects = /innerText/.test(popup) && /OPEN_ATS_SCORE/.test(background);
  if (!collects) return; // the feature is gone; nothing to disclose
  assert.match(policyText, /ATS Score Tool/,
    "popup.js collects page text for the ATS Score Tool, but the policy never mentions it");
  assert.match(policyText, /server logs/i,
    "the ATS text travels in a URL and can land in server logs; the policy should say so");

  // The in-page trigger is GONE. It was a button the content script appended to job pages; with the
  // content script retired there is no code that can modify a page on load, so a policy still
  // describing that button would be disclosing a practice that no longer happens — the same false
  // disclosure the saved-jobs claim was, caught the same way.
  const extractor = fs.readFileSync("extension/extractor.js", "utf8");
  assert.ok(!fs.existsSync("extension/linkedin-content.js"),
    "the content script is gone; nothing can add a button to a page any more");
  assert.doesNotMatch(extractor, /rm-send-btn/,
    "the injected extractor must not reintroduce an in-page button");
  assert.match(policyText, /no longer changes the appearance of any page/i,
    "the policy should state that the in-page button was removed");
});

test("the policy describes ONE capture path, not two", () => {
  // Before E2 the popup wrote to a different table than the hotkey. The policy described "save jobs,
  // or import jobs" — two verbs for what is now one action, which reads as two features to a
  // reviewer applying the single-purpose rule.
  assert.match(policyText, /one\s*<?\/?\w*>?\s*capture action|has\s*one\s*capture/i,
    "the policy should state that there is a single capture action with two triggers");
  const bg = fs.readFileSync("extension/background.js", "utf8");
  assert.equal((bg.match(/async function captureActiveTab/g) || []).length, 1,
    "a second capture implementation is back; the policy's one-path claim is no longer true");
});

test("the policy discloses what the extension keeps in browser storage", () => {
  assert.ok(manifest.permissions.includes("storage"), "storage is declared");
  assert.match(policyText, /What the Extension Stores in Your Browser/,
    "the storage permission is declared but the policy has no section on what is stored");
  for (const claim of [/shortcut/i, /ten minutes/i, /uninstall/i]) {
    assert.match(policyText, claim, `the storage disclosure is missing ${claim}`);
  }
});

test("THE POLICY'S COUNT OF STORED ITEMS MATCHES THE NUMBER OF KEYS THE CODE WRITES", () => {
  // The policy said "two things" for as long as the extension had been writing four. The two
  // undisclosed ones — lastGatedHandoff and batch:{tabId} — are session-only and never leave the
  // browser, so the substance was fine and the documentation was not; "two things" is a claim a
  // reviewer falsifies by opening the extension's storage. Counting the write sites is what ties
  // the sentence to the code, so the next key added fails this instead of quietly making the
  // policy wrong again.
  const sources = ["background.js", "gated-handoff.js", "popup.js", "options.js", "extractor.js",
                   "review-overlay.js"]
    .filter(f => fs.existsSync(`extension/${f}`))
    .map(f => fs.readFileSync(`extension/${f}`, "utf8"));
  const writes = sources.join("\n").match(/chrome\.storage\.(?:local|session)\.set\(/g) || [];
  assert.equal(writes.length, 4,
    `the extension writes ${writes.length} storage keys; the policy enumerates four. Update ` +
    `"What the Extension Stores in Your Browser", PRIVACY_RECONCILIATION.md's storage row and ` +
    `STORE_LISTING.md's storage justification together — the dashboard field is pasted from the last one`);
  assert.match(policyText, /keeps four things/,
    "the policy must state the same count the code writes");

  // Each of the four, named in prose a user can match to what they would see.
  for (const [key, re] of [
    ["lastCapture",      /result of your most recent capture/i],
    ["gate:{tabId}",     /prepared answers for an application in progress/i],
    ["lastGatedHandoff", /result of your most recent form fill/i],
    ["batch:{tabId}",    /part-way through applying/i],
  ]) {
    assert.match(policyText, re, `the policy does not describe the ${key} key`);
  }

  // sweepExpiredPackets() filters on 'gate:', so only ONE of the four gets the ten-minute expiry.
  // Promising it for all four would replace one false claim with another.
  const handoff = fs.readFileSync("extension/gated-handoff.js", "utf8");
  assert.match(handoff, /startsWith\(['"]gate:['"]\)/,
    "the sweep no longer scopes to gate: — if it now covers every session key, the policy's " +
    "'the ten-minute expiry does not apply' caveats are stale and should be removed");
  assert.match(policyText, /ten-minute expiry above does not apply/i,
    "the policy must say which keys the ten-minute expiry does NOT cover");

  // The dashboard field is pasted from STORE_LISTING.md, so it drifts silently unless pinned here.
  assert.match(listing, /Four values/,
    "STORE_LISTING.md's storage justification still describes a different number of values than " +
    "the policy — the owner would paste a contradiction into the Privacy practices tab");
});

test("the policy carries an effective date and a proactive-change commitment", () => {
  // Required by the 2026-08-01 rules: not just "we may update this", but notice before a material
  // change to data handling takes effect.
  assert.match(policy, /const EFFECTIVE_DATE = '[A-Z][a-z]+ \d{1,2}, \d{4}'/,
    "the policy needs an explicit effective date");
  assert.match(policyText, /before that change takes effect/i,
    "the policy must commit to notifying users BEFORE a material data-handling change");
});

test("the policy makes the negative disclosures the store listing also makes", () => {
  for (const [claim, re] of [
    ["no browsing history",  /does\s*not\s*collect your browsing history/i],
    ["no remotely hosted code", /no remotely hosted code/i],
    ["no credential reading", /session cookies, login credentials/i],
  ]) {
    assert.match(policyText, re, `the policy is missing the "${claim}" disclosure`);
  }
  // The same commitments appear in the dashboard copy; if one drifts the pair contradict.
  assert.match(listing, /No remotely hosted code/i);
  assert.match(listing, /Authentication information\*\* — \*not collected/i);
});

test("the manifest's privacy_policy_url is the page this repo actually serves", () => {
  const url = manifest.privacy_policy_url;
  assert.ok(url, "manifest must declare privacy_policy_url");
  const path = new URL(url).pathname;
  const app = fs.readFileSync("client/src/App.jsx", "utf8");
  assert.match(app, new RegExp(`path="${path}"`),
    `manifest points at ${url} but App.jsx has no route for ${path}`);
  assert.match(url, /^https:\/\/resumemaster\.one\//,
    "the policy must be on the production origin, not a dev subdomain");
});

test("third parties named in the policy are ones the code actually uses", () => {
  // A false sharing disclosure is the mirror-image failure of an undisclosed one.
  const named = ["Railway", "Anthropic", "SerpApi", "Apify", "Adzuna", "DuckDuckGo"];
  for (const n of named) {
    assert.ok(policyText.includes(n), `expected the policy to name ${n}`);
  }
  assert.ok(fs.existsSync("services/jobs/enrichLogos.js"), "the logo provider is disclosed; its caller should exist");

  // The disclosed logo host must be the one the code actually loads from. These were allowed to
  // drift once already: the policy named Clearbit for months after logo.clearbit.com stopped
  // resolving, and server.js quietly fell through to a Google favicon URL on every call — a
  // different third party seeing the user's browsing than the one the policy names. Asserted
  // against the shared module's own constant, not a second copy of the hostname.
  const host = new URL(LOGO_HOST).hostname;             // icons.duckduckgo.com
  const brand = host.split(".").at(-2);                 // duckduckgo
  assert.ok(policyText.toLowerCase().includes(brand),
    `the policy must name the operator of ${host}, which is what browsers actually request`);
  // Comments stripped, following boardListingLayout.test.js: these modules EXPLAIN the swap by
  // naming the host they no longer call, and a check that fails on its own rationale is a check
  // nobody keeps. What must not survive is a live reference.
  const stripped = ["shared/companyLogos.js", "services/jobs/enrichLogos.js", "server.js"]
    .map(f => fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""))
    .join("\n");
  assert.ok(!/logo\.clearbit\.com/.test(stripped),
    "a retired logo host must not survive in code the policy no longer discloses");
  assert.ok(!/s2\/favicons/.test(stripped),
    "the Google favicon fallback sent browsing to an undisclosed third party whenever the " +
    "disclosed one failed — which, once its DNS went, was every single call");
  assert.match(fs.readFileSync("package.json", "utf8"), /apify-client/,
    "Apify is disclosed as a third party; the client library should be a real dependency");
});

test("THE RECONCILIATION'S THIRD-PARTY TABLE MATCHES THE SET THE POLICY NAMES", () => {
  // This is the row that rotted. The test above checks the POLICY against the code, and it passed
  // throughout — it was PRIVACY_RECONCILIATION.md's own enumeration that named Clearbit as a
  // recipient and omitted DuckDuckGo for five weeks after task X swapped them. Nothing compared
  // the two documents, so the join looked enforced while its third-party row was not covered in
  // either direction.
  //
  // Convention the table encodes, and this asserts: **bold** = a live recipient the policy names,
  // *italic* = a party named only to say it receives nothing (Clearbit, THEIRSTACK).
  // Both ends via at(), not indexOf: a reworded heading would otherwise return -1, and slice reads
  // -1 as an offset from the end of the file — the region widens instead of failing.
  const secStart = at(policy, '<Section title="Third-Party Services">', 0, "PrivacyPage.jsx");
  const section = policy.slice(secStart, at(policy, "</Section>", secStart, "PrivacyPage.jsx"));
  // The FIRST <Strong> in each <LI> is the recipient's name; later ones are inline emphasis inside
  // the prose ("It is <Strong>not</Strong> used by ordinary job search"), which is not a party.
  const policyNames = [...section.matchAll(/<LI>([\s\S]*?)<\/LI>/g)]
    .map(li => li[1].match(/<Strong>([^<]+)<\/Strong>/))
    .filter(Boolean)
    .map(m => m[1].replace(/\s+/g, " ").trim());
  assert.ok(policyNames.length >= 6, `expected the policy to name recipients, found ${policyNames.length}`);

  // The table used to be a flat list inside the negative-disclosures row, which is how it went
  // stale unnoticed. at() throws by name if either heading is reworded away.
  const tblStart = at(recon, "## Third-party recipients", 0, "PRIVACY_RECONCILIATION.md");
  const table = recon.slice(
    tblStart, at(recon, "### What is machine-guarded", tblStart, "PRIVACY_RECONCILIATION.md"));
  const reconNames = [...table.matchAll(/^\|\s*\*\*([^*|]+)\*\*\s*\|/gm)]
    .map(m => m[1].replace(/\s+/g, " ").trim());

  for (const name of policyNames) {
    assert.ok(reconNames.includes(name),
      `the policy names "${name}" as a third party, but PRIVACY_RECONCILIATION.md's table does ` +
      `not list it as a recipient — an undisclosed recipient in the join`);
  }
  for (const name of reconNames) {
    assert.ok(policyNames.includes(name),
      `PRIVACY_RECONCILIATION.md lists "${name}" as a live recipient, but the policy does not ` +
      `name it — this is the direction that let "Clearbit Logo API" outlive its own retirement`);
  }

  // The specific rot, pinned by name in both directions.
  assert.ok(!reconNames.some(n => /clearbit/i.test(n)),
    "Clearbit must not be listed as a live recipient: logo.clearbit.com has no A record and the " +
    "only surviving reference is RETIRED_LOGO_HOSTS, a repair list");
  assert.ok(reconNames.some(n => /duckduckgo/i.test(n)),
    "the live logo provider must appear in the table as a recipient");
});
