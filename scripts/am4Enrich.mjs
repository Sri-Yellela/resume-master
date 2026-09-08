#!/usr/bin/env node
/**
 * AM4 / task U — THE MANUAL ENRICHMENT PATH: trigger, export, import, and batch provenance.
 *
 * WHY THIS EXISTS. Enrichment had three triggers and all three were automatic: the 04:00 ET cron,
 * a setImmediate after cacheJobs/cacheJoboFeed, and enrichJob.js's own row selection. There was no
 * manual path at all, which is how 837 of ~1252 active production rows accumulated unenriched
 * during the Groq 404 outage with nothing anyone could do short of waiting for tomorrow.
 *
 * ⛔ EVERY SPENDING COMMAND DEFAULTS TO A DRY RUN. `run` prints the row count and a cost ceiling and
 * exits; it needs --apply to send anything. The estimate is computed from the SAME selector the
 * real pass uses (services/jobs/enrichmentSelection.js), so it cannot quote one set and send another.
 *
 * Commands:
 *   node scripts/am4Enrich.mjs run                      # DRY RUN: what would be enriched, and the cost
 *   node scripts/am4Enrich.mjs run --apply --limit 10    # actually enrich 10 rows
 *   node scripts/am4Enrich.mjs run --apply --all         # repeat until no candidates remain
 *   node scripts/am4Enrich.mjs export --out batch.jsonl  # JSONL of rows needing enrichment
 *   node scripts/am4Enrich.mjs import batch.jsonl        # DRY RUN of an import
 *   node scripts/am4Enrich.mjs import batch.jsonl --apply
 *   node scripts/am4Enrich.mjs batches                   # provenance: recent batches
 *   node scripts/am4Enrich.mjs batch 7                   # one batch and what it filled
 *   node scripts/am4Enrich.mjs revert 7                  # undo a batch, restoring the before-image
 *
 * Shared flags:
 *   --limit N            cap the rows considered
 *   --ids a,b,c          operate on exactly these job_ids
 *   --ids-file PATH      the same, read from a JSON array — the shape a 10-row proof run needs,
 *                        because --limit takes the first N of an ordering and can quietly pick up
 *                        rows the operator did not mean (fixtures, say) alongside the intended ones
 *   --source NAME        restrict to one feed (greenhouse, ashby, ...)
 *   --max-last-seen N    freshness gate in days (default 7, matching the expiry); 0 disables it
 *   --db PATH            operate on a different database file (used to rehearse on a copy)
 * Import-only flags:
 *   --overwrite          allow replacing a non-null value (default: fill NULLs only)
 *   --allow-stale        allow rows whose posting changed since export (default: refuse)
 */

import "dotenv/config";
import Database from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runEnrichment } from "../services/jobs/enrichJob.js";
import {
  selectCandidates, estimateCost, columnCoverage, diffCoverage,
  DEFAULT_MAX_LAST_SEEN_DAYS, SOURCE_SILENT_COLUMNS,
} from "../services/jobs/enrichmentSelection.js";
import { buildExport, toJsonl, planImport, applyImport, formatPlan } from "../services/jobs/enrichmentTransfer.js";
import { listBatches, getBatch, revertBatch } from "../services/jobs/enrichmentBatches.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const cmd = argv[0];

const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt;
};
const num = (name, dflt) => {
  const v = opt(name);
  if (v == null) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

const DB_PATH = opt("db", path.join(ROOT, "data", "resume_master.db"));
const LIMIT = num("limit", null);
const SOURCE = opt("source", null);
const MAX_LAST_SEEN = num("max-last-seen", DEFAULT_MAX_LAST_SEEN_DAYS);
const APPLY = flag("apply");

// An explicit id list beats --limit for anything being measured: --limit takes the first N of an
// ordering, so the set it picks depends on discovered_at and can silently include rows the operator
// did not intend. A named list is reproducible.
const IDS = (() => {
  const inline = opt("ids", null);
  const file = opt("ids-file", null);
  if (inline) return inline.split(",").map(s => s.trim()).filter(Boolean);
  if (file) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`--ids-file ${file} must contain a JSON array`);
    return parsed;
  }
  return null;
})();

const bar = (c = "-") => c.repeat(88);
const die = (m) => { console.error("\n" + m); process.exit(2); };

