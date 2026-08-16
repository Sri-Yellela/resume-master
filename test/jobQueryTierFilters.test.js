// The provider + automation-tier WHERE clauses in services/jobs/jobQuery.js, run against real
// SQLite rather than asserted on generated SQL text — the NULL semantics are the whole point of
// these filters and only the database can settle them.
//
// `sources_include`/`sources_exclude` and `tiers_include`/`tiers_exclude` are deliberately NOT
// written the same way: source is always populated so a plain IN/NOT IN is correct, while
// automation_tier arrived with migration 078 and can be NULL until the writers and the boot
// backfill have run. `NULL IN (...)` is NULL, not false, so a bare IN drops those rows silently —
// and so does a bare NOT IN, which is the trap that makes the exclusion direction discard exactly
// the rows nobody asked to exclude. The tier clauses COALESCE to 'unknown' so a NULL row behaves
// as the tier that already means "not established", in both directions.
import test from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { buildJobFilters, ALLOWED_FIELDS, FACET_DIMENSIONS } from "../services/jobs/jobQuery.js";
import { AUTOMATION_TIERS } from "../services/jobs/automationTier.js";

function seed() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, source TEXT, url TEXT, apply_url TEXT, automation_tier TEXT);
    INSERT INTO scraped_jobs VALUES ('gh',   'greenhouse', 'https://boards.greenhouse.io/a', NULL, 'direct');
    INSERT INTO scraped_jobs VALUES ('wd',   'workday',    'https://a.myworkdayjobs.com/b',  NULL, 'account');
    INSERT INTO scraped_jobs VALUES ('li',   'LinkedIn',   'https://linkedin.com/jobs/view/1', NULL, 'gated');
    INSERT INTO scraped_jobs VALUES ('unk',  'adzuna',     'https://careers.example.com/1',  NULL, 'unknown');
    INSERT INTO scraped_jobs VALUES ('nul',  'greenhouse', 'https://boards.greenhouse.io/c', NULL, NULL);
  `);
  return db;
}

function run(db, params) {
  const f = buildJobFilters(params);
  return db.prepare(`SELECT job_id FROM scraped_jobs sj WHERE 1=1 ${f.sql}`).all(...f.params).map(r => r.job_id);
}

test("no params at all produces no SQL — the default query is untouched", () => {
  const f = buildJobFilters({});
  assert.equal(f.sql, "");
  assert.deepEqual(f.params, []);
});

test("none of the four new params appear unless passed", () => {
  // The byte-compatibility property /api/jobs has to keep: an existing caller that sends none of
  // these gets the exact query it got before this module learned about them.
  for (const key of ["sources_include", "sources_exclude", "tiers_include", "tiers_exclude"]) {
    assert.equal(buildJobFilters({ [key]: "" }).sql, "", `${key}='' must be treated as absent`);
    assert.equal(buildJobFilters({ [key]: [] }).sql, "", `${key}=[] must be treated as absent`);
  }
});

test("sources_include / sources_exclude use a plain IN — source is never null", () => {
  const db = seed();
  assert.deepEqual(run(db, { sources_include: "greenhouse" }).sort(), ["gh", "nul"]);
  assert.deepEqual(run(db, { sources_exclude: "greenhouse" }).sort(), ["li", "unk", "wd"]);
  db.close();
});

test("a NULL automation_tier is INCLUDED by tiers_include=unknown, not dropped", () => {
  const db = seed();
  assert.deepEqual(run(db, { tiers_include: "unknown" }).sort(), ["nul", "unk"]);
  db.close();
});

test("a NULL automation_tier is EXCLUDED from tiers_include=direct — no false promise", () => {
  const db = seed();
  assert.deepEqual(run(db, { tiers_include: "direct" }), ["gh"]);
  db.close();
});

test("a NULL automation_tier SURVIVES tiers_exclude=gated — the mirror trap", () => {
  // A bare `automation_tier NOT IN ('gated')` evaluates to NULL for the null row and drops it,
  // which is the same silent-drop shape as the include direction. It must not.
  const db = seed();
  const ids = run(db, { tiers_exclude: "gated" }).sort();
  assert.ok(ids.includes("nul"), "the NULL-tier row vanished from the exclude direction");
  assert.deepEqual(ids, ["gh", "nul", "unk", "wd"]);
  db.close();
});

test("a NULL automation_tier is dropped by tiers_exclude=unknown — asked for, so honoured", () => {
  const db = seed();
  assert.deepEqual(run(db, { tiers_exclude: "unknown" }).sort(), ["gh", "li", "wd"]);
  db.close();
});

test("no row can vanish from both directions of the tier filter", () => {
  const db = seed();
  const all = db.prepare("SELECT job_id FROM scraped_jobs").all().map(r => r.job_id);
  for (const tier of AUTOMATION_TIERS) {
    const inc = new Set(run(db, { tiers_include: tier }));
    const exc = new Set(run(db, { tiers_exclude: tier }));
    for (const id of all) {
      assert.ok(inc.has(id) || exc.has(id), `${id} disappeared from both directions of tier=${tier}`);
    }
  }
  db.close();
});

test("source and tier filters compose, and both directions bind their params in order", () => {
  const db = seed();
  assert.deepEqual(run(db, { sources_include: "greenhouse,workday", tiers_exclude: "unknown" }).sort(), ["gh", "wd"]);
  db.close();
});

test("excluding every provider yields an empty board rather than an error", () => {
  // The state the board's FilteredEmptyState exists to explain. It must be reachable and empty,
  // not a SQL failure and not a silently-unfiltered full board.
  const db = seed();
  assert.deepEqual(run(db, { sources_exclude: "greenhouse,workday,LinkedIn,adzuna" }), []);
  assert.deepEqual(run(db, { tiers_exclude: AUTOMATION_TIERS.join(",") }), []);
  db.close();
});

test("automation_tier is selectable and facetable through the same guard the filter uses", () => {
  assert.ok(ALLOWED_FIELDS.has("automation_tier"), "include_fields could not project the column");
  assert.ok(FACET_DIMENSIONS.automation_tier, "no facet dimension, so the drawer could show no counts");
  // The facet must group through the SAME COALESCE, or "Unknown (n)" would advertise a smaller
  // number than selecting Unknown actually returns.
  assert.match(FACET_DIMENSIONS.automation_tier.column, /COALESCE\(sj\.automation_tier, 'unknown'\)/);
});

test("the facet expression really does count NULL rows as unknown", () => {
  const db = seed();
  const rows = db.prepare(
    `SELECT ${FACET_DIMENSIONS.automation_tier.column} AS value, COUNT(*) AS count
     FROM scraped_jobs sj GROUP BY ${FACET_DIMENSIONS.automation_tier.column}`
  ).all();
  const unknown = rows.find(r => r.value === "unknown");
  assert.equal(unknown.count, 2, "the NULL row must be counted under unknown, matching the filter");
  db.close();
});
