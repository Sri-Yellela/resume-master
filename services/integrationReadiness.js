export const INTEGRATION_PROVIDERS = new Set(["gmail", "google", "linkedin"]);

function parseJson(value, fallback) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

export function publicIntegrationRow(row) {
  if (!row) return { connected: false, healthy: false, status: "not_connected" };
  const expired = row.expires_at && row.expires_at <= Math.floor(Date.now() / 1000);
  return {
    connected: true,
    healthy: row.status === "connected" && !expired,
    status: expired ? "expired" : row.status,
    accountEmail: row.account_email || null,
    identityLinked: !!row.provider_user_id,
    scopes: parseJson(row.scopes_json, []),
    metadata: parseJson(row.metadata_json, {}),
    expiresAt: row.expires_at || null,
    lastCheckedAt: row.last_checked_at || null,
    updatedAt: row.updated_at || null,
    hasSession: !!row.secret_enc,
  };
}

export function getStoredIntegration(db, userId, provider) {
  return db.prepare("SELECT * FROM user_integrations WHERE user_id=? AND provider=?")
    .get(userId, provider);
}

export function getLinkedInStatus(db, userId) {
  const row = db.prepare("SELECT updated_at FROM user_linkedin_sessions WHERE user_id=?").get(userId);
  const linkedIdentity = getStoredIntegration(db, userId, "linkedin");
  const publicLinkedIdentity = publicIntegrationRow(linkedIdentity);
  return {
    connected: !!row || publicLinkedIdentity.connected,
    healthy: !!row || publicLinkedIdentity.healthy,
    status: row ? "connected" : publicLinkedIdentity.status,
    accountEmail: publicLinkedIdentity.accountEmail || null,
    updatedAt: row?.updated_at || publicLinkedIdentity.updatedAt || null,
    lastCheckedAt: publicLinkedIdentity.lastCheckedAt || null,
    hasSession: !!row || publicLinkedIdentity.hasSession,
    identityLinked: publicLinkedIdentity.connected,
  };
}

export function getAutomationReadiness(db, userId) {
  const user = db.prepare("SELECT apify_token FROM users WHERE id=?").get(userId) || {};
  const base = db.prepare("SELECT name, updated_at FROM base_resume WHERE user_id=? AND TRIM(content) != ''").get(userId);
  const activeProfile = db.prepare("SELECT id, profile_name FROM domain_profiles WHERE user_id=? AND is_active=1").get(userId);
  const profile = db.prepare("SELECT first_name, last_name, full_name, email, phone FROM user_profile WHERE user_id=?").get(userId) || {};
  const gmail = publicIntegrationRow(getStoredIntegration(db, userId, "gmail"));
  const google = publicIntegrationRow(getStoredIntegration(db, userId, "google"));
  const linkedin = getLinkedInStatus(db, userId);
  const hasName = !!((profile.first_name && profile.last_name) || profile.full_name);
  const missingApply = [];
  if (!base) missingApply.push("base_resume");
  if (!activeProfile) missingApply.push("active_profile");
  if (!profile.email) missingApply.push("profile_email");
  if (!hasName) missingApply.push("profile_name");
  return {
    apify: {
      connected: !!user.apify_token,
      healthy: !!user.apify_token,
      status: user.apify_token ? "configured" : "missing",
      requiredFor: ["job_search", "manual_refresh"],
    },
    gmail: { ...gmail, requiredFor: ["otp_retrieval", "portal_verification"] },
    google: { ...google, requiredFor: ["google_login", "portal_account_creation"] },
    linkedin: { ...linkedin, requiredFor: ["linkedin_search_context", "linkedin_apply_session"] },
    resume: {
      connected: !!base,
      healthy: !!base,
      status: base ? "available" : "missing",
      name: base?.name || null,
      updatedAt: base?.updated_at || null,
      requiredFor: ["apply", "ats_defaults", "search_defaults"],
    },
    profile: {
      connected: !!activeProfile,
      healthy: !!activeProfile && !!profile.email && hasName,
      status: !activeProfile ? "missing_profile" : (!profile.email || !hasName) ? "missing_autofill_fields" : "ready",
      activeProfileId: activeProfile?.id || null,
      activeProfileName: activeProfile?.profile_name || null,
      missing: [
        ...(!activeProfile ? ["active_profile"] : []),
        ...(!profile.email ? ["email"] : []),
        ...(!hasName ? ["name"] : []),
      ],
      requiredFor: ["search_grouping", "apply_autofill"],
    },
    apply: {
      ready: missingApply.length === 0,
      missing: missingApply,
      optional: [
        ...(!gmail.healthy ? ["gmail"] : []),
        ...(!google.healthy ? ["google"] : []),
        ...(!linkedin.healthy ? ["linkedin"] : []),
      ],
    },
  };
}

export function getMissingApplyPrerequisites(readiness) {
  return readiness?.apply?.missing || [];
}

export function requiresLinkedInSession(jobUrl) {
  try {
    return new URL(jobUrl).hostname.toLowerCase().includes("linkedin.com");
  } catch {
    return false;
  }
}
