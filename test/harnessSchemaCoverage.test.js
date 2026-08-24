// A HARNESS FIXTURE THAT DRIFTS FROM THE SCHEMA DIES SILENTLY MID-RUN.
//
// scripts/g1GatePacket.mjs stopped working and nobody noticed. It builds an in-memory database by
// hand and mounts the REAL routes/apply.js against it, and a later migration added
// `apply_run_jobs.hidden_at` (the AD1 soft-delete work). routes/apply.js started selecting
// `rj.hidden_at`; g1's hand-rolled table never gained the column; the route threw
// `SqliteError: no such column`, the harness crashed at check 4 of ~42, and its exit code was the
// only sign. Roughly 38 assertions — the whole token lifecycle, the per-account isolation, the
// gated-list separation — stopped running at whatever point that migration landed.
//
// Ten harnesses hand-roll `apply_run_jobs` and mount those routes. ALL TEN were missing the same
// seven columns. Only g1 crashed, because only g1 happened to call the endpoint that reads one of
// them; the other nine were one route change away from the same thing.
//
// WHY THIS TEST IS NARROW ON PURPOSE
// The obvious rule — "a hand-rolled table must declare every production column" — is wrong. These
// fixtures declare a 6-column `scraped_jobs` against a 60-column production table deliberately,
// because a fixture is a minimal world, not a mirror. Demanding parity there produces 76 findings
// that are all noise, and a test that cries wolf gets deleted.
//
// The real risk is specific: a column the REAL ROUTES READ, on a table the harness SUPPLIES. That
// is exactly what `hidden_at` was. So this checks the intersection, and nothing else.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const stripSqlComments = (s) => s.replace(/--[^\n]*/g, "");

/** Column names declared by a CREATE TABLE statement, ignoring table constraints. */
function declaredColumns(stmt) {
  const clean = stripSqlComments(stmt);
  const body = clean.slice(clean.indexOf("(") + 1, clean.lastIndexOf(")"));
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  return new Set(parts.map(s => s.trim()).filter(Boolean)
    .filter(s => !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(s))
    .map(s => s.split(/\s+/)[0])
    .filter(n => /^\w+$/.test(n)));
}

/** The CREATE TABLE statement for `table` in `src`, brace-balanced, or null. */
function createStatement(src, table) {
  const clean = stripSqlComments(src);
  const re = new RegExp("CREATE TABLE(?: IF NOT EXISTS)? " + table + "\\s*\\(", "i");
  const m = re.exec(clean);
  if (!m) return null;
  let depth = 0, j = clean.indexOf("(", m.index);
  for (; j < clean.length; j++) {
    if (clean[j] === "(") depth++;
    else if (clean[j] === ")") { depth--; if (depth === 0) { j++; break; } }
  }
  return clean.slice(m.index, j);
}

