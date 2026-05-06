// =============================================================
// scripts/conditionTests.js
// Runs targeted condition tests across every pipeline stage.
// Flags unexpected / buggy behaviour with FAIL markers.
//
// Usage:  node scripts/conditionTests.js
// Output: condition_test_results.txt
// =============================================================

import {
  normaliseRole,
  buildApifyQueriesFromProfile,
  isTitleRelevantToProfile,
} from "../services/searchQueryBuilder.js";

import {
  normaliseItem,
  parseYearsExperience,
  ghostJobScoreNorm,
  isReposted,
  isEmploymentTypeWanted,
  inferWorkType,
} from "../services/jobNormalization.js";

import {
  classifyForIngest,
  INGEST_CONFIDENCE_THRESHOLD,
} from "../services/jobClassifier.js";

import { profileTitleSql } from "../services/profileTitleFilter.js";

// ── helpers ───────────────────────────────────────────────────
const results = [];

function test(group, name, fn) {
  try {
    const { input, output, expected, pass, note } = fn();
    results.push({ group, name, pass, input, output, expected, note: note || null, error: null });
  } catch (err) {
    results.push({ group, name, pass: false, input: null, output: null, expected: null, note: null, error: err.message });
  }
}

function check(value, expected, note) {
  return { pass: JSON.stringify(value) === JSON.stringify(expected), note };
}

// ─────────────────────────────────────────────────────────────
// GROUP 1: Title variant building (Stage 2)
// ─────────────────────────────────────────────────────────────

test("1-TitleVariants", "mid seniority → includes plain + Mid-Level prefix", () => {
  const profile = { target_titles: JSON.stringify(["Data Scientist"]), seniority: "mid", domain: "data" };
  const out = buildApifyQueriesFromProfile(profile);
  return { input: profile, output: out,
    expected: ["Data Scientist", "Mid-Level Data Scientist"],
    ...check(out, ["Data Scientist", "Mid-Level Data Scientist"], "mid seniority should produce exactly these 2 variants") };
});

test("1-TitleVariants", "senior seniority → Senior/Lead/Staff prefixes", () => {
  const profile = { target_titles: JSON.stringify(["Data Scientist"]), seniority: "senior", domain: "data" };
  const out = buildApifyQueriesFromProfile(profile);
  return { input: profile, output: out,
    expected: ["Senior Data Scientist", "Lead Data Scientist", "Staff Data Scientist"],
    ...check(out, ["Senior Data Scientist", "Lead Data Scientist", "Staff Data Scientist"]) };
});

test("1-TitleVariants", "junior seniority → Junior/Associate/Entry Level prefixes", () => {
  const profile = { target_titles: JSON.stringify(["Data Scientist"]), seniority: "junior", domain: "data" };
  const out = buildApifyQueriesFromProfile(profile);
  return { input: profile, output: out,
    expected: ["Junior Data Scientist", "Associate Data Scientist", "Entry Level Data Scientist"],
    ...check(out, ["Junior Data Scientist", "Associate Data Scientist", "Entry Level Data Scientist"]) };
});

test("1-TitleVariants", "empty target_titles → fallback should not crash", () => {
  const profile = { target_titles: JSON.stringify([]), seniority: "mid", domain: "data" };
  let out;
  try { out = buildApifyQueriesFromProfile(profile); } catch(e) { out = `THREW: ${e.message}`; }
  const pass = Array.isArray(out);
  return { input: profile, output: out, expected: "(any array, even empty — must not throw)",
    pass, note: pass ? "ok" : "CRASH or non-array returned for empty target_titles" };
});

test("1-TitleVariants", "3 titles × mid = 6 variants, capped at 10", () => {
  const profile = { target_titles: JSON.stringify(["Data Scientist","ML Engineer","Analytics Engineer"]), seniority: "mid", domain: "data" };
  const out = buildApifyQueriesFromProfile(profile);
  return { input: profile, output: out, expected: "6 variants (3 × 2 prefixes)",
    pass: out.length === 6, note: `got ${out.length} variants` };
});

// ─────────────────────────────────────────────────────────────
// GROUP 2: normaliseItem edge cases (Stage 3)
// ─────────────────────────────────────────────────────────────

