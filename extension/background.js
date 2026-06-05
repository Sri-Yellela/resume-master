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
