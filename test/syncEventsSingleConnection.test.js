// THE APP MAY HOLD EXACTLY ONE SSE CONNECTION, AND IT EMPTIED THE JOB BOARD WHEN IT HELD FOUR.
//
// useSyncEvents opened a NEW EventSource per caller. There are five call sites — App, TopBar
// (twice), JobsPanel and ATSPanel — and four are mounted on the board at once, so the app held four
// permanently-open connections to its own origin, all carrying the identical feed.
//
// A browser allows about six concurrent connections per origin over HTTP/1.1, and an SSE connection
// never completes by design. Four of the six were therefore gone before the board asked for
// anything, and /api/jobs was left queued for a socket that never came free. Measured over eight
// consecutive loads of /app against the PRODUCTION bundle on :3001, before the fix:
//
//     load   /api/jobs started/finished   /api/sync/events   board
//       1            2 / 2                     4 / 0          241
//       2            2 / 0  <- stuck           4 / 0            0
//       3            2 / 2                     4 / 0          241
//       6            2 / 0  <- stuck           4 / 0            0
//       7            2 / 0  <- stuck           4 / 0            0
//       8            2 / 0  <- stuck           4 / 0            0
//
// Four of eight loads showed "0 jobs" over a board the server had 241 rows for. The request was
// ISSUED and never got a socket — no response, no error, no timeout — so nothing in the app could
// notice or retry. After the fix, 12 of 12 loads on :3001 and 12 of 12 on Vite dev showed 241, with
// one SSE connection per load.
//
// This is not a dev-server artifact: Express serves HTTP/1.1, so :3001 has the same ceiling.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ── A fake EventSource, so the real connection accounting can be exercised in node ────────────
class FakeEventSource {
  static live = [];
  static opened = 0;
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.onmessage = null;
    this.onerror = null;
    FakeEventSource.opened++;
    FakeEventSource.live.push(this);
  }
  close() {
    this.closed = true;
    FakeEventSource.live = FakeEventSource.live.filter(e => e !== this);
  }
  emit(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}
globalThis.EventSource = FakeEventSource;
// The hook reads the auth token out of sessionStorage via lib/api.js.
globalThis.sessionStorage = { getItem: () => "", setItem() {}, removeItem() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const {
  subscribeSyncEvents, syncEventsState, __resetSyncEvents,
} = await import("../client/src/hooks/useSyncEvents.js");

const ref = (handlers) => ({ current: handlers });
const reset = () => {
  __resetSyncEvents();
  FakeEventSource.live = [];
  FakeEventSource.opened = 0;
};

test("five subscribers open ONE connection, not five", () => {
  reset();
  const offs = [];
  for (let i = 0; i < 5; i++) offs.push(subscribeSyncEvents(ref({ job_flag: () => {} })));
  assert.equal(FakeEventSource.opened, 1,
    `${FakeEventSource.opened} connections for 5 subscribers — this is the bug that emptied the board`);
  assert.equal(syncEventsState().subscribers, 5);
  assert.equal(syncEventsState().connected, true);
  offs.forEach(off => off());
});

test("every subscriber receives every event — sharing must not cost delivery", () => {
  reset();
  const seen = [0, 0, 0, 0];
  const offs = seen.map((_, i) => subscribeSyncEvents(ref({ job_flag: () => { seen[i]++; } })));
  FakeEventSource.live[0].emit({ type: "job_flag", jobId: "j1", starred: true });
  assert.deepEqual(seen, [1, 1, 1, 1], "an event reached only some of the subscribers");
  offs.forEach(off => off());
});

test("handlers are read through the ref, so a re-render needs no reconnect", () => {
  reset();
  let got = null;
  const r = ref({ job_flag: () => { got = "first"; } });
  const off = subscribeSyncEvents(r);
  r.current = { job_flag: () => { got = "second"; } };      // a re-render replaces the handler map
  FakeEventSource.live[0].emit({ type: "job_flag" });
  assert.equal(got, "second", "the stale handler ran — the ref is not being read at dispatch time");
  assert.equal(FakeEventSource.opened, 1, "replacing handlers must not reopen the connection");
  off();
});

test("heartbeats and the connect frame are not dispatched to handlers", () => {
  reset();
  let calls = 0;
  const off = subscribeSyncEvents(ref({ heartbeat: () => { calls++; }, connected: () => { calls++; } }));
  FakeEventSource.live[0].emit({ type: "heartbeat" });
  FakeEventSource.live[0].emit({ type: "connected" });
  assert.equal(calls, 0);
  off();
});

test("one throwing handler does not stop its siblings, and malformed data is ignored", () => {
  reset();
  let reached = 0;
  const offs = [
    subscribeSyncEvents(ref({ job_flag: () => { throw new Error("boom"); } })),
    subscribeSyncEvents(ref({ job_flag: () => { reached++; } })),
  ];
  FakeEventSource.live[0].emit({ type: "job_flag" });
  assert.equal(reached, 1, "a throwing subscriber swallowed the event for the others");
  assert.doesNotThrow(() => FakeEventSource.live[0].onmessage({ data: "not json" }));
  offs.forEach(off => off());
});

test("the connection closes only when the LAST subscriber leaves", async () => {
  reset();
  const a = subscribeSyncEvents(ref({}));
  const b = subscribeSyncEvents(ref({}));
  a();
  await new Promise(r => setTimeout(r, 400));
  assert.equal(syncEventsState().connected, true, "the connection closed while a subscriber remained");
  b();
  await new Promise(r => setTimeout(r, 400));
  assert.equal(syncEventsState().connected, false, "the last unsubscribe leaked the connection");
  assert.equal(FakeEventSource.live.length, 0);
});

test("a StrictMode-style unmount+remount reuses the connection instead of churning", async () => {
  reset();
  const off = subscribeSyncEvents(ref({}));
  off();                                   // React unmounts...
  const off2 = subscribeSyncEvents(ref({})); // ...and immediately remounts, inside the grace window
  await new Promise(r => setTimeout(r, 400));
  assert.equal(FakeEventSource.opened, 1, "the connection was torn down and reopened");
  assert.equal(syncEventsState().connected, true, "the deferred close fired despite a live subscriber");
  off2();
});

// ── The property, stated against the call sites ──────────────────────────────────────────────

test("no call site constructs its own EventSource", () => {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = `${d}/${e.name}`;
      if (e.isDirectory()) walk(f);
      else if (/\.jsx?$/.test(e.name)) files.push(f);
    }
  })("client/src");

  for (const f of files) {
    const src = fs.readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (!/new EventSource/.test(src)) continue;
    assert.equal(f, "client/src/hooks/useSyncEvents.js",
      `${f} opens its own EventSource — every extra one costs a socket the board needs`);
  }
  // And exactly one construction site inside the hook itself.
  const hook = fs.readFileSync("client/src/hooks/useSyncEvents.js", "utf8");
  assert.equal((hook.match(/new EventSource/g) || []).length, 1);
});

test("the five consumers still subscribe through the hook", () => {
  // The fix must not have been achieved by deleting subscribers.
  const callers = ["client/src/App.jsx", "client/src/components/TopBar.jsx",
                   "client/src/panels/JobsPanel.jsx", "client/src/panels/ATSPanel.jsx"];
  let total = 0;
  for (const f of callers) {
    const n = (fs.readFileSync(f, "utf8").match(/useSyncEvents\(/g) || []).length;
    assert.ok(n > 0, `${f} stopped listening for sync events`);
    total += n;
  }
  assert.equal(total, 5, `expected 5 useSyncEvents call sites across the app, found ${total}`);
});
