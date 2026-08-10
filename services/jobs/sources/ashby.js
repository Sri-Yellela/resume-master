import axios from 'axios';
import { normalizeJob } from '../schema.js';
import { htmlToText, JOB_DESCRIPTION_MAX_LENGTH } from '../htmlToText.js';

const BASE_URL = 'https://api.ashbyhq.com/posting-api/job-board';

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

// Ashby reports intervals as "1 YEAR" / "1 HOUR" / "1 MONTH", which schema.js's
// normalizeSalaryPeriod doesn't recognise (it would pass "1year" straight through as a bogus
// period). Reduce to the bare unit here and let normalizeSalaryPeriod canonicalise it.
function ashbyIntervalToPeriod(interval) {
  if (typeof interval !== 'string') return null;
  const match = interval.match(/\b(year|hour|month|week|day)\b/i);
  return match ? match[1].toLowerCase() : null;
}

function extractAshbyCompensation(job) {
  const comp = job.compensation;
  if (!comp) return {};

  // summaryComponents is a MIXED list — Salary, Bonus and EquityPercentage entries all live in
  // it, in no guaranteed order. Taking [0] blindly (as this did) reads a bonus or equity range
  // as though it were base pay, so select by compensationType instead.
  const salaryComponent = comp.summaryComponents?.find(c => c.compensationType === 'Salary');
  if (salaryComponent) {
    return {
      salary_min:      salaryComponent.minValue != null ? Number(salaryComponent.minValue) : null,
      salary_max:      salaryComponent.maxValue != null ? Number(salaryComponent.maxValue) : null,
      salary_currency: salaryComponent.currencyCode || null,
      salary_period:   ashbyIntervalToPeriod(salaryComponent.interval),
    };
  }

  // Flat fallback, for boards that expose a bare range rather than components.
  return {
    salary_min:      comp.min      != null ? Number(comp.min)      : (comp.minValue != null ? Number(comp.minValue) : null),
    salary_max:      comp.max      != null ? Number(comp.max)      : (comp.maxValue != null ? Number(comp.maxValue) : null),
    salary_currency: comp.currency || comp.currencyCode || null,
    salary_period:   ashbyIntervalToPeriod(comp.interval) || comp.period || null,
  };
}

// Ashby sends 'Remote' | 'Hybrid' | 'On-site'; schema.js expects remote|hybrid|onsite.
function normalizeAshbyWorkplaceType(workplaceType, isRemote) {
  const raw = typeof workplaceType === 'string' ? workplaceType.toLowerCase().replace(/[-_\s]+/g, '') : '';
  if (raw === 'remote' || raw === 'hybrid') return raw;
  if (raw === 'onsite' || raw === 'inoffice') return 'onsite';
  return isRemote ? 'remote' : null;
}

function normalizeAshbyJob(job, companyName) {
  // The posting-api board endpoint returns `descriptionPlain` (already plain text) and
  // `descriptionHtml`. There is no `descriptionSections` field — reading it, as this used to,
  // silently yielded null for every row, which is why enrichment had no text to work from.
  const descriptionText = job.descriptionPlain
    ? job.descriptionPlain.slice(0, JOB_DESCRIPTION_MAX_LENGTH)
    : htmlToText(job.descriptionHtml, { maxLength: JOB_DESCRIPTION_MAX_LENGTH });

  const comp = extractAshbyCompensation(job);

  return normalizeJob({
    id:             job.id,
    req_id:         job.id,
    title:          job.title,
    company:        companyName,
    location:       job.location || (job.isRemote ? 'Remote' : 'Not specified'),
    url:            job.applyUrl,
    source:         'ashby',
    description:    descriptionText,
    posted_at:      job.publishedDate || null,
    remote:         !!job.isRemote,
    _raw:           job,
    workplace_type: normalizeAshbyWorkplaceType(job.workplaceType, job.isRemote),
    salary_min:     comp.salary_min,
    salary_max:     comp.salary_max,
    salary_currency: comp.salary_currency,
    salary_period:  comp.salary_period,
  });
}

// includeCompensation=true is required: without it the response has no `compensation` key at
// all, so extractAshbyCompensation always returned {} and every Ashby row stored a NULL salary.
async function fetchCompanyJobs(slug, companyName, words) {
  const url = `${BASE_URL}/${encodeURIComponent(slug)}?includeCompensation=true`;
  const response = await axios.get(url, { timeout: 15000 });
  const jobs = response.data?.jobs || [];
  return jobs
    .filter(j => titleMatchesQuery(j.title, words))
    .map(j => normalizeAshbyJob(j, companyName));
}

const ashbyPlugin = {
  name: 'ashby',

  isConfigured() {
    return true;
  },

  async search({ query, _companies = [], pageSize = 50 }) {
    const words = queryWords(query);
    const MAX = pageSize * 3;

    const results = await Promise.allSettled(
      _companies.map(({ ats_slug, company }) =>
        fetchCompanyJobs(ats_slug, company, words).catch(err => {
          console.warn(`[ashby] Failed to fetch jobs for "${company}" (${ats_slug}):`, err.message);
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

export default ashbyPlugin;
// Named exports for services/jobs/importJob.js's single-URL reuse of this source's already-
// working fetch+normalize (see importJob.js's fetchKnownAtsJob) — no change to the above.
export { fetchCompanyJobs, normalizeAshbyJob };
