/**
 * TheirStack adapter — https://theirstack.com
 *
 * NOTE: implemented from TheirStack's documented "job search" REST shape as best known at
 * time of writing (POST /v1/jobs/search, bearer token, job_title_or/company_name_or filters).
 * Verify against their current API reference before relying on results — the request/response
 * mapping below is best-effort and may need adjustment; any request failure here is caught
 * and treated as "no results" rather than crashing the eval run (see base.js contract).
 */

import axios from 'axios';

const API_KEY  = process.env.THEIRSTACK_API_KEY || '';
const BASE_URL = 'https://api.theirstack.com/v1/jobs/search';

function isConfigured() {
  return !!API_KEY;
}

function normalize(job) {
  return {
    provider_job_id:       String(job.id ?? job.job_id ?? job.url ?? ''),
    title:                 job.job_title || job.title || '',
    company:               job.company_object?.name || job.company_name || job.company || '',
    location:              job.location || job.long_location || (job.remote ? 'Remote' : null) || 'Not specified',
    url:                   job.url || job.final_url || '',
    apply_url:             job.final_url || job.url || '',
    description:           job.description || null,
    posted_at:             job.date_posted || job.discovered_at || null,
    salary_min_usd:        job.min_annual_salary_usd ?? null,
    salary_max_usd:        job.max_annual_salary_usd ?? null,
    workplace_type:        job.remote === true ? 'remote' : (job.hybrid === true ? 'hybrid' : null),
    experience_level:      job.seniority || null,
    valid_through:         null, // not consistently provided by this endpoint
    is_h1b_sponsor:        job.h1b_sponsor === true ? 1 : (job.h1b_sponsor === false ? 0 : null),
    requires_work_auth:    null,
    is_clearance_required: null,
    raw:                   job,
  };
}

async function searchOne(query, company) {
  try {
    const body = {
      limit: 25,
      job_title_or: query ? [query] : undefined,
      company_name_or: company ? [company] : undefined,
      posted_at_max_age_days: 60,
    };
    const res = await axios.post(BASE_URL, body, {
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    const jobs = res.data?.data || res.data?.jobs || [];
    return Array.isArray(jobs) ? jobs.map(normalize) : [];
  } catch (err) {
    console.warn(`[providerEval:theirstack] Request failed (query="${query}", company="${company || ''}"): ${err.message}`);
    return [];
  }
}

async function search({ query = '', companies = [] } = {}) {
  if (!isConfigured()) return [];
  if (!companies.length) return searchOne(query, null);

  const results = await Promise.allSettled(companies.map(c => searchOne(query, c)));
  return results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
}

const theirstackAdapter = { name: 'theirstack', isConfigured, search };
export default theirstackAdapter;
