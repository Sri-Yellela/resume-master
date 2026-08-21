import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { SORTS } from "../shared/jobFilterOptions.js";

const serverSrc = fs.readFileSync("server.js", "utf8");

// The board ordered by `sj.scraped_at DESC` with nothing after it. A crawl writes its whole batch
// within a second or two, so on a real board scraped_at has a handful of distinct values across
// thousands of rows and cannot order them. Observed in production: 1,275 rows across 9 companies
// sharing 2 distinct scraped_at values, 505 of them one employer — at the default page size of 10
// that is up to 50 consecutive pages of OpenAI before any other company appears, and the other 770
// jobs looked to the user like they did not exist.
//
// The silent half is worse: SQLite guarantees no consistent order between separate queries when
// rows tie, so LIMIT/OFFSET paging could show the same row twice and skip others, with nothing
// surfacing it as an error.

// The production shape: one crawl, two timestamps, one dominant employer.
function boardLikeProduction() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT, scraped_at INTEGER,
      discovered_at INTEGER, posted_at TEXT, is_active INTEGER DEFAULT 1
    );
  `);
  // discovered_at is set EQUAL to scraped_at throughout this fixture, deliberately: it keeps the
  // leading sort key tying exactly as it did when the board led on scraped_at, so the tie-break
  // below remains the thing these tests measure. The case where the two columns DISAGREE is a
  // different bug with its own fixture — see the burial test at the bottom of this file.
  const ins = db.prepare("INSERT INTO scraped_jobs (job_id,title,company,scraped_at,discovered_at,posted_at) VALUES (?,?,?,?,?,?)");
  const CREW = [
    ["OpenAI", 505], ["Stripe", 434], ["Figma", 116], ["Airbnb", 96],
    ["Notion", 93], ["Linear", 26],
  ];
  // Inserted employer-by-employer, exactly as a per-company ATS crawl writes them.
  //
  // posted_at is generated at the precision the ATS APIs actually return — greenhouse hands back
  // values like "2026-04-29T05:00:03.19887Z". An earlier version of this fixture used whole days,
  // which made the tie-break look far weaker than it is: ~60 rows per date meant job_id decided
  // most comparisons, and job_id sorts by company name. Precision matters to what this test
  // measures, so it matches production rather than a convenient round number.
  let i = 0, seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const [company, n] of CREW) {
    for (let k = 0; k < n; k++, i++) {
      const t = Date.UTC(2026, 7, 12) - Math.floor(rnd() * 45 * 86400000);
      const posted = new Date(t).toISOString().replace("Z", String(Math.floor(rnd() * 1e6)).padStart(6, "0") + "Z");
      const touched = i < 646 ? 1786000004 : 1786000003;
      ins.run(`${company}::${k}`, `Engineer ${k}`, company, touched, touched, posted);
    }
  }
  return db;
}

// Mirrors server.js's RECENCY. The leading key is discovered_at (first seen), not scraped_at (last
// touched) — see the burial test at the bottom for why that distinction is load-bearing.
const RECENCY = "COALESCE(sj.discovered_at, sj.scraped_at) DESC, (sj.posted_at IS NULL) ASC, sj.posted_at DESC, sj.job_id";
const page = (db, orderBy, pg, ps = 10) => db.prepare(
  `SELECT sj.job_id, sj.company FROM scraped_jobs sj WHERE sj.is_active=1
   ORDER BY ${orderBy} LIMIT ? OFFSET ?`
).all(ps, (pg - 1) * ps);

test("page one is no longer a single employer", () => {
  const db = boardLikeProduction();
  try {
    const first = page(db, RECENCY, 1);            // the default page size is 10
    const employers = new Set(first.map(r => r.company));
    assert.ok(employers.size > 1,
      `page 1 should show more than one employer, saw: ${[...employers].join(", ")}`);

    // The bug as reported: with a bare `scraped_at DESC` you scroll past 50 rows — five pages —
    // without a second employer appearing at all.
    const before = page(db, "sj.scraped_at DESC", 1, 50);
    assert.equal(new Set(before.map(r => r.company)).size, 1,
      "precondition: the old ordering really did show one employer across five pages");
  } finally { db.close(); }
});

test("paging is reproducible — no row appears twice or vanishes", () => {
  // The silent bug. With a total order, walking the board twice must produce identical pages.
  const db = boardLikeProduction();
  try {
    const walk = () => {
      const seen = [];
      for (let p = 1; p <= 20; p++) for (const r of page(db, RECENCY, p)) seen.push(r.job_id);
      return seen;
    };
    const first = walk();
    assert.deepEqual(walk(), first, "the same query must return the same order");
    assert.equal(new Set(first).size, first.length, "a job must not appear on two pages");
  } finally { db.close(); }
});

test("within a crawl batch the newest posting leads, which is what 'Newest' claims", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, title TEXT, company TEXT,
             scraped_at INTEGER, discovered_at INTEGER, posted_at TEXT, is_active INTEGER DEFAULT 1);`);
    const ins = db.prepare("INSERT INTO scraped_jobs (job_id,title,company,scraped_at,posted_at) VALUES (?,?,?,?,?)");
    // Same crawl second; the older posting was inserted first.
    ins.run("a", "Old posting", "Acme", 1786000000, "2026-07-01T00:00:00Z");
    ins.run("b", "New posting", "Acme", 1786000000, "2026-07-20T00:00:00Z");
    const rows = page(db, RECENCY, 1);
    assert.equal(rows[0].job_id, "b", "the newer posting must lead despite being inserted second");
  } finally { db.close(); }
});

