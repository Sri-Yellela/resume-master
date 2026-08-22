/**
 * Company KB — H-1B sponsorship evidence layer (TASK X3), over DOL/OFLC LCA disclosure data.
 *
 * Two jobs, deliberately in one file because they must agree:
 *   reconcileCompanyLca() — resolves our `company` strings against the ingested LCA employer
 *                           universe and writes company_lca_sponsorship.
 *   getCompanyLca()       — the read the company view and the board ranker both use.
 *
 * WHAT THIS LAYER IS ALLOWED TO SAY. "This employer filed 47 certified H-1B petitions in FY2026 Q1"
 * is evidence about the EMPLOYER. It is not a promise about a role, and this module never produces
 * a boolean called anything like `sponsors`. It never reads or writes scraped_jobs.is_h1b_sponsor:
 * that column keeps its own soft-null semantics and its own meaning (what a POSTING said), and the
 * two are not reconciled into one number because they are not the same claim.
 *
 * RECENCY IS PART OF THE CLAIM, not a footnote. LCA data is quarterly, and a company that filed in
 * 2023 and not since is making a different statement from one that filed last quarter. Measured
 * live: Quora filed 1 certified LCA in FY2025 Q4 and 0 in FY2026 Q1. So the store records how many
 * quarters were SEARCHED (periods_covered) next to how many had filings, decays against the newest
 * quarter in the corpus rather than against wall-clock time — the newest quarter is up to ~4 months
 * old the day it is published, and decaying from `now` would mark fresh data stale — and exposes
 * both the factor and a plain-language label.
 *
 * `presentable` is the integrity gate and it keys off MATCH confidence, not decayed confidence: a
 * company that filed 400 petitions in 2023 and nothing since is still worth showing (labelled
 * stale), whereas a name we are not sure we matched is not worth showing at any age.
 */

import {
  buildEntityIndex,
  matchCompanyToEntities,
  companyMatchKey,
  PRESENTABLE_MIN_CONFIDENCE,
  HIGH_CONFIDENCE,
} from './lcaMatch.js';

// Four quarters. One year of silence halves the weight of the evidence — chosen to match the
// annual rhythm of the H-1B cap rather than picked for feel: an employer that files only in the
// cap-season quarter is a normal sponsor, and a half-life shorter than a year would keep marking
// them as fading.
const RECENCY_HALFLIFE_QUARTERS = 4;
// How far behind the newest ingested quarter a company's last filing can be and still read as
// current / recent. Beyond RECENT_MAX it reads as stale.
const CURRENT_MAX_LAG = 0;
const RECENT_MAX_LAG = 2;
const MAX_TOP_TITLES = 6;

/** 'FY2026Q1' -> { year: 2026, quarter: 1 }; anything else -> null. */
function parseFiscalPeriod(period) {
  const m = /^FY(\d{4})Q([1-4])$/.exec(String(period || ''));
  return m ? { year: Number(m[1]), quarter: Number(m[2]) } : null;
}

/** Monotonic ordinal so quarters can be compared and subtracted. */
function periodOrdinal(period) {
  const p = parseFiscalPeriod(period);
  return p ? p.year * 4 + (p.quarter - 1) : null;
}

function formatFiscalPeriod(year, quarter) {
  return `FY${year}Q${quarter}`;
}

/**
 * The window we have actually ingested: oldest quarter, newest quarter, and how many.
 *
 * Both ends matter now that the corpus spans years rather than one fiscal year. "Nothing found in
 * 21 quarters" is a far stronger negative than "nothing found in 2", and a reader cannot tell which
 * they are being given from a count alone — 21 quarters could be a five-year run or a mislabelled
 * gap. The UI names the span, so the strength of the claim is visible instead of implied.
 *
 * `feinPeriods` is the subset whose source file carried EMPLOYER_FEIN at all (migration 083): the
 * pre-FY2024 layout has no employer tax ID, so the tier-C ambiguity guard falls back to legal names
 * over those quarters. Exposed rather than hidden because it is a real limit on how finely two
 * employers can be told apart in the older half of the window.
 */
