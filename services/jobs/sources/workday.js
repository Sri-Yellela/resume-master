import axios from 'axios';
import { normalizeJob } from '../schema.js';
import { collectCompanyJobs } from './base.js';
import { attachDescriptions, createDetailBudget, detailBudgetFromEnv } from '../detailBudget.js';

// Workday's public career-site JSON API lives at a tenant- AND site-specific path, and the
// "wd#" subdomain number varies per tenant (wd1, wd3, wd5, ...) — unlike Greenhouse/Lever/
// Ashby's single-slug boards, a Workday board needs three pieces of info. company_ats_list's
// ats_slug encodes all three as "wdNumber|tenant|site", e.g. "5|adobe|external_experienced"
// (from https://adobe.wd5.myworkdayjobs.com/external_experienced).
function parseSlug(atsSlug) {
  const [wdNumber, tenant, site] = String(atsSlug || '').split('|');
  return { wdNumber, tenant, site };
}

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

// Workday's list endpoint gives relative strings ("Posted Today", "Posted 30+ Days Ago")
// rather than a real date — approximate to an ISO date so downstream age/freshness logic
// still has something usable, and fall back to null when it doesn't parse.
function parsePostedOn(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes('today')) return new Date().toISOString();
  if (t.includes('yesterday')) return new Date(Date.now() - 86400000).toISOString();
  const m = t.match(/(\d+)\+?\s*days?\s*ago/);
  if (m) return new Date(Date.now() - parseInt(m[1], 10) * 86400000).toISOString();
  return null;
}

function normalizeWorkdayJob(job, companyName, baseUrl) {
  return normalizeJob({
    id:          job.bulletFields?.[0] || job.externalPath,
    req_id:      job.bulletFields?.[0] || job.externalPath,
    title:       job.title,
    company:     companyName,
    location:    job.locationsText || 'Not specified',
    url:         job.externalPath ? `${baseUrl}${job.externalPath}` : baseUrl,
    source:      'workday',
    // Still null HERE, and correctly so: Workday's CXS SEARCH response carries no job text. The
    // description now arrives in a second pass, after capping, and only within a budget that is
    // OFF by default — see fetchPostingDescription below and services/jobs/detailBudget.js.
    description: null,
    posted_at:   parsePostedOn(job.postedOn),
    contract_type: job.timeType || null,
    _raw:        job,
  });
}

async function fetchCompanyJobs(atsSlug, companyName, words) {
  const { wdNumber, tenant, site } = parseSlug(atsSlug);
  if (!wdNumber || !tenant || !site) {
    throw new Error(`Malformed Workday ats_slug "${atsSlug}" — expected "wdNumber|tenant|site"`);
  }
  const host    = `https://${tenant}.wd${wdNumber}.myworkdayjobs.com`;
  const baseUrl = `${host}/${site}`;
  const apiUrl  = `${host}/wday/cxs/${tenant}/${site}/jobs`;

  const jobs = [];
  const limit = 20;
  let offset = 0;
  // Workday paginates the list endpoint; keep pulling while there's more, capped generously
  // so one huge board can't turn a routine crawl into an unbounded fetch loop.
  for (let page = 0; page < 15; page++) {
    const response = await axios.post(
      apiUrl,
      { appliedFacets: {}, limit, offset, searchText: '' },
      { timeout: 8000, headers: { 'Content-Type': 'application/json' } }
    );
    const postings = response.data?.jobPostings || [];
    jobs.push(...postings);
    if (postings.length < limit) break;
    offset += limit;
  }

  return jobs
    .filter(j => titleMatchesQuery(j.title || '', words))
    .map(j => normalizeWorkdayJob(j, companyName, baseUrl));
}

