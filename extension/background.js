import {
  runGatedHandoff, clearPacketForTab, sweepExpiredPackets, applyOverlayEdit,
  loadBatchForTab, clearBatchForTab,
} from './gated-handoff.js';

// Keep in sync with config.js (service workers cannot share plain-script globals).
// DEV SWITCH: comment line A, uncomment line B.
const RESUME_MASTER_URL = 'https://resumemaster.one'; // A: production
// const RESUME_MASTER_URL = 'http://localhost:3000'; // B: local dev

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OPEN_ATS_SCORE') {
    const encoded = encodeURIComponent((message.jobText || '').slice(0, 5000));
    chrome.tabs.create({ url: `${RESUME_MASTER_URL}/ats-score?jd=${encoded}` });
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'OPEN_LINKEDIN_IMPORT') {
    chrome.tabs.create({ url: `${RESUME_MASTER_URL}/auth/linkedin` });
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'OPEN_RESUME_BUILDER') {
    chrome.tabs.create({ url: `${RESUME_MASTER_URL}/resume` });
    sendResponse({ success: true });
    return true;
  }

  return true;
});

// Default hotkey (chrome://extensions/shortcuts owns the actual binding — see
// linkedin-content.js for the separate custom-override mechanism, which is page-scoped and
// cannot be a real chrome.commands rebinding). Relays to the active tab's content script,
// which does the actual capture (it has DOM access; this service worker does not).
chrome.commands.onCommand.addListener((command) => {
  if (command === 'fill-gated-application') { void handleGatedHandoff(); return; }
  if (command !== 'capture-job') return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_AND_IMPORT' }, () => {
      // Ignore "no receiving end" errors — happens on pages with no content script injected.
      void chrome.runtime.lastError;
    });
  });
});

// ── Gated portal handoff (TASK G2) ───────────────────────────────────────────
// THIS LISTENER FIRING IS THE PERMISSION. A chrome.commands invocation is a user gesture, which is
// what grants activeTab for the tab they are on — there is no host permission for portal origins and
// there must never be. Everything else follows from that one grant.
//
// The result is reported with chrome.action's badge rather than a notification: the extension has no
// `notifications` permission, and adding one for a status message would be a new user-facing consent
// prompt for something a badge already says.
async function handleGatedHandoff() {
  void sweepExpiredPackets();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = await runGatedHandoff({ serverUrl: RESUME_MASTER_URL, tab });
  await reportHandoff(tab, result);
  return result;
}

async function reportHandoff(tab, result) {
  const badge = result.ok ? { text: String(result.filled?.length ?? 0), color: '#16a34a' }
                          : { text: '!', color: '#dc2626' };
  try {
    await chrome.action.setBadgeText({ tabId: tab?.id, text: badge.text });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab?.id, color: badge.color });
    await chrome.action.setTitle({ tabId: tab?.id, title: result.message || 'Resume Master' });
  } catch { /* a tab that closed mid-handoff is not an error worth surfacing */ }

  // Stored so the popup, and the verification harnesses, can see the detail a badge cannot.
  try {
    await chrome.storage.session.set({ lastGatedHandoff: { ...result, at: Date.now(), tabId: tab?.id } });
  } catch { /* session storage is best-effort here */ }
}

// ── Review overlay traffic (TASK G3) ─────────────────────────────────────────
// The overlay runs in the page's isolated world and talks back through here. Two messages: a
// corrected value, and the running readiness state.
//
// Kept OUT of the onMessage listener above, which answers synchronously; these need to await.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'GATE_REVIEW_EDIT') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false, reason: 'no_tab' }); return true; }
    applyOverlayEdit({ tabId, field: msg.field, value: msg.value })
      .then(result => sendResponse({ ok: true, result }))
      .catch(e => sendResponse({ ok: false, reason: e.message }));
    return true;                                            // async response
  }

  // ── One gate crossing, several applications (TASK G5) ─────────────────────
  // Moves the SAME TAB to the next application on this portal. G0 measured that the activeTab grant
  // survives every same-origin navigation, browser-initiated ones included, so this costs no second
  // gesture — which is the entire point of amortising per portal rather than per application.
  if (msg?.type === 'GATE_BATCH_NEXT') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false, reason: 'no_tab' }); return true; }
    advanceBatch(tabId).then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, reason: e.message }));
    return true;
  }

  if (msg?.type === 'GATE_REVIEW_STATE') {
    // Recorded against the application's audit row: for a gated application this is the ONLY record
    // of what a human saw before it went out, because the submission happens in a browser we never
    // observe. Best-effort — a failure here must never block the candidate from submitting.
    void recordGateReview(sender.tab?.id, msg);
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

async function recordGateReview(tabId, msg) {
  if (!tabId) return;
  const stored = await chrome.storage.session.get(`gate:${tabId}`);
  const entry = stored?.[`gate:${tabId}`];
  const runJobId = entry?.packet?.runJobId;
  if (!runJobId) return;
  try {
    await fetch(`${RESUME_MASTER_URL}/api/apply/gate-review`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runJobId,
        packetId: entry.packetId ?? null,
        ready: !!msg.ready,
        acknowledged: msg.acknowledged || [],
        edits: msg.edits || [],
      }),
    });
  } catch { /* the candidate's submission does not depend on our bookkeeping */ }
}

