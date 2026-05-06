// =============================================================
// scripts/tracePipeline.js
// Traces a sample job through every stage of the pull pipeline,
// printing the exact input → output at each step.
//
// Usage:
//   node scripts/tracePipeline.js
//   node scripts/tracePipeline.js --scenario datascientist
//   node scripts/tracePipeline.js --role "Data Scientist"
//   node scripts/tracePipeline.js --scenario contract
//   node scripts/tracePipeline.js --scenario ghost
//   node scripts/tracePipeline.js --scenario yoe_drop
//   node scripts/tracePipeline.js --scenario imported
//
// Scenarios:
//   datascientist  Data Scientist, full-time, 3-5 YOE — PASSES all filters (shows Apify payload + DB rows)
//   default        Normal full-time SWE job that passes all filters
//   contract       Contract job — dropped at Stage 4a (employment type)
//   ghost          Ghost listing — dropped at Stage 4c (ghost score ≥ 4)
//   yoe_drop       Job requiring 10 YOE — dropped at Stage 4d
//   imported       LinkedIn-imported job (extension path, Stages 1+7)
//   firmware       Firmware engineer role to test domain isolation
// =============================================================

import {
  normaliseRole,
  buildApifyQueriesFromProfile,
  buildProfileSearchTerms,
  isTitleRelevantToProfile,
  isTitleRelevant,
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
  classifyTitle,
  classifyForIngest,
  INGEST_CONFIDENCE_THRESHOLD,
} from "../services/jobClassifier.js";

import { profileTitleSql } from "../services/profileTitleFilter.js";

import {
  importedJobDedupeKey,
  normaliseImportedJob,
} from "../services/importedJobs.js";

// ── ANSI colour helpers ───────────────────────────────────────
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  cyan:   "\x1b[36m",
  green:  "\x1b[32m",
  red:    "\x1b[31m",
  yellow: "\x1b[33m",
  blue:   "\x1b[34m",
  magenta:"\x1b[35m",
  white:  "\x1b[37m",
  gray:   "\x1b[90m",
  bgGreen:  "\x1b[42m",
  bgRed:    "\x1b[41m",
  bgYellow: "\x1b[43m",
};

const PASS = `${C.bgGreen}${C.bold} PASS ${C.reset}`;
const FAIL = `${C.bgRed}${C.bold} DROP ${C.reset}`;
const INFO = `${C.bgYellow}${C.bold} INFO ${C.reset}`;

function header(title) {
  const line = "─".repeat(64);
  console.log(`\n${C.cyan}${C.bold}${line}${C.reset}`);
  console.log(`${C.cyan}${C.bold}  ${title}${C.reset}`);
  console.log(`${C.cyan}${C.bold}${line}${C.reset}`);
}

function sectionHeader(stage, name) {
  console.log(`\n${C.bold}${C.blue}▶ Stage ${stage}  ${C.white}${name}${C.reset}`);
  console.log(`${C.gray}${"─".repeat(50)}${C.reset}`);
}

function label(text) {
  return `${C.dim}${text}${C.reset}`;
}

function key(text) {
  return `${C.yellow}${text}${C.reset}`;
}

function val(v) {
  if (v === null || v === undefined) return `${C.gray}null${C.reset}`;
  if (typeof v === "boolean")  return v ? `${C.green}true${C.reset}` : `${C.red}false${C.reset}`;
  if (typeof v === "number")   return `${C.magenta}${v}${C.reset}`;
  if (Array.isArray(v))        return `${C.white}[${v.map(i => `"${i}"`).join(", ")}]${C.reset}`;
  if (typeof v === "object")   return `${C.white}${JSON.stringify(v, null, 2)}${C.reset}`;
  return `${C.green}"${v}"${C.reset}`;
}

function row(k, v, indent = "  ") {
  console.log(`${indent}${key(k.padEnd(26))} ${val(v)}`);
}

function inputBlock(obj, title = "INPUT") {
  console.log(`\n  ${C.dim}┌── ${title} ${"─".repeat(Math.max(0, 40 - title.length))}┐${C.reset}`);
  for (const [k, v] of Object.entries(obj)) {
    const display = typeof v === "string" && v.length > 80 ? v.slice(0, 80) + "…" : v;
    console.log(`  ${C.dim}│${C.reset}  ${key(k.padEnd(24))} ${val(display)}`);
  }
  console.log(`  ${C.dim}└${"─".repeat(48)}┘${C.reset}`);
}

