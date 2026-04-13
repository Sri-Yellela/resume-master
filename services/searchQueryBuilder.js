// ============================================================
// services/searchQueryBuilder.js — Role normalisation and query building
// ============================================================
// What this file does:
//   Replaces ROLE_ALIASES + normaliseSearchQuery() + isTitleRelevant()
//   from server.js. Builds Apify search queries from role, classifier
//   result, and qualification resolver result.
//
// What to change here if intent changes:
//   - TO EXPAND ROLE COVERAGE: add entries to data/ROLE_ALIAS_MAP.json.
//     Do not add aliases directly in this file.
//   - QUERY PRIORITY: canonical role first, then variants, then qual
//     templates, then classifier suggestions. To change priority,
//     reorder the merge array in buildApifyQueries().
//   - TITLE RELEVANCE: roleKeywords is derived from ROLE_ALIAS_MAP canonical
//     titles. To add new role families, add entries to ROLE_ALIAS_MAP.json.
//
// Depends on: data/ROLE_ALIAS_MAP.json, data/QUALIFICATION_ROLE_MAP.json
// ============================================================

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _aliasMap = null;
function getAliasMap() {
  if (!_aliasMap) {
    try {
      const p = path.join(__dirname, "..", "data", "ROLE_ALIAS_MAP.json");
      _aliasMap = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch { _aliasMap = {}; }
  }
  return _aliasMap;
}

// Normalise raw user input to a canonical role title.
// TO EXPAND ROLE COVERAGE: add entries to data/ROLE_ALIAS_MAP.json.
// Do not add aliases here directly.
export function normaliseRole(rawInput) {
  if (!rawInput) return "";
  const trimmed = rawInput.trim().replace(/\s+/g, " ");
  const lower   = trimmed.toLowerCase();
  const map     = getAliasMap();
  if (map[lower]?.canonical) return map[lower].canonical;
  // Title-case fallback
  return trimmed.replace(/\b\w/g, c => c.toUpperCase());
}

// Build a deduplicated list of Apify search query strings.
// QUERY PRIORITY: canonical role first, then variants, then qual templates,
// then classifier suggestions. To change priority order, reorder the array below.
export function buildApifyQueries(canonicalRole, classifierResult, qualTemplates) {
  const queries = new Set();

  // 1. Canonical role (highest priority)
  if (canonicalRole) queries.add(canonicalRole);

  // 2. searchVariants from ROLE_ALIAS_MAP for this role
  const map   = getAliasMap();
  const lower = canonicalRole?.toLowerCase();
  for (const [, entry] of Object.entries(map)) {
    if (entry.canonical?.toLowerCase() === lower) {
      (entry.searchVariants || []).forEach(v => queries.add(v));
    }
  }

  // 3. Qualification-based search templates
  (qualTemplates || []).forEach(t => {
    const filled = t.replace("{role}", canonicalRole || "");
    queries.add(filled);
  });

  // 4. Classifier search suggestions
  (classifierResult?.searchQueries || []).forEach(q => queries.add(q));

  // Normalise and cap at 5
  return [...queries]
    .map(q => q.trim())
    .filter(q => q.length > 0)
    .slice(0, 5);
}

// Port of isTitleRelevant() from server.js, extended to all role families.
// roleKeywords is derived dynamically from ROLE_ALIAS_MAP canonical titles.
// To add new role families: add entries to ROLE_ALIAS_MAP.json.
export function isTitleRelevant(title, query) {
  if (!title || !query) return true;

  const TYPO_MAP = {
    "enginere":"engineer","enigneer":"engineer","enginerd":"engineer",
    "sofware":"software","softwar":"software",
    "developr":"developer","devloper":"developer",
    "maneger":"manager","mangager":"manager","manger":"manager",
    "progam":"program","proejct":"project",
    "analist":"analyst","analst":"analyst",
    "maching":"machine","machien":"machine",
  };

  const STOP_WORDS = new Set([
    "the","and","for","with","ing","senior","junior","staff","principal",
    "lead","associate","manager","engineer","specialist","coordinator",
    "director","executive","officer","head","vp","svp","evp",
  ]);

  function tokenise(s) {
    return s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .map(w => TYPO_MAP[w] || w)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  }

  const titleTokens = tokenise(title);
  const queryTokens = tokenise(query);

  if (queryTokens.length === 0) return true;

  // Build dynamic role keywords from ROLE_ALIAS_MAP canonical titles
  const map = getAliasMap();
  const roleKeywords = new Set();
  for (const entry of Object.values(map)) {
    if (entry.canonical) {
      tokenise(entry.canonical).forEach(t => roleKeywords.add(t));
    }
  }
  // Add common role-class keywords not in the alias map
  [
    "engineer","developer","scientist","analyst","manager","designer",
    "architect","consultant","specialist","coordinator","director",
    "associate","researcher","planner","administrator","officer",
    "technician","inspector","estimator","superintendent",
    "accountant","auditor","controller","attorney","counsel",
    "recruiter","buyer","planner","strategist","writer",
  ].forEach(k => roleKeywords.add(k));

  // A title is relevant if it shares at least one meaningful token with the query,
  // OR if it contains at least one known role-class keyword
  const sharedWithQuery = queryTokens.some(qt => titleTokens.includes(qt));
  const hasRoleKeyword  = titleTokens.some(t  => roleKeywords.has(t));

  return sharedWithQuery || hasRoleKeyword;
}
