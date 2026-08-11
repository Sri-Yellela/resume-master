import test from "node:test";
import assert from "node:assert/strict";
import { normalizeJoboJob } from "../services/jobs/sources/jobo.js";
import { decideJoboBackfillMode } from "../services/jobs/aggregator.js";

test("normalizeJoboJob maps common field names into normalizeJob's shape", () => {
  const raw = {
    id: "req-123",
    title: "Senior Backend Engineer",
    company: "Acme Corp",
    location: "Austin, TX",
    url: "https://jobs.acme.example/req-123",
    description: "Build things.",
    is_remote: true,
    posted_at: "2026-07-01T00:00:00Z",
  };
  const job = normalizeJoboJob(raw);
  assert.equal(job.source, "jobo");
  assert.equal(job.req_id, "req-123");
  assert.equal(job.id, "jobo::req-123");
  assert.equal(job.title, "Senior Backend Engineer");
  assert.equal(job.company, "Acme Corp");
  assert.equal(job.workplace_type, "remote");
});

test("normalizeJoboJob accepts the alternate key-name variants it guards against", () => {
  const raw = {
    job_id: "req-456",
    job_title: "Data Scientist",
    company_name: "Widgets Inc",
    application_url: "https://jobs.widgets.example/456",
    is_hybrid: true,
  };
  const job = normalizeJoboJob(raw);
  assert.equal(job.req_id, "req-456");
  assert.equal(job.title, "Data Scientist");
  assert.equal(job.company, "Widgets Inc");
  assert.equal(job.workplace_type, "hybrid");
});

test("normalizeJoboJob throws when a required field is missing under every guessed key name", () => {
  const raw = { id: "req-789", someOtherField: "noise" };
  assert.throws(() => normalizeJoboJob(raw), /required/);
});

// Regression: confirmed against a live /api/jobs/feed response via scripts/joboSyncSmokeTest.js
// — Jobo's real shape nests company under an object and location under a `locations` array,
// not the flat strings the original pick(...) guesses assumed. Before this fix, company
// round-tripped as the literal string "[object Object]" (schema.js's normalizeJob does
// String(company)) and location fell through to normalizeJob's 'Location not specified'
// default despite a real location being present in the response.
test("normalizeJoboJob extracts company.name and locations[0] from Jobo's real (nested) shape", () => {
  const raw = {
    id: "req-real-shape",
    title: "Staff Engineer",
    company: { id: "co-1", name: "Real Company Inc", website: "https://real.example" },
    locations: [{ location: "Austin HQ", city: "Austin", region: "Texas", country: "United States" }],
    apply_url: "https://jobs.real.example/req-real-shape/application",
    is_work_auth_required: true,
  };
  const job = normalizeJoboJob(raw);
  assert.equal(job.company, "Real Company Inc", "must extract company.name, not String(company object)");
  assert.equal(job.location, "Austin HQ", "must extract locations[0].location, not fall through to the default");
  assert.equal(job.requires_work_auth, 1, "must read is_work_auth_required (Jobo's real key), not a guessed-wrong requires_work_auth");
});

test("normalizeJoboJob falls back to locations[0]'s city/region/country when no `location` label is given", () => {
  const raw = {
    id: "req-no-label",
    title: "Staff Engineer",
    company: { name: "Real Company Inc" },
    locations: [{ city: "Austin", region: "Texas", country: "United States" }],
    apply_url: "https://jobs.real.example/req-no-label/application",
  };
  const job = normalizeJoboJob(raw);
  assert.equal(job.location, "Austin, Texas, United States");
});

test("decideJoboBackfillMode defaults to bounded with no saved cursor and no full-backfill env", () => {
  assert.deepEqual(
    decideJoboBackfillMode({ cursor: null, fullBackfillEnv: undefined }),
    { mode: "bounded" }
  );
});

test("decideJoboBackfillMode runs the full stable_scan backfill when JOBO_FULL_BACKFILL=1", () => {
  assert.deepEqual(
    decideJoboBackfillMode({ cursor: null, fullBackfillEnv: "1" }),
    { mode: "full", resumeCursor: null }
  );
});

test("decideJoboBackfillMode resumes an in-progress full backfill regardless of the CURRENT env value", () => {
  assert.deepEqual(
    decideJoboBackfillMode({ cursor: "saved-cursor", fullBackfillEnv: undefined }),
    { mode: "full", resumeCursor: "saved-cursor" }
  );
  assert.deepEqual(
    decideJoboBackfillMode({ cursor: "saved-cursor", fullBackfillEnv: "0" }),
    { mode: "full", resumeCursor: "saved-cursor" }
  );
});

