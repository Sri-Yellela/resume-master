// The one path every model call in this service takes.
//
// ⛔ STATELESS, AND IT LOGS NO CONTENT. A résumé carries a home address, a phone number and an
// employment history. This service processes it and returns the result; it does not retain it.
// What leaves this function besides the message is a USAGE RECORD — purpose, model, token counts,
// duration, success — and never a prompt, a response or any fragment of either. The caller
// (e.g. draft, which records usage_events) gets that record in the response and meters it itself.
//
// Candidate data is never routed off Anthropic here: this service has exactly one provider.
import Anthropic from "@anthropic-ai/sdk";

export const MODEL_SONNET = "claude-sonnet-5";

// ── D70 Phase 3: AUTOMATIC RETRIES ARE CAPPED AT ONE, AND THE CONTRACT SAYS SO ──────────────────
//
// The SDK retries a failed request by itself — a connection error, 408, 409, 429 or 5xx — TWICE by
// default, before callAnthropic ever sees the failure. A transport retry is not free here: the
// request is a whole résumé generation, and a retry after the upstream had already started (a 5xx
// or a dropped connection mid-response) can bill the input — and any output it produced — a
// SECOND and THIRD time for the one document the caller asked for. draft's policy (D70 Phase 3) is
// "cap automatic retries at one, and say so", so the number is set explicitly rather than
// inherited from whatever the SDK's default happens to be in its next release, and docs/API.md
// states it.
//
// Not an environment lever: there is no retry setting anywhere else in this service, and a
// per-deploy knob on how many times a caller's request may be billed is the wrong kind of freedom.
// Anything beyond the one retry is the caller's decision, made from `retryable` on the error.
export const MODEL_MAX_RETRIES = 1;

/**
 * The service's one SDK client. Null with no key — a supported state: the deterministic routes
 * still serve and the model routes answer 503 model_unconfigured.
 * @param Sdk  the SDK's constructor, injectable so the configuration is testable with no network
 */
export function createAnthropicClient({ apiKey, Sdk = Anthropic } = {}) {
  if (!apiKey) return null;
  return new Sdk({ apiKey, maxRetries: MODEL_MAX_RETRIES });
}
export const MODEL_HAIKU = "claude-haiku-4-5-20251001";

/** A usage record: what was spent, never what was said. */
function usageRecord({ purpose, model, message, startedAt, success }) {
  const u = message?.usage || {};
  return {
    purpose,
    model,
    success,
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    // The API's own field names. `cache_creation_input_tokens` was once read under a wrong name in
    // draft and every cache write costed as $0 — so they are passed through verbatim, not renamed.
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    duration_ms: Date.now() - startedAt,
  };
}

/**
 * Call the model. Returns { message, usage }. On failure throws a ModelCallError carrying the same
 * usage record (a failed call is a fact worth metering) and whether a retry could ever succeed.
 */
export async function callAnthropic(client, { purpose, model, ...params }) {
  if (!purpose) throw new Error("callAnthropic: `purpose` is required — it is how spend is attributed");
  if (!model) throw new Error(`callAnthropic(${purpose}): no model`);
  if (!client) throw new ModelUnconfiguredError(purpose);
  const startedAt = Date.now();
  try {
    const message = await client.messages.create({ model, ...params });
    return { message, usage: usageRecord({ purpose, model, message, startedAt, success: true }) };
  } catch (e) {
    throw new ModelCallError(e, usageRecord({ purpose, model, message: null, startedAt, success: false }));
  }
}

export function textOf(message) {
  return (message?.content || []).map(b => b.text || "").join("");
}

export class ModelUnconfiguredError extends Error {
  constructor(purpose) {
    super(`no model client configured for ${purpose} — ANTHROPIC_API_KEY is not set`);
    this.name = "ModelUnconfiguredError";
    this.code = "model_unconfigured";
    this.permanent = true;
  }
}

export class ModelCallError extends Error {
  constructor(cause, usage) {
    // The upstream's own message, which is the provider's wording about the failure — never ours
    // about the payload. Truncated, because a provider error can echo request fragments.
    super(String(cause?.message ?? cause).slice(0, 300));
    this.name = "ModelCallError";
    this.code = "upstream_model_failure";
    this.status = cause?.status ?? cause?.statusCode ?? null;
    this.permanent = isPermanentModelFailure(cause);
    this.usage = usage;
  }
}

// ── IS THIS WORTH RETRYING? ─────────────────────────────────────────────────────────────────────
//
// Carried across from draft's services/modelCall.js unchanged, because the distinction is now a
// promise to every caller: "Please try again" for an exhausted billing balance is a message that
// can never be true. draft learnt that on /api/import/job, whose unfunded balance read as flakiness.
//
// ⛔ MATCHES ON THE PROVIDER'S OWN WORDING, which is fragile, so it fails SAFE: anything it does
// not recognise is treated as retryable. A false "retryable" costs one pointless retry; a false
// "permanent" would tell a caller to give up on a blip.
const PERMANENT_SIGNATURES = [
  /credit balance is too low/i,        // Anthropic, billing exhausted
  /insufficient[_ ]quota/i,            // quota consumed, not rate-limited
  /billing/i,
  /invalid[_ ]api[_ ]key/i,
  /authentication[_ ]error/i,
  /permission[_ ]error/i,
];

/**
 * True when retrying CANNOT succeed without a human changing something — funding an account,
 * fixing a key, granting access.
 *
 * ⛔ A 429 is NOT permanent. Rate limiting is the case retrying exists for, and it carries billing
 * words often enough ("quota") that it has to be excluded before the signature scan, not after.
 */
// ⛔ AND A REJECTED REQUEST IS PERMANENT. Found in Phase B's first live run: a PDF the provider called
// "not valid" came back 400 invalid_request_error, and this reported it retryable — so a caller was
// told to retry a document that fails identically every time. The status codes that mean "this
// request, as sent, can never succeed" are the ones draft's failureAttribution already treats as
// permanent; only the provider-wording scan used to run here.
const PERMANENT_STATUS = new Set([400, 401, 403, 404, 413, 422]);

export function isPermanentModelFailure(err) {
  const status = err?.status ?? err?.statusCode ?? null;
  if (status === 429) return false;
  if (PERMANENT_STATUS.has(status)) return true;
  const text = `${err?.message ?? ""} ${err?.error?.message ?? ""}`;
  return PERMANENT_SIGNATURES.some(re => re.test(text));
}
