#!/usr/bin/env node
// ── BACKFILL job_role_map FOR ROWS THAT HAVE NO BUCKET AT ALL ───────────────────────────────────
//
// THE DEFECT, and it is restore damage rather than a classifier failure.
//
// Every row that goes through the ingest path gets a job_role_map row — services/jobs/aggregator.js
// writes the classifier's verdict, or falls back to 'general' when there is no confident bucket. So
// a posting with NO map row did not come through that path in its current form. It came from
// `scripts/am3RestoreBoard.mjs`, which restores `scraped_jobs` and NOT `job_role_map`
// (docs/am1-recovery.md records that table losing 1,286 rows to the ON DELETE CASCADE).
//
// 277 active postings are in that state. CC1b made them VISIBLE — the board's role join became a
// LEFT JOIN with a soft-null predicate, so "never classified" stops meaning "hidden from everyone".
// But visible-to-everyone is not the same as correct: an unmapped row appears on EVERY profile's
// board, whatever it is. 26 of these are sales postings and 33 are PM postings, and they are
// currently on the owner's engineering board because nobody ever said what they were.
//
// ⛔ SO THIS BACKFILL MAKES THE BOARD SMALLER, AND THAT IS THE POINT. CC1 and CC1b widened the
// board by removing rules that excluded good rows. This narrows it by classifying rows that were
// only there because they were unclassified. Those are not opposites: both replace "we never
// decided" with a decision.
//
// ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────────────────────────
//
// ⛔ IT NEVER TOUCHES scraped_jobs AND NEVER DELETES ANYTHING. `scripts/reclassifyJobs.js` — the
// existing, similar-sounding script — DELETES board rows: it ejects blue-collar postings to
// rejected_jobs and drops no-signal ones outright. On a board that was restored from a backup that
// is not a backfill, it is a second purge. This script only ever INSERTs into job_role_map, and
// only for a job_id that has no row there at all.
//
// ⛔ IT NEVER OVERWRITES AN EXISTING BUCKET. Not the classifier's, and not
// `assignJobRoleMap`'s profile-scoped rows. The candidate set is defined by NOT EXISTS, so a job
// that already carries any bucket is out of scope entirely — there is no UPDATE and no
// INSERT OR REPLACE in this file.
//
// ── THE RULE IT APPLIES, WHICH IS INGEST'S ──────────────────────────────────────────────────────
//
// `classifyJob` is the function the ingest path calls, and it applies INGEST_CONFIDENCE_THRESHOLD
// (0.75) itself: at or above it, the family; below it but with a strong white-collar anchor,
// 'general'; otherwise null.
//
// ⛔ CC1B'S NOTE SAID "a backfill at classifyForIngest's own 0.75 confidence gate", AND USING THAT
// FUNCTION LITERALLY WOULD HAVE BEEN WRONG. `classifyForIngest` returns null below the threshold
// and nothing else — it does not carry the strong-anchor → 'general' policy that the ingest path
// actually applies through `classifyJob`. It would have left the 70 rows that legitimately bucket
// as 'general' unclassified, and a backfill that disagrees with ingest is a second classifier.
//
// Mirroring aggregator.js's write rule exactly:
//   roleKey != null              -> that bucket
//   white-collar, roleKey null   -> ROLE_KEY_FALLBACK ('general'), ingest's own fallback
//   blue-collar                  -> NOTHING WRITTEN, counted and reported
//
// The blue-collar branch matters even though it is empty on this board (measured: 0 of 277). At
// ingest a blue-collar posting is rejected before the map write is reached, so filing one under
// 'general' would be a claim the ingest classifier never makes. The remedy for a blue-collar row
// sitting on the board is ejection, which is a destructive decision with its own script and must
// not be smuggled into a backfill. Leaving it unmapped preserves the status quo for that row.
//
// `source_profile_id` stays NULL, which is what aggregator.js's retireOtherClassifierBuckets uses
// to tell a classifier-derived row from a profile-derived one. A backfilled row must be retireable
// by a later re-crawl exactly like any other classifier row.
//
// ── RUNNING IT ──────────────────────────────────────────────────────────────────────────────────
//
//   node scripts/backfillJobRoleMap.mjs              # DRY RUN — counts and samples, no writes
//   node scripts/backfillJobRoleMap.mjs --apply      # writes, in one transaction
//   node scripts/backfillJobRoleMap.mjs --apply --verbose
//   node scripts/backfillJobRoleMap.mjs --apply --db <path>   # against a COPY, to measure first
//
// `--db` exists because this changes which postings are on which board, and the honest way to find
// out by how much is to apply it to a copy and diff the board — the pattern CC3 used to prove the
// synonym path end to end. It is not a convenience flag; it is how the acceptance criterion below
// was measured before anything was written to the real database.
//
// Dry run is the default because the apply is a write to the live board's scoping table. Idempotent
// either way: a second run finds nothing to do.
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { classifyJob, ROLE_KEY_FALLBACK } from "../services/jobs/classifyJob.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbArg   = process.argv.indexOf("--db");
const DB_PATH = dbArg >= 0
  ? path.resolve(process.argv[dbArg + 1])
  : path.join(__dirname, "..", "data", "resume_master.db");

