import { useEffect, useRef } from "react";
import { authContextQuery } from "../lib/api.js";

// ── ONE EventSource FOR THE WHOLE APP ─────────────────────────────────────────────────────────
//
// This hook used to open a NEW EventSource per caller. There are five call sites — App, TopBar
// (twice), JobsPanel and ATSPanel — and four of them are mounted on the board at once, so the app
// held FOUR permanently-open connections to its own origin, all streaming the identical event feed.
//
// THAT EMPTIED THE JOB BOARD. A browser allows ~6 concurrent connections per origin over HTTP/1.1,
// and SSE connections never complete by design, so four of the six were gone before the board asked
// for anything. Measured over ten consecutive loads of /app in one browser context:
//
//     load   /api/jobs started/finished   /api/sync/events started/finished   board
//       1            2 / 2                          4 / 0                      241
//       2            2 / 0   <- stuck               4 / 0                        0
//       3            2 / 0   <- stuck               4 / 0                        0
//       ...
//       8            2 / 2                          4 / 0                      241
//
// The request was ISSUED and never got a socket: started 2, finished 0, no response, no error, no
// timeout — so nothing in the app could detect it or retry. The board simply rendered "0 jobs" over
// a query the server would happily have answered, and which it HAD answered moments earlier. It
// recovered only when a previous document's sockets happened to be reaped first, which is why it
// looked intermittent and why it looked like "the second load".
//
// This is not a dev-server artifact. Express serves HTTP/1.1, so :3001 has the same six-socket
// ceiling as Vite's :5173.
//
// The fix is the design this should always have had: ONE connection, reference-counted, with every
// subscriber's handlers invoked from it. Five identical streams were waste on the server too — each
// one is a held-open response and a per-connection heartbeat timer, per tab.
//
// The public API is unchanged: callers still write useSyncEvents({ job_flag: fn, ... }) and still
// get their handlers called. No call site was touched.

/** Live subscribers. Each entry is the caller's handlers REF, so re-renders need no resubscribe. */
const subscribers = new Set();

let source = null;
let retryTimeout = null;
let closeTimeout = null;

function dispatch(e) {
  let payload;
  try { payload = JSON.parse(e.data); } catch { return; }   // ignore malformed events
  const { type, ...rest } = payload;
  if (type === "heartbeat" || type === "connected") return;
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

function connect() {
  if (source || !subscribers.size) return;
  const qs = authContextQuery();
  source = new EventSource(`/api/sync/events${qs ? `?${qs}` : ""}`, { withCredentials: true });
  source.onmessage = dispatch;
  source.onerror = () => {
    source?.close();
    source = null;
    clearTimeout(retryTimeout);
    // Only reconnect while someone is still listening, and re-read authContextQuery() on the way
    // back in — the token can have changed while we were down.
    if (subscribers.size) retryTimeout = setTimeout(connect, 5000);
  };
}

function release() {
  if (subscribers.size) return;
  source?.close();
  source = null;
  clearTimeout(retryTimeout);
  retryTimeout = null;
}

/**
 * Join the shared stream. Returns the unsubscribe function.
 *
 * Exported, and the hook is a thin wrapper over it, so the connection accounting — one socket, N
 * subscribers, all of them dispatched to — is reachable without a React renderer. That accounting
 * is the whole point of this file and it is what emptied the board when it was wrong.
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
 * useSyncEvents — subscribes to the app's single /api/sync/events stream.
 *
 * handlers: { [eventType]: (payload) => void }
 *   Supported types: job_flag, resume_generated, profile_switched, scrape_complete
 *
 * The stream reconnects automatically on network failure and is closed once the last subscriber
 * unmounts.
 */
export function useSyncEvents(handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => subscribeSyncEvents(handlersRef), []);
}

/** The live connection state. One socket however many subscribers there are. */
export function syncEventsState() {
  return { connected: !!source, subscribers: subscribers.size };
}

/** Tear everything down. Only for tests, which must not leak a connection between cases. */
export function __resetSyncEvents() {
  subscribers.clear();
  clearTimeout(closeTimeout); closeTimeout = null;
  clearTimeout(retryTimeout); retryTimeout = null;
  source?.close();
  source = null;
}
