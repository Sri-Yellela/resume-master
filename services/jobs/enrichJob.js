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
    return { enriched: 0, failed: 0, skipped: 0 };
  }
  if (enrichmentInProgress) {
    console.log('[enrichJob] Enrichment already running — skipping overlapping invocation');
    return { enriched: 0, failed: 0, skipped: 0 };
  }
  enrichmentInProgress = true;

  try {
    // Cheap SQL pre-filter (updated_at > enriched_at is a superset of "actually changed" —
    // it also catches rows just re-touched with identical content) before the exact
    // content_hash comparison below, so we don't hash every active row every run.
    const rows = db.prepare(`
      SELECT job_id, title, company, description, content_hash
      FROM scraped_jobs
      WHERE is_active = 1
        AND (enriched_at IS NULL OR content_hash IS NULL OR updated_at > enriched_at)
      ORDER BY discovered_at DESC
    `).all();

    const candidates = rows.filter(r => computeContentHash(r.title, r.description) !== r.content_hash);
    if (!candidates.length) {
      console.log('[enrichJob] No rows need enrichment');
      return { enriched: 0, failed: 0, skipped: 0 };
    }

    const batch = candidates.slice(0, batchSize);
    const updateStmt = db.prepare(`
      UPDATE scraped_jobs SET
        summary = @summary, normalized_title = @normalized_title,
        experience_level = @experience_level, workplace_type = @workplace_type,
        salary_min_usd = @salary_min_usd, salary_max_usd = @salary_max_usd,
        salary_period = @salary_period, skills_json = @skills_json,
        is_h1b_sponsor = @is_h1b_sponsor, requires_work_auth = @requires_work_auth,
        is_clearance_required = @is_clearance_required, org_unit_raw = @org_unit_raw,
        content_hash = @content_hash, enriched_at = @enriched_at
      WHERE job_id = @job_id
    `);

    let enriched = 0, failed = 0;
    let totalInputTokens = 0, totalOutputTokens = 0;

    for (const row of batch) {
      try {
        const signals = await extractSignals(anthropic, row, {
          onUsage: (usage) => {
            totalInputTokens  += usage?.input_tokens  || 0;
            totalOutputTokens += usage?.output_tokens || 0;
          },
        });

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
      `[enrichJob] Enriched ${enriched}/${batch.length} (${failed} failed), ` +
      `${candidates.length - batch.length} remaining candidates, ` +
      `${totalInputTokens} in / ${totalOutputTokens} out tokens, ~$${estCostUsd.toFixed(4)} est.`
    );

    return { enriched, failed, skipped: candidates.length - batch.length, totalInputTokens, totalOutputTokens };
  } finally {
    enrichmentInProgress = false;
  }
}

export { runEnrichment, computeContentHash, decayedWeight, DECAY_HALFLIFE_DAYS, ENRICH_BATCH_SIZE };
