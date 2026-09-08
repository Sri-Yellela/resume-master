// services/jobs/enrichmentTransfer.js
//
// U2/U3 — EXPORT THE POSTINGS THAT NEED ENRICHING, AND IMPORT ENRICHMENT BACK IN.
//
// ── WHAT THIS BUYS, STATED HONESTLY ─────────────────────────────────────────────────────────────
//
// Task U is explicit and this file will not claim otherwise: export/import does NOT save cost —
// whoever enriches externally still pays the tokens — and it does NOT reduce verification effort,
// because data crossing a trust boundary needs MORE validation, not less. Most of this file is that
// validation, which is the honest measure of what the trust boundary costs.
//
// What it does buy is CONTROL and SEPARABILITY: enrich a deliberate subset, re-import a corrected
// batch without re-running a model, and keep the door open to outsourcing the work.
//
// ── THE SHAPE: SOURCE COLUMNS AND ENRICHMENT COLUMNS ARE SEPARATED ──────────────────────────────
//
// Each JSONL line is `{ job_id, content_hash, source: {...}, enrichment: {...} }`. The split is not
// cosmetic — it is the writable surface, made obvious to whoever fills the file in. `source` is the
// posting as we scraped it (title, company, description, the feed it came from) and is READ-ONLY:
// the importer ignores it entirely. `enrichment` is the twelve columns the importer will consider.
// A flat row would leave a filler guessing which of thirty keys they are allowed to touch, and
// "guessing" plus "we then write it to the board" is the whole risk.
//
// ── content_hash IS THE STALENESS INTERLOCK, AND IT IS ON EVERY ROW ─────────────────────────────
//
// Without it, enrichment derived from text that has since changed gets applied to the new text and
// nothing anywhere records that it happened. So every exported row carries the content_hash it was
// exported at, the importer recomputes the row's CURRENT hash, and a mismatch is refused by
// default. That check is the difference between "additive" and "silently wrong".
//
// ── WHY THE IMPORTER IS ALL-OR-NOTHING ──────────────────────────────────────────────────────────
//
// A malformed batch fails as a whole, loudly, naming the offending rows, and is never partially
// applied. The alternative — apply the good rows, report the bad ones — leaves the board in a state
// no one chose and no file describes, and the only record of which half landed is a log line. With
// an all-or-nothing rule the board is always either "before this file" or "after this file", both
// of which are states someone can reason about and reproduce.
//
// ⛔ EXTERNAL DATA MUST NEVER SILENTLY CLOBBER GOOD VALUES. Enrichment nulled 120 rows from the
// INSIDE once, and from outside it is worse: there is no code to inspect afterwards, only a file
// somebody sent. Hence, by default: fill NULLs only, refuse changed hashes, reject unknown ids,
// validate every column against the same registries the pipeline uses, and never stamp enriched_at
// on a row where nothing was filled.

import {
  ENRICHMENT_COLUMNS, computeContentHash, selectCandidates, DEFAULT_MAX_LAST_SEEN_DAYS,
} from './enrichmentSelection.js';
import { EXPERIENCE_LEVELS, WORK_MODELS, valueSet } from '../../shared/jobFilterOptions.js';
import {
  openBatch, closeBatch, captureBefore, recordBatchRow, columnChanges, batchProvenanceAvailable,
} from './enrichmentBatches.js';

/** Posting fields that describe the SOURCE. Exported for context; never writable on import. */
export const SOURCE_FIELDS = [
  'title', 'company', 'location', 'url', 'description', 'source',
  'posted_at', 'discovered_at', 'scraped_at',
];

// The same two enums schema.js coerces against and enrichJob.js validates the model against, from
// the same shared table. A third copy of the experience-level vocabulary is exactly what
// shared/jobFilterOptions.js exists to prevent.
const VALID_EXPERIENCE_LEVELS = valueSet(EXPERIENCE_LEVELS);
const VALID_WORKPLACE_TYPES   = valueSet(WORK_MODELS);
const VALID_SALARY_PERIODS    = new Set(['annual', 'hourly', 'monthly']);

const INT_COLUMNS  = ['salary_min_usd', 'salary_max_usd'];
const FLAG_COLUMNS = ['is_h1b_sponsor', 'requires_work_auth', 'is_clearance_required'];
const TEXT_COLUMNS = ['summary', 'normalized_title', 'org_unit_raw'];

