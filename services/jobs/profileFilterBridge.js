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

const LEVEL_ORDER = ['intern', 'entry', 'mid', 'senior', 'lead', 'executive'];

const MAX_DERIVED_Q_TERMS = 8;
const MAX_DERIVED_SKILLS  = 6;

function bucketYearsExperience(years) {
  if (years == null || !Number.isFinite(years) || years < 0) return null;
  const hit = EXPERIENCE_LEVEL_THRESHOLDS.find(t => years <= t.maxYears);
  return hit ? hit.level : null;
}

// jobQuery.js's experience_levels filter is now null-safe (sj.experience_level IS NULL OR
// IN (...)), because enrichment lag is the NORMAL state, not an edge case: a production
// board went to zero when 0 of 178 active rows had been enriched. The earlier note here
// claimed only the visa filter needed null-safety — that was wrong, and it applies to every
// filter over an enrichJob.js-populated column. Widening below is a RELEVANCE nicety (a
// borderline candidate should see one level up), NOT null protection; it never was, since
// NULL matches no IN-list however wide.
function widenOneLevelUp(level) {
  const idx = LEVEL_ORDER.indexOf(level);
  if (idx === -1) return [level];
  const next = LEVEL_ORDER[idx + 1];
  return next ? [level, next] : [level];
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
 *   sponsorship_friendly?: true }}
 */
function deriveProfileFilters(activeProfile, simpleApplyProfile, opts = {}) {
  const derived = {};

  const qTerms = collectQTerms(activeProfile, simpleApplyProfile);
  if (qTerms.length) derived.q = qTerms.join(' ');

  const skills = cleanStringList(simpleApplyProfile?.skills, MAX_DERIVED_SKILLS);
  if (skills.length) derived.skills_include = skills;

  const bucket = bucketYearsExperience(simpleApplyProfile?.yearsExperience);
  if (bucket) derived.experience_levels = widenOneLevelUp(bucket);

  const sponsorshipFriendly = opts.sponsorshipFriendly ??
    !!simpleApplyProfile?.structuredFacts?.requiresSponsorship;
  if (sponsorshipFriendly) derived.sponsorship_friendly = true;

  return derived;
}

export {
  deriveProfileFilters,
  bucketYearsExperience,
  widenOneLevelUp,
  EXPERIENCE_LEVEL_THRESHOLDS,
};