test("a posting with no date sorts last, rather than burying dated ones", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, title TEXT, company TEXT,
             scraped_at INTEGER, discovered_at INTEGER, posted_at TEXT, is_active INTEGER DEFAULT 1);`);
    const ins = db.prepare("INSERT INTO scraped_jobs (job_id,title,company,scraped_at,discovered_at,posted_at) VALUES (?,?,?,?,?,?)");
    ins.run("undated", "No date", "Acme", 1786000000, 1786000000, null);
    ins.run("dated", "Dated", "Acme", 1786000000, 1786000000, "2026-07-01T00:00:00Z");
    // Plain `posted_at DESC` puts NULL last in SQLite only by luck of collation; the explicit
    // (posted_at IS NULL) ASC term is what guarantees it.
    assert.equal(page(db, RECENCY, 1)[0].job_id, "dated");
  } finally { db.close(); }
});

// ── the source ───────────────────────────────────────────────────────────────

test("every board sort ends in the total-order tie-break, not a bare timestamp", () => {
  // atsScore/applicantCount/compHigh/compLow each ended in `sj.scraped_at DESC` too, so they had
  // the identical defect once their own key tied — and ATS scores and applicant counts tie a lot.
  const orderBlock = serverSrc.slice(serverSrc.indexOf("const RECENCY ="),
                                     serverSrc.indexOf("const offset  = (pg - 1) * ps;"));
  assert.match(orderBlock, /sj\.job_id/, "job_id is the primary key and makes the order total");
  const bareTail = orderBlock.match(/sj\.scraped_at DESC'/g) || [];
  assert.equal(bareTail.length, 0, "no sort may end on a bare scraped_at");
  for (const s of ["atsScore", "applicantCount", "compHigh", "compLow"]) {
    assert.match(orderBlock, new RegExp(`${s}[^\\n]*RECENCY`), `${s} must reuse the shared tie-break`);
  }
});

test("the live-scrape poll uses the same ordering as the board", () => {
  assert.match(serverSrc,
    /ORDER BY COALESCE\(sj\.discovered_at, sj\.scraped_at\) DESC, \(sj\.posted_at IS NULL\) ASC, sj\.posted_at DESC, sj\.job_id\s+LIMIT 50/);
  // The poll's WHERE clause must KEEP gating on scraped_at: "changed since you last polled" really
  // is a last-touched question. Only the ORDER BY moves to first-seen.
  assert.match(serverSrc, /AND sj\.scraped_at >= \?/);
});

// ── every option in the <select> has to do something ─────────────────────────

test("every sort value the client can send has its own case", () => {
  // "Oldest" (dateAsc) had no case and fell through to the default, so it rendered identically to
  // "Newest" — a control that visibly does nothing. The offered values are still READ rather than
  // hardcoded, so adding a sort option without a server case fails here.
  //
  // WHAT CHANGED, AND WHY THIS TEST GOT SHORTER. It used to scrape two literal lists — App.jsx's
  // `const SORT_OPTIONS = [...]` and TopBar's `<option value="dateDesc">` block — and then assert
  // that the two agreed, "because two lists is exactly the situation where one drifts". They HAD
  // drifted, on labels: "Pay high to low" in one and "Pay ↓" in the other for the same value. X1
  // made SORTS in shared/jobFilterOptions.js the single definition, so agreement is now structural
  // rather than something to check.
  //
  // AND THEN Y4 REMOVED THE SECOND SURFACE ENTIRELY. The pill is retired, so there is one sort
  // control again — the icon beside IMPORT on the Jobs chrome. Two surfaces was the situation that
  // needed guarding, one definition made it safe, and now there is one of each. The assertion that
  // the pill also rendered from the contract goes with the pill.
  const app    = fs.readFileSync("client/src/App.jsx", "utf8");
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");

  assert.match(app, /const SORT_OPTIONS = SORTS\.options\.map/,
    "the sort icon holds its own list again — it can drift from the server's cases");
  assert.ok(!/SORTS/.test(topBar),
    "a second sort control is back in the top bar — that is the two-lists situation again");

  const options = SORTS.options.map(o => o.value);
  assert.ok(options.includes("dateAsc"), "precondition: the sort control really offers Oldest");
  // A value declared server-only must NOT be offered, or it becomes a control backed by a column
  // nothing writes.
  for (const dbOnly of (SORTS.dbOnly || []).map(d => d.value)) {
    assert.ok(!options.includes(dbOnly), `"${dbOnly}" is declared server-only but is offered`);
  }

  const block = serverSrc.slice(serverSrc.indexOf("const RECENCY ="),
                               serverSrc.indexOf("const offset  = (pg - 1) * ps;"));
  for (const opt of options) {
    if (opt === "dateDesc") continue;   // the default arm, correctly unnamed
    assert.match(block, new RegExp(`sort === '${opt}'`),
      `the sort <select> offers "${opt}" but the server has no case for it, so it silently does nothing`);
  }
});

test("Oldest actually reverses Newest", () => {
  const db = boardLikeProduction();
  try {
    const OLDEST = "sj.scraped_at ASC, (sj.posted_at IS NULL) ASC, sj.posted_at ASC, sj.job_id";
    const newest = page(db, RECENCY, 1, 5).map(r => r.job_id);
    const oldest = page(db, OLDEST, 1, 5).map(r => r.job_id);
    assert.notDeepEqual(oldest, newest, "Oldest must not return the same rows as Newest");
  } finally { db.close(); }
});

test("the experience sorts work on a crawled board, where min_years_exp is never populated", () => {
  // The obvious column for "Exp low to high" is min_years_exp, which the YoE filters use — but the
  // ATS crawl path never writes it, so sorting on it alone would leave both controls dead on any
  // crawled board. experience_level is what enrichment fills, from a fixed ordered vocabulary.
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, company TEXT, scraped_at INTEGER,
             discovered_at INTEGER, posted_at TEXT, min_years_exp INTEGER, experience_level TEXT, is_active INTEGER DEFAULT 1);`);
    const ins = db.prepare(`INSERT INTO scraped_jobs
      (job_id,company,scraped_at,posted_at,min_years_exp,experience_level) VALUES (?,?,?,?,?,?)`);
    // Exactly the crawled shape: no numeric years anywhere, levels present.
    for (const [id, lvl] of [["a", "lead"], ["b", "intern"], ["c", "senior"], ["d", "mid"]]) {
      ins.run(id, "Acme", 1786000000, "2026-07-01T00:00:00Z", null, lvl);
    }
    const LEVEL_RANK = `CASE sj.experience_level
      WHEN 'intern' THEN 0 WHEN 'entry' THEN 1 WHEN 'mid' THEN 2
      WHEN 'senior' THEN 3 WHEN 'lead' THEN 4 WHEN 'executive' THEN 5 END`;
    const EXP = (dir) =>
      `(sj.min_years_exp IS NULL) ASC, sj.min_years_exp ${dir}, ` +
      `((${LEVEL_RANK}) IS NULL) ASC, (${LEVEL_RANK}) ${dir}, ${RECENCY}`;

    assert.deepEqual(page(db, EXP("ASC"), 1, 4).map(r => r.job_id), ["b", "d", "c", "a"],
      "low to high: intern, mid, senior, lead");
    assert.deepEqual(page(db, EXP("DESC"), 1, 4).map(r => r.job_id), ["a", "c", "d", "b"],
      "high to low is the exact reverse");
  } finally { db.close(); }
});

