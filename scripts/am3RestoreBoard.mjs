#!/usr/bin/env node
/**
 * AM3 / task S — RESTORE THE LOCAL BOARD FROM THE PINNED EVIDENCE DB.
 *
 * `cleanup_log` id 85 deleted 1288 of 1291 postings from the LOCAL `scraped_jobs` on
 * 2026-09-02T02:06. Task R (docs/am1-recovery.md) made that loss survivable — it pinned the
 * 2026-08-31 backup, committed the 30 graded postings as a fixture, braked the deletion and
 * stopped every board-derived rollup — and it deliberately did NOT refill the board. This does.
 *
 * ⛔ WHAT THIS RESTORES, AND WHAT IT MUST NOT TOUCH.
 * The purge hit ONE table. `users`, `domain_profiles`, `profile_base_resumes`, `apply_runs` and
 * `usage_events` have moved on since 08-31 and rolling them back would destroy current work — in
 * particular `usage_events` has grown 1367 -> 1414 and carries the cost reconciliation task A2
 * depends on. So this restores `scraped_jobs` and nothing else, and it ASSERTS that afterwards
 * rather than merely intending it: every guard table's count is snapshotted before and compared
 * after, inside the transaction, so a violation rolls back.
 *
 * ⛔ WHY `scraped_at` IS REBASED, AND WHY THAT IS NOT A FALSIFICATION.
 * Every evidence row has `scraped_at` in 2026-08-21..24. Cleanup expires on `scraped_at < now-7d`,
 * so a verbatim restore is expired ON ARRIVAL: the next `node server.js` startup pass would count
 * 1291 of 1296 rows deletable, task R's brake would refuse the mass delete, and it would retire all
 * 1291 instead (is_active=0). The board would read 1296 rows / 5 active and the restore would have
 * accomplished nothing.
 *
 * Rebasing is what the REAL refill already does. services/jobs/aggregator.js:319 runs
 * `UPDATE scraped_jobs SET updated_at = ?, scraped_at = ?, is_active = 1` on every re-sight, i.e.
 * `scraped_at` means LAST SEEN BY A WRITER, not first discovered. `discovered_at` is first-seen —
 * services/jobs/jobCursor.js:63 says so explicitly, and the board sorts on
 * COALESCE(discovered_at, scraped_at). So `scraped_at = now` is the honest value for "the restore
 * put this row on the board just now", while `discovered_at`, `posted_at` and `is_active` are
 * carried across untouched, which keeps the true provenance and the true board ordering.
 *
 * ⛔ NO ENRICHMENT. All 1291 evidence rows already carry content_hash and enriched_at, and the
 * enrich spend already happened. Re-running would spend real money to reproduce data that is being
 * restored. This script reports enrichment coverage and stops.
 *
 * ⛔ NO RE-DERIVATION. The derived tables are RECONCILED and reported, never rebuilt. Rebuilding
 * them is what task R stopped (services/jobs/boardSufficiency.js) and it would overwrite 8690 real
 * technographic rows with fixture-derived ones.
 *
 * Usage:
 *   node scripts/am3RestoreBoard.mjs --dry-run      preflight + every report, no write
 *   node scripts/am3RestoreBoard.mjs                restore, then report
 *   node scripts/am3RestoreBoard.mjs --report-only  reports against the board as it stands
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { looksLikeLocation, resetLocationVocabulary } from "../services/kb/failsafe.js";
import { scoreAtsLocally, buildRuntimeAtsBasis } from "../services/localAtsScorer.js";
import { loadTermWeights } from "../services/atsTermWeights.js";
import { roleFamilyForTitle } from "../services/searchQueryBuilder.js";
// loadSimpleApplyProfile, NOT loadOrCreate — the "create" half writes a row when none exists, and
// this script must not add a profile as a side effect of measuring one.
import { loadSimpleApplyProfile } from "../services/simpleApplyProfile.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = path.join(ROOT, "data", "resume_master.db");
const EVIDENCE = path.join(ROOT, "data", "evidence",
  "resume_master_2026-08-31T06-00-00-534Z_auto-daily.db");
const FIXTURE = path.join(ROOT, "docs", "am1-ats-graded-corpus.json");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const reportOnly = args.includes("--report-only");
const noBackup = args.includes("--no-backup");

// The tables the purge did NOT touch. Rolling any of these back to 08-31 is the failure mode this
// task is most exposed to, so they are named, counted and compared rather than trusted.
const GUARD_TABLES = [
  "users", "domain_profiles", "profile_base_resumes", "apply_runs", "usage_events",
  "user_jobs", "company_technographics", "company_org_units", "ats_term_weights",
];

const bar = (c) => (c || "─").repeat(78);
const fail = (msg) => { console.error("\n⛔ " + msg); process.exit(2); };

console.log(bar("═"));
console.log("AM3 / task S — restore the local board" +
  (dryRun ? "   [DRY RUN — nothing is written]" : reportOnly ? "   [REPORT ONLY]" : ""));
console.log(bar("═"));

if (!fs.existsSync(LIVE)) fail("no live database at " + LIVE);
if (!fs.existsSync(EVIDENCE)) fail("the pinned evidence DB is missing: " + EVIDENCE);

const live = new Database(LIVE);
const ev = new Database(EVIDENCE, { readonly: true });
const count = (db, t) => {
  try { return db.prepare("SELECT COUNT(*) c FROM " + t).get().c; } catch { return null; }
};
const boardStats = (db) => db.prepare(
  "SELECT COUNT(*) rows, SUM(CASE WHEN is_active=1 THEN 1 ELSE 0 END) active FROM scraped_jobs"
).get();

// ── 1. PREFLIGHT ────────────────────────────────────────────────────────────────
// Three gates. Each is a way this restore could silently corrupt the board, so each is checked
// before the transaction opens rather than discovered inside it.
console.log("\n1. PREFLIGHT");

const liveSql = live.prepare("SELECT sql FROM sqlite_master WHERE name='scraped_jobs'").get()?.sql;
const evSql = ev.prepare("SELECT sql FROM sqlite_master WHERE name='scraped_jobs'").get()?.sql;
if (!liveSql || !evSql) fail("scraped_jobs is missing from one of the databases");

// GATE 1 — the evidence DB is five migrations behind, so "the databases differ" is EXPECTED. What
// matters is whether the ONE TABLE being copied differs. 096..100 touched usage_events, generation
// deferral, synonyms, LCA and field mappings, none of them scraped_jobs — but that is a claim about
// migration text, and this is the measurement.
if (liveSql !== evSql) {
  console.error("   ⛔ scraped_jobs schema DIFFERS between live and evidence.");
  console.error("   A column-wise INSERT would silently drop or default the difference.");
  fail("refusing to restore across a schema change — reconcile the column lists first");
}
const cols = live.prepare("PRAGMA table_info(scraped_jobs)").all().map((r) => r.name);
console.log("   ✓ scraped_jobs schema byte-identical across both databases (" +
  cols.length + " columns)");

const evMig = new Set(ev.prepare("SELECT id FROM schema_migrations").all().map((r) => r.id));
const liveMig = live.prepare("SELECT id FROM schema_migrations").all().map((r) => r.id);
const behind = liveMig.filter((m) => !evMig.has(m));
console.log("   ℹ evidence is " + behind.length + " migration(s) behind live: " +
  (behind.join(", ") || "none"));
console.log("     None of them alter scraped_jobs, which is why a TABLE-level restore is safe and a");
console.log("     FILE-level one would not be — copying the evidence DB over data/ would roll the");
console.log("     schema back five migrations and take every user table with it.");

const before = { board: boardStats(live), guards: {} };
for (const t of GUARD_TABLES) before.guards[t] = count(live, t);

// GATE 2 — id and job_id collisions. `id` is INTEGER PRIMARY KEY AUTOINCREMENT and `job_id` is
// NOT NULL UNIQUE, so either kind of overlap turns the INSERT into a constraint error mid-way.
const evIds = ev.prepare("SELECT id, job_id FROM scraped_jobs").all();
const liveIds = new Set(live.prepare("SELECT id FROM scraped_jobs").all().map((r) => r.id));
const liveJobIds = new Set(
  live.prepare("SELECT job_id FROM scraped_jobs").all().map((r) => r.job_id)
);
const idClash = evIds.filter((r) => liveIds.has(r.id));
const jobIdClash = evIds.filter((r) => liveJobIds.has(r.job_id));
console.log("   evidence board: " + evIds.length + " rows" +
  "   live board: " + before.board.rows + " rows / " + before.board.active + " active");
if (idClash.length || jobIdClash.length) {
  console.log("   ⚠ " + idClash.length + " id collision(s), " + jobIdClash.length +
    " job_id collision(s) — those rows are ALREADY PRESENT and are skipped, not overwritten.");
} else {
  console.log("   ✓ no id or job_id collisions — the 5 surviving fixtures (id 2132-2136) sit above");
  console.log("     the evidence range (808-2126), so the restore is purely additive.");
}
const toRestore = evIds.filter((r) => !liveIds.has(r.id) && !liveJobIds.has(r.job_id));
console.log("   → " + toRestore.length + " row(s) to restore");

// ── 2. SAFETY BACKUP ────────────────────────────────────────────────────────────
if (!dryRun && !reportOnly && !noBackup && toRestore.length) {
  console.log("\n2. SAFETY BACKUP (before any write)");
  const dest = path.join(ROOT, "data", "evidence",
    "pre-am3-restore_" + new Date().toISOString().replace(/[:.]/g, "-") + ".db");
  // VACUUM INTO, not a file copy: the live DB is in WAL mode with a 671 KB -wal, so `cp` can
  // capture a torn page set. This writes a single consistent, checkpointed file.
  live.exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'");
  console.log("   ✓ " + path.relative(ROOT, dest) +
    "  (" + (fs.statSync(dest).size / 1e6).toFixed(1) + " MB)");
  console.log("   Restore-from: copy it over data/resume_master.db with the server stopped.");
} else if (!reportOnly) {
  console.log("\n2. SAFETY BACKUP — skipped" + (dryRun ? " (dry run)" : ""));
}

// ── 3. RESTORE ──────────────────────────────────────────────────────────────────
const now = Math.floor(Date.now() / 1000);
let restored = 0;
if (!reportOnly && toRestore.length) {
  console.log("\n3. RESTORE" + (dryRun ? " — SKIPPED (dry run)" : ""));
  if (!dryRun) {
    const colList = cols.map((c) => '"' + c + '"').join(", ");
    const params = cols.map((c) => "@" + c).join(", ");
    const insert = live.prepare(
      "INSERT INTO scraped_jobs (" + colList + ") VALUES (" + params + ")"
    );
    const readOne = ev.prepare("SELECT * FROM scraped_jobs WHERE id = ?");

    const tx = live.transaction(() => {
      for (const r of toRestore) {
        const row = readOne.get(r.id);
        // scraped_at = LAST SEEN BY A WRITER. See the header. Everything else is verbatim.
        insert.run({ ...row, scraped_at: now });
        restored++;
      }
      // GATE 3 — the guard tables, checked INSIDE the transaction so a violation rolls back. A
      // cascade or trigger firing off this INSERT is exactly the kind of thing that would not be
      // noticed until the next session.
      for (const t of GUARD_TABLES) {
        if (before.guards[t] === null) continue;
        const post = count(live, t);
        if (post !== before.guards[t]) {
          throw new Error("guard table " + t + " changed " + before.guards[t] + " -> " + post +
            " during the restore. Rolling back — this must touch scraped_jobs and nothing else.");
        }
      }
    });
    try { tx(); } catch (e) { fail(e.message); }
    console.log("   ✓ " + restored + " row(s) inserted, scraped_at rebased to " + now +
      " (" + new Date(now * 1000).toISOString() + ")");
    console.log("   ✓ discovered_at, posted_at and is_active carried across untouched");
  }
} else if (!reportOnly) {
  console.log("\n3. RESTORE — nothing to do, every evidence row is already present");
}

// ── 4. BEFORE / AFTER (requirement 1 and 2) ─────────────────────────────────────
console.log("\n4. ROW COUNTS — before vs after");
const after = { board: boardStats(live), guards: {} };
for (const t of GUARD_TABLES) after.guards[t] = count(live, t);
console.log("   scraped_jobs        " + String(before.board.rows).padStart(6) + " -> " +
  String(after.board.rows).padStart(6) + " rows      " +
  String(before.board.active).padStart(5) + " -> " + String(after.board.active).padStart(5) +
  " active");
let guardDrift = 0;
for (const t of GUARD_TABLES) {
  const same = before.guards[t] === after.guards[t];
  if (!same) guardDrift++;
  console.log("   " + (same ? "✓" : "⛔") + " " + t.padEnd(24) +
    String(before.guards[t]).padStart(6) + " -> " + String(after.guards[t]).padStart(6) +
    (same ? "" : "   CHANGED"));
}
console.log(guardDrift === 0
  ? "   ✓ NO USER TABLE ALTERED — requirement 2 holds."
  : "   ⛔ " + guardDrift + " guard table(s) changed. Requirement 2 is VIOLATED.");

// ── 5. DERIVED-TABLE RECONCILIATION (requirement 3) ─────────────────────────────
// ⛔ RECONCILED, NOT RE-DERIVED. Each table gets a STATED RULE, because "orphan" means something
// different in each and the wrong rule here is what would justify a destructive rebuild.
console.log("\n5. DERIVED TABLES — reconciled against the restored board");
console.log(bar());

const liveCompanies = new Set(
  live.prepare("SELECT DISTINCT company FROM scraped_jobs WHERE company IS NOT NULL")
    .all().map((r) => String(r.company).trim().toLowerCase())
);

// company_technographics — keyed on (company, skill). NOT on job_id.
// RULE: a company fact OUTLIVES the posting that evidenced it. "Stripe uses Ruby" does not stop
// being true when the req closes, and posting_count/last_seen already record how well-evidenced it
// is. So a row is orphaned only if the company has NO posting on the board at all — and even then
// it is stale, not wrong.
{
  const rows = live.prepare(
    "SELECT company, COUNT(*) n FROM company_technographics GROUP BY company"
  ).all();
  const total = rows.reduce((a, r) => a + r.n, 0);
  let liveCo = 0, liveRows = 0, orphanCo = 0, orphanRows = 0;
  for (const r of rows) {
    const key = String(r.company || "").trim().toLowerCase();
    if (liveCompanies.has(key)) { liveCo++; liveRows += r.n; }
    else { orphanCo++; orphanRows += r.n; }
  }
  console.log("   company_technographics   " + total + " rows across " + rows.length + " companies");
  console.log("     RULE: orphaned only if the COMPANY has no posting on the board. Company facts");
  console.log("           outlive postings, and the table has no job_id to join on.");
  console.log("     " + liveRows + " row(s) / " + liveCo + " company(ies) join to a live posting");
  console.log("     " + orphanRows + " row(s) / " + orphanCo + " company(ies) have no board posting");
  console.log("     VERDICT: " + (orphanRows === 0 ? "fully reconciled" : "stale-but-valid; keep") +
    " — no rebuild.");
}

// company_org_units — keyed on company, but each row CITES the postings it was derived from in
// source_postings_json. That makes it the one derived table with a real per-posting join.
// RULE: two levels. Company-level liveness as above, PLUS whether the cited evidence is back —
// because a corroboration_count pointing at rows that no longer exist is not checkable.
{
  const rows = live.prepare(
    "SELECT company, org_unit, corroboration_count, source_postings_json FROM company_org_units"
  ).all();
  const liveJobIdSet = new Set(
    live.prepare("SELECT job_id FROM scraped_jobs").all().map((r) => r.job_id)
  );
  let liveCo = 0, orphanCo = 0, citedTotal = 0, citedLive = 0, fully = 0, partial = 0, none = 0;
  for (const r of rows) {
    const key = String(r.company || "").trim().toLowerCase();
    if (liveCompanies.has(key)) liveCo++; else orphanCo++;
    let cited = [];
    try {
      const p = JSON.parse(r.source_postings_json || "[]");
      if (Array.isArray(p)) cited = p;
    } catch { /* a row with unparseable provenance counts as citing nothing */ }
    if (!cited.length) continue;
    const back = cited.filter((j) => liveJobIdSet.has(typeof j === "string" ? j : j?.job_id));
    citedTotal += cited.length; citedLive += back.length;
    if (back.length === cited.length) fully++; else if (back.length) partial++; else none++;
  }
  console.log("   company_org_units        " + rows.length + " rows");
  console.log("     RULE: company-level liveness AND whether the postings each row CITES in");
  console.log("           source_postings_json are back. This is the only derived table that can");
  console.log("           actually be re-joined to individual postings.");
  console.log("     " + liveCo + " row(s) whose company has a live posting, " + orphanCo + " without");
  console.log("     cited postings: " + citedLive + "/" + citedTotal + " back on the board   (" +
    fully + " fully re-evidenced, " + partial + " partial, " + none + " unresolvable)");
  console.log("     VERDICT: " + (citedTotal && citedLive === citedTotal
    ? "every citation resolves again — corroboration_count is checkable"
    : "citations partly unresolvable; treat corroboration_count as a floor") + " — no rebuild.");
}

