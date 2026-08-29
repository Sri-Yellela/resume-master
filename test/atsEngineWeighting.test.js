import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import {
  buildRuntimeAtsBasis, scoreAtsLocally, normaliseAtsTerm,
  MIN_SCORABLE_TERMS, SKILL_POINTS, VERB_POINTS, EXPERIENCE_POINTS, HARD_MISS_PENALTY,
} from "../services/localAtsScorer.js";
import {
  computeTermWeights, loadTermWeights, weightForDf, weightsAreStale,
  MIN_DF, NEUTRAL_WEIGHT, MIN_WEIGHT, MAX_WEIGHT, MIN_FAMILY_POSTINGS, GLOBAL_FAMILY,
  MAX_WEIGHT_AGE_DAYS,
} from "../services/atsTermWeights.js";
import { roleFamilyForTitle } from "../services/searchQueryBuilder.js";
import { MIGRATIONS } from "../scripts/migrations.js";

// ── 1. The false-match fix — the single highest-trust-cost defect AK1 removes ────────────────────

test("a multi-word term is not matched by its words appearing scattered across the resume", () => {
  // THE EXACT CASE FROM THE AUDIT. Before AK1, hasTerm fell back to "every word appears somewhere",
  // so this resume — learning materials, a coffee machine — was credited with `machine learning`
  // and the job scored 83. Measured across the live board, 22.8% of all multi-word matches were
  // this artifact ("engineering management" from "business administration management", "state
  // management" from "city state").
  const resume = "I design learning materials for a coffee machine vendor. "
               + "I ran a security program for physical access badges. I handle office logistics.";
  const basis = buildRuntimeAtsBasis({
    resumeText: resume,
    signalProfile: { skills: [], titles: [], keywords: [], yearsExperience: 5, structuredFacts: {} },
    domainProfile: {},
  });
  const job = {
    title: "ML Engineer", company: "X",
    description: "We need machine learning, computer vision, pytorch and distributed training.",
    skills_json: JSON.stringify([
      { skill: "machine learning", type: "hard" },
      { skill: "computer vision", type: "hard" },
      { skill: "pytorch", type: "hard" },
      { skill: "distributed training", type: "hard" },
      { skill: "security program", type: "hard" },
    ]),
  };
  const r = scoreAtsLocally({ job, runtimeBasis: basis });
  const matched = r.tier1_matched.map(normaliseAtsTerm);

  assert.ok(!matched.includes("machine learning"),
    `"machine learning" must not match a coffee machine and learning materials: ${r.tier1_matched.join(", ")}`);
  assert.ok(!matched.includes("computer vision"), "never present at all");
  // The control: "security program" IS literally in the resume, so it must still match. A fix that
  // simply stopped matching multi-word terms would pass the assertion above and be useless.
  assert.ok(matched.includes("security program"),
    `a phrase genuinely present must still match: ${r.tier1_matched.join(", ")}`);
});

test("a reordered or interrupted phrase still matches — precision, not brittleness", () => {
  const basis = buildRuntimeAtsBasis({
    resumeText: "Led the design of distributed systems and owned the data pipeline architecture.",
    signalProfile: { skills: [], titles: [], keywords: [], yearsExperience: 5, structuredFacts: {} },
    domainProfile: {},
  });
  const job = {
    title: "Engineer", company: "X",
    description: "distributed systems design, data pipelines, kubernetes, terraform",
    skills_json: JSON.stringify([
      { skill: "distributed systems design", type: "hard" },
      { skill: "kubernetes", type: "hard" },
      { skill: "terraform", type: "hard" },
      { skill: "observability", type: "hard" },
    ]),
  };
  const matched = scoreAtsLocally({ job, runtimeBasis: basis }).tier1_matched.map(normaliseAtsTerm);
  assert.ok(matched.includes("distributed system design"),
    "one inserted word inside the window is a real match, not a coincidence");
});

// ── 2. Consistency (Phase 3 item 3, asserted here because it is a property of the engine) ────────

