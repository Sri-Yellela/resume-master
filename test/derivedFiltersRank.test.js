// THE X2 RULE, as a tripwire.
//
//   A filter the USER SET excludes rows.
//   A filter DERIVED on their behalf RANKS rows — it never removes them.
//
// Every board outage in this project has been the same shape: a filter applied BY DEFAULT from the
// profile, narrowing a board the user never asked to narrow. test/unenrichedRowSurvivesBoard.test.js
// guards the NULL half of that (a column enrichment has not filled yet). This file guards the other
// half, which no null escape can reach: a row that HAS a value, and whose value is simply outside a
// window we guessed for it.
//
// Measured before this changed, on the real board (241 rows in reach for the reference profile):
//
//     bucket       kept       why
//     entry        171/241    window ['entry','mid']
//     mid          210/241    window ['mid','senior']
//     senior        51/241    window ['senior','lead']      — inventory is 73% mid
//     lead          10/241    window ['lead','executive']
//     executive      0/241    window ['executive']          — AN EMPTY BOARD
//
// The generality assertion is the important one. Pinning "experience_levels ranks" would be pinning
// today's bug; what has to hold is that NO key the bridge can emit is able to exclude, so the next
// dimension someone teaches it to derive cannot reintroduce this.
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildJobFilters, DERIVED_RANK_ORDER } from "../services/jobs/jobQuery.js";
import { deriveProfileFilters, bucketYearsExperience } from "../services/jobs/profileFilterBridge.js";

const LEVELS = ["intern", "entry", "mid", "senior", "lead", "executive"];

