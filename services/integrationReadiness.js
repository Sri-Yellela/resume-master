import { getBaseResumeRecord } from "./simpleApplyProfile.js";

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
    hasSession: false,
  };
}

export function getStoredIntegration(db, userId, provider) {
  return db.prepare("SELECT * FROM user_integrations WHERE user_id=? AND provider=?")
    .get(userId, provider);
}

export function getLinkedInStatus(db, userId) {
  const linkedIdentity = getStoredIntegration(db, userId, "linkedin");
  const publicLinkedIdentity = publicIntegrationRow(linkedIdentity);
  return {
    connected: publicLinkedIdentity.connected,
    healthy: publicLinkedIdentity.healthy,
    status: publicLinkedIdentity.status,
    accountEmail: publicLinkedIdentity.accountEmail || null,
    updatedAt: publicLinkedIdentity.updatedAt || null,
    lastCheckedAt: publicLinkedIdentity.lastCheckedAt || null,
    hasSession: false,
    identityLinked: publicLinkedIdentity.connected,
  };
}

export function isAdzunaConfigured() {
  return !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY);
}

export function isIndeedConfigured() {
  return !!process.env.INDEED_PUBLISHER_ID;
}

export function isLinkedInOAuthConfigured() {
  return !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);
}

export function getAutomationReadiness(db, userId) {
  const activeProfile = db.prepare("SELECT id, profile_name FROM domain_profiles WHERE user_id=? AND is_active=1").get(userId);
  const base = activeProfile
    ? getBaseResumeRecord(db, { userId, profileId: activeProfile.id })
    : null;
  const profile = db.prepare("SELECT first_name, last_name, full_name, email, phone FROM user_profile WHERE user_id=?").get(userId) || {};
  const gmail = publicIntegrationRow(getStoredIntegration(db, userId, "gmail"));
  const google = publicIntegrationRow(getStoredIntegration(db, userId, "google"));
  const linkedin = getLinkedInStatus(db, userId);
  const hasName = !!((profile.first_name && profile.last_name) || profile.full_name);
  const missingApply = [];
  if (!String(base?.content || "").trim()) missingApply.push("base_resume");
  if (!activeProfile) missingApply.push("active_profile");
  if (!profile.email) missingApply.push("profile_email");
  if (!hasName) missingApply.push("profile_name");
  return {
    adzuna: {
      connected: isAdzunaConfigured(),
      healthy: isAdzunaConfigured(),
      status: isAdzunaConfigured() ? "configured" : "missing",
      requiredFor: ["job_search"],
    },
    indeed: {
      connected: isIndeedConfigured(),
      healthy: isIndeedConfigured(),
      status: isIndeedConfigured() ? "configured" : "missing",
      requiredFor: ["job_search"],
    },
    gmail: { ...gmail, requiredFor: ["otp_retrieval", "portal_verification"] },
    google: { ...google, requiredFor: ["google_login", "portal_account_creation"] },
    linkedin: {
      ...linkedin,
      oauthConfigured: isLinkedInOAuthConfigured(),
      requiredFor: ["profile_import"],
    },
    resume: {
      connected: !!base,
      healthy: !!String(base?.content || "").trim(),
      status: String(base?.content || "").trim() ? "available" : "missing",
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
      ],
    },
  };
}

export function getMissingApplyPrerequisites(readiness) {
  return readiness?.apply?.missing || [];
}
