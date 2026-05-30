import { validatePlugin } from './sources/base.js';
import { stripInternalFields } from './schema.js';
import { classify } from './classifier.js';
import { filterDirectApplyOnly } from './directApplyFilter.js';
import { classifyJob } from './classifyJob.js';
import { getKnownLogoUrl } from './enrichLogos.js';
import { isResumeRelevant } from './relevanceFilter.js';

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

/**
 * Search jobs across all configured sources.
 * Fan-out in parallel — if one source fails, others continue.
 * ATS plugins (greenhouse/lever/ashby) receive _companies from caller.
 */
async function searchJobs({ query = '', location = '', country = 'us', page = 1, pageSize = 10,
                            sort, employmentType, remote,
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
        query, location, country, page, pageSize, sort, employmentType, remote,
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

  // Classify + add source labels
  const classified = direct.map(job => {
    const buckets = classify(job);
    return {
      ...stripInternalFields(job),
      ...buckets,
      source_label:   SOURCE_LABELS[job.source] || job.source,
      companyIconUrl: job.thumbnail || null,
      via:            job.via || null,
    };
  });

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
 * Fetch all ATS jobs and upsert them into scraped_jobs.
 * Call at server startup (non-blocking) to warm the cache.
 * @param {import('better-sqlite3').Database} db
 */
async function cacheJobs(db) {
  try {
    const atsCos = db.prepare("SELECT * FROM company_ats_list WHERE active = 1").all();
    if (!atsCos.length) {
      console.log('[cacheJobs] No active ATS companies — skipping cache warm');
      return 0;
    }

    const _ghCompanies    = atsCos.filter(r => r.ats_type === 'greenhouse');
    const _leverCompanies = atsCos.filter(r => r.ats_type === 'lever');
    const _ashbyCompanies = atsCos.filter(r => r.ats_type === 'ashby');

    if (_leverCompanies.length === 0) {
      console.log('[Lever] No companies configured — skipping');
    }

    // Fetch all jobs (empty query = every open position)
    const result = await searchJobs({
      query: '', location: '', page: 1, pageSize: 300,
      _ghCompanies,
      _leverCompanies: _leverCompanies.length > 0 ? _leverCompanies : [],
      _ashbyCompanies,
    });

    if (!result.jobs.length) {
      console.log('[cacheJobs] No jobs returned from ATS sources');
      return 0;
    }

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO scraped_jobs
        (job_id, search_query, _hash, title, company, location, url, source, source_label,
         posted_at, scraped_at, bucket_role, bucket_seniority, bucket_domain, direct_apply, description,
         company_icon_url, via, collar, classification_confidence)
      VALUES
        (@job_id, @search_query, @_hash, @title, @company, @location, @url, @source, @source_label,
         @posted_at, @scraped_at, @bucket_role, @bucket_seniority, @bucket_domain, @direct_apply, @description,
         @company_icon_url, @via, @collar, @classification_confidence)
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

    const upsertAll = db.transaction((jobs) => {
      const now = Math.floor(Date.now() / 1000);
      let ejected = 0, dropped = 0, cached = 0;

      for (const job of jobs) {
        const jobId = job.id || job.url || '';
        if (!jobId) continue;

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

        stmt.run({
          job_id:                    jobId,
          search_query:              job.source || 'ats',
          _hash:                     jobId,
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
      return { cached, ejected, dropped };
    });

    // isResumeRelevant kept as a redundant safety net (superseded by collar gate; removed in Phase 6)
    const relevant = result.jobs.filter(j => isResumeRelevant(j.title));
    const skipped  = result.jobs.length - relevant.length;
    if (skipped > 0) console.log(`[cacheJobs] Skipped ${skipped} jobs (safety net)`);
    const { cached, ejected, dropped } = upsertAll(relevant);
    if (ejected > 0) console.log(`[cacheJobs] Ejected ${ejected} blue-collar jobs`);
    if (dropped > 0) console.log(`[cacheJobs] Dropped ${dropped} unclassifiable jobs`);
    console.log(`[cacheJobs] Cached ${cached} jobs from ATS sources`);

    // Background logo enrichment (non-blocking, max 25 per cache run)
    setImmediate(async () => {
      try {
        const noLogo = db.prepare(`
          SELECT DISTINCT company FROM scraped_jobs
          WHERE company_icon_url IS NULL
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

    return cached;
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
