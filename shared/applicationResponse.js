// ── DID THE EMPLOYER REPLY? ──────────────────────────────────────────────────────────────────
//
// THIS IS NOT shared/applyOutcomeGroups.js, AND THE DISTINCTION IS THE WHOLE POINT.
// That file answers "did WE manage to submit?" — queued / running / submitted / held / failed. It
// is about our own pipeline and it ends the moment the form is sent. This file answers the next
// question, the one nothing in this system could answer before: "did the EMPLOYER respond?"
//
// Two different axes on the same application. A run can be `submitted` (their COMPLETED) and be
// ghosted (our NO_RESPONSE); a run can be `held_review` and the candidate sends it by hand and gets
// an interview. Neither vocabulary can be derived from the other, so they are separate files and
// the names deliberately do not overlap — OUTCOME there, RESPONSE_OUTCOME here.
//
// WHY IT EXISTS: AK1 made the ATS score's provenance recordable (migration 094 stores the score at
// the moment of applying). That is half of a pair. Without the other half — what the employer did —
// there is no way to ever answer whether the score predicts anything, which is the only honest test
// of a number nobody can compute exactly. This file is the other half.

/** What the employer did. Null/absent means "nothing recorded yet" — see MATURITY_DAYS. */
export const RESPONSE_OUTCOME = {
  /** Explicitly marked by the candidate: they never heard back. NOT the same as null. */
  NO_RESPONSE: "no_response",
  /** A rejection. This IS a response — it means a human (or a filter) read it and replied. */
  REJECTED: "rejected",
  /** Recruiter screen, phone screen, take-home — the first real engagement. */
  SCREEN: "screen",
  INTERVIEW: "interview",
  OFFER: "offer",
  /** The CANDIDATE ended it. Says nothing about the employer — see RESPONDED. */
  WITHDRAWN: "withdrawn",
};

export const RESPONSE_OUTCOMES = Object.freeze(Object.values(RESPONSE_OUTCOME));

/**
 * The outcomes that PROVE the employer engaged.
 *
 * REJECTED IS IN THIS SET, AND THAT IS THE IMPORTANT CALL. A rejection is a response: something
 * read the application and answered. For measuring whether a resume gets PAST THE SCREEN — which is
 * the only thing an ATS score could plausibly predict — a rejection and an interview are both
 * successes of the resume and only the interview is a success of the candidate. Lumping rejections
 * in with silence would measure hiring outcomes, not resume screening, and the score has no business
 * predicting the former.
 *
 * WITHDRAWN is deliberately absent: the candidate ended it, and we cannot tell from that alone
 * whether the employer had replied. Rows that carry a first_response_at still count as responses;
 * rows that do not are excluded from the denominator rather than counted as silence.
 */
export const RESPONDED = Object.freeze([
  RESPONSE_OUTCOME.REJECTED,
  RESPONSE_OUTCOME.SCREEN,
  RESPONSE_OUTCOME.INTERVIEW,
  RESPONSE_OUTCOME.OFFER,
]);

/**
 * How far a positive process got. Monotonic and never decreases — see mergeResponse.
 *
 * WHY furthest_stage IS STORED SEPARATELY FROM THE OUTCOME. An application goes screen → interview
 * → rejected. If only the current disposition were stored, that row would read `rejected` and be
 * indistinguishable from one rejected off the resume alone — erasing the interview, which is the
 * single most informative fact about whether the resume worked. The two columns answer different
 * questions and neither derives from the other: "how did it end" and "how far did it get".
 */
export const STAGE_RANK = Object.freeze({
  [RESPONSE_OUTCOME.SCREEN]: 1,
  [RESPONSE_OUTCOME.INTERVIEW]: 2,
  [RESPONSE_OUTCOME.OFFER]: 3,
});

/** Human labels. Kept beside the vocabulary so a UI cannot invent its own wording for a stored value. */
export const RESPONSE_LABELS = Object.freeze({
  [RESPONSE_OUTCOME.NO_RESPONSE]: { label: "No response", note: "never heard back", color: "#6b7280" },
  [RESPONSE_OUTCOME.REJECTED]:    { label: "Rejected",    note: "they replied, and it was no", color: "#dc2626" },
  [RESPONSE_OUTCOME.SCREEN]:      { label: "Screen",      note: "recruiter or phone screen", color: "#d97706" },
  [RESPONSE_OUTCOME.INTERVIEW]:   { label: "Interview",   color: "#2563eb", note: "interviewing" },
  [RESPONSE_OUTCOME.OFFER]:       { label: "Offer",       note: "offer received", color: "#16a34a" },
  [RESPONSE_OUTCOME.WITHDRAWN]:   { label: "Withdrawn",   note: "you ended it", color: "#6b7280" },
});

