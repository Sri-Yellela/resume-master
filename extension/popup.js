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

function isSavedJobsPage(url = '') {
  return /linkedin\.com\/my-items/.test(url);
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
  document.getElementById('btn-save-job').style.display = 'flex';
}

let currentJobData = null;

async function probeAuth() {
  try {
    const res = await fetch(`${RESUME_MASTER_URL}/api/auth/me`, { credentials: 'include' });
    if (!res.ok) return false;
    const data = await res.json();
    return data.authenticated === true;
  } catch (_) {
    return false;
  }
}

async function init() {
  const isAuthed = await probeAuth();

  if (!isAuthed) {
    document.getElementById('btn-sign-in').style.display = 'flex';
    setStatus('Sign in to save and import jobs');
    return;
  }

  const tab = await getCurrentTab();
  if (!tab?.url) return;

  // Show Import Saved Jobs section only on the saved jobs page
  const savedSection = document.getElementById('saved-jobs-section');
  if (savedSection) {
    savedSection.style.display = isSavedJobsPage(tab.url) ? 'block' : 'none';
  }

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
  } else if (isSavedJobsPage(tab.url)) {
    setStatus('LinkedIn saved jobs page');
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

// ─── Import Saved Jobs handler ─────────────────────────────────────────────

document.getElementById('btn-import-saved')?.addEventListener('click', async () => {
  const btn      = document.getElementById('btn-import-saved');
  const progress = document.getElementById('import-progress');
  const fill     = document.getElementById('import-progress-fill');
  const text     = document.getElementById('import-progress-text');
  const result   = document.getElementById('import-result');

  btn.disabled     = true;
  btn.textContent  = 'Scanning saved jobs…';
  progress.style.display = 'block';
  result.style.display   = 'none';
  fill.style.width = '5%';
  text.textContent = 'Scrolling to load all saved jobs…';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const scrapeRes = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_SAVED_JOBS' });
    if (!scrapeRes.success) throw new Error(scrapeRes.error);

    const jobs = scrapeRes.jobs;
    fill.style.width = '40%';
    text.textContent = `Found ${jobs.length} saved jobs. Importing…`;

    if (jobs.length === 0) {
      throw new Error("No saved jobs found. Make sure you're on linkedin.com/my-items/saved-jobs");
    }

    const BATCH = 20;
    let imported = 0;
    let skipped  = 0;

    for (let i = 0; i < jobs.length; i += BATCH) {
      const batch = jobs.slice(i, i + BATCH);
      const pct = 40 + Math.round((i / jobs.length) * 55);
      fill.style.width = pct + '%';
      text.textContent = `Importing ${Math.min(i + BATCH, jobs.length)} of ${jobs.length}…`;

      try {
        const res = await fetch(`${RESUME_MASTER_URL}/api/extension/save-jobs-bulk`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobs: batch }),
        });
        if (res.ok) {
          const data = await res.json();
          imported += data.imported || 0;
          skipped  += data.skipped  || 0;
        } else if (res.status === 401) {
          throw new Error('Sign in to Resume Master first');
        }
      } catch (batchErr) {
        if (batchErr.message.includes('Sign in')) throw batchErr;
        console.warn('[RM] Batch failed:', batchErr.message);
      }
    }

    fill.style.width = '100%';
    text.textContent = 'Done!';
    result.className = 'result-text success';
    result.textContent = `✓ Imported ${imported} jobs` +
      (skipped > 0 ? ` (${skipped} already saved)` : '');
    result.style.display = 'block';

  } catch (e) {
    result.className = 'result-text error';
    result.textContent = '✗ ' + (e.message || 'Import failed');
    result.style.display = 'block';
    if (text) text.textContent = '';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Import Saved Jobs from LinkedIn';
    setTimeout(() => { progress.style.display = 'none'; }, 4000);
  }
});

init();
