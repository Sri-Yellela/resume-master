/**
 * Resume Master — Mobile API types.
 * Contract version 1.1.1.
 *
 * GENERATED — DO NOT EDIT. Regenerate with `node scripts/generateMobileContract.mjs`.
 *
 * The `Job` interface is derived by EXECUTING services/jobs/mapJobRow.js in the server
 * repository, so it cannot disagree with what the API actually returns. Optional (`?:`)
 * members are ABSENT from the JSON when their column is NULL — not null, absent — because
 * mapJobRow passes them through without coalescing and JSON.stringify drops undefined.
 */

export type ApplyOutcome = "aborted" | "completed" | "pending";
export type ApplyStatus = "cancelled" | "dismissed" | "failed" | "held_gate" | "held_review" | "queued" | "running" | "submitted" | "superseded";
export type AutomationTier = "direct" | "guest" | "account" | "gated" | "unknown";
export type EmploymentType = "full-time" | "contract" | "internship" | "part-time";
export type ExperienceLevel = "intern" | "entry" | "mid" | "senior" | "lead" | "executive";
export type Sort = "dateDesc" | "dateAsc" | "compHigh" | "compLow" | "yoeLow" | "yoeHigh" | "atsScore";
export type WorkplaceType = "remote" | "hybrid" | "onsite";

/** The job shape. Derived from mapJobRow's field whitelist. */
export interface Job {
  /** Apply destination. Falls back to url when no distinct apply link was captured. */
  applyUrl?: string;
  /** What the candidate will face at the apply destination, known at BROWSE time. null = the row predates migration 078 and has not been recomputed; read it exactly as 'unknown', never as 'direct'. THE MOBILE FEED MUST GATE ON THIS — see x-mobile-tier-gating. */
  automationTier: ("direct" | "guest" | "account" | "gated" | "unknown") | null;
  bucketDomain: string | null;
  bucketRole: string | null;
  bucketSeniority: string | null;
  /** Employer name as posted. */
  company?: string;
  companyIconUrl: string | null;
  contractType: string | null;
  /** Full posting body. Large — omit it from a feed request with include_fields. */
  description?: string;
  directApply: boolean;
  /** Unix seconds. */
  discoveredAt: number | null;
  /** Per (user, domain profile). Excluded from the default board. */
  disliked: boolean;
  experienceLevel: ("intern" | "entry" | "mid" | "senior" | "lead" | "executive") | null;
  /** Stable job identifier. The value every other endpoint calls jobId. */
  id?: string;
  /** Whether the LISTING is live, not whether the row exists. Only the Saved tab can return false: an expired starred job is retired rather than deleted, so its owner is told it closed instead of being sent to apply for something that is gone. */
  isActive: boolean;
  /** TRI-STATE. null = no signal yet. */
  isClearanceRequired: boolean | null;
  /** TRI-STATE. null = no signal yet. MUST render as absent, never as 'does not sponsor'. */
  isH1bSponsor: boolean | null;
  /** Free text, as posted. Not normalised, not geocoded. */
  location?: string;
  /** INTERNAL — DO NOT DISPLAY THIS NUMBER. The local ATS engine orders coarsely and cannot support a shown figure: Spearman rho 0.746 against a human-graded set of 30, with 12.2% of pairs still mis-ordered. "This job is a 43" claims a precision it does not have. Render the BAND instead — Strong (>=44) / Moderate (>=26) / Weak / Not enough signal — whose cutpoints and copy are defined once in shared/atsBands.js. A NULL IS NOT A ZERO: null means the scorer declined for want of signal, which is its own band and must never render as a low score. The number stays in the payload because the auto-apply gate is a numeric threshold (30) and mobile needs to show remaining capacity against it; that is the only sanctioned use. */
  matchScore: number | null;
  /** As published by the source. Free text or ISO — not normalised. */
  postedAt: string | null;
  /** Coerced with Boolean(); never null. */
  remote: boolean;
  /** TRI-STATE. null = no signal yet. */
  requiresWorkAuth: boolean | null;
  /** ISO 4217 where stated. null means the posting gave no currency, NOT that it is USD. */
  salaryCurrency: string | null;
  salaryMax: number | null;
  salaryMin: number | null;
  /** Always an array; [] means none extracted. Flattened from two stored shapes (plain strings, and {skill,type} objects). */
  skills: string[];
  /** Where this row was INGESTED from (greenhouse, ashby, import). NOT the ATS the candidate will face. */
  source?: string;
  sourceLabel: string | null;
  /** KNOWN DEFECT — do not build an ATS badge on this. It reads j.sourcePlatform (camelCase) while the column is source_platform, so for any DB row it resolves to `source`: where we FOUND the job, not the ATS the candidate will face. See docs/SWIPE_FEED_DESIGN.md Finding 2a. Use automationTier instead. */
  sourcePlatform: string;
  /** Per (user, domain profile). The Saved tab is starred=1. */
  starred: boolean;
  summary: string | null;
  /** Role title as posted. */
  title?: string;
  /** The posting. */
  url?: string;
  validThrough: string | null;
  via: string | null;
  /** Per (user, domain profile). */
  visited: boolean;
  workplaceType: ("remote" | "hybrid" | "onsite") | null;
}

