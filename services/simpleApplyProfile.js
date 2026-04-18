import crypto from "crypto";

const STOP_WORDS = new Set([
  "and","the","for","with","that","this","from","into","your","you","are","was","were",
  "have","has","had","will","can","our","their","they","them","using","use","used","work",
  "team","teams","role","roles","job","jobs","resume","experience","responsible","including",
  "based","within","across","through","about","over","under","than","then","also","such",
  "business","management","support","professional","services","solutions","customer","client",
  "stakeholder","stakeholders","communication","collaboration","leadership","strategy",
]);

const TITLE_HINTS = [
  "software engineer","backend engineer","frontend engineer","full stack engineer",
  "data scientist","data analyst","data engineer","machine learning engineer",
  "project manager","program manager","product manager","business analyst",
  "devops engineer","site reliability engineer","security engineer",
];

const SKILL_HINTS = [
  "javascript","typescript","react","node","python","java","sql","postgres","sqlite",
  "aws","azure","gcp","docker","kubernetes","terraform","linux","api","rest","graphql",
  "machine learning","tensorflow","pytorch","pandas","spark","tableau","power bi",
  "agile","scrum","jira","roadmap","budget","risk","timeline",
];

function compactUnique(items, max) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const value = String(item || "").trim().toLowerCase();
    if (!value || value.length > 60 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function scoreTokens(text) {
  const counts = new Map();
  for (const raw of String(text || "").toLowerCase().match(/[a-z][a-z0-9+#.]{2,}/g) || []) {
    if (STOP_WORDS.has(raw)) continue;
    counts.set(raw, (counts.get(raw) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word]) => word);
}

export function deriveSimpleApplyProfile(resumeText, roleTitles = []) {
  const text = String(resumeText || "");
  const lower = text.toLowerCase();
  const titles = compactUnique([
    ...roleTitles,
    ...TITLE_HINTS.filter(t => lower.includes(t)),
  ], 8);
  const skills = compactUnique(SKILL_HINTS.filter(s => lower.includes(s)), 16);
  const keywords = compactUnique([...skills, ...scoreTokens(text)], 28);
  const searchTerms = compactUnique([...titles.slice(0, 4), ...skills.slice(0, 6)], 8);
  return {
    titles,
    skills,
    keywords,
    searchTerms,
    sourceHash: crypto.createHash("sha256").update(text).digest("hex"),
  };
}

export function upsertSimpleApplyProfile(db, userId, resumeText, roleTitles = []) {
  const profile = deriveSimpleApplyProfile(resumeText, roleTitles);
  db.prepare(`
    INSERT INTO simple_apply_profiles
      (user_id, titles_json, keywords_json, skills_json, search_terms_json, source_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET
      titles_json=excluded.titles_json,
      keywords_json=excluded.keywords_json,
      skills_json=excluded.skills_json,
      search_terms_json=excluded.search_terms_json,
      source_hash=excluded.source_hash,
      updated_at=excluded.updated_at
  `).run(
    userId,
    JSON.stringify(profile.titles),
    JSON.stringify(profile.keywords),
    JSON.stringify(profile.skills),
    JSON.stringify(profile.searchTerms),
    profile.sourceHash,
  );
  return profile;
}

export function loadSimpleApplyProfile(db, userId) {
  const row = db.prepare("SELECT * FROM simple_apply_profiles WHERE user_id=?").get(userId);
  if (!row) return null;
  const parse = (value) => {
    try { return JSON.parse(value || "[]"); } catch { return []; }
  };
  return {
    titles: parse(row.titles_json),
    keywords: parse(row.keywords_json),
    skills: parse(row.skills_json),
    searchTerms: parse(row.search_terms_json),
    sourceHash: row.source_hash,
    updatedAt: row.updated_at,
  };
}