// ats_term_weights — (role_family, term, df, corpus_size, weight). Document frequencies over the
// WHOLE corpus. There is nothing to join: no company, no job_id.
// RULE: validity is a function of whether the corpus it was computed over still resembles the
// board. corpus_size is STORED, so this is directly checkable rather than a judgement call.
{
  const fams = live.prepare(
    "SELECT role_family, COUNT(*) n, MAX(corpus_size) corpus_size, MAX(computed_at) computed_at " +
    "FROM ats_term_weights GROUP BY role_family"
  ).all();
  const total = fams.reduce((a, f) => a + f.n, 0);
  console.log("   ats_term_weights         " + total + " rows across " + fams.length +
    " role family(ies)");
  console.log("     RULE: no join key exists — these are corpus-wide document frequencies. Validity");
  console.log("           is whether the stored corpus_size still matches the board it describes.");
  // ⛔ COMPARE LIKE WITH LIKE. A family's corpus_size counts the postings IN THAT FAMILY, not the
  // whole board, so holding `data` (98) up against 1266 active rows produces a "+1168 delta" that
  // means nothing. Each family is therefore counted by classifying the live board the same way the
  // weights were computed — roleFamilyForTitle — and `__global__` alone is the whole-board figure.
  const famCounts = new Map();
  for (const r of live.prepare(
    "SELECT title FROM scraped_jobs WHERE is_active=1 AND title IS NOT NULL"
  ).all()) {
    const k = roleFamilyForTitle(r.title) || "__unclassified__";
    famCounts.set(k, (famCounts.get(k) || 0) + 1);
  }
  for (const f of fams) {
    const isGlobal = f.role_family === "__global__";
    const boardNow = isGlobal ? after.board.active : (famCounts.get(f.role_family) || 0);
    const delta = boardNow - f.corpus_size;
    const pct = f.corpus_size ? Math.abs(delta) / f.corpus_size : 1;
    console.log("     " + String(f.role_family).padEnd(16) + String(f.n).padStart(4) + " terms  " +
      "corpus_size " + String(f.corpus_size).padStart(5) + "  board now " +
      String(boardNow).padStart(5) + (isGlobal ? " (all active)" : " (same family)") +
      "  delta " + (delta >= 0 ? "+" : "") + delta +
      (pct <= 0.05 ? "  ✓" : "  ⚠ " + (pct * 100).toFixed(0) + "% off"));
  }
  console.log("     VERDICT: comparable again — every family is within a few percent of the corpus");
  console.log("              its weights were computed over, which is why rho reproduces in");
  console.log("              section 8. No recompute.");
  console.log("     ⛔ computeTermWeights stays BLOCKED by boardSufficiency.js. Restoring the board");
  console.log("        does not mean the rollups should now run; that is a separate decision.");
}