/**
 * How long an application must sit with nothing recorded before silence counts as a real negative.
 *
 * THIS IS THE MOST IMPORTANT NUMBER IN THIS FILE. Without it, an application sent yesterday and one
 * sent six months ago both read "no response", and any response-rate computed over them is biased
 * toward zero by however much recent activity there is. Early on — which is exactly when someone
 * will first look at this — almost every application is recent, so the naive rate would read near 0%
 * and look like a damning result about the resume when it is an artifact of the clock.
 *
 * 30 days: long enough that most employers who were going to reply have, short enough that the data
 * becomes usable within a hiring cycle. Applications younger than this are neither positive nor
 * negative — they are UNRESOLVED, and belong in no denominator.
 */
export const MATURITY_DAYS = 30;

export function isResponse(outcome) {
  return RESPONDED.includes(outcome);
}

/**
 * Which analysis bucket one application falls in.
 *
 * Three states, not two, and the third is the one that keeps the number honest:
 *   responded    — the employer engaged (or first_response_at proves they did)
 *   silent       — mature enough that nothing back means nothing coming
 *   unresolved   — too recent, or withdrawn before we learned anything. IN NO DENOMINATOR.
 */
export function responseBucket(app = {}, { now = Math.floor(Date.now() / 1000) } = {}) {
  const outcome = app.response_outcome ?? app.responseOutcome ?? null;
  const firstAt = app.first_response_at ?? app.firstResponseAt ?? null;
  if (firstAt != null || isResponse(outcome)) return "responded";
  if (outcome === RESPONSE_OUTCOME.NO_RESPONSE) return "silent";
  // WITHDRAWN with no recorded response tells us nothing about the employer.
  if (outcome === RESPONSE_OUTCOME.WITHDRAWN) return "unresolved";
  const appliedAt = app.applied_at ?? app.appliedAt ?? null;
  if (appliedAt == null) return "unresolved";
  return (now - appliedAt) >= MATURITY_DAYS * 86400 ? "silent" : "unresolved";
}

/**
 * Fold a newly reported outcome into what is already stored.
 *
 * MONOTONIC ON PURPOSE, in two ways:
 *   first_response_at is set once and never moved — it is the timestamp of the FIRST engagement,
 *   and overwriting it on a later stage would turn "how fast did they reply" into "when did this
 *   last change".
 *   furthest_stage only ever advances. Recording `rejected` after `interview` must not erase the
 *   interview; that is the fact worth keeping.
 *
 * Returns the columns to write. Pure — no clock of its own, no database.
 */
export function mergeResponse(existing = {}, next = {}, { now = Math.floor(Date.now() / 1000) } = {}) {
  const outcome = next.outcome ?? null;
  if (outcome != null && !RESPONSE_OUTCOMES.includes(outcome)) {
    throw new Error(`unknown response outcome: ${outcome}`);
  }
  const prevStage = existing.furthest_stage ?? null;
  const nextStage = STAGE_RANK[outcome] ? outcome : null;
  const furthest = (STAGE_RANK[nextStage] ?? 0) > (STAGE_RANK[prevStage] ?? 0) ? nextStage : prevStage;

  // An explicit "I never heard back" retracts any first_response_at — it is the candidate saying
  // the earlier record was wrong. Every other outcome only ever adds.
  let firstResponseAt = existing.first_response_at ?? null;
  if (outcome === RESPONSE_OUTCOME.NO_RESPONSE) {
    firstResponseAt = null;
  } else if (isResponse(outcome) && firstResponseAt == null) {
    firstResponseAt = next.respondedAt ?? now;
  }

  return {
    response_outcome: outcome,
    furthest_stage: outcome === RESPONSE_OUTCOME.NO_RESPONSE ? null : furthest,
    first_response_at: firstResponseAt,
    outcome_at: now,
    outcome_source: next.source ?? "manual",
  };
}
