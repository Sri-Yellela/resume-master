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
