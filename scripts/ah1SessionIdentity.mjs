#!/usr/bin/env node
/**
 * TASK AH1 — session identity, real-run verification.
 * ============================================================================================
 * WHY THIS IS A HARNESS AND NOT A UNIT TEST
 * test/sessionConcurrency.test.js already asserts, in nine tests, that server.js CONTAINS
 * issueAuthContext, that requireAuth mentions req.authContextToken, that logout revokes a token.
 * Every one of those passed for the entire life of the defect this harness exists to catch,
 * because a source string cannot tell you WHO a request is answered as. Only a real request can.
 *
 * The authentication stack is also the one part of this codebase that cannot be mounted piecemeal:
 * passport, the connect-sqlite3 session store and bindAuthContext are wired together in server.js
 * and only behave as a stack. So this boots the real server.js against a THROWAWAY data directory
 * (RM_DATA_DIR) and asserts on what real HTTP responses say the caller's identity is.
 *
 * THE DEFECT
 * /api/auth/logout revoked the presenting tab's auth-context token and RETURNED EARLY, so the
 * connect.sid session — the durable, 7-day, ROLLING credential — survived. Every request without a
 * token then re-authenticated off it, and a new tab sends no token because sessionStorage is
 * per-tab and starts empty. That is the long-standing "a hard refresh auto-authenticates" report:
 * not a refresh bug, a sign-out that only ever discarded the fallback credential.
 *
 * A password change had the same shape from the other end — it rewrote the hash and left every
 * cookie session and every issued token working, so "reset your password" locked nothing.
 *
 * WHAT IS ASSERTED
 *   Section 1  what the credential IS: a cookie, plus a per-tab token, both validated per request
 *   Section 2  two browser profiles hold two users at once, independently
 *   Section 3  cross-user access is denied on every user-scoped endpoint
 *   Section 4  admin routes cannot be reached by a non-admin session
 *   Section 5  signing out ends THIS browser — token and cookie, both
 *   Section 6  signing out does not touch a DIFFERENT browser profile
 *   Section 7  two users in ONE browser profile still work, and scoped sign-out is honest
 *   Section 8  a password change revokes every credential for that user and nobody else's
 *
 * Section 7 is the distinction that must not be "fixed" wrongly: two tabs in one browser context
 * legitimately SHARE the cookie session, so a sign-out there signing both out is correct. What must
 * never happen is a sign-out reaching across browser profiles, or failing to end the one it is in.
 *
 * Usage:  node scripts/ah1SessionIdentity.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4612;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `ah1-session-identity-${process.pid}`);
const PASSWORD = "Ah1-Harness-pass!9";
const ADMIN_PASSWORD = "Ah1-Harness-admin!9";

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
};

// ── A browser profile ────────────────────────────────────────────────────────────────────────
// The whole task turns on the difference between a credential that is shared per browser profile
// (the cookie) and one that is per tab (the auth-context token), so the harness has to model both
// rather than let a single global fetch blur them. A Profile is a cookie jar; a Tab is a token.
class Profile {
  constructor(name) { this.name = name; this.cookies = new Map(); }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  absorb(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const idx = pair.indexOf("=");
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      // An expiry in the past is a deletion, which is what res.clearCookie sends.
      if (/expires=Thu, 01 Jan 1970/i.test(line) || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
  get lastSetCookieRaw() { return this._raw || []; }
}

async function call(profile, pathname, { method = "GET", token = null, body = null } = {}) {
  const headers = {};
  const cookie = profile?.header();
  if (cookie) headers.cookie = cookie;
  if (token) headers["X-RM-Auth-Context"] = token;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual",
  });
  profile?.absorb(res);
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, json, raw, setCookie: res.headers.getSetCookie?.() ?? [] };
}

const register = (profile, username) => call(profile, "/api/auth/register", {
  method: "POST",
  body: { username, password: PASSWORD, profile: { email: `${username}@example.com`, first_name: username, last_name: "Harness" } },
});
const login = (profile, username, password = PASSWORD) =>
  call(profile, "/api/auth/login", { method: "POST", body: { username, password } });
const whoami = async (profile, token) => {
  const r = await call(profile, "/api/auth/me", { token });
  return r.json?.authenticated ? r.json.user.username : null;
};

// ── boot the real server against a throwaway data directory ──────────────────────────────────
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    RM_DATA_DIR: DATA_DIR,
    PORT: String(PORT),
    NODE_ENV: "development",
    ADMIN_USER: "ah1_admin",
    ADMIN_PASSWORD,
    SESSION_SECRET: "ah1-harness-secret",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", d => { serverLog += d; });
server.stderr.on("data", d => { serverLog += d; });

async function up() {
  try { return (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1200) })).ok; }
  catch { return false; }
}
let ready = false;
for (let i = 0; i < 80; i++) { if (await up()) { ready = true; break; } await sleep(400); }
if (!ready) {
  console.log("FAIL  server did not come up");
  console.log(serverLog.slice(-3000));
  process.exit(1);
}

function shutdown() {
  try { server.kill("SIGKILL"); } catch {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
}
process.on("exit", shutdown);

const authDb = () => new Database(path.join(DATA_DIR, "resume_master.db"), { readonly: true });

try {
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 1. WHAT AUTHENTICATES A REQUEST ─────────────────────────────────────────────");
  // The owner's belief was that cookies are not in use. They are: the durable credential is an
  // HttpOnly connect.sid backed by connect-sqlite3, and the auth-context token is a SECOND,
  // per-tab credential on top of it. Both are validated per request; neither is process memory.
  check("migration 090 applied on a virgin database",
    /090_auth_context_session_binding/.test(serverLog));

  const p1 = new Profile("profile-1");
  const reg = await register(p1, "ah1_alice");
  check("register issues a session cookie AND a per-tab auth-context token",
    reg.status === 200 && !!reg.json?.authContext && reg.setCookie.some(c => /^connect\.sid=/.test(c)),
    `status=${reg.status} token=${!!reg.json?.authContext}`);
  check("the session cookie is HttpOnly, so no script can read the durable credential",
    reg.setCookie.some(c => /^connect\.sid=/.test(c) && /HttpOnly/i.test(c)));
  check("the token is stored server-side as a HASH, never in plaintext",
    (() => {
      const d = authDb();
      const rows = d.prepare("SELECT token_hash FROM auth_contexts").all();
      d.close();
      return rows.length > 0 && rows.every(r => /^[0-9a-f]{64}$/.test(r.token_hash) && r.token_hash !== reg.json.authContext);
    })());
  check("a request with NO credential is anonymous",
    (await call(null, "/api/auth/me")).json?.authenticated === false);
  check("a request with NO credential cannot read user data",
    (await call(null, "/api/profile")).status === 401);
  check("an invented token authenticates nothing",
    (await call(null, "/api/profile", { token: "not-a-real-token" })).status === 401);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 2. TWO BROWSER PROFILES, TWO USERS, AT THE SAME TIME ────────────────────────");
  const p2 = new Profile("profile-2");
  const regB = await register(p2, "ah1_bob");
  const tokenAlice = reg.json.authContext;
  const tokenBob = regB.json.authContext;
  check("profile 1 is alice", await whoami(p1, tokenAlice) === "ah1_alice");
  check("profile 2 is bob", await whoami(p2, tokenBob) === "ah1_bob");
  check("profile 1 is STILL alice while bob is signed in — no ambient current user",
    await whoami(p1, tokenAlice) === "ah1_alice");
  check("each profile's own data comes back, not the other's",
    (await call(p1, "/api/profile", { token: tokenAlice })).json?.email === "ah1_alice@example.com" &&
    (await call(p2, "/api/profile", { token: tokenBob })).json?.email === "ah1_bob@example.com");

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 3. CROSS-USER ACCESS IS DENIED ──────────────────────────────────────────────");
  // Alice is given a row in every user-owned table that has an id-addressable endpoint, then bob
  // asks for it BY THAT ID. A 200 here is the leak; 403/404 is the requirement.
  const aliceId = (await call(p1, "/api/profile", { token: tokenAlice })).json.user_id;
  const bobId = (await call(p2, "/api/profile", { token: tokenBob })).json.user_id;
  check("the two users really are distinct rows", Number.isInteger(aliceId) && aliceId !== bobId);

  const seeded = (() => {
    const d = new Database(path.join(DATA_DIR, "resume_master.db"));
    const ins = (sql, ...a) => { try { return d.prepare(sql).run(...a).lastInsertRowid; } catch { return null; } };
    d.prepare("INSERT OR IGNORE INTO scraped_jobs (job_id,title,company,url) VALUES (?,?,?,?)")
      .run("ah1::job", "Engineer", "Acme", "https://example.invalid/ah1");
    const profileId = ins("INSERT INTO domain_profiles (user_id, profile_name, role_family, domain, is_active) VALUES (?,?,?,?,1)",
      aliceId, "AH1 Alice Profile", "engineering", "engineering");
    const resumeId = ins("INSERT INTO resumes (user_id, job_id, company, role, html) VALUES (?,?,?,?,?)",
      aliceId, "ah1::job", "Acme", "Engineer", "<p>alice-secret-resume</p>");
    const runId = ins("INSERT INTO apply_runs (user_id, mode, status, total_jobs) VALUES (?,?,?,?)", aliceId, "AUTO", "done", 1);
    const runJobId = ins("INSERT INTO apply_run_jobs (run_id, user_id, job_id, status) VALUES (?,?,?,?)", runId, aliceId, "ah1::job", "submitted");
    ins("INSERT INTO job_applications (user_id, job_id, company, role) VALUES (?,?,?,?)", aliceId, "ah1::job", "Acme", "Engineer");
    d.close();
    return { profileId, resumeId, runId, runJobId };
  })();
  check("alice's fixtures were created", !!seeded.profileId && !!seeded.resumeId && !!seeded.runId && !!seeded.runJobId,
    JSON.stringify(seeded));

  // Every user-scoped endpoint that takes an owned id in its path, asserted individually: a leak on
  // any one of them is the whole finding, and folding them into one boolean would hide which.
  const denied = [
    ["GET", `/api/apply/runs/${seeded.runId}`],
    ["GET", `/api/apply/run-jobs/${seeded.runJobId}/review`],
    ["GET", `/api/apply/run-jobs/${seeded.runJobId}/resume`],
    ["GET", `/api/apply/run-jobs/${seeded.runJobId}/screenshot`],
    ["POST", `/api/apply/run-jobs/${seeded.runJobId}/abort`],
    ["DELETE", `/api/apply/run-jobs/${seeded.runJobId}`],
    ["GET", "/api/resumes/ah1::job"],
    ["DELETE", "/api/resumes/ah1::job"],
    ["PATCH", "/api/applications/ah1::job", { company: "bob-was-here" }],
    ["DELETE", "/api/applications/ah1::job"],
    ["GET", `/api/domain-profiles/${seeded.profileId}/base-resume`],
    ["GET", `/api/domain-profiles/${seeded.profileId}/signals`],
    ["GET", `/api/domain-profiles/${seeded.profileId}/suggestions`],
    ["GET", `/api/domain-profiles/${seeded.profileId}/tracked-search`],
    ["GET", `/api/domain-profiles/${seeded.profileId}/enhancement-history`],
    ["GET", `/api/domain-profiles/${seeded.profileId}/enhance-status`],
    ["PUT", `/api/domain-profiles/${seeded.profileId}`, { profileName: "bob-was-here" }],
    ["DELETE", `/api/domain-profiles/${seeded.profileId}`],
    ["POST", `/api/domain-profiles/${seeded.profileId}/activate`],
  ];
  for (const [method, pathname, body = null] of denied) {
    const r = await call(p2, pathname, { method, token: tokenBob, body });
    check(`bob is REFUSED alice's ${method} ${pathname}`,
      r.status === 403 || r.status === 404, `got ${r.status}`);
  }

  // These three legitimately answer 200 for anyone: they are questions about the CALLER ("have I
  // applied to this job", "what versions do I have"), not requests for a named object, so a 404
  // would be the wrong answer and asserting one would pin a wrong requirement. What must hold is
  // that the answer contains nothing of alice's.
  const nonDisclosing = [
    ["GET", "/api/apply/status/ah1::job"],
    ["GET", "/api/resumes/ah1::job/versions"],
    ["GET", "/api/history"],
  ];
  for (const [method, pathname] of nonDisclosing) {
    const r = await call(p2, pathname, { method, token: tokenBob });
    check(`${method} ${pathname} answers bob about BOB and discloses nothing of alice's`,
      r.status === 200 && !/alice-secret-resume/.test(r.raw) && !/Acme/.test(r.raw),
      `status=${r.status} body=${r.raw.slice(0, 90)}`);
  }
  // A denial that also destroyed the row would pass the assertion above and still be the bug.
  check("alice's rows survived every one of bob's attempts",
    (() => {
      const d = authDb();
      const n = ["SELECT COUNT(*) c FROM resumes WHERE user_id=?", "SELECT COUNT(*) c FROM apply_runs WHERE user_id=?",
        "SELECT COUNT(*) c FROM apply_run_jobs WHERE user_id=?", "SELECT COUNT(*) c FROM job_applications WHERE user_id=?",
        "SELECT COUNT(*) c FROM domain_profiles WHERE user_id=?"].map(s => d.prepare(s).get(aliceId).c);
      d.close();
      return n.every(c => c === 1);
    })());
  check("alice can still reach her own run — the denial is about ownership, not a broken route",
    (await call(p1, `/api/apply/runs/${seeded.runId}`, { token: tokenAlice })).status === 200);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 4. ADMIN ROUTES REJECT A NON-ADMIN SESSION ──────────────────────────────────");
  const adminRoutes = [
    "/api/admin/users", "/api/admin/backups", "/api/admin/upgrade-requests",
    "/api/admin/domain-profile-requests", "/api/admin/contact-messages",
    `/api/admin/users/${aliceId}/profile`, `/api/admin/users/${aliceId}/applications`,
    "/api/admin/analytics/overview", "/api/admin/analytics/users", "/api/admin/analytics/spend",
    `/api/admin/analytics/limits/${aliceId}`,
    "/api/admin/db/tables", "/api/admin/db/schema", `/api/admin/db/user-pool/${aliceId}`,
    "/api/admin/db/raw-query?sql=SELECT%201", "/api/admin/db/export/users",
  ];
  let adminDenied = 0;
  for (const pathname of adminRoutes) {
    const r = await call(p2, pathname, { token: tokenBob });
    if (r.status === 403) adminDenied++;
    else check(`non-admin is refused ${pathname}`, false, `got ${r.status}`);
  }
  check(`every admin route refuses a non-admin session (${adminDenied}/${adminRoutes.length})`,
    adminDenied === adminRoutes.length);

  const padmin = new Profile("admin");
  const adminLogin = await login(padmin, "ah1_admin", ADMIN_PASSWORD);
  const tokenAdmin = adminLogin.json?.authContext;
  check("the admin can sign in", adminLogin.status === 200 && !!tokenAdmin);
  check("the admin DOES reach an admin route — the 403s above are about role, not a dead mount",
    (await call(padmin, "/api/admin/users", { token: tokenAdmin })).status === 200);
  check("a non-admin cannot promote themselves through an admin route",
    (await call(p2, `/api/admin/users/${bobId}/plan`, { method: "PATCH", token: tokenBob, body: { planTier: "PRO" } })).status === 403);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 5. SIGNING OUT ENDS THIS BROWSER ────────────────────────────────────────────");
  const p3 = new Profile("profile-3");
  await register(p3, "ah1_carol");
  const carol = await login(p3, "ah1_carol");
  const tokenCarol = carol.json.authContext;
  check("carol is signed in", await whoami(p3, tokenCarol) === "ah1_carol");
  const out = await call(p3, "/api/auth/logout", { method: "POST", token: tokenCarol });
  check("sign-out reports the scope it actually took", out.json?.scope === "browser", JSON.stringify(out.json));
  check("the revoked token authenticates nothing", await whoami(p3, tokenCarol) === null);
  // THE ORIGINAL DEFECT. The cookie is what a hard refresh and every new tab authenticate with,
  // and it used to survive a sign-out for the rest of its seven-day rolling life.
  check("A HARD REFRESH DOES NOT AUTO-AUTHENTICATE: the cookie alone is now anonymous",
    await whoami(p3) === null);
  check("and it cannot read user data either", (await call(p3, "/api/profile")).status === 401);
  check("the cookie session row is gone from the store, not merely ignored",
    (() => {
      const d = new Database(path.join(DATA_DIR, "sessions.db"), { readonly: true });
      const rows = d.prepare("SELECT sess FROM sessions").all();
      d.close();
      const carolId = (() => { const a = authDb(); const r = a.prepare("SELECT id FROM users WHERE username=?").get("ah1_carol"); a.close(); return r.id; })();
      return !rows.some(r => { try { return Number(JSON.parse(r.sess)?.passport?.user) === carolId; } catch { return false; } });
    })());
  check("signing back in works — sign-out ended a session, it did not break the account",
    (await login(p3, "ah1_carol")).status === 200);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 6. SIGN-OUT DOES NOT CROSS BROWSER PROFILES ─────────────────────────────────");
  check("alice is still signed in in profile 1", await whoami(p1, tokenAlice) === "ah1_alice");
  check("bob is still signed in in profile 2", await whoami(p2, tokenBob) === "ah1_bob");
  const outA = await call(p1, "/api/auth/logout", { method: "POST", token: tokenAlice });
  check("alice signs out", outA.status === 200);
  check("alice's profile is anonymous, token and cookie both",
    await whoami(p1, tokenAlice) === null && await whoami(p1) === null);
  check("BOB IS UNAFFECTED — a sign-out is confined to the browser that made it",
    await whoami(p2, tokenBob) === "ah1_bob");
  await login(p1, "ah1_alice");

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 7. TWO USERS IN ONE BROWSER PROFILE ─────────────────────────────────────────");
  // Two tabs in ONE browser context legitimately SHARE the cookie. That is not the bug, and a fix
  // that made it impossible would be a regression. What the per-tab token buys is that a tab can
  // hold a different identity from the cookie — and, in section 5's terms, that signing out of one
  // identity does not silently sign out the other.
  const shared = new Profile("one-browser-two-tabs");
  await register(shared, "ah1_dave");
  await register(shared, "ah1_erin");
  const tabDave = (await login(shared, "ah1_dave")).json.authContext;
  const tabErin = (await login(shared, "ah1_erin")).json.authContext;  // the cookie is now erin's
  check("tab 1 holds dave even though the shared cookie is erin's",
    await whoami(shared, tabDave) === "ah1_dave");
  check("tab 2 holds erin", await whoami(shared, tabErin) === "ah1_erin");
  check("a brand-new tab (empty sessionStorage, cookie only) is the cookie's owner — correct, and shared",
    await whoami(shared) === "ah1_erin");
  check("a write from dave's tab lands on DAVE, not on the cookie's owner",
    (await call(shared, "/api/dock-preferences", { method: "PUT", token: tabDave, body: { itemsOrder: ["quick_actions", "settings"], dockEnabled: true } })).status === 200 &&
    (() => {
      const d = authDb();
      const dave = d.prepare("SELECT id FROM users WHERE username=?").get("ah1_dave").id;
      const rows = d.prepare("SELECT user_id FROM dock_preferences").all();
      d.close();
      return rows.length === 1 && rows[0].user_id === dave;
    })());
  await call(shared, "/api/auth/logout", { method: "POST", token: tabErin });
  check("erin signing out ends erin's tab", await whoami(shared, tabErin) === null);
  check("and ends the shared cookie, so a new tab is anonymous", await whoami(shared) === null);
  check("DAVE'S TAB SURVIVES — his token was issued under a different session",
    await whoami(shared, tabDave) === "ah1_dave");

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 8. A PASSWORD CHANGE REVOKES EVERY CREDENTIAL ───────────────────────────────");
  const d1 = new Profile("bob-laptop");
  const d2 = new Profile("bob-phone");
  const tokenBob1 = (await login(d1, "ah1_bob")).json.authContext;
  const tokenBob2 = (await login(d2, "ah1_bob")).json.authContext;
  check("bob is signed in on two devices",
    await whoami(d1, tokenBob1) === "ah1_bob" && await whoami(d2, tokenBob2) === "ah1_bob");
  const reset = await call(padmin, `/api/admin/users/${bobId}/password`, {
    method: "PATCH", token: tokenAdmin, body: { password: "Ah1-Rotated-pass!9" },
  });
  check("the password change succeeds", reset.status === 200, JSON.stringify(reset.json));
  // No wait here, on purpose. The sweep is awaited inside the route, so by the time the response
  // has been read the credentials are already dead. A sleep would hide a route that answered first
  // and revoked afterwards — which is a real window on a path whose whole job is closing one.
  check("BOTH of bob's devices are signed out — a rotated password locks the account",
    await whoami(d1, tokenBob1) === null && await whoami(d2, tokenBob2) === null);
  check("bob's original browser-2 token is dead too", await whoami(p2, tokenBob) === null);
  check("nobody else was signed out",
    await whoami(padmin, tokenAdmin) === "ah1_admin" && await whoami(p1) === "ah1_alice");
  check("the old password no longer works", (await login(d1, "ah1_bob")).status === 401);
  check("the new password does", (await login(d1, "ah1_bob", "Ah1-Rotated-pass!9")).status === 200);

} catch (e) {
  console.log(`FAIL  harness threw: ${e.message}`);
  console.log(e.stack);
  failures++;
}

console.log("\n" + "=".repeat(96));
console.log(failures ? `${failures} FAILED` : "all checks passed");
console.log("=".repeat(96));
shutdown();
process.exit(failures ? 1 : 0);
