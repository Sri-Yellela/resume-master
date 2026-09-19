/**
 * Background job-description enrichment pass.
 *
 * Fills the Task-1 columns (summary, normalized_title, experience_level, workplace_type,
 * skills_json, salary_*_usd/salary_period, is_h1b_sponsor/requires_work_auth/
 * is_clearance_required) from an LLM read of the actual posting text, and rolls extracted
 * skills up into company_technographics with time-weighted accumulation + decay.
 *
 * Cheap and idempotent: only rows whose content_hash doesn't match their current
 * title+description get enriched, and content_hash/enriched_at are only persisted on
 * success — a crash mid-batch just leaves those rows candidates again next run, it never
 * re-charges a row that already completed. Reuses the classifier.js Anthropic-client
 * pattern (client passed in, not constructed here) and its Haiku model.
 *
 * COVERAGE REALITY, measured after a full backfill of all 1261 active rows (2026-08-22, 0 failed):
 *
 *     skills_json       100 -> 1259    org_unit_raw      52 -> 1091    workplace_type  542 -> 859
 *     salary_min_usd    572 ->  594    enriched_at      101 -> 1261
 *     is_h1b_sponsor      0 ->    3 non-null, and ALL THREE ARE FALSE
 *
 * The visa columns are near-empty because the POSTINGS DO NOT SAY, not because this pass fails: of
 * 1261 descriptions (avg 4.3-5.0k chars, none missing), 0 contain "H-1B"/"H1B" and 36 mention
 * sponsorship/visa/work-authorization at all. The prompt below is deliberately strict — null unless
 * the posting explicitly states a policy — so silence yields null, correctly, 1258 times.
 *
 * Consequence, so it is not rediscovered by re-running this: "Sponsors H-1B" can never render from
 * crawled JD text on this pool. That badge needs a different SOURCE (an employer H-1B filing dataset
 * keyed by company), not another LLM pass over the same words. See test/visaSignalCoverage.test.js.
 *
 * ADDITIVE ONLY. Every column is written via COALESCE(@new, existing), because ingestion has
 * already populated several of these from the source feed and the prompt deliberately tells the
 * model to answer null when a posting is silent. Combining those two facts with a plain
 * assignment meant a normal, correct extraction erased good ingestion data — and because the
 * success path also stamps content_hash, the row left the candidate set for good. Two guards
 * now bound that: COALESCE (a null can never overwrite) and hasAnySignal (an all-null
 * extraction is treated as a failure, so the row is not stamped and stays a candidate).
 */

import { recordPipelineRun } from './pipelineRunLog.js';
// U1 — candidate selection, the freshness gate, cost estimation and coverage all live in one
// module now, because the dry run, the real run and the export must not be able to disagree about
// which rows they mean. computeContentHash moved there with them and is re-exported below, so
// existing importers (scripts/runEnrichment.mjs) are unaffected.
import {
  selectCandidates, computeContentHash, columnCoverage,
  enrichSelectionOptions, ENRICHMENT_COLUMNS,
} from './enrichmentSelection.js';
// Y2A — the description fetch, folded into this pass so there is ONE spend budget rather than one
// here and one in the crawl. detailFetch.js's header explains why this is the right seam; the
// short version is that content_hash = sha1(title|description), so a description arriving there
// makes the row a candidate HERE with no new selector logic at all.
import { fillMissingDescriptions } from './detailFetch.js';
// U4 — provenance. Additive: no read path changes, mapJobRow is untouched.
import {
  openBatch, closeBatch, captureBefore, recordBatchRow, columnChanges, batchProvenanceAvailable,
} from './enrichmentBatches.js';
import { MODEL_HAIKU } from '../../shared/anthropicModels.js';
import { callModel, SYSTEM_USER_ID } from '../modelCall.js';
// resolveProvider is imported for PROVENANCE only — it is the transport's own routing decision, so
// the batch record can name the model that will actually serve the calls. It does not route here.
import { DATA_CLASS, resolveProvider } from '../../shared/modelProviders.js';
// G3 — the same canonical key the stack surface merges on. One vocabulary, used twice.
import { canonicalSkillKey } from '../kb/technographics.js';
import { loadConfirmedSynonyms } from '../kb/skillSynonyms.js';
import { EXPERIENCE_LEVELS, WORK_MODELS, valueSet } from '../../shared/jobFilterOptions.js';

// Model IDs come from shared/anthropicModels.js so a bump cannot land in only some files.
const MODEL_ID = MODEL_HAIKU;

// Same two enums schema.js coerces against, from the same shared table — this was the second of
// four copies of the experience-level vocabulary. shared/jobFilterOptions.js explains why that
// mattered: nothing checked the copies against each other.
const VALID_EXPERIENCE_LEVELS = valueSet(EXPERIENCE_LEVELS);
const VALID_WORKPLACE_TYPES   = valueSet(WORK_MODELS);
const VALID_SALARY_PERIODS    = new Set(['annual', 'hourly', 'monthly']);

// Cost/time bounds per background pass — this is a nice-to-have signal, never something the
// board query waits on, so it stays small and paced rather than racing through everything.
//
// ⛔ THIS IS A PASS SIZE, NOT A DAILY CEILING, and for a long time it was doing the job of both.
// The cron fires ONE pass (aggregator.js, inside cacheJobs), so 25 was also the daily throughput.
// Measured 2026-09-13: backlog 847, inflow ~25-32 rows/day. At 25/day the queue drains at roughly
// the rate it fills, which is why 837 rows once accumulated with nothing surfacing it and why the
// manual trigger had to be built at all. See drainEnrichment below.
const ENRICH_BATCH_SIZE = 25;
const ENRICH_DELAY_MS   = 250;

