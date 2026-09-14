// services/modelCatalogue.js
// PURPOSE (task AD, requirement 2): at startup, ask each provider whether the model this codebase
// is PINNED to still exists. If a provider says it does not, refuse to start and say which one.
//
// ── WHY THIS EXISTS, IN THIS REPOSITORY'S OWN WORDS ─────────────────────────────────────────────
//
// shared/anthropicModels.js opens with the incident: a Haiku bump updated 8 of ~20 inline model
// literals and left Sonnet on `claude-sonnet-4-20250514`, which Anthropic retired on 2026-06-15.
// Every Sonnet call then returned 404 not_found_error, and resume generation, resume enhancement,
// PDF parsing and standalone generation degraded silently FOR ABOUT TWO MONTHS.
//
// It happened again on the free tier: `llama-3.1-8b-instant` was the pinned default until the
// first real call was attempted, and `GET /openai/v1/models` showed the entire llama family gone.
// Task A was built, guarded and tested against fetch stubs the whole time — and a stub answers for
// any model id, including one the platform has retired.
//
// A pinned model id is a dependency on someone else's product decision. The only thing that
// detects its removal is asking. This asks, once, at boot.
//
// ⛔ IT DOES NOT AUTO-UPDATE, AND THAT IS THE POINT OF THE TASK.
//
// Picking "whatever is available" is how you silently switch to a model that behaves differently.
// Measured: openai/gpt-oss-20b returns HTTP 200 with an EMPTY extraction 49 times in 50 at
// max_tokens 500. An auto-updater would have "fixed" the 404 by quietly enriching nothing — the
// green-dashboard failure this project keeps finding, with the repair mechanism as its cause.
// So: report, refuse, and let a human choose the replacement.
//
// ⛔ AND IT DISTINGUISHES "GONE" FROM "UNREACHABLE".
//
// A 404 from a provider that answered is evidence. A DNS failure, a timeout or a 500 is not — it
// is evidence about the network. Refusing to boot on a transient blip would convert a momentary
// outage into a hard one, which is strictly worse than the problem being solved. Unreachable warns
// loudly and continues; only an answered "no such model" refuses.

import { PROVIDERS } from "../shared/modelProviders.js";
import { listProviderModels } from "./providerTransport.js";

/** One model's verdict. `gone` is the only one that stops a boot. */
export const LIVENESS = Object.freeze({
  LIVE: "live",
  GONE: "gone",
  UNREACHABLE: "unreachable",
  UNCONFIGURED: "unconfigured",
  /**
   * The provider is configured and reachable, but this transport has no catalogue endpoint for its
   * wire — so the pin CANNOT BE CHECKED. Distinct from UNREACHABLE on purpose: reporting an
   * un-probeable provider as a network failure is a warning that fires on every boot and can never
   * be cleared, which is how a panel teaches people to ignore it.
   */
  UNSUPPORTED: "unsupported",
});

const TIMEOUT_MS = 10_000;

