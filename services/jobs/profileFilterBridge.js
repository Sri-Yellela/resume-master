/**
 * Profile→Board Bridge — derives DEFAULT services/jobs/jobQuery.js buildJobFilters() params
 * from a user's active domain profile + simple-apply-profile signals.
 *
 * Pure mapper: no DB access, no request object. The caller (server.js's GET /api/jobs) is
 * responsible for merging this output with any explicit req.query values — an explicit value
 * for a given dimension always wins over the derived default (see server.js for the merge).
 *
 * Only sets keys it actually has an opinion about; omitted keys mean "no derived default for
 * this dimension," so a profile with no signals at all produces `{}` and changes nothing.
 */

import { EXPERIENCE_LEVEL_ORDER } from '../../shared/jobFilterOptions.js';

// Explicit, documented years-of-experience -> experience_level enum bucket table
// (schema.js's VALID_EXPERIENCE_LEVELS: intern|entry|mid|senior|lead|executive).
// `intern` is deliberately never derived here — a low years-of-experience count means
// "early career," not "specifically seeking an internship."
const EXPERIENCE_LEVEL_THRESHOLDS = [
  { maxYears: 1,        level: 'entry' },
  { maxYears: 4,        level: 'mid' },
  { maxYears: 8,        level: 'senior' },
  { maxYears: 14,       level: 'lead' },
  { maxYears: Infinity, level: 'executive' },
];

// The fourth copy of the experience-level vocabulary, and the one where ORDER is load-bearing:
// relevanceBand below walks it by index. It is the shared contract's own order now, so a level
// added to the board's controls is one this bridge can widen into rather than an index it cannot
// find.
const LEVEL_ORDER = EXPERIENCE_LEVEL_ORDER;

const MAX_DERIVED_Q_TERMS = 8;
const MAX_DERIVED_SKILLS  = 6;

function bucketYearsExperience(years) {
  if (years == null || !Number.isFinite(years) || years < 0) return null;
  const hit = EXPERIENCE_LEVEL_THRESHOLDS.find(t => years <= t.maxYears);
  return hit ? hit.level : null;
}

/**
 * REBALANCED, from one-level-UP to one level either way — X2 requirement 3.
 *
 * This used to be widenOneLevelUp, and under the old regime the asymmetry had a rationale: the
 * derived levels EXCLUDED, so widening was the only way a borderline candidate could reach a job
 * outside their bucket, and reaching upward is what an ambitious candidate wants. Downward was
 * pointless because nobody needs help finding jobs beneath them.
 *
 * Under ranking that rationale is gone in both halves. Nothing is excluded any more, so "reach" is
 * free — every level is already on the board. What this list decides now is only which rows sort
 * FIRST, i.e. it is a relevance band, not a window. And as a relevance band, upward-only was
 * backwards against this inventory:
 *
 *     in reach for the reference profile: mid 175, senior 45, lead 12, intern 5, entry 4
 *
 * A senior widening to [senior, lead] puts 57 rows in band and sorts the 175 mid roles — which a
 * senior engineer is entirely employable in, and which are 73% of the board — below them. Widening
 * DOWN as well as up is what matches how people actually apply: one level below is a job you can
 * certainly do, one level above is a stretch, and both beat a level two steps away.
 *
 * The band is wide by construction (a mid gets entry+mid+senior = 224 of 241). That is correct for
 * a band whose only job is to sink the clearly-wrong rows — for a mid the 17 lead/intern rows go
 * last — and it is safe precisely because being out of band no longer means being gone.
 */
function relevanceBand(level) {
  const idx = LEVEL_ORDER.indexOf(level);
  if (idx === -1) return [level];
  return [LEVEL_ORDER[idx - 1], level, LEVEL_ORDER[idx + 1]].filter(Boolean);
}

function cleanStringList(list, max) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const clean = String(raw || '').trim();
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

function parseTargetTitles(activeProfile) {
  try {
    const parsed = JSON.parse(activeProfile?.target_titles || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// jobQuery.js's `q` grammar has no "quoted substring" mode (unquoted words = independent OR
// substring terms; a quoted phrase = exact FULL-title equality) — so curated short phrases are
// fed as plain space-joined unquoted terms, the same mechanism a human typing into the same
// search box already gets, rather than inventing new grammar.
function collectQTerms(activeProfile, simpleApplyProfile) {
  const combined = [
    ...(simpleApplyProfile?.searchTerms || []),
    ...(simpleApplyProfile?.titles || []),
    ...parseTargetTitles(activeProfile),
  ];
  return cleanStringList(combined, MAX_DERIVED_Q_TERMS);
}

/**
 * @param {object|null} activeProfile - a domain_profiles row (server.js's getOrRepairActiveProfile)
 * @param {object|null} simpleApplyProfile - loadSimpleApplyProfile()'s return shape
 *   ({ titles, keywords, skills, searchTerms, yearsExperience, structuredFacts }) or null
 * @param {{ sponsorshipFriendly?: boolean }} [opts] - rarely-needed explicit overrides
 * @returns {{ q?: string, skills_include?: string[], experience_levels?: string[],
 *   sponsorship_friendly?: true, company_sponsorship?: true }}
 */
function deriveProfileFilters(activeProfile, simpleApplyProfile, opts = {}) {
  const derived = {};

  const qTerms = collectQTerms(activeProfile, simpleApplyProfile);
  if (qTerms.length) derived.q = qTerms.join(' ');

  const skills = cleanStringList(simpleApplyProfile?.skills, MAX_DERIVED_SKILLS);
  if (skills.length) derived.skills_include = skills;

  const bucket = bucketYearsExperience(simpleApplyProfile?.yearsExperience);
  if (bucket) derived.experience_levels = relevanceBand(bucket);

  const sponsorshipFriendly = opts.sponsorshipFriendly ??
    !!simpleApplyProfile?.structuredFacts?.requiresSponsorship;
  if (sponsorshipFriendly) derived.sponsorship_friendly = true;
  // The same stored fact drives the company-level dimension (TASK X3), because it answers the same
  // question with better evidence: 0 of 1,261 postings mention H-1B, whereas every sponsoring
  // employer has to file an LCA. Emitted as a SEPARATE key rather than folded into
  // sponsorship_friendly so the two rank independently — the posting's own signal still leads, and
  // neither can overwrite the other's meaning. Derived, so it RANKS; the board's own tickbox is
  // what turns it into a filter.
  if (sponsorshipFriendly) derived.company_sponsorship = true;

  return derived;
}

export {
  deriveProfileFilters,
  bucketYearsExperience,
  relevanceBand,
  EXPERIENCE_LEVEL_THRESHOLDS,
};
