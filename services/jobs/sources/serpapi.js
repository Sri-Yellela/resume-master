import axios from 'axios';
import { normalizeJob } from '../schema.js';

function parseDaysAgo(str = '') {
  if (!str || str.includes('hour') || str.includes('just')) return 0;
  const m = str.match(/(\d+)\s*day/);
  return m ? parseInt(m[1], 10) : 7;
}

function normalizeGoogleJob(raw) {
  const ext = raw.detected_extensions || {};
  const url = raw.apply_options?.[0]?.link
            || raw.related_links?.[0]?.link
            || raw.share_link || '';
  return normalizeJob({
    id:           raw.job_id || ('serp-' + Date.now()),
    title:        raw.title,
    company:      raw.company_name,
    location:     raw.location,
    url,
    source:       'serpapi',
    description:  raw.description || null,
    salary_min:   ext.salary_min || null,
    salary_max:   ext.salary_max || null,
    posted_at:    new Date(
      Date.now() - parseDaysAgo(ext.posted_at) * 86400000
    ).toISOString(),
    remote:       !!ext.work_from_home,
    thumbnail:    raw.thumbnail || null,
    via:          raw.via       || null,
    _attribution: { name: 'Google Jobs via SerpApi', url: 'https://serpapi.com' },
  });
}

const serpapiPlugin = {
  name: 'serpapi',

  isConfigured() {
    return !!process.env.SERPAPI_KEY;
  },

  async search({ query, location, page = 1, pageSize = 10, remote, contractType }) {
    if (!this.isConfigured() || !query?.trim()) {
      return { jobs: [], total: 0, source: 'serpapi' };
    }
    let q = query.trim();
    if (remote) q += ' remote';
    if (contractType === 'contract') q += ' contract';

    const { data } = await axios.get('https://serpapi.com/search', {
      params: {
        engine:   'google_jobs',
        q,
        location: location || undefined,
        hl:       'en',
        gl:       'us',
        chips:    'date_posted:week',
        api_key:  process.env.SERPAPI_KEY,
        num:      Math.min(pageSize, 10),
        start:    (page - 1) * 10,
      },
      timeout: 12000,
    });

    const jobs = (data.jobs_results || []).map(normalizeGoogleJob);
    return { jobs, total: jobs.length * 3, source: 'serpapi' };
  },
};

export default serpapiPlugin;