function outputBlock(obj, title = "OUTPUT") {
  console.log(`\n  ${C.dim}┌── ${title} ${"─".repeat(Math.max(0, 40 - title.length))}┐${C.reset}`);
  if (obj === null) {
    console.log(`  ${C.dim}│${C.reset}  ${C.red}null — item was rejected${C.reset}`);
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => console.log(`  ${C.dim}│${C.reset}  ${C.gray}[${i}]${C.reset}  ${val(v)}`));
  } else {
    for (const [k, v] of Object.entries(obj)) {
      const display = typeof v === "string" && v.length > 80 ? v.slice(0, 80) + "…" : v;
      console.log(`  ${C.dim}│${C.reset}  ${key(k.padEnd(24))} ${val(display)}`);
    }
  }
  console.log(`  ${C.dim}└${"─".repeat(48)}┘${C.reset}`);
}

function verdict(passed, reason = "") {
  const badge = passed ? PASS : FAIL;
  const msg   = reason ? `  ${C.dim}${reason}${C.reset}` : "";
  console.log(`\n  ${badge}${msg}`);
}

// ── Sample scenarios ──────────────────────────────────────────
const args       = process.argv.slice(2);
const scenarioArg = args.find(a => a.startsWith("--scenario="))?.split("=")[1]
                 || (args.includes("--scenario") ? args[args.indexOf("--scenario") + 1] : null)
                 || "default";
const roleArg    = args.find(a => a.startsWith("--role="))?.split("=")[1]
                 || (args.includes("--role") ? args[args.indexOf("--role") + 1] : null)
                 || null;

