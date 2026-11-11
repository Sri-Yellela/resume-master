// ⛔ draft A188 (46g, 11-11) · THE TOOLS SERVICE'S STAGING COPY NEVER ACTS AS PRODUCTION.
//
// draft's staging environment (draft docs/STAGING_PLAN.md) is a Railway DUPLICATE of production, and that copy carries this
// service's production variables too — the `tools-prod` model key, the mail key. draft's own boot guard does not run here,
// so this is the same rule for this service: with RM_ENV=staging the server REFUSES TO START (exit 1, before it listens) on
// a production credential, forces anonymous /mcp off, and marks every response noindex. Without RM_ENV=staging nothing
// here changes anything.
export const STAGING_MODEL_KEY_LABEL = "tools-staging";
export const LIVE_HOSTS = Object.freeze(["resumemaster.one", "jobsviadraft.com"]);

/** Must be BLANK on staging — each reaches a paid account or a real person. */
export const STAGING_MUST_BE_BLANK = Object.freeze(["RESEND_API_KEY", "RM_OPENAI_COMPAT_API_KEY", "ANTHROPIC_WORKSPACE_ID"]);
/** Must not name the live sites. */
export const STAGING_URL_VARS = Object.freeze(["RM_PUBLIC_URL", "RM_OPENAI_COMPAT_BASE_URL"]);
/** Forced on staging: anonymous (tokenless) /mcp off — parseAnonymousPolicy reads an unset / empty value as off. */
export const STAGING_FORCED = Object.freeze({ RM_MCP_ANONYMOUS: "" });

const blank = (v) => v == null || String(v).trim() === "";
const namesLiveHost = (v) => { const s = String(v || "").toLowerCase(); return LIVE_HOSTS.some(h => s.includes(`//${h}`) || s.includes(`.${h}`) || s === h); };

export const isStaging = (env = process.env) => String(env.RM_ENV || "").trim().toLowerCase() === "staging";

/** What staging refuses and forces — names only, never a value. */
export function checkStaging(env = process.env) {
  if (!isStaging(env)) return { staging: false, refused: [], forced: {} };
  const refused = [];
  for (const k of STAGING_MUST_BE_BLANK) if (!blank(env[k])) refused.push(`${k}: must be blank on staging`);
  for (const k of STAGING_URL_VARS) if (!blank(env[k]) && namesLiveHost(env[k])) refused.push(`${k}: names the live site`);
  if (!blank(env.ANTHROPIC_API_KEY) && String(env.ANTHROPIC_KEY_LABEL || "").trim() !== STAGING_MODEL_KEY_LABEL) {
    refused.push(`ANTHROPIC_API_KEY: its label must be "${STAGING_MODEL_KEY_LABEL}" (a capped staging key), not "${String(env.ANTHROPIC_KEY_LABEL || "").trim() || "(none)"}"`);
  }
  return { staging: true, refused, forced: { ...STAGING_FORCED } };
}

/** At boot: refuse (exit 1) or force the switches into env. */
export function applyStagingGuard(env = process.env, { exit = (code) => process.exit(code), log = console } = {}) {
  const r = checkStaging(env);
  if (!r.staging) return r;
  if (r.refused.length) {
    log.error(`[staging] ⛔ REFUSED TO START — ${r.refused.length} production setting(s) on a staging deploy:`);
    for (const line of r.refused) log.error(`[staging]   · ${line}`);
    exit(1);
    return r;
  }
  for (const [k, v] of Object.entries(r.forced)) env[k] = v;
  log.log(`[staging] RM_ENV=staging — forced off: ${Object.keys(r.forced).join(", ")}; noindex on every response`);
  return r;
}
