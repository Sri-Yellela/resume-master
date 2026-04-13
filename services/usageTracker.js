// services/usageTracker.js
// PURPOSE: Record all metered events to usage_events, cache_events, and scrape_events.
// DEPENDENCIES: db instance from server.js passed as first argument.
// TO ADD A NEW EVENT TYPE: add the event_type string to the column comment in
//   the migration, then call trackApiCall() or trackScrape() from the route.

// Duplicate pricing here so this module is self-contained.
const ANTHROPIC_PRICING = {
  "claude-sonnet-4-20250514": {
    input: 0.000003, output: 0.000015,
    cache_read: 0.0000003, cache_write: 0.00000375,
  },
  "claude-haiku-4-5-20251001": {
    input: 0.0000008, output: 0.000004,
    cache_read: 0.00000008, cache_write: 0.000001,
  },
};

function calcCost(model, usage = {}) {
  const p = ANTHROPIC_PRICING[model];
  if (!p) return 0;
  return (
    (usage.input_tokens || 0)              * p.input +
    (usage.output_tokens || 0)             * p.output +
    (usage.cache_read_input_tokens || 0)   * p.cache_read +
    (usage.cache_creation_tokens || 0)     * p.cache_write
  );
}

export function trackApiCall(db, {
  userId, eventType, eventSubtype,
  model, usage,
  durationMs, jobId, company,
  atsScoreBefore, atsScoreAfter,
  success = true, errorText = null,
  domainModule = null,
}) {
  try {
    const cost = calcCost(model, usage || {});
    const cacheReadTokens     = usage?.cache_read_input_tokens || 0;
    const cacheCreationTokens = usage?.cache_creation_tokens   || 0;
    const cached = (usage?.input_tokens || 0) === 0 && cacheReadTokens > 0 ? 1 : 0;

    db.prepare(`INSERT INTO usage_events (
      user_id, event_type, event_subtype, input_tokens,
      output_tokens, cache_read_tokens, cache_creation_tokens,
      cached, model, cost_usd, ats_score_before, ats_score_after,
      duration_ms, job_id, company, success, error_text
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      userId, eventType, eventSubtype || null,
      usage?.input_tokens || 0,
      usage?.output_tokens || 0,
      cacheReadTokens, cacheCreationTokens,
      cached, model, cost,
      atsScoreBefore ?? null, atsScoreAfter ?? null,
      durationMs || null, jobId || null, company || null,
      success ? 1 : 0, errorText || null
    );

    // Record cache event for layer-level analysis
    if (cacheReadTokens > 0 || cacheCreationTokens > 0) {
      const p = ANTHROPIC_PRICING[model];
      const tokensSaved = cacheReadTokens;
      const costSaved = p ? cacheReadTokens * (p.input - p.cache_read) : 0;
      db.prepare(`INSERT INTO cache_events (
        user_id, event_type, layer, domain_module,
        tokens_in_cache, tokens_saved, cost_saved_usd, model
      ) VALUES (?,?,?,?,?,?,?,?)`)
      .run(
        userId,
        cacheReadTokens > 0 ? 'cache_hit' : 'cache_write',
        domainModule ? 'layer2_domain' : 'layer1_global',
        domainModule || null,
        cacheCreationTokens || cacheReadTokens,
        tokensSaved, costSaved, model
      );
    }
  } catch (e) {
    console.warn("[usageTracker] trackApiCall error:", e.message);
  }
}

export function trackScrape(db, {
  userId, searchQuery, rawCount, filteredCount,
  insertedCount, duplicateCount, ghostCount,
  irrelevantCount, durationMs,
  success = true, errorText = null,
}) {
  try {
    db.prepare(`INSERT INTO scrape_events (
      user_id, search_query, raw_count, filtered_count,
      inserted_count, duplicate_count, ghost_count,
      irrelevant_count, duration_ms, success, error_text
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      userId, searchQuery, rawCount || 0, filteredCount || 0,
      insertedCount || 0, duplicateCount || 0, ghostCount || 0,
      irrelevantCount || 0, durationMs || null,
      success ? 1 : 0, errorText || null
    );
  } catch (e) {
    console.warn("[usageTracker] trackScrape error:", e.message);
  }
}
