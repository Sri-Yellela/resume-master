// services/jobs/enrichmentBatches.js
//
// U4 — WHICH RUN WROTE THIS ROW, WHAT IT COST, AND HOW TO UNDO IT.
//
// Enrichment had no provenance at all: a column either had a value or it did not, and there was no
// way to ask which pass put it there, what that pass cost, or whether a given pass was any good.
// That is exactly the position task A2 was in when it found a model returning HTTP 200 with a NULL
// extraction 49 times in 50 — the rows looked enriched and the run looked successful.
//
// ── THE CHEAP SHAPE, AND WHY ────────────────────────────────────────────────────────────────────
//
// The enrichment columns STAY ON scraped_jobs. Migration 101 adds `scraped_jobs.enrichment_batch_id`
// and two tables beside it; it does NOT move data. mapJobRow.js is untouched, so the board response,
// the mobile contract, the ATS scorer and the KB rollups all read exactly what they read before.
// See the migration's own comment for the cost of the full split.
//
// ── WHY THERE IS A BEFORE-IMAGE TABLE ───────────────────────────────────────────────────────────
//
// "Revert a bad batch" cannot be implemented as "null the enrichment columns on every row this
// batch touched", and the reason is the COALESCE rule enrichJob.js relies on. Enrichment only ever
// fills columns that were NULL — ingestion has already populated normalized_title, experience_level,
// workplace_type and the salary fields on many rows from the source feed. After the fact, a
// non-null column is indistinguishable between "this batch wrote it" and "it arrived that way",
// so blanket-nulling would delete ingestion data the batch never touched.
//
// That is the same defect, pointed the other way, as the one that nulled 120 rows from the inside.
// So each row's prior values are recorded BEFORE the write, and a revert restores them verbatim.
// A revert is therefore exact and is itself non-destructive.
//
// enriched_at and content_hash are part of the before-image too, deliberately: restoring them is
// what puts a reverted row back in the candidate set. Reverting the values but leaving the row
// stamped as enriched would produce the poisoned shape task U warns about — a row marked done and
// empty, out of the candidate set forever.

import { ENRICHMENT_COLUMNS } from './enrichmentSelection.js';

/** The columns a revert has to restore: everything enrichment writes, plus its two stamps. */
export const BATCH_TRACKED_COLUMNS = [...ENRICHMENT_COLUMNS, 'enriched_at', 'content_hash'];

/** Valid batch sources. `source` answers "what triggered this?", which is the first thing asked. */
export const BATCH_SOURCES = ['cron', 'manual', 'import'];

/**
 * Whether this database can record provenance at all — both tables AND the pointer column.
 *
 * ⛔ ALL THREE, NOT JUST THE TABLES. Checking only for `enrichment_batches` is not enough: the
 * caller's UPDATE also names `scraped_jobs.enrichment_batch_id`, so a database with the tables but
 * not the column, or vice versa, fails at write time with a bare SQLITE_ERROR. That is exactly what
 * happened — enrichment was written to "degrade gracefully" when provenance was unavailable, the
 * openBatch call duly warned and continued, and then the UPDATE threw anyway on the missing column.
 * A degradation path that is not itself checked is a claim, not a behaviour.
 */
export function batchProvenanceAvailable(db) {
  try {
    const tables = db.prepare(
      `SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table'
         AND name IN ('enrichment_batches', 'enrichment_batch_rows')`
    ).get().n;
    if (tables < 2) return false;
    return db.prepare(`SELECT COUNT(*) n FROM pragma_table_info('scraped_jobs')
                       WHERE name = 'enrichment_batch_id'`).get().n === 1;
  } catch {
    return false;
  }
}

/**
 * Opens a batch and returns its id. Called before the first row is written, so a crash mid-batch
 * still leaves a row in enrichment_batches with a started_at and no finished_at — which is a
 * readable state ("this run died") rather than an absence.
 */
export function openBatch(db, { source, provider = null, model = null, notes = null } = {}) {
  if (!BATCH_SOURCES.includes(source)) {
    throw new Error(`enrichmentBatches: source must be one of ${BATCH_SOURCES.join(' | ')}, got ${source}`);
  }
  const info = db.prepare(`
    INSERT INTO enrichment_batches (source, provider, model, started_at, notes)
    VALUES (@source, @provider, @model, @started_at, @notes)
  `).run({ source, provider, model, started_at: Math.floor(Date.now() / 1000), notes });
  return Number(info.lastInsertRowid);
}

/** Reads the tracked columns for one row, for the before-image. Returns null if the row is gone. */
export function captureBefore(db, jobId) {
  return db.prepare(
    `SELECT ${BATCH_TRACKED_COLUMNS.join(', ')} FROM scraped_jobs WHERE job_id = ?`
  ).get(jobId) ?? null;
}

/**
 * Records what `batchId` did to `jobId`, keeping `before` verbatim for revert.
 * `changes` is `{ filled, corrected }` from columnChanges() — what actually changed, not what was
 * attempted — so the batch's own record cannot overstate what it did.
 */
export function recordBatchRow(db, batchId, jobId, before, changes) {
  db.prepare(`
    INSERT INTO enrichment_batch_rows (batch_id, job_id, before_json, filled_json, written_at)
    VALUES (@batch_id, @job_id, @before_json, @filled_json, @written_at)
    ON CONFLICT(batch_id, job_id) DO UPDATE SET
      filled_json = @filled_json, written_at = @written_at
  `).run({
    batch_id: batchId, job_id: jobId,
    before_json: JSON.stringify(before ?? null),
    filled_json: JSON.stringify(changes ?? { filled: [], corrected: [] }),
    written_at: Math.floor(Date.now() / 1000),
  });
}

