import axios from 'axios';
import { normalizeJob } from '../schema.js';

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
    const MAX = pageSize * 3;

    const results = await Promise.allSettled(
      _companies.map(({ ats_slug, company }) =>
        fetchCompanyJobs(ats_slug, company, words).catch(err => {
          console.warn(`[workday] Failed to fetch jobs for "${company}" (${ats_slug}):`, err.message);
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

export default workdayPlugin;
