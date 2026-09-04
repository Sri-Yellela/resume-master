// G1 — the skill synonym table.
//
// ⛔ THE PROPERTY THIS FILE EXISTS TO PROTECT: A FALSE EQUIVALENCE IS A CONFIDENTLY WRONG MATCH.
// It is the same class as the "coffee machine vendor" credited with machine learning (22.8% of all
// multi-word matches before AK1's proximity fix), and it is worse in reach — a wrong org unit is a
// wrong label on one card, while a wrong synonym shifts every posting mentioning either term, in
// the same direction, invisibly.
//
// The real extraction pass proposed `mysql ~ postgresql` (competing databases, which its own prompt
// explicitly forbade), `ci cd ~ production debugging` and `data engineering ~ data visualization`.
// That is not a hypothetical: it is what the model actually returned, at 25 corroborating postings
// each. Corroboration cannot promote here, and these tests are why.

import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { scoreAtsLocally, buildRuntimeAtsBasis } from "../services/localAtsScorer.js";
import {
  recordSynonymProposals, loadConfirmedSynonyms, confirmSynonym, rejectSynonym,
  listProposals, canonicalPair, synonymStats,
} from "../services/kb/skillSynonyms.js";

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE skill_synonyms (
      term TEXT NOT NULL, equivalent TEXT NOT NULL, relation TEXT NOT NULL DEFAULT 'related',
      confidence REAL NOT NULL DEFAULT 0, corroboration_count INTEGER NOT NULL DEFAULT 0,
      source_postings_json TEXT, status TEXT NOT NULL DEFAULT 'proposed',
      reviewed_at INTEGER, reviewed_by TEXT, first_seen INTEGER, last_seen INTEGER,
      updated_at INTEGER, PRIMARY KEY (term, equivalent)
    );
  `);
  return db;
}

const propose = (db, pairs) => recordSynonymProposals(db, pairs);

// ── PROMOTION IS A HUMAN ACT ────────────────────────────────────────────────────────────────────

test("corroboration NEVER promotes — 50 postings do not make a pair true", () => {
  const db = makeDb();
  const many = Array.from({ length: 50 }, (_, i) => ({
    term: "mysql", equivalent: "postgresql", relation: "related", jobId: `j${i}`,
  }));
  propose(db, many);
  const row = db.prepare("SELECT * FROM skill_synonyms").get();
  assert.equal(row.status, "proposed");
  assert.equal(row.corroboration_count, 50);
  assert.equal(row.confidence, 1, "confidence saturates — and still does not promote");
  assert.equal(loadConfirmedSynonyms(db).size, 0,
    "the scorer must see nothing: postings using both words is not evidence they mean the same thing");
  db.close();
});

test("only confirmSynonym reaches the scorer", () => {
  const db = makeDb();
  propose(db, [{ term: "k8s", equivalent: "kubernetes", relation: "alias", jobId: "j1" }]);
  assert.equal(loadConfirmedSynonyms(db).size, 0);
  assert.equal(confirmSynonym(db, "k8s", "kubernetes"), true);
  const map = loadConfirmedSynonyms(db);
  assert.deepEqual(map.get("k8s"), ["kubernetes"]);
  assert.deepEqual(map.get("kubernetes"), ["k8s"], "one stored row, expanded BOTH ways");
  db.close();
});

test("a rejection is STICKY — a later pass cannot resurrect it", () => {
  // The extraction is re-runnable and the corpus that produced a bad pair will keep producing it.
  // If a later run could reset it to 'proposed', every review decision would have to be made again
  // on every pass, and the one that slipped through would be the one nobody re-checked.
  const db = makeDb();
  propose(db, [{ term: "mysql", equivalent: "postgresql", jobId: "j1" }]);
  rejectSynonym(db, "mysql", "postgresql");

  propose(db, [{ term: "mysql", equivalent: "postgresql", jobId: "j2" },
               { term: "mysql", equivalent: "postgresql", jobId: "j3" }]);

  const row = db.prepare("SELECT * FROM skill_synonyms").get();
  assert.equal(row.status, "rejected");
  assert.equal(row.corroboration_count, 1, "and it is not reinforced either");
  assert.equal(synonymStats(db).rejected, 1);
  db.close();
});

test("a confirmation survives a later pass too", () => {
  const db = makeDb();
  propose(db, [{ term: "mentoring", equivalent: "mentorship", relation: "alias", jobId: "j1" }]);
  confirmSynonym(db, "mentoring", "mentorship", "owner");
  propose(db, [{ term: "mentoring", equivalent: "mentorship", relation: "related", jobId: "j2" }]);
  const row = db.prepare("SELECT * FROM skill_synonyms").get();
  assert.equal(row.status, "confirmed");
  assert.equal(row.relation, "alias", "a later pass must not downgrade a reviewed row's claim either");
  db.close();
});

// ── THE PAIR IS ONE FACT ────────────────────────────────────────────────────────────────────────

test("(a,b) and (b,a) are the same row", () => {
  // Two rows would double-count corroboration and let a reviewer confirm one direction while
  // rejecting the other — a table that contradicts itself depending on which way you read it.
  const db = makeDb();
  propose(db, [{ term: "k8s", equivalent: "kubernetes", jobId: "j1" },
               { term: "kubernetes", equivalent: "k8s", jobId: "j2" }]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM skill_synonyms").get().c, 1);
  assert.equal(db.prepare("SELECT corroboration_count c FROM skill_synonyms").get().c, 2);
  // Confirming through either spelling confirms the one fact.
  assert.equal(confirmSynonym(db, "kubernetes", "k8s"), true);
  assert.equal(loadConfirmedSynonyms(db).size, 2);
  db.close();
});

test("a term is never its own synonym, however it is spelled", () => {
  assert.equal(canonicalPair("Kubernetes", "kubernetes"), null);
  assert.equal(canonicalPair("k8s", ""), null);
  assert.equal(canonicalPair(null, "python"), null);
});

test("'related' is the weaker claim and wins when a pass disagrees", () => {
  // Upgrading to 'alias' on one model's say-so would relax review on exactly the rows that need it.
  const db = makeDb();
  propose(db, [{ term: "log analysis", equivalent: "observability", relation: "alias", jobId: "j1" },
               { term: "log analysis", equivalent: "observability", relation: "related", jobId: "j2" }]);
  assert.equal(db.prepare("SELECT relation r FROM skill_synonyms").get().r, "related");
  db.close();
});

// ── THE SCORER ──────────────────────────────────────────────────────────────────────────────────

// Deliberately term-RICH. The scorer DECLINES (score null, decline_reasons set) on a posting with
// too few scorable terms, and a two-line fixture trips that — which would make these read as
// "synonyms do nothing" when the engine had simply refused to have an opinion at all.
const JOB = {
  title: "Site Reliability Engineer",
  description: "You will own log analysis for our platform. Kubernetes experience required. " +
    "You will work with Terraform, Prometheus, Grafana, Python, Go, AWS, Docker, PostgreSQL, " +
    "incident response, capacity planning, CI/CD pipelines and distributed systems. " +
    "Requires 4 years experience building and operating production infrastructure.",
  skills_json: JSON.stringify([
    { skill: "log analysis", type: "hard" }, { skill: "kubernetes", type: "hard" },
    { skill: "terraform", type: "hard" }, { skill: "prometheus", type: "hard" },
    { skill: "python", type: "hard" }, { skill: "aws", type: "hard" },
    { skill: "docker", type: "hard" }, { skill: "distributed systems", type: "hard" },
  ]),
};

/** The scorer takes a prepared basis; buildRuntimeAtsBasis needs a profile, as in every other test. */
const basisFor = (resumeText) => buildRuntimeAtsBasis({
  resumeText,
  signalProfile: { skills: [], yearsExperience: 5, structuredFacts: {} },
  domainProfile: {
    selected_tools: JSON.stringify([]),
    selected_keywords: JSON.stringify([]),
    selected_verbs: JSON.stringify([]),
    target_titles: JSON.stringify(["Site Reliability Engineer"]),
  },
});

test("a confirmed synonym turns a MISS into a MATCH", () => {
  const resumeText = "Built observability tooling and dashboards. Ran kubernetes clusters in production.";
  const before = scoreAtsLocally({ job: JOB, runtimeBasis: basisFor(resumeText) });
  assert.ok((before.tier1_missing || []).some(t => /log analysis/i.test(t)),
    "the AK1 case: the JD says log analysis, the resume says observability, and it misses");

  // THROUGH THE REAL KB, not a hand-built Map. The normaliser STEMS: "log analysis" is keyed as
  // "log analysi", so a Map assembled from raw strings silently never matches and this test would
  // have "proved" the mechanism works while asserting nothing. canonicalPair normalises on the way
  // in and loadConfirmedSynonyms reads the stored keys, so driving the real path is the only way
  // to know the keys agree.
  const db = makeDb();
  propose(db, [{ term: "log analysis", equivalent: "observability", relation: "related", jobId: "j1" }]);
  confirmSynonym(db, "log analysis", "observability");
  const synonyms = loadConfirmedSynonyms(db);
  const after = scoreAtsLocally({ job: JOB, runtimeBasis: basisFor(resumeText), synonyms });
  db.close();
  assert.ok((after.tier1_matched || []).some(t => /log analysis/i.test(t)),
    "with the pair confirmed it matches — this is the whole mechanism");
  assert.ok(after.score >= before.score);
});

test("⛔ SYNONYMS ARE ONE HOP, NEVER TRANSITIVE", () => {
  // a~b and b~c must not make a~c. Two reviewed equivalences would chain into a third no human ever
  // saw: log analysis ~ observability ~ monitoring ~ alerting ~ pagerduty, and now a resume
  // mentioning PagerDuty "has" log analysis. Chains are how a plausible table becomes a nonsense
  // one, and nothing in the review process would ever show the chained pair.
  const synonyms = new Map([
    ["log analysis", ["observability"]],
    ["observability", ["log analysis", "pagerduty"]],
    ["pagerduty", ["observability"]],
  ]);
  const resumeText = "Operated PagerDuty rotations for the team.";
  const report = scoreAtsLocally({ job: JOB, runtimeBasis: basisFor(resumeText), synonyms });
  assert.ok(!(report.tier1_matched || []).some(t => /log analysis/i.test(t)),
    "log analysis must NOT match through observability to pagerduty");
});

test("absent synonyms score exactly as before — every existing caller is unaffected", () => {
  const resumeText = "Built observability tooling. Ran kubernetes clusters.";
  const a = scoreAtsLocally({ job: JOB, runtimeBasis: basisFor(resumeText) });
  const b = scoreAtsLocally({ job: JOB, runtimeBasis: basisFor(resumeText), synonyms: null });
  const c = scoreAtsLocally({ job: JOB, runtimeBasis: basisFor(resumeText), synonyms: new Map() });
  assert.equal(a.score, b.score);
  assert.equal(a.score, c.score);
  assert.deepEqual(a.tier1_matched, c.tier1_matched);
});

test("a synonym cannot rescue a term the resume does not support at all", () => {
  // The expansion must not become a second, looser matcher. Each equivalent goes through the SAME
  // adjacency-and-window check the direct term does — the one AK1 added to kill the 22.8%.
  const synonyms = new Map([["log analysis", ["observability"]]]);
  const resumeText = "I design learning materials for a coffee machine vendor.";
  const report = scoreAtsLocally({ job: JOB, runtimeBasis: basisFor(resumeText), synonyms });
  assert.ok(!(report.tier1_matched || []).some(t => /log analysis/i.test(t)));
});

// ── THE SCORER STAYS FREE, INSTANT AND DETERMINISTIC ────────────────────────────────────────────

test("the scorer does not import the KB, and the KB makes no model call", async () => {
  // Requirement 6. One-way dependency, exactly as with atsTermWeights: the scorer takes a prepared
  // Map and never touches a database, which is what keeps it usable on a swipe card.
  const fs = await import("node:fs");
  const scorer = fs.readFileSync("services/localAtsScorer.js", "utf8");
  // An IMPORT, not a mention: the scorer's own comment names the KB module to say where the Map
  // comes from, and matching that would fail on the documentation rather than on the dependency.
  assert.ok(!/^\s*import[^\n]*skillSynonyms/m.test(scorer),
    "localAtsScorer must not import the KB — loading is the caller's job, or scoring needs a DB");
  const kb = fs.readFileSync("services/kb/skillSynonyms.js", "utf8");
  assert.ok(!/callModel|messages\.create|fetch\s*\(/.test(kb),
    "the KB layer is pure SQL — a model call here would put a model in the scoring path");
});

test("an absent table degrades to 'no synonyms' rather than throwing", () => {
  // A database that predates migration 098 must still score. An exception here would take down
  // every board query for a missing optional asset.
  const db = new Database(":memory:");
  assert.equal(loadConfirmedSynonyms(db).size, 0);
  assert.deepEqual(synonymStats(db), { proposed: 0, confirmed: 0, rejected: 0 });
  db.close();
});

test("the review queue puts the risky claims first", () => {
  // 'alias' sorts before 'related' so the formalities clear fast, and within a relation the
  // best-corroborated come first. A reviewer who stops halfway has still seen the ones that matter.
  const db = makeDb();
  propose(db, [
    { term: "zzz one", equivalent: "zzz two", relation: "related", jobId: "j1" },
    { term: "aaa one", equivalent: "aaa two", relation: "alias", jobId: "j1" },
  ]);
  const q = listProposals(db);
  assert.equal(q[0].relation, "alias");
  db.close();
});