/** The scope every board query is answered in. 404 means none is active. */
export interface ActiveProfileResponse {
  location: string;
  name: string;
  profileId: number;
  targetRole: string;
}

/** `saved` is the list of QUESTION TEXTS stored, not a count. */
export interface AnswersResponse {
  ok: boolean;
  /** Present only when retryJobIds was sent. Carries the started run, or a report of which requested jobs were not queued because they are still blocked. */
  retried: Record<string, unknown> | null;
  saved: string[];
  savedOverrides: SavedOverride[];
  /** The job ids these answers actually unblocked. Answering does NOT authorise a submission — a retry re-enters the approval flow. Present as 'ready to try again', never as 'applied'. */
  unblocked: string[];
}

/** Which days in the month have activity. A count-per-day aggregate, not rows. */
export interface ApplyHistoryMonthResponse {
  /** Keyed by YYYY-MM-DD, valued by the count for that day. Absent keys are zero. */
  days: Record<string, unknown>;
  month: string;
}

/** ONE DAY, in one of two shapes. Asked WITH `group`: rows arrive under `jobs` and `group` echoes what was asked. Asked WITHOUT: rows arrive under `completed` / `pending` / `aborted` and both `jobs` and `group` are absent. A client must branch on which request it made rather than probing for keys. */
export interface ApplyHistoryResponse {
  aborted: HistoryRunJob[] | null;
  completed: HistoryRunJob[] | null;
  /** Also whole-day, and computed through the same partition the rows use, so a tab's number and that tab's contents cannot disagree. */
  counts: ApplyOutcomeCounts;
  date: string;
  group: ("aborted" | "completed" | "pending") | null;
  jobs: HistoryRunJob[] | null;
  pending: HistoryRunJob[] | null;
  /** The WHOLE DAY's total, never the asked-for slice — so an empty completed tab on a busy day cannot claim the day itself was empty. */
  total: number;
}

/** Whole-day counts. Every run-job lands in exactly one of the three. */
export interface ApplyOutcomeCounts {
  aborted: number;
  completed: number;
  pending: number;
}

/** About the CALLER, not about the job. Discloses nothing of another user's. */
export interface ApplyStatusResponse {
  /** The job_applications row, or null when the user has not applied. */
  application: Record<string, unknown> | null;
  /** 'applied' or 'idle'. NOT a member of the apply-run status vocabulary — this is the user's own relationship to the posting, not a run's state. */
  status: string;
}

