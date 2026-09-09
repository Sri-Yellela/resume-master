/**
 * JOB SOURCE PLUGIN INTERFACE
 *
 * Every source plugin must export an object matching this shape.
 * Register plugins in services/jobs/aggregator.js — nowhere else.
 *
 * Example minimal plugin:
 *
 *   export default {
 *     name: 'mysource',
 *     isConfigured: () => !!process.env.MYSOURCE_API_KEY,
 *     search: async ({ query, location, page, pageSize, country }) => {
 *       // fetch from API
 *       // normalize each result with normalizeJob()
 *       return { jobs: [...], total: 0, page: 1, pageSize: 10 };
 *     },
 *   };
 */

function validatePlugin(plugin) {
  const required = ['name', 'isConfigured', 'search'];
  for (const field of required) {
    if (typeof plugin[field] === 'undefined') {
      throw new Error(`Job source plugin "${plugin.name || '?'}" missing required field: ${field}`);
    }
  }
  if (typeof plugin.isConfigured !== 'function') {
    throw new Error(`Plugin "${plugin.name}": isConfigured must be a function`);
  }
  if (typeof plugin.search !== 'function') {
    throw new Error(`Plugin "${plugin.name}": search must be a function`);
  }
}

/**
 * Search params passed to every plugin's search() function.
 * Plugins may ignore fields they don't support.
 */
const SEARCH_PARAMS_SCHEMA = {
  query:    'string  — job title or keyword',
  location: 'string  — city, state, or "remote"',
  country:  'string  — ISO 3166-1 alpha-2 e.g. "us" (default: "us")',
  page:     'number  — 1-based page number (default: 1)',
  pageSize: 'number  — results per page (default: 10, max: 50)',
};

/**
 * Shape every plugin's search() must resolve to.
 */
const SEARCH_RESULT_SCHEMA = {
  jobs:     'NormalizedJob[]',
  total:    'number — total results available from this source',
  page:     'number — current page',
  pageSize: 'number — results per page',
  source:   'string — plugin name (set automatically by aggregator)',
};

/**
 * Collect per-company fetch results into one job list, capping EACH COMPANY rather than the
 * concatenation.
 *
 * ⛔ THIS EXISTS BECAUSE THE OBVIOUS VERSION SILENTLY LOST 60% OF THE BOARD. All seven ATS
 * plugins carried a copy of:
 *
 *     const MAX = pageSize * 3;
 *     results.flatMap(r => r.status === 'fulfilled' ? r.value : []).slice(0, MAX)
 *
 * `_companies` arrives from `SELECT * FROM company_ats_list WHERE active = 1` with no ORDER BY, so
 * it is in sqlite rowid order; `flatMap` concatenates each company's postings in that order; and
 * the slice then discards the TAIL. Every company falling past the cut contributed nothing at all,
 * and `cacheJobs` still recorded the run `status: 'ok'` — so the failure was invisible at every
 * layer below it. Measured against the providers' own APIs on 2026-09-09, both folds run over one
 * fetch of production's own company list:
 *
 *   greenhouse  9 slugs, 2,265 postings   old fold 900   RECOVERED 1,365
 *   ashby       4 slugs, 1,086 postings   old fold 900   RECOVERED   186
 *   lever/workable/recruitee              under the cap  RECOVERED     0
 *
 * The board held 1,255 rows from FIVE companies while eighteen of twenty-three active slugs sat at
 * zero — every one of them probed HTTP 200 with a healthy job list. The arithmetic pins the
 * mechanism to the row: greenhouse's rowid order is stripe 616 + airbnb 170 + figma 114 = exactly
 * 900, so Figma lost 43 of its 157 and Anthropic (595), Brex (282), Scale AI (211), Duolingo (89),
 * Vercel (87) and Mercury (58) were severed whole. ashby's is notion 131 + openai 769 = 900, so
 * OpenAI lost 12 and Ramp (145) and Linear (29) were severed whole.
 *
 * WHY A CAP AT ALL. `search()` serves two callers with opposite needs. Live search
 * (POST /api/jobs/search) passes pageSize 10-20 and neither paginates nor slices downstream, so
 * its payload is whatever the plugins return and a bound is genuinely required. `cacheJobs` passes
 * pageSize 300 as a "give me everything" signal. Capping per company satisfies both without a
 * second code path: no company can starve another, and at the crawl's pageSize the per-company
 * ceiling of 900 is above every real board (the largest observed is openai at 781), so the crawl
 * takes every company whole.
 *
 * The cap is deliberately NOT a total. A total is what made adding a company able to silently
 * evict a different one, which is the property that made this undetectable — the set of companies
 * that survived depended on insertion order and shifted whenever the table changed.
 *
 * @param {PromiseSettledResult<object[]>[]} results  one settled entry per company, in _companies order
 * @param {number} perCompany                          max postings kept from EACH company
 * @returns {object[]} the concatenation, each company capped
 */
function collectCompanyJobs(results, perCompany) {
  const limit = Number.isFinite(perCompany) && perCompany > 0 ? perCompany : Infinity;
  const jobs = [];
  for (const r of results) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
    // slice(0, Infinity) is a copy of the whole array, which is the intended no-op.
    jobs.push(...r.value.slice(0, limit));
  }
  return jobs;
}

export { validatePlugin, SEARCH_PARAMS_SCHEMA, SEARCH_RESULT_SCHEMA, collectCompanyJobs };
