/**
 * THE MOBILE API CONTRACT — generated from the source of truth, never transcribed.
 * ================================================================================================
 *
 * WHY THIS FILE EXISTS
 *
 * The API just became a contract across a REPOSITORY BOUNDARY. It has four consumers now —
 * client/, extension/, and two mobile repositories that are not in this tree — and until this file
 * nothing noticed when a published shape changed.
 *
 * This repository's defect history is almost entirely contract mismatches that failed SILENTLY:
 * mapJobRow vs normalizeApiJob, the popup and the hotkey writing to different tables, three
 * hardcoded tab lists, half-migrated model IDs, five of fourteen LLM call sites logging usage,
 * `tool` vs `toolType`, mode "manual" coerced to "auto". Every one was two sides of a contract that
 * did not meet, with nothing failing loudly. Being in the same tree is what eventually made each of
 * them findable. A separate repository removes that, so the loud failure has to be built.
 *
 * THE RULE THIS FILE OBEYS, AND IT IS THE WHOLE DESIGN
 *
 *   A HAND-WRITTEN CONTRACT IS A FIFTH PLACE TO DRIFT.
 *
 * So the job shape is not typed out here. `services/jobs/mapJobRow.js` is a field WHITELIST — it
 * returns an object literal with a fixed key set, and it is the only shape GET /api/jobs,
 * GET /api/jobs/by-id/:jobId and routes/importJob.js can emit. Its key set is therefore the binding
 * constraint on everything reaching a client, and it is EXECUTED here, not read:
 *
 *     Object.keys(mapJobRow({}))   ->  the published job fields
 *
 * Probing rather than parsing is deliberate. A regex over the source would agree with the source
 * TEXT; calling the function agrees with the source BEHAVIOUR, which is what a client actually
 * receives. The same probe answers two more questions no transcription could get right (see below).
 *
 * WHAT CANNOT BE DERIVED, AND HOW IT IS KEPT HONEST INSTEAD
 *
 * Scalar types cannot be recovered by probing — `mapJobRow({}).title` is `undefined` whether the
 * column is TEXT or INTEGER. So `JOB_FIELD_TYPES` below declares them, and that declaration is a
 * second place that could drift. It is not allowed to: test/mobileApiContract.test.js asserts the
 * JOIN IN BOTH DIRECTIONS, exactly as test/privacyReconciliation.test.js does for permissions and
 * test/filterOptionContract.test.js does for filter values —
 *
 *     a mapJobRow field with no declared type   -> fail   (a new field would ship untyped)
 *     a declared type with no mapJobRow field   -> fail   (the contract would promise a dead field)
 *
 * An orphan in either column is a failure. That is the pattern, and it is the reason removing a
 * field from mapJobRow breaks the build instead of breaking a phone.
 *
 * Enum vocabularies are IMPORTED, not restated: shared/jobFilterOptions.js (the filter option
 * contract) and shared/applyOutcomeGroups.js (the apply status partition) already exist as single
 * sources for exactly this reason, and a third copy here would be the bug this file is about.
 */
"use strict";

import { mapJobRow } from "../jobs/mapJobRow.js";
import {
  EXPERIENCE_LEVELS, WORK_MODELS, AUTOMATION_TIERS, EMPLOYMENT_TYPES, SORTS, values,
} from "../../shared/jobFilterOptions.js";
import { OUTCOME, OUTCOME_STATUSES } from "../../shared/applyOutcomeGroups.js";

/** Bumped only for a BREAKING change. Additive fields do not bump it — see contract/README.md. */
export const CONTRACT_VERSION = "1.0.0";