test("the same job and resume produce an identical report ten times running", () => {
  const basis = buildRuntimeAtsBasis({
    resumeText: "Built Python services on Kubernetes with PostgreSQL. Designed distributed systems.",
    signalProfile: { skills: ["Python", "Kubernetes"], titles: ["Engineer"], keywords: [], yearsExperience: 6, structuredFacts: {} },
    domainProfile: {},
  });
  const job = {
    title: "Backend Engineer", company: "Acme",
    description: "Python, Kubernetes, PostgreSQL, Kafka. Requires 4 years experience.",
    skills_json: JSON.stringify([
      { skill: "Python", type: "hard" }, { skill: "Kubernetes", type: "hard" },
      { skill: "PostgreSQL", type: "hard" }, { skill: "Kafka", type: "hard" },
    ]),
  };
  const first = JSON.stringify(scoreAtsLocally({ job, runtimeBasis: basis }));
  for (let i = 0; i < 9; i++) {
    assert.equal(JSON.stringify(scoreAtsLocally({ job, runtimeBasis: basis })), first,
      `run ${i + 2} differed — the scorer must be deterministic to be trustworthy`);
  }
  // Weighting must not break determinism either.
  const weights = new Map([["python", 1.8], ["kubernetes", 0.5]]);
  const w1 = JSON.stringify(scoreAtsLocally({ job, runtimeBasis: basis, termWeights: weights }));
  const w2 = JSON.stringify(scoreAtsLocally({ job, runtimeBasis: basis, termWeights: weights }));
  assert.equal(w1, w2);
});

// ── 3. Declining to score, instead of fabricating a number ───────────────────────────────────────

test("a posting with almost nothing extractable is DECLINED, not scored 50", () => {
  // ratio() returns 1 on an empty denominator, so before AK1 a posting nothing could be extracted
  // from took a full skill component and emerged around 50 — a confident number about nothing.
  const basis = buildRuntimeAtsBasis({
    resumeText: "Engineer with ten years of experience building things.",
    signalProfile: { skills: ["Python"], titles: [], keywords: [], yearsExperience: 10, structuredFacts: {} },
    domainProfile: {},
  });
  const r = scoreAtsLocally({
    job: { title: "Engineer", company: "X", description: "Join our mission. We value people." },
    runtimeBasis: basis,
  });
  assert.equal(r.score, null, "an unscorable posting must not produce a number");
  assert.equal(r.scorable, false);
  assert.ok(r.decline_reasons.length > 0, "and it must say why");
  assert.match(r.decline_reasons.join(" "), /scorable term/);
});

test("a profile with no resume and no skills is DECLINED", () => {
  const basis = buildRuntimeAtsBasis({ resumeText: "", signalProfile: {}, domainProfile: {} });
  const r = scoreAtsLocally({
    job: {
      title: "Engineer", company: "X", description: "Python, Kubernetes, Kafka, Terraform.",
      skills_json: JSON.stringify([
        { skill: "Python", type: "hard" }, { skill: "Kubernetes", type: "hard" },
        { skill: "Kafka", type: "hard" }, { skill: "Terraform", type: "hard" },
      ]),
    },
    runtimeBasis: basis,
  });
  assert.equal(r.score, null);
  assert.match(r.decline_reasons.join(" "), /No resume text and no profile skills/);
});

test("a scorable report says so, and reports whether weighting was applied", () => {
  const basis = buildRuntimeAtsBasis({
    resumeText: "Python Kubernetes Kafka Terraform engineer.",
    signalProfile: { skills: ["Python"], titles: [], keywords: [], yearsExperience: 5, structuredFacts: {} },
    domainProfile: {},
  });
  const job = {
    title: "Engineer", company: "X", description: "Python, Kubernetes, Kafka, Terraform.",
    skills_json: JSON.stringify([
      { skill: "Python", type: "hard" }, { skill: "Kubernetes", type: "hard" },
      { skill: "Kafka", type: "hard" }, { skill: "Terraform", type: "hard" },
    ]),
  };
  const plain = scoreAtsLocally({ job, runtimeBasis: basis });
  assert.equal(plain.scorable, true);
  assert.equal(typeof plain.score, "number");
  assert.deepEqual(plain.weighting, { applied: false, terms: 0 });

  const weighted = scoreAtsLocally({ job, runtimeBasis: basis, termWeights: new Map([["python", 2]]) });
  assert.equal(weighted.weighting.applied, true);
  assert.equal(weighted.weighting.terms, 1);
});

// ── 4. The composition — the defects the audit measured must not come back ───────────────────────

