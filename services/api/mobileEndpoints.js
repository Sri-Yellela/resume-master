/**
 * THE MOBILE ENDPOINT SURFACE — what the two mobile repositories may call, and nothing else.
 * ================================================================================================
 *
 * SCOPE, AND WHY IT IS DELIBERATELY SMALL
 *
 * The server exposes roughly 190 /api routes. This lists the 27 a swipe feed and a review flow
 * actually need. Publishing the rest would not be generous, it would be a promise: anything named
 * in a contract is something the mobile repos may depend on and this repo may not change without
 * a version bump. So the list is the minimum that makes the product work, and growing it is a
 * decision, not a default.
 *
 * WHAT IS DELIBERATELY ABSENT, each for a reason:
 *   - every /api/admin/* route            a phone is not an admin console
 *   - the gated-handoff endpoints         unresolvable without the extension (see MOBILE_TIER_GATING)
 *   - /api/apply/form-schema*             capture is a desktop-browser concern
 *   - PDF/HTML resume editing             viewing is feasible on a phone, editing is a different product
 *   - the standalone/* surface            a separate anonymous product with its own user table
 *   - /api/sync/events (SSE)              works, but a mobile client should use polling or push;
 *                                         an SSE socket held open by a backgrounded app is a
 *                                         battery and reconnection problem, not a feature
 *
 * THE `mobileNotes` FIELD IS NOT DECORATION. Where an endpoint has a shape a greenfield client
 * would get wrong — a toggle that looks like a setter, a 202 that is not a submission, a list
 * capped at 50 with no way to page — it is stated on the endpoint. That note is the entire value
 * of a contract over a route list.
 */
"use strict";

/** HTTP error bodies this API actually returns, referenced by name so they are written once. */
export const ERROR_SHAPES = Object.freeze({
  Unauthorized:      { status: 401, shape: { error: "string" }, example: { error: "Unauthorized." },
                       description: "No valid cookie session and no valid bearer token. A mobile client must treat this as 'sign in again' — it is also what an expired or revoked token produces." },
  Forbidden:         { status: 403, shape: { error: "string" }, example: { error: "Forbidden." },
                       description: "Authenticated, but not permitted. Admin routes answer this to a non-admin; ownership failures answer 403 or 404 depending on the route." },
  NotFound:          { status: 404, shape: { error: "string" }, example: { error: "Job not found" },
                       description: "The object does not exist OR is not yours. The two are deliberately indistinguishable on user-scoped routes — telling a stranger that an id exists is itself a disclosure." },
  BadRequest:        { status: 400, shape: { error: "string" }, example: { error: "jobIds array required" } },
  FeedBadRequest:    { status: 400, shape: { success: "boolean", error: "string", code: "string", jobs: "Job[]", total: "number" },
                       example: { success: false, error: "This cursor was issued for a different sort or profile. Request the first page again.", code: "cursor_sort_mismatch", jobs: [], total: 0 },
                       description: "GET /api/jobs validates enumerated filter values BEFORE querying, so an unknown value is a 400 rather than a silently empty board. The body still carries jobs:[] and total:0 so a client that renders the list unconditionally does not throw on top of the error. `code` is present only on cursor rejections — `cursor_sort_mismatch` (the cursor belongs to a different ordering; start the feed over) or `cursor_malformed`. A filter-validation 400 carries `error` alone." },
  Conflict:          { status: 409, shape: { error: "string", message: "string" },
                       example: { error: "no_approvable_jobs", message: "None of those applications are awaiting approval." } },
  Gone:              { status: 410, shape: { error: "string" },
                       description: "A RETIRED endpoint. See RETIRED_ENDPOINTS — a client written from stale documentation will hit these, and the body says what to call instead." },
  Unavailable:       { status: 503, shape: { available: "boolean", reason: "string|null" },
                       example: { available: false, reason: "no_browser" },
                       description: "Auto-apply cannot run right now. Not an error in the client — a state to render." },
  ServerError:       { status: 500, shape: { error: "string" } },
});

const AUTH = Object.freeze({
  BEARER: "bearer",   // Authorization: Bearer <token>, or X-RM-Auth-Context: <token>
  PUBLIC: "public",
});

