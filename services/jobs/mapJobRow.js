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
    matchScore:      j._matchScore || j.match_score || null,
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
    discoveredAt:        j.discovered_at         ?? null,
    summary:             j.summary               ?? null,
    validThrough:        j.valid_through         ?? null,
  };
}

export { mapJobRow };
