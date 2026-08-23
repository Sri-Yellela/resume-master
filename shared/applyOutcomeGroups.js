// ── THE OUTCOME PARTITION, SHARED ────────────────────────────────────────────────────────────
//
// In shared/ rather than in client/src/lib/applyObstacles.js because BOTH sides need it and they
// must not disagree: routes/apply.js groups the dated history rows with it, and the panel renders
// the three groups with it. A copy on each side is how "COMPLETED" comes to mean two things.
// Same convention as shared/failureAttribution.js and shared/jobFilterOptions.js — the client
// reaches it as ../../../shared/applyOutcomeGroups.js.

// ── TASK AC4: THE THREE OUTCOME GROUPS OF THE DATED RUN HISTORY ──────────────────────────────
//
// Requirement 3 is a completeness requirement, not a display one: "Map every existing terminal
// status into exactly one group... No status may be unmapped or double-mapped." So the mapping is a
// TOTAL PARTITION expressed as data, and test/applyRunHistory.test.js asserts totality against the
// statuses the server actually writes — not against a list kept in a comment, which is how a status
// added later goes missing.
//
// THE FULL STATUS VOCABULARY, and where each row is written:
//
//   queued       routes/apply.js POST /api/apply/runs — the row's default
//   running      processRunJob, at entry
//   submitted    processRunJob, on a verified or claimed submit
//   held_review  processRunJob — the ATS gate, the six AB1 early returns, the completeness gate,
//                the low-confidence gate, the drift gate, the preview stop, manual review
//   held_gate    processRunJob, when detectGate finds a login wall or a CAPTCHA
//   failed       processRunJob's catch, and result.status === 'error'
//   dismissed    POST /api/apply/reject — the user said no
//   superseded   POST /api/apply/approve and POST /api/apply/answers — this attempt was REPLACED by
//                a newer run-job, so it will never finish and nothing was sent
//   cancelled    POST /api/apply/run-jobs/:id/abort — AC4's own, added with it
//
// THE MAPPING, with the reasoning for the two that are not obvious:
//
//   COMPLETED   submitted                                   it reached the employer
//   PENDING     queued, running, held_review, held_gate      it is still going, or waiting on you
//   ABORTED     failed, dismissed, superseded, cancelled     it ended and nothing was sent
//
//   superseded -> ABORTED. It is not a failure and the user did not abort it, but the ATTEMPT is
//   over, nothing was sent, and it will never resume — the work moved to a newer run-job which
//   appears in its own right. Filing it as PENDING would leave a row waiting on a user who has
//   nothing to do; filing it as COMPLETED would claim a submission that never happened. ABORTED is
//   "ended without being sent", and that is exactly what it is. Labelled as replaced, not as failed.
//
//   dismissed -> ABORTED. The user rejected it. Terminal, and nothing was sent.
//
// THE ONE NON-STATUS INPUT. Requirement 3 names "dead posting" under ABORTED, and a dead posting is
// not a status — it is a held row whose posting the 7-day cleanup removed, so the join to
// scraped_jobs comes back empty. By status it is PENDING; in reality there is no form left to open
// and no run that would find one. It is applied as an OVERRIDE after the status map, which is what
// keeps it from double-mapping: a row gets its group from its status and then, if the posting is
// gone and that group was PENDING, moves to ABORTED. Exactly one group, always.

/** The three groups of AC4's dated view. */
export const OUTCOME = {
  COMPLETED: "completed",
  PENDING:   "pending",
  ABORTED:   "aborted",
};

/**
 * The partition, as data. Every status the server writes appears exactly once across these three
 * sets; test/applyRunHistory.test.js proves it against routes/apply.js rather than trusting a list.
 */
export const OUTCOME_STATUSES = Object.freeze({
  [OUTCOME.COMPLETED]: Object.freeze(["submitted"]),
  [OUTCOME.PENDING]:   Object.freeze(["queued", "running", "held_review", "held_gate"]),
  [OUTCOME.ABORTED]:   Object.freeze(["failed", "dismissed", "superseded", "cancelled"]),
});

/** How each group is named and coloured, in the user's terms rather than the schema's. */
export const OUTCOME_LABELS = Object.freeze({
  [OUTCOME.COMPLETED]: {
    label: "Completed",
    note: "sent to the employer",
    color: "#16a34a",
  },
  [OUTCOME.PENDING]: {
    label: "Pending",
    note: "queued, in flight, or waiting on you",
    color: "#d97706",
  },
  [OUTCOME.ABORTED]: {
    // Not "failed": three of the four statuses in this group are not failures. The group is
    // "ended without being sent", and each row still says which of those it was.
    label: "Aborted",
    note: "ended without being sent",
    color: "#dc2626",
  },
});

const STATUS_TO_OUTCOME = Object.freeze(Object.fromEntries(
  Object.entries(OUTCOME_STATUSES).flatMap(([group, statuses]) => statuses.map(s => [s, group])),
));

/**
 * Which of the three groups one run-job belongs to.
 *
 * @param {{status?: string, postingGone?: boolean, title?: string|null, company?: string|null}} job
 * @returns {"completed"|"pending"|"aborted"}
 */
export function outcomeGroupFor(job = {}) {
  const group = STATUS_TO_OUTCOME[job.status];
  // A status this partition has not met is ABORTED, not silently dropped and not quietly PENDING.
  // "We do not know what happened and nothing was sent" is the honest reading of an unknown
  // terminal state, and it is the reading that cannot mislead: it never claims a submission and
  // never leaves a row in a queue the user is expected to work through.
  if (!group) return OUTCOME.ABORTED;
  // The dead-posting override, applied last so it cannot double-map. Only PENDING is affected: a
  // SUBMITTED application whose posting was later cleaned up is still submitted — the posting going
  // away does not un-send it — and an already-aborted one is already here.
  const postingGone = job.postingGone ?? (job.title == null && job.company == null);
  if (group === OUTCOME.PENDING && postingGone) return OUTCOME.ABORTED;
  return group;
}

/** Whether a run-job can still be aborted: it has not finished, and nothing has been sent. */
export function isAbortable(job = {}) {
  return OUTCOME_STATUSES[OUTCOME.PENDING].includes(job.status);
}
