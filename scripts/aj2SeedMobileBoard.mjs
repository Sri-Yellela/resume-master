// Seed a small, clearly-labelled board so the Android client can be verified against a REAL
// authenticated request.
//
// WHY THIS EXISTS. The dev database holds 3 scraped_jobs, all is_active=0, so GET /api/jobs answers
// `reason: "cache_empty"` for every profile. That is a correct answer to an empty board and it
// verifies nothing about decoding salary, tiers, or bands.
//
// The five scores are chosen to sit exactly ON the band cutpoints rather than near them --
// 44/43 straddles Strong, 26/25 straddles Moderate, and one row scores NULL. A row that lands
// mid-band would pass whether the boundary were 44, 40 or 46; these rows only pass if the client
// implements the cutpoints the owner's graded 30 actually produced. This mirrors the technique
// scripts/ak2BandSurfaces.mjs uses for the desktop surfaces.
//
// Every row is prefixed `aj2fixture::` and is removable with --clean.

import Database from "better-sqlite3";

const db = new Database("data/resume_master.db");
const PREFIX = "aj2fixture::";

if (process.argv.includes("--clean")) {
  db.prepare(`DELETE FROM job_role_map WHERE job_id LIKE ?`).run(`${PREFIX}%`);
  const n = db.prepare(`DELETE FROM scraped_jobs WHERE job_id LIKE ?`).run(`${PREFIX}%`).changes;
  console.log(`removed ${n} fixture rows`);
  process.exit(0);
}

const profileId = Number(process.argv[process.argv.indexOf("--profile") + 1] || 5);
const now = Math.floor(Date.now() / 1000);

// score, tier, remote-ness and salary all vary INDEPENDENTLY, so a client that happens to couple
// two of them (e.g. renders "Desktop only" off the score) fails on at least one row.
const ROWS = [
  {
    id: "strong-boundary", title: "Senior Software Engineer, Backend", company: "Stripe",
    location: "New York, NY", ats: 44, tier: "direct", workplace: "hybrid",
    min: 180000, max: 240000, employment: "full_time", level: "senior",
    skills: ["Kotlin", "Go", "Postgres"],
  },
  {
    id: "moderate-upper", title: "Software Engineer, Payments", company: "Block",
    location: "Remote", ats: 43, tier: "guest", workplace: "remote",
    min: 150000, max: 195000, employment: "full_time", level: "mid",
    skills: ["Java", "Kafka"],
  },
  {
    id: "moderate-lower", title: "Software Engineer, Platform", company: "Datadog",
    location: "Boston, MA", ats: 26, tier: "gated", workplace: "onsite",
    min: 140000, max: 180000, employment: "full_time", level: "mid",
    skills: ["Terraform"],
  },
  {
    id: "weak-boundary", title: "Software Engineer, Internal Tools", company: "Figma",
    location: "San Francisco, CA", ats: 25, tier: "account", workplace: "hybrid",
    min: null, max: null, employment: "full_time", level: "senior",
    skills: [],
  },
  {
    // The scorer DECLINED. This must render as its own band, never as a low score.
    id: "no-signal", title: "Software Engineer, Research", company: "Physical Superintelligence",
    location: "Remote", ats: null, tier: null, workplace: "remote",
    min: null, max: 210000, employment: "contract", level: null,
    skills: ["Research"],
  },
];

const insert = db.prepare(`
  INSERT OR REPLACE INTO scraped_jobs (
    job_id, _hash, company, title, location, url, apply_url, source, source_platform, source_label,
    salary_min, salary_max, salary_currency, employment_type, workplace_type, experience_level,
    ats_score, automation_tier, direct_apply, is_active, discovered_at, scraped_at, posted_at,
    domain_profile_id, skills_json, description, summary, bucket_role, bucket_seniority,
    bucket_domain, work_type, category, search_query
  ) VALUES (
    @job_id, @job_id, @company, @title, @location, @url, @apply_url, 'scraped_jobs', @platform, @platform,
    @salary_min, @salary_max, @currency, @employment, @workplace, @level,
    @ats, @tier, @direct_apply, 1, @now, @now, @posted,
    @profile, @skills, @description, @summary, 'backend', @level,
    'engineering', @workplace, 'engineering', 'backend engineer'
  )
`);

const mapRole = db.prepare(`
  INSERT OR REPLACE INTO job_role_map (job_id, role_key, role_family, domain, source_profile_id, confidence, matched_by, created_at)
  VALUES (@job_id, @role_key, @role_key, 'engineering', @profile, 1.0, 'aj2_fixture', @now)
`);

const roleKey = (db.prepare(
  `SELECT LOWER(COALESCE(NULLIF(role_family, ''), domain)) AS k FROM domain_profiles WHERE id = ?`
).get(profileId)?.k) || "engineering";

let n = 0;
for (const r of ROWS) {
  insert.run({
    job_id: PREFIX + r.id,
    company: r.company,
    title: r.title,
    location: r.location,
    url: `https://example.invalid/${r.id}`,
    apply_url: `https://example.invalid/${r.id}/apply`,
    platform: "greenhouse",
    salary_min: r.min,
    salary_max: r.max,
    currency: r.min || r.max ? "USD" : null,
    employment: r.employment,
    workplace: r.workplace,
    level: r.level,
    ats: r.ats,
    tier: r.tier,
    direct_apply: r.tier === "direct" ? 1 : 0,
    now,
    posted: new Date(now * 1000).toISOString().slice(0, 10),
    profile: profileId,
    skills: JSON.stringify(r.skills),
    description: `Fixture row for mobile verification. Band boundary case: ats_score=${r.ats}.`,
    summary: `${r.title} at ${r.company}.`,
  });
  mapRole.run({ job_id: PREFIX + r.id, role_key: roleKey, profile: profileId, now });
  n++;
}

console.log(`seeded ${n} fixture rows on domain_profile_id=${profileId}, role_key=${roleKey}`);
for (const r of db.prepare(
  `SELECT job_id, ats_score, automation_tier, is_active FROM scraped_jobs WHERE job_id LIKE ? ORDER BY ats_score DESC`
).all(`${PREFIX}%`)) {
  console.log(" ", r.job_id, "ats=" + r.ats_score, "tier=" + r.automation_tier, "active=" + r.is_active);
}
