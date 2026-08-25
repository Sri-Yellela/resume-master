import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * TASK AH1 — the credential's LIFECYCLE: issued, carried, revoked.
 *
 * The behavioural proof of all of this is scripts/ah1SessionIdentity.mjs, which boots the real
 * server and asks it who the caller is. These tests pin the specific code shapes that produced the
 * defect, so a refactor cannot reintroduce it between harness runs.
 *
 * THE DEFECT, in one line of source:
 *     if (token) { ...revoke the token...; return res.json({ ok:true, scoped:true }); }
 * That `return` is the whole bug. It skipped req.logout(), so the connect.sid session — the
 * durable, seven-day, ROLLING credential — outlived the sign-out. Every request that did not carry
 * a tab token then re-authenticated off it, and a new tab carries no token because sessionStorage
 * is per-tab and starts empty. Hence "a hard refresh auto-authenticates".
 */

const SERVER = fs.readFileSync("server.js", "utf8");

function block(source, startNeedle, chars = 1600) {
  const i = source.indexOf(startNeedle);
  assert.notEqual(i, -1, `could not find ${startNeedle}`);
  return source.slice(i, i + chars);
}

test("migration 090 binds an auth context to the session that issued it", () => {
  const migrations = fs.readFileSync("scripts/migrations.js", "utf8");
  for (const [name, source] of [["server.js", SERVER], ["scripts/migrations.js", migrations]]) {
    assert.match(source, /id: "090_auth_context_session_binding"/, name);
    assert.match(source, /ALTER TABLE auth_contexts ADD COLUMN session_sid TEXT/, name);
    assert.match(source, /idx_auth_contexts_session/, name);
  }
});

test("migration 090 is byte-identical in both migration sources", () => {
  // The two arrays are hand-duplicated, and a migration that differs between them applies
  // differently depending on which one ran — the worst kind of schema drift, because both look fine
  // in isolation.
  const grab = (file) => {
    const s = fs.readFileSync(file, "utf8");
    const i = s.indexOf("090_auth_context_session_binding");
    return s.slice(s.lastIndexOf("    {", i), s.indexOf("    },", i) + 6);
  };
  assert.equal(grab("server.js"), grab("scripts/migrations.js"));
});

test("issueAuthContext records the session the token was issued under", () => {
  const fn = block(SERVER, "function issueAuthContext");
  assert.match(fn, /session_sid/);
  assert.match(fn, /options\.sessionLess \? null : \(req\.sessionID \|\| null\)/);
});

test("the extension token is deliberately session-less, so a browser sign-out does not kill it", () => {
  const route = block(SERVER, 'app.get("/api/auth/extension-token"', 500);
  assert.match(route, /sessionLess: true/);
  assert.match(route, /userAgent: "resume-master-extension"/);
});

