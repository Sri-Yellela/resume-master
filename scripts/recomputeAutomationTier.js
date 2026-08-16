#!/usr/bin/env node
/**
 * Admin action: re-derive scraped_jobs.automation_tier for every row.
 *
 * Run this whenever services/jobs/automationTier.js's mapping changes — a new provider onboarded,
 * or an existing one moving between tiers because it started demanding an account. Nothing about a
 * job row changes when that happens, so without this the stored value silently keeps describing
 * the old mapping and the board keeps making a promise the run can no longer keep.
 *
 *   node scripts/recomputeAutomationTier.js            # only rows with no tier yet (the boot default)
 *   node scripts/recomputeAutomationTier.js --all      # re-derive every row (use after a mapping change)
 *   node scripts/recomputeAutomationTier.js --all --dry-run
 *
 * Uses the same backfillAutomationTier() the server runs at boot, which uses the same
 * deriveAutomationTier() the four scraped_jobs writers use. One mapping, one code path.
 */
"use strict";

import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { backfillAutomationTier } from "../services/jobs/backfillAutomationTier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "resume_master.db");

const all = process.argv.includes("--all");
const dryRun = process.argv.includes("--dry-run");

const db = new Database(DB_PATH);

const cols = db.prepare("PRAGMA table_info(scraped_jobs)").all().map(c => c.name);
if (!cols.includes("automation_tier")) {
  console.error(`[recompute-tier] ${DB_PATH} has no automation_tier column — run migration 078 first ` +
    `(npm run migrate, or just start the server).`);
  process.exit(1);
}

const before = db.prepare(`
  SELECT COALESCE(automation_tier, '(null)') AS tier, COUNT(*) AS n
  FROM scraped_jobs WHERE is_active = 1 GROUP BY tier ORDER BY n DESC
`).all();

console.log(`[recompute-tier] db=${DB_PATH} mode=${all ? "all rows" : "NULL rows only"}${dryRun ? " (dry run)" : ""}`);
console.log("[recompute-tier] before (is_active=1):");
console.table(before);

if (dryRun) {
  // Same derivation, no write — so a mapping change can be inspected before it is committed.
  const { deriveAutomationTier } = await import("../services/jobs/automationTier.js");
  const rows = db.prepare(
    `SELECT job_id, source, apply_url, url, automation_tier FROM scraped_jobs ${all ? "" : "WHERE automation_tier IS NULL"}`
  ).all();
  const would = {};
  let changes = 0;
  for (const r of rows) {
    const tier = deriveAutomationTier(r.source, r.apply_url || r.url);
    would[tier] = (would[tier] || 0) + 1;
    if (r.automation_tier !== tier) changes++;
  }
  console.log(`[recompute-tier] dry run: ${rows.length} scanned, ${changes} would change`);
  console.table(Object.entries(would).map(([tier, n]) => ({ tier, n })));
  db.close();
  process.exit(0);
}

const result = backfillAutomationTier(db, { all });
console.log(`[recompute-tier] scanned=${result.scanned} updated=${result.updated}`);

const after = db.prepare(`
  SELECT COALESCE(automation_tier, '(null)') AS tier, COUNT(*) AS n
  FROM scraped_jobs WHERE is_active = 1 GROUP BY tier ORDER BY n DESC
`).all();
console.log("[recompute-tier] after (is_active=1):");
console.table(after);

db.close();
