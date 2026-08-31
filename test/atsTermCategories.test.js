import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { LOCAL_ATS_SOURCE, buildRuntimeAtsBasis, scoreAtsLocally } from "../services/localAtsScorer.js";
import { at } from "../test-support/sourceAnchors.js";

/**
 * TASK AH3 — what belongs in each bucket, enforced.
 *
 * AG1 fixed the FRAGMENT problem: the terms are well-formed. What was left was category and
 * judgement, observed on Notion — Software Engineer, New Grad:
 *
 *   SKILLS MISSING: "thoughtful problem-solving", "intellectual curiosity", "problem decomposition"
 *   VERBS MISSING:  "Deliver", "Manage"
 *   SKILLS MATCHED: "systems", "time"
 *
 * The corpus-wide proof is scripts/ah3TermQuality.mjs, which scores all 1,291 enriched postings
 * against the real fixture resume and screenshots the panel. These run the real scorer on
 * hand-built postings, so each rule can be stated on its own.
 */

const EMPTY_BASIS = {
  resumeText: "", titles: [], skills: [], actionVerbs: [], yearsExperience: null, structuredFacts: {},
};
const basis = (over = {}) => ({ ...EMPTY_BASIS, ...over });

// The posting the report was observed on, with its real skills_json.
const NOTION = {
  title: "Software Engineer, New Grad",
  company: "Notion",
  description:
    "You will build and ship product surfaces in TypeScript and Node.js, with Python for tooling. " +
    "We look for thoughtful problem-solving and problem decomposition. You will deliver and manage " +
    "your own work, drive projects, partner with design, and collaborate across teams. " +
    "You will automate, instrument and debug production systems, and improve reliability over time.",
  skills_json: JSON.stringify([
    { skill: "TypeScript", type: "hard" },
    { skill: "Node.js", type: "hard" },
    { skill: "Python", type: "hard" },
    { skill: "impact-driven approach to technology", type: "soft" },
    { skill: "thoughtful problem-solving", type: "soft" },
    { skill: "problem decomposition", type: "soft" },
    { skill: "collaboration", type: "soft" },
  ]),
};

const norm = (v) => String(v).toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim();
const has = (list, term) => (list || []).some(t => norm(t) === norm(term));

// ── 1. category ──────────────────────────────────────────────────────────────────────────────

test("a soft-typed term is a competency, never a skill", () => {
  const r = scoreAtsLocally({ job: NOTION, runtimeBasis: basis() });
  const skills = [...r.tier1_matched, ...r.tier1_missing];
  const comps = [...r.competencies_matched, ...r.competencies_missing];
  for (const soft of ["thoughtful problem-solving", "problem decomposition", "collaboration"]) {
    assert.ok(has(comps, soft), `${soft} should be a competency`);
    assert.ok(!has(skills, soft), `${soft} must not be filed as a skill`);
  }
});

test("a hard-typed term is still a skill", () => {
  const r = scoreAtsLocally({ job: NOTION, runtimeBasis: basis() });
  const skills = [...r.tier1_matched, ...r.tier1_missing];
  for (const hard of ["TypeScript", "Node.js", "Python"]) assert.ok(has(skills, hard), hard);
});

test("an untyped term stays a skill — no judgement is invented to fill the gap", () => {
  // The feed adapters write plain strings. Reclassifying those as competencies would be asserting
  // something nobody said; the skills bucket is where they have always gone.
  const job = { ...NOTION, skills_json: JSON.stringify(["Kubernetes", { skill: "Terraform" }]) };
  const r = scoreAtsLocally({ job, runtimeBasis: basis() });
  const skills = [...r.tier1_matched, ...r.tier1_missing];
  assert.ok(has(skills, "Kubernetes"));
  assert.ok(has(skills, "Terraform"));
});

test("the posting's own soft typing beats the global registry", () => {
  // "data analysis" and "project management" are registry keywords AND are typed soft by the
  // enrichment on postings that use them as competencies. The registry pass used to re-admit them
  // as skills: 170 soft-typed terms across the corpus were still landing in the skills bucket
  // after the split, because the split alone did not stop the second source.
  const job = {
    title: "Analyst", company: "Acme",
    description: "You will own data analysis and project management for the team.",
    skills_json: JSON.stringify([
      { skill: "data analysis", type: "soft" },
      { skill: "project management", type: "soft" },
    ]),
  };
  const r = scoreAtsLocally({ job, runtimeBasis: basis() });
  const skills = [...r.tier1_matched, ...r.tier1_missing];
  assert.ok(!has(skills, "data analysis"), "a term typed soft here must not be a skill here");
  assert.ok(!has(skills, "project management"));
});

