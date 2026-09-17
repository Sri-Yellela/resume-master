// CC2 — the bridge's skill matching rule, and the '[]' MISS.
//
// These run the REAL SQL against a real in-memory SQLite, because the whole defect was a SQL
// matching rule: a test that asserted the generated string would have passed over `'%"api"%'`
// matching nothing, which is exactly what shipped. So every case below binds the predicate and
// asks the database.

import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildJobFilters } from "../services/jobs/jobQuery.js";

/** A board holding exactly the rows a case needs, and the real predicate run over it. */
function boardWith(skillsValues) {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE scraped_jobs (
    job_id TEXT PRIMARY KEY, title TEXT, company TEXT, skills_json TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    experience_level TEXT, workplace_type TEXT, is_h1b_sponsor INTEGER, requires_work_auth INTEGER
  );`);
  const ins = db.prepare("INSERT INTO scraped_jobs (job_id, title, skills_json) VALUES (?, 'T', ?)");
  skillsValues.forEach((v, i) => ins.run(`j${i}`, v));
  return db;
}

/** The rank value the derived dimension assigns each row: 0 match, 1 unknown, 2 miss. */
function ranks(db, skills) {
  const f = buildJobFilters({ skills_include: skills }, { derivedKeys: ["skills_include"] });
  const key = f.rank.keys.find(k => /skills_json/.test(k.sql));
  assert.ok(key, "skills_include must produce a rank key");
  return db.prepare(
    `SELECT job_id, (${key.sql}) AS r FROM scraped_jobs sj ORDER BY job_id`
  ).all(...key.params).map(r => r.r);
}

/** Whether each row survives the EXPLICIT (non-derived) filter. */
function kept(db, skills) {
  const f = buildJobFilters({ skills_include: skills }, { derivedKeys: [] });
  return db.prepare(
    `SELECT job_id FROM scraped_jobs sj WHERE sj.is_active = 1 ${f.sql} ORDER BY job_id`
  ).all(...f.params).map(r => r.job_id);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// ⛔ REQUIREMENT 4 — THE '[]' BUG, ASSERTED IN BOTH DIRECTIONS
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("'[]' ranks UNKNOWN, not MISS — an empty extraction is not a mismatch", () => {
  // The rank read `WHEN sj.skills_json IS NULL THEN RANK_UNKNOWN`, so '[]' fell through to
  // RANK_MISS: a row whose enrichment RAN and legitimately found no skills was ranked as an
  // EXPLICIT mismatch. Fifth NULL-propagation shape in this codebase, second in the
  // "unknown treated as mismatch" direction.
  const db = boardWith([
    null,                       // j0 never enriched      -> UNKNOWN
    "[]",                       // j1 enriched, no skills -> UNKNOWN (was MISS)
    '["python"]',               // j2 matches             -> MATCH
    '["cobol"]',                // j3 explicit mismatch   -> MISS
  ]);
  assert.deepEqual(ranks(db, ["python"]), [1, 1, 0, 2]);
});

test("NULL still ranks UNKNOWN — the other direction, so the fix cannot invert", () => {
  // Asserting only '[]' would let a change that mapped NULL to MATCH pass. Both states are
  // pinned, and they are pinned to the SAME value because they are the same claim.
  const db = boardWith([null, "[]"]);
  assert.deepEqual(ranks(db, ["python"]), [1, 1]);
});

test("whitespace spellings of empty count as unknown too", () => {
  // JSON.stringify emits '[]', but an importer or a hand edit can emit '[ ]'. A guard that
  // catches one spelling of empty is wrong the first time the other appears.
  const db = boardWith(["[]", "[ ]", "[\t]"]);
  assert.deepEqual(ranks(db, ["python"]), [1, 1, 1]);
});

test("an EXPLICIT skills filter also treats '[]' as unknown, so the two paths agree", () => {
  // The derived rank and the explicit filter must not disagree about what "unknown" means — a row
  // ranked as a mismatch on one path and kept on the other is invisible to both tests and to the
  // user. Explicit still EXCLUDES a real mismatch; it just does not delete skill-less rows.
  const db = boardWith([null, "[]", '["python"]', '["cobol"]']);
  assert.deepEqual(kept(db, ["python"]), ["j0", "j1", "j2"]);
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// ⛔ REQUIREMENT 1 — A TERM INSIDE A MULTI-WORD VALUE, WITHOUT AG1's SUBSTRING DEFECT
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("a term matches as a WHOLE WORD inside a multi-word skill value", () => {
  // The rule was whole-VALUE equality, so "api" matched nothing on a board holding 33 values that
  // mention it. 85% of this board's 4,775 distinct skill values are multi-word.
  const db = boardWith([
    '["api"]',                      // exact value
    '["stripe api"]',               // ends with it
    '["api design patterns"]',      // starts with it
    '["public api gateway"]',       // in the middle
    '[{"skill":"API Design","type":"hard"}]', // the object shape, and case-insensitively
  ]);
  assert.deepEqual(ranks(db, ["api"]), [0, 0, 0, 0, 0]);
});

test("⛔ THE COFFEE MACHINE — AG1's guardrail, run as the brief requires", () => {
  // AG1's defect: a résumé reading "I design learning materials for a coffee machine vendor" was
  // credited with MACHINE LEARNING, and that artifact was 22.8% of all multi-word matches. Bounded
  // proximity at window 1 fixed it; at window 3 it came back.
  //
  // ⛔ NOTE WHAT IS MATCHED HERE, because it is the reason this rule can be simpler than the
  // scorer's: the bridge matches `skills_json`, a list of ALREADY-EXTRACTED skill phrases, not free
  // prose. The prose case is run anyway — if a future change ever points this rule at a
  // description column, this test is what fails.
  const db = boardWith([
    '["I design learning materials for a coffee machine vendor"]',
    '["machine learning pipelines"]',
  ]);
  assert.deepEqual(ranks(db, ["machine learning"]), [2, 0],
    "the coffee prose must be a MISS and the real skill a MATCH");
});

test("the substring false positives this vocabulary actually contains are rejected", () => {
  // Every one of these is a real value from the board, and every one would be a false positive
  // under `LIKE '%term%'` — the obvious fix. Measured: '%api%' credits "stripe capital knowledge"
  // (c-API-tal), '%java%' credits "javascript", '%sql%' credits "postgresql".
  for (const [term, value] of [
    ["java", '["javascript"]'],
    ["api",  '["stripe capital knowledge"]'],
    ["sql",  '["postgresql"]'],
    ["sql",  '["mysql"]'],
  ]) {
    const db = boardWith([value]);
    assert.deepEqual(ranks(db, [term]), [2], `"${term}" must NOT match ${value}`);
  }
});

test("a term cannot be assembled across two adjacent values", () => {
  // ⛔ THIS IS WHAT THE COMPACT-JSON ASSUMPTION BUYS. `% term %` is safe only because
  // JSON.stringify emits no space around its commas, so a space occurs only INSIDE a value. A
  // pretty-printing writer would break it, and this is the test that would fail.
  const db = boardWith(['["machine","learning"]', '["machine", "learning"]']);
  const r = ranks(db, ["machine learning"]);
  assert.equal(r[0], 2, "compact: two separate values must not combine");
  assert.equal(r[1], 2,
    "and even a space-after-comma spelling must not combine — if this fails, a writer started " +
    "pretty-printing skills_json and the rule needs the stored side normalised");
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// REQUIREMENT 2 — the scorer's normaliser, reused rather than re-implemented
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("both the raw and the normalised spelling of a term are tried", () => {
  // normaliseAtsTerm("CI/CD") is "ci cd". Neither spelling alone reaches both stored forms, and
  // picking one would mean the bridge and the scorer disagreed about the same term.
  const raw = boardWith(['["ci/cd tooling"]']);
  assert.deepEqual(ranks(raw, ["CI/CD"]), [0], "the RAW spelling must reach a stored 'ci/cd …'");
  const norm = boardWith(['["ci cd tooling"]']);
  assert.deepEqual(ranks(norm, ["CI/CD"]), [0], "the NORMALISED spelling must reach a stored 'ci cd …'");
});

test("a term the normaliser empties contributes nothing, and never matches everything", () => {
  // ⛔ THE DIRECTION THAT MATTERS. An unusable term list must yield NO opinion, not a predicate
  // that is true for every row — the latter would silently turn the dimension off while looking
  // like it worked.
  const db = boardWith(['["python"]', '["cobol"]']);
  assert.deepEqual(ranks(db, ["+++"]), [2, 2], "no usable spelling means nothing matches");
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// skills_exclude — the same two corrections, wearing a negation
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("skills_exclude excludes on a whole-word mention, and keeps the skill-less", () => {
  // "do not show me api roles" has to exclude the values that MENTION api, not only the one value
  // that IS api — otherwise it is the same whole-value defect with the sign flipped.
  const db = boardWith([
    null,                       // j0 unknown        -> kept
    "[]",                       // j1 unknown        -> kept
    '["api"]',                  // j2 exact          -> excluded
    '["stripe api"]',           // j3 mentions it    -> excluded
    '["stripe capital"]',       // j4 substring only -> KEPT (not a mention)
    '["python"]',               // j5 unrelated      -> kept
  ]);
  const f = buildJobFilters({ skills_exclude: ["api"] }, { derivedKeys: [] });
  const keptIds = db.prepare(
    `SELECT job_id FROM scraped_jobs sj WHERE sj.is_active = 1 ${f.sql} ORDER BY job_id`
  ).all(...f.params).map(r => r.job_id);
  assert.deepEqual(keptIds, ["j0", "j1", "j4", "j5"]);
});
