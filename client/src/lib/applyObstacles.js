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
import { companyLabel } from "../../../shared/atsHosts.js";

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
  // `resumeBlocked` marks the outcomes a MISSING RESUME caused. It is what decides whether the
  // "Generate a resume" button belongs on a row (AB4 requirement 5), and it has to be a property of
  // the reason rather than of `resumeAvailable`: plenty of applications stop with no resume attached
  // for reasons a resume would not fix, and offering to generate one there points the user at the
  // wrong thing. A missing browser binary is the clearest case — the row correctly says "this needs
  // an operator, not you", and a Generate button beside it contradicts that.
  resume_unavailable: {
    obstacle: "No resume was generated, so there was nothing to attach",
    action: "Generate one for this job, and it will be attached on the next run",
    protective: false, retryable: true, resumeBlocked: true,
  },
  generation_failed: {
    obstacle: "The resume for this job could not be generated",
    action: "Generate one for this job and try again",
    protective: false, retryable: true, resumeBlocked: true,
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
  // ── Three statuses the server writes that this table did not describe ────────────────────────
  //
  // Found while building AC4's mapping, which requires every status to land in exactly one outcome
  // group. All three fell through to the unknown fallback below, so they rendered as their own
  // RAW CODE with the underscores swapped out — "dismissed", "superseded" — and were filed as
  // BROKEN, under "These broke". None of them broke:
  //
  //   dismissed   POST /api/apply/reject. The user said no. The `rejected` entry above was written
  //               for this and never matched it: reject writes status='dismissed' with
  //               reason_code='rejected', and BY_REASON has no 'rejected' key, so neither lookup
  //               hit. The sentence existed and was unreachable.
  //   superseded  POST /api/apply/approve and /api/apply/answers. This attempt was REPLACED by a
  //               newer run-job, which appears in its own right. Nothing went wrong and there is
  //               nothing to do — offering "Retry" on it would create a third attempt at a job
  //               already being attempted.
  //   cancelled   AC4's abort. The user stopped it deliberately, so it is protective by definition.
  dismissed:   { obstacle: "You rejected this one",         action: null, protective: true,  retryable: false },
  superseded:  { obstacle: "Replaced by a newer attempt",   action: null, protective: true,  retryable: false },
  cancelled:   { obstacle: "You stopped this one",          action: null, protective: true,  retryable: false },
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
    // Default false so a row only offers to generate a resume where a resume is genuinely the
    // blocker. Spreading `base` first means a table entry can opt in; nothing opts in by accident.
    resumeBlocked: base.resumeBlocked === true,
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

// ── OUTCOME, THEN COMPANY, THEN APPLICATION (TASK AB4) ───────────────────────────────────────
//
// A user applying to seven OpenAI roles wants them together. The panel listed applications in flat
// reverse-chronological order inside each section, so those seven were interleaved with everything
// else and the fact that they were all one employer — the fact that matters when a recruiter from
// that employer calls — was invisible.

/**
 * Group anything carrying a `company` into per-employer buckets.
 *
 * @param {Array} items       rows or grouped applications; anything with `.company`
 * @param {(item:any)=>number} whenOf  recency, for ordering within and between companies
 * @returns {Array<{company: string, items: Array, when: number}>}
 */
export function groupByCompany(items = [], whenOf = (i) => i.when || i.finishedAt || i.startedAt || i.createdAt || 0) {
  const byCompany = new Map();
  for (const item of items) {
    // Applications whose posting has been cleaned up have no company. They are collected under one
    // honest heading rather than each becoming its own single-item company group, which would read
    // as a list of employers the user has never heard of.
    //
    // AE3: keyed on the LABEL, not the raw value, so everything unnameable collapses into that one
    // group rather than a blank company and an ATS host each getting their own — two headings that
    // would render identically and mean the same thing. companyLabel is idempotent, so the group's
    // `company` can be rendered directly or passed through it again.
    const key = companyLabel(item.company);
    if (!byCompany.has(key)) byCompany.set(key, { company: key, items: [], when: 0 });
    const g = byCompany.get(key);
    g.items.push(item);
    g.when = Math.max(g.when, whenOf(item));
  }
  return [...byCompany.values()]
    .map(g => ({ ...g, items: [...g.items].sort((a, b) => whenOf(b) - whenOf(a)) }))
    // Biggest employer first, then most recent. Seven roles at one company is the group a user came
    // here to find; a single application is not.
    .sort((a, b) => b.items.length - a.items.length || b.when - a.when);
}

/**
 * Split stopped applications into the two things the requirement insists must stay distinguishable:
 * what BROKE, and what we deliberately held. "We protected you" and "this failed" need different
 * affordances and produce different feelings, and calling both "Failed" is what this work has been
 * undoing throughout.
 */
export function splitByFault(jobs = []) {
  const broke = [], held = [];
  for (const job of jobs) (describeApplication(job).protective ? held : broke).push(job);
  return { broke, held };
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

// ── CO-RESOLUTION: WHICH PROBLEMS ACTUALLY SHARE ONE CROSSING (TASK AC2) ─────────────────────
//
// The panel's grouping rule has two halves (see the note above groupByApplication): group by
// OBSTACLE when one action unblocks many, by APPLICATION when many obstacles block one. Inside a
// single application's problem list BOTH can be true at once — one of its three problems may also
// be blocking four other applications, while the other two are entirely its own.
//
// That is what this computes: for ONE application, which of its problems are co-resolvable with
// problems on OTHER applications, and how many applications each such action releases.
//
// IT COMPUTES NO GROUPING OF ITS OWN. Both groupings already exist upstream and are authoritative:
//
//   PORTAL SIGN-IN   GET /api/apply/gate-packets groups gate-crossing packets by expected_origin —
//                    the unit an activeTab grant is actually scoped to (G0). This reads that
//                    server-computed `portals` array. Re-deriving it from apply URLs client-side
//                    would be the second grouping the requirement forbids, and it would be wrong:
//                    the origin is a stored fact on the packet, not something a UI should parse
//                    back out of a URL.
//
//   SHARED QUESTION  GET /api/apply/questions already deduplicates questions across jobs and
//                    returns `blocking` — every run-job the question holds up. One answer, saved to
//                    custom_answers by exact question text, releases all of them.
//
// ── WHAT CAN BE CO-RESOLVED, AND WHAT CANNOT ────────────────────────────────────────────────
//
// Stated explicitly, because claiming co-resolution where it does not hold is worse than not
// grouping at all: it prices a ten-second fix at four applications and delivers one.
//
// CAN:
//   login_required        One sign-in, one origin. The grant survives every same-origin navigation
//                         (G0), so every application queued behind that origin genuinely continues.
//   a shared question     One answer stored by question text and reused verbatim on every form that
//                         asks it. The server has already proved the sharing by deduplicating.
//
// CANNOT — and each of these is grouped by origin or by reason UPSTREAM, so the temptation is real:
//   captcha_required      Grouped by origin in `portals` alongside login_required, because it is a
//                         gate reason. It is NOT co-resolvable: a CAPTCHA is a per-attempt human
//                         challenge, not a session grant. Solving one clears one. Excluded here by
//                         name rather than by omission, so the exclusion is visible.
//   ats_below_threshold   A per-resume score against a per-job description.
//   incomplete_form,
//   no_submit_button,
//   manual_review,
//   no_fields_discovered  Facts about ONE employer's form.
//   resume_unavailable,
//   generation_failed     One resume per job; generating one does not produce the others.
//   answers_changed_since_approval   A drift between one approval and one re-resolve.
//   daily_cap_reached     Clears with TIME, not with an action. A count of applications would imply
//                         an action that does not exist.
//   full_auto_disabled,
//   provider_review_only  Policy. There is no user action at all, so there is no count to offer.
//   browser_binary_not_found, internal_error, form_schema_*, gate_token_no_secret
//                         Operator problems. They may well affect many applications at once, but
//                         the person reading this panel cannot clear them, and "one action unblocks
//                         4" has to name an action the reader can actually take.

/** The gate reasons where one crossing really does release the whole batch. */
export const CO_RESOLVABLE_GATE_REASONS = Object.freeze(new Set(["login_required"]));

/**
 * Which HOLD an open question is the concrete form of, keyed by the question's own `reason`.
 *
 * A run-job holds with `manual_review` and the same hold ALSO surfaces as a row in
 * GET /api/apply/questions — one fact recorded twice, at two levels of detail: "the form asked
 * something only you can answer", and the question itself. Listing both reports one problem as two,
 * which is the per-problem inflation AB2 removed from the cards; worse, the grouped one would claim
 * to unblock 2 applications while the bare category beside it silently meant the same thing. So a
 * shared question CLAIMS its hold, and the specific statement is the one that survives.
 *
 * Keyed on the question's reason rather than "any question-shaped hold", because picking the first
 * plausible reason off a list is not a binding — it is a guess that lands differently depending on
 * which attempt happened to be newest. buildOpenQuestions emits exactly two reasons:
 *
 *   low_confidence  we HAD a value and would not send it        → low_confidence_answers
 *   unanswered      the form asked and we would not fill it     → manual_review, then incomplete_form
 *
 * `unanswered` lists two holds because the pipeline records that same situation under either code
 * depending on where it was detected (the completeness gate says incomplete_form, the resolver says
 * manual_review). manual_review is preferred where an application carries both: it is the narrower
 * claim — "only you can answer this" — and incomplete_form then correctly remains as its own
 * problem, since an application with both really does have a second empty field beyond the question.
 *
 * At most one hold per question, so two shared questions claim two holds and a third claims none
 * rather than swallowing an unrelated one.
 */
export const QUESTION_REASON_TO_HOLD = Object.freeze({
  low_confidence: ["low_confidence_answers"],
  unanswered:     ["manual_review", "incomplete_form"],
});

/**
 * One application's problems, with the co-resolvable ones lifted out and counted.
 *
 * @param {object} app        an entry from groupByApplication
 * @param {object} ctx
 * @param {Array}  ctx.portals    GET /api/apply/gate-packets `portals`, verbatim
 * @param {Array}  ctx.packets    GET /api/apply/gate-packets `packets`, verbatim
 * @param {Array}  ctx.questions  GET /api/apply/questions `questions`, verbatim
 * @returns {Array<{kind:"group"|"single", key:string, reasons:Array, unblocks:number,
 *   headline:string, detail:string|null, action:string|null, protective:boolean,
 *   origin?:string, host?:string, question?:string}>}
 */
export function resolutionPlan(app = {}, { portals = [], packets = [], questions = [] } = {}) {
  const reasons = app.reasons || [];
  const jobId = app.jobId != null ? String(app.jobId) : null;
  const claimed = new Set();          // reason indexes already spoken for by a group
  const groups = [];

  // ── 1. The portal batch ────────────────────────────────────────────────────────────────────
  // The PACKET is what knows which origin this application is queued behind. The reason code does
  // not, and the apply URL is not the same thing — a posting host and the login host it redirects
  // to routinely differ. Found by run-job first and by job second, the same precedence
  // handoffPacketFor uses and for the same reason: a re-run makes a new run-job, and the packet
  // prepared for the previous attempt is still the one that can be crossed.
  const rowIds = new Set((app.rows || []).map(r => r.id));
  const packet = packets.find(p => p.runJobId != null && rowIds.has(p.runJobId))
    || packets.find(p => jobId != null && String(p.jobId) === jobId)
    || null;
  const gateIdx = reasons.findIndex(r => CO_RESOLVABLE_GATE_REASONS.has(r.code));
  if (gateIdx !== -1 && packet) {
    const portal = portals.find(p => p.origin === packet.expectedOrigin);
    // count > 1 or nothing is amortised. A "batch" of one is just the problem, and presenting it as
    // a batch inflates one sign-in into an offer it cannot keep.
    if (portal && portal.count > 1) {
      claimed.add(gateIdx);
      groups.push({
        kind: "group", key: `portal:${portal.origin}`, reasons: [reasons[gateIdx]],
        unblocks: portal.count, origin: portal.origin, host: portal.host,
        headline: `Sign in to ${portal.host} once`,
        detail: `Releases this application and ${portal.count - 1} other${portal.count === 2 ? "" : "s"} queued behind the same portal. Each one is still reviewed by you before it is sent.`,
        action: "Sign in", protective: true,
      });
    }
  }

  // ── 2. A question that blocks more than this application ───────────────────────────────────
  // Matched on jobId, and counted on DISTINCT jobs: `blocking` carries one entry per RUN-JOB, so a
  // job held, re-run and held again appears twice and would otherwise read as two applications
  // unblocked. That is the same overcount AB2 removed from the cards.
  for (const q of questions) {
    const blockedJobs = [...new Set((q.blocking || []).map(b => String(b.jobId)))];
    if (jobId == null || !blockedJobs.includes(jobId)) continue;
    if (blockedJobs.length < 2) continue;
    // The hold this question IS, so it is not also listed as a bare category beneath itself. See
    // QUESTION_REASON_TO_HOLD: one fact recorded at two levels of detail, and the specific one wins.
    // Preference order within the mapping matters, so the search is by hold code rather than by
    // position — otherwise which hold gets claimed depends on which attempt happened to be newest.
    let backedIdx = -1;
    for (const code of QUESTION_REASON_TO_HOLD[q.reason] || []) {
      backedIdx = reasons.findIndex((r, i) => !claimed.has(i) && r.code === code);
      if (backedIdx !== -1) break;
    }
    if (backedIdx !== -1) claimed.add(backedIdx);
    groups.push({
      kind: "group", key: `question:${q.question}`,
      reasons: backedIdx !== -1 ? [reasons[backedIdx]] : [], unblocks: blockedJobs.length,
      question: q.question,
      headline: q.question,
      detail: `One answer. It is also blocking ${blockedJobs.length - 1} other application${blockedJobs.length === 2 ? "" : "s"}, and is saved and reused verbatim on every form that asks it.`,
      action: q.eligibility ? "Answer it — only you can state this" : "Answer once",
      protective: true,
    });
  }

  // ── 3. Everything else, in its own right ───────────────────────────────────────────────────
  const singles = reasons
    .map((r, i) => ({ r, i }))
    .filter(({ i }) => !claimed.has(i))
    .map(({ r }) => ({
      kind: "single", key: `reason:${r.code}`, reasons: [r], unblocks: 1,
      headline: r.obstacle, detail: r.detail && r.detail !== r.obstacle ? r.detail : null,
      action: r.action, protective: r.protective,
    }));

  // Amortised actions first: they are worth the most per click, and that is the entire argument for
  // separating them from the per-application list.
  return [...groups.sort((a, b) => b.unblocks - a.unblocks), ...singles];
}

/**
 * The short STATUS label and colour for one attempt — a single apply_run_jobs row.
 *
 * Distinct from describeApplication, which answers "what is in the way and what clears it" in a
 * sentence. This answers "how did this attempt end" in one word, for a pill beside a timestamp.
 * Both are needed and they are not the same question, but both are VOCABULARY, so both live here:
 * the moment a component writes `status === "held_review" ? "Review" : …` inline, that mapping has
 * a second copy and the surfaces can drift.
 *
 * held_gate reads as "Sign in", not "Review" and not "Failed". The portal wants an account or a
 * CAPTCHA before it will take an application, so the next move is the candidate's and it is a
 * specific one — a different message from "check these answers". Blue rather than amber for the
 * same reason: nothing is wrong here.
 *
 * @param {string} status
 * @param {string|null} accent  the theme's accent, for the one in-progress state that uses it
 */
export function attemptStatusChip(status, accent = null) {
  const BY_STATUS = {
    submitted:   { label: "Submitted", color: "#16a34a" },
    held_review: { label: "Review",    color: "#d97706" },
    held_gate:   { label: "Sign in",   color: "#2563eb" },
    failed:      { label: "Failed",    color: "#dc2626" },
    cancelled:   { label: "Aborted",   color: "#6b7280" },
    running:     { label: "Running",   color: accent || "#2563eb" },
    queued:      { label: "Queued",    color: "#6b7280" },
  };
  // An unknown status still renders — as itself, muted — rather than as a blank pill. A status this
  // table has not met is a fact worth seeing, not one worth hiding.
  return BY_STATUS[status] || { label: status || "—", color: "#6b7280" };
}
