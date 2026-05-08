const RESUME_MASTER_URL = 'https://YOUR_DOMAIN.com';

function setStatus(msg, timeout = 0) {
  document.getElementById('status').textContent = msg;
  if (timeout) setTimeout(() => setStatus(''), timeout);
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isJobPage(url = '') {
  return (
    /linkedin\.com\/jobs\/view\//.test(url) ||
    /indeed\.com\/viewjob/.test(url) ||
    /glassdoor\.com\/job-listing/.test(url) ||
    /lever\.co\/.+\/.+/.test(url) ||
    /greenhouse\.io/.test(url) ||
    /workable\.com\/j\//.test(url)
  );
}

async function init() {
  const tab = await getCurrentTab();
  if (isJobPage(tab?.url)) {
    setStatus('Job listing detected');
  } else if (/linkedin\.com\/in\//.test(tab?.url)) {
    setStatus('LinkedIn profile page');
  }
}

document.getElementById('btn-resume').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'OPEN_RESUME_BUILDER' });
  setStatus('Opening...', 800);
  setTimeout(() => window.close(), 800);
});

document.getElementById('btn-linkedin').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'OPEN_LINKEDIN_IMPORT' });
  setStatus('Opening LinkedIn login...', 1000);
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

init();