const SCENARIOS = {
  default: {
    label: "Normal full-time SWE job (should PASS all filters)",
    rawRole: roleArg || "software engineer",
    profile: {
      profile_name: "Software Engineer",
      target_titles: JSON.stringify(["Software Engineer", "Backend Engineer", "Full Stack Engineer"]),
      seniority: "mid",
      domain: "it_digital",
      role_family: "engineering",
    },
    userYoe: 3,
    rawJob: {
      id: "3987654321",
      title: "Software Engineer",
      company: { name: "Acme Corp" },
      location: "New York, NY (Hybrid)",
      contractType: "full_time",
      description: {
        text: "We are looking for a Software Engineer with 2-4 years of experience. " +
          "You will build backend services using Node.js and Python. " +
          "Experience with REST APIs, microservices, and CI/CD pipelines is required. " +
          "This is a hybrid role based in New York.",
      },
      applyMethod: { companyApplyUrl: "https://careers.acme.com/apply/3987654321" },
      linkedinUrl: "https://www.linkedin.com/jobs/view/3987654321",
      workplaceType: "hybrid",
      listingDate: "2026-05-05",
    },
  },

  contract: {
    label: "Contract job (should be DROPPED at Stage 4a — employment type filter)",
    rawRole: roleArg || "software engineer",
    profile: {
      profile_name: "Software Engineer",
      target_titles: JSON.stringify(["Software Engineer"]),
      seniority: "mid",
      domain: "it_digital",
      role_family: "engineering",
    },
    userYoe: 3,
    rawJob: {
      id: "1111111111",
      title: "Software Engineer – Contract",
      company: { name: "Staffing Agency LLC" },
      location: "Remote",
      contractType: "contract",
      description: {
        text: "6-month W2 contract opportunity. Must be available for C2C or corp-to-corp arrangements. " +
          "Experience with Node.js required. Possible contract-to-hire based on performance.",
      },
      applyMethod: { companyApplyUrl: "https://staffingagency.com/apply/1111111111" },
      workplaceType: "remote",
    },
  },

  ghost: {
    label: "Ghost/fake listing (should be DROPPED at Stage 4c — ghost score ≥ 4)",
    rawRole: roleArg || "software engineer",
    profile: {
      profile_name: "Software Engineer",
      target_titles: JSON.stringify(["Software Engineer"]),
      seniority: "mid",
      domain: "it_digital",
      role_family: "engineering",
    },
    userYoe: 3,
    rawJob: {
      id: "9999999999",
      title: "Software Engineer",
      company: { name: "Unknown" },
      location: "",
      contractType: "full_time",
      description: { text: "Apply now." },  // very short — ghost signal
      applyMethod: { companyApplyUrl: "" }, // no URL — ghost signal
      workplaceType: "office",
    },
  },

  yoe_drop: {
    label: "YOE mismatch — job requires 10+ years, user has 3 (should be DROPPED at Stage 4d)",
    rawRole: roleArg || "software engineer",
    profile: {
      profile_name: "Software Engineer",
      target_titles: JSON.stringify(["Software Engineer", "Backend Engineer"]),
      seniority: "mid",
      domain: "it_digital",
      role_family: "engineering",
    },
    userYoe: 3,
    rawJob: {
      id: "8888888888",
      title: "Principal Software Engineer",
      company: { name: "BigTech Inc" },
      location: "San Francisco, CA",
      contractType: "full_time",
      description: {
        text: "This role requires 10+ years of experience in software engineering. " +
          "You will lead architectural decisions across multiple product teams. " +
          "Strong background in distributed systems and system design required.",
      },
      applyMethod: { companyApplyUrl: "https://bigtech.com/apply/8888888888" },
      workplaceType: "hybrid",
      listingDate: "2026-05-04",
    },
  },

  firmware: {
    label: "Firmware engineer — tests domain isolation (must NOT route to generic SWE)",
    rawRole: roleArg || "firmware engineer",
    profile: {
      profile_name: "Firmware Engineer",
      target_titles: JSON.stringify(["Firmware Engineer", "Embedded Systems Engineer"]),
      seniority: "mid",
      domain: "engineering_embedded_firmware",
      role_family: "engineering",
    },
    userYoe: 5,
    rawJob: {
      id: "7777777777",
      title: "Firmware Engineer",
      company: { name: "Chip Maker Corp" },
      location: "Austin, TX",
      contractType: "full_time",
      description: {
        text: "Looking for a Firmware Engineer with 3-6 years of experience. " +
          "Must have strong skills in C/C++, RTOS, JTAG debugging, and ARM Cortex. " +
          "Experience with device tree, Yocto, and bootloader bring-up preferred.",
      },
      applyMethod: { companyApplyUrl: "https://chipmaker.com/apply/7777777777" },
      workplaceType: "office",
      listingDate: "2026-05-03",
    },
  },

  datascientist: {
    label: "Data Scientist, full-time, 3–5 YOE (should PASS all filters)",
    rawRole: roleArg || "data scientist",
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
        text: "We are seeking a Data Scientist with 3-5 years of experience to join our growing team. " +
          "You will build and deploy predictive models, run A/B tests, and surface insights to stakeholders. " +
          "Requirements: strong Python skills, SQL, and ML frameworks (scikit-learn, XGBoost, LightGBM). " +
          "Experience with data pipelines, feature engineering, and experiment design preferred. " +
          "Familiarity with cloud platforms (AWS, GCP) and tools like dbt, Airflow, or Spark is a plus. " +
          "This is a full-time remote role with equity compensation.",
      },
      applyMethod: { companyApplyUrl: "https://insightanalytics.com/careers/apply/4123456789" },
      linkedinUrl: "https://www.linkedin.com/jobs/view/4123456789",
      workplaceType: "remote",
      listingDate: "2026-05-06",
      salary: { min: 120000, max: 160000, currency: "USD" },
      applicants: 47,
    },
  },

  imported: {
    label: "LinkedIn-imported job (extension path — tests Stages 1 & 7)",
    rawRole: roleArg || "data scientist",
    profile: {
      profile_name: "Data Scientist",
      target_titles: JSON.stringify(["Data Scientist", "ML Engineer"]),
      seniority: "senior",
      domain: "data",
      role_family: "data",
    },
    userYoe: 6,
    rawLinkedInJob: {
      externalJobId: "3876543210",
      title: "Senior Data Scientist",
      company: "DataCo",
      location: "Remote",
      jobUrl: "https://www.linkedin.com/jobs/view/3876543210",
      applyUrl: "https://datacoo.com/careers/apply#top",
      postedAt: "2 days ago",
      sourcePlatform: "linkedin",
      compensation: "$160K–$200K",
      description: "Must have 5+ years of experience. Proficiency in Python, dbt, BigQuery required.",
    },
  },
};

const scenario = SCENARIOS[scenarioArg] || SCENARIOS.default;

// ── MAIN TRACE ────────────────────────────────────────────────
header(`JOB PIPELINE TRACE  —  "${scenario.label}"`);
console.log(`  ${label("Scenario:")} ${val(scenarioArg)}    ${label("Profile:")} ${val(scenario.profile.profile_name)}`);

let pipelineDropped = false;
let droppedAt = null;

// ════════════════════════════════════════════════════════════
// STAGE 1 · Role normalisation
// ════════════════════════════════════════════════════════════
sectionHeader("1", "Role Normalisation  (searchQueryBuilder.js → normaliseRole)");

const rawRoleInput = scenario.rawRole;
const normalisedRole = normaliseRole(rawRoleInput);

inputBlock({ rawRole: rawRoleInput });
outputBlock({ normalisedRole });
verdict(true, "Role input cleaned and alias-mapped to canonical form");

// ════════════════════════════════════════════════════════════
// STAGE 2 · Profile-driven title variant building
// ════════════════════════════════════════════════════════════
sectionHeader("2", "Profile-Driven Title Variants  (searchQueryBuilder.js → buildApifyQueriesFromProfile)");