// ------------------------------------------------------------------------------------------------
// THE JOB SHAPE — derived by executing mapJobRow, not by reading it
// ------------------------------------------------------------------------------------------------
//
// Three facts come out of the probe, and the third is the one a hand-written contract gets wrong.
//
//   1. THE KEY SET. mapJobRow returns an object literal, so every key is present on every call
//      regardless of input. Object.keys() over an empty row is therefore the complete whitelist.
//
//   2. WHICH FIELDS DEFAULT TO null / false / []. Fields written `?? null`, `Boolean(...)` or
//      `?? []` have a defined value even for a row with nothing in it.
//
//   3. WHICH FIELDS ARE ABSENT RATHER THAN NULL — and this one matters. Eight fields are plain
//      pass-throughs with no coalescing:
//
//          id, title, company, location, description, url, applyUrl, source
//
//      For a row whose column is NULL they evaluate to `undefined`, and JSON.stringify DELETES an
//      undefined property. So they do not arrive as `null` — they do not arrive AT ALL.
//
//      A contract that typed these as `string | null` would be wrong in a way that reads as
//      correct: a Swift or Kotlin decoder distinguishes "null" from "missing", and a non-optional
//      field that is merely absent throws at decode time rather than yielding nil. That is a store
//      crash found from a review. So they are emitted as OPTIONAL (absent from `required`), and the
//      generated TypeScript marks them `?:`.
//
//      Of the eight, three are NOT NULL in the schema (`job_id`, `company`, `title` — migration
//      002) and so are always present in practice. They are still typed optional, because "the
//      column is NOT NULL today" is a database fact, and the mapper is what the client is coupled
//      to. A live-search result never touches that table at all.
const PROBE = Object.freeze(mapJobRow({}));

/** The whitelist itself. This array is the contract's spine, and nothing else defines it. */
export const JOB_FIELDS = Object.freeze(Object.keys(PROBE));

/** Fields that vanish from the JSON body when their source column is NULL (fact 3 above). */
export const JOB_OPTIONAL_FIELDS = Object.freeze(JOB_FIELDS.filter(k => PROBE[k] === undefined));

/** Everything else always serialises — as a value, or as an explicit null. */
export const JOB_REQUIRED_FIELDS = Object.freeze(JOB_FIELDS.filter(k => PROBE[k] !== undefined));

/**
 * The default a client sees for a row with nothing in it. Published because `null` and `false`
 * are NOT interchangeable here and the difference is load-bearing: `isH1bSponsor: null` means
 * "no signal yet", and rendering it as "does not sponsor" is a false negative about somebody's
 * visa status. mapJobRow says so in a comment; the contract has to say so in data.
 */
export const JOB_FIELD_DEFAULTS = Object.freeze(
  Object.fromEntries(JOB_REQUIRED_FIELDS.map(k => [k, PROBE[k]]))
);

/**
 * THE DECLARED HALF. Reconciled against JOB_FIELDS in both directions by the contract test, so
 * this cannot silently disagree with the mapper.
 *
 * `nullable` is a statement about the mapper's own `?? null`, not about the column.
 * `enum` names a shared vocabulary rather than restating one.
 */
export const JOB_FIELD_TYPES = Object.freeze({
  id:                  { type: "string",  description: "Stable job identifier. The value every other endpoint calls jobId." },
  title:               { type: "string",  description: "Role title as posted." },
  company:             { type: "string",  description: "Employer name as posted." },
  location:            { type: "string",  description: "Free text, as posted. Not normalised, not geocoded." },
  description:         { type: "string",  description: "Full posting body. Large — omit it from a feed request with include_fields." },
  url:                 { type: "string",  format: "uri", description: "The posting." },
  applyUrl:            { type: "string",  format: "uri", description: "Apply destination. Falls back to url when no distinct apply link was captured." },
  source:              { type: "string",  description: "Where this row was INGESTED from (greenhouse, ashby, import). NOT the ATS the candidate will face." },
  salaryMin:           { type: "number",  nullable: true },
  salaryMax:           { type: "number",  nullable: true },
  salaryCurrency:      { type: "string",  nullable: true, description: "ISO 4217 where stated. null means the posting gave no currency, NOT that it is USD." },
  postedAt:            { type: "string",  nullable: true, description: "As published by the source. Free text or ISO — not normalised." },
  contractType:        { type: "string",  nullable: true },
  remote:              { type: "boolean", description: "Coerced with Boolean(); never null." },
  sourceLabel:         { type: "string",  nullable: true },
  sourcePlatform:      { type: "string",  description: "KNOWN DEFECT — do not build an ATS badge on this. It reads j.sourcePlatform (camelCase) while the column is source_platform, so for any DB row it resolves to `source`: where we FOUND the job, not the ATS the candidate will face. See docs/SWIPE_FEED_DESIGN.md Finding 2a. Use automationTier instead." },
  via:                 { type: "string",  nullable: true },
  bucketRole:          { type: "string",  nullable: true },
  bucketSeniority:     { type: "string",  nullable: true },
  bucketDomain:        { type: "string",  nullable: true },
  directApply:         { type: "boolean" },
  companyIconUrl:      { type: "string",  nullable: true, format: "uri" },
  matchScore:          { type: "number",  nullable: true },
  starred:             { type: "boolean", description: "Per (user, domain profile). The Saved tab is starred=1." },
  visited:             { type: "boolean", description: "Per (user, domain profile)." },
  disliked:            { type: "boolean", description: "Per (user, domain profile). Excluded from the default board." },
  isH1bSponsor:        { type: "boolean", nullable: true, description: "TRI-STATE. null = no signal yet. MUST render as absent, never as 'does not sponsor'." },
  requiresWorkAuth:    { type: "boolean", nullable: true, description: "TRI-STATE. null = no signal yet." },
  isClearanceRequired: { type: "boolean", nullable: true, description: "TRI-STATE. null = no signal yet." },
  experienceLevel:     { type: "string",  nullable: true, enum: "experienceLevel" },
  workplaceType:       { type: "string",  nullable: true, enum: "workplaceType" },
  skills:              { type: "string[]", description: "Always an array; [] means none extracted. Flattened from two stored shapes (plain strings, and {skill,type} objects)." },
  automationTier:      { type: "string",  nullable: true, enum: "automationTier", description: "What the candidate will face at the apply destination, known at BROWSE time. null = the row predates migration 078 and has not been recomputed; read it exactly as 'unknown', never as 'direct'. THE MOBILE FEED MUST GATE ON THIS — see x-mobile-tier-gating." },
  isActive:            { type: "boolean", description: "Whether the LISTING is live, not whether the row exists. Only the Saved tab can return false: an expired starred job is retired rather than deleted, so its owner is told it closed instead of being sent to apply for something that is gone." },
  discoveredAt:        { type: "number",  nullable: true, description: "Unix seconds." },
  summary:             { type: "string",  nullable: true },
  validThrough:        { type: "string",  nullable: true },
});

