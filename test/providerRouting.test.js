// Multi-provider routing — the half that keeps the PUBLIC/CANDIDATE split honest.
//
// The routing rule is "route by WHOSE DATA IT IS", chosen over "filter PII out of the payload"
// precisely because it is checkable by a test and the filter is not: "did the regex catch every
// email in every resume" cannot be asserted, and a miss is a real person's address in a training
// corpus with no error and no way to know. What CAN be asserted is that each call site declares
// what it sends, that the declaration matches the payload, and that the default is the safe one.
//
// So this file checks the SPLIT, not the redaction. There is no redaction.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";

import { callModel, routeFor, resetRoutingWarnings, SYSTEM_USER_ID } from "../services/modelCall.js";
import { DATA_CLASS, PROVIDER, PROVIDERS, FREE_TIER_PRICING, resolveProvider, providerForModel } from "../shared/modelProviders.js";
import { callProvider, ProviderRateLimitError, ProviderRequestError, resetRateLimiter } from "../services/providerTransport.js";
import { calculateCost } from "../shared/anthropicModels.js";
import { at, lastAt } from "../test-support/sourceAnchors.js";

const GROQ_ENV = { ENRICH_PROVIDER: "groq", GROQ_API_KEY: "gsk_test" };

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, event_type TEXT NOT NULL,
      event_subtype TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_creation_tokens INTEGER DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0, model TEXT, cost_usd REAL DEFAULT 0,
      ats_score_before INTEGER, ats_score_after INTEGER, duration_ms INTEGER, job_id TEXT,
      company TEXT, success INTEGER NOT NULL DEFAULT 1, error_text TEXT, purpose TEXT,
      provider TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE cache_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, event_type TEXT NOT NULL,
      layer TEXT, domain_module TEXT, tokens_in_cache INTEGER DEFAULT 0,
      tokens_saved INTEGER DEFAULT 0, cost_saved_usd REAL DEFAULT 0, model TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE usage_tracking_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT, purpose TEXT, user_id INTEGER,
      error_text TEXT, recovered_from_sink INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  return db;
}

/** An Anthropic client stub that records what it was asked for. */
function fakeAnthropic() {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        return {
          content: [{ type: "text", text: "{}" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    },
  };
}

/** A fetch stub for the transport. `handler` receives (url, init) and returns a Response. */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// ── THE SPLIT ───────────────────────────────────────────────────────────────────────────────────

test("PUBLIC traffic routes to the configured free tier, at the pinned model", () => {
  const route = routeFor({ dataClass: DATA_CLASS.PUBLIC, model: "claude-haiku-4-5-20251001", env: GROQ_ENV });
  assert.equal(route.provider, PROVIDER.GROQ);
  assert.equal(route.model, "llama-3.1-8b-instant");
});

test("CANDIDATE traffic stays on Anthropic even when a free tier is fully configured", () => {
  // The entire safety property. If this ever passes for groq, resumes are leaving to a tier whose
  // training policy is not stated on any public page.
  const route = routeFor({ dataClass: DATA_CLASS.CANDIDATE, model: "claude-sonnet-5", env: GROQ_ENV });
  assert.equal(route.provider, PROVIDER.ANTHROPIC);
  assert.equal(route.model, "claude-sonnet-5", "the candidate model must not be swapped either");
});

test("an UNDECLARED call site stays on Anthropic — the default fails closed", () => {
  // A blacklist would default the other way and a forgotten annotation would leak. Here a
  // forgotten annotation costs a fraction of a cent and nothing else.
  const route = routeFor({ model: "claude-sonnet-5", env: GROQ_ENV });
  assert.equal(route.provider, PROVIDER.ANTHROPIC);
});

// ── UNCONFIGURED IS LOUD ────────────────────────────────────────────────────────────────────────

test("a missing key WARNS and falls back to Anthropic — it never silently skips", () => {
  resetRoutingWarnings();
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    const route = routeFor({ dataClass: DATA_CLASS.PUBLIC, model: "claude-haiku-4-5-20251001",
                             env: { ENRICH_PROVIDER: "groq" } });
    assert.equal(route.provider, PROVIDER.ANTHROPIC);
    assert.equal(route.model, "claude-haiku-4-5-20251001", "the fallback keeps the caller's model");
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.length, 1, "a configured-but-keyless provider must say so");
  assert.match(warnings[0], /GROQ_API_KEY/);
  assert.match(warnings[0], /falling back to Anthropic/i);
});

