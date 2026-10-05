// D17 (draft's owner, 10-03): ONLY RÉSUMÉ GENERATION MAY CALL A MODEL. This is the ratchet that holds
// the tools service to it, the same shape as draft's test/d17ModelCallSites.test.js.
//
// Every callAnthropic({ purpose: "x" }) in src/ must be one of the generation family below. The set
// found must EQUAL the set allowed: a new model call fails it, and so does a removed one still listed,
// so this list always says exactly what calls a model.
//
// ⚠ THE CLASSIFIER IS THE BORDERLINE CASE, AND IT IS ALLOWED ON PURPOSE (A80, 10-05). When a caller
// sends neither a domainModuleKey nor a roleFamily, generate asks Haiku for the role family and
// domain, ONLY to choose which domain module the generation prompt is assembled from. Its answer never
// leaves the service except as `domainModuleKey` on the generated résumé, it never runs outside a
// generate request, and it is not reachable as a route of its own. That makes it a step of résumé
// generation, not a separate feature — so it is pinned here as generation, with its two conditions:
// it is imported by generate.js alone, and only after both caller-supplied keys are absent.
// draft sends a roleFamily whenever the user has a job profile; the standalone generate tool sends
// none, which is where it runs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ALLOWED = new Map([
  ["resume_generate", "src/generation/generate.js — the résumé itself"],
  ["resume_format",   "src/generation/generate.js — the optional LLM formatting pass, off unless RESUME_MASTER_LLM_FORMAT=1"],
  ["resume_enhance",  "src/generation/enhance.js — the A+ base-résumé enhancement, generation's sibling"],
  ["classifier",      "src/generation/classifier.js — picks generate's domain module when the caller sent none"],
]);

function srcFiles(dir = "src") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...srcFiles(p));
    else if (/\.m?js$/.test(e.name)) out.push(p.replace(/\\/g, "/"));
  }
  return out;
}

// src/model/anthropicCall.js is the definition; src/contract/derived.js calls it against a fake client
// to derive the UsageRecord schema (purpose "p") and never reaches the network.
const NOT_CALL_SITES = new Set(["src/model/anthropicCall.js", "src/contract/derived.js"]);

function purposes() {
  const found = new Map();
  for (const f of srcFiles()) {
    if (NOT_CALL_SITES.has(f)) continue;
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/callAnthropic\(/g)) {
      const p = src.slice(m.index, m.index + 300).match(/purpose:\s*["']([a-z_0-9]+)["']/);
      const key = p ? p[1] : "<no literal purpose>";
      if (!found.has(key)) found.set(key, []);
      found.get(key).push(f);
    }
  }
  return found;
}

test("D17: the tools service calls a model only for résumé generation and its siblings", () => {
  const found = purposes();
  const unexpected = [...found.keys()].filter(p => !ALLOWED.has(p));
  assert.deepEqual(unexpected, [],
    "D17 forbids a model call outside résumé generation. New call site(s):\n" +
    unexpected.map(p => `  ${p}: ${found.get(p).join(", ")}`).join("\n"));
  const gone = [...ALLOWED.keys()].filter(p => !found.has(p));
  assert.deepEqual(gone, [], "a listed purpose no longer calls a model — delete it from ALLOWED");
});

test("D17: no file but src/model/anthropicCall.js talks to the SDK directly", () => {
  const offenders = srcFiles().filter(f => f !== "src/model/anthropicCall.js")
    .filter(f => /\.messages\.(create|stream)\s*\(/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(offenders, [], "a direct SDK call walks round callAnthropic and this whole check");
});

test("D17: the classifier runs only inside generate, and only when the caller named no domain", () => {
  const importers = srcFiles().filter(f => f !== "src/generation/classifier.js")
    .filter(f => /from\s+["']\.{1,2}\/(generation\/)?classifier\.js["']/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(importers, ["src/generation/generate.js"],
    "the classifier is reachable from somewhere other than generate — that is a feature of its own, not a step of generation");
  const gen = fs.readFileSync("src/generation/generate.js", "utf8");
  const at = gen.indexOf("await classify(");
  assert.ok(at > 0, "generate no longer classifies — drop `classifier` from ALLOWED");
  const before = gen.slice(0, at);
  assert.match(before, /let domainModuleKey = input\.domainModuleKey \|\| null;/);
  assert.match(before, /if \(!domainModuleKey && input\.roleFamily\) domainModuleKey = getDomainModuleKey\(input\.roleFamily, input\.domain\);/);
  assert.match(before, /if \(!domainModuleKey\) \{\s*try \{\s*const c = $/, "the model classifier must be the fallback after both caller keys");
});