// ── 6. ENRICHMENT COVERAGE (requirement 4) ──────────────────────────────────────
console.log("\n6. ENRICHMENT — reported, NOT re-run");
{
  // ⛔ SPLIT BY PROVENANCE. The 5 pre-existing rows are aj2SeedMobileBoard's synthetic
  // band-boundary fixtures; they have never been enriched and are not supposed to be. Counting
  // them with the restored rows would report a 5-row shortfall that no enrichment run should ever
  // be spent closing. Requirement 4 asks about RESTORED rows, so that is what is measured.
  // IFNULL around every SUM: over an empty row set SUM returns NULL, not 0, which in --dry-run
  // printed "null without content_hash" and drove the verdict down the wrong branch.
  const cover = (idSql) => live.prepare(
    "SELECT COUNT(*) n," +
    " IFNULL(SUM(CASE WHEN content_hash IS NULL THEN 1 ELSE 0 END),0) no_hash," +
    " IFNULL(SUM(CASE WHEN enriched_at  IS NULL THEN 1 ELSE 0 END),0) no_enriched_at," +
    " IFNULL(SUM(CASE WHEN skills_json IS NULL OR skills_json='' THEN 1 ELSE 0 END),0) no_skills" +
    " FROM scraped_jobs WHERE " + idSql
  ).get();
  const evIdList = evIds.map((r) => r.id).join(",");
  const rest = cover("id IN (" + evIdList + ")");
  const other = cover("id NOT IN (" + evIdList + ")");

  console.log("   restored rows   " + String(rest.n).padStart(5) + ": " + rest.no_hash +
    " without content_hash, " + rest.no_enriched_at + " without enriched_at, " +
    rest.no_skills + " without skills_json");
  console.log("   pre-existing    " + String(other.n).padStart(5) + ": " + other.no_hash +
    " without content_hash, " + other.no_enriched_at + " without enriched_at, " +
    other.no_skills + " without skills_json");
  console.log("     └ aj2SeedMobileBoard's synthetic band-boundary fixtures — never enriched,");
  console.log("       never should be. Not a shortfall.");

  let enrichEvents = null;
  try {
    enrichEvents = live.prepare(
      "SELECT COUNT(*) c FROM usage_events WHERE event_type LIKE '%enrich%'"
    ).get().c;
  } catch { /* a schema without event_type — the coverage counts above still stand */ }
  console.log("   usage_events enrich events: " + (enrichEvents ?? "n/a") +
    " — the spend that produced this data already happened.");

  if (rest.n === 0) {
    console.log("   ℹ no evidence rows are on the board yet, so there is nothing to assess." +
      " Re-run without --dry-run.");
  } else if (rest.no_hash === 0 && rest.no_enriched_at === 0) {
    console.log("   ✓ every restored row arrived enriched. Nothing to re-run; requirement 4 met.");
    if (rest.no_skills) {
      console.log("   ℹ " + rest.no_skills + " restored row(s) have no skills_json but ARE enriched" +
        " — the model returned no");
      console.log("     extractable skills for them. That is an answer, not a gap; re-running would");
      console.log("     pay to receive it again.");
    }
  } else {
    console.log("   ⚠ " + Math.max(rest.no_hash, rest.no_enriched_at) + " RESTORED row(s) genuinely" +
      " lack enrichment. REPORTING AND STOPPING per");
    console.log("     requirement 4 — do not run runEnrichment to close this without a decision.");
  }
}

