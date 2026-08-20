import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { upsertCanonicalJob, reconcileFingerprint, fingerprintJob } from "../services/jobs/aggregator.js";
import { normalizeJob } from "../services/jobs/schema.js";

// The aggregator persisted salary_min_usd/max_usd/period but not salary_min/max/currency, even
// though the columns exist, jobQuery selects them and mapJobRow exposes them as
// salaryMin/salaryMax/salaryCurrency. normalizeJob only derives the _usd pair when the currency IS
// USD — so for a GBP or EUR posting those three columns were the only record of the figure, and
// dropping them on write discarded the salary outright. USD postings hid the bug: their _usd pair
// was populated, so the board looked fine.

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
      automation_tier TEXT,
      -- Source-owned column now written by aggregator's upsertStmt (six sources parse an
      -- employment type; none of it was persisted before). Hand-rolled fixtures have to track the
      -- real schema or the upsert fails against them — the same way automation_tier surfaced.
      employment_type TEXT
    );
    CREATE TABLE job_role_map (
      job_id TEXT PRIMARY KEY, role_key TEXT, role_family TEXT, domain TEXT,
      source_profile_id INTEGER, -- upsertCanonicalJob retires superseded classifier buckets by this column
      confidence REAL, matched_by TEXT
    );
    CREATE TABLE rejected_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT, source TEXT,
      reason TEXT, rejected_at INTEGER
    );
  `);
  return db;
}

const VERDICT = { roleKey: "engineering", seniority: "mid", domain: "software", collar: "white", confidence: 0.9 };

/** Write one normalized posting through the real aggregator path and read the row back. */
function writeAndRead(db, over = {}) {
  const canonical = normalizeJob({
    id: "j1", title: "Backend Engineer", company: "Acme", location: "London, UK",
    url: "https://example.test/j1", source: "greenhouse", description: "text",
    ...over,
  });
  const dedup = reconcileFingerprint(db, { ...canonical, company_icon_url: null });
  const now = Math.floor(Date.now() / 1000);
  upsertCanonicalJob(db, {
    jobId: canonical.id, canonical, verdict: VERDICT, dedup, now,
    contentHash: fingerprintJob(canonical), searchQuery: "test",
    sourceLabel: "Greenhouse", matchedBy: "test",
  });
  return db.prepare("SELECT * FROM scraped_jobs WHERE job_id = ?").get(canonical.id);
}

test("a non-USD range survives the write — it has no other column to live in", () => {
  const db = db0();
  try {
    const row = writeAndRead(db, {
      salary_min: 90000, salary_max: 120000, salary_currency: "GBP", salary_period: "annual",
    });
    // The point of the fix: before it, all three of these were null and the posting's stated pay
    // was gone from the database entirely.
    assert.equal(row.salary_min, 90000);
    assert.equal(row.salary_max, 120000);
    assert.equal(row.salary_currency, "GBP");
    // normalizeJob must NOT invent a USD figure from a GBP one.
    assert.equal(row.salary_min_usd, null, "a GBP range is not a USD range");
    assert.equal(row.salary_max_usd, null);
  } finally { db.close(); }
});

test("a USD range still populates both the source trio and the derived _usd pair", () => {
  const db = db0();
  try {
    const row = writeAndRead(db, {
      salary_min: 152800, salary_max: 296000, salary_currency: "USD", salary_period: "annual",
    });
    assert.equal(row.salary_currency, "USD");
    assert.equal(row.salary_min, 152800);
    assert.equal(row.salary_min_usd, 152800, "the derived pair the board filters on must still work");
    assert.equal(row.salary_max_usd, 296000);
  } finally { db.close(); }
});

test("a posting with no stated pay writes nulls rather than zeros", () => {
  const db = db0();
  try {
    const row = writeAndRead(db);
    assert.equal(row.salary_min, null);
    assert.equal(row.salary_max, null);
    assert.equal(row.salary_currency, null);
  } finally { db.close(); }
});

// ── change detection ─────────────────────────────────────────────────────────

test("a revised non-USD range changes the content hash", () => {
  // salary_min_usd is null for a non-USD posting, so while the hash covered only the _usd pair a
  // company revising its GBP range produced a byte-identical hash and the change was invisible:
  // the crawl would 'touch' the row and keep the stale figure forever.
  const base = { id: "j1", title: "T", company: "C", location: "L", url: "u", source: "greenhouse" };
  const before = fingerprintJob(normalizeJob({ ...base, salary_min: 90000, salary_max: 120000, salary_currency: "GBP" }));
  const after  = fingerprintJob(normalizeJob({ ...base, salary_min: 95000, salary_max: 130000, salary_currency: "GBP" }));
  assert.notEqual(before, after);
});

test("changing only the currency changes the hash — same numbers, different money", () => {
  const base = { id: "j1", title: "T", company: "C", location: "L", url: "u", source: "greenhouse",
                 salary_min: 90000, salary_max: 120000 };
  const gbp = fingerprintJob(normalizeJob({ ...base, salary_currency: "GBP" }));
  const eur = fingerprintJob(normalizeJob({ ...base, salary_currency: "EUR" }));
  assert.notEqual(gbp, eur);
});

test("an unchanged posting still hashes identically, so repeat crawls stay cheap", () => {
  const j = { id: "j1", title: "T", company: "C", location: "L", url: "u", source: "greenhouse",
              salary_min: 90000, salary_max: 120000, salary_currency: "GBP" };
  assert.equal(fingerprintJob(normalizeJob(j)), fingerprintJob(normalizeJob({ ...j })));
});

// ── dedup merge ──────────────────────────────────────────────────────────────

test("a duplicate may donate a salary the canonical row lacks", () => {
  // MERGEABLE_FIELDS is how a lower-priority source fills a gap in the winning row. Without the
  // source trio listed there, a canonical row with no pay could not adopt one from a duplicate
  // that had it — the same drop, one layer up.
  const db = db0();
  try {
    const canonical = writeAndRead(db);
    assert.equal(canonical.salary_currency, null, "precondition: canonical has no pay");

    const donor = normalizeJob({
      id: "j2", title: "Backend Engineer", company: "Acme", location: "London, UK",
      url: "https://example.test/j2", source: "lever", description: "text",
      salary_min: 90000, salary_max: 120000, salary_currency: "GBP", salary_period: "annual",
    });
    const dedup = reconcileFingerprint(db, { ...donor, company_icon_url: null });
    assert.equal(dedup.action, "fold", "precondition: the two collapse to one role");

    const row = db.prepare("SELECT * FROM scraped_jobs WHERE job_id = ?").get(dedup.intoJobId);
    assert.equal(row.salary_min, 90000);
    assert.equal(row.salary_currency, "GBP");
  } finally { db.close(); }
});