// ────────────────────────────────────────────────────────────────────────────────────────────────
// U2 — EXPORT
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Builds the export rows. Uses THE SAME selector as the enrichment trigger (see
 * enrichmentSelection.js), so "the export set and the enrich set can be identical" is a property of
 * the code rather than a coincidence of two similar queries.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [o]
 * @param {boolean}[o.candidatesOnly] default true — only rows that actually need enrichment
 * @param {number} [o.maxLastSeenDays] the freshness gate, same default as the trigger
 * @param {string} [o.source]          restrict to one feed
 * @param {number} [o.limit]           cap the row count
 * @param {string[]}[o.jobIds]         an explicit id list
 * @returns {{rows:object[], meta:object}}
 */
export function buildExport(db, {
  candidatesOnly = true,
  maxLastSeenDays = DEFAULT_MAX_LAST_SEEN_DAYS,
  source = null,
  limit = null,
  jobIds = null,
} = {}) {
  let picked, selectionMeta;
  if (candidatesOnly) {
    const sel = selectCandidates(db, { maxLastSeenDays, source, jobIds, limit });
    picked = sel.candidates;
    selectionMeta = {
      prefilterCount: sel.prefilterCount, totalMatched: sel.totalMatched, gatedOut: sel.gatedOut,
    };
  } else {
    // The escape hatch: export rows regardless of whether they need work — the shape a re-import
    // of CORRECTIONS needs, since a row being corrected is by definition already enriched and
    // would never appear in the candidate set.
    const where = ['is_active = 1'];
    const params = {};
    if (source) { where.push('source = @source'); params.source = source; }
    if (jobIds?.length) {
      const keys = jobIds.map((_, i) => `@jid${i}`);
      where.push(`job_id IN (${keys.join(', ')})`);
      jobIds.forEach((id, i) => { params[`jid${i}`] = id; });
    }
    picked = db.prepare(
      `SELECT * FROM scraped_jobs WHERE ${where.join(' AND ')} ORDER BY discovered_at DESC` +
      (limit != null ? ` LIMIT ${Number(limit)}` : '')
    ).all(params);
    selectionMeta = { prefilterCount: picked.length, totalMatched: picked.length, gatedOut: 0 };
  }

  const ids = picked.map(r => r.job_id);
  // The selector returns a projection, not the whole row, so re-read exactly the columns the
  // export shape needs rather than assuming which are present.
  const full = ids.length
    ? db.prepare(`SELECT job_id, content_hash, ${[...SOURCE_FIELDS, ...ENRICHMENT_COLUMNS].join(', ')}
                  FROM scraped_jobs WHERE job_id IN (${ids.map((_, i) => `@i${i}`).join(', ')})`)
        .all(Object.fromEntries(ids.map((id, i) => [`i${i}`, id])))
    : [];
  const byId = new Map(full.map(r => [r.job_id, r]));

  const rows = ids.map(id => {
    const r = byId.get(id);
    return {
      job_id: r.job_id,
      // Recomputed, not read from the column. On a never-enriched row content_hash IS NULL, and
      // exporting null would disable the staleness interlock for precisely the rows most likely to
      // be enriched externally. The hash of the text as exported is always computable, so compute it.
      content_hash: computeContentHash(r.title, r.description),
      stored_content_hash: r.content_hash ?? null,
      source: Object.fromEntries(SOURCE_FIELDS.map(f => [f, r[f] ?? null])),
      enrichment: Object.fromEntries(ENRICHMENT_COLUMNS.map(c => [c, r[c] ?? null])),
    };
  });

  return {
    rows,
    meta: {
      exportedAt: Math.floor(Date.now() / 1000),
      count: rows.length,
      candidatesOnly, maxLastSeenDays, source, limit,
      ...selectionMeta,
      writableColumns: ENRICHMENT_COLUMNS,
      readOnlyColumns: SOURCE_FIELDS,
    },
  };
}

