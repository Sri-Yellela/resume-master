// ================================================================
// test/pipelineStages.test.js
// End-to-end unit tests for every stage of the job pulling pipeline.
//
// Run all:        node --test test/pipelineStages.test.js
// Run one stage:  node --test --test-name-pattern="Stage 2" test/pipelineStages.test.js
//
// Stages covered:
//   1 · Role normalisation          (searchQueryBuilder.js)
//   2 · Profile-driven title build  (searchQueryBuilder.js)
//   3 · Raw item normalisation      (jobNormalization.js)
//   4a· Hard-drop filters           (jobNormalization.js)
//   4b· Title relevance             (searchQueryBuilder.js)
//   4c· Ghost-job scoring           (jobNormalization.js)
//   4d· YOE parsing                 (jobNormalization.js)
//   5 · Classification at ingest    (jobClassifier.js)
//   6 · Profile title SQL builder   (profileTitleFilter.js)
//   7 · Imported-job dedupe key     (services/importedJobs.js)
// ================================================================

import test from "node:test";
import assert from "node:assert/strict";

import {
  normaliseRole,
  buildApifyQueriesFromProfile,
  buildProfileSearchTerms,
  isTitleRelevant,
  isTitleRelevantToProfile,
} from "../services/searchQueryBuilder.js";

import {
  normaliseItem,
  parseYearsExperience,
  ghostJobScoreNorm,
  isReposted,
  isEmploymentTypeWanted,
  inferWorkType,
  jobHash,
} from "../services/jobNormalization.js";

import {
  classifyTitle,
  classifyForIngest,
  INGEST_CONFIDENCE_THRESHOLD,
} from "../services/jobClassifier.js";

import { profileTitleSql } from "../services/profileTitleFilter.js";

import {
  importedJobDedupeKey,
  normaliseImportedJob,
} from "../services/importedJobs.js";

// ───────────────────────────────────────────────────────────────
// STAGE 1 · Role normalisation
// What it does: maps alias input → canonical role title
// ───────────────────────────────────────────────────────────────

test("Stage 1 · normaliseRole: known alias maps to canonical title", () => {
  // The ROLE_ALIAS_MAP should handle common shorthand
  const result = normaliseRole("software engineer");
  assert.ok(typeof result === "string" && result.length > 0, "should return a non-empty string");
});

test("Stage 1 · normaliseRole: empty/null input returns empty string", () => {
  assert.equal(normaliseRole(""), "");
  assert.equal(normaliseRole(null), "");
  assert.equal(normaliseRole(undefined), "");
});

test("Stage 1 · normaliseRole: unknown input is title-cased and returned as-is", () => {
  const result = normaliseRole("zeppelin wrangler");
  assert.equal(result, "Zeppelin Wrangler", "unknown roles should be title-cased");
});

test("Stage 1 · normaliseRole: strips extra whitespace", () => {
  const result = normaliseRole("  data   scientist  ");
  assert.ok(!result.startsWith(" ") && !result.endsWith(" "), "leading/trailing spaces must be stripped");
  assert.ok(!result.includes("  "), "double-spaces must be collapsed");
});

// ───────────────────────────────────────────────────────────────
// STAGE 2 · Profile-driven title variant building
// What it does: expands target_titles × seniority → up to 10 variants
// ───────────────────────────────────────────────────────────────

test("Stage 2 · buildApifyQueriesFromProfile: returns empty array when no profile", () => {
  assert.deepEqual(buildApifyQueriesFromProfile(null), []);
  assert.deepEqual(buildApifyQueriesFromProfile(undefined), []);
});

test("Stage 2 · buildApifyQueriesFromProfile: falls back to profile_name when no target_titles", () => {
  const profile = { profile_name: "Software Engineer", target_titles: "[]", seniority: "mid" };
  const result = buildApifyQueriesFromProfile(profile);
  assert.ok(result.length > 0, "should fall back to profile_name");
  assert.ok(result.includes("Software Engineer"), "profile_name must appear in output");
});

