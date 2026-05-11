// Ranks jobs from scraped_jobs/job_live_cache for a specific user profile.
// Profile comes from SQLite user_profile row.

const WEIGHTS = {
  role_match:      0.35,
  seniority_match: 0.20,
  location_match:  0.15,
  domain_match:    0.10,
  recency:         0.15,
  salary:          0.05,
};

function scoreJob(job, profile, now = Date.now()) {
  let score = 0;

  // Role match: compare job title to profile's target roles
  const jobText = (job.title + ' ' + (job.description || '')).toLowerCase();
  const targetRoles = Array.isArray(profile.bucket_roles) ? profile.bucket_roles
    : (profile.bucket_roles ? JSON.parse(profile.bucket_roles || '[]') : []);
  if (targetRoles.length && targetRoles.some(r => jobText.includes(r.toLowerCase().replace('_', ' ')))) {
    score += WEIGHTS.role_match;
  } else if (targetRoles.length === 0) {
    score += WEIGHTS.role_match * 0.5; // neutral when no preference set
  }

  // Location match: remote, or location text match
  const targetLocs = Array.isArray(profile.target_locations) ? profile.target_locations
    : (profile.target_locations ? JSON.parse(profile.target_locations || '[]') : []);
  const jobLoc = (job.location || '').toLowerCase();
  if (job.remote === 1 || job.remote === true) {
    score += WEIGHTS.location_match; // remote always counts
  } else if (targetLocs.length === 0 || targetLocs.some(l => jobLoc.includes(l.toLowerCase()))) {
    score += WEIGHTS.location_match * 0.7;
  }

  // Recency: decay over 14 days
  if (job.scraped_at || job.posted_at) {
    const ts = job.scraped_at ? job.scraped_at * 1000 : new Date(job.posted_at).getTime();
    const ageDays = (now - ts) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.max(0, 1 - ageDays / 14);
    score += WEIGHTS.recency * recencyScore;
  }

  // Domain match
  const targetDomains = Array.isArray(profile.target_domains) ? profile.target_domains
    : (profile.target_domains ? JSON.parse(profile.target_domains || '[]') : []);
  if (targetDomains.length === 0 || targetDomains.some(d => jobText.includes(d.toLowerCase()))) {
    score += WEIGHTS.domain_match;
  }

  // Seniority match (basic)
  const seniorityPref = profile.seniority_level;
  if (!seniorityPref || job.bucket_seniority === seniorityPref) {
    score += WEIGHTS.seniority_match;
  }

  return score;
}

function filterAndRankForProfile(jobs, profile, dislikedUrls = []) {
  const dislikedSet = new Set(dislikedUrls);
  const now = Date.now();

  return jobs
    .filter(j => !dislikedSet.has(j.url))
    .map(j => ({ ...j, _score: scoreJob(j, profile, now) }))
    .sort((a, b) => b._score - a._score);
}

export { scoreJob, filterAndRankForProfile };
