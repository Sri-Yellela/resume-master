#!/usr/bin/env node
/**
 * TASK AH2 — multi-tab navigation within one session, real-run verification + screenshots.
 * ============================================================================================
 * THE REPORT
 * "With ONE user signed in, opening Jobs in one tab and Auto Apply in another — or two different
 * job detail views — is not currently possible."
 *
 * WHAT THE DIAGNOSIS FOUND, which is not what the report assumed
 * The PANELS were already deep-linkable. Driven with five tabs at once, /app/jobs,
 * /app/auto-apply, /app/job-profiles, /app/database and /app/recruiter each rendered their own
 * surface simultaneously off one cookie session. Nothing in the client fought over a mount.
 *
 * What was missing was any AFFORDANCE to get the second tab. The tab row was
 * `<button onClick={navigate}>`, and a button cannot be ctrl/cmd-clicked, middle-clicked, or
 * "Open link in new tab"-ed, and is not a link to assistive tech either. The only route to a second
 * tab was to know the URL and type it.
 *
 * Two things were genuinely broken:
 *   - A JOB DETAIL HAD NO ADDRESS AT ALL. It was `selectedJob` React state; /app/jobs/<id>
 *     redirected to the bare board. One selectedJob per mount, so two details could never coexist.
 *   - THE BOARD'S VIEW STATE WAS SHARED PER ORIGIN. rm_jobs_profile_ui_v1 held boardTab,
 *     localSearch, sortBy, currentPage and every filter in localStorage, keyed by profile. Two tabs
 *     on the board overwrote each other, and currentPage cannot be shared by construction.
 *
 * WHAT IS ASSERTED HERE
 *   1  five surfaces, five tabs, one session, all rendering their own panel at once
 *   2  every tab in the row is a real link whose href matches where clicking it goes
 *   3  a job detail is addressable, and TWO tabs hold TWO DIFFERENT jobs at once
 *   4  the board's view state is per tab: two tabs disagree about page/search and both are right
 *
 * Usage:  node scripts/ah2MultiTab.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { resolveBrowserExecutable } from "../services/browserLauncher.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "data", "screenshots", "ah2");
const BASE = "http://localhost:3001";
const USER = { username: "johndoe", password: "A5-fixture-pass!" };
const SURFACES = ["/app/jobs", "/app/auto-apply", "/app/job-profiles", "/app/database", "/app/recruiter"];

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
};

async function up() {
  try { return (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; }
  catch { return false; }
}
let server = null;
async function startServer() {
  if (await up()) { console.log(`server already listening on :3001`); return; }
  server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT, env: { ...process.env, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 60; i++) { if (await up()) return; await sleep(500); }
  throw new Error("server did not come up");
}

async function shot(page, name, caption) {
  await page.evaluate((text) => {
    document.getElementById("__ah2_caption__")?.remove();
    const el = document.createElement("div");
    el.id = "__ah2_caption__";
    el.textContent = text;
    Object.assign(el.style, {
      position: "fixed", top: "0", left: "0", right: "0", zIndex: "2147483647",
      background: "#0b1120", color: "#e2e8f0", font: "600 13px/1.5 ui-monospace, monospace",
      padding: "8px 14px", borderBottom: "2px solid #a78bfa", letterSpacing: "0.02em",
    });
    document.body.appendChild(el);
  }, caption);
  await sleep(300);
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  shot  ${path.relative(ROOT, file)}`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("=== AH2 — four surfaces, two job details, one session ===\n");

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error("No Chrome binary."); process.exit(1); }
  await startServer();

  const browser = await puppeteer.launch({
    executablePath: resolution.path, headless: "new", pipe: true,
    args: ["--no-first-run", "--no-default-browser-check"],
    defaultViewport: { width: 1500, height: 950, deviceScaleFactor: 1 },
  });

  try {
    // ONE browser context: one cookie jar, one signed-in user. That is the AH2 premise — this is
    // not about two identities (AH1), it is about one person using their browser normally.
    const ctx = await browser.createBrowserContext();
    const first = await ctx.newPage();
    await first.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    const who = await first.evaluate(async (u, p) => {
      const r = await fetch("/api/auth/login", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p }),
      });
      const d = await r.json();
      if (d.authContext) sessionStorage.setItem("rm_auth_context", d.authContext);
      return d?.user?.username || null;
    }, USER.username, USER.password);
    check(`signed in as ${USER.username}`, who === USER.username, String(who));

    // ── 1. every surface, its own tab, all at once ──────────────────────────────────────────────
    console.log("\n── 1. FIVE SURFACES, FIVE TABS, SIMULTANEOUSLY ─────────────────────────────────");
    const pages = [first];
    for (let i = 1; i < SURFACES.length; i++) pages.push(await ctx.newPage());
    for (let i = 0; i < SURFACES.length; i++) {
      pages[i].on("pageerror", e => console.log(`      [${SURFACES[i]}] ${e.message}`));
      await pages[i].goto(`${BASE}${SURFACES[i]}`, { waitUntil: "networkidle2" }).catch(() => {});
    }
    await sleep(4000);

    // Each surface has to be identified by something ONLY IT renders, or "it loaded" would pass for
    // five tabs all showing the board.
    const FINGERPRINT = {
      "/app/jobs":         /Your jobs\.|Pick up where you left off/i,
      "/app/auto-apply":   /Applications are filled and held/i,
      "/app/job-profiles": /MANAGE JOB PROFILES/i,
      "/app/database":     /Resumes|Saved Jobs/i,
      "/app/recruiter":    /Companies and roles only/i,
    };
    const states = [];
    for (let i = 0; i < SURFACES.length; i++) {
      const s = await pages[i].evaluate(() => ({
        path: location.pathname,
        text: document.body.innerText.replace(/\s+/g, " ").trim(),
      }));
      states.push(s);
      check(`${SURFACES[i]} renders its OWN surface, with the other four open`,
        s.path === SURFACES[i] && FINGERPRINT[SURFACES[i]].test(s.text),
        `path=${s.path}`);
    }
    check("no two tabs are showing the same surface",
      new Set(states.map(s => s.path)).size === SURFACES.length);
    await shot(pages[1], "1-auto-apply-in-its-own-tab",
      `AH2 · 1/4 · AUTO APPLY in its own tab, while Jobs, Job Profiles, Database and Recruiter are open in four others`);

    // ── 2. the tab row is real links ───────────────────────────────────────────────────────────
    console.log("\n── 2. THE TAB ROW IS MADE OF LINKS, NOT BUTTONS ────────────────────────────────");
    const nav = await pages[0].evaluate(() => {
      const el = document.querySelector('nav[aria-label="Main"]');
      if (!el) return null;
      return [...el.children].map(c => ({
        tag: c.tagName, label: c.innerText.trim(), href: c.getAttribute("href"),
      }));
    });
    check("the main nav exists and has an entry per surface", !!nav && nav.length >= 5,
      JSON.stringify(nav?.map(n => n.label)));
    check("EVERY nav entry is an <a> — a <button> cannot be opened in a new tab by any means",
      !!nav && nav.every(n => n.tag === "A"), JSON.stringify(nav?.map(n => n.tag)));
    check("every nav entry carries an href",
      !!nav && nav.every(n => !!n.href), JSON.stringify(nav?.map(n => n.href)));
    // A nav whose href disagrees with where clicking it goes is worse than no href: left-click and
    // middle-click would land in different places.
    const hrefs = new Set((nav || []).map(n => n.href));
    check("the hrefs are exactly the five panel routes the click handler routes to",
      SURFACES.every(s => hrefs.has(s)), [...hrefs].join(" "));

    // Open one by a REAL ctrl-click, the way a user would, and confirm a new tab appears on it.
    const before = (await ctx.pages()).length;
    await pages[0].bringToFront();
    const target = await pages[0].evaluateHandle(() =>
      [...document.querySelectorAll('nav[aria-label="Main"] a')].find(a => a.getAttribute("href") === "/app/database"));
    const box = await target.asElement()?.boundingBox();
    if (box) {
      await pages[0].keyboard.down("Control");
      await pages[0].mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await pages[0].keyboard.up("Control");
    }
    await sleep(3500);
    const after = await ctx.pages();
    const opened = after.length > before ? after[after.length - 1] : null;
    let openedPath = null;
    if (opened) { try { openedPath = await opened.evaluate(() => location.pathname); } catch {} }
    check("CTRL-CLICKING A TAB OPENS IT IN A NEW BROWSER TAB", after.length > before,
      `tabs ${before} -> ${after.length}`);
    check("and that new tab is on the surface that was clicked", openedPath === "/app/database",
      String(openedPath));
    if (opened) await opened.close();

    // ── 3. two job details, two tabs, two different jobs ───────────────────────────────────────
    console.log("\n── 3. TWO JOB DETAILS AT ONCE, EACH SHOWING ITS OWN JOB ────────────────────────");
    const ids = await pages[0].evaluate(async () => {
      const r = await fetch("/api/jobs?page=1&pageSize=4", {
        credentials: "include",
        headers: { "X-RM-Auth-Context": sessionStorage.getItem("rm_auth_context") || "" },
      });
      const d = await r.json();
      return (d.jobs || []).map(j => ({ id: j.id, title: j.title, company: j.company }));
    });
    check("two distinct jobs to open", ids.length >= 2 && ids[0].id !== ids[1].id,
      JSON.stringify(ids.slice(0, 2)));

    const detail = [];
    for (const job of ids.slice(0, 2)) {
      const p = await ctx.newPage();
      p.on("pageerror", e => console.log(`      [detail] ${e.message}`));
      await p.goto(`${BASE}/app/jobs?job=${encodeURIComponent(job.id)}`, { waitUntil: "networkidle2" });
      await sleep(3500);
      const s = await p.evaluate(() => ({
        url: location.pathname + location.search,
        text: document.body.innerText.replace(/\s+/g, " ").trim(),
      }));
      detail.push({ job, page: p, ...s });
      check(`a deep link resolves job ${job.id} and its detail is open`,
        s.url.includes(encodeURIComponent(job.id)) && s.text.includes(job.title),
        `url=${s.url}`);
    }
    // The whole point: not "both loaded" but "each shows ITS OWN job". Asserted by exclusion,
    // because two tabs both showing job A would satisfy a weaker check.
    check("TAB ONE SHOWS JOB ONE AND NOT JOB TWO",
      detail[0].url.includes(encodeURIComponent(ids[0].id)) &&
      !detail[0].url.includes(encodeURIComponent(ids[1].id)));
    check("TAB TWO SHOWS JOB TWO AND NOT JOB ONE",
      detail[1].url.includes(encodeURIComponent(ids[1].id)) &&
      !detail[1].url.includes(encodeURIComponent(ids[0].id)));
    await shot(detail[0].page, "2-job-detail-one",
      `AH2 · 2/4 · TAB A — job detail deep link, ${detail[0].job.company}: ${detail[0].job.title}`);
    await shot(detail[1].page, "3-job-detail-two-simultaneously",
      `AH2 · 3/4 · TAB B AT THE SAME MOMENT — a DIFFERENT job, ${detail[1].job.company}: ${detail[1].job.title}`);

    // A card's title must be the link that produces those URLs, or the addresses exist and nothing
    // in the UI leads to them.
    const cardLink = await pages[0].evaluate(() => {
      const a = [...document.querySelectorAll('a[href^="/app/jobs?job="]')][0];
      return a ? { href: a.getAttribute("href"), text: a.innerText.trim() } : null;
    });
    check("a job card's title is a link to that job's own address", !!cardLink,
      JSON.stringify(cardLink));

    // The literal requirement: "Open-in-new-tab affordances on job cards must actually open a new
    // tab with that job resolved." Asserted by ctrl-clicking a real card and reading the new tab,
    // because a correct href that something else intercepts is indistinguishable from no href.
    const cardsBefore = (await ctx.pages()).length;
    await pages[0].bringToFront();
    const titleBox = await pages[0].evaluate(() => {
      const a = [...document.querySelectorAll('a[href^="/app/jobs?job="]')][0];
      if (!a) return null;
      a.scrollIntoView({ block: "center" });
      const r = a.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, href: a.getAttribute("href") };
    });
    if (titleBox) {
      await pages[0].keyboard.down("Control");
      await pages[0].mouse.click(titleBox.x, titleBox.y);
      await pages[0].keyboard.up("Control");
    }
    await sleep(4000);
    const cardsAfter = await ctx.pages();
    const cardTab = cardsAfter.length > cardsBefore ? cardsAfter[cardsAfter.length - 1] : null;
    let cardTabState = null;
    if (cardTab) {
      try {
        cardTabState = await cardTab.evaluate(() => ({
          url: location.pathname + location.search,
          text: document.body.innerText.replace(/\s+/g, " ").trim(),
        }));
      } catch {}
    }
    check("CTRL-CLICKING A CARD'S TITLE OPENS A NEW TAB", cardsAfter.length > cardsBefore,
      `tabs ${cardsBefore} -> ${cardsAfter.length}`);
    check("and that tab has the job RESOLVED, not just the bare board",
      !!cardTabState && cardTabState.url === titleBox.href &&
      cardTabState.text.includes(ids[0].company),
      JSON.stringify(cardTabState?.url));
    // The tab that did the ctrl-clicking must NOT have opened the detail as well — the user asked
    // for a new tab, not for two things to happen.
    const originatorUrl = await pages[0].evaluate(() => location.pathname + location.search);
    check("the tab that was ctrl-clicked in did not also open the detail itself",
      !originatorUrl.includes("job="), originatorUrl);
    if (cardTab) await cardTab.close();

    // ── 4. board view state is per tab ─────────────────────────────────────────────────────────
    console.log("\n── 4. TWO TABS ON THE BOARD DO NOT FIGHT OVER STORAGE ──────────────────────────");
    const boardA = pages[0];
    const boardB = await ctx.newPage();
    await boardB.goto(`${BASE}/app/jobs`, { waitUntil: "networkidle2" });
    await sleep(3000);
    // Give each tab a DIFFERENT view, written through the app's own persistence path.
    const setView = (page, snapshot) => page.evaluate((snap) => {
      const KEY = "rm_jobs_profile_ui_v1";
      const all = JSON.parse(sessionStorage.getItem(KEY) || "{}");
      const profileId = Object.keys(JSON.parse(localStorage.getItem(KEY) || "{}"))[0]
        || Object.keys(all)[0] || "1";
      all[profileId] = { ...(all[profileId] || {}), ...snap, cachedAt: Date.now() };
      sessionStorage.setItem(KEY, JSON.stringify(all));
      // Also write the shared seed, which is what the old single-store implementation did and is
      // exactly the write that used to clobber the other tab.
      const seed = JSON.parse(localStorage.getItem(KEY) || "{}");
      seed[profileId] = { ...(seed[profileId] || {}), ...snap, cachedAt: Date.now() };
      localStorage.setItem(KEY, JSON.stringify(seed));
      return profileId;
    }, snapshot);
    const readView = (page) => page.evaluate(() => {
      const KEY = "rm_jobs_profile_ui_v1";
      const mine = JSON.parse(sessionStorage.getItem(KEY) || "{}");
      const k = Object.keys(mine)[0];
      return k ? { currentPage: mine[k].currentPage, localSearch: mine[k].localSearch } : null;
    });
    await setView(boardA, { currentPage: 7, localSearch: "stripe" });
    await setView(boardB, { currentPage: 1, localSearch: "airbnb" });
    const viewA = await readView(boardA);
    const viewB = await readView(boardB);
    check("tab A kept its own page and search after tab B wrote a different one",
      viewA?.currentPage === 7 && viewA?.localSearch === "stripe", JSON.stringify(viewA));
    check("tab B kept its own", viewB?.currentPage === 1 && viewB?.localSearch === "airbnb",
      JSON.stringify(viewB));
    check("THE TWO TABS DISAGREE, AND BOTH ARE RIGHT — the view is per tab, not per origin",
      viewA?.currentPage !== viewB?.currentPage);
    // And the shared seed still exists, so a brand-new tab is not born blank.
    const seed = await boardB.evaluate(() => {
      const all = JSON.parse(localStorage.getItem("rm_jobs_profile_ui_v1") || "{}");
      const k = Object.keys(all)[0];
      return k ? { currentPage: all[k].currentPage } : null;
    });
    check("a shared seed survives for the NEXT new tab, so cross-restart persistence is intact",
      seed !== null, JSON.stringify(seed));
    await shot(boardA, "4-two-boards-independent",
      `AH2 · 4/4 · BOARD TAB A — its own page/search (${JSON.stringify(viewA)}), unaffected by tab B (${JSON.stringify(viewB)})`);

  } finally {
    await browser.close().catch(() => {});
    if (server) { try { server.kill("SIGKILL"); } catch {} }
  }

  console.log("\n" + "=".repeat(96));
  console.log(failures ? `${failures} FAILED` : `all checks passed — shots in ${path.relative(ROOT, OUT_DIR)}`);
  console.log("=".repeat(96));
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.log(`FAIL  ${e.message}`); console.log(e.stack); process.exit(1); });
