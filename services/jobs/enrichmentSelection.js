// services/jobs/enrichmentSelection.js
//
// WHO IS A CANDIDATE FOR ENRICHMENT, AND WHAT WOULD IT COST — decided in ONE place.
//
// ── WHY THIS IS A MODULE AND NOT THREE QUERIES ─────────────────────────────────────────────────
//
// Task U needs the same row set in four places: the background pass, the manual trigger's dry run,
// the manual trigger's real run, and the export ("filterable by the same predicates the trigger
// uses, so the export set and the enrich set can be identical"). Before this file existed there
// were already TWO copies of the predicate — one in enrichJob.js and one in scripts/runEnrichment.mjs
// — and this codebase's entire bug history is two sides, each self-consistent, joined to nothing.
// A dry run that prices a different set than the run sends is that bug with a dollar sign on it.
//
// So the predicate lives here once, and everything that needs it calls in.
//
// ── THE PRE-FILTER IS NOT THE CANDIDATE SET, AND THE GAP IS 250x ────────────────────────────────
//
// Selection is inherently two-step and must stay that way. The SQL limb
// `updated_at > enriched_at` is a deliberate SUPERSET of "the text actually changed" — it also
// catches a row merely re-touched with identical content — so the exact content-hash comparison
// afterwards is what makes the answer true. Measured on the restored local board (task U1.1,
// scripts/am4EnrichBacklogAudit.mjs):
//
//     SQL pre-filter                        1252 rows
//     after the content-hash comparison        5 rows      <- 250x over-count
//
// because task S's restore stamped ONE bulk `updated_at` (1787558402) onto 1247 rows whose title
// and description never changed. A cost estimate built on the pre-filter would have quoted ~$2.10
// to send nothing at all. `selectCandidates` below always applies both steps; there is no option
// to skip the second, on purpose.
//
// ── THE FRESHNESS GATE, AND WHY IT KEYS ON scraped_at ───────────────────────────────────────────
//
// Task U asked for an age condition and warned that "the restored board's rows were REBASED and all
// expire together ~7 days from the restore, so a naive age gate will behave strangely on this
// dataset. Measure real discovered_at values." Both halves of that warning are load-bearing, and
// the measurement changed the design:
//
//   discovered_at is WHEN THE ROW FIRST ARRIVED. On production's 837-row backlog, 809 of 837
//   (96.7%) are 14-60 days old by that column.
//
//   scraped_at is WHEN THE POSTING WAS LAST SEEN — services/jobs/aggregator.js:319 re-stamps it on
//   every re-sight. On the same 837 rows, 832 were last seen within 24 hours and all 837 within
//   three days.
//
// Those describe the same rows and disagree completely, and only one of them is what "stale" means.
// A posting the crawler re-sighted this morning is LIVE — it is old only in the sense that the
// employer has kept it open for a month. Gating on discovered_at would have refused 809 live
// postings as stale; that was the expected outcome when task U was written, and it is wrong.
//
// So the gate keys on `scraped_at`, and the default horizon is the SAME seven days as
// runExpiredJobsCleanup's cutoff (server.js: `now - 7*24*60*60`, also on scraped_at). That makes
// the rule say something defensible rather than arbitrary: **never spend a token on a row the very
// next cleanup pass would delete.** A row not re-sighted in seven days is not a fresh posting, it
// is a row awaiting expiry, and enriching it buys an artifact with a one-day life.
//
// ⛔ THE TWO SEVENS MUST MOVE TOGETHER. If server.js's expiry horizon changes and this does not,
// the gate stops meaning "will survive the next pass" and quietly becomes an arbitrary age filter.
// test/enrichmentFreshnessGate.test.js pins them to each other for exactly that reason.
//
// Consequence worth stating plainly, because it looks like the gate does nothing: on BOTH databases
// measured today the gate admits every candidate (local 5/5, production 837/837). That is the
// correct result and not a no-op — the gate is a floor against a board that has stopped refilling,
// which is precisely the condition that produced cleanup_log id 85.

import crypto from 'crypto';

/**
 * Days since a posting was LAST SEEN (`scraped_at`) beyond which it is not worth enriching.
 * Deliberately equal to runExpiredJobsCleanup's 7-day expiry horizon — see the header.
 */
export const DEFAULT_MAX_LAST_SEEN_DAYS = 7;