async function withTimeout(promise, ms = TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * Anthropic: GET /v1/models/{id} through the SDK. A 404 is the provider stating the model does not
 * exist; anything else is a transport problem and is reported as such.
 */
async function checkAnthropic(client, modelId) {
  if (!client) return { status: LIVENESS.UNCONFIGURED, detail: "no Anthropic client" };
  try {
    const m = await withTimeout(client.models.retrieve(modelId));
    return { status: LIVENESS.LIVE, detail: m?.display_name || m?.id || modelId };
  } catch (e) {
    // The SDK raises NotFoundError for 404. Match on the status field rather than the class so a
    // fetch-stubbed test and the real SDK take the same branch.
    if (e?.status === 404) {
      return { status: LIVENESS.GONE, detail: e?.message || "404 not_found_error" };
    }
    return { status: LIVENESS.UNREACHABLE, detail: `${e?.status ?? ""} ${e?.message || e}`.trim() };
  }
}

/**
 * OpenAI-wire providers (Groq): GET {baseUrl}/models returns the whole catalogue, so membership is
 * checkable in one call. This is the exact request that revealed the llama family had been removed.
 */
async function checkOpenAiWire(spec, apiKey, modelId, fetchImpl) {
  try {
    // Through the transport, never a URL built here: modelCallGuard asserts that only
    // providerTransport.js reads a provider's base URL, and it caught the first version of this
    // function doing exactly that. See listProviderModels.
    const ids = await withTimeout(listProviderModels({ provider: spec.id, apiKey, fetchImpl }));
    if (!ids.length) return { status: LIVENESS.UNREACHABLE, detail: "catalogue came back empty" };
    return ids.includes(modelId)
      ? { status: LIVENESS.LIVE, detail: `${ids.length} models listed` }
      : { status: LIVENESS.GONE, detail: `not in the ${ids.length}-model catalogue` };
  } catch (e) {
    return { status: LIVENESS.UNREACHABLE, detail: String(e?.message || e) };
  }
}

/**
 * Check every pinned model that has a configured key.
 *
 * @param {object}  o
 * @param {object}  [o.anthropic]   the Anthropic SDK client, or null
 * @param {string[]}[o.anthropicModels] Anthropic model ids this codebase pins
 * @param {object}  [o.env]         defaults to process.env
 * @param {Function}[o.fetchImpl]   injected by tests
 * @returns {Promise<Array<{provider, model, status, detail}>>}
 */
export async function checkPinnedModels({
  anthropic = null, anthropicModels = [], env = process.env, fetchImpl = null,
} = {}) {
  const results = [];

  for (const modelId of anthropicModels) {
    const r = anthropic
      ? await checkAnthropic(anthropic, modelId)
      : { status: LIVENESS.UNCONFIGURED, detail: "ANTHROPIC_KEY unset" };
    results.push({ provider: "anthropic", model: modelId, ...r });
  }

  for (const spec of Object.values(PROVIDERS)) {
    // The same lookup resolveProvider() uses — one place decides what "configured" means.
    const apiKey = env[spec.envKey];
    if (!apiKey) {
      // Not configured is not a failure — this provider is simply not in use. Saying so is still
      // worth doing: "unconfigured" and "broken" reading alike is how Jobo hid for months.
      results.push({ provider: spec.id, model: spec.defaultModel,
        status: LIVENESS.UNCONFIGURED, detail: `${spec.envKey} unset` });
      continue;
    }
    const r = spec.wire === "openai"
      ? await checkOpenAiWire(spec, apiKey, spec.defaultModel, fetchImpl)
      : { status: LIVENESS.UNSUPPORTED, detail: `no catalogue endpoint for wire "${spec.wire}"` };
    results.push({ provider: spec.id, model: spec.defaultModel, ...r });
  }

  return results;
}

/**
 * Boot gate. Logs every verdict, then throws if any provider ANSWERED that a pinned model is gone.
 *
 * Returns the results so a caller can report them; throwing is the whole contract, so callers must
 * not swallow it. The message names the model and the provider because "refuse to start and say
 * so" is useless if the operator then has to go looking for which one.
 */
export async function assertPinnedModelsLive(opts = {}) {
  const results = await checkPinnedModels(opts);
  const log = opts.log || console;

  for (const r of results) {
    const line = `[models] ${r.provider}/${r.model}: ${r.status.toUpperCase()}${r.detail ? ` — ${r.detail}` : ""}`;
    if (r.status === LIVENESS.GONE) {
      log.error(line);
    } else if (r.status === LIVENESS.UNREACHABLE) {
      log.warn(line + "  (not treated as a failure — this is evidence about the network, not the catalogue)");
    } else if (typeof log.log === "function") {
      // ⛔ NOT `log.log?.(line) ?? log.warn(line)`. console.log RETURNS undefined, so `??` fired the
      // fallback as well and every verdict printed TWICE — caught only by reading the real output.
      log.log(line);
    } else {
      log.warn(line);
    }
  }

  const gone = results.filter(r => r.status === LIVENESS.GONE);
  if (gone.length) {
    const err = new Error(
      `REFUSING TO START: ${gone.length} pinned model(s) no longer exist at their provider:\n` +
      gone.map(g => `  ${g.provider}/${g.model} — ${g.detail}`).join("\n") +
      `\n\nPick a replacement deliberately and update shared/anthropicModels.js or ` +
      `shared/modelProviders.js. This does NOT substitute one automatically: a model chosen for ` +
      `you is a model whose behaviour nobody checked, and the last one that happened returned ` +
      `HTTP 200 with an empty extraction 49 times in 50.`
    );
    err.code = "PINNED_MODEL_GONE";
    err.results = results;
    throw err;
  }
  return results;
}
