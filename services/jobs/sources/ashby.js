import axios from 'axios';
import { normalizeJob } from '../schema.js';

const BASE_URL = 'https://api.ashbyhq.com/posting-api/job-board';

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

function extractAshbyCompensation(job) {
  const comp = job.compensation;
  if (!comp) return {};
  // Try summaryComponents array (Ashby v2 structure)
  const component = comp.summaryComponents?.[0];
  if (component) {
    return {
      salary_min:      component.compensationRangeMin  != null ? Number(component.compensationRangeMin)  : null,
      salary_max:      component.compensationRangeMax  != null ? Number(component.compensationRangeMax)  : null,
      salary_currency: component.currency              || null,
      salary_period:   component.compensationPeriod    || null,
    };
  }
  // Fall back to flat structure
  return {
    salary_min:      comp.min      != null ? Number(comp.min)      : (comp.minValue != null ? Number(comp.minValue) : null),
    salary_max:      comp.max      != null ? Number(comp.max)      : (comp.maxValue != null ? Number(comp.maxValue) : null),
    salary_currency: comp.currency || null,
    salary_period:   comp.interval || comp.period || null,
  };
}

function normalizeAshbyJob(job, companyName) {
  const descriptionText = job.descriptionSections
    ?.map(s => s.content)
    .join('\n')
    .slice(0, 3000) || null;

  const comp = extractAshbyCompensation(job);

  return normalizeJob({
    id:             job.id,
    req_id:         job.id,
    title:          job.title,
    company:        companyName,
    location:       job.location || (job.isRemote ? 'Remote' : 'Not specified'),
    url:            job.applyUrl,
    source:         'ashby',
    description:    descriptionText,
    posted_at:      job.publishedDate || null,
    remote:         !!job.isRemote,
    _raw:           job,
    workplace_type: job.isRemote ? 'remote' : null,
    salary_min:     comp.salary_min,
    salary_max:     comp.salary_max,
    salary_currency: comp.salary_currency,
    salary_period:  comp.salary_period,
  });
}

async function fetchCompanyJobs(slug, companyName, words) {
  const url = `${BASE_URL}/${encodeURIComponent(slug)}`;
  const response = await axios.get(url, { timeout: 8000 });
  const jobs = response.data?.jobs || [];
  return jobs
    .filter(j => titleMatchesQuery(j.title, words))
    .map(j => normalizeAshbyJob(j, companyName));
}

const ashbyPlugin = {
  name: 'ashby',

  isConfigured() {
    return true;
  },

  async search({ query, _companies = [], pageSize = 50 }) {
    const words = queryWords(query);
    const MAX = pageSize * 3;

    const results = await Promise.allSettled(
      _companies.map(({ ats_slug, company }) =>
        fetchCompanyJobs(ats_slug, company, words).catch(err => {
          console.warn(`[ashby] Failed to fetch jobs for "${company}" (${ats_slug}):`, err.message);
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

export default ashbyPlugin;
// Named exports for services/jobs/importJob.js's single-URL reuse of this source's already-
// working fetch+normalize (see importJob.js's fetchKnownAtsJob) — no change to the above.
export { fetchCompanyJobs, normalizeAshbyJob };
