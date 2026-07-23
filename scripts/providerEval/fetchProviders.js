/**
 * Pulls the frozen input set (NICHE_QUERIES x CANARY_COMPANIES) from a configured provider
 * adapter into provider_eval_jobs. Writes ONLY to that scratch table.
 */

import { computeFingerprint } from '../../services/jobs/schema.js';
import { NICHE_QUERIES, CANARY_COMPANIES } from './config.js';

function buildUpsertStmt(db) {
  return db.prepare(`
    INSERT INTO provider_eval_jobs
      (provider, provider_job_id, query, title, company, location, url, apply_url,
       description, posted_at, salary_min_usd, salary_max_usd, workplace_type,
       experience_level, valid_through, is_h1b_sponsor, requires_work_auth,
       is_clearance_required, fingerprint, fetched_at, raw_json)
    VALUES
      (@provider, @provider_job_id, @query, @title, @company, @location, @url, @apply_url,
       @description, @posted_at, @salary_min_usd, @salary_max_usd, @workplace_type,
       @experience_level, @valid_through, @is_h1b_sponsor, @requires_work_auth,
       @is_clearance_required, @fingerprint, @fetched_at, @raw_json)
    ON CONFLICT(provider, provider_job_id) DO UPDATE SET
      query = excluded.query, title = excluded.title, company = excluded.company,
      location = excluded.location, url = excluded.url, apply_url = excluded.apply_url,
      description = excluded.description, posted_at = excluded.posted_at,
      salary_min_usd = excluded.salary_min_usd, salary_max_usd = excluded.salary_max_usd,
      workplace_type = excluded.workplace_type, experience_level = excluded.experience_level,
      valid_through = excluded.valid_through, is_h1b_sponsor = excluded.is_h1b_sponsor,
      requires_work_auth = excluded.requires_work_auth,
      is_clearance_required = excluded.is_clearance_required,
      fingerprint = excluded.fingerprint, fetched_at = excluded.fetched_at,
      raw_json = excluded.raw_json
  `);
}

/**
 * Pulls the full frozen query/company set from one adapter into provider_eval_jobs.
 * @returns {number} rows pulled (post-dedup within this pull)
 */
async function pullProvider(db, adapter) {
  if (!adapter.isConfigured()) {
    console.log(`[providerEval] ${adapter.name}: no API key configured — skipping`);
    return 0;
  }

  const upsert = buildUpsertStmt(db);
  const now = Math.floor(Date.now() / 1000);
  let pulled = 0;

  for (const query of NICHE_QUERIES) {
    let jobs;
    try {
      jobs = await adapter.search({ query, companies: CANARY_COMPANIES });
    } catch (err) {
      // isConfigured() controls whether we attempt this provider at all; a request-level
      // failure here (vs. inside the adapter, which already catches per-call errors) is
      // unexpected but still shouldn't take down the whole eval run.
      console.warn(`[providerEval] ${adapter.name}: search failed for query "${query}": ${err.message}`);
      continue;
    }

    const txn = db.transaction((rows) => {
      for (const job of rows) {
        if (!job.provider_job_id || !job.title || !job.company) continue;
        upsert.run({
          provider:              adapter.name,
          provider_job_id:       job.provider_job_id,
          query,
          title:                 job.title,
          company:               job.company,
          location:              job.location || null,
          url:                   job.url || '',
          apply_url:             job.apply_url || job.url || '',
          description:           job.description || null,
          posted_at:             job.posted_at || null,
          salary_min_usd:        job.salary_min_usd ?? null,
          salary_max_usd:        job.salary_max_usd ?? null,
          workplace_type:        job.workplace_type || null,
          experience_level:      job.experience_level || null,
          valid_through:         job.valid_through ?? null,
          is_h1b_sponsor:        job.is_h1b_sponsor ?? null,
          requires_work_auth:    job.requires_work_auth ?? null,
          is_clearance_required: job.is_clearance_required ?? null,
          fingerprint:           computeFingerprint(job),
          fetched_at:            now,
          raw_json:              job.raw ? JSON.stringify(job.raw).slice(0, 20000) : null,
        });
      }
    });
    txn(jobs);
    pulled += jobs.length;
  }

  console.log(`[providerEval] ${adapter.name}: pulled ${pulled} rows across ${NICHE_QUERIES.length} queries x ${CANARY_COMPANIES.length} companies`);
  return pulled;
}

export { pullProvider };
