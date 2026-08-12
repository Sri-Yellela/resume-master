import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync("server.js", "utf8");
const accountRoute = fs.readFileSync("routes/account.js", "utf8");
const auth = fs.readFileSync("client/src/components/AuthScreen.jsx", "utf8");
const readiness = fs.readFileSync("services/integrationReadiness.js", "utf8");
const integrations = fs.readFileSync("client/src/panels/IntegrationsPanel.jsx", "utf8");
const docs = fs.readFileSync("documentation.md", "utf8");
const envExample = fs.readFileSync(".env.example", "utf8");

test("auth entry exposes Google, LinkedIn and GitHub provider login options", () => {
  // GitHub was added after this test was written, turning the two-way label into a three-way
  // chain. Asserting each provider is labelled, rather than the exact ternary shape, so adding a
  // fourth provider extends the list instead of breaking the test.
  assert.match(auth, /provider === "linkedin" \? "LinkedIn"/);
  assert.match(auth, /provider === "github" \? "GitHub"/);
  assert.match(auth, /: "Google"/);
  assert.match(auth, /Continue with \{label\}/);
  assert.match(auth, /api\("\/api\/auth\/oauth\/status"\)/);
  // An unconfigured provider is now HIDDEN rather than rendered with a "not configured for this
  // deployment" note — the button returns null once readiness says it isn't configured. Asserting
  // that gate, since it is the behaviour that replaced the copy.
  assert.match(auth, /oauthStatus !== null && !readiness\?\.configured\) return null/);
  // The button now links to the short /auth/:provider alias rather than building the long
  // /api/auth/oauth/${provider}/start URL — which is precisely why that alias is registered
  // server-side (asserted in the route test below, and relied on by the extension popup too).
  assert.match(auth, /href=\{`\/auth\/\$\{provider\}`\}/);
  assert.doesNotMatch(auth, /Provider ID \(optional\)/);
});

test("provider auth links identities to main users and integrations", () => {
  // Both routes now register an ARRAY of paths — the canonical /api/auth/oauth/:provider/* plus a
  // short /auth/:provider alias. That alias is load-bearing: the browser extension's popup opens
  // /auth/linkedin directly. Asserting the path is present in the registration rather than the
  // exact single-string form.
  assert.match(server, /app\.get\(\[?"\/api\/auth\/oauth\/:provider\/start"/);
  assert.match(server, /app\.get\(\[?"\/api\/auth\/oauth\/:provider\/callback"/);
  assert.match(server, /"\/auth\/:provider"/, "the short alias the extension relies on must stay");
  assert.match(server, /exchangeOAuthCode/);
  assert.match(server, /fetchOAuthUserInfo/);
  assert.match(server, /completeProviderAuth/);
  assert.match(server, /app\.post\("\/api\/auth\/provider\/:provider"/);
  assert.match(server, /findUserByAuthProvider/);
  assert.match(server, /google_auth_id/);
  assert.match(server, /linkedin_auth_id/);
  assert.match(server, /upsertAuthIntegration\(user\.id, provider/);
  assert.match(server, /getAutomationReadiness\(db, user\.id\)/);
});

test("OAuth configuration is environment driven", () => {
  assert.match(server, /GOOGLE_OAUTH_CLIENT_ID/);
  assert.match(server, /GOOGLE_OAUTH_CLIENT_SECRET/);
  assert.match(server, /LINKEDIN_OAUTH_CLIENT_ID/);
  assert.match(server, /LINKEDIN_OAUTH_CLIENT_SECRET/);
  assert.match(server, /GOOGLE_OAUTH_REDIRECT_URI/);
  assert.match(server, /LINKEDIN_OAUTH_REDIRECT_URI/);
  assert.match(server, /oauthProviderReadiness/);
  assert.match(server, /app\.get\("\/api\/auth\/oauth\/status"/);
  assert.match(server, /logOAuthReadiness\(\)/);
  // .env.example documents the CURRENT variable names (GOOGLE_CALLBACK_URL, …). The
  // *_OAUTH_REDIRECT_URI form this used to assert is the legacy alias, still accepted by
  // server.js for backwards compatibility but deliberately not what new deployments are told to
  // set. Assert both halves of that contract: the example documents the current names, and the
  // server still honours the legacy ones.
  assert.match(envExample, /GOOGLE_CALLBACK_URL=/);
  assert.match(envExample, /LINKEDIN_CALLBACK_URL=/);
  assert.match(envExample, /GITHUB_CALLBACK_URL=/);
  assert.match(server, /GOOGLE_CALLBACK_URL \|\| process\.env\.GOOGLE_OAUTH_REDIRECT_URI/);
  assert.match(server, /LINKEDIN_CALLBACK_URL \|\| process\.env\.LINKEDIN_OAUTH_REDIRECT_URI/);
});

test("OAuth callback and redirect handling is hardened", () => {
  assert.match(server, /rawPath\.startsWith\("\/"\) && !rawPath\.startsWith\("\/\/"\)/);
  assert.match(server, /Sign in before linking an OAuth provider/);
  assert.match(server, /callback rejected: invalid state/);
  assert.match(server, /provider returned error/);
  assert.match(server, /OAuth callback did not include an authorization code/);
});

test("unlinking OAuth integrations clears provider identity columns", () => {
  assert.match(server, /providerColumnFor/);
  assert.match(accountRoute, /UPDATE users SET \$\{providerColumnFor\(provider\)\}=NULL WHERE id=\?/);
});

test("integrations readiness reflects auth-linked LinkedIn identity as connected", () => {
  assert.match(readiness, /identityLinked/);
  assert.match(readiness, /getStoredIntegration\(db, userId, "linkedin"\)/);
  // getLinkedInStatus was refactored to derive every field from publicIntegrationRow() rather
  // than OR-ing a raw row against it, so `!!row ||` no longer appears. The behaviour asserted —
  // an auth-linked identity reads as connected — is unchanged and still covered.
  assert.match(readiness, /connected: publicLinkedIdentity\.connected/);
});

test("integrations page uses OAuth reconnect flows for Google and LinkedIn login", () => {
  assert.match(integrations, /\/api\/auth\/oauth\/\$\{provider\}\/start/);
  // `status` itself is now optional-chained too (status?.oauth?.[provider]) — a defensive fix for
  // reading readiness before the status request resolves. Matching either form.
  assert.match(integrations, /status\??\.oauth\?\.\[provider\]/);
  assert.match(integrations, /OAuth is not configured by the app operator/);
  // "Reconnect Google" / "Connect LinkedIn Login" / "Unlink Login" are gone. The panel was
  // reframed from generic OAuth account-linking to a purpose-named "LinkedIn Profile Import"
  // section, and no Google section is offered here at all — Google remains a sign-in provider on
  // the auth screen, not an integration to manage. Asserting the copy that exists now.
  assert.match(integrations, /LinkedIn Profile Import/);
  assert.match(integrations, /Import from LinkedIn/);
  assert.match(integrations, /Disconnect/);
});

test("operator docs explain OAuth provider console setup", () => {
  assert.match(docs, /OAuth Provider Setup/);
  assert.match(docs, /Google Cloud Console/);
  assert.match(docs, /LinkedIn Developer Portal/);
  assert.match(docs, /api\/auth\/oauth\/google\/callback/);
  assert.match(docs, /api\/auth\/oauth\/linkedin\/callback/);
});
