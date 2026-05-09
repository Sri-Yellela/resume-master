import axios from 'axios';
import { normalizeJob } from '../schema.js';

const BASE_URL = 'https://api.adzuna.com/v1/api/jobs';

// Adzuna ToS requires attribution near job results.
// Surfaced via _attribution on each job — frontend renders generically.
const ATTRIBUTION = {
  name: 'Adzuna',
  url:  'https://www.adzuna.com',
};

function mapContractType(adzunaValue) {
  const map = { full_time: 'full_time', part_time: 'part_time', contract: 'contract' };
  return map[adzunaValue] || null;
}

function inferRemote(title = '', location = '') {
  const text = `${title} ${location}`.toLowerCase();
  return text.includes('remote') || text.includes('work from home');
}

function normalizeAdzunaJob(raw) {
  return normalizeJob({
    id:              String(raw.id),
    title:           raw.title,
    company:         raw.company?.display_name || 'Unknown Company',
    location:        raw.location?.display_name || raw.location?.area?.join(', ') || null,
    url:             raw.redirect_url,
    source:          'adzuna',
    description:     raw.description || null,
    salary_min:      raw.salary_min || null,
    salary_max:      raw.salary_max || null,
    salary_currency: 'USD',
    posted_at:       raw.created || null,
    contract_type:   mapContractType(raw.contract_time),
    remote:          inferRemote(raw.title, raw.location?.display_name),
    _attribution:    ATTRIBUTION,
    _raw:            raw,
  });
}

const adzunaPlugin = {
  name: 'adzuna',

  isConfigured() {
    return !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY);
  },

  async search({ query, location, country = 'us', page = 1, pageSize = 10 }) {
    const params = {
      app_id:           process.env.ADZUNA_APP_ID,
      app_key:          process.env.ADZUNA_APP_KEY,
      results_per_page: Math.min(pageSize, 50),
    };

    if (query)    params.what  = query;
    if (location) params.where = location;

    const url = `${BASE_URL}/${country}/search/${page}`;

    const response = await axios.get(url, {
      params,
      timeout: 8000,
    });

    const data = response.data;

    return {
      jobs:     (data.results || []).map(normalizeAdzunaJob),
      total:    data.count || 0,
      page,
      pageSize: Math.min(pageSize, 50),
      source:   'adzuna',
    };
  },
};

export default adzunaPlugin;