test("signing out no longer returns early on a token — the session is destroyed too", () => {
  const route = block(SERVER, 'app.post("/api/auth/logout"', 1200);
  // The exact regression: revoking the token and returning without touching the session.
  assert.doesNotMatch(route, /return res\.json\(\{ ok:true, scoped:true \}\)/);
  assert.match(route, /revokeBrowserAuthContexts\(sid, token\)/);
  assert.match(route, /req\.logout\(/);
  assert.match(route, /req\.session\?\.destroy\?\./);
  assert.match(route, /res\.clearCookie\("connect\.sid"/);
  assert.match(route, /scope:"browser"/);
  // req.logout() regenerates the session, so the sid must be read before it runs or the revocation
  // targets a session that no longer exists.
  assert.ok(route.indexOf("const sid = req.sessionID") < route.indexOf("req.logout(() =>"),
    "req.sessionID must be captured BEFORE req.logout() regenerates the session");
});

test("a browser sign-out revokes that browser's contexts and never an unattributable one", () => {
  const fn = block(SERVER, "function revokeBrowserAuthContexts");
  assert.match(fn, /WHERE token_hash=\? AND revoked_at IS NULL/);
  assert.match(fn, /WHERE session_sid=\? AND revoked_at IS NULL/);
  // Matching on NULL would sweep every extension token and every pre-090 row belonging to anyone.
  assert.doesNotMatch(fn, /session_sid IS NULL/);
  assert.match(fn, /if \(!sid\) return;/);
});

test("a password change revokes every credential for that user, both kinds", () => {
  const fn = block(SERVER, "function revokeAllUserSessions", 1800);
  assert.match(fn, /UPDATE auth_contexts SET revoked_at=\? WHERE user_id=\? AND revoked_at IS NULL/);
  // The cookie session is the credential that outlives everything else, so a sweep that only
  // revoked tokens would leave the account effectively unlocked.
  assert.match(fn, /SELECT sid, sess FROM \$\{SStore\.table\}/);
  assert.match(fn, /SStore\.destroy\(row\.sid/);
  assert.match(fn, /passport\?\.user/);
  // connect-sqlite3's own all() drops the sid, which is the one field destroy() needs.
  assert.doesNotMatch(fn, /SStore\.all\(/);
});

test("both password-change paths call the sweep", () => {
  const selfService = block(SERVER, 'app.post("/api/auth/password-reset/confirm"', 900);
  // Awaited: the cookie sweep is async, and answering before it lands would report a lock that
  // had not happened yet.
  assert.match(selfService, /await revokeAllUserSessions\(result\.userId, "password_reset"\)/);
  const adminPath = block(SERVER, 'app.patch("/api/admin/users/:id/password"', 900);
  assert.match(adminPath, /await revokeAllUserSessions\(targetId, "admin_password_change"\)/);
});

test("the data directory is overridable so the auth stack can be tested against a throwaway db", () => {
  assert.match(SERVER, /const DATA_DIR\s+= process\.env\.RM_DATA_DIR \|\| path\.join\(__dirname, "data"\)/);
  assert.match(SERVER, /const DB_PATH\s+= path\.join\(DATA_DIR, "resume_master\.db"\)/);
  // The session store must follow it, or a test boot would revoke the developer's own sessions.
  assert.match(SERVER, /new SQLiteStore\(\{ db:"sessions\.db", dir:DATA_DIR \}\)/);
});

test("scoped mutations report whether they matched a row, instead of a no-op success", () => {
  // A DELETE aimed at another user's job_id was correctly scoped and deleted nothing, then answered
  // {ok:true}. Safe, and indistinguishable from having deleted your own.
  for (const [needle, notFound] of [
    ['app.delete("/api/resumes/:jobId"', "Resume not found"],
    ['app.patch("/api/applications/:jobId"', "Application not found"],
    ['app.delete("/api/applications/:jobId"', "Application not found"],
  ]) {
    const route = block(SERVER, needle, 900);
    assert.match(route, /\.changes/, needle);
    assert.match(route, new RegExp(`404\\)\\.json\\(\\{ error:"${notFound}" \\}\\)`), needle);
  }
});

test("no client call site reaches /api without the tab auth context", () => {
  // This is the client half of the same defect. The cookie is shared by every tab in a browser
  // profile; the auth-context token is per tab. A call that sends only `credentials: "include"` is
  // therefore answered as whoever the COOKIE belongs to, which in a browser with two accounts open
  // is the wrong person — silently, and on a WRITE. JobCard's star/dislike was exactly that.
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(full);
      else if (/\.(jsx?|tsx?)$/.test(e.name)) files.push(full);
    }
  };
  walk("client/src");

  // Reviewed: the standalone tool pages are the anonymous surface. They have no signed-in identity
  // to carry, and their endpoints are in the PUBLIC list of authRouteGuardManifest.test.js.
  const REVIEWED = /\/api\/standalone\//;

  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const m of source.matchAll(/fetch\(\s*(`[^`]*\/api\/[^`]*`|"[^"]*\/api\/[^"]*")/g)) {
      const url = m[1];
      if (REVIEWED.test(url)) continue;
      // The token can be attached after the URL (an inline headers object) or before it (a headers
      // variable built a few lines up, which is what UsbSuggest does), so look both ways.
      const window = source.slice(Math.max(0, m.index - 420), m.index + 420);
      if (/authHeaders|X-RM-Auth-Context|x-rm-auth-context|authContextQuery|getAuthContext/.test(window)) continue;
      offenders.push(`${file}: fetch(${url.slice(0, 60)})`);
    }
  }
  assert.deepEqual(offenders.sort(), [],
    "These call sites reach /api with the cookie only, so they are answered as the cookie's owner " +
    "rather than the tab's user. Route them through api() from lib/api.js, or add authHeaders():\n  " +
    offenders.join("\n  "));
});

test("a URL the browser navigates to carries the context in the query string instead", () => {
  // An <a href> or window.open cannot set a header, so bindAuthContext also accepts ?authContext=.
  const inspector = fs.readFileSync("client/src/pages/admin/DBInspector.jsx", "utf8");
  assert.match(inspector, /authContextQuery/);
  assert.match(inspector, /href=\{`\/api\/admin\/db\/export\/\$\{selected\.name\}\$\{authContextQuery\(\)/);
  assert.match(SERVER, /return header \|\| bearer \|\| req\.query\?\.authContext \|\| null/);
});
