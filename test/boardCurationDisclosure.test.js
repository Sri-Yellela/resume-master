// A board ordered by the profile must SAY it is ordered — and must not claim rows are missing.
//
// The Profile→Board Bridge derives q, skills_include, experience_levels and sponsorship_friendly
// from the active profile and applies them BY DEFAULT to any dimension the user did not set. Two
// passes have now changed what that means:
//
//   Y-era: the derived keys EXCLUDED, silently. A row the bridge dropped looked exactly like a row
//          that did not exist. That is how an imported Quora posting stayed "missing" through two
//          rounds of fixes — present, is_active=1, bucketed 'engineering', and returned only by
//          ?curate=off, because it is a New Grad req (experience_level='entry') against a 3-years
//          profile whose window was ['mid','senior']. The fix then was disclosure: "Showing N of M".
//
//   X2:    the derived keys RANK. A filter the USER SET excludes rows; a filter DERIVED on their
//          behalf orders them and never removes them. Measured on the real board, the old regime
//          kept 171/210/51/10/0 of 241 rows for entry/mid/senior/lead/executive — an executive saw
//          an EMPTY BOARD — because the inventory is bottom-heavy (mid 175, senior 45, lead 12,
//          intern 5, entry 4) and the window only ever widened upward. All five keep 241 now.
//
// So the disclosure contract inverts: there is no withheld remainder to report, and the number that
// matters is how many rows were pushed DOWN. These tests pin that, and pin that explicit filters
// kept their teeth.
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildJobFilters } from "../services/jobs/jobQuery.js";
import { deriveProfileFilters } from "../services/jobs/profileFilterBridge.js";

