// D192 (4d) — claim plausibility's fixtures: each check on its own, the "no data is never a flag" rule, and the flags never
// touching a score. Synthetic people and companies only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { experienceEntries, checkPlausibility, scoreContextual, scoreAtsLocally, buildRuntimeAtsBasis } from "../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KESTREL = { name: "Kestrel Payments", stack: [{ tech: "Apache Kafka", postings: 14 }, { tech: "Go", postings: 12 }, { tech: "Terraform", postings: 9 }, { tech: "Prefect", postings: 6 }],
  ofPostings: 22, families: { "software-engineering": 14, "data-ai": 8 }, industry: "financial technology", employees: 400 };
const RESUME = `Experience
Senior Software Engineer — Kestrel Payments
Jan 2019 – Dec 2021
- Built payment services on Kafka and Go
- Ran pipelines on Airflow
- Integrated Salesforce for the billing team
- Designed a sales incentive compensation model for the field team
- Shipped LLM features on GPT-4
Software Engineering Intern — Tiny Labs
2017 – 2018
- Led a team of 12 engineers
Backend Engineer — Nobody Known Inc
2022 – present
- Built services on Rust and Kafka
Skills
Go, Kafka`;
const entries = experienceEntries(RESUME);
const companyFor = (e) => (e.parts.includes("Kestrel Payments") ? KESTREL : e.parts.includes("Tiny Labs") ? { name: "Tiny Labs", employees: 15 } : null);
const run = () => checkPlausibility({ entries, companyFor, asOf: 2026, vocabulary: ["Salesforce", "Rust"] });   // the caller's vocabulary (draft: shared/techVocabulary.js)
const byEmployer = (name) => run().find(r => r.employer === name || r.header.includes(name));

test("the experience entries: header, title, the other parts, the years, the bullets", () => {
  assert.equal(entries.length, 3);
  assert.deepEqual([entries[0].title, entries[0].parts, entries[0].start, entries[0].end, entries[0].bullets.length],
    ["Senior Software Engineer", ["Kestrel Payments"], 2019, 2021, 5]);
  assert.equal(entries[2].ongoing, true);
});

test("d192PlausibilityTechConfirmed — a technology in the employer's own postings is confirmed, with its evidence", () => {
  assert.deepEqual(byEmployer("Kestrel Payments").confirmed, [{ tech: "Apache Kafka", evidence: "14 of 22" }, { tech: "Go", evidence: "12 of 22" }]);
});

test("d192PlausibilityTechUnlikely — a technology neither it nor anything of its purpose is in a known stack is flagged; a same-purpose one is not", () => {
  const flags = byEmployer("Kestrel Payments").flags;
  assert.ok(flags.some(f => f.kind === "tech" && f.tech === "Salesforce" && /You list Salesforce at Kestrel Payments/.test(f.reason)));
  assert.ok(!flags.some(f => f.tech === "Apache Airflow"), "Airflow ≈ their Prefect — the same purpose is never flagged");
});

test("d192PlausibilityNoDataNeutral — an employer with no record is never flagged on tech or domain", () => {
  const r = byEmployer("Nobody Known");
  assert.equal(r.status, "no_data");
  assert.deepEqual(r.flags, []);
  // and a known employer with too thin a stack is not either
  const thin = checkPlausibility({ entries, companyFor: (e) => (e.parts.includes("Kestrel Payments") ? { name: "Kestrel Payments", stack: [{ tech: "Go", postings: 2 }], ofPostings: 3 } : null), asOf: 2026 });
  assert.ok(!thin[0].flags.some(f => f.kind === "tech" || f.kind === "domain"));
});

test("d192PlausibilityDomainMismatch — sales-incentive work at a company whose postings are engineering and data", () => {
  const f = byEmployer("Kestrel Payments").flags.find(x => x.kind === "domain");
  assert.match(f.reason, /describes sales, but Kestrel Payments' 22 postings are in other kinds of work/);
  // a company that posts sales roles, or whose industry names it, is not flagged
  const sells = checkPlausibility({ entries: [entries[0]], companyFor: () => ({ ...KESTREL, families: { ...KESTREL.families, "sales-cs": 3 } }), asOf: 2026 });
  assert.ok(!sells[0].flags.some(x => x.kind === "domain"));
});

test("d192PlausibilityTimelineFlag — a technology named in a role that ended before it existed", () => {
  const f = byEmployer("Kestrel Payments").flags.filter(x => x.tech === "GPT-4");
  assert.deepEqual(f.map(x => x.kind), ["timeline"], "the timeline says it; no second stack flag for the same technology");
  assert.equal(f[0].reason, "GPT-4 came out in 2023, after this role ended (2021)");
});

test("d192PlausibilityRoleSizeFlag — leading 12 as an intern (or at a 15-person company) is flagged", () => {
  const f = byEmployer("Tiny Labs").flags;
  assert.equal(f.length, 1);
  assert.match(f[0].reason, /Leading 12 people is unusual for a software engineering intern role/);
  const sized = checkPlausibility({ entries: experienceEntries("Experience\nEngineering Manager — Tiny Labs\n2019 – 2020\n- Managed 12 engineers"),
    companyFor: () => ({ name: "Tiny Labs", employees: 15 }), asOf: 2026 });
  assert.match(sized[0].flags[0].reason, /Leading 12 people at Tiny Labs, which has about 15/);
});

test("d192FlagsNeverReduceScore — the scores are computed without the plausibility module and never read it", () => {
  const job = { title: "Backend Engineer", description: "Build services in Go and Kafka on AWS with Terraform and PostgreSQL." };
  const basis = buildRuntimeAtsBasis({ resumeText: RESUME, signalProfile: {}, domainProfile: {} });
  const a = scoreAtsLocally({ job, runtimeBasis: basis, termWeights: null, synonyms: null });
  run();   // checking plausibility changes nothing anywhere
  const b = scoreAtsLocally({ job, runtimeBasis: basis, termWeights: null, synonyms: null });
  assert.deepEqual(a, b);
  for (const f of ["scorer.js", "contextual.js"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(HERE, "..", "src", f), "utf8"), /plausibility/i, `${f} reads plausibility`);
  }
  assert.equal(typeof scoreContextual, "function");
});

test("d192DismissedFlagStays (the key) — a flag's key is stable across re-scores and re-wordings of whitespace and case", () => {
  const k1 = byEmployer("Kestrel Payments").flags.map(f => f.key);
  const again = checkPlausibility({ entries: experienceEntries(RESUME.replace("Integrated Salesforce", "Integrated   SALESFORCE")), companyFor, asOf: 2026, vocabulary: ["Salesforce", "Rust"] });
  const k2 = again[0].flags.map(f => f.key);
  assert.deepEqual(k2, k1);
});

test("no model, no network, no database in the module", () => {
  const src = fs.readFileSync(path.join(HERE, "..", "src", "plausibility.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /\bfetch\s*\(|node:https?|@anthropic-ai|messages\.create|prepare\(/);
});
