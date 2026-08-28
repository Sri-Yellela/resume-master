/**
 * RESPONSE SHAPES — the declared half of the contract.
 * ================================================================================================
 *
 * WHAT IS DERIVED AND WHAT IS DECLARED, AND WHY THE LINE IS WHERE IT IS
 *
 * The `Job` schema is NOT in this file. It is derived by executing mapJobRow (services/api/
 * mobileContract.js), because mapJobRow is a field whitelist and is therefore the one shape that
 * is mechanically knowable — every job reaching any client passes through it, so its key set IS
 * the constraint.
 *
 * The envelopes below have no such single chokepoint. They are built inline in each route handler,
 * so there is nothing to execute that would yield their shape without booting the server and
 * seeding a database. Declaring them is the honest option; pretending they are derived would be
 * worse than declaring them, because a reader would trust them more than they should.
 *
 * WHAT KEEPS THEM HONEST INSTEAD. Two things, neither of which is "someone remembers":
 *
 *   1. Every envelope that CONTAINS a job references `$Job` and never restates a job field. So the
 *      part of these shapes that has historically drifted — the job payload — cannot drift here.
 *   2. scripts/aj1MobileBearer.mjs calls every endpoint in this contract against a real running
 *      server over a real bearer token, and asserts that EVERY TOP-LEVEL KEY THE SERVER ACTUALLY
 *      SENT is declared here. That is a real-run check, not a source-string one, and it is the
 *      reason this file is allowed to exist. It is not decorative: writing it found ELEVEN wrong
 *      declarations in the first draft of this file, including GET /api/domain-profiles, which
 *      returns a BARE ARRAY where this file had claimed an { profiles } envelope — a client
 *      reading `response.profiles` would render "you have no job profile" to a user who has four.
 *
 *      THE CHECK IS ONE-DIRECTIONAL, ON PURPOSE. It asserts real -> declared, never the reverse,
 *      because several fields below are legitimately conditional: `curation` is emitted only when
 *      ranking demoted something, `reason` only on an empty board, `group`/`jobs` only when
 *      history was asked for a slice. Demanding those on every response would fail on correct
 *      bodies, and a check that cries wolf gets deleted. An UNDOCUMENTED key is the direction that
 *      can be asserted without false positives — and it is the direction all eleven defects were
 *      in, so it is not a weak substitute for the check that cannot be written.
 *
 * Type syntax is deliberately tiny — "string", "number", "boolean", "object", a "T[]" suffix, a
 * "|null" suffix, "$Ref" for a named schema, and "enum:name" for a shared vocabulary. It is small
 * enough to read at a glance and to compile to both JSON Schema and TypeScript without a parser.
 */
"use strict";

