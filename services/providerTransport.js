// services/providerTransport.js
// PURPOSE: The ONE module that speaks a non-Anthropic provider's wire protocol. It is the only
// file exempt from the direct-HTTP arm of test/modelCallGuard.test.js, and that exemption is the
// reason it does nothing else: no routing decisions, no tracking, no prompt building. It takes an
// Anthropic-shaped request, performs it against Groq or Gemini, and hands back an Anthropic-shaped
// message.
//
// WHY TRANSLATE INSTEAD OF ADOPTING AN SDK. Three call sites consume the result and all three do
// `msg.content.map(b => b.text).join('')` and read `msg.usage.input_tokens`. Returning the shape
// they already expect means routing is genuinely a callModel-only concern — requirement 1 — rather
// than a change that leaks into every caller. It also keeps the dependency list unchanged: Groq is
// OpenAI-compatible, so this is a base-URL swap and `fetch` is the whole client.
//
// TO ADD A PROVIDER: add it to shared/modelProviders.js, then add a wire adapter below. Do NOT
// call it from anywhere else — the guard will fail the build, which is the intent.

import { PROVIDERS } from "../shared/modelProviders.js";

/**
 * Thrown when a provider rate-limits us and backoff did not clear it.
 *
 * A DISTINCT TYPE BECAUSE THE CALLER MUST NOT STAMP THE ROW. enrichJob only persists content_hash
 * and enriched_at on success, so a throw already leaves the row a candidate for the next pass —
 * but "already leaves" is an accident of the current code, not a guarantee, so
 * test/providerRouting.test.js pins it. Marking a row enriched because the provider was busy would
 * silently drop it from the pool forever, which is the enrichment bug that COALESCE and hasAnySignal
 * were both added to prevent, arriving by a third route.
 */
export class ProviderRateLimitError extends Error {
  constructor(message, { provider, retryAfterMs } = {}) {
    super(message);
    this.name = "ProviderRateLimitError";
    this.code = "RATE_LIMITED";
    this.status = 429;
    this.provider = provider;
    this.retryAfterMs = retryAfterMs ?? null;
  }
}

export class ProviderRequestError extends Error {
  constructor(message, { provider, status } = {}) {
    super(message);
    this.name = "ProviderRequestError";
    this.code = "PROVIDER_ERROR";
    this.provider = provider;
    this.status = status ?? null;
  }
}

// ── CLIENT-SIDE PACING ──────────────────────────────────────────────────────────────────────────
//
// Enrichment paces itself at 25 per batch with a 250ms delay — 240 req/min — so without this, the
// very first real pass would be a wall of 429s and the "does a small free model extract as well as
// Haiku" question would never get asked.
//
// IT LIVES HERE, NOT IN enrichJob, for the same reason routing does not live there: the next PUBLIC
// call site should inherit the limit rather than rediscover it. Anthropic traffic never reaches
// this module and is unaffected.
//
// ⛔ TWO AXES, AND THE ONE THIS ORIGINALLY PACED ON IS THE ONE THAT DOES NOT BIND (task AD).
//
// Groq's free tier is documented at 30 requests/minute and measured at 8,000 TOKENS/minute. An
// enrichment call is ~900 input + up to 500 output, so the account is cut off after about SIX
// calls — a quarter of the request budget. Pacing on requests alone meant the throttle sat
// comfortably under its own ceiling and handed the caller a wall of 429s anyway, which is the
// worst shape of all: a guard that reports success while the thing it guards fails.
//
// Each entry is { at, tokens }, so one window serves both limits and they cannot disagree about
// which calls are inside the minute.
const windows = new Map(); // provider id -> [{ at, tokens }] within the last minute

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Pre-send estimate of what a request will cost against a TOKENS-per-minute budget.
 *
 * Necessarily an estimate: the true count is only known after the response, and a limiter that
 * waits for it has already spent the tokens. Deliberately an OVER-estimate — output is priced at
 * the full `max_tokens` cap rather than at what the model is likely to return — because being
 * early costs latency and being late costs a 429 and a retry. reconcile() corrects it afterwards.
 */
export function estimateRequestTokens(params) {
  const text = JSON.stringify(params?.messages ?? params?.input ?? '') + String(params?.system ?? '');
  // ~4 characters per token. Good enough for pacing; token counting endpoints exist but spending a
  // network round trip to schedule a network round trip is not a trade worth making here.
  const input = Math.ceil(text.length / 4);
  const output = Number(params?.max_tokens) || 0;
  return input + output;
}

