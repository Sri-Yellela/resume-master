/**
 * Normalized Job Schema
 * Every job source plugin must return objects matching this shape.
 * The frontend depends ONLY on this shape — never on source-specific fields.
 *
 * Required fields: id, title, company, location, url, source
 * Optional fields: everything else — use null if unavailable
 */

const JOB_SCHEMA_VERSION = '1.0';

/**
 * Creates a normalized job object with defaults for missing fields.
 * Call this in every source plugin's normalizer.
 */
function normalizeJob({
  id,              // string — unique within this source (will be namespaced)
  title,           // string — job title
  company,         // string — company/employer name
  location,        // string — city, state or "Remote"
  url,             // string — canonical apply URL
  source,          // string — source plugin name e.g. 'adzuna'
  description,     // string|null — plain text job description (no HTML)
  salary_min,      // number|null — minimum salary (annual, USD)
  salary_max,      // number|null — maximum salary (annual, USD)
  salary_currency, // string|null — ISO 4217 e.g. 'USD'
  posted_at,       // string|null — ISO 8601 date string
  contract_type,   // string|null — 'full_time'|'part_time'|'contract'|'internship'
  remote,          // boolean|null — true if explicitly remote
  _attribution,    // object|null — { name, url } if source ToS requires attribution
  _raw,            // object — original source response (stripped before client)
} = {}) {
  if (!id)      throw new Error('normalizeJob: id is required');
  if (!title)   throw new Error('normalizeJob: title is required');
  if (!company) throw new Error('normalizeJob: company is required');
  if (!url)     throw new Error('normalizeJob: url is required');
  if (!source)  throw new Error('normalizeJob: source is required');

  return {
    id:              `${source}::${id}`,
    title:           String(title).trim(),
    company:         String(company).trim(),
    location:        location ? String(location).trim() : 'Location not specified',
    url:             String(url),
    source,
    description:     description ? String(description).trim() : null,
    salary_min:      salary_min != null ? Number(salary_min) : null,
    salary_max:      salary_max != null ? Number(salary_max) : null,
    salary_currency: salary_currency || null,
    posted_at:       posted_at || null,
    contract_type:   contract_type || null,
    remote:          remote != null ? Boolean(remote) : null,
    _attribution:    _attribution || null,
    _raw,
    _schema_version: JOB_SCHEMA_VERSION,
  };
}

/**
 * Strips internal/debug fields before sending to client.
 * Always call this on every job before res.json().
 */
function stripInternalFields(job) {
  const { _raw, _schema_version, ...clientJob } = job;
  return clientJob;
}

export { normalizeJob, stripInternalFields, JOB_SCHEMA_VERSION };