test("an unknown ENRICH_PROVIDER warns and falls back rather than throwing", () => {
  // A typo in a deploy config must not take enrichment down, but it must not be invisible either:
  // without the warning, the deploy that contains it looks identical to a working one.
  const r = resolveProvider({ ENRICH_PROVIDER: "grok" }); // note the missing q
  assert.equal(r.provider, PROVIDER.ANTHROPIC);
  assert.equal(r.reason, "unknown_provider");
  assert.match(r.detail, /grok/);
});

test("the default — nothing configured — is Anthropic and is NOT a warning", () => {
  const r = resolveProvider({});
  assert.equal(r.provider, PROVIDER.ANTHROPIC);
  assert.equal(r.reason, "not_configured",
    "the unconfigured default is the documented state, not a defect to warn about on every call");
});

test("the fallback warning fires ONCE per process, not once per row", () => {
  // enrich_job runs 1302 times in a pass. A per-call warning would bury every other log line, and
  // the usual response to that is to delete the warning.
  resetRoutingWarnings();
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    for (let i = 0; i < 5; i++) {
      routeFor({ dataClass: DATA_CLASS.PUBLIC, model: "m", env: { ENRICH_PROVIDER: "groq" } });
    }
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /warns once per process/i);
});

// ── THE MODEL IS PINNED ─────────────────────────────────────────────────────────────────────────

test("an unpinned ENRICH_MODEL is a LOUD failure, not a quiet fallback", () => {
  // Catalogs churn: a provider deleted most of its free models on a single day. Falling back to
  // Anthropic here would mean the free tier silently stopped being used and the bill silently
  // returned, with every dashboard green.
  assert.throws(
    () => resolveProvider({ ...GROQ_ENV, ENRICH_MODEL: "llama-3.1-8b-instant-deprecated" }),
    (e) => e.code === "UNPINNED_MODEL" && /Pinned: /.test(e.message),
  );
});

test("a pinned ENRICH_MODEL that IS in the catalog is honoured", () => {
  const r = resolveProvider({ ...GROQ_ENV, ENRICH_MODEL: "llama-3.3-70b-versatile" });
  assert.equal(r.model, "llama-3.3-70b-versatile");
});

// ── PRICING ─────────────────────────────────────────────────────────────────────────────────────

test("every pinned model of every provider has a pricing entry", () => {
  // Requirement 3: usage_events stops reconciling the moment a model is callable but unpriceable,
  // and the loud unknown-key warning would then fire on every enrichment call.
  for (const spec of Object.values(PROVIDERS)) {
    for (const m of spec.models) {
      assert.ok(FREE_TIER_PRICING[m], `${spec.label} can call "${m}" but nothing can price it`);
    }
  }
});

test("a free-tier model prices at $0 SILENTLY; a genuinely unknown model still warns loudly", () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    const free = calculateCost("llama-3.1-8b-instant", { input_tokens: 100000, output_tokens: 50000 });
    assert.equal(free, 0);
    assert.deepEqual(warnings, [], "a priced-at-zero model must not warn — it would warn 1302 times a pass");

    const unknown = calculateCost("some-model-nobody-added", { input_tokens: 100 });
    assert.equal(unknown, 0);
    assert.equal(warnings.length, 1, "an unpriced model must STILL be loud — that is how a dead ID hides");
    assert.match(warnings[0], /NO PRICING ENTRY/);
  } finally {
    console.warn = realWarn;
  }
});

test("Anthropic pricing is untouched by the free-tier table", () => {
  // A regression here would silently reprice every historical reconciliation.
  assert.equal(calculateCost("claude-haiku-4-5-20251001", { input_tokens: 1_000_000 }), 1);
  assert.equal(calculateCost("claude-sonnet-5", { output_tokens: 1_000_000 }), 10);
});

// ── usage_events RECORDS PROVIDER AND MODEL ─────────────────────────────────────────────────────