// ------------------------------------------------------------------------------------------------
// ENUM VOCABULARIES — imported from the existing single sources, never restated
// ------------------------------------------------------------------------------------------------
export const ENUMS = Object.freeze({
  experienceLevel: Object.freeze(values(EXPERIENCE_LEVELS)),
  workplaceType:   Object.freeze(values(WORK_MODELS)),
  automationTier:  Object.freeze(values(AUTOMATION_TIERS)),
  employmentType:  Object.freeze(values(EMPLOYMENT_TYPES)),
  sort:            Object.freeze(values(SORTS)),
  // The apply status vocabulary, flattened from the partition that already guarantees every status
  // appears exactly once. Deriving it from the partition rather than listing it means a status
  // added without being filed into a group cannot reach the contract.
  applyStatus:     Object.freeze(Object.values(OUTCOME_STATUSES).flat().slice().sort()),
  applyOutcome:    Object.freeze(Object.values(OUTCOME).slice().sort()),
});

// ------------------------------------------------------------------------------------------------
// AUTOMATION-TIER GATING — requirement 7, stated as data the client can branch on
// ------------------------------------------------------------------------------------------------
//
// A phone has no extension, so it has no activeTab, so it cannot perform the gated handoff. A
// `gated` job queued from a phone parks in held_gate and stays there: the security property of the
// handoff IS the desktop browser holding the portal session (docs/GATED_HANDOFF_ARCHITECTURE.md
// section 2). There is no mobile mechanism that preserves it, so the only honest behaviours are to
// show the job as needing a desktop, or to exclude it.
//
// Published so the two mobile clients do not each invent their own answer, and keyed off the tier
// vocabulary so a NEW TIER added to shared/jobFilterOptions.js with no entry here FAILS the
// contract test rather than defaulting to "completable" on a phone.
export const MOBILE_TIER_GATING = Object.freeze({
  direct:  { completableOnMobile: true,  reason: "Single-page ATS apply. No account, no handoff." },
  guest:   { completableOnMobile: true,  reason: "A guest path exists; the run may still hold for review." },
  account: { completableOnMobile: false, reason: "Self-service account required at the destination. The run holds at login_required and a phone cannot resolve it." },
  gated:   { completableOnMobile: false, reason: "Account plus a CAPTCHA or identity check. Resolvable only through the desktop gated handoff, which requires the extension's activeTab. UNRESOLVABLE FROM A PHONE — show as desktop-only, or exclude." },
  unknown: { completableOnMobile: false, reason: "Not looked at. A promise in NEITHER direction, so it must not be offered as one-tap apply." },
});

export { PROBE as JOB_PROBE };
