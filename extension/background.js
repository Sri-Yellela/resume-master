// extension/background.js — Service worker
// Fetches autofill data from Resume Master, caches it, relays to content scripts.

const DEFAULT_API_BASE = "http://localhost:3001";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_AUTOFILL") {
    getAutofillData().then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "SET_API_BASE") {
    chrome.storage.local.set({ apiBase: msg.value, autofillCache: null, cacheTime: null })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "TRIGGER_FILL") {
    // Re-trigger fill on the same tab (called by content.js on next/continue click)
    getAutofillData().then(data => {
      if (!sender.tab?.id) return;
      chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        func:   fillPage,
        args:   [data],
      }).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e.message }));
    });
    return true;
  }
});

async function getAutofillData() {
  const stored = await chrome.storage.local.get(["autofillCache", "cacheTime", "apiBase"]);
  const base   = stored.apiBase || DEFAULT_API_BASE;
  const now    = Date.now();
  if (stored.autofillCache && stored.cacheTime && (now - stored.cacheTime) < 5 * 60 * 1000) {
    return stored.autofillCache;
  }
  const r = await fetch(`${base}/api/extension/autofill`, { credentials: "include" });
  if (!r.ok) throw new Error("Not authenticated — open Resume Master and log in first.");
  const data = await r.json();
  await chrome.storage.local.set({ autofillCache: data, cacheTime: now });
  return data;
}

// Injected into active tab by popup.js and TRIGGER_FILL relay
function fillPage(autofillData) {
  if (!autofillData?.field_map) return 0;
  const fm  = autofillData.field_map;
  const ddm = autofillData.dropdown_map || {};
  let filled = 0;

  function setVal(el, value) {
    try {
      const proto  = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, value); else el.value = value;
    } catch { el.value = value; }
    ["input", "change", "blur"].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
  }

  // Text inputs and textareas
  Object.entries(fm).forEach(([name, value]) => {
    if (!value) return;
    const sel = [
      `input[name="${name}"]`, `input[id="${name}"]`,
      `textarea[name="${name}"]`, `textarea[id="${name}"]`,
      `input[autocomplete="${name}"]`,
    ].join(",");
    document.querySelectorAll(sel).forEach(el => {
      if (["hidden","submit","button","file","image"].includes(el.type)) return;
      setVal(el, value); filled++;
    });
  });

  // Select dropdowns
  Object.entries(ddm).forEach(([key, matchValues]) => {
    if (!matchValues?.length) return;
    document.querySelectorAll(`select[name="${key}"],select[id="${key}"]`).forEach(sel => {
      for (const opt of sel.options) {
        if (matchValues.some(v => opt.text.toLowerCase().includes(v.toLowerCase()) || opt.value.toLowerCase().includes(v.toLowerCase()))) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          filled++; break;
        }
      }
    });
  });

  // Radio buttons: sponsorship and clearance
  document.querySelectorAll("input[type='radio']").forEach(r => {
    const n = (r.name || "").toLowerCase();
    const v = (r.value || "").toLowerCase();
    const lbl = (r.labels?.[0]?.textContent || "").toLowerCase();
    if (n.includes("sponsor") || lbl.includes("sponsor")) {
      const yes = fm.requires_sponsorship === "Yes";
      if ((yes && (v==="yes"||v==="true")) || (!yes && (v==="no"||v==="false"))) {
        r.checked = true; r.dispatchEvent(new Event("change",{bubbles:true})); filled++;
      }
    }
    if (n.includes("clearance") || lbl.includes("clearance")) {
      const yes = fm.has_clearance === "Yes";
      if ((yes && (v==="yes"||v==="true")) || (!yes && (v==="no"||v==="false"))) {
        r.checked = true; r.dispatchEvent(new Event("change",{bubbles:true})); filled++;
      }
    }
  });

  return filled;
}
