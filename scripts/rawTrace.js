// =============================================================
// scripts/rawTrace.js
// Shows the EXACT raw objects passed into and returned from
// each pipeline function — no annotations, pure JSON.
//
// Usage:
//   node scripts/rawTrace.js
//   node scripts/rawTrace.js --scenario datascientist
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

// ── Scenario ─────────────────────────────────────────────────
const args = process.argv.slice(2);
const scenarioArg =
  args.find(a => a.startsWith("--scenario="))?.split("=")[1] ||
  (args.includes("--scenario") ? args[args.indexOf("--scenario") + 1] : null) ||
  "datascientist";

const SCENARIOS = {
  datascientist: {
    rawRole: "data scientist",
    profile: {
      profile_name: "Data Scientist",
      target_titles: JSON.stringify(["Data Scientist", "ML Engineer", "Analytics Engineer"]),
      seniority: "mid",
      domain: "data",
      role_family: "data",
    },
    userYoe: 4,
    rawJob: {
      id: "4123456789",
      title: "Data Scientist",
      company: { name: "Insight Analytics Inc" },
      location: "Remote",
      contractType: "full_time",
      description: {
        text:
          "We are seeking a Data Scientist with 3-5 years of experience to join our growing team. " +
          "You will build and deploy predictive models, run A/B tests, and surface insights to stakeholders. " +
          "Requirements: strong Python skills, SQL, and ML frameworks (scikit-learn, XGBoost, LightGBM). " +
          "Experience with data pipelines, feature engineering, and experiment design preferred. " +
          "Familiarity with cloud platforms (AWS, GCP) and tools like dbt, Airflow, or Spark is a plus. " +
          "This is a full-time remote role with equity compensation.",
        html: "<p>We are seeking a <strong>Data Scientist</strong> with 3-5 years of experience...</p>",
      },
      applyMethod: { companyApplyUrl: "https://insightanalytics.com/careers/apply/4123456789" },
      linkedinUrl: "https://www.linkedin.com/jobs/view/4123456789",
      workplaceType: "remote",
      listingDate: "2026-05-06",
      salary: { min: 120000, max: 160000, currency: "USD" },
      applicants: 47,
    },
  },
};

const s = SCENARIOS[scenarioArg] || SCENARIOS.datascientist;
const sep = "\n" + "=".repeat(70) + "\n";
const div = "-".repeat(70);

function dump(label, obj) {
  console.log(`\n${div}`);
  console.log(`${label}`);
  console.log(`${div}`);
  console.log(JSON.stringify(obj, null, 2));
}

console.log(sep);
console.log(`PIPELINE RAW TRACE — scenario: ${scenarioArg}`);
console.log(sep);

// ════════════════════════════════════════════════════════════
// STAGE 1 — normaliseRole
// ════════════════════════════════════════════════════════════
console.log("\n\n====== STAGE 1: normaliseRole ======");

const stage1_input = s.rawRole;
const stage1_output = normaliseRole(s.rawRole);

dump("INPUT  → raw role string", stage1_input);
dump("OUTPUT → normalised role", stage1_output);

// ════════════════════════════════════════════════════════════
// STAGE 2 — buildApifyQueriesFromProfile
// ════════════════════════════════════════════════════════════
console.log("\n\n====== STAGE 2: buildApifyQueriesFromProfile ======");

const stage2_input = {
  profile_name:   s.profile.profile_name,
  target_titles:  JSON.parse(s.profile.target_titles),
  seniority:      s.profile.seniority,
  domain:         s.profile.domain,
  role_family:    s.profile.role_family,
};
const stage2_output = buildApifyQueriesFromProfile(s.profile);

dump("INPUT  → active domain profile object", stage2_input);
dump("OUTPUT → jobTitles[] array (sent to Apify)", stage2_output);

// ════════════════════════════════════════════════════════════
// STAGE 2.5 — full Apify actor input payload
// ════════════════════════════════════════════════════════════
console.log("\n\n====== STAGE 2.5: Apify actor input payload (scrapeHarvestAPI) ======");

