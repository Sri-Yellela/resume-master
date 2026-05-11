import { validatePlugin } from './sources/base.js';
import { stripInternalFields } from './schema.js';
import { classify } from './classifier.js';
import { filterDirectApplyOnly } from './directApplyFilter.js';

// ─── REGISTER SOURCES HERE ───────────────────────────────────────────────────
// To add a new source: import it and add to SOURCES array.
// To disable a source: comment out its line. Zero other changes needed.

import adzunaPlugin    from './sources/adzuna.js';
import greenhousePlugin from './sources/greenhouse.js';
import leverPlugin     from './sources/lever.js';
import ashbyPlugin     from './sources/ashby.js';
// import theMuse   from './sources/themusejobs.js';  // add when ready
// import usaJobs   from './sources/usajobs.js';      // add when ready
// import indeed    from './sources/indeed.js';        // add when approved

const SOURCES = [
  adzunaPlugin,
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
      source_label: SOURCE_LABELS[job.source] || job.source,
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
 * Returns readiness status of all registered sources.
 * Used by integrationReadiness.js and admin panel.
 */
function getSourceStatus() {
  return SOURCES.map(source => ({
    name:       source.name,
    configured: source.isConfigured(),
  }));
}

export { searchJobs, getSourceStatus };
