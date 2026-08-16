/**
 * SQL WHERE-clause + facet builder for the /api/jobs board query.
 *
 * Every filter here is OPTIONAL and additive. When none of the params this module reads
 * are present, buildJobFilters() returns an empty sql fragment and empty params array, so
 * a caller passing none of them gets byte-identical query behavior to before this module
 * existed. This module never touches the database itself — it only builds SQL fragments +
 * bound params (and a couple of pure post-fetch aggregation helpers), so it composes with
 * whatever profile/role_key/join scoping the caller already applies.
 */

// Columns a caller may request via include_fields — an ALLOWLIST (not a denylist), so an
// unrecognized/malicious field name can never reach raw SQL string interpolation.
const ALLOWED_FIELDS = new Set([
  'id', 'job_id', 'search_query', 'company', 'title', 'category', 'location', 'work_type',
  'source', 'url', 'posted_at', 'description', 'ghost_score', 'years_experience',
  'is_frequent_repost', 'scraped_at', 'compensation', 'company_icon_url', 'source_platform',
  'apply_url', 'salary_min', 'salary_max', 'salary_currency', 'description_html',
  'applicant_count', 'min_years_exp', 'max_years_exp', 'exp_raw', 'employment_type',
  'domain_profile_id', 'ats_score', 'ats_report', 'bucket_role', 'bucket_seniority',
  'bucket_domain', 'direct_apply', 'source_label', 'via', 'collar',
  'classification_confidence', 'normalized_title', 'summary', 'experience_level',
  'workplace_type', 'valid_through', 'salary_min_usd', 'salary_max_usd', 'salary_period',
  'skills_json', 'is_h1b_sponsor', 'requires_work_auth', 'is_clearance_required',
  'discovered_at', 'updated_at', 'is_active', 'fingerprint', 'sources_seen',
  'automation_tier',
]);

// Facet dimensions the caller may request via include_facets. `skills` isn't a plain SQL
// GROUP BY (skills live in a JSON array column) so it's computed in-app — see
// computeSkillsFacet() below — everything else groups directly in SQL.
const FACET_DIMENSIONS = {
  work_model:       { column: 'sj.workplace_type' },
  experience_level: { column: 'sj.experience_level' },
  employment_type:  { column: 'sj.employment_type' },
  sources:          { column: 'sj.source' },
  // Grouped through the same COALESCE the tier filter uses, so the count the user sees next to
  // "Unknown" is the count they get when they select it — a facet that omitted NULL rows would
  // advertise a smaller number than the filter returns.
  automation_tier:  { column: "COALESCE(sj.automation_tier, 'unknown')" },
  skills:           { column: null },
};

// Columns the free-text `q` search matches against by default (unquoted terms).
const Q_MATCH_COLUMNS = ['sj.title', 'sj.normalized_title', 'sj.company', 'sj.skills_json', 'sj.summary'];

function toArray(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Splits a `q` string into OR terms, "-"-prefixed exclude terms, and "quoted exact title"
// phrases. e.g. `engineer -intern "Staff Software Engineer"` ->
//   [{type:'or',value:'engineer'}, {type:'exclude',value:'intern'}, {type:'exact',value:'Staff Software Engineer'}]
function tokenizeQ(q) {
  const tokens = [];
  const re = /"([^"]+)"|(-\S+)|(\S+)/g;
  let m;
  while ((m = re.exec(q)) !== null) {
    if (m[1] !== undefined)      tokens.push({ type: 'exact',   value: m[1] });
    else if (m[2] !== undefined) tokens.push({ type: 'exclude', value: m[2].slice(1) });
    else if (m[3] !== undefined) tokens.push({ type: 'or',      value: m[3] });
  }
  return tokens;
}

function buildQSql(q) {
  if (!q || !String(q).trim()) return { clause: null, params: [] };
  const tokens = tokenizeQ(String(q).trim());
  const params = [];
  const positiveGroups = [];

  for (const t of tokens.filter(t => t.type === 'or')) {
    positiveGroups.push(`(${Q_MATCH_COLUMNS.map(col => `${col} LIKE ?`).join(' OR ')})`);
    Q_MATCH_COLUMNS.forEach(() => params.push(`%${t.value}%`));
  }
  for (const t of tokens.filter(t => t.type === 'exact')) {
    positiveGroups.push(`LOWER(sj.title) = LOWER(?)`);
    params.push(t.value);
  }

  const clauses = [];
  if (positiveGroups.length) clauses.push(`(${positiveGroups.join(' OR ')})`);
  for (const t of tokens.filter(t => t.type === 'exclude')) {
    clauses.push(`sj.title NOT LIKE ?`);
    params.push(`%${t.value}%`);
  }

  if (!clauses.length) return { clause: null, params: [] };
  return { clause: clauses.join(' AND '), params };
}