/** Serialises to JSONL — one row per line. CSV would lose skills_json's nested shape. */
export function toJsonl({ rows, meta }, { includeMeta = true } = {}) {
  const lines = [];
  // A leading metadata line, marked so the importer can recognise and skip it. It records the
  // predicate the file was produced with, which is the only way a reader can tell later whether a
  // file is a candidate export or a correction export.
  if (includeMeta) lines.push(JSON.stringify({ _meta: meta }));
  for (const r of rows) lines.push(JSON.stringify(r));
  return lines.join('\n') + '\n';
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// U3 — IMPORT
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Parses JSONL, tolerating blank lines and the `_meta` header. Malformed JSON is a row error. */
export function parseJsonl(text) {
  const rows = [];
  const errors = [];
  let meta = null;
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); }
    catch (e) { errors.push({ line: i + 1, error: `unparseable JSON: ${e.message}` }); continue; }
    if (obj && obj._meta) { meta = obj._meta; continue; }
    rows.push({ line: i + 1, obj });
  }
  return { rows, meta, errors };
}

/**
 * Validates ONE column value. Returns `{ ok, value }` or `{ ok:false, error }`.
 *
 * `undefined` means "not supplied" and is dropped; `null` means "explicitly nothing" and is also
 * dropped, because a null carries no information and writing one is the clobber this file refuses.
 * Neither is an error — a filler leaving a column blank is the normal case.
 *
 * ⛔ ENUMS ARE CHECKED AGAINST THE REGISTRY, NOT AGAINST "IS A STRING". Free text in
 * experience_level does not fail loudly at write time — it lands in the column, the board's filter
 * silently never matches it, and the row is invisible to exactly the query it should answer.
 */
export function validateColumn(column, raw) {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };

  if (column === 'experience_level') {
    return VALID_EXPERIENCE_LEVELS.has(raw)
      ? { ok: true, value: raw }
      : { ok: false, error: `experience_level must be one of ${[...VALID_EXPERIENCE_LEVELS].join(' | ')}, got ${JSON.stringify(raw)}` };
  }
  if (column === 'workplace_type') {
    return VALID_WORKPLACE_TYPES.has(raw)
      ? { ok: true, value: raw }
      : { ok: false, error: `workplace_type must be one of ${[...VALID_WORKPLACE_TYPES].join(' | ')}, got ${JSON.stringify(raw)}` };
  }
  if (column === 'salary_period') {
    return VALID_SALARY_PERIODS.has(raw)
      ? { ok: true, value: raw }
      : { ok: false, error: `salary_period must be one of ${[...VALID_SALARY_PERIODS].join(' | ')}, got ${JSON.stringify(raw)}` };
  }
  if (INT_COLUMNS.includes(column)) {
    // Integers, and a STRING "120000" is rejected rather than coerced. Coercion here would make the
    // importer's contract "whatever JSON.parse and Number happen to agree on", which is not a
    // contract anyone can write a file against.
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
      return { ok: false, error: `${column} must be an integer number, got ${JSON.stringify(raw)}` };
    }
    if (raw < 0) return { ok: false, error: `${column} must not be negative, got ${raw}` };
    return { ok: true, value: raw };
  }
  if (FLAG_COLUMNS.includes(column)) {
    // 0/1 only — and true/false, since JSON's native booleans are what a filler will reach for.
    // Nothing else: "yes", 2 and "" are all rejected.
    if (raw === 0 || raw === 1) return { ok: true, value: raw };
    if (raw === true) return { ok: true, value: 1 };
    if (raw === false) return { ok: true, value: 0 };
    return { ok: false, error: `${column} must be 0, 1, true, false or null, got ${JSON.stringify(raw)}` };
  }
  if (column === 'skills_json') {
    // Accepts the two shapes skills_json already holds board-wide (see mapJobRow's parseSkillsList):
    // plain strings, or { skill, type } objects. Stored as a JSON string, which is what the column is.
    let arr = raw;
    if (typeof raw === 'string') {
      try { arr = JSON.parse(raw); }
      catch (e) { return { ok: false, error: `skills_json is a string but not parseable JSON: ${e.message}` }; }
    }
    if (!Array.isArray(arr)) return { ok: false, error: `skills_json must be an array, got ${typeof arr}` };
    const norm = [];
    for (const entry of arr) {
      if (typeof entry === 'string') {
        if (entry.trim()) norm.push({ skill: entry.trim(), type: 'hard' });
        continue;
      }
      if (entry && typeof entry === 'object' && typeof entry.skill === 'string' && entry.skill.trim()) {
        const type = entry.type === 'soft' ? 'soft' : 'hard';
        norm.push({ skill: entry.skill.trim(), type });
        continue;
      }
      return { ok: false, error: `skills_json entries must be strings or {skill,type} objects, got ${JSON.stringify(entry)}` };
    }
    // An empty array is "no skills", which carries no information and is dropped rather than
    // written as "[]" — a "[]" in the column reads as enriched-and-found-nothing and would keep
    // the row out of any future attempt to fill it.
    return { ok: true, value: norm.length ? JSON.stringify(norm) : undefined };
  }
  if (TEXT_COLUMNS.includes(column)) {
    if (typeof raw !== 'string') return { ok: false, error: `${column} must be a string, got ${typeof raw}` };
    const t = raw.trim();
    if (!t) return { ok: true, value: undefined };
    const cap = column === 'summary' ? 300 : column === 'org_unit_raw' ? 120 : 200;
    return { ok: true, value: t.slice(0, cap) };
  }
  return { ok: false, error: `${column} is not an importable enrichment column` };
}