// ── 2. judgement: generic language is not a gap ──────────────────────────────────────────────

test("generic stewardship verbs are grouped, not reported as gaps", () => {
  const r = scoreAtsLocally({ job: NOTION, runtimeBasis: basis() });
  for (const verb of ["Managed", "Delivered", "Drove", "Partnered"]) {
    assert.ok(!has(r.action_verbs_missing, verb), `${verb} must not be listed as a gap`);
  }
  assert.ok(has(r.action_verbs_generic, "Managed"));
  assert.ok(has(r.action_verbs_generic, "Delivered"));
});

test("verbs that name a specific act ARE still reported as gaps", () => {
  // The counterweight. If generic-verb suppression swallowed these the report would say nothing.
  const r = scoreAtsLocally({ job: NOTION, runtimeBasis: basis() });
  const gaps = r.action_verbs_missing.map(norm);
  assert.ok(gaps.some(v => v.startsWith("automat")), gaps.join(" | "));
  assert.ok(gaps.some(v => v.startsWith("instrument")), gaps.join(" | "));
  assert.ok(gaps.some(v => v.startsWith("debug")), gaps.join(" | "));
});

test("the generic set is stemmed the same way the verb index is keyed", () => {
  // Spelled as raw infinitives, eleven of the twelve entries matched nothing: the stemmer turns
  // "Managed" into "manag" and "Coordinated" into "coordinat". A set whose keys are produced by a
  // different rule than the keys it is tested against is not a set.
  const src = fs.readFileSync("services/localAtsScorer.js", "utf8");
  assert.match(src, /GENERIC_ACTION_VERB_WORDS\.map\(normaliseActionVerb\)/);
  const r = scoreAtsLocally({ job: NOTION, runtimeBasis: basis() });
  assert.ok(r.action_verbs_generic.length >= 3, r.action_verbs_generic.join(" | "));
});

// ── 3. noise: the skills bucket is a closed set ──────────────────────────────────────────────

test("a resume-extracted word cannot become a matched skill", () => {
  // THE OBSERVED DEFECT, reproduced. The candidate's profile skills were pushed into the term list
  // unconditionally, and those are resume-extracted tokens rather than a curated list. On the real
  // fixture profile this posting's SKILLS MATCHED read: engineering | provided | science |
  // bachelor | current | environment | skills | specific. Every one of them also counted toward
  // the score.
  const noise = ["provided", "science", "bachelor", "current", "environment", "specific", "systems", "time"];
  const job = {
    title: "Engineer", company: "Acme",
    description: "We provided science to every bachelor in the current environment with specific " +
      "systems over time. You will build with Python and Kubernetes.",
    skills_json: JSON.stringify([{ skill: "Python", type: "hard" }]),
  };
  const r = scoreAtsLocally({ job, runtimeBasis: basis({ skills: noise }) });
  const skills = [...r.tier1_matched, ...r.tier1_missing];
  for (const word of noise) {
    assert.ok(!has(skills, word), `"${word}" is not a skill and must not be in the skills bucket`);
  }
  assert.ok(has(skills, "Python"), "the real skill is still reported");
});

test("the candidate's own wording is still preferred for terms that ARE admitted", () => {
  // The profile no longer ADMITS a term, but it still orders them and supplies the user's spelling,
  // which is the reason it was consulted first in the first place.
  const job = {
    title: "Engineer", company: "Acme",
    description: "You will work with kubernetes and python.",
    skills_json: JSON.stringify([{ skill: "kubernetes", type: "hard" }]),
  };
  const r = scoreAtsLocally({ job, runtimeBasis: basis({ skills: ["Kubernetes"] }) });
  const skills = [...r.tier1_matched, ...r.tier1_missing];
  assert.ok(skills.includes("Kubernetes"), skills.join(" | "));
});