const apifyActorInput = {
  jobTitles:      stage2_output,
  locations:      ["United States"],
  workplaceType:  ["remote", "hybrid", "office"],
  employmentType: ["full-time"],
  postedLimit:    "24h",
  maxItems:       300,
};

dump("INPUT  → payload sent to harvestapi/linkedin-job-search actor", apifyActorInput);
dump("OUTPUT → raw items array from Apify (one sample item shown)", [s.rawJob]);

// ════════════════════════════════════════════════════════════
// STAGE 3 — normaliseItem
// ════════════════════════════════════════════════════════════
console.log("\n\n====== STAGE 3: normaliseItem ======");

dump("INPUT  → raw Apify item", s.rawJob);

const normItem = normaliseItem(s.rawJob);

dump("OUTPUT → normalised item (internal schema)", normItem);

// ════════════════════════════════════════════════════════════
// STAGE 4a — isEmploymentTypeWanted
// ════════════════════════════════════════════════════════════
console.log("\n\n====== STAGE 4a: isEmploymentTypeWanted ======");

const wantedTypes = ["full-time"];
const stage4a_input = {
  "item.title":       normItem.title,
  "item.jobType":     normItem.jobType,
  "item.description": normItem.description,
  wantedTypes,
};
const stage4a_output = isEmploymentTypeWanted(normItem, wantedTypes);

dump("INPUT  → item fields + wantedTypes", stage4a_input);
dump("OUTPUT → boolean (true = keep, false = drop)", stage4a_output);

// ════════════════════════════════════════════════════════════
// STAGE 4b — isTitleRelevantToProfile
// ════════════════════════════════════════════════════════════
console.log("\n\n====== STAGE 4b: isTitleRelevantToProfile ======");

const stage4b_input = {
  jobTitle:     normItem.title,
  targetTitles: stage2_output,
};
const stage4b_output = isTitleRelevantToProfile(normItem.title, stage2_output);

dump("INPUT  → job title + profile target variants", stage4b_input);
dump("OUTPUT → boolean (true = title relevant, false = drop)", stage4b_output);

// ════════════════════════════════════════════════════════════
// STAGE 4c — ghostJobScoreNorm + isReposted
// ════════════════════════════════════════════════════════════
console.log("\n\n====== STAGE 4c: ghostJobScoreNorm + isReposted ======");

const itemForGhost = { ...normItem, url: normItem.applyUrl || normItem.url };
const stage4c_input = {
  "item.url":         itemForGhost.url,
  "item.description": normItem.description,
  "item.company":     normItem.company,
  "item.title":       normItem.title,
};
const ghostScore = ghostJobScoreNorm(itemForGhost);
const reposted   = isReposted(normItem);
const stage4c_output = {
  ghostScore,
  reposted,
  drop: ghostScore >= 4 || reposted,
};

dump("INPUT  → item fields checked for ghost signals", stage4c_input);
dump("OUTPUT → score + reposted flag (drop if score >= 4 or reposted)", stage4c_output);

// ════════════════════════════════════════════════════════════
// STAGE 4d — parseYearsExperience
// ════════════════════════════════════════════════════════════
console.log("\n\n====== STAGE 4d: parseYearsExperience ======");

const stage4d_input = {
  description:          normItem.description,
  "user.yearsExperience": s.userYoe,
  "maxAllowed (user+2)":  s.userYoe + 2,
};
const yoeParsed   = parseYearsExperience(normItem.description || "");
const stage4d_output = {
  parsed:     yoeParsed,
  maxAllowed: s.userYoe + 2,
  drop:       yoeParsed.min != null && yoeParsed.min > (s.userYoe + 2),
};

dump("INPUT  → description text + user YOE context", stage4d_input);
dump("OUTPUT → parsed YOE range + drop decision", stage4d_output);

// ════════════════════════════════════════════════════════════
// STAGE 5 — classifyForIngest
// ════════════════════════════════════════════════════════════
console.log("\n\n====== STAGE 5: classifyForIngest ======");

