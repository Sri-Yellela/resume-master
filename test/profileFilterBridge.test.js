import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveProfileFilters, bucketYearsExperience, widenOneLevelUp, EXPERIENCE_LEVEL_THRESHOLDS,
} from "../services/jobs/profileFilterBridge.js";

test("bucketYearsExperience follows the documented threshold table", () => {
  assert.equal(bucketYearsExperience(0), "entry");
  assert.equal(bucketYearsExperience(1), "entry");
  assert.equal(bucketYearsExperience(2), "mid");
  assert.equal(bucketYearsExperience(4), "mid");
  assert.equal(bucketYearsExperience(5), "senior");
  assert.equal(bucketYearsExperience(8), "senior");
  assert.equal(bucketYearsExperience(9), "lead");
  assert.equal(bucketYearsExperience(14), "lead");
  assert.equal(bucketYearsExperience(15), "executive");
  assert.equal(bucketYearsExperience(40), "executive");
});

test("bucketYearsExperience never derives intern and returns null for missing/invalid input", () => {
  const derivedLevels = EXPERIENCE_LEVEL_THRESHOLDS.map(t => t.level);
  assert.ok(!derivedLevels.includes("intern"), "intern must never appear in the threshold table");
  assert.equal(bucketYearsExperience(null), null);
  assert.equal(bucketYearsExperience(undefined), null);
  assert.equal(bucketYearsExperience(-1), null);
  assert.equal(bucketYearsExperience(NaN), null);
});

test("widenOneLevelUp includes the next bucket, or just itself at the top of the scale", () => {
  assert.deepEqual(widenOneLevelUp("mid"), ["mid", "senior"]);
  assert.deepEqual(widenOneLevelUp("executive"), ["executive"]);
  assert.deepEqual(widenOneLevelUp("unknown-level"), ["unknown-level"]);
});

test("deriveProfileFilters returns {} for a profile with no signals", () => {
  assert.deepEqual(deriveProfileFilters(null, null), {});
  assert.deepEqual(deriveProfileFilters({}, {}), {});
});

test("deriveProfileFilters combines searchTerms, titles, and target_titles into q, deduped and capped", () => {
  const activeProfile = { target_titles: JSON.stringify(["Software Engineer", "software engineer"]) };
  const simpleApplyProfile = {
    searchTerms: ["python", "React"],
    titles: ["Backend Engineer"],
  };
  const result = deriveProfileFilters(activeProfile, simpleApplyProfile);
  const terms = result.q.split(" ");
  assert.ok(terms.includes("python"));
  assert.ok(terms.includes("React"));
  assert.ok(terms.includes("Backend Engineer") || terms.join(" ").includes("Backend Engineer"));
  // "Software Engineer" and "software engineer" are the same term case-insensitively — deduped.
  const softwareEngineerCount = result.q.toLowerCase().split("software engineer").length - 1;
  assert.equal(softwareEngineerCount, 1);
});

test("deriveProfileFilters maps skills (capped) to skills_include", () => {
  const result = deriveProfileFilters(null, {
    skills: ["python", "react", "sql", "aws", "docker", "kubernetes", "terraform"],
  });
  assert.equal(result.skills_include.length, 6);
  assert.deepEqual(result.skills_include, ["python", "react", "sql", "aws", "docker", "kubernetes"]);
});

test("deriveProfileFilters maps yearsExperience to a 2-bucket experience_levels window", () => {
  const result = deriveProfileFilters(null, { yearsExperience: 6 });
  assert.deepEqual(result.experience_levels, ["senior", "lead"]);
});

test("deriveProfileFilters omits experience_levels when yearsExperience is absent", () => {
  const result = deriveProfileFilters(null, { skills: ["python"] });
  assert.equal(result.experience_levels, undefined);
});

test("deriveProfileFilters sets sponsorship_friendly from structuredFacts.requiresSponsorship", () => {
  const yes = deriveProfileFilters(null, { structuredFacts: { requiresSponsorship: true } });
  assert.equal(yes.sponsorship_friendly, true);

  const no = deriveProfileFilters(null, { structuredFacts: { requiresSponsorship: false } });
  assert.equal(no.sponsorship_friendly, undefined);

  const missing = deriveProfileFilters(null, {});
  assert.equal(missing.sponsorship_friendly, undefined);
});

test("deriveProfileFilters opts.sponsorshipFriendly explicitly overrides the profile fact", () => {
  const forcedOn = deriveProfileFilters(null, { structuredFacts: { requiresSponsorship: false } }, { sponsorshipFriendly: true });
  assert.equal(forcedOn.sponsorship_friendly, true);

  const forcedOff = deriveProfileFilters(null, { structuredFacts: { requiresSponsorship: true } }, { sponsorshipFriendly: false });
  assert.equal(forcedOff.sponsorship_friendly, undefined);
});
