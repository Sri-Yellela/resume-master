import crypto from 'crypto';
import { validatePlugin } from './sources/base.js';
import { stripInternalFields } from './schema.js';
import { filterDirectApplyOnly } from './directApplyFilter.js';
import { classifyJob } from './classifyJob.js';
import { getKnownLogoUrl } from './enrichLogos.js';

// ─── REGISTER SOURCES HERE ───────────────────────────────────────────────────
// To add a new source: import it and add to SOURCES array.
// To disable a source: comment out its line. Zero other changes needed.

import adzunaPlugin    from './sources/adzuna.js';
import serpapiPlugin   from './sources/serpapi.js';
import greenhousePlugin from './sources/greenhouse.js';
import leverPlugin     from './sources/lever.js';
import ashbyPlugin     from './sources/ashby.js';
// import theMuse   from './sources/themusejobs.js';  // add when ready
// import usaJobs   from './sources/usajobs.js';      // add when ready
// import indeed    from './sources/indeed.js';        // add when approved

const SOURCES = [
  adzunaPlugin,
  serpapiPlugin,
  greenhousePlugin,
  leverPlugin,
  ashbyPlugin,
];
// ─────────────────────────────────────────────────────────────────────────────

export const SOURCE_LABELS = {
  adzuna:             'Adzuna',
  greenhouse:         'Greenhouse',
  lever:              'Lever',
  ashby:              'Ashby',
  serpapi:            'Google Jobs',
  linkedin_extension: 'LinkedIn (Saved)',
};

// Validate all registered plugins at startup
SOURCES.forEach(validatePlugin);

const activeSources   = SOURCES.filter(s => s.isConfigured()).map(s => s.name);
const inactiveSources = SOURCES.filter(s => !s.isConfigured()).map(s => s.name);
console.log('[JobAggregator] Active sources:',   activeSources.join(', ')   || 'none');
if (inactiveSources.length) {
  console.log('[JobAggregator] Inactive (not configured):', inactiveSources.join(', '));
}

// ATS sources that cacheJobs syncs; non-ATS sources (adzuna, serpapi) use live search only.
const ATS_SOURCE_NAMES = new Set(['greenhouse', 'lever', 'ashby']);

// A job not seen in this many consecutive successful crawls of its source is marked is_active=0.
// Implemented via watermark comparison: row.updated_at < prev_watermark means absent from both
// the previous AND current crawl (2 consecutive misses).
const PRUNE_AFTER_MISSED_CRAWLS = 2;

// Content fingerprint used to skip re-upserting postings that haven't changed since the
// last crawl. Unchanged rows get a cheap timestamp "touch" instead of the full upsert —
// this is what makes repeat crawls dramatically cheaper than the first backfill.
function fingerprintJob(job) {
  const parts = [
    job.title || '', job.location || '', job.description || '', job.posted_at || '',
    job.workplace_type || '', job.valid_through ?? '',
    job.salary_min_usd ?? '', job.salary_max_usd ?? '', job.salary_period || '',
    job.direct_apply === false ? 0 : 1,
  ].join('|');
  return crypto.createHash('sha1').update(parts).digest('hex');
}

/**
 * Search jobs across all configured sources.
 * Fan-out in parallel — if one source fails, others continue.
 * ATS plugins (greenhouse/lever/ashby) receive _companies from caller.
 */
async function searchJobs({ query = '', location = '', country = 'us', page = 1, pageSize = 10,
                            sort, employmentType, remote, maxResults = 0,
                            _ghCompanies = [], _leverCompanies = [], _ashbyCompanies = [] } = {}) {
  const configured = SOURCES.filter(s => s.isConfigured());

  if (configured.length === 0) {
    console.warn('[JobAggregator] No job sources configured. Returning empty results.');
    return { jobs: [], total: 0, page, pageSize, sources: [], attribution: [] };
  }

  const companyMap = {
    greenhouse: _ghCompanies,
    lever:      _leverCompanies,
    ashby:      _ashbyCompanies,
  };

  const results = await Promise.allSettled(
    configured.map(source =>
      source.search({
        query, location, country, page, pageSize, sort, employmentType, remote, maxResults,
        _companies: companyMap[source.name] || [],
      }).then(result => ({ ...result, source: source.name }))
    )
  );

  const allJobs       = [];
  const activeNames   = [];
  const attribution   = [];
  let   totalCount    = 0;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { jobs, total, source } = result.value;
      allJobs.push(...jobs);
      totalCount += total;
      activeNames.push(source);

      for (const job of jobs) {
        if (job._attribution) {
          const alreadyAdded = attribution.some(a => a.name === job._attribution.name);
          if (!alreadyAdded) attribution.push(job._attribution);
        }
      }
    } else {
      console.error('[JobAggregator] Source failed:', result.reason?.message || result.reason);
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  const unique = allJobs.filter(job => {
    if (!job.url || seen.has(job.url)) return false;
    seen.add(job.url);
    return true;
  });

  // Apply direct-apply filter (Greenhouse/Lever/Ashby always pass)
  const direct = filterDirectApplyOnly(unique);

  // Classify with unified classifier; filter blue-collar from live results
  const classified = direct
    .map(job => {
      const v = classifyJob(job.title || '', job.description || '', job.company || '');
      return {
        ...stripInternalFields(job),
        bucket_role:      v.roleKey      || null,
        bucket_seniority: v.seniority    || null,
        bucket_domain:    v.domain       || null,
        _collar:          v.collar,
        source_label:     SOURCE_LABELS[job.source] || job.source,
        companyIconUrl:   job.thumbnail || null,
        via:              job.via || null,
      };
    })
    .filter(job => job._collar === 'white' && job.bucket_role !== null)
    .map(({ _collar, ...rest }) => rest);

  return {
    jobs:        classified,
    total:       totalCount,
    page,
    pageSize,
    sources:     activeNames,
    attribution,
  };
}