// ── THE DAILY BUDGET (task AE) ──────────────────────────────────────────────────────────────────
//
// Enrichment had NO spend ceiling of any kind. ENRICH_BATCH_SIZE was the de facto one, so raising
// it — or looping without a budget — would have removed the only bound that existed. These three
// are the real ceiling, and the drain stops at whichever binds first.
//
// Three axes rather than one because they fail differently: rows bound the work, USD bounds the
// bill when a model's pricing or a posting's length changes underneath the row count, and minutes
// bound a pass that is retrying or hanging. Any one of them alone can be satisfied while another
// runs away.
//
// Defaults sized against measured numbers, not guessed: real cost is ~$0.002/row (enrichment_batches
// 8-11: 25 rows, $0.05-0.06 each), throughput ~2.8s/row. 300 rows is therefore ~$0.60 and ~14
// minutes at full tilt — inside all three bounds, and enough to clear an 847-row backlog in about
// four days net of inflow. In steady state the drain stops early because the queue is empty, so the
// budget only binds while there is a backlog, which is exactly when it should.
const envNum = (name, dflt) => {
  const n = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
const enrichBudget = () => ({
  maxRows:    envNum('ENRICH_DAILY_MAX_ROWS', 300),
  maxUsd:     envNum('ENRICH_DAILY_MAX_USD', 1.0),
  maxMinutes: envNum('ENRICH_MAX_RUN_MINUTES', 20),
});

// Technographic decay: a skill's accumulated weight halves every DECAY_HALFLIFE_DAYS without
// a new posting reinforcing it, so a company's stack signal fades over time instead of
// acting as permanent ground truth from one old posting.
const DECAY_HALFLIFE_DAYS = 30;

// Rough Haiku list pricing (USD per 1M tokens) — for the per-run cost log only; never
// persisted or billed anywhere, just visibility into what a background pass costs.
const EST_INPUT_COST_PER_M  = 1.0;
const EST_OUTPUT_COST_PER_M = 5.0;

function buildPrompt(title, company, description) {
  return `Extract structured signals from this job posting. Only state what the text actually
says — if the posting doesn't mention something, use null. Never guess or infer beyond what's
written; a silent posting must produce null, not your best guess.

Title: ${title || ''}
Company: ${company || ''}
Description:
${(description || '').slice(0, 4000)}

Reply ONLY with valid JSON matching this exact schema. No markdown fences, no explanation:
{
  "summary": "<one sentence summary of the role, or null>",
  "normalizedTitle": "<canonical title stripped of level/location noise, lowercase, or null>",
  "experienceLevel": "<one of: intern | entry | mid | senior | lead | executive | null>",
  "workplaceType": "<one of: remote | hybrid | onsite | null>",
  "skillsHard": ["<hard/technical skill>", "..."],
  "skillsSoft": ["<soft skill>", "..."],
  "salaryMinUsd": <number or null>,
  "salaryMaxUsd": <number or null>,
  "salaryPeriod": "<one of: annual | hourly | monthly | null>",
  "isH1bSponsor": <true, false, or null — null unless the posting explicitly states its sponsorship policy>,
  "requiresWorkAuth": <true, false, or null — null unless explicitly stated>,
  "isClearanceRequired": <true, false, or null — null unless explicitly stated>,
  "orgUnit": "<the specific sub-team/org this role belongs to, e.g. 'Payments Platform' or 'Fraud ML', ONLY if the title or description explicitly names one — null if it just says the company name or a generic department like 'Engineering'>"
}`;
}

function coerceEnum(value, allowedSet) {
  return typeof value === 'string' && allowedSet.has(value) ? value : null;
}

function coerceBool(value) {
  return value === true ? 1 : value === false ? 0 : null;
}

function coerceNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

async function extractSignals(anthropic, job, { onUsage, db = null } = {}) {
  const prompt = buildPrompt(job.title, job.company, job.description);
  const msg = await callModel({
    // One call PER JOB across hundreds of rows — the single largest untracked spender.
    // Background pass, so there is no user: attributed to the system sentinel.
    anthropic, db, purpose: "enrich_job", userId: SYSTEM_USER_ID, jobId: job?.job_id ?? null,
    // PUBLIC: the payload is a job advert's title, company and description — text the company
    // published about itself. No candidate data reaches this prompt at all; buildPrompt above takes
    // exactly three fields and all three come from scraped_jobs. This is 60.2% of all model spend
    // and it is the reason routing exists.
    dataClass: DATA_CLASS.PUBLIC,
    model: MODEL_ID,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });
  // Kept: this callback is the caller's LOCAL batch-token summation for its run summary, not
  // database tracking — that now happens inside callModel. Removing it would blank the
  // per-batch token totals in the enrichment log.
  try { onUsage?.(msg.usage, MODEL_ID); } catch { /* local summation is best-effort */ }

  const raw = msg.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(raw);

  const skillsHard = Array.isArray(parsed.skillsHard) ? parsed.skillsHard.filter(s => typeof s === 'string' && s.trim()) : [];
  const skillsSoft = Array.isArray(parsed.skillsSoft) ? parsed.skillsSoft.filter(s => typeof s === 'string' && s.trim()) : [];
  const skills = [
    ...skillsHard.map(s => ({ skill: s.trim(), type: 'hard' })),
    ...skillsSoft.map(s => ({ skill: s.trim(), type: 'soft' })),
  ];

  return {
    summary:               typeof parsed.summary === 'string' ? (parsed.summary.trim().slice(0, 300) || null) : null,
    normalized_title:      typeof parsed.normalizedTitle === 'string' ? (parsed.normalizedTitle.toLowerCase().trim() || null) : null,
    experience_level:      coerceEnum(parsed.experienceLevel, VALID_EXPERIENCE_LEVELS),
    workplace_type:        coerceEnum(parsed.workplaceType, VALID_WORKPLACE_TYPES),
    salary_min_usd:        coerceNumber(parsed.salaryMinUsd),
    salary_max_usd:        coerceNumber(parsed.salaryMaxUsd),
    salary_period:         coerceEnum(parsed.salaryPeriod, VALID_SALARY_PERIODS),
    is_h1b_sponsor:        coerceBool(parsed.isH1bSponsor),
    requires_work_auth:    coerceBool(parsed.requiresWorkAuth),
    is_clearance_required: coerceBool(parsed.isClearanceRequired),
    // Company KB org layer (Task 9.5) — raw per-posting signal only; services/kb/orgLayer.js
    // does the cross-posting clustering/confidence/promotion. Mined from the SAME posting
    // text as everything else here (never from a resume/profile), matching this file's own
    // "never learn from user claims" boundary.
    org_unit:              typeof parsed.orgUnit === 'string' ? (parsed.orgUnit.trim().slice(0, 120) || null) : null,
    skills,
  };
}

// An extraction where the model returned null for literally everything carries no information.
// It is indistinguishable from a parse that went wrong or a posting whose text never made it
// into the DB, and treating it as success is what poisoned rows before: the UPDATE stamped
// content_hash/enriched_at, permanently removing the row from the candidate set (the hash only
// changes if the title/description does) while contributing nothing. Treat it as a failure so
// the row stays a candidate and gets another chance once its text is present.
function hasAnySignal(signals) {
  return Boolean(
    signals.summary || signals.normalized_title || signals.experience_level ||
    signals.workplace_type || signals.salary_min_usd != null || signals.salary_max_usd != null ||
    signals.salary_period || signals.is_h1b_sponsor != null || signals.requires_work_auth != null ||
    signals.is_clearance_required != null || signals.org_unit || signals.skills.length
  );
}

// Exponential decay: weight halves every DECAY_HALFLIFE_DAYS since it was last reinforced.
function decayedWeight(existingWeight, lastSeenEpoch, nowEpoch) {
  const elapsedDays = Math.max(0, (nowEpoch - lastSeenEpoch) / 86400);
  const factor = Math.pow(0.5, elapsedDays / DECAY_HALFLIFE_DAYS);
  return existingWeight * factor;
}

function upsertTechnographics(db, company, skills, nowEpoch) {
  if (!company || !skills.length) return;
  const getStmt = db.prepare(`SELECT weight, last_seen FROM company_technographics WHERE company = ? AND skill = ?`);
  const upsertStmt = db.prepare(`
    INSERT INTO company_technographics (company, skill, weight, last_seen, posting_count)
    VALUES (@company, @skill, @weight, @now, 1)
    ON CONFLICT(company, skill) DO UPDATE SET
      weight = @weight, last_seen = @now, posting_count = posting_count + 1
  `);
  // G3 — DE-DUP ON THE CANONICAL KEY, not the raw string.
  //
  // This used to key on the exact spelling, so one posting listing both "problem-solving" and
  // "problem solving" incremented TWO rows and counted itself twice in the evidence for one skill.
  // That is where the 386 duplicate rows in this table came from, and it is why the read-side merge
  // in services/kb/technographics.js has to warn that its sums can double-count history it cannot
  // correct. Fixing it here stops the table growing any more of them.
  //
  // The RAW spelling is still what gets stored: it is the provenance, and with the board deleted by
  // retention it is the only surviving record of what the posting actually said. Only the DE-DUP
  // decision is canonical.
  const synonyms = loadConfirmedSynonyms(db);
  const seen = new Set();
  for (const { skill } of skills) {
    const key = canonicalSkillKey(skill, synonyms);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const existing = getStmt.get(company, skill);
    // Fresh evidence from THIS posting always contributes a full unit of weight on top of
    // whatever's left of prior evidence after decay — recent postings weigh more because
    // older ones have already faded by the time this runs.
    const newWeight = existing ? decayedWeight(existing.weight, existing.last_seen, nowEpoch) + 1 : 1;
    upsertStmt.run({ company, skill, weight: newWeight, now: nowEpoch });
  }
}

let enrichmentInProgress = false;

/**
 * Runs one background enrichment pass: finds active rows whose content_hash is missing or
 * stale, extracts signals for up to `batchSize` of them, persists per-row (so a crash
 * mid-batch never re-charges a completed row), and rolls skills into company_technographics.
 * Never throws — failures are logged and leave the row a candidate for the next pass.
 * @param {import('better-sqlite3').Database} db
 * @param {import('@anthropic-ai/sdk').default | null} anthropic
 */
async function runEnrichment(db, anthropic, {
  batchSize = ENRICH_BATCH_SIZE,
  recordRun = true,
  // U1.2 — the freshness gate. Defaults to the env-configured horizon (7 days, matching the
  // expiry), and a caller may override it explicitly; 0 disables the gate.
  maxLastSeenDays = enrichSelectionOptions().maxLastSeenDays,
  // U1.3 — a manual trigger names itself, so the batch record says what caused the spend.
  batchSource = 'cron',
  // Restrict the pass to specific rows or one feed. Used by the manual trigger's "prove it on 10
  // rows before 837" mode; the cron never passes either.
  jobIds = null,
  source = null,
  batchNotes = null,
} = {}) {
  const runStartedAt = Math.floor(Date.now() / 1000);
  // User-triggered passes (a single-URL import) opt out: pipeline_runs is meant to answer "is
  // the SCHEDULED pipeline healthy?", and one row per import would interleave dozens of
  // incidental passes with the cron history, pushing the real runs out of the recent-runs view.
  // The work still happens and still counts toward coverage — only the run record is skipped.
  const record = (fields) => { if (recordRun) recordPipelineRun(db, fields); };
  if (!anthropic) {
    // Same class as Jobo's unconfigured skip: with no client this pass does nothing at all, and
    // "did nothing" must be distinguishable from "ran and found nothing to do".
    console.warn('[enrichJob] MISCONFIGURED: no Anthropic client available — enrichment did NOT run');
    record({
      runKind: 'enrichment', status: 'skipped_unconfigured', startedAt: runStartedAt,
      errorText: 'No Anthropic client available (ANTHROPIC_KEY unset?)',
    });
    return {
      enriched: 0, failed: 0, empty: 0, skipped: 0,
      ran: false, skippedReason: 'unconfigured',
      skippedDetail: 'No Anthropic client available (ANTHROPIC_KEY unset?) — enrichment did NOT run.',
    };
  }
  if (enrichmentInProgress) {
    console.log('[enrichJob] Enrichment already running — skipping overlapping invocation');
    // ⛔ A REFUSAL MUST NOT REPORT AS AN APPLIED RUN.
    //
    // This return used to be indistinguishable from a pass that ran and found nothing: zeros
    // across the board, and the ONLY record that the invocation was refused was the log line
    // above. The caller then reported `applied: true, enriched: 0, failed: 0, empty: 0,
    // batchId: null, warning: null` — a clean bill of health for work that never happened. The
    // owner hit this twice and both times read it as a silent failure of the enrichment itself.
    //
    // That is this pipeline's own defect signature — success-shaped output over an empty result —
    // appearing inside the tooling built to detect it. So `ran` is the field callers branch on:
    // zeros mean "nothing needed doing" ONLY when ran is true.
    return {
      enriched: 0, failed: 0, empty: 0, skipped: 0,
      ran: false, skippedReason: 'already_running',
      skippedDetail: 'Another enrichment pass is already in flight in this process. Nothing was ' +
                     'sent and no row was touched — this invocation was refused, not completed.',
    };
  }
  enrichmentInProgress = true;

  try {
    // Cheap SQL pre-filter (updated_at > enriched_at is a superset of "actually changed" —
    // it also catches rows just re-touched with identical content) before the exact
    // content_hash comparison below, so we don't hash every active row every run.
    // Rows with no description are excluded here rather than skipped inside the loop: there is
    // nothing to extract from an empty posting, so calling the model just burns tokens to get
    // an all-null answer back. Filtering in SQL also stops those rows from consuming batch
    // slots every run and starving rows that DO have text.
    // ONE SELECTOR, shared with the dry run and the export — see enrichmentSelection.js. It applies
    // the cheap SQL pre-filter, the U1.2 freshness gate on `scraped_at`, and then the exact
    // content-hash comparison. `noDescription` is counted, not just excluded: "how many rows can't
    // be enriched because they have no text" is the single number that would have surfaced the
    // missing-description bug on day one, so the monitor needs it explicitly rather than inferring
    // it from a coverage gap.
    const selection = selectCandidates(db, { maxLastSeenDays, jobIds, source });
    const { candidates, noDescription, gatedOut, prefilterCount } = selection;

    // The pre-filter/candidate gap, logged every pass. On the restored board it is 1252 vs 5, and
    // seeing that ratio is what tells an operator the board was bulk-touched rather than changed.
    if (prefilterCount !== candidates.length) {
      console.log(`[enrichJob] pre-filter matched ${prefilterCount} rows; ${candidates.length} ` +
                  `differ from their content_hash and are real candidates`);
    }
    if (gatedOut) {
      console.log(`[enrichJob] freshness gate excluded ${gatedOut} row(s) not seen in ` +
                  `${maxLastSeenDays} days — they are awaiting expiry, not fresh postings`);
    }

    if (!candidates.length) {
      console.log(`[enrichJob] No rows need enrichment (${noDescription} active rows have no description and can never be enriched)`);
      record({
        runKind: 'enrichment', status: 'ok', startedAt: runStartedAt,
        skipped: noDescription, details: { reason: 'no_candidates', gatedOut },
      });
      // ran: true — this pass DID execute; it simply had nothing to do. That is the state the
      // refusal above must never be confused with, which is why both carry the flag explicitly.
      return { enriched: 0, failed: 0, empty: 0, skipped: 0, noDescription, gatedOut,
               ran: true, skippedReason: null };
    }

    const batch = candidates.slice(0, batchSize);

    // U1.4 — COVERAGE, NOT CALL COUNTS. Snapshot the per-column fill rates for exactly the rows
    // this pass will touch, before it touches them, so the run can report whether coverage CLIMBED
    // rather than reporting a count that is equally consistent with 25 null extractions.
    const batchIds = batch.map(r => r.job_id);
    const coverageBefore = columnCoverage(db, { jobIds: batchIds });

    // U4 — open the batch. Provenance is additive and must never be the reason enrichment does not
    // run, so a database that predates migration 101 gets a loud warning and an unprovenanced pass
    // rather than a refusal.
    // ⛔ THE BATCH MUST RECORD THE MODEL THAT ACTUALLY SERVES THE CALLS, NOT THE ONE THIS FILE ASKS
    // FOR. enrichJob passes `model: MODEL_ID` (Haiku) to callModel, but for PUBLIC traffic the
    // routing layer may override it from ENRICH_PROVIDER/ENRICH_MODEL — and it did: a rehearsal of
    // this pass recorded a batch reading `anthropic / claude-haiku-4-5-20251001` while every
    // usage_events row for it said `groq / openai/gpt-oss-20b`. Provenance that names the wrong
    // model is worse than none, because it is the thing you would consult to explain a bad batch.
    // resolveProvider is the same function the transport consults, so the two cannot disagree.
    let routed = { provider: 'anthropic', model: MODEL_ID };
    try {
      const r = resolveProvider(process.env);
      routed = { provider: r.provider, model: r.model || MODEL_ID };
    } catch {
      // An unpinned ENRICH_MODEL throws here exactly as it will throw in the transport. Recording
      // the requested pin is the useful thing to say about a batch that is about to fail that way.
      routed = { provider: String(process.env.ENRICH_PROVIDER || 'anthropic'), model: String(process.env.ENRICH_MODEL || MODEL_ID) };
    }

    // Checked BEFORE the UPDATE is built, because the UPDATE's shape depends on it.
    const provenance = batchProvenanceAvailable(db);
    let batchId = null;
    if (!provenance) {
      console.warn('[enrichJob] batch provenance unavailable — run migration 101_enrichment_batches. ' +
                   'Enriching WITHOUT provenance.');
    } else {
      try {
        batchId = openBatch(db, { source: batchSource, provider: routed.provider, model: routed.model, notes: batchNotes });
      } catch (err) {
        console.warn(`[enrichJob] could not open an enrichment batch (${err.message}) — ` +
                     'enriching WITHOUT provenance.');
      }
    }
    // COALESCE(@x, x) for every column but one: enrichment may only ADD information, never remove
    // it. Ingestion already populates normalized_title/experience_level/workplace_type/salary from
    // the source feed, and a plain `col = @col` overwrote those with NULL whenever the model
    // stayed silent on a field — which the prompt explicitly instructs it to do. The board then
    // lost data by running its own enrichment. A wrong value can still be corrected on a later
    // pass (a non-null extraction always wins); only nulls are now non-destructive.
    //
    // ⛔ THE ONE EXCEPTION IS normalized_title, WHOSE ARGUMENTS ARE REVERSED — see the note on that
    // line. "A non-null extraction always wins" turned out to be the wrong permission for exactly
    // one column, and it was measured rather than argued.
    // ⛔ normalized_title IS THE ONE EXCEPTION, AND THE ARGUMENT ORDER IS REVERSED ON PURPOSE.
    //
    // Every other column below is COALESCE(@model, column): a non-null extraction WINS, so a wrong
    // value can be corrected on a later pass. For normalized_title that permission was being used
    // to destroy information. Measured over EVERY recorded rewrite in production — 475 of them
    // (docs/PART1_RECONCILED_2026-09-18.md §4):
    //
    //     changed                            475 of 475  (100%)
    //     SHORTER than the ingested value     469         (98.7%)
    //     seniority token changed or lost      17 of a 200-row sample (9%)
    //
    //     "staff software engineer, gtm systems"   -> "staff software engineer"
    //     "staff+ software engineer, grc platform" -> "software engineer, grc platform"
    //
    // It is not a near-miss extraction that a later pass improves. It is a systematic truncation,
    // and the column is 100% covered from ingestion (2,610 of 2,610), so enrichment was never
    // filling a gap here — only overwriting a longer, better value with a shorter one.
    //
    // ⛔ AND IT IS READ BY THREE THINGS, WHICH IS WHY THIS IS NOT COSMETIC:
    //   · profileTitleSql            — board membership ranking (CC1's two derived keys)
    //   · the ATS scorer's detectSeniority — matches /staff|principal|senior|lead/ on the title
    //   · roleFamilyForTitle         — buckets the ats_term_weights table per role family
    //
    // So a dropped "staff+" moves a posting's seniority, its band and its weight family at once.
    //
    // COALESCE(column, @model) keeps what is already there and uses the model's only to FILL a
    // genuine gap. NULLIF('') because an empty string is a gap, not a value. This makes enrichment
    // follow the rule the ingest upsert ALREADY applies to this column
    // (`COALESCE(scraped_jobs.normalized_title, excluded.normalized_title)` — "enrichment's output
    // outlives a re-crawl"), so the two writers finally agree.
    //
    // The consequence, stated rather than discovered later: normalized_title becomes effectively
    // write-once at first ingestion. Nothing corrects it any more. That is already true across a
    // re-crawl for the same reason, and the corrector being removed was making it worse.
    const updateStmt = db.prepare(`
      UPDATE scraped_jobs SET
        summary = COALESCE(@summary, summary),
        normalized_title = COALESCE(NULLIF(normalized_title, ''), @normalized_title),
        experience_level = COALESCE(@experience_level, experience_level),
        workplace_type = COALESCE(@workplace_type, workplace_type),
        salary_min_usd = COALESCE(@salary_min_usd, salary_min_usd),
        salary_max_usd = COALESCE(@salary_max_usd, salary_max_usd),
        salary_period = COALESCE(@salary_period, salary_period),
        skills_json = COALESCE(@skills_json, skills_json),
        is_h1b_sponsor = COALESCE(@is_h1b_sponsor, is_h1b_sponsor),
        requires_work_auth = COALESCE(@requires_work_auth, requires_work_auth),
        is_clearance_required = COALESCE(@is_clearance_required, is_clearance_required),
        org_unit_raw = COALESCE(@org_unit_raw, org_unit_raw),
        content_hash = @content_hash, enriched_at = @enriched_at
        -- U4: which run wrote this row. Appended only when the column EXISTS — naming it
        -- unconditionally is what made the "degrade gracefully without migration 101" path throw
        -- SQLITE_ERROR instead of degrading. The newest batch to touch a row owns it, so a non-null
        -- @enrichment_batch_id always wins; COALESCE covers the other direction, where a pass ran
        -- without provenance and must LEAVE an existing pointer alone rather than erasing what a
        -- previous run legitimately recorded.
        ${provenance ? ', enrichment_batch_id = COALESCE(@enrichment_batch_id, enrichment_batch_id)' : ''}
      WHERE job_id = @job_id
    `);

    let enriched = 0, failed = 0, empty = 0;
    let totalInputTokens = 0, totalOutputTokens = 0;
    // Column CORRECTIONS (non-null replaced by a different non-null). Counted separately from
    // fills because a correction moves no fill rate, so without this a correction-only pass is
    // indistinguishable from a pass that extracted nothing at all.
    let correctedTotal = 0;

    for (const row of batch) {
      try {
        const signals = await extractSignals(anthropic, row, {
          db,
          onUsage: (usage) => {
            totalInputTokens  += usage?.input_tokens  || 0;
            totalOutputTokens += usage?.output_tokens || 0;
          },
        });

        if (!hasAnySignal(signals)) {
          empty++;
          console.warn(`[enrichJob] ${row.job_id}: model returned no signal at all — not marking enriched`);
          if (ENRICH_DELAY_MS > 0) await new Promise(r => setTimeout(r, ENRICH_DELAY_MS));
          continue;
        }

        const now = Math.floor(Date.now() / 1000);
        // U4 — the before-image, read BEFORE the write. This is what makes a revert exact: after
        // the UPDATE it is no longer knowable which non-null columns this batch filled and which
        // arrived from ingestion, and guessing would re-create the bug that nulled 120 rows.
        const before = batchId ? captureBefore(db, row.job_id) : null;
        updateStmt.run({
          job_id:                row.job_id,
          summary:               signals.summary,
          normalized_title:      signals.normalized_title,
          experience_level:      signals.experience_level,
          workplace_type:        signals.workplace_type,
          salary_min_usd:        signals.salary_min_usd,
          salary_max_usd:        signals.salary_max_usd,
          salary_period:         signals.salary_period,
          skills_json:           signals.skills.length ? JSON.stringify(signals.skills) : null,
          is_h1b_sponsor:        signals.is_h1b_sponsor,
          requires_work_auth:    signals.requires_work_auth,
          is_clearance_required: signals.is_clearance_required,
          org_unit_raw:          signals.org_unit,
          content_hash:          computeContentHash(row.title, row.description),
          enriched_at:           now,
          // Only when the statement above actually names it: better-sqlite3 rejects a named
          // parameter the SQL does not use, so passing this unconditionally would turn the
          // no-provenance path from one error into a different one.
          ...(provenance ? { enrichment_batch_id: batchId } : {}),
        });

        // Record what the write actually CHANGED, not what it attempted. A row whose every
        // extracted field lost to COALESCE contributed nothing, and the batch's own record has to
        // be able to say so — otherwise `rows_written` inherits the exact weakness of `enriched:
        // 837` that U1.4 exists to remove.
        if (batchId) {
          const after = captureBefore(db, row.job_id);
          const changes = columnChanges(before, after);
          recordBatchRow(db, batchId, row.job_id, before, changes);
          correctedTotal += changes.corrected.length;
        }

        upsertTechnographics(db, row.company, signals.skills, now);
        enriched++;
      } catch (err) {
        failed++;
        console.warn(`[enrichJob] Failed to enrich ${row.job_id}:`, err.message);
        // content_hash/enriched_at intentionally NOT updated — row stays a candidate.
      }

      if (ENRICH_DELAY_MS > 0) await new Promise(r => setTimeout(r, ENRICH_DELAY_MS));
    }

    const estCostUsd = (totalInputTokens / 1_000_000) * EST_INPUT_COST_PER_M
                      + (totalOutputTokens / 1_000_000) * EST_OUTPUT_COST_PER_M;
    console.log(
      `[enrichJob] Enriched ${enriched}/${batch.length} (${failed} failed, ${empty} no-signal), ` +
      `${candidates.length - batch.length} remaining candidates, ` +
      `${totalInputTokens} in / ${totalOutputTokens} out tokens, ~$${estCostUsd.toFixed(4)} est.`
    );
    // A pass that extracted nothing from ANY row is a pipeline fault, not a quiet no-op —
    // most likely descriptions missing upstream. Say so rather than logging a clean-looking 0.
    if (empty && !enriched) {
      console.warn(`[enrichJob] WARNING: all ${empty} rows this pass yielded no signal — check that descriptions are being stored`);
    }

    // U1.4 — REPORT COVERAGE, NOT CALL COUNTS. The same rows, measured again, per column. `enriched
    // = 25` is compatible with 25 rows that gained nothing; a per-column delta is not.
    const coverageAfter = columnCoverage(db, { jobIds: batchIds });
    const coverage = { before: coverageBefore, after: coverageAfter };
    // ⛔ enriched_at IS EXCLUDED FROM THE VERDICT, and that exclusion is the whole point.
    // enriched_at gains by definition on every successful write — it is the stamp, not a signal —
    // so including it here made `gains.length` non-zero for ANY pass that wrote a row, which is
    // precisely the pass this check exists to catch. With it counted, the warning below could
    // never fire and U1.4 would have measured nothing.
    const gains = ENRICHMENT_COLUMNS
      .map(c => [c, (coverageAfter.columns[c]?.filled ?? 0) - (coverageBefore.columns[c]?.filled ?? 0)])
      .filter(([, d]) => d > 0);
    const stampDelta = (coverageAfter.columns.enriched_at?.filled ?? 0)
                     - (coverageBefore.columns.enriched_at?.filled ?? 0);
    console.log(`[enrichJob] coverage over the ${batchIds.length} rows in this pass: ` +
      (gains.length ? gains.map(([c, d]) => `${c} +${d}`).join(', ') : 'NO COLUMN GAINED A VALUE') +
      `  (enriched_at +${stampDelta}, ${correctedTotal} value(s) corrected in place)`);
    // A pass that wrote rows but filled no column is the A2 failure mode exactly: HTTP 200,
    // success:true, a clean usage row, and nothing to show for it.
    //
    // The corrections count is part of the test, not decoration. A pass can legitimately fill
    // nothing and still have done work — replacing a wrong experience_level with a right one moves
    // no fill rate at all — so "no column gained AND nothing was corrected" is the condition that
    // actually indicts the extraction. Warning on a flat fill rate alone would cry wolf at every
    // correction-only pass, and an alarm that fires on correct behaviour gets ignored.
    if (enriched && !gains.length && !correctedTotal) {
      console.warn(`[enrichJob] WARNING: ${enriched} row(s) were stamped enriched but NO column ` +
                   `gained a value and nothing was corrected — this is the shape of a model ` +
                   `returning empty extractions (see task A2: 49 of 50 HTTP 200s were NULL).`);
    }

    if (batchId) {
      closeBatch(db, batchId, {
        rowsAttempted: batch.length, rowsWritten: enriched, rowsFailed: failed, rowsEmpty: empty,
        inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
        estCostUsd: Number(estCostUsd.toFixed(4)), coverage,
      });
    }

    record({
      runKind: 'enrichment', status: 'ok', startedAt: runStartedAt,
      fetched: batch.length, written: enriched, failed, skipped: noDescription,
      details: {
        noSignal: empty,
        remainingCandidates: candidates.length - batch.length,
        inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
        estCostUsd: Number(estCostUsd.toFixed(4)),
        batchId, gatedOut, batchSource,
        coverageGains: Object.fromEntries(gains),
      },
    });

    return {
      enriched, failed, empty, skipped: candidates.length - batch.length, noDescription,
      totalInputTokens, totalOutputTokens, batchId, gatedOut, coverage,
      ran: true, skippedReason: null,
    };
  } finally {
    enrichmentInProgress = false;
  }
}

/**
 * TASK AE — drain the candidate set instead of nibbling at it.
 *
 * THE DECISION, AND WHY IT IS A LOOP RATHER THAN A BIGGER CONSTANT.
 *
 * AE offered two options: a much larger batch size, or a cron that loops until the candidate set is
 * empty within a bounded budget. A larger constant is a guess with a shelf life — it has to be
 * re-picked every time the board changes size, and the board went 1,255 -> 1,388 active rows in
 * four days with task Y's sources still pending. Worse, a constant is wrong in both directions at
 * once: too small on the day a spike lands (2026-09-09 ingested 161 rows in one tick), and pure
 * overhead on the ~300 days a year when 28 rows arrive.
 *
 * A loop makes the BUDGET the thing being chosen, which is the thing actually worth controlling,
 * and it self-limits: when the queue holds 28 rows the drain does 28 and stops, whatever the
 * ceiling says. The budget only binds while there is a backlog.
 *
 * ⛔ THE BUDGET IS NOT OPTIONAL DECORATION. Before this, enrichment had no spend ceiling at all —
 * ENRICH_BATCH_SIZE was the only bound on what a day could cost. Looping without adding a real
 * ceiling would have removed the single thing standing between a runaway pass and the wallet.
 *
 * WHAT STOPS THE LOOP, in the order checked:
 *   drained          the selector returned nothing — the real terminal state
 *   no_progress      a pass wrote nothing. Without this the loop spins forever on rows that fail
 *                    every time, re-charging for each attempt; three such passes in a row during
 *                    the retired-model-id outage would have been 3x the bill for 0 rows
 *   max_rows / max_usd / max_minutes   the budget
 *   refused          another pass is already in flight (the concurrency guard) — NOT a completion
 *
 * Reports COVERAGE PER COLUMN across the whole drain, not a row count, because "enriched: 300" is
 * compatible with 300 rows of nulls (task A2: 49 of 50 HTTP 200s were empty extractions).
 *
 * ONE pipeline_runs record for the whole drain, not one per pass. Ten records a day would push the
 * real history out of the recent-runs view, and the number an operator needs is what the DAY
 * achieved. The per-pass detail survives in enrichment_batches, which is per pass by design.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('@anthropic-ai/sdk').default | null} anthropic
 */
async function drainEnrichment(db, anthropic, {
  batchSize = ENRICH_BATCH_SIZE,
  budget = enrichBudget(),
  batchSource = 'cron',
  now = () => Date.now(),
  // 2A — injectable so tests drive the detail fetch without reaching SmartRecruiters or Adobe,
  // and so a caller can turn it off without an env var.
  fillDescriptions = fillMissingDescriptions,
  detailHttp = undefined,
} = {}) {
  const startedAt = Math.floor(now() / 1000);
  const startedMs = now();
  const before = columnCoverage(db);

  // ── 2A · STEP ZERO: BUY THE MISSING DESCRIPTIONS, UNDER THIS SAME DAY'S BUDGET ───────────────
  //
  // Rows from SmartRecruiters and Workday arrive with no description, because their list endpoints
  // carry none and Phase 1 proved no parameter changes that. The text is bought HERE rather than
  // in the crawl, and the reason is arithmetic rather than taste: a crawl wants 1,500 detail
  // requests while this budget is 300 rows/day, so a crawl-time fetch would buy 1,200 descriptions
  // a day that nothing could ever enrich. See services/jobs/detailBudget.js.
  //
  // ⛔ THE FETCH BUDGET IS THE DAY'S *REMAINING* ROWS, WHICH IS WHAT MAKES IT ONE BUDGET AND NOT
  // TWO. If the queue already holds enough text-bearing rows to fill the day, this buys NOTHING —
  // there is no point owning a description that today's ceiling cannot reach. That subtraction is
  // the entire mechanism by which the two spends cannot disagree.
  //
  // ⛔ AND IT ONLY RUNS IF THERE IS A CLIENT TO ENRICH WITH. Without one, runEnrichment refuses
  // below and the descriptions would sit unenriched — which is exactly the waste being removed,
  // relocated. `anthropic` is checked here rather than trusted from a flag.
  let detail = null;
  if (anthropic) {
    const alreadyQueued = selectCandidates(db, { limit: 1 }).totalMatched;
    const roomForFetches = Math.max(0, budget.maxRows - alreadyQueued);
    if (roomForFetches > 0) {
      detail = await fillDescriptions(db, { limit: roomForFetches, http: detailHttp });
    } else {
      console.log(`[enrichJob] detail fetch skipped — ${alreadyQueued} row(s) already queued fill ` +
                  `the day's ${budget.maxRows}-row budget; a description bought now could not be used`);
    }
  }

  let passes = 0, enriched = 0, failed = 0, empty = 0;
  let inputTokens = 0, outputTokens = 0, usd = 0;
  let stopReason = null, skippedReason = null;
  const batchIds = [];

  while (true) {
    // Checked BEFORE the pass, so the budget is never exceeded by the pass that discovers it.
    // Ordering matters: a drain that has already spent its rows must not send one more batch.
    const elapsedMin = (now() - startedMs) / 60000;
    if (enriched >= budget.maxRows)   { stopReason = 'max_rows';    break; }
    if (usd >= budget.maxUsd)         { stopReason = 'max_usd';     break; }
    if (elapsedMin >= budget.maxMinutes) { stopReason = 'max_minutes'; break; }

    // Never overshoot the row budget on the last pass: ask for exactly what is left.
    const room = Math.min(batchSize, budget.maxRows - enriched);
    const pass = await runEnrichment(db, anthropic, {
      batchSize: room, batchSource, recordRun: false,
    });
    passes++;

    if (!pass.ran) {
      // unconfigured / already_running. Neither is a completed drain and neither may report as one.
      stopReason = 'refused';
      skippedReason = pass.skippedReason;
      break;
    }

    enriched += pass.enriched;
    failed   += pass.failed;
    empty    += pass.empty;
    inputTokens  += pass.totalInputTokens  || 0;
    outputTokens += pass.totalOutputTokens || 0;
    usd = (inputTokens / 1e6) * EST_INPUT_COST_PER_M + (outputTokens / 1e6) * EST_OUTPUT_COST_PER_M;
    if (pass.batchId) batchIds.push(pass.batchId);

    // `skipped` is what the selector had left over after this batch. Zero means the queue is empty,
    // which is the only clean terminal state.
    if (pass.skipped === 0)  { stopReason = 'drained';     break; }
    if (pass.enriched === 0) { stopReason = 'no_progress'; break; }
  }

  const after = columnCoverage(db);
  const gains = [];
  for (const c of ENRICHMENT_COLUMNS) {
    const b = before.columns[c]?.filled ?? 0;
    const a = after.columns[c]?.filled ?? 0;
    if (a !== b) gains.push([c, a - b]);
  }
  const remaining = selectCandidates(db, { limit: 1 }).totalMatched;

  console.log(
    `[enrichJob] drain complete: ${passes} pass(es), ${enriched} enriched, ${failed} failed, ` +
    `${empty} no-signal, ~$${usd.toFixed(4)}, stopped because ${stopReason}` +
    (skippedReason ? ` (${skippedReason})` : '') + `, ${remaining} still queued`
  );
  // 2A — the detail fetch reports its own COVERAGE DELTA, not its request count. `attempted: 300`
  // is true whether 300 descriptions arrived or none did, which is the standing lesson of this
  // pipeline and the reason the two numbers are printed side by side rather than one of them.
  if (detail?.enabled && detail.selected) {
    console.log(
      `[enrichJob] detail fetch: ${detail.attempted} request(s) spent, description coverage ` +
      `${detail.describedBefore} -> ${detail.describedAfter} (+${detail.coverageDelta}) over ` +
      `${detail.selected} selected row(s)` +
      (detail.failed ? `, ${detail.failed} failed ${JSON.stringify(detail.byReason)}` : '')
    );
  }
  if (gains.length) {
    console.log('[enrichJob] coverage moved: ' + gains.map(([c, d]) => `${c} ${d > 0 ? '+' : ''}${d}`).join('  '));
  } else if (enriched) {
    console.warn(`[enrichJob] WARNING: ${enriched} row(s) enriched and NO column gained a value ` +
                 `across the whole drain.`);
  }

  // ⛔ AN OVERLAP IS NOT AN OUTAGE. cacheJobs and cacheJoboFeed BOTH schedule a drain in the same
  // 04:00 tick, so the second one is routinely refused by the concurrency guard while the first is
  // still working. Recording that as a run would write a failed-looking enrichment entry every
  // single day, and the AC health check alerts on exactly that — a permanent false alarm, which is
  // an alarm nobody reads. The drain that IS running records the day's real numbers.
  //
  // `unconfigured` still records, because that one is a genuine finding: it is Jobo's shape, a
  // provider that never ran while everything downstream reported zeros.
  const overlapped = skippedReason === 'already_running';
  if (!overlapped) recordPipelineRun(db, {
    runKind: 'enrichment',
    // `ok` only when the loop reached a real terminal state. A refusal is not a run, and the AC
    // health check reads `written` rather than this anyway — both are recorded so neither has to
    // be inferred from the other.
    //
    // ⛔ AND A RUN THAT WROTE NOTHING WHILE EVERY ROW FAILED IS NOT `ok`. It recorded `ok` for five
    // days in production — 25 of 25 rows failing, zero tokens spent, `status: 'ok'` — because the
    // only non-ok branch here was a refusal. The cause was billing ("Your credit balance is too low
    // to access the Anthropic API"), which is exactly the class of outage a run log exists to make
    // visible, and the log said everything was fine.
    //
    // The health check caught it downstream and said so precisely ("the last 2 enrichment runs
    // wrote nothing — this is the shape that ran for three days undetected"). That does not excuse
    // the row: `pipeline_runs.status` is read by things other than that check, and a status that
    // contradicts its own `failed` column is a trap for the next reader.
    //
    // Deliberately narrow: `failed` only when NOTHING was written AND something actually failed. A
    // partial run still says `ok` — 299 written and 9 failed is a working drain, and promoting that
    // to `failed` would be the opposite error, an alarm nobody reads. An empty queue (0 written, 0
    // failed) stays `ok` too, because that is a drained backlog, which is the goal state.
    status: stopReason === 'refused' ? 'skipped_unconfigured'
          : (enriched === 0 && failed > 0) ? 'failed'
          : 'ok',
    startedAt,
    fetched: enriched + failed + empty,
    written: enriched,
    failed,
    details: {
      passes, stopReason, skippedReason, batchIds,
      // Recorded so the admin health view can answer "did descriptions arrive?" for a day without
      // re-deriving it from the coverage table. Null when there was no client or no room.
      detailFetch: detail ? {
        selected: detail.selected, attempted: detail.attempted,
        withText: detail.withText, failed: detail.failed,
        coverageDelta: detail.coverageDelta, byReason: detail.byReason,
        prioritisedByProfiles: detail.prioritised, throttledSources: detail.throttledSources,
      } : null,
      inputTokens, outputTokens, estCostUsd: Number(usd.toFixed(4)),
      budget, remainingCandidates: remaining,
      coverageGains: Object.fromEntries(gains),
    },
  });

  return {
    passes, enriched, failed, empty, inputTokens, outputTokens,
    detail,
    estCostUsd: Number(usd.toFixed(4)), stopReason, skippedReason, batchIds,
    remainingCandidates: remaining, coverageBefore: before, coverageAfter: after,
    coverageGains: Object.fromEntries(gains),
    ran: stopReason !== 'refused',
  };
}

// buildPrompt is exported for scripts/al1ProviderQualityDiff.mjs, which compares two providers on
// THIS prompt. It is exported rather than copied into the harness deliberately: a copy would drift
// and the harness would then measure a prompt the pipeline does not use — two sides, each
// self-consistent, joined to nothing, which is the shape this codebase keeps finding.
// computeContentHash now LIVES in enrichmentSelection.js, beside the predicate that uses it, and is
// re-exported here so existing importers keep working. Re-exported rather than duplicated for the
// reason buildPrompt is exported rather than copied: a second copy of the fingerprint function
// would let the selector and its callers disagree about which rows have changed.
// The selection/coverage/estimate helpers are deliberately NOT re-exported: they have exactly one
// home, services/jobs/enrichmentSelection.js, and callers import them from there. Offering a second
// path to them would recreate in the import graph the very thing this task removed from the
// queries — two ways to reach one answer, which is how the two drift.
export { runEnrichment, drainEnrichment, enrichBudget, computeContentHash, decayedWeight, hasAnySignal, buildPrompt, DECAY_HALFLIFE_DAYS, ENRICH_BATCH_SIZE };
