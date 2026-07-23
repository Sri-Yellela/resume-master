/**
 * Provider evaluation harness — entrypoint.
 *
 *   node scripts/providerEval/run.js [--reset]
 *
 * Fully isolated from the live pipeline: reads scraped_jobs/company_ats_list read-only for
 * comparison data, writes only to the scratch table provider_eval_jobs. Nothing in the live
 * app (server.js, aggregator.js, any route) imports anything under scripts/providerEval/ —
 * this is a standalone CLI tool, not wired into the running app.
 *
 * Add new providers by dropping an adapter in adapters/ (see adapters/base.js for the
 * contract) and adding it to the PROVIDERS array below.
 */

import { openDb, resetEvalData } from './db.js';
import { pullProvider } from './fetchProviders.js';
import {
  computeMarginalCoverage, computeFreshnessLag, computeApplyUrlQuality,
  computeFieldCompleteness, computeExpiryHygiene, computeCostPerNetNewJob,
} from './metrics.js';
import { scoreProvider, licenseFlag, formatTable } from './rubric.js';
import {
  CANARY_COMPANIES, APPLY_URL_SAMPLE_SIZE, HAND_VERIFY_SAMPLE_SIZE, EXPIRY_SAMPLE_SIZE,
  PROVIDER_META,
} from './config.js';
import { validateAdapter } from './adapters/base.js';

import theirstackAdapter from './adapters/theirstack.js';
import joboAdapter from './adapters/jobo.js';

const PROVIDERS = [theirstackAdapter, joboAdapter];
PROVIDERS.forEach(validateAdapter);

// How many "pulls" of this size would happen in a real month, for the cost-per-net-new-job
// projection. This eval pull covers a fixed niche query set once; a real monthly cadence for
// a provider integration would likely run roughly daily, hence ~30.
const PULLS_PER_MONTH_EQUIVALENT = 30;

async function main() {
  const shouldReset = process.argv.includes('--reset');
  const db = openDb();
  if (shouldReset) {
    resetEvalData(db);
    console.log('[providerEval] Cleared prior scratch data (--reset)');
  }

  // Live comparison data (read-only) ---------------------------------------------------
  const liveFingerprintSet = new Set(
    db.prepare(`SELECT fingerprint FROM scraped_jobs WHERE is_active = 1 AND fingerprint IS NOT NULL`)
      .all().map(r => r.fingerprint)
  );
  const liveFirstSeenRows = db.prepare(`
    SELECT company, MIN(discovered_at) as firstSeen
    FROM scraped_jobs
    WHERE company IN (${CANARY_COMPANIES.map(() => '?').join(',')}) AND discovered_at IS NOT NULL
    GROUP BY company
  `).all(...CANARY_COMPANIES);
  const liveFirstSeenByCompany = Object.fromEntries(liveFirstSeenRows.map(r => [r.company, r.firstSeen]));

  const scoredRows = [];
  const skipped = [];

  for (const adapter of PROVIDERS) {
    if (!adapter.isConfigured()) {
      const envVar = adapter.name === 'theirstack' ? 'THEIRSTACK_API_KEY' : 'JOBO_API_KEY';
      console.log(`[providerEval] ${PROVIDER_META[adapter.name]?.label || adapter.name}: SKIPPED — ${envVar} not set`);
      skipped.push({ name: adapter.name, envVar });
      continue;
    }

    await pullProvider(db, adapter);

    const rows = db.prepare(`SELECT * FROM provider_eval_jobs WHERE provider = ?`).all(adapter.name);
    const rowsByCompany = {};
    for (const r of rows) (rowsByCompany[r.company] ||= []).push(r);

    const coverage     = computeMarginalCoverage(rows, liveFingerprintSet);
    const freshness    = computeFreshnessLag(rowsByCompany, liveFirstSeenByCompany);
    const applyUrl     = await computeApplyUrlQuality(rows, APPLY_URL_SAMPLE_SIZE);
    const completeness = computeFieldCompleteness(rows, HAND_VERIFY_SAMPLE_SIZE);
    const expiry       = await computeExpiryHygiene(rows, EXPIRY_SAMPLE_SIZE);
    const cost         = computeCostPerNetNewJob(
      PROVIDER_META[adapter.name]?.estimatedMonthlyCostUsd ?? null,
      coverage.netNew,
      PULLS_PER_MONTH_EQUIVALENT
    );

    const scores  = scoreProvider({ coverage, freshness, applyUrl, completeness, cost, hadResults: rows.length > 0 });
    const license = licenseFlag(adapter.name);

    scoredRows.push({
      name: adapter.name, label: PROVIDER_META[adapter.name]?.label || adapter.name,
      scores, license,
      detail: { coverage, freshness, applyUrl, completeness, expiry, cost },
    });
  }

  console.log('\n=== Provider Evaluation Rubric ===\n');
  if (scoredRows.length) {
    console.log(formatTable(scoredRows));
  } else {
    console.log('(no providers configured — nothing to score)');
  }
  if (skipped.length) {
    console.log('\nSkipped (no API key configured):');
    skipped.forEach(s => console.log(`  - ${s.name} (set ${s.envVar} to include it)`));
  }

  for (const row of scoredRows) {
    console.log(`\n--- ${row.label} detail ---`);
    console.log(`Coverage:     ${row.detail.coverage.netNew}/${row.detail.coverage.total} net-new (${row.detail.coverage.pct.toFixed(1)}%)`);
    console.log(`Freshness:    avg lag ${row.detail.freshness.avgLagDays == null ? 'n/a (no comparable canary data)' : row.detail.freshness.avgLagDays.toFixed(1) + ' days'}`);
    console.log(`Apply-URL:    ${row.detail.applyUrl.sampled} sampled — direct-ATS ${row.detail.applyUrl.directAts}, aggregator-redirect ${row.detail.applyUrl.aggregatorRedirect}, dead ${row.detail.applyUrl.dead}; post-filter yield ${row.detail.applyUrl.postFilterYieldPct.toFixed(1)}%`);
    console.log(`Completeness: ${JSON.stringify(Object.fromEntries(Object.entries(row.detail.completeness.fillRates).map(([k, v]) => [k, v.toFixed(1) + '%'])))}`);
    console.log(`Expiry:       ${row.detail.expiry.sampled} older listings sampled, ${row.detail.expiry.stillLivePct == null ? 'n/a (no sample)' : row.detail.expiry.stillLivePct.toFixed(1) + '% still live'}`);
    console.log(`Cost:         ${row.detail.cost.costPerNetNewJobUsd == null ? row.detail.cost.note : '$' + row.detail.cost.costPerNetNewJobUsd.toFixed(3) + '/net-new job'}`);
    console.log(`License:      ${row.license.pass ? 'PASS' : 'FAIL'} — ${row.license.notes}`);
    console.log(`\nHand-verify checklist (${row.detail.completeness.handVerifySample.length} rows — read each posting and fill verifiedAccurate by hand):`);
    console.log(JSON.stringify(row.detail.completeness.handVerifySample, null, 2));
  }

  db.close();
}

main().catch(err => {
  console.error('[providerEval] Fatal error:', err);
  process.exitCode = 1;
});
