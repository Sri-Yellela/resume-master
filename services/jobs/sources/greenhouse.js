import axios from 'axios';
import { normalizeJob } from '../schema.js';
import { htmlToText, JOB_DESCRIPTION_MAX_LENGTH, JOB_DESCRIPTION_TAIL_LENGTH } from '../htmlToText.js';

const BASE_URL = 'https://boards-api.greenhouse.io/v1/boards';

const ATTRIBUTION = {
  name: 'Greenhouse',
  url:  'https://www.greenhouse.io',
};

function queryWords(query) {
  return (query || '')
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length >= 3);
}

function titleMatchesQuery(title, words) {
  if (!words.length) return true;
  const lower = title.toLowerCase();
  return words.some(w => lower.includes(w));
}

/**
 * Greenhouse's structured pay range, when the board publishes one.
 *
 * This is strictly better than reading a figure out of the description: it is typed, currency-
 * tagged, exact, and costs no model call. It arrives ONLY when the board is fetched with
 * pay_transparency=true (see fetchCompanyJobs) — without that parameter the field is absent from
 * the response entirely, which is why every greenhouse row landed with a null salary until now.
 */
function greenhousePay(job) {
  const ranges = Array.isArray(job.pay_input_ranges) ? job.pay_input_ranges : [];
  const range = ranges.find(r => r && (r.min_cents != null || r.max_cents != null));
  if (!range) return {};

  const dollars = (cents) =>
    typeof cents === 'number' && Number.isFinite(cents) && cents > 0 ? Math.round(cents / 100) : null;

  // The period is not its own field — greenhouse states it in the range's title, e.g.
  // "Annual Base Salary Range:" or "Hourly Rate:". Anything unrecognised stays null rather than
  // defaulting to annual, which would turn an hourly rate into a six-figure salary.
  const title = String(range.title || '');
  const period = /hour/i.test(title) ? 'hourly'
    : /month/i.test(title) ? 'monthly'
    : /annual|year|salary/i.test(title) ? 'annual'
    : null;

  return {
    salary_min:      dollars(range.min_cents),
    salary_max:      dollars(range.max_cents),
    salary_currency: range.currency_type || null,
    salary_period:   period,
  };
}

function normalizeGreenhouseJob(job, companyName) {
  return normalizeJob({
    ...greenhousePay(job),
    id:           String(job.id),
    req_id:       String(job.id),
    title:        job.title,
    company:      companyName,
    location:     job.location?.name || 'Remote',
    url:          job.absolute_url,
    source:       'greenhouse',
    // `content` only exists when the board was fetched with ?content=true (see fetchCompanyJobs),
    // and arrives as entity-encoded HTML — htmlToText handles both the decode and the strip.
    description:  htmlToText(job.content, {
      maxLength: JOB_DESCRIPTION_MAX_LENGTH,
      tailLength: JOB_DESCRIPTION_TAIL_LENGTH,
    }),
    posted_at:    job.updated_at || null,
    _attribution: ATTRIBUTION,
    _raw:         job,
  });
}

// content=true is required: without it the board endpoint omits the `content` field entirely,
// so every row lands with a NULL description and enrichJob.js then reads an empty posting and
// extracts nothing. It returns descriptions for the whole board in the SAME request, so this
// costs no extra round-trips — only a larger response body.
async function fetchCompanyJobs(slug, companyName, words) {
  // pay_transparency=true adds `pay_input_ranges` to every job. Without it the field is omitted
  // from the response, so the structured salary is unavailable no matter how the payload is parsed.
  // Same round-trip, slightly larger body — the same trade content=true already makes.
  const url = `${BASE_URL}/${encodeURIComponent(slug)}/jobs?content=true&pay_transparency=true`;
  const response = await axios.get(url, { timeout: 15000 });
  const raw = response.data?.jobs || [];
  return raw
    .filter(j => titleMatchesQuery(j.title || '', words))
    .map(j => normalizeGreenhouseJob(j, companyName));
}

const greenhousePlugin = {
  name: 'greenhouse',

  isConfigured() {
    return true;
  },

  async search({ query, _companies = [], pageSize = 50 }) {
    const words = queryWords(query);
    const MAX = pageSize * 3;

    const results = await Promise.allSettled(
      _companies.map(({ ats_slug, company }) =>
        fetchCompanyJobs(ats_slug, company, words).catch(err => {
          console.warn(`[greenhouse] Failed to fetch jobs for "${company}" (${ats_slug}):`, err.message);
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

export default greenhousePlugin;
// Named exports for services/jobs/importJob.js's single-URL reuse of this source's already-
// working fetch+normalize (see importJob.js's fetchKnownAtsJob) — no change to the above.
export { fetchCompanyJobs, normalizeGreenhouseJob };