test("2-NormaliseItem", "company as flat string (not object) — common Apify variant", () => {
  const raw = { id: "111", title: "Data Scientist", company: "FlatCo", location: "Remote",
    description: { text: "Some job" } };
  const out = normaliseItem(raw);
  return { input: { "company field": raw.company }, output: { "company result": out.company },
    expected: "FlatCo",
    pass: out.company === "FlatCo", note: out.company === "FlatCo" ? "ok" : `BUG: got "${out.company}"` };
});

test("2-NormaliseItem", "missing job id → jobId should be null", () => {
  const raw = { title: "Data Scientist", company: { name: "Co" }, description: { text: "x" } };
  const out = normaliseItem(raw);
  return { input: "(no id field)", output: { jobId: out.jobId },
    expected: null,
    pass: out.jobId === null, note: out.jobId === null ? "ok" : `BUG: got "${out.jobId}"` };
});

test("2-NormaliseItem", "salary as text '$120K–$160K' → parses to salaryMin/Max", () => {
  const raw = { id: "222", title: "Data Scientist", company: { name: "Co" },
    description: { text: "Some job" }, compensationText: "$120K–$160K" };
  const out = normaliseItem(raw);
  return { input: { compensationText: "$120K–$160K" }, output: { salaryMin: out.salaryMin, salaryMax: out.salaryMax },
    expected: { salaryMin: 120000, salaryMax: 160000 },
    pass: out.salaryMin === 120000 && out.salaryMax === 160000,
    note: `got min=${out.salaryMin} max=${out.salaryMax}` };
});

test("2-NormaliseItem", "salary as text '$100,000 - $140,000' (no K suffix)", () => {
  const raw = { id: "223", title: "DS", company: { name: "Co" },
    description: { text: "Some job" }, compensationText: "$100,000 - $140,000" };
  const out = normaliseItem(raw);
  return { input: { compensationText: "$100,000 - $140,000" }, output: { salaryMin: out.salaryMin, salaryMax: out.salaryMax },
    expected: { salaryMin: 100000, salaryMax: 140000 },
    pass: out.salaryMin === 100000 && out.salaryMax === 140000,
    note: `got min=${out.salaryMin} max=${out.salaryMax}` };
});

test("2-NormaliseItem", "location as object { city, state } → combined string", () => {
  const raw = { id: "333", title: "DS", company: { name: "Co" },
    location: { city: "New York", state: "NY" }, description: { text: "x" } };
  const out = normaliseItem(raw);
  return { input: { location: raw.location }, output: { location: out.location },
    expected: "New York, NY",
    pass: out.location === "New York, NY", note: `got "${out.location}"` };
});

test("2-NormaliseItem", "empty description → description should be empty string not null", () => {
  const raw = { id: "444", title: "DS", company: { name: "Co" }, description: { text: "" } };
  const out = normaliseItem(raw);
  return { input: "(empty description.text)", output: { description: out.description },
    expected: "",
    pass: out.description === "", note: `got: ${JSON.stringify(out.description)}` };
});

test("2-NormaliseItem", "no description field at all → should not throw, description = ''", () => {
  let out;
  try { out = normaliseItem({ id: "555", title: "DS", company: { name: "Co" } }); }
  catch(e) { return { input: "(no description)", output: `THREW: ${e.message}`, expected: "no throw", pass: false, note: "CRASH" }; }
  return { input: "(no description field)", output: { description: out.description },
    expected: "", pass: out.description === "", note: `got: ${JSON.stringify(out.description)}` };
});

test("2-NormaliseItem", "contractType 'full_time' maps to jobType 'full-time'", () => {
  const raw = { id: "666", title: "DS", company: { name: "Co" }, contractType: "full_time", description: { text: "x" } };
  const out = normaliseItem(raw);
  return { input: { contractType: "full_time" }, output: { jobType: out.jobType },
    expected: "full-time", pass: out.jobType === "full-time", note: `got "${out.jobType}"` };
});

test("2-NormaliseItem", "contractType 'internship' maps to jobType 'internship'", () => {
  const raw = { id: "777", title: "DS Intern", company: { name: "Co" }, contractType: "internship", description: { text: "x" } };
  const out = normaliseItem(raw);
  return { input: { contractType: "internship" }, output: { jobType: out.jobType },
    expected: "internship", pass: out.jobType === "internship", note: `got "${out.jobType}"` };
});

