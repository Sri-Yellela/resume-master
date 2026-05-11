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

function normalizeAshbyJob(job, companyName) {
  const descriptionText = job.descriptionSections
    ?.map(s => s.content)
    .join('\n')
    .slice(0, 3000) || null;

  return normalizeJob({
    id:          job.id,
    title:       job.title,
    company:     companyName,
    location:    job.location || (job.isRemote ? 'Remote' : 'Not specified'),
    url:         job.applyUrl,
    source:      'ashby',
    description: descriptionText,
    posted_at:   job.publishedDate || null,
    remote:      !!job.isRemote,
    _raw:        job,
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