/**
 * THE SURFACE. `response` names a schema in the generated document; `$Job` is the mapJobRow shape,
 * which is derived and never typed out.
 */
export const MOBILE_ENDPOINTS = Object.freeze([

  // ── AUTH ───────────────────────────────────────────────────────────────────────────────────
  {
    group: "auth", method: "POST", path: "/api/auth/login", auth: AUTH.PUBLIC,
    summary: "Sign in with username and password.",
    body: { username: "string", password: "string" },
    response: "AuthLoginResponse",
    errors: ["BadRequest", "Unauthorized"],
    mobileNotes:
      "The token in `authContext` is SESSION-BOUND (session_sid = the throwaway sid of this request) " +
      "and is NOT the credential a mobile app should keep. Exchange it immediately at " +
      "GET /api/auth/mobile-token and discard it. Storing this one means your token is filed under " +
      "a browser session that does not exist, and any browser sign-out sweeping that sid revokes it.",
  },
  {
    group: "auth", method: "POST", path: "/api/auth/register", auth: AUTH.PUBLIC,
    summary: "Create an account. Returns the same authContext as login.",
    body: { username: "string", password: "string", profile: "object|null" },
    response: "AuthLoginResponse",
    errors: ["BadRequest"],
    mobileNotes: "Same exchange requirement as login.",
  },
  {
    group: "auth", method: "GET", path: "/api/auth/mobile-token", auth: AUTH.BEARER,
    summary: "Mint the durable, cookie-less mobile credential. THE mobile auth step.",
    response: "MobileTokenResponse",
    errors: ["Unauthorized"],
    mobileNotes:
      "sessionLess: the returned token has session_sid NULL, so revokeBrowserAuthContexts never " +
      "sweeps it and signing out of a browser cannot silently kill the phone. Its idle window slides " +
      "on every authenticated request (idleSeconds) up to a hard ceiling from issue (absoluteSeconds), " +
      "so an app in regular use is never signed out on a timer. Both numbers are returned rather than " +
      "documented, so a client shows a real expiry instead of a hardcoded guess.",
  },
  {
    group: "auth", method: "POST", path: "/api/auth/revoke-mobile-token", auth: AUTH.BEARER,
    summary: "Revoke every mobile token for this user. 'Sign out all my devices'.",
    response: "OkResponse", errors: ["Unauthorized"],
    mobileNotes: "Revokes MOBILE tokens only. The extension and the browser are untouched — that " +
      "independence is why this is a separate endpoint from revoke-extension-token.",
  },
  {
    group: "auth", method: "GET", path: "/api/auth/me", auth: AUTH.PUBLIC,
    summary: "Who the caller is. Answers 200 with authenticated:false rather than 401.",
    response: "AuthMeResponse", errors: [],
    mobileNotes: "The correct cold-start call. It does not 401, so it distinguishes 'token expired' " +
      "from 'network down' — which a 401-throwing endpoint cannot.",
  },
  {
    group: "auth", method: "POST", path: "/api/auth/logout", auth: AUTH.PUBLIC,
    summary: "Sign out. Revokes the presented token.",
    response: "LogoutResponse", errors: [],
  },
  {
    group: "auth", method: "GET", path: "/api/auth/active-profile", auth: AUTH.BEARER,
    summary: "The active domain profile: the scope EVERY board query is answered in.",
    response: "ActiveProfileResponse", errors: ["Unauthorized", "NotFound"],
    mobileNotes:
      "404 here is a PRECONDITION FAILURE, not an error to swallow. The board is scoped per domain " +
      "profile, and with none active GET /api/jobs answers an empty list. Render 'create a job " +
      "profile', not 'no jobs found'.",
  },

  // ── THE FEED ───────────────────────────────────────────────────────────────────────────────
  {
    group: "feed", method: "GET", path: "/api/jobs", auth: AUTH.BEARER,
    summary: "The board: the paged, profile-scoped, filtered job feed. The swipe feed's source.",
    query: {
      cursor: "string",
      page: "number", pageSize: "number", q: "string", location: "string", sort: "enum:sort",
      experience_levels: "enum:experienceLevel[]", work_models: "enum:workplaceType[]",
      employment_type: "enum:employmentType[]",
      tiers_include: "enum:automationTier[]", tiers_exclude: "enum:automationTier[]",
      starred: "boolean", visited: "boolean", applied: "boolean",
      include_fields: "string", include_facets: "string",
    },
    response: "JobFeedResponse",
    errors: ["FeedBadRequest", "Unauthorized", "ServerError"],
    mobileNotes:
      "A SWIPE FEED MUST PAGE BY `cursor`, NOT BY `page`. Offset paging assumes a stable result " +
      "set; this one is not. A dislike sets disliked=1 and the default board EXCLUDES disliked " +
      "rows, so the set shrinks BEHIND the reader: swipe four rows away on page 1 and page 2 " +
      "starts four rows further down than it should. Those four are never shown, `total` still " +
      "counts them, and nothing reports the loss. Measured on a 25-job board with 3 swipes per " +
      "page: offset paging skipped 6 jobs, the cursor skipped 0. " +
      "Omit `cursor` for the first page, then follow `nextCursor` until it is null. " +
      "A cursor is bound to the ordering it was issued under — change `sort` (or switch domain " +
      "profile, which changes the derived relevance keys) and it answers 400 " +
      "`cursor_sort_mismatch` rather than silently returning an arbitrary slice. Start over. " +
      "`page`/`pageSize` still work unchanged for a paged list view. " +
      "Send include_fields to drop `description` from feed rows; it is the largest field by far " +
      "and a card never shows it. " +
      "`reason: 'cache_empty'` on an empty body means the pool is empty, NOT that the filters " +
      "matched nothing — a client must not render 'no results, try widening' for it.",
  },
  {
    group: "feed", method: "GET", path: "/api/jobs/by-id/{jobId}", auth: AUTH.BEARER,
    summary: "One posting in full, with this caller's own starred/visited/disliked flags.",
    params: { jobId: "string" },
    response: "JobDetailResponse",
    errors: ["BadRequest", "Unauthorized", "NotFound"],
  },
  {
    group: "feed", method: "GET", path: "/api/jobs/facets", auth: AUTH.BEARER,
    summary: "Facet counts over the same filtered set, for filter-sheet badges.",
    response: "FacetsResponse", errors: ["Unauthorized"],
  },

  // ── THE SWIPE ──────────────────────────────────────────────────────────────────────────────
  {
    group: "swipe", method: "PATCH", path: "/api/jobs/interact", auth: AUTH.BEARER,
    summary: "Set starred / disliked to an ABSOLUTE value. The endpoint a swipe must use.",
    body: { jobId: "string", url: "string", starred: "boolean", disliked: "boolean" },
    response: "InteractResponse",
    errors: ["BadRequest", "Unauthorized", "NotFound"],
    mobileNotes:
      "USE THIS, NOT PATCH /api/jobs/{id}/starred. The per-id routes TOGGLE: they read the current " +
      "value and write its opposite. A swipe is an absolute gesture ('save this'), and on a phone " +
      "network a retried or double-sent toggle silently UNDOES the user's swipe with a 200. This " +
      "endpoint sets the value you send, so it is idempotent and safe to retry — which is why the " +
      "toggle routes are not in this contract at all.",
  },
  {
    group: "swipe", method: "PATCH", path: "/api/jobs/{id}/visited", auth: AUTH.BEARER,
    summary: "Mark a posting as seen.",
    params: { id: "string" },
    response: "OkResponse", errors: ["Unauthorized", "NotFound"],
  },

  // ── QUEUE AND APPROVE ──────────────────────────────────────────────────────────────────────
  {
    group: "apply", method: "GET", path: "/api/apply/readiness", auth: AUTH.BEARER,
    summary: "Whether auto-apply can run at all right now.",
    response: "ReadinessResponse", errors: ["Unauthorized", "Unavailable"],
    mobileNotes: "503 is a STATE, not a failure. Render it; do not retry it in a loop.",
  },
  {
    group: "apply", method: "POST", path: "/api/apply/runs", auth: AUTH.BEARER,
    summary: "Queue jobs for an apply run. Max 25 per call.",
    body: { jobIds: "string[]", mode: "string", tool: "string", approvalMode: "string|null" },
    response: "RunQueuedResponse",
    errors: ["BadRequest", "Unauthorized", "Conflict"],
    mobileNotes:
      "202 MEANS QUEUED, NOT SUBMITTED, and this is the single most dangerous thing for a mobile " +
      "client to get wrong: showing 'Applied' here claims something that has not happened. By " +
      "default the run PREVIEWS and parks in held_review for approval; nothing reaches an employer " +
      "until POST /api/apply/approve. " +
      "`queued` is the ids ACCEPTED — it is shorter than `jobIds` when duplicates were dropped, so " +
      "report queued.length, never jobIds.length. " +
      "Send Idempotency-Key: a retry on a flaky connection otherwise queues the run twice. " +
      "approvalMode:'approved' is REJECTED with 400 — it is reserved for the approve endpoint, so " +
      "no client can submit without previewing. Gate on automationTier before queueing at all " +
      "(x-mobile-tier-gating).",
    headers: { "Idempotency-Key": "string" },
  },
  {
    group: "apply", method: "GET", path: "/api/apply/pending", auth: AUTH.BEARER,
    summary: "Applications previewed and awaiting the user's approval. The review inbox.",
    response: "PendingResponse", errors: ["Unauthorized"],
    mobileNotes: "Capped at 100 rows, newest first, with NO pagination parameter. See x-mobile-gaps.",
  },
  {
    group: "apply", method: "POST", path: "/api/apply/approve", auth: AUTH.BEARER,
    summary: "Approve previewed applications and submit them. THE moment of submission.",
    body: { runJobIds: "number[]" },
    response: "ApproveResponse",
    errors: ["Unauthorized", "Conflict"],
    headers: { "Idempotency-Key": "string" },
    mobileNotes:
      "Approved rows are SUPERSEDED rather than mutated, so the preview stays in the audit trail " +
      "and a NEW runJobId carries the submission — do not expect the id you sent to become " +
      "'submitted'. 409 no_approvable_jobs means the rows are no longer awaiting a decision " +
      "(already approved, rejected, or expired), which on a phone usually means another device got " +
      "there first: re-fetch /api/apply/pending rather than showing an error.",
  },
  {
    group: "apply", method: "POST", path: "/api/apply/reject", auth: AUTH.BEARER,
    summary: "Reject previewed applications. Nothing is sent.",
    body: { runJobIds: "number[]" },
    response: "RejectResponse", errors: ["Unauthorized", "Conflict"],
  },
  {
    group: "apply", method: "GET", path: "/api/apply/runs", auth: AUTH.BEARER,
    summary: "Recent runs, newest first. Capped at 20.",
    response: "RunListResponse", errors: ["Unauthorized"],
  },
  {
    group: "apply", method: "GET", path: "/api/apply/runs/{runId}", auth: AUTH.BEARER,
    summary: "One run and its jobs.",
    params: { runId: "number" },
    response: "RunDetailResponse", errors: ["Unauthorized", "NotFound"],
  },
  {
    group: "apply", method: "GET", path: "/api/apply/run-jobs/{runJobId}/review", auth: AUTH.BEARER,
    summary: "Everything shown before approving: answers, provenance, blanks, ATS score.",
    params: { runJobId: "number" },
    response: "RunJobReviewResponse", errors: ["Unauthorized", "NotFound"],
  },
  {
    group: "apply", method: "GET", path: "/api/apply/run-jobs/{runJobId}/resume", auth: AUTH.BEARER,
    summary: "The generated resume PDF for this application.",
    params: { runJobId: "number" },
    response: "BinaryPdf", errors: ["Unauthorized", "NotFound"],
    mobileNotes: "application/pdf, not JSON. Render it in a viewer; editing is not a mobile flow.",
  },
  {
    group: "apply", method: "GET", path: "/api/apply/run-jobs/{runJobId}/screenshot", auth: AUTH.BEARER,
    summary: "The screenshot of the filled form, as evidence of what was about to be sent.",
    params: { runJobId: "number" },
    response: "BinaryImage", errors: ["Unauthorized", "NotFound"],
  },
  {
    group: "apply", method: "POST", path: "/api/apply/run-jobs/{runJobId}/abort", auth: AUTH.BEARER,
    summary: "Cancel an in-flight or held application.",
    params: { runJobId: "number" },
    response: "OkResponse", errors: ["Unauthorized", "NotFound"],
  },
  {
    group: "apply", method: "GET", path: "/api/apply/history", auth: AUTH.BEARER,
    summary: "One DAY of application history, partitioned into completed / pending / aborted.",
    query: { date: "string", tzOffset: "number", group: "enum:applyOutcome" },
    response: "ApplyHistoryResponse",
    errors: ["BadRequest", "Unauthorized"],
    mobileNotes:
      "`date=YYYY-MM-DD` is REQUIRED — without it this is a 400 (`bad_date`), not a default to " +
      "today. Send `tzOffset` (minutes) or the day is bucketed in UTC and a late-evening " +
      "application lands on the wrong date for the user. " +
      "THE RESPONSE IS TWO DIFFERENT SHAPES: with `group`, rows come back under `jobs`; without " +
      "it, under `completed` / `pending` / `aborted`. A client must branch on which it asked for. " +
      "`total` and `counts` are always the WHOLE DAY, never the asked-for slice — so an empty " +
      "completed tab on a busy day does not claim the day was empty. " +
      "An unrecognised `group` is a 400 rather than a silent fallback to all three. " +
      "`abortable` on each row is decided by the SERVER: do not re-derive it, or the button's " +
      "presence and the endpoint's guard will disagree.",
  },
  {
    group: "apply", method: "GET", path: "/api/apply/history/months/{month}", auth: AUTH.BEARER,
    summary: "Which dates in a month have activity, for a calendar marker.",
    params: { month: "string" },
    query: { tzOffset: "number" },
    response: "ApplyHistoryMonthResponse",
    errors: ["BadRequest", "Unauthorized"],
    mobileNotes: "`month` is YYYY-MM; anything else is a 400 (`bad_month`). A count-per-day " +
      "aggregate, not rows — cheap enough to call when a date picker opens.",
  },
  {
    group: "apply", method: "GET", path: "/api/apply/status/{jobId}", auth: AUTH.BEARER,
    summary: "Have I applied to this job? Answers about the CALLER.",
    params: { jobId: "string" },
    response: "ApplyStatusResponse", errors: ["Unauthorized"],
    mobileNotes: "Answers 200 for any job id, including one you do not own — it is a question about " +
      "you, not a request for an object, so it discloses nothing and a 404 would be the wrong answer.",
  },

  // ── CUSTOM ANSWERS ─────────────────────────────────────────────────────────────────────────
  {
    group: "answers", method: "GET", path: "/api/apply/questions", auth: AUTH.BEARER,
    summary: "Questions blocking held applications, de-duplicated across employers.",
    response: "QuestionsResponse", errors: ["Unauthorized"],
    mobileNotes:
      "`answered` means answered FOR EVERY employer still blocked on it — a template answered for " +
      "one company does not unblock the same question at another, so do not treat it as a global " +
      "flag. `needsOwnWords: true` marks a question the system will NEVER auto-answer however full " +
      "the store gets; `draft` is a starting point to be edited, not an answer to submit. " +
      "`eligibility: true` marks an attestation to an employer — present it as one.",
  },
  {
    group: "answers", method: "POST", path: "/api/apply/answers", auth: AUTH.BEARER,
    summary: "Save answers, optionally retrying the applications they unblock.",
    body: { answers: "object", overrides: "object", retryJobIds: "string[]|null", mode: "string" },
    response: "AnswersResponse",
    errors: ["BadRequest", "Unauthorized"],
    headers: { "Idempotency-Key": "string" },
    mobileNotes:
      "Answers are keyed by the EXACT question text captured from the form. `overrides` is keyed by " +
      "company for per-employer answers. A retry re-enters the approval flow — answering unblocks " +
      "the job, it does not authorise the submission.",
  },

  // ── PROFILE ────────────────────────────────────────────────────────────────────────────────
  {
    group: "profile", method: "GET", path: "/api/profile", auth: AUTH.BEARER,
    summary: "The autofill profile: the identity and eligibility answers used to fill forms.",
    response: "UserProfileResponse", errors: ["Unauthorized"],
    mobileNotes: "snake_case, unlike the job shape — it is the user_profile row returned directly. " +
      "This is a genuine inconsistency in the API and it is documented rather than papered over, " +
      "because a client that assumes camelCase here silently sends every field as null.",
  },
  {
    group: "profile", method: "POST", path: "/api/profile", auth: AUTH.BEARER,
    summary: "Write the autofill profile.",
    body: "UserProfileWrite",
    response: "OkResponse", errors: ["Unauthorized"],
    mobileNotes:
      "ABSENT IS NOT EMPTY, but ONLY for the two answer maps. custom_answers and " +
      "custom_answer_overrides are PRESERVED when omitted; EVERY OTHER COLUMN IS OVERWRITTEN " +
      "UNCONDITIONALLY, so a partial POST wipes the fields it left out. Read, merge, then write the " +
      "whole object — there is no PATCH.",
  },
  {
    group: "profile", method: "GET", path: "/api/domain-profiles", auth: AUTH.BEARER,
    summary: "The user's domain profiles. Exactly one is active and scopes the board.",
    response: "DomainProfileListResponse", errors: ["Unauthorized"],
  },
  {
    group: "profile", method: "POST", path: "/api/domain-profiles/{id}/activate", auth: AUTH.BEARER,
    summary: "Switch the active profile. Changes what the whole board returns.",
    params: { id: "number" },
    response: "DomainProfile", errors: ["Unauthorized", "NotFound"],
    mobileNotes: "Returns the NOW-ACTIVE profile row, not an { ok } acknowledgement. " +
      "Discard every cached feed page after this: board rows, starred flags and visited flags are " +
      "all per domain_profile_id, so a page fetched under the old profile is not merely stale — it " +
      "is about a different scope.",
  },
]);

