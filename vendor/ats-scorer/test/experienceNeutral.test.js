// exp-weight-retune (1.2.0, local_ats_v5) — a MET years requirement is neutral, not a bonus. These
// travel with every vendored copy, so each is a property the PACKAGE promises. Synthetic résumés only.
import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreAtsLocally, buildRuntimeAtsBasis, EXPERIENCE_POINTS,
  NO_REQUIREMENT_EXPERIENCE_RATIO, MEETS_EXPERIENCE_RATIO,
} from "../src/index.js";

const SKILLS = ["Python", "Kubernetes", "Kafka", "Terraform", "AWS"];
const posting = (title, sentence = "") => ({
  title, company: "Acme",
  description: `Build services in Python and Kubernetes with Kafka and Terraform on AWS.${sentence ? " " + sentence : ""}`,
  skills_json: JSON.stringify(SKILLS.map(skill => ({ skill, type: "hard" }))),
});
const NONE = posting("Backend Engineer");
const asks = (n) => posting("Backend Engineer", `Requires ${n}+ years of experience.`);
const RESUME = "Backend engineer. Built Python services on Kubernetes and AWS; Kafka pipelines; Terraform.";
const withYears = (yearsExperience, extra = {}) => buildRuntimeAtsBasis({ resumeText: RESUME,
  signalProfile: { skills: ["Python"], titles: [], keywords: [], yearsExperience, structuredFacts: {} }, domainProfile: extra });
const score = (job, basis) => scoreAtsLocally({ job, runtimeBasis: basis }).score;

test("the twin postings differ ONLY in the years sentence — same scored terms, so the score gap is the experience component", () => {
  const a = scoreAtsLocally({ job: NONE, runtimeBasis: withYears(5) });
  const b = scoreAtsLocally({ job: asks(2), runtimeBasis: withYears(5) });
  assert.deepEqual([b.tier1_matched, b.tier1_missing, b.competencies_matched, b.competencies_missing],
    [a.tier1_matched, a.tier1_missing, a.competencies_matched, a.competencies_missing]);
  assert.equal(a.experience.requiredYears, null);
  assert.equal(b.experience.requiredYears, 2);
});

test("⛔ MEETING a years requirement scores EXACTLY what the same posting with no requirement scores", () => {
  // Three years of engineering meets "2+ years" on a sales posting as well as on a backend one — the
  // years cannot see the role, so passing the gate is not evidence of fit. Until 1.2.0 it paid +3.3.
  for (const [req, yrs] of [[2, 2], [2, 3], [2, 6], [5, 5], [5, 9], [8, 12]]) {
    assert.equal(score(asks(req), withYears(yrs)), score(NONE, withYears(yrs)),
      `${yrs} years on a ${req}-year posting must score as the same posting asking for nothing`);
  }
  assert.equal(MEETS_EXPERIENCE_RATIO, NO_REQUIREMENT_EXPERIENCE_RATIO);
});

test("no number of years ever scores ABOVE the no-requirement twin — far over still tapers below it", () => {
  for (let yrs = 0; yrs <= 30; yrs++) {
    assert.ok(score(asks(3), withYears(yrs)) <= score(NONE, withYears(yrs)),
      `${yrs} years on a 3-year posting outscored the posting that asks for nothing`);
  }
  assert.ok(score(asks(3), withYears(25)) < score(NONE, withYears(25)), "a far-over-qualified candidate still tapers");
});

test("a SHORTFALL still costs, graded by distance — being unable to get the job IS evidence", () => {
  const none = score(NONE, withYears(1));
  const short = [9, 7, 5, 3, 2].map(req => score(asks(req), withYears(1)));   // 8, 6, 4, 2, 1 years short
  for (const s of short) assert.ok(s < none, `a shortfall must cost something (${short.join(", ")} vs ${none})`);
  for (let i = 1; i < short.length; i++) {
    assert.ok(short[i - 1] <= short[i], `falling further short must never cost less: ${short.join(" -> ")}`);
  }
  assert.ok(short[0] < short[short.length - 1], "eight years short must cost more than one");
  assert.ok(none - short[0] >= Math.floor(EXPERIENCE_POINTS * 0.7), "a large shortfall is a large cost, not a rounding artifact");
});

test("UNKNOWN years keep the incomplete-profile rate — below a met requirement, so filling the field still matters", () => {
  // Making unknown neutral too was measured and LOWERS draft's own graded path (0.746 -> 0.712).
  const unknown = score(asks(2), withYears(null));
  assert.ok(unknown < score(asks(2), withYears(4)), "unknown years must not tie a known, met requirement");
  assert.ok(unknown < score(NONE, withYears(null)));
});

test("the assistant path (job + résumé text, factsFromText) gets no bonus for text-read years either", () => {
  const text = ["EXPERIENCE", "Acme Corp — Software Engineer", "Jan 2021 – Present",
    "Built Python services on Kubernetes and AWS; Kafka pipelines; Terraform."].join("\n");
  const b = buildRuntimeAtsBasis({ resumeText: text, factsFromText: true, asOf: Date.UTC(2026, 9, 5) });
  assert.equal(b.yearsExperience, 5);
  const met = scoreAtsLocally({ job: asks(2), runtimeBasis: b });
  assert.match(met.experience.summary, /meets 2\+ year requirement/);
  assert.equal(met.score, score(NONE, b), "a text-read 'meets' must not lift the posting above its no-requirement twin");
});

test("the seniority guard still binds on top of a met requirement — the cap is not an experience term", () => {
  const senior = withYears(6, { seniority: "mid" });
  const intern = scoreAtsLocally({ job: posting("Software Engineer Intern", "Requires 1+ years of experience."), runtimeBasis: senior });
  assert.equal(intern.seniority_cap.applied, true);
  assert.ok(intern.score <= 20, `a met requirement must not lift a capped junior posting (${intern.score})`);
});
