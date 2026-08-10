import axios from 'axios';
import { normalizeJob } from '../schema.js';
import { htmlToText, JOB_DESCRIPTION_MAX_LENGTH } from '../htmlToText.js';

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
    req_id:       String(job.id),
    title:        job.title,
    company:      companyName,
    location:     job.location?.name || 'Remote',
    url:          job.absolute_url,
    source:       'greenhouse',
    // `content` only exists when the board was fetched with ?content=true (see fetchCompanyJobs),
    // and arrives as entity-encoded HTML — htmlToText handles both the decode and the strip.
    description:  htmlToText(job.content, { maxLength: JOB_DESCRIPTION_MAX_LENGTH }),
    posted_at:    job.updated_at || null,
    _attribution: ATTRIBUTION,
    _raw:         job,
  });
}

// content=true is required: without it the board endpoint omits the `content` field entirely,
// so every row lands with a NULL description and enrichJob.js then reads an empty posting and
// extracts nothing. It returns descriptions for the whole board in the SAME request, so this
// costs no extra round-trips — only a larger response body.
async function fetchCompanyJobs(slug, companyName, words) {
  const url = `${BASE_URL}/${encodeURIComponent(slug)}/jobs?content=true`;
  const response = await axios.get(url, { timeout: 15000 });
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
// Named exports for services/jobs/importJob.js's single-URL reuse of this source's already-
// working fetch+normalize (see importJob.js's fetchKnownAtsJob) — no change to the above.
export { fetchCompanyJobs, normalizeGreenhouseJob };
