const REQUEST_EVENT = "rm-extension:request";
const RESPONSE_EVENT = "rm-extension:event";

function ensureMarker() {
  if (document.body) {
    document.body.setAttribute("data-jobapp-extension", "true");
    return;
  }
  requestAnimationFrame(ensureMarker);
}

function dispatchToPage(detail) {
  window.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail }));
}

async function fetchAppJson(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    credentials: "include",
    headers: options.headers || {},
    body: options.body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

ensureMarker();

chrome.runtime.sendMessage({
  type: "REGISTER_APP_TAB",
  appUrl: window.location.origin,
});

window.addEventListener(REQUEST_EVENT, (event) => {
  const requestId = event.detail?.requestId;
  chrome.runtime.sendMessage(event.detail?.payload, (response) => {
    const err = chrome.runtime.lastError;
    dispatchToPage({
      requestId,
      ok: !err && !!response?.ok,
      error: err?.message || response?.error || null,
      payload: response || null,
    });
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "APP_FETCH") {
    fetchAppJson(message.path, message.options)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Request failed." }));
    return true;
  }
  dispatchToPage({ payload: message });
  sendResponse?.({ ok: true });
  return false;
});