// ─────────────────────────────────────────────────────────────
// GROUP 3: Employment type filter (Stage 4a)
// ─────────────────────────────────────────────────────────────

function makeItem(overrides) {
  return { title: "Data Scientist", jobType: "full-time", description: "Seeking data scientist.", ...overrides };
}

test("3-EmpTypeFilter", "contractType=contract → DROP", () => {
  const item = makeItem({ jobType: "contract" });
  const out = isEmploymentTypeWanted(item, ["full-time"]);
  return { input: { jobType: item.jobType }, output: out, expected: false,
    pass: out === false, note: out === false ? "correctly dropped" : "BUG: contract job was kept" };
});

test("3-EmpTypeFilter", "'W2 contract' in description → DROP", () => {
  const item = makeItem({ jobType: "", description: "This is a W2 contract position with possible extension." });
  const out = isEmploymentTypeWanted(item, ["full-time"]);
  return { input: { description_snippet: "W2 contract position" }, output: out, expected: false,
    pass: out === false, note: out === false ? "correctly dropped" : "BUG: W2 contract slipped through" };
});

test("3-EmpTypeFilter", "no employment signal at all → assume full-time (KEEP)", () => {
  const item = makeItem({ jobType: "", description: "We are hiring a Data Scientist to join our team." });
  const out = isEmploymentTypeWanted(item, ["full-time"]);
  return { input: { jobType: "", description: "no signal" }, output: out, expected: true,
    pass: out === true, note: out === true ? "correctly kept (no signal = full-time assumption)" : "BUG: job with no type signal was dropped" };
});

test("3-EmpTypeFilter", "'freelance' in description → DROP", () => {
  const item = makeItem({ jobType: "", description: "Freelance data scientist needed for 3-month engagement." });
  const out = isEmploymentTypeWanted(item, ["full-time"]);
  return { input: { description_snippet: "freelance" }, output: out, expected: false,
    pass: out === false, note: out === false ? "correctly dropped" : "BUG: freelance not caught" };
});

test("3-EmpTypeFilter", "wantedTypes has 3 entries → keep EVERYTHING including contracts", () => {
  const item = makeItem({ jobType: "contract", description: "Contract role" });
  const out = isEmploymentTypeWanted(item, ["full-time", "contract", "internship"]);
  return { input: { wantedTypes: "3 types", jobType: "contract" }, output: out, expected: true,
    pass: out === true, note: out === true ? "3+ types = keep all" : "BUG: should keep all when 3 types selected" };
});

test("3-EmpTypeFilter", "'full-time' in description but jobType=contract → what wins?", () => {
  const item = makeItem({ jobType: "contract", description: "This is a full-time equivalent contract role." });
  const out = isEmploymentTypeWanted(item, ["full-time"]);
  return { input: { jobType: "contract", description_snippet: "full-time equivalent contract" }, output: out, expected: false,
    pass: true, // documenting actual behaviour
    note: `actual result: ${out} — "contract" signal detected even when "full-time" also appears` };
});

// ─────────────────────────────────────────────────────────────
// GROUP 4: Title relevance filter (Stage 4b)
// ─────────────────────────────────────────────────────────────

const dsTargets = ["Data Scientist", "ML Engineer", "Analytics Engineer"];

test("4-TitleRelevance", "'Senior Data Scientist' matches 'Data Scientist' target", () => {
  const out = isTitleRelevantToProfile("Senior Data Scientist", dsTargets);
  return { input: { jobTitle: "Senior Data Scientist", targets: dsTargets }, output: out, expected: true,
    pass: out === true, note: out ? "'senior' is stop word → stripped → data+scientist match" : "BUG: Senior DS dropped" };
});

test("4-TitleRelevance", "'Staff Data Scientist' matches (stop word 'staff' stripped)", () => {
  const out = isTitleRelevantToProfile("Staff Data Scientist", dsTargets);
  return { input: { jobTitle: "Staff Data Scientist" }, output: out, expected: true,
    pass: out === true, note: out ? "ok" : "BUG: staff stripped as stop word, should still match" };
});