const profileInput = {
  profile_name: scenario.profile.profile_name,
  target_titles: JSON.parse(scenario.profile.target_titles),
  seniority: scenario.profile.seniority,
  domain: scenario.profile.domain,
};

const titleVariants = buildApifyQueriesFromProfile(scenario.profile);

inputBlock(profileInput, "PROFILE INPUT");
outputBlock(titleVariants, "TITLE VARIANTS SENT TO APIFY");
console.log(`\n  ${label("→ These become the")} ${key("jobTitles[]")} ${label("array in the Apify/HarvestAPI call.")}`);
verdict(true, `${titleVariants.length} title variant(s) generated`);

// ════════════════════════════════════════════════════════════
// STAGE 2.5 · Apify / HarvestAPI payload
// ════════════════════════════════════════════════════════════
sectionHeader("2.5", "Apify / HarvestAPI Payload  (what gets SENT to the external scraper)");
console.log(`  ${label("Actor:")} ${C.cyan}harvestapi/linkedin-job-search${C.reset}  ${label("(LinkedIn scraper on Apify platform)")}`);

const apifyPayload = {
  jobTitles:      titleVariants,
  locations:      ["United States"],          // from user_profile.location (or default)
  workplaceType:  ["remote", "hybrid", "office"],
  employmentType: ["full-time"],
  postedLimit:    "24h",                       // mapped from UI ageFilter (24h = last 24 hrs)
  maxItems:       300,                         // MAX_JOBS_PER_REFRESH (100) × 3
};

inputBlock(apifyPayload, "FULL PAYLOAD SENT TO APIFY");
console.log(`\n  ${label("Notes:")}`);
console.log(`  ${C.dim}│${C.reset}  ${key("jobTitles")}     comes from buildApifyQueriesFromProfile() — profile drives the search`);
console.log(`  ${C.dim}│${C.reset}  ${key("workplaceType")} always all three — UI board filter is applied after, not before`);
console.log(`  ${C.dim}│${C.reset}  ${key("postedLimit")}   "24h" = last 24 hours (default). "1w" / "1m" when UI sets ageFilter`);
console.log(`  ${C.dim}│${C.reset}  ${key("maxItems")}      300 cap; firmware domain gets 75 (smaller niche)`);
console.log(`  ${C.dim}│${C.reset}  ${key("locations")}     single string from user_profile; defaults to "United States"`);

// Sample raw HarvestAPI response shape (representative, not live)
const sampleRaw = scenario.rawJob
  ? {
      id:             scenario.rawJob.id,
      title:          scenario.rawJob.title,
      "company.name": scenario.rawJob.company?.name || scenario.rawJob.company,
      location:       scenario.rawJob.location,
      contractType:   scenario.rawJob.contractType,
      workplaceType:  scenario.rawJob.workplaceType,
      "description.text": ((scenario.rawJob.description?.text || "")).slice(0, 80) + "…",
      "description.html": "<p>(HTML markup of the full job post)</p>",
      "applyMethod.companyApplyUrl": scenario.rawJob.applyMethod?.companyApplyUrl || null,
      linkedinUrl:    scenario.rawJob.linkedinUrl || null,
      listingDate:    scenario.rawJob.listingDate || null,
      "salary.min":   scenario.rawJob.salary?.min || null,
      "salary.max":   scenario.rawJob.salary?.max || null,
      "salary.currency": scenario.rawJob.salary?.currency || null,
      applicants:     scenario.rawJob.applicants ?? null,
    }
  : null;

if (sampleRaw) {
  outputBlock(sampleRaw, "SAMPLE RAW APIFY RESPONSE ITEM (1 of up to 300 returned)");
  console.log(`\n  ${label("→ Apify returns a flat array of these objects (50–200 items typical)")}`);
  console.log(`  ${label("→ Each item is handed to")} ${key("normaliseItem()")} ${label("in Stage 3 to map to internal schema")}`);
}
verdict(true, `Payload queued — Apify actor runs for 2–5 min; server responds immediately with {scraping:true}`);

// ════════════════════════════════════════════════════════════
// STAGE 3 · Raw item normalisation
// ════════════════════════════════════════════════════════════
sectionHeader("3", "Raw Item Normalisation  (jobNormalization.js → normaliseItem)");

