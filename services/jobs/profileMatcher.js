// Ranks jobs within an already role-correct board (board is pre-filtered via job_role_map join).
// Taxonomy A retired in Phase 6; board is already role-correct via job_role_map join.
// scoreJob ranks by recency / location / seniority / domain only.

const WEIGHTS = {
  seniority_match: 0.25,
  location_match:  0.25,
  domain_match:    0.15,
  recency:         0.30,
  salary:          0.05,
};

function scoreJob(job, profile, now = Date.now()) {
  let score = 0;

  // Location match: remote, or location text match
  const targetLocs = Array.isArray(profile.target_locations) ? profile.target_locations
    : (profile.target_locations ? JSON.parse(profile.target_locations || '[]') : []);
  const jobLoc = (job.location || '').toLowerCase();
  if (job.remote === 1 || job.remote === true) {
    score += WEIGHTS.location_match;
  } else if (targetLocs.length === 0 || targetLocs.some(l => jobLoc.includes(l.toLowerCase()))) {
    score += WEIGHTS.location_match * 0.7;
  }

  // Recency: decay over 14 days
  if (job.scraped_at || job.posted_at) {
    const ts = job.scraped_at ? job.scraped_at * 1000 : new Date(job.posted_at).getTime();
    const ageDays = (now - ts) / (1000 * 60 * 60 * 24);
    score += WEIGHTS.recency * Math.max(0, 1 - ageDays / 14);
  }

  // Domain match
  const jobText = (job.title + ' ' + (job.description || '')).toLowerCase();
  const targetDomains = Array.isArray(profile.target_domains) ? profile.target_domains
    : (profile.target_domains ? JSON.parse(profile.target_domains || '[]') : []);
  if (targetDomains.length === 0 || targetDomains.some(d => jobText.includes(d.toLowerCase()))) {
    score += WEIGHTS.domain_match;
  }

  // Seniority match
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
