// SCRAPING -- SCHEDULED FOR REMOVAL AFTER MIGRATION
// services/applyAutomation.js -- Server-side Puppeteer apply automation
// Replaces the Chrome extension form-fill logic with a Node.js service.
//
// autoApply(jobUrl, autofillData, options) -- main entry point
//   options.mode: 'full'    = headless, auto-submit after fill
//               | 'semi'    = visible browser, form pre-filled, user reviews/submits
//               | 'preview' = headless, fills and runs every gate, NEVER submits, closes the
//                             browser. For queue-then-approve: resolves a batch for review without
//                             leaving one visible browser open per job the way semi does.
//   options.approvedAnswers: the answer set a human approved in a preview pass. The run refuses to
//                            submit if it now resolves the form differently.
//   options.platform:        override ATS detection
//   options.resumePath:      absolute path to PDF resume for upload
//   options.storageStatePath: saved session state file

import path  from "path";
import fs    from "fs";
import { fileURLToPath } from "url";
import { launchBrowser } from "./browserLauncher.js";
import { classifyRuntimeError } from "../shared/failureAttribution.js";
import {
  detectPlatformFromUrl, detectPlatformFromPage,
  getPlatformLabelMap,
} from "./platformDetector.js";

// -- Field-type catalogue ------------------------------------------------------
export const FIELD_TYPES = [
  'text', 'text_area', 'select', 'multi_select', 'radio', 'checkbox',
  'file', 'date', 'number', 'typeahead', 'toggle', 'rich_text',
  'hidden', 'password', 'static', 'complex', 'unknown',
];

// name/id/autocomplete attribute substrings -> handler_type
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

// profile field key -> handler_type (used by buildAutofillPayload to build handler_map)
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
  // `years_experience` is the spelling four PLATFORM_LABEL_MAPS use as their value. Without it here
  // resolveHandler's label lookup found no handler and silently skipped, so "Years of Experience"
  // resolved only when the control's ATTRIBUTE happened to be recognisable — the label fallback,
  // which exists precisely for when it is not, was dead.
  years_experience:'years-experience',
  // clearance_level / visa_type were referenced by the label maps and by ELIGIBILITY_HANDLERS
  // (which already lists 'clearance' and 'visa' as the valid handlers for those classes) but no
  // profile key produced either handler, so both were unreachable. Wiring them makes the
  // eligibility guard's canonical-key path work for clearance and visa questions instead of
  // refusing every key and holding the run.
  clearance_level:'clearance', has_clearance:'clearance',
  visa_type:'visa', visa_status:'visa',
  current_job_title:'current-title', current_company:'current-company',
};

// Reverse of PROFILE_KEY_TO_HANDLER: handler_type -> profile keys that legitimately answer it.
// Without this, step 2 only tried field_map[handler_type] and its underscore variant, so the
// CANONICAL key for a class could not resolve its own field: handler 'sponsorship' never looked
// for `requires_sponsorship`. Once eligibility fields are restricted to exact mapping, that gap
// would mean they can never be answered at all — safe, but permanently held.
export const HANDLER_TO_PROFILE_KEYS = Object.entries(PROFILE_KEY_TO_HANDLER)
  .reduce((acc, [key, handler]) => { (acc[handler] ||= []).push(key); return acc; }, {});

// -- Answer provenance + confidence (TASK A2) ----------------------------------
// Every answer records the rule that produced it. The apply path had no equivalent of the KB
// layer's provenance, so an exact handler hit and a fuzzy substring guess were submitted
// identically. See docs/auto-apply-a1-trap-matrix.md.
export const PROVENANCE = {
  HANDLER_EXACT:   'handler_exact',
  FIELD_MAP_EXACT: 'field_map_exact',
  CUSTOM_ANSWER:   'custom_answer',
  LABEL_EXACT:     'label_exact',
  LABEL_FUZZY:     'label_fuzzy',
  DEFAULT:         'default',
};

export const CONFIDENCE_BY_PROVENANCE = {
  handler_exact:   1.0,
  field_map_exact: 0.9,
  // A label that IS the key once normalised ("Current company" <- current_company) is not a guess;
  // it is the strongest signal a label can give. Splitting it out from label_fuzzy is what stops
  // the low-confidence hold from firing on ordinary forms — A2 shipped with every fuzzy match
  // holding the run, and in practice the commonest trigger was an exact label match scored 0.3.
  //
  // 0.85 rather than 0.9 is deliberate: it clears the auto-submit floor but stays BELOW
  // CLEAR_FIRST_MIN_CONFIDENCE, so a label match may fill a blank field yet never overwrite a value
  // the ATS parsed from the uploaded resume. A label string is weaker evidence than an attribute or
  // handler signal, which is what field_map_exact rests on.
  label_exact:     0.85,
  custom_answer:   0.85,
  label_fuzzy:     0.3,
  default:         0.1,
};

// Below this, an answer may not be auto-submitted in mode:'full' (requirement 5).
export const AUTO_SUBMIT_MIN_CONFIDENCE = 0.8;
// Below this, an answer may not wipe a value the ATS already parsed from the resume
// (requirement 6). Only the two exact paths clear a prefilled field.
export const CLEAR_FIRST_MIN_CONFIDENCE = 0.9;

// -- Eligibility-class fields ---------------------------------------------------
// A wrong answer here is a materially false attestation to an employer, so these resolve by exact
// mapping or not at all — never by fuzzy label matching. Order matters: a label may mention two
// classes ("require sponsorship for work authorization"), and the FIRST match wins, so the more
// specific subject is listed first. That single label is the A1 trap: it is a sponsorship
// question that mentions work authorization.
export const ELIGIBILITY_PATTERNS = [
  ['sponsorship', /\bsponsor(?:s|ed|ship)?\b/i],
  ['criminal',    /\b(?:criminal|felony|convict\w*|background\s+check)\b/i],
  ['clearance',   /\bclearance\b/i],
  ['visa',        /\b(?:visa|h-?1-?b|f-?1|opt|cpt|green\s+card|permanent\s+resident)\b/i],
  ['eeo',         /\b(?:gender|ethnicit\w*|races?|racial|veteran|disabilit\w*|eeo|hispanic|latino|pronouns?)\b/i],
  ['work_auth',   /\b(?:work\s+authoriz\w*|authoriz\w*\s+to\s+work|right\s+to\s+work|legally\s+authoriz\w*|employment\s+eligib\w*)\b/i],
];

// Profile keys that are a legitimate answer for each class.
export const ELIGIBILITY_CANONICAL_KEYS = {
  sponsorship: ['requires_sponsorship', 'needs_sponsorship', 'sponsorship'],
  work_auth:   ['work_auth', 'work_authorization', 'authorized_to_work'],
  clearance:   ['clearance_level', 'has_clearance', 'clearance'],
  visa:        ['visa_type', 'visa_status', 'visa'],
  criminal:    ['criminal_history', 'has_criminal_record', 'background_check'],
  eeo:         ['gender', 'ethnicity', 'race', 'veteran_status', 'disability_status', 'pronouns'],
};

// handler_types that are a legitimate answer for each class.
export const ELIGIBILITY_HANDLERS = {
  sponsorship: ['sponsorship'],
  work_auth:   ['work-auth'],
  clearance:   ['clearance'],
  visa:        ['visa'],
  criminal:    [],
  eeo:         ['gender', 'ethnicity', 'veteran', 'disability'],
};

// Labels naming a DIFFERENT person. "Name of Referrer" is not the candidate's name, and this —
// not whole-token matching — is what actually stops the A1 name_ambiguity trap: "name" IS a whole
// token in "Name of Referrer", so token matching alone would still match it.
export const THIRD_PARTY_SUBJECT_RE =
  /\b(?:referr?er|referral|referee|reference|emergency\s+contact|next\s+of\s+kin|supervisor|manager'?s?|manager\s+name|spouse|partner'?s|parent|guardian|witness|previous\s+employer\s+contact)\b/i;

// Handlers/keys that identify the candidate, and so must never fill a third-party field.
export const IDENTITY_HANDLERS = new Set([
  'first-name', 'last-name', 'full-name', 'email', 'phone', 'linkedin', 'github',
  'website', 'portfolio', 'address1', 'address2', 'city', 'state', 'zip', 'country', 'location',
]);
const IDENTITY_KEY_RE = /\b(?:name|email|phone|mobile|linkedin|github|website|portfolio|address|city|state|zip|location)\b/i;

// Negation/inversion tokens. A key must not fuzzy-match a label that inverts its sense.
const INVERSION_RE = /\b(?:not|never|without|require[sd]?|requiring|need(?:s|ed)?|unable|cannot|can't|don'?t|do\s+not|lack)\b/i;

const normaliseText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const keyToPhrase  = (k) => normaliseText(String(k).replace(/[_-]+/g, ' '));

/** The eligibility class a label/name belongs to, or null. */
export function eligibilityClassOf(text) {
  const t = String(text ?? '');
  if (!t) return null;
  for (const [cls, re] of ELIGIBILITY_PATTERNS) if (re.test(t)) return cls;
  return null;
}

/**
 * True when the label IS the key, normalised — "Current company" for `current_company`.
 * Distinct from a token-subset match ("Current company name"), which remains a guess.
 */
export function isExactLabelMatch(label, key) {
  const l = normaliseText(label), k = keyToPhrase(key);
  return !!l && !!k && l === k;
}

