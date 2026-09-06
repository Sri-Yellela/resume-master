// services/jobs/cleanupBrake.js
//
// ⛔ THE INCIDENT THIS EXISTS FOR — cleanup_log id 85, 2026-09-02T02:06:12Z.
//
// One unattended pass of runExpiredJobsCleanup deleted **1288 of 1291** scraped_jobs rows. Three
// survived, all starred. Every human-graded posting behind rho = 0.746 went with it, and every
// derived table — 8690 technographics, 697 org units, 856 term weights — was left describing rows
// that no longer exist.
//
// ── IT WAS NOT A BUG IN THE RULE ────────────────────────────────────────────────────────────────
//
// The rule did precisely what it says: delete anything whose `scraped_at` is older than seven days
// and which is neither applied nor starred. Reconstructed from the 08-31 backup:
//
//     1251 of the 1291 postings were scraped in ONE burst on 2026-08-24
//     nothing was scraped after that day — the board never refilled
//     cleanup ran six times on 2026-08-25 and deleted 0, because nothing was 7 days old yet
//     nothing ran for the next week
//     2026-09-02T02:06, cutoff 2026-08-26 — 1291 of 1291 rows were now older than it
//
// So the deletion was total because the ARRIVALS were bursty and the board stopped being refilled,
// not because the predicate misfired. No individual row was deleted wrongly.
//
// ── WHAT MADE IT UNSURVIVABLE: DELETION AND REFILL SHARE ONE POINT OF FAILURE ───────────────────
//
// The pass that ran was the STARTUP one (server.js's app.listen callback), not the 03:00 cron. Its
// stated purpose is to "catch any window missed if the server was down" — and a window in which the
// server was down is exactly a window in which the re-scrape cron ("0 7 * * *") was ALSO not
// running. The longer the process is down, the more there is to delete and the less has been
// replaced. On boot the cleanup fires immediately from a setImmediate; the re-scrape is up to 24
// hours away and only happens if the process lives that long.
//
// A 7-day expiry is a sound policy for a board that is refilled daily. Attached to a refill that
// stops whenever the process does, it is a rule that empties the board in proportion to downtime.
//
// ── WHAT THIS FILE DOES, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────────────────────
//
// It does NOT change which rows are expired. It bounds the BLAST RADIUS of a single pass: when one
// pass would remove more than `maxShare` of the board, the deletion is refused and the rows are
// RETIRED instead (is_active = 0). Retirement is the true statement either way — these rows have
// not been re-seen — and it is reversible, which a DELETE is not.
//
// Refusing is the right default because the two outcomes are not symmetric. Retaining stale rows
// for another day costs disk. Deleting them costs the only copy of the text, and every measurement
// derived from it. cleanup_log id 85 cost 1288 postings and the ATS engine's only independent
// validation; the counterfactual cost of NOT deleting them that night was one day of disk.
//
// It is a floor, not a ceiling: an operator who really does want the board emptied says so with
// CLEANUP_ALLOW_MASS_DELETE=1, and that is then a deliberate act with a name attached, which is the
// "explicit confirmation" this pass never had.
//
// The threshold ignores small boards on purpose. Deleting 5 of 5 fixtures on a dev machine is not
// an incident and must not need a flag, so the brake only engages once the board is big enough for
// the loss to matter (`minBoard`).

/** Default share of the board a single pass may remove before it must be confirmed. */
export const DEFAULT_MAX_SHARE = 0.5;

/**
 * Boards smaller than this are not braked at all. A 5-row fixture board and a 1291-row real board
 * are different objects; requiring a flag to clear the former would make the flag routine, and a
 * routine confirmation is not a confirmation.
 */
export const DEFAULT_MIN_BOARD = 50;

const envNum = (name, dflt, env) => {
  const n = Number.parseFloat((env ?? process.env)[name] ?? "");
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

/**
 * Decides whether a cleanup pass may proceed. PURE — no database, no environment unless one is
 * handed in, so a test can put it in any state directly rather than constructing a board.
 *
 * @param {object}  o
 * @param {number}  o.total       rows on the board before the pass
 * @param {number}  o.deletable   rows this pass would DELETE (already net of applied/starred exemptions)
 * @param {number} [o.maxShare]   share of `total` above which the pass must be confirmed
 * @param {number} [o.minBoard]   boards at or below this size are never braked
 * @param {boolean}[o.confirmed]  an operator explicitly authorised a mass delete
 * @returns {{allowed:boolean, braked:boolean, share:number, reason:string|null}}
 */
export function assessCleanupScope({
  total,
  deletable,
  maxShare = DEFAULT_MAX_SHARE,
  minBoard = DEFAULT_MIN_BOARD,
  confirmed = false,
} = {}) {
  const t = Number.isFinite(total) ? total : 0;
  const d = Number.isFinite(deletable) ? deletable : 0;
  // A pass that deletes nothing is always allowed, including on an empty board, where the share is
  // 0/0. Returning NaN here would make every downstream comparison false and silently disable the
  // brake — the exact shape of failure this whole file is about.
  const share = t > 0 ? d / t : 0;

  if (d <= 0) return { allowed: true, braked: false, share, reason: null };
  if (t <= minBoard) {
    return { allowed: true, braked: false, share, reason: `board of ${t} is at or below the ${minBoard}-row floor` };
  }
  if (share <= maxShare) {
    return { allowed: true, braked: false, share, reason: null };
  }
  if (confirmed) {
    return {
      allowed: true,
      braked: false,
      share,
      reason: `mass delete of ${d}/${t} (${(share * 100).toFixed(1)}%) EXPLICITLY CONFIRMED`,
    };
  }
  return {
    allowed: false,
    braked: true,
    share,
    reason:
      `this pass would delete ${d} of ${t} rows (${(share * 100).toFixed(1)}%), over the ` +
      `${(maxShare * 100).toFixed(0)}% limit. Refused — the rows are retired (is_active=0) instead, ` +
      `so nothing is lost and they are out of discovery either way. This is what cleanup_log id 85 ` +
      `did unattended on 2026-09-02: 1288 of 1291 postings, including every human-graded one. ` +
      `To proceed anyway set CLEANUP_ALLOW_MASS_DELETE=1.`,
  };
}

/** Reads the knobs from the environment so server.js does not have to restate the defaults. */
export function cleanupBrakeOptions(env = process.env) {
  return {
    maxShare: envNum("CLEANUP_MAX_DELETE_SHARE", DEFAULT_MAX_SHARE, env),
    minBoard: envNum("CLEANUP_MIN_BOARD", DEFAULT_MIN_BOARD, env),
    // Only the literal "1" or "true". A stray "0" or "false" must not read as authorisation, which
    // a bare truthiness check on the string would do.
    confirmed: /^(1|true)$/i.test(String(env.CLEANUP_ALLOW_MASS_DELETE ?? "")),
  };
}
