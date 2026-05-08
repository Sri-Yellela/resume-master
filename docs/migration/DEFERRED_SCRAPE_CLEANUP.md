# Deferred Scrape Reference Cleanup

## What This Tracks
After the Phase 1–7 LinkedIn/scraping migration, a broad
grep for "scrape|apify|puppeteer|linkedin.*session|linkedin.*cookie"
still finds references in three areas. These were intentionally
deferred from the current migration phase.

## Deferred Items

### 1. Database Schema / Migration Files
**Why deferred:** The database migrations are embedded inline in server.js
  and reference table names like `scraped_jobs`, `refresh_log`, `job_cache`.
  These are legacy table names. The tables still exist in the DB.
  Renaming requires a DB migration with a coordinated data
  backfill — that is a separate migration sprint.
**Next step:** When Adzuna/Indeed feed is live and populating
  a `jobs` table, run a migration to:
  - Rename `scraped_jobs` → `jobs`
  - Add `source` column: 'adzuna' | 'indeed'
  - Drop `scraped_at`, `ghost_score`, `_hash` columns
  - Rename `refresh_log` → `job_sync_log`
  - Drop `job_cache` if unused

### 2. Admin Panel (routes/adminDb.js, DBInspector.jsx)
**Why deferred:** Admin panel still exposes scrape monitor,
  force-scrape trigger, and job trace built around `scraped_jobs`.
  Removing these requires replacing them with observability
  for the Adzuna/Indeed sync — meaningless until that feed exists.
**Next step:** After Adzuna/Indeed aggregator is live:
  - Replace "Scrape Monitor" with "Job Sync Monitor"
  - Replace "Force Scrape" with "Trigger Adzuna Sync"
  - Remove Apify run status from admin

### 3. Test Files
**Why deferred:** Test files reference old scrape flows and
  LinkedIn extension flows. Updating them now would test
  removed code. They should be updated alongside new
  Adzuna/Indeed service tests.
**Next step:** When writing Adzuna/Indeed service tests,
  delete old scrape tests in the same PR.

## How to Verify This Phase is Clean
The following grep must return zero results in non-deferred code:
  grep -r "scrape\|apify\|puppeteer\|linkedin.*session\|linkedin.*cookie\|app-bridge" \
    . \
    --include="*.js" --include="*.jsx" \
    --include="*.swift" --include="*.kt" \
    --exclude-dir=node_modules --exclude-dir=.git \
    --exclude-dir=migrations --exclude-dir=tests \
    --exclude-dir=__tests__ --exclude="*.test.js" \
    --exclude="*.spec.js"

**Note:** This codebase embeds DB migrations inline in server.js and
the admin panel (routes/adminDb.js) is intentionally deferred.
All remaining grep hits fall into one of the three deferred categories above.
