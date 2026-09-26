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
 * THE WORDMARK — the name set as a mark rather than as a word in a sentence.
 *
 * Decided 2026-09-26: the mark is lowercase. BRAND stays title-case because the two are used in
 * different places and collapsing them gets one of them wrong in every sentence — "draft is an
 * AI-powered job application platform" and "Does draft auto-apply?" read as typos, not as styling.
 *
 * WORDMARK belongs on surfaces where the name stands alone as a label: the nav and footer lockups,
 * the stamp logo, the extension's manifest `name`, and the Chrome Web Store title. BRAND belongs
 * anywhere the name is a noun inside prose — marketing copy, the FAQ, toasts, the email sender.
 *
 * ⛔ They are the SAME NAME in two cases, and brandAndOriginGuard asserts exactly that: they must
 * differ in case and in nothing else. A WORDMARK that drifts to a different word is two names
 * shipping, which is the failure docs/BRAND.md exists to prevent.
 */
export const WORDMARK = "draft";

/**
 * The bare apex, with no `www`.
 *
 * ⛔ `www.jobsviadraft.com` is in DNS and points at the same Railway target, but is NOT activated
 * and will not be: the plan allows two custom domains and both slots are permanently in use. This
 * comment used to say "until the old domain is retired" — the old domain is not being retired (see
 * LEGACY_HOST below), so the slot never frees.
 *
 * That is not a loss, because `host_permissions` is a MATCH PATTERN — `https://jobsviadraft.com/*`
 * does not match a `www` host, so any code path that emits `www` silently breaks the extension's
 * credentialed fetch. Every host that gets hardcoded anywhere derives from these two constants.
 */
export const CANONICAL_HOST   = "jobsviadraft.com";
export const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`;

/**
 * ⛔ NOT "the old domain". A SECOND PRODUCT'S ADDRESS, and it is staying.
 *
 * This constant used to be documented as "the domain being migrated away from". The owner decided
 * on 2026-09-25 (docs/PRODUCT_MODEL.md) that Resume Master is a separate product — a stateless
 * processing service — which keeps this host. There is no retirement, no 301, and no event that
 * removes its OAuth redirect URIs. docs/MIGRATION_AND_REBRAND.md and docs/DOMAIN_MIGRATION.md both
 * instructed all three and are corrected in place.
 *
 * The name LEGACY_* is now slightly wrong and is kept anyway: renaming it touches every consumer
 * for no behavioural gain, and this comment is where the meaning lives. What it means is "the
 * OTHER origin this deployment answers on".
 *
 * This is a real constant rather than a comment because three kinds of code legitimately need the
 * value, and each of them would otherwise hardcode it again:
 *
 *   1. ~~extension/ is frozen for P4~~ — DONE 2026-09-26. The package now names CANONICAL_ORIGIN,
 *      and so do the tests and harnesses that police it. What still names THIS host is the v1.0.0
 *      item sitting in the Web Store review queue, which is why the origin has to keep answering.
 *   2. The privacy policy names BOTH hosts on purpose: whichever build a reader is running, the
 *      host their data goes to is named in the document they are reading.
 *   3. Both origins serve this one deployment today. Whether Resume Master later splits into its
 *      own service with its own database is an open owner decision; nothing is built.
 *
 * ⛔ NEVER 301 THIS ORIGIN, AND THIS IS PERMANENT — NOT A COUNTDOWN.
 *
 * The rule was originally scoped to the review window: "safe once the extension update is LIVE".
 * It is not. A credentialed `fetch` does not follow redirects, so a 301 on an /api route returns
 * an opaque response that reads as an EMPTY ANSWER rather than an error — silently, for every
 * credentialed client of this origin, present and future, not only the extension that prompted the
 * rule. Serve both origins directly. There is no date after which a redirect becomes fine.
 */
export const LEGACY_HOST   = "resumemaster.one";
export const LEGACY_ORIGIN = `https://${LEGACY_HOST}`;

/**
 * ⛔ THE SECOND PRODUCT'S NAME, not a dead one. Survives nowhere as a user-visible string for
 * THIS product — but it is what the other one is called, and docs/BRAND.md § "Resume Master is a
 * SECOND PRODUCT" sets out how the rebrand guard makes room for that without being disarmed.
 */
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
 * ⚠ NEITHER MAILBOX IS KNOWN TO EXIST YET, and nothing in this repository can verify that mail is
 * routed. Both addresses below moved with the domain because this product's contact address should
 * be on this product's domain — NOT, as previously stated here, because the old ones "die when it
 * is retired". The old domain is not being retired (see LEGACY_HOST), so those mailboxes, if they
 * exist, keep working; they simply belong to the other product now.
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