async function advanceBatch(tabId) {
  const batch = await loadBatchForTab(tabId);
  if (!batch?.origin) return { ok: false, reason: 'no_batch' };

  // Re-read the queue rather than trusting the count the overlay was rendered with: the candidate may
  // have finished one of these in another tab since.
  const res = await fetch(`${RESUME_MASTER_URL}/api/apply/gate-packets`, { credentials: 'include' })
    .catch(() => null);
  if (!res?.ok) return { ok: false, reason: 'unreachable' };
  const body = await res.json();
  const next = (body.packets || [])
    .filter(p => p.expectedOrigin === batch.origin)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!next) { await clearBatchForTab(tabId); return { ok: false, reason: 'batch_empty' }; }

  // The packet released into THIS tab is finished with; the next application must be matched and
  // approved on its own terms rather than inheriting the last one's.
  await clearPacketForTab(tabId);

  // Two applications can share an apply URL — a portal that serves them all from one route, or a
  // reopened handoff for the job already open. tabs.update to the URL already showing does nothing
  // and fires no onUpdated, so waiting for one would hang the batch here forever. Run it directly.
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (current?.url === next.applyUrl) {
    const result = await runGatedHandoff({ serverUrl: RESUME_MASTER_URL, tab: current });
    await reportHandoff(current, result);
    return { ok: true, packetId: next.packetId, applyUrl: next.applyUrl, navigated: false };
  }

  await chrome.tabs.update(tabId, { url: next.applyUrl });
  return { ok: true, packetId: next.packetId, applyUrl: next.applyUrl, navigated: true };
}

// The candidate is already authenticated and the grant is still live, so the next application in a
// batch fills without another keypress. Strictly scoped: only a tab with an ACTIVE BATCH, only when
// it lands on the same origin that batch belongs to. Any other navigation is none of our business.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const batch = await loadBatchForTab(tabId);
  if (!batch?.origin) return;

  // An unreadable URL is not a missing detail, it is the answer: without the tabs permission, a tab's
  // url is visible only while we hold access to it. Losing sight of it means the activeTab grant is
  // gone, which means the tab left the origin — so the batch is over. Treating this as "skip and try
  // again later" is what left a batch pinned to a tab the candidate had navigated away from.
  if (!tab?.url) { await clearBatchForTab(tabId); return; }

  let origin;
  try { origin = new URL(tab.url).origin; } catch { await clearBatchForTab(tabId); return; }
  if (origin !== batch.origin) {
    // Left the portal. The grant is gone (G0 §9) and so is the batch; the remaining jobs stay held
    // rather than being treated as failed — they were never touched.
    await clearBatchForTab(tabId);
    return;
  }
  const result = await runGatedHandoff({ serverUrl: RESUME_MASTER_URL, tab });
  await reportHandoff(tab, result);
});

// The packet outlives its activeTab grant (G0 §9 measured this), so nothing expires it on its own.
// A closed tab is the one unambiguous signal that its handoff is over.
chrome.tabs.onRemoved.addListener((tabId) => {
  void clearPacketForTab(tabId);
  void clearBatchForTab(tabId);
});

// And a sweep for the rest: a handoff the candidate walked away from leaves a packet holding a home
// address in session storage until the browser restarts. onStartup/onInstalled plus every invocation
// is enough to keep that bounded without a polling alarm.
chrome.runtime.onStartup?.addListener(() => { void sweepExpiredPackets(); });
chrome.runtime.onInstalled?.addListener(() => { void sweepExpiredPackets(); });
