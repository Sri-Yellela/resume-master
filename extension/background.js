const STORAGE_KEY = "rmExtensionState";
const APP_ORIGIN_CANDIDATES = [
  "http://localhost:3001",
  "http://127.0.0.1:3001",
];

let runtimeState = {
  appTabId: null,
  linkedInTabId: null,
  appUrl: null,
  lastImportRequest: null,
};

function defaultState() {
  return {
    status: "NOT_AUTHED",
    userEmail: null,
    importedCount: 0,
    error: "",
    appUrl: null,
    linkedInTabId: null,
  };
}

async function getState() {
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  return { ...defaultState(), ...(stored[STORAGE_KEY] || {}) };
}

async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ [STORAGE_KEY]: next });
  await broadcastToApp({ type: "EXTENSION_STATUS", state: next });
  return next;
}

async function withAppTabFetch(path, options = {}) {
  const appTabId = runtimeState.appTabId;
  if (!appTabId) throw new Error("Open Resume Master first.");
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(appTabId, { type: "APP_FETCH", path, options }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Request failed."));
        return;
      }
      resolve(response.data);
    });
  });
}

async function detectAppUrl() {
  if (runtimeState.appUrl) return runtimeState.appUrl;
  const state = await getState();
  if (state.appUrl) {
    runtimeState.appUrl = state.appUrl;
    return state.appUrl;
  }
  return APP_ORIGIN_CANDIDATES[0];
}

async function getSessionToken() {
  const appUrl = await detectAppUrl();
  const { hostname } = new URL(appUrl);
  const cookies = await chrome.cookies.getAll({ domain: hostname });
  const cookieMatch = cookies.find((cookie) =>
    /auth|session|connect\.sid/i.test(cookie.name || "") && cookie.value
  );
  if (cookieMatch?.value && !/^s%3A/i.test(cookieMatch.value)) {
    return cookieMatch.value;
  }
  const data = await withAppTabFetch("/api/auth/extension-token");
  if (!data?.token) throw new Error("Extension token unavailable.");
  return data.token;
}

async function getActiveProfile() {
  return withAppTabFetch("/api/auth/active-profile");
}

async function refreshConnectionState() {
  try {
    const me = await withAppTabFetch("/api/auth/me");
    if (!me?.authenticated) {
      return setState({ status: "NOT_AUTHED", userEmail: null, error: "" });
    }
    const token = await getSessionToken();
    if (!token) {
      return setState({ status: "NOT_AUTHED", userEmail: null, error: "" });
    }
    return setState({
      status: "READY",
      userEmail: me.user?.email || me.user?.username || "Resume Master user",
      error: "",
    });
  } catch {
    return setState({ status: "NOT_AUTHED", userEmail: null, error: "" });
  }
}

