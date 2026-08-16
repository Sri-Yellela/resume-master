import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { upsertCanonicalJob, reconcileFingerprint } from "../services/jobs/aggregator.js";

// TASK 2 requirements 4 and 5, previously unverified because a live Jobo sync was blocked by
// HTTP 402. Both are testable without the network.

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
      is_clearance_required INTEGER, discovered_at INTEGER, updated_at INTEGER,
      is_active INTEGER DEFAULT 1, fingerprint TEXT, sources_seen TEXT, req_uid TEXT,
      -- migration 078: this fixture hand-rolls the schema, so it has to track the real one or
      -- the aggregator's upsert fails against it (which is how this column's absence surfaced).
      automation_tier TEXT
    );
    CREATE TABLE job_role_map (
      job_id TEXT PRIMARY KEY, role_key TEXT, role_family TEXT, domain TEXT,
      confidence REAL, matched_by TEXT
    );
    -- getCacheStmts prepares every statement up front, including the blue-collar reject path,
    -- so this table must exist even though these tests never write to it.
    CREATE TABLE rejected_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT, source TEXT,
      reason TEXT, rejected_at INTEGER
    );
  `);
  return db;
}

const VERDICT = { roleKey: "engineering", seniority: "mid", domain: "software", collar: "white", confidence: 0.9 };

function write(db, { jobId, source, title, company, location, url, now }) {
  const canonical = {
    title, company, location, url, source, description: "text", direct_apply: true,
    posted_at: null, source_label: source,
  };
  const dedup = reconcileFingerprint(db, { ...canonical, id: jobId, company_icon_url: null });
  if (dedup.action !== "insert_canonical") return { folded: true, into: dedup.intoJobId };
  upsertCanonicalJob(db, {
    jobId, canonical: dedup.job, verdict: VERDICT, contentHash: "h_" + jobId,
    searchQuery: source, sourceLabel: source, matchedBy: source, dedup, now,
  });
  return { folded: false, into: jobId };
}

test("a direct-ATS row outranks a Jobo duplicate of the same posting", () => {
  // Priority is direct ATS (3) > provider/jobo (2) > aggregator (1). A Jobo copy of a posting
  // already held from the company's own board must fold in, not create a second board row.
  const db = db0();
  const now = Math.floor(Date.now() / 1000);
  const job = { title: "Backend Engineer", company: "Acme", location: "Remote" };

  write(db, { jobId: "greenhouse::1", source: "greenhouse", url: "https://boards.greenhouse.io/acme/jobs/1", now, ...job });
  const second = write(db, { jobId: "jobo::abc", source: "jobo", url: "https://jobo.example/abc", now, ...job });

  assert.ok(second.folded, "the Jobo duplicate must fold into the existing ATS row");
  assert.equal(second.into, "greenhouse::1", "the ATS row stays canonical");
  const rows = db.prepare("SELECT job_id, source FROM scraped_jobs WHERE is_active = 1").all();
  assert.equal(rows.length, 1, "one canonical board row, not two");
  assert.equal(rows[0].source, "greenhouse");
});

test("re-upserting a changed posting preserves the ORIGINAL discovered_at", () => {
  // INSERT OR REPLACE was resetting discovered_at to now, so an employer editing a description
  // re-flagged a long-known job as NEW<24h and made source freshness track churn rather than
  // whether the source is still being crawled.
  const db = db0();
  const first = 1_700_000_000;
  write(db, { jobId: "greenhouse::1", source: "greenhouse", title: "Eng", company: "Acme",
              location: "Remote", url: "https://boards.greenhouse.io/acme/jobs/1", now: first });
  assert.equal(db.prepare("SELECT discovered_at d FROM scraped_jobs WHERE job_id='greenhouse::1'").get().d, first);

  const later = first + 10 * 86400;
  write(db, { jobId: "greenhouse::1", source: "greenhouse", title: "Eng II", company: "Acme",
              location: "Remote", url: "https://boards.greenhouse.io/acme/jobs/1", now: later });

  const row = db.prepare("SELECT discovered_at, updated_at, title FROM scraped_jobs WHERE job_id='greenhouse::1'").get();
  assert.equal(row.title, "Eng II", "the change itself must still be written");
  assert.equal(row.discovered_at, first, "first-seen must survive a re-crawl of changed content");
  assert.equal(row.updated_at, later, "updated_at is what should move");
});

test("the Jobo expiry statement deactivates only Jobo-owned rows", () => {
  // aggregator.js's expireJoboRow carries an explicit source='jobo' guard so an expiry id that
  // collides with a row now canonically owned by an ATS source cannot deactivate it.
  const db = db0();
  const now = Math.floor(Date.now() / 1000);
  write(db, { jobId: "jobo::gone", source: "jobo", title: "Old Role", company: "A",
              location: "NY", url: "https://jobo.example/gone", now });
  write(db, { jobId: "greenhouse::keep", source: "greenhouse", title: "Live Role", company: "B",
              location: "SF", url: "https://boards.greenhouse.io/b/jobs/9", now });

  const expire = db.prepare(`UPDATE scraped_jobs SET is_active = 0
                             WHERE job_id = ? AND source = 'jobo' AND is_active = 1`);

  assert.equal(expire.run("jobo::gone").changes, 1, "a Jobo row expires");
  assert.equal(expire.run("greenhouse::keep").changes, 0, "a non-Jobo row is never touched");
  assert.equal(expire.run("jobo::gone").changes, 0, "already-inactive rows are not re-counted");

  assert.equal(db.prepare("SELECT is_active FROM scraped_jobs WHERE job_id='jobo::gone'").get().is_active, 0);
  assert.equal(db.prepare("SELECT is_active FROM scraped_jobs WHERE job_id='greenhouse::keep'").get().is_active, 1);
});
