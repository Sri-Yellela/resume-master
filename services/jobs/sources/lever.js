import axios from 'axios';
import { normalizeJob } from '../schema.js';

const BASE_URL = 'https://api.lever.co/v0/postings';

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

function normalizeLeverPosting(posting, companyName) {
  return normalizeJob({
    id:           posting.id,
    title:        posting.text,
    company:      companyName,
    location:     posting.categories?.location || posting.workplaceType || 'Remote',
    url:          posting.hostedUrl || posting.applyUrl,
    source:       'lever',
    description:  posting.descriptionPlain?.slice(0, 3000) || null,
    posted_at:    posting.createdAt ? new Date(posting.createdAt).toISOString() : null,
    remote:       posting.workplaceType === 'remote',
    _raw:         posting,
  });
}

async function fetchCompanyJobs(slug, companyName, words) {
  const url = `${BASE_URL}/${encodeURIComponent(slug)}?mode=json`;
  const response = await axios.get(url, { timeout: 8000 });
  const postings = Array.isArray(response.data) ? response.data : [];
  return postings
    .filter(p => titleMatchesQuery(p.text, words))
    .map(p => normalizeLeverPosting(p, companyName));
}

const leverPlugin = {
  name: 'lever',

  isConfigured() {
    return true;
  },

  async search({ query, _companies = [], pageSize = 50 }) {
    const words = queryWords(query);
    const MAX = pageSize * 3;

    const results = await Promise.allSettled(
      _companies.map(({ ats_slug, company }) =>
        fetchCompanyJobs(ats_slug, company, words).catch(err => {
          console.warn(`[lever] Failed to fetch jobs for "${company}" (${ats_slug}):`, err.message);
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

export default leverPlugin;
