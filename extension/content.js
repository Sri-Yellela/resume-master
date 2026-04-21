function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function findText(root, selectors) {
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    const text = cleanText(el?.textContent || "");
    if (text) return text;
  }
  return "";
}

function dedupeByUrl(jobs) {
  const seen = new Set();
  return jobs.filter(job => {
    const key = job.jobUrl || `${job.title}|${job.company}|${job.location}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractLinkedInSavedJobs() {
  const path = window.location.pathname || "";
  if (!/saved-jobs|my-items\/saved-jobs/.test(path)) {
    return { ok: false, error: "Open LinkedIn Saved Jobs before importing." };
  }

  const links = Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'));
  const jobs = links.map(link => {
    const card = link.closest("li, .jobs-search-results__list-item, .scaffold-layout__list-item, .artdeco-list__item") || link.parentElement;
    const href = link.href || link.getAttribute("href") || "";
    const title = cleanText(link.textContent || "") || findText(card, [
      '[data-control-name*="job"]',
      '.job-card-list__title',
      '.jobs-save-button + div span',
    ]);
    const company = findText(card, [
      '.job-card-container__primary-description',
      '.artdeco-entity-lockup__subtitle',
      '.job-card-container__company-name',
    ]);
    const location = findText(card, [
      '.job-card-container__metadata-item',
      '.artdeco-entity-lockup__caption',
      '.job-card-container__metadata-wrapper li',
    ]);
    const postedAt = findText(card, [
      'time',
      '.job-card-container__footer-item',
      '.job-card-list__footer-wrapper',
    ]);
    return {
      externalJobId: (() => {
        const match = href.match(/\/jobs\/view\/(\d+)/);
        return match ? match[1] : "";
      })(),
      jobUrl: href,
      applyUrl: href,
      title,
      company,
      location,
      postedAt,
      sourcePlatform: "linkedin",
    };
  }).filter(job => job.title && job.jobUrl);

  return { ok: true, jobs: dedupeByUrl(jobs).slice(0, 250) };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "extract_linkedin_saved_jobs") {
    sendResponse(extractLinkedInSavedJobs());
  }
});