/**
 * Plans an import without touching the database. THIS IS THE DRY RUN, and `applyImport` below runs
 * it first every time — so what is reported and what is applied cannot differ.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} jsonlText
 * @param {object} [o]
 * @param {boolean}[o.overwrite]      allow replacing a NON-NULL value (default false: fill nulls only)
 * @param {boolean}[o.allowStale]     allow rows whose content_hash has changed (default false)
 * @returns {object} plan
 */
export function planImport(db, jsonlText, { overwrite = false, allowStale = false } = {}) {
  const { rows, meta, errors: parseErrors } = parseJsonl(jsonlText);
  const rejected = [...parseErrors.map(e => ({ ...e, jobId: null, kind: 'parse' }))];
  const planned = [];
  let unchanged = 0;

  const findRow = db.prepare(
    `SELECT job_id, title, description, content_hash, enriched_at, ${ENRICHMENT_COLUMNS.join(', ')}
     FROM scraped_jobs WHERE job_id = ?`
  );
  const seen = new Set();

  for (const { line, obj } of rows) {
    const jobId = obj?.job_id;
    if (typeof jobId !== 'string' || !jobId) {
      rejected.push({ line, jobId: null, kind: 'no_job_id', error: 'row has no job_id' });
      continue;
    }
    // A file that names the same row twice does not have one answer for it. Which line wins would
    // be an arbitrary choice made by iteration order, so it is a rejection instead.
    if (seen.has(jobId)) {
      rejected.push({ line, jobId, kind: 'duplicate', error: `job_id appears more than once in this file` });
      continue;
    }
    seen.add(jobId);

    const current = findRow.get(jobId);
    // U3.1 — unknown job_id is REJECTED, never inserted. An import is enrichment OF THE BOARD; a
    // row we have never scraped has no description, no provenance and no source, and inserting one
    // would let a file add postings to the board through a side door built for annotations.
    if (!current) {
      rejected.push({ line, jobId, kind: 'unknown_job_id', error: 'no such job_id on the board — never inserted' });
      continue;
    }

    // U3.4 — staleness. The hash of the row's CURRENT text vs the hash the file was exported at.
    const currentHash = computeContentHash(current.title, current.description);
    const exportedHash = obj.content_hash ?? null;
    if (exportedHash == null) {
      rejected.push({ line, jobId, kind: 'no_content_hash',
        error: 'row has no content_hash — cannot tell whether the posting changed since export' });
      continue;
    }
    if (exportedHash !== currentHash && !allowStale) {
      rejected.push({ line, jobId, kind: 'stale',
        error: `posting changed since export (exported ${String(exportedHash).slice(0, 12)}, ` +
               `now ${currentHash.slice(0, 12)}) — enrichment derived from text that no longer exists` });
      continue;
    }

    const supplied = obj.enrichment && typeof obj.enrichment === 'object' ? obj.enrichment : null;
    if (!supplied) {
      rejected.push({ line, jobId, kind: 'no_enrichment', error: 'row has no `enrichment` object' });
      continue;
    }
    // Unknown keys are an error, not noise. A typo'd column name in a hand-filled file otherwise
    // means the value is silently dropped and the run reports success.
    const unknownKeys = Object.keys(supplied).filter(k => !ENRICHMENT_COLUMNS.includes(k));
    if (unknownKeys.length) {
      rejected.push({ line, jobId, kind: 'unknown_column',
        error: `unknown enrichment column(s): ${unknownKeys.join(', ')}` });
      continue;
    }

    const writes = {};
    const skippedNonNull = [];
    let rowInvalid = null;
    for (const col of ENRICHMENT_COLUMNS) {
      const v = validateColumn(col, supplied[col]);
      if (!v.ok) { rowInvalid = { column: col, error: v.error }; break; }
      if (v.value === undefined) continue;
      // U3.3 — FILL NULLS ONLY by default, matching enrichJob's own COALESCE rule. An existing
      // value is only replaced when --overwrite was passed, and the skip is REPORTED either way so
      // a filler can see their value was not taken.
      if (current[col] != null && !overwrite) { skippedNonNull.push(col); continue; }
      if (String(current[col] ?? '') === String(v.value)) { continue; }
      writes[col] = v.value;
    }
    if (rowInvalid) {
      rejected.push({ line, jobId, kind: 'invalid_value',
        error: `${rowInvalid.column}: ${rowInvalid.error}` });
      continue;
    }

    if (!Object.keys(writes).length) {
      unchanged++;
      // Not a rejection: a row with nothing to write is the correct outcome of a no-op round trip,
      // and U2's own verification is "export, change nothing, import, assert ZERO rows written".
      planned.push({ line, jobId, writes: {}, skippedNonNull, wouldWrite: false, stale: exportedHash !== currentHash });
      continue;
    }
    planned.push({
      line, jobId, writes, skippedNonNull, wouldWrite: true,
      stale: exportedHash !== currentHash,
      currentHash,
    });
  }

  // Per-column tally of what WOULD be written — the dry run's most useful line, and the thing to
  // compare against the same tally after applying.
  const perColumn = {};
  for (const p of planned) {
    for (const c of Object.keys(p.writes)) perColumn[c] = (perColumn[c] || 0) + 1;
  }

  return {
    meta,
    overwrite, allowStale,
    rowsInFile: rows.length,
    matched: planned.length,
    wouldWrite: planned.filter(p => p.wouldWrite).length,
    unchanged,
    rejected,
    perColumn,
    planned,
    // U3.2 — a malformed batch fails AS A WHOLE. This is the flag `applyImport` refuses on, and it
    // is computed here so the dry run reports the same verdict the apply would reach.
    valid: rejected.length === 0,
  };
}