function db0() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT, source TEXT,
      normalized_title TEXT, summary TEXT, skills_json TEXT,
      experience_level TEXT, workplace_type TEXT, employment_type TEXT,
      salary_min_usd INTEGER, salary_max_usd INTEGER,
      is_h1b_sponsor INTEGER, requires_work_auth INTEGER,
      posted_at TEXT, scraped_at INTEGER, is_active INTEGER DEFAULT 1
    );
  `);
  const add = db.prepare(
    `INSERT INTO scraped_jobs (job_id,title,company,source,experience_level,scraped_at,is_active)
     VALUES (?,?,?,'ashby',?,1787000000,1)`
  );
  // The reported posting, one row at each level around it, and one clearly out of band.
  add.run("j-quora", "Software Engineer, Machine Learning Platform, New Grad - Quora (Remote)", "Quora", "entry");
  add.run("j-mid",   "Software Engineer, Platform",                                             "Acme",  "mid");
  add.run("j-senior","Senior Software Engineer, Platform",                                      "Acme",  "senior");
  add.run("j-exec",  "VP of Software Engineering",                                              "Acme",  "executive");
  return db;
}

const PROFILE = { target_titles: JSON.stringify(["Software Engineer"]) };
const SIGNALS = { titles: [], searchTerms: [], skills: [], yearsExperience: 3, structuredFacts: {} };
// Every key the bridge can emit. server.js passes its own appliedDerivedKeys; these tests pass the
// full set because everything in `derived` here did in fact come from the bridge.
const DERIVED = ["q", "skills_include", "experience_levels", "sponsorship_friendly"];

/** Rows the board returns, in ranked order — the real fragment against real SQLite. */
function board(db, params, opts) {
  const f = buildJobFilters(params, opts);
  const order = f.rank.sql ? `ORDER BY ${f.rank.sql}, sj.job_id` : "ORDER BY sj.job_id";
  return db.prepare(`SELECT sj.job_id FROM scraped_jobs sj WHERE sj.is_active = 1 ${f.sql} ${order}`)
    .all(...f.params, ...(f.rank.sql ? f.rank.params : [])).map(r => r.job_id);
}
/** What the banner reports: rows explicitly outside a derived window. */
function demoted(db, params, opts) {
  const f = buildJobFilters(params, opts);
  if (!f.rank.demotedSql) return 0;
  return db.prepare(
    `SELECT COUNT(*) AS n FROM scraped_jobs sj WHERE sj.is_active = 1 ${f.sql} AND ${f.rank.demotedSql}`
  ).get(...f.params, ...f.rank.demotedParams).n;
}

// ── The rule ─────────────────────────────────────────────────────────────────────────────────

test("a DERIVED experience window keeps every row — the entry-level posting is back on the board", () => {
  const db = db0();
  const derived = deriveProfileFilters(PROFILE, SIGNALS);
  // 3 years -> 'mid', banded one level either way. 'entry' being IN band now is a separate
  // improvement; the guarantee under test is that even the OUT-of-band row survives.
  assert.deepEqual(derived.experience_levels, ["entry", "mid", "senior"]);

  const rows = board(db, derived, { derivedKeys: DERIVED });
  assert.equal(rows.length, 4, "a derived filter must never remove a row");
  assert.ok(rows.includes("j-quora"), "the reported posting is present, not hidden");
  assert.ok(rows.includes("j-exec"), "even a row outside the band is present");
});

test("in-band rows sort ABOVE out-of-band rows, which is where the narrowing went", () => {
  const db = db0();
  const derived = deriveProfileFilters(PROFILE, SIGNALS);
  const rows = board(db, derived, { derivedKeys: DERIVED });
  // entry/mid/senior are in band and tie at rank 0, so job_id breaks the tie among them;
  // executive is two steps away and is the only row at rank 2.
  assert.deepEqual(rows, ["j-mid", "j-quora", "j-senior", "j-exec"]);
  assert.equal(rows[rows.length - 1], "j-exec", "the out-of-band row must be last, not absent");
});

test("`demoted` counts exactly the rows the old `hidden` deleted", () => {
  const db = db0();
  const derived = deriveProfileFilters(PROFILE, SIGNALS);
  assert.equal(demoted(db, derived, { derivedKeys: DERIVED }), 1, "j-exec alone is out of band");
  // The same params WITHOUT provenance still exclude — that is the old behaviour, and the row the
  // old count called "hidden" is the same one the new count calls "demoted".
  const old = board(db, derived, { derivedKeys: [] });
  assert.equal(old.length, 3);
  assert.ok(!old.includes("j-exec"));
});

test("an EXPLICIT value for the same dimension still excludes", () => {
  const db = db0();
  // The user picked 'executive' by hand. That is an instruction, not a guess: obey it literally.
  const rows = board(db, { experience_levels: ["executive"] }, { derivedKeys: [] });
  assert.deepEqual(rows, ["j-exec"], "an explicit filter must still remove the other three rows");
  assert.equal(demoted(db, { experience_levels: ["executive"] }, { derivedKeys: [] }), 0,
    "an explicit filter ranks nothing — there is nothing to disclose about it");
});

test("provenance is per-key: explicit on one dimension, derived on another, in one query", () => {
  const f = buildJobFilters(
    { experience_levels: ["executive"], skills_include: ["python"] },
    { derivedKeys: ["skills_include"] },
  );
  assert.match(f.sql, /experience_level/, "the explicit dimension must be in the WHERE clause");
  assert.ok(!/skills_json/.test(f.sql), "the derived dimension must NOT be in the WHERE clause");
  assert.deepEqual(f.rankedKeys, ["skills_include"]);
  assert.match(f.rank.sql, /skills_json/);
});

test("nothing ranks, and nothing is disclosed, when the bridge derives nothing", () => {
  const db = db0();
  // A profile with no signals derives {} — the common case for a new account. The response must be
  // byte-identical to the pre-change one, so there must be no rank fragment at all.
  const derived = deriveProfileFilters({ target_titles: "[]" }, null);
  assert.deepEqual(derived, {});
  const f = buildJobFilters(derived, { derivedKeys: DERIVED });
  assert.equal(f.rank.sql, "");
  assert.equal(f.rank.demotedSql, "");
  assert.deepEqual(f.rankedKeys, []);
  assert.equal(board(db, derived, { derivedKeys: DERIVED }).length, 4);
});

test("?curate=off means no ranking either — an empty derived set produces no ORDER BY keys", () => {
  const db = db0();
  // server.js sets derivedFilters = {} for curate=off, so appliedDerivedKeys is empty and there is
  // nothing to rank. The toggle has to turn OFF the ordering, or "Don't sort for me" would lie.
  const f = buildJobFilters({}, { derivedKeys: [] });
  assert.equal(f.rank.sql, "");
  assert.equal(board(db, {}, { derivedKeys: [] }).length, 4);
});

test("a NULL enrichment column ranks BETWEEN match and miss, never at the bottom", () => {
  // skills_json is enrichment-owned and mostly NULL (100 of 1261 rows populated on the real board).
  // "We have not looked at this yet" is not the same claim as "this does not match", so an
  // unenriched row must not be buried under rows we have actively judged to be wrong.
  const db = db0();
  db.prepare("UPDATE scraped_jobs SET skills_json = ? WHERE job_id = 'j-mid'").run('["python"]');
  db.prepare("UPDATE scraped_jobs SET skills_json = ? WHERE job_id = 'j-senior'").run('["cobol"]');
  // j-quora and j-exec keep skills_json NULL.
  const f = buildJobFilters({ skills_include: ["python"] }, { derivedKeys: ["skills_include"] });
  const rows = db.prepare(
    `SELECT sj.job_id FROM scraped_jobs sj WHERE sj.is_active = 1 ${f.sql} ORDER BY ${f.rank.sql}, sj.job_id`
  ).all(...f.params, ...f.rank.params).map(r => r.job_id);
  assert.equal(rows[0], "j-mid", "the skill match ranks first");
  assert.equal(rows[rows.length - 1], "j-senior", "the explicit mismatch ranks last");
  assert.deepEqual(rows.slice(1, 3), ["j-exec", "j-quora"], "unenriched rows sit in the middle");
});

test("experience_level is populated on EVERY row, so its soft-null escape never fires", () => {
  // Worth keeping, because it is the reason ranking rather than another null guard was the fix.
  // normalizeJob assigns experience_level heuristically on write — it is not enrichment-only like
  // skills_json — so on a real board there are no NULLs for `(experience_level IS NULL OR ...)` to
  // rescue. Measured: 1261 active rows, 0 NULL. The Quora row was never NULL, it was 'entry', and
  // no soft-null clause can help a row that has a value.
  const db = db0();
  const nulls = db.prepare("SELECT COUNT(*) AS n FROM scraped_jobs WHERE experience_level IS NULL").get().n;
  assert.equal(nulls, 0, "fixture premise: these rows all carry a level, like production rows do");

  const derived = deriveProfileFilters(PROFILE, SIGNALS);
  // As an EXPLICIT filter the window still bites, and the soft-null escape still rescues nobody.
  const kept = board(db, { experience_levels: derived.experience_levels }, { derivedKeys: [] });
  assert.ok(!kept.includes("j-exec"), "the out-of-window row is excluded on its VALUE, not on a NULL");
});

// ── The Saved tab is not a discovery surface ─────────────────────────────────────────────────
//
// /api/jobs scopes the board with `JOIN job_role_map jrm ON ... AND jrm.role_key = ?` — an INNER
// JOIN on the ACTIVE PROFILE's role key — plus profileTitleSql and the profile bridge. All three are
// discovery narrowing, and all three were also being applied to the Saved ★ tab, where they have no
// business: the user's own star already answers "does this belong on your board?".
//
// Measured before the fix, on the reproduction board: user 14 had starred three imports and the
// Saved tab returned ONE. The Figma req was bucketed 'sales' and the RemoteOK req 'general', so both
// were hidden from the tab whose entire meaning is "the jobs I picked" — the reported "my import
// went nowhere", reached by a third route.
test("the Saved tab returns every starred job, whatever bucket the classifier chose", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, title TEXT, company TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE job_role_map (job_id TEXT, role_key TEXT, PRIMARY KEY (job_id, role_key));
    CREATE TABLE user_jobs (user_id INTEGER, job_id TEXT, domain_profile_id INTEGER,
                            starred INTEGER DEFAULT 0, disliked INTEGER DEFAULT 0);
  `);
  const add = (id, company, roleKey) => {
    db.prepare("INSERT INTO scraped_jobs (job_id,title,company,is_active) VALUES (?,?,?,1)").run(id, "T", company);
    db.prepare("INSERT INTO job_role_map (job_id,role_key) VALUES (?,?)").run(id, roleKey);
    db.prepare("INSERT INTO user_jobs (user_id,job_id,domain_profile_id,starred) VALUES (14,?,5,1)").run(id);
  };
  add("ashby::quora",   "Quora",  "engineering"); // matches the active profile
  add("greenhouse::ae", "Figma",  "sales");       // classifier put it elsewhere
  add("import::rok",    "RemoteOK", "general");   // ROLE_KEY_FALLBACK — reachable by nobody's profile

  // The two shapes of the handler's joinClause, verbatim in structure.
  const scoped = `
    FROM scraped_jobs sj
    JOIN job_role_map jrm ON jrm.job_id = sj.job_id AND jrm.role_key = ?
    LEFT JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ? AND uj.domain_profile_id = ?
    WHERE sj.is_active = 1 AND uj.starred = 1 AND (uj.disliked IS NULL OR uj.disliked = 0)`;
  const savedTab = `
    FROM scraped_jobs sj
    LEFT JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ? AND uj.domain_profile_id = ?
    WHERE sj.is_active = 1 AND uj.starred = 1 AND (uj.disliked IS NULL OR uj.disliked = 0)`;

  const before = db.prepare(`SELECT sj.job_id ${scoped}`).all("engineering", 14, 5).map(r => r.job_id);
  const after  = db.prepare(`SELECT sj.job_id ${savedTab}`).all(14, 5).map(r => r.job_id);

  assert.deepEqual(before, ["ashby::quora"],
    "the role-scoped shape is what returned 1 of 3 — kept here so the regression is legible");
  assert.deepEqual(after.sort(), ["ashby::quora", "greenhouse::ae", "import::rok"],
    "every job the user starred must be on their Saved tab, whatever bucket it landed in");
});