/**
 * Builds an additive WHERE-clause fragment (leading "AND ...", or '' if nothing was passed)
 * plus its bound params, from the rich filter vocabulary. Caller splices this into its own
 * WHERE clause (already scoped to `WHERE sj.is_active = 1` and whatever else it needs).
 *
 * Recognized keys (all optional): q, locations, sources, work_models, employment_types,
 * experience_levels, salary_min_usd, salary_max_usd, posted_after, discovered_after,
 * skills_include, skills_exclude, companies_include, companies_exclude,
 * sources_include, sources_exclude, tiers_include, tiers_exclude.
 */
function buildJobFilters(params = {}) {
  const clauses = [];
  const args = [];

  const qSql = buildQSql(params.q);
  if (qSql.clause) { clauses.push(qSql.clause); args.push(...qSql.params); }

  const locations = toArray(params.locations);
  if (locations.length) {
    clauses.push(`(${locations.map(() => 'sj.location LIKE ?').join(' OR ')})`);
    locations.forEach(l => args.push(`%${l}%`));
  }

  const sources = toArray(params.sources);
  if (sources.length) {
    clauses.push(`sj.source IN (${sources.map(() => '?').join(',')})`);
    args.push(...sources);
  }

  // Soft-null, same class as experience_levels below: workplace_type is enrichJob.js-
  // populated, so an unenriched row is NULL and a hard IN would drop it. Not bridge-derived
  // (only set when the user explicitly picks Remote/Hybrid/Onsite), so this can't zero the
  // whole board by default — but with enrichment lagging it would return 0 results and read
  // as "no remote jobs exist," which is worse than showing not-yet-classified rows.
  const workModels = toArray(params.work_models);
  if (workModels.length) {
    clauses.push(`(sj.workplace_type IS NULL OR sj.workplace_type IN (${workModels.map(() => '?').join(',')}))`);
    args.push(...workModels);
  }

  const employmentTypes = toArray(params.employment_types);
  if (employmentTypes.length) {
    clauses.push(`sj.employment_type IN (${employmentTypes.map(() => '?').join(',')})`);
    args.push(...employmentTypes);
  }

  // Soft-null, same class as skills_include above: experience_level is written by
  // enrichJob.js's background LLM pass, so an unenriched row has it NULL and
  // `NULL IN (...)` is NULL -> excluded. This filter is applied BY DEFAULT via
  // profileFilterBridge (any profile with yearsExperience set), so without this guard a
  // lagging enrichment queue silently zeroes the board for the common case — the exact
  // production failure skills_include caused. Widening the bucket one level up (see the
  // bridge) does NOT help here: widening only moves the IN-list, and NULL matches no list.
  const experienceLevels = toArray(params.experience_levels);
  if (experienceLevels.length) {
    clauses.push(`(sj.experience_level IS NULL OR sj.experience_level IN (${experienceLevels.map(() => '?').join(',')}))`);
    args.push(...experienceLevels);
  }

  // Salary range-overlap: a job's [salary_min_usd, salary_max_usd] range overlaps the
  // requested range. Jobs with no salary data can't be verified as overlapping, so an
  // active salary filter excludes them (rather than guessing).
  const salaryMin = toNumber(params.salary_min_usd);
  if (salaryMin != null) {
    clauses.push(`sj.salary_max_usd IS NOT NULL AND sj.salary_max_usd >= ?`);
    args.push(salaryMin);
  }
  const salaryMax = toNumber(params.salary_max_usd);
  if (salaryMax != null) {
    clauses.push(`sj.salary_min_usd IS NOT NULL AND sj.salary_min_usd <= ?`);
    args.push(salaryMax);
  }

  // posted_after / discovered_after: unix epoch seconds, matching this codebase's other
  // epoch-based filters (ageFilter etc). posted_at is a free-text/ISO string per source, so
  // it's parsed the same way the rest of server.js already does (strftime on it).
  const postedAfter = toInt(params.posted_after);
  if (postedAfter != null) {
    clauses.push(`sj.posted_at IS NOT NULL AND sj.posted_at != '' AND CAST(strftime('%s', sj.posted_at) AS INTEGER) >= ?`);
    args.push(postedAfter);
  }
  // COALESCE onto scraped_at rather than hard-excluding NULL. Note this is NOT the soft-null
  // pattern used for the enrichment-backed filters below — a recency filter genuinely must not
  // admit rows of unknown age. It doesn't have to: scraped_at is written on every upsert, so a
  // row missing discovered_at still has a real "when we first saw it" timestamp, which is a
  // strictly better answer than dropping the row.
  //
  // This matters because rows CAN exist without discovered_at. Production carries 10 adzuna rows
  // with it NULL — orphans from the pre-pivot architecture, since no current write path produces
  // adzuna (cacheJobs crawls only DIRECT_ATS_SOURCES, cacheJoboFeed only jobo, searchJobs never
  // writes). They were invisible to every date filter and to the NEW<24h pill, permanently.
  const discoveredAfter = toInt(params.discovered_after);
  if (discoveredAfter != null) {
    clauses.push(`COALESCE(sj.discovered_at, sj.scraped_at) >= ?`);
    args.push(discoveredAfter);
  }

  // Soft-null, matching sponsorship_friendly below: skills_json is populated gradually by
  // enrichJob.js's background LLM pass, so most/all rows can be null at any given time (in
  // production, 0 of 178 active engineering-role rows had it set when this was diagnosed —
  // enrichment lagging entirely, not a rare edge case). Without the `skills_json IS NULL`
  // escape, this was a HARD requirement with no fallback: any profile with skills in its
  // simple_apply_profile (the common case) got this filter derived by default via
  // profileFilterBridge.js, silently zeroing the entire board for that user. A row must never
  // be hidden purely because we haven't enriched it yet — only excluded on an explicit
  // mismatch once it has been.
  const skillsInclude = toArray(params.skills_include);
  if (skillsInclude.length) {
    clauses.push(`(sj.skills_json IS NULL OR (${skillsInclude.map(() => 'sj.skills_json LIKE ?').join(' OR ')}))`);
    skillsInclude.forEach(s => args.push(`%"${s}"%`));
  }
  const skillsExclude = toArray(params.skills_exclude);
  skillsExclude.forEach(s => {
    clauses.push(`(sj.skills_json IS NULL OR sj.skills_json NOT LIKE ?)`);
    args.push(`%"${s}"%`);
  });

  // Visa/sponsorship soft-filter (Profile→Board Bridge): excludes ONLY an explicit
  // disqualifying structured signal — never on absence of one. is_h1b_sponsor/requires_work_auth
  // are populated gradually by enrichJob.js's background LLM pass, so most rows are null at any
  // given time; a sponsorship-needing user must still see those, not have them all hidden.
  // Same "confidence-weighted, never hard-fail" principle as server.js's
  // evaluateProfileFactEligibility() (a complementary text-regex check used at scrape/poll time).
  if (params.sponsorship_friendly) {
    clauses.push(`(sj.requires_work_auth IS NULL OR sj.requires_work_auth != 1)`);
    clauses.push(`(sj.is_h1b_sponsor IS NULL OR sj.is_h1b_sponsor != 0)`);
  }

  // ── Provider (source) include/exclude ────────────────────────────────────────────────────
  // NO null guard, and that is not an oversight — it is the difference between these two columns
  // and the reason they are commented separately.
  //
  // sj.source is written by every scraped_jobs writer as a NOT-NULL-in-practice value (the crawl
  // path passes the ATS name, the live-search path defaults to 'serpapi', the LinkedIn path
  // passes the literal 'LinkedIn'), so there is no "not classified yet" state to protect. A plain
  // IN / NOT IN says exactly what it means here. Adding a soft-null escape would be worse than
  // useless: it would make `sources_exclude` unable to exclude anything if a NULL ever appeared.
  const sourcesInclude = toArray(params.sources_include);
  if (sourcesInclude.length) {
    clauses.push(`sj.source IN (${sourcesInclude.map(() => '?').join(',')})`);
    args.push(...sourcesInclude);
  }
  const sourcesExclude = toArray(params.sources_exclude);
  if (sourcesExclude.length) {
    clauses.push(`sj.source NOT IN (${sourcesExclude.map(() => '?').join(',')})`);
    args.push(...sourcesExclude);
  }

  // ── Automation tier include/exclude ──────────────────────────────────────────────────────
  // NULL IS COALESCED TO 'unknown', in BOTH directions. Read this next to the soft-null comments
  // on skills_include / experience_levels above — it is the same class of hazard reached by a
  // different route, and the decision it takes is deliberately different from theirs.
  //
  // The hazard: automation_tier arrived with migration 078 and is populated by the writers and by
  // the boot backfill, but between the column landing and either of those running, rows are NULL.
  // `NULL IN ('direct')` is NULL, not false — so a bare IN drops those rows silently, and so does
  // a bare `NOT IN ('gated')`, which is the mirror trap: the exclusion direction discards exactly
  // the rows the user never asked to exclude. That silent-drop shape is what took the board to
  // zero before.
  //
  // The decision, and why it is not the `IS NULL OR ...` escape used above: those columns come
  // from a LAGGING background LLM pass and their filters are DERIVED BY DEFAULT from the profile,
  // so admitting NULL is the only thing that stops a lagging queue from zeroing everyone's board.
  // Neither is true here — this tier is computed synchronously on write, and nothing derives it by
  // default, so an unconditional `IS NULL OR` would instead mean that asking for `direct` returns
  // rows we have made no claim about. That is the promise automationTier.js exists to refuse.
  //
  // COALESCE to 'unknown' resolves both at once, because 'unknown' is already the tier that means
  // "we have not established this". A NULL row therefore behaves identically to a row we HAVE
  // classified as unclassifiable: excluded from `tiers_include=direct` (no false promise),
  // included by `tiers_include=unknown` (it genuinely is), kept by `tiers_exclude=gated` (it is
  // not known to be gated), and dropped by `tiers_exclude=unknown` (the user asked to hide exactly
  // this). No row can vanish from both directions, which is the property that failed before.
  const tiersInclude = toArray(params.tiers_include);
  if (tiersInclude.length) {
    clauses.push(`COALESCE(sj.automation_tier, 'unknown') IN (${tiersInclude.map(() => '?').join(',')})`);
    args.push(...tiersInclude);
  }
  const tiersExclude = toArray(params.tiers_exclude);
  if (tiersExclude.length) {
    clauses.push(`COALESCE(sj.automation_tier, 'unknown') NOT IN (${tiersExclude.map(() => '?').join(',')})`);
    args.push(...tiersExclude);
  }

  const companiesInclude = toArray(params.companies_include);
  if (companiesInclude.length) {
    clauses.push(`sj.company IN (${companiesInclude.map(() => '?').join(',')})`);
    args.push(...companiesInclude);
  }
  const companiesExclude = toArray(params.companies_exclude);
  if (companiesExclude.length) {
    clauses.push(`sj.company NOT IN (${companiesExclude.map(() => '?').join(',')})`);
    args.push(...companiesExclude);
  }

  return { sql: clauses.length ? `AND ${clauses.join(' AND ')}` : '', params: args };
}

