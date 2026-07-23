/**
 * Combines the 6 raw metrics into the weighted scored table + license pass/fail flag.
 * Pure scoring logic — no I/O here.
 */

import { RUBRIC_WEIGHTS, MAX_ACCEPTABLE_COST_PER_JOB_USD, PROVIDER_META } from './config.js';

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * @param {object} raw - { coverage, freshness, applyUrl, completeness, cost, hadResults }
 * @returns {object} per-dimension scores (0..weight) + total (0..100)
 */
function scoreProvider(raw) {
  const w = RUBRIC_WEIGHTS;

  const coverageScore = clamp((raw.coverage.pct / 100) * w.coverage, 0, w.coverage);

  // Freshness: no signal (no comparable canary data) scores a neutral half-credit rather
  // than 0, since "we don't know" isn't the same as "provider is behind". Otherwise, being
  // ahead of our own crawl (negative lag) gets full credit; lagging behind loses credit at
  // 1 point per day behind, floored at 0.
  let freshnessScore;
  if (raw.freshness.avgLagDays == null) freshnessScore = w.freshness / 2;
  else if (raw.freshness.avgLagDays <= 0) freshnessScore = w.freshness;
  else freshnessScore = clamp(w.freshness - raw.freshness.avgLagDays, 0, w.freshness);

  const applyUrlScore = clamp((raw.applyUrl.postFilterYieldPct / 100) * w.applyUrl, 0, w.applyUrl);

  const completenessValues = Object.values(raw.completeness.fillRates);
  const avgCompleteness = completenessValues.length
    ? completenessValues.reduce((a, b) => a + b, 0) / completenessValues.length
    : 0;
  const completenessScore = clamp((avgCompleteness / 100) * w.completeness, 0, w.completeness);

  let costScore;
  if (raw.cost.costPerNetNewJobUsd == null) costScore = w.cost / 2; // unknown pricing -> neutral, not a penalty or a free pass
  else costScore = clamp(w.cost * (1 - raw.cost.costPerNetNewJobUsd / MAX_ACCEPTABLE_COST_PER_JOB_USD), 0, w.cost);

  // Integration: did the adapter actually authenticate and return usable rows at all. This
  // is a coarse proxy for integration effort/reliability, not a full engineering review.
  const integrationScore = raw.hadResults ? w.integration : 0;

  const total = coverageScore + freshnessScore + applyUrlScore + completenessScore + costScore + integrationScore;

  return {
    coverage: round1(coverageScore), freshness: round1(freshnessScore),
    applyUrl: round1(applyUrlScore), completeness: round1(completenessScore),
    cost: round1(costScore), integration: round1(integrationScore),
    total: round1(total),
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function licenseFlag(providerName) {
  const meta = PROVIDER_META[providerName];
  if (!meta) return { pass: false, notes: 'No license metadata configured for this provider.' };
  return { pass: meta.consumerRedistributionAllowed === true, notes: meta.licenseNotes };
}

function formatTable(rows) {
  const headers = ['Provider', 'Coverage', 'Freshness', 'Apply-URL', 'Completeness', 'Cost', 'Integration', 'TOTAL', 'License'];
  const widths = headers.map(h => h.length);
  const dataRows = rows.map(r => [
    r.label,
    `${r.scores.coverage}/${RUBRIC_WEIGHTS.coverage}`,
    `${r.scores.freshness}/${RUBRIC_WEIGHTS.freshness}`,
    `${r.scores.applyUrl}/${RUBRIC_WEIGHTS.applyUrl}`,
    `${r.scores.completeness}/${RUBRIC_WEIGHTS.completeness}`,
    `${r.scores.cost}/${RUBRIC_WEIGHTS.cost}`,
    `${r.scores.integration}/${RUBRIC_WEIGHTS.integration}`,
    `${r.scores.total}/100`,
    r.license.pass ? 'PASS' : 'FAIL',
  ]);
  for (const row of dataRows) {
    row.forEach((cell, i) => { widths[i] = Math.max(widths[i], String(cell).length); });
  }
  const pad = (s, w) => String(s).padEnd(w);
  const sep = widths.map(w => '-'.repeat(w)).join('-+-');
  const headerLine = headers.map((h, i) => pad(h, widths[i])).join(' | ');
  const lines = [headerLine, sep, ...dataRows.map(r => r.map((c, i) => pad(c, widths[i])).join(' | '))];
  return lines.join('\n');
}

export { scoreProvider, licenseFlag, formatTable };
