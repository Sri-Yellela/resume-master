/**
 * Manual verification aid for Task 8 (Jobo feed sync) — NOT wired into npm test, server.js
 * boot, or any cron. Run it wherever JOBO_API_KEY is set (e.g. `railway run node
 * scripts/joboSyncSmokeTest.js`, or locally after copying the key into .env and exporting it).
 *
 * Modes:
 *   node scripts/joboSyncSmokeTest.js
 *     Raw probe only — fetches one batch_size:10 page and prints the first raw job's keys
 *     plus what normalizeJoboJob() maps it to. This is how services/jobs/sources/jobo.js's
 *     defensive field-name guessing gets confirmed/corrected against Jobo's real response
 *     shape, instead of staying a guess.
 *
 *   node scripts/joboSyncSmokeTest.js --run-sync
 *     Also runs the real cacheJoboFeed() bounded backfill against data/resume_master.db and
 *     prints the resulting scraped_jobs/sync_state rows for source='jobo' — the actual
 *     "10 jobs normalized + upserted" check from Task 8's VERIFY section. Requires the DB's
 *     migrations to already be applied (`npm run migrate` first) — this script does not run
 *     migrations itself, to avoid duplicating scripts/migration.js's logic.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchFeedPage, normalizeJoboJob, isConfigured } from '../services/jobs/sources/jobo.js';
import { cacheJoboFeed } from '../services/jobs/aggregator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, '..', 'data', 'resume_master.db');

async function probeRawShape() {
  console.log('[smoke] Fetching one batch_size:10 page from /api/jobs/feed...');
  const page = await fetchFeedPage({ batch_size: 10, stable_scan: true });
  console.log(`[smoke] Got ${page.jobs.length} jobs, has_more=${page.hasMore}, next_cursor=${page.nextCursor}`);

  if (!page.jobs.length) {
    console.warn('[smoke] No jobs returned — nothing to inspect.');
    return page;
  }

  const raw = page.jobs[0];
  console.log('[smoke] Raw first job keys:', Object.keys(raw));
  console.log('[smoke] Raw first job:', JSON.stringify(raw, null, 2));

  try {
    const normalized = normalizeJoboJob(raw);
    console.log('[smoke] normalizeJoboJob() output:', JSON.stringify(normalized, null, 2));
    console.log('[smoke] If any of title/company/url above are empty/wrong, fix the `pick(...)` '
      + 'key lists in services/jobs/sources/jobo.js normalizeJoboJob() against the raw keys shown above.');
  } catch (err) {
    console.error('[smoke] normalizeJoboJob() threw — a required field (id/title/company/url) '
      + 'is missing under the guessed key names. Raw keys were:', Object.keys(raw), '\n', err.message);
  }
  return page;
}

async function runRealSync() {
  console.log('\n[smoke] --run-sync: running the real cacheJoboFeed() bounded backfill against', DB_PATH);
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const requiredTables = ['scraped_jobs', 'sync_state', 'job_role_map', 'rejected_jobs'];
  const existing = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
  );
  const missing = requiredTables.filter(t => !existing.has(t));
  if (missing.length) {
    console.error(`[smoke] DB is missing table(s): ${missing.join(', ')}. Run "npm run migrate" first.`);
    db.close();
    process.exitCode = 1;
    return;
  }

  const count = await cacheJoboFeed(db, null);
  console.log(`[smoke] cacheJoboFeed() returned cached=${count}`);

  const rows = db.prepare(
    "SELECT job_id, title, company, source, is_active, fingerprint, sources_seen, req_uid FROM scraped_jobs WHERE source = 'jobo' ORDER BY discovered_at DESC LIMIT 20"
  ).all();
  console.log(`[smoke] scraped_jobs rows with source='jobo' (up to 20):`, rows);

  const syncRow = db.prepare("SELECT * FROM sync_state WHERE source = 'jobo'").get();
  console.log('[smoke] sync_state row for jobo:', syncRow);

  db.close();
}

async function main() {
  if (!isConfigured()) {
    console.error('[smoke] JOBO_API_KEY is not set in this environment — nothing to probe.');
    process.exitCode = 1;
    return;
  }

  await probeRawShape();

  if (process.argv.includes('--run-sync')) {
    await runRealSync();
  } else {
    console.log('\n[smoke] Skipped the real sync (pass --run-sync to also upsert into data/resume_master.db).');
  }
}

main().catch(err => {
  console.error('[smoke] Failed:', err.message);
  process.exitCode = 1;
});
