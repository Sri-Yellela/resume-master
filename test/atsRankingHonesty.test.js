import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { buildRuntimeAtsBasis, scoreAtsLocally, LOCAL_ATS_SOURCE } from "../services/localAtsScorer.js";
import { MIGRATIONS } from "../scripts/migrations.js";
import { capturedAtsAtApply } from "../routes/apply.js";

/**
 * AK1 Phase 3 — the adversarial cases, asserted rather than described.
 *
 * These are the four shapes from the brief where an engine measuring VOCABULARY rather than FIT
 * gives itself away. They run on synthetic postings on purpose: the live board is not checked into
 * the repo, and a test that silently passes when data/resume_master.db is absent proves nothing.
 * The measured numbers from the real 1291-posting run are recorded in docs/ak1-ats-ranking.md.
 */

const SENIOR_BACKEND = `
JANE OKAFOR - Senior Backend Engineer
EXPERIENCE
Backend Engineer, Payments Platform (2019-2026)
- Designed and scaled distributed systems in Python and Go handling 40k requests per second.
- Built REST and GraphQL APIs; owned API design, versioning and backwards compatibility.
- Migrated a monolith to microservices on Kubernetes and Docker running on AWS.
- Built data pipelines with Kafka and Airflow feeding PostgreSQL and Redis.
- Led incident response and on-call; mentored four engineers.
SKILLS
Python, Go, SQL, PostgreSQL, Redis, Kafka, Kubernetes, Docker, AWS, Terraform,
distributed systems, microservices, API design, system design, data pipelines
`;

const basisFor = (resumeText, yearsExperience, skills, titles = ["Backend Engineer"]) =>
  buildRuntimeAtsBasis({
    resumeText,
    signalProfile: { skills, titles, keywords: [], yearsExperience, structuredFacts: {} },
    domainProfile: {},
  });

const SENIOR = basisFor(SENIOR_BACKEND, 7,
  ["Python", "Go", "Kubernetes", "AWS", "PostgreSQL", "distributed systems", "API design"]);

const job = (title, description, skills, extra = {}) => ({
  title, company: "Acme", normalized_title: title.toLowerCase(), description,
  skills_json: JSON.stringify(skills.map(s => typeof s === "string" ? { skill: s, type: "hard" } : s)),
  ...extra,
});

// ── Adversarial case 1: a role far above the profile's experience ────────────────────────────────

test("ADVERSARIAL 1: a role demanding far more experience than the profile scores lower", () => {
  const skills = ["Python", "Kubernetes", "distributed systems", "API design", "Go"];
  const near = job("Senior Backend Engineer",
    "Build distributed systems in Python and Go on Kubernetes. Requires 5 years of experience.", skills);
  const far = job("Principal Backend Engineer",
    "Build distributed systems in Python and Go on Kubernetes. Requires 15 years of experience.", skills);

  const nearScore = scoreAtsLocally({ job: near, runtimeBasis: SENIOR }).score;
  const farScore = scoreAtsLocally({ job: far, runtimeBasis: SENIOR }).score;

  // The term overlap is IDENTICAL between these two postings — only the years differ. An engine
  // measuring vocabulary rather than fit scores them the same.
  assert.ok(farScore < nearScore,
    `identical vocabulary, 15y vs 5y: the over-levelled role must score lower (${nearScore} -> ${farScore})`);
  assert.ok(nearScore - farScore >= 5,
    `the gap must be meaningful, not a rounding artifact (${nearScore - farScore} points)`);
});

test("ADVERSARIAL 1b: a junior profile scores below a senior one on the same senior posting", () => {
  const junior = basisFor(
    "Alex Chen. Software Engineer I. Wrote Python scripts and small REST endpoints. Fixed bugs, wrote unit tests.",
    2, ["Python", "SQL"], ["Software Engineer"]);
  const posting = job("Staff Backend Engineer",
    "Own distributed systems in Python and Go on Kubernetes and AWS. Requires 10 years of experience.",
    ["Python", "Go", "Kubernetes", "AWS", "distributed systems"]);

  const seniorScore = scoreAtsLocally({ job: posting, runtimeBasis: SENIOR }).score;
  const juniorScore = scoreAtsLocally({ job: posting, runtimeBasis: junior }).score;
  assert.ok(juniorScore < seniorScore,
    `a 2-year profile must not outrank a 7-year one on a 10-year role (${juniorScore} vs ${seniorScore})`);
});

// ── Adversarial case 2: a different discipline sharing vocabulary ────────────────────────────────

