/**
 * Adapter contract every provider in scripts/providerEval/adapters/ must implement:
 *
 *   {
 *     name: 'theirstack' | 'jobo' | ...,
 *     isConfigured(): boolean,                          // true iff its API key is present
 *     async search({ query, companies }): Promise<Job[]> // one query/company combo per call
 *   }
 *
 * Job (the normalized shape every adapter must return, self-contained — deliberately NOT the
 * live pipeline's normalizeJob from services/jobs/schema.js, to keep this harness decoupled):
 *   {
 *     provider_job_id, title, company, location, url, apply_url, description, posted_at,
 *     salary_min_usd, salary_max_usd, workplace_type, experience_level, valid_through,
 *     is_h1b_sponsor, requires_work_auth, is_clearance_required, raw,
 *   }
 * Every field except provider_job_id/title/company/url is nullable — adapters should map
 * what the provider actually returns and leave the rest null rather than guessing.
 *
 * Adapters must never throw for "provider had no results" or routine HTTP errors on a single
 * request — catch and return []; only isConfigured() controls whether a provider is skipped
 * entirely. This keeps one flaky call from aborting the whole eval run.
 */

function validateAdapter(adapter) {
  const required = ['name', 'isConfigured', 'search'];
  for (const key of required) {
    if (!(key in adapter)) throw new Error(`Provider adapter missing required "${key}"`);
  }
  if (typeof adapter.isConfigured !== 'function') throw new Error(`${adapter.name}: isConfigured must be a function`);
  if (typeof adapter.search !== 'function') throw new Error(`${adapter.name}: search must be a function`);
}

export { validateAdapter };