export const RESPONSE_SCHEMAS = Object.freeze({

  // ── Primitives shared across envelopes ─────────────────────────────────────────────────────
  OkResponse: {
    description: "A bare acknowledgement. Some routes add fields; `ok` is the only guaranteed key.",
    fields: { ok: "boolean" },
  },
  PublicUser: {
    description: "The user as every client is allowed to see them. Never carries a password hash " +
      "or an email. `allowedModes` and `capabilities` are derived from planTier server-side — a " +
      "client must gate its UI on these rather than on planTier, so a plan change needs no client " +
      "release.",
    fields: {
      id: "number", username: "string", isAdmin: "boolean",
      applyMode: "string", planTier: "string", allowedModes: "string[]",
      capabilities: "$UserCapabilities", domainProfileComplete: "boolean",
    },
  },
  UserCapabilities: {
    fields: { canUseGenerate: "boolean", canUseAPlusResume: "boolean" },
  },

  // ── Auth ───────────────────────────────────────────────────────────────────────────────────
  AuthLoginResponse: {
    description: "authContext is SESSION-BOUND. Exchange it at GET /api/auth/mobile-token.",
    fields: { ok: "boolean", user: "$PublicUser", authContext: "string" },
  },
  MobileTokenResponse: {
    description: "The durable, cookie-less mobile credential and the two windows that govern it.",
    fields: {
      token: "string",
      idleSeconds: "number",
      absoluteSeconds: "number",
    },
  },
  AuthMeResponse: {
    description: "Answers 200 in both cases. `user` is absent when authenticated is false.",
    fields: { authenticated: "boolean", user: "$PublicUser|null" },
  },
  LogoutResponse: {
    description: "`scope` names what was actually ended, so a client never claims more than happened.",
    fields: { ok: "boolean", scope: "string" },
  },
  ActiveProfileResponse: {
    description: "The scope every board query is answered in. 404 means none is active.",
    fields: { profileId: "number", targetRole: "string", name: "string", location: "string" },
  },

  // ── Feed ───────────────────────────────────────────────────────────────────────────────────
  JobFeedResponse: {
    description: "The board page. `jobs` carries the derived $Job shape and nothing else.",
    fields: {
      success: "boolean",
      jobs: "$Job[]",
      total: "number",
      page: "number",
      pageSize: "number",
      totalPages: "number",
      sources: "string[]",
      fromCache: "boolean",
      reason: "string|null",
      curation: "$Curation|null",
      facets: "object|null",
      nextCursor: "string|null",
      paging: "string",
    },
    fieldNotes: {
      nextCursor: "Opaque. Pass it back as ?cursor= for the next page. **null means this is the " +
        "last page** — established by over-fetching one row, not by comparing a count, so it is a " +
        "fact rather than an inference. Emitted on BOTH paging modes, so an offset client can " +
        "adopt cursors mid-feed without restarting the feed.",
      paging: "'cursor' or 'offset' — which mode answered THIS request. When it is 'cursor', " +
        "`page` and `totalPages` are meaningless: there is no page number to be on. Rendering " +
        "'page 1 of 34' on every cursor page is the quietly-wrong surface this field exists to " +
        "prevent.",
      total: "The count of matching rows AT THIS MOMENT. On a swipe feed it shrinks as the user " +
        "swipes, so it is a progress denominator, not a promise about how many more are coming.",
    },
  },
  Curation: {
    description: "A statement about ORDER, not about a withheld remainder. `demoted` rows ARE on " +
      "the board, further down — a client must not render 'showing N of M', which was the old and " +
      "untrue phrasing.",
    fields: { applied: "boolean", ranked: "boolean", rankedKeys: "string[]", total: "number", demoted: "number" },
  },
  JobDetailResponse: {
    fields: { success: "boolean", job: "$Job" },
  },
  FacetsResponse: {
    description:
      "Counts per dimension, FLAT — there is no `facets` wrapper. Each dimension is an object " +
      "keyed by value and valued by count. Note this is a DIFFERENT shape from the optional " +
      "`facets` block on GET /api/jobs?include_facets=, which is keyed by dimension and valued by " +
      "an array of {value, count}. Two shapes for related data; do not share a parser.",
    fields: {
      workType: "object", employmentType: "object", category: "object",
      postedAge: "object", salaryRange: "$SalaryRange|null", total: "number",
    },
    fieldNotes: {
      postedAge: "Bucketed '24h' / '3d' / '1w'.",
      salaryRange: "null when no row in the set stated a salary — which is NOT the same as a range " +
        "of zero.",
    },
  },
  SalaryRange: {
    fields: { min: "number", max: "number", median: "number" },
  },
  InteractResponse: {
    description: "Echoes the RESOLVED job id and the values now stored, so a client reconciles " +
      "against what the server holds rather than against what it optimistically rendered.",
    fields: { success: "boolean", jobId: "string", starred: "boolean", disliked: "boolean" },
  },

  // ── Apply ──────────────────────────────────────────────────────────────────────────────────
  ReadinessResponse: {
    fields: { available: "boolean", reason: "string|null" },
  },
  RunQueuedResponse: {
    description: "202. QUEUED, NOT SUBMITTED — see the endpoint note. `queued` is the ids accepted " +
      "after duplicates were dropped and is the only correct count to report.",
    fields: {
      ok: "boolean", runId: "number", mode: "string", toolType: "string",
      queued: "string[]", totalJobs: "number",
      dailyCap: "$DailyCap", queueCap: "$QueueCap",
    },
  },
  DailyCap: {
    description: "The SUBMISSION budget.",
    fields: { limit: "number", submittedLast24h: "number", remaining: "number" },
  },
  QueueCap: {
    description: "The GENERATION cost budget, reported so a client can show what is left rather " +
      "than discovering the ceiling by being refused at it.",
    fields: { limit: "number", queuedLast24h: "number", remaining: "number" },
  },
  PendingResponse: {
    fields: { pending: "$PendingItem[]" },
  },
  PendingItem: {
    description: "One application previewed and awaiting a decision.",
    fields: {
      runJobId: "number", runId: "number", jobId: "string",
      title: "string|null", company: "string|null", applyUrl: "string|null",
      createdAt: "number", answerCount: "number",
      guessCount: "number",
      resume: "$PendingResume", screenshotAvailable: "boolean",
    },
    fieldNotes: {
      guessCount: "How many answers came from a FUZZY label match rather than an exact one. " +
        "Surfaced at list level so a reviewer sees which applications need attention without " +
        "opening each. An exact mapping is not a guess; a fuzzy one is.",
      title: "null when the posting expired after the application was created. The row still names " +
        "jobId, so an application is never anonymous even once its target is gone.",
    },
  },
  PendingResume: {
    fields: { artifactId: "number|null", atsScore: "number|null", available: "boolean" },
  },
  ApproveResponse: {
    description:
      "202. Approval creates a NEW run carrying approval_mode='approved'; the ids you sent become " +
      "'superseded' and the submission lives on new runJobIds. The started run is NESTED under " +
      "`run` — it is not flattened into this body.",
    fields: {
      ok: "boolean", approved: "number[]", skipped: "number", run: "$RunQueuedResponse",
    },
    fieldNotes: {
      approved: "The runJobIds actually approved — the ids you SENT, now superseded.",
      skipped: "How many of the ids you sent were not approvable (already decided, or expired). " +
        "A non-zero value with ok:true is a partial success, not a failure: re-fetch " +
        "/api/apply/pending rather than reporting an error.",
      run: "The queued run, in the same shape POST /api/apply/runs returns. On a refusal (cap " +
        "reached, kill switch) the refusal body is returned at ITS status with approved:[] instead.",
    },
  },
  RejectResponse: {
    fields: { ok: "boolean", rejected: "number[]" },
  },
  RunListResponse: {
    description:
      "Not just runs. The same request also returns the run-jobs PRE-BUCKETED by what the user has " +
      "to do about them, so a review inbox needs one request rather than six. The buckets are " +
      "disjoint, and `review` deliberately EXCLUDES applications awaiting approval — those have " +
      "their own surface at GET /api/apply/pending, and listing them here showed every one twice.",
    fields: {
      runs: "$Run[]",
      review: "$RunJob[]", gated: "$RunJob[]", inFlight: "$RunJob[]",
      submitted: "$RunJob[]", stopped: "$RunJob[]",
      statusCounts: "object",
    },
    fieldNotes: {
      runs: "The 20 most recent runs, newest first.",
      gated: "held_gate — blocked on a login wall or CAPTCHA. ON MOBILE THESE ARE UNRESOLVABLE " +
        "(no extension, so no activeTab). Render them as needing a desktop; do not offer a retry.",
      statusCounts: "Keyed by apply status, valued by count, over ALL non-hidden run-jobs — not " +
        "just the ones in the buckets above. Use it for badges, not to size the arrays.",
    },
  },
  RunDetailResponse: {
    fields: { run: "$Run", jobs: "$RunJob[]", logs: "$RunLogEntry[]" },
  },
  RunLogEntry: {
    description: "One event from apply_job_logs. `createdAt` is milliseconds, like every other " +
      "timestamp on the apply surface.",
    fields: {
      id: "number", jobId: "string", title: "string|null", company: "string|null",
      level: "string", event: "string", message: "string", createdAt: "number|null",
    },
  },
  Run: {
    description: "Timestamps are MILLISECONDS here; the database stores seconds and the route " +
      "converts. A client that multiplies again renders a date in the year 57000.",
    fields: {
      id: "number", mode: "string", toolType: "string", approvalMode: "string|null",
      status: "string", totalJobs: "number", submittedCount: "number",
      heldCount: "number", failedCount: "number",
      createdAt: "number|null", startedAt: "number|null", finishedAt: "number|null",
    },
  },
  RunJob: {
    description: "One application within a run.",
    fields: {
      id: "number", runId: "number", jobId: "string",
      title: "string|null", company: "string|null", applyUrl: "string|null",
      mode: "string|null", status: "enum:applyStatus", reasonCode: "string|null",
      reasonDetail: "string|null", atsScore: "number|null",
      resumeAvailable: "boolean", screenshotAvailable: "boolean",
      missingRequired: "string[]", fillLogAvailable: "boolean",
      submitVerified: "boolean", submitEvidence: "string|null",
      startedAt: "number|null", finishedAt: "number|null", createdAt: "number|null",
    },
    fieldNotes: {
      missingRequired: "The LABELS of required fields left blank. A hold reading 'required fields " +
        "were left empty' that does not say which is a hold the candidate cannot act on.",
      submitVerified: "Whether the submission was OBSERVED to succeed, as opposed to merely " +
        "claimed. Do not render 'Applied' on status alone when this is false.",
    },
  },
  RunJobReviewResponse: {
    description:
      "Everything the user is shown before approving. This IS the product's promise: nothing is " +
      "sent that was not previewed. FLAT — the run-job's fields are top-level here, NOT nested " +
      "under a `runJob` key, so this is not interchangeable with the $RunJob shape the run " +
      "endpoints return even though the field names overlap.",
    fields: {
      runJobId: "number", runId: "number", jobId: "string",
      title: "string|null", company: "string|null",
      mode: "string|null", status: "enum:applyStatus",
      reasonCode: "string|null", reasonDetail: "string|null",
      answers: "object[]", openQuestions: "object[]",
      resume: "$PendingResume", submission: "$SubmissionEvidence",
      missingRequired: "string[]", screenshotAvailable: "boolean", fillLogAvailable: "boolean",
    },
    fieldNotes: {
      answers: "Every filled field WITH THE RULE THAT PRODUCED IT. A `label_fuzzy` provenance is a " +
        "guess; `handler_exact` / `field_map_exact` / `custom_answer` are not. That distinction is " +
        "the entire point of showing this — surface it, do not flatten it away.",
      missingRequired: "The LABELS of required fields left blank. A hold saying 'required fields " +
        "were left empty' without saying which is a hold the candidate cannot act on.",
    },
  },
  SubmissionEvidence: {
    description: "Whether the submission was OBSERVED to succeed, as opposed to merely claimed. " +
      "Do not render 'Applied' on status alone when `verified` is false.",
    fields: { verified: "boolean", evidence: "string|null" },
  },
  ApplyHistoryResponse: {
    description:
      "ONE DAY, in one of two shapes. Asked WITH `group`: rows arrive under `jobs` and `group` " +
      "echoes what was asked. Asked WITHOUT: rows arrive under `completed` / `pending` / " +
      "`aborted` and both `jobs` and `group` are absent. A client must branch on which request it " +
      "made rather than probing for keys.",
    fields: {
      date: "string",
      total: "number",
      counts: "$ApplyOutcomeCounts",
      group: "enum:applyOutcome|null",
      jobs: "$HistoryRunJob[]|null",
      completed: "$HistoryRunJob[]|null",
      pending: "$HistoryRunJob[]|null",
      aborted: "$HistoryRunJob[]|null",
    },
    fieldNotes: {
      total: "The WHOLE DAY's total, never the asked-for slice — so an empty completed tab on a " +
        "busy day cannot claim the day itself was empty.",
      counts: "Also whole-day, and computed through the same partition the rows use, so a tab's " +
        "number and that tab's contents cannot disagree.",
    },
  },
  ApplyOutcomeCounts: {
    description: "Whole-day counts. Every run-job lands in exactly one of the three.",
    fields: { completed: "number", pending: "number", aborted: "number" },
  },
  HistoryRunJob: {
    description: "A RunJob plus the two fields only the dated history adds.",
    fields: {
      postingGone: "boolean",
      abortable: "boolean",
    },
    fieldNotes: {
      postingGone: "The posting was removed by the 7-day cleanup while the application survived. " +
        "It is what moves a row that is PENDING by status into ABORTED in reality — there is no " +
        "form left to open.",
      abortable: "Decided by the SERVER. Do not re-derive it: two copies of that rule is how a " +
        "button appears for something the server will refuse.",
    },
    extends: "RunJob",
  },
  ApplyHistoryMonthResponse: {
    description: "Which days in the month have activity. A count-per-day aggregate, not rows.",
    fields: { month: "string", days: "object" },
    fieldNotes: {
      days: "Keyed by YYYY-MM-DD, valued by the count for that day. Absent keys are zero.",
    },
  },
  ApplyStatusResponse: {
    description: "About the CALLER, not about the job. Discloses nothing of another user's.",
    fields: { status: "string", application: "object|null" },
    fieldNotes: {
      status: "'applied' or 'idle'. NOT a member of the apply-run status vocabulary — this is the " +
        "user's own relationship to the posting, not a run's state.",
      application: "The job_applications row, or null when the user has not applied.",
    },
  },

  // ── Answers ────────────────────────────────────────────────────────────────────────────────
  QuestionsResponse: {
    fields: {
      questions: "$OpenQuestion[]", eligibilityCount: "number",
      ownWordsCount: "number", blockedJobs: "number",
    },
  },
  OpenQuestion: {
    fields: {
      question: "string", answered: "boolean", eligibility: "boolean|null",
      draft: "string|null", template: "string|null", needsOwnWords: "boolean|null",
      blocking: "$BlockingJob[]",
    },
    fieldNotes: {
      answered: "Answered FOR EVERY employer still blocked on it. A template answered for one " +
        "company does not unblock the same question at another.",
      needsOwnWords: "The system will never write this one for the candidate, however full the " +
        "answer store gets. `draft` is a starting point to edit, not an answer to send.",
    },
  },
  BlockingJob: {
    fields: { jobId: "string", runId: "number", title: "string|null", company: "string|null" },
  },
  AnswersResponse: {
    description: "`saved` is the list of QUESTION TEXTS stored, not a count.",
    fields: {
      ok: "boolean",
      saved: "string[]",
      savedOverrides: "$SavedOverride[]",
      unblocked: "string[]",
      retried: "object|null",
    },
    fieldNotes: {
      unblocked: "The job ids these answers actually unblocked. Answering does NOT authorise a " +
        "submission — a retry re-enters the approval flow. Present as 'ready to try again', never " +
        "as 'applied'.",
      retried: "Present only when retryJobIds was sent. Carries the started run, or a report of " +
        "which requested jobs were not queued because they are still blocked.",
    },
  },
  SavedOverride: {
    description: "A per-employer answer, keyed by company.",
    fields: { company: "string", question: "string" },
  },

  // ── Profile ────────────────────────────────────────────────────────────────────────────────
  UserProfileResponse: {
    description: "SNAKE_CASE — the user_profile row returned directly, unlike the camelCase job " +
      "shape. Listed here in full because a client that guesses camelCase sends every field null.",
    fields: {
      user_id: "number", full_name: "string|null", email: "string|null", phone: "string|null",
      linkedin_url: "string|null", github_url: "string|null", location: "string|null",
      address_line1: "string|null", address_line2: "string|null", city: "string|null",
      state: "string|null", zip: "string|null", country: "string|null",
      gender: "string|null", ethnicity: "string|null", veteran_status: "string|null",
      disability_status: "string|null",
      requires_sponsorship: "number", sponsorship_need: "string|null",
      has_clearance: "number", clearance_level: "string|null",
      visa_type: "string|null", work_auth: "string|null",
      website_url: "string|null", portfolio_url: "string|null",
      desired_salary: "number|null", salary_currency: "string|null",
      available_start_date: "string|null", willing_to_relocate: "number",
      highest_degree: "string|null", field_of_study: "string|null",
      university: "string|null", graduation_year: "number|null",
      current_job_title: "string|null", current_company: "string|null",
      years_of_experience: "number|null",
      custom_answers: "string|null", custom_answer_overrides: "string|null",
      updated_at: "number|null",
      // Present on the row and returned, but NOT writable through POST /api/profile — that
      // handler's UPDATE does not name them. Documented because they arrive and a strict decoder
      // would reject an undeclared key; marked read-only because sending them changes nothing.
      id: "number", onboarded: "number",
      first_name: "string|null", middle_name: "string|null",
      last_name: "string|null", name_suffix: "string|null",
      confirmed_skills: "string|null", target_skills: "string|null",
      target_domains: "string|null", target_locations: "string|null",
      seniority_level: "string|null",
    },
    fieldNotes: {
      requires_sponsorship: "0 or 1, not a boolean. SQLite has no boolean type and this row is " +
        "returned unmapped.",
      custom_answers: "A JSON STRING, not an object — parse it. Keyed by the exact question text " +
        "captured from the form.",
      custom_answer_overrides: "A JSON STRING keyed by company, for per-employer answers.",
      sponsorship_need: "null means NOT ASKED, and the resolver treats it as a refusal rather than " +
        "guessing 'none' on the candidate's behalf. It is not a synonym for 'no'.",
      id: "READ-ONLY. The row id; POST /api/profile does not write it.",
      first_name: "READ-ONLY through this endpoint — POST /api/profile writes `full_name` and does " +
        "not name the split-name columns. They are set at registration and by " +
        "PATCH /api/auth/complete-profile.",
      onboarded: "READ-ONLY. 0 or 1.",
    },
  },
  UserProfileWrite: {
    description: "The POST body. Same field names as the read shape. NOT a patch: every column " +
      "except the two answer maps is overwritten unconditionally, so omitting a field CLEARS it.",
    sameAs: "UserProfileResponse",
  },
  DomainProfileListResponse: {
    description:
      "A BARE ARRAY — there is no envelope and no `profiles` key. A client reading " +
      "`response.profiles` gets undefined and renders an empty profile list, which presents as " +
      "'you have no job profile' to a user who has four.",
    rootArray: "$DomainProfile",
  },
  DomainProfile: {
    description:
      "SNAKE_CASE — the handler spreads the whole domain_profiles row, so every column is listed " +
      "here rather than a chosen subset. Listing a subset was tried and rejected: the contract " +
      "would then be silent about keys the server really sends, and a strict decoder rejects an " +
      "undeclared key.",
    fields: {
      id: "number", user_id: "number",
      profile_name: "string", role_family: "string|null",
      domain: "string|null", seniority: "string|null", location: "string|null",
      is_active: "number", target_titles: "string[]",
      selected_keywords: "string[]", selected_verbs: "string[]", selected_tools: "string[]",
      tracked_search: "object|null", tracked_search_json: "string|null",
      include_summary: "boolean",
      has_base_resume: "number", base_resume_updated_at: "number|null",
      created_at: "number|null", updated_at: "number|null",
    },
    fieldNotes: {
      is_active: "0 or 1, not a boolean — the raw SQLite column. Exactly one profile per user is 1.",
      has_base_resume: "0 or 1, computed by an EXISTS subquery. Both board prerequisites are 'a " +
        "profile exists' AND 'it has a base resume': without the second, the board renders a " +
        "correct job COUNT over an empty list.",
      target_titles: "Parsed from JSON by the server, so it arrives as an array. An EMPTY array is " +
        "why a board can report 'Showing 0 of 336' — it is not a filter fault.",
      include_summary: "Sent as a real boolean, unlike its siblings, because the stored 0 is truthy " +
        "once it has been through JSON and a `||`.",
      tracked_search: "The PARSED form of tracked_search_json. Both are sent; read this one and " +
        "ignore the string, which is the raw column and is only present because the row is spread.",
      base_resume_updated_at: "Absent (not null) when the profile has no base resume — it is a " +
        "correlated subquery over a row that does not exist.",
    },
  },

  // ── Binary ─────────────────────────────────────────────────────────────────────────────────
  BinaryPdf:   { binary: "application/pdf", description: "The generated resume." },
  BinaryImage: { binary: "image/png", description: "The filled-form screenshot, as evidence." },
});
