import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { upsertCanonicalJob, reconcileFingerprint, fingerprintJob } from "../services/jobs/aggregator.js";
import { normalizeJob } from "../services/jobs/schema.js";

// upsertCanonicalJob used INSERT OR REPLACE, which deletes the row and inserts a new one — so every
// column absent from its list reverted to NULL. That silently discarded everything enrichment owns:
// content_hash and enriched_at were reset (the row then looked unenriched and was re-sent to the
// model), and skills_json / summary / the eligibility flags were overwritten with the source's
// nulls. Measured: a forced re-import of an UNCHANGED board re-enriched all 35 rows and paid to
// rebuild data it had just thrown away.
//
// These pin the replacement upsert's precedence rules.

function db0() {
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
      discovered_at INTEGER, updated_at INTEGER,
      is_active INTEGER DEFAULT 1, fingerprint TEXT, sources_seen TEXT, req_uid TEXT,
      -- migration 078: this fixture hand-rolls the schema, so it has to track the real one or
      -- the aggregator's upsert fails against it (which is how this column's absence surfaced).
      automation_tier TEXT,
      -- Source-owned column now written by aggregator's upsertStmt (six sources parse an
      -- employment type; none of it was persisted before). Hand-rolled fixtures have to track the
      -- real schema or the upsert fails against them — the same way automation_tier surfaced.
      employment_type TEXT
    );
    CREATE TABLE job_role_map (
      job_id TEXT PRIMARY KEY,
      role_key TEXT, role_family TEXT, domain TEXT, confidence REAL, matched_by TEXT,
      source_profile_id INTEGER, -- upsertCanonicalJob retires superseded classifier buckets by this column
      FOREIGN KEY (job_id) REFERENCES scraped_jobs(job_id) ON DELETE CASCADE
    );
    CREATE TABLE rejected_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT, source TEXT,
      reason TEXT, rejected_at INTEGER
    );
  `);
  db.pragma("foreign_keys = ON");   // the cascade REPLACE used to fire is real; keep it enabled
  return db;
}

const VERDICT = { roleKey: "engineering", seniority: "mid", domain: "software", collar: "white", confidence: 0.9 };

/** One crawl of a posting, through the real aggregator path. */
function crawl(db, over = {}) {
  const canonical = normalizeJob({
    id: "j1", title: "Backend Engineer", company: "Acme", location: "Remote",
    url: "https://example.test/j1", source: "greenhouse",
    description: "Build things.", ...over,
  });
  const dedup = reconcileFingerprint(db, { ...canonical, company_icon_url: null });
  upsertCanonicalJob(db, {
    jobId: canonical.id, canonical, verdict: VERDICT, dedup,
    now: Math.floor(Date.now() / 1000), contentHash: fingerprintJob(canonical),
    searchQuery: "test", sourceLabel: "Greenhouse", matchedBy: "test",
  });
  return db.prepare("SELECT * FROM scraped_jobs WHERE job_id = 'greenhouse::j1'").get();
}

/** What enrichJob writes after a successful pass. */
function enrich(db, over = {}) {
  db.prepare(`
    UPDATE scraped_jobs SET
      summary = @summary, normalized_title = @normalized_title, experience_level = @experience_level,
      workplace_type = @workplace_type, skills_json = @skills_json, is_h1b_sponsor = @is_h1b_sponsor,
      requires_work_auth = @requires_work_auth, org_unit_raw = @org_unit_raw,
      content_hash = @content_hash, enriched_at = @enriched_at
    WHERE job_id = 'greenhouse::j1'
  `).run({
    summary: "A model-written summary.", normalized_title: "backend engineer",
    experience_level: "senior", workplace_type: "remote",
    skills_json: JSON.stringify([{ skill: "go", type: "hard" }]),
    is_h1b_sponsor: 1, requires_work_auth: 0, org_unit_raw: "Platform",
    content_hash: "hash-of-original-description", enriched_at: 1700000000, ...over,
  });
}

test("a re-crawl of an unchanged posting keeps every enriched field", () => {
  const db = db0();
  try {
    crawl(db);
    enrich(db);
    const row = crawl(db);   // same posting, crawled again

    assert.equal(row.skills_json, JSON.stringify([{ skill: "go", type: "hard" }]),
      "skills were being replaced with the source's null");
    assert.equal(row.summary, "A model-written summary.");
    assert.equal(row.experience_level, "senior");
    assert.equal(row.is_h1b_sponsor, 1);
    assert.equal(row.requires_work_auth, 0, "0 is a real answer and must survive a re-crawl");
    assert.equal(row.org_unit_raw, "Platform");
  } finally { db.close(); }
});

test("enrichment bookkeeping survives, so an unchanged posting is not re-sent to the model", () => {
  // This is the one that cost money: content_hash and enriched_at reset to NULL, so every forced
  // re-import made the whole board look unenriched.
  const db = db0();
  try {
    crawl(db);
    enrich(db);
    const row = crawl(db);
    assert.equal(row.content_hash, "hash-of-original-description");
    assert.equal(row.enriched_at, 1700000000);
  } finally { db.close(); }
});

test("a changed description still updates, and leaves content_hash stale so enrichment re-runs", () => {
  const db = db0();
  try {
    crawl(db);
    enrich(db);
    const row = crawl(db, { description: "Completely different responsibilities now." });

    assert.equal(row.description, "Completely different responsibilities now.",
      "the source still owns the description");
    // Preserved bookkeeping is what makes the staleness detectable: enrichJob compares a hash of
    // the CURRENT title+description against content_hash, so a changed posting still re-enriches.
    assert.equal(row.content_hash, "hash-of-original-description");
  } finally { db.close(); }
});

test("a source range overwrites an extracted one, but a source without a range erases nothing", () => {
  const db = db0();
  try {
    crawl(db);
    db.prepare("UPDATE scraped_jobs SET salary_min_usd = 100000, salary_max_usd = 120000 WHERE job_id='greenhouse::j1'").run();

    // Crawl with no pay in the payload — the extracted figure must survive.
    let row = crawl(db);
    assert.equal(row.salary_min_usd, 100000, "a source with no range must not erase a known figure");

    // Crawl with a structured range — the ATS's own number wins.
    row = crawl(db, { salary_min: 152800, salary_max: 296000, salary_currency: "USD" });
    assert.equal(row.salary_min_usd, 152800, "a structured range beats an extracted one");
    assert.equal(row.salary_currency, "USD");
  } finally { db.close(); }
});

test("the first insert is unaffected — source values land normally", () => {
  const db = db0();
  try {
    const row = crawl(db, { description: "Build things." });
    assert.equal(row.title, "Backend Engineer");
    assert.equal(row.description, "Build things.");
    assert.equal(row.summary, "Build things.", "normalizeJob's summary is the fallback on insert");
    assert.equal(row.content_hash, null, "not enriched yet");
    assert.equal(row.enriched_at, null);
  } finally { db.close(); }
});

test("a re-crawl no longer deletes the row, so job_role_map's cascade never fires", () => {
  const db = db0();
  try {
    crawl(db);
    db.prepare("UPDATE job_role_map SET matched_by = 'first-pass' WHERE job_id='greenhouse::j1'").run();
    crawl(db);
    const n = db.prepare("SELECT COUNT(*) n FROM job_role_map WHERE job_id='greenhouse::j1'").get().n;
    assert.equal(n, 1, "the role map row should be updated in place, not cascade-deleted and rebuilt");
  } finally { db.close(); }
});
