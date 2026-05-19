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

// Maps skill/title keywords to bucket_role values used in scraped_jobs
const SKILL_TO_ROLE = {
  'data scientist':       'data_scientist',
  'machine learning':     'data_scientist',
  'ml engineer':          'data_scientist',
  'applied scientist':    'data_scientist',
  'research scientist':   'data_scientist',
  'data analyst':         'data_scientist',
  'analytics engineer':   'data_engineer',
  'data engineer':        'data_engineer',
  'etl':                  'data_engineer',
  'software engineer':    'software_engineer',
  'software developer':   'software_engineer',
  'full stack':           'software_engineer',
  'full-stack':           'software_engineer',
  'frontend':             'software_engineer',
  'front-end':            'software_engineer',
  'backend':              'software_engineer',
  'back-end':             'software_engineer',
  'web developer':        'software_engineer',
  'sde':                  'software_engineer',
  'swe':                  'software_engineer',
  'programmer':           'software_engineer',
  'product manager':      'product_manager',
  'product owner':        'product_manager',
  'designer':             'designer',
  'ux':                   'designer',
  'ui designer':          'designer',
  'product designer':     'designer',
  'devops':               'devops',
  'site reliability':     'devops',
  'platform engineer':    'devops',
  'cloud engineer':       'devops',
  'sre':                  'devops',
  'mobile':               'mobile_engineer',
  'ios':                  'mobile_engineer',
  'android':              'mobile_engineer',
  'react native':         'mobile_engineer',
  'flutter':              'mobile_engineer',
  'security':             'security',
  'cybersecurity':        'security',
  'infosec':              'security',
};

function resolveUserRoles(profile) {
  // Parse user skills from target_skills or confirmed_skills
  // Handles JSON array strings, comma-separated strings, and plain arrays
  let userSkills = [];
  try {
    const raw = profile.target_skills || profile.confirmed_skills || '';
    if (Array.isArray(raw)) {
      userSkills = raw.map(s => String(s).toLowerCase().trim()).filter(Boolean);
    } else if (typeof raw === 'string' && raw.startsWith('[')) {
      userSkills = JSON.parse(raw)
        .map(s => (typeof s === 'string' ? s : s.value || s.label || '').toLowerCase().trim())
        .filter(Boolean);
    } else if (typeof raw === 'string' && raw.length > 0) {
      userSkills = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }
  } catch {
    userSkills = [];
  }

  // Map skill keywords → bucket roles
  return [...new Set(
    userSkills.flatMap(skill =>
      Object.entries(SKILL_TO_ROLE)
        .filter(([k]) => skill.includes(k))
        .map(([, v]) => v)
    )
  )];
}

function scoreJob(job, profile, now = Date.now()) {
  let score = 0;

  // Role match: map user skills/targets to bucket roles, compare to job.bucket_role
  const mappedRoles = resolveUserRoles(profile);
  const roleMatch = mappedRoles.length > 0
    ? (mappedRoles.includes(job.bucket_role) ? 1.0
       : job.bucket_role === 'other'          ? 0.5
       :                                        0.2)
    : 0.5; // no profile preference set — neutral
  score += WEIGHTS.role_match * roleMatch;

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
  const jobText = (job.title + ' ' + (job.description || '')).toLowerCase();
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