test("a routed call records the PROVIDER and the model actually called", async () => {
  const db = makeDb();
  const restore = process.env.ENRICH_PROVIDER;
  const restoreKey = process.env.GROQ_API_KEY;
  process.env.ENRICH_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "gsk_test";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(() => jsonResponse({
    choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 900, completion_tokens: 40 },
  }));
  try {
    resetRateLimiter();
    const msg = await callModel({
      anthropic: fakeAnthropic(), db, purpose: "enrich_job", userId: SYSTEM_USER_ID,
      dataClass: DATA_CLASS.PUBLIC,
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{ role: "user", content: "a job advert" }],
    });
    // The Anthropic-shaped result every caller already destructures.
    assert.equal(msg.content.map(b => b.text).join(""), "{\"ok\":true}");

    const row = db.prepare("SELECT * FROM usage_events ORDER BY id DESC LIMIT 1").get();
    assert.equal(row.provider, "groq");
    assert.equal(row.model, "llama-3.1-8b-instant",
      "the model RECORDED must be the one called, not the one the call site asked for");
    assert.equal(row.purpose, "enrich_job");
    assert.equal(row.input_tokens, 900);
    assert.equal(row.output_tokens, 40);
    assert.equal(row.cost_usd, 0);
    assert.equal(row.success, 1);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.ENRICH_PROVIDER = restore;
    if (restoreKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = restoreKey;
  }
});

