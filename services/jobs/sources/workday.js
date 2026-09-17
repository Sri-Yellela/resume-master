import axios from 'axios';
import { normalizeJob } from '../schema.js';
import { collectCompanyJobs } from './base.js';

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
    // NULL HERE, AND THE CRAWL LEAVES IT NULL. Workday's CXS SEARCH response carries no job text
    // — Phase 1 tried 12 extra POST-body keys and 7 query strings against a live tenant and every
    // response was byte-identical, and a list posting has exactly five keys. The text arrives
    // later, from services/jobs/detailFetch.js, inside the ENRICHMENT pass. See detailBudget.js.
    description: null,
    posted_at:   parsePostedOn(job.postedOn),
    // ⛔ THIS READ IS DEAD FROM THE LIST, MEASURED: `timeType` is absent from 100/100 live list
    // postings, so this has been NULL on every Workday row since the source was added — the same
    // shape as the `_atsSlug` bug, code that compiles, runs and reads nothing. Kept rather than
    // deleted because it is the correct mapping IF Workday ever returns the field, and because
    // deleting it would hide that the column has a real source: detailFetch.js now fills
    // contract_type from the JSON-LD page's `employmentType` ("FULL_TIME" -> "full time"), in the
    // request it already makes for the description, through a COALESCE that can only ever add.
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

const workdayPlugin = {
  name: 'workday',

  isConfigured() {
    return true;
  },

  // No incremental primitive on Workday's public career-site API (full pull every crawl;
  // the store-side watermark/fingerprint path in aggregator.js still makes repeat crawls
  // cheap). _updatedAfter is accepted for signature parity with sources that do support it,
  // but intentionally unused here.
  async search({ query, _companies = [], pageSize = 50 }) {
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

    const jobs = collectCompanyJobs(results, PER_COMPANY_MAX);

    // ⛔ NO DETAIL FETCH HERE, AND NO SLUG MAP EITHER. Task Y fetched one CXS detail request per
    // surviving posting, which needed the tenant/wd#/site triple threaded through from
    // `_companies` — and its first attempt lost it, because it rode on the normalized row and
    // normalizeJob is a field WHITELIST that silently drops what it does not name.
    //
    // That whole problem is gone rather than fixed. detailFetch.js reaches Workday through the
    // PUBLIC job page's schema.org JSON-LD, which is a GET of the URL ALREADY ON THE ROW — no
    // triple to reassemble, and Phase 1 measured its description as COMPLETE (1.12-1.16x more
    // readable text than CXS, which returns HTML with undecoded entities). A fetcher that works
    // from a stored row alone is what lets the enrichment pass and the user-opens-a-job path be
    // one implementation.
    return {
      jobs,
      total:    jobs.length,
      page:     1,
      pageSize: jobs.length,
    };
  },
};

export default workdayPlugin;
// Named exports for services/jobs/importJob.js's single-URL reuse of this source's already-
// working fetch+normalize (see importJob.js's fetchKnownAtsJob, which resolves the tenant/wd#/
// site slug via company_ats_list before calling this) — no change to the above.
export { fetchCompanyJobs, normalizeWorkdayJob, parseSlug };