async function throttle(spec, estimatedTokens = 0) {
  const reqLimit = spec.requestsPerMinute;
  const tokLimit = spec.tokensPerMinute;
  if (!reqLimit && !tokLimit) return;

  for (;;) {
    const now = Date.now();
    const recent = (windows.get(spec.id) || []).filter(e => now - e.at < 60_000);
    windows.set(spec.id, recent);

    const reqOk = !reqLimit || recent.length < reqLimit;
    const spent = recent.reduce((s, e) => s + e.tokens, 0);
    // `<=` so a single request larger than the whole per-minute budget still goes out rather than
    // waiting forever for room that can never exist. It will 429 and be retried, which is a
    // recoverable outcome; a deadlock in the limiter is not.
    const tokOk = !tokLimit || spent + estimatedTokens <= tokLimit || recent.length === 0;

    if (reqOk && tokOk) {
      recent.push({ at: now, tokens: estimatedTokens });
      return;
    }
    // Wait exactly until the oldest entry leaves the window, plus a small margin so a clock
    // rounding difference does not spend the slot a millisecond early.
    await sleep(60_000 - (now - recent[0].at) + 50);
  }
}

/**
 * Replace the pre-send estimate for the most recent request with what the provider actually
 * billed. Without this the window drifts — every call is over-counted by the gap between
 * `max_tokens` and real output, so the limiter throttles harder than the provider does and the
 * free tier is left unused for the same reason it was previously overrun: a number nobody checked.
 */
function reconcile(spec, actualTokens) {
  const w = windows.get(spec.id);
  if (!w?.length || !Number.isFinite(actualTokens) || actualTokens <= 0) return;
  w[w.length - 1].tokens = actualTokens;
}

/** Test seam — the window is process-global, so a test that fills it would poison the next one. */
export function resetRateLimiter() {
  windows.clear();
}

/** Test seam — what the limiter believes it has spent in the last minute. */
export function rateLimiterState(providerId) {
  const now = Date.now();
  const recent = (windows.get(providerId) || []).filter(e => now - e.at < 60_000);
  return { requests: recent.length, tokens: recent.reduce((s, e) => s + e.tokens, 0) };
}

/**
 * TASK AD — list a provider's model catalogue.
 *
 * ⛔ IT LIVES HERE FOR THE REASON THIS WHOLE FILE EXISTS. modelCallGuard asserts that only the
 * transport reads a provider's base URL, because a call site that builds its own URL is traffic the
 * hostname scan cannot see. The first version of this probe sat in services/modelCatalogue.js and
 * the guard caught it immediately — correctly, even though a catalogue read is not a model call.
 * Keeping the invariant whole is worth more than the exemption would have been: one file knows
 * where a provider lives, and the catalogue probe is one more thing that file does.
 *
 * Returns the ids the provider currently serves. Throws on any transport problem, so the caller can
 * tell "the provider says this model is gone" from "the provider did not answer" — a distinction
 * the boot gate depends on and would otherwise have to guess at.
 */