/** 202. Approval creates a NEW run carrying approval_mode='approved'; the ids you sent become 'superseded' and the submission lives on new runJobIds. The started run is NESTED under `run` — it is not flattened into this body. */
export interface ApproveResponse {
  /** The runJobIds actually approved — the ids you SENT, now superseded. */
  approved: number[];
  ok: boolean;
  /** The queued run, in the same shape POST /api/apply/runs returns. On a refusal (cap reached, kill switch) the refusal body is returned at ITS status with approved:[] instead. */
  run: RunQueuedResponse;
  /** How many of the ids you sent were not approvable (already decided, or expired). A non-zero value with ok:true is a partial success, not a failure: re-fetch /api/apply/pending rather than reporting an error. */
  skipped: number;
}

/** authContext is SESSION-BOUND. Exchange it at GET /api/auth/mobile-token. */
export interface AuthLoginResponse {
  authContext: string;
  ok: boolean;
  user: PublicUser;
}

/** Answers 200 in both cases. `user` is absent when authenticated is false. */
export interface AuthMeResponse {
  authenticated: boolean;
  user: PublicUser | null;
}

/** The filled-form screenshot, as evidence. Binary body (image/png); not JSON. */
export type BinaryImage = Blob;

/** The generated resume. Binary body (application/pdf); not JSON. */
export type BinaryPdf = Blob;

export interface BlockingJob {
  company: string | null;
  jobId: string;
  runId: number;
  title: string | null;
}

/** A statement about ORDER, not about a withheld remainder. `demoted` rows ARE on the board, further down — a client must not render 'showing N of M', which was the old and untrue phrasing. */
export interface Curation {
  applied: boolean;
  demoted: number;
  ranked: boolean;
  rankedKeys: string[];
  total: number;
}

/** The SUBMISSION budget. */
export interface DailyCap {
  limit: number;
  remaining: number;
  submittedLast24h: number;
}

/** SNAKE_CASE — the handler spreads the whole domain_profiles row, so every column is listed here rather than a chosen subset. Listing a subset was tried and rejected: the contract would then be silent about keys the server really sends, and a strict decoder rejects an undeclared key. */
export interface DomainProfile {
  /** Absent (not null) when the profile has no base resume — it is a correlated subquery over a row that does not exist. */
  base_resume_updated_at: number | null;
  created_at: number | null;
  domain: string | null;
  /** 0 or 1, computed by an EXISTS subquery. Both board prerequisites are 'a profile exists' AND 'it has a base resume': without the second, the board renders a correct job COUNT over an empty list. */
  has_base_resume: number;
  id: number;
  /** Sent as a real boolean, unlike its siblings, because the stored 0 is truthy once it has been through JSON and a `||`. */
  include_summary: boolean;
  /** 0 or 1, not a boolean — the raw SQLite column. Exactly one profile per user is 1. */
  is_active: number;
  location: string | null;
  profile_name: string;
  role_family: string | null;
  selected_keywords: string[];
  selected_tools: string[];
  selected_verbs: string[];
  seniority: string | null;
  /** Parsed from JSON by the server, so it arrives as an array. An EMPTY array is why a board can report 'Showing 0 of 336' — it is not a filter fault. */
  target_titles: string[];
  /** The PARSED form of tracked_search_json. Both are sent; read this one and ignore the string, which is the raw column and is only present because the row is spread. */
  tracked_search: Record<string, unknown> | null;
  tracked_search_json: string | null;
  updated_at: number | null;
  user_id: number;
}

/** A BARE ARRAY — there is no envelope and no `profiles` key. A client reading `response.profiles` gets undefined and renders an empty profile list, which presents as 'you have no job profile' to a user who has four. */
export type DomainProfileListResponse = DomainProfile[];

/** Counts per dimension, FLAT — there is no `facets` wrapper. Each dimension is an object keyed by value and valued by count. Note this is a DIFFERENT shape from the optional `facets` block on GET /api/jobs?include_facets=, which is keyed by dimension and valued by an array of {value, count}. Two shapes for related data; do not share a parser. */
export interface FacetsResponse {
  category: Record<string, unknown>;
  employmentType: Record<string, unknown>;
  /** Bucketed '24h' / '3d' / '1w'. */
  postedAge: Record<string, unknown>;
  /** null when no row in the set stated a salary — which is NOT the same as a range of zero. */
  salaryRange: SalaryRange | null;
  total: number;
  workType: Record<string, unknown>;
}

