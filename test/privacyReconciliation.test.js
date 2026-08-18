import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

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

/** The policy is JSX. Reduce it to the prose a reader actually sees. */
const policyText = policy
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

test("the policy names every job board the extension actually reads", () => {
  // If a board is added to the manifest without being named in the policy, the extension reads a
  // site the policy does not admit to reading.
  const boards = { linkedin: "LinkedIn", indeed: "Indeed", glassdoor: "Glassdoor",
                   lever: "Lever", greenhouse: "Greenhouse", workable: "Workable" };
  for (const [key, label] of Object.entries(boards)) {
    const declared = manifest.host_permissions.some(h => h.includes(key));
    if (!declared) continue;
    assert.ok(policyText.includes(label),
      `the manifest declares ${key} but the privacy policy never names ${label}`);
  }
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
});

test("the policy describes ONE capture path, not two", () => {
  // Before E2 the popup wrote to a different table than the hotkey. The policy described "save jobs,
  // or import jobs" — two verbs for what is now one action, which reads as two features to a
  // reviewer applying the single-purpose rule.
  assert.match(policyText, /one\s*<?\/?\w*>?\s*capture action|has\s*one\s*capture/i,
    "the policy should state that there is a single capture action with two triggers");
  const content = fs.readFileSync("extension/linkedin-content.js", "utf8");
  assert.doesNotMatch(content, /function saveJob/,
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
  const named = ["Railway", "Anthropic", "SerpApi", "Apify", "Adzuna", "Clearbit"];
  for (const n of named) {
    assert.ok(policyText.includes(n), `expected the policy to name ${n}`);
  }
  assert.ok(fs.existsSync("services/jobs/enrichLogos.js"), "Clearbit is disclosed; its caller should exist");
  assert.match(fs.readFileSync("package.json", "utf8"), /apify-client/,
    "Apify is disclosed as a third party; the client library should be a real dependency");
});
