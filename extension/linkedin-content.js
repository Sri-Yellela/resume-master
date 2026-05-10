/*
 * JOB DESCRIPTION EXTRACTOR - Resume Master Extension v1.1
 *
 * Reads only the VISIBLE job description text on job listing pages.
 * Activated only by user clicking the injected button or popup action.
 * Does NOT scrape profiles, user data, or any non-public information.
 * Does NOT run automatically or in the background.
 * Does NOT collect data without user interaction.
 */

(function () {
  if (document.getElementById('rm-send-btn')) return;

  const RESUME_MASTER_URL = 'https://resumemaster.one';

  const EXTRACTORS = {
    'linkedin.com':  () => trySelectors([
      '.jobs-description__content .jobs-box__html-content',
      '.jobs-description-content__text',
      '.job-view-layout',
    ]),
    'indeed.com':    () => trySelectors(['#jobDescriptionText']),
    'glassdoor.com': () => trySelectors(['.jobDescriptionContent']),
    'lever.co':      () => trySelectors(['.posting-description', '.section-wrapper']),
    'greenhouse.io': () => trySelectors(['#content .job__description', '#content']),
    'workable.com':  () => trySelectors(['.job-description']),
  };

  function trySelectors(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el?.innerText?.trim().length > 100) return el.innerText.trim();
    }
    const fallback = document.querySelector('main') || document.body;
    return fallback.innerText.slice(0, 6000).trim();
  }

  function getSiteKey() {
    return Object.keys(EXTRACTORS).find(k => window.location.hostname.includes(k));
  }

  function extractJobText() {
    const siteKey = getSiteKey();
    const extract = siteKey ? EXTRACTORS[siteKey] : () => trySelectors(['main']);
    return extract();
  }

  // Extract structured LinkedIn job data from the DOM
  function extractLinkedInJobData() {
    const title = (
      document.querySelector('.jobs-unified-top-card__job-title h1')?.innerText ||
      document.querySelector('.job-details-jobs-unified-top-card__job-title h1')?.innerText ||
      document.querySelector('h1.t-24')?.innerText ||
      document.title.replace(/ \| LinkedIn$/, '') ||
      ''
    ).trim();

    const company = (
      document.querySelector('.jobs-unified-top-card__company-name a')?.innerText ||
      document.querySelector('.job-details-jobs-unified-top-card__company-name a')?.innerText ||
      document.querySelector('.jobs-unified-top-card__company-name')?.innerText ||
      ''
    ).trim();

    const location = (
      document.querySelector('.jobs-unified-top-card__bullet')?.innerText ||
      document.querySelector('.job-details-jobs-unified-top-card__bullet')?.innerText ||
      ''
    ).trim();

    const workType = (
      document.querySelector('.jobs-unified-top-card__workplace-type')?.innerText ||
      document.querySelector('.job-details-jobs-unified-top-card__workplace-type')?.innerText ||
      ''
    ).trim();

    const description = extractJobText();

    // Extract LinkedIn job ID from URL  e.g. /jobs/view/1234567890/
    const jobIdMatch = window.location.pathname.match(/\/jobs\/view\/(\d+)/);
    const externalJobId = jobIdMatch ? jobIdMatch[1] : null;

    return {
      title,
      company,
      location,
      workType,
      description,
      jobUrl: window.location.href,
      externalJobId,
    };
  }

  function setButtonText(text, reset = true) {
    btn.textContent = text;
    if (reset) setTimeout(() => { btn.textContent = ' Send to Resume Master'; }, 2500);
  }

  function sendCurrentJob() {
    const jobText = extractJobText();
    if (!jobText || jobText.length < 80) {
      setButtonText('No job description found');
      return;
    }

    chrome.runtime.sendMessage({ type: 'OPEN_ATS_SCORE', jobText }, () => {
      btn.textContent = 'Opened in Resume Master';
      btn.style.background = '#437A22';
      setTimeout(() => {
        btn.textContent = ' Send to Resume Master';
        btn.style.background = '#01696F';
      }, 2500);
    });
  }

  async function saveJob() {
    const data = extractLinkedInJobData();
    if (!data.title || !data.company) {
      return { success: false, error: 'Could not extract job title or company' };
    }
    try {
      const res = await fetch(`${RESUME_MASTER_URL}/api/extension/save-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      });
      if (res.status === 401) return { success: false, error: 'Not logged in' };
      if (!res.ok) return { success: false, error: `Server error ${res.status}` };
      const json = await res.json();
      return { success: true, alreadySaved: json.alreadySaved || false };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  const btn = document.createElement('button');
  btn.id = 'rm-send-btn';
  btn.textContent = ' Send to Resume Master';
  Object.assign(btn.style, {
    position: 'fixed', bottom: '24px', right: '24px',
    zIndex: '2147483647',
    background: '#01696F', color: '#fff',
    border: 'none', borderRadius: '9999px',
    padding: '10px 20px', fontSize: '14px', fontWeight: '600',
    cursor: 'pointer', boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    transition: 'background 0.18s ease, transform 0.12s ease',
    lineHeight: '1.4',
  });

  btn.addEventListener('mouseenter', () => {
    btn.style.background = '#0C4E54';
    btn.style.transform = 'scale(1.03)';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.background = '#01696F';
    btn.style.transform = 'scale(1)';
  });
  btn.addEventListener('click', sendCurrentJob);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'EXTRACT_JOB_TEXT') {
      sendResponse({ jobText: extractJobText() });
      return true;
    }
    if (message.type === 'SEND_CURRENT_JOB') {
      sendCurrentJob();
      sendResponse({ success: true });
      return true;
    }
    if (message.type === 'GET_CURRENT_JOB') {
      sendResponse(extractLinkedInJobData());
      return true;
    }
    if (message.type === 'SAVE_JOB') {
      saveJob().then(sendResponse);
      return true; // async
    }
    return false;
  });

  document.body.appendChild(btn);
})();
