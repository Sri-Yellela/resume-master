// scripts/reclassifyJobs.js
// Phase 5 backfill: iterate all scraped_jobs, apply the unified classifyJob verdict.
//
// Results per row:
//   collar === 'blue'   → move to rejected_jobs, DELETE from scraped_jobs + job_role_map
//   roleKey === null    → DELETE (white-ish but no signal — drop)
//   otherwise          → UPDATE bucket_*/collar/confidence, UPSERT job_role_map
//
// Run: node scripts/reclassifyJobs.js [--dry-run]
// --dry-run: counts without writing; useful to preview impact.
import Database from "better-sqlite3";
import path     from "path";
import { fileURLToPath } from "url";
import { classifyJob } from "../services/jobs/classifyJob.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "..", "data", "resume_master.db");
const DRY_RUN   = process.argv.includes("--dry-run");

// ── Open DB ──────────────────────────────────────────────────────────────────
let db;
try {
  db = new Database(DB_PATH, { readonly: DRY_RUN });
} catch (e) {
  console.error(`[reclassify] Cannot open DB at ${DB_PATH}:`, e.message);
  console.error("[reclassify] Run the server once to initialise the schema, then re-run this script.");
  process.exit(1);
}

// ── Verify schema ─────────────────────────────────────────────────────────────
const tables = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
);
if (!tables.has("scraped_jobs")) {
  console.log("[reclassify] scraped_jobs table not found — nothing to backfill.");
  db.close();
  process.exit(0);
}
if (!tables.has("rejected_jobs")) {
  console.error("[reclassify] rejected_jobs table missing — run Phase 3 migration first.");
  db.close();
  process.exit(1);
}

// Check that collar/classification_confidence columns exist (Phase 3 migration)
const scraped_cols = new Set(
  db.prepare("PRAGMA table_info(scraped_jobs)").all().map(r => r.name)
);
if (!scraped_cols.has("collar") || !scraped_cols.has("classification_confidence")) {
  console.error("[reclassify] scraped_jobs is missing collar/classification_confidence columns.");
  console.error("  Run the server once (Phase 3 migration) then re-run this script.");
  db.close();
  process.exit(1);
}

// ── Fetch all jobs ────────────────────────────────────────────────────────────
const rows = db.prepare(
  "SELECT job_id, title, company, description, source FROM scraped_jobs ORDER BY scraped_at DESC"
).all();

const total = rows.length;
if (total === 0) {
  console.log("[reclassify] No jobs in scraped_jobs — nothing to backfill.");
  db.close();
  process.exit(0);
}

console.log(`[reclassify] Processing ${total} jobs${DRY_RUN ? " (DRY RUN — no writes)" : ""}…`);

// ── Prepared statements (only used when not DRY_RUN) ─────────────────────────
const updateStmt = DRY_RUN ? null : db.prepare(`
  UPDATE scraped_jobs
  SET bucket_role              = ?,
      bucket_seniority         = ?,
      bucket_domain            = ?,
      collar                   = 'white',
      classification_confidence = ?
  WHERE job_id = ?
`);

const upsertRoleMap = DRY_RUN ? null : db.prepare(`
  INSERT OR REPLACE INTO job_role_map
    (job_id, role_key, role_family, domain, confidence, matched_by)
  VALUES (?, ?, ?, ?, ?, 'backfill_reclassify')
`);

const rejectStmt = DRY_RUN ? null : db.prepare(`
  INSERT OR REPLACE INTO rejected_jobs (job_id, title, company, source, reason, rejected_at)
  VALUES (?, ?, ?, ?, 'blue_collar', unixepoch())
`);

const deleteScraped  = DRY_RUN ? null : db.prepare("DELETE FROM scraped_jobs WHERE job_id = ?");
const deleteRoleMap  = DRY_RUN ? null : db.prepare("DELETE FROM job_role_map  WHERE job_id = ?");

// ── Counters ──────────────────────────────────────────────────────────────────
let ejected = 0, dropped = 0, reclassified = 0, nowGeneral = 0;
const ejectedBySource  = {};
const droppedBySource  = {};

// ── Main loop ─────────────────────────────────────────────────────────────────
const backfill = DRY_RUN
  ? (jobs) => {
      for (const row of jobs) {
        const v = classifyJob(row.title || '', row.description || '', row.company || '');
        const src = row.source || 'unknown';
        if (v.collar === 'blue') {
          ejected++;
          ejectedBySource[src] = (ejectedBySource[src] || 0) + 1;
        } else if (v.roleKey === null) {
          dropped++;
          droppedBySource[src] = (droppedBySource[src] || 0) + 1;
        } else {
          reclassified++;
          if (v.roleKey === 'general') nowGeneral++;
        }
      }
    }
  : db.transaction((jobs) => {
      const now = Math.floor(Date.now() / 1000);
      for (const row of jobs) {
        const v   = classifyJob(row.title || '', row.description || '', row.company || '');
        const src = row.source || 'unknown';

        if (v.collar === 'blue') {
          deleteScraped.run(row.job_id);
          deleteRoleMap.run(row.job_id);
          rejectStmt.run(row.job_id, row.title || '', row.company || '', src);
          ejected++;
          ejectedBySource[src] = (ejectedBySource[src] || 0) + 1;
          continue;
        }

        if (v.roleKey === null) {
          // White-ish but no signal — remove from live board entirely
          deleteScraped.run(row.job_id);
          deleteRoleMap.run(row.job_id);
          dropped++;
          droppedBySource[src] = (droppedBySource[src] || 0) + 1;
          continue;
        }

        // White-collar with a verdict — update stored fields
        updateStmt.run(v.roleKey, v.seniority || null, v.domain || null, v.confidence || 0, row.job_id);
        upsertRoleMap.run(row.job_id, v.roleKey, v.roleKey, v.domain || null, v.confidence || 0);
        reclassified++;
        if (v.roleKey === 'general') nowGeneral++;
      }
    });

backfill(rows);

// ── Report ────────────────────────────────────────────────────────────────────
const prefix = DRY_RUN ? "[reclassify:dry-run]" : "[reclassify]";

console.log(`\n${prefix} ── Results ──────────────────────────────────────`);
console.log(`${prefix}  Total processed : ${total}`);
console.log(`${prefix}  Ejected (blue)  : ${ejected}`);
console.log(`${prefix}  Dropped (no sig): ${dropped}`);
console.log(`${prefix}  Reclassified    : ${reclassified}`);
console.log(`${prefix}  Now 'general'   : ${nowGeneral}`);

if (ejected > 0) {
  console.log(`\n${prefix} ── Ejected by source ────────────────────────────`);
  Object.entries(ejectedBySource)
    .sort(([, a], [, b]) => b - a)
    .forEach(([src, n]) => console.log(`${prefix}    ${src.padEnd(20)} ${n}`));
}

if (dropped > 0) {
  console.log(`\n${prefix} ── Dropped (no-signal) by source ────────────────`);
  Object.entries(droppedBySource)
    .sort(([, a], [, b]) => b - a)
    .forEach(([src, n]) => console.log(`${prefix}    ${src.padEnd(20)} ${n}`));
}

if (DRY_RUN) {
  console.log(`\n${prefix} No writes performed. Re-run without --dry-run to apply.`);
}

db.close();
console.log(`\n${prefix} Done.`);
