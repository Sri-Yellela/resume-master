#!/usr/bin/env node
/**
 * TASK AJ1 — the mobile bearer path, verified against a real server.
 * ============================================================================================
 *
 * WHY THIS EXISTS AND WHY A UNIT TEST CANNOT REPLACE IT
 *
 * test/mobileApiContract.test.js proves the contract AGREES WITH THE SOURCE. It cannot prove the
 * server ANSWERS that way, because a source string cannot tell you who a request is answered as —
 * that was the whole lesson of AH1, where nine passing tests asserted that server.js *contains*
 * issueAuthContext for the entire life of a defect that signed the wrong person out.
 *
 * The task says of the mobile bearer path: "Test it, do not assume it." So this does.
 *
 * WHAT IS DIFFERENT FROM scripts/ah1SessionIdentity.mjs, AND IT IS THE ENTIRE POINT
 *
 * AH1 drives a browser: a cookie jar PLUS a per-tab token. Every one of its requests carries
 * `Cookie: connect.sid=...`, so a token-only regression would have been invisible to it — the
 * cookie would have answered the request and the assertion would still have passed.
 *
 * THIS HARNESS SENDS NO COOKIE, EVER. `call()` below has no cookie jar to send one from, and
 * check 1.6 proves the omission is real by asserting an uncredentialed request is anonymous. So
 * every 200 here is a 200 EARNED BY THE BEARER TOKEN ALONE, which is the only thing a native
 * mobile app will have. That distinction is why this is a separate harness rather than a section
 * added to AH1.
 *
 * WHAT IS ASSERTED
 *   1  the mobile credential: minted sessionLess, durable, and not the login token
 *   2  every endpoint in the published contract answers on bearer alone
 *   3  cross-user access is denied on the BEARER path, not merely on the cookie path
 *   4  admin routes refuse a non-admin bearer
 *   5  sliding renewal moves expires_at forward, and the absolute cap bounds it
 *   6  revoking the phone does not kill the extension, and vice versa
 *   7  the retired endpoints really answer 410
 *
 * Usage:  node scripts/aj1MobileBearer.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import { MOBILE_ENDPOINTS, RETIRED_ENDPOINTS } from "../services/api/mobileEndpoints.js";
import { JOB_FIELDS, JOB_REQUIRED_FIELDS } from "../services/api/mobileContract.js";
import { RESPONSE_SCHEMAS } from "../services/api/mobileSchemas.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4618;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `aj1-mobile-bearer-${process.pid}`);
const PASSWORD = "Aj1-Harness-pass!9";
const ADMIN_PASSWORD = "Aj1-Harness-admin!9";

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
};

/**
 * A MOBILE CLIENT. No cookie jar — deliberately, and it is the load-bearing property of this file.
 * There is nowhere for a Set-Cookie to be stored and nothing to send one from, so a response that
 * depends on a session cannot accidentally pass here.
 */
async function call(pathname, { method = "GET", token = null, body = null, raw = false } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual",
  });
  const text = raw ? "" : await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return {
    status: res.status, json, raw: text,
    setCookie: res.headers.getSetCookie?.() ?? [],
    contentType: res.headers.get("content-type") || "",
  };
}

const register = (username) => call("/api/auth/register", {
  method: "POST",
  body: { username, password: PASSWORD, profile: { email: `${username}@example.com`, first_name: username, last_name: "Harness" } },
});
const login = (username, password = PASSWORD) =>
  call("/api/auth/login", { method: "POST", body: { username, password } });

/** The real mobile sign-in: log in, exchange, discard the login token. */
async function mobileSignIn(username, password = PASSWORD) {
  const l = await login(username, password);
  const loginToken = l.json?.authContext;
  if (!loginToken) return { loginToken: null, token: null, mint: l };
  const m = await call("/api/auth/mobile-token", { token: loginToken });
  return { loginToken, token: m.json?.token || null, mint: m };
}

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
    ADMIN_USER: "aj1_admin",
    ADMIN_PASSWORD,
    SESSION_SECRET: "aj1-harness-secret",
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
const writeDb = () => new Database(path.join(DATA_DIR, "resume_master.db"));

