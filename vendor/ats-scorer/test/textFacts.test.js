// A81 — years and a stated clearance read from résumé TEXT, opt-in. These travel with every vendored
// copy, so each is a property the PACKAGE promises. Synthetic résumés only.
import test from "node:test";
import assert from "node:assert/strict";
import { scoreAtsLocally, buildRuntimeAtsBasis, yearsFromResumeText, clearanceFromResumeText } from "../src/index.js";

const AS_OF = Date.UTC(2026, 9, 4);   // "present" means October 2026 in every test
const RESUME = [
  "ALEX EXAMPLE",
  "Backend Engineer",
  "SUMMARY",
  "Backend engineer with 9 years of experience building Python services on Kubernetes and AWS.",
  "EXPERIENCE",
  "Acme Corp — Senior Software Engineer",
  "Mar 2021 – Present",
  "Built Python services on Kubernetes. Active TS/SCI clearance.",
  "Beta Systems — Software Engineer",
  "06/2018 - 02/2021",
  "Contract work, Gamma LLC  Jan 2020 – Jun 2020",
  "PROJECTS",
  "Side project — 2015–2016",
  "EDUCATION",
  "State University, B.S. Computer Science  Sep 2014 – May 2018",
].join("\n");
const JOB = {
  title: "Backend Engineer", company: "Acme",
  description: "Python, Kubernetes, Kafka, Terraform and AWS. Requires 5+ years of experience. " +
    "Must hold an active TS/SCI security clearance. U.S. citizenship required.",
  skills_json: JSON.stringify(["Python", "Kubernetes", "Kafka", "Terraform", "AWS"].map(skill => ({ skill, type: "hard" }))),
};

test("⛔ OFF BY DEFAULT: without factsFromText the basis and the report are exactly what they were", () => {
  const before = buildRuntimeAtsBasis({ resumeText: RESUME, signalProfile: {}, domainProfile: {} });
  assert.deepEqual(Object.keys(before).sort(), ["actionVerbs", "claimedActionVerbs", "claimedSkills", "resumeText", "seniority",
    "skills", "structuredFacts", "termWeights", "titles", "yearsExperience"], "not one key added — basis hashes cannot move");
  assert.equal(before.yearsExperience, null);
  assert.deepEqual(before.structuredFacts, {});
  assert.deepEqual(buildRuntimeAtsBasis({ resumeText: RESUME, signalProfile: {}, domainProfile: {}, factsFromText: false }), before);
  const r = scoreAtsLocally({ job: JOB, runtimeBasis: before });
  assert.equal(r.experience.summary, "Job asks for 5+ years; profile years are not set.");
  assert.deepEqual(r.hard_constraint_misses, ["U.S. citizenship", "Security clearance"]);
  assert.equal("facts_from_text" in r, false);
  // and the no-basis path of scoreAtsLocally, too
  assert.deepEqual(scoreAtsLocally({ job: JOB, resumeText: RESUME, signalProfile: {}, domainProfile: {} }), r);
});

test("years from dated roles: the UNION of the ranges, whole years rounded down, the experience section only", () => {
  // Mar 2021 → Oct 2026 and Jun 2018 → Feb 2021 touch, so they merge: Jun 2018 → Oct 2026 = 101 months.
  // The concurrent Gamma contract adds nothing; the 2015–2016 project and the degree are not roles.
  assert.deepEqual(yearsFromResumeText(RESUME, { asOf: AS_OF }), { years: 8, source: "dated_roles", roles: 3 });
  assert.deepEqual(yearsFromResumeText("Engineer, Jan 2020 – Dec 2021\nAdvisor (part-time), Jan 2020 – Dec 2021", { asOf: AS_OF }),
    { years: 2, source: "dated_roles", roles: 2 }, "two concurrent roles are two years, not four");
  assert.deepEqual(yearsFromResumeText("2016 - 2019\n2019 – 2021", { asOf: AS_OF }), { years: 5, source: "dated_roles", roles: 2 },
    "bare years: 2016–2019 is three years, as a reader says it");
  assert.deepEqual(yearsFromResumeText("Engineer, Aug 2022 – Dec 2023\nAnalyst, Jan 2021 – Jul 2022", { asOf: AS_OF }),
    { years: 3, source: "dated_roles", roles: 2 }, "no headings: every line that is not education");
  assert.deepEqual(yearsFromResumeText("University of X, 2014 – 2018\nEngineer, 2019 – 2020", { asOf: AS_OF }),
    { years: 1, source: "dated_roles", roles: 1 }, "an education line is not a role");
  assert.equal(yearsFromResumeText("EXPERIENCE\nEngineer since forever\nEDUCATION\nCollege 2010 – 2014", { asOf: AS_OF }), null);
});

