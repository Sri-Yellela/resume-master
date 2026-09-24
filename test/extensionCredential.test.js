import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isExtensionCredential, isExtensionRequest, mayActAsAdmin } from "../shared/authPolicy.js";
import { EXTENSION_USER_AGENT, MOBILE_USER_AGENT } from "../shared/brand.js";

// ── WHAT THESE GUARD ────────────────────────────────────────────────────────────────────────────
// docs/EXTENSION_DIAGNOSIS.md §6: a credentialed fetch from the extension origin reached 7 of 7
// real admin routes with real admin JSON, because the extension authenticated by whatever cookie
// the browser held.
//
// ⛔ The node suite was 2606 pass / 0 fail throughout that defect and CANNOT see the behaviour —
// scripts/dx2ExtensionIdentity.mjs is what proves it in a real browser. These tests guard the two
// things a source-level test genuinely can: the POLICY (a pure function, tested behaviourally) and
// the SHAPE (that all three admin guards route through it, and that the cookie stopped being sent).

const read = (p) => fs.readFileSync(p, "utf8");

test("mayActAsAdmin: an extension credential is never an admin, even on an admin account", () => {
  const adminViaExtension = { user: { isAdmin: true }, authContextUserAgent: EXTENSION_USER_AGENT };
  assert.equal(isExtensionCredential(adminViaExtension), true);
  assert.equal(mayActAsAdmin(adminViaExtension), false,
    "this is the whole defect: the credential changed but the privilege must change with it");
});

// ── The Sec-Fetch-* shapes below are MEASURED, not assumed ─────────────────────────────────────
// Read off the wire from a real Chrome in .dx1-scratch/dx3Headers.mjs. Chrome sends NO Origin and
// NO Referer on an extension request to a host_permissions host, which is why an Origin-based
// check could never fire. Do not "simplify" these to an Origin test.
const EXTENSION_FETCH  = { "sec-fetch-site": "none",        "sec-fetch-mode": "cors" };
const SAME_ORIGIN_PAGE = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };
const TYPED_URL        = { "sec-fetch-site": "none",        "sec-fetch-mode": "navigate" };
const API_CLIENT       = {};   // curl / node / a harness: neither header exists

test("mayActAsAdmin: an extension page borrowing the COOKIE is refused too", () => {
  // Measured, not theorised: dx2 §2 failed 7/7 with only the credential check in place, because a
  // `credentials: 'include'` fetch from an extension page still carries the browser cookie.
  const cookieFromExtensionPage = { user: { isAdmin: true }, headers: EXTENSION_FETCH };
  assert.equal(isExtensionCredential(cookieFromExtensionPage), false, "it is NOT the token path");
  assert.equal(isExtensionRequest(cookieFromExtensionPage), true, "but it IS the extension");
  assert.equal(mayActAsAdmin(cookieFromExtensionPage), false);
});

test("isExtensionRequest: the admin console itself is untouched", () => {
  // The control that matters. If this ever fails, the fix has locked admins out of their own
  // console — which dx2 §0 and §3 also assert against a real browser.
  const req = { user: { isAdmin: true }, headers: SAME_ORIGIN_PAGE };
  assert.equal(isExtensionRequest(req), false);
  assert.equal(mayActAsAdmin(req), true);
});

test("isExtensionRequest: a typed URL and an ordinary API client are untouched", () => {
  // "none" alone is not the signal — a bookmark or typed URL is also site:none, but mode:navigate.
  // And a client that sends neither header must not be caught by an equality test against "none".
  for (const [label, headers] of [["typed URL", TYPED_URL], ["curl/node", API_CLIENT]]) {
    const req = { user: { isAdmin: true }, headers };
    assert.equal(isExtensionRequest(req), false, label);
    assert.equal(mayActAsAdmin(req), true, label);
  }
});

test("isExtensionRequest: it fails SAFE when the headers are missing entirely", () => {
  // A browser that omits Sec-Fetch-* must fall back to the credential check, not to a blanket
  // refusal and not to a blanket allow.
  assert.equal(isExtensionRequest({ headers: undefined }), false);
  assert.equal(isExtensionRequest({}), false);
  assert.equal(isExtensionRequest(null), false);
  assert.equal(
    isExtensionRequest({ headers: {}, authContextUserAgent: EXTENSION_USER_AGENT }), true,
    "the credential check still decides when the transport says nothing");
});

test("mayActAsAdmin: a browser session on the same admin account still IS an admin", () => {
  // The privilege is removed from the CREDENTIAL, not from the person. If this ever fails, the fix
  // has locked admins out of their own console.
  assert.equal(mayActAsAdmin({ user: { isAdmin: true } }), true);
  assert.equal(mayActAsAdmin({ user: { isAdmin: true }, authContextUserAgent: null }), true);
});

