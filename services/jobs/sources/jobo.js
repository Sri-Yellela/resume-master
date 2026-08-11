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

// Axios's default message is just "Request failed with status code 402", which discards the
// response body — and for this API the body is the only place the actual reason appears. A 402
// (wallet/quota) and a 401 (bad key) are operationally very different but read identically
// without it, and the caller only ever logs err.message. Named separately so the status is
// greppable in logs, and annotated for the two cases an operator must act on differently.
function enrichJoboError(err, what) {
  const status = err.response?.status;
  if (!status) return err;
  const body = err.response.data;
  const detail = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body || {}).slice(0, 300);
  let hint = '';
  if (status === 402) hint = ' — PAYMENT REQUIRED: the Jobo wallet/quota is exhausted or this request exceeds the plan. Rows will NOT sync until this is resolved; check the Jobo dashboard balance.';
  else if (status === 401 || status === 403) hint = ' — AUTH REJECTED: JOBO_API_KEY is set but not accepted (revoked, rotated, or wrong environment).';
  else if (status === 429) hint = ' — RATE LIMITED.';
  const wrapped = new Error(`Jobo ${what} failed: HTTP ${status}${hint} Response: ${detail}`);
  wrapped.status = status;
  wrapped.cause = err;
  return wrapped;
}

/**
 * POST /api/jobs/feed — one page. `body` is caller-supplied and varies by mode:
 *   backfill first page:   { batch_size, stable_scan: true }
 *   incremental first page:{ batch_size, updated_after: <ISO8601> }
 *   any next page:         { cursor }
 * This function doesn't know which mode it's in — aggregator.js's cacheJoboFeed decides.
 */
async function fetchFeedPage(body) {
  let response;
  try {
    response = await axios.post(FEED_URL, body, { headers: authHeaders(), timeout: 15000 });
  } catch (err) {
    throw enrichJoboError(err, 'feed fetch');
  }
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
  let response;
  try {
    response = await axios.get(EXPIRED_URL, { headers: authHeaders(), params, timeout: 15000 });
  } catch (err) {
    throw enrichJoboError(err, 'expired fetch');
  }
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

// Jobo's real response nests company under an object ({ id, name, website, ... }) rather than
// a plain string — confirmed via scripts/joboSyncSmokeTest.js against a live response, where
// this previously round-tripped as the literal string "[object Object]" (schema.js's
// normalizeJob does `String(company)`, which is correct for every OTHER source's plain-string
// company — jobo.js is the one source shaped differently upstream).
function pickCompanyName(job) {
  const c = pick(job, 'company', 'company_name', 'employer');
  if (c && typeof c === 'object') return c.name || null;
  return c;
}

// Same story for location: Jobo returns a `locations` ARRAY of objects ({ location, city,
// region, country, ... }), not a flat `location`/`city` string — pick(job, 'location', 'city')
// always missed it and fell through to normalizeJob's 'Location not specified' default even
// when a real location was present in the response.
function pickLocation(job) {
  const locs = Array.isArray(job.locations) ? job.locations : null;
  if (locs && locs.length) {
    const l = locs[0];
    return l.location || [l.city, l.region, l.country].filter(Boolean).join(', ') || null;
  }
  return pick(job, 'location', 'city');
}

// Jobo reports "Entry Level" / "Mid Level" / "Senior" / "Lead"; schema.js's
// normalizeExperienceLevel only accepts its own lowercase enum and otherwise falls back to
// guessing from the title. Mapping here means an explicitly-stated level is used as stated
// instead of being silently re-derived from title text.
const JOBO_EXPERIENCE_LEVELS = {
  intern: 'intern', internship: 'intern',
  entry: 'entry', 'entry level': 'entry', junior: 'entry', associate: 'entry',
  mid: 'mid', 'mid level': 'mid', 'mid-level': 'mid', intermediate: 'mid',
  senior: 'senior', principal: 'senior', staff: 'senior',
  lead: 'lead', manager: 'lead', director: 'lead',
  executive: 'executive', 'c-level': 'executive',
};

function mapJoboExperienceLevel(raw) {
  if (typeof raw !== 'string') return null;
  return JOBO_EXPERIENCE_LEVELS[raw.trim().toLowerCase()] || null;
}

// Jobo returns structured qualifications rather than a flat skills array:
//   qualifications: { must_have: { skills: [{ name, type }], ... }, nice_to_have: { ... } }
// The { name, type } entries are already the hard/soft split enrichJob.js pays an LLM to
// produce, so mapping them here populates skills_json for free. Emitted as { skill, type } to
// match enrichJob.js's shape, which is what mapJobRow.js's parseSkillsList reads.
function pickSkills(job) {
  const groups = [job.qualifications?.must_have, job.qualifications?.nice_to_have];
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    for (const entry of (Array.isArray(group?.skills) ? group.skills : [])) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (typeof name !== 'string' || !name.trim()) continue;
      const key = name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ skill: name.trim(), type: entry?.type === 'soft' ? 'soft' : 'hard' });
    }
  }
  if (out.length) return out;
  return Array.isArray(job.skills) ? job.skills : (Array.isArray(job.tags) ? job.tags : null);
}