test("an unrouted call still records provider=anthropic — no row is left unattributed", async () => {
  const db = makeDb();
  const anthropic = fakeAnthropic();
  await callModel({
    anthropic, db, purpose: "resume_generate", userId: SYSTEM_USER_ID,
    dataClass: DATA_CLASS.CANDIDATE,
    model: "claude-sonnet-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }],
  });
  const row = db.prepare("SELECT * FROM usage_events ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.provider, "anthropic");
  assert.equal(row.model, "claude-sonnet-5");
  assert.equal(anthropic.calls.length, 1, "the candidate call must have gone to the Anthropic SDK");
});

test("providerForModel labels a model with its provider", () => {
  assert.equal(providerForModel("llama-3.1-8b-instant"), PROVIDER.GROQ);
  assert.equal(providerForModel("gemini-2.0-flash"), PROVIDER.GOOGLE);
  assert.equal(providerForModel("claude-sonnet-5"), null);
});

// ── THE TRANSPORT ───────────────────────────────────────────────────────────────────────────────

test("the OpenAI-compatible adapter returns an ANTHROPIC-shaped message", async () => {
  resetRateLimiter();
  const impl = fakeFetch(() => jsonResponse({
    choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  }));
  const msg = await callProvider({
    provider: PROVIDER.GROQ, apiKey: "gsk_test", fetchImpl: impl,
    params: { model: "llama-3.1-8b-instant", max_tokens: 100,
              messages: [{ role: "user", content: "hi" }], system: "be terse" },
  });
  // `content` MUST be an array of blocks: every caller does `.content.map(b => b.text || '')`.
  // A bare string would map to a list of undefined and every extraction would parse as empty —
  // a total, silent failure that reads as a bad model rather than a bad adapter.
  assert.ok(Array.isArray(msg.content));
  assert.equal(msg.content[0].text, "hello");
  assert.equal(msg.usage.input_tokens, 7);
  assert.equal(msg.usage.output_tokens, 3);

  const body = JSON.parse(impl.calls[0].init.body);
  assert.equal(body.messages[0].role, "system", "an Anthropic `system` becomes an OpenAI system message");
  assert.equal(body.messages[1].content, "hi");
  assert.match(impl.calls[0].init.headers.authorization, /^Bearer /);
});

test("the Gemini adapter translates roles and reads Gemini's own usage fields", async () => {
  resetRateLimiter();
  const impl = fakeFetch(() => jsonResponse({
    candidates: [{ content: { parts: [{ text: "hi there" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4 },
  }));
  const msg = await callProvider({
    provider: PROVIDER.GOOGLE, apiKey: "goog_test", fetchImpl: impl,
    params: { model: "gemini-2.0-flash", max_tokens: 50,
              messages: [{ role: "assistant", content: "prior" }, { role: "user", content: "hi" }] },
  });
  assert.equal(msg.content[0].text, "hi there");
  assert.equal(msg.usage.input_tokens, 11);
  assert.equal(msg.usage.output_tokens, 4);

  const body = JSON.parse(impl.calls[0].init.body);
  assert.equal(body.contents[0].role, "model", "Gemini's vocabulary is user/model, not user/assistant");
  // The key belongs in a header, not the query string, or it lands in every proxy access log.
  assert.ok(!impl.calls[0].url.includes("goog_test"));
  assert.equal(impl.calls[0].init.headers["x-goog-api-key"], "goog_test");
});

test("Anthropic's array-of-blocks content and system shapes flatten rather than stringify", async () => {
  // promptAssembler sends `system` as an array of cache_control blocks. `String(obj)` would send
  // the literal "[object Object]" to the provider, which is a plausible-looking prompt that
  // contains none of the instructions.
  resetRateLimiter();
  const impl = fakeFetch(() => jsonResponse({
    choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 },
  }));
  await callProvider({
    provider: PROVIDER.GROQ, apiKey: "k", fetchImpl: impl,
    params: {
      model: "llama-3.1-8b-instant",
      system: [{ type: "text", text: "SYSTEM RULES" }],
      messages: [{ role: "user", content: [{ type: "text", text: "BLOCK ONE" }, { type: "text", text: " AND TWO" }] }],
    },
  });
  const body = JSON.parse(impl.calls[0].init.body);
  assert.equal(body.messages[0].content, "SYSTEM RULES");
  assert.equal(body.messages[1].content, "BLOCK ONE AND TWO");
  assert.ok(!JSON.stringify(body).includes("[object Object]"));
});

// ── 429 ─────────────────────────────────────────────────────────────────────────────────────────

test("a 429 backs off, retries, and SUCCEEDS if the limit clears", async () => {
  resetRateLimiter();
  const impl = fakeFetch((_url, _init, n) =>
    n === 1
      ? jsonResponse({ error: "rate limited" }, { status: 429, headers: { "retry-after": "0" } })
      : jsonResponse({ choices: [{ message: { content: "second try" } }], usage: {} }));
  const msg = await callProvider({
    provider: PROVIDER.GROQ, apiKey: "k", fetchImpl: impl,
    params: { model: "llama-3.1-8b-instant", messages: [{ role: "user", content: "x" }] },
  });
  assert.equal(msg.content[0].text, "second try");
  assert.equal(impl.calls.length, 2);
});

test("a persistent 429 throws ProviderRateLimitError — it never returns an empty extraction", async () => {
  // The failure that matters: an empty result would be written as "this posting says nothing",
  // and because the success path also stamps content_hash the row would leave the candidate pool
  // for good. That is the exact shape COALESCE and hasAnySignal were both added to prevent.
  resetRateLimiter();
  const impl = fakeFetch(() => jsonResponse({ error: "slow down" },
    { status: 429, headers: { "retry-after": "0" } }));
  await assert.rejects(
    () => callProvider({
      provider: PROVIDER.GROQ, apiKey: "k", fetchImpl: impl,
      params: { model: "llama-3.1-8b-instant", messages: [{ role: "user", content: "x" }] },
    }),
    (e) => e instanceof ProviderRateLimitError && e.code === "RATE_LIMITED",
  );
  assert.equal(impl.calls.length, 4, "one attempt plus three retries");
});

test("a non-429 provider error is a ProviderRequestError carrying the status", async () => {
  resetRateLimiter();
  const impl = fakeFetch(() => jsonResponse({ error: "bad model" }, { status: 400 }));
  await assert.rejects(
    () => callProvider({
      provider: PROVIDER.GROQ, apiKey: "k", fetchImpl: impl,
      params: { model: "llama-3.1-8b-instant", messages: [{ role: "user", content: "x" }] },
    }),
    (e) => e instanceof ProviderRequestError && e.status === 400,
  );
  assert.equal(impl.calls.length, 1, "a 400 must not be retried — it will fail identically");
});

test("a rate-limited call is RECORDED as a failure, not dropped", async () => {
  // A failed call is a fact worth having: the dead claude-sonnet-4 ID 404'd on every call for two
  // months while the cost table showed nothing at all.
  const db = makeDb();
  const restore = process.env.ENRICH_PROVIDER;
  const restoreKey = process.env.GROQ_API_KEY;
  process.env.ENRICH_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "gsk_test";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(() => jsonResponse({ error: "slow down" },
    { status: 429, headers: { "retry-after": "0" } }));
  try {
    resetRateLimiter();
    await assert.rejects(() => callModel({
      anthropic: fakeAnthropic(), db, purpose: "enrich_job", userId: SYSTEM_USER_ID,
      dataClass: DATA_CLASS.PUBLIC, model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "x" }],
    }), (e) => e.code === "RATE_LIMITED");
    const row = db.prepare("SELECT * FROM usage_events ORDER BY id DESC LIMIT 1").get();
    assert.equal(row.success, 0);
    assert.equal(row.provider, "groq");
    assert.match(row.error_text, /rate limited/i);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.ENRICH_PROVIDER = restore;
    if (restoreKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = restoreKey;
  }
});

// ── THE SPLIT IS DECLARED AT EVERY SITE, AND THE DECLARATIONS ARE THE EXPECTED ONES ─────────────

test("every callModel call site declares a dataClass", () => {
  // The safe default protects production; this protects INTENT. A new site that forgets is made to
  // choose, rather than inheriting a default that happens to be right today.
  const files = ["server.js", "services/classifier.js", "services/jobs/enrichJob.js",
                 "services/jobs/importJob.js", "routes/domainProfiles.js"];
  const missing = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/callModel\(\{([\s\S]{0,900}?)\}\);/g)) {
      if (!/dataClass:\s*DATA_CLASS\./.test(m[1])) {
        missing.push(`${file}: near "${m[1].trim().slice(0, 70)}"`);
      }
    }
  }
  assert.deepEqual(missing, [],
    "These call sites do not say whose data they send:\n" + missing.map(x => `  ${x}`).join("\n"));
});