/** The columns enrichment writes. Coverage is reported per column, never as one total. */
export const ENRICHMENT_COLUMNS = [
  'summary', 'normalized_title', 'experience_level', 'workplace_type',
  'salary_min_usd', 'salary_max_usd', 'salary_period', 'skills_json',
  'is_h1b_sponsor', 'requires_work_auth', 'is_clearance_required', 'org_unit_raw',
];

// Haiku 4.5 list pricing, for estimates and run summaries only — never billed or persisted.
export const USD_PER_INPUT_MTOK = 1.0;
export const USD_PER_OUTPUT_MTOK = 5.0;
// buildPrompt slices the description at 4000 chars and the call caps output at 500 tokens; both
// bounds are what make the estimate a CEILING rather than a guess.
export const PROMPT_DESC_CHAR_CAP = 4000;
export const MAX_OUTPUT_TOKENS = 500;

/** sha1 of title|description — the "has this posting's text changed?" fingerprint. */
export function computeContentHash(title, description) {
  return crypto.createHash('sha1').update(`${title || ''}|${description || ''}`).digest('hex');
}

const envNum = (name, dflt, env) => {
  const n = Number.parseFloat((env ?? process.env)[name] ?? '');
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

/** Reads the knobs from the environment so callers do not have to restate the defaults. */
export function enrichSelectionOptions(env = process.env) {
  return { maxLastSeenDays: envNum('ENRICH_MAX_LAST_SEEN_DAYS', DEFAULT_MAX_LAST_SEEN_DAYS, env) };
}

/**
 * Selects the rows enrichment would act on, applying BOTH steps: the SQL pre-filter and the exact
 * content-hash comparison. Read-only.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object}  [o]
 * @param {number}  [o.maxLastSeenDays]  freshness horizon on scraped_at; 0/Infinity disables it
 * @param {string}  [o.source]           restrict to one feed ('greenhouse', 'ashby', ...)
 * @param {string[]}[o.jobIds]           restrict to an explicit id list (the import/export unit)
 * @param {number}  [o.limit]            cap the returned rows (applied AFTER the hash check, so a
 *                                       limit can never be filled with rows that need no work)
 * @param {number}  [o.now]              epoch seconds, injectable for tests
 * @returns {{candidates:object[], prefilterCount:number, gatedOut:number, noDescription:number}}
 */
export function selectCandidates(db, {
  maxLastSeenDays = DEFAULT_MAX_LAST_SEEN_DAYS,
  source = null,
  jobIds = null,
  limit = null,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  const where = [
    'is_active = 1',
    "description IS NOT NULL AND TRIM(description) != ''",
    '(enriched_at IS NULL OR content_hash IS NULL OR updated_at > enriched_at)',
  ];
  const params = {};

  // 0 or a non-finite horizon means "no gate" — an operator who wants the whole backlog regardless
  // of liveness can say so, and that is then a deliberate act rather than a default.
  const gated = Number.isFinite(maxLastSeenDays) && maxLastSeenDays > 0;
  if (gated) {
    // NULL scraped_at is treated as UNGATED (kept), not as infinitely old. A row that has never
    // recorded a sighting is a row the aggregator has not touched, not a row known to be stale, and
    // `NULL < cutoff` is NULL in SQL anyway — so being explicit here documents the choice instead
    // of letting three-valued logic make it silently.
    where.push('(scraped_at IS NULL OR scraped_at >= @lastSeenCutoff)');
    params.lastSeenCutoff = now - Math.round(maxLastSeenDays * 86400);
  }
  if (source) { where.push('source = @source'); params.source = source; }
  if (jobIds?.length) {
    // Inlined rather than bound because better-sqlite3 has no array parameter. The values are
    // quoted through the driver's own escaping by passing them as numbered params instead.
    const keys = jobIds.map((_, i) => `@jid${i}`);
    where.push(`job_id IN (${keys.join(', ')})`);
    jobIds.forEach((id, i) => { params[`jid${i}`] = id; });
  }

  const prefiltered = db.prepare(`
    SELECT job_id, title, company, description, content_hash, source,
           enriched_at, updated_at, discovered_at, posted_at, scraped_at
    FROM scraped_jobs
    WHERE ${where.join(' AND ')}
    ORDER BY discovered_at DESC
  `).all(params);

  // Step two, and the reason the counts above are not the answer.
  const matched = prefiltered.filter(r => computeContentHash(r.title, r.description) !== r.content_hash);

  // What the gate actually excluded, measured the same way — the identical query minus the gate —
  // so "the gate refused N rows" is a number rather than a claim.
  let gatedOut = 0;
  if (gated) {
    const ungated = selectCandidates(db, {
      maxLastSeenDays: 0, source, jobIds, limit: null, now,
    });
    gatedOut = ungated.candidates.length - matched.length;
  }

  const noDescription = db.prepare(`
    SELECT COUNT(*) n FROM scraped_jobs
    WHERE is_active = 1 AND (description IS NULL OR TRIM(description) = '')
  `).get().n;

  return {
    candidates: limit != null ? matched.slice(0, limit) : matched,
    totalMatched: matched.length,
    prefilterCount: prefiltered.length,
    gatedOut,
    noDescription,
  };
}

/**
 * Ceiling cost of enriching these rows. Input is priced from the real description lengths (capped
 * exactly where buildPrompt caps them); output is priced at the max_tokens cap, so the number is an
 * upper bound and is labelled as one everywhere it is printed.
 */
export function estimateCost(rows) {
  const chars = rows.reduce((s, r) => s + Math.min(r.description?.length || 0, PROMPT_DESC_CHAR_CAP), 0);
  const inputTokens = Math.round(chars / 4);          // ~4 chars/token
  const outputTokens = rows.length * MAX_OUTPUT_TOKENS;
  return {
    rows: rows.length,
    inputTokens,
    outputTokens,
    usd: Number(((inputTokens / 1e6) * USD_PER_INPUT_MTOK
               + (outputTokens / 1e6) * USD_PER_OUTPUT_MTOK).toFixed(4)),
  };
}

/**
 * Per-column fill rates. THIS IS WHAT "IT WORKED" HAS TO MEAN.
 *
 * Task A2 found a model returning HTTP 200, success:true, a clean usage row and a NULL extraction
 * 49 times in 50. A run that reports `enriched: 837` is compatible with all 837 being that. So
 * every run reports how many rows actually carry a value in each column, and a caller comparing a
 * before to an after can see whether coverage CLIMBED.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [o]
 * @param {string[]} [o.jobIds] scope to specific rows (a batch); omit for all active rows
 */
export function columnCoverage(db, { jobIds = null } = {}) {
  const params = {};
  let where = 'is_active = 1';
  if (jobIds?.length) {
    const keys = jobIds.map((_, i) => `@jid${i}`);
    where = `job_id IN (${keys.join(', ')})`;
    jobIds.forEach((id, i) => { params[`jid${i}`] = id; });
  }
  const select = ENRICHMENT_COLUMNS.map(c => `SUM(${c} IS NOT NULL) ${c}`).join(', ');
  const row = db.prepare(
    `SELECT COUNT(*) n, ${select}, SUM(enriched_at IS NOT NULL) enriched_at FROM scraped_jobs WHERE ${where}`
  ).get(params);

  const total = row.n || 0;
  const columns = {};
  for (const c of [...ENRICHMENT_COLUMNS, 'enriched_at']) {
    columns[c] = { filled: row[c] || 0, total, rate: total ? Number(((row[c] || 0) / total).toFixed(4)) : 0 };
  }
  return { total, columns };
}

/**
 * Formats two coverage snapshots side by side and says whether coverage climbed.
 *
 * ⛔ THE VISA COLUMNS ARE EXPECTED AT OR NEAR ZERO AND THAT IS NOT A FAILURE. Of 1261 descriptions,
 * ZERO contain "H-1B"/"H1B" and 36 mention sponsorship at all; the prompt correctly answers null
 * when a posting is silent. See test/visaSignalCoverage.test.js. They are excluded from the
 * climbed/regressed verdict below because a signal absent from the source material cannot be
 * evidence about the pipeline either way — but they are still PRINTED, so the claim stays checkable.
 */
export const SOURCE_SILENT_COLUMNS = ['is_h1b_sponsor', 'requires_work_auth', 'is_clearance_required'];

export function diffCoverage(before, after) {
  const rows = [];
  let climbed = 0, regressed = 0;
  for (const c of [...ENRICHMENT_COLUMNS, 'enriched_at']) {
    const b = before.columns[c]?.filled ?? 0;
    const a = after.columns[c]?.filled ?? 0;
    rows.push({ column: c, before: b, after: a, delta: a - b, sourceSilent: SOURCE_SILENT_COLUMNS.includes(c) });
    if (SOURCE_SILENT_COLUMNS.includes(c) || c === 'enriched_at') continue;
    if (a > b) climbed++;
    if (a < b) regressed++;
  }
  return { rows, climbed, regressed };
}