test("a precise year count outranks the level bucket where it exists", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, company TEXT, scraped_at INTEGER,
             discovered_at INTEGER, posted_at TEXT, min_years_exp INTEGER, experience_level TEXT, is_active INTEGER DEFAULT 1);`);
    const ins = db.prepare(`INSERT INTO scraped_jobs
      (job_id,company,scraped_at,posted_at,min_years_exp,experience_level) VALUES (?,?,?,?,?,?)`);
    ins.run("numbered", "Acme", 1786000000, "2026-07-01T00:00:00Z", 1, "lead");   // says 1 year
    ins.run("levelled", "Acme", 1786000000, "2026-07-01T00:00:00Z", null, "intern");
    const LEVEL_RANK = `CASE sj.experience_level WHEN 'intern' THEN 0 WHEN 'entry' THEN 1
      WHEN 'mid' THEN 2 WHEN 'senior' THEN 3 WHEN 'lead' THEN 4 WHEN 'executive' THEN 5 END`;
    const EXP = `(sj.min_years_exp IS NULL) ASC, sj.min_years_exp ASC, ` +
                `((${LEVEL_RANK}) IS NULL) ASC, (${LEVEL_RANK}) ASC, ${RECENCY}`;
    assert.equal(page(db, EXP, 1, 2)[0].job_id, "numbered",
      "a stated year count is more precise than a bucket and should lead");
  } finally { db.close(); }
});

test("an all-NULL sort column does not scramble the board", () => {
  // ats_score is populated only for jobs the user has actually scored, so on a fresh board it is
  // NULL everywhere. NULLs-last keeps that case a stable recency listing instead of arbitrary order.
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, company TEXT, scraped_at INTEGER,
             discovered_at INTEGER, posted_at TEXT, ats_score INTEGER, is_active INTEGER DEFAULT 1);`);
    const ins = db.prepare("INSERT INTO scraped_jobs (job_id,company,scraped_at,posted_at,ats_score) VALUES (?,?,?,?,?)");
    ins.run("a", "Acme", 1786000000, "2026-07-03T00:00:00Z", null);
    ins.run("b", "Acme", 1786000000, "2026-07-02T00:00:00Z", null);
    ins.run("c", "Acme", 1786000000, "2026-07-01T00:00:00Z", 90);   // the one scored job
    const ATS = `(sj.ats_score IS NULL) ASC, sj.ats_score DESC, ${RECENCY}`;
    const order = page(db, ATS, 1, 5).map(r => r.job_id);
    assert.equal(order[0], "c", "the scored job must lead, not be lost among the unscored ones");
    assert.deepEqual(order.slice(1), ["a", "b"], "the rest stay in recency order");
  } finally { db.close(); }
});