test("the PUBLIC set is exactly the three job-text purposes", () => {
  // Pinned so that widening it is a deliberate edit with a reviewer, not a one-line drift. Every
  // addition here is a new class of data leaving for a free tier.
  const expected = new Set(["enrich_job", "classify_job", "import_job"]);
  const found = new Set();
  const files = ["server.js", "services/classifier.js", "services/jobs/enrichJob.js",
                 "services/jobs/importJob.js", "routes/domainProfiles.js"];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    // Anchored at the DECLARATION and scanning backwards for the purpose beside it. Anchoring at
    // `callModel({` and reading forward needs a window wide enough for the widest prompt, and
    // classify_job's is ~1KB of template literal — a fixed forward window silently missed it and
    // this test reported two PUBLIC sites where there are three.
    for (const m of src.matchAll(/dataClass:\s*DATA_CLASS\.PUBLIC/g)) {
      const before = src.slice(Math.max(0, m.index - 600), m.index);
      const p = [...before.matchAll(/purpose: *["']([a-z_]+)["']/g)].pop();
      assert.ok(p, `a PUBLIC declaration in ${file} has no purpose within 600 chars above it`);
      found.add(p[1]);
    }
  }
  assert.deepEqual([...found].sort(), [...expected].sort(),
    "A purpose was added to or removed from the free-tier route. Every entry here is candidate-free\n" +
    "text a company published about itself. Check the PAYLOAD, not the name — `classifier` and\n" +
    "`classify_job` differ by one word and one of them sends the candidate's resume.");
});

test("the resume-bearing `classifier` purpose is NOT public", () => {
  // services/classifier.js sends 2000 chars of the candidate's resume. Its name sits one letter
  // from `classify_job`, which is genuinely public, and the two are adjacent in every cost report.
  const src = fs.readFileSync("services/classifier.js", "utf8");
  assert.match(src, /resumeText\.slice/, "this test is pinned to the resume actually being sent");
  assert.match(src, /dataClass: DATA_CLASS\.CANDIDATE/);
  assert.ok(!/dataClass: DATA_CLASS\.PUBLIC/.test(src));
});

// ── A 429 LEAVES THE ROW RETRYABLE ──────────────────────────────────────────────────────────────

test("a 429 during enrichment leaves the row a candidate — it is never stamped enriched", async () => {
  // Requirement 7. enrichJob's failure path ALREADY leaves content_hash and enriched_at unset, so
  // this holds today — but "already holds" is a property of the current code, not a guarantee, and
  // the cost of it silently ceasing to hold is a row that leaves the candidate pool permanently
  // (the hash only changes when title/description does). Groq's 30 req/min ceiling makes 429 the
  // ORDINARY case for a 1302-row pass, not an edge one, so it is pinned here.
  const { runEnrichment } = await import("../services/jobs/enrichJob.js");
  const db = makeDb();
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT, description TEXT,
      summary TEXT, normalized_title TEXT, experience_level TEXT, workplace_type TEXT,
      salary_min_usd INTEGER, salary_max_usd INTEGER, salary_period TEXT, skills_json TEXT,
      is_h1b_sponsor INTEGER, requires_work_auth INTEGER, is_clearance_required INTEGER,
      org_unit_raw TEXT, content_hash TEXT, enriched_at INTEGER,
      is_active INTEGER DEFAULT 1, discovered_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS company_technographics (
      company TEXT NOT NULL, skill TEXT NOT NULL, skill_type TEXT, weight REAL DEFAULT 0,
      posting_count INTEGER DEFAULT 0, last_seen_at INTEGER, updated_at INTEGER,
      PRIMARY KEY (company, skill)
    );
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, stage TEXT, started_at INTEGER, finished_at INTEGER,
      ok INTEGER, detail TEXT
    );
  `);
  db.prepare(`INSERT INTO scraped_jobs (job_id, title, company, description)
              VALUES ('j1', 'Backend Engineer', 'Acme', 'Build APIs all day.')`).run();

  const restore = process.env.ENRICH_PROVIDER;
  const restoreKey = process.env.GROQ_API_KEY;
  process.env.ENRICH_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "gsk_test";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(() => jsonResponse({ error: "rate limit exceeded" },
    { status: 429, headers: { "retry-after": "0" } }));
  try {
    resetRateLimiter();
    const result = await runEnrichment(db, fakeAnthropic(), { recordRun: false });
    assert.equal(result.enriched, 0, "nothing was extracted, so nothing may be counted as enriched");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.ENRICH_PROVIDER = restore;
    if (restoreKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = restoreKey;
  }

  const row = db.prepare("SELECT * FROM scraped_jobs WHERE job_id = 'j1'").get();
  assert.equal(row.content_hash, null, "a rate-limited row must stay a candidate for the next pass");
  assert.equal(row.enriched_at, null);
  assert.equal(row.summary, null, "and it must not have been written with an empty extraction");

  // The 429 is still a recorded fact — a failed call is spend-adjacent information and the dead
  // sonnet-4 ID proved that silence about failures is how an outage lasts two months.
  const failed = db.prepare("SELECT * FROM usage_events WHERE success = 0").all();
  assert.ok(failed.length >= 1, "the rate-limited attempt must appear in usage_events");
  assert.equal(failed[0].provider, "groq");
});

test("a param the transport cannot translate is REFUSED, not dropped", async () => {
  // A request that succeeds while quietly ignoring half of what it was asked to do is worse than
  // one that fails. `tools` is the sharp case: routed to a free tier it would come back as plain
  // prose, and the call site would read that as a bad model rather than a lost parameter.
  resetRateLimiter();
  const impl = fakeFetch(() => jsonResponse({ choices: [{ message: { content: "x" } }], usage: {} }));
  await assert.rejects(
    () => callProvider({
      provider: PROVIDER.GROQ, apiKey: "k", fetchImpl: impl,
      params: { model: "llama-3.1-8b-instant", messages: [{ role: "user", content: "x" }],
                tools: [{ name: "search" }] },
    }),
    (e) => e instanceof ProviderRequestError && /tools/.test(e.message),
  );
  assert.equal(impl.calls.length, 0, "it must refuse BEFORE spending a request");
});

test("the three PUBLIC call sites pass only translatable params", async () => {
  // The refusal above is a runtime backstop. This is the compile-time-ish version: if enrichment,
  // classification or import ever grows a `tools` or `stop_sequences`, this fails at `npm test`
  // rather than at 3am in a background pass.
  const sites = [
    ["services/jobs/enrichJob.js", /dataClass: DATA_CLASS\.PUBLIC/],
    ["services/jobs/importJob.js", /dataClass: DATA_CLASS\.PUBLIC/],
    ["server.js", /dataClass: DATA_CLASS\.PUBLIC/],
  ];
  const translatable = new Set(["model", "max_tokens", "messages", "system", "temperature"]);
  // Bookkeeping keys consumed by callModel itself and never forwarded to a provider.
  const wrapperKeys = new Set(["anthropic", "db", "purpose", "userId", "eventType", "eventSubtype",
                               "jobId", "company", "domainModule", "atsScoreBefore", "atsScoreAfter",
                               "onTracked", "dataClass"]);
  for (const [file, marker] of sites) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(new RegExp(marker.source, "g"))) {
      // Read forward from the declaration only as far as the END of callModel's argument object —
      // the first line that closes it. A fixed character window overruns into the neighbouring
      // object literals (enrichJob's SQL bindings sit right below the call) and reports column
      // names as if they were request params.
      const rest = src.slice(m.index);
      const close = rest.search(/^\s*\}\);/m);
      const after = close > 0 ? rest.slice(0, close) : rest.slice(0, 2000);
      const keys = [...after.matchAll(/^\s{2,}([a-zA-Z_]+):/gm)].map(x => x[1]);
      const bad = keys.filter(k => !translatable.has(k) && !wrapperKeys.has(k));
      assert.deepEqual(bad, [],
        `${file}: a PUBLIC call site passes ${bad.join(", ")}, which the transport cannot translate`);
    }
  }
});

// ── MIGRATION 096 ───────────────────────────────────────────────────────────────────────────────

test("migration 096 is byte-identical in both runners and is additive", () => {
  // The list is duplicated between the boot-time runner (server.js) and the CLI one
  // (scripts/migrations.js). A migration added to only one of them applies on only one path.
  const grab = (file) => {
    const s = fs.readFileSync(file, "utf8");
    const i = s.indexOf(`id: "096_usage_events_provider"`);
    assert.ok(i > 0, `096 missing from ${file}`);
    // `at`/`lastAt` rather than bare indexOf: a missing anchor returns -1, and slice reads -1 as an
    // offset from the END, so the region silently becomes far too WIDE instead of empty and the
    // assertions over it keep passing. test/sourceAnchorGuard.test.js enforces this.
    return s.slice(lastAt(s, "{", i), at(s, "\n    },", i))
      .replace(/\r\n/g, "\n").replace(/^\s+/gm, "");
  };
  const sql = grab("scripts/migrations.js");
  assert.equal(sql, grab("server.js"),
    "the boot-time runner and the CLI runner must apply the same DDL");
  assert.match(sql, /ADD COLUMN provider/);
  // The one UPDATE it does contain is the backfill, and it is bounded to rows with no value.
  // Anything DROPping or DELETing here would be destroying the record of past spend.
  assert.doesNotMatch(sql, /\bDROP\b|\bDELETE\b/i);
  assert.match(sql, /UPDATE usage_events SET provider = 'anthropic' WHERE provider IS NULL/);
});

test("096 backfills existing rows to anthropic rather than leaving them unknown", async () => {
  const { MIGRATIONS } = await import("../scripts/migrations.js");
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) {
    if (m.id === "096_usage_events_provider") break;
    db.exec(m.sql);
  }
  db.prepare("INSERT INTO users (id,username,password_hash) VALUES (1,'ada','x')").run();
  db.prepare(`INSERT INTO usage_events (user_id, event_type, model, purpose)
              VALUES (1, 'enrich_job', 'claude-haiku-4-5-20251001', 'enrich_job')`).run();

  db.exec(MIGRATIONS.find(m => m.id === "096_usage_events_provider").sql);

  // Every row predating this migration WAS an Anthropic call — there was no other path. NULL would
  // say "unknown", which is a different and false claim, and would grow a bucket in `GROUP BY
  // provider` that never corresponded to anything real.
  const row = db.prepare("SELECT provider FROM usage_events").get();
  assert.equal(row.provider, "anthropic");
  db.close();
});
