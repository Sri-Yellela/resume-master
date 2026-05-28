import fs from "node:fs";
const path = "client/src/components/JobCard.jsx";
let s = fs.readFileSync(path, "utf8");

// All keys use explicit \uXXXX escapes to match exact codepoints in the file.
// Codepoints verified via codePointAt inspection of JobCard.jsx after initial fix run.
const map = [
  // â (U+00E2) + † (U+2020) + ' (U+2019)  →  → (U+2192)
  ["â†’", "→"],
  // â (U+00E2) + † (U+2020) + © (U+00A9)  →  ↩ (U+21A9)
  ["â†©", "↩"],
  // â (U+00E2) + † (U+2020) + — (U+2014)  →  ↗ (U+2197)
  ["â†—", "↗"],
  // â (U+00E2) + U+008F + ³ (U+00B3)      →  ⏳ (U+23F3)
  ["â³", "⏳"],
  // â (U+00E2) + † (U+2020) + » (U+00BB)  →  ↻ (U+21BB)
  ["â†»", "↻"],
  // ð (U+00F0) + Ÿ (U+0178) + ' (U+2018) + U+0081  →  👁 (U+1F441)
  ["ðŸ‘", "\u{1F441}"],
  // ð (U+00F0) + Ÿ (U+0178) + Ž (U+017D) + " (U+201C)  →  🎓 (U+1F393)
  ["ðŸŽ“", "\u{1F393}"],
  // ð (U+00F0) + Ÿ (U+0178) + ' (U+2018) + ¥ (U+00A5)  →  👥 (U+1F465)
  ["ðŸ‘¥", "\u{1F465}"],
];

let total = 0;
for (const [from, to] of map) {
  const parts = s.split(from);
  if (parts.length > 1) { total += parts.length - 1; s = parts.join(to); }
}
fs.writeFileSync(path, s, "utf8");
console.log("Applied " + total + " character replacements.");