/**
 * RETIRED — requirement 5. Every one of these answers 410 with a body naming the replacement.
 *
 * A GREENFIELD CLIENT IS EXACTLY THE CLIENT THAT WILL CALL THESE. It is written from whatever
 * documentation is to hand, and this repository's older docs describe several of them as live —
 * docs/mobile-linkedin-import.md is written in the present indicative about a feature that has
 * never existed. Naming the retirements in the contract is cheaper than a store review.
 *
 * They are 410 rather than 404 deliberately: 404 reads as "wrong URL, check your typing" and 410
 * reads as "this is gone on purpose", which is the true statement.
 */
export const RETIRED_ENDPOINTS = Object.freeze([
  { method: "POST", path: "/api/scrape", status: 410, since: "E2",
    replacement: "GET /api/jobs",
    body: "External scraping has been removed. Job search now uses /api/jobs." },
  { method: "ALL", path: "/api/extension/save-job", status: 410, since: "E2",
    replacement: "POST /api/import/job",
    body: "Redirects callers to /api/import/job." },
  { method: "ALL", path: "/api/imported-jobs/*", status: 410, since: "E2",
    replacement: "GET /api/jobs?starred=true",
    body: "Imported jobs have been merged into the main board. Captured jobs appear under Saved." },
  // These two answer { error: "gone", message: "<sentence>" } — a short machine code in `error`
  // and the prose in `message`, unlike the others which put the whole sentence in `error`. Both
  // conventions are live, so a client parsing a 410 must read BOTH keys.
  { method: "POST", path: "/api/apply/session/save", status: 410, since: "AF",
    replacement: null, errorCode: "gone",
    body: "Portal sessions are no longer stored on the server. A portal that wants you signed in is " +
      "handed to your own browser: sign in once there and every application queued behind that " +
      "portal continues." },
  { method: "GET", path: "/api/apply/session/{domain}", status: 410, since: "AF",
    replacement: null, errorCode: "gone",
    body: "Portal sessions are no longer stored on the server. A portal that wants you signed in is " +
      "handed to your own browser: sign in once there and every application queued behind that " +
      "portal continues." },
  { method: "PATCH", path: "/api/settings/apply-mode", status: 410, since: "entitlements",
    replacement: null,
    body: "Plans control tool access." },
]);

