import fs from "node:fs";
const s = fs.readFileSync("client/src/components/JobCard.jsx", "utf8");

// Find all sequences starting with â (U+00E2) or ï or ð — the mojibake markers
const hits = new Set();
for (let i = 0; i < s.length; i++) {
  const cp = s.codePointAt(i);
  if (cp === 0x00E2 || cp === 0x00EF || cp === 0x00C3 || cp === 0x00F0) {
    // Grab up to 6 code points for context
    let seq = "";
    let cps = [];
    for (let j = i; j < Math.min(i + 6, s.length); j++) {
      const c = s.codePointAt(j);
      if (c > 0xFFFF) j++; // surrogate pair
      cps.push("U+" + c.toString(16).toUpperCase().padStart(4, "0"));
      seq += String.fromCodePoint(c);
      // Stop at common delimiters
      if (c === 0x22 || c === 0x27 || c === 0x3C || c === 0x3E || c === 0x0A) break;
    }
    hits.add(JSON.stringify({ seq, cps }));
  }
}

console.log("Distinct mojibake-prefix sequences found:");
for (const h of [...hits].sort()) {
  const { seq, cps } = JSON.parse(h);
  console.log("  " + JSON.stringify(seq) + "  |  " + cps.join(" "));
}
