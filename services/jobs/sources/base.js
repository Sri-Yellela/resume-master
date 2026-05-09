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

export { validatePlugin, SEARCH_PARAMS_SCHEMA, SEARCH_RESULT_SCHEMA };
