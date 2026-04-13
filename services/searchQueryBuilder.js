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
// TITLE RELEVANCE: requires BOTH function word match AND domain word match when present in query.
// If query has a function word (engineer/manager/analyst/etc.) it must appear in title.
// If query has a domain word (software/data/product/etc.) it or a synonym must appear in title.
// Generic titles with no matching domain (Secretary, Agent, etc.) are correctly rejected.
export function isTitleRelevant(title, query) {
  if (!title || !query) return true;

  // FUNCTION_WORDS: job type indicators — NOT in STOP_WORDS so they can be matched
  const FUNCTION_WORDS = new Set([
    "engineer","developer","scientist","analyst","manager","designer",
    "architect","consultant","specialist","researcher","administrator",
    "technician","recruiter","accountant","attorney","nurse","officer",
    "planner","strategist","writer","programmer","instructor","teacher",
    "coordinator","director","producer","editor","illustrator","animator",
  ]);

  // DOMAIN_SYNONYMS: for a domain word in the query, accept these in the title too
  const DOMAIN_SYNONYMS = {
    software:  ["software","web","frontend","backend","fullstack","application","app"],
    machine:   ["machine","ml","deep","learning","neural","ai","artificial"],
    data:      ["data","analytics","bi","database","warehouse"],
    product:   ["product"],
    devops:    ["devops","devsecops","platform","infrastructure","sre","reliability"],
    security:  ["security","cybersecurity","infosec","appsec","devsecops"],
    mobile:    ["mobile","ios","android","flutter","react"],
    cloud:     ["cloud","infrastructure","platform","azure","aws","gcp"],
    hardware:  ["hardware","electrical","electronics","embedded","firmware"],
    network:   ["network","networking","systems","telecom"],
    game:      ["game","gaming","unity","unreal"],
    marketing: ["marketing","growth","digital","seo","content"],
    finance:   ["finance","financial","accounting","treasury","investment"],
    sales:     ["sales","revenue","business","account"],
  };

  // STOP_WORDS for tokenisation — intentionally does NOT include function words
  const STOP_WORDS = new Set([
    "the","and","for","with","senior","junior","staff","principal",
    "lead","associate","head","vp","svp","evp","entry","level",
    "remote","hybrid","onsite","part","time","full","contract",
  ]);

  const TYPO_MAP = {
    "enginere":"engineer","enigneer":"engineer","enginerd":"engineer",
    "sofware":"software","softwar":"software",
    "developr":"developer","devloper":"developer",
    "maneger":"manager","mangager":"manager","manger":"manager",
    "analist":"analyst","analst":"analyst",
    "maching":"machine","machien":"machine",
  };

  function tokenise(s) {
    return s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .map(w => TYPO_MAP[w] || w)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  }

  const titleTokens = new Set(tokenise(title));
  const queryTokens = tokenise(query);

  if (queryTokens.length === 0) return true;

  // Separate function words from domain words in the query
  const queryFnWords  = queryTokens.filter(t => FUNCTION_WORDS.has(t));
  const queryDomWords = queryTokens.filter(t => !FUNCTION_WORDS.has(t) && t.length > 2);

  // Function word check: if query has function words, at least one must appear in title
  let fnMatch = queryFnWords.length === 0; // trivially pass if no function words in query
  for (const fw of queryFnWords) {
    if (titleTokens.has(fw)) { fnMatch = true; break; }
  }

  // Domain word check: if query has domain words, at least one (or synonym) must appear in title
  let domMatch = queryDomWords.length === 0; // trivially pass if no domain words in query
  for (const dw of queryDomWords) {
    if (titleTokens.has(dw)) { domMatch = true; break; }
    const syns = DOMAIN_SYNONYMS[dw] || [];
    if (syns.some(s => titleTokens.has(s))) { domMatch = true; break; }
  }

  // Both must match when present in query
  return fnMatch && domMatch;
}
