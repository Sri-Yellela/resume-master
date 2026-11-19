// D192 (4) — the contextual score's fixtures. Every part is a pure function; each is tested on its own fixture.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  scoreContextual, roleFit, responsibilityOverlap, responsibilityPhrases, techStackFit, domainsIn, ecosystemOf,
  resolveContextualWeights, DEFAULT_CONTEXTUAL_WEIGHTS, CONTEXTUAL_CONTRACT, scoreAtsLocally, buildRuntimeAtsBasis,
} from "../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const POSTING = `Senior Backend Engineer — Kestrel Payments

What you'll do
- Build payment infrastructure that moves money for millions of merchants
- Design event-driven services on Kafka and PostgreSQL
- Lead a team of 5 engineers through design reviews
- Own on-call for the ledger service

Requirements
- 5+ years of backend experience
- PCI DSS experience a plus`;

const RESUME = `Experience
Senior Software Engineer, Backend — Ledgerly
- Built payment infrastructure processing card transactions for merchants in fintech
- Designed event-driven services on Kafka and PostgreSQL with exactly-once delivery
- Ran on-call rotation for the ledger service and cut pages by 40%
Skills
Go, Kafka, PostgreSQL, Airflow, Redis, Docker`;

const SENIOR_BACKEND = { category: "software-engineering", subcategory: "swe.backend", level: "senior" };

test("d192RoleFitFromTaxonomy — same role full marks; the taxonomy distance and the level gap cost", () => {
  assert.equal(roleFit(SENIOR_BACKEND, SENIOR_BACKEND).score, 100);
  const frontendMid = roleFit(SENIOR_BACKEND, { category: "software-engineering", subcategory: "swe.frontend", level: "mid" });
  assert.equal(frontendMid.relation, "same_family");
  assert.equal(frontendMid.level_gap, 1);
  assert.ok(frontendMid.score < 100 && frontendMid.score > 20, `same family, one level short: ${frontendMid.score}`);
  const otherFamily = roleFit(SENIOR_BACKEND, { category: "data", subcategory: "data.analyst", level: "senior" });
  assert.ok(otherFamily.score < frontendMid.score, "another category costs more than a sibling subcategory");
  const threeShort = roleFit(SENIOR_BACKEND, { ...SENIOR_BACKEND, level: "entry" });
  const oneShort = roleFit(SENIOR_BACKEND, { ...SENIOR_BACKEND, level: "mid" });
  assert.ok(threeShort.score < oneShort.score, "three steps cost more than one");
  const over = roleFit({ ...SENIOR_BACKEND, level: "mid" }, SENIOR_BACKEND);
  assert.ok(over.score > oneShort.score, "over-levelled costs less than under-levelled");
  assert.equal(roleFit(SENIOR_BACKEND, { ...SENIOR_BACKEND, subcategory: "swe.frontend", also: { subcategory: "swe.backend" } }).relation, "also_fits");
  assert.equal(roleFit({}, SENIOR_BACKEND).status, "no_data");
  assert.equal(roleFit(SENIOR_BACKEND, null).status, "no_data");
});

test("d192ResponsibilityOverlapNoModel — the posting's responsibility lines matched by token overlap", () => {
  const phrases = responsibilityPhrases(POSTING);
  assert.equal(phrases.length, 4, "only the What you'll do section, never Requirements");
  const r = responsibilityOverlap(POSTING, RESUME);
  assert.equal(r.status, "ok");
  assert.ok(r.matched.some(p => /payment infrastructure/i.test(p)));
  assert.ok(r.matched.some(p => /event-driven/i.test(p)));
  assert.ok(r.missing.some(p => /Lead a team of 5/i.test(p)), "no team leadership in the résumé");
  assert.equal(r.score, Math.round(100 * r.matched.length / 4));
  assert.equal(responsibilityOverlap("Great company. Apply now.", RESUME).status, "no_data");
  // pure: same input, same answer
  assert.deepEqual(responsibilityOverlap(POSTING, RESUME), r);
});

test("d192TechStackWeightedByPostingShare — a technology in 14 of 22 postings matters more than one in 2", () => {
  const company = { ofPostings: 22, stack: [{ tech: "Apache Kafka", postings: 14 }, { tech: "Terraform", postings: 2 }] };
  const hasKafka = techStackFit(company, ["Apache Kafka"]);
  const hasTerraform = techStackFit(company, ["Terraform"]);
  assert.ok(hasKafka.score > hasTerraform.score);
  assert.equal(hasKafka.score, Math.round(100 * 14 / 16));
  assert.deepEqual(hasKafka.gaps.map(g => g.tech), ["Terraform"]);
  const extras = techStackFit(company, ["Apache Kafka", "Redis", "Elixir"]);
  assert.equal(extras.score, hasKafka.score, "the résumé's extras are neutral, never a penalty");
});

test("d192EcosystemMatchByCategory — the same purpose earns half", () => {
  assert.equal(ecosystemOf("Prefect"), ecosystemOf("Apache Airflow"));
  const company = { ofPostings: 10, stack: [{ tech: "Prefect", postings: 10 }] };
  const r = techStackFit(company, ["Apache Airflow"]);
  assert.equal(r.score, 50);
  assert.deepEqual(r.ecosystem.map(e => [e.yours, e.theirs]), [["Apache Airflow", "Prefect"]]);
  assert.equal(techStackFit(company, ["Prefect"]).score, 100);
  assert.equal(techStackFit(company, ["Figma"]).score, 0);
});

test("d192NoTechDataReturnsNoData — no stack: the part is left out and the others carry the score", () => {
  assert.equal(techStackFit(null, ["Go"]).status, "no_data");
  assert.equal(techStackFit({ stack: [] }, ["Go"]).status, "no_data");
  const c = scoreContextual({ skillMatch: 80, posting: { ...SENIOR_BACKEND, text: POSTING }, resume: { ...SENIOR_BACKEND, text: RESUME } });
  assert.equal(c.parts.tech_stack.status, "no_data");
  assert.equal(c.parts.tech_stack.weight, 0);
  const sum = Object.values(c.parts).reduce((s, p) => s + p.weight, 0);
  assert.ok(Math.abs(sum - 1) < 0.01, `weights rescaled to 1: ${sum}`);
});

test("d192WeightsConfigurable — weights from the caller; unknown parts and negatives refused", () => {
  assert.deepEqual(resolveContextualWeights(null), DEFAULT_CONTEXTUAL_WEIGHTS);
  assert.deepEqual(DEFAULT_CONTEXTUAL_WEIGHTS, { skill_match: 0.5, role_fit: 0.2, responsibility_overlap: 0.15, tech_stack: 0.15 });
  assert.throws(() => resolveContextualWeights({ vibes: 1 }), TypeError);
  assert.throws(() => resolveContextualWeights({ role_fit: -1 }), TypeError);
  assert.throws(() => resolveContextualWeights({ skill_match: 0, role_fit: 0, responsibility_overlap: 0, tech_stack: 0 }), TypeError);
  const args = { skillMatch: 90, posting: { ...SENIOR_BACKEND, text: POSTING }, resume: { category: "data", subcategory: "data.analyst", level: "senior", text: RESUME } };
  const skillOnly = scoreContextual({ ...args, weights: { role_fit: 0, responsibility_overlap: 0, tech_stack: 0 } });
  assert.equal(skillOnly.score, 90);
  assert.ok(scoreContextual(args).score < 90, "a different family pulls the default blend below the skill match");
});

test("d192SimilaritiesAndDissimilaritiesListed + d192DissimilarityLinksToLesson", () => {
  const c = scoreContextual({
    skillMatch: 78, skillsBoth: ["kafka", "postgresql", "go"],
    posting: { ...SENIOR_BACKEND, text: POSTING }, resume: { ...SENIOR_BACKEND, text: RESUME, tech: ["Go", "Apache Kafka", "PostgreSQL", "Apache Airflow"] },
    company: { ofPostings: 22, stack: [{ tech: "Apache Kafka", postings: 14 }, { tech: "Prefect", postings: 6 }, { tech: "Terraform", postings: 9 }] },
  });
  assert.equal(c.contract, CONTEXTUAL_CONTRACT);
  assert.equal(CONTEXTUAL_CONTRACT, "2.0.0");
  assert.deepEqual(c.similarities.skills, ["kafka", "postgresql", "go"]);
  assert.deepEqual(c.similarities.stack, ["Apache Kafka"]);
  assert.deepEqual(c.similarities.ecosystem, [{ yours: "Apache Airflow", theirs: "Prefect", family: "orchestration" }]);
  assert.deepEqual(c.similarities.domains, ["fintech"]);
  assert.deepEqual(c.similarities.role, ["same_role"]);
  const gap = c.dissimilarities.find(d => d.kind === "stack_gap");
  assert.deepEqual([gap.tech, gap.action, gap.postings, gap.of], ["Terraform", "learn", 9, 22]);
  assert.ok(c.dissimilarities.some(d => d.kind === "responsibility" && /team of 5/.test(d.phrase)));
  for (const k of Object.keys(c.parts)) assert.equal(typeof c.parts[k].score, "number", k);
  assert.ok(c.score >= 0 && c.score <= 100);
});

test("a domain difference is listed and never a penalty; a shared domain lifts role fit", () => {
  assert.deepEqual(domainsIn("We build HIPAA compliant EHR tools").map(d => d.domain), ["healthcare"]);
  const base = { skillMatch: 70, posting: { ...SENIOR_BACKEND, text: "Healthcare platform, HIPAA." }, resume: { ...SENIOR_BACKEND, text: "Payments in fintech." } };
  const c = scoreContextual(base);
  assert.equal(c.parts.role_fit.score, 100);
  const d = c.dissimilarities.find(x => x.kind === "domain");
  assert.equal(d.theirs, "healthcare");
  assert.equal(d.penalty, false);
  const lifted = scoreContextual({ ...base, posting: { ...SENIOR_BACKEND, level: "mid", text: "fintech payments" } });
  assert.equal(lifted.parts.role_fit.domain_lift, 10);
});

test("d192ExistingScoreUnchanged — the skill match is passed through; scoreAtsLocally is untouched", () => {
  const job = { title: "Backend Engineer", description: POSTING };
  const basis = buildRuntimeAtsBasis({ resumeText: RESUME, signalProfile: {}, domainProfile: {} });
  const report = scoreAtsLocally({ job, runtimeBasis: basis, termWeights: null, synonyms: null });
  assert.equal("contextual" in report, false, "the v1 report gains no field");
  const c = scoreContextual({ skillMatch: report.score, posting: { text: POSTING }, resume: { text: RESUME } });
  assert.equal(c.parts.skill_match.score, report.score == null ? null : Math.round(report.score));
  assert.equal(scoreContextual({ skillMatch: null }).score, null, "a declined skill match declines the contextual score too");
});

test("the contextual module makes no model, network or database call", () => {
  const src = fs.readFileSync(path.join(HERE, "..", "src", "contextual.js"), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(src, /\bfetch\s*\(|node:https?|@anthropic-ai|messages\.create|embedding|prepare\(|import\s/);
});

test("the contract's request shape — company.techStack [{ name, category, postingShare }] and company.industry", () => {
  const company = { industry: "Healthcare", techStack: [{ name: "Apache Kafka", category: "data", postingShare: 0.64 }, { name: "Terraform", category: "devops", postingShare: 0.09 }, { name: "Tableau", category: "data", postingShare: 0.3 }] };
  const r = techStackFit(company, ["Apache Kafka"]);
  assert.equal(r.status, "ok");
  assert.equal(r.score, Math.round(100 * 640 / (640 + 90 + 300)));
  assert.deepEqual(r.gaps.map(g => [g.tech, g.share]), [["Terraform", 0.09], ["Tableau", 0.3]]);
  assert.equal(r.ecosystem.length, 0, "the caller's coarse group 'data' never makes Kafka and Tableau one purpose");
  assert.equal(techStackFit({ techStack: [] }, ["Go"]).status, "no_data");
  const c = scoreContextual({ skillMatch: 70, posting: { text: "Build services." }, resume: { text: "fintech payments" }, company });
  assert.ok(c.dissimilarities.some(d => d.kind === "domain" && d.theirs === "healthcare"), "industry read as the posting's domain");
  // 46x: a gap is LISTED from GAP_MIN_SHARE (10 % of their postings) — Tableau at 30 % is, Terraform at 9 % is not (it still costs)
  assert.ok(c.dissimilarities.some(d => d.kind === "stack_gap" && d.tech === "Tableau" && d.share === 0.3 && d.action === "learn"));
  assert.ok(!c.dissimilarities.some(d => d.kind === "stack_gap" && d.tech === "Terraform"), "under 10 % of their postings: not advice");
  assert.ok(c.parts.tech_stack.gaps.some(g => g.tech === "Terraform"), "…but the part still counts it");
});

test("with no resume.tech, the technologies are read from the résumé text (the tools service standing alone)", async () => {
  const { techMentionedIn } = await import("../src/index.js");
  assert.deepEqual(techMentionedIn("Built pipelines on Kafka and airflow; some C++", ["Apache Kafka", "Apache Airflow", "Go", "C++", "Terraform"]),
    ["Apache Kafka", "Apache Airflow", "C++"]);
  assert.deepEqual(techMentionedIn("Going forward", ["Go"]), [], "whole word only");
  const c = scoreContextual({ skillMatch: 60, posting: { text: "x" }, resume: { text: "Pipelines in Airflow, streams on Kafka" },
    company: { techStack: [{ name: "Apache Kafka", postingShare: 0.5 }, { name: "Prefect", postingShare: 0.5 }] } });
  assert.deepEqual(c.similarities.stack, ["Apache Kafka"]);
  assert.deepEqual(c.similarities.ecosystem.map(e => e.theirs), ["Prefect"]);
});

test("46x tidy: a phrase ends on a word; a same-purpose pair is said only where yours isn't already an exact match", async () => {
  const { responsibilityPhrases, PHRASE_CHARS } = await import("../src/index.js");
  const long = "What you'll do\n- Build payment infrastructure that moves money for millions of businesses across forty countries every single day of the year";
  const [p] = responsibilityPhrases(long);
  assert.ok(p.text.length <= PHRASE_CHARS + 1 && p.text.endsWith("…") && !/\b(of|for|the)…$/.test(p.text), p.text);
  const c = scoreContextual({ skillMatch: 60, posting: { text: "x" }, resume: { text: "x", tech: ["Java", "Apache Airflow"] },
    company: { techStack: [{ name: "Java", postingShare: 0.5 }, { name: "Scala", postingShare: 0.3 }, { name: "Prefect", postingShare: 0.2 }] } });
  assert.deepEqual(c.similarities.ecosystem.map(e => [e.yours, e.theirs]), [["Apache Airflow", "Prefect"]], "Java → Scala is not said: Java already matches");
  assert.ok(c.parts.tech_stack.ecosystem.some(e => e.theirs === "Scala"), "…but it still earns its half in the part");
});