/**
 * Applies an import. Runs `planImport` first and REFUSES the whole file if anything was rejected.
 *
 * All writes happen in ONE transaction, so "never partially apply" is enforced by the database
 * rather than by this function being careful. A throw mid-loop rolls back everything.
 *
 * @returns {{ok:boolean, plan:object, written?:number, batchId?:number|null, reason?:string}}
 */
export function applyImport(db, jsonlText, {
  overwrite = false, allowStale = false, force = false, notes = null,
} = {}) {
  const plan = planImport(db, jsonlText, { overwrite, allowStale });

  if (!plan.valid && !force) {
    return {
      ok: false, plan, written: 0,
      reason: `${plan.rejected.length} row(s) rejected — the whole file is refused and NOTHING was ` +
              `written. Fix the file, or pass force to apply only the rows that validate ` +
              `(deliberately awkward: a partly-applied file leaves the board in a state no file describes).`,
    };
  }

  const toWrite = plan.planned.filter(p => p.wouldWrite);
  if (!toWrite.length) {
    // Nothing to do is a SUCCESS, and reporting it as one is what makes the U2 round-trip check
    // ("export, change nothing, import, assert ZERO rows written") a passing assertion rather than
    // an error path.
    return { ok: true, plan, written: 0, batchId: null, reason: 'no row needed a write' };
  }

  // Checked as a whole — both tables AND the pointer column — for the same reason enrichJob checks
  // it: the UPDATE below names enrichment_batch_id, so "the tables exist" is not the question.
  const provenance = batchProvenanceAvailable(db);
  let batchId = null;
  if (!provenance) {
    console.warn('[enrichmentImport] batch provenance unavailable — run migration ' +
                 '101_enrichment_batches. Importing WITHOUT provenance.');
  } else {
    try {
      batchId = openBatch(db, { source: 'import', provider: 'external', model: null, notes });
    } catch (err) {
      console.warn(`[enrichmentImport] could not open an enrichment batch (${err.message}) — ` +
                   'importing WITHOUT provenance.');
    }
  }

  let written = 0;
  db.transaction(() => {
    for (const p of toWrite) {
      const before = captureBefore(db, p.jobId);
      const sets = Object.keys(p.writes).map(c => `${c} = @${c}`);
      // U3.6 — NEVER write enriched_at for a row where nothing was filled. Reached only inside
      // `toWrite`, i.e. only for rows with at least one real write, so the poisoned shape (a row
      // marked done and empty, out of the candidate set forever) cannot be produced here.
      //
      // content_hash is stamped to the hash the row's text has NOW, which the plan already verified
      // matches what the file was derived from. Skipped when --allowStale forced a mismatch
      // through: stamping then would assert this enrichment describes the current text, and the
      // operator has just acknowledged it does not.
      sets.push('enriched_at = @enriched_at');
      const params = { ...p.writes, job_id: p.jobId, enriched_at: Math.floor(Date.now() / 1000) };
      if (!p.stale) { sets.push('content_hash = @content_hash'); params.content_hash = p.currentHash; }
      if (batchId != null) { sets.push('enrichment_batch_id = @batch_id'); params.batch_id = batchId; }
      db.prepare(`UPDATE scraped_jobs SET ${sets.join(', ')} WHERE job_id = @job_id`).run(params);

      if (batchId != null) {
        const after = captureBefore(db, p.jobId);
        recordBatchRow(db, batchId, p.jobId, before, columnChanges(before, after));
      }
      written++;
    }
  })();

  if (batchId != null) {
    closeBatch(db, batchId, {
      rowsAttempted: plan.matched, rowsWritten: written,
      rowsFailed: plan.rejected.length, rowsEmpty: plan.unchanged,
      inputTokens: 0, outputTokens: 0, estCostUsd: 0,
      coverage: { perColumn: plan.perColumn, overwrite, allowStale, forced: !plan.valid },
    });
  }

  return { ok: true, plan, written, batchId };
}