function normalizeJoboJob(job) {
  const id = pick(job, 'id', 'job_id', 'external_id');
  const remoteFlag = pick(job, 'is_remote', 'remote');
  const hybridFlag = pick(job, 'is_hybrid', 'hybrid');
  // Compensation is a nested { min, max, currency, period } object. The flat salary_* keys this
  // used to read do not exist in the response, so salary was always null.
  const comp = job.compensation && typeof job.compensation === 'object' ? job.compensation : {};

  return normalizeJob({
    id,
    req_id:      id != null ? String(id) : null,
    title:       pick(job, 'title', 'job_title'),
    company:     pickCompanyName(job),
    location:    pickLocation(job),
    url:         pick(job, 'url', 'application_url', 'apply_url', 'listing_url'),
    source:      'jobo',
    description: pick(job, 'description', 'description_text'),
    salary_min:      comp.min      ?? pick(job, 'salary_min'),
    salary_max:      comp.max      ?? pick(job, 'salary_max'),
    salary_currency: comp.currency ?? pick(job, 'salary_currency', 'currency'),
    salary_period:   comp.period   ?? pick(job, 'salary_period'),
    // date_posted is when the EMPLOYER posted the role; created_at is merely when Jobo ingested
    // it into their own index. Reading created_at (as this did, since neither posted_at nor
    // published_at exists) overstates freshness by however long Jobo took to pick the job up --
    // on a live sample, created_at was 2026-04-29 for roles actually posted 2026-04-01..04-28.
    posted_at:       pick(job, 'date_posted', 'posted_at', 'published_at', 'created_at'),
    contract_type:   pick(job, 'employment_type', 'contract_type'),
    remote:          remoteFlag != null ? Boolean(remoteFlag) : null,
    // workplace_type is a top-level string ("On-site" / "Hybrid" / "Remote"). The is_remote /
    // is_hybrid booleans this used to read do not exist, so this was always null.
    // schema.js's normalizeWorkplaceType already canonicalises "On-site" -> "onsite".
    workplace_type:  pick(job, 'workplace_type')
                     ?? (remoteFlag === true ? 'remote' : (hybridFlag === true ? 'hybrid' : null)),
    experience_level: mapJoboExperienceLevel(pick(job, 'experience_level', 'seniority')),
    valid_through: (() => {
      const exp = pick(job, 'expires_at', 'valid_through');
      return exp ? Math.floor(new Date(exp).getTime() / 1000) : null;
    })(),
    skills: pickSkills(job),
    is_h1b_sponsor:        pick(job, 'h1b_sponsor', 'is_h1b_sponsor'),
    requires_work_auth:    pick(job, 'is_work_auth_required', 'requires_work_auth'),
    is_clearance_required: pick(job, 'is_clearance_required'),
    _raw: job,
  });
}

const joboSource = { isConfigured, fetchFeedPage, fetchExpiredPage, normalizeJoboJob };
export default joboSource;
export { isConfigured, fetchFeedPage, fetchExpiredPage, normalizeJoboJob };
