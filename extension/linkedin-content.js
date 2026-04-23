function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function dedupeByUrl(jobs) {
  const seen = new Set();
  return jobs.filter((job) => {
    const key = job.jobUrl || `${job.title}|${job.company}|${job.location}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findText(root, selectors) {
  for (const selector of selectors) {
    const text = cleanText(root.querySelector(selector)?.textContent || "");
    if (text) return text;
  }
  return "";
}

function scrapeVisibleLinkedInJobs() {
  const cards = Array.from(document.querySelectorAll("li .job-card-container, .jobs-search-results__list-item, .scaffold-layout__list-item"));
  const jobs = cards.map((card) => {
    const link = card.querySelector('a[href*="/jobs/view/"]');
    const href = link?.href || link?.getAttribute("href") || "";
    const title = findText(card, [
      ".job-card-list__title",
      ".job-card-container__link",
      ".artdeco-entity-lockup__title span",
    ]);
    const company = findText(card, [
      ".artdeco-entity-lockup__subtitle",
      ".job-card-container__primary-description",
      ".job-card-container__company-name",
    ]);
    const location = findText(card, [
      ".job-card-container__metadata-item",
      ".artdeco-entity-lockup__caption",
      ".job-card-container__metadata-wrapper li",
    ]);
    const postedAt = findText(card, ["time", ".job-card-container__footer-item"]);
    const jobIdMatch = href.match(/\/jobs\/view\/(\d+)/);
    return {
      externalJobId: jobIdMatch ? jobIdMatch[1] : "",
      jobUrl: href,
      applyUrl: href,
      title,
      company,
      location,
      postedAt,
      sourcePlatform: "linkedin",
    };
  }).filter((job) => job.title && job.jobUrl);
  return dedupeByUrl(jobs).slice(0, 250);
}

async function importJobs() {
  const jobs = scrapeVisibleLinkedInJobs();
  if (!jobs.length) throw new Error("No LinkedIn jobs found on this page.");

  const context = await chrome.runtime.sendMessage({ type: "GET_IMPORT_CONTEXT" });
  if (!context?.ok || !context.token || !context.appUrl) {
    throw new Error(context?.error || "Extension is not connected to Resume Master.");
  }

  const response = await fetch(`${context.appUrl}/api/jobs/import`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${context.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jobs,
      source: "linkedin",
      profileId: context.profile?.profileId || null,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "LinkedIn import failed.");

  await chrome.runtime.sendMessage({ type: "IMPORT_DONE", count: Number(payload.imported || 0) });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "SCRAPE_JOBS") return false;
  importJobs()
    .then(() => sendResponse({ ok: true }))
    .catch(async (error) => {
      await chrome.runtime.sendMessage({ type: "IMPORT_ERROR", error: error.message || "Import failed." });
      sendResponse({ ok: false, error: error.message || "Import failed." });
    });
  return true;
});