/**
 * WHAT A MOBILE CLIENT NEEDS THAT THIS API DOES NOT EXPOSE — requirement 8.
 *
 * Reported rather than built: each of these is a server change with its own design, and inventing
 * them inside a contract task would be exactly the unbudgeted scope creep the audit warned about.
 * They are published INSIDE the contract document so the mobile repos plan around them instead of
 * discovering them one at a time.
 */
export const MOBILE_GAPS = Object.freeze({
  pagination: {
    severity: "RESOLVED",
    what: "GET /api/jobs paged by OFFSET, which silently skipped jobs on a swipe feed. FIXED — " +
      "it now supports a keyset cursor. Kept in this list rather than deleted, so a mobile team " +
      "reading an older copy of the contract learns the fix exists instead of building the " +
      "client-side workaround this entry used to recommend.",
    why:
      "Offset pagination assumes a stable result set. A swipe feed mutates the set it is paging " +
      "through: every dislike sets disliked=1, and the default board EXCLUDES disliked rows. So " +
      "each swipe shortened the list behind the reader, every subsequent row shifted up by one, " +
      "and page 2 SKIPPED as many jobs as the user swiped away on page 1 — never shown, still " +
      "counted in `total`, with nothing reporting the loss. A desktop board never hit this because " +
      "it does not mutate membership while paging.",
    fix:
      "DONE. Send `?cursor=` and follow `nextCursor` until it is null. The cursor anchors to the " +
      "last row's own sort VALUES rather than to a position, so removals behind it cannot move it. " +
      "Implemented in services/jobs/jobCursor.js, which generates the ORDER BY and the cursor's " +
      "resume predicate from ONE key-list declaration — written twice they would drift, and a " +
      "cursor that disagrees with its ORDER BY does not error, it returns the wrong rows.",
    verified:
      "test/jobsKeysetCursor.test.js asserts the DEFECT first (offset paging really does lose one " +
      "row per removal on the fixture) and then that the cursor does not — without that half a " +
      "cursor walk over an unchanging board would pass trivially. scripts/aj1MobileBearer.mjs " +
      "repeats it over real HTTP: on a 25-job board with 3 swipes per page, offset paging skipped " +
      "6 jobs and the cursor skipped 0.",
    caveat:
      "`total` is still a snapshot and shrinks as the user swipes. It is a progress denominator, " +
      "not a promise about how many more are coming.",
  },
  reviewInboxPaging: {
    severity: "minor",
    what: "GET /api/apply/pending is capped at 100 and GET /api/apply/questions at 50, neither pageable.",
    why: "A backlog past the cap is invisible with no indication that it was truncated. On desktop " +
      "the caps are generous; on a phone, where a user reviews in short bursts, a backlog is normal.",
    fix: "A page parameter, or a total count so the client can say the list is truncated.",
  },
  resumeExistsOnJob: {
    severity: "product",
    what: "No field says whether a resume already exists for a job.",
    why: "Structurally absent from mapJobRow — it maps a JOB, and resume currency is a per " +
      "(user, job, tool, profile) question needing a join to resumes and profile_base_resumes. " +
      "A swipe card cannot show 'already generated' without a second request per card. " +
      "Documented in docs/SWIPE_FEED_DESIGN.md Finding 6.",
    fix: "A joined boolean on the feed row, or a bulk endpoint taking many job ids at once.",
  },
  atsPlatformBadge: {
    severity: "product",
    what: "No trustworthy field names the ATS a candidate will face.",
    why: "sourcePlatform LOOKS like it, and is not — it reads j.sourcePlatform (camelCase) against " +
      "a source_platform column, so it always resolves to `source`, i.e. where the job was found. " +
      "It happens to look right only because both current scrapers are named after the ATSes they " +
      "scrape. Add one aggregator source and the badge lies. " +
      "automationTier IS trustworthy and is derived from detectPlatformFromUrl(apply_url) — use it.",
    fix: "Persist detectPlatformFromUrl(apply_url) as a real field, or repair sourcePlatform.",
  },
  pushNotifications: {
    severity: "product",
    what: "No push transport. Realtime is server-sent events at GET /api/sync/events.",
    why: "An SSE connection requires a foregrounded process. A backgrounded iOS or Android app " +
      "cannot hold one, so 'your application needs approval' cannot reach a user who is not " +
      "looking at the app — which is precisely when it matters.",
    fix: "APNs/FCM device registration and a server-side sender. A real project, not a field.",
  },
});

export { AUTH as AUTH_MODES };
