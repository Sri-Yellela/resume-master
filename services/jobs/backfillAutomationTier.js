/**
 * Recompute path for scraped_jobs.automation_tier.
 *
 * A stored derived value goes stale silently — that is exactly how enrichment ended up with 120
 * rows marked done and empty. automation_tier is derived from a mapping
 * (services/jobs/automationTier.js) that will change whenever a provider is onboarded or a
 * provider changes what it demands of an applicant, and nothing about a row's own data changes
 * when that happens. So there has to be a way to re-derive every row on demand, and it has to go
 * through the same function the writers use.
 *
 * Two entry points, one implementation:
 *   - server.js calls this at boot with the default (NULL-only) mode, so migration 078's newly
 *     added column is populated on the very next start rather than waiting for a re-crawl. It is
 *     a no-op once every row has a tier.
 *   - scripts/recomputeAutomationTier.js calls it with { all: true } — the documented admin
 *     action for when the mapping itself changed and existing non-NULL values are now wrong.
 *
 * Reads apply_url ?? url, matching what every writer passes to deriveAutomationTier() and what
 * mapJobRow exposes as applyUrl: only the LinkedIn scrape writer populates apply_url; every other
 * writer leaves it null and carries the apply destination in url.
 */
"use strict";

import { deriveAutomationTier } from "./automationTier.js";

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ all?: boolean }} [opts]  all:true re-derives every row; default touches only rows
 *                                    whose automation_tier IS NULL.
 * @returns {{ scanned: number, updated: number, byTier: Record<string, number> }}
 */
function backfillAutomationTier(db, { all = false } = {}) {
  const where = all ? "" : "WHERE automation_tier IS NULL";
  const rows = db.prepare(`
    SELECT job_id, source, apply_url, url, automation_tier
    FROM scraped_jobs
    ${where}
  `).all();

  const update = db.prepare("UPDATE scraped_jobs SET automation_tier = ? WHERE job_id = ?");
  const byTier = {};
  let updated = 0;

  // One transaction: a half-applied recompute would leave the board filtering against a mixture
  // of two mappings, which is harder to notice than a failure.
  const run = db.transaction(() => {
    for (const r of rows) {
      const tier = deriveAutomationTier(r.source, r.apply_url || r.url);
      byTier[tier] = (byTier[tier] || 0) + 1;
      if (r.automation_tier === tier) continue; // already correct — no write, no churn
      update.run(tier, r.job_id);
      updated++;
    }
  });
  run();

  return { scanned: rows.length, updated, byTier };
}

export { backfillAutomationTier };
