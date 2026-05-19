'use strict';

/*
 * SAVED JOBS SCRAPER - Resume Master Extension v1.1
 *
 * Runs only on linkedin.com/my-items/saved-jobs when triggered by user.
 * Reads only VISIBLE DOM — no cookies, no li_at, no session data accessed.
 * User is already logged in and browsing their own saved jobs page.
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SCRAPE_SAVED_JOBS') {
    scrapeSavedJobs()
      .then(jobs => sendResponse({ success: true, jobs }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // async response
  }
  if (msg.type === 'GET_SAVED_JOB_COUNT') {
    sendResponse({ count: getSavedJobCount() });
  }
});

function getSavedJobCount() {
  const heading = document.querySelector(
    '.my-items__count, .artdeco-tabpanel h2, ' +
    '[data-test-saved-jobs-count], .saved-jobs__count'
  );
  if (heading) {
    const match = heading.textContent.match(/(\d+)/);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

async function scrapeSavedJobs() {
  const jobs = [];
  const seen = new Set();

  // Scroll to load all infinite-scroll items
  await scrollToLoadAll();

  // Try multiple card selector strategies
  const cardSelectors = [
    '.jobs-save-button__job-card',
    '.job-card-container',
    '.job-card-list__entity-lockup',
    '[data-job-id]',
    '.scaffold-layout__list-item',
  ];

  let cards = [];
  for (const sel of cardSelectors) {
    cards = Array.from(document.querySelectorAll(sel));
    if (cards.length > 0) break;
  }

  // Fallback: walk up from job links
  if (cards.length === 0) {
    const links = Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'));
    cards = links.map(a => a.closest('li, article, div[class*="card"]') || a);
    // Dedupe in case multiple links point to same card element
    cards = [...new Set(cards)];
  }

  for (const card of cards) {
    try {
      const job = extractJobFromCard(card);
      if (job && job.jobUrl && !seen.has(job.jobUrl)) {
        seen.add(job.jobUrl);
        jobs.push(job);
      }
    } catch (e) {
      console.warn('[RM] Failed to extract job from card:', e.message);
    }
  }

  return jobs;
}

function extractJobFromCard(card) {
  // Title
  const titleEl = card.querySelector([
    '.job-card-list__title',
    '.job-card-container__link span[aria-hidden="true"]',
    'a[href*="/jobs/view/"] span[aria-hidden="true"]',
    '.artdeco-entity-lockup__title span',
    'strong',
    'h3',
  ].join(','));
  const title = titleEl?.textContent?.trim() || '';

  // Company
  const companyEl = card.querySelector([
    '.job-card-container__primary-description',
    '.job-card-container__company-name',
    '.artdeco-entity-lockup__subtitle span',
    '.job-card-list__company-name',
  ].join(','));
  const company = companyEl?.textContent?.trim() || '';

  // Location
  const locationEl = card.querySelector([
    '.job-card-container__metadata-item',
    '.artdeco-entity-lockup__caption span',
    '.job-card-container__metadata-wrapper li:first-child',
  ].join(','));
  const location = locationEl?.textContent?.trim() || '';

  // Job URL — strip tracking params, keep only origin + pathname
  const linkEl = card.querySelector('a[href*="/jobs/view/"]') ||
    (card.tagName === 'A' && card.href?.includes('/jobs/view/') ? card : null);
  const rawHref = linkEl?.href || '';
  let jobUrl = '';
  try {
    const u = new URL(rawHref);
    jobUrl = u.origin + u.pathname;
  } catch (_) {
    jobUrl = rawHref;
  }

  const idMatch = jobUrl.match(/\/jobs\/view\/(\d+)/);
  const externalJobId = idMatch ? idMatch[1] : null;

  // Company logo
  const logoEl = card.querySelector(
    'img.artdeco-entity-image, img[class*="entity-image"]'
  );
  const companyLogo = (logoEl?.src && !logoEl.src.includes('ghost'))
    ? logoEl.src : null;

  // Saved / posted date
  const savedDateEl = card.querySelector([
    '.job-card-list__footer-wrapper time',
    '.job-card-container__footer-item time',
    '[aria-label*="ago"]',
    '[aria-label*="Saved"]',
  ].join(','));
  const postedDate = savedDateEl?.textContent?.trim() ||
    savedDateEl?.getAttribute('aria-label')?.trim() || null;

  if (!title && !company) return null;

  return {
    title,
    company,
    location,
    jobUrl,
    applyUrl:       jobUrl,
    externalJobId,
    companyLogo,
    postedDate,
    salary:         null,
    workType:       '',
    description:    '',
    sourceLabel:    'LinkedIn Saved',
  };
}

async function scrollToLoadAll(maxScrolls = 20, delayMs = 1200) {
  let prevHeight = 0;
  let unchanged  = 0;
  let scrollCount = 0;

  while (scrollCount < maxScrolls && unchanged < 2) {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, delayMs));

    const newHeight = document.body.scrollHeight;
    if (newHeight === prevHeight) {
      unchanged++;
    } else {
      unchanged = 0;
    }
    prevHeight = newHeight;
    scrollCount++;
  }

  window.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 400));
}