export async function listProviderModels({ provider, apiKey, fetchImpl, timeoutMs = 10_000 } = {}) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new ProviderRequestError(`unknown provider "${provider}"`, { provider });
  if (spec.wire !== "openai") {
    throw new ProviderRequestError(`no catalogue endpoint for wire "${spec.wire}"`, { provider });
  }
  const doFetch = fetchImpl || globalThis.fetch;
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await doFetch(`${spec.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    if (!res.ok) {
      throw new ProviderRequestError(`GET /models -> HTTP ${res.status}`, { provider, status: res.status });
    }
    const body = await res.json();
    return (body?.data || []).map(m => m?.id).filter(Boolean);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── WIRE ADAPTERS ───────────────────────────────────────────────────────────────────────────────

/** Anthropic's `messages` content may be a string or an array of blocks; flatten to text. */
function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(b => (typeof b === "string" ? b : b?.text || "")).join("");
  return "";
}

/** Anthropic's `system` may be a string or an array of blocks (the cache_control shape). */
function flattenSystem(system) {
  if (!system) return null;
  return flattenContent(system) || null;
}

/** The shape every caller already expects, so nothing downstream has to know a provider changed. */
function asAnthropicMessage({ text, inputTokens, outputTokens, model, stopReason }) {
  return {
    id: null,
    type: "message",
    role: "assistant",
    model,
    // `content` is an ARRAY OF BLOCKS, because callers do `.content.map(b => b.text || '')`.
    // Returning a bare string here would make that produce a list of undefined and every
    // extraction would parse as empty — a silent, total failure that looks like a bad model.
    content: [{ type: "text", text: text || "" }],
    stop_reason: stopReason || "end_turn",
    // Only the two token fields exist off-Anthropic. They are reported as 0 rather than omitted so
    // trackApiCall's `usage?.input_tokens || 0` records a real zero, not a missing column.
    usage: {
      input_tokens: inputTokens || 0,
      output_tokens: outputTokens || 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

async function callOpenAiCompatible(spec, apiKey, { model, max_tokens, messages, system, temperature }) {
  const chat = [];
  const sys = flattenSystem(system);
  if (sys) chat.push({ role: "system", content: sys });
  for (const m of messages || []) chat.push({ role: m.role, content: flattenContent(m.content) });

  const res = await fetch(`${spec.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: chat,
      max_tokens: max_tokens ?? 1024,
      ...(temperature == null ? {} : { temperature }),
    }),
  });
  await assertOk(res, spec);
  const body = await res.json();
  return asAnthropicMessage({
    text: body?.choices?.[0]?.message?.content || "",
    inputTokens: body?.usage?.prompt_tokens,
    outputTokens: body?.usage?.completion_tokens,
    stopReason: body?.choices?.[0]?.finish_reason,
    model,
  });
}

