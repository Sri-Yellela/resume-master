// services/jobs/boardSufficiency.js
//
// ⛔ A DERIVATION IS ONLY AS TRUE AS THE BOARD IT READS.
//
// `cleanup_log` id 85 deleted 1288 of 1291 scraped_jobs rows on 2026-09-02. Five fixtures remain.
// Every table derived from that board still describes it — 8690 company_technographics, 697
// company_org_units, 856 ats_term_weights, 40 company_hiring_signals — so those tables are STALE
// but INTACT, and stale-but-intact is recoverable. The postings are in a backup; the derivations
// can be rebuilt from it.
//
// What is NOT recoverable is a derivation that RE-RUNS against the five fixtures and overwrites the
// real output with one computed from nothing. That is a second, larger loss layered on the first,
// and it is the shape that already cost this project 120 rows once (enrichment poisoning).
//
// scripts/al3SkillSynonyms.mjs already refuses this way, with MIN_CORPUS_POSTINGS = 200 — but it is
// a script somebody chooses to run. The rollups on server.js's 04:00 cron are not:
//
//   runHiringSignalsRollup  ⛔ LIVE RISK. Upserts on (company, window_end); window_end is `now`, so
//                              every pass writes a NEW row, and getHiringSignals reads
//                              `ORDER BY window_end DESC LIMIT 1`. One unattended pass against the
//                              five fixtures therefore makes "Stripe: 1 open role" the CURRENT
//                              answer for the company panel — a false claim about the world,
//                              presented as measured data, with the true snapshot still sitting in
//                              the table underneath it where nothing will read it.
//
//   runOrgLayerRollup       Safe today, guarded anyway. It only touches clusters it re-derives this
//                           run, never deletes, and never demotes a confirmed unit — and all five
//                           fixtures have org_unit_raw = NULL, so it currently writes nothing at
//                           all. It is guarded because that safety is a property of today's
//                           implementation, not of the contract, and the cost of the guard is zero.
//
//   computeTermWeights      ⛔ WORST CASE, though not on a cron. It opens with
//                           `DELETE FROM ats_term_weights` inside the rebuild transaction. One
//                           `node scripts/recomputeAtsTermWeights.js` replaces 856 real weights
//                           with whatever four fixtures with skills_json yield. The ATS engine
//                           would keep scoring, on a neutral table, and rho would not be
//                           reproducible afterwards.
//
// ── TWO RULES, BECAUSE THE TWO FAILURES ARE NOT THE SAME ───────────────────────────────────────
//
// `assessBoardSufficiency` is a floor on the INPUT: below this many postings, no aggregate over
// them means anything. That is the right rule for a rollup that APPENDS — hiring signals, org
// units — where there is no prior output to compare a new pass against, and where the first run on
// a fresh board would have nothing to diff.
//
// `assessRebuildScope` is a bound on the BLAST RADIUS, for the one derivation that DESTROYS its
// predecessor: computeTermWeights opens with `DELETE FROM ats_term_weights`. There a diff is the
// better rule and a board floor is the worse one — the question is not "is the board big enough"
// but "am I about to trade 856 measured weights for 3?", and that question answers itself without
// anybody choosing a threshold for what counts as a corpus. It is also inert on an empty table,
// which is what lets the real guard run in unit tests over small fixtures instead of being opted
// out of exactly where it would first be exercised.

/**
 * The same figure scripts/al3SkillSynonyms.mjs refuses below. Kept identical on purpose: two
 * different thresholds for "is this a corpus?" would be two different answers to one question.
 */
export const MIN_BOARD_FOR_DERIVATION = 200;

/**
 * Is this board big enough to derive from?
 *
 * PURE apart from the one COUNT it runs, and the count is passed in by `boardSufficiency` so the
 * decision itself can be tested at any board size without building one.
 *
 * @param {object}   o
 * @param {number}   o.active     active postings on the board
 * @param {string}   o.operation  what is about to run, named in the refusal
 * @param {number}  [o.min]
 * @param {boolean} [o.confirmed] an operator explicitly authorised running against a thin board
 * @returns {{sufficient:boolean, active:number, reason:string|null}}
 */
