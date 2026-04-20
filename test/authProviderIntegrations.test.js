import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync("server.js", "utf8");
const auth = fs.readFileSync("client/src/components/AuthScreen.jsx", "utf8");
const readiness = fs.readFileSync("services/integrationReadiness.js", "utf8");
const integrations = fs.readFileSync("client/src/panels/IntegrationsPanel.jsx", "utf8");
const docs = fs.readFileSync("documentation.md", "utf8");
const envExample = fs.readFileSync(".env.example", "utf8");

test("auth entry exposes Google and LinkedIn provider login options", () => {
  assert.match(auth, /const label = provider === "linkedin" \? "LinkedIn" : "Google"/);
  assert.match(auth, /Continue with \{label\}/);
  assert.match(auth, /api\("\/api\/auth\/oauth\/status"\)/);
  assert.match(auth, /not configured for this deployment/);
  assert.match(auth, /\/api\/auth\/oauth\/\$\{provider\}\/start/);
  assert.doesNotMatch(auth, /Provider ID \(optional\)/);
});

test("provider auth links identities to main users and integrations", () => {
  assert.match(server, /app\.get\("\/api\/auth\/oauth\/:provider\/start"/);
  assert.match(server, /app\.get\("\/api\/auth\/oauth\/:provider\/callback"/);
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
  assert.match(envExample, /GOOGLE_OAUTH_REDIRECT_URI=http:\/\/localhost:3001\/api\/auth\/oauth\/google\/callback/);
  assert.match(envExample, /LINKEDIN_OAUTH_REDIRECT_URI=http:\/\/localhost:3001\/api\/auth\/oauth\/linkedin\/callback/);
});

test("OAuth callback and redirect handling is hardened", () => {
  assert.match(server, /rawPath\.startsWith\("\/"\) && !rawPath\.startsWith\("\/\/"\)/);
  assert.match(server, /Sign in before linking an OAuth provider/);
  assert.match(server, /callback rejected: invalid state/);
  assert.match(server, /provider returned error/);
  assert.match(server, /OAuth callback did not include an authorization code/);
});

test("unlinking OAuth integrations clears provider identity columns", () => {
  assert.match(server, /UPDATE users SET \$\{providerColumnFor\(provider\)\}=NULL WHERE id=\?/);
});

test("integrations readiness reflects auth-linked LinkedIn identity as connected", () => {
  assert.match(readiness, /identityLinked/);
  assert.match(readiness, /getStoredIntegration\(db, userId, "linkedin"\)/);
  assert.match(readiness, /connected: !!row \|\| publicLinkedIdentity\.connected/);
});

test("integrations page uses OAuth reconnect flows for Google and LinkedIn login", () => {
  assert.match(integrations, /\/api\/auth\/oauth\/\$\{provider\}\/start/);
  assert.match(integrations, /status\.oauth\?\.\[provider\]/);
  assert.match(integrations, /OAuth is not configured by the app operator/);
  assert.match(integrations, /Reconnect Google/);
  assert.match(integrations, /Connect LinkedIn Login/);
  assert.match(integrations, /Unlink Login/);
});

test("operator docs explain OAuth provider console setup", () => {
  assert.match(docs, /OAuth Provider Setup/);
  assert.match(docs, /Google Cloud Console/);
  assert.match(docs, /LinkedIn Developer Portal/);
  assert.match(docs, /api\/auth\/oauth\/google\/callback/);
  assert.match(docs, /api\/auth\/oauth\/linkedin\/callback/);
});
