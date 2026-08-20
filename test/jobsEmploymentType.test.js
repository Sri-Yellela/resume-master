// The Employment Type filter queried a column nothing could write.
//
// Six of the nine sources already parsed an employment/contract type (adzuna, jobo, recruitee,
// smartrecruiters, workable, workday) — and aggregator's upsertStmt, the single writer shared by
// cacheJobs(), cacheJoboFeed() and importJob.js, had no employment_type column. So the value was
// extracted on every crawl and thrown away, sj.employment_type was NULL on 100% of rows, and the
// drawer's four Employment Type pills filtered a column that could never hold anything. Combined
// with the hard `sj.employment_type = ?` this handler used, selecting any pill took the board to
// exactly zero rows.
//
// Each source also spells the value differently ("Full time" from workday's timeType, a
// typeOfEmployment.id from smartrecruiters, adzuna's own full_time), so persisting the raw value
// would have produced a column that still matched none of the board's own vocabulary.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { normalizeEmploymentType, normalizeJob } from "../services/jobs/schema.js";
import { upsertCanonicalJob, fingerprintJob } from "../services/jobs/aggregator.js";

test("source spellings fold onto the vocabulary the client already sends", () => {
  // The board sends full-time | part-time | contract | internship (JobsPanel's EMP_TYPE_OPTIONS),
  // and saved searches already store those strings, so that is the canonical form.
  const cases = {
    "Full time": "full-time", "full_time": "full-time", "FULLTIME": "full-time",
    "Permanent": "full-time", "PERMANENT_EMPLOYEE": "full-time", "regular": "full-time",
    "Part time": "part-time", "part_time": "part-time", "PT": "part-time",
    "Contract": "contract", "contractor": "contract", "Fixed-term": "contract",
    "freelance": "contract", "Temporary": "contract", "seasonal": "contract",
    "Internship": "internship", "intern": "internship", "Trainee": "internship",
    "apprenticeship": "internship", "co-op": "internship",
  };
  for (const [raw, want] of Object.entries(cases)) {
    assert.equal(normalizeEmploymentType(raw), want, `${raw} -> ${want}`);
  }
});

test("an unrecognised or empty value returns null rather than a guess", () => {
  // null is meaningful: the filter is soft-null, so the row stays visible. Guessing would hide a
  // posting under a label its source never gave it.
  for (const raw of [null, undefined, "", "   ", "Voluntary", "W2", "banana", 42]) {
    assert.equal(normalizeEmploymentType(raw), null, `${JSON.stringify(raw)} must not be guessed`);
  }
});

test("the value every source already parsed is now actually persisted", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, search_query TEXT, _hash TEXT, title TEXT, company TEXT,
      location TEXT, url TEXT, source TEXT, source_label TEXT, posted_at TEXT, scraped_at INTEGER,
      bucket_role TEXT, bucket_seniority TEXT, bucket_domain TEXT, direct_apply INTEGER,
      description TEXT, company_icon_url TEXT, via TEXT, collar TEXT,
      classification_confidence REAL, normalized_title TEXT, summary TEXT, experience_level TEXT,
      workplace_type TEXT, valid_through INTEGER, salary_min_usd INTEGER, salary_max_usd INTEGER,
      salary_period TEXT, salary_min INTEGER, salary_max INTEGER, salary_currency TEXT,
      skills_json TEXT, is_h1b_sponsor INTEGER, requires_work_auth INTEGER,
      is_clearance_required INTEGER, org_unit_raw TEXT, content_hash TEXT, enriched_at INTEGER,
      discovered_at INTEGER, updated_at INTEGER, is_active INTEGER DEFAULT 1, fingerprint TEXT,
      sources_seen TEXT, req_uid TEXT, automation_tier TEXT, employment_type TEXT
    );
    CREATE TABLE job_role_map (
      job_id TEXT NOT NULL, role_key TEXT NOT NULL, role_family TEXT, domain TEXT,
      source_profile_id INTEGER, confidence REAL, matched_by TEXT, PRIMARY KEY (job_id, role_key)
    );
    CREATE TABLE rejected_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT, source TEXT, reason TEXT, rejected_at INTEGER
    );
  `);
  const write = (jobId, contractType) => {
    const canonical = normalizeJob({
      id: jobId, title: "Backend Engineer", company: "Acme", location: "Remote",
      url: `https://example.test/${jobId}`, source: "workday",
      description: "Build things.", contract_type: contractType,
    });
    upsertCanonicalJob(db, {
      jobId, canonical,
      verdict: { roleKey: "engineering", domain: "general", confidence: 0.9, collar: "white" },
      dedup: { sourcesSeen: "workday", reqUid: null }, now: 1_787_000_000,
      contentHash: fingerprintJob(canonical), searchQuery: "crawl",
      sourceLabel: "Workday", matchedBy: "crawl",
    });
    return db.prepare("SELECT employment_type FROM scraped_jobs WHERE job_id = ?").get(jobId).employment_type;
  };

  // workday's own spelling, straight through the real writer.
  assert.equal(write("j-ft", "Full time"), "full-time");
  assert.equal(write("j-ct", "Contract"), "contract");
  // Unparseable stays null, and the row is still written rather than rejected.
  assert.equal(write("j-unknown", "Voluntary"), null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM scraped_jobs").get().n, 3);

  // A later crawl reflecting an employer's change must win — it is a source column, not an
  // enrichment one, so it is assigned from `excluded` rather than COALESCEd.
  assert.equal(write("j-ft", "Contract"), "contract");
});

test("the board filters it soft-null, so unparsed rows are never hidden", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /AND \(sj\.employment_type IS NULL OR sj\.employment_type IN \(/);
  // And as an IN list, because buildParams sends a comma-joined multi-select.
  assert.match(server, /const etValues = String\(employmentType\)\.split\(','\)/);
});

test("the four dead controls are gone and the surviving ones are the populated ones", () => {
  const panel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  const jsx = panel.replace(/\{\/\*[\s\S]*?\*\/\}/g, ""); // drop the notes explaining the removals

  // Removed: every one of these filtered a column absent from aggregator's upsertStmt, except the
  // legacy Source select, whose two options were values no writer produces.
  for (const label of ["Work Type", "Category", "Max Applicants", "Years of Experience"]) {
    assert.ok(!jsx.includes(`>${label}<`), `${label} is a control that cannot affect the result set`);
  }
  assert.ok(!/<option value="indeed">/.test(jsx), "the legacy Source select offered unreachable values");

  // Kept, because every one of these columns IS written and the filters discriminate on real data.
  for (const label of ["Employment Type", "Work Model", "Experience Level", "Provider",
                       "Automation Tier", "Date Posted"]) {
    assert.ok(jsx.includes(`>${label}<`), `${label} filters a populated column and must stay`);
  }
});
