/**
 * The 6 rubric dimensions computed from a provider's pulled rows (provider_eval_jobs) plus
 * whatever live scraped_jobs/company_ats_list data is needed for comparison. Every function
 * here is read-only against the live tables — nothing in this file writes to scraped_jobs.
 */

import axios from 'axios';
import { computeFingerprint } from '../../services/jobs/schema.js';
import { isDirectApply, filterDirectApplyOnly } from '../../services/jobs/directApplyFilter.js';
import { EXPIRY_MIN_AGE_DAYS } from './config.js';

// ── 1. Marginal coverage ────────────────────────────────────────────────────────────────
// % of a provider's pulled rows that are NOT already in our live board, deduped via the
// same cross-source fingerprint (company|title|primary-location) the live pipeline uses.
function computeMarginalCoverage(providerRows, liveFingerprintSet) {
  if (!providerRows.length) return { total: 0, netNew: 0, pct: 0 };
  let netNew = 0;
  for (const row of providerRows) {
    const fp = row.fingerprint || computeFingerprint(row);
    if (!liveFingerprintSet.has(fp)) netNew++;
  }
  return { total: providerRows.length, netNew, pct: (netNew / providerRows.length) * 100 };
}

// ── 2. Freshness lag ─────────────────────────────────────────────────────────────────────
// For each canary company, compare our own ATS crawl's first-seen time (scraped_jobs
// discovered_at, earliest) against the provider's appearance time (posted_at, earliest) for
// that same company. Positive lagDays = provider saw it later than we did (good for us);
// negative = provider was ahead of our own crawl.
function computeFreshnessLag(providerRowsByCompany, liveFirstSeenByCompany) {
  const perCompany = [];
  for (const [company, rows] of Object.entries(providerRowsByCompany)) {
    const ourFirstSeen = liveFirstSeenByCompany[company];
    if (ourFirstSeen == null || !rows.length) continue;
    const providerTimes = rows
      .map(r => (r.posted_at ? Date.parse(r.posted_at) / 1000 : null))
      .filter(t => Number.isFinite(t));
    if (!providerTimes.length) continue;
    const providerFirstSeen = Math.min(...providerTimes);
    const lagDays = (providerFirstSeen - ourFirstSeen) / 86400;
    perCompany.push({ company, ourFirstSeen, providerFirstSeen, lagDays });
  }
  if (!perCompany.length) return { perCompany: [], avgLagDays: null, medianLagDays: null };
  const sorted = [...perCompany].map(c => c.lagDays).sort((a, b) => a - b);
  const avgLagDays = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const medianLagDays = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return { perCompany, avgLagDays, medianLagDays };
}

// Short HEAD (falls back to GET) check — used by both apply-url quality (dead-link
// detection) and expiry hygiene (still-live check). Any network failure or 4xx/5xx counts
// as "not live"; a successful response counts as live regardless of body content, since we
// only need reachability here, not content verification.
async function checkUrlLive(url, timeoutMs = 6000) {
  if (!url) return false;
  try {
    const res = await axios.head(url, { timeout: timeoutMs, maxRedirects: 5, validateStatus: () => true });
    if (res.status < 400) return true;
    // Some ATS boards reject HEAD; retry once with GET before concluding dead.
    if (res.status === 405) {
      const getRes = await axios.get(url, { timeout: timeoutMs, maxRedirects: 5, validateStatus: () => true });
      return getRes.status < 400;
    }
    return false;
  } catch {
    return false;
  }
}

// ── 3. Apply-url quality ─────────────────────────────────────────────────────────────────
// Of a sample, classify each row's url as direct-ATS, aggregator-redirect, or dead, and
// report what fraction survives the live pipeline's own filterDirectApplyOnly.
async function computeApplyUrlQuality(providerRows, sampleSize) {
  const sample = providerRows.slice(0, sampleSize);
  if (!sample.length) return { sampled: 0, directAts: 0, aggregatorRedirect: 0, dead: 0, postFilterYieldPct: 0 };

  let directAts = 0, aggregatorRedirect = 0, dead = 0;
  for (const row of sample) {
    const url = row.apply_url || row.url;
    const live = await checkUrlLive(url);
    if (!live) { dead++; continue; }
    if (isDirectApply({ source: row.provider, url })) directAts++;
    else aggregatorRedirect++;
  }

  const passed = filterDirectApplyOnly(sample.map(r => ({ source: r.provider, url: r.apply_url || r.url }))).length;
  return {
    sampled: sample.length,
    directAts, aggregatorRedirect, dead,
    postFilterYieldPct: (passed / sample.length) * 100,
  };
}

