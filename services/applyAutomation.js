// SCRAPING � SCHEDULED FOR REMOVAL AFTER MIGRATION
// services/applyAutomation.js — Server-side Puppeteer apply automation
// Replaces the Chrome extension form-fill logic with a Node.js service.
//
// autoApply(jobUrl, autofillData, options) — main entry point
//   options.mode: 'full'  = headless, auto-submit after fill
//               | 'semi'  = visible browser, form pre-filled, user reviews/submits
//   options.platform:        override ATS detection
//   options.resumePath:      absolute path to PDF resume for upload
//   options.storageStatePath: saved session state file

import path  from "path";
import fs    from "fs";
import { fileURLToPath } from "url";
import { launchBrowser } from "./browserLauncher.js";
import {
  detectPlatformFromUrl, detectPlatformFromPage,
  getPlatformLabelMap,
} from "./platformDetector.js";

// ── Field-type catalogue ──────────────────────────────────────────────────────
export const FIELD_TYPES = [
  'text', 'text_area', 'select', 'multi_select', 'radio', 'checkbox',
  'file', 'date', 'number', 'typeahead', 'toggle', 'rich_text',
  'hidden', 'password', 'static', 'complex', 'unknown',
];

// name/id/autocomplete attribute substrings → handler_type
export const HANDLER_BY_ATTR = {
  'given-name':'first-name','given_name':'first-name','first-name':'first-name','first_name':'first-name','fname':'first-name',
  'family-name':'last-name','family_name':'last-name','last-name':'last-name','last_name':'last-name','lname':'last-name','surname':'last-name',
  'fullname':'full-name','full-name':'full-name','full_name':'full-name',
  'email':'email',
  'tel':'phone','phone':'phone','mobile':'phone','telephone':'phone',
  'linkedin':'linkedin',
  'github':'github',
  'website':'website',
  'portfolio':'portfolio',
  'address-line1':'address1','address_line1':'address1','address_line_1':'address1','address1':'address1',
  'address-line2':'address2','address_line2':'address2','address_line_2':'address2','address2':'address2',
  'city':'city',
  'state':'state',
  'zip':'zip','postal-code':'zip','postal_code':'zip','postalcode':'zip',
  'country':'country',
  'location':'location',
  'sponsorship':'sponsorship','requires_sponsorship':'sponsorship',
  'work_auth':'work-auth','work-auth':'work-auth','work_authorization':'work-auth','authorization':'work-auth',
  'gender':'gender',
  'ethnicity':'ethnicity',
  'veteran':'veteran','veteran_status':'veteran',
  'disability':'disability','disability_status':'disability',
  'salary':'salary','desired_salary':'salary',
  'start_date':'start-date','available_start_date':'start-date',
  'relocate':'relocate','willing_to_relocate':'relocate',
  'degree':'degree','highest_degree':'degree','education':'degree',
  'field_of_study':'field-of-study','major':'field-of-study',
  'university':'school','school':'school','college':'school',
  'grad_year':'grad-year','graduation_year':'grad-year',
  'years_experience':'years-experience','years_of_experience':'years-experience',
  'current_title':'current-title','current_job_title':'current-title','job_title':'current-title',
  'current_company':'current-company',
};