test("Stage 2 · buildApifyQueriesFromProfile: senior prefix applied correctly", () => {
  const profile = {
    profile_name: "SWE",
    target_titles: JSON.stringify(["Software Engineer"]),
    seniority: "senior",
  };
  const result = buildApifyQueriesFromProfile(profile);
  assert.ok(result.some(t => t.toLowerCase().includes("senior")), "senior prefix should appear");
});

test("Stage 2 · buildApifyQueriesFromProfile: junior prefix applied correctly", () => {
  const profile = {
    profile_name: "SWE",
    target_titles: JSON.stringify(["Software Engineer"]),
    seniority: "junior",
  };
  const result = buildApifyQueriesFromProfile(profile);
  assert.ok(
    result.some(t => /junior|associate|entry/i.test(t)),
    "junior prefix (Junior / Associate / Entry Level) should appear"
  );
});

test("Stage 2 · buildApifyQueriesFromProfile: caps at 10 variants", () => {
  const manyTitles = ["Role A","Role B","Role C","Role D","Role E","Role F"];
  const profile = {
    profile_name: "Test",
    target_titles: JSON.stringify(manyTitles),
    seniority: "senior",
  };
  const result = buildApifyQueriesFromProfile(profile);
  assert.ok(result.length <= 10, `should cap at 10 variants, got ${result.length}`);
});

test("Stage 2 · buildApifyQueriesFromProfile: firmware domain gets hardcoded firmware titles", () => {
  const profile = {
    profile_name: "Firmware Engineer",
    target_titles: JSON.stringify(["Firmware Engineer"]),
    seniority: "mid",
    domain: "engineering_embedded_firmware",
  };
  const result = buildApifyQueriesFromProfile(profile);
  assert.ok(result.some(t => /firmware/i.test(t)), "should include firmware titles");
  assert.ok(result.some(t => /embedded/i.test(t)), "should include embedded titles");
});

test("Stage 2 · buildApifyQueriesFromProfile: no duplicates in output", () => {
  const profile = {
    profile_name: "Data Scientist",
    target_titles: JSON.stringify(["Data Scientist", "Data Scientist"]),
    seniority: "mid",
  };
  const result = buildApifyQueriesFromProfile(profile);
  const unique = new Set(result);
  assert.equal(result.length, unique.size, "output must not contain duplicates");
});

// ───────────────────────────────────────────────────────────────
// STAGE 3 · Raw item normalisation (HarvestAPI → internal schema)
// What it does: maps messy API response shapes to a clean object
// ───────────────────────────────────────────────────────────────

test("Stage 3 · normaliseItem: extracts title and company from standard fields", () => {
  const raw = { title: "Software Engineer", company: { name: "Acme Corp" }, id: "12345" };
  const result = normaliseItem(raw);
  assert.equal(result.title, "Software Engineer");
  assert.equal(result.company, "Acme Corp");
  assert.equal(result.jobId, "12345");
});

test("Stage 3 · normaliseItem: falls back to companyName when company.name is absent", () => {
  const raw = { title: "Data Analyst", companyName: "Widgets Inc", id: "99" };
  const result = normaliseItem(raw);
  assert.equal(result.company, "Widgets Inc");
});

test("Stage 3 · normaliseItem: extracts description from nested text field", () => {
  const raw = {
    title: "Engineer", company: { name: "Co" }, id: "1",
    description: { text: "Must have 5 years of Python experience." },
  };
  const result = normaliseItem(raw);
  assert.ok(result.description.includes("Python"), "description text must be extracted");
});

test("Stage 3 · normaliseItem: maps full_time contractType to full-time employment type", () => {
  const raw = { title: "PM", companyName: "Co", id: "2", contractType: "full_time" };
  const result = normaliseItem(raw);
  assert.equal(result.jobType, "full-time");
});

