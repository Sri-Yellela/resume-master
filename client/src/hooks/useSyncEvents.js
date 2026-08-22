import { useEffect, useRef } from "react";
import { authContextQuery } from "../lib/api.js";

// ── ONE SSE STREAM FOR THE WHOLE ORIGIN ───────────────────────────────────────────────────────
//
// A browser allows ~6 concurrent connections per origin over HTTP/1.1, and an SSE connection never
// completes by design. Every stream this app holds open is therefore a socket the board cannot
// have. That budget has now been overspent twice, at two different scopes.
//
// ONE PER CALLER (fixed first). The hook opened a stream per call site — App, TopBar twice,
// JobsPanel and ATSPanel — four of which mount on the board at once. Four of six sockets were gone
// before the board asked for anything, and /api/jobs was left queued for a socket that never came
// free: started 2, finished 0, no response, no error, no timeout. The board rendered "0 jobs" over
// a query the server had 241 rows for. The answer was one connection per APP, reference-counted.
//
// ONE PER TAB (fixed here). Chrome's socket pool is keyed by HOST and shared by every tab in the
// profile, so one stream per tab still accumulates across tabs. Measured on :3001 after the first
// fix, opening /app/jobs in eight tabs of a single browser context:
//
//     tab   /api/jobs started/finished   board
//     1-5           2 / 2                 25
//      6            2 / 0  <- stuck        0     <- empty board
//      7      the DOCUMENT never loaded          <- navigation timed out; the origin is unreachable
//
// The same failure one scope out, degrading the same silent way: the sixth tab shows an empty board
// and the seventh cannot load the app at all, with nothing anywhere reporting an error.
//
// So the invariant is not "one stream per app". It is ONE STREAM PER ORIGIN: exactly one tab holds
// the connection and relays every event to the others over a BroadcastChannel. Leadership is a Web
// Lock, which the browser releases automatically when the holding tab closes or crashes, so the
// next tab takes the stream over without any liveness protocol of our own.
//
// NO TAB LOSES AN EVENT. Relaying rather than disconnecting is the whole point. The cheap fix is to
// drop the stream in hidden tabs, but a background tab would then miss job_flag and
// profile_switched and come back silently wrong — trading a visible bug for an invisible one.
//
// THE LOCK AND CHANNEL ARE KEYED BY AUTH CONTEXT. sessionStorage is per-tab, so two tabs can be
// signed in as DIFFERENT users; an unkeyed channel would relay one user's events into the other's
// board. Tabs share a stream only when they share an identity.
//
// The public API is unchanged. Callers still write useSyncEvents({ job_flag: fn, ... }); no call
// site has been touched by either fix.

/** Live subscribers IN THIS TAB. Each entry is a caller's handlers REF, so re-renders need no resubscribe. */
const subscribers = new Set();

let source = null;          // the stream itself — only ever open on the leader tab
let retryTimeout = null;
let closeTimeout = null;

let channel = null;         // relay to the other tabs; open on leader and follower alike
let groupKey = null;        // the identity this tab's channel and lock are keyed to
let releaseLock = null;     // resolves the promise holding the Web Lock, giving up leadership
let lockAbort = null;       // aborts a lock request that has not been granted yet
let lockPending = false;    // a request is queued and not yet granted
let leading = false;

/**
 * Cross-tab sharing needs both APIs. Where either is missing the hook falls back to the previous
 * behaviour — one stream per tab — which is still correct, just not as cheap.
 */
function crossTabAvailable() {
  return typeof BroadcastChannel === "function"
      && typeof navigator !== "undefined"
      && typeof navigator.locks?.request === "function";
}

/** A tab may only share a stream with tabs that share its identity. See the header note. */
function identityKey() {
  return authContextQuery() || "session";
}

/** Deliver one event to this tab's subscribers. Reached from the stream AND from the relay. */
function fanout(payload) {
  const { type, ...rest } = payload || {};
  if (!type || type === "heartbeat" || type === "connected") return;
  // Snapshot first: a handler may unmount a component, and mutating the set mid-iteration would
  // skip a sibling subscriber.
  for (const ref of [...subscribers]) {
    const handler = ref.current?.[type];
    if (typeof handler === "function") {
      // One throwing handler must not stop the others from seeing the event.
      try { handler(rest); } catch { /* a subscriber's own failure is its own */ }
    }
  }
}

/** The leader's stream handler: relay to the other tabs first, then deliver here. */
function onStreamMessage(e) {
  let payload;
  try { payload = JSON.parse(e.data); } catch { return; }   // ignore malformed events
  if (!payload?.type || payload.type === "heartbeat" || payload.type === "connected") return;
  // Relay BEFORE the local fan-out: a subscriber in THIS tab that throws must not cost every other
  // tab the event. postMessage is guarded because a closing channel throws InvalidStateError.
  try { channel?.postMessage(payload); } catch { /* the relay is best-effort */ }
  fanout(payload);
}