// profile field key → handler_type (used by buildAutofillPayload to build handler_map)
export const PROFILE_KEY_TO_HANDLER = {
  first_name:'first-name', last_name:'last-name', full_name:'full-name',
  email:'email', phone:'phone',
  linkedin_url:'linkedin', github_url:'github',
  website_url:'website', portfolio_url:'portfolio',
  address_line1:'address1', address_line2:'address2',
  city:'city', state:'state', zip:'zip', country:'country', location:'location',
  requires_sponsorship:'sponsorship',
  work_auth:'work-auth', work_authorization:'work-auth',
  gender:'gender', ethnicity:'ethnicity',
  veteran_status:'veteran', disability_status:'disability',
  desired_salary:'salary', available_start_date:'start-date',
  willing_to_relocate:'relocate',
  highest_degree:'degree', field_of_study:'field-of-study',
  university:'school', graduation_year:'grad-year',
  years_of_experience:'years-experience',
  current_job_title:'current-title', current_company:'current-company',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.join(__dirname, "..", "data", "screenshots");
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// In-progress tracker: jobId → { status, browser }
const inProgress = new Map();

// ── Fill script injected into page context ────────────────────────────────────
// Logic ported directly from extension/content.js and background.js
const FILL_FN_SRC = `
function(autofillData, labelMap) {
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

// ── Field discovery script (injected into page context) ──────────────────────
const DISCOVER_FN_SRC = `
function(handlerByAttr, profileKeyToHandler, labelMap) {
  const SKIP_TYPES = new Set(['hidden','submit','button','image','reset']);
  function getFieldType(el) {
    const tag = el.tagName;
    const type = (el.type || '').toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const cls  = el.className || '';
    if (tag === 'SELECT') return el.multiple ? 'multi_select' : 'select';
    if (tag === 'TEXTAREA') return 'text_area';
    if (tag === 'INPUT') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio')    return 'radio';
      if (type === 'file')     return 'file';
      if (type === 'date')     return 'date';
      if (type === 'number')   return 'number';
      if (type === 'password') return 'password';
    }
    if (el.getAttribute('contenteditable') === 'true') return 'rich_text';
    if (role === 'switch') return 'toggle';
    if (role === 'combobox' || el.getAttribute('aria-autocomplete') === 'list' ||
        /select2|autocomplete|typeahead|combobox|react-select/.test(cls)) return 'typeahead';
    return 'text';
  }

  function getLabel(el) {
    const id = el.id;
    if (id) {
      const lbl = document.querySelector('label[for="' + id + '"]');
      if (lbl) return lbl.textContent.trim();
    }
    const closest = el.closest('label');
    if (closest) return closest.textContent.trim();
    return el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
  }

  function isVisible(el) {
    try {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch { return false; }
  }

  function resolveHandler(el, fieldType, label) {
    const attrNames = ['name','id','autocomplete'];
    const attrVals = attrNames.map(a => (el.getAttribute(a) || '').toLowerCase());
    for (const val of attrVals) {
      if (!val) continue;
      for (const [substr, ht] of Object.entries(handlerByAttr)) {
        if (val.includes(substr)) return ht;
      }
    }
    // file-specific: check label+name+id for resume/cover
    if (fieldType === 'file') {
      const combined = (label + ' ' + attrVals.join(' ')).toLowerCase();
      if (combined.includes('resume') || combined.includes('cv')) return 'resume';
      if (combined.includes('cover') || combined.includes('letter')) return 'cover-letter';
    }
    // label map → profile key → handler
    const labelLower = label.toLowerCase();
    for (const [k, profileKey] of Object.entries(labelMap)) {
      if (labelLower.includes(k.toLowerCase()) && profileKeyToHandler[profileKey]) {
        return profileKeyToHandler[profileKey];
      }
    }
    return null;
  }

  const fields = [];
  const seenRadioNames = new Set();

  const elems = Array.from(document.querySelectorAll(
    'input,textarea,select,[contenteditable="true"],[role="combobox"],[role="switch"]'
  ));

  for (const el of elems) {
    if (!isVisible(el)) continue;
    const type = (el.type || '').toLowerCase();
    if (el.tagName === 'INPUT' && SKIP_TYPES.has(type)) continue;

    const fieldType = getFieldType(el);
    const name = el.getAttribute('name') || el.id || '';

    // dedupe radio groups
    if (fieldType === 'radio') {
      if (seenRadioNames.has(name)) continue;
      seenRadioNames.add(name);
    }

    const label = getLabel(el);
    const handler_type = resolveHandler(el, fieldType, label);
    const is_required = el.required || el.getAttribute('aria-required') === 'true';

    let options = [];
    if (el.tagName === 'SELECT') {
      options = Array.from(el.options).map(o => ({ value: o.value, label: o.text.trim() }));
    } else if (fieldType === 'radio') {
      const radios = document.querySelectorAll('input[type="radio"][name="' + name + '"]');
      options = Array.from(radios).map(r => ({ value: r.value, label: getLabel(r) }));
    }

    fields.push({
      field_id: el.id || name,
      name,
      type: fieldType,
      label,
      is_required: !!is_required,
      options,
      handler_type: handler_type || null,
    });
  }

  return fields;
}
`;

// ── Apply answers script (injected into page context) ─────────────────────────
const APPLY_FN_SRC = `
function(answers) {
  function setNativeValue(el, value) {
    try {
      const proto  = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
    } catch { el.value = value; }
    ['input','change','blur'].forEach(ev =>
      el.dispatchEvent(new Event(ev, { bubbles: true })));
  }

  let filled = 0;
  for (const ans of answers) {
    if (ans.type === 'typeahead') continue;
    const el = (ans.field_id ? (document.getElementById(ans.field_id) || document.querySelector('[name="' + ans.field_id + '"]')) : null)
            || (ans.name   ? (document.querySelector('[name="' + ans.name + '"]')) : null);
    if (!el) continue;
    try {
      if (ans.type === 'select') {
        for (const opt of el.options) {
          if (opt.text.toLowerCase().includes(ans.value.toLowerCase()) ||
              opt.value.toLowerCase().includes(ans.value.toLowerCase())) {
            el.value = opt.value; el.dispatchEvent(new Event('change',{bubbles:true})); filled++; break;
          }
        }
      } else if (ans.type === 'radio') {
        const radios = document.querySelectorAll('input[type="radio"][name="' + (ans.name || ans.field_id) + '"]');
        for (const r of radios) {
          if ((r.value || '').toLowerCase() === ans.value.toLowerCase() ||
              (r.labels?.[0]?.textContent || '').toLowerCase().includes(ans.value.toLowerCase())) {
            r.checked = true; r.dispatchEvent(new Event('change',{bubbles:true})); filled++; break;
          }
        }
      } else if (ans.type === 'checkbox' || ans.type === 'toggle') {
        const want = ans.value === 'true' || ans.value === true;
        if (el.checked !== want) { el.checked = want; el.dispatchEvent(new Event('change',{bubbles:true})); filled++; }
      } else if (ans.type === 'rich_text') {
        el.innerHTML = ans.value; el.dispatchEvent(new Event('input',{bubbles:true})); filled++;
      } else {
        if (ans.clear_first) setNativeValue(el, '');
        setNativeValue(el, ans.value); filled++;
      }
    } catch {}
  }
  return filled;
}
`;

// ── discoverFields ────────────────────────────────────────────────────────────
export async function discoverFields(pageOrFrame, provider) {
  try {
    const labelMap = getPlatformLabelMap(provider || 'generic');
    return await pageOrFrame.evaluate(
      `(${DISCOVER_FN_SRC})(${JSON.stringify(HANDLER_BY_ATTR)}, ${JSON.stringify(PROFILE_KEY_TO_HANDLER)}, ${JSON.stringify(labelMap)})`
    );
  } catch (e) {
    console.warn("[applyAutomation] discoverFields error:", e.message);
    return [];
  }
}

// ── buildAnswers ──────────────────────────────────────────────────────────────
export function buildAnswers(fields, profilePayload) {
  const { field_map = {}, handler_map = {}, custom_answers = {} } = profilePayload || {};
  const SKIP_TYPES = new Set(['file','hidden','password','static','unknown','complex']);
  const answers = [];

  for (const field of fields) {
    if (SKIP_TYPES.has(field.type)) continue;

    let value = null;

    // 1. handler_map lookup by handler_type
    if (field.handler_type && handler_map[field.handler_type] !== undefined && handler_map[field.handler_type] !== '') {
      value = handler_map[field.handler_type];
    }

    // 2. field_map lookup by handler_type (with dash → underscore fallback)
    if (value === null && field.handler_type) {
      const fm1 = field_map[field.handler_type];
      const fm2 = field_map[field.handler_type.replace(/-/g,'_')];
      if (fm1 !== undefined && fm1 !== '') value = fm1;
      else if (fm2 !== undefined && fm2 !== '') value = fm2;
    }

    // 3. Fuzzy label match against field_map keys
    if (value === null && field.label) {
      const lbl = field.label.toLowerCase();
      for (const [k, v] of Object.entries(field_map)) {
        if (v && lbl.includes(k.replace(/_/g,' ').toLowerCase())) {
          value = v; break;
        }
      }
    }

    // 4. custom_answers fallback
    if (value === null && field.label) {
      const lbl = field.label.toLowerCase();
      for (const [q, a] of Object.entries(custom_answers)) {
        const ql = q.toLowerCase();
        if (lbl.includes(ql) || ql.includes(lbl)) { value = String(a); break; }
      }
    }

    if (value === null) continue;

    // Type formatting
    let typeahead_selection = null;
    if (field.type === 'checkbox' || field.type === 'toggle') {
      const boolVal = value === true || value === 'true' || value === 'Yes' || value === '1' || value === 1;
      value = boolVal ? 'true' : 'false';
    } else if (field.type === 'typeahead') {
      typeahead_selection = String(value);
      value = String(value);
    } else if (field.type === 'date' && value) {
      // Ensure YYYY-MM-DD
      const d = new Date(value);
      if (!isNaN(d.getTime())) {
        value = d.toISOString().slice(0, 10);
      }
    } else {
      value = String(value);
    }

    answers.push({
      field_id: field.field_id,
      name: field.name,
      type: field.type,
      value,
      typeahead_selection,
      clear_first: true,
    });
  }

  return answers;
}

// ── applyTypeaheadAnswer ──────────────────────────────────────────────────────
async function applyTypeaheadAnswer(page, answer) {
  try {
    const el = answer.field_id
      ? (await page.$('#' + answer.field_id) || await page.$('[name="' + answer.field_id + '"]'))
      : null;
    if (!el) return;
    await el.click();
    await el.type(String(answer.value || ''), { delay: 50 });
    await new Promise(r => setTimeout(r, 800));
    // Try to click a dropdown option matching typeahead_selection
    const sel = answer.typeahead_selection || answer.value;
    const options = await page.$$('[role=option],[role=listitem],[class*=option],[class*=suggestion]');
    for (const opt of options) {
      try {
        const txt = (await opt.evaluate(el => el.textContent || '')).trim();
        if (txt.toLowerCase().includes(String(sel).toLowerCase())) {
          await opt.click(); return;
        }
      } catch {}
    }
    // Fallback: arrow down + enter
    await el.press('ArrowDown');
    await el.press('Enter');
  } catch (e) {
    console.warn("[applyAutomation] applyTypeaheadAnswer:", e.message);
  }
}

// ── classifyFlowState ─────────────────────────────────────────────────────────
export async function classifyFlowState(page, originalDomain) {
  try {
    // 1. Cross-domain redirect
    if (originalDomain) {
      const currentHost = new URL(page.url()).hostname;
      if (currentHost !== originalDomain) return 'redirected';
    }

    // 2. Submitted
    const bodyText = await page.evaluate(`document.body?.innerText || ''`).catch(() => '');
    if (/thank you|application (received|submitted|complete)|successfully (applied|submitted)|we.{0,10}ll be in touch/i.test(bodyText)) {
      return 'submitted';
    }

    // 3. Expired
    if (/no longer (available|accepting)|position (has been )?filled|posting.*expired|job.*no longer/i.test(bodyText)) {
      return 'expired';
    }

    // 4. CAPTCHA
    const hasCaptcha = await page.evaluate(`!!(document.querySelector('iframe[src*="recaptcha"]') || document.querySelector('iframe[src*="hcaptcha"]') || document.querySelector('.g-recaptcha') || document.querySelector('.h-captcha') || document.querySelector('[data-sitekey]'))`).catch(() => false);
    if (hasCaptcha) return 'captcha_required';

    // 5. Login
    const hasPassword = await page.evaluate(`!!document.querySelector('input[type="password"]')`).catch(() => false);
    if (hasPassword) return 'login_required';
    const urlLower = (page.url() || '').toLowerCase();
    if (/\/login|\/signin|\/sign-in/.test(urlLower)) return 'login_required';

    // 6. Redirect pending
    const hasMetaRefresh = await page.evaluate(`(()=>{const m=document.querySelector('meta[http-equiv="refresh"]');return !!(m && (m.getAttribute('content')||'').toLowerCase().includes('url='));})()`).catch(() => false);
    if (hasMetaRefresh) return 'redirect_required';

    // 7. Next button
    const NEXT_BTN_RE = /^(next|continue|proceed|save and continue|next step)/i;
    const nextBtns = await page.$$('button,input[type="button"],input[type="submit"],a[role="button"]').catch(() => []);
    for (const btn of nextBtns) {
      try {
        const txt = (await btn.evaluate(el => el.textContent || '')).trim();
        const visible = await btn.evaluate(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        if (NEXT_BTN_RE.test(txt) && visible) return 'next_available';
      } catch {}
    }

    // 8. Submit button
    const SUBMIT_BTN_RE = /^(submit|apply|apply now|submit application|send application|finish)/i;
    for (const btn of nextBtns) {
      try {
        const txt = (await btn.evaluate(el => el.textContent || '')).trim();
        const visible = await btn.evaluate(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        if (SUBMIT_BTN_RE.test(txt) && visible) return 'submit_ready';
      } catch {}
    }

    // 9. Form inputs present
    const hasForm = await page.evaluate(`!!document.querySelector('input:not([type="hidden"]):not([type="submit"]):not([type="button"])')`).catch(() => false);
    if (hasForm) return 'form_ready';

    return 'form_ready';
  } catch (e) {
    console.warn("[applyAutomation] classifyFlowState error:", e.message);
    return 'error';
  }
}

// ── discoverAndFill ───────────────────────────────────────────────────────────
async function discoverAndFill(page, frames, provider, autofillData, labelMap) {
  let n = 0;
  for (const frame of frames) {
    const fields = await discoverFields(frame, provider);
    if (fields.length) {
      const answers = buildAnswers(fields, autofillData);
      const simpleAnswers = answers.filter(a => a.type !== 'typeahead');
      if (simpleAnswers.length) n += await frame.evaluate(`(${APPLY_FN_SRC})(${JSON.stringify(simpleAnswers)})`).catch(() => 0);
      for (const a of answers.filter(a => a.type === 'typeahead')) await applyTypeaheadAnswer(page, a);
    }
    // Legacy fallback sweep for any inputs discovery missed
    n += await fillContext(frame, autofillData, labelMap);
  }
  return n;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function fillContext(pageOrFrame, autofillData, labelMap) {
  try {
    // FILL_FN_SRC is an anonymous function expression — invoke as IIFE with args.
    // Named function expressions (function foo(){}) have their name scoped only
    // inside the body; calling foo() after the expression would ReferenceError.
    return await pageOrFrame.evaluate(
      `(${FILL_FN_SRC})(${JSON.stringify(autofillData)}, ${JSON.stringify(labelMap)})`
    );
  } catch (e) {
    console.warn("[applyAutomation] fillContext error:", e.message);
    return 0;
  }
}

async function uploadToFileInput(input, filePath) {
  await input.uploadFile(filePath);
  await input.evaluate(inp => {
    if (!inp.files?.length || typeof DataTransfer === "undefined") {
      inp.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const transfer = new DataTransfer();
    for (const file of inp.files) transfer.items.add(file);
    inp.files = transfer.files;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 800));
}

async function handleTypedFileUploads(page, resumePath, coverLetterPath) {
  if (!resumePath && !coverLetterPath) return;
  try {
    const inputs = await page.$$("input[type='file']");
    if (!inputs.length) return;

    // Classify each file input by examining label + name + id attributes
    const slots = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input[type='file']")).map((el, idx) => {
        const labelEl = el.id ? document.querySelector('label[for="' + el.id + '"]') : null;
        const labelText = labelEl?.textContent || el.closest('label')?.textContent ||
                          el.getAttribute('aria-label') || el.placeholder || '';
        const attrs = [el.id || '', el.name || '', el.getAttribute('aria-label') || ''].join(' ');
        const combined = (labelText + ' ' + attrs).toLowerCase();
        const isCover  = /cover|letter/.test(combined);
        const isResume = /resume|\bcv\b/.test(combined);
        return { idx, isCover, isResume };
      })
    );

    let resumeUploaded = false;
    let coverUploaded  = false;

    for (const slot of slots) {
      const input = inputs[slot.idx];
      if (!input) continue;
      if (slot.isCover && !coverUploaded && coverLetterPath && fs.existsSync(coverLetterPath)) {
        await uploadToFileInput(input, coverLetterPath);
        coverUploaded = true;
      } else if (slot.isResume && !resumeUploaded && resumePath && fs.existsSync(resumePath)) {
        await uploadToFileInput(input, resumePath);
        resumeUploaded = true;
      }
    }

    // Fallback: upload resume to first file input when no typed resume slot was found
    if (!resumeUploaded && resumePath && fs.existsSync(resumePath) && inputs.length > 0) {
      if (!slots[0]?.isCover) {
        await uploadToFileInput(inputs[0], resumePath);
      }
    }
  } catch (e) {
    console.warn("[applyAutomation] file upload routing:", e.message);
  }
}

const NEXT_RE = /^(next|continue|proceed|save and continue|save & continue|next step)/i;
async function clickNext(page) {
  for (const btn of await page.$$("button,input[type='button'],input[type='submit'],a[role='button']")) {
    try {
      const txt = (await btn.evaluate(el => el.textContent || "")).trim();
      const visible = await btn.evaluate(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (NEXT_RE.test(txt) && visible) {
        await btn.click(); await new Promise(r => setTimeout(r, 1500)); return true;
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
    mode              = "semi",
    platform          = null,
    resumePath        = null,
    // Promise<string|null> — resolves to a PDF file path when generation+ATS gate completes,
    // or null if generation failed / ATS score is below threshold / PDF conversion failed.
    // The browser awaits this before the first resume upload attempt, enabling parallel
    // site-visit + generation without blocking navigation or form-fill.
    resumePathPromise        = null,
    coverLetterPath          = null,
    coverLetterPathPromise   = null,
    jobId             = `tmp_${Date.now()}`,
    storageStatePath  = null,
  } = options;

  const isFullAuto = mode === "full";
  let browser, page;

  try {
    console.log(`[autoApply] launching browser — mode=${mode} url=${jobUrl}`);
    const isWindows = process.platform === "win32";
    // launchBrowser resolves the best available binary, applies container-safe args,
    // and throws with a structured reasonCode on failure.
    browser = await launchBrowser({
      headless:  isFullAuto || !isWindows ? "new" : false,
      mode:      isFullAuto ? "auto" : "manual",
      viewport:  isWindows ? { width: 1280, height: 800 } : null,
      isWindows,
    });
    console.log("[autoApply] browser launched");

    page = await browser.newPage();
    // Restore cookies from session state file if provided
    if (storageStatePath && fs.existsSync(storageStatePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(storageStatePath, "utf8"));
        if (Array.isArray(state.cookies) && state.cookies.length > 0) {
          await page.setCookie(...state.cookies);
        }
      } catch (e) {
        console.warn("[autoApply] could not restore session state:", e.message);
      }
    }

    inProgress.set(String(jobId), { status: "navigating", browser });
    console.log(`[autoApply] navigating to ${jobUrl}`);

    await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));

    const detected  = platform || detectPlatformFromUrl(jobUrl) || await detectPlatformFromPage(page);
    const labelMap  = getPlatformLabelMap(detected);
    console.log(`[autoApply] detected platform=${detected}`);

    inProgress.set(String(jobId), { status: "filling", browser });

    let totalFilled = 0;
    const fillAllFrames = async () => {
      totalFilled += await fillContext(page, autofillData, labelMap);
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        totalFilled += await fillContext(frame, autofillData, labelMap);
      }
    };

    totalFilled += await discoverAndFill(page, [page, ...page.frames()], detected, autofillData, labelMap);

    // Resolve effective resume path — await resumePathPromise if no direct path provided.
    // resumePathPromise is set by the apply worker when generation runs in parallel;
    // it resolves to a temp PDF path once generation + ATS gate complete, or null on failure.
    let effectiveResumePath = resumePath;
    if (!effectiveResumePath && resumePathPromise) {
      inProgress.set(String(jobId), { status: "waiting_for_resume", browser });
      try {
        effectiveResumePath = await Promise.race([
          resumePathPromise,
          new Promise(r => setTimeout(() => r(null), 90_000)),
        ]);
      } catch { effectiveResumePath = null; }
    }

    let effectiveCoverLetterPath = coverLetterPath;
    if (!effectiveCoverLetterPath && coverLetterPathPromise) {
      try {
        effectiveCoverLetterPath = await Promise.race([
          coverLetterPathPromise,
          new Promise(r => setTimeout(() => r(null), 90_000)),
        ]);
      } catch { effectiveCoverLetterPath = null; }
    }

    await handleTypedFileUploads(page, effectiveResumePath, effectiveCoverLetterPath);

    // Multi-step pagination
    for (let step = 0; step < 8; step++) {
      if (!await clickNext(page)) break;
      totalFilled += await discoverAndFill(page, [page, ...page.frames()], detected, autofillData, labelMap);
      await handleTypedFileUploads(page, effectiveResumePath, effectiveCoverLetterPath);
    }

    // ATS gate: if a resumePathPromise was provided but resolved to null (generation failed,
    // ATS below threshold, or PDF conversion failed) — do NOT auto-submit.
    if (isFullAuto && resumePathPromise && !effectiveResumePath) {
      const pageTitle = await page.title().catch(() => "");
      const ss = await takeScreenshot(page, jobId);
      inProgress.set(String(jobId), { status: "ats_held", browser: null });
      await browser.close();
      return {
        status:           "ats_held",
        reasonCode:       "resume_unavailable",
        fieldsFilled:     totalFilled,
        platform:         detected,
        pageTitle,
        screenshotBase64: ss.base64,
        screenshotPath:   ss.path,
      };
    }

    // Check flow state after fill + upload
    const originalDomain = (() => { try { return new URL(jobUrl).hostname; } catch { return null; } })();
    const flowState = await classifyFlowState(page, originalDomain);

    // Terminal states
    if (isFullAuto && (flowState === 'login_required' || flowState === 'captcha_required' || flowState === 'expired')) {
      const pageTitle = await page.title().catch(() => "");
      const ss = await takeScreenshot(page, jobId);
      inProgress.set(String(jobId), { status: flowState, browser: null });
      await browser.close();
      return {
        status:           flowState,
        reasonCode:       flowState,
        flowState,
        fieldsFilled:     totalFilled,
        platform:         detected,
        pageTitle,
        screenshotBase64: ss.base64,
        screenshotPath:   ss.path,
      };
    }

    let status, pageTitle;
    if (isFullAuto) {
      inProgress.set(String(jobId), { status: "submitting", browser });
      const SUBMIT_RE = /^(submit|apply|apply now|submit application|send application)/i;
      let submitted = false;
      for (const btn of await page.$$("button,input[type='submit']")) {
        try {
          const txt = (await btn.evaluate(el => el.textContent || "")).trim();
          const visible = await btn.evaluate(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          if (SUBMIT_RE.test(txt) && visible) {
            await btn.click(); await new Promise(r => setTimeout(r, 2000)); submitted = true; break;
          }
        } catch {}
      }
      if (submitted || flowState === 'submitted') {
        status = "submitted";
      } else {
        status = "filled_not_submitted";
      }
      pageTitle = await page.title().catch(() => "");
    } else {
      status    = "awaiting_user";
      pageTitle = await page.title().catch(() => "");
    }

    console.log(`[autoApply] done — status=${status} fieldsFilled=${totalFilled}`);
    const ss = await takeScreenshot(page, jobId);
    inProgress.set(String(jobId), { status, browser: isFullAuto ? null : browser });
    if (isFullAuto) await browser.close();

    return {
      status,
      flowState,
      platform: detected,
      fieldsFilled: totalFilled,
      pageTitle,
      screenshotBase64: ss.base64,
      screenshotPath:   ss.path,
    };

  } catch (e) {
    console.error(`[autoApply] error: ${e.message}`);
    inProgress.delete(String(jobId));
    let ss = { base64: null, path: null };
    try { if (page) ss = await takeScreenshot(page, jobId); } catch {}
    try { if (browser) await browser.close(); } catch {}
    return {
      status: "error",
      error: e.message,
      reasonCode: e.reasonCode || (String(e.message || "").toLowerCase().includes("timeout") ? "browser_timeout" : "browser_error"),
      screenshotBase64: ss.base64,
      screenshotPath: ss.path,
    };
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
