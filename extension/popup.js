const baseUrlInput = document.getElementById("baseUrl");
const tokenInput = document.getElementById("token");
const importBtn = document.getElementById("importBtn");
const statusEl = document.getElementById("status");

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#991b1b" : "#0f172a";
}

async function loadPrefs() {
  const stored = await chrome.storage.local.get(["rmBaseUrl", "rmImportToken"]);
  if (stored.rmBaseUrl) baseUrlInput.value = stored.rmBaseUrl;
  if (stored.rmImportToken) tokenInput.value = stored.rmImportToken;
}

async function savePrefs() {
  await chrome.storage.local.set({
    rmBaseUrl: baseUrlInput.value.trim(),
    rmImportToken: tokenInput.value.trim(),
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function extractJobs(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: "extract_linkedin_saved_jobs" }, response => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Could not extract jobs from the page."));
        return;
      }
      resolve(response.jobs || []);
    });
  });
}

async function importJobs() {
  const baseUrl = baseUrlInput.value.trim().replace(/\/+$/, "");
  const token = tokenInput.value.trim();
  if (!baseUrl) return setStatus("Resume Master URL is required.", true);
  if (!token) return setStatus("Import token is required.", true);

  const tab = await getActiveTab();
  if (!tab?.id || !tab.url?.includes("linkedin.com")) {
    return setStatus("Open the LinkedIn saved-jobs page in the active tab first.", true);
  }

  importBtn.disabled = true;
  setStatus("Reading LinkedIn saved jobs…");
  try {
    await savePrefs();
    const jobs = await extractJobs(tab.id);
    if (!jobs.length) throw new Error("No saved jobs found on the active LinkedIn page.");

    setStatus(`Found ${jobs.length} saved jobs. Importing…`);
    const response = await fetch(`${baseUrl}/api/import-sources/linkedin-saved/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-RM-Import-Token": token,
      },
      body: JSON.stringify({ jobs }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Import failed.");
    setStatus(`Import complete.\nInserted: ${payload.inserted || 0}\nUpdated: ${payload.updated || 0}\nSkipped: ${payload.skipped || 0}`);
  } catch (error) {
    setStatus(error.message || "Import failed.", true);
  } finally {
    importBtn.disabled = false;
  }
}

importBtn.addEventListener("click", () => { importJobs(); });
loadPrefs();
