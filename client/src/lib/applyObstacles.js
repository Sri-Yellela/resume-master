// ── THE OBSTACLE VOCABULARY ───────────────────────────────────────────────────────────────────
//
// The Auto Apply panel was organised around RUNS. "Run 47" is not a thing a user thinks about, and
// "0✓ 1 review ↗" three times is not readable. They think about a job they want and what is
// stopping them. So every row in that panel now names an OBSTACLE and an ACTION, and this file is
// the single place that decides what those are.
//
// IT ALSO UNFLATTENS THE TERMINAL VOCABULARY. The pipeline records a rich set of outcomes and the
// UI collapsed all of them into "Review" or "Failed", losing the distinction that matters most:
//
//     WE DELIBERATELY HELD THIS TO PROTECT YOU        vs        THIS BROKE
//
// A resume that scored below your threshold, a form with a question we refused to guess, and an
// application filled and waiting for your approval are all things the system did ON PURPOSE and
// correctly. A missing browser binary and a 500 from the generator are not. Showing both as "Failed"
// tells the user their pipeline is broken when it is in fact working exactly as designed — and
// showing both as "Review" tells them to go read something that no amount of reading will fix.
// `protective` is that distinction, and it is the field the panel colours on.
//
// Consumed by panels/AutoApplyPanel.jsx (the four sections) and by components/JobCard.jsx (the
// board's own application-state chip), so the board and the pipeline cannot describe the same
// application in two different ways.

/** The four surfaces. Mirrors the server's partition in routes/apply.js's GET /api/apply/runs. */
export const SECTION = {
  NEEDS_YOU: "needsYou",
  IN_FLIGHT: "inFlight",
  SUBMITTED: "submitted",
  STOPPED: "stopped",
};

// Per REASON CODE, because the status alone is too coarse — held_review covers "we filled it and
// want your approval", "the resume scored 61", and "the form had a question we would not guess",
// which need three different sentences and three different actions.
//
//   obstacle   what is in the way, in the user's terms. Never a status code.
//   action     the ONE thing that clears it. null when there is nothing to do but wait or read.
//   protective true when the system stopped ON PURPOSE. false when something went wrong.
//   retryable  true only where retrying can plausibly succeed — a 404 model id and a login wall
//              need different affordances, and offering "Retry" on the former is a lie.
const BY_REASON = {
  // ── Held on purpose ──────────────────────────────────────────────────────────────────────────
  awaiting_approval: {
    obstacle: "Filled and waiting for your approval",
    action: "Review the answers, then approve or reject",
    protective: true, retryable: false,
  },
  ats_below_threshold: {
    obstacle: "Resume scored below your ATS threshold",
    action: "Read the score, then approve it anyway or improve the resume",
    protective: true, retryable: false,
  },
  manual_review: {
    obstacle: "The form asked something only you can answer",
    action: "Answer it, and this application continues",
    protective: true, retryable: true,
  },
  low_confidence_answers: {
    obstacle: "Some answers were guessed and we would not send a guess",
    action: "Confirm or correct them",
    protective: true, retryable: true,
  },
  incomplete_form: {
    obstacle: "Required fields were left empty",
    action: "Fill in what is missing",
    protective: true, retryable: true,
  },
  answers_changed_since_approval: {
    obstacle: "The form changed after you approved it",
    action: "Re-read the answers and approve again",
    protective: true, retryable: false,
  },
  login_required: {
    obstacle: "The employer's portal wants you signed in",
    action: "Sign in once — every application on that portal continues",
    protective: true, retryable: true,
  },
  captcha_required: {
    obstacle: "The portal is behind a CAPTCHA or identity check",
    action: "Complete it yourself — this one cannot be automated",
    protective: true, retryable: false,
  },
  no_submit_button: {
    obstacle: "The form was filled but had no submit button we could find",
    action: "Open the filled form and submit it yourself",
    protective: true, retryable: false,
  },
  submit_unverified: {
    obstacle: "Submit was clicked but the page never confirmed it",
    action: "Open the form and check whether it went through",
    protective: true, retryable: false,
  },
  no_fields_discovered: {
    obstacle: "No form fields were found on the page",
    action: "Open the posting and apply yourself",
    protective: true, retryable: false,
  },

  // ── Actually broke ───────────────────────────────────────────────────────────────────────────
  resume_unavailable: {
    obstacle: "No resume was generated, so there was nothing to attach",
    action: "Retry — generation may succeed this time",
    protective: false, retryable: true,
  },
  internal_error: {
    obstacle: "Something went wrong on our side",
    action: "Retry",
    protective: false, retryable: true,
  },
  browser_binary_not_found: {
    obstacle: "The apply browser is not installed on the server",
    action: "This needs an operator, not you — retrying will not help",
    protective: false, retryable: false,
  },
  form_schema_empty: {
    obstacle: "The saved form layout for this employer is empty",
    action: "Retry — the layout is re-learned on the next attempt",
    protective: false, retryable: true,
  },
  form_schema_no_host: {
    obstacle: "The apply link did not resolve to a real site",
    action: "Open the posting and apply yourself",
    protective: false, retryable: false,
  },
  gate_packet_unparseable_url: {
    obstacle: "The sign-in hand-off link could not be built",
    action: "Open the posting and apply yourself",
    protective: false, retryable: false,
  },
  gate_token_no_secret: {
    obstacle: "The sign-in hand-off is not configured on the server",
    action: "This needs an operator, not you",
    protective: false, retryable: false,
  },
};

