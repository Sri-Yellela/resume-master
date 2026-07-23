import axios from 'axios';
import { normalizeJob } from '../schema.js';

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

function normalizeRecruiteeJob(job, companyName) {
  const loc = job.location || [job.city, job.state_name, job.country].filter(Boolean).join(', ') || 'Not specified';
  const workplaceType = job.remote ? 'remote' : (job.hybrid ? 'hybrid' : (job.on_site ? 'onsite' : null));
  const salary = job.salary || {};

  return normalizeJob({
    id:              String(job.id),
    title:           job.title,
    company:         companyName,
    location:        job.remote ? 'Remote' : loc,
    url:             job.careers_url,
    source:          'recruitee',
    description:     job.description || job.requirements || null,
    posted_at:       job.published_at || job.created_at || null,
    remote:          !!job.remote,
    workplace_type:  workplaceType,
    experience_level: job.experience_code || null,
    contract_type:   job.employment_type_code || null,
    salary_min:      salary.min != null ? Number(salary.min) : null,
    salary_max:      salary.max != null ? Number(salary.max) : null,
    salary_currency: salary.currency || null,
    salary_period:   salary.period || null,
    _raw:            job,
  });
}

async function fetchCompanyJobs(slug, companyName, words) {
  const url = `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`;
  const response = await axios.get(url, { timeout: 8000 });
  const offers = response.data?.offers || [];
  return offers
    .filter(o => titleMatchesQuery(o.title, words))
    .map(o => normalizeRecruiteeJob(o, companyName));
}

const recruiteePlugin = {
  name: 'recruitee',

  isConfigured() {
    return true;
  },

  async search({ query, _companies = [], pageSize = 50 }) {
    const words = queryWords(query);
    const MAX = pageSize * 3;

    const results = await Promise.allSettled(
      _companies.map(({ ats_slug, company }) =>
        fetchCompanyJobs(ats_slug, company, words).catch(err => {
          console.warn(`[recruitee] Failed to fetch jobs for "${company}" (${ats_slug}):`, err.message);
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

export default recruiteePlugin;
