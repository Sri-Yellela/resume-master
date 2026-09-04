// shared/modelProviders.js
// PURPOSE: The catalog of NON-Anthropic model providers — which exist, what they are pinned to,
// what they cost, and how fast they may be called. Pure data and pure functions: no network, no
// SDK, no env reads beyond the helpers at the bottom, so it is safe to import anywhere.
//
// WHY THIS FILE EXISTS: enrichment is 60.2% of all model spend ($3.32 over 1302 calls) and it
// reads job descriptions companies published about themselves. There is no candidate data in it.
// Routing that traffic to a free tier costs nothing in privacy terms and removes the largest line
// item — but only if the routing decision is made by WHOSE DATA IT IS, which is checkable, rather
// than by what a regex finds in a payload, which is not.
//
// ── THE SPLIT ───────────────────────────────────────────────────────────────────────────────────
//
// Every call site declares a DATA CLASS. PUBLIC may be routed to a free tier. CANDIDATE may not,
// ever, and the default is CANDIDATE so a site that declares nothing stays on Anthropic — the
// whitelist direction. A blacklist here fails silently, and the thing it would leak is a real
// person's home address and work authorisation.
//
// ⚠ FREE TIERS ARE OFTEN FUNDED BY YOUR PROMPTS. Groq does not state its free-tier training policy
// on a public page either way. That is precisely why the PUBLIC/CANDIDATE split is structural
// rather than best-effort: if a free tier does train on what it is sent, the only thing it can
// learn from this repo is the text of job adverts that were already on the open web.

/** What a call site is sending. Declared per call site; the router honours it. */
export const DATA_CLASS = Object.freeze({
  /** Text the company published about itself — job descriptions, titles, requirements. */
  PUBLIC: "public",
  /** Anything derived from a person: resumes, profiles, cover letters, parsed PDFs. */
  CANDIDATE: "candidate",
});

export const PROVIDER = Object.freeze({
  ANTHROPIC: "anthropic",
  GROQ: "groq",
  GOOGLE: "google",
});

// ── PINNED MODELS ───────────────────────────────────────────────────────────────────────────────
//
// ⛔ PIN THE MODEL ID. Free-tier catalogs churn hard: one provider deleted most of its free models
// on a single day and every caller naming an exact model went dark. The failure this creates must
// be LOUD — an unresolvable model throws rather than falling back to Anthropic, because a quiet
// fallback means the free tier silently stops being used and the bill silently returns while every
// dashboard stays green. That is the cacheJoboFeed shape ("sync complete — 0 jobs cached") and it
// went unnoticed for months.
//
// A model not listed here cannot be selected. Adding one is a deliberate edit that also forces a
// pricing decision, which is the point: usage_events cannot reconcile against a model it cannot
// price, and calculateCost's loud unknown-key warning is the only thing that catches that.

export const PROVIDERS = Object.freeze({
  [PROVIDER.GROQ]: Object.freeze({
    id: PROVIDER.GROQ,
    label: "Groq",
    /** Absent key is a LOUD fallback to Anthropic, never a skip. See resolveProvider(). */
    envKey: "GROQ_API_KEY",
    // Fully OpenAI-compatible, so this is a base-URL swap and needs no SDK. Reaching it with
    // `fetch` is deliberate: no new dependency, and the guard in test/modelCallGuard.test.js
    // scans for this hostname so a second, untracked caller cannot appear.
    wire: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.1-8b-instant",
    models: Object.freeze(["llama-3.1-8b-instant", "llama-3.3-70b-versatile"]),
    // RATE LIMITS ARE THE CONSTRAINT HERE, NOT PRICE. 30 req/min is the binding one: enrichment
    // paces at 25 per batch / 250ms, which is 240 req/min — eight times over. The transport
    // throttles to this rather than leaving it to each caller, so a future PUBLIC call site
    // inherits it instead of rediscovering it as a wall of 429s.
    requestsPerMinute: 30,
    requestsPerDay: 14_400,
  }),
  [PROVIDER.GOOGLE]: Object.freeze({
    id: PROVIDER.GOOGLE,
    label: "Gemini",
    envKey: "GOOGLE_API_KEY",
    wire: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.0-flash",
    models: Object.freeze(["gemini-2.0-flash", "gemini-2.0-flash-lite"]),
    // Documented free-tier limits are lower per-minute but far higher per-day than Groq's.
    requestsPerMinute: 15,
    requestsPerDay: 1_500,
  }),
});

