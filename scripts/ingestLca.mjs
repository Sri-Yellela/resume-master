// Ingest DOL/OFLC LCA (H-1B, H-1B1, E-3) disclosure data into the Company KB (TASK X3).
//
// This is the source the posting-level H-1B experiment should have been from the start. Of 1,261
// scraped postings, 0 mention "H-1B" and the LLM backfill produced 3 non-null values, all false —
// the signal is not in posting text. But every H-1B-sponsoring employer MUST file a Labor Condition
// Application, and OFLC publishes every determination quarterly, keyed by employer.
//
// WHAT A "QUARTERLY FILE" MEANS CHANGED PART-WAY THROUGH THE HISTORY, and nothing in the filename
// or the record layout tells you which convention you are holding. Measured from the decision dates
// inside the files:
//
//   FY2021 Q1   2020-10-01 → 2020-12-31   1 quarter
//   FY2021 Q2   2020-10-01 → 2021-03-31   2 quarters — CONTAINS Q1
//   FY2021 Q3   2020-10-01 → 2021-06-30   3 quarters — CONTAINS Q2
//   FY2025 Q1   2024-10-01 → 2024-12-31   1 quarter
//   FY2025 Q2   2025-01-01 → 2025-03-31   1 quarter — disjoint from Q1
//
// The older files are FISCAL-YEAR CUMULATIVE; the newer ones are per-quarter. Both are labelled
// identically. Reading the FY2025 pair and generalising "the files are per-quarter, so sum them"
// is correct for those and TRIPLE-COUNTS FY2021 Q1 — which is what the first version of this
// script did. OFLC's own release notes do not settle it either: "all determinations issued during
// October 1 2025 through June 30 2026" describes the SET of files published to date, not one file.
//
// So the window is never assumed. Each file's true span is derived from its own decision dates, and
// planWindow() drops any period whose span is contained in another's. A cumulative fiscal year
// collapses to ONE period row holding the whole year; per-quarter years keep all four. No list of
// which years were cumulative appears anywhere, because such a list would be wrong the next time
// OFLC changes its mind.
//
// MANY SHEETS CARRY PHANTOM BLANK ROWS, and the ratio is wildly inconsistent — not by year, not by
// size, not by anything predictable — which is why both counts are recorded rather than trusted.
// Measured across all 18 ingested files, sheet-rows / real-cases:
//   FY2026Q1  12.5x        FY2025Q1   9.7x        FY2024Q4   5.0x        FY2023Q4   4.9x
//   FY2025Q4   4.8x        FY2023Q2   4.5x        FY2023Q3   3.7x        FY2024Q3   3.2x
//   FY2025Q3   2.9x        every FY2021 and FY2022 file, plus FY2024 Q1-Q2 and FY2025 Q2:  1.0x
// So a third of the files are clean and one is 12x padding. The parser filters on EMPLOYER_NAME and
// stores both numbers in lca_source_files, so a regression in that filter shows up as a row count
// rather than as a silently multiplied corpus.
//
// IDEMPOTENT BY RECONCILIATION, not by hoping. Re-importing a quarter deletes that quarter's rows
// and reinserts them inside one transaction, so a re-run — or a re-issued file with corrections —
// converges instead of doubling. Same discipline as the job pipeline's req_uid.
//
// WHAT IS NOT STORED. The disclosure file withholds only attorney FEIN and bar number as PII, which
// leaves employer/attorney/preparer contact names, emails and phone numbers in the sheet. None of
// them are read. The column list below is an allowlist for exactly that reason — the same rule as
// company_form_schemas' structure-only capture.
//
// Usage:
//   node scripts/ingestLca.mjs --dry-run                  # what it would fetch, no writes
//   node scripts/ingestLca.mjs                            # last 5 quarters, then reconcile
//   node scripts/ingestLca.mjs --from=FY2024Q1 --to=FY2026Q1
//   node scripts/ingestLca.mjs --periods=FY2026Q1
//   node scripts/ingestLca.mjs --reconcile-only           # re-match without re-downloading 2 GB
//   node scripts/ingestLca.mjs --discover                 # probe which quarters DOL is serving
import "dotenv/config";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { companyMatchKey, parseDbaNames } from "../services/kb/lcaMatch.js";
import {
  reconcileCompanyLca, knownCompanies, getCorpusCoverage,
  formatFiscalPeriod, periodOrdinal,
} from "../services/kb/lcaLayer.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = "https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs";
// dol.gov HTML pages 403 anything that is not a browser (Akamai), but the .xlsx asset URLs serve
// fine to a plain fetch. So filenames are PROBED, never scraped from the index page.
const fileNameFor = (year, quarter) => `LCA_Disclosure_Data_FY${year}_Q${quarter}.xlsx`;
// Node's default undici User-Agent is 403'd by dol.gov's edge; curl's is not. The same public file
// from the same public path — this only identifies the client in a form the CDN recognises.
const FETCH_HEADERS = { "User-Agent": "curl/8.0 (resume-master lca-ingest)" };

