// ENRICHMENT WAS OVERWRITING A GOOD normalized_title WITH A SHORTER ONE, 99% OF THE TIME.
//
// Every enrichment column is written `COALESCE(@model, column)` — a non-null extraction WINS, on
// the reasoning that "a wrong value can still be corrected on a later pass". For one column that
// permission was being used to destroy information. Measured over EVERY recorded rewrite in
// production — 475 of them (docs/PART1_RECONCILED_2026-09-18.md §4):
//
//     changed                           475 of 475  (100%)
//     SHORTER than the ingested value    469        (98.7%)
//     seniority token changed or lost     17 of a 200-row sample (9%)
//
//     "staff software engineer, gtm systems"   -> "staff software engineer"
//     "staff+ software engineer, grc platform" -> "software engineer, grc platform"
//
// Not a near-miss a later pass improves — a systematic truncation. And normalized_title is 100%
// covered from ingestion (2,610 of 2,610 active), so enrichment was never filling a gap here.
//
// ⛔ IT IS READ BY THREE THINGS, WHICH IS WHY A DROPPED "staff+" IS NOT COSMETIC:
//   · profileTitleSql            — board membership ranking
//   · the scorer's detectSeniority — matches /staff|principal|senior|lead/ on the title
//   · roleFamilyForTitle         — buckets the ats_term_weights table per role family
//
// So the fix reverses the COALESCE arguments for that column alone: keep what is there, fill only
// a genuine gap. These tests execute the real statement against real SQLite rather than reading
// its text, because the defect is an argument ORDER and a source scan for "COALESCE" would pass
// against either direction.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { at } from "../test-support/sourceAnchors.js";
import { ENRICHMENT_COLUMNS } from "../services/jobs/enrichmentSelection.js";

const SRC = fs.readFileSync("services/jobs/enrichJob.js", "utf8");

/** The real UPDATE, lifted from the source so the test cannot drift from the statement it pins. */
function updateSql() {
  const stmt = SRC.slice(at(SRC, "UPDATE scraped_jobs SET"), at(SRC, "WHERE job_id = @job_id"));
  // The provenance column is appended conditionally by a template expression; drop that branch and
  // the SQL comments, leaving the column list this test exercises.
  return (stmt + "WHERE job_id = @job_id")
    .replace(/\$\{[^}]*\}/g, "")
    .replace(/^\s*--.*$/gm, "");
}

function db1(normalized_title) {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE scraped_jobs (
             job_id TEXT PRIMARY KEY, summary TEXT, normalized_title TEXT, experience_level TEXT,
             workplace_type TEXT, salary_min_usd INTEGER, salary_max_usd INTEGER,
             salary_period TEXT, skills_json TEXT, is_h1b_sponsor INTEGER,
             requires_work_auth INTEGER, is_clearance_required INTEGER, org_unit_raw TEXT,
             content_hash TEXT, enriched_at INTEGER);`);
  db.prepare("INSERT INTO scraped_jobs (job_id, normalized_title, summary) VALUES ('j', ?, 'About Acme. Boilerplate.')")
    .run(normalized_title);
  return db;
}

/** Run the real statement with a model payload. */
function enrich(db, payload) {
  const params = { job_id: "j", content_hash: "h", enriched_at: 1 };
  for (const c of ENRICHMENT_COLUMNS) params[c] = null;
  Object.assign(params, payload);
  db.prepare(updateSql()).run(params);
  return db.prepare("SELECT * FROM scraped_jobs WHERE job_id='j'").get();
}

test("⛔ a model title NEVER replaces one ingestion already set", () => {
  const db = db1("staff+ software engineer, grc platform");
  try {
    const row = enrich(db, { normalized_title: "software engineer, grc platform" });
    assert.equal(row.normalized_title, "staff+ software engineer, grc platform",
      "the ingested value survives — this is the whole fix");
  } finally { db.close(); }
});

test("the seniority token specifically survives, because three readers depend on it", () => {
  for (const [ingested, model] of [
    ["staff+ software engineer, inference velocity", "staff software engineer, inference"],
    ["staff software engineer, gtm systems",         "staff software engineer"],
    ["senior backend engineer, payments",            "backend engineer"],
  ]) {
    const db = db1(ingested);
    try {
      assert.equal(enrich(db, { normalized_title: model }).normalized_title, ingested);
    } finally { db.close(); }
  }
});

test("a genuine GAP is still filled — this is a fill-only rule, not a ban", () => {
  for (const gap of [null, ""]) {
    const db = db1(gap);
    try {
      const row = enrich(db, { normalized_title: "staff software engineer" });
      assert.equal(row.normalized_title, "staff software engineer",
        `an empty (${JSON.stringify(gap)}) title must still be filled`);
    } finally { db.close(); }
  }
});

test("a silent model still does not null the column out", () => {
  // The original defect this UPDATE was written to fix, and it must survive the new one.
  const db = db1("staff software engineer");
  try {
    assert.equal(enrich(db, { normalized_title: null }).normalized_title, "staff software engineer");
  } finally { db.close(); }
});

test("⛔ EVERY OTHER COLUMN STILL LETS A NON-NULL EXTRACTION WIN", () => {
  // The fix is one column wide. If it were applied to all of them, enrichment would stop being
  // able to correct anything — including summary, whose rewrites the same audit found to be a
  // clear improvement (boilerplate "About Anthropic…" -> a specific description of the role).
  const db = db1("staff software engineer");
  try {
    const row = enrich(db, {
      summary: "Build distributed inference systems serving Claude.",
      experience_level: "senior",
      skills_json: '["python"]',
    });
    assert.equal(row.summary, "Build distributed inference systems serving Claude.",
      "summary corrections are an improvement and must keep working");
    assert.equal(row.experience_level, "senior");
    assert.equal(row.skills_json, '["python"]');
  } finally { db.close(); }
});

test("the reversal is on normalized_title and nothing else, in the source", () => {
  const sql = updateSql();
  assert.match(sql, /normalized_title = COALESCE\(NULLIF\(normalized_title, ''\), @normalized_title\)/,
    "fill-only: existing value first");
  // Every other enrichment column keeps model-wins ordering.
  for (const c of ENRICHMENT_COLUMNS.filter(c => c !== "normalized_title")) {
    assert.match(sql, new RegExp(`${c} = COALESCE\\(@${c}, ${c}\\)`),
      `${c} must still let a non-null extraction win`);
  }
});

test("enrichment and the ingest upsert now agree about this column", () => {
  // The aggregator has always kept the existing value on re-crawl —
  // `COALESCE(scraped_jobs.normalized_title, excluded.normalized_title)`, commented "enrichment's
  // output outlives a re-crawl". Enrichment was the only writer that could overwrite it. Now
  // neither can, which is the point: two writers, one rule.
  const agg = fs.readFileSync("services/jobs/aggregator.js", "utf8");
  assert.match(agg, /normalized_title\s*=\s*COALESCE\(scraped_jobs\.normalized_title,\s*excluded\.normalized_title\)/);
});
