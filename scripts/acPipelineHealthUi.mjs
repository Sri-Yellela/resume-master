#!/usr/bin/env node
/**
 * AC RESIDUAL — does the alert actually READ as an alert?
 *
 * AC item 2 asks for "an ALERT — not a quiet entry in a log nobody reads". No node test can answer
 * that. pipelineHealth.test.js proves the `alerts` array is CORRECT, and an array nobody renders is
 * precisely the quiet log the item complains about — so correctness of the payload and visibility
 * of the finding are two different claims and only one of them has a unit test.
 *
 * ⛔ THIS EXISTS BECAUSE THE NODE SUITE PASSES THROUGH LAYOUT DEFECTS. It found one on its first
 * run: `LIVE SEARCH ONLY` and `NOT CONFIGURED` are longer than any label the Health column was
 * built for, so both wrapped to two lines and broke OUT of the pill's rounded background. Every
 * string assertion about those labels passed while they rendered as visibly broken chrome. The
 * pill-wrap check below is the guard for that, and it asserts GEOMETRY (one client rect per pill),
 * not text.
 *
 * The fixture is the complaint: every health state this residual introduced, in one payload, so a
 * single screenshot shows whether they are distinguishable from each other.
 *
 * Usage:  node scripts/acPipelineHealthUi.mjs        # starts its own vite dev server
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "data", "screenshots", "ac-residual");
// Its own port. abPanelUi holds 5199 and --strictPort means a collision is a hard failure rather
// than a silent move to another port that the banner scrape would then miss.
const PORT = 5207;

let pass = 0, fail = 0;
const ok   = (m) => { pass++; console.log("PASS " + m); };
const bad  = (m) => { fail++; console.log("FAIL " + m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  (process.env.LOCALAPPDATA || "") + "/Google/Chrome/Application/chrome.exe",
];
const chrome = CANDIDATES.find(p => p && fs.existsSync(p));
if (!chrome) { console.log("FAIL no Chrome binary found"); process.exit(1); }

const now = Math.floor(Date.now() / 1000);
const H = 3600;

// The fixture is the complaint: every state this residual added, side by side, so a screenshot can
// show whether they are distinguishable. Numbers are production's own.
const HEALTH = {
  generatedAt: now,
  staleAfterHours: 48,
  hasRunLog: true,
  alertCounts: { critical: 8, warn: 2 },
  alerts: [
    { severity: "critical", kind: "company", subject: "greenhouse/anthropic",
      detail: "Anthropic: active company, zero rows on the board — a dead slug, or its postings were dropped before they were written" },
    { severity: "critical", kind: "company", subject: "greenhouse/brex",
      detail: "Brex: active company, zero rows on the board — a dead slug, or its postings were dropped before they were written" },
    { severity: "critical", kind: "company", subject: "greenhouse/scaleai",
      detail: "Scale AI: active company, zero rows on the board — a dead slug, or its postings were dropped before they were written" },
    { severity: "critical", kind: "company", subject: "ashby/ramp",
      detail: "Ramp: active company, zero rows on the board — a dead slug, or its postings were dropped before they were written" },
    { severity: "critical", kind: "source", subject: "lever",
      detail: "ran and returned nothing — every configured slug came back empty" },
    { severity: "critical", kind: "source", subject: "workable",
      detail: "the crawl skipped it: no active companies are configured for this source" },
    { severity: "critical", kind: "enrichment", subject: "last run",
      detail: "recorded status 'ok' but wrote 0 of 25 fetched — 404 model not_found: claude-3-haiku-20240307" },
    { severity: "critical", kind: "enrichment", subject: "consecutive failures",
      detail: "the last 3 enrichment runs wrote nothing — this is the shape that ran for three days undetected" },
    { severity: "warn", kind: "source", subject: "ashby",
      detail: "no successful run in 72h (threshold 48h)" },
    { severity: "warn", kind: "company", subject: "greenhouse/figma",
      detail: "Figma: no row seen in 61h (threshold 48h)" },
  ],
  sources: [
    { name: "adzuna", configured: true, inCrawl: false, health: "live_search_only", companies: null, total: 0, active: 0, noDescription: 0, enriched: 0, lastRowAt: null, lastActivityAt: null, staleHours: null, lastRun: null, lastSuccessAt: null },
    { name: "serpapi", configured: true, inCrawl: false, health: "live_search_only", companies: null, total: 0, active: 0, noDescription: 0, enriched: 0, lastRowAt: null, lastActivityAt: null, staleHours: null, lastRun: null, lastSuccessAt: null },
    { name: "greenhouse", configured: true, inCrawl: true, health: "ok", companies: 9, total: 682, active: 621, noDescription: 0, enriched: 226, lastRowAt: now - H, lastActivityAt: now - H, staleHours: 1, lastRun: { status: "ok", at: now - H, fetched: 2267, written: 900, merged: 12, dropped: 0, ejected: 4, failed: 0, error: null }, lastSuccessAt: now - H },
    { name: "ashby", configured: true, inCrawl: true, health: "stale", companies: 4, total: 651, active: 634, noDescription: 0, enriched: 239, lastRowAt: now - 72 * H, lastActivityAt: now - 72 * H, staleHours: 72, lastRun: { status: "ok", at: now - 72 * H, fetched: 1086, written: 900, merged: 0, dropped: 0, ejected: 0, failed: 0, error: null }, lastSuccessAt: now - 72 * H },
    { name: "lever", configured: true, inCrawl: true, health: "no_results", companies: 7, total: 0, active: 0, noDescription: 0, enriched: 0, lastRowAt: null, lastActivityAt: null, staleHours: null, lastRun: { status: "no_results", at: now - H, fetched: 0, written: 0, merged: 0, dropped: 0, ejected: 0, failed: 0, error: null }, lastSuccessAt: null },
    { name: "workable", configured: true, inCrawl: true, health: "not_configured", companies: 3, total: 0, active: 0, noDescription: 0, enriched: 0, lastRowAt: null, lastActivityAt: null, staleHours: null, lastRun: { status: "skipped_unconfigured", at: now - H, fetched: 0, written: 0, merged: 0, dropped: 0, ejected: 0, failed: 0, error: "No companies configured for this source" }, lastSuccessAt: null },
    { name: "smartrecruiters", configured: true, inCrawl: true, health: "wrote_nothing", companies: 2, total: 0, active: 0, noDescription: 0, enriched: 0, lastRowAt: null, lastActivityAt: now - H, staleHours: 1, lastRun: { status: "ok", at: now - H, fetched: 282, written: 0, merged: 0, dropped: 0, ejected: 0, failed: 0, error: null }, lastSuccessAt: now - H },
    { name: "jobo", configured: true, inCrawl: true, health: "failed", companies: null, total: 0, active: 0, noDescription: 0, enriched: 0, lastRowAt: null, lastActivityAt: null, staleHours: 669, lastRun: { status: "failed", at: now - 4 * H, fetched: 0, written: 0, merged: 0, dropped: 0, ejected: 0, failed: 0, error: "connect ETIMEDOUT connect.jobo.world:443" }, lastSuccessAt: null },
  ],
  companies: [
    { source: "greenhouse", company: "Anthropic", slug: "anthropic", total: 0, active: 0, noDescription: 0, enriched: 0, lastRowAt: null, addedAt: now - 90 * 24 * H, staleHours: null, health: "no_rows" },
    { source: "greenhouse", company: "Brex", slug: "brex", total: 0, active: 0, noDescription: 0, enriched: 0, lastRowAt: null, addedAt: now - 90 * 24 * H, staleHours: null, health: "no_rows" },
    { source: "greenhouse", company: "Scale AI", slug: "scaleai", total: 0, active: 0, noDescription: 0, enriched: 0, lastRowAt: null, addedAt: now - 90 * 24 * H, staleHours: null, health: "no_rows" },
    { source: "ashby", company: "Ramp", slug: "ramp", total: 0, active: 0, noDescription: 0, enriched: 0, lastRowAt: null, addedAt: now - 90 * 24 * H, staleHours: null, health: "no_rows" },
    { source: "smartrecruiters", company: "Ubisoft", slug: "Ubisoft2", total: 97, active: 97, noDescription: 97, enriched: 0, lastRowAt: now - 2 * H, addedAt: now - 90 * 24 * H, staleHours: 2, health: "no_descriptions" },
    { source: "greenhouse", company: "Figma", slug: "figma", total: 80, active: 74, noDescription: 0, enriched: 30, lastRowAt: now - 61 * H, addedAt: now - 90 * 24 * H, staleHours: 61, health: "stale" },
    { source: "greenhouse", company: "Stripe", slug: "stripe", total: 500, active: 468, noDescription: 0, enriched: 180, lastRowAt: now - H, addedAt: now - 90 * 24 * H, staleHours: 1, health: "ok" },
    { source: "ashby", company: "OpenAI", slug: "openai", total: 560, active: 536, noDescription: 0, enriched: 200, lastRowAt: now - H, addedAt: now - 90 * 24 * H, staleHours: 1, health: "ok" },
    { source: "lever", company: "Spotify", slug: "spotify", total: 0, active: 0, noDescription: 0, enriched: 0, lastRowAt: null, addedAt: now - H, staleHours: null, health: "awaiting_first_crawl" },
    { source: "lever", company: "Match Group", slug: "matchgroup", total: 0, active: 0, noDescription: 0, enriched: 0, lastRowAt: null, addedAt: now - H, staleHours: null, health: "awaiting_first_crawl" },
  ],
  enrichment: {
    activeTotal: 1255,
    coverage: [
      { column: "description", nonNull: 1255, total: 1255, pct: 100 },
      { column: "summary", nonNull: 1255, total: 1255, pct: 100 },
      { column: "normalized_title", nonNull: 1255, total: 1255, pct: 100 },
      { column: "experience_level", nonNull: 1255, total: 1255, pct: 100 },
      { column: "workplace_type", nonNull: 617, total: 1255, pct: 49.2 },
      { column: "skills_json", nonNull: 465, total: 1255, pct: 37.1 },
      { column: "salary_max_usd", nonNull: 576, total: 1255, pct: 45.9 },
      { column: "is_h1b_sponsor", nonNull: 0, total: 1255, pct: 0 },
      { column: "requires_work_auth", nonNull: 4, total: 1255, pct: 0.3 },
    ],
    recentRuns: [
      { status: "ok", health: "failed", started_at: now - 6 * H, fetched: 25, written: 0, failed: 25, skipped: 0, error_text: "404 model not_found: claude-3-haiku-20240307", details: { remainingCandidates: 790 } },
      { status: "ok", health: "failed", started_at: now - 30 * H, fetched: 25, written: 0, failed: 25, skipped: 0, error_text: null, details: null },
    ],
    noDescription: 97,
  },
  dedup: { multiSource: 41, total: 1255 },
};

const ME = { authenticated: true, user: { id: 1, username: "admin", isAdmin: true } };
const FALLBACK = { ok: true, jobs: [], items: [], results: [], sources: [], data: [], count: 0, total: 0 };

function startVite() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath,
      [path.join(ROOT, "client", "node_modules", "vite", "bin", "vite.js"),
       "--port", String(PORT), "--strictPort"],
      { cwd: path.join(ROOT, "client"), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const onData = (b) => {
      // ⛔ STRIP THE ESC BYTE ITSELF, not just the bracket-and-letter tail. Vite colours the host
      // and the port with SEPARATE sequences, so `/\[[0-9;]*m/` leaves a bare \x1b sitting between
      // "localhost:" and the number and a literal /localhost:5207/ never matches — on a server
      // that started perfectly. That is a 90-second timeout reported as "vite did not start".
      out += b.toString().replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b/g, "");
      if (new RegExp(`localhost:${PORT}`).test(out)) resolve({ proc, url: `http://localhost:${PORT}` });
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", reject);
    setTimeout(() => reject(new Error("vite did not start:\n" + out.slice(-800))), 90000);
  });
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const vite = await startVite();
console.log("vite " + vite.url);
const browser = await puppeteer.launch({
  executablePath: chrome, headless: "new", pipe: true,
  args: ["--no-first-run", "--no-default-browser-check"],
  defaultViewport: { width: 1500, height: 1400, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("  [page error] " + e.message));
  page.on("console", m => { if (m.type() === "error") console.log("  [console] " + m.text()); });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const u = new URL(req.url(), vite.url);
    if (!u.pathname.startsWith("/api/")) return req.continue();
    const json = (b) => req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/auth/me") return json(ME);
    if (u.pathname === "/api/admin/db/pipeline-health") return json(HEALTH);
    if (u.pathname === "/api/admin/db/scrape-monitor") return json({ jobs: [], sources: [] });
    return json(FALLBACK);
  });

  await page.goto(vite.url + "/admin/db", { waitUntil: "networkidle2", timeout: 90000 });
  await new Promise(r => setTimeout(r, 2500));

  // innerText, deliberately: it reflects text-transform, so it is what the operator actually
  // reads. Matched case-INSENSITIVELY because the header is uppercased in CSS, not in the string —
  // a case-sensitive check here reported a missing banner that was rendering perfectly.
  const t = await page.evaluate(() => document.body.innerText);
  const has = (re) => new RegExp(re, "i").test(t);

  check(has("Pipeline Health"), "the panel rendered at all");
  check(has("\\d+ critical"),   "the alert banner states a critical COUNT");
  check(has("greenhouse/anthropic"),
    "a zero-row company names its source/slug, which is the only actionable form of it");
  check(has("consecutive failures"),
    "the three-in-a-row enrichment streak is surfaced, not just the latest run");
  check(has("recorded as"),
    "the run's own 'ok' is shown NEXT TO the derived FAILED — the contradiction is the finding");

  // Every state this residual added must be present AND distinguishable.
  for (const label of ["WROTE NOTHING", "LIVE SEARCH ONLY", "AWAITING CRAWL",
                       "NO DESCRIPTIONS", "NO ROWS"]) {
    check(t.includes(label), `the ${label} state renders`);
  }

  // ── Is the alert block ABOVE the stat cards? Geometry, not string presence: an alert that
  // renders below three screens of table is a log entry with extra colour.
  const geom = await page.evaluate(() => {
    const els = [...document.querySelectorAll("div")];
    const alertBox = els.find(e => /\d+ critical/i.test(e.textContent || "") && e.children.length === 0);
    const activeRows = els.find(e => (e.textContent || "").trim() === "Active Rows");
    return {
      alertTop: alertBox ? Math.round(alertBox.getBoundingClientRect().top) : null,
      statTop: activeRows ? Math.round(activeRows.getBoundingClientRect().top) : null,
    };
  });
  check(geom.alertTop != null && geom.statTop != null && geom.alertTop < geom.statTop,
    `the alert banner precedes the stat cards (alert=${geom.alertTop} stats=${geom.statTop})`);

  // ── THE PILL-WRAP GUARD, which took two attempts and the first one was blind.
  //
  // A wrapped pill spills over its own rounded background — what happened to LIVE SEARCH ONLY and
  // NOT CONFIGURED on this harness's first run, when the Health column was 110px.
  //
  // ⛔ THE OBVIOUS CHECKS DO NOT WORK, and both of them PASSED against the broken layout:
  //   el.getClientRects().length  — the Pill is display:inline-block, so it is ONE box however
  //                                 many lines of text sit inside it. Always 1.
  //   el.scrollWidth > clientWidth — the text wraps rather than overflowing, so the box grows in
  //                                 HEIGHT and the widths stay equal. Always false.
  // A Range over the text contents is the thing that actually knows: it returns one client rect
  // PER RENDERED LINE. Verified in both directions — reverting the column width makes this fail.
  const wrapped = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("span")) {
      if (getComputedStyle(el).borderRadius !== "999px") continue;   // the Pill's signature
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = range.getClientRects().length;
      if (lines > 1) out.push({ text: (el.textContent || "").trim(), lines });
    }
    return out;
  });
  check(wrapped.length === 0,
    `no health pill wraps onto a second line${wrapped.length ? " — " + JSON.stringify(wrapped) : ""}`);

  await page.screenshot({ path: path.join(OUT_DIR, "pipeline-health-alerts.png") });
  await page.evaluate(() => window.scrollTo(0, 900));
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT_DIR, "pipeline-health-percompany.png") });
  console.log("\nscreenshots -> " + OUT_DIR);
} finally {
  await browser.close();
  vite.proc.kill();
}

console.log("\n" + "=".repeat(72));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
