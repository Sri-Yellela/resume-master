// ============================================================
// services/profileTitleFilter.js — Pure profile title filter helpers
// ============================================================
// Extracted from server.js during phased modularization.
// Used by: server.js job listing/search SQL builders
// ============================================================

export function parseProfileArray(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || "[]"); } catch { return []; }
}

export function profileTitleSql(column, profile) {
  const targetTitles = parseProfileArray(profile?.target_titles);
  if (!targetTitles.length) return { sql: "1 = 1", params: [] };

  const stopWords = new Set([
    "the","and","for","with","ing","a","an","of","in","at","by","to","or",
    "senior","junior","staff","principal","lead","entry","level","mid",
    "ii","iii","iv","i","engineer","engineering",
  ]);

  const clauses = [];
  const params = [];

  for (const rawTitle of targetTitles) {
    const tokens = String(rawTitle || "").toLowerCase()
      .split(/[\s,/\-()]+/)
      .map(w => w.trim())
      .filter(w => w.length > 2 && !stopWords.has(w))
      .slice(0, 4);

    if (!tokens.length) continue;

    clauses.push(`(${tokens.map(() => `LOWER(${column}) LIKE ?`).join(" AND ")})`);
    params.push(...tokens.map(token => `%${token}%`));
  }

  return clauses.length
    ? { sql: `(${clauses.join(" OR ")})`, params }
    : { sql: "1 = 1", params: [] };
}