test("the Saved tab still respects the user's own dislike, and other users' stars stay theirs", () => {
  // Dropping the role join must not drop the per-user scoping with it.
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, title TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE user_jobs (user_id INTEGER, job_id TEXT, domain_profile_id INTEGER,
                            starred INTEGER DEFAULT 0, disliked INTEGER DEFAULT 0);
  `);
  db.prepare("INSERT INTO scraped_jobs (job_id,title,is_active) VALUES ('a','A',1),('b','B',1),('c','C',1)").run();
  db.prepare("INSERT INTO user_jobs (user_id,job_id,domain_profile_id,starred,disliked) VALUES (14,'a',5,1,0)").run();
  db.prepare("INSERT INTO user_jobs (user_id,job_id,domain_profile_id,starred,disliked) VALUES (14,'b',5,1,1)").run();
  db.prepare("INSERT INTO user_jobs (user_id,job_id,domain_profile_id,starred,disliked) VALUES (99,'c',7,1,0)").run();

  const rows = db.prepare(`
    SELECT sj.job_id FROM scraped_jobs sj
    LEFT JOIN user_jobs uj ON uj.job_id = sj.job_id AND uj.user_id = ? AND uj.domain_profile_id = ?
    WHERE sj.is_active = 1 AND uj.starred = 1 AND (uj.disliked IS NULL OR uj.disliked = 0)
  `).all(14, 5).map(r => r.job_id);

  assert.deepEqual(rows, ["a"], "a disliked star is out, and another user's star is not yours");
});
