// ⭐ The formatting prompt is built from the renderer's stylesheet, so the two cannot disagree.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { FORMATTING_SYSTEM } from "../src/formatting/formattingSystem.js";
import { RESUME_STYLE_BLOCK } from "../src/formatting/resumeFormatter.js";

const cssLines = RESUME_STYLE_BLOCK.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^<\/?style>$/.test(l));

test("every line of the renderer's stylesheet appears in the formatting prompt", () => {
  // In draft 35 of 43 lines did — the prompt specified a design the renderer had abandoned.
  assert.ok(cssLines.length >= 40, `stylesheet parsed to ${cssLines.length} lines`);
  const prompt = new Set(FORMATTING_SYSTEM.split(/\r?\n/).map(l => l.trim()));
  const missing = cssLines.filter(l => !prompt.has(l));
  assert.deepEqual(missing, [], "the prompt must carry the renderer's CSS verbatim");
});

test("⛔ the prompt's source holds NO CSS of its own — a second copy is how the drift happened", () => {
  const src = fs.readFileSync("src/formatting/formattingSystem.js", "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /--color-|font-family:|\.section-title\s*\{|ul\.bullets/,
    "formattingSystem.js restates CSS — interpolate RESUME_STYLE_BLOCK instead");
  assert.match(code, /import \{ RESUME_STYLE_BLOCK \}/);
});

test("the old design's hand-drawn bullet is gone from the prompt, as it is from the renderer", () => {
  assert.doesNotMatch(RESUME_STYLE_BLOCK, /content:\s*"•"/);
  assert.doesNotMatch(FORMATTING_SYSTEM, /content:\s*"•"/);
  assert.doesNotMatch(FORMATTING_SYSTEM, /letter-spacing: 0\.22em/, "the old uppercase-name design");
});