test("the points still sum to 100, and hard constraints only ever subtract", () => {
  assert.equal(SKILL_POINTS + VERB_POINTS + EXPERIENCE_POINTS, 100,
    "the three earnable components are the whole scale");
  assert.ok(HARD_MISS_PENALTY > 0, "a constraint miss is a penalty");
  const src = fs.readFileSync("services/localAtsScorer.js", "utf8");
  assert.match(src, /- hardPenalty/, "constraints are subtracted, never added");
  assert.doesNotMatch(src, /HARD_POINTS/,
    "the v3 budget that PAID for having no clearance problem must be gone");
  // Skills must dominate: the thing the product claims to measure has to be the thing that moves
  // the number. In v3 the skill component correlated r=0.21 with the final score.
  assert.ok(SKILL_POINTS > EXPERIENCE_POINTS + VERB_POINTS,
    "skill overlap must outweigh everything else combined");
});

test("experience is graded, not a cliff — and being far over-qualified costs something", () => {
  const mk = (yrs) => buildRuntimeAtsBasis({
    resumeText: "Python Kubernetes Kafka Terraform PostgreSQL engineer building distributed systems.",
    signalProfile: { skills: ["Python"], titles: [], keywords: [], yearsExperience: yrs, structuredFacts: {} },
    domainProfile: {},
  });
  const job = {
    title: "Engineer", company: "X",
    description: "Python, Kubernetes, Kafka, Terraform. Requires 5 years of experience.",
    skills_json: JSON.stringify([
      { skill: "Python", type: "hard" }, { skill: "Kubernetes", type: "hard" },
      { skill: "Kafka", type: "hard" }, { skill: "Terraform", type: "hard" },
    ]),
  };
  const at = (y) => scoreAtsLocally({ job, runtimeBasis: mk(y) }).score;

  // Graded, not binary: four distinct outcomes below the requirement, where v3 had exactly one.
  const below = [at(1), at(3), at(4), at(5)];
  assert.ok(below[0] < below[1] && below[1] < below[2] && below[2] < below[3],
    `falling further short must cost more, monotonically: ${below.join(" -> ")}`);
  assert.ok(new Set(below).size === 4, "a cliff produces two values; a grade produces many");

  // Over-qualification is a real mismatch, so it tapers rather than plateauing forever.
  assert.ok(at(25) < at(5), `a 25-year candidate on a 5-year role must not outrank a clean fit`);
  assert.ok(at(25) > at(1), "but over-qualified still beats badly under-qualified");
});

// ── 5. The weight table ──────────────────────────────────────────────────────────────────────────

test("a term below the document-frequency floor gets NEUTRAL weight, not maximum", () => {
  // THE POINT OF THE WHOLE MODULE. 69.9% of this corpus's distinct terms appear in exactly one
  // posting, and they are LLM phrasings — "passion for mission", "japanese fluency". Plain IDF
  // hands those the maximum weight, which is the opposite of the intent.
  assert.equal(weightForDf(1, 1289), NEUTRAL_WEIGHT);
  assert.equal(weightForDf(MIN_DF - 1, 1289), NEUTRAL_WEIGHT);
  assert.ok(weightForDf(MIN_DF, 1289) > NEUTRAL_WEIGHT, "at the floor, rarity starts to count");
});

test("weights are bounded, and a ubiquitous term is damped rather than zeroed", () => {
  const N = 1289;
  for (const df of [MIN_DF, 10, 50, 200, 600, N]) {
    const w = weightForDf(df, N);
    assert.ok(w >= MIN_WEIGHT && w <= MAX_WEIGHT, `df=${df} produced ${w}, outside [${MIN_WEIGHT}, ${MAX_WEIGHT}]`);
  }
  assert.ok(weightForDf(MIN_DF, N) > weightForDf(200, N), "rarer must weigh more");
  assert.ok(weightForDf(N, N) >= MIN_WEIGHT, "a term in every posting still counts for something");
});

test("weights carry provenance and are refused once stale", () => {
  const now = 1_800_000_000;
  assert.equal(weightsAreStale(now - 86400, now), false);
  assert.equal(weightsAreStale(now - (MAX_WEIGHT_AGE_DAYS + 1) * 86400, now), true);
  assert.equal(weightsAreStale(null, now), true, "no timestamp is not a fresh timestamp");
  assert.equal(weightsAreStale(0, now), true);
});