export function assessBoardSufficiency({ active, operation, min = MIN_BOARD_FOR_DERIVATION, confirmed = false } = {}) {
  const n = Number.isFinite(active) ? active : 0;
  if (n >= min) return { sufficient: true, active: n, reason: null };
  if (confirmed) {
    return {
      sufficient: true,
      active: n,
      reason: `${operation}: running against only ${n} active posting(s) — EXPLICITLY CONFIRMED via ` +
              `ALLOW_THIN_BOARD_DERIVATION. The output will describe those ${n} rows and nothing else.`,
    };
  }
  return {
    sufficient: false,
    active: n,
    reason:
      `${operation}: REFUSED — the board has ${n} active posting(s), below the ${min}-row floor. ` +
      `cleanup_log id 85 deleted 1288 of 1291 rows on 2026-09-02; the derived tables still hold the ` +
      `real output and re-deriving now would replace it with one computed from fixtures. Rebuild ` +
      `from data/evidence/ or data/backups/ instead. To run anyway set ALLOW_THIN_BOARD_DERIVATION=1.`,
  };
}

/**
 * Rows a wholesale rebuild may lose before it has to be confirmed. At 0.5 a rebuild may halve its
 * table unremarked; replacing 856 weights with 3 is refused.
 */
export const MIN_REBUILD_RETAIN_SHARE = 0.5;

/**
 * Below this many existing rows the table is not yet an asset and a rebuild is unremarkable — the
 * guard must not fire on a fresh install or a unit-test fixture, or it becomes noise that gets
 * switched off.
 */
export const MIN_REBUILD_TABLE = 50;

/**
 * May a wholesale DELETE-and-rebuild proceed? PURE.
 *
 * Both counts are of the SAME table: what is there now, and what this pass would write. A rebuild
 * that grows, holds steady, or shrinks moderately is ordinary. One that collapses the table is the
 * signature of a derivation running against a corpus that is no longer there, and the previous
 * contents are the only copy of a measurement nothing else can reproduce.
 *
 * @param {object}   o
 * @param {number}   o.existing   rows currently in the table
 * @param {number}   o.incoming   rows this pass would write
 * @param {string}   o.operation  named in the refusal
 * @param {number}  [o.minRetainShare]
 * @param {number}  [o.minTable]
 * @param {boolean} [o.confirmed]
 * @returns {{allowed:boolean, braked:boolean, retained:number, reason:string|null}}
 */
export function assessRebuildScope({
  existing,
  incoming,
  operation,
  minRetainShare = MIN_REBUILD_RETAIN_SHARE,
  minTable = MIN_REBUILD_TABLE,
  confirmed = false,
} = {}) {
  const have = Number.isFinite(existing) ? existing : 0;
  const next = Number.isFinite(incoming) ? incoming : 0;
  // 0/0 must be 1 (nothing is being lost), never NaN — a NaN here makes every comparison false and
  // silently disables the guard, which is the failure mode this whole file exists to prevent.
  const retained = have > 0 ? next / have : 1;

  if (have <= minTable) return { allowed: true, braked: false, retained, reason: null };
  if (retained >= minRetainShare) return { allowed: true, braked: false, retained, reason: null };
  if (confirmed) {
    return {
      allowed: true, braked: false, retained,
      reason: `${operation}: rebuilding ${have} rows down to ${next} — EXPLICITLY CONFIRMED via ALLOW_THIN_BOARD_DERIVATION.`,
    };
  }
  return {
    allowed: false, braked: true, retained,
    reason:
      `${operation}: REFUSED — this rebuild would replace ${have} rows with ${next} ` +
      `(${(retained * 100).toFixed(1)}% retained, floor ${(minRetainShare * 100).toFixed(0)}%). ` +
      `That is what a derivation looks like when its corpus has been purged: cleanup_log id 85 took ` +
      `scraped_jobs from 1291 rows to 5 on 2026-09-02. The existing rows are kept. Rebuild from ` +
      `data/evidence/ or data/backups/ instead, or set ALLOW_THIN_BOARD_DERIVATION=1 to proceed.`,
  };
}

/** Whether an operator has explicitly authorised deriving from a thin board. */
export function thinBoardConfirmed(env = process.env) {
  // Only a literal "1"/"true". A stray "0" must not read as authorisation, which a bare truthiness
  // check on the string would do.
  return /^(1|true)$/i.test(String(env.ALLOW_THIN_BOARD_DERIVATION ?? ""));
}

/**
 * Convenience wrapper for a caller that has a database and wants the answer for the live board.
 * `is_active = 1` because that is what every one of these rollups aggregates over.
 */
export function boardSufficiency(db, operation, { min = MIN_BOARD_FOR_DERIVATION, env = process.env } = {}) {
  let active = 0;
  try { active = db.prepare("SELECT COUNT(*) c FROM scraped_jobs WHERE is_active = 1").get().c; }
  catch { active = 0; } // no table at all is the thinnest board there is, not a reason to proceed
  return assessBoardSufficiency({ active, operation, min, confirmed: thinBoardConfirmed(env) });
}