function getCorpusCoverage(db) {
  const rows = db.prepare(
    `SELECT fiscal_period, file_name, period_start, period_end, has_employer_fein, quarters_covered
       FROM lca_source_files`
  ).all();
  if (!rows.length) {
    return { latestPeriod: null, earliestPeriod: null, periods: [], files: [], spanByPeriod: {},
      periodsCovered: 0, feinPeriods: 0, windowStart: null, windowEnd: null };
  }
  const periods = [...new Set(rows.map(r => r.fiscal_period))]
    .sort((a, b) => periodOrdinal(a) - periodOrdinal(b));
  const spanByPeriod = {};
  for (const r of rows) spanByPeriod[r.fiscal_period] = r.quarters_covered || 1;
  const starts = rows.map(r => r.period_start).filter(t => t != null);
  const ends = rows.map(r => r.period_end).filter(t => t != null);
  return {
    latestPeriod: periods[periods.length - 1],
    earliestPeriod: periods[0],
    periods,
    files: rows.map(r => r.file_name).sort(),
    // How many quarters this period spans, per period. A cumulative fiscal-year file spans 4.
    spanByPeriod,
    // QUARTERS SEARCHED, not files ingested. After de-overlap a four-year corpus is nine period
    // rows covering twenty-one quarters, and "we looked at 9 quarters" would understate it by more
    // than half. Falls back to counting rows for periods ingested before migration 084 measured them.
    periodsCovered: rows.reduce((n, r) => n + (r.quarters_covered || 1), 0),
    feinPeriods: rows.filter(r => r.has_employer_fein === 1).length,
    // The window as DATES, which is unambiguous in a way a fiscal-quarter label is not once one
    // period can mean a whole year.
    windowStart: starts.length ? Math.min(...starts) : null,
    windowEnd: ends.length ? Math.max(...ends) : null,
  };
}

/**
 * How a period should be NAMED on screen, given how many quarters it actually spans.
 *
 * A cumulative FY2021 file holds a full year's filings under the label "FY2021Q3". Rendering that
 * as "FY2021 Q3" would claim a year of sponsorship happened in one quarter — a four-fold overstate
 * on the one number the reader is most likely to quote.
 */
function periodDisplayLabel(fiscalPeriod, quartersCovered) {
  const p = parseFiscalPeriod(fiscalPeriod);
  if (!p || !quartersCovered || quartersCovered <= 1) return fiscalPeriod;
  if (quartersCovered >= 4) return `FY${p.year}`;
  return `FY${p.year}Q1-Q${p.quarter}`;
}

/**
 * Every company string this installation knows about, from the four places that hold one. The
 * union, not scraped_jobs alone: company_ats_list holds companies we crawl but may have no live
 * postings for, and a company that drops off the board should not lose its KB fact.
 */
