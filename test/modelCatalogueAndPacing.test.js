// ── TASK AD — the two follow-ups from the provider-verdict session, and the max_tokens trap ─────
//
// 1. PACE ON TOKENS, NOT REQUESTS. The transport throttled on `requestsPerMinute` alone. Groq's
//    free tier is documented at 30 req/min and MEASURED at 8,000 tokens/min; an enrichment call is
//    ~900 in + up to 500 out, so the account is cut off after about SIX calls. The limiter sat
//    comfortably under its own ceiling and handed the caller a wall of 429s — a guard reporting
//    success while the thing it guards fails.
//
// 2. MODEL-CATALOGUE LIVENESS. shared/anthropicModels.js opens with the incident: a partial sweep
//    left Sonnet pinned to `claude-sonnet-4-20250514`, Anthropic retired it, every call 404'd, and
//    four features degraded silently for two months. The same thing happened on the free tier when
//    the whole llama family was removed. Nothing asked, so nothing knew.
//    ⛔ It must REFUSE, never substitute — an auto-updater would have "fixed" the 404 by quietly
//    switching to a model that returns HTTP 200 and an empty extraction 49 times in 50.
//
// 3. max_tokens BOUNDS REASONING AND ANSWER TOGETHER. Seen twice at exactly 500: 49-in-50 empty
//    extractions, and 10-in-10 truncations at precisely 500 output tokens with success=1.
import test from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";
import { PROVIDERS, PROVIDER } from "../shared/modelProviders.js";
import {
  callProvider, ProviderRequestError, resetRateLimiter, rateLimiterState, estimateRequestTokens,
} from "../services/providerTransport.js";
import { checkPinnedModels, assertPinnedModelsLive, LIVENESS } from "../services/modelCatalogue.js";

const GROQ_KEY = "test-groq-key";
const okBody = (outTokens = 10) => ({
  choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: outTokens },
});
const okResponse = (outTokens) => ({
  ok: true, status: 200, json: async () => okBody(outTokens), headers: new Map(),
});

// ── 1 · TOKEN PACING ────────────────────────────────────────────────────────────────────────────

test("the Groq spec declares the limit that actually binds", () => {
  const g = PROVIDERS[PROVIDER.GROQ];
  assert.equal(g.requestsPerMinute, 30);
  assert.equal(g.tokensPerMinute, 8_000,
    "the measured free-tier ceiling — 30 req/min is documented and never reached");
});

test("the estimate counts BOTH directions, because the limit does", () => {
  // Output has to be priced at the max_tokens cap: the real figure is unknown until after the
  // call, and a limiter that waits for it has already spent the tokens.
  const n = estimateRequestTokens({
    messages: [{ role: "user", content: "x".repeat(4000) }], max_tokens: 500,
  });
  assert.ok(n >= 1500, `expected input + max_tokens, got ${n}`);
  assert.ok(n < 3000, `expected an estimate, not a wild over-count, got ${n}`);
});

