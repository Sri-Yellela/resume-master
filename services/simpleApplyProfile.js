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

// Extract the user's total years of professional experience from their resume text.
// Returns an integer or null if not found. Used as a hard constraint in job filtering.
export function extractUserYearsExperience(text) {
  const str = String(text || "");
  // Match "X+ years of professional/software/work/industry/total experience"
  // Try the most specific patterns first to reduce false positives.
  const patterns = [
    /(\d+)\s*\+?\s*years?\s+of\s+(?:professional|software|industry|work|total)\s+experience/i,
    /(\d+)\s*\+?\s*years?\s+(?:professional|software|industry|work|total)\s+experience/i,
    /over\s+(\d+)\s*years?\s+of\s+experience/i,
    /(\d+)\s*years?\s+of\s+(?:relevant\s+)?experience/i,
    /(\d+)\s*years?\s+experience\s+(?:in|with|as)/i,
  ];
  for (const re of patterns) {
    const m = str.match(re);
    if (m) {
      const n = parseInt(m[1]);
      if (n >= 1 && n <= 40) return n; // sanity range
    }
  }
  return null;
}

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
  const yearsExperience = extractUserYearsExperience(text);
  return {
    titles,
    skills,
    keywords,
    searchTerms,
    yearsExperience,
    sourceHash: crypto.createHash("sha256").update(text).digest("hex"),
  };
}

function parseJsonArray(value) {
  try { return JSON.parse(value || "[]"); } catch { return []; }
}

function resolveScope(scopeOrUserId, maybeRoleTitles = []) {
  if (scopeOrUserId && typeof scopeOrUserId === "object") {
    return {
      userId: scopeOrUserId.userId,
      profileId: scopeOrUserId.profileId ?? null,
      roleTitles: Array.isArray(scopeOrUserId.roleTitles) ? scopeOrUserId.roleTitles : [],
      seedLegacy: scopeOrUserId.seedLegacy !== false,
    };
  }
  return {
    userId: scopeOrUserId,
    profileId: null,
    roleTitles: Array.isArray(maybeRoleTitles) ? maybeRoleTitles : [],
    seedLegacy: true,
  };
}

function shouldSeedLegacyProfile(db, userId, profileId) {
  if (!userId || !profileId) return false;
  const hasScopedResume = db.prepare(`
    SELECT 1
    FROM profile_base_resumes pbr
    JOIN domain_profiles dp ON dp.id = pbr.profile_id
    WHERE dp.user_id = ?
    LIMIT 1
  `).get(userId);
  if (hasScopedResume) return false;
  const profile = db.prepare(`
    SELECT is_active
    FROM domain_profiles
    WHERE id = ? AND user_id = ?
  `).get(profileId, userId);
  return !!profile?.is_active;
}

function seedScopedProfileFromLegacy(db, userId, profileId, roleTitles = []) {
  if (!shouldSeedLegacyProfile(db, userId, profileId)) return;
  const legacyResume = db.prepare(`
    SELECT name, content, enhanced_content, enhanced_at, enhanced_ats_delta, updated_at
    FROM base_resume
    WHERE user_id = ?
  `).get(userId);
  if (String(legacyResume?.content || "").trim()) {
    db.prepare(`
      INSERT INTO profile_base_resumes
        (profile_id, user_id, name, content, enhanced_content, enhanced_at, enhanced_ats_delta, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, unixepoch()))
      ON CONFLICT(profile_id) DO UPDATE SET
        user_id = excluded.user_id,
        name = excluded.name,
        content = excluded.content,
        enhanced_content = excluded.enhanced_content,
        enhanced_at = excluded.enhanced_at,
        enhanced_ats_delta = excluded.enhanced_ats_delta,
        updated_at = excluded.updated_at
    `).run(
      profileId,
      userId,
      legacyResume.name || "resume.txt",
      legacyResume.content,
      legacyResume.enhanced_content ?? null,
      legacyResume.enhanced_at ?? null,
      legacyResume.enhanced_ats_delta ?? null,
      legacyResume.updated_at ?? null,
    );
  }

  const legacySignals = db.prepare(`
    SELECT *
    FROM simple_apply_profiles
    WHERE user_id = ?
  `).get(userId);
  if (legacySignals) {
    db.prepare(`
      INSERT INTO profile_simple_apply_profiles
        (profile_id, user_id, titles_json, keywords_json, skills_json, search_terms_json, source_hash, years_experience, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, unixepoch()))
      ON CONFLICT(profile_id) DO UPDATE SET
        user_id = excluded.user_id,
        titles_json = excluded.titles_json,
        keywords_json = excluded.keywords_json,
        skills_json = excluded.skills_json,
        search_terms_json = excluded.search_terms_json,
        source_hash = excluded.source_hash,
        years_experience = excluded.years_experience,
        updated_at = excluded.updated_at
    `).run(
      profileId,
      userId,
      legacySignals.titles_json || JSON.stringify(roleTitles || []),
      legacySignals.keywords_json || "[]",
      legacySignals.skills_json || "[]",
      legacySignals.search_terms_json || "[]",
      legacySignals.source_hash ?? null,
      legacySignals.years_experience ?? null,
      legacySignals.updated_at ?? null,
    );
  }
}

export function getBaseResumeRecord(db, scopeOrUserId) {
  const { userId, profileId, seedLegacy } = resolveScope(scopeOrUserId);
  if (profileId) {
    if (seedLegacy) seedScopedProfileFromLegacy(db, userId, profileId);
    return db.prepare(`
      SELECT name, content, enhanced_content, enhanced_at, enhanced_ats_delta, updated_at
      FROM profile_base_resumes
      WHERE profile_id = ? AND user_id = ?
    `).get(profileId, userId) || null;
  }
  return db.prepare(`
    SELECT name, content, enhanced_content, enhanced_at, enhanced_ats_delta, updated_at
    FROM base_resume
    WHERE user_id = ?
  `).get(userId) || null;
}

