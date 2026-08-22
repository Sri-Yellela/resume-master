// What the H-1B sponsorship evidence is ALLOWED to say (TASK X3, Phase 3).
//
// The signal is real and the matching is measured, so the remaining way to get this wrong is in the
// presentation: turning "this employer filed 47 labour condition applications" into "this job
// sponsors", or turning a name we could not resolve into a zero. Both are the same failure — a
// confident claim the evidence does not support — and both are cheap to make in a JSX file long
// after the matcher was written. So this file pins the copy and the gates, not just the numbers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { reconcileCompanyLca, getCompanyLca, mapLcaRow, getCorpusCoverage, knownCompanies }
  from "../services/kb/lcaLayer.js";
import { buildJobFilters, DERIVED_RANK_ORDER } from "../services/jobs/jobQuery.js";

const SECTIONS_SRC = fs.readFileSync(
  new URL("../client/src/components/CompanyKbSections.jsx", import.meta.url), "utf8");
const LAYER_SRC = fs.readFileSync(
  new URL("../services/kb/lcaLayer.js", import.meta.url), "utf8");
const MATCH_SRC = fs.readFileSync(
  new URL("../services/kb/lcaMatch.js", import.meta.url), "utf8");
const JOBQUERY_SRC = fs.readFileSync(
  new URL("../services/jobs/jobQuery.js", import.meta.url), "utf8");

const PERIODS = ["FY2025Q1", "FY2025Q2", "FY2025Q3", "FY2025Q4", "FY2026Q1"];