test("mayActAsAdmin: a non-admin is refused however they authenticated", () => {
  assert.equal(mayActAsAdmin({ user: { isAdmin: false } }), false);
  assert.equal(mayActAsAdmin({ user: {} }), false);
  assert.equal(mayActAsAdmin({}), false);
  assert.equal(mayActAsAdmin(null), false, "an unauthenticated request must not throw here");
});

test("the mobile credential is deliberately NOT covered — scope is recorded, not assumed", () => {
  // Not an endorsement: nothing in this pass measured mobile, and the mobile contract is versioned.
  // Asserted so that widening the policy is a deliberate edit to a failing test, not a silent drift.
  const adminViaMobile = { user: { isAdmin: true }, authContextUserAgent: MOBILE_USER_AGENT };
  assert.equal(isExtensionCredential(adminViaMobile), false);
  assert.equal(mayActAsAdmin(adminViaMobile), true);
});

test("the policy compares against the WIRE VALUE, not a second spelling of it", () => {
  // shared/brand.js: renaming either user_agent string orphans every live row and revoke silently
  // stops revoking. A literal here would be exactly that second spelling.
  const src = read("shared/authPolicy.js");
  assert.match(src, /import \{ EXTENSION_USER_AGENT \} from "\.\/brand\.js"/);
  assert.doesNotMatch(src, /"resume-master-extension"/,
    "compare against the constant, never a re-typed literal");
});

test("bindAuthContext carries the credential KIND forward, or the policy has nothing to read", () => {
  const src = read("server.js");
  const i = src.indexOf("function bindAuthContext");
  assert.notEqual(i, -1);
  const fn = src.slice(i, i + 2500);
  assert.match(fn, /ac\.user_agent/, "the column must be selected");
  assert.match(fn, /req\.authContextUserAgent = row\.user_agent/,
    "and bound onto the request, which is what shared/authPolicy.js reads");
});

test("ALL THREE admin guards route through the one predicate", () => {
  // Three independently-written requireAdmin definitions are how the extension reached the DB
  // inspector while a fix sat in one of them. Each must consult the shared policy.
  for (const file of ["server.js", "routes/admin.js", "routes/adminDb.js"]) {
    const src = read(file);
    assert.match(src, /from "\.{1,2}\/shared\/authPolicy\.js"/, `${file} must import the policy`);
    const i = src.indexOf("function requireAdmin");
    assert.notEqual(i, -1, `${file} has no requireAdmin`);
    const fn = src.slice(i, i + 700);
    assert.match(fn, /mayActAsAdmin\(req\)|isExtensionCredential\(req\)/,
      `${file}'s requireAdmin must consult shared/authPolicy.js`);
    assert.doesNotMatch(fn, /!req\.user\?\.isAdmin\)\s*return res\.status\(403\)/,
      `${file} still decides admin from req.user.isAdmin alone`);
  }
});

test("the extension sends its own token and NEVER the ambient cookie", () => {
  // `credentials: 'omit'` is the security property, not a tidiness preference: if the cookie still
  // travelled, requireAuth would authenticate off the SESSION and the extension would be back to
  // borrowing whoever is signed in, token or no token.
  const auth = read("extension/auth.js");
  assert.match(auth, /credentials: 'omit'/);
  assert.match(auth, /'X-RM-Auth-Context'/);
  assert.match(auth, /\/api\/auth\/extension-token/);

  // ⛔ NOT the other two credentials. See server.js at the mobile route for why they are separate.
  assert.doesNotMatch(auth, /mobile-token/);

  // Exactly ONE credentialed call exists in the whole extension: the bootstrap that trades a
  // session for a token. Counted in CODE, ignoring the prose that explains it.
  const codeOf = (p) => read(p).split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const includes = ["extension/auth.js", "extension/background.js", "extension/gated-handoff.js",
                    "extension/popup.js", "extension/options.js"]
    .flatMap(f => (codeOf(f).match(/credentials: *'include'/g) || []).map(() => f));
  assert.deepEqual(includes, ["extension/auth.js"],
    `only the token bootstrap may send the cookie; found in: ${includes.join(", ") || "nowhere"}`);
});

test("the popup names the identity the extension is acting as", () => {
  const html = read("extension/popup.html");
  const js = read("extension/popup.js");
  assert.match(html, /id="identity-who"/, "there must be somewhere to render it");
  assert.match(js, /Signed in as/, "and it must actually say so");
  // Rendered as text, never parsed: a username is user-controlled input.
  assert.match(js, /name\.textContent = identity\.username/);
  assert.doesNotMatch(js, /innerHTML\s*=\s*[`'"].*\$\{/, "no interpolated innerHTML in the popup");
});
