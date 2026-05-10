const RESUME_MASTER_URL = 'https://resumemaster.one';

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

let currentJobData = null;

async function init() {
  const tab = await getCurrentTab();
  if (!tab?.url) return;

  if (isLinkedInJobPage(tab.url) && tab.id) {
    // Query the content script for structured job data
    try {
      const jobData = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT_JOB' });
      if (jobData?.title && jobData?.company) {
        currentJobData = jobData;
        document.getElementById('preview-title').textContent = jobData.title;
        document.getElementById('preview-company').textContent = jobData.company + (jobData.location ? ' · ' + jobData.location : '');
        document.getElementById('job-preview').style.display = 'block';
        document.getElementById('btn-save-job').style.display = 'flex';
        setStatus('LinkedIn job detected');
      } else {
        setStatus('Job listing detected');
      }
    } catch (_) {
      setStatus('Job listing detected');
    }
  } else if (isJobPage(tab.url)) {
    setStatus('Job listing detected');
  } else if (/linkedin\.com\/in\//.test(tab.url)) {
    setStatus('LinkedIn profile page');
  }
}

document.getElementById('btn-save-job').addEventListener('click', async () => {
  if (!currentJobData) return;
  const btn = document.getElementById('btn-save-job');
  btn.textContent = 'Saving...';
  btn.disabled = true;

  try {
    const tab = await getCurrentTab();
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'SAVE_JOB' });
    if (result?.success) {
      btn.textContent = result.alreadySaved ? 'Already saved' : 'Saved!';
      setStatus(result.alreadySaved ? 'Already in your list' : 'Job saved to Resume Master', 2000);
    } else {
      btn.textContent = 'Save Job';
      btn.disabled = false;
      setStatus(result?.error === 'Not logged in'
        ? 'Sign in to Resume Master first'
        : 'Save failed — try again', 3000);
    }
  } catch (e) {
    btn.textContent = 'Save Job';
    btn.disabled = false;
    setStatus('Error: ' + (e.message || 'unknown'), 3000);
  }
});

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
