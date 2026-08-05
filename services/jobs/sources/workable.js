import axios from 'axios';
import { normalizeJob } from '../schema.js';

const BASE_URL = 'https://apply.workable.com/api/v1/widget/accounts';

function queryWords(query) {
  return (query || '')
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length >= 3);
}

function titleMatchesQuery(title, words) {
  if (!words.length) return true;
  const lower = (title || '').toLowerCase();
  return words.some(w => lower.includes(w));
}

function normalizeWorkableJob(job, companyName) {
  const location = [job.city, job.state, job.country].filter(Boolean).join(', ') || 'Not specified';
  return normalizeJob({
    id:              job.shortcode,
    req_id:          job.shortcode,
    title:           job.title,
    company:         companyName,
    location:        job.telecommuting ? 'Remote' : location,
    url:             job.application_url || job.url,
    source:          'workable',
    description:     null,
    posted_at:       job.published_on || job.created_at || null,
    remote:          !!job.telecommuting,
    workplace_type:  job.telecommuting ? 'remote' : null,
    experience_level: job.experience || null,
    contract_type:   job.employment_type || null,
    _raw:            job,
  });
}

async function fetchCompanyJobs(slug, companyName, words) {
  const url = `${BASE_URL}/${encodeURIComponent(slug)}`;
  const response = await axios.get(url, { timeout: 8000 });
  const jobs = response.data?.jobs || [];
  return jobs
    .filter(j => titleMatchesQuery(j.title, words))
    .map(j => normalizeWorkableJob(j, companyName));
}

const workablePlugin = {
  name: 'workable',

  isConfigured() {
    return true;
  },

  async search({ query, _companies = [], pageSize = 50 }) {
    const words = queryWords(query);
    const MAX = pageSize * 3;

    const results = await Promise.allSettled(
      _companies.map(({ ats_slug, company }) =>
        fetchCompanyJobs(ats_slug, company, words).catch(err => {
          console.warn(`[workable] Failed to fetch jobs for "${company}" (${ats_slug}):`, err.message);
          return [];
        })
      )
    );

    const jobs = results
      .flatMap(r => (r.status === 'fulfilled' ? r.value : []))
      .slice(0, MAX);

    return {
      jobs,
      total:    jobs.length,
      page:     1,
      pageSize: jobs.length,
    };
  },
};

export default workablePlugin;
// Named exports for services/jobs/importJob.js's single-URL reuse of this source's already-
// working fetch+normalize (see importJob.js's fetchKnownAtsJob) — no change to the above.
export { fetchCompanyJobs, normalizeWorkableJob };