/**
 * Fetch all ATS jobs and upsert them into scraped_jobs (incremental watermark sync).
 * - First run per source: full backfill.
 * - Subsequent runs: full pull (ATS sources have no delta API), but each posting is
 *   fingerprinted (title/location/description/comp/etc.) against its last-seen hash —
 *   unchanged postings get a cheap timestamp touch instead of a full re-upsert, so
 *   repeat crawls are dramatically cheaper than the first backfill.
 * - Watermark advances only on success so the stale-prune logic stays correct.
 * - Rows not seen in PRUNE_AFTER_MISSED_CRAWLS consecutive crawls → is_active = 0.
 * - Rows with passed valid_through → is_active = 0.
 * - Re-appearing rows → is_active = 1 (via upsert or the unchanged-touch path).
 * @param {import('better-sqlite3').Database} db
 */
async function cacheJobs(db) {
  try {
    const atsCos = db.prepare("SELECT * FROM company_ats_list WHERE active = 1").all();
    if (!atsCos.length) {
      console.log('[cacheJobs] No active ATS companies — skipping cache warm');
      return 0;
    }

    const companyMap = {
      greenhouse: atsCos.filter(r => r.ats_type === 'greenhouse'),
      lever:      atsCos.filter(r => r.ats_type === 'lever'),
      ashby:      atsCos.filter(r => r.ats_type === 'ashby'),
    };

    const atsSources = SOURCES.filter(s => s.isConfigured() && ATS_SOURCE_NAMES.has(s.name));

    // ── Prepared statements (reused across all source loops) ─────────────────
    const upsertStmt = db.prepare(`
      INSERT OR REPLACE INTO scraped_jobs
        (job_id, search_query, _hash, title, company, location, url, source, source_label,
         posted_at, scraped_at, bucket_role, bucket_seniority, bucket_domain, direct_apply, description,
         company_icon_url, via, collar, classification_confidence,
         normalized_title, summary, experience_level, workplace_type, valid_through,
         salary_min_usd, salary_max_usd, salary_period, skills_json,
         is_h1b_sponsor, requires_work_auth, is_clearance_required,
         discovered_at, updated_at, is_active)
      VALUES
        (@job_id, @search_query, @_hash, @title, @company, @location, @url, @source, @source_label,
         @posted_at, @scraped_at, @bucket_role, @bucket_seniority, @bucket_domain, @direct_apply, @description,
         @company_icon_url, @via, @collar, @classification_confidence,
         @normalized_title, @summary, @experience_level, @workplace_type, @valid_through,
         @salary_min_usd, @salary_max_usd, @salary_period, @skills_json,
         @is_h1b_sponsor, @requires_work_auth, @is_clearance_required,
         @discovered_at, @updated_at, 1)
    `);

    const roleMapStmt = db.prepare(`
      INSERT OR REPLACE INTO job_role_map
        (job_id, role_key, role_family, domain, confidence, matched_by)
      VALUES
        (@job_id, @role_key, @role_family, @domain, @confidence, @matched_by)
    `);

    const rejectStmt = db.prepare(`
      INSERT OR REPLACE INTO rejected_jobs (job_id, title, company, source, reason, rejected_at)
      VALUES (@job_id, @title, @company, @source, @reason, @rejected_at)
    `);

    const deleteJobStmt  = db.prepare(`DELETE FROM scraped_jobs  WHERE job_id = ?`);
    const deleteRoleStmt = db.prepare(`DELETE FROM job_role_map  WHERE job_id = ?`);

    // Cheap "seen, unchanged" touch — refreshes updated_at (so the stale-prune watermark
    // logic doesn't mark it absent) and reactivates it if a prior crawl had pruned it,
    // without re-running classification or rewriting every column.
    const touchSeenStmt = db.prepare(`
      UPDATE scraped_jobs SET updated_at = ?, scraped_at = ?, is_active = 1
      WHERE job_id = ?
    `);

    const getExistingHashes = db.prepare(`SELECT job_id, _hash FROM scraped_jobs WHERE source = ?`);

    // Mark rows inactive when their listing date has passed
    const markExpiredByDate = db.prepare(`
      UPDATE scraped_jobs SET is_active = 0
      WHERE source = ? AND is_active = 1
        AND valid_through IS NOT NULL AND valid_through < ?
    `);

    // Mark rows inactive when absent from PRUNE_AFTER_MISSED_CRAWLS consecutive crawls.
    // updated_at < prevWatermark ⟹ row was absent from both previous and current crawl.
    const markStale = db.prepare(`
      UPDATE scraped_jobs SET is_active = 0
      WHERE source = ? AND is_active = 1 AND updated_at < ?
    `);

    const upsertSyncState = db.prepare(`
      INSERT INTO sync_state (source, last_watermark, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET
        last_watermark = excluded.last_watermark,
        updated_at     = excluded.updated_at
    `);

    const getSyncState = db.prepare('SELECT last_watermark FROM sync_state WHERE source = ?');

    let totalCached = 0;

    for (const source of atsSources) {
      const companies = companyMap[source.name] || [];
      if (companies.length === 0) {
        console.log(`[cacheJobs:${source.name}] No companies configured — skipping`);
        continue;
      }

      // Snapshot the previous watermark BEFORE the fetch; used for stale-prune after upsert.
      const prevState    = getSyncState.get(source.name);
      const prevWatermark = prevState?.last_watermark ?? null;

      // Full pull (no incremental primitive for Greenhouse/Lever/Ashby).
      // Do NOT advance watermark if the fetch throws.
      let fetchedJobs;
      try {
        const result = await source.search({ query: '', _companies: companies, pageSize: 300 });
        fetchedJobs = result.jobs;
      } catch (err) {
        console.error(`[cacheJobs:${source.name}] Fetch failed — watermark NOT advanced: ${err.message}`);
        continue;
      }

      // Treat 0-job responses as potentially failed (per-company errors are swallowed by the
      // plugin). Skip prune and watermark advancement to avoid deactivating real jobs on
      // transient network issues.
      if (!fetchedJobs.length) {
        console.log(`[cacheJobs:${source.name}] No jobs returned — skipping prune`);
        continue;
      }

      const now = Math.floor(Date.now() / 1000);

      // Fingerprints from the last crawl — lets us skip the full upsert (and re-classification)
      // for postings that haven't changed, so repeat crawls are dramatically cheaper than backfill.
      const existingHashes = new Map(
        getExistingHashes.all(source.name).map(r => [r.job_id, r._hash])
      );

      // ── Upsert in a transaction ───────────────────────────────────────────
      const { cached, unchanged, ejected, dropped } = db.transaction(() => {
        let cached = 0, unchanged = 0, ejected = 0, dropped = 0;

        for (const job of fetchedJobs) {
          const jobId = job.id || job.url || '';
          if (!jobId) continue;

          const fingerprint = fingerprintJob(job);
          if (existingHashes.get(jobId) === fingerprint) {
            touchSeenStmt.run(now, now, jobId);
            unchanged++;
            continue;
          }

          const verdict = classifyJob(job.title || '', job.description || '', job.company || '');

          if (verdict.collar === 'blue') {
            deleteJobStmt.run(jobId);
            deleteRoleStmt.run(jobId);
            rejectStmt.run({
              job_id:      jobId,
              title:       job.title   || '',
              company:     job.company || '',
              source:      job.source  || '',
              reason:      'blue_collar',
              rejected_at: now,
            });
            ejected++;
            continue;
          }

          if (verdict.roleKey === null) {
            dropped++;
            continue;
          }

          upsertStmt.run({
            job_id:                    jobId,
            search_query:              job.source || 'ats',
            _hash:                     fingerprint,
            title:                     job.title || '',
            company:                   job.company || '',
            location:                  job.location || '',
            url:                       job.url || '',
            source:                    job.source || '',
            source_label:              job.source_label || '',
            posted_at:                 job.posted_at || null,
            scraped_at:                now,
            bucket_role:               verdict.roleKey,
            bucket_seniority:          verdict.seniority || null,
            bucket_domain:             verdict.domain || null,
            direct_apply:              job.direct_apply === false ? 0 : 1,
            description:               job.description || null,
            company_icon_url:          job.thumbnail || job.companyIconUrl || null,
            via:                       job.via || null,
            collar:                    'white',
            classification_confidence: verdict.confidence || 0,
            normalized_title:          job.normalized_title || null,
            summary:                   job.summary         || null,
            experience_level:          job.experience_level || null,
            workplace_type:            job.workplace_type  || null,
            valid_through:             job.valid_through   != null ? job.valid_through : null,
            salary_min_usd:            job.salary_min_usd  != null ? job.salary_min_usd  : null,
            salary_max_usd:            job.salary_max_usd  != null ? job.salary_max_usd  : null,
            salary_period:             job.salary_period   || null,
            skills_json:               job.skills_json     || null,
            is_h1b_sponsor:            job.is_h1b_sponsor  != null ? job.is_h1b_sponsor  : null,
            requires_work_auth:        job.requires_work_auth != null ? job.requires_work_auth : null,
            is_clearance_required:     job.is_clearance_required != null ? job.is_clearance_required : null,
            discovered_at:             now,
            updated_at:                now,
          });

          // Canonical verdict → job_role_map (supersedes old classifyForIngest path)
          roleMapStmt.run({
            job_id:      jobId,
            role_key:    verdict.roleKey,
            role_family: verdict.roleKey,
            domain:      verdict.domain || null,
            confidence:  verdict.confidence || 0,
            matched_by:  'ats_cache',
          });
          cached++;
        }

        return { cached, unchanged, ejected, dropped };
      })();

      // ── Expiry pruning (outside the upsert transaction) ───────────────────

      // 1. valid_through expiry: listing's own declared end date has passed.
      const byDate = markExpiredByDate.run(source.name, now);

      // 2. Stale-seen prune: row absent from PRUNE_AFTER_MISSED_CRAWLS consecutive crawls.
      //    After upsert, seen rows have updated_at = now (> prevWatermark).
      //    Rows with updated_at < prevWatermark were absent from both previous AND current crawl.
      let byStale = { changes: 0 };
      if (prevWatermark !== null) {
        byStale = markStale.run(source.name, prevWatermark);
      }

      // Advance watermark only after a successful fetch + upsert.
      upsertSyncState.run(source.name, now, now);

      const pruned = byDate.changes + byStale.changes;
      if (ejected > 0) console.log(`[cacheJobs:${source.name}] Ejected ${ejected} blue-collar jobs`);
      if (dropped > 0) console.log(`[cacheJobs:${source.name}] Dropped ${dropped} unclassifiable jobs`);
      if (pruned  > 0) console.log(`[cacheJobs:${source.name}] Pruned ${pruned} jobs inactive (${byDate.changes} expired, ${byStale.changes} stale)`);
      console.log(`[cacheJobs:${source.name}] Sync complete — ${fetchedJobs.length} fetched, ${cached} new/changed, ${unchanged} unchanged (touch-only), ${pruned} pruned (prevWatermark=${prevWatermark})`);
      totalCached += cached;
    }

    // Background logo enrichment (non-blocking, max 25 per cache run)
    setImmediate(async () => {
      try {
        const noLogo = db.prepare(`
          SELECT DISTINCT company FROM scraped_jobs
          WHERE company_icon_url IS NULL
            AND is_active = 1
            AND company IS NOT NULL AND company != ''
          LIMIT 25
        `).all();
        const updateLogo = db.prepare(`
          UPDATE scraped_jobs SET company_icon_url = ?
          WHERE company = ? AND company_icon_url IS NULL
        `);
        let count = 0;
        for (const { company } of noLogo) {
          // Use known-domain lookup first (offline-safe); fetchLogoUrl falls back to this anyway
          const url = getKnownLogoUrl(company);
          if (url) { updateLogo.run(url, company); count++; }
          await new Promise(r => setTimeout(r, 50));
        }
        if (count > 0) console.log(`[EnrichLogos] Set logo URLs for ${count} companies`);
      } catch(e) {
        console.warn('[EnrichLogos] Background enrichment:', e.message);
      }
    });

    console.log(`[cacheJobs] Total: ${totalCached} jobs cached across ${atsSources.length} sources`);
    return totalCached;
  } catch (err) {
    console.error('[cacheJobs] Failed:', err.message);
    return 0;
  }
}

/**
 * Returns readiness status of all registered sources.
 * Used by integrationReadiness.js and admin panel.
 */
function getSourceStatus() {
  return SOURCES.map(source => ({
    name:       source.name,
    configured: source.isConfigured(),
  }));
}

export { searchJobs, cacheJobs, getSourceStatus };
