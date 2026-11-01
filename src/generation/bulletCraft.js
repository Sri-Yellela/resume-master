// D123 P6f · THE OWNER'S BULLET CRAFT — one file, prompts/bullet_craft.md, read by BOTH tailoring calls.
//
// The full call appends it to Layer 1's block (promptAssembler.assemblePrompt); the lean call appends it to LEAN_SYSTEM
// (tailor.js). Read once, lazily, so the lean path works without loadAllPrompts(). Its conditionals (the SUMMARY
// rules) are resolved by the caller's flags; the lean call never rewrites a summary, so it resolves SUMMARY off.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const BULLET_CRAFT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts", "bullet_craft.md");

let cached = null;

/** The craft file's text with its leading maintainer comment removed (the model has no use for it). */
export function bulletCraftText() {
  if (cached === null) cached = fs.readFileSync(BULLET_CRAFT_PATH, "utf8").replace(/\r\n/g, "\n").replace(/^<!--[\s\S]*?-->\s*/, "");
  return cached;
}