if (scenario.rawJob) {
  const rawInput = scenario.rawJob;
  const normItem = normaliseItem(rawInput);

  inputBlock({
    id:           rawInput.id,
    title:        rawInput.title,
    company:      rawInput.company?.name || rawInput.company,
    location:     rawInput.location,
    contractType: rawInput.contractType,
    workplaceType:rawInput.workplaceType,
    description:  (rawInput.description?.text || "").slice(0, 80) + "…",
  }, "RAW API RESPONSE (key fields)");

  outputBlock({
    jobId:         normItem.jobId,
    title:         normItem.title,
    company:       normItem.company,
    location:      normItem.location,
    jobType:       normItem.jobType,
    workTypeHint:  normItem.workTypeHint,
    applyUrl:      normItem.applyUrl,
    salaryMin:     normItem.salaryMin,
    salaryMax:     normItem.salaryMax,
    description:   (normItem.description || "").slice(0, 80) + "…",
  }, "NORMALISED ITEM");

  // ════════════════════════════════════════════════════════════
  // STAGE 4a · Employment type filter
  // ════════════════════════════════════════════════════════════
  sectionHeader("4a", "Employment Type Filter  (jobNormalization.js → isEmploymentTypeWanted)");

  const wantedTypes = ["full-time"];
  const empTypePassed = isEmploymentTypeWanted(normItem, wantedTypes);

  inputBlock({
    "item.jobType":    normItem.jobType,
    "item.title":      normItem.title,
    "item.description": (normItem.description || "").slice(0, 100) + "…",
    "wantedTypes":     wantedTypes,
  });
  outputBlock({ passed: empTypePassed });

  if (!empTypePassed) {
    verdict(false, "Contract/temp keywords detected → job DROPPED here");
    pipelineDropped = true;
    droppedAt = "4a (employment type)";
  } else {
    verdict(true, "Employment type is acceptable — continues to next stage");
  }

  // ════════════════════════════════════════════════════════════
  // STAGE 4b · Title relevance filter
  // ════════════════════════════════════════════════════════════
  if (!pipelineDropped) {
    sectionHeader("4b", "Title Relevance Filter  (searchQueryBuilder.js → isTitleRelevantToProfile)");

    const titlePassed = isTitleRelevantToProfile(normItem.title, titleVariants);

    inputBlock({
      "job title":     normItem.title,
      "profile targets (variants)": titleVariants,
    });

    // Show token breakdown
    const stopWords = new Set(["the","and","for","with","ing","a","an","of","in","at","by","to","or","senior","junior","staff","principal","lead","entry","level","mid","ii","iii","iv","i"]);
    const TYPO_MAP  = { "enginere":"engineer","enigneer":"engineer","sofware":"software","managr":"manager","analist":"analyst" };
    const tokenSets = titleVariants.map(t => ({
      target: t,
      tokens: t.toLowerCase().split(/[\s,/\-]+/).filter(w => w.length > 2 && !stopWords.has(w)).map(w => TYPO_MAP[w] || w),
    }));

    console.log(`\n  ${label("Token breakdown (AND match — all tokens must appear in job title):")}`);
    for (const { target, tokens } of tokenSets) {
      const titleLow = normItem.title.toLowerCase();
      const allMatch = tokens.every(tok => titleLow.includes(tok));
      const tokenInfo = tokens.map(tok => titleLow.includes(tok) ? `${C.green}✓${tok}${C.reset}` : `${C.red}✗${tok}${C.reset}`).join("  ");
      const result = allMatch ? `${C.green}✓ MATCHES${C.reset}` : `${C.gray}✗ no match${C.reset}`;
      console.log(`    ${label(target.padEnd(30))} tokens: [${tokenInfo}]  →  ${result}`);
    }

    outputBlock({ titleRelevant: titlePassed });

    if (!titlePassed) {
      verdict(false, "Job title does not match any profile target → job DROPPED here");
      pipelineDropped = true;
      droppedAt = "4b (title relevance)";
    } else {
      verdict(true, "Title matches profile targets — continues");
    }
  }

  // ════════════════════════════════════════════════════════════
  // STAGE 4c · Ghost job scoring
  // ════════════════════════════════════════════════════════════
  if (!pipelineDropped) {
    sectionHeader("4c", "Ghost Job Scoring  (jobNormalization.js → ghostJobScoreNorm + isReposted)");

    const jobForGhost = { ...normItem, url: normItem.applyUrl || normItem.url };
    const ghostScore  = ghostJobScoreNorm(jobForGhost);
    const reposted    = isReposted(normItem);
    const ghostDrop   = ghostScore >= 4;

    console.log(`\n  ${label("Scoring signals:")}`);
    const urlMissing  = !jobForGhost.url || jobForGhost.url === "#";
    const shortDesc   = (normItem.description || "").length < 150;
    const unknownCo   = !normItem.company || normItem.company === "Unknown";
    console.log(`    ${key("No/empty URL")}            ${urlMissing ? C.red+"+3"+C.reset : C.gray+"+0"+C.reset}  (${urlMissing ? "MISSING" : "ok"})`);
    console.log(`    ${key("Description < 150 chars")} ${shortDesc  ? C.red+"+2"+C.reset : C.gray+"+0"+C.reset}  (len=${(normItem.description || "").length})`);
    console.log(`    ${key("Unknown company")}          ${unknownCo  ? C.red+"+2"+C.reset : C.gray+"+0"+C.reset}  (company="${normItem.company}")`);
    console.log(`    ${key("'Reposted' in text")}       ${reposted   ? `${C.red}flag${C.reset}` : `${C.gray}no${C.reset}`}`);

    outputBlock({
      ghostScore,
      threshold: 4,
      reposted,
      willDrop: ghostDrop || reposted,
    });

    if (ghostDrop) {
      verdict(false, `Ghost score ${ghostScore} ≥ 4 → job DROPPED here`);
      pipelineDropped = true;
      droppedAt = `4c (ghost score = ${ghostScore})`;
    } else if (reposted) {
      verdict(false, "Reposted listing → job DROPPED here");
      pipelineDropped = true;
      droppedAt = "4c (reposted)";
    } else {
      verdict(true, `Ghost score ${ghostScore} < 4 — continues`);
    }
  }

  // ════════════════════════════════════════════════════════════
  // STAGE 4d · YOE eligibility filter
  // ════════════════════════════════════════════════════════════
  if (!pipelineDropped) {
    sectionHeader("4d", "Years-of-Experience Filter  (jobNormalization.js → parseYearsExperience)");

    const yoeParsed   = parseYearsExperience(normItem.description || "");
    const maxAllowed  = scenario.userYoe + 2;
    const yoeDrop     = yoeParsed.min != null && yoeParsed.min > maxAllowed;

    inputBlock({
      "description snippet":  (normItem.description || "").slice(0, 120) + "…",
      "user.yearsExperience": scenario.userYoe,
      "maxAllowed (user+2)":  maxAllowed,
    });

    outputBlock({
      "parsed.min":    yoeParsed.min,
      "parsed.max":    yoeParsed.max,
      "parsed.raw":    yoeParsed.raw,
      "will drop":     yoeDrop,
    });

    if (yoeDrop) {
      verdict(false, `Job requires ${yoeParsed.min} YOE, user has ${scenario.userYoe} (maxAllowed=${maxAllowed}) → job DROPPED`);
      pipelineDropped = true;
      droppedAt = `4d (YOE: job needs ${yoeParsed.min}, user has ${scenario.userYoe})`;
    } else {
      const msg = yoeParsed.min == null
        ? "No YOE requirement found — passes by default"
        : `Job needs ${yoeParsed.min} YOE, user has ${scenario.userYoe} (within +2 buffer)`;
      verdict(true, msg);
    }
  }

  // ════════════════════════════════════════════════════════════
  // STAGE 5 · Classification at ingest
  // ════════════════════════════════════════════════════════════
  if (!pipelineDropped) {
    sectionHeader("5", "Classification at Ingest  (jobClassifier.js → classifyForIngest)");

    const classResult = classifyForIngest(normItem.title, normItem.description || "");

    inputBlock({
      title: normItem.title,
      description: (normItem.description || "").slice(0, 100) + "…",
      "confidence threshold": INGEST_CONFIDENCE_THRESHOLD,
    });

    outputBlock(classResult
      ? {
          roleKey:    classResult.roleKey,
          confidence: classResult.confidence,
          matchedBy:  classResult.matchedBy,
          willAssign: classResult.confidence >= INGEST_CONFIDENCE_THRESHOLD,
        }
      : {
          roleKey:    "unclassified",
          confidence: 0,
          willAssign: false,
          note:       "Confidence below threshold — left unclassified (NOT silently forced to SWE)",
        }
    );

    if (!classResult) {
      verdict(false, "Confidence too low → stays UNCLASSIFIED (won't appear unless board has no role filter)");
    } else {
      verdict(true, `Assigned role_key="${classResult.roleKey}" with confidence ${(classResult.confidence * 100).toFixed(0)}%`);

      // ════════════════════════════════════════════════════════
      // STAGE 5.5 · DB Storage — what actually gets written
      // ════════════════════════════════════════════════════════
      sectionHeader("5.5", "DB Storage  (INSERT rows written to SQLite after ingest)");

      const yoeDb    = parseYearsExperience(normItem.description || "");
      const wtDb     = inferWorkType(
        (normItem.workTypeHint || "") + " " +
        (normItem.location     || "") + " " +
        (normItem.description  || "")
      );
      const ghostDb  = ghostJobScoreNorm({ ...normItem, url: normItem.applyUrl || normItem.url });

      // ── Table 1: scraped_jobs ────────────────────────────────
      console.log(`\n  ${C.bold}${C.white}TABLE 1 — scraped_jobs${C.reset}  ${C.dim}(one row per unique LinkedIn job ID)${C.reset}`);
      inputBlock({
        job_id:              normItem.jobId                                   + "  ← real LinkedIn job ID (PK, INSERT OR IGNORE)",
        search_query:        normalisedRole.toLowerCase()                     + "  ← normalised query string",
        company:             normItem.company,
        title:               normItem.title,
        category:            "(assigned by classifyJob — async LLM/rule call after ingest)",
        location:            normItem.location || "United States",
        work_type:           wtDb                                             + "  ← inferred from location + description text",
        source:              "LinkedIn",
        url:                 normItem.url        || null,
        apply_url:           normItem.applyUrl   || null,
        posted_at:           "(unix epoch — normalizePostedAt(listingDate))",
        description:         "(full text — " + (normItem.description || "").length + " chars)",
        description_html:    normItem.descriptionHtml ? "(HTML present)" : null,
        ghost_score:         ghostDb,
        min_years_exp:       yoeDb.min,
        max_years_exp:       yoeDb.max,
        exp_raw:             yoeDb.raw,
        is_frequent_repost:  isReposted(normItem) ? 1 : 0,
        _hash:               "(md5(company.lower + '|' + title.lower)  — content dedup key)",
        scraped_at:          "(unixepoch() — epoch seconds at insert time)",
        source_platform:     "linkedin",
        salary_min:          normItem.salaryMin      || null,
        salary_max:          normItem.salaryMax      || null,
        salary_currency:     normItem.salaryCurrency || null,
        applicant_count:     normItem.applicantCount || null,
        company_icon_url:    normItem.companyLogoUrl || null,
        employment_type:     normItem.jobType        || null,
        domain_profile_id:   "(domain_profiles.id — scopes job to the triggering profile)",
      }, "scraped_jobs INSERT values");

      // ── Table 2: job_role_map ────────────────────────────────
      console.log(`\n  ${C.bold}${C.white}TABLE 2 — job_role_map${C.reset}  ${C.dim}(drives triple-filter board query)${C.reset}`);
      inputBlock({
        job_id:            normItem.jobId,
        role_key:          classResult.roleKey                                + "  ← used in WHERE jrm.role_key = ?",
        role_family:       scenario.profile.role_family,
        domain:            scenario.profile.domain,
        source_profile_id: "(domain_profiles.id — which profile produced this mapping)",
        confidence:        classResult.confidence,
        matched_by:        "profile_scrape",
      }, "job_role_map INSERT values");
      console.log(`  ${C.dim}│${C.reset}  ${C.yellow}NOTE:${C.reset} ${C.dim}INSERT OR IGNORE — first-write wins; profile scrape takes precedence over orphan ingest classifier${C.reset}`);

      // ── Table 3: user_jobs ───────────────────────────────────
      console.log(`\n  ${C.bold}${C.white}TABLE 3 — user_jobs${C.reset}  ${C.dim}(user-scoped interaction state — created lazily)${C.reset}`);
      inputBlock({
        user_id:           "(users.id — the user who triggered /api/scrape)",
        job_id:            normItem.jobId,
        domain_profile_id: "(domain_profiles.id — per-profile isolation; no cross-profile bleed)",
        visited:           0,
        starred:           0,
        disliked:          0,
        applied:           0,
        resume_generated:  0,
        updated_at:        "(unixepoch() — set on first user action: visit, star, apply, etc.)",
      }, "user_jobs INSERT (on first board load / user interaction)");
      console.log(`  ${C.dim}│${C.reset}  ${C.yellow}NOTE:${C.reset} ${C.dim}Row created when user opens board (GET /api/jobs) or interacts with the job card${C.reset}`);
      console.log(`  ${C.dim}│${C.reset}  ${C.yellow}SSE: ${C.reset} ${C.dim}After background scrape finishes, emitToUser() fires "scrape_complete" → board auto-refreshes${C.reset}`);

      verdict(true, "3 tables written — job is now scoped to the profile and visible on the user's board");
    }
  }

  // ════════════════════════════════════════════════════════════
  // STAGE 6 · Profile title SQL builder
  // ════════════════════════════════════════════════════════════
  if (!pipelineDropped) {
    sectionHeader("6", "Profile Title SQL Builder  (profileTitleFilter.js → profileTitleSql)");
    console.log(`  ${label("(This runs at board-display time — GET /api/jobs — not at scrape time)")}`);

    const sqlResult = profileTitleSql("sj.title", scenario.profile);

    inputBlock({
      "profile.target_titles": JSON.parse(scenario.profile.target_titles),
    });

    outputBlock({
      "sql fragment":  sqlResult.sql,
      "bind params":   sqlResult.params,
    });

    verdict(true, "SQL fragment used to scope the board query to this profile's titles");
  }

} // end if rawJob


