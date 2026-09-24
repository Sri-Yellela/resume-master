// ── WHAT A CREDENTIAL IS ALLOWED TO BE, IN ONE PLACE ────────────────────────────────────────────
//
// There are THREE separate `requireAdmin` definitions in this repo — server.js, routes/admin.js and
// routes/adminDb.js — each written independently and each checking `req.user?.isAdmin` and nothing
// else. That is how the extension reached the DB inspector: a fix applied to one of them leaves the
// other two open, and nothing makes them disagree loudly.
//
// This module is the predicate they now share. It is deliberately a PREDICATE and not a middleware,
// because the three guards differ in what they do on refusal (status text, logging) and unifying
// that too would be a bigger change than the defect warrants.
//
// Plain ESM with no imports beyond brand.js and no node builtins, matching shared/brand.js — the
// client's Vite build can reach this directory.

import { EXTENSION_USER_AGENT } from "./brand.js";

/**
 * Is this request authenticated by the BROWSER EXTENSION's credential?
 *
 * Reads `req.authContextUserAgent`, which server.js's bindAuthContext sets from
 * `auth_contexts.user_agent` when a token authenticates the request. A cookie-session request
 * leaves it undefined, which is correct: the human sitting in the admin console is not the
 * extension.
 *
 * ⛔ The comparison is against the WIRE VALUE in shared/brand.js, not a new literal. That string is
 * also what the revoke statements match on, so a second spelling here would silently stop matching
 * the rows it is meant to describe.
 */
export function isExtensionCredential(req) {
  return req?.authContextUserAgent === EXTENSION_USER_AGENT;
}

/**
 * Is this request coming FROM an extension context, whatever it authenticated with?
 *
 * ⛔ WHY THE CREDENTIAL CHECK ALONE IS NOT ENOUGH, measured rather than reasoned.
 * scripts/dx2ExtensionIdentity.mjs §2 failed 7/7 with only isExtensionCredential in place: a
 * `credentials: 'include'` fetch issued from an extension page still carries the BROWSER COOKIE,
 * because host_permissions lets the extension talk to our origin with cookies attached. The
 * extension's own code no longer does that — but "no current call site does it" is a property of
 * today's source, one careless fetch away from being false again.
 *
 * ⛔ IT IS NOT THE Origin HEADER, AND THAT WAS MEASURED THE HARD WAY.
 * Chrome sends NO Origin and NO Referer on an extension request to a host in host_permissions —
 * from a page or from the service worker. A `/^chrome-extension:\/\//` test on Origin is dead
 * code that can never fire, which is worse than no check because it reads like one. Two guesses
 * were wrong here before the headers were actually read off the wire.
 *
 * WHAT IS ACTUALLY DISTINCTIVE, from that measurement:
 *
 *     extension page / service worker fetch   sec-fetch-site: none        sec-fetch-mode: cors
 *     same-origin page fetch (admin console)  sec-fetch-site: same-origin
 *     a typed URL or bookmark                 sec-fetch-site: none        sec-fetch-mode: navigate
 *     curl / node / a harness                 both headers ABSENT
 *
 * So `site === "none" && mode === "cors"` isolates exactly the extension case. A page cannot forge
 * Sec-Fetch-* (they are forbidden header names), and the equality test against "none" means an
 * ordinary API client, which sends neither header, is untouched.
 *
 * DEFENCE IN DEPTH, NOT THE PRIMARY CONTROL. The primary control is that the extension holds its
 * own token and never sends the cookie. This is the backstop for the day someone adds a
 * credentialed fetch back. It can only ever REMOVE privilege, never grant it, so a browser that
 * omits these headers fails safe — back to the credential check above.
 */
export function isExtensionRequest(req) {
  if (isExtensionCredential(req)) return true;
  const h = req?.headers || {};
  return h["sec-fetch-site"] === "none" && h["sec-fetch-mode"] === "cors";
}

/**
 * May this request reach an admin route?
 *
 * ⛔ THE EXTENSION IS NEVER AN ADMIN, WHOEVER HOLDS IT. Moving the extension onto its own
 * sessionLess token does not on its own remove the privilege: bindAuthContext hydrates the FULL
 * user from the token's user_id, so an admin's extension token still satisfies `isAdmin`. The
 * credential changed; the privilege did not. The check therefore has to be on the KIND of
 * credential, not on the person behind it.
 *
 * See docs/EXTENSION_DIAGNOSIS.md §6 for the measured 7-of-7 reach this closes.
 */
export function mayActAsAdmin(req) {
  if (isExtensionRequest(req)) return false;
  return !!req?.user?.isAdmin;
}