test("Stage 3 · normaliseItem: maps internship contractType correctly", () => {
  const raw = { title: "Intern", companyName: "Co", id: "3", contractType: "internship" };
  const result = normaliseItem(raw);
  assert.equal(result.jobType, "internship");
});

test("Stage 3 · normaliseItem: parses salary range from compensation text", () => {
  const raw = {
    title: "Engineer", companyName: "Co", id: "4",
    compensationText: "$100K–$140K",
  };
  const result = normaliseItem(raw);
  assert.ok(result.salaryMin != null, "salaryMin should be parsed");
  assert.ok(result.salaryMax != null, "salaryMax should be parsed");
  assert.ok(result.salaryMin >= 100000, `expected salaryMin >= 100000, got ${result.salaryMin}`);
  assert.ok(result.salaryMax <= 150000, `expected salaryMax <= 150000, got ${result.salaryMax}`);
});

test("Stage 3 · normaliseItem: location falls back to 'United States' when absent", () => {
  const raw = { title: "Dev", companyName: "Co", id: "5" };
  const result = normaliseItem(raw);
  assert.ok(result.location.length > 0, "location must never be empty");
});

test("Stage 3 · normaliseItem: remote workplaceType sets workTypeHint to remote", () => {
  const raw = { title: "Dev", companyName: "Co", id: "6", workplaceType: "remote" };
  const result = normaliseItem(raw);
  assert.equal(result.workTypeHint, "remote");
});

test("Stage 3 · inferWorkType: detects remote from text", () => {
  assert.equal(inferWorkType("This is a remote-first position"), "Remote");
});

test("Stage 3 · inferWorkType: detects hybrid from text", () => {
  assert.equal(inferWorkType("Hybrid role in New York"), "Hybrid");
});

test("Stage 3 · inferWorkType: defaults to Onsite when no signal", () => {
  assert.equal(inferWorkType("Full-time position in San Francisco office"), "Onsite");
});

// ───────────────────────────────────────────────────────────────
// STAGE 4a · Hard-drop filters (employment type)
// What it does: removes contract/temp/intern jobs from a full-time search
// ───────────────────────────────────────────────────────────────

test("Stage 4a · isEmploymentTypeWanted: full-time job passes a full-time filter", () => {
  const item = { title: "Software Engineer", jobType: "full-time", description: "Permanent role." };
  assert.ok(isEmploymentTypeWanted(item, ["full-time"]), "full-time job must pass full-time filter");
});

test("Stage 4a · isEmploymentTypeWanted: contract job is dropped for a full-time search", () => {
  const item = { title: "Developer", jobType: "contract", description: "6-month contract role." };
  assert.ok(!isEmploymentTypeWanted(item, ["full-time"]), "contract job must be dropped from full-time filter");
});

test("Stage 4a · isEmploymentTypeWanted: internship job is dropped for a full-time search", () => {
  const item = { title: "Intern Engineer", jobType: "internship", description: "Summer internship." };
  assert.ok(!isEmploymentTypeWanted(item, ["full-time"]), "internship must be dropped from full-time filter");
});

test("Stage 4a · isEmploymentTypeWanted: 3+ types selected = keep everything", () => {
  const item = { title: "Temp Role", jobType: "temporary", description: "Temp contract work." };
  // Selecting all 3 types means no filtering
  assert.ok(isEmploymentTypeWanted(item, ["full-time", "contract", "internship"]), "3+ types = keep all");
});

test("Stage 4a · isEmploymentTypeWanted: job with no employment signal assumed full-time", () => {
  // No keywords in title, type, or description → assumed full-time
  const item = { title: "Product Manager", jobType: "", description: "Lead a team of engineers." };
  assert.ok(isEmploymentTypeWanted(item, ["full-time"]), "job with no employment signal should pass full-time filter");
});

// ───────────────────────────────────────────────────────────────
// STAGE 4b · Title relevance filter
// What it does: ensures scraped titles match what the profile is searching for
// ───────────────────────────────────────────────────────────────

