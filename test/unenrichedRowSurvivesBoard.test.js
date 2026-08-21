// THE TRIPWIRE. Every board outage in this project so far has been the same bug wearing a
// different column: a filter over a column that an UNENRICHED row leaves NULL, applied BY DEFAULT
// from the active profile, silently taking the board to zero.
//
//   skills_json      — 0 of 178 active rows enriched; `skills_json LIKE ?` emptied the board.
//   experience_level — `NULL IN ('mid','senior')` is NULL, so every unenriched row vanished.
//   workplace_type   — same shape, reached through the Remote/Hybrid/Onsite control.
//   automation_tier  — NULL dropped by `IN` *and* by `NOT IN`, the mirror trap.
//   employment_type  — server.js's clause for the column was soft-null and jobQuery.js's was not.
//   posted_at        — `posted_at IS NOT NULL AND ...` dropped every undated posting.
//
// Each was found only after a user reported an empty or incomplete board. This file exists so the
// NEXT one is found by `npm test` instead: it asserts that a row with every enrichment-owned column
// NULL survives the DEFAULT board query for a profile with realistic signals. If you add a filter
// over a column enrichment populates, it has to keep this test green.
//
// Deliberately built from the REAL pieces — deriveProfileFilters + buildJobFilters against real
// SQLite — rather than from asserted SQL strings, so it fails on behaviour rather than on wording.
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildJobFilters } from "../services/jobs/jobQuery.js";
import { deriveProfileFilters } from "../services/jobs/profileFilterBridge.js";

// Every column the board filters on that a not-yet-enriched row leaves NULL.
const ENRICHMENT_OWNED_NULL_COLUMNS = [
  "experience_level", "workplace_type", "skills_json", "employment_type",
  "automation_tier", "posted_at", "salary_min_usd", "salary_max_usd",
  "is_h1b_sponsor", "requires_work_auth", "is_clearance_required",
];

function db0() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT, location TEXT, source TEXT,
      normalized_title TEXT, summary TEXT, skills_json TEXT,
      experience_level TEXT, workplace_type TEXT, employment_type TEXT, automation_tier TEXT,
      salary_min_usd INTEGER, salary_max_usd INTEGER,
      is_h1b_sponsor INTEGER, requires_work_auth INTEGER, is_clearance_required INTEGER,
      posted_at TEXT, discovered_at INTEGER, scraped_at INTEGER, is_active INTEGER DEFAULT 1
    );
  `);
  return db;
}

const NOW = 1_787_000_000;

/** The row this whole file is about: imported/crawled, never enriched, every such column NULL. */
function insertUnenriched(db, overrides = {}) {
  const row = {
    job_id: "j-unenriched",
    title: "Software Engineer, Machine Learning Platform, New Grad - Quora (Remote)",
    company: "Quora",
    location: "Remote - Multiple Locations",
    source: "ashby",
    normalized_title: null, summary: null,
    // Everything in ENRICHMENT_OWNED_NULL_COLUMNS stays NULL unless a test overrides it.
    skills_json: null, experience_level: null, workplace_type: null, employment_type: null,
    automation_tier: null, salary_min_usd: null, salary_max_usd: null,
    is_h1b_sponsor: null, requires_work_auth: null, is_clearance_required: null,
    posted_at: null,
    discovered_at: NOW, scraped_at: NOW, is_active: 1,
    ...overrides,
  };
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO scraped_jobs (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`
  ).run(...cols.map((c) => row[c]));
  return row.job_id;
}

/** Does this filter set return the row? Runs the real fragment against real SQLite. */
function survives(db, filterParams) {
  const f = buildJobFilters(filterParams);
  return db
    .prepare(`SELECT COUNT(*) AS n FROM scraped_jobs sj WHERE sj.is_active = 1 ${f.sql}`)
    .get(...f.params).n === 1;
}

// ── The headline guarantee ───────────────────────────────────────────────────────────────────

test("an unenriched row survives the DEFAULT board query for a profile with full signals", () => {
  const db = db0();
  insertUnenriched(db);

  // A realistic active profile: target titles, skills, and years of experience — i.e. every
  // dimension profileFilterBridge has an opinion about, all applied by default.
  const derived = deriveProfileFilters(
    { target_titles: JSON.stringify(["Software Engineer"]) },
    {
      titles: ["Software Engineer"],
      searchTerms: ["machine learning"],
      skills: ["Python", "Kubernetes", "PyTorch"],
      yearsExperience: 3,
      structuredFacts: { requiresSponsorship: true },
    }
  );

  // Guard the premise: if the bridge stops deriving these, this test would pass vacuously.
  assert.ok(derived.q, "premise: the bridge derives q");
  assert.ok(derived.skills_include?.length, "premise: the bridge derives skills_include");
  assert.ok(derived.experience_levels?.length, "premise: the bridge derives experience_levels");
  assert.equal(derived.sponsorship_friendly, true, "premise: the bridge derives sponsorship_friendly");

  assert.ok(
    survives(db, derived),
    "an unenriched row was dropped by the DEFAULT profile-derived board query — this is the exact " +
    "shape of every board outage so far. Whichever filter you just added over an enrichment-owned " +
    "column needs the soft-null escape `(col IS NULL OR col <predicate>)`."
  );
});