if (!cmd || flag("help") || flag("h")) {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString().split("*/")[0].replace(/^#!.*\n/, ""));
  process.exit(0);
}
if (!fs.existsSync(DB_PATH)) die(`no database at ${DB_PATH}`);
const db = new Database(DB_PATH);

function anthropicOrDie() {
  const key = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || "";
  // runEnrichment degrades to a logged no-op without a client. Failing here instead means "I ran
  // it" can never quietly mean "it skipped" — the same reason scripts/runEnrichment.mjs refuses.
  if (!key) die("No ANTHROPIC_KEY (or ANTHROPIC_API_KEY). Refusing to run — enrichment would " +
                "silently skip rather than fail.");
  return new Anthropic({ apiKey: key });
}

/** The dry run. Shared by `run` and printed before any --apply, so both see the same numbers. */
function reportPlan() {
  const sel = selectCandidates(db, { maxLastSeenDays: MAX_LAST_SEEN, source: SOURCE, jobIds: IDS });
  const considered = LIMIT != null ? sel.candidates.slice(0, LIMIT) : sel.candidates;
  const est = estimateCost(considered);

  console.log(bar("="));
  console.log(`ENRICHMENT DRY RUN — ${path.basename(DB_PATH)}`);
  console.log(bar("="));
  console.log(`pre-filter matched      ${sel.prefilterCount}`);
  console.log(`real candidates         ${sel.totalMatched}   (after the content-hash comparison)`);
  if (sel.prefilterCount !== sel.totalMatched) {
    console.log(`  the gap is ${sel.prefilterCount - sel.totalMatched} rows whose updated_at moved but whose TEXT did not —`);
    console.log(`  pricing the pre-filter instead would overstate this run by ` +
                `${(sel.prefilterCount / Math.max(1, sel.totalMatched)).toFixed(0)}x`);
  }
  if (sel.gatedOut) {
    console.log(`freshness gate excluded ${sel.gatedOut}   (not seen in ${MAX_LAST_SEEN} days — awaiting expiry)`);
  }
  console.log(`no description at all   ${sel.noDescription}   (can never be enriched)`);
  console.log(`this run would send     ${considered.length}${LIMIT != null ? `   (--limit ${LIMIT})` : ""}`);
  console.log("");
  console.log(`ESTIMATED CEILING       $${est.usd.toFixed(4)}   ` +
              `(${est.inputTokens} in + up to ${est.outputTokens} out tokens, Haiku 4.5 list price)`);
  console.log(`  a ceiling, not a quote: input is real, output is priced at the max_tokens cap.`);
  return { considered, est, sel };
}

function printCoverage(before, after, label = "coverage") {
  const d = diffCoverage(before, after);
  console.log("");
  console.log(`${label} over ${after.total} row(s) — per column, because a row count proves nothing:`);
  console.log(`  ${"column".padEnd(24)} ${"before".padStart(6)} ${"after".padStart(6)} ${"delta".padStart(6)}`);
  for (const r of d.rows) {
    const note = r.sourceSilent ? "   (source is silent — near-zero is correct)" : "";
    console.log(`  ${r.column.padEnd(24)} ${String(r.before).padStart(6)} ${String(r.after).padStart(6)} ` +
                `${(r.delta > 0 ? "+" + r.delta : String(r.delta)).padStart(6)}${note}`);
  }
  console.log("");
  console.log(`  ${d.climbed} column(s) climbed, ${d.regressed} regressed ` +
              `(the visa columns are excluded from this verdict: 0 of 1261 postings mention H-1B, ` +
              `so their emptiness is the SOURCE MATERIAL, not a pipeline failure)`);
  return d;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────

if (cmd === "run") {
  const { considered, est } = reportPlan();
  if (!considered.length) { console.log("\nNothing to do."); process.exit(0); }
  if (!APPLY) {
    console.log("\n--apply was NOT passed. Nothing was sent and no model was called.");
    process.exit(0);
  }

  const anthropic = anthropicOrDie();
  const ids = considered.map(r => r.job_id);
  const before = columnCoverage(db, { jobIds: ids });
  console.log(`\n${bar()}\nAPPLYING — up to ${considered.length} row(s), est. ceiling $${est.usd.toFixed(4)}\n${bar()}`);

  const batchIds = [];
  let pass = 0;
  for (;;) {
    pass++;
    const res = await runEnrichment(db, anthropic, {
      // The pass is restricted to the rows the dry run priced. Without this the batch size and the
      // ordering could pick up rows the estimate never covered, and the quoted number would be
      // about a different set than the spend.
      jobIds: ids,
      batchSize: LIMIT != null ? Math.min(LIMIT, 25) : 25,
      maxLastSeenDays: MAX_LAST_SEEN,
      batchSource: "manual",
      batchNotes: `scripts/am4Enrich.mjs run --apply${LIMIT != null ? ` --limit ${LIMIT}` : ""}`,
      recordRun: true,
    });
    if (res.batchId) batchIds.push(res.batchId);
    console.log(`pass ${pass}: enriched=${res.enriched} failed=${res.failed} empty=${res.empty} ` +
                `remaining=${res.skipped} batch=${res.batchId ?? "none"}`);
    if (!flag("all")) break;
    if (!res.enriched) { console.log("no progress this pass — stopping"); break; }
  }

  const d = printCoverage(before, columnCoverage(db, { jobIds: ids }), "coverage for the rows this run touched");
  console.log(`\nbatches: ${batchIds.join(", ") || "none"}`);
  // U1.5 — "If coverage does not climb with the count, STOP." Said in the exit code, so a wrapper
  // or a CI step can act on it rather than having to parse this output.
  if (!d.climbed) {
    console.error("\n⛔ NO COLUMN GAINED A VALUE. Task U1.5: if coverage does not climb with the " +
                  "count, STOP — do not scale this up. Check the provider and model before rerunning.");
    process.exit(3);
  }
  process.exit(0);
}

if (cmd === "export") {
  const out = opt("out", null);
  const { rows, meta } = buildExport(db, {
    candidatesOnly: !flag("all-rows"),
    maxLastSeenDays: MAX_LAST_SEEN, source: SOURCE, limit: LIMIT, jobIds: IDS,
  });
  const jsonl = toJsonl({ rows, meta });
  if (out) {
    fs.writeFileSync(out, jsonl, "utf8");
    console.log(`wrote ${rows.length} row(s) to ${out}`);
  } else {
    process.stdout.write(jsonl);
  }
  console.error(`\n${rows.length} row(s) exported. ` +
    `WRITABLE columns: ${meta.writableColumns.join(", ")}.\n` +
    `Everything under "source" is READ-ONLY and is ignored on import.\n` +
    `Keep job_id and content_hash on every row — content_hash is what lets the importer refuse ` +
    `enrichment derived from text that has since changed.`);
  process.exit(0);
}

if (cmd === "import") {
  const file = argv[1];
  if (!file || file.startsWith("--")) die("usage: import <file.jsonl> [--apply] [--overwrite] [--allow-stale]");
  if (!fs.existsSync(file)) die(`no such file: ${file}`);
  const text = fs.readFileSync(file, "utf8");
  const options = { overwrite: flag("overwrite"), allowStale: flag("allow-stale") };

  console.log(bar("="));
  console.log(`IMPORT ${APPLY ? "" : "DRY RUN "}— ${file} -> ${path.basename(DB_PATH)}`);
  console.log(bar("="));
  const plan = planImport(db, text, options);
  console.log(formatPlan(plan));

  if (!APPLY) { console.log("\n--apply was NOT passed. Nothing was written."); process.exit(plan.valid ? 0 : 1); }
  if (!plan.valid) {
    die("⛔ REFUSED — the file has rejected rows and is applied as a whole or not at all. " +
        "Nothing was written. Fix the rows listed above.");
  }

  const ids = plan.planned.filter(p => p.wouldWrite).map(p => p.jobId);
  const before = columnCoverage(db, { jobIds: ids });
  const res = applyImport(db, text, options);
  if (!res.ok) die(`⛔ ${res.reason}`);
  console.log(`\napplied: ${res.written} row(s) written, batch ${res.batchId ?? "none"}`);
  if (ids.length) printCoverage(before, columnCoverage(db, { jobIds: ids }), "coverage for the imported rows");
  process.exit(0);
}

if (cmd === "batches") {
  const rows = listBatches(db, { limit: num("limit", 20) });
  if (!rows.length) { console.log("no enrichment batches recorded yet"); process.exit(0); }
  console.log(`${"id".padStart(4)} ${"source".padEnd(8)} ${"model".padEnd(28)} ` +
              `${"att".padStart(4)} ${"wrote".padStart(5)} ${"fail".padStart(4)} ${"empty".padStart(5)} ` +
              `${"cost".padStart(8)}  started              state`);
  for (const b of rows) {
    const started = new Date(b.started_at * 1000).toISOString().replace("T", " ").slice(0, 19);
    const state = b.reverted_at ? "REVERTED" : b.finished_at ? "done" : "OPEN (died?)";
    console.log(`${String(b.id).padStart(4)} ${String(b.source).padEnd(8)} ${String(b.model ?? "-").padEnd(28)} ` +
                `${String(b.rows_attempted).padStart(4)} ${String(b.rows_written).padStart(5)} ` +
                `${String(b.rows_failed).padStart(4)} ${String(b.rows_empty).padStart(5)} ` +
                `${("$" + Number(b.est_cost_usd).toFixed(4)).padStart(8)}  ${started}  ${state}`);
  }
  process.exit(0);
}

if (cmd === "batch") {
  const id = Number(argv[1]);
  if (!Number.isFinite(id)) die("usage: batch <id>");
  const b = getBatch(db, id);
  if (!b) die(`no batch ${id}`);
  console.log(`batch ${b.id}: source=${b.source} provider=${b.provider ?? "-"} model=${b.model ?? "-"}`);
  console.log(`  started ${new Date(b.started_at * 1000).toISOString()}` +
              `${b.finished_at ? `  finished ${new Date(b.finished_at * 1000).toISOString()}` : "  NOT FINISHED"}`);
  console.log(`  attempted=${b.rows_attempted} wrote=${b.rows_written} failed=${b.rows_failed} empty=${b.rows_empty}`);
  console.log(`  tokens ${b.input_tokens} in / ${b.output_tokens} out, est $${Number(b.est_cost_usd).toFixed(4)}`);
  if (b.reverted_at) console.log(`  ⚠ REVERTED at ${new Date(b.reverted_at * 1000).toISOString()}`);
  if (b.notes) console.log(`  notes: ${b.notes}`);
  const fills = {}, corrections = {};
  for (const r of b.rows) {
    for (const c of r.filled) fills[c] = (fills[c] || 0) + 1;
    for (const c of r.corrected) corrections[c] = (corrections[c] || 0) + 1;
  }
  console.log(`\n  ${b.rows.length} row(s) recorded. Columns FILLED (null -> value):`);
  for (const [c, n] of Object.entries(fills).sort((a, b2) => b2[1] - a[1])) console.log(`    ${c.padEnd(24)} ${n}`);
  if (!Object.keys(fills).length) console.log("    none");
  if (Object.keys(corrections).length) {
    console.log(`  Columns CORRECTED (value -> different value):`);
    for (const [c, n] of Object.entries(corrections).sort((a, b2) => b2[1] - a[1])) console.log(`    ${c.padEnd(24)} ${n}`);
  }
  process.exit(0);
}

if (cmd === "revert") {
  const id = Number(argv[1]);
  if (!Number.isFinite(id)) die("usage: revert <id> [--apply]");
  const b = getBatch(db, id);
  if (!b) die(`no batch ${id}`);
  console.log(`batch ${id} (${b.source}, ${b.rows.length} recorded row(s))`);
  if (!APPLY) {
    console.log(`\nDRY RUN — would restore ${b.rows.length} row(s) to their recorded prior state, ` +
                `including enriched_at and content_hash (which puts them back in the candidate set).`);
    console.log("Values that came from INGESTION are preserved: the revert replays a per-row " +
                "before-image rather than nulling the enrichment columns.");
    console.log("\n--apply was NOT passed. Nothing was changed.");
    process.exit(0);
  }
  const res = revertBatch(db, id);
  if (!res.ok) die(`⛔ ${res.reason}`);
  console.log(`\nrestored ${res.restored} of ${res.rowsRecorded} recorded row(s)` +
              `${res.missing ? `; ${res.missing} row(s) no longer exist and could not be restored` : ""}`);
  process.exit(0);
}

die(`unknown command: ${cmd}\nRun with --help for usage.`);
