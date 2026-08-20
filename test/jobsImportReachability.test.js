// An imported job that reports success must be REACHABLE on the board it was imported for.
//
// The reported case: a Quora posting imported through /api/import/job returned 200, rendered its
// full JD, was starred into user_jobs — and never appeared on the board. Diagnosed end to end
// against production data, the cause was neither the import writer nor any NULL column (the row came
// out with experience_level='mid', workplace_type='remote', automation_tier='direct', so every
// null-sensitive filter passed it). It was the role bucket:
//
//   1. classifyTitle disqualified `engineering` for "Software Engineer, Machine Learning" because
//      engineering's exclusion list contains "machine learning" — even though the SAME title
//      carries engineering's strong anchor "software engineer", which the scorer documents as
//      decisive. `data` needs the contiguous phrase "machine learning engineer", absent here, so it
//      scored weak-only at 0.35 and the title fell through to 'general'.
//   2. /api/jobs reads the board through `JOIN job_role_map jrm ON ... AND jrm.role_key = ?` — an
//      INNER JOIN — so a row bucketed 'general' is invisible to an 'engineering' profile. Measured:
//      role_key='engineering' → 0 rows, role_key='general' → 1 row, for the same job_id.
//   3. And when classifyJob returns roleKey === null outright, upsertCanonicalJob wrote NO role_map
//      row at all, making the row unreachable for EVERY user under EVERY filter, including
//      ?curate=off — against importJob.js's own stated contract that an explicit user import must
//      never silently vanish.
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { classifyTitle } from "../services/jobClassifier.js";
import { classifyJob, ROLE_KEY_FALLBACK } from "../services/jobs/classifyJob.js";
import { upsertCanonicalJob, fingerprintJob } from "../services/jobs/aggregator.js";
import { normalizeJob } from "../services/jobs/schema.js";

// ── 1. The classifier: a specialisation qualifier must not strip the family its own anchor names ──

test("a qualifier does not strip the family named by the title's own strong anchor", () => {
  // The exact reported title. Before the fix: 'general', confidence 0.35, i.e. nobody's board.
  const v = classifyJob("Software Engineer, Machine Learning", "Build ranking systems.", "Quora");
  assert.equal(v.roleKey, "engineering");
  assert.ok(v.confidence >= 0.75,
    `must clear INGEST_CONFIDENCE_THRESHOLD, got ${v.confidence} — below it the verdict falls back ` +
    `to the 'general' bucket and the job is invisible again`);
});

test("the same holds for the other shapes of the same construction", () => {
  for (const title of [
    "Senior Software Engineer, AI Platform",
    "Backend Engineer, ML Infrastructure",
    "Software Engineer - Machine Learning Platform",
  ]) {
    assert.equal(classifyJob(title, "", "Acme").roleKey, "engineering", title);
  }
});

test("exclusions still win wherever the specialist family strong-claims the title", () => {
  // This is what the exclusion lists were written for, and none of it may regress. In each case the
  // specialist family has a strong TITLE anchor of its own, so the exclusion stays in force.
  const expected = {
    "Embedded Software Engineer": "engineering_embedded_firmware",
    "Firmware Engineer":          "engineering_embedded_firmware",
    "Machine Learning Engineer":  "data",
    "ML Engineer":                "data",
    "Data Engineer":              "data",
    "Data Scientist":             "data",
    "Analytics Engineer":         "data",
    "AI Engineer":                "data",
    "Product Manager":            "pm",
    "Technical Program Manager":  "pm",
  };
  for (const [title, want] of Object.entries(expected)) {
    assert.equal(classifyJob(title, "", "Acme").roleKey, want, title);
  }
});

test("plain engineering titles are unaffected", () => {
  for (const title of ["Software Engineer", "Full Stack Engineer", "Site Reliability Engineer",
                       "DevOps Engineer", "Platform Engineer"]) {
    assert.equal(classifyJob(title, "", "Acme").roleKey, "engineering", title);
  }
});

