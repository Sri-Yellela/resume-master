/**
 * Normalized Job Schema
 * Every job source plugin must return objects matching this shape.
 * The frontend depends ONLY on this shape — never on source-specific fields.
 *
 * Required fields: id, title, company, location, url, source
 * Optional fields: everything else — use null if unavailable
 */

const JOB_SCHEMA_VERSION = '1.1';

// ── Enum helpers ──────────────────────────────────────────────────────────────

const VALID_EXPERIENCE_LEVELS = new Set(['intern','entry','mid','senior','lead','executive']);

function normalizeExperienceLevel(explicit, title) {
  if (explicit && VALID_EXPERIENCE_LEVELS.has(explicit)) return explicit;
  if (!title) return null;
  const t = title.toLowerCase();
  if (/\b(intern(?:ship)?|co.?op)\b/.test(t)) return 'intern';
  if (/\b(c-suite|chief\s+executive|ceo\b|cto\b|cfo\b|coo\b|cpo\b)\b/.test(t)) return 'executive';
  if (/\b(director|vice\s+president|\bvp\b|head\s+of)\b/.test(t)) return 'lead';
  if (/\b(manager|lead\b)\b/.test(t)) return 'lead';
  if (/\b(senior|sr\.?|principal|staff)\b/.test(t)) return 'senior';
  if (/\b(junior|jr\.?|entry.?level|new.?grad|graduate\b|associate\b)\b/.test(t)) return 'entry';
  return 'mid';
}

const VALID_WORKPLACE_TYPES = new Set(['remote','hybrid','onsite']);

function normalizeWorkplaceType(explicit, remoteBool, title, location) {
  if (explicit) {
    const v = explicit.toLowerCase().replace(/[-\s]+/g, '');
    if (v === 'remote') return 'remote';
    if (v === 'hybrid') return 'hybrid';
    if (v === 'onsite' || v === 'inoffice' || v === 'inperson') return 'onsite';
    if (VALID_WORKPLACE_TYPES.has(v)) return v;
  }
  if (remoteBool === true) return 'remote';
  const text = `${title || ''} ${location || ''}`.toLowerCase();
  if (/\bremote\b/.test(text)) return 'remote';
  if (/\bhybrid\b/.test(text)) return 'hybrid';
  if (/\b(onsite|on.?site|in.?office)\b/.test(text)) return 'onsite';
  return null;
}

function normalizeSalaryPeriod(period) {
  if (!period) return null;
  const p = period.toLowerCase().replace(/[-_\s]+/g, '');
  if (p === 'annual' || p === 'yearly' || p === 'year' || p === 'peryear') return 'annual';
  if (p === 'hourly' || p === 'hour' || p === 'perhour') return 'hourly';
  if (p === 'monthly' || p === 'month' || p === 'permonth') return 'monthly';
  return p;
}

function inferClearanceRequired(title) {
  if (!title) return null;
  return /\b(security\s+clearance|clearance\s+required|active\s+clearance|top.?secret|ts\/sci)\b/i.test(title) ? 1 : null;
}

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
  thumbnail,       // string|null — company logo/thumbnail URL (SerpApi, etc.)
  via,             // string|null — listing attribution e.g. "via LinkedIn"
  _attribution,    // object|null — { name, url } if source ToS requires attribution
  _raw,            // object — original source response (stripped before client)
  // ── Enriched fields (v1.1) — null when source can't supply ──────────────
  workplace_type,      // 'remote'|'hybrid'|'onsite'|null — explicit from source
  experience_level,    // enum from VALID_EXPERIENCE_LEVELS — explicit from source
  valid_through,       // number|null — unix epoch when listing expires
  salary_min_usd,      // number|null — explicit USD override (otherwise derived)
  salary_max_usd,      // number|null — explicit USD override (otherwise derived)
  salary_period,       // 'annual'|'hourly'|'monthly'|null
  skills,              // string[]|null — job skill tags
  is_h1b_sponsor,      // boolean|null
  requires_work_auth,  // boolean|null
  is_clearance_required, // boolean|null — explicit from source
} = {}) {
  if (!id)      throw new Error('normalizeJob: id is required');
  if (!title)   throw new Error('normalizeJob: title is required');
  if (!company) throw new Error('normalizeJob: company is required');
  if (!url)     throw new Error('normalizeJob: url is required');
  if (!source)  throw new Error('normalizeJob: source is required');

  const cleanTitle       = String(title).trim();
  const cleanDesc        = description ? String(description).trim() : null;
  const cleanCurrency    = salary_currency || null;
  const resolvedSalMin   = salary_min != null ? Number(salary_min) : null;
  const resolvedSalMax   = salary_max != null ? Number(salary_max) : null;
  const isUsd            = cleanCurrency === 'USD';

  return {
    id:              `${source}::${id}`,
    title:           cleanTitle,
    company:         String(company).trim(),
    location:        location ? String(location).trim() : 'Location not specified',
    url:             String(url),
    source,
    description:     cleanDesc,
    salary_min:      resolvedSalMin,
    salary_max:      resolvedSalMax,
    salary_currency: cleanCurrency,
    posted_at:       posted_at || null,
    contract_type:   contract_type || null,
    remote:          remote != null ? Boolean(remote) : null,
    thumbnail:       thumbnail || null,
    via:             via || null,
    _attribution:    _attribution || null,
    _raw,
    _schema_version: JOB_SCHEMA_VERSION,
    // ── Enriched fields ─────────────────────────────────────────────────────
    normalized_title:      cleanTitle.toLowerCase(),
    summary:               cleanDesc ? cleanDesc.slice(0, 300) || null : null,
    experience_level:      normalizeExperienceLevel(experience_level, cleanTitle),
    workplace_type:        normalizeWorkplaceType(workplace_type, remote != null ? Boolean(remote) : null, cleanTitle, location),
    valid_through:         valid_through != null ? Math.round(Number(valid_through)) : null,
    salary_min_usd:        salary_min_usd != null ? Math.round(Number(salary_min_usd))
                         : (isUsd && resolvedSalMin != null ? Math.round(resolvedSalMin) : null),
    salary_max_usd:        salary_max_usd != null ? Math.round(Number(salary_max_usd))
                         : (isUsd && resolvedSalMax != null ? Math.round(resolvedSalMax) : null),
    salary_period:         normalizeSalaryPeriod(salary_period),
    skills_json:           Array.isArray(skills) && skills.length ? JSON.stringify(skills) : null,
    is_h1b_sponsor:        is_h1b_sponsor != null ? (is_h1b_sponsor ? 1 : 0) : null,
    requires_work_auth:    requires_work_auth != null ? (requires_work_auth ? 1 : 0) : null,
    is_clearance_required: is_clearance_required != null ? (is_clearance_required ? 1 : 0)
                         : inferClearanceRequired(cleanTitle),
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
