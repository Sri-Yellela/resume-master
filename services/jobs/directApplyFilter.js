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

// Sources that are always trusted to be direct-apply
const ALWAYS_ALLOW_SOURCES = new Set(['greenhouse', 'lever', 'ashby']);

function isDirectApply(job) {
  if (ALWAYS_ALLOW_SOURCES.has(job.source)) return true;
  if (!job.url) return false;
  return !BLOCKED_URL_PATTERNS.some(p => p.test(job.url));
}

function filterDirectApplyOnly(jobs) {
  return jobs.filter(isDirectApply);
}

export { isDirectApply, filterDirectApplyOnly };
