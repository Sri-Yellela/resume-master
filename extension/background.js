import {
  runGatedHandoff, clearPacketForTab, sweepExpiredPackets, applyOverlayEdit,
  loadBatchForTab, clearBatchForTab,
} from './gated-handoff.js';
import { extractJobPayload, showCaptureToast } from './extractor.js';

// Keep in sync with config.js (service workers cannot share plain-script globals).
// DEV SWITCH: comment line A, uncomment line B.
const RESUME_MASTER_URL = 'https://resumemaster.one'; // A: production
// const RESUME_MASTER_URL = 'http://localhost:3000'; // B: local dev

// ── Capture (E2) ─────────────────────────────────────────────────────────────
// THE ONE NETWORK PATH FOR CAPTURE, and it lives in the service worker rather than the content
// script for a reason that only shows up in production.
//
// A content script's fetch carries the PAGE's origin — https://www.linkedin.com — not the
// extension's. server.js's corsOrigin admits only APP_BASE_ORIGIN/FRONTEND_ORIGIN in production, and
// corsOriginExtension additionally admits chrome-extension:// but not a job board either. So every
// capture posted from the content script would be refused by CORS the moment NODE_ENV=production —
// invisible in development, where corsOrigin returns true for everything.
//
// A service worker fetch is not subject to CORS for a host in host_permissions, and
// https://resumemaster.one/* is declared. Moving the call here fixes it without widening the
// server's CORS to six job boards, which is the alternative and a far worse trade.
async function importCapturedJob({ url, text }) {
  try {
    const res = await fetch(`${RESUME_MASTER_URL}/api/import/job`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, text }),
    });

    if (res.status === 401) {
      return { success: false, message: 'Sign in to Resume Master first' };
    }
    const json = await res.json().catch(() => ({}));
    if (json.needsClientCapture) {
      // Should not happen: we always send the extracted text. Reported rather than swallowed, so a
      // regression in extraction is visible instead of looking like a generic failure.
      return { success: false, message: json.message || 'Could not read this job automatically' };
    }
    if (!res.ok) {
      return { success: false, message: json.error || `Import failed (${res.status})` };
    }

    const job = json.job || {};
    const label = [job.title, job.company].filter(Boolean).join(' @ ') || 'job';
    return {
      success: true,
      // One message, produced in one place, so the popup and the hotkey cannot word it differently.
      message: json.alreadyImported || json.reconciled
        ? `Already on your board: ${label}`
        : `Captured: ${label}`,
      jobId: job.jobId || json.jobId || null,
    };
  } catch (e) {
    return { success: false, message: 'Could not reach Resume Master' };
  }
}

// ── THE capture implementation. One function, every trigger. ─────────────────
//
// Extraction is INJECTED rather than delivered by a content script, and that is the whole design.
// A content script needs a host permission for every origin it runs on, so capture only ever worked
// on the six boards the manifest happened to name — never on a Greenhouse board embedded at
// stripe.com/jobs, never on Ashby, never on a company careers page. You cannot enumerate every
// employer's domain, so that approach had a ceiling built into it.
//
// activeTab has no such ceiling. The user's invocation — the toolbar click or the hotkey — grants
// access to that one tab, and executeScript reaches it whatever the origin. G0 measured the grant
// on a real Workday tenant with no host permission for it; E6 measured that a toolbar click grants
// it to the popup too. So the extension now asks for NO job-board host permission at all and
// captures more sites than it did with seven.
//
// It also means the extension has no standing access to anything. Before, it could read six sites
// whenever they were open. Now it can read one tab, at the moment you point it at one.
async function captureActiveTab(tab) {
  if (!tab?.id) return { success: false, message: 'No active tab.' };

  // tab.url is only readable once the grant exists, so treat "unreadable" as "not yet granted"
  // rather than as a bad page — the injection below will produce the real error if there is one.
  if (tab.url && !/^https?:$/.test(new URL(tab.url).protocol)) {
    return { success: false, message: 'Only http(s) pages can be captured.' };
  }

  let extracted;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractJobPayload });
    extracted = r?.result;
  } catch (e) {
    // The grant is missing or lapsed — Chrome revokes it when the tab leaves the origin it was
    // taken on. This is an expected state with a clear remedy, not a failure worth a stack trace.
    return { success: false, message: 'Press the shortcut again on the job page you want to capture.' };
  }

  if (!extracted?.ok) {
    const miss = { success: false, message: 'No job found on this page' };
    await reportCapture(tab.id, miss);
    return miss;
  }

  const result = await importCapturedJob({ url: extracted.url, text: extracted.text });
  await reportCapture(tab.id, result);
  return result;
}