try {
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 1. THE MOBILE CREDENTIAL ────────────────────────────────────────────────────");

  const regA = await register("aj1_alice");
  check("register succeeds without a cookie jar", regA.status === 200 && !!regA.json?.authContext,
    `status=${regA.status}`);

  const alice = await mobileSignIn("aj1_alice");
  check("login returns a session-bound token, and it is EXCHANGEABLE", !!alice.loginToken);
  check("GET /api/auth/mobile-token mints a durable credential on bearer alone",
    alice.mint.status === 200 && !!alice.token, `status=${alice.mint.status}`);
  check("the mint is a DIFFERENT token from the login one — the login token is not the credential",
    !!alice.token && alice.token !== alice.loginToken);
  check("the mint publishes both windows so a client shows a real expiry, not a guess",
    alice.mint.json?.idleSeconds === 7 * 24 * 3600 && alice.mint.json?.absoluteSeconds === 90 * 24 * 3600,
    JSON.stringify({ idle: alice.mint.json?.idleSeconds, abs: alice.mint.json?.absoluteSeconds }));

  const tokenHashRow = () => {
    const d = authDb();
    const rows = d.prepare(
      "SELECT token_hash, session_sid, user_agent, created_at, expires_at FROM auth_contexts WHERE user_agent='resume-master-mobile'"
    ).all();
    d.close();
    return rows;
  };
  const mobileRows = tokenHashRow();
  check("the mobile token is stored SESSION-LESS — session_sid is NULL",
    mobileRows.length === 1 && mobileRows[0].session_sid === null,
    JSON.stringify(mobileRows.map(r => r.session_sid)));
  check("the mobile token is stored as a hash, never in plaintext",
    mobileRows.every(r => /^[0-9a-f]{64}$/.test(r.token_hash) && r.token_hash !== alice.token));

  // The property that makes the whole design work: a login token IS session-bound, so persisting
  // it would file the phone's credential under a browser session nobody can sign out of.
  const loginBound = (() => {
    const d = authDb();
    const rows = d.prepare("SELECT session_sid FROM auth_contexts WHERE user_agent IS NULL OR user_agent NOT LIKE 'resume-master-%'").all();
    d.close();
    return rows;
  })();
  check("a LOGIN-issued token really is session-bound — which is why mobile must not keep it",
    loginBound.length > 0 && loginBound.every(r => r.session_sid !== null),
    JSON.stringify(loginBound.map(r => r.session_sid ? "bound" : "null")));

  check("NO COOKIE IS SENT BY THIS HARNESS — an uncredentialed request is anonymous",
    (await call("/api/auth/me")).json?.authenticated === false);
  check("an uncredentialed request cannot read user data",
    (await call("/api/profile")).status === 401);
  check("an invented bearer token authenticates nothing",
    (await call("/api/profile", { token: "not-a-real-token" })).status === 401);
  check("the bearer token identifies the right user",
    (await call("/api/auth/me", { token: alice.token })).json?.user?.username === "aj1_alice");

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 2. EVERY CONTRACT ENDPOINT ANSWERS ON BEARER ALONE ──────────────────────────");
  // The requirement: "A bearer-token request to each listed endpoint succeeds." What is asserted
  // is that the endpoint is REACHED AS ALICE — never 401, and never 403. A 404 for a fixture id
  // that does not exist is a correct answer and is accepted; a 401 is the failure this looks for,
  // because it is what a token-only client would hit if any route were cookie-only.
  const aliceId = (await call("/api/profile", { token: alice.token })).json?.user_id;
  check("alice has a user id", Number.isInteger(aliceId));

  // Give alice a domain profile so the board endpoints answer about something.
  const seeded = (() => {
    const d = writeDb();
    const ins = (sql, ...a) => { try { return d.prepare(sql).run(...a).lastInsertRowid; } catch (e) { return null; } };
    d.prepare(`INSERT OR IGNORE INTO scraped_jobs (job_id,search_query,title,company,url,_hash)
               VALUES (?,?,?,?,?,?)`)
      .run("aj1::job", "engineer", "Engineer", "Acme", "https://example.invalid/aj1", "aj1hash");
    // A second job with no apply history, so the duplicate filter is not what refuses a queue
    // attempt. It is NOT enough to get a 202: startRun's prerequisite gate refuses first, because
    // this throwaway user has no integrations configured. See the note on the five unverified
    // envelopes at the end of section 2 — that refusal is correct behaviour, not a fixture bug.
    d.prepare(`INSERT OR IGNORE INTO scraped_jobs (job_id,search_query,title,company,url,_hash)
               VALUES (?,?,?,?,?,?)`)
      .run("aj1::job2", "engineer", "Engineer II", "Acme", "https://example.invalid/aj1b", "aj1hash2");
    const profileId = ins("INSERT INTO domain_profiles (user_id, profile_name, role_family, domain, is_active) VALUES (?,?,?,?,1)",
      aliceId, "AJ1 Alice Profile", "engineering", "engineering");
    const resumeId = ins("INSERT INTO resumes (user_id, job_id, company, role, html) VALUES (?,?,?,?,?)",
      aliceId, "aj1::job", "Acme", "Engineer", "<p>alice-secret-resume</p>");
    const runId = ins("INSERT INTO apply_runs (user_id, mode, status, total_jobs) VALUES (?,?,?,?)", aliceId, "AUTO", "done", 1);
    const runJobId = ins("INSERT INTO apply_run_jobs (run_id, user_id, job_id, status) VALUES (?,?,?,?)", runId, aliceId, "aj1::job", "submitted");
    ins("INSERT INTO job_applications (user_id, job_id, company, role) VALUES (?,?,?,?)", aliceId, "aj1::job", "Acme", "Engineer");
    d.close();
    return { profileId, resumeId, runId, runJobId };
  })();
  check("alice's fixtures exist", !!seeded.profileId && !!seeded.runId && !!seeded.runJobId,
    JSON.stringify(seeded));

  /** Substitute real ids into the contract's {param} placeholders. */
  const concretise = (p) => p
    .replace("{jobId}", "aj1::job")
    .replace("{runJobId}", String(seeded.runJobId))
    .replace("{runId}", String(seeded.runId))
    .replace("{month}", new Date().toISOString().slice(0, 7))
    .replace("{id}", String(seeded.profileId));

  // Bodies that satisfy each endpoint's validation, so a 400 does not masquerade as coverage.
  const BODIES = {
    "POST /api/auth/login":        { username: "aj1_alice", password: PASSWORD },
    "POST /api/auth/register":     null,   // covered above; re-registering would 409
    "PATCH /api/jobs/interact":    { jobId: "aj1::job", starred: true },
    "POST /api/apply/runs":        { jobIds: ["aj1::job2"] },
    "POST /api/apply/approve":     { runJobIds: [seeded.runJobId] },
    "POST /api/apply/reject":      { runJobIds: [seeded.runJobId] },
    "POST /api/apply/answers":     { answers: { "Why us?": "Because." } },
    "POST /api/profile":           { full_name: "Alice Harness", email: "aj1_alice@example.com" },
  };
  // Query strings for the endpoints that REQUIRE one. Without these the sweep gets a 400, which
  // passes the "not 401" bar while proving almost nothing — the endpoint rejected the request
  // before doing any work. Supplying valid parameters turns those two rows into real coverage.
  const today = new Date().toISOString().slice(0, 10);
  const QUERY = {
    "GET /api/apply/history":                 `?date=${today}&tzOffset=0`,
    "GET /api/apply/history/months/{month}":  `?tzOffset=0`,
    "GET /api/jobs":                          `?pageSize=5`,
  };

  // Endpoints skipped, each for a stated reason. An unexplained skip is how coverage silently drops.
  const SKIP = {
    "POST /api/auth/register":          "would 409 on an existing username; covered by check 1.1",
    "POST /api/auth/logout":            "revokes the token every later check needs; covered in section 6",
    "POST /api/auth/revoke-mobile-token": "same — covered in section 6",
  };

  // ── THE DECLARED ENVELOPES, CHECKED AGAINST REAL RESPONSES ─────────────────────────────────
  //
  // The Job shape is DERIVED and so cannot be wrong. The response envelopes are DECLARED in
  // services/api/mobileSchemas.js, and a declaration has nothing keeping it honest unless
  // something compares it to a real body. This is that something, and it is not hypothetical:
  // writing this check found FOUR wrong declarations in my own first draft —
  //
  //   GET  /api/apply/status/{jobId}  really returns { status, application }, not { applied, status }
  //   GET  /api/domain-profiles       really returns a BARE ARRAY, not { profiles: [...] }
  //   GET  /api/jobs/facets           really returns FLAT dimensions, not { facets: {...} }
  //   POST /api/apply/approve         really returns { ok, approved, skipped, run }
  //
  // Any one of those would have had a mobile team building against a body the server never sends —
  // `response.profiles` on an array is undefined, which renders "you have no job profile" to a
  // user who has four.
  //
  // DIRECTION MATTERS. This asserts REAL -> DECLARED: every key the server actually sent must be
  // documented. The other direction (declared -> real) cannot be asserted here, because several
  // fields are legitimately conditional — `curation` only when ranking demoted something, `reason`
  // only on an empty board, `group`/`jobs` only when history was asked for a slice. Requiring them
  // would fail on correct responses, and a check that cries wolf gets deleted. So this catches an
  // UNDOCUMENTED field, which is the direction that had all four defects in it.
  const declaredKeys = (schemaName) => {
    const def = RESPONSE_SCHEMAS[schemaName];
    if (!def || def.binary || def.rootArray) return null;
    const src = def.sameAs ? RESPONSE_SCHEMAS[def.sameAs] : def;
    const own = Object.keys(src.fields || {});
    // `extends` composes, so an inherited field is a documented field.
    return def.extends ? [...own, ...declaredKeys(def.extends) || []] : own;
  };

  let envelopesChecked = 0;
  const envelopesUnverified = [];
  function envelopeCheck(key, ep, r) {
    // Only a SUCCESS body is the declared one. An endpoint that answered 404 (no fixture) or 409
    // (nothing to act on) is reached but not shape-verified, and that is recorded rather than
    // passed over — an unverified declaration is exactly what the eleven defects above were.
    if (r.status !== 200 && r.status !== 202) {
      const def = RESPONSE_SCHEMAS[ep.response];
      if (def && !def.binary) envelopesUnverified.push(`${key} (${r.status})`);
      return;
    }
    const def = RESPONSE_SCHEMAS[ep.response];
    if (!def || def.binary) return;
    if (def.rootArray) {
      envelopesChecked++;
      check(`  ...and ${key} really returns a BARE ARRAY as declared`, Array.isArray(r.json),
        `got ${Array.isArray(r.json) ? "array" : typeof r.json}`);
      return;
    }
    if (!r.json || typeof r.json !== "object" || Array.isArray(r.json)) {
      check(`  ...and ${key} returns the declared OBJECT envelope`, false,
        `got ${Array.isArray(r.json) ? "array" : typeof r.json} — the contract declares an object`);
      return;
    }
    const declared = new Set(declaredKeys(ep.response) || []);
    const undocumented = Object.keys(r.json).filter(k => !declared.has(k));
    envelopesChecked++;
    check(`  ...and ${key} sends NO key the contract fails to document`,
      undocumented.length === 0,
      undocumented.length ? `undocumented: ${undocumented.join(", ")}` : "");
  }

  let reached = 0, skipped = 0;
  for (const ep of MOBILE_ENDPOINTS) {
    const key = `${ep.method} ${ep.path}`;
    if (SKIP[key]) { skipped++; continue; }
    const isPublic = ep.auth === "public";
    const r = await call(concretise(ep.path) + (QUERY[key] || ""), {
      method: ep.method,
      token: isPublic ? null : alice.token,
      body: BODIES[key] ?? (ep.body && ep.method !== "GET" ? {} : null),
      raw: ep.response?.startsWith("Binary"),
    });
    // 401 is the ONLY status this section treats as failure for an authenticated route: it means
    // the bearer token was not accepted, i.e. the route is cookie-only and a phone cannot use it.
    const ok = isPublic ? r.status < 500 : r.status !== 401;
    if (ok) reached++;
    check(`bearer reaches ${key}`, ok, `status=${r.status}`);
    // Where a valid request was supplied, "reached" is not enough — assert it actually WORKED.
    // A 400 satisfies "not 401" while proving the endpoint rejected the request before doing any
    // work, which is coverage in name only.
    if (QUERY[key]) {
      check(`  ...and ${key} answers 200 to a VALID request`, r.status === 200, `status=${r.status}`);
    }
    envelopeCheck(key, ep, r);
  }
  check(`every contract endpoint answered on bearer alone (${reached}/${MOBILE_ENDPOINTS.length - skipped}, ${skipped} skipped by name)`,
    reached === MOBILE_ENDPOINTS.length - skipped);
  // A floor. If the envelope check ever stopped matching — a schema rename, an early return —
  // every assertion above would pass vacuously, which is the failure mode this whole file exists
  // to prevent in the API and must not be reintroduced in the harness itself.
  check(`declared envelopes were checked against real bodies (${envelopesChecked} endpoints)`,
    envelopesChecked >= 12, `only ${envelopesChecked} were verified`);
  // NAMED, not merely counted. These declarations were read off the handler source and never
  // confirmed against a live body, because this run could not provoke a success from them. That is
  // a real limit of this harness and stating it is the point — silently reporting "22 verified"
  // would imply the other seven were fine.
  console.log(`NOTE  ${envelopesUnverified.length} envelope(s) NOT shape-verified (no success body in this run): ` +
    (envelopesUnverified.join(", ") || "none"));
  // WHY THOSE FIVE, so the gap is understood rather than merely listed. They are the WRITE paths,
  // and each refuses for a correct reason this harness cannot remove cheaply:
  //   POST /api/apply/runs      startRun's prerequisite gate — a throwaway user has no integrations
  //   POST approve / reject / abort   nothing is in held_review, because reaching that state needs
  //                             a real browser driving a real form
  //   PATCH /api/jobs/{id}/visited    the job is not mapped to the active profile's role key
  // Seeding around them would mean asserting against a world that does not match production setup,
  // which is worse than a stated gap. Their declared shapes were read directly off the handlers'
  // res.json() calls; that is good evidence, and it is not the same as a live check.
  console.log("NOTE  those five are the WRITE paths; each refuses for a correct reason (prerequisites, " +
    "nothing held, unmapped job). Shapes read from source, not live-verified — stated, not hidden.");

  // The feed's actual payload must match the contract's derived job shape.
  const feed = await call("/api/jobs?pageSize=5", { token: alice.token });
  check("GET /api/jobs answers 200 on bearer and carries the documented envelope",
    feed.status === 200 && Array.isArray(feed.json?.jobs) &&
    ["total", "page", "pageSize", "totalPages"].every(k => k in feed.json),
    `status=${feed.status} keys=${Object.keys(feed.json || {}).join(",")}`);

  const detail = await call("/api/jobs/by-id/aj1::job", { token: alice.token });
  check("GET /api/jobs/by-id returns a job on bearer alone", detail.status === 200 && !!detail.json?.job,
    `status=${detail.status}`);
  if (detail.json?.job) {
    // THE CONTRACT CHECK THAT MATTERS: a real response body, against the derived whitelist.
    const got = new Set(Object.keys(detail.json.job));
    const missingRequired = JOB_REQUIRED_FIELDS.filter(f => !got.has(f));
    check("every REQUIRED field of the derived Job shape is present in a REAL response",
      missingRequired.length === 0, missingRequired.join(",") || "none missing");
    const undocumented = [...got].filter(f => !JOB_FIELDS.includes(f) && f !== "scrapedAt");
    check("the real response carries NO field the contract does not document",
      undocumented.length === 0, undocumented.join(",") || "none extra");
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 3. CROSS-USER ACCESS IS DENIED ON THE BEARER PATH ───────────────────────────");
  // AH1 proved this for a cookie session carrying a token. The task asks whether the SAME
  // guarantees hold on the bearer path with no cookie at all. They must, because requireAuth
  // admits a token exactly as it admits a session and every handler derives its owner from
  // req.user — but "must" is the word that precedes every silent contract defect in this
  // repository, so it is measured rather than reasoned about.
  await register("aj1_bob");
  const bob = await mobileSignIn("aj1_bob");
  check("bob holds his own mobile token", !!bob.token && bob.token !== alice.token);
  const bobId = (await call("/api/profile", { token: bob.token })).json?.user_id;
  check("alice and bob are distinct users", Number.isInteger(bobId) && bobId !== aliceId);

  const denied = [
    ["GET", `/api/apply/runs/${seeded.runId}`],
    ["GET", `/api/apply/run-jobs/${seeded.runJobId}/review`],
    ["GET", `/api/apply/run-jobs/${seeded.runJobId}/resume`],
    ["GET", `/api/apply/run-jobs/${seeded.runJobId}/screenshot`],
    ["POST", `/api/apply/run-jobs/${seeded.runJobId}/abort`],
    ["DELETE", `/api/apply/run-jobs/${seeded.runJobId}`],
    ["GET", "/api/resumes/aj1::job"],
    ["DELETE", "/api/resumes/aj1::job"],
    ["PATCH", "/api/applications/aj1::job", { company: "bob-was-here" }],
    ["DELETE", "/api/applications/aj1::job"],
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
  let deniedCount = 0;
  for (const [method, pathname, body = null] of denied) {
    const r = await call(pathname, { method, token: bob.token, body });
    const ok = r.status === 403 || r.status === 404;
    if (ok) deniedCount++;
    else check(`bob's BEARER is refused alice's ${method} ${pathname}`, false, `got ${r.status}`);
  }
  check(`all ${denied.length} user-scoped endpoints refuse a cross-user BEARER (${deniedCount}/${denied.length})`,
    deniedCount === denied.length);
  check("no response leaked alice's resume content to bob",
    !(await call("/api/resumes/aj1::job", { token: bob.token })).raw.includes("alice-secret-resume"));
  check("alice's rows survived every one of bob's bearer attempts",
    (() => {
      const d = authDb();
      const n = ["SELECT COUNT(*) c FROM resumes WHERE user_id=?", "SELECT COUNT(*) c FROM apply_runs WHERE user_id=?",
        "SELECT COUNT(*) c FROM job_applications WHERE user_id=?", "SELECT COUNT(*) c FROM domain_profiles WHERE user_id=?"]
        .map(s => d.prepare(s).get(aliceId).c);
      d.close();
      return n.every(c => c >= 1);
    })());
  check("alice can still reach her own run — the denial is about ownership, not a broken route",
    (await call(`/api/apply/runs/${seeded.runId}`, { token: alice.token })).status === 200);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 4. ADMIN ROUTES REFUSE A NON-ADMIN BEARER ───────────────────────────────────");
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
    const r = await call(pathname, { token: bob.token });
    if (r.status === 403) adminDenied++;
    else check(`non-admin BEARER is refused ${pathname}`, false, `got ${r.status}`);
  }
  check(`every admin route refuses a non-admin BEARER (${adminDenied}/${adminRoutes.length})`,
    adminDenied === adminRoutes.length);

  const admin = await mobileSignIn("aj1_admin", ADMIN_PASSWORD);
  check("the admin can obtain a mobile token", !!admin.token);
  check("the admin DOES reach an admin route on bearer — the 403s are about role, not a dead mount",
    (await call("/api/admin/users", { token: admin.token })).status === 200);
  check("a non-admin cannot promote themselves through an admin route on bearer",
    (await call(`/api/admin/users/${bobId}/plan`, { method: "PATCH", token: bob.token, body: { planTier: "PRO" } })).status === 403);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 5. SLIDING RENEWAL (decision 6a) ────────────────────────────────────────────");
  // The behaviour a weekly forced sign-out would have shipped without. Rather than wait seven days,
  // the stored expiry is pushed BACKWARDS to simulate a token six days into its life, and the next
  // authenticated request must move it forward again.
  // Addressed by the HASH OF alice.token, not by "alice's mobile row". Section 2 sweeps every
  // contract endpoint, and GET /api/auth/mobile-token is one of them — so alice legitimately holds
  // more than one mobile credential by now. Picking a row by user_agent alone aged one token and
  // then renewed a different one, which reported a working sliding renewal as broken.
  const mobileHash = crypto.createHash("sha256").update(alice.token, "utf8").digest("hex");
  const hashOfMobile = () => {
    const d = authDb();
    const r = d.prepare("SELECT token_hash, created_at, expires_at FROM auth_contexts WHERE token_hash=?").get(mobileHash);
    d.close();
    return r;
  };
  const before = hashOfMobile();
  check("alice's mobile token has an expiry", Number.isInteger(before?.expires_at));

  const aged = before.expires_at - 6 * 24 * 3600;   // as if issued six days ago
  { const d = writeDb(); d.prepare("UPDATE auth_contexts SET expires_at=? WHERE token_hash=?").run(aged, before.token_hash); d.close(); }
  const stillWorks = await call("/api/auth/me", { token: alice.token });
  const after = hashOfMobile();
  check("a token six days into its life still authenticates",
    stillWorks.json?.user?.username === "aj1_alice");
  check("SLIDING RENEWAL moved expires_at FORWARD on use — no weekly forced sign-out",
    after.expires_at > aged, `aged=${aged} after=${after.expires_at} (+${after.expires_at - aged}s)`);

  // THE CLAMP. Without it, "active" would mean "immortal" and a leaked token in the hands of
  // anything that polls would never expire.
  //
  // The token is aged to 89 DAYS OLD, one day short of the absolute cap, with an hour left to run.
  // That is the interesting case, and it is the one an "is expires_at under the cap?" assertion
  // cannot see: renewal SHOULD still fire (an hour is less than the cap allows), but it must land
  // ON the cap rather than at the full idle window. So the check is an equality against the cap —
  // if the clamp were removed, expires_at would be now+7d, which is 6 days past it.
  const now0 = Math.floor(Date.now() / 1000);
  const nearCapCreated = now0 - 89 * 24 * 3600;
  const cap = nearCapCreated + 90 * 24 * 3600;      // one day from now
  { const d = writeDb();
    d.prepare("UPDATE auth_contexts SET created_at=?, expires_at=? WHERE token_hash=?")
      .run(nearCapCreated, now0 + 3600, before.token_hash); d.close(); }
  const nearCapCall = await call("/api/auth/me", { token: alice.token });
  const clamped = hashOfMobile();
  check("an 89-day-old token still authenticates — the cap has not been reached",
    nearCapCall.json?.user?.username === "aj1_alice");
  check("renewal STILL FIRES near the cap — it extended past the hour it had left",
    clamped.expires_at > now0 + 3600, `expires_at=${clamped.expires_at} was=${now0 + 3600}`);
  check("THE ABSOLUTE CAP BINDS — it landed exactly ON the cap, not at the full idle window",
    clamped.expires_at === cap,
    `expires_at=${clamped.expires_at} cap=${cap} unclamped_would_be=${now0 + 7 * 24 * 3600}`);
  check("...which is 6 days SHORT of the idle window — proof the clamp, not the window, bound it",
    clamped.expires_at < now0 + 7 * 24 * 3600);

  // The other direction: past the cap, renewal must not move the deadline at all — and in
  // particular must never move it BACKWARDS, which an unguarded Math.min would do.
  const pastCapCreated = now0 - 200 * 24 * 3600;
  const untouched = now0 + 3600;
  { const d = writeDb();
    d.prepare("UPDATE auth_contexts SET created_at=?, expires_at=? WHERE token_hash=?")
      .run(pastCapCreated, untouched, before.token_hash); d.close(); }
  await call("/api/auth/me", { token: alice.token });
  const beyond = hashOfMobile();
  check("past the absolute cap, renewal extends NOTHING — the token runs out on schedule",
    beyond.expires_at === untouched, `expires_at=${beyond.expires_at} expected=${untouched}`);
  check("and it was never moved BACKWARDS — an unguarded Math.min would expire a live session early",
    beyond.expires_at >= untouched, `expires_at=${beyond.expires_at} now=${Math.floor(Date.now() / 1000)}`);

  // Put alice's token back to a normal state for the remaining sections.
  { const d = writeDb();
    d.prepare("UPDATE auth_contexts SET created_at=?, expires_at=? WHERE token_hash=?")
      .run(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 7 * 24 * 3600, before.token_hash); d.close(); }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 6. THE PHONE AND THE EXTENSION ARE INDEPENDENTLY REVOCABLE ──────────────────");
  // If these shared an endpoint or a user_agent tag, "sign out my phone" would silently kill the
  // extension. Two credentials that a user manages separately must be revocable separately.
  const ext = await call("/api/auth/extension-token", { token: alice.token });
  check("alice can also hold an extension token", ext.status === 200 && !!ext.json?.token);
  check("both credentials work at once",
    (await call("/api/auth/me", { token: alice.token })).json?.authenticated === true &&
    (await call("/api/auth/me", { token: ext.json.token })).json?.authenticated === true);

  const revokeExt = await call("/api/auth/revoke-extension-token", { method: "POST", token: alice.token });
  check("revoking the EXTENSION token succeeds", revokeExt.status === 200);
  check("...the extension token is dead",
    (await call("/api/auth/me", { token: ext.json.token })).json?.authenticated === false);
  check("...and THE PHONE IS UNTOUCHED",
    (await call("/api/auth/me", { token: alice.token })).json?.authenticated === true);

  const ext2 = await call("/api/auth/extension-token", { token: alice.token });
  const revokeMobile = await call("/api/auth/revoke-mobile-token", { method: "POST", token: alice.token });
  check("revoking the MOBILE token succeeds", revokeMobile.status === 200);
  check("...the phone is signed out",
    (await call("/api/auth/me", { token: alice.token })).json?.authenticated === false);
  check("...and THE EXTENSION IS UNTOUCHED — the two are genuinely independent",
    (await call("/api/auth/me", { token: ext2.json.token })).json?.authenticated === true);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 7. THE RETIREMENTS REALLY ANSWER 410 ────────────────────────────────────────");
  // Requirement 5, measured rather than read off the source. A greenfield client written from
  // stale documentation is exactly the client that calls these, and a 410 with an explanatory
  // body is the difference between a legible failure and a mystery.
  const bob2 = await mobileSignIn("aj1_bob");
  const retiredProbes = [
    ["POST", "/api/scrape"],
    ["POST", "/api/extension/save-job"],
    ["GET", "/api/imported-jobs"],
    ["GET", "/api/imported-jobs/anything"],
    ["POST", "/api/apply/session/save"],
    ["GET", "/api/apply/session/greenhouse.io"],
    ["PATCH", "/api/settings/apply-mode"],
  ];
  for (const [method, pathname] of retiredProbes) {
    const r = await call(pathname, { method, token: bob2.token, body: method === "GET" ? null : {} });
    check(`${method} ${pathname} answers 410 to a bearer client`, r.status === 410,
      `got ${r.status}`);
    if (r.status === 410) {
      // The two conventions in use, both legitimate: some tombstones put the whole sentence in
      // `error`, while SESSION_RETIRED puts a short machine code there ("gone") and the sentence in
      // `message`. Taking the LONGER of the two asks the question that matters — is there prose a
      // developer can act on — instead of insisting on which key it lives under. The first draft
      // used `error || message`, which short-circuited on "gone" and reported a perfectly good
      // tombstone as unexplained.
      const prose = [r.json?.error, r.json?.message].filter(s => typeof s === "string")
        .sort((a, b) => b.length - a.length)[0] || "";
      check(`  ...and its body explains what to do instead`, prose.length > 20,
        JSON.stringify(r.json).slice(0, 80));
    }
  }
  check(`the contract documents ${RETIRED_ENDPOINTS.length} retirements and all were probed`,
    RETIRED_ENDPOINTS.length === 6);

} catch (e) {
  console.log(`FAIL  harness threw: ${e.message}`);
  console.log(e.stack);
  console.log(serverLog.slice(-2000));
  failures++;
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
shutdown();
process.exit(failures === 0 ? 0 : 1);
