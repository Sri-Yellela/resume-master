// D123 P6e + P6f (draft's WORKLOG, owner 11-01): the prompt fixes the audit agreed (R2, R4, R5 and the two invention
// licences), the owner's bullet craft in ONE file read by both calls, and the lean guard's new checks — no number
// dropped (40,000 = 40k), no sole ownership the bullet does not state, bullets ordered by relevance in code.
// Synthetic person; no model is called.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { assemblePrompt, loadAllPrompts } from "../src/generation/promptAssembler.js";
import { LEAN_SYSTEM, checkLeanChanges, applyChanges, indexBullets } from "../src/generation/tailor.js";
import { bulletCraftText } from "../src/generation/bulletCraft.js";
import { buildStructuredResume } from "../src/formatting/resumeFormatter.js";

loadAllPrompts();

const BASE = `Alex Rivers
Denver, CO | alex.rivers@example.com

EXPERIENCE
Software Engineer, Quillmark Freight, Denver, CO | Jan 2023 - Present
- Wrote internal docs for the on-call rotation
- Built a REST API in Java serving 40,000 requests a day
- Cut p95 latency from 820 ms to 310 ms with a Redis cache

SKILLS
Languages: Java, Python, SQL

EDUCATION
B.S. Computer Science, Harrowgate State University | 2022`;
const structure = buildStructuredResume(BASE);
const id = (needle) => indexBullets(structure).find(b => b.text.includes(needle)).id;
const system = (mode, flags = {}) => assemblePrompt("engineering", mode, "", flags).systemBlocks.map(b => b.text).join("\n");
const CRAFT_MARK = "The shape of a bullet, in this order:";

test("p6fCraftFileLoadedByBothCalls: the full call and the lean call both carry prompts/bullet_craft.md", () => {
  assert.ok(bulletCraftText().includes(CRAFT_MARK));
  assert.ok(system("GENERATE").includes(CRAFT_MARK), "the full call");
  assert.ok(system("A_PLUS").includes(CRAFT_MARK), "A+ too");
  assert.ok(LEAN_SYSTEM.includes(CRAFT_MARK), "the lean call");
  assert.ok(!LEAN_SYSTEM.includes("## SUMMARY"), "the lean call never rewrites a summary, so its rules stay out");
  assert.ok(system("GENERATE", { SUMMARY: true }).includes("430-480 rendered characters"), "the full call keeps them when the summary is on");
});

test("p6fNoSecondCopyOfRules: the craft's rules are written once, in the craft file", () => {
  const files = ["prompts/layer1_global_rules.md", ...fs.readdirSync("prompts/layer2_domains").map(f => `prompts/layer2_domains/${f}`),
    ...fs.readdirSync("prompts/layer3_modes").map(f => `prompts/layer3_modes/${f}`), "src/generation/tailor.js"];
  const rules = [/at most 30 words/i, /One accomplishment per bullet/i, /Contributed to, Co-designed/, /430-480 rendered characters/,
    /double asterisks/i, /No em or en dashes|em dashes and en dashes/i, /## BULLETS/];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const r of rules) assert.doesNotMatch(text, r, `${f} restates a craft rule (${r}); it belongs in prompts/bullet_craft.md`);
  }
  // In the assembled prompt each appears exactly once.
  const full = system("GENERATE", { SUMMARY: true });
  for (const r of [/at most 30 words/gi, /430-480 rendered characters/g]) assert.equal(full.match(r).length, 1, String(r));
});

test("p6eNoInventionLicences: neither 'company reality' nor 'credible approximations' reaches any call", () => {
  for (const text of [system("GENERATE"), system("A_PLUS"), LEAN_SYSTEM]) {
    assert.doesNotMatch(text, /company reality/i);
    assert.doesNotMatch(text, /credible approximations/i);
    assert.doesNotMatch(text, /Do not echo or paraphrase existing resume bullets/i);
    assert.doesNotMatch(text, /at least two stakeholder/i, "quotas became a preference");
    assert.doesNotMatch(text, /Transferable to target stack/i, "the translation table put unused tools in Skills");
  }
  assert.doesNotMatch(system("GENERATE"), /may only appear in the most recent experience slot/i, "the arbitrary AI-terms rule (A+ keeps its own)");
});