async function callGemini(spec, apiKey, { model, max_tokens, messages, system, temperature }) {
  const contents = (messages || []).map(m => ({
    // Gemini's vocabulary is user/model, not user/assistant.
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: flattenContent(m.content) }],
  }));
  const sys = flattenSystem(system);

  const res = await fetch(`${spec.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    // The key goes in a HEADER, not the query string, so it cannot end up in a proxy access log.
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents,
      ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
      generationConfig: {
        maxOutputTokens: max_tokens ?? 1024,
        ...(temperature == null ? {} : { temperature }),
      },
    }),
  });
  await assertOk(res, spec);
  const body = await res.json();
  const parts = body?.candidates?.[0]?.content?.parts || [];
  return asAnthropicMessage({
    text: parts.map(p => p?.text || "").join(""),
    inputTokens: body?.usageMetadata?.promptTokenCount,
    outputTokens: body?.usageMetadata?.candidatesTokenCount,
    stopReason: body?.candidates?.[0]?.finishReason,
    model,
  });
}

const ADAPTERS = { openai: callOpenAiCompatible, gemini: callGemini };

async function assertOk(res, spec) {
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  if (res.status === 429) {
    const header = res.headers?.get?.("retry-after");
    const retryAfterMs = header && Number.isFinite(Number(header)) ? Number(header) * 1000 : null;
    throw new ProviderRateLimitError(
      `${spec.label} rate limited: ${text.slice(0, 200)}`,
      { provider: spec.id, retryAfterMs },
    );
  }
  throw new ProviderRequestError(
    `${spec.label} returned ${res.status}: ${text.slice(0, 300)}`,
    { provider: spec.id, status: res.status },
  );
}

// ── THE ENTRY POINT ─────────────────────────────────────────────────────────────────────────────

/** How many times a 429 is retried before it is handed back to the caller as retryable. */
const MAX_RATE_LIMIT_RETRIES = 3;

// ── PARAMS THIS TRANSPORT CAN ACTUALLY HONOUR ───────────────────────────────────────────────────
//
// The adapters read exactly these. Anything else an Anthropic call site passes would be SILENTLY
// DROPPED on the way out — and a request that succeeds while quietly ignoring half of what it was
// asked to do is worse than one that fails, because nothing surfaces it. `tools` is the sharp case:
// a call site that routes tool use to a free tier would get a plain text answer back, parse it as
// a refusal, and look like a bad model rather than a lost parameter.
//
// So the unsupported set THROWS. Adding a param here means teaching both adapters to translate it,
// which is the work the throw exists to force.
const SUPPORTED_PARAMS = new Set(["model", "max_tokens", "messages", "system", "temperature"]);

function assertTranslatable(params, spec) {
  const unsupported = Object.keys(params).filter(k => !SUPPORTED_PARAMS.has(k));
  if (!unsupported.length) return;
  throw new ProviderRequestError(
    `cannot route to ${spec.label}: ${unsupported.join(", ")} ${unsupported.length === 1 ? "has" : "have"} ` +
    `no translation in this transport and would be dropped silently. Either teach the adapters to ` +
    `translate ${unsupported.length === 1 ? "it" : "them"}, or leave this call site on Anthropic ` +
    `(dataClass: CANDIDATE, or ENRICH_PROVIDER unset).`,
    { provider: spec.id },
  );
}

/**
 * TASK AD ITEM 3 — a reasoning model with a small `max_tokens` fails SILENTLY, so refuse it loudly.
 *
 * `max_tokens` bounds reasoning AND answer together. Set it low and the budget is spent thinking
 * before the answer begins: HTTP 200, success=1, a clean usage row, and nothing usable. Measured
 * twice on this pipeline, both at exactly 500 — an empty extraction 49 times in 50, and 10 of 10
 * truncated at precisely 500 output tokens.
 *
 * Nothing downstream can tell that apart from "this posting says nothing", which is why it is
 * refused here instead of documented somewhere. The check is a no-op for non-reasoning models, so
 * enrichJob's max_tokens: 500 on Haiku is untouched.
 */
function assertOutputBudget(params, spec) {
  const model = params?.model;
  const floor = spec.minOutputTokens;
  if (!floor || !spec.reasoningModels?.includes(model)) return;
  // An ABSENT max_tokens is not the trap and must not be refused: the provider then applies its
  // own default, which on a reasoning model is generous. The measured failure is an explicitly
  // SMALL ceiling, so only an explicit value is checked.
  if (params?.max_tokens == null) return;
  const asked = Number(params.max_tokens) || 0;
  if (asked >= floor) return;
  throw new ProviderRequestError(
    `${spec.label}/${model} is a REASONING model and max_tokens: ${asked} is below the ${floor} ` +
    `floor. max_tokens bounds the reasoning and the answer together, so this would very likely ` +
    `return HTTP 200 with an empty or truncated extraction and record it as a success — measured ` +
    `on this pipeline at exactly this setting: 49 empty extractions in 50, and 10 of 10 truncated ` +
    `at precisely 500 output tokens. Raise max_tokens to at least ${floor}, or leave this call ` +
    `site on a non-reasoning model.`,
    { provider: spec.id },
  );
}

/**
 * Perform an Anthropic-shaped request against a non-Anthropic provider.
 *
 * ON 429 IT BACKS OFF AND RETRIES, then throws ProviderRateLimitError if the limit is still there.
 * It never returns a partial or empty result in that case: an empty extraction would be treated as
 * a failure by enrichJob's hasAnySignal check anyway, but only by luck, and "the provider was busy"
 * must never be recorded as "this posting says nothing".
 */
export async function callProvider({ provider, apiKey, params, fetchImpl } = {}) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new ProviderRequestError(`unknown provider "${provider}"`, { provider });
  const adapter = ADAPTERS[spec.wire];
  if (!adapter) throw new ProviderRequestError(`no adapter for wire "${spec.wire}"`, { provider });
  if (!apiKey) throw new ProviderRequestError(`${spec.envKey} is required`, { provider });
  assertTranslatable(params || {}, spec);
  assertOutputBudget(params || {}, spec);

  // Injected only by tests. The real path uses global fetch, which is what the guard scans for.
  const originalFetch = globalThis.fetch;
  if (fetchImpl) globalThis.fetch = fetchImpl;

  try {
    let lastError = null;
    const estimated = estimateRequestTokens(params);
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      await throttle(spec, estimated);
      try {
        const result = await adapter(spec, apiKey, params);
        // Correct the estimate with what was actually billed, so the window tracks the provider's
        // accounting rather than our guess at it.
        const used = (result?.usage?.input_tokens ?? 0) + (result?.usage?.output_tokens ?? 0);
        reconcile(spec, used);
        return result;
      } catch (e) {
        if (!(e instanceof ProviderRateLimitError)) throw e;
        lastError = e;
        if (attempt === MAX_RATE_LIMIT_RETRIES) break;
        // Honour Retry-After when the provider sends one; otherwise 1s, 2s, 4s with jitter, so a
        // fleet of callers does not resynchronise onto the same retry instant.
        const backoff = e.retryAfterMs ?? (1000 * 2 ** attempt + Math.floor(Math.random() * 250));
        await sleep(backoff);
      }
    }
    throw lastError;
  } finally {
    if (fetchImpl) globalThis.fetch = originalFetch;
  }
}