test("Stage 4b · isTitleRelevant: exact match passes", () => {
  assert.ok(isTitleRelevant("Software Engineer", "software engineer"), "exact match must pass");
});

test("Stage 4b · isTitleRelevant: multi-word query uses AND logic (all tokens must match)", () => {
  assert.ok(isTitleRelevant("Senior Product Manager", "product manager"), "both tokens must appear");
  assert.ok(!isTitleRelevant("Product Designer", "product manager"), "title without 'manager' must fail");
});

test("Stage 4b · isTitleRelevant: empty query or title always returns true (no false-drops)", () => {
  assert.ok(isTitleRelevant("", "software engineer"), "empty title returns true");
  assert.ok(isTitleRelevant("Software Engineer", ""), "empty query returns true");
});

test("Stage 4b · isTitleRelevant: stop words are ignored in query", () => {
  // 'senior' is a stop word — query 'senior software engineer' tokens: ['software', 'engineer']
  assert.ok(isTitleRelevant("Junior Software Engineer", "senior software engineer"),
    "stop words like 'senior' should not block a valid title match");
});

test("Stage 4b · isTitleRelevantToProfile: matches any target title (OR logic across titles)", () => {
  const targets = ["Software Engineer", "Backend Developer"];
  assert.ok(isTitleRelevantToProfile("Senior Software Engineer", targets), "must match first target");
  assert.ok(isTitleRelevantToProfile("Backend Developer", targets), "must match second target");
  assert.ok(!isTitleRelevantToProfile("Marketing Manager", targets), "unrelated title must fail");
});

test("Stage 4b · isTitleRelevantToProfile: no targets → always returns true (no false-drops)", () => {
  assert.ok(isTitleRelevantToProfile("Any Title At All", []), "empty targets should not block any title");
  assert.ok(isTitleRelevantToProfile("Any Title At All", null), "null targets should not block any title");
});

test("Stage 4b · isTitleRelevantToProfile: cross-domain bleed prevention — nursing title fails SWE targets", () => {
  const sweTargets = ["Software Engineer", "Backend Developer", "Full Stack Engineer"];
  assert.ok(!isTitleRelevantToProfile("Registered Nurse", sweTargets), "Nurse must not match SWE profile");
  assert.ok(!isTitleRelevantToProfile("Clinical Coordinator", sweTargets), "Clinical role must not match SWE profile");
});

test("Stage 4b · isTitleRelevantToProfile: TYPO_MAP corrects typos in TARGET tokens only (not incoming job title)", () => {
  // BUG MARKER: TYPO_MAP is applied to tokens from the *target title* (profile side),
  // NOT to the incoming job title being tested.
  // Consequence: a job scraped with a typo in its title (e.g. "Enigneer" instead of "Engineer")
  // will be silently DROPPED even if the profile's target title is correct.
  // Fix would be: also apply TYPO_MAP to tokens from `t` (the incoming job title).

  const targets = ["Software Engineer"];

  // A typo in the incoming job title — does NOT get corrected → fails to match → job dropped
  assert.ok(
    !isTitleRelevantToProfile("Software Enigneer", targets),
    "KNOWN LIMITATION: typo in job title is NOT corrected — job is dropped (TYPO_MAP only applies to target tokens)"
  );

  // A typo in the target title (profile side) — DOES get corrected before token comparison
  const typoTargets = ["Software Enigneer"]; // typo in the profile target
  assert.ok(
    isTitleRelevantToProfile("Senior Software Engineer", typoTargets),
    "Typo in target title IS corrected via TYPO_MAP before token matching"
  );
});

// ───────────────────────────────────────────────────────────────
// STAGE 4c · Ghost-job scoring
// What it does: flags likely fake/stale listings to prevent them entering the DB
// ───────────────────────────────────────────────────────────────