// ── 4. Field completeness ───────────────────────────────────────────────────────────────
const COMPLETENESS_FIELDS = {
  salary:          r => r.salary_min_usd != null || r.salary_max_usd != null,
  workModel:       r => r.workplace_type != null,
  experienceLevel: r => r.experience_level != null,
  validThrough:    r => r.valid_through != null,
  visa:            r => r.is_h1b_sponsor != null || r.requires_work_auth != null || r.is_clearance_required != null,
};

function computeFieldCompleteness(providerRows, handVerifySampleSize) {
  const total = providerRows.length;
  const fillRates = {};
  for (const [field, predicate] of Object.entries(COMPLETENESS_FIELDS)) {
    fillRates[field] = total ? (providerRows.filter(predicate).length / total) * 100 : 0;
  }

  // Hand-verify checklist: a formatted sample for a human reviewer to eyeball for accuracy
  // (not something this script can judge itself — field presence != field correctness).
  const handVerifySample = providerRows.slice(0, handVerifySampleSize).map(r => ({
    title: r.title, company: r.company, url: r.url,
    salary: r.salary_min_usd || r.salary_max_usd ? `${r.salary_min_usd ?? '?'}-${r.salary_max_usd ?? '?'}` : null,
    workModel: r.workplace_type, experienceLevel: r.experience_level,
    validThrough: r.valid_through, visaFlags: {
      h1b: r.is_h1b_sponsor, workAuth: r.requires_work_auth, clearance: r.is_clearance_required,
    },
    verifiedAccurate: null, // <- fill in by hand after reading the actual posting
  }));

  return { total, fillRates, handVerifySample };
}

// ── 5. Expiry hygiene ────────────────────────────────────────────────────────────────────
// % of sampled OLDER listings (by the provider's own posted_at) whose url is still live.
async function computeExpiryHygiene(providerRows, sampleSize, minAgeDays = EXPIRY_MIN_AGE_DAYS) {
  const nowSec = Math.floor(Date.now() / 1000);
  const older = providerRows.filter(r => {
    const postedSec = r.posted_at ? Date.parse(r.posted_at) / 1000 : null;
    return Number.isFinite(postedSec) && (nowSec - postedSec) / 86400 >= minAgeDays;
  });
  const sample = older.slice(0, sampleSize);
  if (!sample.length) return { sampled: 0, stillLive: 0, stillLivePct: null };

  let stillLive = 0;
  for (const row of sample) {
    if (await checkUrlLive(row.apply_url || row.url)) stillLive++;
  }
  return { sampled: sample.length, stillLive, stillLivePct: (stillLive / sample.length) * 100 };
}

// ── 6. Cost per net-new fresh job ───────────────────────────────────────────────────────
// estimatedMonthlyCostUsd is a config value (real vendor pricing isn't API-discoverable).
// netNewRatePerPull is how many net-new jobs THIS pull produced; scaled to the real monthly
// crawl volume to estimate a realistic monthly net-new count, then divided into cost.
function computeCostPerNetNewJob(estimatedMonthlyCostUsd, netNewCount, pullsPerMonthEquivalent) {
  if (estimatedMonthlyCostUsd == null) return { costPerNetNewJobUsd: null, note: 'No pricing configured — see config.js PROVIDER_META' };
  const estimatedMonthlyNetNew = netNewCount * pullsPerMonthEquivalent;
  if (!estimatedMonthlyNetNew) return { costPerNetNewJobUsd: null, note: 'No net-new jobs found in this pull' };
  return { costPerNetNewJobUsd: estimatedMonthlyCostUsd / estimatedMonthlyNetNew, estimatedMonthlyNetNew };
}

export {
  computeMarginalCoverage,
  computeFreshnessLag,
  computeApplyUrlQuality,
  computeFieldCompleteness,
  computeExpiryHygiene,
  computeCostPerNetNewJob,
  checkUrlLive,
};
