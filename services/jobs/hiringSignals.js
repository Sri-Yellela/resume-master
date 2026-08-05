/**
 * Company KB — hiring-signals rollup (Task 9.7).
 *
 * Pure, read-only aggregation of columns scraped_jobs already has (discovered_at, updated_at,
 * is_active, bucket_domain, company) into a per-company time-series snapshot. No LLM calls, no
 * per-job writes — this is the "same pipeline as technographics, aggregated temporally," not a
 * new signal source. NOT B2B buying-intent; this only ever describes hiring/team-growth
 * evidence a company's own postings already show.
 *
 * One 30-day trailing window per company per rollup run, not a 7-day AND 30-day row sharing one
 * PRIMARY KEY(company, window_end) — the literal schema can't hold two window sizes for the
 * same window_end value without colliding. A daily row per company already gives a genuine
 * time series (compare consecutive rows for trend); a second window size is a natural follow-up
 * column/table if wanted later, not silently invented here.
 */

const WINDOW_DAYS = 30;
const SECONDS_PER_DAY = 86400;

/**
 * growth_score = (new_count - expired_count) / max(1, open_count) — a normalized net-growth
 * rate. Positive = net hiring (more newly discovered than expired in the window relative to
 * current openings); negative = net shrinkage. This is EVIDENCE from what we've crawled, not
 * ground truth about the company's actual headcount plans — documented explicitly here and in
 * the API response, not implied as more certain than it is.
 */
function computeGrowthScore(newCount, expiredCount, openCount) {
  return (newCount - expiredCount) / Math.max(1, openCount);
}

/**
 * Runs one rollup pass: for every company with at least one scraped_jobs row, computes a
 * 30-day trailing snapshot and upserts company_hiring_signals. Pure aggregation — never writes
 * to scraped_jobs or any other table.
 * @param {import('better-sqlite3').Database} db
 */
function runHiringSignalsRollup(db) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - WINDOW_DAYS * SECONDS_PER_DAY;

  const companies = db.prepare(`
    SELECT DISTINCT company FROM scraped_jobs WHERE company IS NOT NULL AND company != ''
  `).all().map(r => r.company);

  const openStmt = db.prepare(`
    SELECT COUNT(*) as n FROM scraped_jobs WHERE company = ? AND is_active = 1
  `);
  const newStmt = db.prepare(`
    SELECT COUNT(*) as n FROM scraped_jobs
    WHERE company = ? AND discovered_at IS NOT NULL AND discovered_at >= ?
  `);
  // updated_at is what cacheJobs' prune logic touches when it flips is_active to 0 — the
  // existing, already-correct "when did this row become inactive" signal (see aggregator.js).
  const expiredStmt = db.prepare(`
    SELECT COUNT(*) as n FROM scraped_jobs
    WHERE company = ? AND is_active = 0 AND updated_at IS NOT NULL AND updated_at >= ?
  `);
  const domainStmt = db.prepare(`
    SELECT bucket_domain as domain, COUNT(*) as n FROM scraped_jobs
    WHERE company = ? AND is_active = 1 AND bucket_domain IS NOT NULL
    GROUP BY bucket_domain
  `);
  const upsert = db.prepare(`
    INSERT INTO company_hiring_signals
      (company, window_start, window_end, open_count, new_count, expired_count,
       domain_breakdown_json, growth_score, updated_at)
    VALUES (@company, @window_start, @window_end, @open_count, @new_count, @expired_count,
            @domain_breakdown_json, @growth_score, @updated_at)
    ON CONFLICT(company, window_end) DO UPDATE SET
      window_start          = excluded.window_start,
      open_count            = excluded.open_count,
      new_count             = excluded.new_count,
      expired_count         = excluded.expired_count,
      domain_breakdown_json = excluded.domain_breakdown_json,
      growth_score          = excluded.growth_score,
      updated_at            = excluded.updated_at
  `);

  let count = 0;
  for (const company of companies) {
    const openCount    = openStmt.get(company).n;
    const newCount     = newStmt.get(company, windowStart).n;
    const expiredCount = expiredStmt.get(company, windowStart).n;
    const domainBreakdown = {};
    for (const row of domainStmt.all(company)) domainBreakdown[row.domain] = row.n;

    upsert.run({
      company,
      window_start: windowStart,
      window_end: now,
      open_count: openCount,
      new_count: newCount,
      expired_count: expiredCount,
      domain_breakdown_json: JSON.stringify(domainBreakdown),
      growth_score: computeGrowthScore(newCount, expiredCount, openCount),
      updated_at: now,
    });
    count++;
  }

  console.log(`[hiringSignals] Rollup complete — ${count} company snapshot(s) upserted`);
  return { count };
}

/**
 * Read helper for the API. Returns the latest snapshot for a company, or (with
 * `{ history: true }`) every stored snapshot ordered oldest-to-newest.
 */
function getHiringSignals(db, company, { history = false } = {}) {
  if (history) {
    return db.prepare(`
      SELECT * FROM company_hiring_signals WHERE company = ? ORDER BY window_end ASC
    `).all(company).map(parseRow);
  }
  const row = db.prepare(`
    SELECT * FROM company_hiring_signals WHERE company = ? ORDER BY window_end DESC LIMIT 1
  `).get(company);
  return row ? parseRow(row) : null;
}

function parseRow(row) {
  let domainBreakdown = {};
  try { domainBreakdown = JSON.parse(row.domain_breakdown_json || '{}'); } catch { /* leave {} */ }
  return { ...row, domain_breakdown: domainBreakdown };
}

export { runHiringSignalsRollup, getHiringSignals, computeGrowthScore, WINDOW_DAYS };