/** A RunJob plus the two fields only the dated history adds. */
export interface HistoryRunJob extends RunJob {
  /** Decided by the SERVER. Do not re-derive it: two copies of that rule is how a button appears for something the server will refuse. */
  abortable: boolean;
  /** The posting was removed by the 7-day cleanup while the application survived. It is what moves a row that is PENDING by status into ABORTED in reality — there is no form left to open. */
  postingGone: boolean;
}

/** Echoes the RESOLVED job id and the values now stored, so a client reconciles against what the server holds rather than against what it optimistically rendered. */
export interface InteractResponse {
  disliked: boolean;
  jobId: string;
  starred: boolean;
  success: boolean;
}

export interface JobDetailResponse {
  job: Job;
  success: boolean;
}

/** The board page. `jobs` carries the derived $Job shape and nothing else. */
export interface JobFeedResponse {
  curation: Curation | null;
  facets: Record<string, unknown> | null;
  fromCache: boolean;
  jobs: Job[];
  /** Opaque. Pass it back as ?cursor= for the next page. **null means this is the last page** — established by over-fetching one row, not by comparing a count, so it is a fact rather than an inference. Emitted on BOTH paging modes, so an offset client can adopt cursors mid-feed without restarting the feed. */
  nextCursor: string | null;
  page: number;
  pageSize: number;
  /** 'cursor' or 'offset' — which mode answered THIS request. When it is 'cursor', `page` and `totalPages` are meaningless: there is no page number to be on. Rendering 'page 1 of 34' on every cursor page is the quietly-wrong surface this field exists to prevent. */
  paging: string;
  reason: string | null;
  sources: string[];
  success: boolean;
  /** The count of matching rows AT THIS MOMENT. On a swipe feed it shrinks as the user swipes, so it is a progress denominator, not a promise about how many more are coming. */
  total: number;
  totalPages: number;
}

/** `scope` names what was actually ended, so a client never claims more than happened. */
export interface LogoutResponse {
  ok: boolean;
  scope: string;
}

/** The durable, cookie-less mobile credential and the two windows that govern it. */
export interface MobileTokenResponse {
  absoluteSeconds: number;
  idleSeconds: number;
  token: string;
}

/** A bare acknowledgement. Some routes add fields; `ok` is the only guaranteed key. */
export interface OkResponse {
  ok: boolean;
}

export interface OpenQuestion {
  /** Answered FOR EVERY employer still blocked on it. A template answered for one company does not unblock the same question at another. */
  answered: boolean;
  blocking: BlockingJob[];
  draft: string | null;
  eligibility: boolean | null;
  /** The system will never write this one for the candidate, however full the answer store gets. `draft` is a starting point to edit, not an answer to send. */
  needsOwnWords: boolean | null;
  question: string;
  template: string | null;
}

/** One application previewed and awaiting a decision. */
export interface PendingItem {
  answerCount: number;
  applyUrl: string | null;
  company: string | null;
  createdAt: number;
  /** How many answers came from a FUZZY label match rather than an exact one. Surfaced at list level so a reviewer sees which applications need attention without opening each. An exact mapping is not a guess; a fuzzy one is. */
  guessCount: number;
  jobId: string;
  resume: PendingResume;
  runId: number;
  runJobId: number;
  screenshotAvailable: boolean;
  /** null when the posting expired after the application was created. The row still names jobId, so an application is never anonymous even once its target is gone. */
  title: string | null;
}

export interface PendingResponse {
  pending: PendingItem[];
}

export interface PendingResume {
  artifactId: number | null;
  /** INTERNAL - DO NOT DISPLAY. The engine orders coarsely (rho 0.746 against a human-graded 30, 12.2% of pairs mis-ordered) and cannot support a shown number. Render the band from shared/atsBands.js instead. null means the scorer DECLINED for want of signal - its own band, never a zero. Kept in the payload because the auto-apply gate is numeric (30). */
  atsScore: number | null;
  available: boolean;
}