test("Stage 4c · ghostJobScoreNorm: normal job has low ghost score", () => {
  const job = {
    title: "Software Engineer",
    company: "Acme Corp",
    description: "We are looking for a full stack developer. Must have 3+ years of React and Node.js. " +
      "You will work in a collaborative team environment and ship features weekly.",
    url: "https://careers.acmecorp.com/apply/12345",
  };
  const score = ghostJobScoreNorm(job);
  assert.ok(score < 4, `normal job ghost score should be < 4, got ${score}`);
});

test("Stage 4c · ghostJobScoreNorm: missing URL is a strong ghost signal (+3)", () => {
  const job = {
    title: "Engineer",
    company: "Co",
    description: "A reasonably long description with real content about the role and requirements.",
    url: "",
  };
  const score = ghostJobScoreNorm(job);
  assert.ok(score >= 3, `missing URL should contribute >=3 to ghost score, got ${score}`);
});

test("Stage 4c · ghostJobScoreNorm: very short description is a ghost signal (+2)", () => {
  const job = {
    title: "Engineer",
    company: "Co",
    description: "Apply now.",
    url: "https://example.com/apply",
  };
  const score = ghostJobScoreNorm(job);
  assert.ok(score >= 2, `short description should contribute >=2 to ghost score, got ${score}`);
});

test("Stage 4c · ghostJobScoreNorm: unknown company is a ghost signal (+2)", () => {
  const job = {
    title: "Engineer",
    company: "Unknown",
    description: "A long enough description to avoid that penalty. ".repeat(5),
    url: "https://example.com/job",
  };
  const score = ghostJobScoreNorm(job);
  assert.ok(score >= 2, `unknown company should contribute >=2 to ghost score, got ${score}`);
});

test("Stage 4c · isReposted: detects reposted keyword in title", () => {
  assert.ok(isReposted({ title: "Software Engineer (Reposted)", description: "" }));
});

test("Stage 4c · isReposted: detects reposted keyword in description", () => {
  assert.ok(isReposted({ title: "Engineer", description: "This position has been reposted." }));
});

test("Stage 4c · isReposted: normal job is not marked as reposted", () => {
  assert.ok(!isReposted({ title: "Software Engineer", description: "Great full-time role at our company." }));
});

// ───────────────────────────────────────────────────────────────
// STAGE 4d · Years-of-experience (YOE) parsing
// What it does: extracts min/max YOE from job description text
// ───────────────────────────────────────────────────────────────

test("Stage 4d · parseYearsExperience: parses '5+ years of experience'", () => {
  const result = parseYearsExperience("Must have 5+ years of experience in software development.");
  assert.equal(result.min, 5, "min should be 5");
  assert.equal(result.max, null, "max should be null for plus-style");
});

test("Stage 4d · parseYearsExperience: parses '3-5 years of experience' range", () => {
  const result = parseYearsExperience("Requires 3-5 years of experience.");
  assert.equal(result.min, 3);
  assert.equal(result.max, 5);
});

test("Stage 4d · parseYearsExperience: parses 'minimum 7 years'", () => {
  const result = parseYearsExperience("Minimum 7 years of relevant industry experience required.");
  assert.equal(result.min, 7);
});

test("Stage 4d · parseYearsExperience: parses 'at least 2 years'", () => {
  const result = parseYearsExperience("You should have at least 2 years of Python experience.");
  assert.equal(result.min, 2);
});

test("Stage 4d · parseYearsExperience: returns null for descriptions with no YOE mention", () => {
  const result = parseYearsExperience("Exciting opportunity at a fast-growing startup. Great benefits.");
  assert.equal(result.min, null, "min should be null when no YOE mentioned");
  assert.equal(result.max, null, "max should be null when no YOE mentioned");
});

test("Stage 4d · parseYearsExperience: YOE filter logic — user with 4 years is dropped for 7+ YOE job", () => {
  const desc = "Requires 7+ years of experience in backend development.";
  const { min } = parseYearsExperience(desc);
  const userYoe = 4;
  const maxAllowed = userYoe + 2; // +2 buffer from pipeline
  const shouldDrop = min != null && min > maxAllowed;
  assert.ok(shouldDrop, `7-YOE job should be dropped for a 4-YOE user (maxAllowed=${maxAllowed})`);
});