/** Whole-token containment: `name` matches "Legal Name" but not "Username". */
export function matchesWholeToken(label, key) {
  const needle = keyToPhrase(key);
  if (!needle) return false;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s_-]+');
  return new RegExp(`(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)`, 'i').test(normaliseText(label));
}

/** True when the label negates/inverts the key's sense and the key itself carries no negation. */
export function invertsKey(label, key) {
  return INVERSION_RE.test(normaliseText(label)) && !INVERSION_RE.test(keyToPhrase(key));
}

/**
 * May `key` (a field_map key) or `handler` answer this field? Shared by every resolution path so
 * the legacy sweep and the discovery handler cannot contradict buildAnswers.
 * Returns null when allowed, or a string reason when refused.
 */
export function refuseReason({ label = '', name = '', key = null, handler = null, allowEligibilityExactAnswer = false }) {
  const subject = `${label} ${name}`;
  const cls = eligibilityClassOf(subject);
  if (cls) {
    const okKeys = ELIGIBILITY_CANONICAL_KEYS[cls] || [];
    const okHandlers = ELIGIBILITY_HANDLERS[cls] || [];
    const keyOk = key != null && okKeys.includes(String(key).toLowerCase());
    const handlerOk = handler != null && okHandlers.includes(String(handler));
    if (!keyOk && !handlerOk && !allowEligibilityExactAnswer) return `eligibility_class:${cls}`;
  }
  if (THIRD_PARTY_SUBJECT_RE.test(subject)) {
    const identityKey = key != null && IDENTITY_KEY_RE.test(keyToPhrase(key));
    const identityHandler = handler != null && IDENTITY_HANDLERS.has(String(handler));
    if (identityKey || identityHandler) return 'third_party_subject';
  }
  return null;
}

// -- Eligibility boolean polarity ----------------------------------------------
// A1 finding: the checkbox "I am authorized to work without sponsorship" was answered FALSE
// (unchecked) from a profile whose `requires_sponsorship` is "No". Those two statements agree —
// not requiring sponsorship IS being authorized without it — but the resolver passed the stored
// value straight through coerceAffirmative, so it answered the OPPOSITE of the truth, at 0.9
// confidence, above the auto-submit floor. It held only because an unchecked required checkbox
// reads as empty to the completeness gate; that is the field type saving it, not the logic.
//
// `invertsKey` does not catch it, for two independent reasons:
//   1. it is only wired to the FUZZY label path, not the exact field_map path this resolved on;
//   2. INVERSION_RE matches the label ("without") AND the key phrase ("requires sponsorship"),
//      so the two cancel and it returns false.
// Both are addressed by asking a narrower question: which DIRECTION does each side state?

// What `true` means for each canonical sponsorship key.
const SPONSORSHIP_KEY_SENSE = {
  requires_sponsorship: 'needs',
  needs_sponsorship:    'needs',
  sponsorship:          'needs',
};