/** Everything a harness supplies for `table`: its CREATE plus any ALTERs it applies itself. */
function harnessColumns(src, table) {
  const stmt = createStatement(src, table);
  if (!stmt) return null;
  const cols = declaredColumns(stmt);
  for (const m of stripSqlComments(src).matchAll(new RegExp("ALTER TABLE " + table + " ADD COLUMN (\\w+)", "g"))) {
    cols.add(m[1]);
  }
  // A harness may import and exec a REAL migration instead of hand-rolling — and then it must NOT
  // also declare the column, or the migration's ALTER is a duplicate and the harness dies before
  // its first assertion. (That is not hypothetical: adding gate_review_json to these four
  // CREATEs is exactly how g3/g4/g5/ab1 were broken while fixing g1.) So migration-applied columns
  // are credited here, and the two spellings both count: g1 uses `m.id === "079_…"`, the others
  // loop `for (const id of ['079_…', '080_…'])`.
  if (/MIGRATIONS/.test(src)) {
    const migrations = fs.readFileSync("scripts/migrations.js", "utf8");
    const ids = new Set();
    for (const m of src.matchAll(/m\.id === ["']([^"']+)["']/g)) ids.add(m[1]);
    for (const m of src.matchAll(/\bof\s*\[([^\]]+)\]/g)) {
      for (const q of m[1].matchAll(/["']([0-9]{3}_[A-Za-z0-9_]+)["']/g)) ids.add(q[1]);
    }
    for (const id of ids) {
      const block = migrations.slice(migrations.indexOf(`id: "${id}"`));
      const stop = block.indexOf("\n    },");
      const sql = stop === -1 ? block : block.slice(0, stop);
      const created = createStatement(sql, table);
      if (created) for (const c of declaredColumns(created)) cols.add(c);
      for (const a of sql.matchAll(new RegExp("ALTER TABLE " + table + " ADD COLUMN (\\w+)", "g"))) cols.add(a[1]);
    }
  }
  return cols;
}

/**
 * Columns routes/apply.js reads or writes on `table`.
 *
 * Read from the SQL rather than guessed: the alias the route binds in FROM/JOIN, then every
 * `alias.column` reference, plus explicit INSERT column lists and UPDATE ... SET targets. Missing a
 * few exotic references is acceptable — the test only needs to be a floor, and `hidden_at` is
 * squarely inside it.
 */
function columnsRoutesUse(routeSrc, table) {
  const used = new Set();
  const aliases = new Set();
  for (const m of routeSrc.matchAll(new RegExp("(?:FROM|JOIN)\\s+" + table + "\\s+(?:AS\\s+)?(\\w+)", "gi"))) {
    if (!/^(on|where|set|values|group|order|limit)$/i.test(m[1])) aliases.add(m[1]);
  }
  for (const a of aliases) {
    for (const m of routeSrc.matchAll(new RegExp("\\b" + a + "\\.(\\w+)", "g"))) used.add(m[1]);
  }
  for (const m of routeSrc.matchAll(new RegExp("INSERT INTO " + table + "\\s*\\(([^)]*)\\)", "gi"))) {
    for (const c of m[1].split(",")) {
      const n = c.trim();
      if (/^\w+$/.test(n)) used.add(n);
    }
  }
  for (const m of routeSrc.matchAll(new RegExp("UPDATE " + table + "\\s+SET\\s+([\\s\\S]{0,400}?)(?:WHERE|$)", "gi"))) {
    for (const pair of m[1].split(",")) {
      const n = (pair.split("=")[0] || "").trim();
      if (/^\w+$/.test(n)) used.add(n);
    }
  }
  return used;
}

/** Migration ids a harness applies itself, in either spelling used across these files. */
function migrationIdsApplied(src) {
  const ids = new Set();
  if (!/MIGRATIONS/.test(src)) return ids;
  for (const m of src.matchAll(/m\.id === ["']([^"']+)["']/g)) ids.add(m[1]);
  for (const m of src.matchAll(/\bof\s*\[([^\]]+)\]/g)) {
    for (const q of m[1].matchAll(/["']([0-9]{3}_[A-Za-z0-9_]+)["']/g)) ids.add(q[1]);
  }
  return ids;
}

/** Columns those migrations ADD to `table`. Declaring one of these too is a duplicate-column crash. */
function migrationAddedColumns(src, table) {
  const migrations = fs.readFileSync("scripts/migrations.js", "utf8");
  const added = new Set();
  for (const id of migrationIdsApplied(src)) {
    const block = migrations.slice(migrations.indexOf(`id: "${id}"`));
    const stop = block.indexOf("\n    },");
    const sql = stop === -1 ? block : block.slice(0, stop);
    for (const a of sql.matchAll(new RegExp("ALTER TABLE " + table + " ADD COLUMN (\\w+)", "g"))) added.add(a[1]);
  }
  return added;
}

/**
 * The production column set for `table`, from the migrations — never from a developer's database.
 *
 * Used to INTERSECT with what the routes appear to reference, which is what makes the extractor
 * above safe to be naive. Aliases are reused across statements in routes/apply.js (`r` is
 * apply_runs in one query and apply_run_jobs in another) and the SELECT lists rename columns
 * (`sj.company AS sj_company`), so a file-wide `alias.column` sweep picks up names that belong to
 * other tables. Keeping only names the table REALLY HAS drops every one of those by construction,
 * and cannot drop a genuine finding: `hidden_at` is a real column, which is why it was a real bug.
 */
function productionColumns(table) {
  const src = fs.readFileSync("server.js", "utf8") + "\n" + fs.readFileSync("scripts/migrations.js", "utf8");
  const stmt = createStatement(src, table);
  const cols = stmt ? declaredColumns(stmt) : new Set();
  for (const m of stripSqlComments(src).matchAll(new RegExp("ALTER TABLE " + table + " ADD COLUMN (\\w+)", "g"))) {
    cols.add(m[1]);
  }
  return cols;
}

/** What the routes read, restricted to columns the table actually has. */
function requiredColumns(routeSrc, table) {
  const prod = productionColumns(table);
  return [...columnsRoutesUse(routeSrc, table)].filter(c => prod.has(c)).sort();
}

const APPLY_TABLES = ["apply_run_jobs", "apply_runs", "apply_gate_packets", "apply_job_logs"];
const routeSrc = fs.readFileSync("routes/apply.js", "utf8");
const harnesses = fs.readdirSync("scripts")
  .filter(f => /\.mjs$/.test(f))
  .filter(f => /applyRoutes|routes\/apply\.js/.test(fs.readFileSync(path.join("scripts", f), "utf8")));

test("the harnesses that mount the real apply routes are discoverable", () => {
  // If this drops to zero the rest of the file passes vacuously, which is the failure mode a
  // coverage test most easily hides behind.
  assert.ok(harnesses.length >= 8,
    `expected the apply-route harnesses to be found, got ${harnesses.length}: ${harnesses.join(" ")}`);
});

test("routes/apply.js really does read the column that broke g1", () => {
  // Anchors the extractor. If this stops matching, the check below has quietly stopped checking.
  const used = columnsRoutesUse(routeSrc, "apply_run_jobs");
  assert.ok(used.has("hidden_at"),
    "the extractor no longer sees rj.hidden_at — it would not have caught the original defect");
  assert.ok(used.size >= 10, `only ${used.size} columns extracted: ${[...used].join(" ")}`);
});

for (const table of APPLY_TABLES) {
  const required = requiredColumns(routeSrc, table);
  if (!required.length) continue;
  test(`every harness supplying ${table} declares the columns routes/apply.js reads`, () => {
    const failures = [];
    for (const f of harnesses) {
      const src = fs.readFileSync(path.join("scripts", f), "utf8");
      const have = harnessColumns(src, table);
      if (!have) continue;                       // this harness does not supply the table at all
      const missing = required.filter(c => !have.has(c));
      if (missing.length) failures.push(`  ${f}: ${missing.join(" ")}`);
    }
    assert.deepEqual(failures, [],
      `these harnesses would throw "no such column" the moment they hit a route that reads it:\n` +
      failures.join("\n"));
  });
}

// ── THE OTHER DIRECTION, and it bit while fixing the first one ───────────────
//
// Adding a missing column is only safe if the harness is not ALREADY getting it from a migration it
// applies. Four harnesses (g3, g4, g5, ab1) exec 080_apply_gate_review, which ALTERs
// `gate_review_json` in. Declaring it in their CREATE as well made the ALTER throw
// `duplicate column name` — and each one died BEFORE ITS FIRST ASSERTION while still exiting
// non-zero with a clean-looking log. That is the same silent-truncation shape as the original g1
// defect, caused by the fix for it. Both directions are now guarded, because only checking for
// missing columns is what let this through.
test("no harness declares a column the migration it applies will ADD", () => {
  const collisions = [];
  for (const f of harnesses) {
    const src = fs.readFileSync(path.join("scripts", f), "utf8");
    for (const table of APPLY_TABLES) {
      const stmt = createStatement(src, table);
      if (!stmt) continue;
      const declared = declaredColumns(stmt);
      const added = migrationAddedColumns(src, table);
      const dupes = [...added].filter(c => declared.has(c)).sort();
      if (dupes.length) collisions.push(`  ${f} / ${table}: ${dupes.join(" ")}`);
    }
  }
  assert.deepEqual(collisions, [],
    "these harnesses would throw \"duplicate column name\" before their first assertion:\n" +
    collisions.join("\n"));
});

test("the collision detector sees a real collision", () => {
  // Same reasoning as the positive control below: a guard that cannot fail is not a guard. g3 really
  // does apply 080, so re-adding the column to a copy of its schema must be reported.
  const g3 = fs.readFileSync("scripts/g3ReviewOverlay.mjs", "utf8");
  const added = migrationAddedColumns(g3, "apply_run_jobs");
  assert.ok(added.has("gate_review_json"),
    "g3 must still be applying the migration that adds gate_review_json");
  // Injected into the apply_run_jobs statement ITSELF, not the whole file — `scraped_jobs` also has
  // an `ats_score INTEGER` column and appears first, so a file-wide replace lands in the wrong table
  // and the synthetic break silently does nothing.
  const stmt = createStatement(g3, "apply_run_jobs");
  const reBroken = stmt.replace(/\bats_score INTEGER,/, "ats_score INTEGER, gate_review_json TEXT,");
  assert.notEqual(reBroken, stmt, "the injection point must exist");
  const declared = declaredColumns(reBroken);
  assert.ok(declared.has("gate_review_json"), "the synthetic re-break must declare it");
  assert.ok([...added].some(c => declared.has(c)), "and the detector must flag the overlap");
});

// ── POSITIVE CONTROL ─────────────────────────────────────────────────────────
//
// A coverage test that cannot fail is worse than none, and this one is especially prone to it: it
// passes if the extractor breaks, if the harness list empties, or if the intersection over-narrows.
// So the detection is exercised against a schema that is deliberately missing the column, rather
// than trusted because the real ones happen to pass.
test("THE DETECTION WORKS — a fixture missing hidden_at is reported", () => {
  const complete = `db.exec(\`
    CREATE TABLE apply_run_jobs (id INTEGER PRIMARY KEY, run_id INTEGER, user_id INTEGER,
      job_id TEXT, status TEXT, reason_code TEXT, hidden_at INTEGER);\`);`;
  const broken = complete.replace(", hidden_at INTEGER", "");

  const required = requiredColumns(routeSrc, "apply_run_jobs");
  assert.ok(required.includes("hidden_at"), "the column that caused the defect must be required");

  const missingFrom = (src) => required.filter(c => !harnessColumns(src, "apply_run_jobs").has(c));
  assert.ok(missingFrom(broken).includes("hidden_at"),
    "a fixture without hidden_at must be reported — this is the g1 case exactly");
  assert.ok(!missingFrom(complete).includes("hidden_at"),
    "and a fixture with it must not be");
});

test("a harness that hand-rolls nothing is not silently credited", () => {
  // harnessColumns returns null for a harness that does not declare the table, and the loop above
  // `continue`s on that. If it ever returned an empty set instead, every such harness would be
  // reported with the full column list and the signal would drown.
  assert.equal(harnessColumns("// no schema here", "apply_run_jobs"), null);
});
