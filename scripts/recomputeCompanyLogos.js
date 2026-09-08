#!/usr/bin/env node
/**
 * Admin action: re-resolve scraped_jobs.company_icon_url for rows this app owns.
 *
 * Run this whenever the logo PROVIDER changes, or shared/companyLogos.js's KNOWN_DOMAINS table
 * gains or corrects an entry. Nothing about a job row changes when a third party retires its API,
 * so without this the stored value keeps pointing at an address that resolves to nothing — which
 * is exactly what happened when Clearbit shut down logo.clearbit.com and 1290 of 1296 rows went on
 * requesting it, once per card, per render.
 *
 *   node scripts/recomputeCompanyLogos.js            # only rows on a RETIRED host (the boot default)
 *   node scripts/recomputeCompanyLogos.js --all      # also re-resolve rows already on the current host
 *   node scripts/recomputeCompanyLogos.js --all --dry-run
 *
 * Uses the same backfillCompanyLogos() the server runs at boot, which uses the same
 * getKnownLogoUrl() CompanyIcon resolves with client-side. One table, one code path.
 *
 * Feed-supplied logos (LinkedIn's, serpapi's thumbnail) are never touched in either mode — they
 * are more specific than anything the domain table can derive.
 */
"use strict";

import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { backfillCompanyLogos, isRetiredLogoUrl } from "../services/jobs/backfillCompanyLogos.js";
import { getKnownLogoUrl, isKnownLogoUrlHost, LOGO_HOST } from "../shared/companyLogos.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "resume_master.db");

const all = process.argv.includes("--all");
const dryRun = process.argv.includes("--dry-run");

const db = new Database(DB_PATH);

// Bucket by WHO the URL points at, not by whether it is null — "1290 rows have a logo" was true
// and useless for the entire time every one of those logos was dead.
const census = () => db.prepare(`
  SELECT CASE
           WHEN company_icon_url IS NULL                       THEN '(null)'
           WHEN company_icon_url LIKE 'https://logo.clearbit.com/%'    THEN 'clearbit (RETIRED)'
           WHEN company_icon_url LIKE 'https://www.google.com/s2/%'    THEN 'google favicon (RETIRED)'
           WHEN company_icon_url LIKE ? || '/%'                THEN 'current provider'
           ELSE 'feed-supplied'
         END AS host, COUNT(*) AS n
  FROM scraped_jobs GROUP BY host ORDER BY n DESC
`).all(LOGO_HOST);

console.log(`[recompute-logos] db=${DB_PATH} host=${LOGO_HOST} mode=${all ? "all owned rows" : "retired hosts only"}${dryRun ? " (dry run)" : ""}`);
console.log("[recompute-logos] before:");
console.table(census());

if (dryRun) {
  // Same predicate and same resolution as the real path, no write — so a provider swap can be
  // inspected before it is committed.
  const rows = db.prepare("SELECT job_id, company, company_icon_url FROM scraped_jobs WHERE company_icon_url IS NOT NULL").all();
  let repointed = 0, cleared = 0, kept = 0;
  for (const r of rows) {
    if (!(isRetiredLogoUrl(r.company_icon_url) || (all && isKnownLogoUrlHost(r.company_icon_url)))) { kept++; continue; }
    const next = getKnownLogoUrl(r.company);
    if (next === r.company_icon_url) continue;
    if (next === null) cleared++; else repointed++;
  }
  console.log(`[recompute-logos] dry run: ${rows.length} scanned, ${repointed} would be repointed, ` +
    `${cleared} would be cleared to NULL, ${kept} feed-supplied would be left untouched`);
  db.close();
  process.exit(0);
}

const result = backfillCompanyLogos(db, { all });
console.log(`[recompute-logos] scanned=${result.scanned} repointed=${result.updated} ` +
  `cleared=${result.cleared} kept=${result.kept}`);

console.log("[recompute-logos] after:");
console.table(census());

db.close();
