// ============================================================
// services/jobs/searchSuggestions.js — typeahead for the search bar
// ============================================================
// What this file does:
//   Derives the search bar's title and location suggestions FROM scraped_jobs, scoped to the
//   caller's active role, ranked by how often each one actually occurs. There is no
//   hand-maintained list of roles anywhere in here: if a title is not on the board, it is not
//   suggested, and when the board changes the suggestions change with it.
//
// What to change here if intent changes:
//   - TO CHANGE WHAT COLLAPSES TOGETHER: SENIORITY_PREFIX / the trimming in baseTitle().
//     Canonical role names themselves live in data/ROLE_ALIAS_MAP.json — add aliases there, not
//     here, exactly as services/searchQueryBuilder.js instructs.
//   - TO CHANGE FRESHNESS: TTL_MS.
//
// Depends on: services/searchQueryBuilder.js (normaliseRole — the project's existing
// normalisation, reused rather than reimplemented).
//
// NOT wired to buildApifyQueriesFromProfile, deliberately: that is scraping-era and off-limits.
// The only thing borrowed from that module is normaliseRole, which is a pure string function.
// ============================================================

import { normaliseRole } from "../searchQueryBuilder.js";

// How long a built index is served before it is rebuilt. The board is crawled nightly, so a title
// list that is a few minutes stale is not wrong in any way a user could notice — and the point of
// the cache is that typing must never become a query per keystroke against a 1,253-row join.
const TTL_MS = 5 * 60 * 1000;

// Seniority and stage words are stripped before normalisation so that the SAME role does not
// occupy three suggestion slots. This is the requirement's own example: "Sr. Software Engineer",
// "Senior Software Engineer" and "SWE" must collapse to one entry. The first two reduce to
// "software engineer" here and then title-case through normaliseRole; "swe" is an alias in
// ROLE_ALIAS_MAP.json and resolves to the same canonical string. All three land on
// "Software Engineer".
//
// Anchored at the start only. A trailing qualifier is a different job ("Engineering Manager" is
// not "Engineer"), and stripping it anywhere in the string would merge roles that are genuinely
// distinct.
const SENIORITY_PREFIX =
  /^(?:sr\.?|senior|jr\.?|junior|staff|principal|lead|entry[- ]level|new[- ]grad(?:uate)?|associate|apprentice|graduate|intern(?:ship)?)\s+/i;
// A title that is ONLY a seniority word is not a role — "Sr." on its own describes nobody's job.
// A separate pattern because the prefix form above requires trailing whitespace to consume, and so
// cannot see a string that is nothing but the qualifier.
const SENIORITY_ONLY =
  /^(?:sr\.?|senior|jr\.?|junior|staff|principal|lead|entry[- ]level|new[- ]grad(?:uate)?|associate|apprentice|graduate|intern(?:ship)?)$/i;

/**
 * Reduce one stored title to the role it is an instance of.
 *
 * scraped_jobs.normalized_title is written by the enrichment pass and looks like
 * "software engineer, machine learning platform" — the role, then the team or specialisation. The
 * suggestion list wants the role. Everything from the first comma, bracket or en/em dash onward is
 * that trailing detail, and keeping it would produce a list of a thousand one-off strings rather
 * than a ranking of the roles the board actually holds.
 */