// Fallbacks, by STATUS, for a row whose reason code is absent or one this table has not met.
const BY_STATUS = {
  queued:      { obstacle: "Waiting its turn",              action: null, protective: true,  retryable: false },
  running:     { obstacle: "Filling the form now",          action: null, protective: true,  retryable: false },
  submitted:   { obstacle: "Sent to the employer",          action: null, protective: true,  retryable: false },
  held_gate:   { obstacle: "The employer's portal wants you signed in",
                 action: "Sign in once — every application on that portal continues",
                 protective: true, retryable: true },
  held_review: { obstacle: "Held for you to look at",       action: "Open it and decide", protective: true,  retryable: false },
  rejected:    { obstacle: "You rejected this one",         action: null, protective: true,  retryable: false },
  failed:      { obstacle: "This one did not complete",     action: "Retry", protective: false, retryable: true },
};

const IN_FLIGHT_STATUSES = new Set(["queued", "running"]);
const NEEDS_YOU_STATUSES = new Set(["held_review", "held_gate"]);

/** Which of the four sections a row belongs to. Total by exclusion — mirrors the server. */
export function sectionFor(status) {
  if (IN_FLIGHT_STATUSES.has(status)) return SECTION.IN_FLIGHT;
  if (NEEDS_YOU_STATUSES.has(status)) return SECTION.NEEDS_YOU;
  if (status === "submitted") return SECTION.SUBMITTED;
  return SECTION.STOPPED;
}

/**
 * The one description every surface uses.
 *
 * @param {{status?: string, reasonCode?: string|null, reasonDetail?: string|null}} job
 * @returns {{section: string, obstacle: string, action: string|null, protective: boolean,
 *   retryable: boolean, detail: string|null, code: string}}
 */
export function describeApplication(job = {}) {
  const status = job.status || "";
  const reason = job.reasonCode || "";
  const base = BY_REASON[reason]
    || BY_STATUS[status]
    // An unknown pairing must still read as a sentence, never as a raw code — that is the whole
    // point of this file. Underscores out, and it is filed as broken rather than protective,
    // because an outcome nobody has described is not one we can claim was deliberate.
    || {
      obstacle: reason ? reason.replace(/_/g, " ") : "This one stopped for a reason we have not seen before",
      action: "Open the posting and apply yourself",
      protective: false,
      retryable: false,
    };
  return {
    ...base,
    section: sectionFor(status),
    detail: job.reasonDetail || null,
    // Kept for tooling and logs. Deliberately NOT rendered as the row's label anywhere.
    code: reason || status || "unknown",
  };
}

// ── WHICH WAY TO GROUP ───────────────────────────────────────────────────────────────────────
//
// The panel had ONE grouping rule — by obstacle — and applied it everywhere. That is right for a
// portal sign-in and wrong for everything else, and the failure was visible: NEEDS YOU showed the
// same OpenAI application THREE TIMES, once per problem —
//
//     "the portal is behind a CAPTCHA"          1 APPLICATION
//     "the form asked something only you can answer"   1 APPLICATION
//     "held for you to look at"                 1 APPLICATION
//
// — three cards, one application, and each card claiming to be one application so the counts looked
// right while the panel was lying about how much work there was. It happens because the server
// returns one row per RUN-JOB: a job held, re-run, and held again for a different reason is three
// rows, and grouping those by their obstacle sentence scatters one application across three cards.
//
// THE RULE, and it has two halves because both cases are real:
//
//   group by OBSTACLE      when ONE action unblocks MANY applications
//                          → "Sign in to Workday once → 4 applications ready". A ten-second job
//                            priced as one. Shown as four rows it is priced as four.
//
//   group by APPLICATION   when MANY obstacles block ONE application
//                          → "OpenAI — Staff Engineer · 3 things to resolve". One card, one job,
//                            everything in its way listed inside it.
//
// The portal batching lives on the server (GET /api/apply/gate-packets groups gate-crossing packets
// by origin, which is the unit an activeTab grant is scoped to). This is the other half.

