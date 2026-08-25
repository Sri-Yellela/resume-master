#!/usr/bin/env node
/**
 * TASK AH1 — screenshot evidence, in a REAL browser.
 * ============================================================================================
 * scripts/ah1SessionIdentity.mjs proves the identity guarantees over HTTP. HTTP cannot show the
 * thing the owner actually reported, which was about the UI: "a hard refresh auto-authenticates",
 * and "two different users cannot be signed in in two tabs". So this drives real Chrome against
 * the real app in TWO INDEPENDENT BROWSER CONTEXTS — separate cookie jars, which is what two
 * browser profiles are — and photographs four states:
 *
 *   1  profile A signed in as one user
 *   2  profile B signed in as a DIFFERENT user, at the same moment
 *   3  profile A after signing out AND HARD-RELOADING — the defect's exact reproduction step
 *   4  profile B, still signed in, unaffected by A's sign-out
 *
 * Shot 3 is the whole task. Before the fix, /api/auth/logout revoked only the tab's auth-context
 * token and left the connect.sid session alive, so this reload came back into the application.
 *
 * Runs against the built client on :3001 (npm run build first), not the vite dev server, so what
 * is photographed is what ships. Creates ONE temporary user and deletes it on the way out.
 *
 * Usage:  node scripts/ah1IdentityShots.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";
import { resolveBrowserExecutable } from "../services/browserLauncher.js";
import { hashPassword } from "../services/authSecurity.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "data", "screenshots", "ah1");
const PORT = 3001;
const BASE = `http://localhost:${PORT}`;
const DB_PATH = path.join(ROOT, "data", "resume_master.db");

// User A is the existing A5 fixture account, which has a profile and a base resume so the app
// renders a real board rather than an onboarding prompt.
const USER_A = { username: "johndoe", password: "A5-fixture-pass!" };
// User B is created here and removed at the end, because proving two IDENTITIES needs two.
const USER_B = { username: "ah1_second", password: "Ah1-Shots-pass!9" };

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
};

// ── temporary second user ────────────────────────────────────────────────────────────────────
function seedUserB() {
  const db = new Database(DB_PATH);
  db.pragma("foreign_keys = ON");
  removeUserB(db);
  const userId = db.prepare(
    "INSERT INTO users (username, password_hash, is_admin, apply_mode, plan_tier) VALUES (?, ?, 0, 'TAILORED', 'PRO')"
  ).run(USER_B.username, hashPassword(USER_B.password)).lastInsertRowid;
  db.prepare(`INSERT INTO user_profile (user_id, full_name, first_name, last_name, email)
              VALUES (?, ?, ?, ?, ?)`)
    .run(userId, "Ada Second", "Ada", "Second", "ada.second@example.invalid");
  const dpId = db.prepare(
    "INSERT INTO domain_profiles (user_id, profile_name, role_family, domain, is_active) VALUES (?, ?, ?, ?, 1)"
  ).run(userId, "AH1 Second Candidate", "engineering", "engineering").lastInsertRowid;
  // The board needs BOTH a profile and a base resume, or it renders an onboarding prompt instead
  // of listings — and an onboarding prompt is not evidence about identity.
  const source = db.prepare(`
    SELECT content FROM profile_base_resumes ORDER BY LENGTH(content) DESC LIMIT 1
  `).get();
  db.prepare(`INSERT INTO profile_base_resumes (profile_id, user_id, name, content, updated_at)
              VALUES (?, ?, ?, ?, unixepoch())`)
    .run(dpId, userId, "ah1-second-resume.txt", source?.content || "Ada Second\nSoftware Engineer\n");
  // target_titles drives the board's filter; empty means "Showing 0 of N".
  try {
    db.prepare("UPDATE domain_profiles SET target_titles=? WHERE id=?")
      .run(JSON.stringify(["Software Engineer", "Backend Engineer"]), dpId);
  } catch {}
  db.close();
  console.log(`seeded ${USER_B.username} (user ${userId}, domain profile ${dpId})`);
  return userId;
}
function removeUserB(open) {
  const db = open || new Database(DB_PATH);
  const row = db.prepare("SELECT id FROM users WHERE username=?").get(USER_B.username);
  if (row) {
    for (const t of ["profile_base_resumes", "dock_preferences", "user_jobs", "user_profile",
      "auth_contexts", "domain_profiles", "resumes", "job_applications", "apply_run_jobs", "apply_runs"]) {
      try { db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(row.id); } catch {}
    }
    db.prepare("DELETE FROM users WHERE id=?").run(row.id);
  }
  if (!open) db.close();
}

// ── server ───────────────────────────────────────────────────────────────────────────────────
async function serverUp() {
  try { return (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; }
  catch { return false; }
}
let server = null;
async function startServer() {
  if (await serverUp()) { console.log(`server already listening on :${PORT}`); return; }
  server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT, env: { ...process.env, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 60; i++) { if (await serverUp()) return; await sleep(500); }
  throw new Error("server did not come up");
}

// Sign in the way the app does: POST /api/auth/login, then put the returned auth context in THIS
// context's sessionStorage. Doing it in-page rather than through the form keeps the shot about
// identity rather than about the login form, and it is the same two credentials either way.
async function signIn(page, { username, password }) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async (u, p) => {
    const r = await fetch("/api/auth/login", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p }),
    });
    const d = await r.json();
    if (d.authContext) sessionStorage.setItem("rm_auth_context", d.authContext);
    return { status: r.status, username: d?.user?.username || null };
  }, username, password);
  await page.goto(`${BASE}/app`, { waitUntil: "networkidle2" });
  await sleep(2500);
  return result;
}

async function identityOnPage(page) {
  return page.evaluate(async () => {
    const r = await fetch("/api/auth/me", {
      credentials: "include",
      headers: (() => {
        const t = sessionStorage.getItem("rm_auth_context");
        return t ? { "X-RM-Auth-Context": t } : {};
      })(),
    });
    const d = await r.json();
    return { authenticated: !!d.authenticated, username: d?.user?.username || null, path: location.pathname };
  });
}

async function shot(page, name, caption) {
  // Stamp the caption into the page so the PNG is self-describing — a screenshot of an app that
  // does not say which of four states it is has to be trusted rather than read.
  await page.evaluate((text) => {
    document.getElementById("__ah1_caption__")?.remove();
    const el = document.createElement("div");
    el.id = "__ah1_caption__";
    el.textContent = text;
    Object.assign(el.style, {
      position: "fixed", top: "0", left: "0", right: "0", zIndex: "2147483647",
      background: "#0b1120", color: "#e2e8f0", font: "600 13px/1.5 ui-monospace, monospace",
      padding: "8px 14px", borderBottom: "2px solid #38bdf8", letterSpacing: "0.02em",
    });
    document.body.appendChild(el);
  }, caption);
  await sleep(350);
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  shot  ${path.relative(ROOT, file)}`);
  return file;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("=== AH1 — two browser profiles, two identities, one sign-out ===\n");

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error("No Chrome binary."); process.exit(1); }

  seedUserB();
  await startServer();
  console.log(`server   ${BASE}\n`);

  const browser = await puppeteer.launch({
    executablePath: resolution.path, headless: "new", pipe: true,
    args: ["--no-first-run", "--no-default-browser-check"],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  });

  try {
    // Two independent BrowserContexts. Separate cookie jars and separate storage — which is
    // exactly what two browser profiles, or a normal plus a private window, are to the server.
    const ctxA = await browser.createBrowserContext();
    const ctxB = await browser.createBrowserContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    for (const [name, p] of [["A", pageA], ["B", pageB]]) {
      p.on("pageerror", e => console.log(`      [${name} page error] ${e.message}`));
    }

    const inA = await signIn(pageA, USER_A);
    check(`profile A signs in as ${USER_A.username}`, inA.username === USER_A.username, JSON.stringify(inA));
    const inB = await signIn(pageB, USER_B);
    check(`profile B signs in as ${USER_B.username}`, inB.username === USER_B.username, JSON.stringify(inB));

    const whoA1 = await identityOnPage(pageA);
    const whoB1 = await identityOnPage(pageB);
    check("both profiles are signed in AT THE SAME TIME, as different people",
      whoA1.username === USER_A.username && whoB1.username === USER_B.username,
      `A=${whoA1.username} B=${whoB1.username}`);
    check("neither profile is bounced to /login",
      whoA1.path.startsWith("/app") && whoB1.path.startsWith("/app"),
      `A=${whoA1.path} B=${whoB1.path}`);

    await shot(pageA, "1-profile-A-signed-in",
      `AH1 · 1/4 · BROWSER PROFILE A — signed in as "${whoA1.username}"  (path ${whoA1.path})`);
    await shot(pageB, "2-profile-B-signed-in-simultaneously",
      `AH1 · 2/4 · BROWSER PROFILE B, AT THE SAME MOMENT — signed in as "${whoB1.username}"  (path ${whoB1.path})`);

    // ── the defect's reproduction step ──────────────────────────────────────────────────────
    const out = await pageA.evaluate(async () => {
      const t = sessionStorage.getItem("rm_auth_context");
      const r = await fetch("/api/auth/logout", {
        method: "POST", credentials: "include",
        headers: t ? { "X-RM-Auth-Context": t } : {},
      });
      sessionStorage.removeItem("rm_auth_context");
      return { status: r.status, body: await r.json().catch(() => ({})) };
    });
    check("profile A's sign-out reports it took the whole browser",
      out.body?.scope === "browser", JSON.stringify(out));

    // HARD reload, cache bypassed, with an EMPTY sessionStorage — the state a new tab is in, and
    // the state that used to walk straight back into the application on the cookie alone.
    await pageA.goto(`${BASE}/app`, { waitUntil: "networkidle2" });
    await sleep(2500);
    const whoA2 = await identityOnPage(pageA);
    check("A HARD REFRESH AFTER SIGN-OUT DOES NOT AUTO-AUTHENTICATE",
      whoA2.authenticated === false, JSON.stringify(whoA2));
    check("and profile A is sitting on /login, not inside the app",
      whoA2.path.startsWith("/login"), `path=${whoA2.path}`);
    await shot(pageA, "3-profile-A-hard-refresh-after-signout",
      `AH1 · 3/4 · PROFILE A after SIGN OUT + HARD REFRESH — authenticated=${whoA2.authenticated}, ` +
      `path ${whoA2.path}   (before the fix this came back INTO the app)`);

    const whoB2 = await identityOnPage(pageB);
    check("PROFILE B IS UNTOUCHED — a sign-out does not cross browser profiles",
      whoB2.authenticated === true && whoB2.username === USER_B.username, JSON.stringify(whoB2));
    await pageB.reload({ waitUntil: "networkidle2" });
    await sleep(2000);
    const whoB3 = await identityOnPage(pageB);
    check("and B survives its own hard refresh — a VALID session still restores, as it should",
      whoB3.username === USER_B.username, JSON.stringify(whoB3));
    await shot(pageB, "4-profile-B-unaffected",
      `AH1 · 4/4 · PROFILE B, after A signed out and after its OWN hard refresh — ` +
      `still "${whoB3.username}", path ${whoB3.path}`);

  } finally {
    await browser.close().catch(() => {});
    if (server) { try { server.kill("SIGKILL"); } catch {} }
    removeUserB();
    console.log(`removed ${USER_B.username}`);
  }

  console.log("\n" + "=".repeat(96));
  console.log(failures ? `${failures} FAILED` : `all checks passed — shots in ${path.relative(ROOT, OUT_DIR)}`);
  console.log("=".repeat(96));
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.log(`FAIL  ${e.message}`); console.log(e.stack); removeUserB(); process.exit(1); });
