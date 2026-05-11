import axios from 'axios';
import { normalizeJob } from '../schema.js';

const BASE_URL = 'https://boards-api.greenhouse.io/v1/boards';

const ATTRIBUTION = {
  name: 'Greenhouse',
  url:  'https://www.greenhouse.io',
};

function queryWords(query) {
  return (query || '')
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length >= 3);
}

function titleMatchesQuery(title, words) {
  if (!words.length) return true;
  const lower = title.toLowerCase();
  return words.some(w => lower.includes(w));
}

function normalizeGreenhouseJob(job, companyName) {
  return normalizeJob({
    id:           String(job.id),
    title:        job.title,
    company:      companyName,
    location:     job.location?.name || 'Remote',
    url:          job.absolute_url,
    source:       'greenhouse',
    description:  null,
    posted_at:    job.updated_at || null,
    _attribution: ATTRIBUTION,
    _raw:         job,
  });
}

async function fetchCompanyJobs(slug, companyName, words) {
  const url = `${BASE_URL}/${encodeURIComponent(slug)}/jobs`;
  const response = await axios.get(url, { timeout: 8000 });
  const raw = response.data?.jobs || [];
  return raw
    .filter(j => titleMatchesQuery(j.title || '', words))
    .map(j => normalizeGreenhouseJob(j, companyName));
}

const greenhousePlugin = {
  name: 'greenhouse',

  isConfigured() {
    return true;
  },

  async search({ query, _companies = [], pageSize = 50 }) {
    const words = queryWords(query);
    const MAX = pageSize * 3;

    const results = await Promise.allSettled(
      _companies.map(({ ats_slug, company }) =>
        fetchCompanyJobs(ats_slug, company, words).catch(err => {
          console.warn(`[greenhouse] Failed to fetch jobs for "${company}" (${ats_slug}):`, err.message);
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

export default greenhousePlugin;