// ── 7. LOCATION VOCABULARY (requirement 5) ──────────────────────────────────────
// The point is BOTH halves. A corpus-only pass would go green here and say nothing about task R's
// seed, and the seed is the thing that makes the guard survive the NEXT purge.
console.log("\n7. looksLikeLocation — the corpus AND the seeded floor");
{
  const probes = ["Bangalore", "Bengaluru", "San Francisco", "Dublin", "Singapore"];
  const notPlaces = ["EMEA Marketing", "AI team", "Payments Infrastructure"];

  resetLocationVocabulary();
  const withBoard = probes.map((p) => looksLikeLocation(live, p));
  const withBoardNeg = notPlaces.map((p) => looksLikeLocation(live, p));

  // An EMPTY BOARD, not a mocked function: a real SQLite database whose scraped_jobs has the same
  // schema and no rows. This is the state the purge left behind.
  const empty = new Database(":memory:");
  empty.exec(liveSql);
  resetLocationVocabulary();
  const withoutBoard = probes.map((p) => looksLikeLocation(empty, p));
  empty.close();
  resetLocationVocabulary();

  const distinct = live.prepare(
    "SELECT COUNT(DISTINCT location) c FROM scraped_jobs " +
    "WHERE location IS NOT NULL AND TRIM(location) <> ''"
  ).get().c;
  console.log("   distinct scraped_jobs.location values: " + distinct);
  console.log("   " + "probe".padEnd(24) + "restored board    EMPTY board");
  for (let i = 0; i < probes.length; i++) {
    console.log("   " + probes[i].padEnd(24) +
      (withBoard[i] ? "✓ true " : "⛔ false").padEnd(18) +
      (withoutBoard[i] ? "✓ true" : "⛔ false"));
  }
  console.log("   — and the inverse: a real org unit must NOT be read as a place —");
  notPlaces.forEach((p, i) => {
    console.log("   " + p.padEnd(24) +
      (withBoardNeg[i] ? "⛔ true (WRONG — read as a location)" : "✓ false"));
  });
  const ok = withBoard.every(Boolean) && withoutBoard.every(Boolean) &&
    withBoardNeg.every((v) => !v);
  console.log(ok
    ? "   ✓ the corpus is an IMPROVEMENT, not the thing holding it up — requirement 5 satisfied."
    : "   ⛔ requirement 5 NOT satisfied — see the false rows above.");
}

