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
 * ADDITIVE ONLY. Every column is written via COALESCE(@new, existing), because ingestion has
 * already populated several of these from the source feed and the prompt deliberately tells the
 * model to answer null when a posting is silent. Combining those two facts with a plain
 * assignment meant a normal, correct extraction erased good ingestion data — and because the
 * success path also stamps content_hash, the row left the candidate set for good. Two guards
 * now bound that: COALESCE (a null can never overwrite) and hasAnySignal (an all-null
 * extraction is treated as a failure, so the row is not stamped and stays a candidate).
 */

import crypto from 'crypto';

const MODEL_ID = 'claude-haiku-4-5-20251001';

const VALID_EXPERIENCE_LEVELS = new Set(['intern', 'entry', 'mid', 'senior', 'lead', 'executive']);
const VALID_WORKPLACE_TYPES   = new Set(['remote', 'hybrid', 'onsite']);
const VALID_SALARY_PERIODS    = new Set(['annual', 'hourly', 'monthly']);

// Cost/time bounds per background pass — this is a nice-to-have signal, never something the
// board query waits on, so it stays small and paced rather than racing through everything.
const ENRICH_BATCH_SIZE = 25;
const ENRICH_DELAY_MS   = 250;

// Technographic decay: a skill's accumulated weight halves every DECAY_HALFLIFE_DAYS without
// a new posting reinforcing it, so a company's stack signal fades over time instead of
// acting as permanent ground truth from one old posting.
const DECAY_HALFLIFE_DAYS = 30;

// Rough Haiku list pricing (USD per 1M tokens) — for the per-run cost log only; never
// persisted or billed anywhere, just visibility into what a background pass costs.
const EST_INPUT_COST_PER_M  = 1.0;
const EST_OUTPUT_COST_PER_M = 5.0;

function computeContentHash(title, description) {
  return crypto.createHash('sha1').update(`${title || ''}|${description || ''}`).digest('hex');
}

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

async function extractSignals(anthropic, job, { onUsage } = {}) {
  const prompt = buildPrompt(job.title, job.company, job.description);
  const msg = await anthropic.messages.create({
    model: MODEL_ID,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });
  try { onUsage?.(msg.usage, MODEL_ID); } catch { /* usage tracking is best-effort */ }

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
  const seen = new Set();
  for (const { skill } of skills) {
    if (seen.has(skill)) continue; // de-dup within the SAME posting (hard+soft lists can repeat)
    seen.add(skill);
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
async function runEnrichment(db, anthropic, { batchSize = ENRICH_BATCH_SIZE } = {}) {
  if (!anthropic) {
    console.log('[enrichJob] No Anthropic client available — skipping enrichment pass');
    return { enriched: 0, failed: 0, empty: 0, skipped: 0 };
  }
  if (enrichmentInProgress) {
    console.log('[enrichJob] Enrichment already running — skipping overlapping invocation');
    return { enriched: 0, failed: 0, empty: 0, skipped: 0 };
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
    const rows = db.prepare(`
      SELECT job_id, title, company, description, content_hash
      FROM scraped_jobs
      WHERE is_active = 1
        AND description IS NOT NULL AND TRIM(description) != ''
        AND (enriched_at IS NULL OR content_hash IS NULL OR updated_at > enriched_at)
      ORDER BY discovered_at DESC
    `).all();

    const candidates = rows.filter(r => computeContentHash(r.title, r.description) !== r.content_hash);
    if (!candidates.length) {
      console.log('[enrichJob] No rows need enrichment');
      return { enriched: 0, failed: 0, empty: 0, skipped: 0 };
    }

    const batch = candidates.slice(0, batchSize);
    // COALESCE(@x, x) throughout: enrichment may only ADD information, never remove it.
    // Ingestion already populates normalized_title/experience_level/workplace_type/salary from
    // the source feed, and a plain `col = @col` overwrote those with NULL whenever the model
    // stayed silent on a field — which the prompt explicitly instructs it to do. The board then
    // lost data by running its own enrichment. A wrong value can still be corrected on a later
    // pass (a non-null extraction always wins); only nulls are now non-destructive.
    const updateStmt = db.prepare(`
      UPDATE scraped_jobs SET
        summary = COALESCE(@summary, summary),
        normalized_title = COALESCE(@normalized_title, normalized_title),
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
      WHERE job_id = @job_id
    `);

    let enriched = 0, failed = 0, empty = 0;
    let totalInputTokens = 0, totalOutputTokens = 0;

    for (const row of batch) {
      try {
        const signals = await extractSignals(anthropic, row, {
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
        });

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

    return { enriched, failed, empty, skipped: candidates.length - batch.length, totalInputTokens, totalOutputTokens };
  } finally {
    enrichmentInProgress = false;
  }
}

export { runEnrichment, computeContentHash, decayedWeight, hasAnySignal, DECAY_HALFLIFE_DAYS, ENRICH_BATCH_SIZE };