// ════════════════════════════════════════════════════════════
// STAGE 7 · Imported-job dedupe key  (LinkedIn extension path)
// ════════════════════════════════════════════════════════════
if (scenarioArg === "imported" && scenario.rawLinkedInJob) {
  sectionHeader("7", "LinkedIn Import — Normalise & Dedupe  (services/importedJobs.js)");

  const rawLI = scenario.rawLinkedInJob;

  inputBlock({
    externalJobId: rawLI.externalJobId,
    title:         rawLI.title,
    company:       rawLI.company,
    jobUrl:        rawLI.jobUrl,
    applyUrl:      rawLI.applyUrl,
    postedAt:      rawLI.postedAt,
    compensation:  rawLI.compensation,
    description:   (rawLI.description || "").slice(0, 80) + "…",
  }, "RAW LINKEDIN JOB (from extension scrape)");

  const dedupeKey   = importedJobDedupeKey("linkedin", rawLI);
  const normalisedLI = normaliseImportedJob("linkedin", rawLI);

  outputBlock({
    dedupeKey,
    "dedupeKey strategy": rawLI.externalJobId ? "externalJobId (highest priority)" :
                          rawLI.jobUrl         ? "canonicalUrl (fallback)" :
                                                 "SHA-256(title|company|loc)",
  }, "DEDUPE KEY");

  outputBlock(normalisedLI
    ? {
        title:          normalisedLI.title,
        company:        normalisedLI.company,
        location:       normalisedLI.location,
        jobUrl:         normalisedLI.jobUrl,
        applyUrl:       normalisedLI.applyUrl,
        workType:       normalisedLI.workType,
        employmentType: normalisedLI.employmentType,
        compensation:   normalisedLI.compensation,
        postedAt:       normalisedLI.postedAt,
        sourcePlatform: normalisedLI.sourcePlatform,
        externalJobId:  normalisedLI.externalJobId,
        dedupeKey:      normalisedLI.dedupeKey,
      }
    : null,
    "NORMALISED FOR DB INSERT"
  );

  verdict(normalisedLI !== null, normalisedLI ? "Valid job — ready for DB upsert" : "Missing title — REJECTED");
}


