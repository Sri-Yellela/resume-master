// MIGRATION 109 — RESTORING THE SENIORITY ENRICHMENT STRIPPED, AND NOTHING ELSE.
//
// ccfef0f stopped enrichment overwriting normalized_title. 109 repairs what it already did. The
// scope is deliberately NARROWER than the audit that prompted it first recommended, and that
// narrowing is the thing most worth pinning.
//
// ⛔ THE BLANKET REPAIR WAS MEASURED AND REJECTED. 475 production rows were rewritten and 469 made
// SHORTER, which read as systematic truncation. The largest losses say otherwise:
//
//     "senior fullstack engineer (f/m/d) - berlin i germany | eu i remote"
//          -> "senior fullstack engineer"                     the column DOING ITS JOB
//     "fraud analyst (revenue protection) - 12-month fixed-term"
//          -> "fraud analyst"                                 likewise
//
// Restoring all 469 would push location, EEO and contract-duration noise back into a column whose
// purpose is to strip it. Length was a bad proxy for harm.
//
// What is defensible is SENIORITY LOSS: of the sampled rows carrying a seniority token, 27 lost it
// against 10 that kept it. `detectSeniority` matches exactly those tokens on the title, so there is
// no reading in which dropping "senior" improves a normalised title. 54 rows on production.
//
// ⛔ AND THE EARLIEST BEFORE-IMAGE, NOT THE LATEST. 28 jobs appear in more than one enrichment
// batch, so the most recent before_json for those holds a value a PREVIOUS pass already truncated.
// Restoring that would restore the damage. That fixture is the first test below.

import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../scripts/migrations.js";
import { applyPendingMigrations } from "../scripts/applyMigrations.js";

const M109 = MIGRATIONS.find(m => m.id === "109_restore_stripped_seniority_titles");

/** A board plus enrichment history, with migration 109 not yet applied. */
function board(rows) {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, normalized_title TEXT);
           CREATE TABLE enrichment_batch_rows (
             batch_id INTEGER, job_id TEXT, before_json TEXT, written_at INTEGER);`);
  const j = db.prepare("INSERT INTO scraped_jobs VALUES (?,?)");
  const e = db.prepare("INSERT INTO enrichment_batch_rows VALUES (?,?,?,?)");
  for (const r of rows) {
    j.run(r.id, r.now);
    for (const b of r.batches) {
      e.run(b.batch, r.id, JSON.stringify({ normalized_title: b.title }), b.at);
    }
  }
  return db;
}
const run = (db) => db.exec(M109.sql);
const titleOf = (db, id) =>
  db.prepare("SELECT normalized_title t FROM scraped_jobs WHERE job_id=?").get(id).t;

test("⛔ the EARLIEST before-image wins when a job was enriched twice", () => {
  // The trap. Batch 9 ran later and recorded the ALREADY-TRUNCATED title as its "before". Taking
  // the most recent image would restore the damage and report success.
  const db = board([{
    id: "multi", now: "account executive manager",
    batches: [
      { batch: 9, at: 300, title: "account executive manager" },              // later, already lost
      { batch: 2, at: 200, title: "senior manager, account executive" },      // the original
    ],
  }]);
  try {
    run(db);
    assert.equal(titleOf(db, "multi"), "senior manager, account executive");
  } finally { db.close(); }
});

test("a lost seniority token is restored", () => {
  const cases = [
    ["senior / staff product engineer",               "product engineer"],
    ["lead product marketing manager - verticals",    "product marketing manager"],
    ["gtm senior business systems analyst – channel", "business systems analyst"],
    ["principal data scientist, forecasting",         "data scientist"],
    ["director of engineering, platform",             "engineering manager"],
  ];
  for (const [orig, now] of cases) {
    const db = board([{ id: "x", now, batches: [{ batch: 1, at: 100, title: orig }] }]);
    try {
      run(db);
      assert.equal(titleOf(db, "x"), orig, `"${now}" should have been restored to "${orig}"`);
    } finally { db.close(); }
  }
});

test("⛔ a row where enrichment only stripped NOISE is left alone", () => {
  // The whole reason this migration is not a blanket restore. These are the column working.
  const cases = [
    ["senior fullstack engineer (f/m/d) - berlin i germany | eu i remote", "senior fullstack engineer"],
    ["fraud analyst (revenue protection) - 12-month fixed-term",           "fraud analyst"],
    ["software engineer, codex - enterprise controls",                     "software engineer"],
  ];
  for (const [orig, now] of cases) {
    const db = board([{ id: "x", now, batches: [{ batch: 1, at: 100, title: orig }] }]);
    try {
      run(db);
      assert.equal(titleOf(db, "x"), now,
        `"${now}" is a better normalised title than "${orig}" and must survive`);
    } finally { db.close(); }
  }
});

test("a seniority word that was never there does not trigger a restore", () => {
  // `NOT LIKE '%senior%'` on its own would match every title without the word. The rule requires
  // the token to have been present BEFORE and absent AFTER.
  const db = board([{ id: "x", now: "backend engineer",
                      batches: [{ batch: 1, at: 100, title: "backend engineer, payments" }] }]);
  try {
    run(db);
    assert.equal(titleOf(db, "x"), "backend engineer");
  } finally { db.close(); }
});

test("rows with no enrichment history, and empty before-images, are untouched", () => {
  const db = board([
    { id: "never", now: "staff engineer", batches: [] },
    { id: "blank", now: "engineer", batches: [{ batch: 1, at: 100, title: "" }] },
  ]);
  try {
    run(db);
    assert.equal(titleOf(db, "never"), "staff engineer");
    assert.equal(titleOf(db, "blank"), "engineer", "an empty before-image is not a value to restore");
  } finally { db.close(); }
});

test("it is idempotent — the second run changes nothing", () => {
  const db = board([{ id: "x", now: "product engineer",
                      batches: [{ batch: 1, at: 100, title: "senior / staff product engineer" }] }]);
  try {
    run(db);
    const after = titleOf(db, "x");
    run(db);
    assert.equal(titleOf(db, "x"), after,
      "after the restore the token is present, so the WHERE cannot match again");
  } finally { db.close(); }
});

test("it runs inside the real migration runner, on a real schema, from empty", () => {
  // 109 is a data repair that reads enrichment_batch_rows — created by 101 — so it must survive a
  // full cold migration run, not just its own exec.
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
               id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()));`);
    const n = applyPendingMigrations(db, MIGRATIONS);
    assert.equal(n, MIGRATIONS.length);
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id=?")
      .get("109_restore_stripped_seniority_titles"), "109 applied and recorded");
  } finally { db.close(); }
});