test("an exclusion is applied only when another family actually strong-claims the title", () => {
  // The mechanism, asserted directly rather than through its consequences: "software engineer" is a
  // strong anchor for engineering AND "machine learning" is one of its exclusions, so the old
  // unconditional check returned -Infinity for engineering here.
  const { roleKey } = classifyTitle("Software Engineer, Machine Learning", "");
  assert.equal(roleKey, "engineering");
  // ...whereas here `engineering_embedded_firmware` does strong-claim it, so engineering stays out.
  assert.equal(classifyTitle("Embedded Software Engineer", "").roleKey,
               "engineering_embedded_firmware");
});

// ── 2. The writer: an unclassified import must still land in a bucket, idempotently ───────────────

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
      automation_tier TEXT,
      -- Source-owned column now written by aggregator's upsertStmt (six sources parse an
      -- employment type; none of it was persisted before). Hand-rolled fixtures have to track the
      -- real schema or the upsert fails against them — the same way automation_tier surfaced.
      employment_type TEXT
    );
    -- PRIMARY KEY (job_id, role_key), matching migration 031: a job legitimately carries more than
    -- one bucket, which is why the fallback is guarded on "any bucket" rather than on this pair.
    CREATE TABLE job_role_map (
      job_id TEXT NOT NULL, role_key TEXT NOT NULL, role_family TEXT, domain TEXT,
      source_profile_id INTEGER, confidence REAL, matched_by TEXT,
      PRIMARY KEY (job_id, role_key),
      FOREIGN KEY (job_id) REFERENCES scraped_jobs(job_id) ON DELETE CASCADE
    );
    CREATE TABLE rejected_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT, source TEXT,
      reason TEXT, rejected_at INTEGER
    );
  `);
  db.pragma("foreign_keys = ON");
  return db;
}

/** One write through the real aggregator path, as importJob.js performs it. */
function writeJob(db, { jobId, title, verdict, source = "ashby" }) {
  const canonical = normalizeJob({
    id: jobId, title, company: "Quora", location: "Remote",
    url: `https://jobs.ashbyhq.com/quora/${jobId}`, source,
    description: "Build things.", posted_at: "2026-08-01T00:00:00Z",
  });
  upsertCanonicalJob(db, {
    jobId, canonical, verdict,
    dedup: { sourcesSeen: source, reqUid: null },
    now: 1_787_000_000,
    contentHash: fingerprintJob(canonical),
    searchQuery: "import",
    sourceLabel: source,
    matchedBy: "import_ats_reuse",
  });
  return jobId;
}

const roleRows = (db, jobId) =>
  db.prepare("SELECT role_key, matched_by FROM job_role_map WHERE job_id = ?").all(jobId);

test("an unclassified import still gets a role_map row, so it is reachable at all", () => {
  const db = db0();
  writeJob(db, {
    jobId: "j-unclassified", title: "Content Moderator",
    verdict: { roleKey: null, domain: "general", confidence: 0.35, collar: "white" },
  });
  const rows = roleRows(db, "j-unclassified");
  assert.equal(rows.length, 1,
    "no role_map row means the INNER JOIN in /api/jobs can never return this row, for anyone");
  assert.equal(rows[0].role_key, ROLE_KEY_FALLBACK);
  assert.match(rows[0].matched_by, /_unclassified$/,
    "the fallback must be distinguishable from a real verdict in the stored provenance");
});

test("the fallback never adds a second bucket to a job a real verdict already placed", () => {
  const db = db0();
  // A crawl classifies it properly...
  writeJob(db, {
    jobId: "j-both", title: "Software Engineer",
    verdict: { roleKey: "engineering", domain: "general", confidence: 0.9, collar: "white" },
  });
  // ...then the same posting is re-imported and comes back unclassifiable.
  writeJob(db, {
    jobId: "j-both", title: "Software Engineer",
    verdict: { roleKey: null, domain: "general", confidence: 0.3, collar: "white" },
  });
  const rows = roleRows(db, "j-both");
  assert.deepEqual(rows.map((r) => r.role_key), ["engineering"],
    "a 'general' fallback beside a real bucket would surface the same job on a second board");
});