test("near-duplicate competencies collapse onto the posting's own wording", () => {
  // "problem solving" from the registry and "thoughtful problem-solving" from the posting are one
  // idea in two wordings. Fewer, defensible terms beat a longer list.
  const r = scoreAtsLocally({ job: NOTION, runtimeBasis: basis() });
  const comps = [...r.competencies_matched, ...r.competencies_missing].map(norm);
  assert.ok(comps.includes("thoughtful problem solving"), comps.join(" | "));
  assert.ok(!comps.includes("problem solving"), `the generic wording should have collapsed: ${comps.join(" | ")}`);
});

// ── 4. the split must not silently re-weight the score ───────────────────────────────────────

test("the score is computed over the union, so splitting the report does not move every gate", () => {
  const src = fs.readFileSync("services/localAtsScorer.js", "utf8");
  // AK1 renamed the locals when the score became weighted; the property under test is unchanged —
  // the denominator is still the UNION of both buckets, not one of them.
  assert.match(src, /const allScored = \[\.\.\.jobTerms, \.\.\.jobCompetencies\]/);
  assert.match(src, /const scoredTerms = allScored\.length/);
  assert.match(src, /const scoredVerbs = jobVerbs\.length \+ genericVerbs\.length/);
  // A posting whose asks are ALL competencies must not score as though it asked for nothing.
  //
  // AK1 added a floor: below MIN_SCORABLE_TERMS the scorer DECLINES rather than returning a
  // fabricated number, and three terms is below it. The fixture carries four so the assertion below
  // still exercises what it always did — that competencies count toward the score — rather than
  // silently becoming an assertion about null.
  const job = {
    title: "Lead", company: "Acme",
    description: "We want collaboration and problem decomposition and thoughtful problem-solving and stakeholder management.",
    skills_json: JSON.stringify([
      { skill: "collaboration", type: "soft" },
      { skill: "problem decomposition", type: "soft" },
      { skill: "thoughtful problem-solving", type: "soft" },
      { skill: "stakeholder management", type: "soft" },
    ]),
  };
  const missed = scoreAtsLocally({ job, runtimeBasis: basis() });
  const met = scoreAtsLocally({ job, runtimeBasis: basis({
    resumeText: "collaboration problem decomposition thoughtful problem-solving",
  }) });
  assert.ok(met.score > missed.score,
    `a resume that shows the competencies must outscore one that does not (${missed.score} -> ${met.score})`);
});

test("the report version was bumped, or every cached report keeps the old categories", () => {
  // Reports are cached in four places and served whenever `source` matches. AG1's fragment fix
  // appeared to work and did not, for exactly this reason (e566dbc).
  // v4: AK1 changed what the NUMBER means (weighted terms, graded experience, constraints as a
  // penalty) and what the report carries (scorable / decline_reasons / weighting). Every cached v3
  // report would otherwise keep being served with the old semantics behind the same field names.
  assert.equal(LOCAL_ATS_SOURCE, "local_ats_v4");
  const server = fs.readFileSync("server.js", "utf8");
  assert.doesNotMatch(server, /"local_ats_v2"/, "no gate may still spell the superseded version");
});

// ── 5. the panel shows what the scorer computed ──────────────────────────────────────────────

test("the panel renders both new buckets, and AG2's copy is untouched", () => {
  const panel = fs.readFileSync("client/src/panels/ATSPanel.jsx", "utf8");
  assert.match(panel, /activeReport\.competencies_matched\?\.length > 0/);
  assert.match(panel, /activeReport\.competencies_missing\?\.length > 0/);
  assert.match(panel, /activeReport\.action_verbs_generic\?\.length > 0/);
  // Generic language is NOT claimable — a chip that offers to add "Manage" to your profile is the
  // same false gap in a different control.
  const genericBlock = panel.slice(at(panel, "○ Generic Language"), at(panel, "○ Generic Language") + 600);
  assert.doesNotMatch(genericBlock, /onToggleClaim/);
  // Competencies matched must count as evidenced, or a term shown as matched above renders as
  // unevidenced below.
  assert.match(panel, /\.\.\.\(activeReport\.competencies_matched \|\| \[\]\)/);
  for (const sentence of [
    "Claiming a term says it is true of you",
    "never rewrites one you already have",
    "It does not change this score",
  ]) assert.ok(panel.includes(sentence), sentence);
});
