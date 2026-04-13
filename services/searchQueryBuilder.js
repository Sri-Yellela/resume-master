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

// TITLE RELEVANCE: ALL meaningful query tokens must appear in the job title (strict AND match).
// "Project Coordinator" → tokens ["project","coordinator"] → both must be in title.
export function isTitleRelevant(title, query) {
  if (!title || !query) return true;
  const t = title.toLowerCase().trim();
  const q = query.toLowerCase().trim();

  const TYPO_MAP = {
    "enginere":"engineer","enigneer":"engineer","enginerd":"engineer",
    "sofware":"software","softwar":"software",
    "developr":"developer","devloper":"developer",
    "maneger":"manager","mangager":"manager","manger":"manager",
    "analist":"analyst","analst":"analyst",
    "maching":"machine","machien":"machine",
  };

  const normTerm = w => TYPO_MAP[w] || w;

  const stopWords = new Set([
    "the","and","for","with","ing","a","an","of","in",
    "at","by","to","or","senior","junior","staff",
    "principal","lead","associate","assistant","entry",
    "level","mid","ii","iii","iv","i",
  ]);

  const tokens = q
    .split(/[\s,/\-]+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .map(normTerm);

  if (tokens.length === 0) return true;

  // Every token must appear in the title — strict AND match
  return tokens.every(token => t.includes(token));
}
