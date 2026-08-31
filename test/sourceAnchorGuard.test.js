// ── The half that keeps SOURCE-REGION tests honest ──────────────────────────────────────────────
//
// Most of this suite asserts against a REGION of a source file, carved out with indexOf. When an
// anchor moves, indexOf returns -1 — and slice reads a negative index as an offset from the END of
// the string rather than as an error. So the region silently becomes the wrong one:
//
//     slice(1200, -1)  ->  runs to one character from the end of the WHOLE FILE
//
// A `match` assertion over a region four times too wide usually still finds its string, so the test
// keeps passing while it has stopped being about the thing it names. That is this project's Shape 5.
//
// This was not hypothetical. Sweeping 284 lookups across 59 files turned up THREE anchors that were
// already dead, every one of them in a test that was passing:
//
//   summaryOptIn         "async function generateResumeForApply" — the function is not async, so
//                        coreGenerateResume's body was 63,521 chars instead of 15,948 (4.0x)
//   authRouteBootstrap   "{/* Root and catch-all" — that comment was split in two, so the /app
//                        route block ran to the end of App.jsx, 1066 chars instead of 223 (4.8x)
//   appScrollProgress    a `indexOf("Left group") >= 0` guard that could NEVER be true, because
//                        the helper above it strips JSX comments and that string only ever appears
//                        inside one — so the ternary always took its fallback and sliced to EOF
//
// None of the three failed. They were repaired only because `at()` made a missing anchor throw.
//
// This guard stops the next one. It is deliberately a source scan and not a lint rule: the repair
// has to happen at the call site, because only the call site knows which two anchors were meant.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// This file quotes the forbidden shape in its own failure message and in its fixtures, so it must
// not scan itself — the same carve-out modelCallGuard.test.js makes, for the same reason.
const SELF = "sourceAnchorGuard.test.js";

/** Character span of the argument list of the call whose "(" is at `open`. */
function argSpan(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return [open + 1, i];
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i++;
        i++;
      }
    }
  }
  return [open + 1, text.length];
}

test("no test carves a source region with a bare indexOf", () => {
  const dir = "test";
  const offenders = [];

  for (const name of fs.readdirSync(dir).filter(f => f.endsWith(".js") && f !== SELF)) {
    const file = path.join(dir, name).split(path.sep).join("/");
    const src = fs.readFileSync(file, "utf8");

    // Every .slice( argument list in the file.
    const spans = [];
    for (const m of src.matchAll(/\.slice\s*\(/g)) spans.push(argSpan(src, m.index + m[0].length - 1));

    for (const m of src.matchAll(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(indexOf|lastIndexOf)\s*\(/g)) {
      if (!spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
      offenders.push(`${file}:${src.slice(0, m.index).split("\n").length}`);
    }
  }

  assert.deepEqual(
    offenders, [],
    "These carve a source region with an anchor that is allowed to go missing:\n" +
    offenders.map(o => `  ${o}`).join("\n") +
    "\n\nWHY IT MATTERS: indexOf returns -1 for a missing anchor, and slice reads -1 as an offset\n" +
    "  from the END of the string. The region does not become empty, it becomes far too wide — and\n" +
    "  a `match` assertion over it usually still passes, so the test quietly stops checking what it\n" +
    "  is named after.\n\n" +
    "FIX: import { at } from '../test-support/sourceAnchors.js' and replace\n" +
    "      src.slice(src.indexOf(A), src.indexOf(B))\n" +
    "  with\n" +
    "      src.slice(at(src, A), at(src, B))\n" +
    "  `at` throws with the anchor text when it cannot find one, so a moved anchor fails loudly\n" +
    "  and names itself. Use lastAt for lastIndexOf. Do NOT add an exemption here."
  );
});

// The guard above is a source scan, so its coverage is a property of its own matching — exactly the
// thing that let the Batch API slip past modelCallGuard. Pin it against the shapes it must catch and
// the ones it must leave alone, so it cannot quietly narrow.
test("the scan catches every slice-with-indexOf shape, and nothing else", () => {
  const scan = (src) => {
    const spans = [];
    for (const m of src.matchAll(/\.slice\s*\(/g)) spans.push(argSpan(src, m.index + m[0].length - 1));
    let hits = 0;
    for (const m of src.matchAll(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(indexOf|lastIndexOf)\s*\(/g)) {
      if (spans.some(([a, b]) => m.index >= a && m.index < b)) hits++;
    }
    return hits;
  };

  // Two anchors, one anchor, a from-index, lastIndexOf, a dotted receiver, and a nested lookup.
  assert.equal(scan('const x = src.slice(src.indexOf("a"), src.indexOf("b"));'), 2);
  assert.equal(scan('const x = src.slice(src.indexOf("a"));'), 1);
  assert.equal(scan('const x = src.slice(i, src.indexOf("b", i));'), 1);
  assert.equal(scan('const x = s.slice(s.lastIndexOf("{", i), s.indexOf("}", i));'), 2);
  assert.equal(scan('const x = a.b.slice(a.b.indexOf("z"));'), 1);
  assert.equal(scan('const x = d.slice(d.indexOf("];", d.indexOf("const M")));'), 2);

  // An indexOf that is NOT feeding a slice is none of this guard's business — it is only dangerous
  // because slice accepts -1 silently.
  assert.equal(scan('assert.ok(src.indexOf("a") !== -1);'), 0);
  assert.equal(scan('const i = src.indexOf("a"); if (i > 0) {}'), 0);
  assert.equal(scan('const x = src.slice(0, 40);'), 0);
  // Already repaired sites must not be flagged, or the guard fights its own fix.
  assert.equal(scan('const x = src.slice(at(src, "a"), at(src, "b"));'), 0);
});