/** Human-readable dry-run report. Same object the apply path consumes, so they cannot disagree. */
export function formatPlan(plan) {
  const L = [];
  L.push(`rows in file        ${plan.rowsInFile}`);
  L.push(`matched to a posting ${plan.matched}`);
  L.push(`would write          ${plan.wouldWrite}`);
  L.push(`nothing to write     ${plan.unchanged}`);
  L.push(`rejected             ${plan.rejected.length}`);
  L.push(`mode                 ${plan.overwrite ? 'OVERWRITE non-null values' : 'fill NULLs only'}` +
         `${plan.allowStale ? ', STALE ROWS ALLOWED' : ''}`);
  if (Object.keys(plan.perColumn).length) {
    L.push('');
    L.push('per column, rows that would be written:');
    for (const [c, n] of Object.entries(plan.perColumn).sort((a, b) => b[1] - a[1])) {
      L.push(`  ${c.padEnd(24)} ${n}`);
    }
  }
  const skipped = plan.planned.filter(p => p.skippedNonNull.length);
  if (skipped.length) {
    L.push('');
    L.push(`${skipped.length} row(s) had values SKIPPED because the column was already non-null ` +
           `(pass overwrite to replace):`);
    for (const p of skipped.slice(0, 10)) L.push(`  ${p.jobId}: ${p.skippedNonNull.join(', ')}`);
    if (skipped.length > 10) L.push(`  ... and ${skipped.length - 10} more`);
  }
  if (plan.rejected.length) {
    L.push('');
    L.push('REJECTED ROWS — the whole file is refused unless these are fixed:');
    for (const r of plan.rejected.slice(0, 25)) {
      L.push(`  line ${r.line}${r.jobId ? ` (${r.jobId})` : ''} [${r.kind}]: ${r.error}`);
    }
    if (plan.rejected.length > 25) L.push(`  ... and ${plan.rejected.length - 25} more`);
  }
  L.push('');
  L.push(plan.valid ? 'VALID — this file can be applied.' : 'INVALID — nothing would be written.');
  return L.join('\n');
}