const APPLY   = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");

export const MATCHED_BY = "backfill_classifier";
export const MATCHED_BY_UNCLASSIFIED = `${MATCHED_BY}_unclassified`;

/**
 * What this backfill would write for one posting. Exported so the test exercises THIS decision
 * rather than a copy of it — the whole risk here is diverging from the ingest path, and a test
 * against a re-implementation could not see that.
 *
 * @returns {{action: "bucket"|"fallback"|"skip", roleKey: string|null, verdict: object}}
 */
export function backfillDecision(row) {
  const verdict = classifyJob(row.title || "", row.description || "", row.company || "");
  if (verdict.collar === "blue") return { action: "skip", roleKey: null, verdict };
  if (verdict.roleKey != null)   return { action: "bucket", roleKey: verdict.roleKey, verdict };
  return { action: "fallback", roleKey: ROLE_KEY_FALLBACK, verdict };
}

/** The candidate set: active postings with no job_role_map row of any kind. */
export const UNMAPPED_SQL = `
  SELECT sj.job_id, sj.title, sj.company, sj.description
  FROM scraped_jobs sj
  WHERE sj.is_active = 1
    AND NOT EXISTS (SELECT 1 FROM job_role_map m WHERE m.job_id = sj.job_id)
  ORDER BY sj.job_id
`;

function main() {
  const db = new Database(DB_PATH, { readonly: !APPLY });
  const rows = db.prepare(UNMAPPED_SQL).all();

  console.log(`\njob_role_map backfill — ${APPLY ? "APPLY" : "DRY RUN (no writes)"}`);
  console.log(`  active postings with no bucket: ${rows.length}`);
  if (!rows.length) {
    console.log("  nothing to do — every active posting carries a bucket.\n");
    db.close();
    return 0;
  }

  const decisions = rows.map(r => ({ row: r, ...backfillDecision(r) }));
  const tally = {};
  for (const d of decisions) {
    const label = d.action === "skip" ? "(blue-collar — left unmapped)"
                : d.action === "fallback" ? `${ROLE_KEY_FALLBACK} (ingest fallback)`
                : d.roleKey;
    tally[label] = (tally[label] || 0) + 1;
  }

  console.log("\n  verdicts:");
  for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${k}`);
  }

  if (VERBOSE) {
    console.log("\n  sample per bucket:");
    const seen = new Set();
    for (const d of decisions) {
      if (d.action === "skip" || seen.has(d.roleKey)) continue;
      seen.add(d.roleKey);
      console.log(`    ${d.roleKey.padEnd(32)} ${d.row.title} @ ${d.row.company}`
        + `  (confidence ${Number(d.verdict.confidence || 0).toFixed(2)})`);
    }
  }

  const writable = decisions.filter(d => d.action !== "skip");
  console.log(`\n  would insert: ${writable.length}   leave unmapped: ${decisions.length - writable.length}`);

  if (!APPLY) {
    console.log("\n  DRY RUN — no writes. Re-run with --apply to perform the backfill.\n");
    db.close();
    return 0;
  }

  // INSERT only, never REPLACE: the candidate set is already "has no row", so a conflict here
  // would mean the set was computed against a different database state than the write — which is
  // a bug worth failing on rather than papering over.
  const insert = db.prepare(`
    INSERT INTO job_role_map (job_id, role_key, role_family, domain, source_profile_id, confidence, matched_by)
    VALUES (?, ?, ?, ?, NULL, ?, ?)
  `);
  const run = db.transaction((ds) => {
    for (const d of ds) {
      insert.run(
        d.row.job_id, d.roleKey, d.roleKey, d.verdict.domain || null,
        d.verdict.confidence || 0,
        d.action === "fallback" ? MATCHED_BY_UNCLASSIFIED : MATCHED_BY,
      );
    }
  });
  run(writable);

  const left = db.prepare(UNMAPPED_SQL).all().length;
  console.log(`\n  inserted ${writable.length} row(s). Active postings still unmapped: ${left}`
    + `${left ? " (blue-collar, deliberately)" : ""}`);
  console.log(`  provenance: matched_by='${MATCHED_BY}' / '${MATCHED_BY_UNCLASSIFIED}', `
    + `source_profile_id NULL — reversible with:`);
  console.log(`    DELETE FROM job_role_map WHERE matched_by LIKE '${MATCHED_BY}%';\n`);
  db.close();
  return 0;
}

// Importable for the test without running the backfill.
//
// `pathToFileURL` rather than a hand-built `file://${argv[1]}`: on Windows the hand-built form is
// `file://C:/…` and import.meta.url is `file:///C:/…`, so the comparison silently fails and the
// script runs as a no-op — which is exactly what it did the first time.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