export function baseTitle(raw) {
  if (!raw || typeof raw !== "string") return "";
  let t = raw
    .split(/[,([–—]|\s+[-–—]\s+/)[0]   // drop ", …", " (…", " - …", " – …"
    .replace(/\s+/g, " ")
    .trim();
  // Repeatedly, because "senior staff software engineer" carries two.
  let previous;
  do { previous = t; t = t.replace(SENIORITY_PREFIX, ""); } while (t !== previous);
  t = t.trim();
  return SENIORITY_ONLY.test(t) ? "" : t;
}

/**
 * A stored title -> the canonical string shown in the dropdown.
 * Returns "" for anything that reduces to nothing, or to a fragment too short to be a role.
 */
export function canonicalTitle(raw) {
  const base = baseTitle(raw);
  if (base.length < 3) return "";
  return normaliseRole(base);
}

/** Locations get whitespace and separator tidying only — there is no alias map for places. */
export function canonicalLocation(raw) {
  if (!raw || typeof raw !== "string") return "";
  const t = raw.replace(/\s+/g, " ").replace(/\s*[;|]\s*/g, ", ").trim();
  if (t.length < 2) return "";
  // Title-case only all-lower or all-upper input, so "New York, NY" and "USA" survive as written.
  if (t === t.toLowerCase() || t === t.toUpperCase()) {
    return t.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }
  return t;
}

// roleKey -> { at, titles, locations }. Process-local by design: it is derived data with a TTL, so
// a restart or a second worker simply rebuilds it.
const cache = new Map();

/** Frequency-ranked [{ value, count }], highest first, ties broken alphabetically for stability. */
function rank(counts) {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/**
 * Build (or reuse) the whole suggestion index for one role scope.
 *
 * ONE query per role scope per TTL, reading two columns. Everything the typeahead does afterwards
 * is an in-memory filter over a few hundred short strings, which is what keeps a keystroke from
 * reaching the jobs table.
 */
export function getSuggestionIndex(db, roleKey, { now = Date.now(), ttlMs = TTL_MS } = {}) {
  const key = String(roleKey || "");
  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit;

  // Same scoping as the board's own discovery query: the active profile's role_key through
  // job_role_map, and live rows only. Suggesting a title that the board cannot then show would be
  // worse than suggesting nothing.
  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(sj.normalized_title), ''), sj.title) AS title,
           sj.location AS location
    FROM scraped_jobs sj
    JOIN job_role_map jrm ON jrm.job_id = sj.job_id AND jrm.role_key = ?
    WHERE sj.is_active = 1
  `).all(key);

  const titles = new Map();
  const locations = new Map();
  for (const r of rows) {
    const t = canonicalTitle(r.title);
    if (t) titles.set(t, (titles.get(t) || 0) + 1);
    const l = canonicalLocation(r.location);
    if (l) locations.set(l, (locations.get(l) || 0) + 1);
  }

  const built = { at: now, titles: rank(titles), locations: rank(locations) };
  cache.set(key, built);
  return built;
}

/** Drop cached indexes. Exported for tests and for callers that have just rewritten the board. */
export function clearSuggestionCache() { cache.clear(); }

/**
 * Match ranking, in three tiers, so that typing "s" leads with the roles that START with s rather
 * than with whatever merely contains one.
 *
 *   0  prefix of the whole string      "s"  -> "Software Engineer"
 *   1  prefix of any later word        "eng" -> "Software Engineer"
 *   2  substring anywhere              "ware" -> "Software Engineer"
 *
 * Within a tier the frequency order from the index is preserved.
 */
function tierOf(valueLower, qLower) {
  if (valueLower.startsWith(qLower)) return 0;
  if (valueLower.split(/[\s/]+/).some((w) => w.startsWith(qLower))) return 1;
  return valueLower.includes(qLower) ? 2 : -1;
}

/**
 * @returns {string[]} up to `limit` suggestions. An empty array is a NORMAL result — the caller
 * shows nothing at all for it, not an error and not an empty box.
 */
export function suggest(db, { roleKey, field = "title", q = "", limit = 8, now = Date.now() } = {}) {
  const query = String(q || "").trim().toLowerCase();
  if (!query) return [];

  const index = getSuggestionIndex(db, roleKey, { now });
  const pool = field === "location" ? index.locations : index.titles;

  // The typed text is normalised through the SAME pipeline as the stored titles before matching, so
  // an alias types through: "swe" becomes "Software Engineer" and therefore prefix-matches the
  // entry built from the board's own rows. Without this the alias map would only affect display and
  // typing a real-world abbreviation would find nothing.
  const alias = field === "title" ? canonicalTitle(query).toLowerCase() : "";
  const needles = alias && alias !== query ? [query, alias] : [query];

  const scored = [];
  for (const { value } of pool) {
    const lower = value.toLowerCase();
    let best = -1;
    for (const n of needles) {
      const t = tierOf(lower, n);
      if (t !== -1 && (best === -1 || t < best)) best = t;
    }
    if (best !== -1) scored.push({ value, tier: best });
  }
  // Stable sort by tier alone: the pool is already frequency-ordered, so equal tiers keep it.
  scored.sort((a, b) => a.tier - b.tier);
  return scored.slice(0, limit).map((s) => s.value);
}
