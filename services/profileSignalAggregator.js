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

/**
 * The statuses that mean THE CANDIDATE SAID SO (AG2).
 *
 * 'inactive' and 'selected' are emphatically not here. 'inactive' is the system having noticed a
 * term in job descriptions — nobody has claimed anything — and treating it as a claim is how the
 * panel came to show auto-ingested terms as already-added, locked green chips the user never
 * chose. The system may suggest; only the user may claim.
 */
export const CLAIM_STATUSES = new Set(["claimed", "applied"]);

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
    // AG2. Deliberately NOT filtered by `promotable`: that threshold decides whether the system is
    // confident enough to SUGGEST a term (it wants to have seen it in two postings). A term the
    // candidate has claimed is not a suggestion any more — it is something they said about
    // themselves, and hiding it because only one job asked for it would lose their answer.
    //
    // 'applied' is included because it is also a claim: it is a term the user clicked on an ATS
    // chip under the old one-way flow, which was them asserting it just the same.
    claimedSkills: promoted.filter(item => item.kind === "skill" && CLAIM_STATUSES.has(item.status)),
    claimedActionVerbs: promoted.filter(item => item.kind === "action_verb" && CLAIM_STATUSES.has(item.status)),
  };
}

/**
 * A CLAIM (AG2) — the candidate asserting that a suggested term is true of them.
 *
 * WHY A NEW STATUS AND NOT 'selected' OR 'applied'
 * The three statuses already here mean other things, and reusing one would have made opting in do
 * something the user did not ask for:
 *   'inactive' — the system noticed this term in job descriptions. Nobody has said anything.
 *   'selected' — queued for the base-resume ENHANCEMENT flow, which rewrites
 *                profile_base_resumes.content. Opting in must never rewrite the source of truth.
 *   'applied'  — already written into domain_profiles.selected_tools/selected_verbs.
 * 'claimed' is the candidate's own assertion, and it is REVERSIBLE. status is a plain TEXT column
 * with no CHECK constraint, so this needs no migration.
 *
 * WHY IT DOES NOT WRITE domain_profiles
 * buildRuntimeAtsBasis folds selected_tools/selected_keywords straight into the text the ATS report
 * scores the resume against. Writing a claim there would mean ticking a box raised your own score
 * with no resume evidence behind it — which is exactly the "add this to improve your score"
 * incentive this feature must not create. A claim informs GENERATION; it never scores itself.
 *
 * @returns the same shape listProfileSignalSuggestions returns, so callers refresh in one round trip.
 */
export function setProfileSignalClaim(db, { userId, profileId, kind = "skill", label, claimed = true }) {
  const allowedKind = kind === "action_verb" ? "action_verb" : "skill";
  const nextLabel = cleanProfileSignalLabel(label);
  const nextKey = profileSignalKey(nextLabel);
  if (!nextLabel || !nextKey) return listProfileSignalSuggestions(db, { userId, profileId });

  if (claimed) {
    // Created on claim if absent: the term may have come straight off the report for a job the
    // scrape-time aggregator never saw, and a claim the user made must be recorded either way.
    db.prepare(`
      INSERT INTO profile_signal_suggestions
        (profile_id, user_id, signal_key, signal_label, signal_kind, structured_field, frequency, status, first_seen_at, last_seen_at, selected_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, 'claimed', unixepoch(), unixepoch(), unixepoch())
      ON CONFLICT(profile_id, signal_key) DO UPDATE SET
        signal_label = excluded.signal_label,
        signal_kind = excluded.signal_kind,
        status = 'claimed',
        selected_at = COALESCE(profile_signal_suggestions.selected_at, excluded.selected_at),
        last_seen_at = excluded.last_seen_at,
        updated_at = unixepoch()
    `).run(profileId, userId, nextKey, nextLabel, allowedKind, ATS_SIGNAL_PROMOTION_THRESHOLD);
  } else {
    // Withdrawn, not deleted. The row goes back to being a suggestion the system has seen, which is
    // what it was before the user touched it — and the frequency history is not the user's to lose.
    //
    // Only a 'claimed' row is withdrawable. An 'applied' one also lives in
    // domain_profiles.selected_tools, and silently un-claiming it here would leave the two stores
    // disagreeing; that legacy path has never had a remove and this is not the place to add one.
    db.prepare(`
      UPDATE profile_signal_suggestions
      SET status = 'inactive', selected_at = NULL, updated_at = unixepoch()
      WHERE user_id = ? AND profile_id = ? AND signal_key = ? AND status = 'claimed'
    `).run(userId, profileId, nextKey);
  }
  console.log(`[profile-claims] ${claimed ? "claimed" : "withdrew"} ${allowedKind} "${nextLabel}" on profile ${profileId} for user ${userId}`);
  return listProfileSignalSuggestions(db, { userId, profileId });
}

/**
 * Every term the candidate has claimed on a profile, for injection into generation.
 * Ordered so the same profile always produces the same prompt.
 */