test("TOKENS stop the caller long before requests do", async () => {
  // ⛔ THE DEFECT: ~1,400 estimated tokens a call means the 8,000/min ceiling is reached after six,
  // while only six of thirty permitted REQUESTS have been used. A request-only limiter waves every
  // one of them through and the provider answers with 429s.
  //
  // ⛔ AND THE FIRST VERSION OF THIS TEST WAS BLIND. It looped `while (state.tokens + estimate <=
  // budget)`, which is the limiter's own arithmetic restated in the test — so it passed with the
  // token axis switched off entirely, measuring nothing but its own loop condition. The only
  // honest observable is BEHAVIOURAL: once the budget is gone the next call must BLOCK rather than
  // proceed, and blocking is visible without waiting out the minute by racing it against a timer.
  resetRateLimiter();
  const params = {
    model: "openai/gpt-oss-20b",
    messages: [{ role: "user", content: "x".repeat(3600) }],
    max_tokens: 4096,
  };
  const estimate = estimateRequestTokens(params);
  const budget = PROVIDERS[PROVIDER.GROQ].tokensPerMinute;
  assert.ok(estimate > 1000, `fixture must be token-heavy, got ${estimate}`);
  assert.ok(estimate * 30 > budget * 2,
    "the fixture must exhaust tokens well before the 30-request ceiling, or this proves nothing");

  let sent = 0;
  // Report the estimate back as the actual usage, so reconciliation cannot quietly refill the
  // budget and hide the block we are looking for.
  const fetchImpl = async () => {
    sent++;
    return { ok: true, status: 200, headers: new Map(), json: async () => ({
      choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
      usage: { prompt_tokens: estimate, completion_tokens: 0 },
    }) };
  };

  const perMinute = Math.floor(budget / estimate);
  for (let i = 0; i < perMinute; i++) {
    await callProvider({ provider: PROVIDER.GROQ, apiKey: GROQ_KEY, params, fetchImpl });
  }
  assert.equal(sent, perMinute, "everything inside the budget must go straight out");
  assert.ok(perMinute < 30,
    `tokens must bind first: budget allows ${perMinute} calls against a 30-request ceiling`);

  // The next one is over budget. It must not reach the wire.
  const pending = callProvider({ provider: PROVIDER.GROQ, apiKey: GROQ_KEY, params, fetchImpl });
  const raced = await Promise.race([
    pending.then(() => "completed"),
    new Promise(r => setTimeout(() => r("blocked"), 250)),
  ]);
  assert.equal(raced, "blocked",
    "the call past the token budget must WAIT — a request-only limiter lets it through");
  assert.equal(sent, perMinute, "and it must not have been sent");

  // Release the pending call so it cannot outlive the test.
  resetRateLimiter();
  await Promise.race([pending.catch(() => {}), new Promise(r => setTimeout(r, 100))]);
});

test("the window is RECONCILED with real usage, so it does not throttle harder than the provider", async () => {
  // The estimate prices output at the full max_tokens (4096). The provider actually billed 100+10.
  // Without reconciliation every call is over-counted and the free tier goes unused for the mirror
  // image of the original reason: a number nobody checked.
  resetRateLimiter();
  const params = {
    model: "openai/gpt-oss-20b", messages: [{ role: "user", content: "hello" }], max_tokens: 4096,
  };
  const estimate = estimateRequestTokens(params);
  await callProvider({
    provider: PROVIDER.GROQ, apiKey: GROQ_KEY, params, fetchImpl: async () => okResponse(10),
  });
  const state = rateLimiterState(PROVIDER.GROQ);
  assert.equal(state.requests, 1);
  assert.equal(state.tokens, 110, "100 prompt + 10 completion, as billed");
  assert.ok(state.tokens < estimate,
    `reconciliation must shrink the estimate (${estimate}) to the actual (${state.tokens})`);
});

test("a single request larger than the whole budget still goes out rather than deadlocking", async () => {
  resetRateLimiter();
  const params = {
    model: "openai/gpt-oss-20b",
    messages: [{ role: "user", content: "x".repeat(200_000) }],   // ~50k tokens, far over 8k
    max_tokens: 4096,
  };
  let sent = 0;
  await callProvider({
    provider: PROVIDER.GROQ, apiKey: GROQ_KEY, params,
    fetchImpl: async () => { sent++; return okResponse(10); },
  });
  assert.equal(sent, 1, "it will 429 and be retried; a limiter that can never admit it is worse");
});

// ── 3 · THE max_tokens FLOOR ────────────────────────────────────────────────────────────────────

test("a REASONING model with max_tokens 500 is refused, loudly, before any spend", async () => {
  // The exact setting measured twice on this pipeline.
  resetRateLimiter();
  let sent = 0;
  await assert.rejects(
    () => callProvider({
      provider: PROVIDER.GROQ, apiKey: GROQ_KEY,
      params: { model: "openai/gpt-oss-20b", messages: [{ role: "user", content: "hi" }], max_tokens: 500 },
      fetchImpl: async () => { sent++; return okResponse(); },
    }),
    (e) => {
      assert.ok(e instanceof ProviderRequestError);
      assert.match(e.message, /REASONING model/);
      assert.match(e.message, /49 empty extractions in 50/);
      return true;
    },
  );
  assert.equal(sent, 0, "it must refuse BEFORE the request, not diagnose it afterwards");
});

