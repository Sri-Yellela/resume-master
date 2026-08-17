import {
  runGatedHandoff, clearPacketForTab, sweepExpiredPackets,
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

  const badge = result.ok ? { text: String(result.filled.length), color: '#16a34a' }
                          : { text: '!', color: '#dc2626' };
  try {
    await chrome.action.setBadgeText({ tabId: tab?.id, text: badge.text });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab?.id, color: badge.color });
    await chrome.action.setTitle({ tabId: tab?.id, title: result.message || 'Resume Master' });
  } catch { /* a tab that closed mid-handoff is not an error worth surfacing */ }

  // Stored so the popup can render the detail the badge cannot. G3 replaces this with the in-page
  // provenance overlay; until then it is the only way to see WHICH fields were filled and why.
  try {
    await chrome.storage.session.set({ lastGatedHandoff: { ...result, at: Date.now(), tabId: tab?.id } });
  } catch { /* session storage is best-effort here */ }

  return result;
}

// The packet outlives its activeTab grant (G0 §9 measured this), so nothing expires it on its own.
// A closed tab is the one unambiguous signal that its handoff is over.
chrome.tabs.onRemoved.addListener((tabId) => { void clearPacketForTab(tabId); });

// And a sweep for the rest: a handoff the candidate walked away from leaves a packet holding a home
// address in session storage until the browser restarts. onStartup/onInstalled plus every invocation
// is enough to keep that bounded without a polling alarm.
chrome.runtime.onStartup?.addListener(() => { void sweepExpiredPackets(); });
chrome.runtime.onInstalled?.addListener(() => { void sweepExpiredPackets(); });