// Columns read from the sheet. An ALLOWLIST — see the PII note above. A missing REQUIRED column is
// fatal: the layout has changed and guessing would be worse than stopping.
const COLUMNS = [
  "CASE_STATUS", "DECISION_DATE", "JOB_TITLE", "TOTAL_WORKER_POSITIONS",
  "EMPLOYER_NAME", "TRADE_NAME_DBA", "EMPLOYER_STATE",
];
// THE LAYOUT CHANGED IN FY2024. EMPLOYER_FEIN does not exist in FY2021 through FY2023 — those are
// 96 columns with no employer tax ID anywhere in them, and FY2024 Q1 onward is 98 with it. Measured,
// not assumed: FY2023 Q4 parses NO-FEIN and FY2024 Q1 parses FEIN. It is optional rather than
// required because refusing twelve of the twenty-one available quarters over one absent column would
// throw away three years of history, and because the matcher degrades honestly without
// it: countDistinctEntities() falls back to counting distinct legal names, which is STRICTER than
// counting FEINs, so the tier-C ambiguity guard gets more cautious over old data rather than
// silently switching off. `has_employer_fein` records which files carried it, so the limitation is
// a column in the ledger and not something a future reader has to rediscover.
//
// One knock-on that is deliberately NOT worked around: with no FEIN, two employers whose normalised
// names collide ("Apex Technologies, Inc." and "Apex Technologies LLC" both key to "apex
// technologies") merge into one row per quarter with their counts summed. That sounds worse than it
// is — tier A already sums across every FEIN sharing a key, on purpose, because one brand's legal
// family is one employer for this question, so the TOTAL is what tier A would have produced anyway.
// What is genuinely lost is the entity list: a merged pre-FY2024 row can name only one of them.
// Measured at 1.0% of keys spanning more than one FEIN in the quarters that have FEINs, nearly all
// of those being real subsidiaries, so this buys nothing worth a second identity scheme.
const OPTIONAL_COLUMNS = ["EMPLOYER_FEIN"];
const DEFAULT_QUARTERS = 5;
// Job titles are stored only for employers with at least this many certified cases in the quarter.
// A titles blob on all ~18k employers per quarter is most of the disk this table costs, and a
// single-case employer's one title is not a hiring pattern worth the bytes.
const TITLES_MIN_CERTIFIED = 3;
const MAX_TITLES_PER_EMPLOYER = 5;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt = null) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const DRY = flag("dry-run");
const RECONCILE_ONLY = flag("reconcile-only");
const DISCOVER = flag("discover");
const KEEP = !flag("no-cache");
const CACHE_DIR = opt("cache", path.join(ROOT, "data", "lca-cache"));

const log = (...a) => console.log("[lca]", ...a);

/**
 * A cell's text, for the several shapes exceljs hands back.
 *
 * NOT decoration: a plain String(value) turned 5,943 of 127,445 rows' job titles into the literal
 * "[object Object]", because employers paste formatted text into the ETA-9035 form and those cells
 * arrive as `{ richText: [...] }` rather than as strings. It reached the screen as a top-titles chip
 * reading "[object Object] 40" before this existed. Applied to every text field, not just
 * JOB_TITLE — the same cell shape in EMPLOYER_NAME would normalise to the key "object object" and
 * silently merge unrelated employers.
 */
