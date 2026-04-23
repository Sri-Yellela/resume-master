const REQUEST_EVENT = "rm-extension:request";
const RESPONSE_EVENT = "rm-extension:event";
const INSTALL_URL = "https://chromewebstore.google.com/";

export function getLinkedInExtensionInstallUrl() {
  return INSTALL_URL;
}

export function isLinkedInExtensionInstalled() {
  return typeof document !== "undefined"
    && !!document.body
    && document.body.hasAttribute("data-jobapp-extension");
}

export function sendExtensionRequest(payload, timeoutMs = 10000) {
  if (!isLinkedInExtensionInstalled()) {
    return Promise.reject(new Error("LinkedIn extension is not installed."));
  }
  return new Promise((resolve, reject) => {
    const requestId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const timeout = setTimeout(() => {
      window.removeEventListener(RESPONSE_EVENT, onEvent);
      reject(new Error("Extension request timed out."));
    }, timeoutMs);

    function onEvent(event) {
      if (event.detail?.requestId !== requestId) return;
      clearTimeout(timeout);
      window.removeEventListener(RESPONSE_EVENT, onEvent);
      if (!event.detail?.ok) {
        reject(new Error(event.detail?.error || "Extension request failed."));
        return;
      }
      resolve(event.detail?.payload || {});
    }

    window.addEventListener(RESPONSE_EVENT, onEvent);
    window.dispatchEvent(new CustomEvent(REQUEST_EVENT, {
      detail: { requestId, payload },
    }));
  });
}

export function subscribeToExtensionEvents(handler) {
  function onEvent(event) {
    if (!event.detail?.payload?.type) return;
    handler(event.detail.payload);
  }
  window.addEventListener(RESPONSE_EVENT, onEvent);
  return () => window.removeEventListener(RESPONSE_EVENT, onEvent);
}
