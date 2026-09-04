// SCRAPING — SCHEDULED FOR REMOVAL AFTER MIGRATION
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
import { appendFailure } from "./trackingFailureSink.js";
import { notifyLostFailure } from "./trackingFailureWebhook.js";

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
  // Of the unpersisted ones, how many reached the out-of-process sink (and so survive an
  // unreachable database), versus how many were LOST outright — the filesystem was unwritable too,
  // and nothing but the log below remains.
  sinkedFailures: 0,
  lostFailures: 0,
  // Of the LOST ones, how many were pushed off-box via the optional webhook. Inert unless
  // USAGE_FAILURE_WEBHOOK_URL is set, in which case a lost failure is at least visible somewhere
  // other than a log line on one host.
  webhookAttempts: 0,
  webhookThrottled: 0,
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
  trackingStats.sinkedFailures = 0;
  trackingStats.lostFailures = 0;
  trackingStats.webhookAttempts = 0;
  trackingStats.webhookThrottled = 0;
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
  // Which provider served the call. Defaults to anthropic so a caller that predates routing
  // records the truth rather than a NULL that would read as "unknown".
  provider = "anthropic",
}) {
  let eventId = null;
  try {
    const cost = calcCost(model, usage || {});
    const cacheReadTokens     = usage?.cache_read_input_tokens || 0;
    const cacheCreationTokens = cacheCreationTokensOf(usage || {});
    const state = cacheState(usage || {});
    const cached = cacheReadTokens > 0 ? 1 : 0;

    const inserted = db.prepare(`INSERT INTO usage_events (
      user_id, event_type, event_subtype, input_tokens,
      output_tokens, cache_read_tokens, cache_creation_tokens,
      cached, model, cost_usd, ats_score_before, ats_score_after,
      duration_ms, job_id, company, success, error_text, purpose, provider
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      userId, eventType, eventSubtype || null,
      usage?.input_tokens || 0,
      usage?.output_tokens || 0,
      cacheReadTokens, cacheCreationTokens,
      cached, model, cost,
      atsScoreBefore ?? null, atsScoreAfter ?? null,
      durationMs || null, jobId || null, company || null,
      success ? 1 : 0, errorText || null, purpose || null, provider || "anthropic"
    );
    trackingStats.recorded++;
    // AK1: the row id, so a caller that only learns a value AFTER the call can fill it in.
    // resume_generate is the case that needs it — the post-generation ATS score does not exist
    // until ~100 lines after the model call that this row records. See recordAtsOutcome below.
    eventId = Number(inserted.lastInsertRowid) || null;

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

      // THIRD fallback, out of process: the database could not even record that it failed, which
      // is what an unreachable database looks like from here. An append-only file needs no
      // service, no network and no working database, and is drained back in at the next boot.
      const sunk = appendFailure({
        model, purpose: purpose ?? eventType, userId,
        errorText: String(e?.message ?? e),
        persistError: persistError.message,
      });
      if (sunk) {
        trackingStats.sinkedFailures++;
      } else {
        // FOURTH tier: neither the database nor the filesystem could hold this. The webhook is the
        // only way the fact leaves the box. Fire-and-forget and opt-in — see the module header for
        // why it never awaits, never retries and never floods.
        trackingStats.lostFailures++;
        const outcome = notifyLostFailure({
          model, purpose: purpose ?? eventType, userId,
          errorText: String(e?.message ?? e),
          persistError: persistError.message,
          sinkError: "append to local sink failed",
        });
        if (outcome === "attempted") trackingStats.webhookAttempts++;
        else if (outcome === "throttled") trackingStats.webhookThrottled++;
      }
    }

    console.error("[usageTracker] FAILED TO RECORD USAGE — spend is happening and is not being " +
      `logged. model=${model} purpose=${purpose ?? eventType}: ${e.message}` +
      (trackingStats.lostFailures > 0
        ? " — AND it could not be written to the database or the out-of-process sink, so this log " +
          "line is the only remaining record of it."
        : ""));
  }
  return eventId;
}

/**
 * AK1 — fill in the ATS scores on a usage_events row after the fact.
 *
 * WHY THIS EXISTS AT ALL. usage_events has carried ats_score_before and ats_score_after since the
 * table was created, routes/admin.js reads both to render an "avg before -> avg after" generation-
 * lift panel, and every row had NULL in both — because the only caller that could supply them,
 * resume_generate, computes the post-generation score about a hundred lines AFTER the model call
 * that writes the row. The panel had therefore never shown anything, and "does generation actually
 * improve the score?" was unanswerable in a system built to answer it.
 *
 * An UPDATE rather than deferring the INSERT: the row must exist the moment the call returns, so
 * that spend is recorded even if everything downstream throws. Cost accounting is the row's first
 * job; the lift measurement is a passenger and must not be able to delay or lose it.
 *
 * Never throws. A failed measurement update must not fail a generation the user is waiting for.
 */
export function recordAtsOutcome(db, eventId, { scoreBefore = null, scoreAfter = null } = {}) {
  if (!db || !eventId) return false;
  // A declined score is null, and null is the honest record. Writing 0 would put a fabricated
  // data point into the only dataset that can ever show whether generation is worth its cost.
  if (scoreBefore == null && scoreAfter == null) return false;
  try {
    db.prepare(
      `UPDATE usage_events
          SET ats_score_before = COALESCE(?, ats_score_before),
              ats_score_after  = COALESCE(?, ats_score_after)
        WHERE id = ?`
    ).run(scoreBefore ?? null, scoreAfter ?? null, eventId);
    return true;
  } catch (e) {
    trackingStats.failed++;
    trackingStats.lastError = e.message;
    console.error(`[usageTracker] could not record ATS outcome on event ${eventId}: ${e.message}`);
    return false;
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