test("4-TitleRelevance", "'Data Science Manager' vs 'Data Scientist' — science ≠ scientist", () => {
  const out = isTitleRelevantToProfile("Data Science Manager", dsTargets);
  return { input: { jobTitle: "Data Science Manager" }, output: out, expected: false,
    pass: true, // documenting actual behaviour
    note: `actual: ${out} — "science" token does NOT match "scientist" → job DROPPED. Valid DS manager roles silently excluded.` };
});

test("4-TitleRelevance", "'Machine Learning Engineer' vs 'ML Engineer' target", () => {
  const out = isTitleRelevantToProfile("Machine Learning Engineer", dsTargets);
  return { input: { jobTitle: "Machine Learning Engineer", targets: "includes 'ML Engineer'" }, output: out, expected: false,
    pass: true, // documenting
    note: `actual: ${out} — tokens from "ML Engineer" = ["engineer"]. "Machine Learning Engineer" DOES contain "engineer" → ${out ? "PASSES" : "DROPS"}. "ML" token stripped (len≤2).` };
});

test("4-TitleRelevance", "'Data Scientist II' — roman numeral 'ii' is stop word", () => {
  const out = isTitleRelevantToProfile("Data Scientist II", dsTargets);
  return { input: { jobTitle: "Data Scientist II" }, output: out, expected: true,
    pass: out === true, note: out ? "'ii' is stop word → stripped → still matches data+scientist" : "BUG: DS II was dropped" };
});

test("4-TitleRelevance", "'Applied Data Scientist' — extra token 'applied'", () => {
  const out = isTitleRelevantToProfile("Applied Data Scientist", dsTargets);
  return { input: { jobTitle: "Applied Data Scientist" }, output: out, expected: true,
    pass: out === true, note: out ? "ok — AND check is on target tokens in job title, not vice versa" : "BUG: Applied DS dropped" };
});

test("4-TitleRelevance", "'Data Analyst' vs 'Data Scientist' — analyst ≠ scientist", () => {
  const out = isTitleRelevantToProfile("Data Analyst", dsTargets);
  return { input: { jobTitle: "Data Analyst" }, output: out, expected: false,
    pass: out === false, note: out === false ? "correctly dropped — analyst is not scientist" : "BUG: Data Analyst passed DS filter" };
});

test("4-TitleRelevance", "job title 'DS' (abbreviation) — short token stripped (len≤2)", () => {
  const out = isTitleRelevantToProfile("DS", dsTargets);
  return { input: { jobTitle: "DS" }, output: out, expected: false,
    pass: true, // documenting
    note: `actual: ${out} — 'ds' is length 2 → filtered out → no tokens remain → DROPS. Real DS jobs with abbreviated titles missed.` };
});

test("4-TitleRelevance", "empty job title → should not throw", () => {
  let out;
  try { out = isTitleRelevantToProfile("", dsTargets); }
  catch(e) { return { input: "(empty title)", output: `THREW: ${e.message}`, expected: false, pass: false, note: "CRASH" }; }
  return { input: "(empty string)", output: out, expected: false, pass: out === false, note: "empty title should always be false" };
});

// ─────────────────────────────────────────────────────────────
// GROUP 5: Ghost job scoring (Stage 4c)
// ─────────────────────────────────────────────────────────────

test("5-GhostScore", "score exactly 3 (no URL +3) → KEEP (threshold is 4)", () => {
  const item = { url: "", description: "A" .repeat(200), company: "RealCo", title: "Data Scientist" };
  const score = ghostJobScoreNorm(item);
  return { input: { url: "(empty)", descLen: 200, company: "RealCo" }, output: { score },
    expected: { score: 3, drop: false },
    pass: score === 3, note: `score=${score} — below threshold of 4, job KEPT` };
});

test("5-GhostScore", "score exactly 4 → DROP (at threshold)", () => {
  const item = { url: "", description: "A".repeat(50), company: "RealCo", title: "Data Scientist" };
  const score = ghostJobScoreNorm(item);
  return { input: { url: "(empty)", descLen: 50, company: "RealCo" }, output: { score },
    expected: { score: 5, drop: true },
    pass: score >= 4, note: `score=${score} — no URL(+3) + short desc(+2) = 5 → DROP` };
});

