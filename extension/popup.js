// RESUME_MASTER_URL is defined by config.js, loaded before this script.

function setStatus(msg, timeout = 0) {
  document.getElementById('status').textContent = msg;
  if (timeout) setTimeout(() => setStatus(''), timeout);
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isLinkedInJobPage(url = '') {
  return /linkedin\.com\/jobs\/view\//.test(url);
}

function isJobPage(url = '') {
  return (
    isLinkedInJobPage(url) ||
    /indeed\.com\/viewjob/.test(url) ||
    /glassdoor\.com\/job-listing/.test(url) ||
    /lever\.co\/.+\/.+/.test(url) ||
    /greenhouse\.io/.test(url) ||
    /workable\.com\/j\//.test(url)
  );
}

function detectSource(url = '') {
  if (url.includes('indeed.com'))     return 'Indeed';
  if (url.includes('glassdoor.com'))  return 'Glassdoor';
  if (url.includes('lever.co'))       return 'Lever';
  if (url.includes('greenhouse.io'))  return 'Greenhouse';
  if (url.includes('workable.com'))   return 'Workable';
  return 'Direct';
}

function showJobPreview(jobData) {
  document.getElementById('preview-title').textContent = jobData.title || '';
  document.getElementById('preview-company').textContent =
    (jobData.company || '') + (jobData.location ? ' · ' + jobData.location : '');
  document.getElementById('job-preview').style.display = 'block';
  document.getElementById('btn-capture-job').style.display = 'flex';
}

let currentJobData = null;

// A hotkey capture (BYO-2) happens on the page in view, not the popup — there's nothing to
// show "live" in a popup that wasn't open at that moment. This shows the last result, if any,
// as a secondary/bonus status line whenever the popup happens to be opened afterward.
async function showLastCapture() {
  try {
    const { lastCapture } = await chrome.storage.local.get('lastCapture');
    const el = document.getElementById('last-capture');
    if (!el || !lastCapture) return;
    el.textContent = (lastCapture.success ? '✓ Captured: ' : '✗ ') + (lastCapture.message || '');
    el.className = 'result-text ' + (lastCapture.success ? 'success' : 'error');
    el.style.display = 'block';
  } catch (_) { /* storage unavailable */ }
}

// Asked via the service worker, not fetched here. A popup's fetch carries chrome-extension:// as
// its origin, which server.js's corsOrigin refuses in production — so this worked in development
// and would have shown "Sign in" to every production user, hiding the capture button entirely.
async function probeAuth() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'PROBE_AUTH' });
    return res?.authenticated === true;
  } catch (_) {
    return false;
  }
}

async function init() {
  const isAuthed = await probeAuth();

  if (!isAuthed) {
    document.getElementById('btn-sign-in').style.display = 'flex';
    setStatus('Sign in to capture jobs');
    return;
  }

  await showLastCapture();

  const tab = await getCurrentTab();
  if (!tab?.url) return;

  if (isLinkedInJobPage(tab.url) && tab.id) {
    // Query the content script for structured job data
    try {
      const jobData = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT_JOB' });
      if (jobData?.title && jobData?.company) {
        currentJobData = jobData;
        showJobPreview(currentJobData);
        setStatus('LinkedIn job detected');
      } else {
        setStatus('Job listing detected');
      }
    } catch (_) {
      setStatus('Job listing detected');
    }
  } else if (isJobPage(tab.url) && tab.id) {
    // Generic ATS sites — extract text + parse title from page title
    try {
      const textRes = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_JOB_TEXT' });
      const pageTitle = tab.title || '';
      const cleanTitle = pageTitle
        .replace(/\s*[-–—|]\s*(Indeed|Glassdoor|Workable|Greenhouse|Lever|Jobs).*$/i, '')
        .trim();
      const parts = cleanTitle.split(/\s+(?:at|@)\s+/i);

      currentJobData = {
        title:          parts[0]?.trim() || cleanTitle,
        company:        parts[1]?.trim() || '',
        location:       '',
        workType:       '',
        description:    textRes?.jobText || '',
        jobUrl:         tab.url,
        applyUrl:       tab.url,
        externalJobId:  null,
        salary:         null,
        postedDate:     null,
        companyLogo:    null,
        sourceLabel:    detectSource(tab.url),
      };

      if (currentJobData.title) {
        showJobPreview(currentJobData);
        setStatus(detectSource(tab.url) + ' job detected');
      } else {
        setStatus('Job listing detected');
      }
    } catch (_) {
      setStatus('Job listing detected');
    }
  } else if (/linkedin\.com\/in\//.test(tab.url)) {
    setStatus('LinkedIn profile page');
  }
}

// The SAME capture the hotkey runs — same message, same implementation, same destination, same
// wording. Previously this button called a second implementation that wrote to a different table
// with a different dedup identity, so "Save Job" and Ctrl+Shift+K were two features wearing one name.
document.getElementById('btn-capture-job').addEventListener('click', async () => {
  const btn = document.getElementById('btn-capture-job');
  btn.textContent = 'Capturing...';
  btn.disabled = true;

  try {
    const tab = await getCurrentTab();
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_AND_IMPORT' });
    // The message is produced once, in the service worker, so the popup cannot word the outcome
    // differently from the toast the page just showed.
    setStatus(result?.message || 'Capture failed — try again', 3000);
    if (result?.success) {
      btn.textContent = 'Captured';
    } else {
      btn.textContent = 'Capture job';
      btn.disabled = false;
    }
  } catch (e) {
    btn.textContent = 'Capture job';
    btn.disabled = false;
    setStatus('Could not reach the page — reload and try again', 3000);
  }
});

document.getElementById('btn-sign-in').addEventListener('click', () => {
  chrome.tabs.create({ url: `${RESUME_MASTER_URL}/login` });
  setTimeout(() => window.close(), 300);
});

document.getElementById('btn-resume').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'OPEN_RESUME_BUILDER' });
  setStatus('Opening...', 800);
  setTimeout(() => window.close(), 800);
});

document.getElementById('btn-linkedin').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'OPEN_LINKEDIN_IMPORT' });
  setStatus('Opening sign in...', 1000);
  setTimeout(() => window.close(), 900);
});

document.getElementById('btn-ats').addEventListener('click', async () => {
  const tab = await getCurrentTab();
  if (isJobPage(tab?.url) && tab?.id) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.body?.innerText?.slice(0, 6000) || '',
      });
      await chrome.runtime.sendMessage({ type: 'OPEN_ATS_SCORE', jobText: result || '' });
      setStatus('Sending to ATS Score...', 1000);
    } catch (_err) {
      await chrome.runtime.sendMessage({ type: 'OPEN_ATS_SCORE', jobText: '' });
    }
    setTimeout(() => window.close(), 900);
  } else {
    await chrome.tabs.create({ url: `${RESUME_MASTER_URL}/ats-score` });
    setTimeout(() => window.close(), 300);
  }
});

// ─── Settings (capture shortcut) ───────────────────────────────────────────

document.getElementById('btn-settings')?.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

init();
