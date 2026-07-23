/**
 * Jobo adapter.
 *
 * NOTE: this project doesn't have confirmed API documentation for Jobo on hand, so the
 * request/response shape below is a best-effort placeholder using a conventional REST
 * pattern (GET /v1/jobs?query=&company=, API key header). Before this adapter is trusted for
 * a real eval run, verify the actual endpoint/auth/field names against Jobo's current docs
 * and update normalize()/searchOne() accordingly — until then, treat any output from this
 * adapter as suspect. Any request failure is caught and treated as "no results" (see
 * base.js contract) so a wrong guess here degrades to a clean skip, not a crash.
 */

import axios from 'axios';

const API_KEY  = process.env.JOBO_API_KEY || '';
const BASE_URL = 'https://api.jobo.com/v1/jobs';

function isConfigured() {
  return !!API_KEY;
}

function normalize(job) {
  return {
    provider_job_id:       String(job.id ?? job.job_id ?? job.url ?? ''),
    title:                 job.title || job.job_title || '',
    company:               job.company || job.company_name || '',
    location:              job.location || (job.is_remote ? 'Remote' : null) || 'Not specified',
    url:                   job.url || job.listing_url || '',
    apply_url:             job.apply_url || job.url || '',
    description:           job.description || null,
    posted_at:             job.posted_at || job.published_at || null,
    salary_min_usd:        job.salary_min ?? null,
    salary_max_usd:        job.salary_max ?? null,
    workplace_type:        job.is_remote === true ? 'remote' : (job.is_hybrid === true ? 'hybrid' : null),
    experience_level:      job.experience_level || null,
    valid_through:         job.expires_at ? Math.floor(new Date(job.expires_at).getTime() / 1000) : null,
    is_h1b_sponsor:        job.h1b_sponsor === true ? 1 : (job.h1b_sponsor === false ? 0 : null),
    requires_work_auth:    job.requires_work_auth === true ? 1 : (job.requires_work_auth === false ? 0 : null),
    is_clearance_required: null,
    raw:                   job,
  };
}

async function searchOne(query, company) {
  try {
    const res = await axios.get(BASE_URL, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      params: { query: query || undefined, company: company || undefined, limit: 25 },
      timeout: 10000,
    });
    const jobs = res.data?.results || res.data?.jobs || res.data?.data || [];
    return Array.isArray(jobs) ? jobs.map(normalize) : [];
  } catch (err) {
    console.warn(`[providerEval:jobo] Request failed (query="${query}", company="${company || ''}"): ${err.message}`);
    return [];
  }
}

async function search({ query = '', companies = [] } = {}) {
  if (!isConfigured()) return [];
  if (!companies.length) return searchOne(query, null);

  const results = await Promise.allSettled(companies.map(c => searchOne(query, c)));
  return results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
}

const joboAdapter = { name: 'jobo', isConfigured, search };
export default joboAdapter;
