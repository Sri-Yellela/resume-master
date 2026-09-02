// Normalises a scraped_jobs/aggregator row (snake_case DB columns or camelCase live-search
// results) into the single camelCase shape every job-board client consumes. Extracted out of
// server.js so routes/importJob.js can return the exact same shape the board already uses,
// without duplicating the mapping.
function parseSkillsList(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    // skills_json holds two coexisting shapes (see jobQuery.js's computeSkillsFacet): plain
    // strings, or { skill, type } objects from enrichJob.js's typed hard/soft extraction.
    return arr
      .map(entry => (typeof entry === 'string' ? entry : entry?.skill))
      .filter(s => typeof s === 'string' && s.trim());
  } catch { return null; }
}

function mapJobRow(j) {
  return {
    id:              j.job_id || j.id,
    title:           j.title,
    company:         j.company,
    location:        j.location,
    description:     j.description,
    url:             j.url,
    applyUrl:        j.apply_url || j.applyUrl || j.url,
    salaryMin:       j.salary_min  ?? j.salaryMin  ?? null,
    salaryMax:       j.salary_max  ?? j.salaryMax  ?? null,
    salaryCurrency:  j.salary_currency  || j.salaryCurrency  || null,
    postedAt:        j.posted_at  || j.postedAt  || null,
    contractType:    j.contract_type || j.contractType || null,
    remote:          Boolean(j.remote),
    source:          j.source,
    sourceLabel:     j.source_label || j.sourceLabel || null,
    sourcePlatform:  j.source || j.source_label || j.sourcePlatform || 'direct',
    via:             j.via || null,
    bucketRole:      j.bucket_role      || j.bucketRole      || null,
    bucketSeniority: j.bucket_seniority || j.bucketSeniority || null,
    bucketDomain:    j.bucket_domain    || j.bucketDomain    || null,
    directApply:     Boolean(j.direct_apply ?? j.directApply),
    companyIconUrl:  j.company_icon_url || j.companyIconUrl  || j.thumbnail || null,
    // THE STORED COLUMN IS ats_score. This read `j._matchScore || j.match_score`, and neither
    // exists: `_matchScore` is assigned nowhere in this repository and `match_score` is not a
    // column on scraped_jobs. So this field was NULL on every row of every response, always.
    //
    // Nothing failed, because the desktop client never reads it — JobCard/JobDetailPanel/JobsPanel
    // all read `g?.atsScore ?? job?.baseAtsScore`, and baseAtsScore comes from a different mapper
    // (the /api/jobs/poll shape) reading the same ats_score column. Two sides, each self-consistent,
    // joined to nothing. It surfaced only when a native client implemented the mobile contract
    // exactly as written and banded every job as "Not enough signal".
    //
    // ?? NOT ||, DELIBERATELY. A score of 0 is a real score and bands as Weak; `||` would collapse
    // it to null, and null means the scorer DECLINED. Those are different answers, and keeping them
    // apart is the entire point of the fourth band.
    //
    // Still null on two paths, correctly: /api/jobs/generic selects an explicit column list without
    // ats_score because a public unpersonalized feed has no per-user score, and live aggregator
    // results have never been scored. Both are "no opinion", which is what null means here.
    matchScore:      j.ats_score ?? j.matchScore ?? null,
    starred:         Boolean(j.starred),
    visited:         Boolean(j.visited),
    disliked:        Boolean(j.disliked),
    // FE-1: Task 1/5 enrichment fields — additive, nullable-safe. null means "no signal yet"
    // (not-yet-enriched or the posting never stated it) and must render as absent on the
    // client, never as a false negative (e.g. isH1bSponsor: null is NOT "does not sponsor").
    isH1bSponsor:        j.is_h1b_sponsor        ?? null,
    requiresWorkAuth:    j.requires_work_auth    ?? null,
    isClearanceRequired: j.is_clearance_required ?? null,
    experienceLevel:     j.experience_level      ?? null,
    workplaceType:       j.workplace_type        ?? null,
    skills:              parseSkillsList(j.skills_json ?? j.skills) ?? [],
    // Automation tier (services/jobs/automationTier.js): what the candidate will face at the
    // apply destination, known at browse time instead of mid-run. null here means the row predates
    // migration 078 and has not been recomputed yet — the client must read that exactly the way it
    // reads 'unknown' (no promise in either direction), never as 'direct'.
    automationTier:      j.automation_tier       ?? j.automationTier ?? null,
    // Whether the LISTING is still live, not whether the row exists. Only the Saved tab can return
    // is_active = 0 rows (see server.js): runExpiredJobsCleanup retires an expired starred job
    // rather than deleting it, so its owner keeps it — and needs to be told it has closed instead of
    // being sent to apply for something that is gone. Absent column (a live-search result, which has
    // no is_active at all) reads as live, which is what a just-fetched posting is.
    isActive:            j.is_active == null ? true : !!j.is_active,
    discoveredAt:        j.discovered_at         ?? null,
    summary:             j.summary               ?? null,
    validThrough:        j.valid_through         ?? null,
  };
}

export { mapJobRow };