test("p6eNoCssOrPdfComment: the model is no longer asked for CSS or the PDF comment; the class names stay (the formatter reads them)", () => {
  const g = system("GENERATE");
  assert.doesNotMatch(g, /All CSS must be in/);
  assert.doesNotMatch(g, /Save and submit as PDF/);
  assert.match(g, /`entry-org`/);
});

test("p6eAplusRulesOnlyInAplus: exclusions, FAANG, the distribution rules and the tool registry reach A+ only", () => {
  const g = system("GENERATE"), a = system("A_PLUS");
  for (const r of [/Absolute company exclusion/, /FAANG/, /SKILL AND STACK DISTRIBUTION/, /CANONICAL TOOL REGISTRY/, /\*\*Stripe:\*\*/]) {
    assert.doesNotMatch(g, r, `Generate still carries ${r}`);
    assert.match(a, r, `A+ lost ${r}`);
  }
  assert.ok(g.length < a.length - 2000, `Generate's static prompt shrank (${g.length} vs A+ ${a.length})`);
});

test("p6fNumbersKeptAndForward: a dropped number is refused; 40,000 reworded as 40k is the same number", () => {
  const b = id("40,000");
  const dropped = checkLeanChanges({ structure, baseResumeText: BASE, changes: { bullets: { [b]: "Built a **Java** REST API for high traffic" } } });
  assert.deepEqual(dropped.violations.map(v => v.kind), ["number_dropped"]);
  assert.equal(dropped.bullets[b], undefined, "the candidate's own text stays");
  const k = checkLeanChanges({ structure, baseResumeText: BASE, changes: { bullets: { [b]: "Built a **Java** REST API serving 40k requests a day" } } });
  assert.deepEqual(k.violations, []);
  const added = checkLeanChanges({ structure, baseResumeText: BASE, changes: { bullets: { [b]: "Built a Java REST API serving 40,000 requests a day for 3 teams" } } });
  assert.deepEqual(added.violations.map(v => v.kind), ["number_not_in_bullet"]);
  const latency = id("820 ms");
  const moved = checkLeanChanges({ structure, baseResumeText: BASE, changes: { bullets: { [latency]: "Added a **Redis** cache that cut p95 latency from 820 ms to 310 ms" } } });
  assert.deepEqual(moved.violations, [], "numbers brought forward into the result are kept, not dropped");
});

test("p6fContributionVerbsWithoutSoleOwnership: Led / Owned / Spearheaded only when the bullet already says so", () => {
  const b = id("40,000");
  for (const text of ["Led a REST API in Java serving 40,000 requests a day", "Single-handedly built a REST API serving 40,000 requests a day",
    "Owned the REST API in Java serving 40,000 requests a day"]) {
    const r = checkLeanChanges({ structure, baseResumeText: BASE, changes: { bullets: { [b]: text } } });
    assert.deepEqual(r.violations.map(v => v.kind), ["sole_ownership_claimed"], text);
  }
  const ok = checkLeanChanges({ structure, baseResumeText: BASE, changes: { bullets: { [b]: "Implemented a REST API in **Java** serving 40,000 requests a day" } } });
  assert.deepEqual(ok.violations, []);
  // "led" inside another word is not a claim
  const word = checkLeanChanges({ structure, baseResumeText: BASE, changes: { bullets: { [b]: "Built a scheduled REST API in Java serving 40,000 requests a day" } } });
  assert.deepEqual(word.violations, []);
});

test("p6fBulletsOrderedByRelevance: within an employer the bullet with the most must-have terms comes first; ties keep their order", () => {
  const keywords = { matched: ["Java", "REST API", "Redis"], claimed: [], placements: [] };
  const out = applyChanges(structure, {}, { keywords });
  const bullets = out.sections.find(s => s.type === "entries").entries[0].bullets;
  assert.match(bullets[0], /REST API in Java/, "two must-have terms");
  assert.match(bullets[1], /Redis/, "one");
  assert.match(bullets[2], /internal docs/, "none, last");
  const unchanged = applyChanges(structure, {}, {}).sections.find(s => s.type === "entries").entries[0].bullets;
  assert.match(unchanged[0], /internal docs/, "without keywords the candidate's order stands");
});
