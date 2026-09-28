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
import { assemblePrompt, loadAllPrompts } from "../src/generation/promptAssembler.js";

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
  const src = fs.readFileSync("src/generation/promptAssembler.js", "utf8");
  assert.match(src, /caching has SAVED/, "the net result must be stated");
  assert.match(src, /ag2_claims_verify/, "the callers that DO read cache must be named");
  assert.match(src, /resume_generate/, "and the one that does not");
  assert.match(src, /TASK D JUST CHANGED THE INTERACTIVE PATH/i,
    "the reason the 0-read caller is about to start reading must be recorded");
});

// The two pricing-arithmetic tests that followed here in draft check draft's pricing table
// (shared/anthropicModels.js), which costs usage_events. This service has no pricing table: it
// returns token counts and the caller prices them. Those tests stay in draft.

test("⛔ nothing here sets a 1-hour cache TTL — the caller prices these writes at the 5-minute rate", () => {
  // draft costs every cache write this service reports from `cache_creation_input_tokens` at the
  // 5-MINUTE rate (1.25x base). A 1-hour write is 2x, so setting ttl:"1h" here would make every
  // caller under-report those writes by 37.5% SILENTLY — the usage record carries the aggregate
  // count, not which TTL wrote it. Moved from draft with the breakpoints (A4). If a 1h TTL is ever
  // wanted, the usage record must split the two first, and this test changes with it.
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]);
  for (const f of [...walk("src"), "server.js"].filter(f => f.endsWith(".js"))) {
    assert.ok(!/ttl:\s*["']1h["']/.test(fs.readFileSync(f, "utf8")), `${f} sets a 1-hour cache TTL`);
  }
});
