/**
 * Jobo Job Feed adapter — a FEED sync source, not a per-query search adapter.
 *
 * Unlike the ATS plugins in this directory (workday.js, greenhouse.js, ...), Jobo has no
 * per-company scoping and no query-time search primitive: it exposes its whole catalogue as a
 * paged feed (POST /api/jobs/feed, backfill via stable_scan or incremental via updated_after)
 * plus a separate expired-ids feed (GET /api/jobs/expired). Because of that this module is
 * deliberately NOT the {name, isConfigured, search} shape from ./base.js and is NOT registered
 * in aggregator.js's SOURCES array — it's imported directly by aggregator.js's cacheJoboFeed(),
 * which owns the sync_state/backfill/incremental/expiry state machine (see aggregator.js).
 *
 * NOTE: scripts/providerEval/adapters/jobo.js targets a different (wrong-guess) endpoint —
 * that adapter is for the standalone eval harness only and is untouched by this module.
 */

import axios from 'axios';
import { normalizeJob } from '../schema.js';

const API_KEY    = process.env.JOBO_API_KEY || '';
const FEED_URL    = 'https://connect.jobo.world/api/jobs/feed';
const EXPIRED_URL = 'https://connect.jobo.world/api/jobs/expired';

function isConfigured() {
  return !!API_KEY;
}

function authHeaders() {
  return { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' };
}

/**
 * POST /api/jobs/feed — one page. `body` is caller-supplied and varies by mode:
 *   backfill first page:   { batch_size, stable_scan: true }
 *   incremental first page:{ batch_size, updated_after: <ISO8601> }
 *   any next page:         { cursor }
 * This function doesn't know which mode it's in — aggregator.js's cacheJoboFeed decides.
 */
async function fetchFeedPage(body) {
  const response = await axios.post(FEED_URL, body, { headers: authHeaders(), timeout: 15000 });
  const data = response.data || {};
  return {
    jobs:       Array.isArray(data.jobs) ? data.jobs : [],
    hasMore:    Boolean(data.has_more),
    nextCursor: data.next_cursor || null,
  };
}

/**
 * GET /api/jobs/expired — one page. expired_since + batch_size are always sent; cursor is
 * added once a prior page returned one (additive, per Jobo's documented query shape).
 */
async function fetchExpiredPage({ expiredSince, batchSize = 10000, cursor } = {}) {
  const params = { expired_since: expiredSince, batch_size: batchSize };
  if (cursor) params.cursor = cursor;
  const response = await axios.get(EXPIRED_URL, { headers: authHeaders(), params, timeout: 15000 });
  const data = response.data || {};
  return {
    jobIds:     Array.isArray(data.job_ids) ? data.job_ids : [],
    hasMore:    Boolean(data.has_more),
    nextCursor: data.next_cursor || null,
  };
}

// Jobo's docs (as supplied) cover the feed/expired envelope shape but not the per-job field
// names, so this mapping is deliberately defensive — a couple of plausible key variants per
// field, same style scripts/providerEval/adapters/jobo.js used for its (unrelated, wrong-
// endpoint) guess. scripts/joboSyncSmokeTest.js prints a raw job's keys on first real run so
// this can be corrected against reality rather than left as a guess.
function pick(job, ...keys) {
  for (const k of keys) {
    if (job[k] !== undefined && job[k] !== null) return job[k];
  }
  return null;
}

function normalizeJoboJob(job) {
  const id = pick(job, 'id', 'job_id', 'external_id');
  const remoteFlag = pick(job, 'is_remote', 'remote');
  const hybridFlag = pick(job, 'is_hybrid', 'hybrid');

  return normalizeJob({
    id,
    req_id:      id != null ? String(id) : null,
    title:       pick(job, 'title', 'job_title'),
    company:     pick(job, 'company', 'company_name', 'employer'),
    location:    pick(job, 'location', 'city'),
    url:         pick(job, 'url', 'application_url', 'apply_url', 'listing_url'),
    source:      'jobo',
    description: pick(job, 'description', 'description_text'),
    salary_min:      pick(job, 'salary_min'),
    salary_max:      pick(job, 'salary_max'),
    salary_currency: pick(job, 'salary_currency', 'currency'),
    posted_at:       pick(job, 'posted_at', 'published_at', 'created_at'),
    contract_type:   pick(job, 'employment_type', 'contract_type'),
    remote:          remoteFlag != null ? Boolean(remoteFlag) : null,
    workplace_type:  remoteFlag === true ? 'remote' : (hybridFlag === true ? 'hybrid' : null),
    experience_level: pick(job, 'experience_level', 'seniority'),
    valid_through: (() => {
      const exp = pick(job, 'expires_at', 'valid_through');
      return exp ? Math.floor(new Date(exp).getTime() / 1000) : null;
    })(),
    skills: Array.isArray(job.skills) ? job.skills : (Array.isArray(job.tags) ? job.tags : null),
    is_h1b_sponsor:        pick(job, 'h1b_sponsor', 'is_h1b_sponsor'),
    requires_work_auth:    pick(job, 'requires_work_auth'),
    is_clearance_required: pick(job, 'is_clearance_required'),
    _raw: job,
  });
}

const joboSource = { isConfigured, fetchFeedPage, fetchExpiredPage, normalizeJoboJob };
export default joboSource;
export { isConfigured, fetchFeedPage, fetchExpiredPage, normalizeJoboJob };
