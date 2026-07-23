import crypto from 'crypto';
import { validatePlugin } from './sources/base.js';
import { stripInternalFields, computeFingerprint, computeReqUid } from './schema.js';
import { filterDirectApplyOnly, DIRECT_ATS_SOURCES } from './directApplyFilter.js';
import { classifyJob } from './classifyJob.js';
import { getKnownLogoUrl } from './enrichLogos.js';
import { runEnrichment } from './enrichJob.js';

// ─── REGISTER SOURCES HERE ───────────────────────────────────────────────────
// To add a new source: import it and add to SOURCES array.
// To disable a source: comment out its line. Zero other changes needed.

import adzunaPlugin    from './sources/adzuna.js';
import serpapiPlugin   from './sources/serpapi.js';
import greenhousePlugin from './sources/greenhouse.js';
import leverPlugin     from './sources/lever.js';
import ashbyPlugin     from './sources/ashby.js';
import workdayPlugin   from './sources/workday.js';
import smartrecruitersPlugin from './sources/smartrecruiters.js';
import workablePlugin  from './sources/workable.js';
import recruiteePlugin from './sources/recruitee.js';
// import theMuse   from './sources/themusejobs.js';  // add when ready
// import usaJobs   from './sources/usajobs.js';      // add when ready
// import indeed    from './sources/indeed.js';        // add when approved

const SOURCES = [
  adzunaPlugin,
  serpapiPlugin,
  greenhousePlugin,
  leverPlugin,
  ashbyPlugin,
  workdayPlugin,
  smartrecruitersPlugin,
  workablePlugin,
  recruiteePlugin,
];
// ─────────────────────────────────────────────────────────────────────────────

