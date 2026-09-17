import axios from 'axios';
import { normalizeJob } from '../schema.js';
import { collectCompanyJobs } from './base.js';
import { attachDescriptions, createDetailBudget, detailBudgetFromEnv } from '../detailBudget.js';

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
    req_id:          job.id,
    title:           job.name,
    company:         companyName,
    location,
    url,
    source:          'smartrecruiters',
    // Still null HERE, and that is correct: the postings LIST endpoint omits jobAd content. The
    // text now arrives in a second pass, after capping, and only within a budget that is OFF by
    // default — see fetchPostingDescription below and services/jobs/detailBudget.js. Leaving it
    // null at this point keeps normalizeSmartRecruitersJob a pure mapping of what the list
    // returned, so importJob.js's single-URL reuse is unaffected.
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

// ONE posting's jobAd text. Separate and injectable (`_fetchDetail`) so the budget, the ordering
// and the plugin can all be tested without making a single request to SmartRecruiters — which
// matters more than usual here, because the thing being bounded IS outbound requests to them.
//
// Returns null rather than throwing: a posting whose detail fetch fails keeps its list row and
// stays description-less, which is exactly the status quo and not a regression. attachDescriptions
// contains the rejection too, but returning null keeps the intent local and readable.
async function fetchPostingDescription(job, injected = null) {
  if (injected) return injected(job);
  const raw = job?._raw || {};
  const companyIdentifier = raw.company?.identifier;
  const postingId = raw.id || job?.id;
  if (!companyIdentifier || !postingId) return null;
  try {
    const res = await axios.get(
      `${BASE_URL}/${encodeURIComponent(companyIdentifier)}/postings/${encodeURIComponent(postingId)}`,
      { timeout: 8000 },
    );
    const sections = res.data?.jobAd?.sections || {};
    // SmartRecruiters splits the ad into named sections; concatenated in the order a human reads
    // them. Falls back to whatever text is present rather than returning nothing for an ad that
    // uses only some of them.
    return ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
      .map(k => sections[k]?.text)
      .filter(Boolean)
      .join('\n\n') || null;
  } catch {
    return null;
  }
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
  async search({ query, _companies = [], pageSize = 50, _updatedAfter = null,
                 _detailBudget = null, _fetchDetail = null }) {
    const words = queryWords(query);
    // PER COMPANY, not across the concatenation. This was `MAX` applied to the flattened array,
    // which silently dropped every company past the 900th posting — see collectCompanyJobs.
    const PER_COMPANY_MAX = pageSize * 3;
    const updatedAfterIso = _updatedAfter ? new Date(_updatedAfter * 1000).toISOString() : null;

    const results = await Promise.allSettled(
      _companies.map(({ ats_slug, company }) =>
        fetchCompanyJobs(ats_slug, company, words, updatedAfterIso).catch(err => {
          console.warn(`[smartrecruiters] Failed to fetch jobs for "${company}" (${ats_slug}):`, err.message);
          return [];
        })
      )
    );

    // ⛔ CAP FIRST, THEN FETCH DETAIL. collectCompanyJobs discards everything past PER_COMPANY_MAX,
    // so fetching descriptions before this point spends real requests against SmartRecruiters on
    // rows that are then thrown away — the same defect as the cap `0de67c8` fixed, one layer up,
    // and equally invisible without counting. Pinned by test/detailBudget.test.js.
    const jobs = collectCompanyJobs(results, PER_COMPANY_MAX);

    const budget = _detailBudget || createDetailBudget(detailBudgetFromEnv());
    const detail = await attachDescriptions(
      jobs, budget,
      (job) => fetchPostingDescription(job, _fetchDetail),
      (job) => job.company || '_',
    );
    if (detail?.enabled) {
      console.log(`[smartrecruiters] detail fetch: ${detail.spent} spent, ${detail.skipped} skipped, ${detail.withText} gained text`);
    }

    return {
      jobs,
      total:    jobs.length,
      page:     1,
      pageSize: jobs.length,
      _detail:  detail,
    };
  },
};

export default smartrecruitersPlugin;
// Named exports for services/jobs/importJob.js's single-URL reuse of this source's already-
// working fetch+normalize (see importJob.js's fetchKnownAtsJob) — no change to the above.
export { fetchCompanyJobs, normalizeSmartRecruitersJob, fetchPostingDescription };
