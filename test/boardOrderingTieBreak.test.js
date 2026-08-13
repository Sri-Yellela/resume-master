import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";

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
      posted_at TEXT, is_active INTEGER DEFAULT 1
    );
  `);
  const ins = db.prepare("INSERT INTO scraped_jobs (job_id,title,company,scraped_at,posted_at) VALUES (?,?,?,?,?)");
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
      ins.run(`${company}::${k}`, `Engineer ${k}`, company, i < 646 ? 1786000004 : 1786000003, posted);
    }
  }
  return db;
}

const RECENCY = "sj.scraped_at DESC, (sj.posted_at IS NULL) ASC, sj.posted_at DESC, sj.job_id";
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
             scraped_at INTEGER, posted_at TEXT, is_active INTEGER DEFAULT 1);`);
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
             scraped_at INTEGER, posted_at TEXT, is_active INTEGER DEFAULT 1);`);
    const ins = db.prepare("INSERT INTO scraped_jobs (job_id,title,company,scraped_at,posted_at) VALUES (?,?,?,?,?)");
    ins.run("undated", "No date", "Acme", 1786000000, null);
    ins.run("dated", "Dated", "Acme", 1786000000, "2026-07-01T00:00:00Z");
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

test("the live-scrape poll uses the same tie-break", () => {
  assert.match(serverSrc,
    /ORDER BY sj\.scraped_at DESC, \(sj\.posted_at IS NULL\) ASC, sj\.posted_at DESC, sj\.job_id\s*\n\s*LIMIT 50/);
});

// ── every option in the <select> has to do something ─────────────────────────

test("every sort value the client can send has its own case", () => {
  // "Oldest" (dateAsc) had no case and fell through to the default, so it rendered identically to
  // "Newest" — a control that visibly does nothing. Read the option values out of the panel rather
  // than hardcoding them, so adding an <option> without a server case fails here.
  const panel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  const selectStart = panel.indexOf('<option value="dateDesc"');
  const options = [...panel.slice(selectStart, selectStart + 900).matchAll(/<option value="([a-zA-Z]+)"/g)]
    .map(m => m[1]);
  assert.ok(options.includes("dateAsc"), "precondition: the panel really offers Oldest");

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
             posted_at TEXT, min_years_exp INTEGER, experience_level TEXT, is_active INTEGER DEFAULT 1);`);
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
             posted_at TEXT, min_years_exp INTEGER, experience_level TEXT, is_active INTEGER DEFAULT 1);`);
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
             posted_at TEXT, ats_score INTEGER, is_active INTEGER DEFAULT 1);`);
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