test("the same model above the floor is allowed", async () => {
  resetRateLimiter();
  const r = await callProvider({
    provider: PROVIDER.GROQ, apiKey: GROQ_KEY,
    params: { model: "openai/gpt-oss-20b", messages: [{ role: "user", content: "hi" }], max_tokens: 4096 },
    fetchImpl: async () => okResponse(),
  });
  assert.ok(r.content, "a sufficient budget must not be blocked");
});

test("the floor does NOT apply to non-reasoning models — enrichJob's Haiku 500 is untouched", () => {
  const g = PROVIDERS[PROVIDER.GROQ];
  assert.ok(!g.reasoningModels.includes("claude-haiku-4-5-20251001"));
  // Anthropic traffic never reaches this transport at all, which is the stronger guarantee.
  assert.equal(PROVIDERS[PROVIDER.ANTHROPIC], undefined,
    "Anthropic is not a routable provider in this transport");
});

// ── 2 · MODEL-CATALOGUE LIVENESS ────────────────────────────────────────────────────────────────

const anthropicStub = (impl) => ({ models: { retrieve: impl } });
const err = (status, message) => Object.assign(new Error(message), { status });

test("a live Anthropic model reports LIVE", async () => {
  const r = await checkPinnedModels({
    anthropic: anthropicStub(async (id) => ({ id, display_name: "Claude Haiku 4.5" })),
    anthropicModels: ["claude-haiku-4-5-20251001"],
    env: {},
  });
  const hit = r.find(x => x.provider === "anthropic");
  assert.equal(hit.status, LIVENESS.LIVE);
});

test("a RETIRED model reports GONE — the exact 2026-06-15 Sonnet incident", async () => {
  const r = await checkPinnedModels({
    anthropic: anthropicStub(async () => { throw err(404, "model not_found_error"); }),
    anthropicModels: ["claude-sonnet-4-20250514"],
    env: {},
  });
  assert.equal(r[0].status, LIVENESS.GONE);
});

test("⛔ a GONE model REFUSES THE BOOT, and never substitutes another", async () => {
  const log = { error: () => {}, warn: () => {}, log: () => {} };
  await assert.rejects(
    () => assertPinnedModelsLive({
      anthropic: anthropicStub(async () => { throw err(404, "model not_found_error"); }),
      anthropicModels: ["claude-sonnet-4-20250514"],
      env: {}, log,
    }),
    (e) => {
      assert.equal(e.code, "PINNED_MODEL_GONE");
      assert.match(e.message, /REFUSING TO START/);
      assert.match(e.message, /claude-sonnet-4-20250514/, "it must name the model");
      // The anti-auto-update contract, asserted as text because it is the whole point of the task.
      assert.match(e.message, /does NOT substitute one automatically/);
      return true;
    },
  );
});

test("UNREACHABLE is not GONE — a network blip must not take the server down", async () => {
  // ⛔ THE FAILURE MODE OF THE FIX ITSELF. A liveness check that refuses to boot on a DNS hiccup
  // converts a momentary outage into a hard one, which is worse than the problem it solves. Only
  // an ANSWERED "no such model" is evidence about the catalogue.
  const log = { error: () => {}, warn: () => {}, log: () => {} };
  const results = await assertPinnedModelsLive({
    anthropic: anthropicStub(async () => { throw new Error("ECONNREFUSED"); }),
    anthropicModels: ["claude-haiku-4-5-20251001"],
    env: {}, log,
  });
  assert.equal(results[0].status, LIVENESS.UNREACHABLE, "no status field means transport, not 404");
});

test("a 500 from the provider is also UNREACHABLE, not GONE", async () => {
  const r = await checkPinnedModels({
    anthropic: anthropicStub(async () => { throw err(500, "internal"); }),
    anthropicModels: ["claude-haiku-4-5-20251001"], env: {},
  });
  assert.equal(r[0].status, LIVENESS.UNREACHABLE);
});