/** The three tables migration 082 creates, plus the board's scraped_jobs. */
function db0() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT, source TEXT,
      normalized_title TEXT, summary TEXT, skills_json TEXT, experience_level TEXT,
      is_h1b_sponsor INTEGER, requires_work_auth INTEGER,
      posted_at TEXT, scraped_at INTEGER, is_active INTEGER DEFAULT 1
    );
    CREATE TABLE lca_source_files (
      file_name TEXT PRIMARY KEY, fiscal_period TEXT NOT NULL, fiscal_year INTEGER NOT NULL,
      fiscal_quarter INTEGER NOT NULL, period_start INTEGER, period_end INTEGER,
      sheet_rows INTEGER NOT NULL DEFAULT 0, case_rows INTEGER NOT NULL DEFAULT 0,
      employer_rows INTEGER NOT NULL DEFAULT 0, byte_size INTEGER, source_url TEXT,
      ingested_at INTEGER NOT NULL
    );
    CREATE TABLE lca_employer_periods (
      employer_key TEXT NOT NULL, fein TEXT NOT NULL, fiscal_period TEXT NOT NULL,
      employer_name TEXT NOT NULL, dba_keys_json TEXT, state TEXT,
      certified INTEGER NOT NULL DEFAULT 0, denied INTEGER NOT NULL DEFAULT 0,
      withdrawn INTEGER NOT NULL DEFAULT 0, positions INTEGER NOT NULL DEFAULT 0,
      top_titles_json TEXT, last_decision INTEGER,
      PRIMARY KEY (employer_key, fein, fiscal_period)
    );
    CREATE TABLE company_lca_sponsorship (
      company TEXT NOT NULL PRIMARY KEY, match_status TEXT NOT NULL, match_tier TEXT,
      match_confidence REAL NOT NULL DEFAULT 0, match_key TEXT, match_reason TEXT,
      matched_entities_json TEXT, candidate_count INTEGER NOT NULL DEFAULT 0,
      certified_total INTEGER NOT NULL DEFAULT 0, denied_total INTEGER NOT NULL DEFAULT 0,
      positions_total INTEGER NOT NULL DEFAULT 0, by_period_json TEXT, by_fiscal_year_json TEXT,
      top_titles_json TEXT, latest_period TEXT, latest_filing_at INTEGER,
      periods_covered INTEGER NOT NULL DEFAULT 0, periods_with_filings INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'dol_oflc_lca', provenance_json TEXT,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL
    );
  `);
  const f = db.prepare(`INSERT INTO lca_source_files
    (file_name, fiscal_period, fiscal_year, fiscal_quarter, case_rows, ingested_at)
    VALUES (?,?,?,?,?,1787000000)`);
  PERIODS.forEach(p => f.run(`LCA_${p}.xlsx`, p, Number(p.slice(2, 6)), Number(p.slice(-1)), 1000));
  return db;
}

const addEmployer = (db, name, fein, periods, dba = []) => {
  const ins = db.prepare(`INSERT INTO lca_employer_periods
    (employer_key, fein, fiscal_period, employer_name, dba_keys_json, state, certified, last_decision)
    VALUES (?,?,?,?,?,'CA',?,1787000000)`);
  const key = name.toLowerCase()
    .replace(/\bd\/?b\/?a\b/g, "|").split("|")[0]
    .replace(/[^a-z0-9]+/g, " ").trim()
    .replace(/ (inc|llc|pbc|corporation|corp|ltd|limited|co)$/g, "").trim();
  for (const [period, certified] of Object.entries(periods)) {
    ins.run(key, fein, period, name, JSON.stringify(dba), certified);
  }
};

/**
 * The three companies the verification asks for, plus the two the integrity rules exist for.
 * Every count is from the real FY2025 Q1 - FY2026 Q1 corpus.
 */
function fixture() {
  const db = db0();
  // HEAVY SPONSOR: 331 certified across all five quarters, exact legal-name match.
  addEmployer(db, "Stripe, Inc.", "47-1849232",
    { FY2025Q1: 79, FY2025Q2: 71, FY2025Q3: 82, FY2025Q4: 58, FY2026Q1: 41 });
  // THIN AND STALE: 2 certified, and nothing since FY2025 Q2 — three quarters behind the corpus.
  addEmployer(db, "PowerLattice Technologies Inc.", "88-1234567",
    { FY2025Q1: 1, FY2025Q2: 1 });
  // BRAND-PREFIX (tier C) with the insurer sitting right beside it, on a different FEIN.
  addEmployer(db, "Mercury Technologies, Inc.", "82-2557284", { FY2025Q4: 6, FY2026Q1: 2 });
  addEmployer(db, "Mercury Insurance Services, LLC", "95-4831771", { FY2025Q4: 7, FY2026Q1: 7 });
  // AMBIGUOUS: two holdco candidates, two FEINs, no way to choose.
  addEmployer(db, "Apex Technologies, Inc.", "11-1111111", { FY2026Q1: 12 });
  addEmployer(db, "Apex Systems, LLC", "22-2222222", { FY2026Q1: 40 });
  // D/B/A only.
  addEmployer(db, "People Center, Inc. d/b/a Rippling", "82-3226753",
    { FY2025Q4: 30, FY2026Q1: 9 }, ["rippling"]);

  const summary = reconcileCompanyLca(db, {
    companies: ["Stripe", "PowerLattice Technologies", "Mercury", "Apex", "Rippling", "Linear"],
    now: 1787000000,
  });
  return { db, summary };
}

// ── Three companies, presenting correctly and distinguishably ────────────────────────────────

test("a heavy sponsor, a non-sponsor and an unmatched company are three DIFFERENT answers", () => {
  const { db } = fixture();

  const heavy = getCompanyLca(db, "Stripe");
  assert.equal(heavy.matchStatus, "matched");
  assert.equal(heavy.matchTier, "A");
  assert.equal(heavy.certifiedTotal, 331);
  assert.equal(heavy.periodsWithFilings, 5);
  assert.equal(heavy.periodsCovered, 5);
  assert.equal(heavy.recency, "current");
  assert.equal(heavy.presentable, true);
  assert.equal(heavy.highConfidence, true);
  assert.deepEqual(heavy.matchedEntities.map(e => e.name), ["Stripe, Inc."]);

  // NOT-A-SPONSOR is a real finding, and it is a different shape from "we don't know": the name is
  // resolved at 0.95, five quarters were searched, and nothing was found.
  db.prepare(`UPDATE company_lca_sponsorship SET certified_total = 0, latest_period = NULL,
    periods_with_filings = 0, by_period_json = '{}' WHERE company = 'Stripe'`).run();
  const none = getCompanyLca(db, "Stripe");
  assert.equal(none.presentable, true, "a confident zero must still render — it is information");
  assert.equal(none.certifiedTotal, 0);
  assert.equal(none.recency, "none", "never filed is not the same label as filed-long-ago");
  assert.equal(none.quartersSinceFiling, null);

  // UNMATCHED renders nothing at all.
  const unmatched = getCompanyLca(db, "Linear");
  assert.equal(unmatched.matchStatus, "unmatched");
  assert.equal(unmatched.presentable, false);
  assert.equal(unmatched.certifiedTotal, 0);
  assert.notEqual(unmatched.matchReason, null, "and it records WHY, so the silence is explainable");
});

test("staleness is part of the claim: three quarters of silence is labelled, not hidden", () => {
  const { db } = fixture();
  const stale = getCompanyLca(db, "PowerLattice Technologies");
  assert.equal(stale.certifiedTotal, 2);
  assert.equal(stale.latestPeriod, "FY2025Q2");
  assert.equal(stale.latestCorpusPeriod, "FY2026Q1");
  assert.equal(stale.quartersSinceFiling, 3);
  assert.equal(stale.recency, "stale");
  // Half-life is four quarters, so three quarters behind is a bit above half weight.
  assert.ok(stale.recencyFactor > 0.5 && stale.recencyFactor < 0.65,
    `expected ~0.59, got ${stale.recencyFactor}`);
  // Decay changes the WORDING, never whether it renders: 400 filings in 2023 is still worth seeing.
  assert.equal(stale.presentable, true);

  const current = getCompanyLca(db, "Stripe");
  assert.equal(current.recencyFactor, 1);
  assert.notEqual(current.recency, stale.recency, "current and stale must be distinguishable");
});

// ── No low-confidence match is presented as fact ─────────────────────────────────────────────

test("an AMBIGUOUS name renders nothing — not a zero, not 'no data'", () => {
  const { db, summary } = fixture();
  assert.equal(summary.ambiguous, 1);
  const apex = getCompanyLca(db, "Apex");
  assert.equal(apex.matchStatus, "ambiguous");
  assert.equal(apex.matchConfidence, 0);
  assert.equal(apex.presentable, false);
  assert.equal(apex.certifiedTotal, 0, "an ambiguous match must not carry anyone's filings");
  assert.equal(apex.candidateCount, 2);
  // The candidates are kept so the silence can be explained on request.
  assert.equal(apex.matchedEntities.length, 2);
  assert.match(apex.matchReason, /distinct employers/);
});

test("a tier-C match renders, but only ever with the entity named and the basis stated", () => {
  const { db } = fixture();
  const mercury = getCompanyLca(db, "Mercury");
  assert.equal(mercury.matchTier, "C");
  assert.equal(mercury.matchConfidence, 0.6);
  assert.equal(mercury.presentable, true, "0.60 renders");
  assert.equal(mercury.highConfidence, false, "but never as a bare number");
  // And it carries only the technology company's 8, never the insurer's 14.
  assert.equal(mercury.certifiedTotal, 8);
  assert.deepEqual(mercury.matchedEntities.map(e => e.name), ["Mercury Technologies, Inc."]);

  // The UI's own gate: !highConfidence must reach the reader as a qualifier on the match.
  assert.match(SECTIONS_SRC, /nameMatched = !lca\.highConfidence/);
  assert.match(SECTIONS_SRC, /Matched on name to \$\{entityNamesMid\} — verify the employer/);
  // Legal names end in a period, so mid-sentence use has to drop it — otherwise the provenance line
  // renders "Matched to Stripe, Inc..", which reads as a bug in the one line meant to look careful.
  assert.match(SECTIONS_SRC, /entityNamesMid = entityNames\.replace\(\/\\\.\$\/, ""\)/);
});

test("the component returns null for anything not presentable, before it renders a number", () => {
  const fn = SECTIONS_SRC.slice(SECTIONS_SRC.indexOf("export function SponsorshipSection"));
  const body = fn.slice(0, fn.indexOf("export function HiringSection"));
  assert.match(body, /if \(!lca\?\.presentable\) return null;/);
  // The guard has to be the FIRST statement in the body — a number computed above it is a number
  // that can leak. Sliced from the parameter list's closing brace, not from the first `{`, which
  // belongs to the destructured props.
  const firstStatement = body.slice(body.indexOf("}) {") + 4).trim();
  assert.ok(firstStatement.startsWith("if (!lca?.presentable) return null;"),
    `the presentable guard must come first, found: ${firstStatement.slice(0, 80)}`);
});

// ── The integrity line ───────────────────────────────────────────────────────────────────────

test("the copy says EVIDENCE ABOUT THE EMPLOYER, and never that the role sponsors", () => {
  const body = SECTIONS_SRC.slice(SECTIONS_SRC.indexOf("export function SponsorshipSection"),
                                  SECTIONS_SRC.indexOf("export function HiringSection"));
  assert.match(body, /Evidence about the employer — not confirmation that this role sponsors\./);
  assert.match(body, /Absence of a filing is evidence, not proof this employer will not sponsor\./);
  // Nothing anywhere in the rendered strings may promise sponsorship for the job.
  for (const forbidden of [
    /this job sponsors/i, /sponsors this role/i, /will sponsor/i, /sponsorship available/i,
    /confirmed sponsor/i, /verified sponsor/i, /guaranteed/i,
  ]) {
    assert.ok(!forbidden.test(body), `the sponsorship copy must not contain ${forbidden}`);
  }
  // The caveat sits with the claim, not at the foot of the panel: it must appear before the
  // per-quarter chips, which are the next thing down.
  assert.ok(body.indexOf("Evidence about the employer") < body.indexOf("formatPeriod(period)"),
    "the disclaimer must precede the detail it qualifies");
});

// ── The posting-level flag is untouched ──────────────────────────────────────────────────────

test("nothing in X3 reads or writes scraped_jobs.is_h1b_sponsor", () => {
  for (const [name, src] of [["lcaLayer", LAYER_SRC], ["lcaMatch", MATCH_SRC]]) {
    assert.ok(!/\bis_h1b_sponsor\b/.test(src.replace(/^\s*\*.*$/gm, "").replace(/\/\/.*$/gm, "")),
      `${name} must not touch is_h1b_sponsor outside its comments`);
    assert.ok(!/UPDATE\s+scraped_jobs|INSERT\s+INTO\s+scraped_jobs/i.test(src),
      `${name} must never write scraped_jobs`);
  }
  // And the company-level rank/filter block builds its SQL from company_lca_sponsorship only.
  const block = JOBQUERY_SRC.slice(JOBQUERY_SRC.indexOf("Company-level H-1B evidence"),
                                   JOBQUERY_SRC.indexOf("Provider (source) include/exclude"));
  assert.match(block, /company_lca_sponsorship/);
  const code = block.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/is_h1b_sponsor|requires_work_auth/.test(code),
    "the company-level block must not reference the posting columns in its SQL");
});

test("the posting soft-null rule still keeps null-visa rows, with the new key present", () => {
  const db = db0();
  const add = db.prepare(`INSERT INTO scraped_jobs
    (job_id,title,company,source,is_h1b_sponsor,requires_work_auth,scraped_at,is_active)
    VALUES (?,?,?,'ashby',?,?,1787000000,1)`);
  add.run("j-null", "Engineer", "Stripe", null, null);   // unenriched — must survive
  add.run("j-yes", "Engineer", "Stripe", 1, null);
  add.run("j-no", "Engineer", "Stripe", 0, null);

  const f = buildJobFilters({ sponsorship_friendly: true }, { derivedKeys: [] });
  const kept = db.prepare(`SELECT job_id FROM scraped_jobs sj WHERE sj.is_active = 1 ${f.sql}`)
    .all(...f.params).map(r => r.job_id);
  assert.ok(kept.includes("j-null"), "a null-visa row must survive the explicit sponsor filter");
  assert.ok(kept.includes("j-yes"));
  assert.ok(!kept.includes("j-no"), "an explicit 0 is still excluded — that part is unchanged");
});

// ── Ranking, and the narrowest possible opt-in filter ────────────────────────────────────────

function boardDb() {
  const { db } = fixture();
  const add = db.prepare(`INSERT INTO scraped_jobs (job_id,title,company,source,scraped_at,is_active)
    VALUES (?,?,?,'ashby',1787000000,1)`);
  add.run("j-stripe", "Engineer", "Stripe");   // matched 0.95, 331 filings
  add.run("j-mercury", "Engineer", "Mercury"); // matched 0.60, 8 filings
  add.run("j-apex", "Engineer", "Apex");       // ambiguous
  add.run("j-linear", "Engineer", "Linear");   // unmatched
  add.run("j-nobody", "Engineer", "Nobody");   // never reconciled at all
  return db;
}
const run = (db, params, opts) => {
  const f = buildJobFilters(params, opts);
  const order = f.rank.sql ? `ORDER BY ${f.rank.sql}, sj.job_id` : "ORDER BY sj.job_id";
  return db.prepare(`SELECT sj.job_id FROM scraped_jobs sj WHERE sj.is_active = 1 ${f.sql} ${order}`)
    .all(...f.params, ...(f.rank.sql ? f.rank.params : [])).map(r => r.job_id);
};

test("company_sponsorship is in DERIVED_RANK_ORDER, so derived it can only rank", () => {
  assert.ok(DERIVED_RANK_ORDER.includes("company_sponsorship"));
  const derived = buildJobFilters({ company_sponsorship: true },
    { derivedKeys: ["company_sponsorship"] });
  assert.equal(derived.sql, "", "derived must contribute no WHERE clause");
  assert.ok(derived.rank.sql.length > 0);
});

test("derived: evidence reorders the board and removes nothing, not even the ambiguous company", () => {
  const db = boardDb();
  const all = run(db, {}, {});
  const ranked = run(db, { company_sponsorship: true }, { derivedKeys: ["company_sponsorship"] });
  assert.equal(ranked.length, all.length, `ranking dropped ${all.length - ranked.length} rows`);
  // Companies with filings lead; everything we cannot establish sits in the middle band, never last.
  assert.deepEqual(ranked.slice(0, 2).sort(), ["j-mercury", "j-stripe"]);
  for (const id of ["j-apex", "j-linear", "j-nobody"]) {
    assert.ok(ranked.includes(id), `${id} must survive a derived rank`);
  }
});

test("a 0.60 match can rank UP but can never push anything DOWN", () => {
  const db = boardDb();
  // The rank value itself, per row, so this asserts the three-valued state and not just an order.
  const rankOf = () => {
    const f = buildJobFilters({ company_sponsorship: true },
      { derivedKeys: ["company_sponsorship"] });
    return Object.fromEntries(db.prepare(
      `SELECT sj.job_id, (${f.rank.sql.replace(/\) ASC$/, ")")}) AS r FROM scraped_jobs sj`
    ).all(...f.rank.params).map(r => [r.job_id, r.r]));
  };
  const MATCH = 0, UNKNOWN = 1, MISS = 2;

  const before = rankOf();
  assert.equal(before["j-mercury"], MATCH, "0.60 with filings is enough to rank UP");
  assert.equal(before["j-stripe"], MATCH);
  assert.equal(before["j-linear"], UNKNOWN);
  assert.equal(before["j-nobody"], UNKNOWN, "a company never reconciled is unknown, not a miss");
  assert.equal(before["j-apex"], UNKNOWN, "ambiguous is unknown — never a miss");

  // Strip Mercury's filings. 0.60 is below the 0.80 demote bar, so it falls to UNKNOWN, not MISS.
  db.prepare(`UPDATE company_lca_sponsorship SET certified_total = 0 WHERE company = 'Mercury'`).run();
  assert.equal(rankOf()["j-mercury"], UNKNOWN,
    "a 0.60 match with zero filings must not be demoted — pushing a row down takes 0.80");
  assert.notEqual(rankOf()["j-mercury"], MISS);
  // And the explicit filter agrees with the rank: it does not exclude it either.
  assert.ok(run(db, { company_sponsorship: true }, { derivedKeys: [] }).includes("j-mercury"));

  // Whereas Stripe at 0.95 with zero filings IS a miss — the one state that demotes.
  db.prepare(`UPDATE company_lca_sponsorship SET certified_total = 0 WHERE company = 'Stripe'`).run();
  assert.equal(rankOf()["j-stripe"], MISS);
});

test("explicit: the filter excludes ONLY a high-confidence zero, and nothing else", () => {
  const db = boardDb();
  const before = run(db, { company_sponsorship: true }, { derivedKeys: [] });
  assert.equal(before.length, 5, "with everything matched-and-filing, the filter removes nothing");

  // Make Stripe a confident non-filer: resolved at 0.95, five quarters searched, zero found.
  db.prepare(`UPDATE company_lca_sponsorship SET certified_total = 0 WHERE company = 'Stripe'`).run();
  const after = run(db, { company_sponsorship: true }, { derivedKeys: [] });
  assert.ok(!after.includes("j-stripe"), "a 0.95 match with zero filings is what the user ticked to hide");
  for (const id of ["j-apex", "j-linear", "j-nobody", "j-mercury"]) {
    assert.ok(after.includes(id),
      `${id} must survive the opt-in filter — unmatched and ambiguous companies are never excluded`);
  }
});

// ── Reconciliation ───────────────────────────────────────────────────────────────────────────

test("reconciling twice changes nothing but last_seen — the pass is idempotent", () => {
  const { db } = fixture();
  const snap = () => db.prepare(`SELECT company, match_status, match_tier, match_confidence,
    certified_total, by_period_json, latest_period, periods_with_filings
    FROM company_lca_sponsorship ORDER BY company`).all();
  const first = snap();
  reconcileCompanyLca(db, {
    companies: ["Stripe", "PowerLattice Technologies", "Mercury", "Apex", "Rippling", "Linear"],
    now: 1787009999,
  });
  assert.deepEqual(snap(), first, "a second reconcile must not change a single derived value");
  assert.equal(db.prepare("SELECT count(*) c FROM company_lca_sponsorship").get().c, 6,
    "and must not duplicate a company");
});

test("quarters SUM — the files are disjoint, so taking the newest would undercount fourfold", () => {
  const { db } = fixture();
  const stripe = getCompanyLca(db, "Stripe");
  assert.equal(stripe.certifiedTotal, 79 + 71 + 82 + 58 + 41);
  assert.deepEqual(stripe.byPeriod,
    { FY2025Q1: 79, FY2025Q2: 71, FY2025Q3: 82, FY2025Q4: 58, FY2026Q1: 41 });
  // Fiscal-year rollup follows the file's own FY label, not the calendar year of the decision.
  assert.deepEqual(stripe.byFiscalYear, { 2025: 79 + 71 + 82 + 58, 2026: 41 });
  assert.equal(getCorpusCoverage(db).periodsCovered, 5);
  assert.equal(getCorpusCoverage(db).latestPeriod, "FY2026Q1");
});

test("mapLcaRow survives a company with no corpus at all, rather than throwing on the read path", () => {
  const db = db0();
  db.prepare("DELETE FROM lca_source_files").run();
  assert.equal(getCorpusCoverage(db).latestPeriod, null);
  assert.equal(getCompanyLca(db, "Stripe"), null, "never reconciled reads as null, not as a zero");
  const mapped = mapLcaRow({ company: "X", match_status: "matched", match_confidence: 0.95,
    certified_total: 5, latest_period: "FY2026Q1", periods_covered: 0, periods_with_filings: 1,
    candidate_count: 1, denied_total: 0, positions_total: 5, last_seen: 1 }, null);
  assert.equal(mapped.quartersSinceFiling, null);
  assert.equal(mapped.recency, "none");
  assert.equal(mapped.presentable, true);
});

test("knownCompanies unions every table that holds one, and tolerates a missing table", () => {
  const db = db0();
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,company,source,scraped_at,is_active)
    VALUES ('j','T','Stripe','ashby',1,1)`).run();
  // company_ats_list and the KB stores do not exist in this fixture; the union must still work.
  assert.deepEqual(knownCompanies(db), ["Stripe"]);
});