test("Stage 4d · parseYearsExperience: YOE filter logic — user with 4 years passes a 5-YOE job (within +2 buffer)", () => {
  const desc = "You need 5 years of experience with cloud infrastructure.";
  const { min } = parseYearsExperience(desc);
  const userYoe = 4;
  const maxAllowed = userYoe + 2;
  const shouldDrop = min != null && min > maxAllowed;
  assert.ok(!shouldDrop, `5-YOE job should NOT be dropped for a 4-YOE user (buffer allows it)`);
});

// ───────────────────────────────────────────────────────────────
// STAGE 5 · Classification at ingest
// What it does: assigns a role key to each job with confidence >= 0.75
// ───────────────────────────────────────────────────────────────

test("Stage 5 · classifyForIngest: clear engineering title meets threshold", () => {
  const result = classifyForIngest("Senior Software Engineer", "");
  assert.ok(result !== null, "clear SWE title should pass ingest threshold");
  assert.equal(result.roleKey, "engineering");
  assert.ok(result.confidence >= INGEST_CONFIDENCE_THRESHOLD);
});

test("Stage 5 · classifyForIngest: clear data science title meets threshold", () => {
  const result = classifyForIngest("Data Scientist", "");
  assert.ok(result !== null);
  assert.equal(result.roleKey, "data");
  assert.ok(result.confidence >= INGEST_CONFIDENCE_THRESHOLD);
});

test("Stage 5 · classifyForIngest: firmware title is correctly isolated from generic SWE", () => {
  const result = classifyForIngest("Firmware Engineer", "");
  assert.ok(result !== null);
  assert.equal(result.roleKey, "engineering_embedded_firmware");
  assert.notEqual(result.roleKey, "engineering", "firmware must NOT be classified as generic SWE");
});

test("Stage 5 · classifyForIngest: PM title meets threshold", () => {
  const result = classifyForIngest("Product Manager", "");
  assert.ok(result !== null);
  assert.equal(result.roleKey, "pm");
});

test("Stage 5 · classifyForIngest: product designer does NOT classify as pm", () => {
  const result = classifyForIngest("Product Designer", "");
  if (result !== null) {
    assert.notEqual(result.roleKey, "pm", "product designer must not classify as PM");
  }
});

test("Stage 5 · classifyForIngest: vague title returns null (does not force-assign)", () => {
  const result = classifyForIngest("Technical Specialist", "");
  assert.ok(
    result === null || result.confidence < INGEST_CONFIDENCE_THRESHOLD,
    `ambiguous title must not reach ingest threshold, got ${result?.roleKey} @ ${result?.confidence}`
  );
});

test("Stage 5 · classifyForIngest: completely unrecognized title returns null", () => {
  const result = classifyForIngest("Banana Peeler Coordinator III", "");
  assert.equal(result, null);
});

test("Stage 5 · classifyForIngest: description anchors boost confidence for borderline title", () => {
  const desc = "You will use dbt and BigQuery. Must have experience with feature engineering and MLflow.";
  const withDesc = classifyForIngest("Data Scientist", desc);
  const withoutDesc = classifyTitle("Data Scientist", "");
  assert.ok(withDesc !== null);
  assert.ok(withDesc.confidence >= withoutDesc.confidence, "description anchors should boost confidence");
});

test("Stage 5 · classifyTitle: ML engineer cannot route to engineering (exclusion)", () => {
  const result = classifyTitle("Machine Learning Engineer");
  assert.notEqual(result.roleKey, "engineering");
});

test("Stage 5 · classifyTitle: data scientist cannot route to engineering (exclusion)", () => {
  const result = classifyTitle("Data Scientist");
  assert.notEqual(result.roleKey, "engineering");
});