test("computeTermWeights scopes by role family and skips families too small to speak", () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m.sql);

  // search_query and _hash are NOT NULL without a default on this table.
  const stmt = db.prepare(
    "INSERT INTO scraped_jobs (job_id, title, normalized_title, company, skills_json, search_query, _hash) VALUES (?,?,?,?,?,?,?)"
  );
  const insert = (id, title, norm, company, skills) => stmt.run(id, title, norm, company, skills, "t", id);
  // Enough engineering postings to clear MIN_FAMILY_POSTINGS, plus a handful of design ones that
  // deliberately do not.
  const common = { skill: "communication", type: "soft" };
  for (let i = 0; i < MIN_FAMILY_POSTINGS + 5; i++) {
    insert(`e${i}`, "Software Engineer", "software engineer", "Acme", JSON.stringify([
      { skill: "python", type: "hard" }, common,
      ...(i < MIN_DF ? [{ skill: "kubernetes", type: "hard" }] : []),
      { skill: `bespoke phrasing ${i}`, type: "hard" },
    ]));
  }
  for (let i = 0; i < 5; i++) {
    insert(`d${i}`, "Product Designer", "product designer", "Acme",
      JSON.stringify([{ skill: "figma", type: "hard" }, common]));
  }

  const result = computeTermWeights(db, { now: 1_800_000_000 });
  const families = result.families.map(f => f.family);
  assert.ok(families.includes(GLOBAL_FAMILY), "a global table is always written");
  assert.ok(families.includes("engineering"), "a family over the minimum gets its own weights");
  assert.ok(!families.includes("design"), "five postings cannot support their own weight table");

  const eng = loadTermWeights(db, "engineering", { now: 1_800_000_000 });
  assert.equal(eng.family, "engineering");
  assert.equal(eng.stale, false);
  assert.ok(eng.corpusSize > 0);
  // "python" is in every engineering posting; "kubernetes" is in exactly MIN_DF of them.
  assert.ok(eng.weights.get("kubernetes") > eng.weights.get("python"),
    "the rarer term must outweigh the ubiquitous one");
  // The per-posting singletons never reach the table at all — absence means neutral.
  assert.equal(eng.weights.has("bespoke phrasing 3"), false,
    "a term seen once is not evidence and must not be stored as a weight");

  // A family with no table of its own falls back to global rather than to nothing.
  const design = loadTermWeights(db, "design", { now: 1_800_000_000 });
  assert.equal(design.family, GLOBAL_FAMILY);
  assert.ok(design.weights.size > 0);
  db.close();
});

test("loadTermWeights degrades to unweighted rather than throwing when the table is absent", () => {
  const db = new Database(":memory:");
  const r = loadTermWeights(db, "engineering");
  assert.equal(r.weights.size, 0);
  assert.equal(r.stale, true, "no table is not fresh weights");
  db.close();
});

test("scoring is unchanged when no weights are supplied — an unweighted deployment is not broken", () => {
  const basis = buildRuntimeAtsBasis({
    resumeText: "Python Kubernetes engineer with Kafka and Terraform.",
    signalProfile: { skills: ["Python"], titles: [], keywords: [], yearsExperience: 5, structuredFacts: {} },
    domainProfile: {},
  });
  const job = {
    title: "Engineer", company: "X", description: "Python, Kubernetes, Kafka, Terraform.",
    skills_json: JSON.stringify([
      { skill: "Python", type: "hard" }, { skill: "Kubernetes", type: "hard" },
      { skill: "Kafka", type: "hard" }, { skill: "Terraform", type: "hard" },
    ]),
  };
  const none = scoreAtsLocally({ job, runtimeBasis: basis, termWeights: null });
  const empty = scoreAtsLocally({ job, runtimeBasis: basis, termWeights: new Map() });
  assert.equal(none.score, empty.score, "an empty weight map must behave exactly as no map");
  assert.equal(typeof none.score, "number");
});

test("weighting changes the number it should and leaves the report's terms alone", () => {
  const basis = buildRuntimeAtsBasis({
    resumeText: "Rust systems engineer. Wrote Rust for embedded targets.",
    signalProfile: { skills: ["Rust"], titles: [], keywords: [], yearsExperience: 5, structuredFacts: {} },
    domainProfile: {},
  });
  const job = {
    title: "Engineer", company: "X", description: "Rust, communication, collaboration, teamwork.",
    skills_json: JSON.stringify([
      { skill: "Rust", type: "hard" }, { skill: "communication", type: "hard" },
      { skill: "collaboration", type: "hard" }, { skill: "teamwork", type: "hard" },
    ]),
  };
  // Rust is the rare, meaningful term; the other three are filler that half the corpus asks for.
  const weights = new Map([["rust", 2.0], ["communication", 0.35], ["collaboration", 0.35], ["teamwork", 0.35]]);
  const plain = scoreAtsLocally({ job, runtimeBasis: basis });
  const weighted = scoreAtsLocally({ job, runtimeBasis: basis, termWeights: weights });

  assert.ok(weighted.score > plain.score,
    `matching the term that matters must be worth more than matching filler (${plain.score} -> ${weighted.score})`);
  assert.deepEqual(weighted.tier1_matched, plain.tier1_matched, "weighting must not change WHICH terms matched");
  assert.deepEqual(weighted.tier1_missing, plain.tier1_missing);
});

