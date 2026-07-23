// Filters job listings to only show direct-apply opportunities.
// Removes aggregator middlemen URLs that require an account on another site.

const BLOCKED_URL_PATTERNS = [
  /linkedin\.com\/jobs/i,
  /indeed\.com\/rc\//i,
  /glassdoor\.com\/job-listing/i,
  /monster\.com\//i,
  /ziprecruiter\.com\//i,
  /careerbuilder\.com\//i,
  /simplyhired\.com\//i,
];

// Sources that are always trusted to be direct-apply — the same "direct ATS" tier
// used for cross-source dedup priority in aggregator.js (a company's own ATS listing
// always outranks an aggregator's copy of the same role). Add Tier-A ATS integrations
// here as they're onboarded; nothing else needs to change.
const DIRECT_ATS_SOURCES = new Set([
  'greenhouse', 'lever', 'ashby',
  'workday', 'smartrecruiters', 'workable', 'recruitee',
]);

function isDirectApply(job) {
  if (DIRECT_ATS_SOURCES.has(job.source)) return true;
  if (!job.url) return false;
  return !BLOCKED_URL_PATTERNS.some(p => p.test(job.url));
}

function filterDirectApplyOnly(jobs) {
  return jobs.filter(isDirectApply);
}

export { isDirectApply, filterDirectApplyOnly, DIRECT_ATS_SOURCES };