test("ADVERSARIAL 2: a data role heavy on Python scores below a backend role, for a backend resume", () => {
  // The trap: both postings say "Python" and "SQL". Only the surrounding skills differ. An engine
  // matching on shared vocabulary alone cannot separate these.
  const backend = job("Backend Engineer",
    "Build backend services in Python. Own API design, distributed systems, Kubernetes and PostgreSQL.",
    ["Python", "SQL", "API design", "distributed systems", "Kubernetes", "PostgreSQL"]);
  const data = job("Data Scientist",
    "Analyse data in Python and SQL. Build statistical models, run experiments, own dashboards.",
    ["Python", "SQL", "statistical modeling", "experimentation", "data visualization", "hypothesis testing"]);

  const b = scoreAtsLocally({ job: backend, runtimeBasis: SENIOR }).score;
  const d = scoreAtsLocally({ job: data, runtimeBasis: SENIOR }).score;
  assert.ok(b > d,
    `shared Python/SQL vocabulary must not let a data role match a backend resume as well as a backend role (backend ${b}, data ${d})`);
});

// ── Adversarial case 3: mostly company boilerplate ───────────────────────────────────────────────

test("ADVERSARIAL 3: a posting that is all boilerplate DECLINES rather than scoring ~50", () => {
  // Verbatim-shaped Stripe boilerplate with the requirements removed. Before AK1 this scored
  // around 50, because ratio() returns 1 on an empty denominator — a confident number about a
  // posting nothing had been extracted from.
  const boilerplate = {
    title: "Software Engineer", company: "Acme", normalized_title: "software engineer",
    description: "Who we are. Acme is a financial infrastructure platform for businesses. "
      + "Millions of companies use Acme to accept payments, grow their revenue, and accelerate new "
      + "business opportunities. Our mission is to increase the GDP of the internet, and we have a "
      + "staggering amount of work ahead. That means you have an unprecedented opportunity to put "
      + "the global economy within everyone's reach while doing the most important work of your career.",
    skills_json: null,
  };
  const r = scoreAtsLocally({ job: boilerplate, runtimeBasis: SENIOR });
  assert.equal(r.score, null, "no number may be produced from a posting with no requirements in it");
  assert.equal(r.scorable, false);
  assert.match(r.decline_reasons.join(" "), /scorable term/);
});

// ── Adversarial case 4: near-duplicate postings must score alike ─────────────────────────────────

test("ADVERSARIAL 4: near-duplicate postings from the same company score within a point or two", () => {
  const skills = ["Python", "Kubernetes", "distributed systems", "API design", "PostgreSQL"];
  const a = job("Backend Engineer, Payments",
    "Join the Payments team. Build distributed systems in Python on Kubernetes with PostgreSQL. Own API design. Requires 5 years of experience.", skills);
  const b = job("Backend Engineer, Payments",
    "Join the Payments group. Build distributed systems in Python on Kubernetes with PostgreSQL. Own API design. Requires 5 years of experience. We are a fast-moving team.", skills);

  const sa = scoreAtsLocally({ job: a, runtimeBasis: SENIOR }).score;
  const sb = scoreAtsLocally({ job: b, runtimeBasis: SENIOR }).score;
  assert.ok(Math.abs(sa - sb) <= 3,
    `two near-identical postings must not diverge — an unstable engine cannot be ranked on (${sa} vs ${sb})`);
});

// ── The regression the ordinal spot-check diagnosed ──────────────────────────────────────────────

test("an ambiguous skill word is not admitted from the job text alone", () => {
  // DIAGNOSED FROM A REAL INVERSION. "Staff UX Researcher (Mixed Methods)" ranked 11th of 30 against
  // a backend resume because the registry admitted `Go` from the English word "go" in the posting,
  // and the candidate lists Go. Fixing it moved Spearman rho from 0.448 to 0.504 on the judged set.
  const uxLike = {
    title: "UX Researcher", company: "Acme", normalized_title: "ux researcher",
    description: "You will go deep on qualitative research, go broad on survey design, "
      + "run statistical analysis and user research, and go to market with findings.",
    skills_json: JSON.stringify([
      { skill: "qualitative research", type: "hard" }, { skill: "survey design", type: "hard" },
      { skill: "statistical analysis", type: "hard" }, { skill: "user research", type: "hard" },
    ]),
  };
  const r = scoreAtsLocally({ job: uxLike, runtimeBasis: SENIOR });
  const matched = r.tier1_matched.map(t => t.toLowerCase());
  assert.ok(!matched.includes("go"),
    `"go" as an English verb must not be credited as the language: ${r.tier1_matched.join(", ")}`);

  // The control: when the enrichment — something that actually READ the posting — names Go, it is
  // admitted. The rule is "corroborate ambiguous terms", not "never match Go".
  const realGo = {
    title: "Backend Engineer", company: "Acme", normalized_title: "backend engineer",
    description: "Write services in Go. Kubernetes, PostgreSQL, distributed systems.",
    skills_json: JSON.stringify([
      { skill: "Go", type: "hard" }, { skill: "Kubernetes", type: "hard" },
      { skill: "PostgreSQL", type: "hard" }, { skill: "distributed systems", type: "hard" },
    ]),
  };
  const r2 = scoreAtsLocally({ job: realGo, runtimeBasis: SENIOR });
  assert.ok(r2.tier1_matched.map(t => t.toLowerCase()).includes("go"),
    `a posting the enrichment says wants Go must still match it: ${r2.tier1_matched.join(", ")}`);
});