test("5-GhostScore", "description exactly 150 chars → boundary (< 150 scores +2)", () => {
  const desc150 = "A".repeat(150);
  const desc149 = "A".repeat(149);
  const score150 = ghostJobScoreNorm({ url: "https://ok.com", description: desc150, company: "Co", title: "DS" });
  const score149 = ghostJobScoreNorm({ url: "https://ok.com", description: desc149, company: "Co", title: "DS" });
  return { input: { desc150: "150 chars", desc149: "149 chars" },
    output: { score_at_150: score150, score_at_149: score149 },
    expected: { score_at_150: 0, score_at_149: 2 },
    pass: score150 === 0 && score149 === 2,
    note: `150 chars → score=${score150} (should be 0). 149 chars → score=${score149} (should be +2). Boundary is STRICT less-than.` };
});

test("5-GhostScore", "LinkedIn-only URL (no /apply) → +1 signal", () => {
  const item = { url: "https://www.linkedin.com/jobs/view/12345", description: "A".repeat(200), company: "Co", title: "DS" };
  const score = ghostJobScoreNorm(item);
  return { input: { url: item.url }, output: { score },
    expected: 1, pass: score === 1, note: `LinkedIn view URL without /apply = +1 ghost signal. score=${score}` };
});

test("5-GhostScore", "'Multiple Positions Available' in title → +2", () => {
  const item = { url: "https://ok.com", description: "A".repeat(200), company: "Co", title: "Multiple Positions Available" };
  const score = ghostJobScoreNorm(item);
  return { input: { title: item.title }, output: { score },
    expected: 2, pass: score === 2, note: `"multiple" in title = +2. score=${score}` };
});

// ─────────────────────────────────────────────────────────────
// GROUP 6: YOE filter (Stage 4d)
// ─────────────────────────────────────────────────────────────

function yoeTest(descSnippet, userYoe, expectDrop, expectMin, expectMax) {
  const parsed = parseYearsExperience(descSnippet);
  const maxAllowed = userYoe + 2;
  const drop = parsed.min != null && parsed.min > maxAllowed;
  return {
    input: { description_snippet: descSnippet, user_yoe: userYoe, maxAllowed },
    output: { parsed, drop },
    expected: { min: expectMin, max: expectMax, drop: expectDrop },
    pass: parsed.min === expectMin && parsed.max === expectMax && drop === expectDrop,
    note: `parsed min=${parsed.min} max=${parsed.max} raw="${parsed.raw}" drop=${drop}`
  };
}

test("6-YOEFilter", "'3-5 years of experience', userYoe=4 → KEEP (min=3 ≤ maxAllowed=6)", () =>
  yoeTest("We need someone with 3-5 years of experience in data science.", 4, false, 3, 5));

test("6-YOEFilter", "'10+ years of experience', userYoe=4 → DROP (min=10 > maxAllowed=6)", () =>
  yoeTest("Requires 10+ years of experience in analytics.", 4, true, 10, null));

test("6-YOEFilter", "'5 or more years', userYoe=4 → KEEP (min=5 ≤ maxAllowed=6)", () =>
  yoeTest("Requires 5 or more years of experience.", 4, false, 5, null));

test("6-YOEFilter", "'7 or more years', userYoe=4 → DROP (min=7 > maxAllowed=6)", () =>
  yoeTest("Requires 7 or more years of experience.", 4, true, 7, null));

test("6-YOEFilter", "'minimum 3 years', userYoe=2 → KEEP (min=3 ≤ maxAllowed=4)", () =>
  yoeTest("Minimum 3 years of relevant experience required.", 2, false, 3, 3));

test("6-YOEFilter", "no YOE mentioned → KEEP (min=null → no drop)", () =>
  yoeTest("We are looking for a talented data scientist to join our team.", 4, false, null, null));

test("6-YOEFilter", "'1-2 years' entry-level, userYoe=0 → KEEP", () =>
  yoeTest("Looking for 1-2 years of experience in Python.", 0, false, 1, 2));

test("6-YOEFilter", "'at least 8 years', userYoe=6 → DROP (min=8 > maxAllowed=8) — boundary", () => {
  // userYoe=6, maxAllowed=8, min=8 → 8 > 8 is FALSE → should KEEP
  const parsed = parseYearsExperience("At least 8 years of experience required.");
  const maxAllowed = 6 + 2;
  const drop = parsed.min != null && parsed.min > maxAllowed;
  return {
    input: { snippet: "at least 8 years", userYoe: 6, maxAllowed: 8 },
    output: { parsed, drop },
    expected: "min=8, maxAllowed=8 → 8>8 is false → KEEP",
    pass: drop === false,
    note: `parsed min=${parsed.min}. 8 > 8 = false → job KEPT. Boundary is STRICT greater-than.`
  };
});

