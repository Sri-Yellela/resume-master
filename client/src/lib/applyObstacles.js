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
