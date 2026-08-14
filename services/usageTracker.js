// SCRAPING � SCHEDULED FOR REMOVAL AFTER MIGRATION
// services/usageTracker.js
// PURPOSE: Record all metered events to usage_events, cache_events, and scrape_events.
// DEPENDENCIES: db instance from server.js passed as first argument.
// TO ADD A NEW EVENT TYPE: add the event_type string to the column comment in
//   the migration, then call trackApiCall() or trackScrape() from the route.

// Pricing and model IDs live in ONE place — see shared/anthropicModels.js for why this module
// no longer keeps its own copy (the duplicate drifted and mispriced every Haiku call).
import {
  ANTHROPIC_PRICING,
  calculateCost as calcCost,
  cacheCreationTokensOf,
} from "../shared/anthropicModels.js";

function cacheState(usage = {}) {
  const inputTokens = usage?.input_tokens || 0;
  const cacheReadTokens = usage?.cache_read_input_tokens || 0;
  const cacheCreationTokens = cacheCreationTokensOf(usage);
  if (cacheReadTokens > 0 && inputTokens > 0) return "partial";
  if (cacheReadTokens > 0) return "warm";
  if (cacheCreationTokens > 0) return "cold_write";
  return "cold";
}

function cacheEventTypeForState(state) {
  if (state === "warm") return "cache_hit";
  if (state === "partial") return "cache_partial";
  if (state === "cold_write") return "cache_write";
  return "cache_miss";
}

// Tracking failures used to go to console.warn and nothing else — the same "logs quietly" class
// as the Jobo unconfigured skip and the enrichment empty-write stamp. A cost table that is empty
// because every insert threw looked identical to one that is empty because nothing ran. These
// counters make that distinguishable, and routes/admin.js reports them as coverage.
const trackingStats = {
  recorded: 0,
  failed: 0,
  // Of the failures above, how many were written to usage_tracking_failures (migration 076) and
  // therefore survive a restart, versus how many could not be persisted either — which is what a
  // wholly unreachable database looks like from in here.
  persistedFailures: 0,
  unpersistedFailures: 0,
  lastError: null,
  lastErrorAt: null,
  lastPersistError: null,
};

/** Recorded vs failed usage inserts for this process. Read by the admin cost endpoint. */
export function getTrackingStats() {
  return { ...trackingStats };
}

/** Test seam only. */
export function resetTrackingStats() {
  trackingStats.recorded = 0;
  trackingStats.failed = 0;
  trackingStats.persistedFailures = 0;
  trackingStats.unpersistedFailures = 0;
  trackingStats.lastError = null;
  trackingStats.lastErrorAt = null;
  trackingStats.lastPersistError = null;
}

export function trackApiCall(db, {
  userId, eventType, eventSubtype,
  model, usage,
  durationMs, jobId, company,
  atsScoreBefore, atsScoreAfter,
  success = true, errorText = null,
  domainModule = null,
  purpose = null,
}) {
  try {
    const cost = calcCost(model, usage || {});
    const cacheReadTokens     = usage?.cache_read_input_tokens || 0;
    const cacheCreationTokens = cacheCreationTokensOf(usage || {});
    const state = cacheState(usage || {});
    const cached = cacheReadTokens > 0 ? 1 : 0;

    db.prepare(`INSERT INTO usage_events (
      user_id, event_type, event_subtype, input_tokens,
      output_tokens, cache_read_tokens, cache_creation_tokens,
      cached, model, cost_usd, ats_score_before, ats_score_after,
      duration_ms, job_id, company, success, error_text, purpose
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      userId, eventType, eventSubtype || null,
      usage?.input_tokens || 0,
      usage?.output_tokens || 0,
      cacheReadTokens, cacheCreationTokens,
      cached, model, cost,
      atsScoreBefore ?? null, atsScoreAfter ?? null,
      durationMs || null, jobId || null, company || null,
      success ? 1 : 0, errorText || null, purpose || null
    );
    trackingStats.recorded++;

    console.info("[usage] model_call", JSON.stringify({
      userId,
      eventType,
      eventSubtype: eventSubtype || null,
      model,
      inputTokens: usage?.input_tokens || 0,
      outputTokens: usage?.output_tokens || 0,
      cacheReadTokens,
      cacheCreationTokens,
      cacheState: state,
      costUsd: Number(cost.toFixed(6)),
      durationMs: durationMs || null,
      jobId: jobId || null,
      success: !!success,
    }));

    // Record one cache-state event per model call so misses and partial hits are visible.
    if (model) {
      const p = ANTHROPIC_PRICING[model];
      const tokensSaved = cacheReadTokens;
      const costSaved = p ? cacheReadTokens * (p.input - p.cache_read) : 0;
      db.prepare(`INSERT INTO cache_events (
        user_id, event_type, layer, domain_module,
        tokens_in_cache, tokens_saved, cost_saved_usd, model
      ) VALUES (?,?,?,?,?,?,?,?)`)
      .run(
        userId,
        cacheEventTypeForState(state),
        domainModule ? 'layer2_domain' : 'layer1_global',
        domainModule || null,
        cacheCreationTokens || cacheReadTokens,
        tokensSaved, costSaved, model
      );
    }
  } catch (e) {
    // LOUD, and counted. A swallowed insert means spend happened and was never recorded, so
    // the cost panel would under-report without anything indicating it.
    trackingStats.failed++;
    trackingStats.lastError = e.message;
    trackingStats.lastErrorAt = Math.floor(Date.now() / 1000);

    // PERSIST the gap (migration 076). The counters above reset on restart, so without this a
    // failure followed by a deploy left no trace and coverage read healthy for a gap that really
    // happened.
    //
    // This write is attempted BECAUSE a write just failed, so it is wrapped separately and can
    // never throw out of here. It succeeds for the common causes — a constraint violation, a
    // missing column, a bad table name — because those are specific to usage_events. It cannot
    // succeed when the database itself is unreachable, which is why the in-process counters stay:
    // they are the last resort, and routes/admin.js reports both rather than implying the
    // persisted count is complete.
    try {
      db.prepare(`INSERT INTO usage_tracking_failures
        (model, purpose, user_id, error_text) VALUES (?,?,?,?)`)
        .run(
          model ?? null,
          purpose ?? eventType ?? null,
          // No FK on this column: an FK violation on usage_events.user_id is one of the reasons
          // tracking fails, so the failure record must not be able to fail the same way.
          userId ?? null,
          String(e?.message ?? e).slice(0, 500)
        );
      trackingStats.persistedFailures++;
    } catch (persistError) {
      trackingStats.unpersistedFailures++;
      trackingStats.lastPersistError = persistError.message;
    }

    console.error("[usageTracker] FAILED TO RECORD USAGE — spend is happening and is not being " +
      `logged. model=${model} purpose=${purpose ?? eventType}: ${e.message}`);
  }
}

// trackScrape() removed in cleanup 5.8 — it was the ONLY writer to scrape_events and had zero
// callers, so the table has sat at 0 rows since the pivot retired external scraping.
//
// The scrape_events TABLE is deliberately kept: routes/admin.js still reads it in four analytics
// queries. Those panels therefore report a permanent zero, which is accurate (no scraping
// happens) but worth knowing before someone reads it as a data bug — recorded as §5.12 in
// docs/PIPELINE_DIAGNOSIS.md. Dropping the table would break those queries, so it is a separate
// decision from removing the dead writer.