// ── 6. Role families reuse the existing vocabulary ───────────────────────────────────────────────

test("role family comes from ROLE_ALIAS_MAP, not a second vocabulary", () => {
  assert.equal(roleFamilyForTitle("software engineer"), "engineering");
  assert.equal(roleFamilyForTitle("Staff Software Engineer, Service Infrastructure"), "engineering");
  assert.equal(roleFamilyForTitle("data scientist"), "data");
  assert.equal(roleFamilyForTitle("product manager"), "pm");
  // No guess when nothing matches: the caller falls back to the global table, which is merely less
  // specific, where a wrong family would score a designer against infrastructure vocabulary.
  assert.equal(roleFamilyForTitle("Chief Happiness Officer"), null);
  assert.equal(roleFamilyForTitle(""), null);
  assert.equal(roleFamilyForTitle(null), null);

  // Word-bounded, so a substring cannot smuggle in a family.
  assert.notEqual(roleFamilyForTitle("audiology technician"), "engineering");

  const src = fs.readFileSync("services/searchQueryBuilder.js", "utf8");
  assert.match(src, /ROLE_ALIAS_MAP\.json/, "the one role vocabulary stays the one role vocabulary");
});

// ── 7. The migration is byte-identical in both runners ───────────────────────────────────────────

test("migration 093 is byte-identical in both migration runners", () => {
  const grab = (file) => {
    const src = fs.readFileSync(file, "utf8");
    const i = src.indexOf(`id: "093_ats_term_weights"`);
    assert.ok(i > 0, `093 missing from ${file}`);
    const start = src.lastIndexOf("{", i);
    const end = src.indexOf("\n    },", i);
    return src.slice(start, end).replace(/\r\n/g, "\n").replace(/^\s+/gm, "");
  };
  assert.equal(grab("scripts/migrations.js"), grab("server.js"),
    "the boot-time runner and the CLI runner must apply the same DDL");
});

test("093 is appended at the end and every migration id is unique", () => {
  const src = fs.readFileSync("scripts/migrations.js", "utf8");
  const ids = [...src.matchAll(/id: "(\d{3}_[a-z0-9_]+)"/g)].map(m => m[1]);

  // UNIQUENESS IS THE PROPERTY THAT MATTERS, and it is on the FULL id: schema_migrations keys on
  // the whole string, so `013_employment_type` and `013_domain_profiles` — which do both exist —
  // are two distinct migrations that both apply. A shared numeric prefix is untidy, not a bug, and
  // asserting on the prefix instead would fail on a codebase that is actually correct.
  assert.equal(new Set(ids).size, ids.length, "a duplicate full id would silently skip a migration");

  // Additive: the new one is last, so no applied migration was edited or reordered ahead of it.
  assert.equal(ids[ids.length - 1], "093_ats_term_weights");
  assert.ok(ids.every(id => Number(id.slice(0, 3)) <= 93), "093 is the high-water mark");
});

// ── 8. The gate cannot auto-submit on a score it never saw ───────────────────────────────────────

test("auto-apply holds when the score is null, rather than falling through the gate", () => {
  const src = fs.readFileSync("routes/apply.js", "utf8");
  assert.match(src, /mode === "auto" && \(atsScore === null \|\| atsScore < ATS_AUTO_APPLY_THRESHOLD\)/,
    "an unknown score must hold; it used to pass");
  assert.match(src, /const unscorable = gen\.atsScore == null/,
    "the generated-resume gate must distinguish 'declined' from 'scored zero'");
  assert.doesNotMatch(src, /atsScore !== null && atsScore < ATS_AUTO_APPLY_THRESHOLD/,
    "the old fall-through must not survive anywhere");
});

test("MIN_SCORABLE_TERMS is small enough not to silence the real board", () => {
  // The guard exists for the fabricated-50 case, not to refuse ordinary postings. Measured on the
  // live board it declines 1 of 1291. If this number grows, the engine has gone quiet on real jobs.
  assert.ok(MIN_SCORABLE_TERMS >= 2 && MIN_SCORABLE_TERMS <= 6,
    `MIN_SCORABLE_TERMS=${MIN_SCORABLE_TERMS} is outside the range that was measured against the board`);
});