test("the flat rate for an unknown experience requirement is deliberate, and documented as measured", () => {
  // Renormalising over the components that carry information is the obvious alternative and it was
  // MEASURED WORSE (rho 0.448 -> 0.242). The comment carrying that result is the thing stopping the
  // next person from re-introducing it, so it is asserted.
  const src = fs.readFileSync("services/localAtsScorer.js", "utf8");
  assert.match(src, /RENORMALIS/i, "the measured-and-rejected alternative must stay recorded");
  assert.match(src, /0\.448/, "with the number that rejected it");
  assert.match(src, /expRatio == null \? 0\.85/, "and the flat rate it was rejected in favour of");
});

// ── Ground truth: recorded now, claimed from never ───────────────────────────────────────────────

test("migration 094 is byte-identical in both runners and only ADDS columns", () => {
  const grab = (file) => {
    const src = fs.readFileSync(file, "utf8");
    const i = src.indexOf(`id: "094_application_ats_provenance"`);
    assert.ok(i > 0, `094 missing from ${file}`);
    return src.slice(src.lastIndexOf("{", i), src.indexOf("\n    },", i))
      .replace(/\r\n/g, "\n").replace(/^\s+/gm, "");
  };
  const sql = grab("scripts/migrations.js");
  assert.equal(sql, grab("server.js"));
  assert.doesNotMatch(sql, /\bDROP\b|\bUPDATE\b|\bDELETE\b/i,
    "an additive migration may not rewrite existing rows");
});

test("an application records the score AND the scorer version that produced it", () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m.sql);

  db.prepare("INSERT INTO scraped_jobs (job_id,title,company,search_query,_hash,ats_report) VALUES (?,?,?,?,?,?)")
    .run("j1", "Backend Engineer", "Acme", "t", "h1",
      JSON.stringify({ source: LOCAL_ATS_SOURCE, score: 61, tier1_missing: ["kafka"] }));

  const stamped = capturedAtsAtApply(db, 1, "j1");
  assert.equal(stamped.score, 61);
  assert.equal(stamped.version, LOCAL_ATS_SOURCE,
    "a score without its scorer cannot be compared with any other score");
  assert.match(stamped.report, /kafka/, "the missing terms are kept — that is the useful half");

  // A DECLINED report carries no score, and must not be recorded as one.
  db.prepare("INSERT INTO scraped_jobs (job_id,title,company,search_query,_hash,ats_report) VALUES (?,?,?,?,?,?)")
    .run("j2", "Engineer", "Acme", "t", "h2",
      JSON.stringify({ source: LOCAL_ATS_SOURCE, score: null, scorable: false }));
  assert.equal(capturedAtsAtApply(db, 1, "j2").score, null,
    "a declined score must not become a data point in the only dataset that can validate this number");

  // An unscored job stamps nulls rather than a fabricated zero.
  assert.deepEqual(capturedAtsAtApply(db, 1, "nope"), { score: null, version: null, report: null });
  db.close();
});

test("the version stamped is the report's OWN source, not today's constant", () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m.sql);
  // A cached report produced by an older scorer. Stamping today's version onto it is exactly the
  // lie the column exists to prevent: v3 and v4 disagree by ~17 points on the same fit.
  db.prepare("INSERT INTO scraped_jobs (job_id,title,company,search_query,_hash,ats_report) VALUES (?,?,?,?,?,?)")
    .run("old", "Engineer", "Acme", "t", "h",
      JSON.stringify({ source: "local_ats_v3", score: 45 }));
  const stamped = capturedAtsAtApply(db, 1, "old");
  assert.equal(stamped.version, "local_ats_v3");
  assert.notEqual(stamped.version, LOCAL_ATS_SOURCE);
  db.close();
});

test("both application writers stamp the score — neither route may leave a hole in the dataset", () => {
  const apply = fs.readFileSync("routes/apply.js", "utf8");
  const server = fs.readFileSync("server.js", "utf8");
  for (const [name, src] of [["routes/apply.js", apply], ["server.js", server]]) {
    assert.match(src, /INSERT INTO job_applications[\s\S]{0,600}ats_score_at_apply/,
      `${name} writes job_applications without stamping the score`);
    assert.match(src, /ats_score_at_apply=COALESCE\(job_applications\.ats_score_at_apply/,
      `${name} must keep the FIRST stamp — re-recording must not overwrite the score that was true when it was sent`);
  }
});