function cellText(v) {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v.richText)) return v.richText.map(r => r?.text ?? "").join("").trim() || null;
  if (typeof v.text === "string") return v.text.trim() || null;         // hyperlink cell
  if (v.result != null) return cellText(v.result);                       // formula cell
  return null;
}

/** Excel 1900-system serial (or a Date exceljs already coerced) -> unix seconds. */
function serialToUnix(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round((n - 25569) * 86400);
}

async function headOk(url) {
  try {
    const res = await fetch(url, { method: "HEAD", headers: FETCH_HEADERS });
    return res.ok ? Number(res.headers.get("content-length")) || 0 : 0;
  } catch { return 0; }
}

/** Which quarters DOL is actually serving right now, newest last. */
async function discoverPeriods() {
  const thisFy = new Date().getUTCFullYear() + 1; // fiscal years run ahead of calendar years
  const found = [];
  for (let year = thisFy; year >= thisFy - 6; year--) {
    for (let q = 1; q <= 4; q++) {
      const size = await headOk(`${BASE_URL}/${fileNameFor(year, q)}`);
      if (size > 0) found.push({ period: formatFiscalPeriod(year, q), year, quarter: q, size });
    }
  }
  return found.sort((a, b) => periodOrdinal(a.period) - periodOrdinal(b.period));
}

