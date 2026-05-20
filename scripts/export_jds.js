/**
 * Export all scraped_jobs as JSON for MDE RAG bootstrap.
 *
 * Usage (from Resume Master root):
 *   node scripts/export_jds.js > ../mde-rag/data/jd_export.json
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data', 'resume_master.db');

const db = new Database(dbPath);

const jobs = db.prepare(`
  SELECT
    id,
    title,
    company,
    bucket_role,
    location,
    description,
    scraped_at AS created_at
  FROM scraped_jobs
  WHERE company IS NOT NULL
    AND company != ''
  ORDER BY scraped_at DESC
`).all();

process.stdout.write(JSON.stringify(jobs, null, 2));
process.stderr.write(`Exported ${jobs.length} jobs\n`);

db.close();