// ════════════════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════════════════
header("PIPELINE SUMMARY");

if (pipelineDropped) {
  console.log(`\n  ${FAIL}  ${C.red}${C.bold}Job was DROPPED${C.reset}`);
  console.log(`  ${label("Dropped at:")}  ${C.yellow}${droppedAt}${C.reset}`);
  console.log(`  ${label("Reason:")}      Job did not pass the filter at this stage.`);
  console.log(`  ${label("Expected?")}    ${C.dim}Check the scenario label: "${scenario.label}"${C.reset}\n`);
} else {
  console.log(`\n  ${PASS}  ${C.green}${C.bold}Job passed all pipeline filters${C.reset}`);
  console.log(`  ${label("Next steps:")}  INSERT into scraped_jobs → tag job_role_map → sync user_jobs → SSE push`);
  console.log(`  ${label("Board query:")} profileTitleSql() + roleTitleSql() + user board filters\n`);
}

console.log(`  ${label("Try other scenarios:")}`);
console.log(`  ${C.cyan}node scripts/tracePipeline.js --scenario datascientist${C.reset}   ${C.dim}← Data Scientist, full-time, 3–5 YOE (PASSES)${C.reset}`);
console.log(`  ${C.cyan}node scripts/tracePipeline.js --scenario contract${C.reset}         ${C.dim}← dropped at Stage 4a (employment type)${C.reset}`);
console.log(`  ${C.cyan}node scripts/tracePipeline.js --scenario ghost${C.reset}             ${C.dim}← dropped at Stage 4c (ghost score ≥ 4)${C.reset}`);
console.log(`  ${C.cyan}node scripts/tracePipeline.js --scenario yoe_drop${C.reset}          ${C.dim}← dropped at Stage 4d (10+ YOE required)${C.reset}`);
console.log(`  ${C.cyan}node scripts/tracePipeline.js --scenario firmware${C.reset}          ${C.dim}← firmware domain isolation test${C.reset}`);
console.log(`  ${C.cyan}node scripts/tracePipeline.js --scenario imported${C.reset}          ${C.dim}← LinkedIn extension import path${C.reset}`);
console.log(`  ${C.cyan}node scripts/tracePipeline.js --role "ML Engineer"${C.reset}         ${C.dim}← swap role on any scenario${C.reset}\n`);