export const SOURCE_LABELS = {
  adzuna:             'Adzuna',
  greenhouse:         'Greenhouse',
  lever:              'Lever',
  ashby:              'Ashby',
  workday:            'Workday',
  smartrecruiters:    'SmartRecruiters',
  workable:           'Workable',
  recruitee:          'Recruitee',
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
// Canonical direct-ATS set lives in directApplyFilter.js — it's also the top dedup tier below.
const ATS_SOURCE_NAMES = DIRECT_ATS_SOURCES;

// Cross-source dedup priority tiers (highest wins as canonical):
//   Tier 3 — direct ATS (company's own board): greenhouse/lever/ashby + future Tier-A additions.
//   Tier 2 — managed provider (direct-apply but not a Tier-A ATS integration) — the default for
//            any source not explicitly listed, e.g. linkedin_extension.
//   Tier 1 — aggregator (gatekept middleman listing): adzuna, serpapi.
const AGGREGATOR_SOURCES = new Set(['adzuna', 'serpapi']);

function sourcePriority(source) {
  if (DIRECT_ATS_SOURCES.has(source)) return 3;
  if (AGGREGATOR_SOURCES.has(source)) return 1;
  return 2;
}

// A job not seen in this many consecutive successful crawls of its source is marked is_active=0.
// Implemented via watermark comparison: row.updated_at < prev_watermark means absent from both
// the previous AND current crawl (2 consecutive misses).
const PRUNE_AFTER_MISSED_CRAWLS = 2;

// Content hash used to skip re-upserting postings that haven't changed since the last crawl
// of their OWN source. Unrelated to the cross-source `fingerprint` column/computeFingerprint()
// below — this one is per-row change detection ("did source X's copy of job Y change"), that
// one is cross-source identity ("is source X's job the same ROLE as source Z's job"). Unchanged
// rows get a cheap timestamp "touch" instead of the full upsert — this is what makes repeat
// crawls dramatically cheaper than the first backfill.
function fingerprintJob(job) {
  const parts = [
    job.title || '', job.location || '', job.description || '', job.posted_at || '',
    job.workplace_type || '', job.valid_through ?? '',
    job.salary_min_usd ?? '', job.salary_max_usd ?? '', job.salary_period || '',
    job.direct_apply === false ? 0 : 1,
  ].join('|');
  return crypto.createHash('sha1').update(parts).digest('hex');
}

// ── Cross-source dedup (collapse the same role from multiple sources) ──────────────────
// Fields a lower-priority duplicate may carry that the winning canonical row should adopt
// if the canonical doesn't already have them (never overwrites a real value with null).
const MERGEABLE_FIELDS = [
  'description', 'company_icon_url', 'workplace_type', 'experience_level',
  'valid_through', 'salary_min_usd', 'salary_max_usd', 'salary_period', 'skills_json',
  'is_h1b_sponsor', 'requires_work_auth', 'is_clearance_required', 'posted_at',
];

function isBlank(v) {
  return v === null || v === undefined || v === '';
}

// Returns a copy of `target` with any blank field filled in from `donor`.
function unionMergeFields(target, donor) {
  const merged = { ...target };
  for (const f of MERGEABLE_FIELDS) {
    if (isBlank(merged[f]) && !isBlank(donor[f])) merged[f] = donor[f];
  }
  return merged;
}

function mergeSourcesSeen(existingSourcesSeenJson, ...sources) {
  const set = new Set();
  if (existingSourcesSeenJson) {
    try { JSON.parse(existingSourcesSeenJson).forEach(s => { if (s) set.add(s); }); } catch { /* ignore malformed */ }
  }
  sources.forEach(s => { if (s) set.add(s); });
  return JSON.stringify([...set]);
}

// One prepared-statement bundle per db connection (this app has exactly one long-lived
// connection, but a WeakMap keeps this safe/reusable rather than assuming that).
const fingerprintStmtsCache = new WeakMap();
function getFingerprintStmts(db) {
  let stmts = fingerprintStmtsCache.get(db);
  if (!stmts) {
    stmts = {
      // All active rows sharing the coarse fingerprint, NOT limited to one — a high-volume
      // employer can genuinely have several distinct open reqs with the same title+location,
      // and selectMatch() below needs to see all of them to tell "a sibling" from "my twin".
      findCandidates: db.prepare(`
        SELECT * FROM scraped_jobs
        WHERE fingerprint = ? AND job_id != ? AND is_active = 1
        ORDER BY updated_at DESC
      `),
      findOwnSourcesSeen: db.prepare(`SELECT sources_seen FROM scraped_jobs WHERE job_id = ?`),
      demote: db.prepare(`UPDATE scraped_jobs SET is_active = 0 WHERE job_id = ?`),
      foldIntoExisting: db.prepare(`
        UPDATE scraped_jobs SET
          description            = @description,
          company_icon_url       = @company_icon_url,
          workplace_type          = @workplace_type,
          experience_level        = @experience_level,
          valid_through           = @valid_through,
          salary_min_usd          = @salary_min_usd,
          salary_max_usd          = @salary_max_usd,
          salary_period           = @salary_period,
          skills_json             = @skills_json,
          is_h1b_sponsor          = @is_h1b_sponsor,
          requires_work_auth      = @requires_work_auth,
          is_clearance_required   = @is_clearance_required,
          posted_at               = @posted_at,
          sources_seen            = @sources_seen,
          req_uid                 = @req_uid
        WHERE job_id = @job_id
      `),
    };
    fingerprintStmtsCache.set(db, stmts);
  }
  return stmts;
}

// Picks which (if any) of the rows sharing a fingerprint is "the same job" as the incoming
// one, per Task 3.1's two-tier rule:
//   - Incoming has a req_uid: an exact req_uid match is definitely the same job. Absent that,
//     a candidate with NO req_uid (a hash-only aggregator echo) is treated as the same job too
//     — that's the ATS<->aggregator merge case. If every candidate has a DIFFERENT non-null
//     req_uid, none of them match: these are genuinely distinct sibling reqs, not duplicates.
//   - Incoming has no req_uid (aggregator/unknown source): prefer folding into a candidate
//     that DOES have a req_uid (the ATS canonical) over a hash-only one, since that's the
//     more precisely-identified row; falls back to Task 3's original "any fingerprint match"
//     behavior when no candidate has a req_uid either.
// Known limitation: if an aggregator echo arrives BEFORE its own ATS twin, and a genuinely
// different sibling req (same title/company/location) exists, that later sibling could match
// the orphaned hash-only row instead of creating its own — aggregators carry no req id, so
// this ambiguity can't be fully resolved from their data alone. Distinct siblings still never
// silently disappear once each has arrived from a source that DOES carry a req_uid.
function selectMatch(candidates, reqUid) {
  if (!candidates.length) return null;
  if (reqUid) {
    const exact = candidates.find(c => c.req_uid === reqUid);
    if (exact) return exact;
    const hashOnly = candidates.find(c => !c.req_uid);
    return hashOnly || null;
  }
  return candidates.find(c => c.req_uid) || candidates[0];
}

/**
 * Cross-source dedup check — call before every write to scraped_jobs so a role arriving
 * from an aggregator (adzuna/serpapi) never coexists on the board alongside the same role's
 * direct-ATS copy, WHILE keeping genuinely distinct sibling requisitions (same title/company/
 * location, different req) as separate rows (Task 3.1). Never hard-deletes: a demoted
 * duplicate keeps its row (is_active=0) so any job_applications/resumes tied to its job_id
 * stay intact; a folded (lower-priority) duplicate never gets a row of its own at all.
 *
 * Returns:
 *   { action: 'insert_canonical', job, sourcesSeen, fingerprint, reqUid }
 *     → caller should upsert `job` (already union-merged with any demoted duplicate's fields)
 *       as its own row, storing `fingerprint`, `sourcesSeen`, and `reqUid`. Any previously-
 *       canonical lower-priority row this job actually matches has already been demoted.
 *   { action: 'fold', intoJobId, fingerprint, reqUid }
 *     → caller must NOT write a row for this job; its data has already been folded into the
 *       existing higher-(or-equal-)priority canonical row (whose req_uid is `reqUid`).
 */
function reconcileFingerprint(db, job) {
  const stmts       = getFingerprintStmts(db);
  const fingerprint = computeFingerprint(job);
  const reqUid      = computeReqUid(job);
  const jobId       = job.id || job.url || '';

  const candidates = stmts.findCandidates.all(fingerprint, jobId);
  const existing   = selectMatch(candidates, reqUid);

  if (!existing) {
    // Either nothing shares this fingerprint, or (reqUid set) every same-fingerprint row is a
    // confirmed-distinct sibling req — either way this job gets its own canonical row.
    const own = stmts.findOwnSourcesSeen.get(jobId);
    const sourcesSeen = mergeSourcesSeen(own?.sources_seen, job.source);
    return { action: 'insert_canonical', job, sourcesSeen, fingerprint, reqUid };
  }

  const incomingWins = sourcePriority(job.source) > sourcePriority(existing.source);

  if (incomingWins) {
    const sourcesSeen = mergeSourcesSeen(existing.sources_seen, existing.source, job.source);
    const merged      = unionMergeFields(job, existing);
    stmts.demote.run(existing.job_id);
    const finalReqUid = reqUid || existing.req_uid || null;
    return { action: 'insert_canonical', job: merged, sourcesSeen, fingerprint, reqUid: finalReqUid };
  }

  // Incoming is a same-or-lower-priority duplicate of an already-canonical role — fold its
  // useful fields into the canonical row instead of creating a second board entry.
  const sourcesSeen     = mergeSourcesSeen(existing.sources_seen, existing.source, job.source);
  const mergedExisting  = unionMergeFields(existing, job);
  const finalReqUid     = existing.req_uid || reqUid || null;
  stmts.foldIntoExisting.run({ ...mergedExisting, sources_seen: sourcesSeen, req_uid: finalReqUid, job_id: existing.job_id });
  return { action: 'fold', intoJobId: existing.job_id, fingerprint, reqUid: finalReqUid };
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
 * @param {import('@anthropic-ai/sdk').default | null} [anthropic] optional — when provided,
 *   a background LLM enrichment pass (services/jobs/enrichJob.js) runs after the sync
 *   completes. Omitted/falsy simply skips enrichment (e.g. no ANTHROPIC_KEY configured).
 */
async function cacheJobs(db, anthropic = null) {
  try {
    const atsCos = db.prepare("SELECT * FROM company_ats_list WHERE active = 1").all();
    if (!atsCos.length) {
      console.log('[cacheJobs] No active ATS companies — skipping cache warm');
      return 0;
    }

    const companyMap = {
      greenhouse:      atsCos.filter(r => r.ats_type === 'greenhouse'),
      lever:           atsCos.filter(r => r.ats_type === 'lever'),
      ashby:           atsCos.filter(r => r.ats_type === 'ashby'),
      workday:         atsCos.filter(r => r.ats_type === 'workday'),
      smartrecruiters: atsCos.filter(r => r.ats_type === 'smartrecruiters'),
      workable:        atsCos.filter(r => r.ats_type === 'workable'),
      recruitee:       atsCos.filter(r => r.ats_type === 'recruitee'),
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
         discovered_at, updated_at, is_active, fingerprint, sources_seen, req_uid)
      VALUES
        (@job_id, @search_query, @_hash, @title, @company, @location, @url, @source, @source_label,
         @posted_at, @scraped_at, @bucket_role, @bucket_seniority, @bucket_domain, @direct_apply, @description,
         @company_icon_url, @via, @collar, @classification_confidence,
         @normalized_title, @summary, @experience_level, @workplace_type, @valid_through,
         @salary_min_usd, @salary_max_usd, @salary_period, @skills_json,
         @is_h1b_sponsor, @requires_work_auth, @is_clearance_required,
         @discovered_at, @updated_at, 1, @fingerprint, @sources_seen, @req_uid)
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
    // without re-running classification or rewriting every column. Also (re)writes the
    // fingerprint/sources_seen/req_uid every crawl, so rows created before migration 063/065
    // (or before a cross-source duplicate showed up) self-heal into the dedup system over
    // time instead of sitting on the coarse key forever.
    const touchSeenStmt = db.prepare(`
      UPDATE scraped_jobs SET updated_at = ?, scraped_at = ?, is_active = 1,
        fingerprint = ?, sources_seen = ?, req_uid = ?
      WHERE job_id = ?
    `);
    const demoteStmt = db.prepare(`UPDATE scraped_jobs SET is_active = 0 WHERE job_id = ?`);

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
      const { cached, unchanged, ejected, dropped, merged } = db.transaction(() => {
        let cached = 0, unchanged = 0, ejected = 0, dropped = 0, merged = 0;

        for (const job of fetchedJobs) {
          const jobId = job.id || job.url || '';
          if (!jobId) continue;

          const contentHash = fingerprintJob(job);
          if (existingHashes.get(jobId) === contentHash) {
            // Still run cross-source reconciliation even on the cheap path: a duplicate from
            // another source may have appeared (or disappeared) since this row was last touched.
            const jobForDedup = { ...job, company_icon_url: job.thumbnail || job.companyIconUrl || null };
            const dedup = reconcileFingerprint(db, jobForDedup);
            if (dedup.action === 'fold') {
              // This previously-canonical row turns out to be a duplicate of a higher-(or-equal-)
              // priority row that appeared since — its fields were just folded into that row.
              demoteStmt.run(jobId);
              merged++;
            } else {
              touchSeenStmt.run(now, now, dedup.fingerprint, dedup.sourcesSeen, dedup.reqUid, jobId);
              unchanged++;
            }
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

          // Cross-source dedup: collapse this posting into an existing higher-(or-equal-)
          // priority canonical row if the same role already has one from another source.
          const jobForDedup = { ...job, company_icon_url: job.thumbnail || job.companyIconUrl || null };
          const dedup = reconcileFingerprint(db, jobForDedup);
          if (dedup.action === 'fold') {
            merged++;
            continue;
          }
          const canonical = dedup.job;

          upsertStmt.run({
            job_id:                    jobId,
            search_query:              canonical.source || 'ats',
            _hash:                     contentHash,
            title:                     canonical.title || '',
            company:                   canonical.company || '',
            location:                  canonical.location || '',
            url:                       canonical.url || '',
            source:                    canonical.source || '',
            source_label:              canonical.source_label || '',
            posted_at:                 canonical.posted_at || null,
            scraped_at:                now,
            bucket_role:               verdict.roleKey,
            bucket_seniority:          verdict.seniority || null,
            bucket_domain:             verdict.domain || null,
            direct_apply:              canonical.direct_apply === false ? 0 : 1,
            description:               canonical.description || null,
            company_icon_url:          canonical.company_icon_url || null,
            via:                       canonical.via || null,
            collar:                    'white',
            classification_confidence: verdict.confidence || 0,
            normalized_title:          canonical.normalized_title || null,
            summary:                   canonical.summary         || null,
            experience_level:          canonical.experience_level || null,
            workplace_type:            canonical.workplace_type  || null,
            valid_through:             canonical.valid_through   != null ? canonical.valid_through : null,
            salary_min_usd:            canonical.salary_min_usd  != null ? canonical.salary_min_usd  : null,
            salary_max_usd:            canonical.salary_max_usd  != null ? canonical.salary_max_usd  : null,
            salary_period:             canonical.salary_period   || null,
            skills_json:               canonical.skills_json     || null,
            is_h1b_sponsor:            canonical.is_h1b_sponsor  != null ? canonical.is_h1b_sponsor  : null,
            requires_work_auth:        canonical.requires_work_auth != null ? canonical.requires_work_auth : null,
            is_clearance_required:     canonical.is_clearance_required != null ? canonical.is_clearance_required : null,
            discovered_at:             now,
            updated_at:                now,
            fingerprint:               dedup.fingerprint,
            sources_seen:              dedup.sourcesSeen,
            req_uid:                   dedup.reqUid,
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

        return { cached, unchanged, ejected, dropped, merged };
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
      if (merged  > 0) console.log(`[cacheJobs:${source.name}] Merged ${merged} cross-source duplicates into existing canonical rows`);
      if (pruned  > 0) console.log(`[cacheJobs:${source.name}] Pruned ${pruned} jobs inactive (${byDate.changes} expired, ${byStale.changes} stale)`);
      console.log(`[cacheJobs:${source.name}] Sync complete — ${fetchedJobs.length} fetched, ${cached} new/changed, ${unchanged} unchanged (touch-only), ${merged} merged, ${pruned} pruned (prevWatermark=${prevWatermark})`);
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

    // Background job-description enrichment (non-blocking — never delays the board query
    // or this function's return). Skips cleanly when no Anthropic client is configured.
    setImmediate(() => {
      runEnrichment(db, anthropic).catch(e => console.warn('[enrichJob] Background pass failed:', e.message));
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

export { searchJobs, cacheJobs, getSourceStatus, reconcileFingerprint };
