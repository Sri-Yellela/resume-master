/**
 * Per-run outcome log for the ingestion pipeline (migration 069, `pipeline_runs`).
 *
 * Exists because the pipeline had no way to say "I did nothing". Every failure diagnosed in
 * docs/PIPELINE_DIAGNOSIS.md logged like success: an unconfigured provider, a hard HTTP 402, a
 * source silently returning zero jobs, and an enrichment pass that wrote NULL over good data
 * all produced the same cheerful "0 jobs cached" line. Row counts in scraped_jobs cannot
 * distinguish those cases after the fact — only a record written AT run time can, which is what
 * this table is for.
 *
 * Two grains, both keyed by `run_kind`:
 *   'source_sync' — one row per SOURCE per crawl (not one per crawl), so a single source going
 *                   quiet is visible even while the others succeed. Ashby stopped writing on
 *                   2026-08-07 while greenhouse kept going, and nothing surfaced it.
 *   'enrichment'  — one row per background enrichment pass.
 *
 * Deliberately fire-and-forget: observability must never be able to break ingestion, so a
 * failure to record (including the table not existing yet, pre-migration) is warned about and
 * swallowed rather than thrown.
 */

const VALID_STATUSES = new Set(['ok', 'failed', 'skipped_unconfigured', 'no_results']);

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} run
 * @param {'source_sync'|'enrichment'} run.runKind
 * @param {string|null} [run.source] source name; null for enrichment passes
 * @param {'ok'|'failed'|'skipped_unconfigured'|'no_results'} run.status
 * @param {number} run.startedAt unix epoch seconds
 * @param {string|null} [run.errorText]
 * @param {object} [run.details] arbitrary extra context, stored as JSON
 */
function recordPipelineRun(db, {
  runKind, source = null, status, startedAt,
  fetched = 0, written = 0, unchanged = 0, merged = 0, dropped = 0,
  ejected = 0, failed = 0, skipped = 0, expired = 0,
  errorText = null, details = null,
} = {}) {
  try {
    if (!VALID_STATUSES.has(status)) {
      // A typo'd status would silently create a category the monitor never renders, which is
      // the same class of invisible failure this table exists to catch.
      console.warn(`[pipelineRunLog] Unknown status "${status}" for ${runKind}/${source} — recording anyway`);
    }
    const finishedAt = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO pipeline_runs (
        run_kind, source, status, started_at, finished_at, duration_ms,
        fetched, written, unchanged, merged, dropped, ejected, failed, skipped, expired,
        error_text, details_json
      ) VALUES (
        @run_kind, @source, @status, @started_at, @finished_at, @duration_ms,
        @fetched, @written, @unchanged, @merged, @dropped, @ejected, @failed, @skipped, @expired,
        @error_text, @details_json
      )
    `).run({
      run_kind:     runKind,
      source,
      status,
      started_at:   startedAt,
      finished_at:  finishedAt,
      duration_ms:  Math.max(0, (finishedAt - startedAt) * 1000),
      fetched, written, unchanged, merged, dropped, ejected, failed, skipped, expired,
      error_text:   errorText ? String(errorText).slice(0, 500) : null,
      details_json: details ? JSON.stringify(details) : null,
    });
  } catch (err) {
    console.warn('[pipelineRunLog] Could not record run (non-fatal):', err.message);
  }
}

export { recordPipelineRun, VALID_STATUSES };