/** The user as every client is allowed to see them. Never carries a password hash or an email. `allowedModes` and `capabilities` are derived from planTier server-side — a client must gate its UI on these rather than on planTier, so a plan change needs no client release. */
export interface PublicUser {
  allowedModes: string[];
  applyMode: string;
  capabilities: UserCapabilities;
  domainProfileComplete: boolean;
  id: number;
  isAdmin: boolean;
  planTier: string;
  username: string;
}

export interface QuestionsResponse {
  blockedJobs: number;
  eligibilityCount: number;
  ownWordsCount: number;
  questions: OpenQuestion[];
}

/** The GENERATION cost budget, reported so a client can show what is left rather than discovering the ceiling by being refused at it. */
export interface QueueCap {
  limit: number;
  queuedLast24h: number;
  remaining: number;
}

export interface ReadinessResponse {
  available: boolean;
  reason: string | null;
}

export interface RejectResponse {
  ok: boolean;
  rejected: number[];
}

/** Timestamps are MILLISECONDS here; the database stores seconds and the route converts. A client that multiplies again renders a date in the year 57000. */
export interface Run {
  approvalMode: string | null;
  createdAt: number | null;
  failedCount: number;
  finishedAt: number | null;
  heldCount: number;
  id: number;
  mode: string;
  startedAt: number | null;
  status: string;
  submittedCount: number;
  toolType: string;
  totalJobs: number;
}

export interface RunDetailResponse {
  jobs: RunJob[];
  logs: RunLogEntry[];
  run: Run;
}

/** One application within a run. */
export interface RunJob {
  applyUrl: string | null;
  /** INTERNAL - DO NOT DISPLAY. The engine orders coarsely (rho 0.746 against a human-graded 30, 12.2% of pairs mis-ordered) and cannot support a shown number. Render the band from shared/atsBands.js instead. null means the scorer DECLINED for want of signal - its own band, never a zero. Kept in the payload because the auto-apply gate is numeric (30). */
  atsScore: number | null;
  company: string | null;
  createdAt: number | null;
  fillLogAvailable: boolean;
  finishedAt: number | null;
  id: number;
  jobId: string;
  /** The LABELS of required fields left blank. A hold reading 'required fields were left empty' that does not say which is a hold the candidate cannot act on. */
  missingRequired: string[];
  mode: string | null;
  reasonCode: string | null;
  reasonDetail: string | null;
  resumeAvailable: boolean;
  runId: number;
  screenshotAvailable: boolean;
  startedAt: number | null;
  status: ("cancelled" | "dismissed" | "failed" | "held_gate" | "held_review" | "queued" | "running" | "submitted" | "superseded");
  submitEvidence: string | null;
  /** Whether the submission was OBSERVED to succeed, as opposed to merely claimed. Do not render 'Applied' on status alone when this is false. */
  submitVerified: boolean;
  title: string | null;
}

/** Everything the user is shown before approving. This IS the product's promise: nothing is sent that was not previewed. FLAT — the run-job's fields are top-level here, NOT nested under a `runJob` key, so this is not interchangeable with the $RunJob shape the run endpoints return even though the field names overlap. */
export interface RunJobReviewResponse {
  /** Every filled field WITH THE RULE THAT PRODUCED IT. A `label_fuzzy` provenance is a guess; `handler_exact` / `field_map_exact` / `custom_answer` are not. That distinction is the entire point of showing this — surface it, do not flatten it away. */
  answers: Record<string, unknown>[];
  company: string | null;
  fillLogAvailable: boolean;
  jobId: string;
  /** The LABELS of required fields left blank. A hold saying 'required fields were left empty' without saying which is a hold the candidate cannot act on. */
  missingRequired: string[];
  mode: string | null;
  openQuestions: Record<string, unknown>[];
  reasonCode: string | null;
  reasonDetail: string | null;
  resume: PendingResume;
  runId: number;
  runJobId: number;
  screenshotAvailable: boolean;
  status: ("cancelled" | "dismissed" | "failed" | "held_gate" | "held_review" | "queued" | "running" | "submitted" | "superseded");
  submission: SubmissionEvidence;
  title: string | null;
}

