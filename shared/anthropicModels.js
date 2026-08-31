// shared/anthropicModels.js
// PURPOSE: Single source of truth for Anthropic model IDs and per-token pricing.
//
// WHY THIS FILE EXISTS: model IDs used to be inline string literals at ~20 call sites across
// server.js, services/ and routes/. A bump to Haiku updated 8 of them and left Sonnet on
// claude-sonnet-4-20250514, which Anthropic RETIRED on 2026-06-15. Every Sonnet call then
// 404'd (not_found_error) — silently breaking resume generation, resume enhancement,
// PDF parsing and standalone generation for ~2 months, because the four features degraded
// without surfacing "the model does not exist".
//
// TO BUMP A MODEL: change the constant here. Do not reintroduce inline literals — a partial
// sweep is what caused the outage above.
//
// TO UPDATE PRICING: edit ANTHROPIC_PRICING below. Keys MUST match the model ID actually sent
// to the API, or calculateCost() cannot price the call (it warns loudly rather than silently
// returning $0 — see the unknown-key branch).

// Verified against https://platform.claude.com/docs/en/about-claude/models/overview 2026-08-13.
export const MODEL_SONNET = "claude-sonnet-5";
export const MODEL_HAIKU = "claude-haiku-4-5-20251001";

// Per-token costs in USD. Verified against
// https://platform.claude.com/docs/en/about-claude/pricing on 2026-08-13, re-verified 2026-08-31.
// Cache reads cost 0.1x base input; 5-minute cache writes cost 1.25x base input.
//
// ⚠️ `cache_write` BELOW IS THE 5-MINUTE RATE ONLY (1.25x). A ONE-HOUR cache write costs 2x base
// input — $4/MTok on Sonnet 5, $2/MTok on Haiku 4.5 — and there is no key for it here.
//
// This is fine today because nothing sets a ttl: services/promptAssembler.js and server.js both
// send a bare `cache_control: { type: "ephemeral" }`, which is the 5-minute default. It stops being
// fine the moment cache-window batching adopts `ttl: "1h"`, which is the natural reason to reach
// for it. calculateCost would then price those writes at $2.50 instead of $4.00 and UNDER-REPORT
// every batched write by 37.5% — silently, because the model ID still resolves and the loud
// unknown-key branch below never fires.
//
// BEFORE adopting a 1-hour TTL, resolve the open question this comment exists to flag: the API
// reports writes as `cache_creation_input_tokens` regardless of TTL, so a second price key is not
// enough on its own — the usage payload's per-TTL breakdown has to be read, or the TTL threaded
// through from the request. Do not add a 1h key without wiring whichever of those is real; a price
// nothing selects is worse than an absent one. See docs/ak2-cache-batching-assessment.md.
export const ANTHROPIC_PRICING = {
  // Claude Sonnet 5 — $2/MTok in, $10/MTok out.
  // Anthropic's launch "introductory" $2/$10 is now the STANDARD price; the increase to
  // $3/$15 that was scheduled for 2026-09-01 was cancelled, so this needs no expiry handling.
  "claude-sonnet-5": {
    input:       0.000002,
    output:      0.00001,
    cache_read:  0.0000002,
    cache_write: 0.0000025,
  },
  // Claude Haiku 4.5 — $1/MTok in, $5/MTok out.
  // These were previously recorded as $0.80/$4, which are HAIKU 3.5's prices: the same
  // incomplete migration that stranded Sonnet bumped the Haiku model ID without repricing it,
  // so every Haiku call was logged ~20% cheaper than it actually billed.
  "claude-haiku-4-5-20251001": {
    input:       0.000001,
    output:      0.000005,
    cache_read:  0.0000001,
    cache_write: 0.00000125,
  },
  // RETIRED 2026-06-15 — kept so historical usage_events rows and any cost recompute over
  // pre-migration data still price correctly. Nothing calls this model any more; if it shows
  // up in a NEW usage event, something is still holding a stale ID.
  "claude-sonnet-4-20250514": {
    input:       0.000003,
    output:      0.000015,
    cache_read:  0.0000003,
    cache_write: 0.00000375,
  },
};

// The Anthropic API returns cache-creation tokens as `cache_creation_input_tokens`.
// Older code in this repo read `usage.cache_creation_tokens` — which is the *database column*
// name, not the API field — so it was always undefined and cache-write cost silently totalled
// $0 on every real call. Tests did not catch it because their fixtures passed the DB column
// name. Read both so live responses and legacy/fixture shapes both price correctly.
export function cacheCreationTokensOf(usage = {}) {
  return usage.cache_creation_input_tokens ?? usage.cache_creation_tokens ?? 0;
}

export function calculateCost(model, usage = {}) {
  const p = ANTHROPIC_PRICING[model];
  if (!p) {
    // Fail LOUD, not soft. Returning a bare 0 here is how a dead model ID hides: the call
    // fails or the price changes, cost logging reports $0.00, and the dashboards look healthy.
    console.warn(
      `[pricing] NO PRICING ENTRY for model "${model}" — cost logged as $0. ` +
      `Add it to ANTHROPIC_PRICING in shared/anthropicModels.js. ` +
      `Known models: ${Object.keys(ANTHROPIC_PRICING).join(", ")}`
    );
    return 0;
  }
  return (
    (usage.input_tokens || 0)            * p.input +
    (usage.output_tokens || 0)           * p.output +
    (usage.cache_read_input_tokens || 0) * p.cache_read +
    cacheCreationTokensOf(usage)         * p.cache_write
  );
}
