import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// ── EVERY JSX COMPONENT A PAGE RENDERS MUST ACTUALLY EXIST ─────────────────────────────────────
//
// `client/src/pages/tools/ATSToolPage.jsx` used <Link> four times and never imported it, and
// `GenerateToolPage.jsx` did the same. Both pages therefore threw
// "ReferenceError: Link is not defined" the instant they rendered — they had NEVER worked.
//
// ⛔ THE BUILD DOES NOT CATCH THIS. JSX compiles `<Link/>` to a call on an identifier resolved at
// RUNTIME, so an undefined component is a perfectly valid module that explodes when rendered.
// `vite build` exits 0. Nothing else in this suite renders a page, so nothing noticed.
//
// It was found by opening the page in a real browser while verifying something else. This test is
// the cheap version of that — defect shape 2, a handler wired to nothing, in its purest form.

const ROOT = "client/src";

function jsxFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsxFiles(p, out);
    else if (e.name.endsWith(".jsx")) out.push(p);
  }
  return out;
}

/** Names this module can legally reference: imported, declared, or destructured at top level. */
function namesInScope(src) {
  const names = new Set();
  // import X, {a as b, c}, * as ns from "..."
  for (const m of src.matchAll(/import\s+([^;]+?)\s+from\s*["'][^"']+["']/g)) {
    const clause = m[1];
    for (const part of clause.split(/,(?![^{]*\})/)) {
      const t = part.trim();
      if (!t) continue;
      if (t.startsWith("{")) {
        for (const spec of t.replace(/[{}]/g, "").split(","))
          names.add((spec.split(/\s+as\s+/).pop() || "").trim());
      } else if (t.startsWith("*")) {
        names.add((t.split(/\s+as\s+/).pop() || "").trim());
      } else {
        names.add(t);
      }
    }
  }
  // function Foo / const Foo = / class Foo — anywhere, including nested helpers
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  // Destructured locals, e.g. `const { Foo } = x`
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=/g))
    for (const spec of m[1].split(",")) names.add((spec.split(":").pop() || "").trim().replace(/\s*=.*$/, ""));
  // ARRAY destructuring, e.g. `const [JobCard, setJC] = useState(null)` — a lazily-loaded
  // component is bound this way in LandingPage and is perfectly legal.
  for (const m of src.matchAll(/(?:const|let|var)\s*\[([^\]]+)\]\s*=/g))
    for (const spec of m[1].split(",")) names.add(spec.trim().replace(/\s*=.*$/, ""));
  // RENAMES, e.g. a prop destructured as `icon: Icon` in a parameter list. Matching the rename
  // target anywhere is deliberately generous: this set only ever ADDS to what is in scope, so the
  // cost of being generous is a missed defect, never a false accusation — and the case this guard
  // exists for (<Link> bound nowhere at all) is still caught, which the injection test below pins.
  for (const m of src.matchAll(/\b[A-Za-z0-9_$]+\s*:\s*([A-Z][A-Za-z0-9_$]*)/g)) names.add(m[1]);
  return names;
}

/** Component identifiers actually rendered: `<Foo`, `<Foo.Bar` → Foo. Lowercase = HTML, skipped. */
function componentsUsed(src) {
  const used = new Set();
  for (const m of src.matchAll(/<([A-Z][A-Za-z0-9_$]*)/g)) used.add(m[1]);
  return used;
}

test("every capitalised JSX component in client/src resolves to something in scope", () => {
  const offenders = [];
  for (const file of jsxFiles(ROOT)) {
    const src = fs.readFileSync(file, "utf8");
    const scope = namesInScope(src);
    for (const used of componentsUsed(src)) {
      // `Foo.Bar` is checked on its root, which is what has to be in scope.
      const root = used.split(".")[0];
      if (!scope.has(root)) offenders.push(`${file.replace(/\\/g, "/")} <${used}>`);
    }
  }
  assert.deepEqual(offenders, [],
    "these JSX components are rendered but never imported or declared — the page will throw " +
    "ReferenceError at runtime and the build will not notice:\n  " + offenders.join("\n  "));
});

test("the scan is real — it sees the components that ARE imported", () => {
  // Guards the guard: a scan that silently matched nothing would pass forever. ApplyToolPage is
  // the sibling that imports Link correctly, so it must be found and must NOT be an offender.
  const src = fs.readFileSync("client/src/pages/tools/ApplyToolPage.jsx", "utf8");
  assert.ok(componentsUsed(src).has("Link"), "the JSX scan found no <Link> where one exists");
  assert.ok(namesInScope(src).has("Link"), "the import scan missed a real named import");
});

test("the guard would have caught the defect it was written for", () => {
  // Verified by injection rather than by trusting the logic: a guard never seen to fail is not
  // evidence. Reconstructs the exact pre-fix shape in memory.
  const broken = 'import { useState } from "react";\nexport function P(){ return <Link to="/x">go</Link>; }';
  assert.ok(!namesInScope(broken).has("Link"));
  assert.ok(componentsUsed(broken).has("Link"));
});