/** Open the origin's one connection. Only the leader reaches this — or any tab, when falling back. */
function openStream() {
  if (source || !subscribers.size) return;
  const qs = authContextQuery();
  source = new EventSource(`/api/sync/events${qs ? `?${qs}` : ""}`, { withCredentials: true });
  source.onmessage = onStreamMessage;
  source.onerror = () => {
    source?.close();
    source = null;
    clearTimeout(retryTimeout);
    // Only reconnect while someone is still listening, and re-read authContextQuery() on the way
    // back in — the token can have changed while we were down.
    if (subscribers.size) retryTimeout = setTimeout(openStream, 5000);
  };
}

/** Queue for the origin's one stream. Resolving the returned promise is what gives leadership up. */
function requestLeadership(key) {
  lockPending = true;
  lockAbort = new AbortController();
  navigator.locks.request(
    `rm-sync-events-leader:${key}`,
    { mode: "exclusive", signal: lockAbort.signal },
    () => new Promise(resolve => {
      lockPending = false;
      // Everyone left while we waited in line. Hand the lock straight back so a tab that still has
      // subscribers can take it, and stay eligible to queue again if a subscriber returns — this
      // tab must not sit holding a stream nobody is listening to.
      if (!subscribers.size) { resolve(); return; }
      // Granted. This tab now holds the origin's only connection, and holds the lock until it lets
      // go or the browser reclaims it — which is what makes a closed tab hand leadership on.
      releaseLock = resolve;
      leading = true;
      openStream();
    }),
  ).catch(() => { lockPending = false; });   // aborted by release(): a normal exit from the queue
}

function connect() {
  if (!subscribers.size) return;
  if (!crossTabAvailable()) { openStream(); return; }

  const key = identityKey();
  // Signing in inside a live tab changes who this tab is. Leave the old identity's group before
  // joining the new one, or this tab would go on relaying a stream that is not its user's.
  if (channel && groupKey !== key) leaveGroup();

  if (!channel) {
    groupKey = key;
    channel = new BroadcastChannel(`rm-sync-events:${key}`);
    channel.onmessage = e => fanout(e.data);             // the follower path: events arrive relayed
  }

  if (leading) { openStream(); return; }                 // already hold it; make sure it is open
  if (lockPending) return;                               // already queued for it
  // NOT holding and NOT queued. This is reachable after a grant landed during the teardown grace
  // window and was handed straight back, which is the ordinary React StrictMode remount — without
  // this the tab would keep a channel, never queue again, and never see another event.
  requestLeadership(key);
}

/**
 * Drop the stream and this tab's membership of its identity group, unconditionally. Used both when
 * the last subscriber leaves and when the tab changes identity underneath a live group.
 */
function leaveGroup() {
  source?.close();
  source = null;
  clearTimeout(retryTimeout);
  retryTimeout = null;
  // Give up leadership so a waiting tab can take the stream, and stop queueing if it was never
  // granted. Aborting an already-granted request is a no-op, so both cases are covered.
  try { lockAbort?.abort(); } catch { /* already settled */ }
  lockAbort = null;
  lockPending = false;
  releaseLock?.();
  releaseLock = null;
  leading = false;
  channel?.close();
  channel = null;
  groupKey = null;
}

function release() {
  if (subscribers.size) return;
  leaveGroup();
}

/**
 * Join the shared stream. Returns the unsubscribe function.
 *
 * Exported, and the hook is a thin wrapper over it, so the connection accounting — one socket, N
 * subscribers, N tabs, all of them dispatched to — is reachable without a React renderer. That
 * accounting is the whole point of this file and it is what emptied the board when it was wrong.
 *
 * @param {{current: Record<string, Function>}} handlersRef
 */
export function subscribeSyncEvents(handlersRef) {
  // A pending teardown means a subscriber left microseconds ago — React StrictMode unmounts and
  // remounts every effect, and switching tabs unmounts one consumer while mounting another.
  // Cancelling it reuses the live connection instead of closing and immediately reopening.
  clearTimeout(closeTimeout);
  closeTimeout = null;

  subscribers.add(handlersRef);
  connect();

  return () => {
    subscribers.delete(handlersRef);
    // Deferred, for the same reason: do not tear down a connection that is about to be re-used.
    clearTimeout(closeTimeout);
    closeTimeout = setTimeout(release, 250);
  };
}

/**
 * useSyncEvents — subscribes to the origin's single /api/sync/events stream.
 *
 * handlers: { [eventType]: (payload) => void }
 *   Supported types: job_flag, resume_generated, profile_switched, scrape_complete
 *
 * The stream reconnects automatically on network failure, moves to another tab when the tab holding
 * it closes, and is closed once the last subscriber unmounts.
 */
export function useSyncEvents(handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => subscribeSyncEvents(handlersRef), []);
}

/** The live connection state. One socket however many subscribers — and however many tabs. */
export function syncEventsState() {
  return {
    connected: !!source,
    subscribers: subscribers.size,
    leading,
    relaying: !!channel,
  };
}

/** Tear everything down. Only for tests, which must not leak a connection between cases. */
export function __resetSyncEvents() {
  subscribers.clear();
  clearTimeout(closeTimeout); closeTimeout = null;
  leaveGroup();
}