// ── Real-shape regressions ────────────────────────────────────────────────────
// Every assertion below is pinned to a LIVE response from POST /api/jobs/feed, not to a
// guessed key name. This adapter's original mapping was written against Jobo's envelope docs,
// which do not document per-job field names, so several fields were read from keys that simply
// do not exist and silently produced null forever (the same class as the company/location bug
// fixed in 7ff3174). Confirmed present in the real payload:
//   id,title,normalized_title,company,description,summary,listing_url,apply_url,locations,
//   compensation,employment_type,workplace_type,experience_level,source,created_at,updated_at,
//   date_posted,valid_through,qualifications,responsibilities,benefits,is_work_auth_required,
//   is_h1b_sponsor,is_clearance_required
function realShapeJob(overrides = {}) {
  return {
    id: "5e0a1f2c-0000-4000-8000-000000000000",
    title: "Electrical Systems Engineer",
    company: { id: "c1", name: "Epia Neuro", website: "https://epia.example" },
    locations: [{ location: "Alameda HQ", city: "Alameda", region: "CA", country: "US" }],
    listing_url: "https://jobs.example/5e0a1f2c",
    description: "Design embedded hardware.",
    workplace_type: "On-site",
    experience_level: "Mid Level",
    employment_type: "Full-time",
    compensation: { min: 150000, max: 200000, currency: "USD", period: "year" },
    created_at: "2026-04-29T05:00:03.198870Z",
    updated_at: "2026-07-27T18:22:19.516253Z",
    date_posted: "2026-04-17T01:02:38.319Z",
    qualifications: {
      must_have: {
        education: ["BS in Electrical Engineering"],
        certifications: [],
        skills: [{ name: "Embedded hardware design", type: "hard" }, { name: "C/C++", type: "hard" }],
      },
      nice_to_have: { skills: [{ name: "Mentoring", type: "soft" }] },
    },
    ...overrides,
  };
}

test("normalizeJoboJob reads workplace_type from the real top-level string, not is_remote/is_hybrid", () => {
  // is_remote / is_hybrid do not exist in the response, so workplace_type was ALWAYS null.
  assert.equal(normalizeJoboJob(realShapeJob()).workplace_type, "onsite");
  assert.equal(normalizeJoboJob(realShapeJob({ workplace_type: "Hybrid" })).workplace_type, "hybrid");
  assert.equal(normalizeJoboJob(realShapeJob({ workplace_type: "Remote" })).workplace_type, "remote");
});

test("normalizeJoboJob maps Jobo's experience_level wording onto the schema enum", () => {
  // Jobo sends "Mid Level"/"Entry Level"/"Senior"/"Lead". schema.js only accepts its own
  // lowercase enum, so the raw value was rejected and the level silently re-guessed from the
  // title instead of using what the posting explicitly stated.
  assert.equal(normalizeJoboJob(realShapeJob()).experience_level, "mid");
  assert.equal(normalizeJoboJob(realShapeJob({ experience_level: "Entry Level" })).experience_level, "entry");
  assert.equal(normalizeJoboJob(realShapeJob({ experience_level: "Senior" })).experience_level, "senior");
  assert.equal(normalizeJoboJob(realShapeJob({ experience_level: "Lead" })).experience_level, "lead");
});

test("normalizeJoboJob reads the nested compensation object, not flat salary_* keys", () => {
  // salary_min/salary_max/salary_currency do not exist at the top level, so salary was
  // ALWAYS null for every Jobo row.
  const job = normalizeJoboJob(realShapeJob());
  assert.equal(job.salary_min, 150000);
  assert.equal(job.salary_max, 200000);
  assert.equal(job.salary_currency, "USD");
  assert.equal(job.salary_period, "annual", "'year' must canonicalise to the schema's 'annual'");
  assert.equal(job.salary_max_usd, 200000, "a USD range should populate the USD columns");
});

test("normalizeJoboJob prefers date_posted over created_at for posted_at", () => {
  // created_at is when JOBO ingested the job; date_posted is when the employer posted it.
  // Reading created_at overstated freshness -- on live data, created_at was 2026-04-29 for
  // roles actually posted 2026-04-01..04-28.
  assert.equal(normalizeJoboJob(realShapeJob()).posted_at, "2026-04-17T01:02:38.319Z");
  // Falls back only when date_posted is genuinely absent.
  const noDatePosted = realShapeJob();
  delete noDatePosted.date_posted;
  assert.equal(normalizeJoboJob(noDatePosted).posted_at, "2026-04-29T05:00:03.198870Z");
});

test("normalizeJoboJob harvests skills from structured qualifications", () => {
  // job.skills / job.tags do not exist, so skills_json was always null. Jobo's
  // qualifications.{must_have,nice_to_have}.skills entries are already the hard/soft split
  // enrichJob.js pays an LLM to produce, and are emitted in its { skill, type } shape.
  const skills = JSON.parse(normalizeJoboJob(realShapeJob()).skills_json);
  assert.deepEqual(skills, [
    { skill: "Embedded hardware design", type: "hard" },
    { skill: "C/C++", type: "hard" },
    { skill: "Mentoring", type: "soft" },
  ]);
});

test("normalizeJoboJob de-duplicates a skill listed in both must_have and nice_to_have", () => {
  const job = realShapeJob({
    qualifications: {
      must_have:     { skills: [{ name: "Python", type: "hard" }] },
      nice_to_have:  { skills: [{ name: "python", type: "hard" }] },
    },
  });
  assert.deepEqual(JSON.parse(normalizeJoboJob(job).skills_json), [{ skill: "Python", type: "hard" }]);
});

test("normalizeJoboJob leaves skills null when qualifications carry none", () => {
  const job = realShapeJob({ qualifications: { must_have: { education: [], certifications: [] } } });
  assert.equal(normalizeJoboJob(job).skills_json, null, "no skills must stay null, not an empty array");
});
