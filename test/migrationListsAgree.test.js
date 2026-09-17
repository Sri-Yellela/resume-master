// THERE ARE TWO MIGRATION LISTS AND THEY MUST NOT DRIFT.
//
// `server.js` carries an INLINE `const MIGRATIONS = [...]`, and its loop is what actually runs at
// boot. `scripts/migrations.js` exports a second copy, which `scripts/migration.js` reads. They are
// duplicates of each other, and nothing checked that.
//
// The failure is asymmetric and both directions are silent:
//
//   added only to scripts/migrations.js  -> NEVER RUNS IN PRODUCTION. The column does not exist,
//                                           and every read of it fails at runtime rather than at
//                                           boot. Task Y phase 2 nearly shipped exactly this: 107
//                                           was written to scripts/migrations.js first, and the
//                                           detail-fetch pass would have been permanently inert
//                                           behind its own "migration not applied" guard, which
//                                           degrades quietly BY DESIGN.
//   added only to server.js              -> the standalone tool cannot reproduce the schema, so a
//                                           fixture DB and production disagree about what exists.
//
// This test does not compare the SQL — the two copies differ in comments, and requiring byte
// equality would be a test about formatting. It compares the ID SETS, which is the thing that
// decides whether a migration runs.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { MIGRATIONS } from "../scripts/migrations.js";

/** The ids inside server.js's inline list, sliced to that array and no other part of the file. */
function serverMigrationIds() {
  const src = fs.readFileSync(path.join(process.cwd(), "server.js"), "utf8");
  const start = src.indexOf("const MIGRATIONS = [");
  assert.ok(start > 0, "server.js no longer declares an inline `const MIGRATIONS = [` — if the " +
                       "duplication was removed, delete this test rather than loosening it");
  // The list ends where the runner begins. Anchoring on the runner rather than on a brace count
  // keeps this immune to the SQL template literals inside the array.
  const end = src.indexOf('console.log("[boot] migrations', start);
  assert.ok(end > start, "could not find the boot migration runner after the list");
  const block = src.slice(start, end);
  return [...block.matchAll(/^\s*id:\s*["']([^"']+)["']/gm)].map(m => m[1]);
}

test("both migration lists contain exactly the same ids", () => {
  const fromServer = serverMigrationIds();
  const fromScript = MIGRATIONS.map(m => m.id);

  const onlyInServer = fromServer.filter(id => !fromScript.includes(id));
  const onlyInScript = fromScript.filter(id => !fromServer.includes(id));

  assert.deepEqual(onlyInServer, [],
    "these migrations run at boot but are MISSING from scripts/migrations.js, so the standalone " +
    "tool cannot reproduce the schema: " + onlyInServer.join(", "));
  assert.deepEqual(onlyInScript, [],
    "these migrations are in scripts/migrations.js but NOT in server.js's inline list, so they " +
    "WILL NEVER RUN in production: " + onlyInScript.join(", "));
});

test("the lists apply migrations in the same order", () => {
  // Order matters for real: 107 ALTERs a table that earlier migrations create, and two lists that
  // agree on membership but not sequence would still build different schemas.
  assert.deepEqual(serverMigrationIds(), MIGRATIONS.map(m => m.id));
});

test("107 is present, because the detail fetch is INERT without it", () => {
  // Not a tautology given the above: this names the specific migration whose absence makes
  // fillMissingDescriptions return `reason: 'migration_107_missing'` and do nothing at all —
  // quietly, by design, because a background observability step must never break the work it
  // observes. A quiet no-op is the right degradation and the wrong thing to ship unnoticed.
  const id = "107_detail_fetch_bookkeeping";
  assert.ok(serverMigrationIds().includes(id), `${id} missing from server.js's runner`);
  assert.ok(MIGRATIONS.some(m => m.id === id), `${id} missing from scripts/migrations.js`);

  const sql = MIGRATIONS.find(m => m.id === id).sql;
  for (const col of ["detail_fetched_at", "detail_fetch_attempts", "detail_fetch_error"]) {
    assert.match(sql, new RegExp(`ADD COLUMN\\s+${col}\\b`), `107 must add ${col}`);
  }
  // ⛔ The one thing 107 must never do.
  assert.doesNotMatch(sql, /content_hash|enriched_at/,
    "107 must not touch content_hash or enriched_at — they are the only 'this row is done' " +
    "signals and the detail fetch is not allowed to write them");
});
