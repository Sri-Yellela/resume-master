// Normalises a scraped_jobs/aggregator row (snake_case DB columns or camelCase live-search
// results) into the single camelCase shape every job-board client consumes. Extracted out of
// server.js so routes/importJob.js can return the exact same shape the board already uses,
// without duplicating the mapping.
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
  };
}

export { mapJobRow };
