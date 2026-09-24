// ── THE EXTENSION'S CREDENTIAL — ONE IDENTITY, DELIBERATELY CHOSEN ──────────────────────────────
//
// WHAT THIS REPLACES, AND WHY IT WAS A SECURITY DEFECT
// Every call the extension made used `credentials: 'include'`, which means it acted as WHATEVER
// SESSION THE BROWSER HAPPENED TO HOLD for our origin. Not an identity it chose — an identity it
// inherited. A measured probe from the extension origin reached 7 of 7 real admin routes with real
// admin JSON, because the person using it was signed in as an admin somewhere in the same browser.
// The extension is published and installable, so that was true for every user who had one.
// See docs/EXTENSION_DIAGNOSIS.md §6.
//
// THE CREDENTIAL IS NOW A TOKEN, AND THE COOKIE IS NEVER SENT
// `credentials: 'omit'` on every call below is not tidiness — it is the property. If the cookie
// still travelled, the server's requireAuth would authenticate off the SESSION and the extension
// would be back to borrowing whoever is signed in, token or no token.
//
// ⛔ WHY THIS TOKEN AND NOT THE OTHER TWO
//   · GET /api/auth/extension-token issues a `sessionLess: true` context tagged
//     'resume-master-extension'. Session-less because the extension is not a tab of this browser
//     profile, so signing out of the browser must not silently kill it — and it has its own revoke
//     endpoint, so it can still be ended on purpose.
//   · NOT the mobile token. The two revoke endpoints key on user_agent, so sharing one would mean
//     "sign out my phone" also kills the extension. server.js says this at the mobile route.
//   · NOT the login-issued authContext. It is session-bound, swept by revokeBrowserAuthContexts,
//     and persisting it produces intermittent, untraceable sign-outs.
//
// THE BOOTSTRAP IS THE ONE CREDENTIALED CALL, AND IT ONLY EXCHANGES
// /api/auth/extension-token is behind requireAuth, so acquiring the token needs the cookie once.
// That single call trades an ambient session for a durable credential of our own and then never
// happens again while the token lives. It is the only `credentials: 'include'` in the extension.

const TOKEN_KEY = 'authToken';
const IDENTITY_KEY = 'authIdentity';

/** Read the stored token, or null. Never throws — storage can be unavailable during teardown. */
async function storedToken() {
  try { return (await chrome.storage.local.get(TOKEN_KEY))?.[TOKEN_KEY] || null; }
  catch { return null; }
}

async function storeToken(token) {
  try { await chrome.storage.local.set({ [TOKEN_KEY]: token }); } catch { /* best effort */ }
}

async function clearStoredToken() {
  try { await chrome.storage.local.remove([TOKEN_KEY, IDENTITY_KEY]); } catch { /* best effort */ }
}

/**
 * Trade the browser's session for the extension's own token.
 *
 * Returns null when there is no session to trade — which is the ordinary "not signed in" state and
 * not an error. A 401 here is the ONLY 401 that means "sign in"; every other 401 in this file means
 * "our token stopped working", which is a different remedy.
 */
async function bootstrapToken(serverUrl) {
  try {
    const res = await fetch(`${serverUrl}/api/auth/extension-token`, { credentials: 'include' });
    if (!res.ok) return null;
    const { token } = await res.json();
    if (!token) return null;
    await storeToken(token);
    return token;
  } catch {
    return null;
  }
}

/**
 * THE ONE NETWORK PATH. Every call the extension makes to our server goes through here.
 *
 * Returns the raw Response so callers can read JSON, or bytes for the resume PDF, without this
 * helper guessing. Returns null only when there is no usable credential at all, so a caller can
 * tell "not signed in" from "the server said no".
 *
 * ONE retry, and only on 401, and only after re-bootstrapping. A token can be revoked from the
 * website, or expire past its absolute window; both look like 401 and both are fixed by asking for
 * a new one. Retrying more than once would turn a genuine sign-out into a loop.
 */
export async function authedFetch(serverUrl, path, init = {}) {
  let token = await storedToken();
  if (!token) {
    token = await bootstrapToken(serverUrl);
    if (!token) return null;
  }

  const send = (t) => fetch(`${serverUrl}${path}`, {
    ...init,
    // ⛔ NEVER 'include'. See the note at the top of this file — the cookie is the defect.
    credentials: 'omit',
    headers: { ...(init.headers || {}), 'X-RM-Auth-Context': t },
  });

  let res = await send(token);
  if (res.status === 401) {
    await clearStoredToken();
    const fresh = await bootstrapToken(serverUrl);
    if (!fresh) return null;
    res = await send(fresh);
  }
  return res;
}

/**
 * Who the extension is acting as — the thing the popup must be able to show.
 *
 * `isAdmin` is reported because it is TRUE of the account and FALSE of what the extension can do
 * with it: the server refuses admin routes to this credential kind regardless. The popup says so
 * rather than hiding it, because a user who is an admin should be able to see that their extension
 * is deliberately not one.
 */
export async function getIdentity(serverUrl) {
  const res = await authedFetch(serverUrl, '/api/auth/me');
  if (!res || !res.ok) return { authenticated: false };
  const body = await res.json().catch(() => null);
  if (!body?.authenticated) return { authenticated: false };
  const identity = {
    authenticated: true,
    username: body.user?.username || '',
    accountIsAdmin: body.user?.isAdmin === true,
  };
  try { await chrome.storage.local.set({ [IDENTITY_KEY]: identity }); } catch { /* best effort */ }
  return identity;
}

/** The last identity we saw, for a popup that opens before the network answers. */
export async function cachedIdentity() {
  try { return (await chrome.storage.local.get(IDENTITY_KEY))?.[IDENTITY_KEY] || null; }
  catch { return null; }
}

/**
 * End this extension's credential, on purpose.
 *
 * Revokes server-side FIRST, then clears locally: clearing first would leave a live token on the
 * server that nothing can present and nothing can revoke. The local clear runs even if the revoke
 * fails, because a user asking to disconnect must always end up disconnected here.
 */
export async function disconnect(serverUrl) {
  try { await authedFetch(serverUrl, '/api/auth/revoke-extension-token', { method: 'POST' }); }
  catch { /* the local clear below is what the user asked for */ }
  await clearStoredToken();
}