export function saveBaseResumeRecord(db, scopeOrUserId, content, name = "resume.txt") {
  const { userId, profileId } = resolveScope(scopeOrUserId);
  if (profileId) {
    db.prepare(`
      INSERT INTO profile_base_resumes (profile_id, user_id, content, name, updated_at)
      VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(profile_id) DO UPDATE SET
        user_id = excluded.user_id,
        content = excluded.content,
        name = excluded.name,
        updated_at = excluded.updated_at
    `).run(profileId, userId, content, name);
    return;
  }
  db.prepare(`
    INSERT INTO base_resume (user_id, content, name, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET
      content = excluded.content,
      name = excluded.name,
      updated_at = excluded.updated_at
  `).run(userId, content, name);
}

export function profileHasBaseResume(db, scopeOrUserId) {
  const row = getBaseResumeRecord(db, scopeOrUserId);
  return !!String(row?.content || "").trim();
}

export function upsertSimpleApplyProfile(db, scopeOrUserId, resumeText, roleTitles = []) {
  const scope = resolveScope(scopeOrUserId, roleTitles);
  const profile = deriveSimpleApplyProfile(resumeText, roleTitles);
  if (scope.profileId) {
    db.prepare(`
      INSERT INTO profile_simple_apply_profiles
        (profile_id, user_id, titles_json, keywords_json, skills_json, search_terms_json, source_hash, years_experience, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(profile_id) DO UPDATE SET
        user_id=excluded.user_id,
        titles_json=excluded.titles_json,
        keywords_json=excluded.keywords_json,
        skills_json=excluded.skills_json,
        search_terms_json=excluded.search_terms_json,
        source_hash=excluded.source_hash,
        years_experience=excluded.years_experience,
        updated_at=excluded.updated_at
    `).run(
      scope.profileId,
      scope.userId,
      JSON.stringify(profile.titles),
      JSON.stringify(profile.keywords),
      JSON.stringify(profile.skills),
      JSON.stringify(profile.searchTerms),
      profile.sourceHash,
      profile.yearsExperience ?? null,
    );
    return profile;
  }
  db.prepare(`
    INSERT INTO simple_apply_profiles
      (user_id, titles_json, keywords_json, skills_json, search_terms_json, source_hash, years_experience, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET
      titles_json=excluded.titles_json,
      keywords_json=excluded.keywords_json,
      skills_json=excluded.skills_json,
      search_terms_json=excluded.search_terms_json,
      source_hash=excluded.source_hash,
      years_experience=excluded.years_experience,
      updated_at=excluded.updated_at
  `).run(
    scope.userId,
    JSON.stringify(profile.titles),
    JSON.stringify(profile.keywords),
    JSON.stringify(profile.skills),
    JSON.stringify(profile.searchTerms),
    profile.sourceHash,
    profile.yearsExperience ?? null,
  );
  return profile;
}

export function loadSimpleApplyProfile(db, scopeOrUserId) {
  const scope = resolveScope(scopeOrUserId);
  if (scope.profileId && scope.seedLegacy) {
    seedScopedProfileFromLegacy(db, scope.userId, scope.profileId);
  }
  const row = scope.profileId
    ? db.prepare(`
        SELECT * FROM profile_simple_apply_profiles
        WHERE profile_id = ? AND user_id = ?
      `).get(scope.profileId, scope.userId)
    : db.prepare("SELECT * FROM simple_apply_profiles WHERE user_id=?").get(scope.userId);
  if (!row) return null;
  return {
    titles: parseJsonArray(row.titles_json),
    keywords: parseJsonArray(row.keywords_json),
    skills: parseJsonArray(row.skills_json),
    searchTerms: parseJsonArray(row.search_terms_json),
    yearsExperience: row.years_experience ?? null,
    sourceHash: row.source_hash,
    updatedAt: row.updated_at,
  };
}

export function loadOrCreateSimpleApplyProfile(db, scopeOrUserId, roleTitles = []) {
  const scope = resolveScope(scopeOrUserId, roleTitles);
  const base = getBaseResumeRecord(db, scope);
  const profile = loadSimpleApplyProfile(db, scope);
  if (!base?.content) return profile;
  const sourceHash = crypto.createHash("sha256").update(String(base.content || "")).digest("hex");
  if (profile?.sourceHash === sourceHash) return profile;
  return upsertSimpleApplyProfile(db, scope, base.content, scope.roleTitles);
}

export function buildAtsResumeBasis(resumeText, signalProfile = null) {
  const signals = signalProfile
    ? [
        signalProfile.titles?.length ? `Likely titles: ${signalProfile.titles.join(", ")}` : "",
        signalProfile.skills?.length ? `Skills/tools: ${signalProfile.skills.join(", ")}` : "",
        signalProfile.keywords?.length ? `Keywords: ${signalProfile.keywords.slice(0, 18).join(", ")}` : "",
      ].filter(Boolean).join("\n")
    : "";
  const yoeLine = signalProfile?.yearsExperience != null
    ? `Years of experience: ${signalProfile.yearsExperience}`
    : "";
  const fullSignals = [signals, yoeLine].filter(Boolean).join("\n");
  return fullSignals
    ? `STORED USER SIGNALS:\n${fullSignals}\n\nBASE RESUME TEXT:\n${resumeText || ""}`
    : String(resumeText || "");
}
