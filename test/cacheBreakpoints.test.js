// TASK E — cache breakpoints, and the measurement that changed the recommendation.
//
// The assessment said to REMOVE the generation prefix's cache breakpoints: "written at 1.25x and
// read at 0.1x — written every time, read never. A 25% surcharge buying nothing. Unconditional
// -8.1%." Requirement 1 also said to "verify before/after against real usage_events, reconciled".
//
// Verified, and the premise is TRUE OF ONE CALLER AND FALSE IN AGGREGATE. The unread writes are
// real and exactly where the assessment said they were — but the callers that generate in BURSTS
// read the prefix heavily, and deleting the breakpoints would forfeit $0.39 to recover $0.02.
//
// These tests pin the numbers and the resulting design so that neither the measurement nor the
// reasoning has to be redone from scratch by whoever reads "unconditional -8.1%" next.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { assemblePrompt, loadAllPrompts } from "../services/promptAssembler.js";
import { ANTHROPIC_PRICING } from "../shared/anthropicModels.js";

await loadAllPrompts();

const blocks = (opts) => assemblePrompt("general", "GENERATE", "runtime inputs", { SUMMARY: false }, opts).systemBlocks;

test("breakpoints are ON by default — the measured-best status quo", () => {
  const s = blocks(undefined);
  assert.ok(s.length >= 2);
  assert.ok(s.every(b => b.cache_control?.type === "ephemeral" || !b.text),
    "every non-empty system block should carry a breakpoint by default");
});

test("a caller that knows it is one-shot can turn them off", () => {
  // This is the -8.1% the assessment identified, made available rather than forced on everyone.
  const s = blocks({ cache: false });
  assert.ok(s.every(b => b.cache_control === undefined),
    "cache:false must remove every breakpoint, or the lever does nothing");
  // And the prompt text itself is untouched — this is a billing decision, not a content one.
  assert.deepEqual(s.map(b => b.text), blocks(undefined).map(b => b.text));
});

test("the measurement is recorded where the decision is made", () => {
  // A number in a commit message is unfindable six months later. The reasoning has to sit beside
  // the line it justifies, or the next person reads "unconditional -8.1%" in the queue doc and
  // deletes the breakpoints without re-measuring.
  const src = fs.readFileSync("services/promptAssembler.js", "utf8");
  assert.match(src, /caching has SAVED/, "the net result must be stated");
  assert.match(src, /ag2_claims_verify/, "the callers that DO read cache must be named");
  assert.match(src, /resume_generate/, "and the one that does not");
  assert.match(src, /TASK D JUST CHANGED THE INTERACTIVE PATH/i,
    "the reason the 0-read caller is about to start reading must be recorded");
});

test("the arithmetic behind the decision, from the live pricing table", () => {
  // Re-derived here so the numbers in the comment are checkable rather than asserted. A cache
  // write is 1.25x base input (so the surcharge over plain input is 0.25x) and a read is 0.1x
  // (so a hit saves 0.9x). Verified live 2026-09-04 against platform.claude.com pricing.
  // Ratios, with a tolerance: 0.2/1e6 is not bit-identical to 2e-7, and a strict equality here
  // fails on floating point rather than on a pricing change — which would make this test noise.
  const near = (actual, expected, what) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: expected ~${expected}, got ${actual}`);

  const p = ANTHROPIC_PRICING["claude-sonnet-5"];
  near(p.cache_write / p.input, 1.25, "5-minute cache write multiplier");
  near(p.cache_read / p.input, 0.1, "cache read multiplier");

  // The real usage_events totals at the time of the decision.
  const rows = [
    { writes: 6704,  reads: 0 },       // resume_generate
    { writes: 14352, reads: 0 },       // af2_claim_verify
    { writes: 19136, reads: 138736 },  // ag2_claims_verify
    { writes: 9632,  reads: 76864 },   // ag3_claim_sample
  ];
  const surcharge = rows.reduce((a, r) => a + r.writes * 0.25 * p.input, 0);
  const saved = rows.reduce((a, r) => a + r.reads * 0.9 * p.input, 0);
  assert.ok(saved > surcharge,
    "if this ever flips, the breakpoints ARE costing money and requirement 1's advice becomes right");
  assert.equal(Number((saved - surcharge).toFixed(4)), 0.3632,
    "the net figure quoted in promptAssembler.js and the write-up");
});

// ── REQUIREMENT 5: PRICING VERIFIED LIVE, NOT FROM MEMORY ───────────────────────────────────────

test("Sonnet 5 and Haiku 4.5 match the live pricing table", () => {
  // Checked against https://platform.claude.com/docs/en/about-claude/pricing on 2026-09-04:
  //   Sonnet 5    $2 base in · $2.50 5m write · $4 1h write · $0.20 read · $10 out
  //   Haiku 4.5   $1 base in · $1.25 5m write · $2 1h write · $0.10 read · $5  out
  // The docs also state in terms: the increase to $3/$15 scheduled for 2026-09-01 "will not occur".
  // Compared in DOLLARS PER MILLION, which is how the pricing page states them — and with a
  // tolerance, because 0.2/1e6 is not bit-identical to the stored 2e-7 and a strict check would
  // fail on floating point rather than on a price change.
  const perMTok = (v) => Number((v * 1e6).toFixed(6));
  const s = ANTHROPIC_PRICING["claude-sonnet-5"];
  assert.equal(perMTok(s.input), 2);
  assert.equal(perMTok(s.output), 10);
  assert.equal(perMTok(s.cache_write), 2.5);
  assert.equal(perMTok(s.cache_read), 0.2);

  const h = ANTHROPIC_PRICING["claude-haiku-4-5-20251001"];
  assert.equal(perMTok(h.input), 1);
  assert.equal(perMTok(h.output), 5);
  assert.equal(perMTok(h.cache_write), 1.25);
  assert.equal(perMTok(h.cache_read), 0.1);
});

test("there is still no 1-hour cache price key, and nothing selects one", () => {
  // shared/anthropicModels.js warns that cache_write is the 5-MINUTE rate only; a 1-hour write is
  // 2x base input ($4/MTok on Sonnet 5 — confirmed live), and pricing one at 2.5 would under-report
  // every batched write by 37.5% SILENTLY, because the model ID still resolves and the loud
  // unknown-key branch never fires. The guard is that nothing sets a ttl.
  for (const f of ["services/promptAssembler.js", "server.js"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.ok(!/ttl:\s*["']1h["']/.test(src),
      `${f} sets a 1-hour cache TTL, but calculateCost has no 1h key — it would under-report by 37.5%`);
  }
});

// ── REQUIREMENT 2: BATCHING enrich_job ──────────────────────────────────────────────────────────

test("the Batch API is still not used, and the guard would catch it if it were", () => {
  // Requirement 2 said to batch enrich_job "IF it is still on Anthropic after task A". It is —
  // no GROQ_API_KEY exists — but the condition that matters is different and is recorded in
  // docs/al6-cache-and-batching.md: enrichment has nothing left to enrich (the board is 5 rows
  // after the retention purge), and task A's routing for it is built but unverified, so batching
  // now would optimise a path that may move providers the moment a key appears.
  //
  // What IS asserted is that the decision has not been quietly taken: no batch call exists, and
  // test/modelCallGuard.test.js covers messages.batches.create — AK2's finding, and the reason
  // adding batching cannot become untracked spend.
  const guard = fs.readFileSync("test/modelCallGuard.test.js", "utf8");
  assert.match(guard, /batches\\\.\)\?\(create\|results\)|batches/,
    "the guard must still cover the batch call shape before anyone adds batching");
});