/** Not just runs. The same request also returns the run-jobs PRE-BUCKETED by what the user has to do about them, so a review inbox needs one request rather than six. The buckets are disjoint, and `review` deliberately EXCLUDES applications awaiting approval — those have their own surface at GET /api/apply/pending, and listing them here showed every one twice. */
export interface RunListResponse {
  /** held_gate — blocked on a login wall or CAPTCHA. ON MOBILE THESE ARE UNRESOLVABLE (no extension, so no activeTab). Render them as needing a desktop; do not offer a retry. */
  gated: RunJob[];
  inFlight: RunJob[];
  review: RunJob[];
  /** The 20 most recent runs, newest first. */
  runs: Run[];
  /** Keyed by apply status, valued by count, over ALL non-hidden run-jobs — not just the ones in the buckets above. Use it for badges, not to size the arrays. */
  statusCounts: Record<string, unknown>;
  stopped: RunJob[];
  submitted: RunJob[];
}

/** One event from apply_job_logs. `createdAt` is milliseconds, like every other timestamp on the apply surface. */
export interface RunLogEntry {
  company: string | null;
  createdAt: number | null;
  event: string;
  id: number;
  jobId: string;
  level: string;
  message: string;
  title: string | null;
}

/** 202. QUEUED, NOT SUBMITTED — see the endpoint note. `queued` is the ids accepted after duplicates were dropped and is the only correct count to report. */
export interface RunQueuedResponse {
  dailyCap: DailyCap;
  mode: string;
  ok: boolean;
  queueCap: QueueCap;
  queued: string[];
  runId: number;
  toolType: string;
  totalJobs: number;
}

export interface SalaryRange {
  max: number;
  median: number;
  min: number;
}

/** A per-employer answer, keyed by company. */
export interface SavedOverride {
  company: string;
  question: string;
}

/** Whether the submission was OBSERVED to succeed, as opposed to merely claimed. Do not render 'Applied' on status alone when `verified` is false. */
export interface SubmissionEvidence {
  evidence: string | null;
  verified: boolean;
}

export interface UserCapabilities {
  canUseAPlusResume: boolean;
  canUseGenerate: boolean;
}

/** SNAKE_CASE — the user_profile row returned directly, unlike the camelCase job shape. Listed here in full because a client that guesses camelCase sends every field null. */
export interface UserProfileResponse {
  address_line1: string | null;
  address_line2: string | null;
  available_start_date: string | null;
  city: string | null;
  clearance_level: string | null;
  confirmed_skills: string | null;
  country: string | null;
  current_company: string | null;
  current_job_title: string | null;
  /** A JSON STRING keyed by company, for per-employer answers. */
  custom_answer_overrides: string | null;
  /** A JSON STRING, not an object — parse it. Keyed by the exact question text captured from the form. */
  custom_answers: string | null;
  desired_salary: number | null;
  disability_status: string | null;
  email: string | null;
  ethnicity: string | null;
  field_of_study: string | null;
  /** READ-ONLY through this endpoint — POST /api/profile writes `full_name` and does not name the split-name columns. They are set at registration and by PATCH /api/auth/complete-profile. */
  first_name: string | null;
  full_name: string | null;
  gender: string | null;
  github_url: string | null;
  graduation_year: number | null;
  has_clearance: number;
  highest_degree: string | null;
  /** READ-ONLY. The row id; POST /api/profile does not write it. */
  id: number;
  last_name: string | null;
  linkedin_url: string | null;
  location: string | null;
  middle_name: string | null;
  name_suffix: string | null;
  /** READ-ONLY. 0 or 1. */
  onboarded: number;
  phone: string | null;
  portfolio_url: string | null;
  /** 0 or 1, not a boolean. SQLite has no boolean type and this row is returned unmapped. */
  requires_sponsorship: number;
  salary_currency: string | null;
  seniority_level: string | null;
  /** null means NOT ASKED, and the resolver treats it as a refusal rather than guessing 'none' on the candidate's behalf. It is not a synonym for 'no'. */
  sponsorship_need: string | null;
  state: string | null;
  target_domains: string | null;
  target_locations: string | null;
  target_skills: string | null;
  university: string | null;
  updated_at: number | null;
  user_id: number;
  veteran_status: string | null;
  visa_type: string | null;
  website_url: string | null;
  willing_to_relocate: number;
  work_auth: string | null;
  years_of_experience: number | null;
  zip: string | null;
}