// ── PRICING ─────────────────────────────────────────────────────────────────────────────────────
//
// EXPLICIT $0, NOT AN ABSENT ENTRY AND NOT AN EXCEPTION. calculateCost() warns loudly on a model it
// cannot price, which is correct for a dead Anthropic ID and wrong for a free-tier one: the warning
// would fire on every single enrichment call, and the only way to quiet it would be to special-case
// the free tier inside the pricing function — at which point a genuinely unknown model gets the
// same silence. So free models are priced, at zero, and stay reconcilable: SUM(cost_usd) over
// usage_events still equals the real bill, and the row count still equals the real traffic.
//
// These are ZERO BECAUSE THE TIER IS FREE, not because the cost is unknown. If a paid tier is ever
// adopted, these become real numbers here and nothing else changes.
export const FREE_TIER_PRICING = Object.freeze({
  "llama-3.1-8b-instant":   Object.freeze({ input: 0, output: 0, cache_read: 0, cache_write: 0 }),
  "llama-3.3-70b-versatile": Object.freeze({ input: 0, output: 0, cache_read: 0, cache_write: 0 }),
  "gemini-2.0-flash":       Object.freeze({ input: 0, output: 0, cache_read: 0, cache_write: 0 }),
  "gemini-2.0-flash-lite":  Object.freeze({ input: 0, output: 0, cache_read: 0, cache_write: 0 }),
});

/** Which provider a model id belongs to, or null. Used to label usage_events rows. */
export function providerForModel(model) {
  for (const p of Object.values(PROVIDERS)) {
    if (p.models.includes(model)) return p.id;
  }
  return null;
}

/**
 * Resolve the configured provider for PUBLIC traffic from env.
 *
 * Returns `{ provider, model, reason }`. `provider` is ANTHROPIC whenever the free tier is not
 * usable — but never silently: `reason` says which of the four cases applied, and the caller logs
 * it. The four are distinguishable on purpose, because "not configured" and "configured but the
 * key is missing" are different bugs and only one of them is a mistake.
 *
 * @param {object} env  process.env, injected so this is testable without mutating the real one.
 */
export function resolveProvider(env = {}) {
  const requested = String(env.ENRICH_PROVIDER || "").trim().toLowerCase();

  if (!requested || requested === PROVIDER.ANTHROPIC) {
    return { provider: PROVIDER.ANTHROPIC, model: null, reason: "not_configured" };
  }

  const spec = PROVIDERS[requested];
  if (!spec) {
    // An unknown provider NAME is a typo in a deploy config, and the deploy that contains it will
    // otherwise look identical to a working one. Loud, and it falls back rather than throwing:
    // a mistyped optional optimisation must not take enrichment down.
    return {
      provider: PROVIDER.ANTHROPIC, model: null, reason: "unknown_provider",
      detail: `ENRICH_PROVIDER="${requested}" is not a provider. Known: ${Object.keys(PROVIDERS).join(", ")}.`,
    };
  }

  if (!env[spec.envKey]) {
    return {
      provider: PROVIDER.ANTHROPIC, model: null, reason: "missing_key",
      detail: `ENRICH_PROVIDER=${requested} but ${spec.envKey} is not set.`,
    };
  }

  // ⛔ THE PINNED MODEL. An explicitly requested model that is not in the catalog THROWS — it does
  // not fall back. Requirement 6: an unavailable model is a loud failure, never a quiet fallback to
  // nothing. This is safe to throw on because enrichJob's failure path leaves content_hash and
  // enriched_at unset, so every row it touches stays a candidate for the next run.
  const requestedModel = String(env.ENRICH_MODEL || "").trim();
  if (requestedModel && !spec.models.includes(requestedModel)) {
    const e = new Error(
      `ENRICH_MODEL="${requestedModel}" is not a pinned model for ${spec.label}. ` +
      `Pinned: ${spec.models.join(", ")}. Add it to PROVIDERS in shared/modelProviders.js — which ` +
      `also forces a pricing entry, without which usage_events cannot reconcile.`
    );
    e.code = "UNPINNED_MODEL";
    throw e;
  }

  return { provider: spec.id, model: requestedModel || spec.defaultModel, reason: "configured" };
}