// include_fields is an ALLOWLIST projection of scraped_jobs columns for lightweight list
// views (e.g. skip `description`). Omitted/empty -> 'sj.*', identical to today's SELECT.
function buildSelectColumns(includeFields) {
  const requested = toArray(includeFields).filter(f => ALLOWED_FIELDS.has(f));
  if (!requested.length) return 'sj.*';
  const cols = new Set(requested);
  cols.add('job_id'); // always required — it's the row identity mapJobRow/the client key on
  return [...cols].map(f => `sj.${f}`).join(', ');
}

// Which of include_facets' requested dimensions are recognized; unknown names are dropped
// rather than erroring, matching the "optional, additive" spirit of the rest of this module.
function resolveFacetDimensions(includeFacets) {
  return toArray(includeFacets).filter(d => Object.prototype.hasOwnProperty.call(FACET_DIMENSIONS, d));
}

// skills_json is a JSON array TEXT column, not a normalized table, so its facet is counted
// in application code from already-fetched skills_json values rather than SQL GROUP BY.
function computeSkillsFacet(skillsJsonList) {
  const counts = new Map();
  for (const raw of skillsJsonList) {
    if (!raw) continue;
    let arr;
    try { arr = JSON.parse(raw); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      // Two coexisting shapes: plain strings (schema.js's heuristic normalizeJob output) and
      // { skill, type } objects (enrichJob.js's typed hard/soft LLM extraction) — a row's
      // skills_json is one or the other depending on whether it's been through enrichment.
      const skill = typeof entry === 'string' ? entry
                  : (entry && typeof entry.skill === 'string' ? entry.skill : null);
      if (!skill) continue;
      counts.set(skill, (counts.get(skill) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count }));
}

export {
  buildJobFilters,
  buildSelectColumns,
  resolveFacetDimensions,
  computeSkillsFacet,
  FACET_DIMENSIONS,
  ALLOWED_FIELDS,
  toArray,
};