test("years: a stated 'N years of experience' only when no role is dated; implausible dates are ignored", () => {
  assert.deepEqual(yearsFromResumeText("Engineer with 7+ years of professional experience in Go."), { years: 7, source: "stated_years" });
  assert.equal(yearsFromResumeText("Call 1234-5678. Founded 1850 – 1900."), null, "a phone number and a century are not a career");
  assert.equal(yearsFromResumeText("Engineer, Jan 2030 – Present", { asOf: AS_OF }), null, "a start in the future is not a role");
  assert.deepEqual(yearsFromResumeText("Engineer, Jan 2024 – Dec 2031", { asOf: AS_OF }), { years: 2, source: "dated_roles", roles: 1 },
    "an end in the future is clamped to now");
});

test("a clearance is read only when stated as HELD — a hedge, a requirement or a trade secret is not one", () => {
  for (const [line, text] of [["Active TS/SCI clearance", "TS/SCI"], ["Clearance: Top Secret", "Top Secret"],
    ["Hold a Secret clearance (DoD)", "Secret clearance"], ["Public Trust", "Public Trust"], ["DOE Q clearance", "DOE Q clearance"]]) {
    assert.deepEqual(clearanceFromResumeText(`Engineer\n${line}\nPython`), { stated: true, text }, line);
  }
  for (const line of ["Eligible for a security clearance", "Able to obtain a Top Secret clearance", "TS/SCI (expired 2019)",
    "Formerly held a Secret clearance", "Supported programs requiring TS/SCI", "Protected trade secrets for clients",
    "Willing to obtain clearance", "No clearance"]) {
    assert.equal(clearanceFromResumeText(line), null, line);
  }
});

test("factsFromText ON: the years and the clearance fill what the profile left unset — citizenship is NEVER read", () => {
  const basis = buildRuntimeAtsBasis({ resumeText: RESUME, signalProfile: {}, domainProfile: {}, factsFromText: true, asOf: AS_OF });
  assert.equal(basis.yearsExperience, 8);
  assert.equal(basis.structuredFacts.hasClearance, true);
  assert.equal("citizenshipStatus" in basis.structuredFacts, false);
  const r = scoreAtsLocally({ job: JOB, runtimeBasis: basis });
  assert.equal(r.experience.fit, true);
  assert.equal(r.experience.summary, "Résumé experience (the résumé's dated roles cover about 8 years) meets 5+ year requirement.");
  assert.deepEqual(r.hard_constraint_misses, ["U.S. citizenship"], "the stated clearance satisfies the posting; citizenship stays a miss");
  assert.deepEqual(r.facts_from_text, { years_experience: { years: 8, source: "dated_roles", roles: 3 },
    clearance: { stated: true, text: "TS/SCI" }, not_read: ["citizenship"] });
  const off = scoreAtsLocally({ job: JOB, runtimeBasis: buildRuntimeAtsBasis({ resumeText: RESUME, signalProfile: {}, domainProfile: {} }) });
  assert.ok(r.score > off.score, "reading the facts can only remove a penalty here, never invent one");
});

test("a fact the profile STATES always wins over the text", () => {
  const basis = buildRuntimeAtsBasis({ resumeText: RESUME, factsFromText: true, asOf: AS_OF,
    signalProfile: { yearsExperience: 2, structuredFacts: { hasClearance: false } } });
  assert.equal(basis.yearsExperience, 2);
  assert.equal(basis.structuredFacts.hasClearance, false);
  assert.deepEqual(basis.factsFromText, { yearsExperience: null, clearance: null, notRead: ["citizenship"] });
  const r = scoreAtsLocally({ job: JOB, runtimeBasis: basis });
  assert.equal(r.experience.summary, "Job asks for 5+ years; profile has 2 years.", "the profile's words, unchanged");
  assert.ok(r.hard_constraint_misses.includes("Security clearance"));
});

test("factsFromText with nothing to read says so, and stays deterministic for a fixed asOf", () => {
  const basis = buildRuntimeAtsBasis({ resumeText: "Python Kubernetes Kafka engineer.", factsFromText: true, asOf: AS_OF });
  const r = scoreAtsLocally({ job: JOB, runtimeBasis: basis });
  assert.equal(r.experience.summary, "Job asks for 5+ years; the résumé text shows no dated roles or stated years to compare.");
  assert.deepEqual(r.facts_from_text, { years_experience: null, clearance: null, not_read: ["citizenship"] });
  const again = buildRuntimeAtsBasis({ resumeText: RESUME, factsFromText: true, asOf: AS_OF });
  assert.deepEqual(scoreAtsLocally({ job: JOB, runtimeBasis: again }),
    scoreAtsLocally({ job: JOB, runtimeBasis: buildRuntimeAtsBasis({ resumeText: RESUME, factsFromText: true, asOf: AS_OF }) }));
});