// ONE posting's description. Injectable (`_fetchDetail`) so the budget and the ordering can be
// tested without issuing a single request to a real Workday tenant — which matters because the
// thing being bounded IS outbound requests to Adobe's careers API.
//
// Workday's CXS detail endpoint mirrors the search path: the same
// /wday/cxs/{tenant}/{site} prefix, plus the posting's externalPath. Returns null on any failure,
// leaving the list row description-less, which is the status quo rather than a regression.
//
// The slug is PASSED IN rather than read off the row. The first version of this carried it on the
// normalized job as `_atsSlug` — which compiled, ran, and did nothing, because normalizeJob in
// schema.js is a field WHITELIST that builds its result field by field and silently drops
// anything it does not name. search() owns the company -> slug mapping, so it supplies it.
async function fetchPostingDescription(job, atsSlug, injected = null) {
  if (injected) return injected(job);
  const externalPath = job?._raw?.externalPath;
  if (!externalPath || !atsSlug) return null;
  const { wdNumber, tenant, site } = parseSlug(atsSlug);
  if (!wdNumber || !tenant || !site) return null;
  try {
    const res = await axios.get(
      `https://${tenant}.wd${wdNumber}.myworkdayjobs.com/wday/cxs/${tenant}/${site}${externalPath}`,
      { timeout: 8000, headers: { Accept: 'application/json' } },
    );
    // jobDescription is HTML; the board stores HTML elsewhere too and htmlToText handles it
    // downstream, so it is passed through rather than stripped here.
    return res.data?.jobPostingInfo?.jobDescription || null;
  } catch {
    return null;
  }
}

const workdayPlugin = {
  name: 'workday',

  isConfigured() {
    return true;
  },

  // No incremental primitive on Workday's public career-site API (full pull every crawl;
  // the store-side watermark/fingerprint path in aggregator.js still makes repeat crawls
  // cheap). _updatedAfter is accepted for signature parity with sources that do support it,
  // but intentionally unused here.
  async search({ query, _companies = [], pageSize = 50,
                 _detailBudget = null, _fetchDetail = null }) {
    const words = queryWords(query);
    // PER COMPANY, not across the concatenation. This was `MAX` applied to the flattened array,
    // which silently dropped every company past the 900th posting — see collectCompanyJobs.
    const PER_COMPANY_MAX = pageSize * 3;

    const results = await Promise.allSettled(
      _companies.map(({ ats_slug, company }) =>
        fetchCompanyJobs(ats_slug, company, words).catch(err => {
          console.warn(`[workday] Failed to fetch jobs for "${company}" (${ats_slug}):`, err.message);
          return [];
        })
      )
    );

    // ⛔ CAP FIRST, THEN FETCH DETAIL — see the same note in smartrecruiters.js and the header of
    // services/jobs/detailBudget.js. Rows past PER_COMPANY_MAX are discarded, so fetching their
    // descriptions first spends real requests on rows that are thrown away.
    const jobs = collectCompanyJobs(results, PER_COMPANY_MAX);

    // company -> ats_slug, because the detail endpoint needs the tenant/site triple and the
    // normalized row cannot carry it (see fetchPostingDescription).
    const slugByCompany = new Map(_companies.map(c => [c.company, c.ats_slug]));

    const budget = _detailBudget || createDetailBudget(detailBudgetFromEnv());
    const detail = await attachDescriptions(
      jobs, budget,
      (job) => fetchPostingDescription(job, slugByCompany.get(job.company), _fetchDetail),
      (job) => job.company || '_',
    );
    if (detail?.enabled) {
      console.log(`[workday] detail fetch: ${detail.spent} spent, ${detail.skipped} skipped, ${detail.withText} gained text`);
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

export default workdayPlugin;
// Named exports for services/jobs/importJob.js's single-URL reuse of this source's already-
// working fetch+normalize (see importJob.js's fetchKnownAtsJob, which resolves the tenant/wd#/
// site slug via company_ats_list before calling this) — no change to the above.
export { fetchCompanyJobs, normalizeWorkdayJob, parseSlug };