/**
 * Collapse held run-job rows into ONE entry per application, carrying every reason that blocks it.
 *
 * Ordered by how recently something happened to each application, so the thing the user just
 * watched hold is at the top. Within an application the reasons are newest-first for the same
 * reason, and deduplicated by obstacle: two attempts that hit the same wall are one thing to
 * resolve, not two.
 *
 * @param {Array} jobs run-job rows as GET /api/apply/runs returns them
 * @returns {Array<{jobId, id, company, title, applyUrl, when, attempts, rows, reasons, protective,
 *   primary, postingGone}>}
 */
export function groupByApplication(jobs = []) {
  const when = (j) => j.finishedAt || j.startedAt || j.createdAt || 0;
  const byJob = new Map();

  for (const job of jobs) {
    // jobId is the application's identity. A row with neither is its own island rather than being
    // merged into a bucket keyed `undefined` — which would collapse every unidentifiable row into
    // one card claiming to be one application.
    const key = job.jobId != null ? `job:${job.jobId}` : `row:${job.id}`;
    if (!byJob.has(key)) byJob.set(key, { key, rows: [] });
    byJob.get(key).rows.push(job);
  }

  return [...byJob.values()].map(({ key, rows }) => {
    const ordered = [...rows].sort((a, b) => when(b) - when(a));
    const newest = ordered[0];

    // Every distinct thing in this application's way. Deduplicated by the obstacle SENTENCE rather
    // than the reason code: two codes that render the same sentence are one thing to a reader, and
    // showing it twice is the per-problem duplication this function exists to end.
    const seen = new Set();
    const reasons = [];
    for (const row of ordered) {
      const d = describeApplication(row);
      if (seen.has(d.obstacle)) continue;
      seen.add(d.obstacle);
      reasons.push({ ...d, row });
    }

    // Company and role come from ANY row that has them: the newest attempt may post-date the
    // 7-day posting cleanup and carry nulls, while an earlier one still names the job. Falling
    // back to the newest row alone is what produced "One application — Held for you to look at",
    // which names neither the company nor the role, so the user cannot tell which job it is.
    const named = ordered.find(r => r.company || r.title) || newest;

    return {
      key,
      jobId: newest.jobId ?? null,
      id: newest.id,
      runId: newest.runId ?? null,
      company: named.company ?? null,
      title: named.title ?? null,
      applyUrl: ordered.find(r => r.applyUrl)?.applyUrl ?? null,
      atsScore: ordered.find(r => r.atsScore != null)?.atsScore ?? null,
      when: when(newest),
      // Attempts across every run, not the newest row's own counter: the user's question is "how
      // many times has this been tried", and that spans runs.
      attempts: ordered.reduce((n, r) => n + (r.attemptCount || 1), 0),
      rows: ordered,
      reasons,
      // One broken reason is enough to stop calling the whole thing deliberate.
      protective: reasons.every(r => r.protective),
      // What to lead with. The newest is the current state of the application, and it is the one
      // whose row carries the artifacts worth linking.
      primary: reasons[0],
      postingGone: !ordered.some(r => r.title),
    };
  }).sort((a, b) => b.when - a.when);
}

/**
 * The board's own chip: a short state for a job the user has queued or applied to.
 * Returns null when the job has no application, so the card renders nothing extra.
 */
export function boardApplicationChip(applyState) {
  if (!applyState || !applyState.status) return null;
  const d = describeApplication(applyState);
  const LABEL = {
    [SECTION.IN_FLIGHT]: applyState.status === "running" ? "Applying now" : "Queued",
    [SECTION.SUBMITTED]: "Applied",
    [SECTION.NEEDS_YOU]: "Needs you",
    [SECTION.STOPPED]:   d.protective ? "Stopped" : "Didn't send",
  };
  const TONE = {
    [SECTION.IN_FLIGHT]: "#2563eb",
    [SECTION.SUBMITTED]: "#16a34a",
    [SECTION.NEEDS_YOU]: "#d97706",
    [SECTION.STOPPED]:   d.protective ? "#6b7280" : "#dc2626",
  };
  return { label: LABEL[d.section], color: TONE[d.section], title: d.obstacle, section: d.section };
}

/** Human label for a missing apply prerequisite, plus the one action that clears it. */
export const PREREQUISITE_LABELS = {
  base_resume:   { obstacle: "No base resume on this profile", action: "Upload one in Job Profiles", to: "job-profiles" },
  active_profile:{ obstacle: "No active job profile",           action: "Create one",                 to: "job-profiles" },
  profile_email: { obstacle: "Your profile has no email address", action: "Add it in your profile",   to: "profile" },
  profile_name:  { obstacle: "Your profile has no name",        action: "Add it in your profile",     to: "profile" },
};