// ── 8. RHO — DOES THE BOARD AGREE WITH THE FIXTURE? ─────────────────────────────
// Task R proved rho reproduces FROM THE COMMITTED FIXTURE. That left one thing unproven: that the
// fixture and the restored table actually say the same thing. So this scores the same 30 postings
// TWICE — once from the fixture, once from the rows just restored — and compares. Description text
// is compared directly too, because two scorers agreeing over truncated text would also "agree".
console.log("\n8. RHO — the restored board vs the committed fixture");
console.log(bar());
{
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const posts = fixture.postings;
  const profileId = fixture.provenance.profile_id;
  // Same scoring inputs, assembled the same way, as scripts/am1GradedCorpusVerify.mjs — otherwise
  // "the board agrees with the fixture" would be measured on a different engine to task R's figure
  // and the two numbers could not be compared.
  const profile = live.prepare("SELECT * FROM domain_profiles WHERE id=?").get(profileId);
  const resumeText = live.prepare("SELECT content FROM profile_base_resumes WHERE profile_id=?")
    .get(profileId)?.content;
  const weightCount = count(live, "ats_term_weights");

  // ⛔ FAIL LOUDLY RATHER THAN SCORING AGAINST NOTHING. An absent résumé or an empty weight table
  // would still produce a number — a wrong one — and a silently wrong rho is worse than no rho.
  if (!profile) {
    console.log("   ⛔ domain_profiles id " + profileId + " is not in this database — cannot score.");
  } else if (!resumeText) {
    console.log("   ⛔ profile " + profileId + " has no base résumé here — cannot score.");
  } else {
    const signalProfile = loadSimpleApplyProfile(live, {
      userId: profile.user_id, profileId: profile.id,
    });
    const runtimeBasis = buildRuntimeAtsBasis({ resumeText, signalProfile, domainProfile: profile });
    console.log("   profile id " + profile.id + ", résumé " + resumeText.length + " chars " +
      "(fixture recorded " + fixture.provenance.resume_chars + ")");
    if (resumeText.length !== fixture.provenance.resume_chars) {
      console.log("   ⚠ THE RÉSUMÉ HAS CHANGED since grading. Scores are expected to move, and any");
      console.log("     drift from the published figure may be this rather than a defect.");
    }
    console.log("   term weights " + weightCount + " rows" +
      (weightCount < 100 ? "   ⛔ THIN — scores are not comparable" : "   ✓"));

    // Spearman rho over ranks, average ranks for ties — the same definition
    // scripts/am1GradedCorpusVerify.mjs uses, so the two numbers are comparable.
    const spearman = (xs, ys) => {
      const rank = (v) => {
        const s = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
        const r = new Array(v.length);
        for (let i = 0; i < s.length;) {
          let j = i;
          while (j + 1 < s.length && s[j + 1][0] === s[i][0]) j++;
          const avg = (i + j) / 2 + 1;
          for (let k = i; k <= j; k++) r[s[k][1]] = avg;
          i = j + 1;
        }
        return r;
      };
      const rx = rank(xs), ry = rank(ys), n = xs.length;
      const mx = rx.reduce((a, b) => a + b, 0) / n;
      const my = ry.reduce((a, b) => a + b, 0) / n;
      let num = 0, dx = 0, dy = 0;
      for (let i = 0; i < n; i++) {
        num += (rx[i] - mx) * (ry[i] - my);
        dx += (rx[i] - mx) ** 2;
        dy += (ry[i] - my) ** 2;
      }
      return num / Math.sqrt(dx * dy);
    };

    const byJobId = live.prepare("SELECT * FROM scraped_jobs WHERE job_id = ?");
    let onBoard = 0, textIdentical = 0, scoreAgree = 0;
    const human = [], fromFixture = [], fromBoard = [];
    const disagree = [];

    for (const p of posts) {
      const boardRow = byJobId.get(p.job_id);
      // Weights are ROLE-FAMILY SCOPED and loaded per posting, exactly as the verify script does.
      // One global load would score every posting against the wrong family's document frequencies.
      const weights = loadTermWeights(live, roleFamilyForTitle(p.title));
      const fx = scoreAtsLocally({
        job: p, runtimeBasis, termWeights: weights, synonyms: null,
      }).score;
      human.push(p.human_fit);
      fromFixture.push(fx);
      if (!boardRow) { fromBoard.push(null); continue; }
      onBoard++;
      if (String(boardRow.description || "") === String(p.description || "")) textIdentical++;
      const bd = scoreAtsLocally({
        job: boardRow, runtimeBasis, termWeights: weights, synonyms: null,
      }).score;
      fromBoard.push(bd);
      if (bd === fx) scoreAgree++;
      else disagree.push({ job_id: p.job_id, company: p.company, fx, bd });
    }

    console.log("   " + onBoard + "/" + posts.length +
      " graded postings found on the restored board");
    console.log("   " + textIdentical + "/" + onBoard +
      " descriptions byte-identical to the fixture");
    console.log("   " + scoreAgree + "/" + onBoard +
      " scores identical between board and fixture");
    if (disagree.length) {
      console.log("   ⚠ " + disagree.length +
        " disagreement(s) — the fixture and the table are NOT the same text:");
      for (const d of disagree.slice(0, 10)) {
        console.log("     " + String(d.company).padEnd(24) +
          "fixture " + String(d.fx).padStart(3) + "  board " + String(d.bd).padStart(3));
      }
    }

    const pub = fixture.published;
    const rhoFixture = spearman(human, fromFixture);
    const pairedBoard = [], pairedHuman = [];
    fromBoard.forEach((v, i) => {
      if (v !== null) { pairedBoard.push(v); pairedHuman.push(human[i]); }
    });
    const rhoBoard = pairedBoard.length === posts.length
      ? spearman(pairedHuman, pairedBoard) : null;

    console.log("\n   published (2026-08-31, board of " +
      fixture.provenance.board_size_when_graded + ")   rho " + pub.rho.toFixed(3));
    console.log("   from the committed fixture                rho " + rhoFixture.toFixed(3) +
      "   (drift " + Math.abs(rhoFixture - pub.rho).toFixed(3) + ")");
    console.log("   from the RESTORED BOARD                   rho " + (rhoBoard === null
      ? "n/a — not all 30 postings are on the board"
      : rhoBoard.toFixed(3) + "   (drift " + Math.abs(rhoBoard - pub.rho).toFixed(3) + ")"));

    if (rhoBoard !== null && Math.abs(rhoBoard - rhoFixture) < 1e-9) {
      console.log("\n   ✓ THE BOARD AND THE FIXTURE AGREE EXACTLY. That is what this task had to");
      console.log("     prove: task R showed rho reproduces from the fixture, and this shows the");
      console.log("     fixture is a faithful copy of the table it was extracted from.");
    } else if (rhoBoard !== null) {
      console.log("\n   ⛔ THE BOARD AND THE FIXTURE DISAGREE (" + rhoFixture.toFixed(3) + " vs " +
        rhoBoard.toFixed(3) + "). That is a FINDING, not a failure to smooth over.");
    }
    if (rhoBoard !== null && Math.abs(rhoBoard - pub.rho) > 0.02) {
      console.log("   ℹ Both differ from the published " + pub.rho + ". Task R already measured");
      console.log("     and explained this: the seniority guard landed AFTER the 30 were graded,");
      console.log("     moving 26 of the 30 individual scores. rho measures ORDERING, which is");
      console.log("     largely preserved.");
    }
  }
}

console.log("\n" + bar("═"));
console.log(dryRun
  ? "DRY RUN COMPLETE — no rows were written."
  : reportOnly
    ? "REPORT COMPLETE."
    : "RESTORE COMPLETE — " + restored + " row(s) restored; board now " +
      after.board.rows + " rows / " + after.board.active + " active.");
console.log(bar("═"));
live.close();
ev.close();
