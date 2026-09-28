// Moved from draft's test/resumeArtifacts.test.js in A4, VERBATIM apart from paths: the A+ overlay and
// the prompt assembler moved here in A2, and the tests that pin them move with them rather than
// being deleted from draft and lost. (draft keeps the sandbox/artifact tests, which are about its UI.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("A+ prompt overlay requires stronger honest ATS coverage", () => {
  const layered = fs.readFileSync("prompts/layer3_modes/a_plus.md", "utf8");

  assert.match(layered, /A\+ Coverage Mandate/);
  assert.match(layered, /missing-keyword ledger/);
  assert.match(layered, /Semantic bridge/);
  assert.match(layered, /A\+ Resume is more aggressive than Generate/);
  assert.match(layered, /Technical Skills placement/);
});


test("prompt assembler caches stable mode overlays", () => {
  const assembler = fs.readFileSync("src/generation/promptAssembler.js", "utf8");
  // Reads layer3Resolved, not layer3Text: AI1 resolves the prompt-file conditionals before the
  // block is built, so the text that is cached is the text that is SENT. Asserting against the
  // raw file variable would pass while a resolved-but-uncached block went out on every call.
  //
  // ASSERTED ON THE VARIABLE, NOT ON THE WHOLE EXPRESSION. This used to pin the literal
  // `...(layer3Resolved ? { cache_control: { type: "ephemeral" } } : {})`, which broke when AL6
  // hoisted the breakpoint into a `breakpoint` const so callers could switch caching off — a
  // change that did not touch the property this test is named after. The behavioural half is in
  // test/cacheBreakpoints.test.js.
  assert.match(assembler, /\.\.\.\(layer3Resolved \? breakpoint : \{\}\)/);
  assert.ok(!/layer3Text\s*\?\s*breakpoint/.test(assembler),
    "the cached block must key off the RESOLVED text, not the raw file text");
});

