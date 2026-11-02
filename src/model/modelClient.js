// D123 P3 · A PROVIDER-NEUTRAL MODEL CLIENT — the tailoring call's model chosen by configuration, per task.
//
// The Anthropic SDK client stays the service's client (src/model/anthropicCall.js). This adds ONE other kind, an
// OpenAI-compatible chat-completions endpoint (NVIDIA's hosted Nemotron, OpenRouter, Together, a vLLM server …), and
// gives it the SAME surface the SDK has — `messages.create({ model, max_tokens, system, messages })` returning
// `{ content: [{ type: "text", text }], usage: { input_tokens, output_tokens } }` — so callAnthropic, the usage record,
// the model_usage ledger and the attempt counter work unchanged. A model with no price in src/model/prices.js costs
// NULL in the ledger (a visible gap), never $0.
//
// Configuration (all optional; absent = every call stays on Anthropic, byte for byte):
//   RM_TAILOR_PROVIDER        "anthropic" (default) | "openai-compatible" — the lean tailoring call's provider
//   RM_TAILOR_MODEL           the model id on that provider (required with openai-compatible)
//   RM_OPENAI_COMPAT_BASE_URL e.g. https://integrate.api.nvidia.com/v1 — https only
//   RM_OPENAI_COMPAT_API_KEY  that provider's own key (never an Anthropic key, never logged)
//   RM_OPEN_MODEL             the model id served when a request names options.model "open" (contract 1.8.0)
// The repair call (after a failed check) stays on Anthropic's stronger model: D123 P3, "falling back to the Sonnet tier".
//
// ⛔ D123 P5's terms note: a candidate's résumé goes to this provider when it is configured — the privacy policy must
// name the provider before production sets it. Never train on another provider's outputs.
import { noteAttempt } from "./anthropicCall.js";

export const PROVIDERS = Object.freeze(["anthropic", "openai-compatible"]);
/** The per-request model choices a caller may send as options.model (contract 1.8.0). */
export const MODEL_CHOICES = Object.freeze(["haiku", "sonnet", "open"]);

/** Whether the "open" choice can be served: the OpenAI-compatible endpoint, its key and a model id are all set. */
export function openConfigured(env = process.env) {
  return !!(env.RM_OPENAI_COMPAT_BASE_URL && env.RM_OPENAI_COMPAT_API_KEY && env.RM_OPEN_MODEL);
}

function systemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map(b => b?.text || "").join("\n\n");
}

/** An OpenAI-compatible client wearing the Anthropic SDK's `messages.create` shape. */
export function createOpenAiCompatibleClient({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  const base = String(baseUrl || "").replace(/\/$/, "");
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base)) {
    throw new Error("RM_OPENAI_COMPAT_BASE_URL must be https (or a localhost server)");
  }
  if (!apiKey) throw new Error("RM_OPENAI_COMPAT_API_KEY is not set");
  const client = {
    provider: "openai-compatible",
    messages: {
      async create({ model, max_tokens, system, messages, temperature }) {
        const body = {
          model, max_tokens,
          ...(temperature !== undefined ? { temperature } : {}),
          messages: [
            ...(system ? [{ role: "system", content: systemText(system) }] : []),
            ...(messages || []).map(m => ({ role: m.role, content: typeof m.content === "string" ? m.content : (m.content || []).map(c => c.text || "").join("") })),
          ],
        };
        noteAttempt();
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        let res;
        try {
          res = await fetchImpl(`${base}/chat/completions`, {
            method: "POST", signal: ctl.signal,
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(body),
          });
        } finally { clearTimeout(timer); }
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          // The provider's own words, truncated by ModelCallError — never the request.
          throw Object.assign(new Error(String(json?.error?.message || json?.message || `HTTP ${res.status}`)), { status: res.status });
        }
        const text = json?.choices?.[0]?.message?.content ?? "";
        return {
          content: [{ type: "text", text: String(text) }],
          usage: { input_tokens: json?.usage?.prompt_tokens ?? 0, output_tokens: json?.usage?.completion_tokens ?? 0 },
        };
      },
    },
  };
  client[Symbol.for("resume-master.countsAttempts")] = true;
  return client;
}

/**
 * The tailoring call's { client, model } from configuration: the Anthropic client and the default model unless
 * RM_TAILOR_PROVIDER says otherwise. A broken configuration is an ERROR at the first call, never a silent fallback to
 * another provider (that would send a résumé somewhere nobody chose).
 */
export function tailorRoute(env = process.env, { anthropicClient, defaultModel, fetchImpl, choice = null, models = {} } = {}) {
  // D123 (owner 11-01, contract 1.8.0): the CALLER may name the model per request — "haiku" | "sonnet" | "open". A named
  // choice overrides RM_TAILOR_PROVIDER for that request; "open" is the OpenAI-compatible provider configured here
  // (RM_OPENAI_COMPAT_BASE_URL / _API_KEY + RM_OPEN_MODEL) and is refused when it is not configured.
  if (choice) {
    if (!MODEL_CHOICES.includes(choice)) throw new Error(`options.model must be one of ${MODEL_CHOICES.join(", ")}`);
    if (choice === "haiku" || choice === "sonnet") return { provider: "anthropic", client: anthropicClient, model: models[choice], choice };
    if (!openConfigured(env)) throw Object.assign(new Error('options.model "open" is not configured on this service'), { code: "model_not_available" });
    const client = createOpenAiCompatibleClient({ baseUrl: env.RM_OPENAI_COMPAT_BASE_URL, apiKey: env.RM_OPENAI_COMPAT_API_KEY, fetchImpl });
    return { provider: "openai-compatible", client, model: env.RM_OPEN_MODEL, choice };
  }
  const provider = String(env.RM_TAILOR_PROVIDER || "anthropic").trim();
  if (!PROVIDERS.includes(provider)) throw new Error(`RM_TAILOR_PROVIDER must be one of ${PROVIDERS.join(", ")}`);
  if (provider === "anthropic") return { provider, client: anthropicClient, model: env.RM_TAILOR_MODEL || defaultModel };
  if (!env.RM_TAILOR_MODEL) throw new Error("RM_TAILOR_MODEL is required with RM_TAILOR_PROVIDER=openai-compatible");
  const client = createOpenAiCompatibleClient({ baseUrl: env.RM_OPENAI_COMPAT_BASE_URL, apiKey: env.RM_OPENAI_COMPAT_API_KEY, fetchImpl });
  return { provider, client, model: env.RM_TAILOR_MODEL };
}