const stage5_input = {
  title:       normItem.title,
  description: normItem.description,
  threshold:   INGEST_CONFIDENCE_THRESHOLD,
};
const classResult = classifyForIngest(normItem.title, normItem.description || "");

dump("INPUT  → title + description + confidence threshold", stage5_input);
dump("OUTPUT → classification result (null = unclassified)", classResult);

// ════════════════════════════════════════════════════════════
// STAGE 5.5 — DB INSERT rows (computed values)
// ════════════════════════════════════════════════════════════
console.log("\n\n====== STAGE 5.5: DB INSERT rows ======");

const yoeForDb  = parseYearsExperience(normItem.description || "");
const wtForDb   = inferWorkType(
  (normItem.workTypeHint || "") + " " + (normItem.location || "") + " " + (normItem.description || "")
);
const ghostForDb = ghostJobScoreNorm({ ...normItem, url: normItem.applyUrl || normItem.url });

const scrapedJobsRow = {
  job_id:              normItem.jobId,
  search_query:        stage1_output.toLowerCase(),
  company:             normItem.company,
  title:               normItem.title,
  category:            "(assigned by async classifyJob call)",
  location:            normItem.location || "United States",
  work_type:           wtForDb,
  source:              "LinkedIn",
  url:                 normItem.url || null,
  apply_url:           normItem.applyUrl || null,
  posted_at:           "(normalizePostedAt('2026-05-06') → unix epoch)",
  description:         normItem.description || null,
  description_html:    normItem.descriptionHtml || null,
  ghost_score:         ghostForDb,
  years_experience:    yoeForDb.min,
  min_years_exp:       yoeForDb.min,
  max_years_exp:       yoeForDb.max,
  exp_raw:             yoeForDb.raw,
  is_frequent_repost:  isReposted(normItem) ? 1 : 0,
  _hash:               "(md5('insight analytics inc|data scientist'))",
  scraped_at:          "(unixepoch())",
  source_platform:     "linkedin",
  salary_min:          normItem.salaryMin || null,
  salary_max:          normItem.salaryMax || null,
  salary_currency:     normItem.salaryCurrency || null,
  applicant_count:     normItem.applicantCount || null,
  company_icon_url:    normItem.companyLogoUrl || null,
  employment_type:     normItem.jobType || null,
  domain_profile_id:   "(domain_profiles.id of active profile)",
};

const jobRoleMapRow = {
  job_id:            normItem.jobId,
  role_key:          classResult?.roleKey || null,
  role_family:       s.profile.role_family,
  domain:            s.profile.domain,
  source_profile_id: "(domain_profiles.id of active profile)",
  confidence:        classResult?.confidence || null,
  matched_by:        "profile_scrape",
};

const userJobsRow = {
  user_id:           "(users.id — user who triggered /api/scrape)",
  job_id:            normItem.jobId,
  domain_profile_id: "(domain_profiles.id of active profile)",
  visited:           0,
  starred:           0,
  disliked:          0,
  applied:           0,
  resume_generated:  0,
  updated_at:        "(unixepoch() on first board interaction)",
};

dump("TABLE: scraped_jobs — INSERT values", scrapedJobsRow);
dump("TABLE: job_role_map — INSERT values", jobRoleMapRow);
dump("TABLE: user_jobs    — INSERT values (created lazily on first board load)", userJobsRow);

// ════════════════════════════════════════════════════════════
// STAGE 6 — profileTitleSql
// ════════════════════════════════════════════════════════════
console.log("\n\n====== STAGE 6: profileTitleSql (board query filter) ======");

const stage6_input = {
  column:        "sj.title",
  target_titles: JSON.parse(s.profile.target_titles),
};
const sqlResult = profileTitleSql("sj.title", s.profile);

dump("INPUT  → column name + profile.target_titles", stage6_input);
dump("OUTPUT → SQL fragment + bind params", { sql: sqlResult.sql, params: sqlResult.params });

console.log(sep);
console.log("END OF TRACE");
console.log(sep);