test("each enrichment-owned column, filtered alone, still returns the unenriched row", () => {
  const db = db0();
  insertUnenriched(db);

  // One filter at a time, so a failure names the column instead of just "the board is empty".
  // salary is deliberately absent: it hard-fails on NULL BY DESIGN (see jobQuery.js) and is
  // asserted separately below so that intent stays visible rather than looking like an omission.
  const perColumn = {
    experience_level: { experience_levels: ["mid", "senior"] },
    workplace_type:   { work_models: ["remote", "hybrid"] },
    skills_json:      { skills_include: ["Python", "Kubernetes"] },
    employment_type:  { employment_types: ["full-time"] },
    automation_tier:  { tiers_exclude: ["gated"] },
    posted_at:        { posted_after: NOW - 7 * 86400 },
    requires_work_auth: { sponsorship_friendly: true },
  };

  for (const [column, params] of Object.entries(perColumn)) {
    assert.ok(
      survives(db, params),
      `filtering on ${column} dropped a row whose ${column} is NULL: ${JSON.stringify(params)}`
    );
  }
});

test("the exclude direction drops NULLs too, and must be guarded the same way", () => {
  const db = db0();
  insertUnenriched(db);

  // NOT IN discards NULL exactly as IN does — the mirror trap that took the board to zero for
  // automation_tier. A user excluding a value they never set must not lose the unclassified rows.
  assert.ok(survives(db, { skills_exclude: ["COBOL"] }), "skills_exclude dropped a NULL skills_json");
  assert.ok(survives(db, { tiers_exclude: ["gated"] }), "tiers_exclude dropped a NULL automation_tier");
});

// ── The deliberate exceptions, pinned so they stay deliberate ────────────────────────────────

test("salary still hard-fails on NULL — a product decision, asserted so it cannot drift silently", () => {
  const db = db0();
  insertUnenriched(db);

  // NOT a bug. A job with no stated range cannot be shown to overlap a requested one, and guessing
  // would be worse. Pinned here so that if it is ever changed it is changed on purpose: today
  // has_salary is 0 across the board, so ANY active salary filter empties it.
  assert.equal(survives(db, { salary_min_usd: 100000 }), false);
  assert.equal(survives(db, { salary_max_usd: 250000 }), false);

  // And the bridge must never derive one by default, or the above becomes a default-on outage.
  const derived = deriveProfileFilters(
    { target_titles: "[]" },
    { skills: ["Python"], yearsExperience: 3, titles: [], searchTerms: [] }
  );
  assert.equal(derived.salary_min_usd, undefined);
  assert.equal(derived.salary_max_usd, undefined);
});

test("a populated column is still filtered on — soft-null must not become no-op", () => {
  const db = db0();
  // The other half of the contract: these escapes exist for ABSENT data, not to disable the filter.
  insertUnenriched(db, {
    job_id: "j-enriched",
    experience_level: "executive",
    workplace_type: "onsite",
    employment_type: "contract",
    automation_tier: "gated",
    skills_json: JSON.stringify(["COBOL"]),
    posted_at: "2020-01-01T00:00:00Z",
  });
  db.prepare("DELETE FROM scraped_jobs WHERE job_id = 'j-unenriched'").run();

  const dropped = (params) => {
    const f = buildJobFilters(params);
    return db.prepare(`SELECT COUNT(*) AS n FROM scraped_jobs sj WHERE sj.is_active = 1 ${f.sql}`)
      .get(...f.params).n === 0;
  };

  assert.ok(dropped({ experience_levels: ["mid", "senior"] }), "experience_levels became a no-op");
  assert.ok(dropped({ work_models: ["remote"] }),              "work_models became a no-op");
  assert.ok(dropped({ employment_types: ["full-time"] }),      "employment_types became a no-op");
  assert.ok(dropped({ tiers_exclude: ["gated"] }),             "tiers_exclude became a no-op");
  assert.ok(dropped({ skills_include: ["Python"] }),           "skills_include became a no-op");
  assert.ok(dropped({ posted_after: NOW - 7 * 86400 }),        "posted_after became a no-op");
});

// ── posted_after: the two clauses the same UI control emits must agree ───────────────────────

test("posted_after falls back to scraped_at, so it agrees with the ageFilter clause beside it", () => {
  const db = db0();
  insertUnenriched(db); // posted_at NULL, scraped_at = NOW

  // JobsPanel's single "Past week" pill emits BOTH ageFilter (server.js: `sj.scraped_at >= ?`) and
  // posted_after, from the same state. When posted_after hard-required posted_at, the two clauses
  // in one query disagreed and the undated row lost.
  const cutoff = NOW - 7 * 86400;
  assert.ok(survives(db, { posted_after: cutoff }),
    "an undated but recently-scraped row was dropped by posted_after while ageFilter kept it");

  // Still a real recency filter: a genuinely old row is excluded on its scraped_at.
  const old = db0();
  insertUnenriched(old, { scraped_at: NOW - 400 * 86400, discovered_at: NOW - 400 * 86400 });
  assert.equal(survives(old, { posted_after: cutoff }), false,
    "posted_after must not become a soft-null escape — an old row is still old");
});