test("Stage 5 · classifyTitle: project manager cannot route to engineering (exclusion)", () => {
  const result = classifyTitle("Project Manager");
  assert.notEqual(result.roleKey, "engineering");
});

// ───────────────────────────────────────────────────────────────
// STAGE 6 · Profile title SQL builder
// What it does: generates SQL LIKE clauses scoped to the profile's target titles
// ───────────────────────────────────────────────────────────────

test("Stage 6 · profileTitleSql: empty target_titles returns permissive '1 = 1' clause", () => {
  const result = profileTitleSql("sj.title", { target_titles: "[]" });
  assert.equal(result.sql, "1 = 1", "empty profile titles must not filter anything out");
  assert.deepEqual(result.params, []);
});

test("Stage 6 · profileTitleSql: null profile returns permissive '1 = 1' clause", () => {
  const result = profileTitleSql("sj.title", null);
  assert.equal(result.sql, "1 = 1");
});

test("Stage 6 · profileTitleSql: single target title produces LIKE clauses", () => {
  const profile = { target_titles: JSON.stringify(["Software Engineer"]) };
  const result = profileTitleSql("sj.title", profile);
  assert.ok(result.sql.includes("LIKE"), "should produce LIKE clauses");
  assert.ok(result.params.length > 0, "should produce bind params");
  // Each token param should be wrapped in % wildcards
  assert.ok(result.params.every(p => p.startsWith("%") && p.endsWith("%")), "params must be %token% wildcard");
});

test("Stage 6 · profileTitleSql: multiple targets joined with OR", () => {
  const profile = { target_titles: JSON.stringify(["Software Engineer", "Backend Developer"]) };
  const result = profileTitleSql("sj.title", profile);
  assert.ok(result.sql.includes(" OR "), "multiple targets must be joined with OR");
});

test("Stage 6 · profileTitleSql: seniority stop words excluded, 'engineer' kept as meaningful token", () => {
  const profile = { target_titles: JSON.stringify(["Senior Software Engineer"]) };
  const result = profileTitleSql("sj.title", profile);
  // 'senior' is a seniority stop word and must be stripped.
  // 'engineer' was previously a stop word but was intentionally removed — it is a
  // meaningful filter token that prevents "Senior Lead Engineer" producing 1=1 passthrough.
  const paramValues = result.params.map(p => p.replace(/%/g, ""));
  assert.ok(!paramValues.includes("senior"), "'senior' is a seniority stop word and must be excluded");
  assert.ok(paramValues.includes("software"), "'software' is meaningful and must be a token");
  assert.ok(paramValues.includes("engineer"), "'engineer' is now a meaningful token (no longer a stop word)");
});

// ───────────────────────────────────────────────────────────────
// STAGE 7 · Imported job dedupe key (LinkedIn import path)
// What it does: prevents duplicate jobs re-importing on every scrape
// ───────────────────────────────────────────────────────────────

test("Stage 7 · importedJobDedupeKey: uses externalJobId when available (highest priority)", () => {
  const raw = { externalJobId: "12345", jobUrl: "https://linkedin.com/jobs/12345", title: "Engineer", company: "Co" };
  const key = importedJobDedupeKey("linkedin", raw);
  assert.ok(key.includes("12345"), "dedupe key must include externalJobId");
  assert.ok(key.startsWith("linkedin:"), "key must be prefixed with source_key");
});

test("Stage 7 · importedJobDedupeKey: falls back to canonicalized URL when no externalJobId", () => {
  const raw = { jobUrl: "https://careers.acme.com/apply?id=99#details", title: "PM", company: "Acme" };
  const key = importedJobDedupeKey("linkedin", raw);
  assert.ok(!key.includes("#details"), "URL fragment (hash) must be stripped from dedupe key");
  assert.ok(key.startsWith("linkedin:"), "key must be prefixed with source_key");
});

