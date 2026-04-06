// extension/content.js — Injected on every page
// Detects ATS platform, maps label-based fields, watches next/continue buttons
// to re-trigger fill on multi-step forms.

(function () {
  "use strict";

  const hostname = window.location.hostname.toLowerCase();

  const ATS_MAP = {
    "greenhouse.io":      "greenhouse",
    "boards.greenhouse":  "greenhouse",
    "jobs.lever.co":      "lever",
    "lever.co":           "lever",
    "myworkdayjobs.com":  "workday",
    "workday.com":        "workday",
    "icims.com":          "icims",
    "jobs.icims.com":     "icims",
    "linkedin.com":       "linkedin",
    "taleo.net":          "taleo",
  };

  let detectedATS = null;
  for (const [pattern, ats] of Object.entries(ATS_MAP)) {
    if (hostname.includes(pattern)) { detectedATS = ats; break; }
  }

  // Listen for fill requests from background/popup
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "AUTOFILL_PAGE") {
      performFill(msg.data).then(n => sendResponse({ filled: n }));
      return true;
    }
  });

  // Watch next/continue buttons and re-trigger fill after page transitions
  const NEXT_RE = /^(next|continue|proceed|save and continue|save & continue|next step)/i;

  function watchNextButtons() {
    document.querySelectorAll("button, input[type='button'], input[type='submit'], a[role='button']").forEach(el => {
      const text = (el.textContent || el.value || "").trim();
      if (!NEXT_RE.test(text)) return;
      el.addEventListener("click", () => {
        setTimeout(() => chrome.runtime.sendMessage({ type: "TRIGGER_FILL" }), 1500);
      }, { once: true });
    });
  }

  // MutationObserver: re-watch on DOM changes (SPA navigation)
  const observer = new MutationObserver(() => watchNextButtons());
  observer.observe(document.body, { childList: true, subtree: true });
  watchNextButtons();

  // ATS-specific label → field name mappers
  function getATSLabelMap() {
    const maps = {
      greenhouse: {
        "First Name": "first_name", "Last Name": "last_name",
        "Email": "email", "Phone": "phone",
        "LinkedIn": "linkedin_url", "GitHub": "github_url",
        "Website": "github_url", "City": "city",
        "State": "state", "Zip": "zip", "Location": "location",
      },
      lever: {
        "Full name": "full_name", "Email address": "email",
        "Phone": "phone", "LinkedIn": "linkedin_url",
        "GitHub": "github_url", "Location": "location",
      },
      workday: {
        "First Name": "first_name", "Last Name": "last_name",
        "Email": "email", "Phone Number": "phone",
        "Address Line 1": "address_line1", "Address Line 2": "address_line2",
        "City": "city", "State": "state", "Postal Code": "zip",
        "LinkedIn URL": "linkedin_url",
      },
      icims: {
        "First Name": "first_name", "Last Name": "last_name",
        "Email": "email", "Phone": "phone",
        "City": "city", "State": "state", "Zip": "zip",
      },
      linkedin: {
        "First name": "first_name", "Last name": "last_name",
        "Email address": "email", "Mobile phone number": "phone",
        "City": "city", "LinkedIn profile URL": "linkedin_url",
      },
      taleo: {
        "First Name": "first_name", "Last Name": "last_name",
        "Email": "email", "Phone": "phone",
        "Address": "address_line1", "City": "city",
        "State": "state", "Zip Code": "zip",
      },
    };
    return maps[detectedATS] || {};
  }

  // Build a map of { elementId → field_key } from label elements
  function buildLabelMap(labelMap) {
    const result = {};
    document.querySelectorAll("label").forEach(lbl => {
      const text = lbl.textContent.trim();
      const key  = Object.keys(labelMap).find(k => text.toLowerCase().includes(k.toLowerCase()));
      if (!key || !labelMap[key]) return;
      const forId = lbl.getAttribute("for");
      if (forId) result[forId] = labelMap[key];
    });
    return result;
  }

  function setNativeValue(el, value) {
    try {
      const proto  = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, value); else el.value = value;
    } catch { el.value = value; }
    ["input", "change", "blur"].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
  }

  async function performFill(autofillData) {
    if (!autofillData?.field_map) return 0;
    const fm     = autofillData.field_map;
    const ddm    = autofillData.dropdown_map || {};
    const atsMap = buildLabelMap(getATSLabelMap());
    let filled   = 0;

    // Generic name/id fill
    Object.entries(fm).forEach(([name, value]) => {
      if (!value) return;
      document.querySelectorAll(
        `input[name="${name}"],input[id="${name}"],textarea[name="${name}"],textarea[id="${name}"],input[autocomplete="${name}"]`
      ).forEach(el => {
        if (["hidden","submit","button","file"].includes(el.type)) return;
        setNativeValue(el, value); filled++;
      });
    });

    // ATS label-based fill
    Object.entries(atsMap).forEach(([elId, fieldKey]) => {
      if (!fieldKey || !fm[fieldKey]) return;
      const el = document.getElementById(elId) || document.querySelector(`[name="${elId}"]`);
      if (!el) return;
      setNativeValue(el, fm[fieldKey]); filled++;
    });

    // Dropdowns
    Object.entries(ddm).forEach(([key, matchValues]) => {
      if (!matchValues?.length) return;
      document.querySelectorAll(`select[name="${key}"],select[id="${key}"]`).forEach(sel => {
        for (const opt of sel.options) {
          if (matchValues.some(v => opt.text.toLowerCase().includes(v.toLowerCase()))) {
            sel.value = opt.value; sel.dispatchEvent(new Event("change",{bubbles:true})); filled++; break;
          }
        }
      });
    });

    // Radio: sponsorship and clearance
    document.querySelectorAll("input[type='radio']").forEach(r => {
      const n = (r.name||"").toLowerCase(), v = (r.value||"").toLowerCase();
      const lbl = (r.labels?.[0]?.textContent||"").toLowerCase();
      if (n.includes("sponsor")||lbl.includes("sponsor")) {
        const yes = fm.requires_sponsorship === "Yes";
        if ((yes&&(v==="yes"||v==="true"))||(!yes&&(v==="no"||v==="false"))) {
          r.checked=true; r.dispatchEvent(new Event("change",{bubbles:true})); filled++;
        }
      }
      if (n.includes("clearance")||lbl.includes("clearance")) {
        const yes = fm.has_clearance === "Yes";
        if ((yes&&(v==="yes"||v==="true"))||(!yes&&(v==="no"||v==="false"))) {
          r.checked=true; r.dispatchEvent(new Event("change",{bubbles:true})); filled++;
        }
      }
    });

    return filled;
  }
})();
