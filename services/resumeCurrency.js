/**
 * IS A STORED RESUME ARTIFACT STILL THE RIGHT ONE? (AH5)
 *
 * WHY THIS IS ITS OWN MODULE
 * Two places decide whether to reuse a generated resume: processRunJob's CASE A in routes/apply.js,
 * and generateResumeForApply in server.js. Both already reused — that instinct is correct, because
 * regenerating a resume the candidate has already produced costs a model call and minutes of their
 * time. What neither had was a definition of when a stored artifact STOPS being the right one, and
 * they each ran their own `SELECT ... FROM resumes` to decide. Two queries, no rule.
 *
 * So both reused an artifact built under a different job profile, or from a base resume that had
 * since been rewritten, and nothing anywhere said so. That is the more expensive failure: a
 * regeneration wastes a minute, a silently stale resume is sent to an employer.
 *
 * THE RULE, and it is the whole rule:
 *   same user, same job   `resumes` is UNIQUE(user_id, job_id), so this is the row's identity and
 *                         there is never more than one candidate to choose between.
 *   same tool             a Generate artifact is not an A+ Resume artifact. apply_mode records
 *                         which one, through the caller's legacyModeForTool.
 *   same profile          resumes.domain_profile_id (migration 091) against the ACTIVE profile.
 *   after the last base-resume change
 *                         resumes.updated_at >= profile_base_resumes.updated_at for the active
 *                         profile. Editing the base resume is the candidate saying "this is who I
 *                         am now"; an artifact built before that no longer reflects it.
 *
 * NULL domain_profile_id is an artifact written before 091 existed. It is treated as usable rather
 * than stale — the alternative is regenerating every artifact in the database on the next queue,
 * which is a real cost imposed to fix a record-keeping gap — and it is reported as its own reason
 * so the fill log can say "reused, though we cannot tell which profile built it" rather than
 * claiming a match it did not verify.
 *
 * EVERY RETURN CARRIES A REASON. That is not decoration: the reason is what the run logs and what
 * the fill log shows, so "we reused what you generated" and "we rebuilt it because your base resume
 * changed" are both stated out loud instead of left for the candidate to infer from a timestamp.
 */

/** The apply_mode string an artifact for `tool` is stored under. */
export function modeForTool(tool) {
  return tool === "a_plus_resume" ? "CUSTOM_SAMPLER" : "TAILORED";
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ userId: number, jobId: string|number, tool?: string }} args
 * @returns {{ current: boolean, reason: string, detail?: string, artifact: object|null }}
 */
export function artifactCurrency(db, { userId, jobId, tool = "generate" } = {}) {
  const mode = modeForTool(tool);
  let row = null;
  try {
    row = db.prepare(
      `SELECT id, ats_score, html, apply_mode, domain_profile_id, updated_at
       FROM resumes WHERE user_id=? AND job_id=?`
    ).get(userId, String(jobId));
  } catch {
    // An un-migrated deployment has no domain_profile_id column. Fall back to the columns that
    // have always existed rather than failing the run: the currency check is an optimisation and a
    // safety net, and neither is worth refusing to apply over.
    try {
      row = db.prepare(
        `SELECT id, ats_score, html, apply_mode, updated_at FROM resumes WHERE user_id=? AND job_id=?`
      ).get(userId, String(jobId));
      if (row) row.domain_profile_id = null;
    } catch { row = null; }
  }
  if (!row?.html) return { current: false, reason: "no_artifact", artifact: null };

  if (row.apply_mode && row.apply_mode !== mode) {
    return {
      current: false, reason: "different_tool", artifact: row,
      detail: `stored artifact is ${row.apply_mode}; this run wants ${mode}`,
    };
  }

  const activeProfile = (() => {
    try { return db.prepare("SELECT id FROM domain_profiles WHERE user_id=? AND is_active=1").get(userId); }
    catch { return null; }
  })();

  if (row.domain_profile_id != null && activeProfile?.id != null
      && Number(row.domain_profile_id) !== Number(activeProfile.id)) {
    return {
      current: false, reason: "different_profile", artifact: row,
      detail: `built for job profile ${row.domain_profile_id}; the active profile is ${activeProfile.id}`,
    };
  }

  if (activeProfile?.id != null) {
    const base = (() => {
      try {
        return db.prepare("SELECT updated_at FROM profile_base_resumes WHERE profile_id=? AND user_id=?")
          .get(activeProfile.id, userId);
      } catch { return null; }
    })();
    if (base?.updated_at != null && row.updated_at != null && Number(row.updated_at) < Number(base.updated_at)) {
      return {
        current: false, reason: "base_resume_changed", artifact: row,
        detail: "your base resume was edited after this resume was generated",
      };
    }
  }

  return {
    current: true,
    reason: row.domain_profile_id == null ? "reused_unknown_profile" : "reused",
    artifact: row,
  };
}

/** One sentence a human can read, for the run log and the fill log. */
export function currencySentence({ current, reason, detail } = {}) {
  if (current) {
    return reason === "reused_unknown_profile"
      ? "Reused the resume already generated for this job (its job profile was not recorded)."
      : "Reused the resume already generated for this job — nothing was regenerated.";
  }
  switch (reason) {
    case "no_artifact":         return "No resume existed for this job yet, so one was generated.";
    case "different_tool":      return `Regenerated: ${detail}.`;
    case "different_profile":   return `Regenerated: ${detail}.`;
    case "base_resume_changed": return `Regenerated: ${detail}.`;
    default:                    return "Regenerated.";
  }
}
