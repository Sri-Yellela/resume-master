import axios from 'axios';
import { normalizeJob } from '../schema.js';

const BASE_URL = 'https://api.smartrecruiters.com/v1/companies';

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

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeSmartRecruitersJob(job, companyName) {
  const loc = job.location || {};
  const location = loc.remote ? 'Remote'
    : loc.fullLocation || [loc.city, loc.region, loc.country].filter(Boolean).join(', ') || 'Not specified';

  // The list endpoint doesn't include the public posting URL, only an internal API `ref`.
  // SmartRecruiters' public job pages follow a predictable
  // jobs.smartrecruiters.com/{companyIdentifier}/{id}-{slugified-title} pattern — reconstruct
  // it here rather than firing a second (detail) request per posting for every company on
  // every crawl. Falls back to the identifier-only URL (still resolves) if title is missing.
  const companyIdentifier = job.company?.identifier || companyName;
  const url = `https://jobs.smartrecruiters.com/${encodeURIComponent(companyIdentifier)}/${job.id}${job.name ? '-' + slugify(job.name) : ''}`;

  return normalizeJob({
    id:              job.id,
    title:           job.name,
    company:         companyName,
    location,
    url,
    source:          'smartrecruiters',
    description:     null,
    posted_at:       job.releasedDate || null,
    remote:          !!loc.remote,
    workplace_type:  loc.remote ? 'remote' : (loc.hybrid ? 'hybrid' : null),
    experience_level: job.experienceLevel?.id || null,
    contract_type:   job.typeOfEmployment?.id || null,
    _raw:            job,
  });
}

async function fetchCompanyJobs(slug, companyName, words, updatedAfterIso) {
  const jobs = [];
  const limit = 100;
  let offset = 0;
  for (let page = 0; page < 10; page++) {
    const params = { limit, offset };
    if (updatedAfterIso) params.updatedAfter = updatedAfterIso;
    const response = await axios.get(`${BASE_URL}/${encodeURIComponent(slug)}/postings`, {
      timeout: 8000, params,
    });
    const postings = response.data?.content || [];
    jobs.push(...postings);
    if (postings.length < limit) break;
    offset += limit;
  }

  return jobs
    .filter(j => titleMatchesQuery(j.name, words))
    .map(j => normalizeSmartRecruitersJob(j, companyName));
}

const smartrecruitersPlugin = {
  name: 'smartrecruiters',

  isConfigured() {
    return true;
  },

  // SmartRecruiters' public Postings API genuinely supports an `updatedAfter` filter (unlike
  // Greenhouse/Lever/Ashby/Workday/Workable/Recruitee, which don't expose one) — accepted
  // here for real incremental capability. NOT wired to narrow results from aggregator.js's
  // shared cacheJobs call site today: that loop's stale-prune logic marks any row absent from
  // a crawl as gone, which assumes every fetch is a full/authoritative snapshot. Narrowing to
  // "changed since X" would make every UNCHANGED job look absent and get wrongly pruned within
  // two crawls. Using this for real requires the prune model to distinguish a deliberately
  // partial (incremental) fetch from a full one — a follow-up, not this task's scope. Callable
  // directly (e.g. a scheduled true-delta sync) with a real _updatedAfter today regardless.
  async search({ query, _companies = [], pageSize = 50, _updatedAfter = null }) {
    const words = queryWords(query);
    const MAX = pageSize * 3;
    const updatedAfterIso = _updatedAfter ? new Date(_updatedAfter * 1000).toISOString() : null;

    const results = await Promise.allSettled(
      _companies.map(({ ats_slug, company }) =>
        fetchCompanyJobs(ats_slug, company, words, updatedAfterIso).catch(err => {
          console.warn(`[smartrecruiters] Failed to fetch jobs for "${company}" (${ats_slug}):`, err.message);
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

export default smartrecruitersPlugin;