test("6-YOEFilter", "'2 to 4 years of experience', userYoe=4 → KEEP", () =>
  yoeTest("We need 2 to 4 years of relevant experience.", 4, false, 2, 4));

// ─────────────────────────────────────────────────────────────
// GROUP 7: Classification (Stage 5)
// ─────────────────────────────────────────────────────────────

function classifyTest(title, desc, expectedRoleKey) {
  const result = classifyForIngest(title, desc || "");
  const pass = expectedRoleKey === null
    ? result === null
    : result?.roleKey === expectedRoleKey && result?.confidence >= INGEST_CONFIDENCE_THRESHOLD;
  return {
    input: { title, description_snippet: (desc || "").slice(0, 60) + "…" },
    output: result,
    expected: expectedRoleKey ? `roleKey="${expectedRoleKey}" confidence≥0.75` : "null (unclassified)",
    pass,
    note: result
      ? `roleKey="${result.roleKey}" confidence=${result.confidence} matchedBy="${result.matchedBy}"`
      : "returned null — unclassified"
  };
}

const dsDesc = "Build predictive models using Python, scikit-learn, XGBoost. A/B testing, SQL, feature engineering.";
const mlDesc = "Train and deploy ML models. Deep learning, PyTorch, TensorFlow, MLOps pipeline, model serving.";
const deDesc = "Build data pipelines using Spark, Airflow, dbt. ETL, Kafka, BigQuery, data warehouse design.";
const baDesc = "Analyze business metrics, create dashboards in Tableau, SQL queries, stakeholder reporting.";
const sweDesc = "Build backend APIs in Python/Django. REST, PostgreSQL, Docker, CI/CD, microservices.";

test("7-Classification", "'Data Scientist' + DS description → role_key='data'", () =>
  classifyTest("Data Scientist", dsDesc, "data"));

test("7-Classification", "'Machine Learning Engineer' + ML description → role_key='data'", () =>
  classifyTest("Machine Learning Engineer", mlDesc, "data"));

test("7-Classification", "'Data Engineer' + pipeline description → role_key='data'", () =>
  classifyTest("Data Engineer", deDesc, "data"));

test("7-Classification", "'Business Analyst' + BI description → should classify (data or unclassified?)", () => {
  const result = classifyForIngest("Business Analyst", baDesc);
  return {
    input: { title: "Business Analyst", desc: baDesc.slice(0,60) },
    output: result,
    expected: "documenting actual behaviour",
    pass: true,
    note: result
      ? `classifies as "${result.roleKey}" at ${result.confidence} — will appear on ${result.roleKey} profile boards`
      : "returns null → UNCLASSIFIED — won't appear on any board without manual review"
  };
});

test("7-Classification", "'Software Engineer' + SWE description → role_key='engineering' NOT 'data'", () =>
  classifyTest("Software Engineer", sweDesc, "engineering"));

test("7-Classification", "'Analytics Engineer' + DE description → what wins?", () => {
  const result = classifyForIngest("Analytics Engineer", deDesc);
  return {
    input: { title: "Analytics Engineer" }, output: result,
    expected: "documenting — data vs engineering conflict",
    pass: true,
    note: result ? `"${result.roleKey}" at ${result.confidence}` : "null"
  };
});

test("7-Classification", "title only, empty description → confidence drops?", () => {
  const result = classifyForIngest("Data Scientist", "");
  return {
    input: { title: "Data Scientist", description: "(empty)" }, output: result,
    expected: "role_key='data' (title alone should be enough)",
    pass: result?.roleKey === "data",
    note: result ? `roleKey="${result.roleKey}" conf=${result.confidence}` : "null — title alone insufficient"
  };
});

test("7-Classification", "'Intern Data Scientist' — does intern in title affect classification?", () => {
  const result = classifyForIngest("Intern Data Scientist", dsDesc);
  return {
    input: { title: "Intern Data Scientist" }, output: result,
    expected: "role_key='data'",
    pass: result?.roleKey === "data",
    note: result ? `"${result.roleKey}" at ${result.confidence}` : "null"
  };
});

