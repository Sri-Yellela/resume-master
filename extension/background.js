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
  if (command !== 'capture-job') return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_AND_IMPORT' }, () => {
      // Ignore "no receiving end" errors — happens on pages with no content script injected.
      void chrome.runtime.lastError;
    });
  });
});
