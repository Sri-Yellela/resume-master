import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveProfileFilters, bucketYearsExperience, relevanceBand, EXPERIENCE_LEVEL_THRESHOLDS,
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

// REBALANCED (X2 requirement 3): widenOneLevelUp -> relevanceBand, one level either way.
// The old asymmetry existed because these levels EXCLUDED, so widening was a candidate's only
// reach; under ranking nothing is excluded and the list decides sort order alone, where
// upward-only was backwards against a bottom-heavy inventory (mid 175 of 241 in reach).
test("relevanceBand spans one level either way, clamped at both ends of the scale", () => {
  assert.deepEqual(relevanceBand("mid"), ["entry", "mid", "senior"]);
  assert.deepEqual(relevanceBand("senior"), ["mid", "senior", "lead"]);
  // Clamped, not wrapped, at each end.
  assert.deepEqual(relevanceBand("intern"), ["intern", "entry"]);
  assert.deepEqual(relevanceBand("executive"), ["lead", "executive"]);
  // An unknown level is not in LEVEL_ORDER, so there is no neighbour to name.
  assert.deepEqual(relevanceBand("unknown-level"), ["unknown-level"]);
});

test("the band always contains its own centre — a candidate's own level can never sort last", () => {
  for (const level of ["intern", "entry", "mid", "senior", "lead", "executive"]) {
    assert.ok(relevanceBand(level).includes(level), `${level} must be in its own band`);
  }
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

test("deriveProfileFilters maps yearsExperience to the relevance band around its bucket", () => {
  const result = deriveProfileFilters(null, { yearsExperience: 6 });
  // 6 years -> 'senior', banded one either way. Was ["senior","lead"] while these levels excluded.
  assert.deepEqual(result.experience_levels, ["mid", "senior", "lead"]);
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