function knownCompanies(db) {
  const seen = new Map(); // lowercase -> first-seen original casing
  const sources = [
    `SELECT DISTINCT company FROM company_ats_list WHERE company IS NOT NULL AND company != ''`,
    `SELECT DISTINCT company FROM scraped_jobs WHERE company IS NOT NULL AND company != ''`,
    `SELECT DISTINCT company FROM company_technographics WHERE company IS NOT NULL AND company != ''`,
    `SELECT DISTINCT company FROM company_org_units WHERE company IS NOT NULL AND company != ''`,
    `SELECT DISTINCT company FROM company_hiring_signals WHERE company IS NOT NULL AND company != ''`,
  ];
  for (const sql of sources) {
    let rows = [];
    try { rows = db.prepare(sql).all(); } catch { continue; } // table may not exist yet
    for (const r of rows) {
      const key = r.company.trim().toLowerCase();
      if (key && !seen.has(key)) seen.set(key, r.company.trim());
    }
  }
  return [...seen.values()].sort();
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

/**
 * One display row per employer NAME, preferring the entry that carries a FEIN. See the call site:
 * a company that filed both before and after the FY2023 layout change appears twice in the entity
 * index, and only the aggregation wants both. (Pre-FY2024 files have no FEIN column, so the same
 * company legitimately appears once with a tax ID and once with the '' sentinel.)
 */
function dedupeEntitiesByName(entities) {
  const byName = new Map();
  for (const e of entities) {
    const existing = byName.get(e.employerName);
    if (!existing || (!existing.fein && e.fein)) {
      byName.set(e.employerName, { name: e.employerName, fein: e.fein || null, state: e.state || null });
    }
  }
  return [...byName.values()];
}

/**
 * Rolls the matched entities' per-quarter rows into the totals company_lca_sponsorship stores.
 * Sums across quarters because the DOL files are per-quarter and disjoint — verified from the
 * record layout's own reporting-period line and from the decision-date ranges, NOT assumed. Taking
 * the newest file as a year-to-date total would undercount every sponsor by ~4x.
 */
function aggregateEntityPeriods(db, entities, spanByPeriod = {}) {
  const totals = {
    certified: 0, denied: 0, withdrawn: 0, positions: 0,
    byPeriod: {}, byFiscalYear: {}, titles: new Map(),
    latestPeriod: null, latestFilingAt: null, periodsWithFilings: 0,
  };
  if (!entities.length) return totals;

  // storedKey, not legalKey: employer_key is part of this table's primary key, so the lookup has to
  // use the value on disk even when the current normaliser would derive a different one. See
  // buildEntityIndex — recomputing for MATCHING and preserving for LOOKUP is what keeps a
  // normalisation change from orphaning rows.
  const pairs = entities.map(e => ({ key: e.storedKey ?? e.legalKey, fein: e.fein || '' }));
  const where = pairs.map(() => '(employer_key = ? AND fein = ?)').join(' OR ');
  const args = pairs.flatMap(p => [p.key, p.fein]);
  const rows = db.prepare(
    `SELECT fiscal_period, certified, denied, withdrawn, positions, top_titles_json, last_decision
       FROM lca_employer_periods WHERE ${where}`
  ).all(...args);

  // Quarters, not period rows — see periodsWithFilings below.
  const quartersWithFilings = new Set();
  for (const r of rows) {
    totals.certified += r.certified || 0;
    totals.denied += r.denied || 0;
    totals.withdrawn += r.withdrawn || 0;
    totals.positions += r.positions || 0;
    const fy = parseFiscalPeriod(r.fiscal_period);
    if (r.certified > 0) {
      quartersWithFilings.add(r.fiscal_period);
      // Keyed by DISPLAY label, so a cumulative year reads "FY2021" rather than "FY2021Q3".
      const label = periodDisplayLabel(r.fiscal_period, spanByPeriod[r.fiscal_period]);
      totals.byPeriod[label] = (totals.byPeriod[label] || 0) + r.certified;
      if (fy) totals.byFiscalYear[fy.year] = (totals.byFiscalYear[fy.year] || 0) + r.certified;
      const ord = periodOrdinal(r.fiscal_period);
      if (ord != null && (totals.latestPeriod == null || ord > periodOrdinal(totals.latestPeriod))) {
        totals.latestPeriod = r.fiscal_period;
      }
      if (r.last_decision && (totals.latestFilingAt == null || r.last_decision > totals.latestFilingAt)) {
        totals.latestFilingAt = r.last_decision;
      }
    }
    for (const [title, n] of Object.entries(parseJson(r.top_titles_json, {}) || {})) {
      totals.titles.set(title, (totals.titles.get(title) || 0) + n);
    }
  }
  // QUARTERS with filings, weighted by each period's span — so it is comparable with
  // periods_covered, which also counts quarters. Counting period ROWS instead put Stripe at "18 of
  // 21" when it filed in every quarter of the corpus: 18 is the number of FILES after de-overlap,
  // and three of those files each cover more than one quarter. Two numbers side by side that count
  // different things is the kind of ratio a reader trusts and should not.
  totals.periodsWithFilings = [...quartersWithFilings]
    .reduce((n, p) => n + (spanByPeriod[p] || 1), 0);
  return totals;
}

/**
 * Resolves company strings against the ingested LCA universe and writes company_lca_sponsorship.
 * Re-runnable: one row per company, upserted, so running it twice is a no-op beyond last_seen.
 * Writes a row for UNMATCHED and AMBIGUOUS companies too — "we looked and could not safely
 * identify this employer" is a fact worth storing, and without it the reconciler could not tell a
 * company it has never examined from one it examined and declined.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ companies?: string[], now?: number }} [opts]
 */
function reconcileCompanyLca(db, opts = {}) {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const companies = opts.companies?.length ? opts.companies : knownCompanies(db);
  const coverage = getCorpusCoverage(db);
  const provenance = JSON.stringify({
    source: 'dol_oflc_lca',
    files: coverage.files,
    periods: coverage.periods,
  });

  const entityRows = db.prepare(
    `SELECT employer_key, fein, employer_name, dba_keys_json, state
       FROM lca_employer_periods GROUP BY employer_key, fein, employer_name`
  ).all();
  const index = buildEntityIndex(entityRows);

  const upsert = db.prepare(`
    INSERT INTO company_lca_sponsorship (
      company, match_status, match_tier, match_confidence, match_key, match_reason,
      matched_entities_json, candidate_count, certified_total, denied_total, positions_total,
      by_period_json, by_fiscal_year_json, top_titles_json, latest_period, latest_filing_at,
      periods_covered, periods_with_filings, source, provenance_json, first_seen, last_seen
    ) VALUES (
      @company, @match_status, @match_tier, @match_confidence, @match_key, @match_reason,
      @matched_entities_json, @candidate_count, @certified_total, @denied_total, @positions_total,
      @by_period_json, @by_fiscal_year_json, @top_titles_json, @latest_period, @latest_filing_at,
      @periods_covered, @periods_with_filings, 'dol_oflc_lca', @provenance_json, @now, @now
    )
    ON CONFLICT(company) DO UPDATE SET
      match_status = @match_status, match_tier = @match_tier,
      match_confidence = @match_confidence, match_key = @match_key, match_reason = @match_reason,
      matched_entities_json = @matched_entities_json, candidate_count = @candidate_count,
      certified_total = @certified_total, denied_total = @denied_total,
      positions_total = @positions_total, by_period_json = @by_period_json,
      by_fiscal_year_json = @by_fiscal_year_json, top_titles_json = @top_titles_json,
      latest_period = @latest_period, latest_filing_at = @latest_filing_at,
      periods_covered = @periods_covered, periods_with_filings = @periods_with_filings,
      provenance_json = @provenance_json, last_seen = @now
  `);

  const summary = { companies: 0, matched: 0, ambiguous: 0, unmatched: 0, tiers: {}, withFilings: 0 };
  const run = db.transaction(() => {
    for (const company of companies) {
      const m = matchCompanyToEntities(company, index);
      const totals = m.status === 'matched'
        ? aggregateEntityPeriods(db, m.entities, coverage.spanByPeriod)
        : aggregateEntityPeriods(db, [], coverage.spanByPeriod);
      const topTitles = [...totals.titles.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, MAX_TOP_TITLES)
        .map(([title, n]) => ({ title, count: n }));
      upsert.run({
        company,
        match_status: m.status,
        match_tier: m.tier,
        match_confidence: m.confidence,
        match_key: m.key || null,
        match_reason: m.reason,
        // Stored for every status, including 'ambiguous': the whole point of declining a match is
        // being able to show WHICH employers were confused, if anyone ever asks why we said nothing.
        //
        // DE-DUPLICATED BY NAME, because the pre-FY2024 files carry no FEIN and the FY2024+ ones
        // do — so one company arrives as two index entries, `Stripe, Inc.` with a tax ID and
        // `Stripe, Inc.` with the '' sentinel. Both are needed for aggregation (each keys a
        // different set of lca_employer_periods rows) and only one belongs on screen, or the UI
        // renders "Stripe, Inc. + Stripe, Inc." and looks like it is double-counting. The
        // FEIN-bearing entry wins so the displayed row is the one that can be looked up.
        matched_entities_json: JSON.stringify(dedupeEntitiesByName(m.entities)),
        candidate_count: m.candidateCount,
        certified_total: totals.certified,
        denied_total: totals.denied,
        positions_total: totals.positions,
        by_period_json: JSON.stringify(totals.byPeriod),
        by_fiscal_year_json: JSON.stringify(totals.byFiscalYear),
        top_titles_json: JSON.stringify(topTitles),
        latest_period: totals.latestPeriod,
        latest_filing_at: totals.latestFilingAt,
        periods_covered: coverage.periodsCovered,
        periods_with_filings: totals.periodsWithFilings,
        provenance_json: provenance,
        now,
      });
      summary.companies++;
      summary[m.status]++;
      if (m.tier) summary.tiers[m.tier] = (summary.tiers[m.tier] || 0) + 1;
      if (totals.certified > 0) summary.withFilings++;
    }
  });
  run();
  return summary;
}

/**
 * Turns a company_lca_sponsorship row into the client-facing shape. camelCase to match
 * mapJobRow/mapOrgUnitRow.
 *
 * @param {object} row
 * @param {ReturnType<typeof getCorpusCoverage>|string|null} coverage - the ingested window. Recency
 *   is measured against its NEWEST quarter, not against wall-clock time: the most recent DOL file
 *   is up to four months old the day it is published, so decaying from `now` would mark fresh data
 *   stale. A bare string is accepted as that newest quarter for callers that only have the one value.
 */
function mapLcaRow(row, coverage) {
  if (!row) return null;
  const cov = typeof coverage === 'string' || coverage == null
    ? { latestPeriod: coverage || null, earliestPeriod: null, periodsCovered: null, feinPeriods: null }
    : coverage;
  const latestCorpusPeriod = cov.latestPeriod;
  const corpusOrd = periodOrdinal(latestCorpusPeriod);
  const rowOrd = periodOrdinal(row.latest_period);
  const lag = corpusOrd != null && rowOrd != null ? Math.max(0, corpusOrd - rowOrd) : null;
  const recencyFactor = lag == null ? 0 : Math.pow(0.5, lag / RECENCY_HALFLIFE_QUARTERS);
  const matched = row.match_status === 'matched';
  return {
    company: row.company,
    matchStatus: row.match_status,
    matchTier: row.match_tier,
    matchConfidence: row.match_confidence,
    matchReason: row.match_reason,
    matchedEntities: parseJson(row.matched_entities_json, []),
    candidateCount: row.candidate_count,
    certifiedTotal: row.certified_total,
    deniedTotal: row.denied_total,
    positionsTotal: row.positions_total,
    byPeriod: parseJson(row.by_period_json, {}),
    byFiscalYear: parseJson(row.by_fiscal_year_json, {}),
    topTitles: parseJson(row.top_titles_json, []),
    latestPeriod: row.latest_period,
    latestFilingAt: row.latest_filing_at,
    periodsCovered: row.periods_covered,
    periodsWithFilings: row.periods_with_filings,
    latestCorpusPeriod: latestCorpusPeriod || null,
    earliestCorpusPeriod: cov.earliestPeriod || null,
    corpusWindowStart: cov.windowStart ?? null,
    corpusWindowEnd: cov.windowEnd ?? null,
    // How many of the searched quarters could distinguish employers by tax ID at all. Below
    // periodsCovered means the older files had no FEIN column and the match leaned on legal names.
    corpusFeinPeriods: cov.feinPeriods,
    // How many quarters behind the newest data this company's last filing is, and the decay that
    // implies. null lag = never filed in the window searched, which is NOT the same as stale.
    quartersSinceFiling: lag,
    recencyFactor: Math.round(recencyFactor * 100) / 100,
    recency: lag == null ? 'none'
           : lag <= CURRENT_MAX_LAG ? 'current'
           : lag <= RECENT_MAX_LAG ? 'recent' : 'stale',
    // The two gates the UI reads. `presentable` false means render NOTHING — not a zero and not
    // "no data" — because a name we could not safely resolve must not become a claim.
    presentable: matched && row.match_confidence >= PRESENTABLE_MIN_CONFIDENCE,
    highConfidence: matched && row.match_confidence >= HIGH_CONFIDENCE,
    source: row.source,
    provenance: parseJson(row.provenance_json, null),
    lastSeen: row.last_seen,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} company
 * @returns {ReturnType<typeof mapLcaRow>} null when this company has never been reconciled.
 */
function getCompanyLca(db, company) {
  let row;
  try {
    row = db.prepare(`SELECT * FROM company_lca_sponsorship WHERE company = ?`).get(company);
  } catch { return null; } // pre-migration DB — the company view must still render
  if (!row) return null;
  return mapLcaRow(row, getCorpusCoverage(db));
}

export {
  RECENCY_HALFLIFE_QUARTERS,
  CURRENT_MAX_LAG,
  RECENT_MAX_LAG,
  parseFiscalPeriod,
  periodOrdinal,
  formatFiscalPeriod,
  periodDisplayLabel,
  getCorpusCoverage,
  knownCompanies,
  reconcileCompanyLca,
  mapLcaRow,
  getCompanyLca,
  companyMatchKey,
};