// ── an import must not be buried by the nightly crawl ────────────────────────
//
// The second, independent ordering defect, and the one that kept a user-imported job invisible after
// the curation disclosure had already made the board honest about its filters.
//
// scraped_at and discovered_at are DIFFERENT facts, and upsertCanonicalJob writes them differently:
// `scraped_at: now` on every single write, `discovered_at: priorDiscoveredAt ?? now` so it keeps
// meaning first-seen. The nightly 04:00 crawl therefore rewrites scraped_at on all ~1,250 crawled
// rows without changing what any of them are. A board sorted by scraped_at then ranks by "when our
// crawler last looked", which is a fact about us, not about the posting — and it pushes anything not
// in the newest batch to the bottom.
//
// A user-imported job is precisely that. Measured on the reproduction board: an import made minutes
// earlier ranked LAST, page 34 of 34, under 1,252 crawled rows the crawl had merely re-touched. The
// user's report was "the job never appeared on the board", and they were right — nobody scrolls to
// page 34.
function boardAfterNightlyCrawl() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT, scraped_at INTEGER,
      discovered_at INTEGER, posted_at TEXT, is_active INTEGER DEFAULT 1
    );
  `);
  const ins = db.prepare(
    "INSERT INTO scraped_jobs (job_id,title,company,scraped_at,discovered_at,posted_at) VALUES (?,?,?,?,?,?)"
  );
  const CRAWL_RAN_AT = 1_787_300_000;              // last night's 04:00 pass
  const IMPORTED_AT  = CRAWL_RAN_AT - 6 * 3600;    // the user imported it the previous evening
  // 60 crawled rows: first seen WEEKS ago, but re-touched by last night's crawl.
  for (let k = 0; k < 60; k++) {
    ins.run(`crawled::${k}`, `Engineer ${k}`, "BigCo", CRAWL_RAN_AT, CRAWL_RAN_AT - 30 * 86400, null);
  }
  // The import: first seen last night, and never touched since.
  ins.run("ashby::quora", "Software Engineer, ML Platform, New Grad", "Quora", IMPORTED_AT, IMPORTED_AT, null);
  return db;
}

test("a job imported yesterday leads the board, instead of sinking under a re-crawl", () => {
  const db = boardAfterNightlyCrawl();
  try {
    // The bug, kept in the test so the regression stays legible: ranked by last-touched, the import
    // is dead last behind 60 rows that are a month old.
    const byTouched = page(db, "sj.scraped_at DESC, sj.job_id", 1, 100).map(r => r.job_id);
    assert.equal(byTouched.at(-1), "ashby::quora",
      "premise: sorting by scraped_at puts the newest job last, because the crawl re-touched the rest");
    assert.ok(!byTouched.slice(0, 10).includes("ashby::quora"),
      "premise: and it is nowhere near page one");

    // The fix: ranked by first-seen, the genuinely newest posting leads.
    const byDiscovered = page(db, RECENCY, 1, 10).map(r => r.job_id);
    assert.equal(byDiscovered[0], "ashby::quora",
      "the newest job the user has must be the first job the user sees");
  } finally { db.close(); }
});

test("a row with no discovered_at still sorts on its scraped_at rather than vanishing to the end", () => {
  // Production carries adzuna orphans from the pre-pivot architecture with discovered_at NULL. A bare
  // `discovered_at DESC` would rank every one of them below every dated row, permanently — the same
  // class of silent burial this test file exists to stop. COALESCE is what prevents it.
  const db = boardAfterNightlyCrawl();
  try {
    db.prepare(
      "INSERT INTO scraped_jobs (job_id,title,company,scraped_at,discovered_at,posted_at) VALUES (?,?,?,?,?,?)"
    ).run("orphan::1", "Orphan", "Adzuna Co", 1_787_400_000, null, null);
    const first = page(db, RECENCY, 1, 3).map(r => r.job_id);
    assert.equal(first[0], "orphan::1",
      "its scraped_at is the newest timestamp available for it, so it must be ranked by that");
  } finally { db.close(); }
});
