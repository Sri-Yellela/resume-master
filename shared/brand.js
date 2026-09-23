// ── THE SINGLE SOURCE FOR THE NAME AND THE ADDRESS ──────────────────────────────────────────────
//
// Decided in docs/BRAND.md on 2026-09-23. Derive from here; do not decide per-file. Deciding
// per-file is how two names ship, and this project has already shipped two names for one thing
// more than once (three hardcoded tab lists, half-migrated model IDs, `tool` vs `toolType`).
//
// This module is plain ESM with no imports, because BOTH sides read it: the server as
// `./shared/brand.js` and the client as `../../shared/brand.js`. Anything added here must stay
// free of node builtins or the Vite build breaks.
//
// test/brandAndOriginGuard.test.js asserts that no tracked file outside this one and an explicit,
// self-pruning allowlist contains the legacy literals. That guard was verified to FAIL by
// reintroducing a literal before it was committed — see docs/BRAND.md on why that matters here.

/** What users see. Never "Resume Master", never "Jobs via Draft" — the domain is not the name. */
export const BRAND = "Draft";

/**
 * The bare apex, with no `www`.
 *
 * ⛔ `www.jobsviadraft.com` is in DNS and points at the same Railway target, but is NOT activated:
 * the plan allows two custom domains and both slots are in use until the old domain is retired.
 * More importantly, `host_permissions` is a MATCH PATTERN — `https://jobsviadraft.com/*` does not
 * match a `www` host, so any code path that emits `www` silently breaks the extension's
 * credentialed fetch. Every host that gets hardcoded anywhere derives from these two constants.
 */
export const CANONICAL_HOST   = "jobsviadraft.com";
export const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`;

/**
 * The domain being migrated away from. STILL SERVING, and still the only origin the reviewed
 * Chrome extension knows about.
 *
 * This is a real constant rather than a comment because three kinds of code legitimately need the
 * old value while the migration is in flight, and each of them would otherwise hardcode it again:
 *
 *   1. extension/ is frozen for P4 (Web Store review in progress). Its two URL constants and its
 *      manifest still name this host, and the tests that police them must assert against THIS,
 *      not against CANONICAL_ORIGIN, or they fail the moment the app moves.
 *   2. The harness scripts that rewrite the extension's URL to point at a local server match on
 *      the literal currently in that source.
 *   3. Both origins serve identically until P4 lands.
 *
 * ⛔ Do NOT 301 the old origin while the reviewed extension still points at it. The extension's
 * `fetch` calls are credentialed and do not follow redirects, so a 301 on an /api route fails
 * silently rather than working. The redirect becomes safe only after the extension update that
 * moves host_permissions to CANONICAL_ORIGIN is LIVE in the store — not merely submitted.
 */
export const LEGACY_HOST   = "resumemaster.one";
export const LEGACY_ORIGIN = `https://${LEGACY_HOST}`;

/** The previous public name. Survives nowhere as a user-visible string; see docs/BRAND.md. */
export const LEGACY_BRAND = "Resume Master";

/**
 * Where the privacy policy lives. Served by the CLIENT BUILD (client/src/pages/marketing/
 * PrivacyPage.jsx), so changing the policy text requires a deploy, and fetching this URL returns a
 * ~2 kB SPA shell with zero policy text in it — grep the deployed bundle to verify WORDING, never
 * the response body of this URL.
 *
 * ⛔ The Chrome Web Store holds this URL in the listing and reviewers fetch it. It must be live and
 * correct on the new origin BEFORE the listing is updated to cite it (P4).
 */
export const PRIVACY_POLICY_PATH = "/privacy";
export const PRIVACY_POLICY_URL  = `${CANONICAL_ORIGIN}${PRIVACY_POLICY_PATH}`;

/**
 * ⚠ NEITHER MAILBOX IS KNOWN TO EXIST YET. Both addresses below moved with the domain because the
 * old ones die when it is retired, but nothing in this repository can verify that mail is routed:
 *
 *   · PRIVACY_CONTACT_EMAIL is published in the privacy policy, which is a legal document a Web
 *     Store reviewer reads. It needs a real mailbox before P4 cites the policy.
 *   · SENDER_EMAIL's domain must be VERIFIED WITH RESEND or password-reset sends fail outright.
 *     The value it replaced was `noreply@resumemaster.app` — a THIRD domain, `.app` not `.one`,
 *     which appears in no migration document and may never have been held at all. Production
 *     overrides this via PASSWORD_RESET_FROM, so the default is a fallback, not the live value.
 */
export const PRIVACY_CONTACT_EMAIL = `privacy@${CANONICAL_HOST}`;
export const SENDER_EMAIL          = `noreply@${CANONICAL_HOST}`;
export const SENDER_FROM           = `${BRAND} <${SENDER_EMAIL}>`;

/**
 * Permanent store identifiers, immutable after first publish. Neither app is published.
 *
 * ⚠ Availability was NOT verified from this repository — it cannot be. `draft` is a contested
 * namespace, and store display names and bundle identifiers are separate namespaces, so "Draft"
 * being free as a display name says nothing about these. Check `com.draft.android` in the Play
 * Store and attempt to reserve `com.draft.ios` in App Store Connect BEFORE first publish. The
 * fallback, if either is taken, is `com.jobsviadraft.*` — certain to be free, since the owner
 * holds the matching domain.
 *
 * These live here so the two mobile repos and this repo cannot disagree about them, and so the
 * guard can allowlist the identifier BY VALUE rather than by a blanket suppression.
 */
export const ANDROID_APPLICATION_ID = "com.draft.android";
export const IOS_BUNDLE_IDENTIFIER  = "com.draft.ios";

/**
 * ⛔ WIRE VALUES — NOT BRAND STRINGS. These are written into `auth_contexts.user_agent` and matched
 * by the revoke statements in server.js. Renaming either one orphans every live row, so revoke
 * silently stops revoking; and the extension credential and the mobile credential are
 * independently revocable ONLY while the two strings differ. They keep the old spelling on
 * purpose, and they are not user-visible anywhere.
 */
export const EXTENSION_USER_AGENT = "resume-master-extension";
export const MOBILE_USER_AGENT    = "resume-master-mobile";
