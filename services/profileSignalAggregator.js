import {
  cleanProfileSignalLabel,
  profileSignalKey,
} from "../shared/profileSignals.js";

function parseJsonArray(value) {
  try { return JSON.parse(value || "[]"); } catch { return []; }
}

const NOISE_TERMS = new Set([
  "experience",
  "communication",
  "leadership",
  "team player",
  "detail oriented",
  "problem solving",
  "collaboration",
  "stakeholder management",
]);

const STRUCTURED_FACT_PATTERNS = [
  { pattern: /\bu\.?s\.?\s+citizen(ship)?\b/i, field: "citizenshipStatus", label: "U.S. citizenship" },
  { pattern: /\bwork authorization\b/i, field: "workAuthorization", label: "Work authorization" },
  { pattern: /\bauthorized to work\b/i, field: "workAuthorization", label: "Authorized to work" },
  { pattern: /\bsponsorship\b/i, field: "requiresSponsorship", label: "Requires sponsorship" },
  { pattern: /\bsecurity clearance\b/i, field: "hasClearance", label: "Security clearance" },
  { pattern: /\bpublic trust\b/i, field: "clearanceLevel", label: "Public Trust clearance" },
  { pattern: /\bsecret\b/i, field: "clearanceLevel", label: "Secret clearance" },
  { pattern: /\btop secret\b/i, field: "clearanceLevel", label: "Top Secret clearance" },
  { pattern: /\bts\/sci\b/i, field: "clearanceLevel", label: "TS/SCI clearance" },
  { pattern: /\bpoly(graph)?\b/i, field: "clearanceLevel", label: "Polygraph clearance" },
  { pattern: /\bbachelor'?s?\b|\bbs\b|\bba\b/i, field: "degreeLevel", label: "Bachelor's degree" },
  { pattern: /\bmaster'?s?\b|\bms\b|\bma\b|\bmba\b/i, field: "degreeLevel", label: "Master's degree" },
  { pattern: /\bph\.?d\b|\bdoctorate\b/i, field: "degreeLevel", label: "Doctorate" },
];

export const ENHANCEMENT_SELECTED_THRESHOLD = 5;
export const ENHANCEMENT_SELECTED_CAP = 8;
export const ATS_SIGNAL_PROMOTION_THRESHOLD = 2;

export function classifyMissingSignal(rawValue) {
  const label = cleanProfileSignalLabel(rawValue);
  if (!label) return null;
  for (const entry of STRUCTURED_FACT_PATTERNS) {
    if (entry.pattern.test(label)) {
      return {
        kind: "structured_fact",
        field: entry.field,
        label: entry.label,
        key: profileSignalKey(`${entry.field}:${entry.label}`),
      };
    }
  }
  if (NOISE_TERMS.has(label.toLowerCase())) return null;
  if (label.length < 2 || label.length > 50) return null;
  if (!/[a-z]/i.test(label)) return null;
  return {
    kind: "skill",
    label,
    key: profileSignalKey(label),
  };
}

export function extractMissingSignals(report = {}) {
  const deduped = new Map();
  (Array.isArray(report?.tier1_missing) ? report.tier1_missing : []).forEach(value => {
    const classified = classifyMissingSignal(value);
    if (!classified) return;
    const key = `${classified.kind}:${classified.key}`;
    if (!deduped.has(key)) deduped.set(key, classified);
  });
  (Array.isArray(report?.action_verbs_missing) ? report.action_verbs_missing : []).forEach(value => {
    const label = cleanProfileSignalLabel(value);
    if (!label || label.length > 40 || NOISE_TERMS.has(label.toLowerCase())) return;
    const classified = { kind: "action_verb", label, key: profileSignalKey(label) };
    const key = `${classified.kind}:${classified.key}`;
    if (!deduped.has(key)) deduped.set(key, classified);
  });
  return [...deduped.values()];
}

function promoteSignalRow(row) {
  const promotable = Number(row.frequency || 0) >= ATS_SIGNAL_PROMOTION_THRESHOLD;
  return {
    key: row.signal_key,
    label: row.signal_label,
    kind: row.signal_kind,
    field: row.structured_field || null,
    status: row.status || "inactive",
    frequency: Number(row.frequency || 0),
    firstSeenAt: row.first_seen_at || null,
    lastSeenAt: row.last_seen_at || null,
    promotable,
  };
}

export function listProfileSignalSuggestions(db, { userId, profileId }) {
  const rows = db.prepare(`
    SELECT signal_key, signal_label, signal_kind, structured_field, status, frequency, first_seen_at, last_seen_at
    FROM profile_signal_suggestions
    WHERE user_id = ? AND profile_id = ?
    ORDER BY frequency DESC, last_seen_at DESC, signal_label COLLATE NOCASE ASC
  `).all(userId, profileId);
  const promoted = rows.map(promoteSignalRow);
  return {
    inactiveSkills: promoted.filter(item => item.kind === "skill" && item.status === "inactive" && item.promotable),
    selectedSkills: promoted.filter(item => item.kind === "skill" && item.status === "selected" && item.promotable),
    appliedSkills: promoted.filter(item => item.kind === "skill" && item.status === "applied"),
    inactiveActionVerbs: promoted.filter(item => item.kind === "action_verb" && item.status === "inactive" && item.promotable),
    selectedActionVerbs: promoted.filter(item => item.kind === "action_verb" && item.status === "selected" && item.promotable),
    appliedActionVerbs: promoted.filter(item => item.kind === "action_verb" && item.status === "applied"),
    structuredFacts: promoted.filter(item => item.kind === "structured_fact" && item.promotable),
  };
}

export function addProfileSignalSuggestions(db, { userId, profileId, kind = "skill", labels = [] }) {
  const allowedKind = kind === "action_verb" ? "action_verb" : "skill";
  const items = (Array.isArray(labels) ? labels : [labels])
    .map(label => cleanProfileSignalLabel(label))
    .filter(Boolean)
    .slice(0, 20);
  if (!items.length) return listProfileSignalSuggestions(db, { userId, profileId });
  const upsert = db.prepare(`
    INSERT INTO profile_signal_suggestions
      (profile_id, user_id, signal_key, signal_label, signal_kind, structured_field, frequency, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, 'inactive', unixepoch(), unixepoch())
    ON CONFLICT(profile_id, signal_key) DO UPDATE SET
      signal_label = excluded.signal_label,
      signal_kind = excluded.signal_kind,
      frequency = MAX(profile_signal_suggestions.frequency, excluded.frequency),
      last_seen_at = excluded.last_seen_at,
      updated_at = unixepoch()
  `);
  const tx = db.transaction(() => {
    items.forEach(label => upsert.run(profileId, userId, profileSignalKey(label), label, allowedKind, ATS_SIGNAL_PROMOTION_THRESHOLD));
  });
  tx();
  return listProfileSignalSuggestions(db, { userId, profileId });
}

function addNormalizedProfileSuggestion(db, { userId, profileId, kind, label }) {
  const nextLabel = cleanProfileSignalLabel(label);
  const nextKey = profileSignalKey(nextLabel);
  if (!nextLabel || !nextKey) {
    return listProfileSignalSuggestions(db, { userId, profileId });
  }
  const profile = db.prepare(`
    SELECT selected_tools, selected_verbs
    FROM domain_profiles
    WHERE id = ? AND user_id = ?
  `).get(profileId, userId);
  const activeValues = kind === "action_verb"
    ? parseJsonArray(profile?.selected_verbs || "[]")
    : parseJsonArray(profile?.selected_tools || "[]");
  if (activeValues.some(value => profileSignalKey(value) === nextKey)) {
    return listProfileSignalSuggestions(db, { userId, profileId });
  }
  const existing = db.prepare(`
    SELECT signal_key
    FROM profile_signal_suggestions
    WHERE user_id = ? AND profile_id = ? AND signal_kind = ?
  `).all(userId, profileId, kind);
  if (existing.some(row => row.signal_key === nextKey)) {
    return listProfileSignalSuggestions(db, { userId, profileId });
  }
  return addProfileSignalSuggestions(db, {
    userId,
    profileId,
    kind,
    labels: [nextLabel],
  });
}

export function addSkillToProfile(db, { userId, profileId, label }) {
  return addNormalizedProfileSuggestion(db, {
    userId,
    profileId,
    kind: "skill",
    label,
  });
}

export function addVerbToProfile(db, { userId, profileId, label }) {
  return addNormalizedProfileSuggestion(db, {
    userId,
    profileId,
    kind: "action_verb",
    label,
  });
}

export function syncSelectedSkillSuggestions(db, { userId, profileId, selectedKeys = [] }) {
  const wanted = new Set((Array.isArray(selectedKeys) ? selectedKeys : []).map(profileSignalKey));
  const rows = db.prepare(`
    SELECT signal_key, status
    FROM profile_signal_suggestions
    WHERE user_id = ? AND profile_id = ? AND signal_kind = 'skill'
  `).all(userId, profileId);
  const update = db.prepare(`
    UPDATE profile_signal_suggestions
    SET status = ?, selected_at = CASE WHEN ? = 'selected' THEN unixepoch() ELSE NULL END
    WHERE user_id = ? AND profile_id = ? AND signal_key = ?
  `);
  const tx = db.transaction(() => {
    rows.forEach(row => {
      const nextStatus = wanted.has(row.signal_key) ? "selected" : "inactive";
      if ((row.status || "inactive") !== nextStatus) {
        update.run(nextStatus, nextStatus, userId, profileId, row.signal_key);
      }
    });
  });
  tx();
  return listProfileSignalSuggestions(db, { userId, profileId });
}

export function aggregateAtsMissingSignals(db, { userId, profileId, report }) {
  const signals = extractMissingSignals(report);
  if (!signals.length) return { inserted: 0, eligibleNow: false, promotedCount: 0 };

  const before = computeEnhancementStatus(db, { userId, profileId });
  const upsert = db.prepare(`
    INSERT INTO profile_signal_suggestions
      (profile_id, user_id, signal_key, signal_label, signal_kind, structured_field, frequency, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'inactive', unixepoch(), unixepoch())
    ON CONFLICT(profile_id, signal_key) DO UPDATE SET
      signal_label = excluded.signal_label,
      signal_kind = excluded.signal_kind,
      structured_field = COALESCE(excluded.structured_field, profile_signal_suggestions.structured_field),
      frequency = profile_signal_suggestions.frequency + 1,
      last_seen_at = excluded.last_seen_at,
      updated_at = unixepoch()
  `);
  const tx = db.transaction(() => {
    signals.forEach(signal => {
      upsert.run(
        profileId,
        userId,
        signal.key,
        signal.label,
        signal.kind,
        signal.field || null,
      );
    });
  });
  tx();

  const after = computeEnhancementStatus(db, { userId, profileId });
  return {
    inserted: signals.length,
    eligibleNow: !before.eligible && after.eligible,
    promotedCount: after.suggestedSkillCount,
    structuredFactCount: after.structuredFactCount,
  };
}

export function computeEnhancementStatus(db, { userId, profileId }) {
  const baseResume = db.prepare(`
    SELECT content, enhanced_content, enhanced_at, enhanced_ats_delta
    FROM profile_base_resumes
    WHERE user_id = ? AND profile_id = ?
  `).get(userId, profileId);
  const suggestions = listProfileSignalSuggestions(db, { userId, profileId });
  const latest = db.prepare(`
    SELECT id, ats_delta, selected_skills_json, created_at, adopted_at
    FROM profile_resume_enhancements
    WHERE user_id = ? AND profile_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId, profileId);
  const selectedCount = suggestions.selectedSkills.length;
  const eligible = !!String(baseResume?.content || "").trim() && selectedCount >= ENHANCEMENT_SELECTED_THRESHOLD;
  return {
    profileId,
    eligible,
    selectedCount,
    threshold: ENHANCEMENT_SELECTED_THRESHOLD,
    suggestedSkillCount: suggestions.inactiveSkills.length,
    structuredFactCount: suggestions.structuredFacts.length,
    hasEnhancedDraft: !!String(baseResume?.enhanced_content || "").trim(),
    enhancedAt: baseResume?.enhanced_at || null,
    enhancedAtsDelta: baseResume?.enhanced_ats_delta ?? null,
    latestEnhancement: latest ? {
      id: latest.id,
      atsDelta: latest.ats_delta ?? null,
      selectedSkills: parseJsonArray(latest.selected_skills_json),
      createdAt: latest.created_at || null,
      adoptedAt: latest.adopted_at || null,
    } : null,
  };
}

export function buildSelectedEnhancementSkills(db, { userId, profileId, limit = ENHANCEMENT_SELECTED_CAP }) {
  return db.prepare(`
    SELECT signal_label, frequency
    FROM profile_signal_suggestions
    WHERE user_id = ? AND profile_id = ? AND signal_kind = 'skill' AND status = 'selected'
    ORDER BY frequency DESC, last_seen_at DESC, signal_label COLLATE NOCASE ASC
    LIMIT ?
  `).all(userId, profileId, limit).map(row => ({
    label: row.signal_label,
    frequency: Number(row.frequency || 0),
  }));
}

export function markSelectedSuggestionsApplied(db, { userId, profileId, selectedLabels = [] }) {
  const wanted = new Set((selectedLabels || []).map(label => signalKey(label)));
  const update = db.prepare(`
    UPDATE profile_signal_suggestions
    SET status = 'applied', applied_at = unixepoch(), updated_at = unixepoch()
    WHERE user_id = ? AND profile_id = ? AND signal_kind = 'skill' AND signal_key = ?
  `);
  const tx = db.transaction(() => {
    wanted.forEach(key => update.run(userId, profileId, key));
  });
  tx();
}

export function insertProfileEnhancementHistory(db, {
  userId,
  profileId,
  baseResumeContent,
  enhancedContent,
  selectedSkills = [],
  atsDelta = null,
}) {
  const row = db.prepare(`
    INSERT INTO profile_resume_enhancements
      (profile_id, user_id, base_resume_content, enhanced_content, selected_skills_json, ats_delta, created_at)
    VALUES (?, ?, ?, ?, ?, ?, unixepoch())
  `).run(
    profileId,
    userId,
    baseResumeContent,
    enhancedContent,
    JSON.stringify(selectedSkills),
    atsDelta,
  );
  return row.lastInsertRowid;
}

export function listProfileEnhancementHistory(db, { userId, profileId, limit = 8 }) {
  return db.prepare(`
    SELECT id, ats_delta, selected_skills_json, created_at, adopted_at
    FROM profile_resume_enhancements
    WHERE user_id = ? AND profile_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, profileId, limit).map(row => ({
    id: row.id,
    atsDelta: row.ats_delta ?? null,
    selectedSkills: parseJsonArray(row.selected_skills_json),
    createdAt: row.created_at || null,
    adoptedAt: row.adopted_at || null,
  }));
}
