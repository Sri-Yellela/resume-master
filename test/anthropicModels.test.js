// Regression cover for the partial-model-migration outage: server.js called
// claude-sonnet-4-20250514 for ~2 months after Anthropic retired it, so resume generation,
// resume enhancement, PDF parsing and standalone generation all 404'd while the UI reported
// only a generic failure. These tests pin the things that were silently wrong.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  MODEL_SONNET,
  MODEL_HAIKU,
  ANTHROPIC_PRICING,
  calculateCost,
  cacheCreationTokensOf,
} from "../shared/anthropicModels.js";

test("every model the app calls has a pricing entry", () => {
  for (const id of [MODEL_SONNET, MODEL_HAIKU]) {
    assert.ok(
      ANTHROPIC_PRICING[id],
      `${id} is sent to the API but has no ANTHROPIC_PRICING entry, so its cost logs as $0`
    );
  }
});

test("no module hardcodes a model ID outside shared/anthropicModels.js", () => {
  // This is the actual root cause: inline literals meant a bump could update some call sites
  // and miss others. Any new literal fails here.
  const files = [
    "server.js",
    "services/usageTracker.js",
    "services/classifier.js",
    "services/jobs/enrichJob.js",
    "services/jobs/importJob.js",
    "routes/domainProfiles.js",
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const hits = src.match(/["']claude-[a-z0-9.\-]+["']/g) || [];
    assert.deepEqual(
      hits, [],
      `${f} hardcodes ${hits.join(", ")} — import MODEL_SONNET/MODEL_HAIKU instead`
    );
  }
});

test("the retired Sonnet model is not what the app calls", () => {
  assert.notEqual(
    MODEL_SONNET, "claude-sonnet-4-20250514",
    "claude-sonnet-4-20250514 was retired 2026-06-15 and returns 404 not_found_error"
  );
});

test("published per-token rates are recorded correctly", () => {
  // Sonnet 5: $2/MTok in, $10/MTok out. Haiku 4.5: $1/MTok in, $5/MTok out.
  // Haiku previously carried $0.80/$4 — Haiku 3.5's rates — understating every Haiku call ~20%.
  assert.equal(ANTHROPIC_PRICING[MODEL_SONNET].input, 2 / 1_000_000);
  assert.equal(ANTHROPIC_PRICING[MODEL_SONNET].output, 10 / 1_000_000);
  assert.equal(ANTHROPIC_PRICING[MODEL_HAIKU].input, 1 / 1_000_000);
  assert.equal(ANTHROPIC_PRICING[MODEL_HAIKU].output, 5 / 1_000_000);

  // Cache reads are 0.1x base input; 5-minute cache writes are 1.25x base input.
  for (const id of [MODEL_SONNET, MODEL_HAIKU]) {
    const p = ANTHROPIC_PRICING[id];
    assert.ok(Math.abs(p.cache_read - p.input * 0.1) < 1e-12, `${id} cache_read != 0.1x input`);
    assert.ok(Math.abs(p.cache_write - p.input * 1.25) < 1e-12, `${id} cache_write != 1.25x input`);
  }
});

test("cache-creation tokens are read from the real API field name", () => {
  // The API returns `cache_creation_input_tokens`; the DB column is `cache_creation_tokens`.
  // Cost code used to read the column name off the API object, so it was always undefined and
  // cache-write cost silently totalled $0 on every live call.
  assert.equal(cacheCreationTokensOf({ cache_creation_input_tokens: 500 }), 500);
  assert.equal(cacheCreationTokensOf({ cache_creation_tokens: 500 }), 500);
  assert.equal(cacheCreationTokensOf({}), 0);

  const cost = calculateCost(MODEL_SONNET, { cache_creation_input_tokens: 1_000_000 });
  assert.equal(cost, ANTHROPIC_PRICING[MODEL_SONNET].cache_write * 1_000_000); // $2.50
  assert.ok(cost > 0, "cache-write cost must not silently price at $0");
});

test("cost is computed across all four token classes", () => {
  const cost = calculateCost(MODEL_SONNET, {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
  });
  assert.ok(Math.abs(cost - (2 + 10 + 0.2 + 2.5)) < 1e-9, `expected $14.70, got ${cost}`);
});

test("an unknown model warns loudly instead of silently costing $0", () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const cost = calculateCost("claude-does-not-exist", { input_tokens: 5000 });
    assert.equal(cost, 0);
    assert.ok(
      warnings.some(w => w.includes("NO PRICING ENTRY") && w.includes("claude-does-not-exist")),
      "unknown model must emit a loud warning — a bare 0 is how a dead model ID hides"
    );
  } finally {
    console.warn = originalWarn;
  }
});