/** One row at every experience level, so a window can never match all of them. */
function db0() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT, source TEXT,
      -- normalized_title and summary are in Q_MATCH_COLUMNS, so the derived q rank reads them.
      normalized_title TEXT, summary TEXT,
      skills_json TEXT, experience_level TEXT,
      is_h1b_sponsor INTEGER, requires_work_auth INTEGER,
      posted_at TEXT, scraped_at INTEGER, is_active INTEGER DEFAULT 1
    );
  `);
  const add = db.prepare(
    `INSERT INTO scraped_jobs (job_id,title,company,source,experience_level,scraped_at,is_active)
     VALUES (?,?,'Acme','ashby',?,1787000000,1)`
  );
  for (const lvl of LEVELS) add.run(`j-${lvl}`, `Software Engineer (${lvl})`, lvl);
  return db;
}

function rows(db, params, opts) {
  const f = buildJobFilters(params, opts);
  const order = f.rank.sql ? `ORDER BY ${f.rank.sql}, sj.job_id` : "ORDER BY sj.job_id";
  return db.prepare(`SELECT sj.job_id FROM scraped_jobs sj WHERE sj.is_active = 1 ${f.sql} ${order}`)
    .all(...f.params, ...(f.rank.sql ? f.rank.params : [])).map(r => r.job_id);
}

// A profile with every signal the bridge reads, so every derivable key is actually derived.
const PROFILE = { target_titles: JSON.stringify(["Software Engineer"]) };
const signalsFor = (years) => ({
  titles: ["Software Engineer"],
  searchTerms: ["platform"],
  skills: ["Python", "Kubernetes"],
  yearsExperience: years,
  structuredFacts: { requiresSponsorship: true },
});

// ── Generality: the bridge has no way to exclude anything ────────────────────────────────────

test("every key deriveProfileFilters can emit is a RANKING key, not a filtering key", () => {
  // The set the bridge can produce, taken from the bridge rather than from a hand-written list, so
  // teaching it a new dimension fails this test until that dimension is given a rank expression.
  const emitted = new Set();
  for (const years of [0.5, 3, 6, 10, 20]) {
    for (const k of Object.keys(deriveProfileFilters(PROFILE, signalsFor(years)))) emitted.add(k);
  }
  assert.ok(emitted.size >= 4, "the bridge stopped deriving things — this test would pass vacuously");

  for (const key of emitted) {
    assert.ok(DERIVED_RANK_ORDER.includes(key),
      `deriveProfileFilters emits "${key}", which buildJobFilters would apply as a HARD FILTER. ` +
      `Every derived dimension must rank instead — add it to DERIVED_RANK_ORDER with a rank ` +
      `expression, or stop deriving it.`);
  }
});

test("a derived key produces a rank expression and NO where clause; an explicit one is the reverse", () => {
  const derived = deriveProfileFilters(PROFILE, signalsFor(3));
  for (const key of Object.keys(derived)) {
    const asDerived = buildJobFilters({ [key]: derived[key] }, { derivedKeys: [key] });
    assert.equal(asDerived.sql, "", `derived ${key} must contribute no WHERE clause`);
    assert.ok(asDerived.rank.sql.length > 0, `derived ${key} must contribute a rank key`);
    assert.deepEqual(asDerived.rankedKeys, [key]);

    const asExplicit = buildJobFilters({ [key]: derived[key] }, { derivedKeys: [] });
    assert.ok(asExplicit.sql.startsWith("AND "), `explicit ${key} must contribute a WHERE clause`);
    assert.equal(asExplicit.rank.sql, "", `explicit ${key} must contribute no rank key`);
    assert.deepEqual(asExplicit.rankedKeys, []);
  }
});

// ── The headline guarantee ───────────────────────────────────────────────────────────────────

test("NO experience bucket loses a single row — including the one that saw an empty board", () => {
  const db = db0();
  const all = rows(db, {}, {}).length;
  assert.equal(all, LEVELS.length);

  for (const years of [0.5, 3, 6, 10, 15, 20, 40]) {
    const derived = deriveProfileFilters(PROFILE, signalsFor(years));
    const kept = rows(db, derived, { derivedKeys: Object.keys(derived) });
    assert.equal(kept.length, all,
      `${years} years (bucket ${bucketYearsExperience(years)}) lost ${all - kept.length} of ${all} rows`);
  }
});

test("a 15-year profile sees jobs, and sees its own band first", () => {
  const db = db0();
  const derived = deriveProfileFilters(PROFILE, signalsFor(15));
  assert.equal(bucketYearsExperience(15), "executive");
  assert.deepEqual(derived.experience_levels, ["lead", "executive"]);

  const kept = rows(db, derived, { derivedKeys: Object.keys(derived) });
  assert.equal(kept.length, LEVELS.length, "an executive profile must not see an empty board");
  // The band leads; everything else follows, in the order the tie-break gives.
  assert.deepEqual(kept.slice(0, 2), ["j-executive", "j-lead"]);
  assert.ok(!kept.slice(0, 2).includes("j-intern"), "an out-of-band level must not lead");
});

test("in-band before unknown before out-of-band, on the dimension that has all three states", () => {
  const db = db0();
  // skills_json: one match, one mismatch, the rest NULL — the three-valued rank in one query.
  db.prepare("UPDATE scraped_jobs SET skills_json = ? WHERE job_id = 'j-mid'").run('["Python"]');
  db.prepare("UPDATE scraped_jobs SET skills_json = ? WHERE job_id = 'j-lead'").run('["COBOL"]');

  const kept = rows(db, { skills_include: ["Python"] }, { derivedKeys: ["skills_include"] });
  assert.equal(kept.length, LEVELS.length, "ranking must not drop the mismatch");
  assert.equal(kept[0], "j-mid", "the match leads");
  assert.equal(kept[kept.length - 1], "j-lead", "the explicit mismatch is last");
});

// ── The other half of the rule ───────────────────────────────────────────────────────────────

test("explicit filters keep their teeth, including the power to empty the board", () => {
  const db = db0();
  // This is not a bug: the user asked for exactly this. The rule protects people from OUR guesses,
  // not from their own instructions.
  assert.deepEqual(rows(db, { experience_levels: ["executive"] }, { derivedKeys: [] }), ["j-executive"]);
  assert.deepEqual(rows(db, { companies_include: ["Nobody"] }, { derivedKeys: [] }), []);
});

test("provenance comes from the caller — buildJobFilters never guesses which keys were derived", () => {
  // The merge point is the only place that knows, and it must be the only place that decides. With
  // no opts at all every key filters, which is what non-board callers (routes/adminDb.js's board
  // explainer) still want.
  const params = { experience_levels: ["executive"] };
  assert.match(buildJobFilters(params).sql, /experience_level/);
  assert.equal(buildJobFilters(params).rank.sql, "");
  assert.equal(buildJobFilters(params, { derivedKeys: ["experience_levels"] }).sql, "");
});
