// A narrowed board must SAY it is narrowed.
//
// The Profile→Board Bridge derives q, skills_include, experience_levels and sponsorship_friendly
// from the active profile and applies them BY DEFAULT to any dimension the user did not set. That
// is deliberate curation and is not weakened here. What was wrong is that it was SILENT: a row the
// bridge excluded looked exactly like a row that did not exist, for the user and for us.
//
// That is how an imported Quora posting stayed "missing" through two rounds of fixes. Measured on
// production-shaped data at the time of this change: the row was present, is_active=1, req_uid set,
// automation_tier='direct', bucketed 'engineering' — and
//     /api/jobs?localSearch=quora              -> total 0
//     /api/jobs?localSearch=quora&curate=off   -> total 1
// because the posting is a New Grad req (experience_level='entry') and a 3-years-experience profile
// derives experience_levels=['mid','senior'] — widenOneLevelUp only ever widens UPWARD, so 'entry'
// is unreachable for anyone with any experience. Board-wide the same profile saw 291 of 336.
//
// These tests pin the two halves of the disclosure contract:
//   1. the numbers the client renders are computed from the SAME query minus only the derived keys
//   2. nothing is emitted when the bridge hid nothing, so the uncurated response shape is unchanged
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildJobFilters } from "../services/jobs/jobQuery.js";
import { deriveProfileFilters, widenOneLevelUp } from "../services/jobs/profileFilterBridge.js";

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
  // The reported posting, and one row at each of the levels around it.
  add.run("j-quora", "Software Engineer, Machine Learning Platform, New Grad - Quora (Remote)", "Quora", "entry");
  add.run("j-mid",   "Software Engineer, Platform",                                             "Acme",  "mid");
  add.run("j-senior","Senior Software Engineer, Platform",                                      "Acme",  "senior");
  return db;
}

const PROFILE = { target_titles: JSON.stringify(["Software Engineer"]) };
const SIGNALS = { titles: [], searchTerms: [], skills: [], yearsExperience: 3, structuredFacts: {} };

/** The two counts server.js compares: the curated board, and the same board minus derived keys. */
function counts(db, derived, explicit = {}) {
  const run = (params) => {
    const f = buildJobFilters(params);
    return db.prepare(`SELECT COUNT(*) AS n FROM scraped_jobs sj WHERE sj.is_active = 1 ${f.sql}`)
      .get(...f.params).n;
  };
  return { total: run({ ...explicit, ...derived }), uncuratedTotal: run(explicit) };
}

test("the derived experience window excludes 'entry' for anyone with experience — the reported cause", () => {
  // Not a NULL bug: the row HAS a value and the value is simply outside the derived window. The
  // soft-null escape cannot help here, which is why the fix is disclosure rather than another guard.
  assert.deepEqual(widenOneLevelUp("mid"), ["mid", "senior"]);
  const derived = deriveProfileFilters(PROFILE, SIGNALS);
  assert.deepEqual(derived.experience_levels, ["mid", "senior"]);
  assert.ok(!derived.experience_levels.includes("entry"),
    "if 'entry' ever enters the default window this test's premise is gone — revisit the disclosure");
});

test("the curated board hides the entry-level row and the uncurated board does not", () => {
  const db = db0();
  const { total, uncuratedTotal } = counts(db, deriveProfileFilters(PROFILE, SIGNALS));
  assert.equal(total, 2);
  assert.equal(uncuratedTotal, 3);
  assert.equal(uncuratedTotal - total, 1, "this difference is what the notice reports as `hidden`");
});

test("the uncurated count is the same query minus ONLY the derived keys", () => {
  const db = db0();
  // An explicit user filter must be present in BOTH counts — otherwise "Show all N" would advertise
  // rows the user's own filters exclude, and clicking it would not produce N.
  const explicit = { companies_include: ["Acme"] };
  const { total, uncuratedTotal } = counts(db, deriveProfileFilters(PROFILE, SIGNALS), explicit);
  assert.equal(total, 2,          "curated: Acme rows at mid+senior");
  assert.equal(uncuratedTotal, 2, "uncurated: still only Acme — the explicit filter is not dropped");
});

test("nothing is disclosed when the bridge hid nothing", () => {
  const db = db0();
  // A profile with no signals derives {} — the common case for a new account. server.js only builds
  // the uncurated count when at least one derived key applied, and only emits `curation` when that
  // count is strictly higher, so this response is byte-identical to the pre-change one.
  const derived = deriveProfileFilters({ target_titles: "[]" }, null);
  assert.deepEqual(derived, {});
  const { total, uncuratedTotal } = counts(db, derived);
  assert.equal(total, uncuratedTotal);
});

test("an explicit value for a derived dimension wins, and is not blamed on the profile", () => {
  // server.js pushes a key to appliedDerivedKeys ONLY when it actually took effect. A user who has
  // set the experience filter themselves must not be told their profile is hiding rows.
  const db = db0();
  const derived = deriveProfileFilters(PROFILE, SIGNALS);
  const explicit = { experience_levels: ["entry", "mid", "senior"] };
  // What server.js ends up applying: explicit beats derived for the same key.
  const applied = { ...derived, ...explicit };
  const f = buildJobFilters(applied);
  const n = db.prepare(`SELECT COUNT(*) AS n FROM scraped_jobs sj WHERE sj.is_active = 1 ${f.sql}`)
    .get(...f.params).n;
  assert.equal(n, 3, "the user's own wider window must be honoured over the derived one");
});

test("experience_level is populated on EVERY row, so its soft-null escape never fires", () => {
  // Worth pinning, because it is the difference between "this filter is guarded" and "this filter is
  // guarded in a case that does not occur". normalizeJob assigns experience_level heuristically on
  // write — it is not enrichment-only like skills_json — so on a real board there are no NULLs for
  // `(experience_level IS NULL OR ...)` to rescue. Measured on the reproduction board: 1254 rows,
  // 0 NULL, and 363 of them (lead/entry/intern/executive) outside a ['mid','senior'] window.
  //
  // That is why the fix for the reported job is disclosure, not another null guard: the row was
  // never NULL, it was 'entry', and no soft-null clause can help a row that has a value.
  const db = db0();
  const nulls = db.prepare("SELECT COUNT(*) AS n FROM scraped_jobs WHERE experience_level IS NULL").get().n;
  assert.equal(nulls, 0, "fixture premise: these rows all carry a level, like production rows do");

  const derived = deriveProfileFilters(PROFILE, SIGNALS);
  const f = buildJobFilters({ experience_levels: derived.experience_levels });
  const kept = db.prepare(`SELECT job_id FROM scraped_jobs sj WHERE sj.is_active = 1 ${f.sql}`)
    .all(...f.params).map(r => r.job_id);
  assert.ok(!kept.includes("j-quora"), "the entry-level row is excluded on its VALUE, not on a NULL");
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
