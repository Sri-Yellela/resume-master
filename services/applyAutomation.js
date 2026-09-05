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
  // A sponsorship answer is COMPUTED from the tri-state for the tense the question asks about,
  // never read off a stored yes/no. See the sponsorship tense section below.
  SPONSORSHIP_DERIVED:       'sponsorship_derived',
  SPONSORSHIP_ASSUMED_FUTURE:'sponsorship_assumed_future',
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
  // Derived from an explicitly stated fact and an explicitly tensed question — not a guess about
  // either, so it carries the same weight as an attribute hit.
  sponsorship_derived:        1.0,
  // The question named no tense, so the disclosing reading was used (see sponsorshipAnswer).
  // Deliberately BELOW AUTO_SUBMIT_MIN_CONFIDENCE: reading an employer's intent about someone's
  // immigration status is exactly the judgement a human should confirm, so full-auto holds on it.
  sponsorship_assumed_future: 0.75,
};

// Below this, an answer may not be auto-submitted in mode:'full' (requirement 5).
export const AUTO_SUBMIT_MIN_CONFIDENCE = 0.8;
// Below this, an answer may not wipe a value the ATS already parsed from the resume
// (requirement 6). Only the two exact paths clear a prefilled field.
export const CLEAR_FIRST_MIN_CONFIDENCE = 0.9;

// The flow states that are GATES: a human can cross them, so the run holds with a prepared packet
// rather than failing (TASK G1, docs/GATED_HANDOFF_ARCHITECTURE.md §3). Deliberately NOT including
// 'expired' — an expired posting has nothing behind it for a human to finish, and conflating the two
// would offer a handoff for an application that cannot exist.
export const GATE_FLOW_STATES = new Set(['login_required', 'captcha_required']);

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

// -- Credential fields ---------------------------------------------------------
// A portal's SIGN-IN box is not an application field, and the candidate's details must never be
// typed into one.
//
// This is not hypothetical. A gated posting redirects to a sign-in page; discovery walks it, finds
// an input named `login_email` labelled "Email", resolves it to the `email` handler and fills it
// with the candidate's address at field_map_exact — 0.9 confidence, the second-highest tier. The run
// then correctly detects the gate and holds, having already typed into a third party's login form.
// Nothing was submitted, but the address was entered, and on a real portal an email in a sign-in box
// is an account-existence probe against that candidate's own identity.
//
// Two signals, and the first is the one that generalises:
//
//   1. THE OWNING FORM CONTAINS A PASSWORD INPUT. That form is a credential form whatever its
//      controls are called, which catches `login_email`, a plain `email`, and anything else in it.
//      This deliberately also refuses a form that mixes application fields with account creation —
//      filling one of those IS automated account creation, which the design places permanently out
//      of scope, so refusing is the boundary being enforced rather than a capability lost.
//
//   2. The control itself names a credential. Catches a login box that is not inside a <form> at
//      all, which is common in SPA portals.
//
// Kept separate from the gate CLASSIFIER on purpose. classifyFlowState decides what a page is;
// this decides what a control is, and it has to hold on pages the classifier does not flag — a
// sign-in widget beside a real application form, or a login form the heuristics simply miss.
export const CREDENTIAL_AUTOCOMPLETE = new Set([
  'username', 'current-password', 'new-password', 'one-time-code',
]);

// Tested against a subject with [_-] normalised to spaces, because \b does not break on an
// underscore: `login_email` is one word to a word-boundary regex, so /\blogin\b/ never matches it —
// which is precisely the field this exists to catch.
export const CREDENTIAL_SUBJECT_RE =
  /\b(?:user\s?name|user\s?id|login|log\s?in|sign\s?in|password|passwd|passphrase|passcode|one\s?time\s?code|verification\s?code|security\s?code|otp|2fa|mfa)\b/i;

/**
 * True when a discovered control belongs to a credential form, or is itself a credential field.
 * Such a control is never answered, in any mode, on any page.
 */
export function isCredentialField({
  name = '', id = '', label = '', autocomplete = '', type = '', in_credential_form = false,
} = {}) {
  if (String(type).toLowerCase() === 'password') return true;
  if (in_credential_form) return true;
  if (CREDENTIAL_AUTOCOMPLETE.has(String(autocomplete).toLowerCase().trim())) return true;
  return CREDENTIAL_SUBJECT_RE.test(`${name} ${id} ${label}`.replace(/[_-]+/g, ' '));
}

// Negation/inversion tokens. A key must not fuzzy-match a label that inverts its sense.
const INVERSION_RE = /\b(?:not|never|without|require[sd]?|requiring|need(?:s|ed)?|unable|cannot|can't|don'?t|do\s+not|lack)\b/i;

// Exported because services/customAnswers.js expands `{company}` templates into the literal question
// text this same function then matches on. If the two normalisers ever diverged, a template would
// expand to a key buildAnswers could no longer match, and the answer would silently go missing.
export const normaliseText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
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

// -- Sponsorship TENSE: one boolean cannot answer a two-tense question ---------
// The A5 live-run review (docs/auto-apply-a5-live-run.md §4.1) found the failure the direction
// layer above does not cover. `requires_sponsorship` is a single boolean, and the canonical
// Greenhouse question is "do you NOW OR IN THE FUTURE require sponsorship". For a candidate on
// F-1 STEM OPT both tenses are true at once and they DISAGREE: no sponsorship is needed today,
// and H-1B will be needed when OPT expires. Answering the future-inclusive question from the
// present-tense boolean submitted "No" — a false material attestation — at handler_exact/1.0,
// the most trustworthy tier the resolver has, with no flag and the completeness gate satisfied.
//
// The A1 trap matrix could not see this: its payload carries no sponsorship key at all, so it
// exercised the fallthrough refusal. buildAutofillPayload does carry one.
//
// The fix is to stop storing an ANSWER and store the SITUATION instead. Three values cover it:
//   'none'   — never needs sponsorship (citizen, permanent resident)
//   'future' — authorized now under a time-limited status, will need sponsorship later (OPT/CPT/J-1)
//   'now'    — needs sponsorship to start at all
// and the answer to a given question is computed from that plus the question's own tense.
export const SPONSORSHIP_NEEDS = new Set(['none', 'future', 'now']);

// Future-inclusive scope. Checked FIRST, because the canonical wording contains BOTH markers
// ("now or in the future") and the future reading is the one that governs.
const SPONSORSHIP_FUTURE_RE =
  /\b(?:in\s+the\s+future|at\s+any\s+(?:point|time)|ever|eventually|at\s+some\s+point|down\s+the\s+(?:road|line)|future)\b/i;
// Present-only scope — the question explicitly limits itself to today.
const SPONSORSHIP_PRESENT_RE =
  /\b(?:currently|presently|today|right\s+now|at\s+(?:this|the\s+present)\s+time)\b/i;

/**
 * Which time scope does this sponsorship question ask about?
 * Returns 'future' | 'present' | null (the question names no tense).
 */
export function sponsorshipQuestionTense(text) {
  const t = String(text ?? '');
  if (!t) return null;
  if (SPONSORSHIP_FUTURE_RE.test(t)) return 'future';
  if (SPONSORSHIP_PRESENT_RE.test(t)) return 'present';
  return null;
}

/**
 * The candidate's situation as a tri-state, from a profile row.
 *
 * `sponsorship_need` is authoritative when set. Otherwise it is derived from the legacy boolean,
 * and the derivation deliberately REFUSES the one case that caused the bug: `requires_sponsorship=0`
 * on a profile whose visa/work-auth text names a time-limited status is ambiguous between 'none'
 * and 'future', because the 0 was set against the present-tense reading. Guessing 'none' there is
 * precisely the false attestation this exists to stop, so it returns null and the resolver holds.
 *
 * Returns 'none' | 'future' | 'now' | null (unknown — the caller must refuse).
 */
export function resolveSponsorshipNeed(profile) {
  const explicit = String(profile?.sponsorship_need ?? '').toLowerCase();
  if (SPONSORSHIP_NEEDS.has(explicit)) return explicit;

  if (profile?.requires_sponsorship) return 'now';

  // A time-limited authorization means "not now" does not imply "not ever".
  const statusText = `${profile?.visa_type ?? ''} ${profile?.work_auth ?? ''}`;
  const TEMPORARY_STATUS_RE =
    /\b(?:f-?1|opt|stem\s*opt|cpt|j-?1|h-?4|l-?2|tn\b|ead|student\s+visa|work\s+permit|h-?1-?b)\b/i;
  if (TEMPORARY_STATUS_RE.test(statusText)) return null;

  return 'none';
}

