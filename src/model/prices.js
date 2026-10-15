// What a model call cost, in US dollars — for the model_usage ledger (A97, 10-14).
//
// Per token, first-party Anthropic API rates, the same figures as draft's shared/anthropicModels.js
// ANTHROPIC_PRICING (checked against the API reference 10-14): Sonnet 5 $2 / $10 per MTok, Haiku 4.5
// $1 / $5; a cache read is 0.1x input, a cache write 1.25x — the 5-MINUTE rate. Every cache_control
// in this service is a bare `ephemeral` (the 5-minute default); a 1-hour TTL writes at 2x and would
// need its own rate here, read from the usage payload's per-TTL breakdown.
//
// ⛔ A MODEL WITH NO PRICE COSTS NULL, NOT $0. A zero is indistinguishable from a free call; a null
// in the ledger is a visible gap. Add the model here in the same commit that starts calling it.
import crypto from "node:crypto";
import { MODEL_SONNET, MODEL_HAIKU } from "./anthropicCall.js";

export const PRICES = Object.freeze({
  [MODEL_SONNET]: { input: 2e-6, output: 10e-6, cache_read: 0.2e-6, cache_write: 2.5e-6 },
  [MODEL_HAIKU]:  { input: 1e-6, output: 5e-6,  cache_read: 0.1e-6, cache_write: 1.25e-6 },
});

/** Dollars for one usage record (src/model/anthropicCall.js usageRecord), or null if unpriced. */
export function costOf(usage = {}) {
  const p = PRICES[usage.model];
  if (!p) return null;
  const n = (k) => Number(usage[k]) || 0;
  return n("input_tokens") * p.input + n("output_tokens") * p.output
    + n("cache_read_input_tokens") * p.cache_read + n("cache_creation_input_tokens") * p.cache_write;
}

/**
 * A short, non-reversible name for an API key: the first 8 hex of its sha256. Logged at boot and
 * written on every ledger row, so "do these two processes share a key?" is answerable from the logs
 * — the T4 follow-up (10-14) had to work that out by hand. Never the key, never a slice of it.
 */
export function keyFingerprint(apiKey) {
  if (!apiKey) return null;
  return crypto.createHash("sha256").update(String(apiKey)).digest("hex").slice(0, 8);
}
