/**
 * Backfill path for postings that carry NO job_role_map bucket at all.
 *
 * Same shape and the same remedy as backfillAutomationTier: a derived value that some rows never
 * got, re-derived through the SAME function the writers use, idempotent, and reachable from both
 * a boot hook and an admin script.
 *
 * ── WHY ROWS EXIST WITH NO BUCKET ───────────────────────────────────────────────────────────────
 *
 * Not a classifier failure. Every row through services/jobs/aggregator.js gets one — the verdict's
 * bucket, or the 'general' fallback. Rows with none came from scripts/am3RestoreBoard.mjs, which
 * restores `scraped_jobs` and not `job_role_map`; docs/am1-recovery.md records that table losing
 * 1,286 rows to the ON DELETE CASCADE. 277 active postings were in that state locally.
 *
 * CC1b is why that was survivable rather than an outage: the board's role join became a LEFT JOIN
 * with a soft-null predicate, so "never classified" stopped meaning "hidden from everyone". But an
 * unmapped posting then appears on EVERY profile's board — 26 sales roles and 33 PM roles were on
 * an engineering board for no better reason than that nobody had said what they were.
 *
 * ── THE RULE IS INGEST'S, DELIBERATELY ──────────────────────────────────────────────────────────
 *
 *   verdict.roleKey != null        -> that bucket
 *   white-collar, roleKey == null  -> ROLE_KEY_FALLBACK ('general'), ingest's own fallback
 *   blue-collar                    -> NOTHING written, counted and returned
 *
 * ⛔ CC1B'S NOTE SAID "classifyForIngest at 0.75" AND THAT FUNCTION IS THE WRONG ONE. It returns
 * null below the threshold and nothing else — it does not carry the strong-white-anchor ->
 * 'general' policy the ingest path applies through classifyJob. Using it would leave a chunk of
 * rows unclassified and make this disagree with every future crawl, which is a second classifier:
 * one bucket from the backfill, a different one from the next re-crawl, and a board that flickers.
 *
 * ⛔ BLUE-COLLAR ROWS ARE LEFT ALONE ON PURPOSE. At ingest a blue-collar posting is rejected before
 * the map write is reached, so filing one under 'general' would be a claim the ingest classifier
 * never makes. The remedy for one sitting on the board is ejection — a destructive decision with
 * its own script (scripts/reclassifyJobs.js), which must not be smuggled into a backfill.
 *
 * ⛔ IT NEVER TOUCHES scraped_jobs AND NEVER DELETES. The only statement it executes against the
 * database is one INSERT into job_role_map, for a job_id that has no row there at all. It cannot
 * overwrite the classifier's bucket or assignJobRoleMap's profile-scoped one: the candidate set is
 * defined by NOT EXISTS.
 *
 * `source_profile_id` is written NULL, which is what aggregator.js's retireOtherClassifierBuckets
 * uses to tell a classifier row from a profile-derived one — so a backfilled bucket is retireable
 * by a later re-crawl exactly like any other. Its comment says that column, not the matched_by
 * string, is the discriminator precisely so a new matched_by value cannot quietly opt out.
 *
 * COST: classifyJob is regex work over the title and the head of the description — 0.163 ms/row
 * measured over 2,460 real postings, so a whole-board worst case is ~0.4 s. That is what makes the
 * boot hook affordable; after the first run the candidate set is empty and it is one indexed query.
 */
"use strict";

import { classifyJob, ROLE_KEY_FALLBACK } from "./classifyJob.js";

export const MATCHED_BY = "backfill_classifier";
export const MATCHED_BY_UNCLASSIFIED = `${MATCHED_BY}_unclassified`;

/** Active postings with no job_role_map row of any kind. */
export const UNMAPPED_SQL = `
  SELECT sj.job_id, sj.title, sj.company, sj.description
  FROM scraped_jobs sj
  WHERE sj.is_active = 1
    AND NOT EXISTS (SELECT 1 FROM job_role_map m WHERE m.job_id = sj.job_id)
  ORDER BY sj.job_id
`;

/**
 * What the backfill would write for one posting. Exported so callers and tests exercise THIS
 * decision rather than a copy — the whole risk is diverging from the ingest path, and a test
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

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {{ scanned: number, candidates: number, inserted: number, skippedBlue: number,
 *             byBucket: Record<string, number> }}
 *          `candidates` is what WOULD be written; `inserted` is what was. They differ only on a
 *          dry run, and keeping them separate is what lets the script print "would insert N"
 *          without the caller inferring it from a zero.
 */
export function backfillRoleMap(db, { dryRun = false } = {}) {
  const rows = db.prepare(UNMAPPED_SQL).all();
  const byBucket = {};
  let skippedBlue = 0;

  const decisions = [];
  for (const row of rows) {
    const d = backfillDecision(row);
    if (d.action === "skip") { skippedBlue++; continue; }
    byBucket[d.roleKey] = (byBucket[d.roleKey] || 0) + 1;
    decisions.push({ row, ...d });
  }

  const base = { scanned: rows.length, candidates: decisions.length, skippedBlue, byBucket };
  if (dryRun || !decisions.length) return { ...base, inserted: 0 };

  // A plain INSERT, never REPLACE: the candidate set is already "has no row", so a conflict would
  // mean the set was computed against a different database state than the write — a bug worth
  // failing on rather than papering over. One transaction, so a partial classification pass cannot
  // leave the board scoped by a mixture of two states.
  const insert = db.prepare(`
    INSERT INTO job_role_map (job_id, role_key, role_family, domain, source_profile_id, confidence, matched_by)
    VALUES (?, ?, ?, ?, NULL, ?, ?)
  `);
  db.transaction(() => {
    for (const d of decisions) {
      insert.run(
        d.row.job_id, d.roleKey, d.roleKey, d.verdict.domain || null,
        d.verdict.confidence || 0,
        d.action === "fallback" ? MATCHED_BY_UNCLASSIFIED : MATCHED_BY,
      );
    }
  })();

  return { ...base, inserted: decisions.length };
}