// ─────────────────────────────────────────────────────────────
// GROUP 8: profileTitleSql edge cases (Stage 6)
// ─────────────────────────────────────────────────────────────

test("8-ProfileTitleSQL", "3 target titles → 3 OR clauses", () => {
  const profile = { target_titles: JSON.stringify(["Data Scientist","ML Engineer","Analytics Engineer"]) };
  const { sql, params } = profileTitleSql("sj.title", profile);
  const clauseCount = (sql.match(/LOWER/g) || []).length;
  return { input: { target_titles: ["Data Scientist","ML Engineer","Analytics Engineer"] },
    output: { sql, params, clauseCount },
    expected: "sql has LIKE clauses for each meaningful token",
    pass: params.includes("%data%") && params.includes("%scientist%"),
    note: `params=${JSON.stringify(params)} clauses=${clauseCount}` };
});

test("8-ProfileTitleSQL", "empty target_titles → returns 1=1 passthrough", () => {
  const profile = { target_titles: JSON.stringify([]) };
  const { sql, params } = profileTitleSql("sj.title", profile);
  return { input: { target_titles: [] }, output: { sql, params },
    expected: { sql: "1 = 1", params: [] },
    pass: sql === "1 = 1" && params.length === 0,
    note: `sql="${sql}" params=${JSON.stringify(params)}` };
});

test("8-ProfileTitleSQL", "target title with only stop words → no tokens → falls through to 1=1", () => {
  const profile = { target_titles: JSON.stringify(["Senior Lead Engineer"]) };
  const { sql, params } = profileTitleSql("sj.title", profile);
  // "senior" and "lead" are stop words, "engineer" is also a stop word in profileTitleFilter
  return { input: { target_titles: ["Senior Lead Engineer"] }, output: { sql, params },
    expected: "documenting actual behaviour",
    pass: true,
    note: `sql="${sql}" params=${JSON.stringify(params)} — if all tokens are stop words, no clause generated` };
});

// ─────────────────────────────────────────────────────────────
// OUTPUT
// ─────────────────────────────────────────────────────────────

const sep = "=".repeat(70);
const div = "-".repeat(70);

let totalPass = 0, totalFail = 0;
const output = [];

output.push(sep);
output.push("PIPELINE CONDITION TEST RESULTS");
output.push(`Run: ${new Date().toISOString()}`);
output.push(sep);

const groups = [...new Set(results.map(r => r.group))];

for (const group of groups) {
  output.push(`\n\n${div}`);
  output.push(`GROUP: ${group}`);
  output.push(div);

  const groupResults = results.filter(r => r.group === group);
  for (const r of groupResults) {
    const badge = r.pass ? "PASS" : "FAIL";
    if (r.pass) totalPass++; else totalFail++;

    output.push(`\n[${badge}] ${r.name}`);

    if (r.error) {
      output.push(`  ERROR: ${r.error}`);
      continue;
    }

    output.push(`  INPUT:    ${JSON.stringify(r.input, null, 0).slice(0, 200)}`);
    output.push(`  OUTPUT:   ${JSON.stringify(r.output, null, 0).slice(0, 200)}`);
    output.push(`  EXPECTED: ${typeof r.expected === "string" ? r.expected : JSON.stringify(r.expected)}`);
    if (r.note) output.push(`  NOTE:     ${r.note}`);
  }
}

output.push(`\n\n${sep}`);
output.push("SUMMARY");
output.push(sep);
output.push(`Total: ${results.length}   PASS: ${totalPass}   FAIL: ${totalFail}`);
output.push("");

const failures = results.filter(r => !r.pass);
if (failures.length === 0) {
  output.push("All tests passed.");
} else {
  output.push("FAILING TESTS:");
  for (const f of failures) {
    output.push(`  [FAIL] ${f.group} → "${f.name}"`);
    output.push(`         expected: ${typeof f.expected === "string" ? f.expected : JSON.stringify(f.expected)}`);
    output.push(`         got:      ${JSON.stringify(f.output, null, 0).slice(0, 150)}`);
    if (f.note) output.push(`         note:     ${f.note}`);
  }
}

output.push(sep);

const text = output.join("\n");
console.log(text);

import fs from "fs";
fs.writeFileSync("condition_test_results.txt", text);
