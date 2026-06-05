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

  async search({ query, location, country = 'us', page = 1, pageSize = 10,
                  sort, employmentType, remote, maxResults = 0 }) {
    const FETCH_PAGE_SIZE = 50;
    const cap = maxResults > 0 ? Math.min(maxResults, 200) : Math.min(pageSize, 50);

    const baseParams = {
      app_id:           process.env.ADZUNA_APP_ID,
      app_key:          process.env.ADZUNA_APP_KEY,
      results_per_page: FETCH_PAGE_SIZE,
    };

    if (query)    baseParams.what  = query;
    if (location) baseParams.where = location;

    // Sort mapping
    if (sort === 'dateDesc')        { baseParams.sort_by = 'date';   baseParams.sort_direction = 'down'; }
    else if (sort === 'dateAsc')    { baseParams.sort_by = 'date';   baseParams.sort_direction = 'up'; }
    else if (sort === 'salaryDesc') { baseParams.sort_by = 'salary'; baseParams.sort_direction = 'down'; }
    else if (sort === 'salaryAsc')  { baseParams.sort_by = 'salary'; baseParams.sort_direction = 'up'; }

    // Contract type mapping (employmentType is comma-separated e.g. "full-time,contract")
    if (employmentType) {
      const types = String(employmentType).split(',').map(t => t.trim());
      if (types.includes('full-time')) baseParams.full_time = 1;
      if (types.includes('part-time')) baseParams.part_time = 1;
      if (types.includes('contract'))  baseParams.contract  = 1;
    }

    // Pagination loop: fetches multiple pages when maxResults > 50
    let allJobs = [];
    let total   = 0;
    let currentPage = page;

    while (allJobs.length < cap) {
      const url = `${BASE_URL}/${country}/search/${currentPage}`;
      const response = await axios.get(url, { params: baseParams, timeout: 8000 });
      const data     = response.data;
      const pageJobs = (data.results || []).map(normalizeAdzunaJob);
      total = data.count || 0;
      allJobs.push(...pageJobs);
      if (pageJobs.length < FETCH_PAGE_SIZE || allJobs.length >= total) break;
      currentPage++;
      // Small delay between pages to avoid rate-limiting
      await new Promise(r => setTimeout(r, 300));
    }

    // Trim to cap and dedupe by URL
    const seen = new Set();
    allJobs = allJobs
      .slice(0, cap)
      .filter(j => {
        if (!j.url || seen.has(j.url)) return false;
        seen.add(j.url);
        return true;
      });

    // Adzuna has no native remote filter — apply post-fetch when requested
    if (remote === true || remote === 'true') {
      allJobs = allJobs.filter(j => j.remote === true);
    }

    return {
      jobs:     allJobs,
      total,
      page,
      pageSize: allJobs.length,
      source:   'adzuna',
    };
  },
};

export default adzunaPlugin;