/**
 * The truthful answer to THIS sponsorship question.
 *
 * Returns { affirmative, tense, assumed } — or null when the situation is unknown or the
 * question's direction cannot be read, in which case the caller must refuse rather than guess.
 *
 * When the question names no tense, the FUTURE-INCLUSIVE reading is used. That choice is
 * deliberate and it is not a coin toss: across both question directions the future-inclusive
 * answer is the one that DISCLOSES the sponsorship need. Over-disclosing is honest; the opposite
 * error is a misrepresentation to an employer. It is marked `assumed` so it scores below the
 * auto-submit floor and a human is asked.
 */
export function sponsorshipAnswer({ label = '', name = '', need = null } = {}) {
  if (!SPONSORSHIP_NEEDS.has(String(need ?? ''))) return null;
  const subject = `${label} ${name}`;
  const sense = sponsorshipQuestionSense(subject);
  if (!sense) return null;

  const read  = sponsorshipQuestionTense(subject);
  const tense = read || 'future';
  const needsAtTense = need === 'now' ? true
    : need === 'future' ? tense === 'future'
    : false;

  return {
    affirmative: sense === 'needs' ? needsAtTense : !needsAtTense,
    tense,
    assumed: !read,
  };
}

/** Was this answer produced by sponsorshipAnswer? Its direction is already resolved. */
export function isDerivedSponsorship(provenance) {
  return provenance === PROVENANCE.SPONSORSHIP_DERIVED ||
         provenance === PROVENANCE.SPONSORSHIP_ASSUMED_FUTURE;
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

// -- Submit-button classification ----------------------------------------------
// A1 trap 4: SUBMIT_RE was /^(submit|apply|...)/i — anchored at ^, so Lever's "Review and Submit"
// never matched and a fully filled, fully gated application silently ended as
// filled_not_submitted. The qualifier before the verb is common ("Review and Submit", "Confirm
// and Submit"), so the anchor rejects exactly the phrasing real ATSes use.
//
// Dropping the anchor alone would be dangerous: bare /submit|apply/ also matches "Submit
// feedback", "Submit a question" and "Apply filters" — and this regex decides which button gets
// CLICKED to send a real application under a real person's name. So the rule is:
//   - reject anything that names a different action, FIRST;
//   - accept "submit"/"send" wherever they appear (that verb has no other job on an application
//     form once the non-application actions above are excluded);
//   - accept "apply" only as the WHOLE label ("Apply", "Apply Now"), because "apply" is a common
//     verb for non-submitting controls ("Apply filters") in a way "submit" is not.

// Checked first. A submit-shaped verb doing some other job.
const NOT_SUBMIT_RE =
  /\b(?:feedback|question|comment|inquiry|enquiry|filter|filters|coupon|promo|search|newsletter|subscribe|referral|refer|later|draft|withdraw|cancel|delete|remove|report)\b/i;

// "Submit", "Submit Application", "Review and Submit", "Send Application", "Finish and Submit".
const STRONG_SUBMIT_RE = /\b(?:submit|send)\b/i;
// "Apply" / "Apply Now" as the entire label — never "Apply filters".
const WEAK_SUBMIT_RE = /^apply(?:\s+now)?[\s.!]*$/i;

/**
 * Score a button label as the application's submit control.
 *   2 — strong: names the submit/send action
 *   1 — weak:   an "Apply"-only label
 *   0 — not a submit control
 *
 * Scored rather than first-match because the scan now accepts a qualifier before the verb, so a
 * page can offer more than one candidate; the strongest is clicked, not merely the first found.
 */
export function classifySubmitLabel(text) {
  const t = String(text ?? '').trim();
  if (!t) return 0;
  if (NOT_SUBMIT_RE.test(t)) return 0;
  if (STRONG_SUBMIT_RE.test(t)) return 2;
  if (WEAK_SUBMIT_RE.test(t)) return 1;
  return 0;
}

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
    // A credential control is marked before anything else and keeps NO handler, whatever the handler
    // was derived from. The login_email case resolved through an ATTRIBUTE, not a label, so a check
    // scoped to label-derived handlers — like the one below — would have let it straight through.
    if (isCredentialField(f)) {
      f.credential = true;
      if (f.handler_type) f.handler_rejected = `${f.handler_type}:credential_field`;
      f.handler_type = null;
      continue;
    }
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

// ── TASK AC4: ABORT ──────────────────────────────────────────────────────────────────────────
//
// A run being aborted while its browser is filling must terminate cleanly, MUST NOT SUBMIT, and
// must release its packet. The packet is the caller's job (routes/apply.js voids it); the two
// halves here are the flag and the browser.
//
// WHY BOTH, AND WHY IN THIS ORDER. Closing the browser alone is not an abort — it is a crash. Every
// pending page operation rejects, autoApply's catch runs, and the run is recorded as `failed` with
// whatever Puppeteer said, which is a lie about what happened and puts a "Retry" button on a thing
// the user deliberately stopped. So the FLAG is set first and the browser closed second: whichever
// of the two the run notices, it reports `cancelled`, because the flag is checked before the catch
// attributes anything.
//
// WHAT HAPPENS TO THE IN-FLIGHT PUPPETEER CONTEXT, precisely: browser.close() terminates the
// Chromium process. The page, every frame, and the filled DOM go with it — that DOM only ever
// existed in that process, which is the same fact AB1 was built around. Any await in flight
// (a navigation, a click, a screenshot) rejects with a "Target closed" / "Session closed" error,
// which classifyRuntimeError would attribute to the browser; the flag check in front of it is what
// stops that misattribution.
//
// THE SUBMIT GUARANTEE, and its exact limit. The flag is checked immediately before the submit
// click and after every gate, so an abort that arrives at any point up to that check cannot result
// in a submission. An abort that arrives in the microseconds AFTER the check and BEFORE the click
// has dispatched cannot be un-clicked by anything — no flag and no process kill can recall a
// request the network has already taken. That window is bounded by one statement, it is reported
// honestly (the run records what it observed rather than assuming), and it is the only case where
// "aborted" and "submitted" can both be near-true. Closing the browser mid-click does not help and
// can hurt: it would leave the run unable to READ whether the submit landed, turning a knowable
// outcome into an unknown one.
// jobId -> the epoch ms the abort was requested at. A TIMESTAMP rather than a Set membership, for
// the reason in ABORT_FLAG_TTL_MS below.
const aborted = new Map();

/**
 * How long an abort request stays in force.
 *
 * THE FLAG CANNOT SIMPLY BE PERMANENT, and it cannot be cleared immediately either — this is the
 * whole reason it is timestamped:
 *
 *   Permanent would be wrong because the key is the JOB (the posting), and the same posting is
 *   routinely re-queued and re-run. One abort would silently cancel every future attempt at that
 *   job, and nothing would say why.
 *
 *   Clearing it the moment browser.close() resolves is ALSO wrong, and was the first version of
 *   this: close() resolves as soon as the process is gone, while the run that was awaiting a page
 *   operation is still unwinding through its own catch. Clear the flag in that window and the catch
 *   sees no abort, attributes the "Target closed" to the browser, and records a deliberate stop as
 *   a failure with a Retry button on it. The DB guard still protects the STATUS, but the run's
 *   failed_count and its error log would both be lying.
 *
 * So it expires. Five minutes is far longer than any unwind (a page operation times out in 30s) and
 * far shorter than the time it takes a user to re-queue and re-dispatch the same posting. The
 * normal path does not rely on the TTL at all — processRunJob clears the flag in its `finally`, as
 * soon as the run it belongs to has actually finished. The TTL is the backstop for the case where
 * no run was in flight to clear it.
 */
export const ABORT_FLAG_TTL_MS = 5 * 60 * 1000;

/**
 * Ask an in-flight run to stop. Idempotent, and safe to call for a job that is not running.
 * @param {string|number} jobId
 */
export async function requestAbort(jobId) {
  const key = String(jobId);
  // Flag FIRST. See above: a browser closed without the flag is indistinguishable from a crash.
  aborted.set(key, Date.now());
  const entry = inProgress.get(key);
  if (entry?.browser) {
    try { await entry.browser.close(); } catch { /* already gone: the abort still stands */ }
  }
  inProgress.set(key, { status: "cancelled", browser: null });
}

/** Whether an abort has been requested for this job, and is still in force. */
export function isAbortRequested(jobId) {
  const at = aborted.get(String(jobId));
  if (at == null) return false;
  if (Date.now() - at > ABORT_FLAG_TTL_MS) { aborted.delete(String(jobId)); return false; }
  return true;
}

/**
 * Forget an abort, so a later run of the same job is not stopped by an old request.
 *
 * Called by processRunJob's `finally` — i.e. once the run it belongs to has fully unwound and
 * recorded itself. NOT by the abort endpoint: see ABORT_FLAG_TTL_MS for why clearing it as soon as
 * the browser closes loses the race with the run's own catch.
 */
export function clearAbort(jobId) {
  aborted.delete(String(jobId));
  inProgress.delete(String(jobId));
}

/** The result an aborted run returns. Never `error` — nothing went wrong, the user stopped it. */
function abortedResult(fieldsFilled = 0) {
  return {
    status: "cancelled",
    reasonCode: "user_aborted",
    reasonDetail: "You stopped this application. Nothing was submitted.",
    fieldsFilled,
    submitVerified: false,
    submitEvidence: "aborted_before_submit",
  };
}

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

  // A portal's SIGN-IN box is not an application field. This sweep bypasses buildAnswers entirely,
  // so the credential rule has to be enforced here as well or it is not enforced on this path at
  // all — the same reason the eligibility guards above are duplicated into it. The policy itself is
  // defined once, in Node (isCredentialField); only its regex source crosses into the page.
  function isCredential(el) {
    try {
      const form = el.form || el.closest('form');
      if (form && form.querySelector('input[type="password"]')) return true;
    } catch {}
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase().trim();
    if ((g.credentialAutocomplete || []).indexOf(ac) !== -1) return true;
    const lbl = (el.labels && el.labels[0] ? el.labels[0].textContent : '') || '';
    try {
      return new RegExp(g.credentialRe, 'i')
        .test((describe(el) + ' ' + lbl).replace(/[_-]+/g, ' '));
    } catch { return false; }
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
      if (isCredential(el)) return;
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
    if (isCredential(el)) return;
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
    if (isCredential(el)) return;
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
      if (isCredential(sel)) return;
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
    if (isCredential(r)) return;
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

    // Reported, not decided, in the page: whether this control sits in a form that also holds a
    // password input. The DECISION is isCredentialField() in Node, where it is unit-testable — this
    // side only supplies the one fact that needs the DOM.
    const ownerForm = el.form || el.closest('form');
    const in_credential_form = !!(ownerForm && ownerForm.querySelector('input[type="password"]'));

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
      autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
      in_credential_form,
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
export async function discoverFields(pageOrFrame, provider, derivedLabelMap = null) {
  try {
    // TASK H — the derived half is merged UNDER the authored map, never over it. See
    // getPlatformLabelMap: the authored entries are where the eligibility labels live.
    const labelMap = getPlatformLabelMap(provider || 'generic', derivedLabelMap);
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
  // The tri-state, not an answer. A stored yes/no cannot answer both tenses of the sponsorship
  // question — see the sponsorship tense section and docs/auto-apply-a5-live-run.md §4.1.
  //
  // PRESENT-BUT-NULL IS NOT THE SAME AS ABSENT, and the distinction is the fix:
  //   absent          — a caller that predates the tri-state (the extension payload, older tests).
  //                     Keep the legacy boolean path so nothing that worked stops working.
  //   present, valid  — derive the answer for the tense each question asks about.
  //   present, null   — resolveSponsorshipNeed looked and REFUSED, because `requires_sponsorship=0`
  //                     on a time-limited status is ambiguous between 'none' and 'future'. Falling
  //                     back to the boolean here would reinstate the exact false attestation this
  //                     exists to prevent, so it must refuse instead.
  const hasSponsorshipTriState = !!profilePayload && 'sponsorship_need' in profilePayload;
  const sponsorshipNeed = hasSponsorshipTriState ? profilePayload.sponsorship_need : undefined;
  const answers = [];

  for (const field of fields) {
    if (SKIP_TYPES.has(field.type)) continue;
    // Skipped like a password field is, and for the same reason. Clearing handler_type in
    // sanitizeDiscoveredFields is not sufficient on its own: steps 3 and 4 below match on the LABEL,
    // and a sign-in box labelled "Email" is matched by both.
    if (field.credential || isCredentialField(field)) continue;

    const label = field.label || '';
    const guardCtx = { label, name: field.name || '' };
    let value = null;
    let provenance = null;
    let matched_on = null;
    const refusals = [];

    // A sponsorship question is answered by DERIVATION, below, never by reading a stored yes/no
    // off the payload. Steps 1 and 2 are therefore closed to it: step 1 in particular applies no
    // guard at all, which is exactly how `handler_map['sponsorship'] = "No"` reached a
    // future-tense question at confidence 1.0. A user's own answer to this exact question (step 3)
    // still wins — that is better evidence than anything we can compute.
    const deriveSponsorship = hasSponsorshipTriState &&
      eligibilityClassOf(`${label} ${field.name || ''}`) === 'sponsorship';

    // 1. handler_map by handler_type — an exact signal, and the strongest one available.
    if (!deriveSponsorship &&
        field.handler_type && handler_map[field.handler_type] !== undefined && handler_map[field.handler_type] !== '') {
      value = handler_map[field.handler_type];
      provenance = PROVENANCE.HANDLER_EXACT;
      matched_on = field.handler_type;
    }

    // 2. field_map by handler_type (with dash -> underscore fallback). Also exact: the handler
    //    itself was derived from an attribute, or from a label the guards already vetted in
    //    sanitizeDiscoveredFields.
    if (value === null && !deriveSponsorship && field.handler_type) {
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

    // 5. Sponsorship — computed for the tense THIS question asks about, from the tri-state.
    //    Reached only when the user has not answered this exact question themselves. A yes/no is
    //    produced here and the option/checkbox formatting below turns it into whatever the control
    //    accepts, so this one branch covers selects, radios and checkboxes alike.
    if (value === null && deriveSponsorship) {
      const derived = sponsorshipAnswer({ label, name: field.name || '', need: sponsorshipNeed });
      if (derived) {
        value = derived.affirmative ? 'Yes' : 'No';
        provenance = derived.assumed
          ? PROVENANCE.SPONSORSHIP_ASSUMED_FUTURE
          : PROVENANCE.SPONSORSHIP_DERIVED;
        matched_on = `sponsorship_need:${sponsorshipNeed}/${derived.tense}`;
      } else {
        // Either the situation is unknown, or the question's direction is unreadable. Both are
        // refusals: a wrong answer here is a false statement to an employer about the candidate's
        // right to work, and the completeness gate can hold on it.
        refusals.push(SPONSORSHIP_NEEDS.has(String(sponsorshipNeed ?? ''))
          ? 'sponsorship:undetermined_question_sense'
          : 'sponsorship:unknown_sponsorship_need');
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
      //
      // A derived sponsorship answer is exempt: sponsorshipAnswer already resolved the question's
      // direction, so `value` is the answer AS THE QUESTION ASKS IT. Running polarity over it again
      // would invert a correct answer — and would refuse outright, since `matched_on` here names
      // the tri-state rather than one of the canonical boolean keys.
      // A CUSTOM ANSWER IS EXEMPT FOR THE SAME REASON, and more strongly. booleanPolarity resolves
      // the direction between a PROFILE KEY's sense and the QUESTION's sense — it exists because
      // `requires_sponsorship: "No"` and "authorized to work WITHOUT sponsorship" state the same
      // fact in opposite words. A custom answer has no such indirection: the candidate answered
      // THIS question, so the value already IS the answer as the question asks it, and there is no
      // direction left to resolve.
      //
      // Without this the guard fed `matched_on` — which for a custom answer is the QUESTION TEXT —
      // into SPONSORSHIP_KEY_SENSE, found nothing (it is not a canonical key and never will be),
      // returned 'unknown', and refused. The effect was that a candidate who had explicitly
      // answered an eligibility checkbox was asked to answer it again: step 3's own note says
      // "an explicit answer to this exact question is strictly better evidence", and the
      // correction loop stores the user's reply THERE, so the loop could never converge on a
      // checkbox — the same question forever. Found by scripts/a8FileUploadTrap.mjs, whose /ashby
      // case held on exactly this.
      //
      // Safe because the exemption cannot be reached by a guess: refuseReason() only lets an
      // eligibility-class subject through custom_answers on `allowEligibilityExactAnswer`, i.e. a
      // normalised-EXACT question match. A fuzzy or containment match on an eligibility field is
      // already refused before it gets here.
      const answeredByCandidate = provenance === PROVENANCE.CUSTOM_ANSWER;
      const polarity = (isDerivedSponsorship(provenance) || answeredByCandidate)
        ? 'direct'
        : booleanPolarity({ label, name: field.name || '', key: matched_on });
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
 * Every discovered field this run did NOT fill, and WHY (AH5).
 *
 * Read off the POST-FILL discovery pass, so it is the ACTUAL STATE OF THE FORM rather than the
 * gate's opinion of it. That distinction is the whole point: a run reports "Autofilled 7 fields"
 * and holds for review, and the candidate is left to work out which 7 and what is still empty by
 * reading the form themselves.
 *
 * INCLUDES OPTIONAL FIELDS, unlike the two gates above, which filter on `is_required` because they
 * are deciding whether to stop. This is not deciding anything — it is the record — and "we left
 * your salary expectation blank on purpose" is exactly the kind of thing a fill log exists to say.
 *
 * THE REASONS ARE THE THREE THE RESOLVER CAN ACTUALLY DISTINGUISH, and no more:
 *   low_confidence  a value was produced and policy refused to type it. `refusals` on a skipped
 *                   answer, or an entry in `rejectedAnswers` — the two ways the policy says no.
 *   needs_you       an ELIGIBILITY question — sponsorship, work authorisation, clearance. We
 *                   recognise it perfectly well and decline to answer it, because a wrong answer
 *                   here is a false statement to an employer about the candidate's status.
 *   no_answer       a rule matched this field and the profile had nothing to put in it.
 *   unmatched       no rule produced a candidate at all; the field was seen and never understood.
 *
 * `needs_you` is separated from `unmatched` because buildAnswers emits NOTHING for an eligibility
 * field the profile cannot answer — no value and no refusal — so by the rule above it would fall
 * through to "we did not recognise the field". Measured on the fixture form, that mislabelled both
 * of Greenhouse's eligibility questions. We classify them (eligibilityClassOf names them), so
 * saying we did not recognise them is untrue, and it is untrue in the direction that makes the
 * product look broken rather than careful.
 *
 * A fourth, `fill_failed`, is separated out deliberately: the resolver had a value, policy allowed
 * it, and the field is STILL empty. That is our bug rather than the candidate's missing data, and
 * folding it into `no_answer` would hide it in the one record built to expose it.
 */
export function buildBlanks({ fields = [], resolvedAnswers = [], rejectedAnswers = [] } = {}) {
  const refusals = new Map();
  const attempted = new Set();
  const seenByResolver = new Set();
  const keysOf = (a) => [a.field_id, a.name, a.label, a.field].filter(v => v != null).map(String);

  for (const a of resolvedAnswers) {
    for (const k of keysOf(a)) {
      seenByResolver.add(k);
      if (a.skipped) { if (a.refusals?.length) refusals.set(k, a.refusals); }
      else attempted.add(k);
    }
  }
  const declined = new Map();
  for (const r of rejectedAnswers) for (const k of keysOf(r)) declined.set(k, r);

  const lookup = (map, f) => {
    for (const k of [f.field_id, f.name, f.label].filter(v => v != null).map(String)) {
      if (map.has(k)) return map.get(k);
    }
    return null;
  };
  const known = (set, f) =>
    [f.field_id, f.name, f.label].filter(v => v != null).map(String).some(k => set.has(k));

  return fields
    .filter(f => f.current_value === '' || f.current_value == null)
    .map(f => {
      const refusal = lookup(refusals, f);
      const decline = lookup(declined, f);
      const eligibility = eligibilityClassOf(`${f.label || ''} ${f.name || ''}`);
      const reason = refusal ? 'low_confidence'
        : decline ? 'low_confidence'
        : known(attempted, f) ? 'fill_failed'
        : eligibility ? 'needs_you'
        : known(seenByResolver, f) ? 'no_answer'
        : 'unmatched';
      return {
        field: f.field_id ?? f.name ?? null,
        label: f.label ?? null,
        type: f.type ?? null,
        required: !!f.is_required,
        reason,
        // What the policy actually objected to, when it objected. "We would not guess your
        // sponsorship answer" is a different statement from "this is blank".
        eligibility: eligibility || undefined,
        detail: refusal ? refusal.join('; ')
          : decline ? `declined a ${decline.provenance || 'low-confidence'} guess` +
              (decline.confidence != null ? ` (confidence ${decline.confidence})` : '')
          : eligibility ? `an eligibility question (${eligibility}) — only you can answer this`
          : null,
      };
    });
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

// ── Correction watching (AF5) ────────────────────────────────────────────────
//
// Reads back the controls THIS RUN WROTE TO, resolved by the same `getElementById(field_id) ||
// [name=field_id]` lookup the filler itself uses — so a reported correction is a change to the exact
// element that was filled, not to a lookalike found by a second, differently-written selector.
//
// A plain EXPRESSION, matching APPLY_FN_SRC and GATE_EVIDENCE_SRC: evaluate() treats the string as an
// expression, so a bare arrow function would come back as a function object rather than run.
export const CORRECTION_WATCH_SRC = `(filled, bindingName) => {
  const locate = (key) => {
    if (!key) return null;
    // Bracketed ATS names ("job_application[requires_sponsorship]") are legal inside a quoted
    // attribute selector; only a literal double quote needs escaping.
    const safe = String(key).replace(/"/g, '\\\\"');
    return document.getElementById(key) || document.querySelector('[name="' + safe + '"]');
  };
  const readValue = (el) => {
    if (!el) return null;
    if (el.type === 'checkbox') return el.checked ? 'true' : 'false';
    if (el.type === 'radio') {
      const safe = String(el.name || '').replace(/"/g, '\\\\"');
      const group = document.querySelectorAll('input[type="radio"][name="' + safe + '"]');
      for (const r of group) if (r.checked) return r.value;
      return '';
    }
    return el.value == null ? '' : String(el.value);
  };
  const snapshot = () => {
    const out = [];
    for (const key of Object.keys(filled)) {
      const el = locate(key);
      // A control that has GONE is not a correction. An SPA can replace a step, and reporting
      // "was X, now nothing" for a node that no longer exists would invent a defect.
      if (!el) continue;
      const now = readValue(el);
      if (now === null) continue;
      if (now !== filled[key].value) {
        out.push({
          field: filled[key].label || key, key,
          was: filled[key].value, now,
          provenance: filled[key].provenance, confidence: filled[key].confidence,
        });
      }
    }
    return out;
  };
  let last = '[]';
  const report = () => {
    let json;
    try { json = JSON.stringify(snapshot()); } catch (e) { return; }
    if (json === last) return;
    last = json;
    try { window[bindingName](json); } catch (e) {}
  };
  document.addEventListener('change', report, true);
  document.addEventListener('input', report, true);
  document.addEventListener('submit', report, true);
  window.addEventListener('beforeunload', report);
  // Polled as WELL as evented. A click-driven submit can navigate before a listener runs, and an
  // SPA that swaps controls fires neither change nor input on the node we remembered.
  setInterval(report, 2000);
  return Object.keys(filled).length;
}`;

/**
 * Watch a semi-filled form for edits the human makes, and report each one.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {Array} resolvedAnswers  what this run filled, with provenance
 * @param {(corrections: Array) => void} onCorrections
 */
export async function installCorrectionWatcher(page, resolvedAnswers, onCorrections) {
  const filled = {};
  for (const a of resolvedAnswers || []) {
    // Only what was actually WRITTEN can be corrected. A skipped or refused field is not a
    // correction when the human fills it — it is them answering a question we declined to guess,
    // which `missingRequired` already reports and which is a different fact.
    if (a?.skipped || a?.policy_rejected) continue;
    if (a?.value === null || a?.value === undefined || a.value === '') continue;
    const key = a.field_id ?? a.name;
    if (!key) continue;
    filled[String(key)] = {
      label: a.label || a.name || a.field_id || '',
      value: String(a.value),
      provenance: a.provenance ?? null,
      confidence: a.confidence ?? null,
    };
  }
  if (Object.keys(filled).length === 0) return 0;

  const binding = '__rmReportCorrections';
  try {
    await page.exposeFunction(binding, (json) => {
      try {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed)) onCorrections(parsed);
      } catch { /* a malformed report is dropped, never thrown into the page */ }
    });
    const watched = await page.evaluate(
      `(${CORRECTION_WATCH_SRC})(${JSON.stringify(filled)}, ${JSON.stringify(binding)})`
    );
    console.log(`[autoApply] watching ${watched} filled field(s) for corrections`);
    return watched;
  } catch (e) {
    // Never fatal. Losing the campaign note is not worth losing the application.
    console.warn(`[autoApply] correction watcher not installed: ${e.message}`);
    return 0;
  }
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

// -- detectGate ----------------------------------------------------------------
/**
 * The two page states only a human may cross: a CAPTCHA, and a sign-in wall.
 *
 * Extracted out of classifyFlowState so the PRE-FILL check and the terminal classification cannot
 * disagree about what a gate looks like. classifyFlowState still owns everything else it decides —
 * submitted, expired, next_available — none of which is meaningful before a form has been filled,
 * which is why the gate part is what gets lifted rather than the whole classifier being moved
 * earlier.
 *
 * ── A GATE HAS TO BE PROVABLE FROM THE RENDERED PAGE (AE1) ────────────────────────────────────
 * The previous version asked `document.querySelector('iframe[src*="recaptcha"]') || …` and treated
 * a hit as a gate. Measured against the live posting this was reported on
 * (jobs.ashbyhq.com/openai/0432731c-…/application, scripts/ae1Diagnose.mjs):
 *
 *   iframe[src*="recaptcha"] → https://www.recaptcha.net/recaptcha/api2/anchor?k=6LeFb_YU…
 *                              w=256 h=60  visibility: HIDDEN
 *
 * That is INVISIBLE reCAPTCHA's anchor frame: bot-scoring infrastructure that every visitor loads
 * and no visitor ever interacts with. There was no challenge, no gate, and a plain fill-and-submit
 * form of 15 fields sitting behind the false verdict. A false gate stops an application that would
 * have succeeded, and the candidate is told the employer asked for a CAPTCHA — so the failure is
 * silent as well as wrong.
 *
 * The rule this now enforces: a terminal gate state is a claim about what the CANDIDATE WOULD SEE,
 * so only a node that is actually rendered may support it. Concretely —
 *   - PRESENCE IS NOT PROOF. A node that is display:none, visibility:hidden, transparent, or
 *     smaller than a control a human could click is infrastructure, not a challenge.
 *   - `[data-sitekey]` IS NOT PROOF, in any visibility state. It is a CONFIGURATION attribute: it
 *     says a captcha is provisioned for this page, not that one is being presented. Invisible
 *     Turnstile and reCAPTCHA v3 carry it on pages that never challenge anyone. It is collected as
 *     context for the log and deliberately cannot decide the outcome.
 *   - NOTHING READS PAGE SOURCE. Every probe is a DOM query against live nodes with their computed
 *     style. A page's SCRIPTS are not its CONTENT: a bundled JS chunk that merely mentions
 *     'hcaptcha' is not a challenge, and a text match against source could never tell the two
 *     apart. This is also why the widget-class probes require a rendered box rather than the mere
 *     existence of the container element a provider script is told to fill.
 *
 * The credential half keeps a wider net ON PURPOSE, because the two errors are not symmetric: a
 * false CAPTCHA costs an application, while a missed sign-in wall means typing a candidate's
 * identity into a third party's login box. So a password input counts when it is visible OR when
 * its owning form is on screen with a visible text control beside it — which is the two-step
 * sign-in shape (email, then password) that a visible-only probe would walk straight into.
 */

// The in-page probe. A plain EXPRESSION, matching APPLY_FN_SRC / COUNT_CONTROLS: frame.evaluate()
// evaluates the string as an expression, so an arrow function would come back as a function object.
//
// Returns EVIDENCE, not a verdict. The decision is classifyGateEvidence() — a pure function on the
// other side of this seam, so the rule that decides a gate is unit-testable without a browser, and
// so a run can log exactly which node and which measurement produced the answer. Reporting only
// `true` is what made AE1 undiagnosable from the logs.
export const GATE_EVIDENCE_SRC = `(() => {
  // Rendered-ness, measured. Not a heuristic: these are the four ways a node can be in the DOM and
  // absent from the page. Ancestors are walked because opacity and display are not inherited into
  // getComputedStyle the way visibility is.
  const MIN_W = 24, MIN_H = 12;
  function rendered(el) {
    if (!el.getClientRects().length) return { ok: false, why: 'no_box' };
    const r = el.getBoundingClientRect();
    if (r.width < MIN_W || r.height < MIN_H) return { ok: false, why: 'below_min_size', w: Math.round(r.width), h: Math.round(r.height) };
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none') return { ok: false, why: 'display_none' };
      if (cs.visibility !== 'visible') return { ok: false, why: 'visibility_' + cs.visibility };
      if (parseFloat(cs.opacity) < 0.05) return { ok: false, why: 'transparent' };
    }
    return { ok: true, why: 'rendered', w: Math.round(r.width), h: Math.round(r.height) };
  }
  const describe = (el, selector) => {
    const v = rendered(el);
    return {
      selector, tag: el.tagName.toLowerCase(), visible: v.ok, why: v.why,
      w: v.w ?? null, h: v.h ?? null,
      src: (el.getAttribute('src') || '').slice(0, 160),
    };
  };

  // A challenge WIDGET, by provider. Matching the provider path rather than the bare word means a
  // same-origin asset that merely has 'captcha' in its filename cannot qualify.
  const CHALLENGE = [
    'iframe[src*="/recaptcha/"]',
    'iframe[src*="hcaptcha.com"]',
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="/fc/api/"]',
    '.g-recaptcha', '.h-captcha', '.cf-turnstile',
  ];
  const challenges = [];
  for (const s of CHALLENGE) {
    for (const el of document.querySelectorAll(s)) challenges.push(describe(el, s));
  }

  // Configured-but-not-presented. Never decides anything — see the note above. Carried so a log can
  // say "a captcha is provisioned here and was not shown" instead of leaving that indistinguishable
  // from "no captcha exists".
  const configured = [];
  for (const el of document.querySelectorAll('[data-sitekey]')) configured.push(describe(el, '[data-sitekey]'));

  // The credential half. Each password input reports its own rendered-ness AND its owning form's, so
  // the pure classifier can apply the asymmetric rule without a second round trip.
  const credentials = [];
  for (const el of document.querySelectorAll('input[type="password"]')) {
    const own = rendered(el);
    const form = el.form || el.closest('form');
    let formVisible = false, formHasVisibleText = false;
    if (form) {
      formVisible = rendered(form).ok;
      for (const sib of form.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,select')) {
        if (sib !== el && rendered(sib).ok) { formHasVisibleText = true; break; }
      }
    }
    credentials.push({
      selector: 'input[type="password"]', tag: 'input',
      visible: own.ok, why: own.why, w: own.w ?? null, h: own.h ?? null,
      formVisible, formHasVisibleText,
    });
  }

  return { challenges, configured, credentials };
})()`;

/** Nothing found. The shape a failed evaluate degrades to, so the classifier never sees undefined. */
export const EMPTY_GATE_EVIDENCE = Object.freeze({ challenges: [], configured: [], credentials: [] });

/**
 * The gate DECISION, as a pure function of measured evidence plus the URL.
 *
 * @param {{challenges:Array,configured:Array,credentials:Array}} evidence  GATE_EVIDENCE_SRC output
 * @param {string} url  the URL the page is actually on
 * @returns {{gate:'login_required'|'captcha_required'|null, captcha:boolean, login:boolean,
 *            matched:object|null, reason:string}}
 *   `captcha` and `login` are reported SEPARATELY as well as collapsed into `gate`, because the
 *   pre-fill check and the terminal classification want different halves: nothing may be typed into
 *   a credential wall, whereas a challenge sitting on the real application form must not stop the
 *   fill (AE2 — that is what produced a handoff packet with nothing in it).
 */
export function classifyGateEvidence(evidence, url) {
  const ev = evidence && typeof evidence === 'object' ? evidence : EMPTY_GATE_EVIDENCE;

  const challenge = (ev.challenges || []).find(c => c && c.visible) || null;

  // Visible password input, or the two-step sign-in shape. See the asymmetry note above.
  const credential = (ev.credentials || []).find(c => c && (c.visible || (c.formVisible && c.formHasVisibleText))) || null;

  const urlLower = String(url || '').toLowerCase();
  const urlWall = /\/login|\/signin|\/sign-in/.test(urlLower);

  // The URL is not page source — it is where the browser actually is, and a browser sitting on a
  // sign-in path is a sign-in wall whether or not the form has mounted yet.
  const login = !!credential || urlWall;
  const captcha = !!challenge;

  // Ordering preserved from the original: a challenge is reported ahead of a wall when both are
  // present. `login` stays separately readable, so the pre-fill check is never fooled by a page
  // that carries both.
  const gate = captcha ? 'captcha_required' : (login ? 'login_required' : null);
  const matched = captcha ? challenge : (credential || null);
  const reason = captcha ? `visible ${challenge.selector} ${challenge.w}x${challenge.h}`
    : credential ? `visible credential form (${credential.why})`
    : urlWall ? 'url is a sign-in path'
    : 'no rendered challenge or credential wall';

  return { gate, captcha, login, matched, reason };
}

/**
 * Read the evidence off a live page and classify it. Logs what matched and what was rejected, so a
 * gate verdict is auditable after the fact rather than a bare boolean.
 */
export async function gatherGateEvidence(page) {
  const evidence = await page.evaluate(GATE_EVIDENCE_SRC).catch(() => EMPTY_GATE_EVIDENCE);
  const verdict = classifyGateEvidence(evidence, page.url());
  const rejected = [...(evidence.challenges || []), ...(evidence.configured || [])].filter(c => !c.visible);
  if (verdict.gate || rejected.length) {
    console.log(`[applyAutomation] gate evidence: ${verdict.gate ?? 'none'} — ${verdict.reason}` +
      (rejected.length ? `; not presented: ${rejected.map(r => `${r.selector}(${r.why})`).join(', ')}` : ''));
  }
  return { ...verdict, evidence };
}

/** @returns {'login_required'|'captcha_required'|null} */
export async function detectGate(page) {
  return (await gatherGateEvidence(page)).gate;
}

// ── landedUrl: WHERE THE FORM ACTUALLY WAS ────────────────────────────────────────────────────
// Every terminal return above/below carries `landedUrl: page.url()`, read while the page is still
// open. A gate hold already recorded this as `gate.applyUrl`; the HELD returns did not, and that is
// what made a held review unresumable — routes/apply.js could only build a handoff packet for a
// result that carried a URL, so only gates got one.
//
// It is not the same value as the job's apply_url. A posting's link is frequently a redirector, and
// a multi-step ATS moves the URL as you advance. The packet's expected_origin is target-matched
// against the tab the candidate opens before ANY answer is released, so it has to be the origin the
// browser actually reached, not the one we set off towards. Using apply_url here would make the
// extension correctly refuse to fill a form it had prepared.
/**
 * The result of meeting a gate. Shared by the pre-fill check and the post-fill classification so the
 * two cannot drift into producing different shapes for the same outcome.
 */
async function buildGateHold({ page, jobId, flowState, detected, totalFilled, jobUrl, resolvedAnswers }) {
  const pageTitle = await page.title().catch(() => "");
  const ss = await takeScreenshot(page, jobId);
  return {
    status:           'held_gate',
    reasonCode:       flowState,
    flowState,
    fieldsFilled:     totalFilled,
    platform:         detected,
    pageTitle,
    screenshotBase64: ss.base64,
    screenshotPath:   ss.path,
    // Where the human has to go, read before the browser closes: a gated portal usually redirects to
    // a sign-in on the way, so this is not the URL the run was queued with.
    gate: { flowState, applyUrl: await page.url(), startedFrom: jobUrl },
    // Withheld for login_required ON PURPOSE — the controls on a sign-in page are a CREDENTIAL form,
    // not the application. captcha_required is the opposite case: that challenge usually sits on the
    // real application form, so those answers are genuine field-matched evidence.
    answers: flowState === 'captcha_required' ? (resolvedAnswers || []) : [],
  };
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

    // 4 & 5. CAPTCHA, then login
    const gate = await detectGate(page);
    if (gate) return gate;

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
    //
    // ZERO FIELDS IS ITS OWN ANSWER (AE2). These two returns were both 'form_ready' — a dead
    // branch, and the second instance of the defect the `no_fields_discovered` outcome was
    // introduced to kill. `hasForm` was computed, tested, and then discarded: a page with no
    // fillable control anywhere reported the same state as a fully mounted application form. The
    // run downstream then read 'form_ready' and carried on, which is exactly "a silent condition
    // reported as a different condition". It must never fall through to a gate state either — a
    // page we could not read is not a page that challenged us.
    //
    // ACROSS EVERY FRAME, and this cost a regression to learn twice. The first version of this
    // asked the MAIN frame only, which is fine for the greenhouse/lever/ashby shape and wrong for
    // workday/icims/taleo, where the entire application lives in an iframe and the main document
    // legitimately holds no control at all. Those runs went from `submitted` to
    // `no_fields_discovered` — caught by scripts/a8FileUploadTrap.mjs, not by the node suite, since
    // it takes a real iframe to see it. waitForFormReady's own comment says exactly this about its
    // own sum, one function away; the same rule applies to any "is there a form" question.
    let controls = 0;
    for (const frame of frameList(page)) {
      const n = Number(await frame.evaluate(COUNT_CONTROLS).catch(() => 0));
      if (Number.isFinite(n)) controls += n;
    }
    return controls > 0 ? 'form_ready' : 'no_fields_discovered';
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
  // TASK H — the derived map has to reach discoverFields, which is where a LABEL becomes a
  // handler. discoverAndFill already receives the merged `labelMap`, but discoverFields
  // recomputes its own from the provider alone, so an injected mapping was being built here and
  // then thrown away one call later — the fill was unchanged and nothing said why.
  const derivedLabelMap = opts.derivedLabelMap || null;
  const { policy = defaultAnswerPolicy, mode = 'full', step = 0, touched = new Set() } = opts;
  let filled = 0;
  const collected = [];
  const rejected = [];
  // Raw fields seen across every frame, before any policy filtering. Lets the caller tell
  // "the page had no form at all" from "we declined to answer what was there".
  let fieldCount = 0;

  for (const frame of frames) {
    const fields = await discoverFields(frame, provider, derivedLabelMap);
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
/**
 * The legacy in-page sweep. Exported for tests: this is the path that fills by attribute and label
 * heuristics WITHOUT producing an answer object, so nothing about it is observable from the resolver
 * side — and it is the path whose guards have twice turned out to be the ones that matter.
 */
export async function fillContext(pageOrFrame, autofillData, labelMap) {
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
      credentialRe:  CREDENTIAL_SUBJECT_RE.source,
      credentialAutocomplete: [...CREDENTIAL_AUTOCOMPLETE],
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
    // AL2 — THE DOCUMENTS ARE NOT MISSING, THEY ARE NOT WRITTEN YET.
    //
    // With generation deferred to approval, a preview reaches the form with no resume and no cover
    // letter ON PURPOSE: they are written when the user approves. The completeness gate below
    // checks required FILE inputs (A1 finding N2 — a form with no resume used to pass the gate and
    // then be silently unsubmittable), so a deferred preview held as 'incomplete_form' instead of
    // 'awaiting_approval'. Only 'awaiting_approval' rows are approvable, so EVERY deferred preview
    // became unapprovable and the entire queue-then-approve flow dead-ended — while the run
    // history blamed the employer's form.
    //
    // This flag is the difference between "we could not fill this" and "we have not written it
    // yet", which is a distinction the gate cannot make on its own. It NEVER widens what may be
    // submitted: it is only ever set on a preview, the blanks are still reported, and the approved
    // run that follows carries a real resume through the ordinary gate.
    documentsDeferred        = false,
    // TASK H — { platform: { normalisedLabel: field_key } }, CONFIRMED rows only. Absent means
    // "authored map only", which is the pre-H behaviour.
    derivedLabelMaps         = null,
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
    // AF5. Called with the corrections a HUMAN made to a semi-filled form, as
    // [{field, was, now, provenance, confidence}], every time they change something.
    //
    // A callback rather than a return value because a semi run RETURNS while the browser is still
    // open — `awaiting_user` means the human has not finished yet, so by definition their edits
    // happen after the only moment autoApply could have reported them. Each correction is either a
    // resolver defect or a missing custom answer, which makes this the most useful thing a semi
    // campaign produces and the one thing nothing was recording.
    onCorrections     = null,
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

    // An abort that arrives while the browser is still LAUNCHING lands here. requestAbort sets the
    // flag before it looks for a browser to close, so a job aborted in that window has the flag and
    // no browser — this is what catches it, rather than letting a run the user stopped go on to
    // navigate to a real employer's form.
    if (isAbortRequested(jobId)) {
      console.log(`[autoApply] aborted before navigation — job=${jobId}`);
      try { await browser.close(); } catch {}
      return abortedResult(0);
    }

    inProgress.set(String(jobId), { status: "navigating", browser });
    console.log(`[autoApply] navigating to ${jobUrl}`);

    await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Explicit readiness condition, not a fixed sleep — see waitForFormReady.
    const readiness = await waitForFormReady(page);
    console.log(`[autoApply] form readiness: controls=${readiness.count} waited=${readiness.waitedMs}ms` +
      (readiness.timedOut ? " (TIMED OUT — page never settled with a fillable control)" : ""));

    const detected  = platform || detectPlatformFromUrl(jobUrl) || await detectPlatformFromPage(page);
    // TASK H — `derivedLabelMaps` is every platform's CONFIRMED mappings, injected by the caller
    // because this module has no database handle by design. Picked after detection, and merged
    // beneath the authored map so a derived entry can only ever fill a gap.
    const labelMap  = getPlatformLabelMap(detected, derivedLabelMaps?.[detected] || null);
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
        { policy: answerPolicy, mode: isUnattended ? 'full' : 'semi', step: stepIndex++, touched: touchedFrames,
          derivedLabelMap: derivedLabelMaps?.[detected] || null });
      if (firstPassFieldCount === null) firstPassFieldCount = r.fieldCount ?? null;
      totalFilled += r.filled;
      resolvedAnswers.push(...r.answers);
      if (r.rejected?.length) rejectedAnswers.push(...r.rejected);
      if (r.escalation) escalation = r.escalation;
      return !r.escalation;
    };

    // GATE BEFORE FILL. The classifier used to run only after the form had been filled, so a run
    // that met a sign-in wall typed into it first and held afterwards — the candidate's email went
    // into the portal's login box at 0.9 confidence, because `login_email` labelled "Email" resolves
    // to the email handler like any other field. Nothing was submitted, but on a real portal that is
    // an account-existence probe against the candidate's own identity.
    //
    // Checking here costs two evaluates on a page we are about to walk anyway, and a gate found now
    // means nothing is typed at all. `fieldsFilled: 0` is then the truth rather than a count of
    // writes into a form that was never the application.
    // ── ONLY A CREDENTIAL WALL HALTS THE FILL (AE2) ─────────────────────────────────────────────
    // This check used to halt on EITHER gate, and halting on a CAPTCHA is what produced the empty
    // handoff. Measured on the live posting: a hidden reCAPTCHA frame was read as a gate, the run
    // returned here with `resolvedAnswers: []`, and routes/apply.js then built the packet from the
    // canonical profile set instead of the form — so the extension's "Open & fill" had canonical
    // names to match against Ashby's `_systemfield_email` / UUID control names and filled nothing.
    // The screenshot filed as evidence was of an untouched form.
    //
    // The asymmetry is deliberate and is the reason this check exists at all. A sign-in wall must
    // be met with nothing typed: its controls are a THIRD PARTY'S credential form, and an email in
    // that box is an account-existence probe against the candidate's own identity. A challenge is
    // the opposite case — it sits ON the real application form, so the correct behaviour is to fill
    // the form and hold afterwards, where the hold carries answers that were matched against the
    // employer's actual controls. buildGateHold already says exactly this about its `answers`; the
    // pre-fill branch was contradicting it.
    const preFillGate = isUnattended ? await gatherGateEvidence(page) : null;
    if (preFillGate?.login) {
      console.log(`[autoApply] credential wall detected BEFORE filling — nothing typed (${preFillGate.reason})`);
      inProgress.set(String(jobId), { status: 'held_gate', browser: null });
      const held = await buildGateHold({
        page, jobId, flowState: 'login_required', detected, totalFilled: 0, jobUrl, resolvedAnswers: [],
      });
      await browser.close();
      return held;
    }
    if (preFillGate?.captcha) {
      console.log(`[autoApply] challenge present before filling (${preFillGate.reason}) — filling anyway, ` +
        `the hold after the fill is the one that carries answers`);
    }

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
        landedUrl:        page.url(),
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
        landedUrl:        page.url(),
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
        landedUrl:        page.url(),
        screenshotBase64: ss.base64,
        screenshotPath:   ss.path,
      };
    }

    // Check flow state after fill + upload
    const originalDomain = (() => { try { return new URL(jobUrl).hostname; } catch { return null; } })();
    const flowState = await classifyFlowState(page, originalDomain);

    // A form that is no longer there. classifyFlowState now names this rather than calling it
    // 'form_ready' (see step 9), so it has to be terminal HERE too: falling through would put a
    // page with no controls into the completeness gate, which would find nothing missing —
    // because there is nothing at all — and clear the run to click submit on it.
    if (isUnattended && flowState === 'no_fields_discovered') {
      const pageTitleN = await page.title().catch(() => "");
      const ssN = await takeScreenshot(page, jobId);
      inProgress.set(String(jobId), { status: "no_fields_discovered", browser: null });
      await browser.close();
      return {
        status:           "no_fields_discovered",
        reasonCode:       "no_fields_discovered",
        reasonDetail:     `The form was reachable and ${totalFilled} field(s) were filled, but no ` +
                          `fillable control remained when the run re-read the page. It moved or ` +
                          `unmounted mid-run, so nothing here can be verified as sent.`,
        flowState,
        fieldsFilled:     totalFilled,
        fieldsDiscovered: firstPassFieldCount ?? 0,
        answers:          resolvedAnswers,
        platform:         detected,
        pageTitle:        pageTitleN,
        landedUrl:        page.url(),
        screenshotBase64: ssN.base64,
        screenshotPath:   ssN.path,
      };
    }

    // Terminal states
    if (isUnattended && (GATE_FLOW_STATES.has(flowState) || flowState === 'expired')) {
      // A GATE is not a failure and not the same thing as an expired posting, which is why the two
      // part company here. `expired` means there is nothing to apply to; a gate means there IS, and a
      // human can finish it. G1 gives the gate its own terminal status so routes/apply.js can park a
      // packet for the handoff — and so the ~14 endpoints that key on status='held_review' stop
      // picking up jobs whose form was never even reached.
      //
      // Reaching a gate HERE rather than in the pre-fill check means the page only became one after
      // we filled: a portal that asks to sign in when the form is submitted, or a CAPTCHA that
      // appears on interaction. So this path can still carry answers, and the pre-fill path cannot.
      if (GATE_FLOW_STATES.has(flowState)) {
        inProgress.set(String(jobId), { status: 'held_gate', browser: null });
        const held = await buildGateHold({
          page, jobId, flowState, detected, totalFilled, jobUrl, resolvedAnswers,
        });
        await browser.close();
        return held;
      }

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
        landedUrl:        page.url(),
        screenshotBase64: ss.base64,
        screenshotPath:   ss.path,
      };
    }

    let status, pageTitle;
    let submitVerified = null, submitEvidence = null, submitReasonCode = null;
    // Semi's report of what the human still has to fill in (AE6). Named separately from the
    // unattended gate's locals because these do NOT stop the run — they are attached to a result
    // whose status is `awaiting_user`.
    let semiMissingRequired = null, semiOpenQuestions = null;
    // AH5's fill-log half for semi, declared here for the same reason: it is attached to an
    // `awaiting_user` result rather than stopping the run.
    let semiBlanks = null;
    if (isUnattended) {
      // Completeness gate: re-discover all frames; hold if any required non-file field is still empty.
      const postFillFields = (await Promise.all(
        frameList(page).map(f => discoverFields(f, detected, derivedLabelMaps?.[detected] || null).catch(() => []))
      )).flat();
      // A1 finding N2: required FILE inputs used to be exempt here, so a form with no resume
      // attached passed the gate while the browser refused to submit it — the run then reported
      // filled_not_submitted with no reasonCode, having never reached the later steps. A file
      // input's value is readable ('' when empty), so it is checked like any other control.
      // A DEFERRED DOCUMENT IS NOT A MISSING ANSWER. When generation waits for approval there is
      // deliberately no resume or cover letter to attach yet, so a required FILE input is expected
      // to be empty in the preview and holding on it makes the row unapprovable — see
      // `documentsDeferred` above. Scoped to FILE inputs only: every other required field is still
      // the candidate's to answer and still holds the run. The fields are excluded from the GATE,
      // not from the record — they remain in `blanks` below, so the preview still shows them.
      const deferredDoc = (f) => documentsDeferred && f.type === 'file';
      const missingFields = postFillFields
        .filter(f => f.is_required && (f.current_value === '' || f.current_value == null))
        .filter(f => !deferredDoc(f));
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
          // AH5: the whole post-fill form state, not just the required blanks the gate stopped on.
          blanks:           buildBlanks({ fields: postFillFields, resolvedAnswers, rejectedAnswers }),
          openQuestions:    buildOpenQuestions({ missingFields }),
          answers:          resolvedAnswers,
          platform:         detected,
          pageTitle:        pageTitle2,
          landedUrl:        page.url(),
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
          landedUrl:        page.url(),
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
            landedUrl:    page.url(),
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
          landedUrl:    page.url(),
          screenshotBase64: ssP.base64,
          screenshotPath:   ssP.path,
        };
      }

      // ── THE ABORT CHECKPOINT THAT MATTERS (TASK AC4) ────────────────────────────────────────
      // Last statement before the run becomes capable of submitting. Everything above this line is
      // reading and filling; everything below can send an application to a real employer. An abort
      // observed here returns without a click, and without a screenshot — the browser may already
      // have been closed by requestAbort, and reaching into a dead context to take a picture would
      // turn a clean stop into a "Target closed" error attributed to the browser.
      if (isAbortRequested(jobId)) {
        console.log(`[autoApply] aborted before submit — job=${jobId}`);
        try { await browser.close(); } catch {}
        return { ...abortedResult(totalFilled), answers: resolvedAnswers, platform: detected };
      }

      inProgress.set(String(jobId), { status: "submitting", browser });
      // Submit-button matching lives in classifySubmitLabel — see the note there for why the
      // old /^(submit|apply|…)/ anchor rejected the exact phrasing real ATSes use, and why
      // simply removing the anchor would have been unsafe.
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

      // Collect every visible candidate across the in-scope frames FIRST, then click the
      // strongest. First-match-wins was safe only while the pattern was ^-anchored and could
      // therefore match at most one obvious label; now that a qualifier may precede the verb, a
      // page can present several candidates and the best one has to win rather than the earliest.
      const scored = [];
      for (const ctx of submitCandidates) {
        let buttons = [];
        try { buttons = await ctx.$$("button,input[type='submit']"); } catch { continue; }
        for (const btn of buttons) {
          try {
            const txt = (await btn.evaluate(el => el.textContent || el.value || "")).trim();
            const score = classifySubmitLabel(txt);
            if (!score) continue;
            const visible = await btn.evaluate(el => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            });
            if (visible) scored.push({ ctx, btn, txt, score });
          } catch {}
        }
      }
      // Stable: highest score wins, ties keep discovery order (main frame before touched frames).
      scored.sort((a, b) => b.score - a.score);
      if (scored.length) {
        const best = scored[0];
        console.log(`[autoApply] submit button: ${JSON.stringify(best.txt)} (score ${best.score}` +
          `${scored.length > 1 ? `, ${scored.length} candidates` : ""})`);
        const ctx = best.ctx;
        try {
          await best.btn.click();
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
        } catch {}
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

      // ── SEMI MUST SAY WHAT IS STILL YOURS TO ANSWER (AE6) ──────────────────────────────────
      // The completeness gate above lives inside `if (isUnattended)`, so a semi run performed no
      // check on the form it had just filled and returned no `missingRequired` at all. The review
      // surface then rendered a clean row — no obstacle, nothing outstanding — over a form that
      // could not be submitted. That is not "the gates are off in semi", which is a defensible
      // product decision; it is the run declining to report a fact it already had in hand.
      //
      // The same discovery pass the gate uses, WITHOUT the hold: semi's whole premise is that a
      // human is looking at the form and will finish it, so blocking would defeat the mode. What it
      // owes them is the list. `missingRequired` is the same shape the unattended hold emits, so
      // routes/apply.js and the panel consume it unchanged, and `openQuestions` carries the type
      // and options so a question can be answered rather than merely named.
      const semiFields = (await Promise.all(
        frameList(page).map(f => discoverFields(f, detected, derivedLabelMaps?.[detected] || null).catch(() => []))
      )).flat();
      const semiMissingFields = semiFields
        .filter(f => f.is_required && (f.current_value === '' || f.current_value == null));
      // Why each one is empty, when the resolver had an opinion: "we would not guess your
      // sponsorship answer" is a different statement from "this is blank".
      const semiRefusals = new Map();
      for (const a of resolvedAnswers) {
        if (a.skipped && a.refusals?.length) semiRefusals.set(a.field_id ?? a.name, a.refusals);
      }
      for (const f of semiMissingFields) {
        const r = semiRefusals.get(f.field_id) ?? semiRefusals.get(f.name);
        if (r) f.refusals = r;
      }
      semiMissingRequired = semiMissingFields.map(f => f.label || f.field_id || '(unknown)');
      semiOpenQuestions   = buildOpenQuestions({ missingFields: semiMissingFields });
      // AH5: the fill log's blank half, from the SAME pass — actual form state, including the
      // optional fields the gates ignore because they are not deciding anything.
      semiBlanks          = buildBlanks({ fields: semiFields, resolvedAnswers, rejectedAnswers });
      console.log(`[autoApply] semi: ${semiMissingRequired.length} required field(s) are yours to answer` +
        (semiMissingRequired.length ? ` — ${semiMissingRequired.join(', ')}` : ''));

      // ── WATCH FOR CORRECTIONS (AF5) ────────────────────────────────────────────────────────
      // Installed before returning, because there is no later moment: the run ends here and the
      // human's edits happen afterwards, in a browser this process still owns.
      //
      // A page BINDING, never a fetch from the page. On a real employer's origin a fetch to our
      // server is cross-origin and would either be blocked or would put the candidate's answers on
      // the network to make a local note. The binding keeps every value inside this process, which
      // is where answers_json already lives.
      if (onCorrections) {
        await installCorrectionWatcher(page, resolvedAnswers, onCorrections);
      }
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
      // AE6: present on a semi run whether or not anything is missing. An EMPTY array is a real
      // answer — "we checked, nothing is outstanding" — and is not the same as the absent field
      // this used to return, which the review surface could only read as "no information".
      ...(semiMissingRequired ? { missingRequired: semiMissingRequired } : {}),
      ...(semiOpenQuestions?.length ? { openQuestions: semiOpenQuestions } : {}),
      // AH5. Present on a semi run whether or not anything is blank, for the same reason
      // missingRequired is: an empty array means "we looked at every field and none is empty",
      // which is a fact, and an absent key is how the silence went unnoticed before.
      ...(semiBlanks ? { blanks: semiBlanks } : {}),
      // AF5: the DENOMINATOR. Two hold branches already reported this and the terminal path did not,
      // so the run that actually completes — the only kind a semi campaign produces — could report
      // "12 fields filled" with no way to know whether 12 was most of the form or a tenth of it.
      // Per-ATS discovery reliability is not computable without it.
      fieldsDiscovered: firstPassFieldCount ?? 0,
      pageTitle,
      landedUrl:        page.url(),
      screenshotBase64: ss.base64,
      screenshotPath:   ss.path,
    };

  } catch (e) {
    // ── AN ABORT IS NOT A CRASH (TASK AC4) ────────────────────────────────────────────────────
    // requestAbort closes the browser out from under whatever this run was awaiting, so the throw
    // arriving here is usually "Target closed" or "Session closed" — and classifyRuntimeError would
    // correctly identify that as a browser failure, which is the wrong story: nothing failed, the
    // user stopped it. Checked BEFORE attribution, so the run reports what actually happened and
    // the row does not get a "Retry" affordance for a thing that was deliberately halted.
    if (isAbortRequested(jobId)) {
      console.log(`[autoApply] aborted mid-run — job=${jobId} (${e.message})`);
      inProgress.delete(String(jobId));
      try { if (browser) await browser.close(); } catch {}
      return abortedResult(0);
    }
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
