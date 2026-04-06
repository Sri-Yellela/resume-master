// extension/popup.js
(async function () {
  const btnFill  = document.getElementById("btnFill");
  const statusEl = document.getElementById("status");
  const apiUrlEl = document.getElementById("apiUrl");
  const btnSave  = document.getElementById("btnSave");
  const modeBadge= document.getElementById("modeBadge");

  // Load saved URL and cached mode
  const stored = await chrome.storage.local.get(["apiBase", "autofillCache"]);
  if (stored.apiBase)              apiUrlEl.value   = stored.apiBase;
  if (stored.autofillCache?.mode)  modeBadge.textContent = stored.autofillCache.mode;

  btnSave.addEventListener("click", async () => {
    const url = apiUrlEl.value.trim();
    if (!url) return;
    await chrome.runtime.sendMessage({ type: "SET_API_BASE", value: url });
    setStatus("✓ URL saved, cache cleared", "ok");
  });

  btnFill.addEventListener("click", async () => {
    btnFill.disabled = true;
    setStatus("Fetching profile…", "loading");
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No active tab found.");

      const data = await chrome.runtime.sendMessage({ type: "GET_AUTOFILL" });
      if (data?.error) throw new Error(data.error);

      modeBadge.textContent = data.mode || "—";

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func:   fillPage,
        args:   [data],
      });

      const n = results?.[0]?.result ?? 0;
      setStatus(`✓ Filled ${n} field(s)`, "ok");
    } catch (e) {
      setStatus("✗ " + e.message, "err");
    } finally {
      btnFill.disabled = false;
    }
  });

  function setStatus(msg, cls) {
    statusEl.textContent = msg;
    statusEl.className   = "status " + (cls || "");
  }

  // Serialised and injected into the active tab
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

    Object.entries(fm).forEach(([name, value]) => {
      if (!value) return;
      document.querySelectorAll(
        `input[name="${name}"],input[id="${name}"],textarea[name="${name}"],textarea[id="${name}"],input[autocomplete="${name}"]`
      ).forEach(el => {
        if (["hidden","submit","button","file","image"].includes(el.type)) return;
        setVal(el, value); filled++;
      });
    });

    Object.entries(ddm).forEach(([key, vals]) => {
      if (!vals?.length) return;
      document.querySelectorAll(`select[name="${key}"],select[id="${key}"]`).forEach(sel => {
        for (const opt of sel.options) {
          if (vals.some(v => opt.text.toLowerCase().includes(v.toLowerCase()))) {
            sel.value = opt.value; sel.dispatchEvent(new Event("change",{bubbles:true})); filled++; break;
          }
        }
      });
    });

    document.querySelectorAll("input[type='radio']").forEach(r => {
      const n=(r.name||"").toLowerCase(), v=(r.value||"").toLowerCase();
      const lbl=(r.labels?.[0]?.textContent||"").toLowerCase();
      if (n.includes("sponsor")||lbl.includes("sponsor")) {
        const yes=fm.requires_sponsorship==="Yes";
        if ((yes&&(v==="yes"||v==="true"))||(!yes&&(v==="no"||v==="false"))) {
          r.checked=true; r.dispatchEvent(new Event("change",{bubbles:true})); filled++;
        }
      }
    });

    return filled;
  }
})();
