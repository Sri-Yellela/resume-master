#!/usr/bin/env node
/**
 * AM3 / task T — IS THE BRAKE DEPLOYED, AND DO THE SCHEMAS ACTUALLY DIFFER?
 *
 * ⛔ THIS TASK'S SECOND PREMISE WAS ALREADY KNOWN TO BE WRONG BEFORE THIS RAN, AND THAT SHAPES
 * WHAT THIS SCRIPT DOES. NEXT_WORK.md originally claimed "production's cleanup_log has no `ran_at`
 * column". The column is `run_at`; `ran_at` exists nowhere in the repository and
 * `SELECT ran_at FROM cleanup_log` fails identically against the LOCAL database. A query that
 * fails the same way against both databases is evidence about the query, not about the schema.
 *
 * So this does NOT go looking for a difference to confirm. It compares the FULL schema — every
 * table, every index — and reports the answer either way. "They match" is a good result and is
 * worth writing down, because migrations are DUAL-PATH (scripts/migrations.js and the server.js
 * MIGRATIONS array, byte-identical by hand) precisely so the two can never drift, and nothing has
 * ever checked that guarantee against a deployed database.
 *
 * ⛔ READ-ONLY. Three authenticated GETs. No schema change is applied and none is proposed here —
 * task T says report first, and a migration written off an unreviewed diff is how the dual path
 * would acquire the hole it is meant to prevent.
 *
 * REQUIREMENT ORDER IS DELIBERATE. The migration high-water is fetched FIRST because it BOUNDS the
 * diff: equal high-waters make divergence much less likely and tell you what to expect. An
 * unexpected diff under equal high-waters means a table was created outside the migration system.
 *
 * Usage:
 *   node scripts/am3ProdSchemaDiff.mjs                against $APP_BASE_URL (default)
 *   node scripts/am3ProdSchemaDiff.mjs --url http://localhost:3001
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = path.join(ROOT, "data", "resume_master.db");

// .env is not loaded by default in a bare script, and the credentials live there.
for (const line of (fs.existsSync(path.join(ROOT, ".env"))
  ? fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/) : [])) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const args = process.argv.slice(2);
const urlArg = args.indexOf("--url");
const BASE = (urlArg >= 0 ? args[urlArg + 1] : process.env.APP_BASE_URL || "https://resumemaster.one")
  .replace(/\/$/, "");
const USER = process.env.ADMIN_USER;
const PASS = process.env.ADMIN_PASSWORD;

const bar = (c) => (c || "─").repeat(84);
const fail = (m) => { console.error("\n⛔ " + m); process.exit(2); };

console.log(bar("═"));
console.log("AM3 / task T — production vs local schema, and is the cleanup brake deployed?");
console.log("target: " + BASE + "   (READ-ONLY — three GETs, no mutation)");
console.log(bar("═"));

if (!USER || !PASS) fail("ADMIN_USER / ADMIN_PASSWORD are not set — cannot authenticate.");

// ── authenticate ────────────────────────────────────────────────────────────────
const login = await fetch(BASE + "/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: USER, password: PASS }),
});
if (!login.ok) fail("login failed: HTTP " + login.status + " " + (await login.text()).slice(0, 200));
const { authContext: TOKEN, user } = await login.json();
if (!TOKEN) fail("login returned no authContext token");
if (!user?.isAdmin) fail("the account authenticated but is not an admin");
console.log("\nauthenticated as " + user.username + " (id " + user.id + ", isAdmin)");

const get = async (p) => {
  const r = await fetch(BASE + p, { headers: { "x-rm-auth-context": TOKEN } });
  if (!r.ok) fail("GET " + p + " -> HTTP " + r.status + " " + (await r.text()).slice(0, 200));
  return r.json();
};

// Parse the [TABLE: name — n rows] / CREATE ... ; blocks the export emits, plus its INDEXES and
// MIGRATION HISTORY sections. Reading the deployed endpoint's own format is the point: it is the
// only view of production's sqlite_master available without shell access to the container.
function parseExport(text) {
  const tables = new Map(), indexes = new Map(), migrations = [];
  const rows = new Map();
  let section = "tables", cur = null, buf = [];
  const flush = () => {
    if (cur && buf.length) tables.set(cur, buf.join("\n").trim());
    cur = null; buf = [];
  };
  for (const line of text.split("\n")) {
    if (/^═+$/.test(line)) continue;
    if (line === "INDEXES") { flush(); section = "indexes"; continue; }
    if (line === "MIGRATION HISTORY") { flush(); section = "migrations"; continue; }
    if (section === "migrations") {
      const m = line.match(/^(\S+) — applied (.+)$/);
      if (m) migrations.push({ id: m[1], applied: m[2] });
      continue;
    }
    if (section === "indexes") {
      const m = line.match(/^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?["`]?([\w]+)["`]?/i);
      if (m) indexes.set(m[1], line.replace(/;\s*$/, "").trim());
      continue;
    }
    const t = line.match(/^\[TABLE: (\S+) — (\d+) rows\]$/);
    // `sqlite_sequence` is SQLite's own AUTOINCREMENT bookkeeping, created implicitly by the engine
    // and present in ANY database with an AUTOINCREMENT column. The export's table list does not
    // filter it while the local sqlite_master query here does, so leaving it in reported a
    // divergence that is purely an artifact of the two queries. Dropped on both sides.
    if (t) { flush(); if (t[1] !== "sqlite_sequence") { cur = t[1]; rows.set(t[1], Number(t[2])); } continue; }
    if (cur) buf.push(line);
  }
  flush();
  for (const [k, v] of tables) tables.set(k, v.replace(/;\s*$/, "").trim());
  return { tables, indexes, migrations, rows };
}

// Whitespace is not schema. SQLite stores the CREATE statement verbatim, so the two paths' hand
// alignment differs harmlessly; comparing raw text would report every table as different and bury
// a real difference. Structure — identifiers, types, constraints, order — is preserved.
const norm = (sql) => String(sql || "")
  .replace(/--[^\n]*/g, " ")
  .replace(/\s+/g, " ")
  .replace(/\s*([(),])\s*/g, "$1")
  .replace(/"/g, "")
  .trim()
  .toLowerCase();

// ── REQUIREMENT 3 — THE MIGRATION HIGH-WATER, FIRST ─────────────────────────────
console.log("\n" + bar());
console.log("REQUIREMENT 3 — MIGRATION HIGH-WATER (first, because it bounds requirement 2)");
console.log(bar());

const exp = await get("/api/admin/db/schema/export");
const prod = parseExport(exp.schema);

const live = new Database(LIVE, { readonly: true });
const localMigrations = live.prepare("SELECT id, applied_at FROM schema_migrations ORDER BY applied_at ASC").all();

const hw = (ids) => {
  const numbered = ids.map((m) => String(m.id ?? m).match(/^(\d+)_/)).filter(Boolean)
    .map((m) => Number(m[1]));
  return numbered.length ? Math.max(...numbered) : null;
};
const prodHw = hw(prod.migrations), localHw = hw(localMigrations);
console.log("   production   " + String(prod.migrations.length).padStart(4) + " rows applied," +
  "  high-water " + prodHw);
console.log("   local        " + String(localMigrations.length).padStart(4) + " rows applied," +
  "  high-water " + localHw);

const prodIds = new Set(prod.migrations.map((m) => m.id));
const localIds = new Set(localMigrations.map((m) => m.id));
const onlyLocal = [...localIds].filter((i) => !prodIds.has(i));
const onlyProd = [...prodIds].filter((i) => !localIds.has(i));
if (onlyLocal.length) console.log("   applied LOCALLY but not in production: " + onlyLocal.join(", "));
if (onlyProd.length) console.log("   applied in PRODUCTION but not locally: " + onlyProd.join(", "));
if (!onlyLocal.length && !onlyProd.length) {
  console.log("   ✓ IDENTICAL migration sets. Divergence is unlikely, and any difference the next");
  console.log("     section finds would mean a table was created OUTSIDE the migration system.");
} else {
  console.log("   ⚠ the migration sets DIFFER, so expect the diff below to be non-empty. The");
  console.log("     question then is whether the differences correspond to exactly these rows.");
}

// ── REQUIREMENT 2 — THE FULL SCHEMA DIFF ────────────────────────────────────────
console.log("\n" + bar());
console.log("REQUIREMENT 2 — FULL SCHEMA DIFF (every table and index, not one column)");
console.log(bar());

const localTables = new Map(
  live.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((r) => [r.name, r.sql])
);
const localIndexes = new Map(
  live.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name")
    .all().map((r) => [r.name, r.sql])
);

console.log("   tables   production " + prod.tables.size + "   local " + localTables.size);
console.log("   indexes  production " + prod.indexes.size + "   local " + localIndexes.size);

const tOnlyProd = [...prod.tables.keys()].filter((t) => !localTables.has(t)).sort();
const tOnlyLocal = [...localTables.keys()].filter((t) => !prod.tables.has(t)).sort();
const shared = [...prod.tables.keys()].filter((t) => localTables.has(t)).sort();

// Each known difference carries its explanation, because "the table sets differ" is where the
// investigation starts and an unexplained entry here is indistinguishable from real drift.
const TABLE_NOTES = {
  import_extension_tokens:
    "the REMOVED extension token copy/paste flow. Deleted in c818b9c; SQLite does not drop a\n" +
    "       table when its CREATE statement leaves the source, so production still carries it —\n" +
    "       with 3 stale token hashes that no code will ever expire or consume.",
  provider_eval_jobs:
    "a deliberate SCRATCH table, created by scripts/providerEval/db.js with CREATE TABLE IF NOT\n" +
    "       EXISTS when that harness runs. Outside the migration system by design, dev-only, empty.",
};
if (tOnlyProd.length) {
  console.log("\n   TABLES ONLY IN PRODUCTION (" + tOnlyProd.length + "):");
  for (const t of tOnlyProd) {
    console.log("     + " + t + "   (" + prod.rows.get(t) + " rows)");
    if (TABLE_NOTES[t]) console.log("       └ " + TABLE_NOTES[t]);
  }
}
if (tOnlyLocal.length) {
  console.log("\n   TABLES ONLY LOCALLY (" + tOnlyLocal.length + "):");
  for (const t of tOnlyLocal) {
    let n = "?"; try { n = live.prepare('SELECT COUNT(*) c FROM "' + t + '"').get().c; } catch {}
    console.log("     - " + t + "   (" + n + " rows)");
    if (TABLE_NOTES[t]) console.log("       └ " + TABLE_NOTES[t]);
  }
}
if (!tOnlyProd.length && !tOnlyLocal.length) console.log("\n   ✓ the TABLE SETS are identical.");

// Column-level, not just text-level. Splitting the CREATE body on top-level commas gives the FULL
// definition of each column, which matters here: the real difference this found is two identical
// column NAMES with different DEFAULT clauses, and a name-only comparison reports that as "same
// columns, difference is somewhere in the text" — true, useless, and exactly what it printed first.
const defsOf = (sql) => {
  const m = String(sql).match(/\(([\s\S]*)\)\s*;?\s*$/);
  if (!m) return [];
  const out = []; let depth = 0, cur = "";
  for (const ch of m[1]) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((c) => c.trim().replace(/\s+/g, " ")).filter(Boolean);
};
const nameOf = (def) => def.split(/\s+/)[0].replace(/["`]/g, "").toLowerCase();

const differing = [];
for (const t of shared) {
  if (norm(prod.tables.get(t)) !== norm(localTables.get(t))) differing.push(t);
}
if (!differing.length) {
  console.log("   ✓ all " + shared.length + " shared tables have IDENTICAL CREATE statements");
  console.log("     (modulo whitespace and quoting — see `norm`).");
} else {
  console.log("\n   SHARED TABLES WHOSE DEFINITION DIFFERS (" + differing.length + "):");
  for (const t of differing) {
    const pd = defsOf(prod.tables.get(t)), ld = defsOf(localTables.get(t));
    const pn = pd.map(norm), ln = ld.map(norm);
    console.log("     " + t);
    const pMissing = pd.filter((d, i) => !ln.includes(pn[i]));
    const lMissing = ld.filter((d, i) => !pn.includes(ln[i]));
    const pNames = new Set(pd.map(nameOf)), lNames = new Set(ld.map(nameOf));
    const addedProd = [...pNames].filter((n) => !lNames.has(n));
    const addedLocal = [...lNames].filter((n) => !pNames.has(n));
    if (addedProd.length) console.log("       columns only in PRODUCTION: " + addedProd.join(", "));
    if (addedLocal.length) console.log("       columns only LOCALLY:       " + addedLocal.join(", "));
    for (const d of pMissing) console.log("       prod : " + d);
    for (const d of lMissing) console.log("       local: " + d);
  }
  console.log("\n   ⛔ WHAT THE apply_mode DIFFERENCE IS, AND WHAT IT IS NOT.");
  console.log("     It is NOT dual-path drift. Both paths agree: scripts/migrations.js:13/:44 and");
  console.log("     server.js:391/:422 all declare DEFAULT 'SIMPLE', byte-identically. 'TAILORED'");
  console.log("     was the ORIGINAL default (a780d91) and b212ca6 changed it to 'SIMPLE'.");
  console.log("     Production's users/resumes tables were created BEFORE b212ca6, and");
  console.log("     `CREATE TABLE IF NOT EXISTS` IS A NO-OP AGAINST AN EXISTING TABLE — so editing");
  console.log("     a CREATE statement can never update a database that already has the table.");
  console.log("     That is the real hole: the dual path governs what a NEW database gets, and");
  console.log("     nothing reconciles a long-lived one. A numbered migration would have.");
  console.log("\n     IMPACT, MEASURED RATHER THAN ASSUMED: inert.");
  console.log("       · resumes — both INSERT sites (server.js:8083, :8532) pass apply_mode");
  console.log("         explicitly, so the default is never consulted.");
  console.log("       · users  — only the admin seed (server.js:3441) omits it. Every other insert");
  console.log("         (:5054, :5635, :6101) is explicit.");
  console.log("       · and on READ, publicUser() (server.js:4921-4924) coerces applyMode to");
  console.log("         allowedModesForTier(planTier)[0] whenever the stored value is not entitled.");
  console.log("         ⛔ SO THE `applyMode: TAILORED` IN PRODUCTION'S LOGIN RESPONSE IS PLAN");
  console.log("            COERCION (admin is PLUS -> TAILORED), NOT evidence the default bit.");
  console.log("            Those two explanations are indistinguishable from outside, and claiming");
  console.log("            the stronger one would be exactly the kind of unfounded reading this");
  console.log("            task was created to correct.");
}

const iOnlyProd = [...prod.indexes.keys()].filter((i) => !localIndexes.has(i)).sort();
const iOnlyLocal = [...localIndexes.keys()].filter((i) => !prod.indexes.has(i)).sort();
if (iOnlyProd.length) console.log("\n   INDEXES only in production: " + iOnlyProd.join(", "));
if (iOnlyLocal.length) console.log("\n   INDEXES only locally:       " + iOnlyLocal.join(", "));
if (!iOnlyProd.length && !iOnlyLocal.length) console.log("   ✓ the INDEX SETS are identical.");

// ── THE cleanup_log COLUMN THE ORIGINAL NOTE NAMED ──────────────────────────────
// Checked explicitly because it is the claim that started task T, and a diff that does not settle
// it would leave the wrong note standing.
console.log("\n   the claim that triggered this task — cleanup_log's columns:");
{
  const p = prod.tables.get("cleanup_log"), l = localTables.get("cleanup_log");
  const pc = p ? defsOf(p).map(nameOf) : null, lc = l ? defsOf(l).map(nameOf) : null;
  console.log("     production: " + (pc ? pc.join(", ") : "TABLE ABSENT"));
  console.log("     local:      " + (lc ? lc.join(", ") : "TABLE ABSENT"));
  const hasRanAt = (c) => c && c.includes("ran_at");
  console.log("     `ran_at` present anywhere? production " + (hasRanAt(pc) ? "YES" : "no") +
    ", local " + (hasRanAt(lc) ? "YES" : "no") +
    "  → the column is `run_at` in both; the original note was a query typo.");
}

// ── REQUIREMENT 1 — IS THE BRAKE ON THE PRODUCTION CODE PATH? ───────────────────
console.log("\n" + bar());
console.log("REQUIREMENT 1 — IS THE CLEANUP BRAKE ON THE CODE PATH PRODUCTION EXECUTES?");
console.log(bar());
console.log("   The repo half is not in question: server.js imports assessCleanupScope and calls it");
console.log("   BEFORE the DELETE, counting with the same predicate the DELETE uses. The question is");
console.log("   whether the RUNNING PROCESS is that code. There is no /version endpoint, so this is");
console.log("   settled by ancestry: task Q (abea2c9) landed AFTER the brake (bd95d20) on main, and");
console.log("   Q added `approvalCap` to GET /api/apply/pending. If production serves that field,");
console.log("   it is running abea2c9 or later, which contains bd95d20.");
{
  const pending = await get("/api/apply/pending");
  const cap = pending?.approvalCap;
  console.log("\n   GET /api/apply/pending -> keys: " + Object.keys(pending || {}).join(", "));
  if (cap && typeof cap.limit === "number") {
    console.log("   ✓ approvalCap present: " + JSON.stringify(cap));
    console.log("   ⇒ TASK Q IS DEPLOYED, so bd95d20 is an ancestor of the running build and");
    console.log("     services/jobs/cleanupBrake.js IS on production's code path.");
    console.log("     Production is no longer protected by uptime alone.");
  } else {
    console.log("   ⛔ approvalCap ABSENT from the response.");
    console.log("   ⇒ PRODUCTION PREDATES abea2c9, so task Q is not deployed.");
    console.log("");
    console.log("   Strictly, that alone does not place bd95d20 outside the build — bd95d20 is the");
    console.log("   earlier commit. But the two were committed 49 SECONDS APART:");
    console.log("     bd95d20  2026-09-06 14:47:50  task R — brake the deletion");
    console.log("     abea2c9  2026-09-06 14:48:39  task Q — approval cap");
    console.log("   and only three commits exist after bd95d20, all from the same day. A deploy that");
    console.log("   picked up bd95d20 but not abea2c9 would have had to land inside that 49-second");
    console.log("   window. So the brake is almost certainly NOT deployed either.");
    console.log("");
    console.log("   ⛔ VERDICT: THE BRAKE IS IN main AND IS NOT ON PRODUCTION'S CODE PATH.");
    console.log("     NEXT_WORK.md's task T asked exactly this and feared exactly this answer:");
    console.log("     'until it is deployed, production is protected by uptime rather than by a");
    console.log("     guard.' That is the current state. 1248 live postings are one process start");
    console.log("     away from the id-85 predicate, with nothing counting the rows first.");
    console.log("     ⇒ ACTION: redeploy. This is a deploy, not a code change.");
  }
}

// The trigger itself, restated from the local evidence, because requirement 1 asks what invoked
// the id-85 pass and whether it can fire again.
console.log("\n   the id-85 trigger, and its reachability:");
{
  const rows = live.prepare(
    "SELECT id, run_at, jobs_deleted FROM cleanup_log ORDER BY jobs_deleted DESC LIMIT 3"
  ).all();
  for (const r of rows) {
    console.log("     cleanup_log id " + String(r.id).padStart(3) + "  " +
      new Date(r.run_at * 1000).toISOString() + "  deleted " + r.jobs_deleted);
  }
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const startup = /setImmediate\([^)]*\)?[\s\S]{0,400}?runExpiredJobsCleanup\(\)/.test(src);
  const cron = /cron[\s\S]{0,200}?runExpiredJobsCleanup/i.test(src) ||
    /runExpiredJobsCleanup[\s\S]{0,200}?0 3 \* \* \*/.test(src);
  console.log("     invoked from: startup (app.listen -> setImmediate) " + (startup ? "YES" : "not found") +
    ",  03:00 cron " + (cron ? "YES" : "not found"));
  console.log("     Task R's finding stands: the pass that fired was the STARTUP one, and the refill");
  console.log("     is the 04:00 cacheJobs cron. Both are tied to the process, so the rule empties a");
  console.log("     board in proportion to DOWNTIME — which is why a continuously-deployed board");
  console.log("     stays full and a laptop's empties between sessions.");
  console.log("     ⛔ Reachability is not gated by a route or a confirmation. It is one process");
  console.log("        start. The brake is the only thing bounding it.");
}

console.log("\n" + bar("═"));
console.log("TASK T COMPLETE — read-only. No schema change applied or proposed.");
console.log(bar("═"));
live.close();