function buildLinkedInUrl({ targetRole = "", location = "" } = {}) {
  const params = new URLSearchParams();
  if (targetRole) params.set("keywords", targetRole);
  if (location) params.set("location", location);
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

async function broadcastToApp(payload) {
  if (!runtimeState.appTabId) return;
  try {
    await chrome.tabs.sendMessage(runtimeState.appTabId, payload);
  } catch {}
}

async function closeLinkedInTab(tabId) {
  if (!tabId) return;
  try { await chrome.tabs.remove(tabId); } catch {}
  if (runtimeState.linkedInTabId === tabId) runtimeState.linkedInTabId = null;
}

async function startLinkedInImport(payload = {}) {
  const status = await refreshConnectionState();
  if (status.status !== "READY") return { ok: false, state: status };

  const targetUrl = buildLinkedInUrl(payload);
  const tab = await chrome.tabs.create({ url: targetUrl, active: true });
  runtimeState.linkedInTabId = tab.id;
  runtimeState.lastImportRequest = payload;
  await setState({
    status: "IMPORTING",
    error: "",
    importedCount: 0,
    linkedInTabId: tab.id,
  });
  return { ok: true, tabId: tab.id };
}

chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({
    url: [
      "http://localhost:3001/*",
      "http://127.0.0.1:3001/*",
      "https://*.up.railway.app/*",
      "https://www.linkedin.com/jobs/*",
    ],
  });
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    if (tab.url.includes("linkedin.com/jobs/")) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["linkedin-content.js"] }).catch(() => {});
    } else {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["app-bridge.js"] }).catch(() => {});
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (runtimeState.linkedInTabId === tabId) runtimeState.linkedInTabId = null;
  if (runtimeState.appTabId === tabId) runtimeState.appTabId = null;
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (tabId !== runtimeState.linkedInTabId || info.status !== "complete" || !tab.url) return;
  if (tab.url.includes("linkedin.com/login") || tab.url.includes("linkedin.com/checkpoint")) {
    await setState({
      status: "ERROR",
      error: "Please log into LinkedIn in the opened tab, then click Import again.",
    });
    await broadcastToApp({ type: "LINKEDIN_LOGIN_REQUIRED", tabId });
    return;
  }
  if (tab.url.includes("linkedin.com/jobs/")) {
    chrome.tabs.sendMessage(tabId, { type: "SCRAPE_JOBS" }, () => void chrome.runtime.lastError);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "REGISTER_APP_TAB": {
        runtimeState.appTabId = sender.tab?.id || runtimeState.appTabId;
        runtimeState.appUrl = message.appUrl || runtimeState.appUrl;
        await setState({ appUrl: runtimeState.appUrl });
        const state = await refreshConnectionState();
        sendResponse({ ok: true, state });
        return;
      }
      case "GET_STATUS": {
        const state = await refreshConnectionState();
        sendResponse({ ok: true, state });
        return;
      }
      case "OPEN_APP": {
        const appUrl = await detectAppUrl();
        await chrome.tabs.create({ url: `${appUrl}/app` });
        sendResponse({ ok: true });
        return;
      }
      case "OPEN_POPUP": {
        if (chrome.action?.openPopup) {
          await chrome.action.openPopup().catch(() => {});
        }
        sendResponse({ ok: true });
        return;
      }
      case "CLEAR_EXTENSION_SESSION": {
        await chrome.storage.session.clear();
        await setState(defaultState());
        sendResponse({ ok: true });
        return;
      }
      case "START_LINKEDIN_IMPORT": {
        const result = await startLinkedInImport(message.payload || {});
        sendResponse(result);
        return;
      }
      case "RETRY_IMPORT": {
        if (!runtimeState.linkedInTabId) throw new Error("No LinkedIn tab to retry.");
        chrome.tabs.sendMessage(runtimeState.linkedInTabId, { type: "SCRAPE_JOBS" }, () => void chrome.runtime.lastError);
        await setState({ status: "IMPORTING", error: "" });
        sendResponse({ ok: true });
        return;
      }
      case "CLOSE_LINKEDIN_TAB": {
        await closeLinkedInTab(message.tabId || runtimeState.linkedInTabId);
        sendResponse({ ok: true });
        return;
      }
      case "GET_IMPORT_CONTEXT": {
        const token = await getSessionToken();
        const profile = await getActiveProfile();
        const appUrl = await detectAppUrl();
        sendResponse({ ok: true, token, profile, appUrl });
        return;
      }
      case "IMPORT_DONE": {
        const count = Number(message.count || 0);
        const state = await setState({ status: "DONE", importedCount: count, error: "" });
        await broadcastToApp({ type: "IMPORT_DONE", count, tabId: sender.tab?.id || runtimeState.linkedInTabId, state });
        sendResponse({ ok: true });
        return;
      }
      case "IMPORT_ERROR": {
        const error = message.error || "Import failed.";
        const state = await setState({ status: "ERROR", error });
        await broadcastToApp({ type: "IMPORT_ERROR", error, tabId: sender.tab?.id || runtimeState.linkedInTabId, state });
        sendResponse({ ok: true });
        return;
      }
      default:
        sendResponse({ ok: false, error: "Unsupported message" });
    }
  })().catch(async (error) => {
    const messageText = error?.message || "Extension request failed.";
    await setState({ status: "ERROR", error: messageText });
    sendResponse({ ok: false, error: messageText });
  });
  return true;
});