export function listProfileClaims(db, { userId, profileId }) {
  const rows = db.prepare(`
    SELECT signal_label, signal_kind
    FROM profile_signal_suggestions
    WHERE user_id = ? AND profile_id = ? AND status IN ('claimed', 'applied')
    ORDER BY signal_kind ASC, signal_label COLLATE NOCASE ASC
  `).all(userId, profileId);
  return {
    skills: rows.filter(r => r.signal_kind === "skill").map(r => r.signal_label),
    actionVerbs: rows.filter(r => r.signal_kind === "action_verb").map(r => r.signal_label),
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
  const targetColumn = kind === "action_verb" ? "selected_verbs" : "selected_tools";
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
  const nextValues = [...activeValues, nextLabel];
  const applySuggestion = db.prepare(`
    INSERT INTO profile_signal_suggestions
      (profile_id, user_id, signal_key, signal_label, signal_kind, structured_field, frequency, status, first_seen_at, last_seen_at, selected_at, applied_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, 'applied', unixepoch(), unixepoch(), NULL, unixepoch())
    ON CONFLICT(profile_id, signal_key) DO UPDATE SET
      signal_label = excluded.signal_label,
      signal_kind = excluded.signal_kind,
      frequency = MAX(profile_signal_suggestions.frequency, excluded.frequency),
      status = 'applied',
      last_seen_at = excluded.last_seen_at,
      applied_at = COALESCE(profile_signal_suggestions.applied_at, excluded.applied_at),
      updated_at = unixepoch()
  `);
  const updateProfile = db.prepare(`
    UPDATE domain_profiles
    SET ${targetColumn} = ?, updated_at = unixepoch()
    WHERE id = ? AND user_id = ?
  `);
  const tx = db.transaction(() => {
    updateProfile.run(JSON.stringify(nextValues), profileId, userId);
    applySuggestion.run(
      profileId,
      userId,
      nextKey,
      nextLabel,
      kind,
      ATS_SIGNAL_PROMOTION_THRESHOLD,
    );
  });
  tx();
  console.log(`[profile-suggestions] applied ${kind} "${nextLabel}" to profile ${profileId} (${targetColumn}) for user ${userId}`);
  return listProfileSignalSuggestions(db, { userId, profileId });
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

/**
 * Reconcile which skills are queued for the base-resume ENHANCEMENT rewrite.
 *
 * IT OWNS TWO STATUSES AND ONLY TWO. 'selected' means queued; 'inactive' means not. Everything else
 * a row can be is an assertion the candidate made, and this control has no business moving it:
 *
 *   'applied'  — already written into domain_profiles.selected_tools. Downgrading it here left the
 *                two stores disagreeing, with a fossil applied_at on a row claiming to be inactive.
 *   'claimed'  — the candidate said "this is true of me" on an ATS report (AG2).
 *
 * This used to reconcile EVERY skill row to selected-or-inactive, so unticking one box in
 * "Selected For Enhancement" silently downgraded every applied skill AND withdrew every claim on
 * the profile. The claim case was the worse of the two and the newer: AG2 added a status this
 * function did not know about, and a two-state reconciliation over a four-state column quietly
 * destroys the states it has never heard of. Restricting it in SQL rather than in the loop is
 * deliberate — it can only see the rows it is allowed to change.
 */
const ENHANCEMENT_QUEUE_STATUSES = ["selected", "inactive"];

export function syncSelectedSkillSuggestions(db, { userId, profileId, selectedKeys = [] }) {
  const wanted = new Set((Array.isArray(selectedKeys) ? selectedKeys : []).map(profileSignalKey));
  const rows = db.prepare(`
    SELECT signal_key, status
    FROM profile_signal_suggestions
    WHERE user_id = ? AND profile_id = ? AND signal_kind = 'skill'
      AND status IN (${ENHANCEMENT_QUEUE_STATUSES.map(() => "?").join(", ")})
  `).all(userId, profileId, ...ENHANCEMENT_QUEUE_STATUSES);
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

/**
 * Move the skills an enhancement actually used from 'selected' to 'applied'.
 *
 * `selectedLabels` are LABELS, straight out of profile_resume_enhancements.selected_skills_json,
 * which stores what buildSelectedEnhancementSkills returned. profileSignalKey cleans its input on
 * the way through, so it is the whole derivation — the same one that wrote signal_key in the first
 * place.
 *
 * This called an undefined `signalKey` until 2026-08-25 and threw a ReferenceError. It survived
 * because the only caller passes an empty array when nothing is selected, and `.map` never runs its
 * callback on an empty array — so it was silent right up to the moment someone used the feature.
 * By then POST /adopt had already overwritten profile_base_resumes.content, so the throw landed
 * mid-route: the base resume was replaced, the suggestions were not marked, and the caller got a
 * 500 for an operation that had partly happened.
 */
export function markSelectedSuggestionsApplied(db, { userId, profileId, selectedLabels = [] }) {
  const wanted = new Set(
    (Array.isArray(selectedLabels) ? selectedLabels : [selectedLabels])
      .map(label => profileSignalKey(label))
      .filter(Boolean),
  );
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
