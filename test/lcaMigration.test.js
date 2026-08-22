// Migration 082 (TASK X3), and the two properties this project's migrations keep getting wrong:
// the dual path has to stay byte-identical, and the schema has to be additive.
//
// The dual path is not redundancy for its own sake. server.js runs migrations at boot and
// scripts/migrations.js backs the `npm run migrate` CLI; a block that drifts between them means the
// CLI and the server disagree about the schema, and the disagreement only shows up on whichever
// path a given deploy happens to take.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../scripts/migrations.js";

const ID = "082_company_lca_sponsorship";
const FEIN_ID = "083_lca_source_fein_presence";

test("migration 082 is byte-identical in server.js and scripts/migrations.js", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const script = fs.readFileSync("scripts/migrations.js", "utf8");
  const block = (src) => {
    const i = src.indexOf(`id: "${ID}"`);
    assert.ok(i > 0, `migration ${ID} must exist`);
    return src.slice(i, src.indexOf("\n    },", i));
  };
  assert.equal(block(server), block(script),
    "the migration must be byte-identical in server.js and scripts/migrations.js");
});

test("migration 082 is additive, and touches scraped_jobs not at all", () => {
  const m = MIGRATIONS.find(x => x.id === ID);
  assert.ok(m, `${ID} must be in the MIGRATIONS array`);
  assert.doesNotMatch(m.sql, /DROP\s+TABLE|DROP\s+COLUMN|ALTER\s+TABLE\s+\w+\s+RENAME/i,
    "additive only");
  // The posting-level flag keeps its own column and its own meaning. A company-level fact that
  // altered scraped_jobs would be the first step toward one overwriting the other.
  assert.doesNotMatch(m.sql, /scraped_jobs/i,
    "company-level LCA evidence must not touch scraped_jobs — is_h1b_sponsor is a different claim");
  const ids = MIGRATIONS.map(x => x.id);
  assert.ok(ids.indexOf(ID) < ids.indexOf(FEIN_ID), "new migrations append, never insert");
});

// ── 083: the record layout changed under us ──────────────────────────────────

test("migration 083 is byte-identical in both paths, and records a layout fact not a guess", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const script = fs.readFileSync("scripts/migrations.js", "utf8");
  const block = (src) => {
    const i = src.indexOf(`id: "${FEIN_ID}"`);
    assert.ok(i > 0, `migration ${FEIN_ID} must exist`);
    return src.slice(i, src.indexOf("\n    },", i));
  };
  assert.equal(block(server), block(script));

  const m = MIGRATIONS.find(x => x.id === FEIN_ID);
  assert.doesNotMatch(m.sql, /DROP\s+TABLE|DROP\s+COLUMN/i, "additive only");
  // NULLABLE with no default, and that is the point: a row written before this check ran must not
  // claim either answer. A DEFAULT 0 would assert "this file had no FEIN column" about every
  // period ingested earlier, which is exactly the false certainty the column exists to remove.
  assert.doesNotMatch(m.sql, /has_employer_fein\s+INTEGER\s+NOT NULL|has_employer_fein\s+INTEGER\s+DEFAULT/i,
    "has_employer_fein must be nullable with no default — NULL means 'not checked'");

  const db = new Database(":memory:");
  db.exec(MIGRATIONS.find(x => x.id === ID).sql);
  db.exec(m.sql);
  const col = db.prepare(`SELECT name, "notnull", dflt_value FROM pragma_table_info('lca_source_files')`)
    .all().find(c => c.name === "has_employer_fein");
  assert.ok(col, "lca_source_files must carry has_employer_fein");
  assert.equal(col.notnull, 0);
  assert.equal(col.dflt_value, null);
});

test("the three tables come up clean, and the keys are the ones idempotency depends on", () => {
  const db = new Database(":memory:");
  db.exec(MIGRATIONS.find(x => x.id === ID).sql);
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map(r => r.name);
  assert.deepEqual(tables,
    ["company_lca_sponsorship", "lca_employer_periods", "lca_source_files"]);

  // Re-running must be a no-op, not an error — every table is IF NOT EXISTS.
  db.exec(MIGRATIONS.find(x => x.id === ID).sql);

  // fein is in the primary key, and SQLite allows NULLs in a non-INTEGER primary key — which would
  // silently stop de-duplicating the rows this table exists to de-duplicate. Hence NOT NULL plus a
  // '' sentinel written by the ingester.
  const cols = db.prepare(`SELECT name, "notnull" FROM pragma_table_info('lca_employer_periods')`).all();
  const fein = cols.find(c => c.name === "fein");
  assert.equal(fein.notnull, 1, "fein must be NOT NULL because it is part of the primary key");

  // One row per employer per quarter: a re-import of the same quarter converges instead of doubling.
  const ins = db.prepare(`INSERT INTO lca_employer_periods
    (employer_key, fein, fiscal_period, employer_name, certified) VALUES (?,?,?,?,?)`);
  ins.run("stripe", "47-1849232", "FY2026Q1", "Stripe, Inc.", 41);
  assert.throws(() => ins.run("stripe", "47-1849232", "FY2026Q1", "Stripe, Inc.", 41),
    /UNIQUE constraint failed/);
  // ...and the same employer in a DIFFERENT quarter is a different row, because quarters sum.
  ins.run("stripe", "47-1849232", "FY2025Q4", "Stripe, Inc.", 58);
  assert.equal(db.prepare("SELECT count(*) c FROM lca_employer_periods").get().c, 2);
});

test("company_lca_sponsorship carries provenance, confidence and last_seen like every KB store", () => {
  const db = new Database(":memory:");
  db.exec(MIGRATIONS.find(x => x.id === ID).sql);
  const cols = new Set(db.prepare(
    `SELECT name FROM pragma_table_info('company_lca_sponsorship')`).all().map(r => r.name));
  for (const required of [
    "match_status", "match_confidence", "match_tier", "matched_entities_json", "match_reason",
    "certified_total", "by_period_json", "latest_period", "periods_covered",
    "periods_with_filings", "source", "provenance_json", "first_seen", "last_seen",
  ]) {
    assert.ok(cols.has(required), `company_lca_sponsorship needs ${required}`);
  }
  // periods_covered next to periods_with_filings is what keeps a zero honest: "nothing found in 5
  // quarters" and "nothing found, and we never looked" must not be the same row.
  assert.ok(cols.has("periods_covered") && cols.has("periods_with_filings"));
});