test("the free-tier catalogue is checked by MEMBERSHIP — the llama removal, reproduced", async () => {
  // GET /openai/v1/models listed no llama model at all. This is that response.
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ data: [{ id: "openai/gpt-oss-20b" }, { id: "openai/gpt-oss-120b" }] }),
  });
  const live = await checkPinnedModels({ env: { GROQ_API_KEY: GROQ_KEY }, fetchImpl });
  assert.equal(live.find(x => x.provider === PROVIDER.GROQ).status, LIVENESS.LIVE);

  const gone = async () => ({
    ok: true, status: 200, json: async () => ({ data: [{ id: "something-else" }] }),
  });
  const r2 = await checkPinnedModels({ env: { GROQ_API_KEY: GROQ_KEY }, fetchImpl: gone });
  const hit = r2.find(x => x.provider === PROVIDER.GROQ);
  assert.equal(hit.status, LIVENESS.GONE);
  assert.match(hit.detail, /not in the 1-model catalogue/);
});

test("an empty catalogue is UNREACHABLE, not a claim that every model is gone", async () => {
  // A provider returning `{data: []}` is far more likely to be broken than to have deleted its
  // entire product. Reading it as GONE would refuse the boot on the strength of a bad response.
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  const r = await checkPinnedModels({ env: { GROQ_API_KEY: GROQ_KEY }, fetchImpl });
  assert.equal(r.find(x => x.provider === PROVIDER.GROQ).status, LIVENESS.UNREACHABLE);
});

test("a provider with no catalogue endpoint reads UNSUPPORTED, not UNREACHABLE", async () => {
  // Gemini has no /models probe in this transport. Calling that a network failure would warn on
  // every single boot with nothing an operator could ever do about it — the permanent-warning
  // shape that teaches people to stop reading the panel.
  const r = await checkPinnedModels({ env: { GOOGLE_API_KEY: "k" } });
  const hit = r.find(x => x.provider === PROVIDER.GOOGLE);
  assert.equal(hit.status, LIVENESS.UNSUPPORTED);
  assert.notEqual(hit.status, LIVENESS.UNREACHABLE);
});

test("each verdict is logged EXACTLY once", async () => {
  // `log.log?.(line) ?? log.warn(line)` printed everything twice: console.log returns undefined, so
  // `??` fired the fallback too. Invisible to every assertion in this file until the real output
  // was read — so it is asserted now.
  const lines = [];
  const log = { error: l => lines.push(l), warn: l => lines.push(l), log: l => lines.push(l) };
  await assertPinnedModelsLive({
    anthropic: anthropicStub(async (id) => ({ id })),
    anthropicModels: ["claude-haiku-4-5-20251001"], env: {}, log,
  });
  const haiku = lines.filter(l => l.includes("claude-haiku-4-5-20251001"));
  assert.equal(haiku.length, 1, `logged ${haiku.length} times: ${JSON.stringify(haiku)}`);
});

test("an unconfigured provider reads as UNCONFIGURED, never as a healthy or failing one", async () => {
  // "Unconfigured" and "broken" reading alike is how Jobo hid for months.
  const r = await checkPinnedModels({ env: {} });
  for (const hit of r) {
    assert.equal(hit.status, LIVENESS.UNCONFIGURED, `${hit.provider} with no key`);
    assert.match(hit.detail, /unset/);
  }
});

test("server.js actually calls the gate, and exits on GONE", () => {
  // A boot gate nobody wired in is a module with tests. Asserted against the source because the
  // alternative is booting the real server in a unit test.
  const src = fs.readFileSync("server.js", "utf8");
  assert.match(src, /assertPinnedModelsLive\(/, "the gate must be called at boot");
  assert.match(src, /PINNED_MODEL_GONE/, "and its verdict acted on");
  assert.match(src, /process\.exit\(1\)/, "refusing to start means exiting");
});