// "…authorized to work WITHOUT sponsorship", "…do NOT require sponsorship", "no sponsorship needed".
// True here means the candidate does NOT need sponsorship — the opposite sense to the keys above.
// The negation alternative deliberately anchors on "not/never/don't" IMMEDIATELY before the verb
// rather than on an auxiliary, so "Do you NOT require sponsorship?" (subject between the two)
// still reads as a negation.
const SPONSORSHIP_WITHOUT_RE =
  /\bwithout\s+(?:requiring\s+|needing\s+)?(?:visa\s+)?sponsorship\b|\b(?:not|never|don'?t|doesn'?t|won'?t)\s+(?:require|requires|requiring|need|needs|needing)\b[^.?]{0,30}\bsponsorship\b|\bno\s+sponsorship\b/i;

// "Do you now or in the future REQUIRE sponsorship…" — same sense as the keys above.
const SPONSORSHIP_NEEDS_RE =
  /\b(?:require|requires|requiring|need|needs|needing|seeking|request)\b[^.?]{0,40}\bsponsorship\b/i;

/**
 * Which direction does this question state, for the sponsorship class?
 * Returns 'needs' | 'without' | null (undetermined).
 * Checked "without" FIRST: "authorized to work without requiring sponsorship" satisfies both
 * patterns, and the negated reading is the correct one.
 */
export function sponsorshipQuestionSense(text) {
  const t = String(text ?? '');
  if (!t) return null;
  if (SPONSORSHIP_WITHOUT_RE.test(t)) return 'without';
  if (SPONSORSHIP_NEEDS_RE.test(t)) return 'needs';
  return null;
}

/**
 * Decide how a stored boolean answers this field.
 *   'direct'   — the stored sense matches the question; use the value as-is
 *   'invert'   — opposite senses; the correct answer is the negation
 *   'unknown'  — cannot be established; the caller MUST refuse rather than guess
 *
 * Only sponsorship is handled: it is the class A1 proved fires, it is a materially false
 * attestation when wrong, and its vocabulary is small enough to enumerate honestly. Any other
 * eligibility class returns 'unknown' so it refuses instead of being silently passed through.
 * Non-eligibility checkboxes ("I agree to the terms") are not eligibility-classed at all and
 * never reach this — they keep the existing pass-through behaviour.
 */
export function booleanPolarity({ label = '', name = '', key = null } = {}) {
  const subject = `${label} ${name}`;
  const cls = eligibilityClassOf(subject);
  if (!cls) return 'direct';               // ordinary checkbox — unchanged behaviour
  if (cls !== 'sponsorship') return 'unknown';

  const keySense = SPONSORSHIP_KEY_SENSE[String(key ?? '').toLowerCase()];
  if (!keySense) return 'unknown';         // not a key whose meaning we can state

  const qSense = sponsorshipQuestionSense(subject);
  if (!qSense) return 'unknown';           // question direction unreadable — refuse, never guess

  return qSense === keySense ? 'direct' : 'invert';
}

// -- Option-set constraint -----------------------------------------------------
// A1 finding #2: the select "Are you legally authorized to work in the country of employment?"
// (options: Yes / No) received the free-text string "Authorized to work in the US (F-1 STEM OPT)"
// at 0.9 confidence. It held only because that string matches no option, so the page-side fill
// was a no-op — but the answer was still RECORDED as answered, with high confidence, and nothing
// noticed that the field a required eligibility question owns had in fact been left empty.
//
// The matcher below mirrors the page-side matching in APPLY_FN_SRC EXACTLY. That equivalence is
// deliberate and is what makes this safe to add: we refuse precisely when the page-side fill
// would have been a no-op anyway, so no field that used to be filled stops being filled. The
// only thing that changes is that an unfillable value is now recorded as unanswered — which the
// completeness gate can act on — instead of being counted as a confident answer.

/** The option a value would actually select on the page, or null if none would match. */
export function matchOptionValue(value, options = []) {
  const v = String(value ?? '').toLowerCase();
  if (!v) return null;
  for (const o of options || []) {
    const ov = String(o?.value ?? '').toLowerCase();
    const ol = String(o?.label ?? '').toLowerCase();
    if ((ol && ol.includes(v)) || (ov && ov.includes(v))) return o.value;
  }
  return null;
}

/** True when an option set is a plain yes/no pair (ignoring an empty "Select…" placeholder). */
export function isYesNoOptionSet(options = []) {
  const vals = (options || [])
    .map(o => normaliseText(o?.label || o?.value))
    .filter(v => v && !/^select/.test(v));
  return vals.length === 2 && vals.some(v => /^y(es)?$/.test(v)) && vals.some(v => /^no?$/.test(v));
}

// Work-authorization status text is free-form ("Authorized to work in the US (F-1 STEM OPT)",
// "US Citizen", "Not authorized"), but the question asking about it is often a Yes/No. Reading a
// status into a yes/no answer needs an enumerated vocabulary, checked NEGATIVE-FIRST so a denial
// can never be read as an affirmative by a stray positive word later in the same sentence.
const WORK_AUTH_NEGATIVE_RE =
  /\b(?:not|never)\s+(?:legally\s+|currently\s+)?(?:authori[sz]ed|eligible|permitted|allowed)\b|\bunauthori[sz]ed\b|\bno\s+(?:work\s+)?authori[sz]ation\b|\bnot\s+(?:a\s+)?(?:us\s+)?citizen\b/i;
const WORK_AUTH_AFFIRMATIVE_RE =
  /\b(?:authori[sz]ed|eligible|permitted|allowed)\s+to\s+work\b|\bwork\s+authori[sz]ation\b|\b(?:u\.?s\.?\s+)?citizen\b|\bpermanent\s+resident\b|\bgreen\s+card\b|\bead\b|\bopt\b|\bcpt\b/i;

/**
 * Read a free-text work-authorization status as yes/no.
 * Returns true / false / null (undetermined — the caller MUST refuse rather than guess).
 */
// Field types whose value must be one of the options the control offers. `multi_select` is
// included because a single resolved value still has to name a real option.
export const OPTION_TYPES = new Set(['select', 'radio', 'multi_select']);

export function workAuthAffirmative(text) {
  const t = String(text ?? '');
  if (!t) return null;
  if (WORK_AUTH_NEGATIVE_RE.test(t)) return false;
  if (WORK_AUTH_AFFIRMATIVE_RE.test(t)) return true;
  return null;
}

/**
 * Normalise a yes/no-ish value to a boolean for checkbox/toggle fields.
 * FAIL-SAFE DIRECTION IS LOAD-BEARING: anything unrecognised is false. Never invent an
 * affirmative — an affirmative is what attests something to an employer.
 */
export function coerceAffirmative(value) {
  if (value === true) return true;
  const v = normaliseText(value);
  return ['yes', 'y', 'true', '1', 'on', 'checked', 'affirmative', 'i do', 'i am', 'agree', 'agreed', 'accept'].includes(v);
}

/**
 * Strip handler_types that discovery inferred from the LABEL MAP and that the guards refuse.
 * Attribute-derived handlers are left alone: `name="requires_sponsorship"` is an exact signal,
 * whereas the label map's `"Name" -> full_name` is a substring guess that then resolves through
 * the *exact* field_map path — the A1 name_ambiguity trap (finding N5).
 */
export function sanitizeDiscoveredFields(fields) {
  for (const f of fields || []) {
    if (f?.handler_source !== 'label' || !f.handler_type) continue;
    const reason = refuseReason({ label: f.label, name: f.name, handler: f.handler_type });
    if (reason) {
      f.handler_rejected = `${f.handler_type}:${reason}`;
      f.handler_type = null;
    }
  }
  return fields;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.join(__dirname, "..", "data", "screenshots");
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// In-progress tracker: jobId -> { status, browser }
const inProgress = new Map();

// -- Fill script injected into page context ------------------------------------
// Logic ported directly from extension/content.js and background.js
const FILL_FN_SRC = `
function(autofillData, labelMap, guards) {
  if (!autofillData || !autofillData.field_map) return 0;
  const fm  = autofillData.field_map;
  const ddm = autofillData.dropdown_map || {};
  const g   = guards || { eligibility: [], canonicalKeys: {}, thirdPartyRe: '$^', identityKeyRe: '$^' };
  let filled = 0;

  // This legacy sweep fills elements DIRECTLY, bypassing buildAnswers and therefore bypassing
  // provenance and the low-confidence hold. A1 proved it independently submits the inverted
  // sponsorship answer via its own labelMap substring match, so restricting buildAnswers alone
  // would have fixed nothing. The same guards are applied here.
  function tokenMatch(hay, needle) {
    const n = String(needle || '').replace(/[_-]+/g, ' ').replace(/\\s+/g, ' ').trim().toLowerCase();
    if (!n) return false;
    const esc = n.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\s+/g, '[\\\\s_-]+');
    try {
      return new RegExp('(?:^|[^a-z0-9])' + esc + '(?:[^a-z0-9]|\$)', 'i')
        .test(String(hay || '').replace(/\\s+/g, ' ').trim().toLowerCase());
    } catch { return false; }
  }
  // True when \`key\` must not fill a field described by \`text\`.
  function refused(text, key) {
    const t = String(text || '');
    if (!t) return false;
    for (const pair of g.eligibility) {
      let re; try { re = new RegExp(pair[1], 'i'); } catch { continue; }
      if (re.test(t)) {
        const ok = (g.canonicalKeys[pair[0]] || []).indexOf(String(key).toLowerCase()) !== -1;
        return !ok;
      }
    }
    try {
      if (new RegExp(g.thirdPartyRe, 'i').test(t) &&
          new RegExp(g.identityKeyRe, 'i').test(String(key).replace(/[_-]+/g, ' '))) return true;
    } catch {}
    return false;
  }
  const describe = (el) =>
    [el.getAttribute('name') || '', el.id || '', el.placeholder || '', el.getAttribute('aria-label') || ''].join(' ');

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
      // Do not overwrite a value that is already there. Steps 2 and 3 always checked this; step 1
      // did not, so it clobbered both ATS-prefilled values (requirement 6) and buildAnswers' own
      // vetted output — it was overwriting a date formatted to the field's advertised MM/DD/YYYY
      // with the raw ISO string, because this key happens to equal the control's name.
      if (el.value) return;
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
    const subject = describe(el);
    for (const [key, fieldKey] of Object.entries(HINT_MAP)) {
      if (tokenMatch(hint, key) && fm[fieldKey]) {
        if (refused(subject, fieldKey)) break;
        setNativeValue(el, fm[fieldKey]); filled++; break;
      }
    }
  });

  // 3. Label-based fill (ATS-specific maps)
  document.querySelectorAll("label").forEach(lbl => {
    const text = lbl.textContent.trim();
    let matchedKey = null;
    for (const [k, fk] of Object.entries(labelMap)) {
      if (tokenMatch(text, k)) { matchedKey = fk; break; }
    }
    if (!matchedKey || !fm[matchedKey]) return;
    const forId = lbl.getAttribute("for");
    const el = forId
      ? (document.getElementById(forId) || document.querySelector('[name="'+forId+'"]'))
      : lbl.querySelector("input,textarea,select");
    if (!el || el.value) return;
    // The label text is the authoritative description here; include the control's own attributes.
    if (refused(text + ' ' + describe(el), matchedKey)) return;
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

// -- Field discovery script (injected into page context) ----------------------
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

  // Whole-token containment, mirroring matchesWholeToken() in Node. Stops the label map's "Name"
  // from claiming "Username"; it does NOT stop it claiming "Name of Referrer" -- "name" is a whole
  // token there -- which is why the returned source matters and Node re-vets label hits.
  function tokenMatch(haystack, needle) {
    // NOTE the doubled backslash. This is inside a template literal, so a single backslash is
    // consumed by the parser: the whitespace class here previously collapsed to the bare letter s,
    // and this line shipped normalising runs of that LETTER instead of whitespace. "First Name"
    // became "fir t name" and never matched, so every multi-word label-map key containing an s
    // silently failed and a shorter key such as "Name" won instead. Guarded by the emitted-source
    // test in test/platformLabelMaps.test.js.
    const n = String(needle || '').replace(/[_-]+/g, ' ').replace(/\\s+/g, ' ').trim().toLowerCase();
    if (!n) return false;
    const esc = n.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\s+/g, '[\\\\s_-]+');
    try {
      return new RegExp('(?:^|[^a-z0-9])' + esc + '(?:[^a-z0-9]|\$)', 'i')
        .test(String(haystack || '').replace(/\\s+/g, ' ').trim().toLowerCase());
    } catch { return false; }
  }

  // Returns { handler, source }. The source lets Node distinguish an exact attribute signal
  // (name="requires_sponsorship") from a label-map substring guess ("Name" -> full_name), which
  // otherwise resolve through the same "exact" field_map path. See sanitizeDiscoveredFields.
  function resolveHandler(el, fieldType, label) {
    const attrNames = ['name','id','autocomplete'];
    const attrVals = attrNames.map(a => (el.getAttribute(a) || '').toLowerCase());
    for (const val of attrVals) {
      if (!val) continue;
      for (const [substr, ht] of Object.entries(handlerByAttr)) {
        if (val.includes(substr)) return { handler: ht, source: 'attr' };
      }
    }
    // file-specific: check label+name+id for resume/cover
    if (fieldType === 'file') {
      const combined = (label + ' ' + attrVals.join(' ')).toLowerCase();
      if (combined.includes('resume') || combined.includes('cv')) return { handler: 'resume', source: 'file' };
      if (combined.includes('cover') || combined.includes('letter')) return { handler: 'cover-letter', source: 'file' };
    }
    // label map -> profile key -> handler
    for (const [k, profileKey] of Object.entries(labelMap)) {
      if (tokenMatch(label, k) && profileKeyToHandler[profileKey]) {
        return { handler: profileKeyToHandler[profileKey], source: 'label' };
      }
    }
    return { handler: null, source: null };
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
    const resolved = resolveHandler(el, fieldType, label);
    const handler_type = resolved.handler;
    const handler_source = resolved.source;
    const is_required = el.required || el.getAttribute('aria-required') === 'true';

    let options = [];
    if (el.tagName === 'SELECT') {
      options = Array.from(el.options).map(o => ({ value: o.value, label: o.text.trim() }));
    } else if (fieldType === 'radio') {
      const radios = document.querySelectorAll('input[type="radio"][name="' + name + '"]');
      options = Array.from(radios).map(r => ({ value: r.value, label: getLabel(r) }));
    }

    let current_value = '';
    if (fieldType === 'checkbox') {
      current_value = el.checked ? 'true' : '';
    } else if (fieldType === 'radio') {
      const checked = document.querySelector('input[type="radio"][name="' + name + '"]:checked');
      current_value = checked ? checked.value : '';
    } else {
      current_value = (el.value !== undefined ? el.value : (el.textContent || '')).trim();
    }

    fields.push({
      field_id: el.id || name,
      name,
      type: fieldType,
      label,
      is_required: !!is_required,
      options,
      handler_type: handler_type || null,
      handler_source: handler_source || null,
      current_value,
    });
  }

  return fields;
}
`;

// -- Apply answers script (injected into page context) -------------------------
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

// -- discoverFields ------------------------------------------------------------
export async function discoverFields(pageOrFrame, provider) {
  try {
    const labelMap = getPlatformLabelMap(provider || 'generic');
    const fields = await pageOrFrame.evaluate(
      `(${DISCOVER_FN_SRC})(${JSON.stringify(HANDLER_BY_ATTR)}, ${JSON.stringify(PROFILE_KEY_TO_HANDLER)}, ${JSON.stringify(labelMap)})`
    );
    // Label-map-derived handlers are re-vetted here, in Node, where the policy is testable.
    return sanitizeDiscoveredFields(fields);
  } catch (e) {
    console.warn("[applyAutomation] discoverFields error:", e.message);
    return [];
  }
}

// -- buildAnswers --------------------------------------------------------------
export function buildAnswers(fields, profilePayload) {
  const { field_map = {}, handler_map = {}, custom_answers = {} } = profilePayload || {};
  const SKIP_TYPES = new Set(['file','hidden','password','static','unknown','complex']);
  const answers = [];

  for (const field of fields) {
    if (SKIP_TYPES.has(field.type)) continue;

    const label = field.label || '';
    const guardCtx = { label, name: field.name || '' };
    let value = null;
    let provenance = null;
    let matched_on = null;
    const refusals = [];

    // 1. handler_map by handler_type — an exact signal, and the strongest one available.
    if (field.handler_type && handler_map[field.handler_type] !== undefined && handler_map[field.handler_type] !== '') {
      value = handler_map[field.handler_type];
      provenance = PROVENANCE.HANDLER_EXACT;
      matched_on = field.handler_type;
    }

    // 2. field_map by handler_type (with dash -> underscore fallback). Also exact: the handler
    //    itself was derived from an attribute, or from a label the guards already vetted in
    //    sanitizeDiscoveredFields.
    if (value === null && field.handler_type) {
      const candidates = [
        field.handler_type,
        field.handler_type.replace(/-/g, '_'),
        ...(HANDLER_TO_PROFILE_KEYS[field.handler_type] || []),
      ];
      const hit = candidates.find(k => field_map[k] !== undefined && field_map[k] !== '');
      // Vet even this exact path: a handler that survived discovery can still be the wrong class
      // for the label (the inversion case), and the key must be legitimate for that class.
      if (hit && !refuseReason({ ...guardCtx, key: hit, handler: field.handler_type })) {
        value = field_map[hit];
        provenance = PROVENANCE.FIELD_MAP_EXACT;
        matched_on = hit;
      } else if (hit) {
        refusals.push(`${hit}:${refuseReason({ ...guardCtx, key: hit, handler: field.handler_type })}`);
      }
    }

    // 3. custom_answers — the user's own answer to this question.
    //
    //    ORDERED AHEAD OF THE FUZZY STEP, and that ordering is load-bearing for the
    //    validation-correction loop. When a field holds as low-confidence, the loop asks the user
    //    and stores their reply here; if the fuzzy step ran first it would keep winning with its
    //    0.3 guess, the stored answer would never be reached, and the loop could never converge —
    //    the same question would be asked forever. An explicit answer to this exact question is
    //    strictly better evidence than a token-subset match against a profile key.
    //
    //    The reverse direction (`ql.includes(lbl)`) is DROPPED: a short label matched almost any
    //    longer stored question. An eligibility field may be answered here only on a
    //    normalised-EXACT question match, which is not a guess — the user answered that question.
    if (value === null && label) {
      const lbl = normaliseText(label);
      for (const [q, a] of Object.entries(custom_answers)) {
        if (a === undefined || a === null || a === '') continue;
        const ql = normaliseText(q);
        if (!ql) continue;
        const exact = ql === lbl;
        // Forward containment only, and only for questions specific enough to mean something.
        const forward = ql.length >= 8 && lbl.includes(ql);
        if (!exact && !forward) continue;
        const reason = refuseReason({ ...guardCtx, key: q, allowEligibilityExactAnswer: exact });
        if (reason) { refusals.push(`custom:${reason}`); continue; }
        value = String(a);
        provenance = PROVENANCE.CUSTOM_ANSWER;
        matched_on = q;
        break;
      }
    }

    // 4. Fuzzy label match against field_map keys — the weakest path, and the one A1 proved
    //    submits false attestations. Whole-token only (not raw substring), refused outright for
    //    eligibility-class and third-party-subject fields, and refused when the label inverts the
    //    key's sense. An exact label match is trustworthy enough to submit; a token-subset match
    //    stays a guess, cannot auto-submit, and becomes a question the loop can ask.
    if (value === null && label) {
      for (const [k, v] of Object.entries(field_map)) {
        if (!v) continue;
        if (!matchesWholeToken(label, k)) continue;
        const reason = refuseReason({ ...guardCtx, key: k });
        if (reason) { refusals.push(`${k}:${reason}`); continue; }
        if (invertsKey(label, k)) { refusals.push(`${k}:inverted_label`); continue; }
        value = v;
        // Guards above are not relaxed for an exact label — only the confidence differs.
        provenance = isExactLabelMatch(label, k) ? PROVENANCE.LABEL_EXACT : PROVENANCE.LABEL_FUZZY;
        matched_on = k;
        break;
      }
    }

    if (value === null) {
      if (refusals.length) {
        answers.push({
          field_id: field.field_id, name: field.name, type: field.type,
          value: null, skipped: true, refusals,
          provenance: null, confidence: 0, clear_first: false, typeahead_selection: null,
        });
      }
      continue;
    }

    const confidence = CONFIDENCE_BY_PROVENANCE[provenance] ?? 0;

    // Type formatting
    let typeahead_selection = null;
    if (field.type === 'checkbox' || field.type === 'toggle') {
      // An eligibility question can state the OPPOSITE direction to the key that answered it —
      // "authorized to work without sponsorship" vs `requires_sponsorship`. Passing the stored
      // value straight through then attests the opposite of the truth. Resolve the direction
      // before coercing; refuse outright when it cannot be established.
      const polarity = booleanPolarity({ label, name: field.name || '', key: matched_on });
      if (polarity === 'unknown') {
        // Same shape as the other refusals: recorded, never typed, so the completeness gate holds
        // and the correction loop can ask the user. Guessing here is a false attestation.
        refusals.push(`${matched_on ?? 'value'}:undetermined_boolean_polarity`);
        answers.push({
          field_id: field.field_id, name: field.name, type: field.type, label,
          required: !!field.is_required,
          options: Array.isArray(field.options) ? field.options : [],
          value: null, skipped: true, refusals,
          provenance: null, confidence: 0, clear_first: false, typeahead_selection: null,
        });
        continue;
      }
      // Case-insensitive, common affirmatives accepted. Unrecognised stays false — see
      // coerceAffirmative: the fail-safe direction is deliberate.
      const affirmative = coerceAffirmative(value);
      value = (polarity === 'invert' ? !affirmative : affirmative) ? 'true' : 'false';
    } else if (OPTION_TYPES.has(field.type) && Array.isArray(field.options) && field.options.length) {
      // Constrain the value to an option this field actually offers.
      let picked = matchOptionValue(value, field.options);

      // A free-text work-authorization status against a Yes/No question: read the status rather
      // than posting it verbatim into a field that cannot hold it.
      if (picked === null && isYesNoOptionSet(field.options) &&
          eligibilityClassOf(`${label} ${field.name || ''}`) === 'work_auth') {
        const affirmative = workAuthAffirmative(value);
        if (affirmative !== null) picked = matchOptionValue(affirmative ? 'yes' : 'no', field.options);
      }

      if (picked === null) {
        // Nothing this field offers matches. The page-side fill would have been a no-op, so this
        // loses no filling that used to happen — it stops the run RECORDING an unfillable value
        // as a confident answer, and lets the completeness gate hold on a required field.
        refusals.push(`${matched_on ?? 'value'}:value_not_in_options`);
        answers.push({
          field_id: field.field_id, name: field.name, type: field.type, label,
          required: !!field.is_required,
          options: field.options,
          value: null, skipped: true, refusals,
          provenance: null, confidence: 0, clear_first: false, typeahead_selection: null,
        });
        continue;
      }
      // Canonical option value, so the page-side match is exact rather than a substring guess.
      value = String(picked);
    } else if (field.type === 'typeahead') {
      typeahead_selection = String(value);
      value = String(value);
    } else if (field.type === 'date' && value) {
      const d = new Date(value);
      if (!isNaN(d.getTime())) value = d.toISOString().slice(0, 10);
      else value = String(value);
    } else {
      value = String(value);
      // A text control can still be a date field; honour a format it explicitly advertises.
      value = formatDateForHint(value, label);
    }

    answers.push({
      field_id: field.field_id,
      name: field.name,
      type: field.type,
      label,
      // Carried so a policy layer can tell "a guess in a field the form demands" (which must stop
      // the run) from "a guess in an optional field" (which can simply be left alone).
      required: !!field.is_required,
      options: Array.isArray(field.options) ? field.options : [],
      value,
      typeahead_selection,
      provenance,
      confidence,
      matched_on,
      // Only an exact-path answer may wipe a value the ATS already parsed from the uploaded
      // resume. A fuzzy or custom answer fills a blank field but never overwrites (requirement 6).
      clear_first: confidence >= CLEAR_FIRST_MIN_CONFIDENCE,
      ...(refusals.length ? { refusals } : {}),
    });
  }

  return answers;
}

// An explicit format hint in a label/placeholder, e.g. "Available from (MM/DD/YYYY)". Only an
// EXPLICIT hint is honoured — DD/MM vs MM/DD is unrecoverable by guessing, and a wrong guess here
// silently misstates a date to an employer.
const DATE_HINT_RE = /\b(MM)\s*[\/.-]\s*(DD)\s*[\/.-]\s*(YYYY)\b|\b(DD)\s*[\/.-]\s*(MM)\s*[\/.-]\s*(YYYY)\b/i;

/**
 * Re-format an ISO-ish date to match a format the field explicitly advertises. A1 trap 6: the
 * field wants MM/DD/YYYY, but because the control is type="text" (not type="date") the ISO
 * normalisation did not apply and "2026-09-01" was submitted verbatim.
 * Returns the original string when there is no hint or the value is not a date.
 */
export function formatDateForHint(value, hintText) {
  const m = DATE_HINT_RE.exec(String(hintText || ''));
  if (!m) return String(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (!iso) return String(value);
  const [, y, mo, d] = iso;
  return m[1] ? `${mo}/${d}/${y}` : `${d}/${mo}/${y}`;
}

// -- Step-scoped answer approval -----------------------------------------------
//
// Every step of a form emits a resolved answer set, and a policy decides what happens to it BEFORE
// anything is typed. Previously all policy ran at the END of a run: by the time the low-confidence
// gate said "this is a guess, hold", the guess had already been typed into steps 1..N of a real
// employer's form and "Next" had been clicked through them. Deciding per step means a run that is
// going to be held is held before it writes anything.
//
// The seam is injectable (`autoApply(..., { answerPolicy })`), which is the hook a confirmation UI
// or a hosted provider would plug into: it receives the step's answers and returns what to do.
//
//   approve  — fill these answers
//   reject   — do not fill these, but continue (a guess in an OPTIONAL field: leaving it blank is
//              more truthful than typing something we do not know)
//   escalate — stop the run now and hand back to a human, before typing anything on this step
//
// A policy receives { step, mode, provider, url, answers, fields } and returns
// { approved?, rejected?, escalate?, reason? }. Omitted fields default to "approve everything".

export const POLICY_ACTIONS = { APPROVE: 'approve', REJECT: 'reject', ESCALATE: 'escalate' };

/**
 * The default policy, derived from what A1–A3 established.
 *
 * semi mode approves everything: a human is looking at the form, and pre-filling a guess for them
 * to correct is the entire point of semi. Full-auto has no such reviewer, so a guess is either
 * stopped (required field — the form cannot proceed without it, so ask with the proposal) or
 * dropped (optional field — continue, leave it blank rather than fabricate).
 */
export function defaultAnswerPolicy({ mode = 'full', answers = [] } = {}) {
  const fillable = answers.filter(a => !a.skipped && a.value !== null);
  if (mode !== 'full') return { approved: fillable };

  const guesses = fillable.filter(a => (a.confidence ?? 0) < AUTO_SUBMIT_MIN_CONFIDENCE);
  if (guesses.length === 0) return { approved: fillable };

  const blocking = guesses.filter(a => a.required);
  if (blocking.length > 0) {
    return {
      approved: [],
      escalate: true,
      reason: 'low_confidence_answers',
      escalated: blocking,
      // Optional guesses are named too, so the caller can see everything the step was unsure about
      // rather than only the part that stopped it.
      rejected: guesses.filter(a => !a.required),
    };
  }
  return {
    approved: fillable.filter(a => !guesses.includes(a)),
    rejected: guesses,
    reason: 'low_confidence_optional',
  };
}

/** Normalise whatever a policy returned into a decision this module can act on. */
export function normalisePolicyDecision(decision, fillable) {
  if (!decision || typeof decision !== 'object') return { approved: fillable, rejected: [], escalate: false };
  const approved = Array.isArray(decision.approved) ? decision.approved : fillable;
  return {
    approved,
    rejected: Array.isArray(decision.rejected) ? decision.rejected : [],
    escalate: decision.escalate === true,
    reason: decision.reason || null,
    escalated: Array.isArray(decision.escalated) ? decision.escalated : [],
  };
}

/**
 * Turn a hold into an answerable question set — the validation-correction loop.
 *
 * `missingRequired` on its own ends a run: it is a list of label strings with no type, no options
 * and no indication of why. That is a dead end. This returns everything needed to ASK, so the
 * answers can come back through `custom_answers`, which is the one resolution path that is exact by
 * construction (see buildAnswers step 4) and therefore safe even for eligibility fields.
 *
 * Two kinds of question:
 *   unanswered      — required and still empty; nothing resolved it
 *   low_confidence  — resolved, but only by a guess, so it must be confirmed rather than submitted
 *
 * `eligibility` is surfaced deliberately: those answers are attestations to an employer, and the UI
 * should say so rather than presenting them as ordinary form fields.
 */
export function buildOpenQuestions({ missingFields = [], lowConfidence = [] } = {}) {
  const seen = new Set();
  const questions = [];

  const push = (q) => {
    const key = normaliseText(q.question);
    if (!key || seen.has(key)) return;
    seen.add(key);
    questions.push(q);
  };

  for (const f of missingFields) {
    const question = f.label || f.name || f.field_id || '';
    if (!question) continue;
    push({
      question,
      field: f.name || f.field_id || null,
      type: f.type || 'text',
      options: Array.isArray(f.options) ? f.options.filter(o => o && o.value !== '') : [],
      required: !!f.is_required,
      eligibility: eligibilityClassOf(`${f.label || ''} ${f.name || ''}`),
      reason: 'unanswered',
      // What the resolver tried and refused, when it tried anything — this is why the field is
      // empty, and it is the difference between "we have no answer" and "we refused to guess".
      refusals: Array.isArray(f.refusals) ? f.refusals : undefined,
    });
  }

  for (const a of lowConfidence) {
    const question = a.field || a.label || a.name || '';
    if (!question) continue;
    push({
      question,
      field: a.name || a.field_id || null,
      type: a.type || 'text',
      options: [],
      required: false,
      eligibility: eligibilityClassOf(question),
      reason: 'low_confidence',
      proposed: a.value ?? null,
      provenance: a.provenance ?? null,
      confidence: a.confidence ?? null,
    });
  }

  return questions;
}

/**
 * Answers that may not be auto-submitted in mode:'full' (requirement 5).
 *
 * `policy_rejected` answers are excluded: the step policy declined to type them, so they are not
 * part of the submission and cannot make it unsafe. Counting them held runs over a guess that had
 * already been dropped — which meant an optional field the policy correctly left blank kept
 * re-opening as a question that answering could never close.
 */
export function lowConfidenceAnswers(answers) {
  return (answers || []).filter(a =>
    !a.skipped && !a.policy_rejected && a.value !== null && (a.confidence ?? 0) < AUTO_SUBMIT_MIN_CONFIDENCE);
}

/** Stable identity for an answer across two runs of the same form. */
const answerKey = (a) => String(a.field_id ?? a.name ?? a.label ?? "");

/**
 * What a human approved, versus what this run is actually about to submit.
 *
 * Approval happens against a PREVIEW pass, and the submitting run resolves the form again — so an
 * employer editing the form in between, or any non-determinism in resolution, would mean submitting
 * something nobody agreed to. Returns the differences; a non-empty result must never be submitted.
 *
 * Deliberately strict in both directions: a changed value is drift, and so is a field being filled
 * that was not in the approved set. Reviewing five answers does not authorise a sixth.
 */
export function driftFromApproved(approved, current) {
  if (!Array.isArray(approved)) return [];
  const live = (approved || []).filter(a => a && !a.skipped && !a.policy_rejected);
  const was = new Map(live.map(a => [answerKey(a), a]));
  const drift = [];
  for (const a of (current || [])) {
    if (a.skipped || a.policy_rejected) continue;
    const key = answerKey(a);
    const before = was.get(key);
    if (!before) {
      drift.push({ field: a.label || a.name || a.field_id, change: "added",
                   approved: null, now: a.value });
    } else if (String(before.value ?? "") !== String(a.value ?? "")) {
      drift.push({ field: a.label || a.name || a.field_id, change: "changed",
                   approved: before.value, now: a.value });
    }
    was.delete(key);
  }
  // Anything approved that this run did not fill: the reviewer saw an answer that is not going.
  for (const [, before] of was) {
    drift.push({ field: before.label || before.name || before.field_id, change: "missing",
                 approved: before.value, now: null });
  }
  return drift;
}

// -- applyTypeaheadAnswer ------------------------------------------------------
async function applyTypeaheadAnswer(page, answer) {
  try {
    const el = answer.field_id
      ? (await page.$('#' + answer.field_id) || await page.$('[name="' + answer.field_id + '"]'))
      : null;
    if (!el) return;
    await el.click();
    // el.type() APPENDS. A1 recorded "Boston, MABoston, MA" because this ran twice and never
    // cleared. Honour clear_first here as the other fill paths do, and never append to a value
    // that is already present: without clear_first permission the existing value is either an
    // ATS-parsed value or our own from a previous pass, and both must be left alone.
    const existing = await el.evaluate(e => e.value || '').catch(() => '');
    if (existing) {
      if (!answer.clear_first) return;
      await el.evaluate(e => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(e, ''); else e.value = '';
        ['input', 'change'].forEach(ev => e.dispatchEvent(new Event(ev, { bubbles: true })));
      });
    }
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

// -- classifyFlowState ---------------------------------------------------------
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

// -- discoverAndFill -----------------------------------------------------------
// page.frames() ALREADY includes the main frame, so the previous `[page, ...page.frames()]`
// processed it twice (A1 finding N3): fieldsFilled reached 198 on a 9-field step, missingRequired
// came back with every entry duplicated, and the typeahead text was typed twice.
export function frameList(page) {
  const frames = page.frames();
  return frames.includes(page.mainFrame()) ? frames : [page.mainFrame(), ...frames];
}

// -- waitForFormReady ----------------------------------------------------------
// Replaces a fixed `setTimeout(1500)` after domcontentloaded.
//
// Every live target renders client-side — Ashby, Greenhouse and Lever all ship a JS bundle that
// builds the form after the document is parsed. A fixed sleep is wrong in both directions: too
// short and discovery walks an empty DOM and reports "Autofilled 0 fields" as a clean run (this
// is what happened on a real Ashby posting — the whole run took 9 seconds); too long and every
// static page pays for the slowest SPA.
//
// The condition is "the form has STOPPED CHANGING and has at least one fillable control", not a
// provider-specific selector and not networkidle:
//   - a selector per provider is a maintenance trap and breaks the moment a provider re-skins;
//   - networkidle never arrives on pages that poll, stream analytics, or hold a socket open —
//     common on all three targets.
// Counting real form controls across every frame works for all of them because whatever the
// framework, what we ultimately have to fill is native <input>/<select>/<textarea> nodes.
// Requiring the count to be STABLE across consecutive polls is what makes it a readiness
// condition rather than a race: a hydrating form's count climbs as nodes mount, so an unchanged
// count means mounting has settled.
export const FORM_READY_POLL_MS = 150;
// 5 polls = 750ms of an unchanged count before we call the form ready.
//
// This number is load-bearing, and the /spa harness route exists to pin it. A real form does not
// mount in one shot — it arrives in chunks as bundles resolve and async data lands. With a 300ms
// window, discovery fired on the FIRST chunk of the /spa form and found 3 of its 8 fields, then
// filled 3 and held on the rest as "incomplete_form": a subtler version of the same bug, where
// the run looks like it worked and quietly submits a partial application. The window has to be
// wider than the realistic gap between chunks, not merely non-zero.
//
// 750ms still puts the static routes at ~900ms, under the 1500ms fixed sleep this replaced.
export const FORM_READY_STABLE_POLLS = 5;
export const FORM_READY_TIMEOUT_MS = 15000;

// A plain EXPRESSION, not an arrow function. frame.evaluate(string) evaluates the string as an
// expression, so `() => ...` would evaluate to a function object and the count would come back
// as undefined — summing that yields NaN, the comparison never matches, and the readiness check
// silently degrades into a full-timeout sleep on every single run. Matches how APPLY_FN_SRC is
// invoked elsewhere in this file.
const COUNT_CONTROLS = `document.querySelectorAll(
  'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]),select,textarea,[contenteditable=true]'
).length`;

export async function waitForFormReady(page, {
  pollMs = FORM_READY_POLL_MS,
  stablePolls = FORM_READY_STABLE_POLLS,
  timeoutMs = FORM_READY_TIMEOUT_MS,
} = {}) {
  const started = Date.now();
  let lastCount = -1, stable = 0;

  while (Date.now() - started < timeoutMs) {
    let count = 0;
    // Sum across frames: workday/icims/taleo put the whole form in an iframe, so a main-frame-only
    // count would report 0 forever and burn the full timeout on a page that was ready immediately.
    for (const frame of frameList(page)) {
      try {
        const n = Number(await frame.evaluate(COUNT_CONTROLS));
        // Coerce defensively: a NaN here would make `count === lastCount` never true and turn
        // this readiness check into a silent full-timeout sleep.
        if (Number.isFinite(n)) count += n;
      } catch { /* frame detached mid-poll */ }
    }

    if (count > 0 && count === lastCount) {
      if (++stable >= stablePolls) {
        return { ready: true, count, waitedMs: Date.now() - started, timedOut: false };
      }
    } else {
      stable = 0;
    }
    lastCount = count;
    await new Promise(r => setTimeout(r, pollMs));
  }

  // Timed out. Report honestly rather than pretending — the caller decides whether a page with no
  // controls is a hold. Never claim readiness we did not observe.
  return { ready: false, count: Math.max(lastCount, 0), waitedMs: Date.now() - started, timedOut: true };
}

async function discoverAndFill(page, frames, provider, autofillData, labelMap, opts = {}) {
  const { policy = defaultAnswerPolicy, mode = 'full', step = 0, touched = new Set() } = opts;
  let filled = 0;
  const collected = [];
  const rejected = [];
  // Raw fields seen across every frame, before any policy filtering. Lets the caller tell
  // "the page had no form at all" from "we declined to answer what was there".
  let fieldCount = 0;

  for (const frame of frames) {
    const fields = await discoverFields(frame, provider);
    fieldCount += fields.length;
    if (fields.length) {
      const answers = buildAnswers(fields, autofillData);
      collected.push(...answers);

      // Refusal records carry value:null and must never reach the page — the generic branch of
      // APPLY_FN_SRC would stringify null into the field.
      const fillable = answers.filter(a => !a.skipped && a.value !== null);

      // ── The approval seam. Nothing is typed before this returns. ──
      let decision;
      try {
        decision = normalisePolicyDecision(
          await policy({ step, mode, provider, url: page.url(), answers, fields, fillable }),
          fillable,
        );
      } catch (e) {
        // A policy that throws must not silently become "approve everything" — that would turn a
        // broken confirmation hook into an unreviewed submission. Escalate instead.
        console.warn('[applyAutomation] answer policy threw — escalating:', e.message);
        decision = { approved: [], rejected: [], escalate: true, reason: 'policy_error', escalated: fillable };
      }

      // Tag on the answer objects themselves — `collected` holds the same references, so the
      // end-of-run gate can tell a dropped guess from a submitted one.
      for (const a of decision.rejected) a.policy_rejected = true;
      if (decision.rejected.length) rejected.push(...decision.rejected);

      if (decision.escalate) {
        return {
          filled,
          fieldCount,
          answers: collected,
          rejected,
          escalation: {
            reason: decision.reason || 'policy_escalation',
            step,
            answers: decision.escalated.length ? decision.escalated : fillable,
          },
        };
      }

      const approved = decision.approved;
      // Remember that this frame owns part of the application. The submit scan is restricted to
      // these: a submit-shaped button inside an untouched third-party iframe (an ad, a captcha, an
      // analytics widget) must never be clicked, and main-frame-only scanning used to prevent that
      // by accident.
      if (approved.length) touched.add(frame);
      const simpleAnswers = approved.filter(a => a.type !== 'typeahead');
      if (simpleAnswers.length) filled += await frame.evaluate(`(${APPLY_FN_SRC})(${JSON.stringify(simpleAnswers)})`).catch(() => 0);
      // The FRAME, not the page: a typeahead inside an iframe was previously looked up in the main
      // document and silently never filled. For a single-document form frame === mainFrame, so this
      // is a no-op there.
      for (const a of approved.filter(a => a.type === 'typeahead')) await applyTypeaheadAnswer(frame, a);
    }
    // Legacy fallback sweep for any inputs discovery missed.
    // NOTE: this path is NOT policy-gated — it fills by attribute/label heuristics inside the page
    // and never produces an answer object to approve. Its A2 guards (eligibility class, third-party
    // subject, whole-token matching) are what keep it in bounds. Bringing it under the policy would
    // mean porting it to the buildAnswers path, which is its own change.
    filled += await fillContext(frame, autofillData, labelMap);
  }
  return { filled, fieldCount, answers: collected, rejected, escalation: null };
}

// -- Helpers -------------------------------------------------------------------
async function fillContext(pageOrFrame, autofillData, labelMap) {
  try {
    // FILL_FN_SRC is an anonymous function expression -- invoke as IIFE with args.
    // Named function expressions (function foo(){}) have their name scoped only
    // inside the body; calling foo() after the expression would ReferenceError.
    // Guards are serialised as regex SOURCES and rebuilt in-page; the policy itself stays defined
    // once, in Node, where it is unit-testable.
    const guards = {
      eligibility:   ELIGIBILITY_PATTERNS.map(([cls, re]) => [cls, re.source]),
      canonicalKeys: ELIGIBILITY_CANONICAL_KEYS,
      thirdPartyRe:  THIRD_PARTY_SUBJECT_RE.source,
      identityKeyRe: IDENTITY_KEY_RE.source,
    };
    return await pageOrFrame.evaluate(
      `(${FILL_FN_SRC})(${JSON.stringify(autofillData)}, ${JSON.stringify(labelMap)}, ${JSON.stringify(guards)})`
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
  // Frame-aware: workday, icims and taleo host the entire application in an iframe, so a
  // main-frame-only scan found no file input at all. With A3's completeness gate now checking
  // required file fields, that meant every run on those providers held on "Resume" — the resume
  // was never uploaded because nothing looked inside the frame. The uploaded flags are shared
  // across frames so one resume is not attached twice.
  let resumeUploaded = false;
  let coverUploaded  = false;
  for (const ctx of frameList(page)) {
    if (resumeUploaded && coverUploaded) break;
    ({ resumeUploaded, coverUploaded } =
      await uploadIntoContext(ctx, resumePath, coverLetterPath, resumeUploaded, coverUploaded));
  }
}

async function uploadIntoContext(page, resumePath, coverLetterPath, resumeUploaded, coverUploaded) {
  try {
    const inputs = await page.$$("input[type='file']");
    if (!inputs.length) return { resumeUploaded, coverUploaded };

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
        resumeUploaded = true;
      }
    }
  } catch (e) {
    console.warn("[applyAutomation] file upload routing:", e.message);
  }
  return { resumeUploaded, coverUploaded };
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
        await btn.click();
        // Same defect as the post-navigation sleep, one step later: step 2 of a multi-step form
        // renders client-side too, so a fixed wait means the next discovery pass can walk a DOM
        // that is still mounting and under-fill the step. Wait on the same readiness condition.
        await waitForFormReady(page);
        return true;
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

// -- Main entry point ----------------------------------------------------------
export async function autoApply(jobUrl, autofillData, options = {}) {
  const {
    mode              = "semi",
    platform          = null,
    resumePath        = null,
    // Promise<string|null> -- resolves to a PDF file path when generation+ATS gate completes,
    // or null if generation failed / ATS score is below threshold / PDF conversion failed.
    // The browser awaits this before the first resume upload attempt, enabling parallel
    // site-visit + generation without blocking navigation or form-fill.
    resumePathPromise        = null,
    coverLetterPath          = null,
    coverLetterPathPromise   = null,
    jobId             = `tmp_${Date.now()}`,
    storageStatePath  = null,
    // Step-scoped approval hook. Receives each step's resolved answer set BEFORE anything is typed
    // and returns { approved?, rejected?, escalate?, reason? }. This is the seam a confirmation UI
    // or a hosted provider plugs into; defaultAnswerPolicy is the built-in behaviour.
    answerPolicy      = defaultAnswerPolicy,
    // Queue-then-approve. The answer set a human approved, from an earlier mode:'preview' pass.
    // When supplied, the run refuses to submit if what it resolves this time differs — see
    // driftFromApproved below.
    approvedAnswers   = null,
  } = options;

  // 'preview' is full-auto in every respect EXCEPT the submit click: same headless browser, same
  // strict answer policy, same gates, browser closed at the end. It exists so a batch can be
  // resolved and parked for review without leaving a visible browser open per job — which is what
  // semi does, and why semi cannot serve a queue.
  const isPreview  = mode === "preview";
  const isFullAuto = mode === "full";
  // Everything gated on "no human is watching this happen" — every gate below reads this, not
  // isFullAuto, so preview reports exactly the outcome a real submit run would reach.
  const isUnattended = isFullAuto || isPreview;
  let browser, page;

  try {
    console.log(`[autoApply] launching browser — mode=${mode} url=${jobUrl}`);
    const isWindows = process.platform === "win32";
    // launchBrowser resolves the best available binary, applies container-safe args,
    // and throws with a structured reasonCode on failure.
    browser = await launchBrowser({
      headless:  isUnattended || !isWindows ? "new" : false,
      mode:      isUnattended ? "auto" : "manual",
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
    // Explicit readiness condition, not a fixed sleep — see waitForFormReady.
    const readiness = await waitForFormReady(page);
    console.log(`[autoApply] form readiness: controls=${readiness.count} waited=${readiness.waitedMs}ms` +
      (readiness.timedOut ? " (TIMED OUT — page never settled with a fillable control)" : ""));

    const detected  = platform || detectPlatformFromUrl(jobUrl) || await detectPlatformFromPage(page);
    const labelMap  = getPlatformLabelMap(detected);
    console.log(`[autoApply] detected platform=${detected}`);

    inProgress.set(String(jobId), { status: "filling", browser });

    let totalFilled = 0;
    // Answers accumulate across every step so the low-confidence gate below sees the whole run,
    // not just the last page. (A dead `fillAllFrames` closure sat here — defined, never called.)
    const resolvedAnswers = [];
    const rejectedAnswers = [];
    // Frames that received at least one approved answer, i.e. that own part of this application.
    const touchedFrames = new Set();
    let escalation = null;
    let stepIndex = 0;
    // Fields seen by the FIRST discovery pass, before any policy filtering. Distinguishes
    // "the page had no form" from "the page had a form we chose not to answer" — those are
    // different failures and used to look identical.
    let firstPassFieldCount = null;
    const runDiscovery = async () => {
      const r = await discoverAndFill(page, frameList(page), detected, autofillData, labelMap,
        { policy: answerPolicy, mode: isUnattended ? 'full' : 'semi', step: stepIndex++, touched: touchedFrames });
      if (firstPassFieldCount === null) firstPassFieldCount = r.fieldCount ?? null;
      totalFilled += r.filled;
      resolvedAnswers.push(...r.answers);
      if (r.rejected?.length) rejectedAnswers.push(...r.rejected);
      if (r.escalation) escalation = r.escalation;
      return !r.escalation;
    };

    await runDiscovery();

    // "Autofilled 0 fields" was previously indistinguishable from a clean run: the pipeline
    // reported autofill_done and carried on to the submit path. A page where we discovered NOTHING
    // is not an application we understand, and it is the third instance of the "logs like success"
    // defect class in this codebase (after the Jobo unconfigured skip and the enrichment
    // empty-write stamp). Emit a distinct outcome and HOLD.
    if (firstPassFieldCount === 0) {
      const pageTitle = await page.title().catch(() => "");
      const ss = await takeScreenshot(page, jobId);
      inProgress.set(String(jobId), { status: "no_fields_discovered", browser: null });
      await browser.close();
      return {
        status:           "no_fields_discovered",
        reasonCode:       "no_fields_discovered",
        reasonDetail:     `No fillable field was discovered in any frame. ` +
                          `Readiness: controls=${readiness.count} waited=${readiness.waitedMs}ms` +
                          `${readiness.timedOut ? " (timed out — page never settled)" : ""}. ` +
                          `Frames=${frameList(page).length}.`,
        fieldsFilled:     0,
        fieldsDiscovered: 0,
        readiness,
        platform:         detected,
        pageTitle,
        screenshotBase64: ss.base64,
        screenshotPath:   ss.path,
      };
    }

    // Resolve effective resume path -- await resumePathPromise if no direct path provided.
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

    // Multi-step pagination. A step that escalates stops the walk: advancing further would mean
    // clicking through an employer's form on the strength of an answer we already decided a human
    // has to see.
    for (let step = 0; step < 8 && !escalation; step++) {
      if (!await clickNext(page)) break;
      if (!await runDiscovery()) break;
      await handleTypedFileUploads(page, effectiveResumePath, effectiveCoverLetterPath);
    }

    // Step-scoped escalation. Reported before the ATS and completeness gates because it happened
    // FIRST, chronologically — during the fill — and because nothing was typed for the offending
    // step. The shape deliberately matches the end-of-run low-confidence hold, so A3's audit
    // persistence and the correction loop consume it unchanged.
    if (isUnattended && escalation) {
      const escalatedAsQuestions = escalation.answers.map(a => ({
        field: a.label || a.name || a.field_id, name: a.name, field_id: a.field_id,
        type: a.type, value: a.value, provenance: a.provenance, confidence: a.confidence,
      }));
      const pageTitleE = await page.title().catch(() => "");
      const ssE = await takeScreenshot(page, jobId);
      inProgress.set(String(jobId), { status: "held_review", browser: null });
      await browser.close();
      return {
        status:           "held_review",
        reasonCode:       escalation.reason,
        flowState:        "form_ready",
        fieldsFilled:     totalFilled,
        lowConfidence:    escalation.answers.map(a => ({
          field: a.label || a.name || a.field_id,
          value: a.value, provenance: a.provenance, confidence: a.confidence, matched_on: a.matched_on,
        })),
        openQuestions:    buildOpenQuestions({ lowConfidence: escalatedAsQuestions }),
        answers:          resolvedAnswers,
        rejectedAnswers:  rejectedAnswers.map(a => ({
          field: a.label || a.name || a.field_id, provenance: a.provenance, confidence: a.confidence,
        })),
        policyEscalation: { step: escalation.step, reason: escalation.reason },
        platform:         detected,
        pageTitle:        pageTitleE,
        screenshotBase64: ssE.base64,
        screenshotPath:   ssE.path,
      };
    }

    // ATS gate: if a resumePathPromise was provided but resolved to null (generation failed,
    // ATS below threshold, or PDF conversion failed) -- do NOT auto-submit.
    if (isUnattended && resumePathPromise && !effectiveResumePath) {
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
    if (isUnattended && (flowState === 'login_required' || flowState === 'captcha_required' || flowState === 'expired')) {
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
    let submitVerified = null, submitEvidence = null, submitReasonCode = null;
    if (isUnattended) {
      // Completeness gate: re-discover all frames; hold if any required non-file field is still empty.
      const postFillFields = (await Promise.all(
        frameList(page).map(f => discoverFields(f, detected).catch(() => []))
      )).flat();
      // A1 finding N2: required FILE inputs used to be exempt here, so a form with no resume
      // attached passed the gate while the browser refused to submit it — the run then reported
      // filled_not_submitted with no reasonCode, having never reached the later steps. A file
      // input's value is readable ('' when empty), so it is checked like any other control.
      const missingFields = postFillFields
        .filter(f => f.is_required && (f.current_value === '' || f.current_value == null));
      const missingRequired = missingFields.map(f => f.label || f.field_id || '(unknown)');
      if (missingRequired.length > 0) {
        // Attach what the resolver refused for each field, so a question can explain itself
        // ("we did not guess your sponsorship answer") rather than just being blank.
        const refusalsByField = new Map();
        for (const a of resolvedAnswers) {
          if (a.skipped && a.refusals?.length) refusalsByField.set(a.field_id ?? a.name, a.refusals);
        }
        for (const f of missingFields) {
          const r = refusalsByField.get(f.field_id) ?? refusalsByField.get(f.name);
          if (r) f.refusals = r;
        }
        const pageTitle2 = await page.title().catch(() => '');
        const ss2 = await takeScreenshot(page, jobId);
        inProgress.set(String(jobId), { status: 'held_review', browser: null });
        await browser.close();
        return {
          status:           'held_review',
          reasonCode:       'incomplete_form',
          flowState:        'form_ready',
          fieldsFilled:     totalFilled,
          missingRequired,
          openQuestions:    buildOpenQuestions({ missingFields }),
          answers:          resolvedAnswers,
          platform:         detected,
          pageTitle:        pageTitle2,
          screenshotBase64: ss2.base64,
          screenshotPath:   ss2.path,
        };
      }

      // Low-confidence gate (requirement 5): a label_fuzzy answer is a guess, and this pipeline
      // submits under a real candidate's name. Hold for a human instead of auto-submitting, and
      // name the answers that caused it. Same flag-don't-fabricate rule as the resume failsafe,
      // applied where the stakes are higher.
      const lowConfidence = lowConfidenceAnswers(resolvedAnswers);
      if (lowConfidence.length > 0) {
        const lowConfidenceQuestions = lowConfidence.map(a => ({
          field: a.label || a.name || a.field_id, name: a.name, field_id: a.field_id,
          type: a.type, value: a.value, provenance: a.provenance, confidence: a.confidence,
        }));
        const pageTitle3 = await page.title().catch(() => '');
        const ss3 = await takeScreenshot(page, jobId);
        inProgress.set(String(jobId), { status: 'held_review', browser: null });
        await browser.close();
        return {
          status:           'held_review',
          reasonCode:       'low_confidence_answers',
          flowState:        'form_ready',
          fieldsFilled:     totalFilled,
          lowConfidence:    lowConfidence.map(a => ({
            field: a.label || a.name || a.field_id,
            value: a.value,
            provenance: a.provenance,
            confidence: a.confidence,
            matched_on: a.matched_on,
          })),
          openQuestions:    buildOpenQuestions({ lowConfidence: lowConfidenceQuestions }),
          answers:          resolvedAnswers,
          platform:         detected,
          pageTitle:        pageTitle3,
          screenshotBase64: ss3.base64,
          screenshotPath:   ss3.path,
        };
      }

      // DRIFT GATE. The approved answers came from a preview pass against this same form; this run
      // resolved it again. If the two disagree, the thing about to be submitted is not the thing a
      // human agreed to, and a submission cannot be recalled — so hold rather than guess which is
      // right. Runs before the preview stop below so an approved re-run and a fresh preview are
      // checked by the same code.
      if (approvedAnswers) {
        const drift = driftFromApproved(approvedAnswers, resolvedAnswers);
        if (drift.length > 0) {
          const pageTitleD = await page.title().catch(() => '');
          const ssD = await takeScreenshot(page, jobId);
          inProgress.set(String(jobId), { status: 'held_review', browser: null });
          await browser.close();
          return {
            status:       'held_review',
            reasonCode:   'answers_changed_since_approval',
            flowState:    'form_ready',
            fieldsFilled: totalFilled,
            drift,
            answers:      resolvedAnswers,
            platform:     detected,
            pageTitle:    pageTitleD,
            screenshotBase64: ssD.base64,
            screenshotPath:   ssD.path,
          };
        }
      }

      // PREVIEW STOP. Everything above has run — the ATS gate, terminal flow states, the
      // completeness gate, the low-confidence gate — so this reports the outcome a real submit run
      // would reach. The only thing not done is the click.
      if (isPreview) {
        const pageTitleP = await page.title().catch(() => '');
        const ssP = await takeScreenshot(page, jobId);
        inProgress.set(String(jobId), { status: 'preview_ready', browser: null });
        await browser.close();
        return {
          status:       'preview_ready',
          reasonCode:   'awaiting_approval',
          flowState:    'form_ready',
          fieldsFilled: totalFilled,
          answers:      resolvedAnswers,
          rejectedAnswers: rejectedAnswers.map(a => ({
            field: a.label || a.name || a.field_id, provenance: a.provenance, confidence: a.confidence,
          })),
          platform:     detected,
          pageTitle:    pageTitleP,
          screenshotBase64: ssP.base64,
          screenshotPath:   ssP.path,
        };
      }

      inProgress.set(String(jobId), { status: "submitting", browser });
      const SUBMIT_RE = /^(submit|apply|apply now|submit application|send application)/i;
      let clicked = false;
      let clickedFrame = null;
      const urlBefore = page.url();

      // CROSS-FRAME SUBMIT. Previously main-frame-only, so a form hosted in an iframe was filled
      // completely, passed every gate, and then stopped at `no_submit_button`. That made submission
      // arbitrary on greenhouse, which embeds its form in an iframe on some boards and not others:
      // identical applications either went out or silently did not, depending on the embed.
      //
      // Scope is deliberately narrow — the main frame plus frames we actually filled — so a
      // submit-shaped button in an untouched third-party frame is never clicked.
      const submitCandidates = [page.mainFrame(), ...touchedFrames].filter(
        (f, i, arr) => f && arr.indexOf(f) === i
      );
      const framesBefore = new Map();
      for (const f of submitCandidates) {
        try { framesBefore.set(f, f.url()); } catch {}
      }

      for (const ctx of submitCandidates) {
        if (clicked) break;
        let buttons = [];
        try { buttons = await ctx.$$("button,input[type='submit']"); } catch { continue; }
        for (const btn of buttons) {
          try {
            const txt = (await btn.evaluate(el => el.textContent || el.value || "")).trim();
            const visible = await btn.evaluate(el => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            });
            if (SUBMIT_RE.test(txt) && visible) {
              await btn.click();
              // Give a navigation the chance to happen instead of assuming it did. An iframe-hosted
              // form usually navigates the FRAME, not the page, so both are awaited.
              await Promise.race([
                page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null),
                ctx === page.mainFrame()
                  ? new Promise(() => {})
                  : ctx.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null),
                new Promise(r => setTimeout(r, 2000)),
              ]);
              clicked = true;
              clickedFrame = ctx;
              break;
            }
          } catch {}
        }
      }

      // A1 finding N1: `submitted` was previously set by the CLICK ALONE, with nothing checking
      // that anything was actually sent. A form blocked by HTML5 validation produced
      // status:'submitted' with zero submissions recorded on the receiving end — a silent
      // non-application, and self-concealing, because the duplicate guard then treats the job as
      // done and never retries it. Require post-click evidence.
      //
      // The evidence has to be gathered where the submission happened: an iframe-hosted form leaves
      // the main document's URL and body untouched, so main-frame-only checks would report
      // `clicked_no_evidence` for a submission that genuinely succeeded — N1's guarantee inverted
      // into a false negative.
      const urlAfter = page.url();
      const evidence = [];
      let postFlow = flowState;
      if (clicked) {
        const inClickedFrame = clickedFrame && clickedFrame !== page.mainFrame()
          ? await classifyFlowState(clickedFrame, null).catch(() => null)
          : null;
        postFlow = await classifyFlowState(page, originalDomain);
        if (postFlow === "submitted") evidence.push("confirmation_page");
        else if (inClickedFrame === "submitted") { evidence.push("frame_confirmation_page"); postFlow = "submitted"; }
        for (const [f, before] of framesBefore) {
          try {
            if (f.url() !== before) { evidence.push(f === page.mainFrame() ? "url_changed" : "frame_url_changed"); }
          } catch {}
        }
      }
      if (urlAfter !== urlBefore && !evidence.includes("url_changed")) evidence.push("url_changed");

      if (flowState === "submitted") {
        // Already on a confirmation page before we clicked anything.
        status = "submitted";
        submitVerified = true;
        submitEvidence = "confirmation_page_pre_click";
      } else if (clicked && evidence.length > 0) {
        status = "submitted";
        submitVerified = true;
        // Which frame submitted is part of the audit: it is the difference between a main-document
        // submission and an embedded one, and it is what makes a cross-frame claim checkable.
        submitEvidence = [...new Set(evidence)].join(",") +
          (clickedFrame && clickedFrame !== page.mainFrame() ? "|frame" : "");
      } else if (clicked) {
        // The dangerous case: a submit-shaped button was clicked and nothing changed.
        status = "filled_not_submitted";
        submitVerified = false;
        submitEvidence = "clicked_no_evidence";
        submitReasonCode = "submit_unverified";
      } else {
        status = "filled_not_submitted";
        submitVerified = false;
        submitEvidence = "no_submit_button";
      }
      pageTitle = await page.title().catch(() => "");
    } else {
      status    = "awaiting_user";
      pageTitle = await page.title().catch(() => "");
    }

    console.log(`[autoApply] done — status=${status} fieldsFilled=${totalFilled}`);
    const ss = await takeScreenshot(page, jobId);
    inProgress.set(String(jobId), { status, browser: isUnattended ? null : browser });
    if (isUnattended) await browser.close();

    return {
      status,
      flowState,
      platform: detected,
      fieldsFilled: totalFilled,
      answers: resolvedAnswers,
      // Guesses the policy declined to type into optional fields. Recorded rather than dropped
      // silently: "we left this blank on purpose" is a different fact from "we never saw it".
      ...(rejectedAnswers.length ? {
        rejectedAnswers: rejectedAnswers.map(a => ({
          field: a.label || a.name || a.field_id, provenance: a.provenance, confidence: a.confidence,
        })),
      } : {}),
      submitVerified,
      submitEvidence,
      ...(submitReasonCode ? { reasonCode: submitReasonCode } : {}),
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
    // Attribute by CAUSE. This used to default every unrecognised error to "browser_error",
    // which is how an Anthropic 404 was reported as a browser failure — the browser had
    // navigated, audited and autofilled successfully. An unattributable error is now
    // "internal_error": an honest unknown, rather than a confident accusation against a
    // subsystem that then gets debugged for nothing.
    const attributed = classifyRuntimeError(e);
    return {
      status: "error",
      error: e.message,
      reasonCode: attributed.reasonCode,
      reasonDetail: attributed.detail,
      // Null when unknown. A permanent failure must never be retried — a 404 on a model name
      // fails identically every time.
      permanent: attributed.permanent,
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
