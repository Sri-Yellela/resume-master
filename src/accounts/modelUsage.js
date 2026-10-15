// ── The model-spend ledger (A97, owner 10-14) — one row per model call, counts and price only ───
//
// Before this the service's only record of spend was the stdout `metering:true` line, held as long
// as Railway keeps logs. ~$7 then left the account with nothing here to say where it went. This is
// the durable copy: written from metering.record (src/http/metering.js), so the token API and the
// site's paid tools — every path that calls a model — land in the same table.
//
// ⛔ COUNTS, NEVER CONTENT, AND NEVER A PERSON. A row holds the calling client's id ("draft",
// "site-user"), the route, the model, token counts, duration, the price, and which key paid. No
// request field, no prompt, no response, no user id — the site's per-person record is the credit
// ledger, which an account's delete already removes. So the token API still stores nothing a caller
// SENT (test/accounts.test.js asserts it); what it now keeps is what the service SPENT.
//
// Lives in src/accounts/ because that is the one place SQL may run (test/stateless.test.js).
import { costOf } from "../model/prices.js";

/**
 * @returns a ledger function for createMetering({ ledger }), or null with no store.
 * @param keyLabel  ANTHROPIC_KEY_LABEL — the key's name in the Console ("tools-prod"), or null
 * @param keyFp     keyFingerprint(ANTHROPIC_API_KEY)
 */
export function createModelUsageLedger(db, { keyLabel = null, keyFp = null } = {}) {
  if (!db) return null;
  const insert = db.prepare(`
    INSERT INTO model_usage (client, via, route, purpose, model, success, input_tokens, output_tokens,
                             cache_creation_input_tokens, cache_read_input_tokens, duration_ms, cost_usd,
                             key_label, key_fp, attempts)
    VALUES (@client, @via, @route, @purpose, @model, @success, @input_tokens, @output_tokens,
            @cache_creation_input_tokens, @cache_read_input_tokens, @duration_ms, @cost_usd,
            @key_label, @key_fp, @attempts)
  `);
  const n = (v) => Number(v) || 0;
  const writeAll = db.transaction((rows) => { for (const r of rows) insert.run(r); });
  return (clientId, route, usage = [], extra = {}) => {
    const rows = usage.filter(Boolean).map(u => ({
      client: String(clientId ?? "unknown"),
      via: extra?.via ?? null,
      route: String(route),
      purpose: u.purpose ?? null,
      model: u.model ?? null,
      success: u.success === false ? 0 : 1,
      input_tokens: n(u.input_tokens),
      output_tokens: n(u.output_tokens),
      cache_creation_input_tokens: n(u.cache_creation_input_tokens),
      cache_read_input_tokens: n(u.cache_read_input_tokens),
      duration_ms: u.duration_ms == null ? null : n(u.duration_ms),
      cost_usd: costOf(u),
      key_label: keyLabel,
      key_fp: keyFp,
      // A97: HTTP sends behind this one call (an SDK retry makes it 2); null when not observable.
      attempts: u.attempts == null ? null : n(u.attempts),
    }));
    if (rows.length) writeAll(rows);
    return rows.length;
  };
}

/** Totals by UTC day, client, route, model and key — what scripts/modelUsageReport.mjs prints. */
export function modelUsageSummary(db, { since = 0 } = {}) {
  return db.prepare(`
    SELECT date(created_at, 'unixepoch') AS day, client, route, model, key_label, key_fp,
           COUNT(*) AS calls, SUM(success = 0) AS failed,
           SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
           SUM(cache_creation_input_tokens) AS cache_write_tokens, SUM(cache_read_input_tokens) AS cache_read_tokens,
           ROUND(SUM(cost_usd), 4) AS cost_usd, SUM(cost_usd IS NULL) AS unpriced,
           SUM(attempts) AS attempts, SUM(attempts > 1) AS retried
    FROM model_usage WHERE created_at >= ?
    GROUP BY day, client, route, model, key_label, key_fp
    ORDER BY day, client, route, model
  `).all(since);
}
