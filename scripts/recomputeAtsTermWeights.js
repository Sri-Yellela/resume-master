#!/usr/bin/env node
/**
 * Recompute the ATS corpus term-weight table from scraped_jobs.
 *
 *   node scripts/recomputeAtsTermWeights.js            # recompute and report
 *   node scripts/recomputeAtsTermWeights.js --dry-run  # report what would change, write nothing
 *
 * WHEN TO RUN IT: after any substantial scrape or enrichment pass. Weights are document frequencies
 * over the board, so they drift as the board does, and services/atsTermWeights.js refuses weights
 * older than MAX_WEIGHT_AGE_DAYS rather than scoring against a corpus that no longer exists. That
 * refusal is the safety net, not the schedule — a scorer running unweighted is a silently worse
 * scorer, so this belongs beside the enrichment pass.
 *
 * NOTE: this is a .js CLI, not a .mjs. scripts/verifyHarnesses.mjs auto-discovers every *.mjs in
 * this directory and runs it as a verification harness; a recompute that mutates the weight table
 * is not a harness and must not join that suite.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { computeTermWeights, GLOBAL_FAMILY, MIN_DF, MIN_FAMILY_POSTINGS } from "../services/atsTermWeights.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.ATS_DB_PATH || path.join(__dirname, "..", "data", "resume_master.db");
const dryRun = process.argv.includes("--dry-run");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const before = (() => {
  try {
    return db.prepare(
      "SELECT COUNT(*) n, MAX(computed_at) at FROM ats_term_weights"
    ).get();
  } catch {
    return null;
  }
})();

if (!before) {
  console.error("[ats-weights] ats_term_weights does not exist — run migration 093 first");
  process.exit(1);
}

console.log(`[ats-weights] db ${DB_PATH}`);
console.log(`[ats-weights] existing rows: ${before.n}` +
  (before.at ? ` (computed ${new Date(before.at * 1000).toISOString()})` : " (never computed)"));
console.log(`[ats-weights] MIN_DF=${MIN_DF} MIN_FAMILY_POSTINGS=${MIN_FAMILY_POSTINGS}`);

if (dryRun) {
  // Compute into a transaction and roll it back, so a dry run reports the real numbers rather than
  // an estimate of them. Reporting a guess would defeat the point of having a dry run.
  let result = null;
  try {
    db.exec("BEGIN");
    result = computeTermWeights(db);
  } finally {
    db.exec("ROLLBACK");
  }
  report(result);
  console.log("[ats-weights] DRY RUN — nothing was written");
} else {
  report(computeTermWeights(db));
}

function report(result) {
  console.log(`\n[ats-weights] corpus: ${result.corpusSize} postings carrying skills_json`);
  console.log("[ats-weights] families written (a family below the minimum falls back to global):");
  for (const f of result.families.sort((a, b) => b.postings - a.postings)) {
    const label = f.family === GLOBAL_FAMILY ? "(global)" : f.family;
    console.log(
      `  ${String(f.postings).padStart(5)} postings  ` +
      `${String(f.distinctTerms).padStart(5)} distinct  ` +
      `${String(f.weighted).padStart(5)} weighted (df>=${MIN_DF})  ${label}`
    );
  }
  const total = result.families.reduce((n, f) => n + f.weighted, 0);
  console.log(`[ats-weights] ${total} rows, computed_at ${new Date(result.computedAt * 1000).toISOString()}`);
}