/** Same feedback for every trigger: the toast in the page, and the record the popup reads later. */
async function reportCapture(tabId, result) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId }, func: showCaptureToast, args: [result.message, !!result.success],
    });
  } catch (_) { /* the toast is a courtesy; never let it change the outcome */ }
  // Recorded so the popup can show the outcome of a hotkey capture it was not open for.
  chrome.storage.local.set({ lastCapture: { ...result, at: Date.now() } }).catch(() => {});
}

/** What the popup shows before you commit to capturing. Same extractor, no network, no writes. */
async function previewActiveTab(tab) {
  const capturable = !!tab?.id && (!tab.url || /^https?:$/.test(new URL(tab.url).protocol));
  if (!capturable) return { capturable: false };
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractJobPayload });
    const p = r?.result;
    return { capturable: true, ok: !!p?.ok, title: p?.title || '', company: p?.company || '', location: p?.location || '' };
  } catch (_) {
    // No grant yet. The button still shows: clicking it is itself an invocation, and the capture
    // that follows will succeed where this speculative read could not.
    return { capturable: true, ok: false, unreadable: true };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Capture, from the popup button. The hotkey reaches the same function through onCommand below;
  // neither trigger has an implementation of its own.
  if (message.type === 'CAPTURE_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => captureActiveTab(tab))
      .then(sendResponse);
    return true;                                            // async response
  }

  if (message.type === 'PREVIEW_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => previewActiveTab(tab))
      .then(sendResponse);
    return true;
  }

  // The popup's auth probe, moved here for the same CORS reason: from the popup this request
  // carries chrome-extension://, which corsOrigin refuses in production.
  if (message.type === 'PROBE_AUTH') {
    fetch(`${RESUME_MASTER_URL}/api/auth/me`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => sendResponse({ authenticated: d?.authenticated === true }))
      .catch(() => sendResponse({ authenticated: false }));
    return true;
  }

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

// The hotkey. chrome://extensions/shortcuts owns the binding, and that is now the only way to
// rebind it: the old page-scoped keydown override lived in the content script, which no longer
// exists. Chrome's own rebinding UI works on every page rather than only the six the content
// script reached, so this is a smaller extension doing more.
//
// THE LISTENER FIRING IS THE PERMISSION. A chrome.commands invocation is a user gesture, which is
// what grants activeTab for the tab they are on — the same grant the gated handoff runs on.
chrome.commands.onCommand.addListener((command) => {
  if (command === 'fill-gated-application') { void handleGatedHandoff(); return; }
  if (command !== 'capture-job') return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => { void captureActiveTab(tab); });
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
  // Scoped to the batch's origin. Unscoped, this list is the newest 100 unconsumed packets across
  // EVERY portal — so a candidate with a long queue could have this batch's packets fall outside
  // the cap entirely, and the filter below would find nothing. That reads as `batch_empty` and
  // stops a run that has work left, which is the worst way for a cap to fail: silently, and as a
  // completion.
  const res = await fetch(
    `${RESUME_MASTER_URL}/api/apply/gate-packets?origin=${encodeURIComponent(batch.origin)}`,
    { credentials: 'include' })
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
