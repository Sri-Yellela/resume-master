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
// Groq allows 30 req/min. Enrichment paces itself at 25 per batch with a 250ms delay — 240 req/min,
// eight times the ceiling — so without this, the very first real pass would be a wall of 429s and
// the "does an 8B model extract as well as Haiku" question would never get asked.
//
// IT LIVES HERE, NOT IN enrichJob, for the same reason routing does not live there: the next PUBLIC
// call site should inherit the limit rather than rediscover it. Anthropic traffic never reaches
// this module and is unaffected.
const windows = new Map(); // provider id -> array of request timestamps within the last minute

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function throttle(spec) {
  const limit = spec.requestsPerMinute;
  if (!limit) return;
  for (;;) {
    const now = Date.now();
    const recent = (windows.get(spec.id) || []).filter(t => now - t < 60_000);
    windows.set(spec.id, recent);
    if (recent.length < limit) {
      recent.push(now);
      return;
    }
    // Wait exactly until the oldest request leaves the window, plus a small margin so a clock
    // rounding difference does not spend the slot a millisecond early.
    await sleep(60_000 - (now - recent[0]) + 50);
  }
}

/** Test seam — the window is process-global, so a test that fills it would poison the next one. */
export function resetRateLimiter() {
  windows.clear();
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

  // Injected only by tests. The real path uses global fetch, which is what the guard scans for.
  const originalFetch = globalThis.fetch;
  if (fetchImpl) globalThis.fetch = fetchImpl;

  try {
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      await throttle(spec);
      try {
        return await adapter(spec, apiKey, params);
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
