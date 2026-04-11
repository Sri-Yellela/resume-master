// services/applyAutomation.js — Server-side Playwright apply automation
// Replaces the Chrome extension form-fill logic with a Node.js service.
//
// autoApply(jobUrl, autofillData, options) — main entry point
//   options.mode: 'full'  = headless, auto-submit after fill
//               | 'semi'  = visible browser, form pre-filled, user reviews/submits
//   options.platform:        override ATS detection
//   options.resumePath:      absolute path to PDF resume for upload
//   options.storageStatePath: saved session state file

import { chromium } from "playwright";
import path  from "path";
import fs    from "fs";
import { fileURLToPath } from "url";
import {
  detectPlatformFromUrl, detectPlatformFromPage,
  getPlatformLabelMap,
} from "./platformDetector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.join(__dirname, "..", "data", "screenshots");
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// In-progress tracker: jobId → { status, browser }
const inProgress = new Map();

// ── Fill script injected into page context ────────────────────────────────────
// Logic ported directly from extension/content.js and background.js
const FILL_FN_SRC = `
function resumeMasterFill(autofillData, labelMap) {
  if (!autofillData || !autofillData.field_map) return 0;
  const fm  = autofillData.field_map;
  const ddm = autofillData.dropdown_map || {};
  let filled = 0;

  function setNativeValue(el, value) {
    try {
      const proto  = el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, value); else el.value = value;
    } catch { el.value = value; }
    ["input","change","blur"].forEach(ev =>
      el.dispatchEvent(new Event(ev, { bubbles: true })));
  }

  // 1. Generic name/id/autocomplete fill
  for (const [name, value] of Object.entries(fm)) {
    if (!value) continue;
    const sel = [
      'input[name="'+name+'"]','input[id="'+name+'"]',
      'textarea[name="'+name+'"]','textarea[id="'+name+'"]',
      'input[autocomplete="'+name+'"]',
    ].join(",");
    document.querySelectorAll(sel).forEach(el => {
      if (["hidden","submit","button","file","image"].includes(el.type)) return;
      setNativeValue(el, value); filled++;
    });
  }

  // 2. Placeholder / aria-label heuristic fill
  const HINT_MAP = {
    "first name": "first_name", "first": "first_name",
    "last name":  "last_name",  "last":  "last_name",
    "full name":  "full_name",  "name":  "full_name",
    "email":      "email",      "e-mail":"email",
    "phone":      "phone",      "mobile":"phone", "telephone":"phone",
    "linkedin":   "linkedin_url","github":"github_url",
    "city":       "city",       "state": "state",
    "zip":        "zip",        "postal":"zip",
    "address 1":  "address_line1","address":"address_line1",
    "address 2":  "address_line2",
    "location":   "location",
  };
  document.querySelectorAll(
    "input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='file']),textarea"
  ).forEach(el => {
    if (el.value) return;
    const hint = ((el.placeholder||"") + " " + (el.getAttribute("aria-label")||"")).toLowerCase();
    for (const [key, fieldKey] of Object.entries(HINT_MAP)) {
      if (hint.includes(key) && fm[fieldKey]) {
        setNativeValue(el, fm[fieldKey]); filled++; break;
      }
    }
  });

  // 3. Label-based fill (ATS-specific maps)
  document.querySelectorAll("label").forEach(lbl => {
    const text = lbl.textContent.trim();
    let matchedKey = null;
    for (const [k, fk] of Object.entries(labelMap)) {
      if (text.toLowerCase().includes(k.toLowerCase())) { matchedKey = fk; break; }
    }
    if (!matchedKey || !fm[matchedKey]) return;
    const forId = lbl.getAttribute("for");
    const el = forId
      ? (document.getElementById(forId) || document.querySelector('[name="'+forId+'"]'))
      : lbl.querySelector("input,textarea,select");
    if (!el || el.value) return;
    if (el.tagName === "SELECT") {
      for (const opt of el.options) {
        if (opt.text.toLowerCase().includes((fm[matchedKey]||"").toLowerCase())) {
          el.value = opt.value; el.dispatchEvent(new Event("change",{bubbles:true})); filled++; break;
        }
      }
    } else { setNativeValue(el, fm[matchedKey]); filled++; }
  });

  // 4. Dropdown fill
  for (const [key, matchValues] of Object.entries(ddm)) {
    if (!matchValues?.length) continue;
    document.querySelectorAll('select[name="'+key+'"],select[id="'+key+'"]').forEach(sel => {
      for (const opt of sel.options) {
        if (matchValues.some(v =>
          opt.text.toLowerCase().includes(v.toLowerCase()) ||
          opt.value.toLowerCase().includes(v.toLowerCase())
        )) {
          sel.value = opt.value; sel.dispatchEvent(new Event("change",{bubbles:true})); filled++; break;
        }
      }
    });
  }

  // 5. Radio buttons: sponsorship + clearance
  document.querySelectorAll("input[type='radio']").forEach(r => {
    const n   = (r.name  || "").toLowerCase();
    const v   = (r.value || "").toLowerCase();
    const lbl = (r.labels?.[0]?.textContent || "").toLowerCase();
    if (n.includes("sponsor") || lbl.includes("sponsor")) {
      const yes = fm.requires_sponsorship === "Yes";
      if ((yes&&(v==="yes"||v==="true"))||(!yes&&(v==="no"||v==="false"))) {
        r.checked=true; r.dispatchEvent(new Event("change",{bubbles:true})); filled++;
      }
    }
    if (n.includes("clearance") || lbl.includes("clearance")) {
      const yes = fm.has_clearance === "Yes";
      if ((yes&&(v==="yes"||v==="true"))||(!yes&&(v==="no"||v==="false"))) {
        r.checked=true; r.dispatchEvent(new Event("change",{bubbles:true})); filled++;
      }
    }
  });

  return filled;
}
`;