test("the fallback is idempotent across repeated unclassified re-imports", () => {
  const db = db0();
  for (let i = 0; i < 3; i++) {
    writeJob(db, {
      jobId: "j-repeat", title: "Content Moderator",
      verdict: { roleKey: null, domain: "general", confidence: 0.3, collar: "white" },
    });
  }
  assert.equal(roleRows(db, "j-repeat").length, 1);
});

test("a changed verdict REPLACES the old bucket instead of adding a second one", () => {
  // job_role_map's PK is (job_id, role_key), so the upsert only replaces the row for the key being
  // written. A re-crawl whose verdict changed therefore used to leave the stale bucket in place and
  // the posting appeared on two profiles' boards at once. Seen on real data after the classifier fix:
  // Figma's "Software Engineer - Machine Learning" sat in both 'engineering' and 'general'.
  const db = db0();
  writeJob(db, { jobId: "j-moved", title: "Software Engineer, Machine Learning",
    verdict: { roleKey: "general", domain: "general", confidence: 0.35, collar: "white" } });
  assert.deepEqual(roleRows(db, "j-moved").map((r) => r.role_key), ["general"]);

  writeJob(db, { jobId: "j-moved", title: "Software Engineer, Machine Learning",
    verdict: { roleKey: "engineering", domain: "general", confidence: 0.87, collar: "white" } });
  assert.deepEqual(roleRows(db, "j-moved").map((r) => r.role_key), ["engineering"],
    "the superseded bucket must be retired, or the same job shows up on two boards");
});

test("retiring a superseded bucket never touches a profile-derived one", () => {
  // server.js's assignJobRoleMap records "this profile scraped this job" and stamps
  // source_profile_id. That answers a different question from the classifier's verdict and must
  // survive a reclassification — which is why the retire is keyed on source_profile_id IS NULL.
  const db = db0();
  writeJob(db, { jobId: "j-prof", title: "Software Engineer",
    verdict: { roleKey: "general", domain: "general", confidence: 0.35, collar: "white" } });
  db.prepare(`INSERT INTO job_role_map (job_id, role_key, role_family, domain, source_profile_id,
    confidence, matched_by) VALUES (?, 'pm', 'pm', null, 7, 1.0, 'profile_scrape')`).run("j-prof");

  writeJob(db, { jobId: "j-prof", title: "Software Engineer",
    verdict: { roleKey: "engineering", domain: "general", confidence: 0.9, collar: "white" } });
  assert.deepEqual(roleRows(db, "j-prof").map((r) => r.role_key).sort(), ["engineering", "pm"],
    "the profile-scoped bucket must survive; only the classifier's own stale bucket is retired");
});

test("a real verdict still writes its own bucket exactly as before", () => {
  const db = db0();
  writeJob(db, {
    jobId: "j-real", title: "Software Engineer",
    verdict: { roleKey: "engineering", domain: "general", confidence: 0.9, collar: "white" },
  });
  const rows = roleRows(db, "j-real");
  assert.deepEqual(rows.map((r) => r.role_key), ["engineering"]);
  assert.equal(rows[0].matched_by, "import_ats_reuse", "real verdicts keep their unsuffixed provenance");
});

// ── 3. End to end: the reported job, through the real board query ─────────────────────────────────

test("the reported Quora import is reachable on an engineering profile's board", () => {
  const db = db0();
  const title = "Software Engineer, Machine Learning";
  writeJob(db, { jobId: "j-quora", title, verdict: classifyJob(title, "Build ranking systems.", "Quora") });

  // The board's own scoping shape: an INNER JOIN on the active profile's role_key.
  const board = (roleKey) => db.prepare(`
    SELECT sj.job_id FROM scraped_jobs sj
    JOIN job_role_map jrm ON jrm.job_id = sj.job_id AND jrm.role_key = ?
    WHERE sj.is_active = 1
  `).all(roleKey).map((r) => r.job_id);

  assert.deepEqual(board("engineering"), ["j-quora"],
    "this is the exact query that returned 0 rows for this job before the classifier fix");
  assert.deepEqual(board("general"), [],
    "and it must no longer be sitting in the bucket almost no profile maps to");
});