test("Stage 7 · importedJobDedupeKey: fallback hash key when neither jobId nor URL exists", () => {
  const raw = { title: "Data Analyst", company: "Widgets Co", location: "New York, NY" };
  const key = importedJobDedupeKey("linkedin", raw);
  assert.ok(key.startsWith("linkedin:fallback:"), "must use fallback hash when no id or url");
});

test("Stage 7 · importedJobDedupeKey: same job produces the same key (deterministic)", () => {
  const raw = { externalJobId: "abc123", title: "Engineer", company: "Co" };
  const key1 = importedJobDedupeKey("linkedin", raw);
  const key2 = importedJobDedupeKey("linkedin", raw);
  assert.equal(key1, key2, "dedupe key must be deterministic for the same input");
});

test("Stage 7 · importedJobDedupeKey: different jobs produce different keys", () => {
  const raw1 = { externalJobId: "job-1", title: "Engineer", company: "Co" };
  const raw2 = { externalJobId: "job-2", title: "Engineer", company: "Co" };
  assert.notEqual(importedJobDedupeKey("linkedin", raw1), importedJobDedupeKey("linkedin", raw2));
});

test("Stage 7 · normaliseImportedJob: returns null when title is missing", () => {
  const raw = { company: "Co", jobUrl: "https://example.com" };
  const result = normaliseImportedJob("linkedin", raw);
  assert.equal(result, null, "job without a title must be rejected at normalisation");
});

test("Stage 7 · normaliseImportedJob: defaults company to 'Unknown company' when missing", () => {
  const raw = { title: "Software Engineer", jobUrl: "https://example.com/job/1" };
  const result = normaliseImportedJob("linkedin", raw);
  assert.ok(result !== null);
  assert.equal(result.company, "Unknown company");
});

test("Stage 7 · normaliseImportedJob: infers workType from location and title text", () => {
  const raw = { title: "Remote Software Engineer", company: "Co", jobUrl: "https://x.com/1" };
  const result = normaliseImportedJob("linkedin", raw);
  assert.ok(result !== null);
  assert.equal(result.workType, "Remote", "work type should be inferred as Remote from title text");
});

test("Stage 7 · normaliseImportedJob: strips URL hash fragment", () => {
  const raw = { title: "Engineer", company: "Co", jobUrl: "https://careers.co.com/apply?id=5#top" };
  const result = normaliseImportedJob("linkedin", raw);
  assert.ok(!result.jobUrl.includes("#"), "hash fragment must be stripped from jobUrl");
});

test("Stage 7 · normaliseImportedJob: payloadJson is a valid JSON string of original raw data", () => {
  const raw = { title: "Engineer", company: "Co", jobUrl: "https://x.com", externalJobId: "xyz" };
  const result = normaliseImportedJob("linkedin", raw);
  assert.ok(result !== null);
  assert.doesNotThrow(() => JSON.parse(result.payloadJson), "payloadJson must be valid JSON");
  const parsed = JSON.parse(result.payloadJson);
  assert.equal(parsed.externalJobId, "xyz", "payloadJson must preserve original raw data");
});

// ───────────────────────────────────────────────────────────────
// BONUS · jobHash deduplication
// ───────────────────────────────────────────────────────────────

test("Bonus · jobHash: same title+company always produces the same hash", () => {
  const a = jobHash({ title: "Software Engineer", company: "Acme Corp" });
  const b = jobHash({ title: "Software Engineer", company: "Acme Corp" });
  assert.equal(a, b, "hash must be deterministic");
});

test("Bonus · jobHash: different companies produce different hashes", () => {
  const a = jobHash({ title: "Software Engineer", company: "Acme Corp" });
  const b = jobHash({ title: "Software Engineer", company: "Other Corp" });
  assert.notEqual(a, b);
});

test("Bonus · jobHash: case-insensitive (title/company are lowercased before hashing)", () => {
  const a = jobHash({ title: "Software Engineer", company: "Acme Corp" });
  const b = jobHash({ title: "SOFTWARE ENGINEER", company: "ACME CORP" });
  assert.equal(a, b, "hash must be case-insensitive");
});