// ── Helpers ───────────────────────────────────────────────────────────────────
async function fillContext(pageOrFrame, autofillData, labelMap) {
  try {
    return await pageOrFrame.evaluate(
      `(${FILL_FN_SRC}); resumeMasterFill(${JSON.stringify(autofillData)}, ${JSON.stringify(labelMap)})`
    );
  } catch (e) {
    console.warn("[applyAutomation] fillContext:", e.message);
    return 0;
  }
}

async function handleResumeUpload(page, resumePath) {
  if (!resumePath || !fs.existsSync(resumePath)) return;
  try {
    const inputs = await page.locator("input[type='file']").all();
    if (inputs.length > 0) {
      await inputs[0].setInputFiles(resumePath);
      await page.waitForTimeout(800);
    }
  } catch (e) {
    console.warn("[applyAutomation] file upload:", e.message);
  }
}

const NEXT_RE = /^(next|continue|proceed|save and continue|save & continue|next step)/i;
async function clickNext(page) {
  for (const btn of await page.locator("button,input[type='button'],input[type='submit'],a[role='button']").all()) {
    try {
      const txt = ((await btn.textContent()) || "").trim();
      if (NEXT_RE.test(txt) && await btn.isVisible()) {
        await btn.click(); await page.waitForTimeout(1500); return true;
      }
    } catch {}
  }
  return false;
}

async function takeScreenshot(page, jobId) {
  const filename = `apply_${String(jobId).replace(/[^a-z0-9_]/gi,"_")}_${Date.now()}.png`;
  const filepath = path.join(SCREENSHOT_DIR, filename);
  try {
    await page.screenshot({ path: filepath, fullPage: false });
    const buf = fs.readFileSync(filepath);
    return { path: filepath, base64: buf.toString("base64") };
  } catch {
    return { path: null, base64: null };
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function autoApply(jobUrl, autofillData, options = {}) {
  const {
    mode             = "semi",
    platform         = null,
    resumePath       = null,
    jobId            = `tmp_${Date.now()}`,
    storageStatePath = null,
  } = options;

  const isFullAuto = mode === "full";
  let browser, context, page;

  try {
    browser = await chromium.launch({
      headless: isFullAuto,
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"],
    });

    const ctxOpts = {};
    if (storageStatePath && fs.existsSync(storageStatePath)) {
      ctxOpts.storageState = storageStatePath;
    }
    context = await browser.newContext(ctxOpts);
    page    = await context.newPage();

    inProgress.set(String(jobId), { status: "navigating", browser });

    await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);

    const detected  = platform || detectPlatformFromUrl(jobUrl) || await detectPlatformFromPage(page);
    const labelMap  = getPlatformLabelMap(detected);

    inProgress.set(String(jobId), { status: "filling", browser });

    let totalFilled = 0;
    const fillAllFrames = async () => {
      totalFilled += await fillContext(page, autofillData, labelMap);
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        totalFilled += await fillContext(frame, autofillData, labelMap);
      }
    };

    await fillAllFrames();
    await handleResumeUpload(page, resumePath);

    // Multi-step pagination
    for (let step = 0; step < 8; step++) {
      if (!await clickNext(page)) break;
      await fillAllFrames();
      await handleResumeUpload(page, resumePath);
    }

    let status, pageTitle;
    if (isFullAuto) {
      inProgress.set(String(jobId), { status: "submitting", browser });
      const SUBMIT_RE = /^(submit|apply|apply now|submit application|send application)/i;
      let submitted = false;
      for (const btn of await page.locator("button,input[type='submit']").all()) {
        try {
          const txt = ((await btn.textContent()) || "").trim();
          if (SUBMIT_RE.test(txt) && await btn.isVisible()) {
            await btn.click(); await page.waitForTimeout(2000); submitted = true; break;
          }
        } catch {}
      }
      status    = submitted ? "submitted" : "filled_not_submitted";
      pageTitle = await page.title().catch(() => "");
    } else {
      status    = "awaiting_user";
      pageTitle = await page.title().catch(() => "");
    }

    const ss = await takeScreenshot(page, jobId);
    inProgress.set(String(jobId), { status, browser: isFullAuto ? null : browser });
    if (isFullAuto) await browser.close();

    return {
      status,
      platform: detected,
      fieldsFilled: totalFilled,
      pageTitle,
      screenshotBase64: ss.base64,
      screenshotPath:   ss.path,
    };

  } catch (e) {
    inProgress.delete(String(jobId));
    let ss = { base64: null, path: null };
    try { if (page) ss = await takeScreenshot(page, jobId); } catch {}
    try { if (browser) await browser.close(); } catch {}
    return { status: "error", error: e.message, screenshotBase64: ss.base64, screenshotPath: ss.path };
  }
}

export function getApplyStatus(jobId) {
  return inProgress.get(String(jobId)) || null;
}

export async function closeSemiBrowser(jobId) {
  const entry = inProgress.get(String(jobId));
  if (entry?.browser) try { await entry.browser.close(); } catch {}
  inProgress.delete(String(jobId));
}