/** The POST body. Same field names as the read shape. NOT a patch: every column except the two answer maps is overwritten unconditionally, so omitting a field CLEARS it. */
export interface UserProfileWrite {
  address_line1: string | null;
  address_line2: string | null;
  available_start_date: string | null;
  city: string | null;
  clearance_level: string | null;
  confirmed_skills: string | null;
  country: string | null;
  current_company: string | null;
  current_job_title: string | null;
  /** A JSON STRING keyed by company, for per-employer answers. */
  custom_answer_overrides: string | null;
  /** A JSON STRING, not an object — parse it. Keyed by the exact question text captured from the form. */
  custom_answers: string | null;
  desired_salary: number | null;
  disability_status: string | null;
  email: string | null;
  ethnicity: string | null;
  field_of_study: string | null;
  /** READ-ONLY through this endpoint — POST /api/profile writes `full_name` and does not name the split-name columns. They are set at registration and by PATCH /api/auth/complete-profile. */
  first_name: string | null;
  full_name: string | null;
  gender: string | null;
  github_url: string | null;
  graduation_year: number | null;
  has_clearance: number;
  highest_degree: string | null;
  /** READ-ONLY. The row id; POST /api/profile does not write it. */
  id: number;
  last_name: string | null;
  linkedin_url: string | null;
  location: string | null;
  middle_name: string | null;
  name_suffix: string | null;
  /** READ-ONLY. 0 or 1. */
  onboarded: number;
  phone: string | null;
  portfolio_url: string | null;
  /** 0 or 1, not a boolean. SQLite has no boolean type and this row is returned unmapped. */
  requires_sponsorship: number;
  salary_currency: string | null;
  seniority_level: string | null;
  /** null means NOT ASKED, and the resolver treats it as a refusal rather than guessing 'none' on the candidate's behalf. It is not a synonym for 'no'. */
  sponsorship_need: string | null;
  state: string | null;
  target_domains: string | null;
  target_locations: string | null;
  target_skills: string | null;
  university: string | null;
  updated_at: number | null;
  user_id: number;
  veteran_status: string | null;
  visa_type: string | null;
  website_url: string | null;
  willing_to_relocate: number;
  work_auth: string | null;
  years_of_experience: number | null;
  zip: string | null;
}

/** Which automation tiers can be completed on a phone, and why not when they cannot. */
export const MOBILE_TIER_GATING: Record<AutomationTier, { completableOnMobile: boolean; reason: string }> = {
  account: { completableOnMobile: false, reason: "Self-service account required at the destination. The run holds at login_required and a phone cannot resolve it." },
  direct: { completableOnMobile: true, reason: "Single-page ATS apply. No account, no handoff." },
  gated: { completableOnMobile: false, reason: "Account plus a CAPTCHA or identity check. Resolvable only through the desktop gated handoff, which requires the extension's activeTab. UNRESOLVABLE FROM A PHONE — show as desktop-only, or exclude." },
  guest: { completableOnMobile: true, reason: "A guest path exists; the run may still hold for review." },
  unknown: { completableOnMobile: false, reason: "Not looked at. A promise in NEITHER direction, so it must not be offered as one-tap apply." },
};

/** Endpoints that answer 410. A client must not call these. */
export const RETIRED_ENDPOINTS = [
  "POST /api/scrape",
  "ALL /api/extension/save-job",
  "ALL /api/imported-jobs/*",
  "POST /api/apply/session/save",
  "GET /api/apply/session/{domain}",
  "PATCH /api/settings/apply-mode"
] as const;