async function download(year, quarter) {
  const name = fileNameFor(year, quarter);
  const dest = path.join(CACHE_DIR, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) {
    log(`cached  ${name} (${(fs.statSync(dest).size / 1048576).toFixed(0)} MB)`);
    return dest;
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const url = `${BASE_URL}/${name}`;
  log(`fetch   ${url}`);
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  log(`saved   ${name} (${(buf.length / 1048576).toFixed(0)} MB)`);
  return dest;
}

/**
 * Streams one quarterly file into per-(employer, FEIN) aggregates. Returns the aggregates plus the
 * counts lca_source_files records, so the phantom-blank-row ratio stays observable.
 */
async function parseQuarter(file) {
  const wb = new ExcelJS.stream.xlsx.WorkbookReader(file, {
    sharedStrings: "cache", worksheets: "emit", entries: "emit",
  });
  const employers = new Map();
  let idx = null, sheetRows = 0, caseRows = 0, minDate = null, maxDate = null, hasFein = false;

  for await (const ws of wb) {
    for await (const row of ws) {
      const v = row.values;
      if (!idx) {
        const header = v.map(x => (x == null ? "" : String(x).trim()));
        idx = {};
        for (const c of COLUMNS) {
          const at = header.indexOf(c);
          if (at < 0) throw new Error(`column ${c} missing from ${path.basename(file)}`);
          idx[c] = at;
        }
        for (const c of OPTIONAL_COLUMNS) {
          const at = header.indexOf(c);
          idx[c] = at < 0 ? null : at;
        }
        hasFein = idx.EMPLOYER_FEIN != null;
        continue;
      }
      sheetRows++;
      const name = cellText(v[idx.EMPLOYER_NAME]);
      if (!name) continue; // phantom blank row
      caseRows++;

      // '' when the file has no FEIN column at all, which is the pre-FY2024 case. It is a
      // sentinel and not a value: the primary key needs NOT NULL, and countDistinctEntities()
      // reads the emptiness as "cannot distinguish entities this way here".
      const fein = (idx.EMPLOYER_FEIN == null ? null : cellText(v[idx.EMPLOYER_FEIN])) || "";
      const key = companyMatchKey(name);
      const id = `${key}|${fein}`;
      let e = employers.get(id);
      if (!e) {
        e = {
          employer_key: key, fein, employer_name: name,
          state: cellText(v[idx.EMPLOYER_STATE]),
          dba: new Set(), certified: 0, denied: 0, withdrawn: 0, positions: 0,
          titles: new Map(), last_decision: null,
        };
        employers.set(id, e);
      }
      // Rippling is reachable ONLY through these two fields ("People Center, Inc. d/b/a Rippling").
      for (const d of parseDbaNames(name)) e.dba.add(d);
      const trade = cellText(v[idx.TRADE_NAME_DBA]);
      if (trade) {
        for (const d of parseDbaNames(trade)) e.dba.add(d);
        const tradeKey = companyMatchKey(trade);
        if (tradeKey && tradeKey !== key) e.dba.add(tradeKey);
      }

      const status = cellText(v[idx.CASE_STATUS]) || "";
      // 'Certified - Withdrawn' counts as certified: OFLC DID issue the certification, and the
      // employer withdrawing the application afterwards does not unmake the evidence that they
      // filed one. Kept in `withdrawn` only when it never got certified at all.
      if (/^Certified/i.test(status)) e.certified++;
      else if (/^Denied/i.test(status)) e.denied++;
      else if (/^Withdrawn/i.test(status)) e.withdrawn++;

      const positions = Number(v[idx.TOTAL_WORKER_POSITIONS]);
      if (Number.isFinite(positions)) e.positions += positions;

      const title = cellText(v[idx.JOB_TITLE]);
      if (title) {
        const t = title.slice(0, 60);
        e.titles.set(t, (e.titles.get(t) || 0) + 1);
      }
      const decided = serialToUnix(v[idx.DECISION_DATE]);
      if (decided != null) {
        if (e.last_decision == null || decided > e.last_decision) e.last_decision = decided;
        if (minDate == null || decided < minDate) minDate = decided;
        if (maxDate == null || decided > maxDate) maxDate = decided;
      }
    }
    break; // one sheet per file
  }
  return { employers: [...employers.values()], sheetRows, caseRows, minDate, maxDate, hasFein };
}

const SECONDS_PER_QUARTER = 91.3125 * 86400;

/** A file's true reporting window, in quarters. 1 for a per-quarter file, up to 4 for a cumulative one. */
function quartersInWindow(minDate, maxDate) {
  if (minDate == null || maxDate == null) return null;
  return Math.max(1, Math.min(4, Math.round((maxDate - minDate) / SECONDS_PER_QUARTER)));
}

/**
 * Which already-ingested periods this file's window swallows, and whether an existing one swallows
 * IT — the de-overlap decision.
 *
 * Necessary because OFLC changed conventions mid-history: the FY2021-FY2022 files are fiscal-year
 * CUMULATIVE (FY2021 Q3 covers 2020-10-01 to 2021-06-30, i.e. Q1+Q2+Q3) while FY2025 onward are
 * per-quarter and disjoint. Summing across periods is right for the new files and triple-counts the
 * old ones, and the filename gives no hint which you have. So the window is measured from the
 * decision dates in the file and compared against what is already stored: a strict superset
 * supersedes what it contains, a strict subset is skipped, and disjoint windows coexist. The end
 * state for a cumulative fiscal year is ONE period row holding the whole year, reached without
 * anyone hard-coding which years were cumulative.
 */
function planWindow(db, { period, minDate, maxDate }) {
  if (minDate == null || maxDate == null) return { supersedes: [], supersededBy: null };
  const rows = db.prepare(
    `SELECT fiscal_period, period_start, period_end FROM lca_source_files
      WHERE fiscal_period != ? AND period_start IS NOT NULL AND period_end IS NOT NULL`
  ).all(period);
  const supersedes = [];
  let supersededBy = null;
  for (const r of rows) {
    const containsIt = minDate <= r.period_start && maxDate >= r.period_end;
    const containedBy = r.period_start <= minDate && r.period_end >= maxDate;
    // Equal windows would satisfy both; treat that as "already have it" and skip, since two files
    // reporting the identical window are the same data under two labels.
    if (containedBy && !(containsIt && (minDate !== r.period_start || maxDate !== r.period_end))) {
      supersededBy = r.fiscal_period;
      break;
    }
    if (containsIt) supersedes.push(r.fiscal_period);
  }
  return { supersedes, supersededBy };
}

/**
 * Delete-then-insert for the period, in one transaction. This is what makes a re-import reconcile
 * rather than double: an employer that disappears from a re-issued file has to disappear from the
 * table too, which an upsert alone would never do.
 *
 * `supersedes` names periods whose window this file fully contains — their rows go in the same
 * transaction, so the store is never briefly double-counted.
 */
function writeQuarter(db, { period, year, quarter, fileName, byteSize, parsed, supersedes = [] }) {
  const now = Math.floor(Date.now() / 1000);
  const del = db.prepare(`DELETE FROM lca_employer_periods WHERE fiscal_period = ?`);
  const ins = db.prepare(`
    INSERT INTO lca_employer_periods (
      employer_key, fein, fiscal_period, employer_name, dba_keys_json, state,
      certified, denied, withdrawn, positions, top_titles_json, last_decision
    ) VALUES (
      @employer_key, @fein, @fiscal_period, @employer_name, @dba_keys_json, @state,
      @certified, @denied, @withdrawn, @positions, @top_titles_json, @last_decision
    )
    ON CONFLICT(employer_key, fein, fiscal_period) DO UPDATE SET
      employer_name = @employer_name, dba_keys_json = @dba_keys_json, state = @state,
      certified = @certified, denied = @denied, withdrawn = @withdrawn,
      positions = @positions, top_titles_json = @top_titles_json,
      last_decision = @last_decision
  `);
  const insFile = db.prepare(`
    INSERT INTO lca_source_files (
      file_name, fiscal_period, fiscal_year, fiscal_quarter, period_start, period_end,
      sheet_rows, case_rows, employer_rows, byte_size, source_url, has_employer_fein,
      quarters_covered, ingested_at
    ) VALUES (
      @file_name, @fiscal_period, @fiscal_year, @fiscal_quarter, @period_start, @period_end,
      @sheet_rows, @case_rows, @employer_rows, @byte_size, @source_url, @has_employer_fein,
      @quarters_covered, @ingested_at
    )
    ON CONFLICT(file_name) DO UPDATE SET
      fiscal_period = @fiscal_period, period_start = @period_start, period_end = @period_end,
      sheet_rows = @sheet_rows, case_rows = @case_rows, employer_rows = @employer_rows,
      byte_size = @byte_size, has_employer_fein = @has_employer_fein,
      quarters_covered = @quarters_covered, ingested_at = @ingested_at
  `);

  // Employers with no certified, denied or withdrawn case contribute nothing a reader could use.
  const rows = parsed.employers.filter(e => e.certified || e.denied || e.withdrawn);
  const delLedger = db.prepare(`DELETE FROM lca_source_files WHERE fiscal_period = ?`);
  const run = db.transaction(() => {
    // Superseded periods go in the SAME transaction as the replacement, so the store is never
    // momentarily holding both a cumulative file and the quarters it contains.
    for (const stale of supersedes) { del.run(stale); delLedger.run(stale); }
    del.run(period);
    for (const e of rows) {
      const titles = e.certified >= TITLES_MIN_CERTIFIED
        ? Object.fromEntries([...e.titles.entries()]
            .sort((a, b) => b[1] - a[1]).slice(0, MAX_TITLES_PER_EMPLOYER))
        : null;
      ins.run({
        employer_key: e.employer_key, fein: e.fein, fiscal_period: period,
        employer_name: e.employer_name,
        dba_keys_json: e.dba.size ? JSON.stringify([...e.dba]) : null,
        state: e.state, certified: e.certified, denied: e.denied, withdrawn: e.withdrawn,
        positions: e.positions,
        top_titles_json: titles ? JSON.stringify(titles) : null,
        last_decision: e.last_decision,
      });
    }
    insFile.run({
      file_name: fileName, fiscal_period: period, fiscal_year: year, fiscal_quarter: quarter,
      period_start: parsed.minDate, period_end: parsed.maxDate,
      sheet_rows: parsed.sheetRows, case_rows: parsed.caseRows, employer_rows: rows.length,
      byte_size: byteSize, source_url: `${BASE_URL}/${fileName}`,
      has_employer_fein: parsed.hasFein ? 1 : 0,
      quarters_covered: quartersInWindow(parsed.minDate, parsed.maxDate), ingested_at: now,
    });
  });
  run();
  return rows.length;
}

function resolveRequestedPeriods(available) {
  const explicit = opt("periods");
  if (explicit) {
    const want = new Set(explicit.split(",").map(s => s.trim().toUpperCase()));
    return available.filter(a => want.has(a.period));
  }
  const from = opt("from"), to = opt("to");
  if (from || to) {
    const lo = from ? periodOrdinal(from.toUpperCase()) : -Infinity;
    const hi = to ? periodOrdinal(to.toUpperCase()) : Infinity;
    return available.filter(a => periodOrdinal(a.period) >= lo && periodOrdinal(a.period) <= hi);
  }
  return available.slice(-DEFAULT_QUARTERS);
}

async function main() {
  const db = new Database(path.join(ROOT, "data", "resume_master.db"));

  if (RECONCILE_ONLY) {
    const coverage = getCorpusCoverage(db);
    log(`reconcile-only over ${coverage.periodsCovered} ingested quarter(s): ${coverage.periods.join(", ") || "(none)"}`);
    const summary = reconcileCompanyLca(db);
    log("reconciled:", JSON.stringify(summary));
    return;
  }

  log(`probing ${BASE_URL} for available quarters…`);
  const available = await discoverPeriods();
  if (!available.length) throw new Error("no LCA disclosure files reachable — is the network up?");
  log(`available: ${available.map(a => `${a.period}(${(a.size / 1048576).toFixed(0)}MB)`).join(" ")}`);
  if (DISCOVER) return;

  const wanted = resolveRequestedPeriods(available);
  if (!wanted.length) throw new Error("no quarters matched the requested range");
  const totalMb = wanted.reduce((n, w) => n + w.size, 0) / 1048576;
  log(`selected ${wanted.length} quarter(s): ${wanted.map(w => w.period).join(", ")} (~${totalMb.toFixed(0)} MB)`);
  log(`companies to reconcile afterwards: ${knownCompanies(db).length}`);
  if (DRY) { log("--dry-run: nothing downloaded, nothing written"); return; }

  for (const w of wanted) {
    const file = await download(w.year, w.quarter);
    const started = Date.now();
    const parsed = await parseQuarter(file);
    const range = [parsed.minDate, parsed.maxDate]
      .map(t => (t ? new Date(t * 1000).toISOString().slice(0, 10) : "?")).join(" → ");
    const quarters = quartersInWindow(parsed.minDate, parsed.maxDate);
    const plan = planWindow(db, { period: w.period, minDate: parsed.minDate, maxDate: parsed.maxDate });
    if (plan.supersededBy) {
      log(`${w.period}: ${range} (${quarters}q) is already covered by ${plan.supersededBy} — SKIPPED`);
      if (!KEEP) fs.unlinkSync(file);
      continue;
    }
    const employerRows = writeQuarter(db, {
      period: w.period, year: w.year, quarter: w.quarter,
      fileName: path.basename(file), byteSize: fs.statSync(file).size, parsed,
      supersedes: plan.supersedes,
    });
    log(`${w.period}: ${parsed.caseRows} cases of ${parsed.sheetRows} sheet rows, ` +
        `${employerRows} employers, ${range} (${quarters}q), ` +
        `${parsed.hasFein ? "FEIN" : "NO-FEIN"}` +
        `${plan.supersedes.length ? `, supersedes ${plan.supersedes.join("+")}` : ""}, ` +
        `${((Date.now() - started) / 1000).toFixed(0)}s`);
    if (!KEEP) fs.unlinkSync(file);
  }

  const summary = reconcileCompanyLca(db);
  log("reconciled:", JSON.stringify(summary));
  const coverage = getCorpusCoverage(db);
  log(`corpus: ${coverage.periodsCovered} quarter(s), newest ${coverage.latestPeriod}`);
}

main().catch(e => { console.error("[lca] FAILED:", e.message); process.exit(1); });
