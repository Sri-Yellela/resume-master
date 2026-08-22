// Ingest DOL/OFLC LCA (H-1B, H-1B1, E-3) disclosure data into the Company KB (TASK X3).
//
// This is the source the posting-level H-1B experiment should have been from the start. Of 1,261
// scraped postings, 0 mention "H-1B" and the LLM backfill produced 3 non-null values, all false —
// the signal is not in posting text. But every H-1B-sponsoring employer MUST file a Labor Condition
// Application, and OFLC publishes every determination quarterly, keyed by employer.
//
// THE FILES ARE PER-QUARTER, NOT CUMULATIVE, and this matters enough to state twice. OFLC's own
// release notes read as if each file were fiscal-year-to-date ("all determinations issued during
// October 1 2025 through June 30 2026"); that describes the SET of files published so far. The
// FY2026 Q1 record layout says "Reporting Period: October 1, 2025 through December 31, 2025", and
// the decision dates agree (FY2026 Q1 = Oct 1-Dec 31 2025, FY2025 Q4 = Jul 1-Sep 30 2025, disjoint).
// So quarters SUM. Treating the newest file as a year-to-date total would undercount every sponsor
// roughly fourfold.
//
// MOST SHEETS CARRY PHANTOM BLANK ROWS, and the ratio is wildly inconsistent between files, which
// is why both counts are recorded rather than trusted. Measured over the five quarters ingested:
//   FY2026Q1    83,120 cases of 1,042,437 sheet rows   (12.5x)
//   FY2025Q1   107,414 cases of 1,042,871 sheet rows    (9.7x)
//   FY2025Q3   238,425 cases of   683,534 sheet rows    (2.9x)
//   FY2025Q2   132,133 cases of   132,133 sheet rows    (1.0x — none at all)
// The parser filters on EMPLOYER_NAME and stores both numbers in lca_source_files, so a regression
// in that filter shows up as a row count rather than as a silently multiplied corpus.
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

// Columns read from the sheet. An ALLOWLIST — see the PII note above.
const COLUMNS = [
  "CASE_STATUS", "DECISION_DATE", "JOB_TITLE", "TOTAL_WORKER_POSITIONS",
  "EMPLOYER_NAME", "TRADE_NAME_DBA", "EMPLOYER_STATE", "EMPLOYER_FEIN",
];
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
  let idx = null, sheetRows = 0, caseRows = 0, minDate = null, maxDate = null;

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
        continue;
      }
      sheetRows++;
      const name = cellText(v[idx.EMPLOYER_NAME]);
      if (!name) continue; // phantom blank row
      caseRows++;

      const fein = cellText(v[idx.EMPLOYER_FEIN]) || "";
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
  return { employers: [...employers.values()], sheetRows, caseRows, minDate, maxDate };
}

/**
 * Delete-then-insert for the period, in one transaction. This is what makes a re-import reconcile
 * rather than double: an employer that disappears from a re-issued file has to disappear from the
 * table too, which an upsert alone would never do.
 */
function writeQuarter(db, { period, year, quarter, fileName, byteSize, parsed }) {
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
      sheet_rows, case_rows, employer_rows, byte_size, source_url, ingested_at
    ) VALUES (
      @file_name, @fiscal_period, @fiscal_year, @fiscal_quarter, @period_start, @period_end,
      @sheet_rows, @case_rows, @employer_rows, @byte_size, @source_url, @ingested_at
    )
    ON CONFLICT(file_name) DO UPDATE SET
      fiscal_period = @fiscal_period, period_start = @period_start, period_end = @period_end,
      sheet_rows = @sheet_rows, case_rows = @case_rows, employer_rows = @employer_rows,
      byte_size = @byte_size, ingested_at = @ingested_at
  `);

  // Employers with no certified, denied or withdrawn case contribute nothing a reader could use.
  const rows = parsed.employers.filter(e => e.certified || e.denied || e.withdrawn);
  const run = db.transaction(() => {
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
      byte_size: byteSize, source_url: `${BASE_URL}/${fileName}`, ingested_at: now,
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
    const employerRows = writeQuarter(db, {
      period: w.period, year: w.year, quarter: w.quarter,
      fileName: path.basename(file), byteSize: fs.statSync(file).size, parsed,
    });
    const range = [parsed.minDate, parsed.maxDate]
      .map(t => (t ? new Date(t * 1000).toISOString().slice(0, 10) : "?")).join(" → ");
    log(`${w.period}: ${parsed.caseRows} cases of ${parsed.sheetRows} sheet rows, ` +
        `${employerRows} employers, ${range}, ${((Date.now() - started) / 1000).toFixed(0)}s`);
    if (!KEEP) fs.unlinkSync(file);
  }

  const summary = reconcileCompanyLca(db);
  log("reconciled:", JSON.stringify(summary));
  const coverage = getCorpusCoverage(db);
  log(`corpus: ${coverage.periodsCovered} quarter(s), newest ${coverage.latestPeriod}`);
}

main().catch(e => { console.error("[lca] FAILED:", e.message); process.exit(1); });