/**
 * How the row changed, split into the two kinds of change that are NOT interchangeable.
 *
 *   filled    — was NULL, now has a value. This is what moves a per-column fill rate, and it is
 *               what "coverage climbed" means.
 *   corrected — had a value, now has a DIFFERENT one. Enrichment is additive via COALESCE but a
 *               non-null extraction is still allowed to replace a non-null value, so this happens.
 *
 * They are recorded separately because collapsing them makes both unreadable: a pass that only
 * corrected values shows a flat fill rate and looks like the A2 empty-extraction failure, while a
 * pass counted as "changed 25 columns" hides whether any of it was new information.
 */
export function columnChanges(before, after) {
  const filled = [], corrected = [];
  for (const c of ENRICHMENT_COLUMNS) {
    const b = before?.[c] ?? null, a = after?.[c] ?? null;
    if (b == null && a != null) filled.push(c);
    else if (b != null && a != null && b !== a) corrected.push(c);
  }
  return { filled, corrected };
}

/** Closes the batch with its counts, tokens, cost and the coverage snapshot behind them. */
export function closeBatch(db, batchId, {
  rowsAttempted = 0, rowsWritten = 0, rowsFailed = 0, rowsEmpty = 0,
  inputTokens = 0, outputTokens = 0, estCostUsd = 0, coverage = null,
} = {}) {
  db.prepare(`
    UPDATE enrichment_batches SET
      finished_at = @finished_at, rows_attempted = @rows_attempted, rows_written = @rows_written,
      rows_failed = @rows_failed, rows_empty = @rows_empty, input_tokens = @input_tokens,
      output_tokens = @output_tokens, est_cost_usd = @est_cost_usd, coverage_json = @coverage_json
    WHERE id = @id
  `).run({
    id: batchId, finished_at: Math.floor(Date.now() / 1000),
    rows_attempted: rowsAttempted, rows_written: rowsWritten,
    rows_failed: rowsFailed, rows_empty: rowsEmpty,
    input_tokens: inputTokens, output_tokens: outputTokens,
    est_cost_usd: Number(estCostUsd) || 0,
    coverage_json: coverage ? JSON.stringify(coverage) : null,
  });
}

/**
 * Restores every row this batch wrote to its recorded prior state, in ONE transaction.
 *
 * Restores the tracked columns verbatim — including enriched_at and content_hash, so the rows go
 * back into the candidate set — and clears enrichment_batch_id. The before-image rows are KEPT and
 * the batch is stamped `reverted_at` rather than deleted: the record of what happened is the point,
 * and a revert that erases its own evidence is the same mistake as a delete that erases the text.
 *
 * Idempotent: reverting an already-reverted batch is a no-op and says so.
 */
export function revertBatch(db, batchId) {
  const batch = db.prepare('SELECT * FROM enrichment_batches WHERE id = ?').get(batchId);
  if (!batch) return { ok: false, reason: `no batch ${batchId}`, restored: 0 };
  if (batch.reverted_at) {
    return { ok: false, reason: `batch ${batchId} was already reverted at ${batch.reverted_at}`, restored: 0 };
  }
  const rows = db.prepare('SELECT job_id, before_json FROM enrichment_batch_rows WHERE batch_id = ?').all(batchId);
  if (!rows.length) return { ok: false, reason: `batch ${batchId} has no recorded rows to restore`, restored: 0 };

  const sets = BATCH_TRACKED_COLUMNS.map(c => `${c} = @${c}`).join(', ');
  const restore = db.prepare(
    `UPDATE scraped_jobs SET ${sets}, enrichment_batch_id = NULL WHERE job_id = @job_id`
  );
  let restored = 0, missing = 0;
  db.transaction(() => {
    for (const r of rows) {
      const before = JSON.parse(r.before_json || 'null');
      // A row deleted since the batch ran cannot be restored, and inventing one would be worse
      // than reporting it. Counted, not silently skipped.
      if (!before) { missing++; continue; }
      const params = { job_id: r.job_id };
      for (const c of BATCH_TRACKED_COLUMNS) params[c] = before[c] ?? null;
      restored += restore.run(params).changes;
    }
    db.prepare('UPDATE enrichment_batches SET reverted_at = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000), batchId);
  })();
  return { ok: true, restored, missing, rowsRecorded: rows.length };
}

/** Recent batches, newest first — the provenance view. */
export function listBatches(db, { limit = 20 } = {}) {
  return db.prepare(`
    SELECT b.*, (SELECT COUNT(*) FROM enrichment_batch_rows r WHERE r.batch_id = b.id) recorded_rows
    FROM enrichment_batches b ORDER BY b.started_at DESC, b.id DESC LIMIT ?
  `).all(limit);
}

/** One batch with its rows — what it touched and what it filled. */
export function getBatch(db, batchId) {
  const batch = db.prepare('SELECT * FROM enrichment_batches WHERE id = ?').get(batchId);
  if (!batch) return null;
  const rows = db.prepare(
    'SELECT job_id, filled_json, written_at FROM enrichment_batch_rows WHERE batch_id = ? ORDER BY written_at'
  ).all(batchId).map(r => {
    // filled_json holds { filled, corrected }. Tolerate the bare array an earlier shape wrote so a
    // batch recorded before columnChanges() existed still reads rather than throwing.
    const parsed = JSON.parse(r.filled_json || '{}');
    const changes = Array.isArray(parsed) ? { filled: parsed, corrected: [] } : parsed;
    return {
      jobId: r.job_id,
      filled: changes.filled ?? [],
      corrected: changes.corrected ?? [],
      writtenAt: r.written_at,
    };
  });
  return {
    ...batch,
    coverage: batch.coverage_json ? JSON.parse(batch.coverage_json) : null,
    rows,
  };
}
