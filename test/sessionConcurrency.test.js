import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("server supports tab-scoped auth contexts over the browser cookie session", () => {
  const server = fs.readFileSync("server.js", "utf8");

  assert.match(server, /040_tab_scoped_auth_contexts/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS auth_contexts/);
  assert.match(server, /function issueAuthContext/);
  assert.match(server, /function bindAuthContext/);
  assert.match(server, /app\.use\(bindAuthContext\)/);
  assert.match(server, /authContext:issueAuthContext\(user\.id, req\)/);
  assert.match(server, /authContext:issueAuthContext\(newUser\.id, req\)/);
  assert.match(server, /UPDATE auth_contexts SET revoked_at=unixepoch\(\)/);
});

test("client request and realtime layers send the tab auth context", () => {
  const api = fs.readFileSync("client/src/lib/api.js", "utf8");
  const sync = fs.readFileSync("client/src/hooks/useSyncEvents.js", "utf8");
  const auth = fs.readFileSync("client/src/components/AuthScreen.jsx", "utf8");
  const adminLogin = fs.readFileSync("client/src/pages/AdminLoginPage.jsx", "utf8");
  const jobs = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  const dbInspector = fs.readFileSync("client/src/pages/admin/DBInspector.jsx", "utf8");

  assert.match(api, /const AUTH_CONTEXT_KEY = "rm_auth_context"/);
  assert.match(api, /sessionStorage\.setItem\(AUTH_CONTEXT_KEY, token\)/);
  assert.match(api, /"X-RM-Auth-Context": token/);
  assert.match(api, /Session expired\. Sign in again\./);
  assert.match(sync, /authContextQuery/);
  assert.match(sync, /\/api\/sync\/events\$\{qs \? `\?\$\{qs\}` : ""\}/);
  assert.match(auth, /setAuthContext\(d\.authContext\)/);
  assert.match(adminLogin, /setAuthContext\(d\.authContext\)/);
  assert.match(jobs, /headers:authHeaders\(\)/);
  assert.match(dbInspector, /headers:authHeaders\(\)/);
});

test("logout clears only the current tab context on the client", () => {
  const app = fs.readFileSync("client/src/App.jsx", "utf8");
  const api = fs.readFileSync("client/src/lib/api.js", "utf8");

  assert.match(app, /setAuthContext\(""\)/);
  assert.match(api, /sessionStorage\.removeItem\(AUTH_CONTEXT_KEY\)/);
});

test("requireAuth accepts valid auth context token even when Passport session is absent", () => {
  // Root cause fix: users whose sessions.db was wiped (server restart on ephemeral
  // storage) but who have a valid auth_contexts row must not receive 401.
  const server = fs.readFileSync("server.js", "utf8");

  // requireAuth must check req.authContextToken in addition to req.isAuthenticated()
  assert.match(server, /req\.isAuthenticated\(\) \|\| req\.authContextToken/);

  // bindAuthContext must set req.authContextToken only on valid token
  const bindStart = server.indexOf("function bindAuthContext");
  const bindEnd   = server.indexOf("\nfunction ", bindStart + 1);
  const bindBlock = server.slice(bindStart, bindEnd);
  assert.match(bindBlock, /req\.authContextToken = token/);
  assert.match(bindBlock, /revoked_at IS NULL/);
  assert.match(bindBlock, /expires_at > \?/);

  // requireAuth logging for diagnosing 401s
  assert.match(server, /\[auth\] 401/);
  assert.match(server, /cookie:.*token_sent:/);
});

test("deserializeUser cleans up gracefully when user row is missing", () => {
  // Prevents server restart from turning stale session IDs into 500 errors.
  const server = fs.readFileSync("server.js", "utf8");
  const dsStart = server.indexOf("passport.deserializeUser");
  const dsEnd   = server.indexOf("});\n\nfunction hydrateAuthUser", dsStart);
  const dsBlock = server.slice(dsStart, dsEnd);

  // Must use done(null, false) not done(new Error(...)) for missing user
  assert.match(dsBlock, /done\(null, false\)/);
  assert.doesNotMatch(dsBlock, /done\(new Error\("User not found"\)\)/);
  // Must log the incident
  assert.match(dsBlock, /deserializeUser.*not found/);
});

test("api.js clears stale auth context and dispatches event on 401", () => {
  // Ensures the user is force-logged out immediately on any 401, not just on
  // the next visibilitychange event.
  const api = fs.readFileSync("client/src/lib/api.js", "utf8");

  // Must clear the auth context when a 401 is received
  assert.match(api, /setAuthContext\(""\)/);
  // Must dispatch the session-expired event
  assert.match(api, /rm:session-expired/);
  assert.match(api, /window\.dispatchEvent/);
});

test("App.jsx force-logouts immediately when rm:session-expired fires", () => {
  const app = fs.readFileSync("client/src/App.jsx", "utf8");

  assert.match(app, /rm:session-expired/);
  assert.match(app, /window\.addEventListener\("rm:session-expired"/);
  assert.match(app, /window\.removeEventListener\("rm:session-expired"/);
});

test("session config uses rolling renewal to prevent mid-session expiry", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /rolling: true/);
});

test("bindAuthContext logs when a token is sent but is expired or invalid", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const bindStart = server.indexOf("function bindAuthContext");
  const bindEnd   = server.indexOf("\nfunction ", bindStart + 1);
  const bindBlock = server.slice(bindStart, bindEnd);

  // Must log when a token is present but lookup fails (not silently swallow it)
  assert.match(bindBlock, /token not found\/expired/);
  assert.match(bindBlock, /\[auth-context\]/);
});
