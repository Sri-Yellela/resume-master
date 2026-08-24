#!/usr/bin/env node
/**
 * Fake ATS — a local test target for services/applyAutomation.js
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * autoApply() can only be exercised against a real employer's form, which means
 * every test costs a real application under a real candidate's name and cannot be
 * undone. This serves ATS-shaped forms locally so the pipeline can be run end to
 * end, including the submit click, with no outbound traffic.
 *
 * This is deliberately NOT a friendly mock. Every form below contains at least one
 * TRAP reproducing a specific weakness found in the buildAnswers() audit. A run that
 * "succeeds" against these forms while answering the traps wrongly is exactly the
 * failure we cannot detect in production — so assert on the RECORDED ANSWERS, never
 * merely on status === 'submitted'.
 *
 * USAGE
 *   node scripts/fakeAts.js               # serves on :4599
 *   PORT=5000 node scripts/fakeAts.js
 *
 *   GET  /                     index of available forms
 *   GET  /greenhouse           2-step form (traps: sponsorship inversion, name ambiguity)
 *   GET  /lever                1-step form (traps: lowercase yes/no, "Review and Submit")
 *   GET  /ashby                1-step form (traps: required typeahead, date format)
 *   GET  /ashby-spa            THE LIVE POSTING'S MEASURED SHAPE — React-rendered in two chunks,
 *                              transcribed from ae1Diagnose.mjs's reading of a real Ashby form:
 *                              nameless required date picker, UUID field names, checkboxes named
 *                              with their own question, EEOC radio groups. This is the target the
 *                              submit path had never been exercised against; /ashby is a native-
 *                              control replica and that gap is what AE1/AE2 came out of.
 *                              ?answerable=1  ?autofilltrap=1  ?deadsubmit=1  ?delay=ms
 *   GET  /multistep            2-step form offering BOTH navigation styles from one step 1
 *                              (real POST -> new document, history.pushState -> same document)
 *                              plus a cross-origin control. Built for TASK G0: whether an
 *                              activeTab grant survives a step transition.
 *   GET  /spa                  JS-RENDERED form — fields injected in two chunks after a delay
 *                              (?delay=ms, default 2500; ?delay=0 renders synchronously).
 *                              Reproduces the hydration timing every real ATS has and that
 *                              static HTML cannot: a discovery pass that does not wait for a
 *                              readiness condition walks an empty DOM here, exactly as it did
 *                              against a real Ashby posting.
 *   GET  /_submissions         JSON of everything submitted so far (for assertions)
 *   POST /_reset               clear recorded submissions
 *
 * FILE UPLOADS ARE REAL. Every form carrying a file input declares
 * enctype="multipart/form-data" and the recorder parses it. Each submission records:
 *   fields     text parts only, name -> value (same shape urlencoded produced)
 *   files      name -> { filename, contentType, size }, or NULL when the input was
 *              present but no file was chosen — that is the distinction between
 *              "resume uploaded" and "resume field skipped", and it is the whole point
 *   partCount  parts in THIS post. A multi-step flow can report 0 here and still list uploads in
 *              `files` — greenhouse takes the resume at step 1 and posts step 2 urlencoded, so
 *              assert on `files`, never on partCount, to decide whether a resume arrived.
 * A file field appears in `files`, never in `fields`, so the two can never be confused.
 *
 * NO EXTERNAL DEPENDENCIES — node:http only.
 */

import http from 'node:http';
import { parse as parseQuery } from 'node:querystring';

const PORT = Number(process.env.PORT || 4599);

/** In-memory submission log. Reset between test cases via POST /_reset. */
const submissions = [];

// ── Trap registry ────────────────────────────────────────────────────────────
// Each trap names the audit finding it reproduces. Tests should assert the
// EXPECTED value, not just that a value was supplied.
const TRAPS = {
  sponsorship_inversion: {
    finding: 'buildAnswers step 3 fuzzy match: a `work_authorization` key substring-matches a ' +
             'SPONSORSHIP question, producing a semantically inverted, legally material answer.',
    field:   'requires_sponsorship',
    expect:  'a sponsorship yes/no — NOT a work-authorization status string',
  },
  name_ambiguity: {
    finding: 'A short field_map key like `name` substring-matches several labels; first match ' +
             'wins and Object.entries order is arbitrary.',
    fields:  ['legal_name', 'preferred_name', 'referrer_name'],
    expect:  'each name field gets ITS OWN value; referrer_name must not receive the candidate name',
  },
  // A `finding` is written in the PAST TENSE once it is fixed, and says what the behaviour is now.
  // This registry is served as JSON on the index page, so it is where a reader forms their
  // expectation before writing an assertion — and a fixed defect described in the present tense is
  // how a7's case 3 came to assert the broken behaviour as though it were the guarantee. The trap
  // stays: it is still the regression target. Only the tense and the "now" line are new.
  lowercase_yes: {
    finding: "WAS: buildAnswers checked value === 'Yes' (capital Y only), so 'yes' coerced to " +
             "'false' — silently answering No.",
    now:     'FIXED. coerceAffirmative() accepts an enumerated affirmative list and is fail-safe in ' +
             'the other direction: anything unrecognised stays false, because an affirmative is ' +
             'what attests something to an employer. booleanPolarity() resolves the DIRECTION ' +
             'first, so an inverted question cannot be answered backwards.',
    field:   'authorized_to_work',
    expect:  "'yes' must be submitted as an affirmative, not 'false'",
  },
  submit_label: {
    finding: 'WAS: SUBMIT_RE was anchored at ^, so a button labelled "Review and Submit" never ' +
             'matched and the run silently ended as filled_not_submitted.',
    now:     'FIXED. classifySubmitLabel() scores labels instead of first-matching: ' +
             'STRONG_SUBMIT_RE is /\\b(?:submit|send)\\b/, so a qualifier may precede the verb and ' +
             '"Review and Submit" scores 2, while NOT_SUBMIT_RE still excludes "Save and Continue" ' +
             'and "Submit Draft". The /lever form MUST therefore reach a real submission. Asserting ' +
             'filled_not_submitted here is asserting the old bug — a7 case 3 did exactly that.',
    expect:  'the run either submits or reports filled_not_submitted — never a false "submitted", ' +
             'which is what the recorded submission count decides',
  },
  required_unmapped: {
    finding: 'buildAnswers skips unresolvable fields; the completeness gate must then HOLD ' +
             'rather than submit an incomplete form.',
    field:   'hear_about_us',
    expect:  "status === 'held_review' with this label in missingRequired",
  },
  // ── /ashby-spa, transcribed from the live posting (AE1/AE2 follow-up) ──────
  nameless_required: {
    finding: 'A required control with NO name and NO associated <label> takes its label from ' +
             '`placeholder` via getLabel()\'s last resort. Nothing can resolve "Pick date..." — the ' +
             'form has not said what it wants. Every fixture before this one labelled everything, ' +
             'so the case that actually stops a live Ashby run had no local target.',
    field:   '(nameless, placeholder "Pick date...")',
    expect:  "held_review/incomplete_form with 'Pick date...' in missingRequired — never a submit",
  },
  uuid_field_names: {
    finding: 'Three controls are named with a bare GUID, so the ONLY signal is the label. This is ' +
             'why a canonical-profile gate packet (keyed on `email`, `first_name`) fills nothing ' +
             'here, which is what AE2 observed as "Open & fill filled an empty form".',
    fields:  ['09a328e0-…', '20f8883c-…', 'f189fed2-…'],
    expect:  'resolved by LABEL, and the packet source reported as discovered_form not canonical_profile',
  },
  autofill_slot_theft: {
    finding: 'The live page puts an unlabelled file input behind the copy "Upload your resume here ' +
             'to autofill key application fields". uploadIntoContext classifies file inputs on ' +
             'label+name+id, so if that copy ever reaches the input as an aria-label the resume ' +
             'lands in the WRONG slot and the required one stays empty — a hold that reads as ' +
             '"no resume" when the resume was uploaded.',
    field:   '_systemfield_resume',
    expect:  "?autofilltrap=1 -> held_review with 'Resume' in missingRequired, resume NOT recorded",
  },
  dead_submit: {
    finding: 'A1 finding N1: `submitted` was once set by the CLICK ALONE. A submit-shaped button ' +
             'that changes nothing must report clicked_no_evidence — the false positive is ' +
             'self-concealing, because the duplicate guard then never retries the job.',
    expect:  "?deadsubmit=1 -> filled_not_submitted/submit_unverified, and /_submissions stays EMPTY",
  },
};

// ── HTML helpers ─────────────────────────────────────────────────────────────
const page = (title, body) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5}
 label{display:block;margin:14px 0 4px;font-weight:600;font-size:14px}
 input,select,textarea{width:100%;padding:8px;font-size:14px;box-sizing:border-box}
 .req::after{content:" *";color:#c00}
 button{margin-top:20px;padding:10px 18px;font-size:15px;cursor:pointer}
 fieldset{border:1px solid #ddd;margin:20px 0;padding:12px 16px}
</style></head><body>${body}</body></html>`;

// Labels MUST be associated with their control via for/id.
//
// The first version emitted `<label>Text</label><input>` — adjacent, no `for`, input not nested.
// discoverFields' getLabel() looks for label[for=id], then el.closest('label'), then
// aria-label/placeholder; none of those match that markup, so every field came back with
// label:"" and the harness silently exercised only attribute-based resolution. buildAnswers
// steps 3 (fuzzy label) and 4 (custom_answers) were unreachable, which is most of what the
// traps exist to test. Real Greenhouse/Lever/Ashby markup associates labels, so this is the
// fixture matching reality, not a concession to the code.
//
// for/id is used rather than wrapping the input in the label because getLabel() returns
// closest.textContent — a wrapping label around a <select> would fold every option's text into
// the label ("...require sponsorship?Select...YesNo") and corrupt the very matching under test.
// The id is derived from `name` so no call site has to pass one.
const field = (label, input, required = false) => {
  const existingId = input.match(/\bid="([^"]+)"/)?.[1];
  const name = input.match(/\bname="([^"]+)"/)?.[1];
  let id = existingId;
  if (!id && name) {
    id = 'f_' + name.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
    input = input.replace(/<(input|select|textarea)\b/, `<$1 id="${id}"`);
  }
  return `<label class="${required ? 'req' : ''}"${id ? ` for="${id}"` : ''}>${label}</label>${input}`;
};

// ── Greenhouse-flavoured 2-step form ─────────────────────────────────────────
// Realistic Greenhouse naming: job_application[<field>]
function greenhouseStep1() {
  return page('Senior Engineer — Application', `
  <h1>Senior Engineer</h1><p>Step 1 of 2 — About you</p>
  <form method="POST" action="/greenhouse/step2" enctype="multipart/form-data">
    ${field('First Name', `<input id="first_name" name="job_application[first_name]" required>`, true)}
    ${field('Last Name',  `<input id="last_name"  name="job_application[last_name]"  required>`, true)}
    ${field('Email',      `<input id="email" type="email" name="job_application[email]" required>`, true)}
    ${field('Phone',      `<input id="phone" type="tel" name="job_application[phone]">`)}

    <fieldset><legend>TRAP: name_ambiguity</legend>
      ${field('Legal Name',        `<input name="job_application[legal_name]" required>`, true)}
      ${field('Preferred Name',    `<input name="job_application[preferred_name]">`)}
      ${field('Name of Referrer',  `<input name="job_application[referrer_name]">`)}
    </fieldset>

    ${field('Resume', `<input type="file" name="job_application[resume]" accept=".pdf,.doc,.docx" required>`, true)}
    ${field('Cover Letter', `<input type="file" name="job_application[cover_letter]" accept=".pdf,.doc,.docx">`)}
    <button type="submit">Next</button>
  </form>`);
}

// Greenhouse uploads the resume at step 1, which POSTs to /greenhouse/step2 and is not itself a
// recorded submission — so without carrying it, the one form that exercises a two-step upload would
// leave no evidence the resume ever arrived. Step-1 uploads travel forward as a hidden `_step1_files`
// summary, so the final /_submit/greenhouse record is self-contained. (This step has no file input
// of its own, so it stays urlencoded — real ATS flows mix the two, and it keeps that path covered.)
function greenhouseStep2(carry, files = {}) {
  const hidden = Object.entries(carry)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(String(v))}">`).join('');
  const uploads = `<input type="hidden" name="_step1_files" value="${escapeHtml(JSON.stringify(files))}">`;
  return page('Senior Engineer — Step 2', `
  <h1>Senior Engineer</h1><p>Step 2 of 2 — Eligibility</p>
  <form method="POST" action="/_submit/greenhouse">
    ${hidden}${uploads}
    <fieldset><legend>TRAP: sponsorship_inversion</legend>
      ${field('Do you now or in the future require sponsorship for work authorization?',
        `<select name="job_application[requires_sponsorship]" aria-required="true">
           <option value="">Select...</option>
           <option value="Yes">Yes</option>
           <option value="No">No</option>
         </select>`, true)}
      ${field('Are you legally authorized to work in the country of employment?',
        `<select name="job_application[legally_authorized]" aria-required="true">
           <option value="">Select...</option>
           <option value="Yes">Yes</option>
           <option value="No">No</option>
         </select>`, true)}
    </fieldset>

    ${field('Years of professional experience',
      `<input type="number" name="job_application[years_experience]" min="0" required>`, true)}
    ${field('Earliest start date',
      `<input type="date" name="job_application[start_date]">`)}
    ${field('LinkedIn Profile', `<input type="url" name="job_application[linkedin]">`)}

    <fieldset><legend>TRAP: required_unmapped</legend>
      ${field('How did you hear about us? (free text, no standard mapping)',
        `<textarea name="job_application[hear_about_us]" required rows="3"></textarea>`, true)}
    </fieldset>

    <button type="submit">Submit Application</button>
  </form>`);
}

// ── Lever-flavoured single-step form ─────────────────────────────────────────
function leverForm() {
  return page('Backend Engineer — Apply', `
  <h1>Backend Engineer</h1>
  <form method="POST" action="/_submit/lever" enctype="multipart/form-data">
    ${field('Full name', `<input name="name" required>`, true)}
    ${field('Email',     `<input name="email" type="email" required>`, true)}
    ${field('Current company', `<input name="org">`)}
    ${field('Resume', `<input type="file" name="resume" required>`, true)}

    <fieldset><legend>TRAP: lowercase_yes</legend>
      ${field('Are you authorized to work without sponsorship?',
        `<select name="cards[authorized_to_work]" aria-required="true">
           <option value="">Select...</option>
           <option value="yes">yes</option>
           <option value="no">no</option>
         </select>`, true)}
    </fieldset>

    ${field('Location', `<input name="location" placeholder="City, State">`)}
    <fieldset><legend>TRAP: submit_label</legend>
      <p style="font-size:13px;color:#666">Button reads "Review and Submit" — the qualifier sits
      BEFORE the verb, which the old ^-anchored SUBMIT_RE could never match. Now handled by
      classifySubmitLabel; this form must reach an actual submission, not filled_not_submitted.</p>
    </fieldset>
    <button type="submit">Review and Submit</button>
  </form>`);
}

// ── Ashby-flavoured single-step form ─────────────────────────────────────────
function ashbyForm() {
  return page('Platform Engineer — Application', `
  <h1>Platform Engineer</h1>
  <form method="POST" action="/_submit/ashby" enctype="multipart/form-data">
    ${field('Name',  `<input name="_systemfield_name" required>`, true)}
    ${field('Email', `<input name="_systemfield_email" type="email" required>`, true)}
    ${field('Resume', `<input type="file" name="_systemfield_resume" required>`, true)}
    ${field('Location (start typing)',
      `<input name="_systemfield_location" role="combobox" aria-autocomplete="list" aria-required="true" required>`, true)}
    ${field('Available from (MM/DD/YYYY)',
      `<input name="start_date" placeholder="MM/DD/YYYY" required>`, true)}
    ${field('Website', `<input name="_systemfield_website" type="url">`)}

    <fieldset><legend>TRAP: lowercase_yes</legend>
      <p style="font-size:13px;color:#666">A1 found the harness had no checkbox or toggle anywhere,
      so buildAnswers' <code>value === 'Yes'</code> coercion (which only runs for
      checkbox/toggle) was never exercised. This is that field. A stored <code>'yes'</code> must
      arrive checked; anything unrecognised must stay unchecked.</p>
      ${field('I am authorized to work without sponsorship',
        `<input type="checkbox" name="authorized_no_sponsorship" required>`, true)}
    </fieldset>

    <button type="submit">Submit</button>
  </form>`);
}

// ── /ashby-spa: THE REAL FORM'S SHAPE, MEASURED ──────────────────────────────
//
// WHY THIS EXISTS AND /ashby DOES NOT SUFFICE
// `/ashby` above is static HTML with native controls. That is what AE1/AE2 turned out to have been
// verified against, while the live posting is a React SPA whose controls do not resemble it — and the
// docs said so explicitly ("everything was verified against a replica with native <select>s").
//
// So this is not invented. Every field below is transcribed from `scripts/ae1Diagnose.mjs`'s reading
// of `jobs.ashbyhq.com/openai/0432731c-…/application`, which reported 15 fields across 3 frames and
// 32 raw controls. The four things the old fixture could not reproduce, and which are the whole
// reason a live run behaved differently:
//
//   1. NAMELESS REQUIRED CONTROLS. The date picker and the typeahead carry NO `name` and NO
//      associated <label> — their label comes from `placeholder` via getLabel()'s last resort, which
//      is why they read as "Pick date..." and "Start typing...". A required field whose only
//      identity is the word "Pick date..." cannot be resolved by any map, and that is not a bug in
//      the resolver: it is the form declining to say what it wants. The completeness gate holding on
//      it is the correct outcome, and this fixture is where that can be asserted.
//   2. UUID FIELD NAMES. Three fields are named with a bare GUID, so the ONLY signal is the label.
//      This is what made AE2's canonical-profile packet fill nothing: it is keyed on `email` and
//      `first_name`, which match no control here.
//   3. CHECKBOXES WHOSE `name` IS THE ENTIRE LABEL TEXT. Measured, not stylised — the arbitration
//      checkbox really is named with its own 180-character question.
//   4. RADIO GROUPS LABELLED BY THEIR FIRST OPTION. discoverFields dedupes a group to one field and
//      takes getLabel() of the first radio, so the four EEOC groups present as "Male",
//      "Hispanic or Latino", and so on — which is what a resolver actually has to cope with.
//
// It renders client-side in two chunks like `/spa`, because that is the other half of the reality:
// the readiness condition has to be exercised, not bypassed.
//
// SUBMISSION IS RECORDED THE WAY THE REAL ONE HAPPENS. Real Ashby does not do a native form POST; it
// collects state in JS and sends it. So does this — an intercepted submit builds a real multipart
// FormData (so `files` records the resume for real, through the existing parser), POSTs it to
// /_submit/ashby-spa, and then NAVIGATES to a confirmation page. That last step matters: it is what
// gives the post-click evidence check something honest to find (`url_changed` plus the confirmation
// text `classifyFlowState` matches on) instead of a status nobody verified.
//
// Query params, each one a case worth being able to reach:
//   ?delay=ms      hydration delay (default 2500; 0 renders synchronously)
//   ?answerable=1  gives the date field a real <label> and a name, so a run CAN complete it and the
//                  submit click is reachable. The difference between this and the default IS the
//                  finding: the form is unsubmittable because of how it labels one control.
//   ?autofilltrap=1  gives the unnamed "autofill from resume" file input the real page's own copy
//                  ("Upload your resume here to autofill…") as an aria-label. uploadIntoContext
//                  classifies file inputs on label+name+id, so the resume then lands in the WRONG
//                  slot and `_systemfield_resume` stays empty — a hold that looks like a missing
//                  resume when the resume was in fact uploaded, to the wrong input.
//   ?deadsubmit=1  the submit button posts nothing and navigates nowhere. This is A1 finding N1's
//                  case: a submit-shaped button that changes nothing must report
//                  `clicked_no_evidence`, never `submitted`.
const EEOC_PREFIX = '41056061-f039-4b0f-8310-713131d11bda';
function ashbySpaForm({ delayMs, answerable = false, autofillTrap = false, deadSubmit = false } = {}) {
  const d = Number.isFinite(delayMs) ? delayMs : 2500;
  // Kept as data so the radio groups below are one loop rather than four hand-written blocks, and so
  // the option labels stay exactly as measured.
  const eeoc = [
    ['gender',            ['Male', 'Female', 'Decline to self identify']],
    ['race',              ['Hispanic or Latino', 'White', 'Black or African American', 'Asian', 'Decline to self identify']],
    ['veteran_status',    ['I identify as one or more of the classifications of protected veteran listed above',
                           'I am not a protected veteran', 'I decline to self identify']],
    ['disability_status', ['Yes, I have a disability, or have had one in the past',
                           'No, I do not have a disability', 'I do not want to answer']],
  ];
  const radioHtml = eeoc.map(([key, opts]) => {
    const name = `${EEOC_PREFIX}__systemfield_eeoc_${key}`;
    return opts.map((opt, i) => {
      const id = `f_eeoc_${key}_${i}`;
      return `<label for="${id}" style="font-weight:400">` +
             `<input type="radio" id="${id}" name="${name}" value="${escapeHtml(opt)}" ` +
             `style="width:auto;margin-right:6px"> ${escapeHtml(opt)}</label>`;
    }).join('');
  }).join('<hr style="border:0;border-top:1px solid #eee;margin:14px 0">');

  // Measured: the `name` attribute IS the question, verbatim, for both of these. Built here in Node
  // rather than assembled in the page, so the attribute quoting is done once and visibly.
  const ARBITRATION = 'I acknowledge that I have opened, read, and understood the Arbitration ' +
    'Agreement. I understand that by submitting my application, I am agreeing to be bound by the ' +
    'terms of the Arbitration Agreement.';
  const CONFIRM = 'I confirm I have read the above.';
  const checkbox = (id, text) =>
    `<label for="${id}" style="font-weight:400">` +
    `<input type="checkbox" id="${id}" name="${escapeHtml(text)}" ` +
    `style="width:auto;margin-right:6px"> ${escapeHtml(text)}</label>`;
  const checkboxHtml =
    '<fieldset><legend>Arbitration Agreement</legend>' +
    checkbox('f_arb', ARBITRATION) + checkbox('f_conf', CONFIRM) +
    '</fieldset>';

  // The date field, in its two forms. The default is the measured one: no name, no label, required.
  const dateField = answerable
    ? `<label class="req" for="f_start">Earliest start date</label>` +
      `<input id="f_start" name="start_date" placeholder="Pick date..." required>`
    : `<input placeholder="Pick date..." required style="margin-top:14px">`;

  const autofillAria = autofillTrap
    ? ` aria-label="Upload your resume here to autofill key application fields"`
    : '';

  return page('Software Engineer, Agent Productivity — OpenAI', `
  <h1>Software Engineer, Agent Productivity</h1>
  <p style="font-size:13px;color:#666">Shape transcribed from a live Ashby posting
  (scripts/ae1Diagnose.mjs). Rendered by JavaScript ${d}ms after load, in two chunks.</p>
  <div id="app"><p id="boot">Loading application form…</p></div>
  <script>
  (function(){
    var DELAY = ${d};
    var DEAD  = ${deadSubmit ? 'true' : 'false'};

    // CHUNK 1 — the identity block. Note _systemfield_* beside bare GUIDs: that mix is the real
    // form's, and it is why label-based resolution is not optional here.
    var chunk1 =
      // enctype declared even though the submit is intercepted and posts a hand-built FormData: if
      // the interception is ever removed, a native POST of a file input WITHOUT it sends a filename
      // and no bytes, and the resume path silently stops being exercised. Pinned by
      // formReadiness.test.js for every form in this harness.
      '<form id="ashbyform" enctype="multipart/form-data">' +
      '<fieldset><legend>Autofill from resume</legend>' +
        '<p style="font-size:13px;color:#666">Upload your resume here to autofill key application fields.</p>' +
        '<input type="file"${autofillAria}>' +
      '</fieldset>' +
      '<label class="req" for="f_legal">Legal Name</label>' +
      '<input id="f_legal" name="_systemfield_name" required>' +
      '<label for="f_pref">Preferred Name (if applicable)</label>' +
      '<input id="f_pref" name="09a328e0-8d57-4f88-86ab-688de1657b17">' +
      '<label class="req" for="f_email">Email</label>' +
      '<input id="f_email" name="_systemfield_email" required>' +
      '<label class="req" for="f_resume">Resume</label>' +
      '<input id="f_resume" type="file" name="_systemfield_resume" required>' +
      '<label class="req" for="f_phone">Phone Number</label>' +
      '<input id="f_phone" name="20f8883c-d278-427c-9465-dc614f612e1f" required>' +
      '<div id="chunk2"></div>' +
      '<button id="f_submit" type="' + (DEAD ? 'button' : 'submit') + '">Submit Application</button>' +
      '</form>';

    // CHUNK 2 — everything with no name, no label, or a label that is really an option. The half of
    // the form that a resolver cannot map, arriving late enough that a readiness check which fires
    // on "any field" would miss all of it.
    var chunk2 =
      '<div role="combobox" aria-autocomplete="list" style="display:none"></div>' +
      '<input placeholder="Start typing..." role="combobox" aria-autocomplete="list">' +
      ${JSON.stringify(dateField)} +
      '<label for="f_addl">Additional Information</label>' +
      '<textarea id="f_addl" name="f189fed2-624b-41a1-a76f-0c67a2611d1a" rows="3"></textarea>' +
      ${JSON.stringify(checkboxHtml)} +
      '<fieldset><legend>Voluntary self-identification</legend>' +
        ${JSON.stringify(radioHtml)} +
      '</fieldset>';

    setTimeout(function(){
      var b = document.getElementById('boot'); if (b) b.remove();
      document.getElementById('app').innerHTML = chunk1;
      setTimeout(function(){
        document.getElementById('chunk2').innerHTML = chunk2;
        wire();
      }, 400);
    }, DELAY);

    // The submit path. Real Ashby collects state and sends it, so this does too — and it includes
    // the NAMELESS controls, keyed by the label a human reads, because otherwise the one thing this
    // fixture exists to reproduce would be invisible in the recorded submission.
    function wire() {
      var form = document.getElementById('ashbyform');
      var btn  = document.getElementById('f_submit');
      if (!form || !btn) return;
      var handler = function(ev){
        if (ev) ev.preventDefault();
        if (DEAD) return;                       // clicked, nothing happens, nothing changes
        var fd = new FormData();
        var seen = 0;
        Array.prototype.forEach.call(
          form.querySelectorAll('input,textarea,select,[role=combobox]'), function(el){
          if (el.type === 'submit' || el.type === 'button') return;
          var key = el.getAttribute('name');
          if (!key) {
            // Nameless control: record it under the label a human sees, which for these IS the
            // placeholder. Prefixed so an assertion cannot confuse it with a real field name.
            var lbl = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
            if (!lbl) return;
            key = 'unnamed:' + lbl;
          }
          if (el.type === 'file') {
            if (el.files && el.files[0]) { fd.append(key, el.files[0], el.files[0].name); seen++; }
            return;
          }
          if (el.type === 'checkbox') { if (el.checked) { fd.append(key, 'true'); seen++; } return; }
          if (el.type === 'radio')    { if (el.checked) { fd.append(key, el.value); seen++; } return; }
          if (el.value) { fd.append(key, el.value); seen++; }
        });
        fd.append('_controlsRecorded', String(seen));
        fetch('/_submit/ashby-spa', { method: 'POST', body: fd })
          .then(function(){ location.assign('/ashby-spa/thanks'); })
          .catch(function(){ location.assign('/ashby-spa/thanks'); });
      };
      form.addEventListener('submit', handler);
      if (DEAD) btn.addEventListener('click', handler);
    }
  })();
  </script>`);
}

// The confirmation the submit navigates to. Separate page, real navigation — so `url_changed` and
// the confirmation text are both genuinely earned rather than asserted by the fixture.
function ashbySpaThanks() {
  return page('Application received — OpenAI', `
  <h1>Thank you for your application</h1>
  <p>Your application has been submitted successfully. We'll be in touch.</p>
  <p style="font-size:12px;color:#666">Reached by a real navigation from /ashby-spa, so a run that
  claims <code>submitted</code> here has both <code>url_changed</code> and a confirmation page —
  the two independent signals A1 finding N1 requires. Assert against
  <a href="/_submissions">/_submissions</a>, never on the status.</p>`);
}

// ── JS-RENDERED (SPA) form ───────────────────────────────────────────────────
// The characteristic every live target shares and this harness could not reproduce: Ashby,
// Greenhouse and Lever all build their form client-side, AFTER the document is parsed. Because
// every form above was static HTML, a discovery pass that walks the DOM too early found all the
// fields here and none of them in production — a real Ashby run discovered nothing, filled
// nothing, and reported "Autofilled 0 fields" as a clean autofill_done in 9 seconds.
//
// The delay is deliberately longer than the fixed 1500ms sleep autoApply used to use, so a run
// that does not WAIT on a readiness condition reliably sees an empty DOM. ?delay= overrides it,
// and ?delay=0 renders synchronously for a control case.
//
// Fields are injected in TWO chunks so the control count climbs rather than jumping straight to
// its final value: a readiness check that merely waits for "any field" would fire on the first
// chunk and still miss half the form. Only waiting for the count to STOP CHANGING is correct.
//
// ?variant=2 serves a CHANGED form — one question added, one removed, one made required. Forms
// change, and a schema captured once and trusted forever is worse than no schema (TASK G4
// requirement 3), so the store has to be able to observe the change rather than assume stability.
function spaForm(delayMs, variant = 1) {
  const d = Number.isFinite(delayMs) ? delayMs : 2500;
  return page('SPA ATS — Apply', `
  <h1>Senior Data Engineer</h1>
  <p>Form is rendered by JavaScript ${d}ms after load, in two chunks — as every real ATS does.</p>
  <div id="app"><p id="boot">Loading application form…</p></div>
  <script>
  (function(){
    var DELAY = ${d};
    var chunk1 =
      '<form id="spaform" method="POST" action="/_submit/spa" enctype="multipart/form-data">' +
      '<label class="req" for="f_name">Full name</label><input id="f_name" name="name" required>' +
      '<label class="req" for="f_email">Email</label><input id="f_email" name="email" type="email" required>' +
      '<label for="f_phone">Phone</label><input id="f_phone" name="phone">' +
      '<div id="chunk2"></div>' +
      '<button type="submit">Submit application</button></form>';
    var chunk2 = ${variant === 2 ? `
      '<label class="req" for="f_resume">Resume</label>' +
      '<input id="f_resume" type="file" name="resume" required>' +
      '<label for="f_linkedin">LinkedIn</label><input id="f_linkedin" name="linkedin">' +
      '<label for="f_addr">Address</label><input id="f_addr" name="address1">' +
      '<label class="req" for="f_portfolio">Portfolio URL</label>' +
      '<input id="f_portfolio" name="portfolio" required>' +
      '<label class="req" for="f_auth">I am authorized to work without sponsorship</label>' +
      '<input id="f_auth" type="checkbox" name="authorized_no_sponsorship" required>'` : `
      '<label class="req" for="f_resume">Resume</label>' +
      '<input id="f_resume" type="file" name="resume" required>' +
      '<label for="f_linkedin">LinkedIn</label><input id="f_linkedin" name="linkedin">' +
      '<label for="f_github">GitHub</label><input id="f_github" name="github">' +
      '<label for="f_addr">Address</label><input id="f_addr" name="address1">' +
      '<label class="req" for="f_auth">I am authorized to work without sponsorship</label>' +
      '<input id="f_auth" type="checkbox" name="authorized_no_sponsorship" required>'`};
    setTimeout(function(){
      var b = document.getElementById('boot'); if (b) b.remove();
      document.getElementById('app').innerHTML = chunk1;
      // Second chunk lands a further 400ms later, so the count is briefly non-zero but not final.
      setTimeout(function(){ document.getElementById('chunk2').innerHTML = chunk2; }, 400);
    }, DELAY);
  })();
  </script>`);
}

// ── G1: a portal that demands an account before it will show the form ────────
// The gated case, which nothing here could reproduce: Meta, Amazon, Google and per-tenant Workday
// all want a session before an application exists. classifyFlowState already detects it
// (login_required / captcha_required) but there was no local target to detect it ON, so the gate
// branch of autoApply had never been exercised end to end.
//
// /gated 302s to /gated/signin, which carries a password field and a /signin URL — the two signals
// classifyFlowState reads. There is deliberately NO application form on the sign-in page: that is the
// whole point of the case, and it is what makes the packet fall back to the canonical profile
// resolution rather than to discovered fields.
//
// NOTHING HERE CAN BE AUTOMATED PAST. There is no valid credential, by design — the hard boundary is
// that a human crosses every gate. The form posts nowhere and the harness must never try.
function gatedSignin() {
  return page('Sign in to continue — Careers', `
  <h1>Sign in to apply</h1>
  <p>You need an account with us before you can apply to this role.</p>
  <form method="POST" action="/gated/signin">
    ${field('Email', `<input name="login_email" type="email" required>`, true)}
    ${field('Password', `<input name="login_password" type="password" required>`, true)}
    <button type="submit">Sign in</button>
  </form>
  <p style="font-size:12px;color:#666">There is no valid credential here on purpose. This route exists
  so the gate can be OBSERVED, not crossed — see the hard boundary in
  docs/GATED_HANDOFF_PROMPTS.md. A run reaching this page must end held_gate with a packet.</p>`);
}

// A sign-in form and an application form on ONE page — the case where classifying the page is not
// enough and only a per-CONTROL rule protects the candidate.
//
// The two forms both have a control named `email`, which is the whole difficulty: name and label are
// identical, and the only thing distinguishing them is which form they belong to. The login side also
// uses the shapes the legacy in-page sweep matches on (a bare `name="email"`, a placeholder, an
// autocomplete token), so a run that fills this page wrongly does so through that sweep rather than
// through the resolver.
function gatedMixed() {
  return page('G-CRED Senior Engineer — Apply or sign in', `
  <h1>Senior Engineer</h1>
  <p>Returning candidate? Sign in. Otherwise apply below.</p>

  <form id="loginform" method="POST" action="/gated/signin">
    <fieldset><legend>Sign in — NOTHING here may ever be filled</legend>
      ${field('Email', `<input name="email" id="login_email" type="email" placeholder="Email" autocomplete="username" required>`, true)}
      ${field('Password', `<input name="password" id="login_password" type="password" autocomplete="current-password" required>`, true)}
      <button type="submit">Sign in</button>
    </fieldset>
  </form>

  <form id="applyform" method="POST" action="/_submit/mixed" enctype="multipart/form-data">
    <fieldset><legend>Apply — this is the application</legend>
      ${field('First Name', `<input name="first_name" required>`, true)}
      ${field('Last Name',  `<input name="last_name" required>`, true)}
      ${field('Email Address', `<input name="applicant_email" type="email" placeholder="Email" required>`, true)}
      ${field('Phone', `<input name="phone" type="tel">`)}
      <button type="submit">Submit Application</button>
    </fieldset>
  </form>`);
}

function gatedCaptcha() {
  return page('Verify you are human — Careers', `
  <h1>Verify you are human</h1>
  <p>Complete the challenge to continue to the application.</p>
  <div class="g-recaptcha" data-sitekey="fake-site-key-not-real">
    <iframe title="reCAPTCHA" src="about:blank" style="width:300px;height:74px;border:1px solid #ccc"></iframe>
  </div>
  <p style="font-size:12px;color:#666">A fixture, not a real challenge, and not solvable — solving one
  is permanently out of scope. It exists so captcha_required can be observed.</p>`);
}

// ── G1/G3: the application form BEHIND the gate ──────────────────────────────
// What the candidate reaches after signing in themselves — the page the extension hands off onto.
// Nothing here is reachable by the server; it exists so G2's fill and G3's review overlay have a
// realistic target, and it carries the traps that make the review worth reading:
//
//   job_application[requires_sponsorship]  Greenhouse's real naming. An eligibility answer must
//                                          still be matched here, by unwrapping the namespace —
//                                          exact-name-only would never fill it on any real ATS.
//   work_authorization                     bare canonical name, the easy case
//   org / "Current Company"                no name match; only a LABEL match can fill it, which is
//                                          what makes it a guess the overlay must ask about
//   authorized_no_sponsorship              the INVERSION trap: same words, opposite sense. Nothing
//                                          may fill this from a `requires_sponsorship` answer.
function gatedForm() {
  return page('G3-TRAPS Senior Engineer — Application', `
  <h1>Senior Engineer</h1>
  <p>Signed in. Complete your application.</p>
  <form method="POST" action="/_submit/gated" enctype="multipart/form-data">
    ${field('First Name', `<input name="first_name" required>`, true)}
    ${field('Last Name',  `<input name="last_name" required>`, true)}
    ${field('Email',      `<input name="email" type="email" required>`, true)}
    ${field('Phone',      `<input name="phone" type="tel">`)}
    ${field('Resume', `<input type="file" name="resume" accept=".pdf" required>`, true)}

    <fieldset><legend>TRAP: label-only match</legend>
      ${field('Current Company', `<input name="org">`)}
    </fieldset>

    <fieldset><legend>Eligibility</legend>
      ${field('Do you now or in the future require sponsorship for work authorization?',
        `<select name="job_application[requires_sponsorship]" aria-required="true">
           <option value="">Select...</option><option value="Yes">Yes</option><option value="No">No</option>
         </select>`, true)}
      ${field('Are you legally authorized to work in the country of employment?',
        `<select name="work_authorization" aria-required="true">
           <option value="">Select...</option><option value="Yes">Yes</option><option value="No">No</option>
         </select>`, true)}
    </fieldset>

    <fieldset><legend>TRAP: sponsorship_inversion</legend>
      <p style="font-size:13px;color:#666">Same words as the question above, opposite sense. A
      <code>requires_sponsorship: "No"</code> answer placed here would attest the opposite of the
      truth. Nothing may fill it.</p>
      ${field('I am authorized to work without sponsorship',
        `<input type="checkbox" name="authorized_no_sponsorship">`)}
    </fieldset>

    <button type="submit">Submit Application</button>
  </form>`);
}

// ── G0: multi-step form carrying BOTH navigation styles ──────────────────────
// Exists for TASK G0 in docs/GATED_HANDOFF_PROMPTS.md. Chrome revokes an activeTab grant when
// the tab "navigates away", and the entire interaction model of the gated handoff turns on
// whether a portal's own step transition counts as navigating away. Workday and Amazon paginate
// both ways — sometimes a real document load, sometimes an SPA route change — and there is no
// reason to assume the two behave alike.
//
// So one step 1 carries THREE advance controls, identical in outcome and different only in
// mechanism:
//   #adv-post    real form POST -> a NEW document at the same origin
//   #adv-spa     history.pushState + DOM rewrite -> SAME document, new URL, no load
//   #adv-cross   a DIFFERENT origin (127.0.0.1 instead of localhost, same server) — the CONTROL.
//                A probe reporting "grant survived" here is broken; without this case a passing
//                result cannot be told apart from a probe that never observes a revocation.
//
// Every page stamps window.__g0DocId at parse time. A probe reading the same id before and after
// an advance proves the document was never replaced, so "same-document" is observed rather than
// asserted from the mechanism's name. Both advance paths render a byte-identical field set from
// step2FieldsHtml(), because the probe counts controls and a differing count would be read as a
// grant difference.
//
// G0-SPIKE is in every title on purpose: a chrome.commands hotkey can only be delivered as real
// keyboard input to a focused OS window, so the harness has to locate this window by title.
const g0DocStamp =
  `<script>window.__g0DocId='doc-'+Math.random().toString(36).slice(2,10);</script>`;

function step2FieldsHtml() {
  return `
    ${field('Years of professional experience',
      `<input type="number" name="years_experience" min="0" required>`, true)}
    ${field('Earliest start date', `<input type="date" name="start_date">`)}
    ${field('LinkedIn Profile', `<input type="url" name="linkedin">`)}
    ${field('Are you legally authorized to work in the country of employment?',
      `<select name="legally_authorized" aria-required="true">
         <option value="">Select...</option>
         <option value="Yes">Yes</option>
         <option value="No">No</option>
       </select>`, true)}`;
}

function multistepStep1() {
  const step2 = step2FieldsHtml();
  return page('G0-SPIKE Multi-step — Step 1', `
  ${g0DocStamp}
  <h1>Multi-step application — Step 1</h1>
  <p>Three ways to reach step 2. Only the mechanism differs.</p>
  <!-- novalidate: the G0 probe is read-only — it counts controls and never types into one — so
       constraint validation would block the real-POST advance and the trial would time out instead
       of measuring anything. The required flags stay for anything else reading this fixture. -->
  <form id="step1form" method="POST" action="/multistep/step2" novalidate>
    ${field('First Name', `<input name="first_name" required>`, true)}
    ${field('Last Name',  `<input name="last_name" required>`, true)}
    ${field('Email',      `<input name="email" type="email" required>`, true)}
    <button id="adv-post" type="submit">Next — real POST (new document)</button>
  </form>
  <div id="app"></div>
  <button id="adv-spa" type="button">Next — pushState (same document)</button>
  <p><a id="adv-cross" href="http://127.0.0.1:${PORT}/multistep">Different origin (control)</a></p>
  <script>
  (function(){
    var STEP2 = ${JSON.stringify(step2)};
    document.getElementById('adv-spa').addEventListener('click', function(){
      // Order matters: rewrite first, then push. A grant revoked by the URL change would
      // otherwise be indistinguishable from one revoked by the DOM replacement.
      document.getElementById('step1form').remove();
      this.remove();
      document.getElementById('app').innerHTML =
        '<h2>Step 2 of 2 — Eligibility (SPA)</h2>' + STEP2;
      history.pushState({ step: 2 }, '', '/multistep/step2?spa=1');
    });
  })();
  </script>`);
}

function multistepStep2(carry = {}) {
  const hidden = Object.entries(carry)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(String(v))}">`).join('');
  return page('G0-SPIKE Multi-step — Step 2', `
  ${g0DocStamp}
  <h1>Multi-step application — Step 2</h1>
  <p>Reached by a real document load.</p>
  <form method="POST" action="/_submit/multistep">
    ${hidden}
    ${step2FieldsHtml()}
    <button type="submit">Submit Application</button>
  </form>`);
}

// ── Workday-flavoured IFRAME form ────────────────────────────────────────────
// The non-greenhouse coverage case. platformDetector.usesIframe() is true for workday, icims and
// taleo — three of the nine providers outside the v1 full-auto allowlist — yet nothing in this
// harness had an iframe, so the multi-frame path had never been exercised at all. Everything real
// lives in the inner document; the outer page only hosts it.
function workdayShell() {
  return page('Workday — Apply', `
  <h1>Staff Engineer</h1>
  <p>Application hosted in an iframe, as workday/icims/taleo do.</p>
  <!-- DECOY, deliberately FIRST in the DOM so a naive walk over every frame reaches it before the
       real form. It has a visible "Submit" button and no field we would ever fill, standing in for
       the third-party frames a real posting carries (ads, captcha, analytics). Clicking it must be
       impossible: the submit scan only considers frames that received an approved answer. If it is
       ever posted, /_submissions records provider "decoy" and the test fails. -->
  <iframe src="/workday/decoy" title="Sponsored" style="width:100%;height:80px;border:1px dashed #f00"></iframe>
  <iframe src="/workday/inner" title="Application" style="width:100%;height:900px;border:1px solid #ccc"></iframe>`);
}

function workdayDecoy() {
  return page('Sponsored', `
  <form method="POST" action="/_submit/decoy">
    <p style="font-size:12px;color:#900">Third-party widget — nothing here belongs to the application.</p>
    <button type="submit">Submit</button>
  </form>`);
}

function workdayInner() {
  return page('Workday — Application', `
  <form method="POST" action="/_submit/workday" enctype="multipart/form-data">
    ${field('First Name', `<input name="firstName" required>`, true)}
    ${field('Last Name',  `<input name="lastName" required>`, true)}
    ${field('Email',      `<input name="email" type="email" required>`, true)}
    ${field('Phone Number', `<input name="phoneNumber" type="tel">`)}
    ${field('Name',       `<input name="candidateName">`)}
    ${field('Resume', `<input type="file" name="resumeUpload" required>`, true)}
    ${field('Are you legally authorized to work in the country of employment?',
      `<select name="workAuthorization" aria-required="true">
         <option value="">Select...</option>
         <option value="Yes">Yes</option>
         <option value="No">No</option>
       </select>`, true)}
    <button type="submit">Submit Application</button>
  </form>`);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function indexPage() {
  return page('Fake ATS', `
  <h1>Fake ATS</h1>
  <p>Local test target for <code>applyAutomation.js</code>. No outbound traffic; nothing reaches an employer.</p>
  <ul>
    <li><a href="/greenhouse">/greenhouse</a> — 2-step (sponsorship inversion, name ambiguity, required unmapped)</li>
    <li><a href="/lever">/lever</a> — 1-step (lowercase yes/no, "Review and Submit" button)</li>
    <li><a href="/spa">/spa</a> — JS-rendered, fields appear after a delay (SPA hydration)</li>
    <li><a href="/ashby">/ashby</a> — 1-step (required typeahead, non-ISO date)</li>
    <li><a href="/ashby-spa">/ashby-spa</a> — <strong>the live posting's measured shape</strong>:
      React-rendered in two chunks, nameless required date picker, UUID field names, checkboxes
      named with their own question text, four EEOC radio groups labelled by their first option.
      <code>?answerable=1</code> makes the date resolvable so the submit click is reachable;
      <code>?autofilltrap=1</code> sends the resume to the wrong file input;
      <code>?deadsubmit=1</code> clicks and changes nothing.</li>
    <li><a href="/multistep">/multistep</a> — 2-step offering a real POST, a pushState advance and
      a cross-origin control from one step 1 (TASK G0: activeTab grant lifetime)</li>
    <li><a href="/gated">/gated</a> — 302 to a sign-in wall, no form behind it
      (TASK G1: login_required → held_gate + packet). <a href="/gated/captcha">/gated/captcha</a>
      is the captcha_required variant. Neither is crossable, by design.
      <a href="/gated/form">/gated/form</a> is what waits behind it — the handoff target for G2/G3,
      carrying the sponsorship-inversion and label-only-match traps.
      <a href="/gated/mixed">/gated/mixed</a> puts a sign-in form and an application form on ONE page,
      both with a control named <code>email</code>: the case where only a per-control rule protects
      the candidate's details from the login box.</li>
  </ul>
  <p><a href="/_submissions">/_submissions</a> — recorded submissions (JSON). Each record carries
  <code>fields</code> (text parts), <code>files</code> (uploads — <code>null</code> where the input
  was present but empty) and <code>partCount</code>. Every form with a file input posts as
  <code>multipart/form-data</code>, so an upload is observable rather than assumed.</p>
  <h2>Traps</h2>
  <pre style="white-space:pre-wrap;font-size:12px">${escapeHtml(JSON.stringify(TRAPS, null, 2))}</pre>`);
}

// ── Server ───────────────────────────────────────────────────────────────────
// Buffers, not a string: a multipart body carries raw PDF bytes, and `raw += chunk` would decode
// them as UTF-8 and corrupt every part boundary offset. The cap is 20MB rather than the old 2MB
// because file content now actually crosses the wire.
function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    let len = 0;
    req.on('data', c => { chunks.push(c); len += c.length; if (len > 2e7) req.destroy(); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const CRLF2 = Buffer.from('\r\n\r\n');

/**
 * Minimal multipart/form-data parser — enough to record what a browser actually sent.
 *
 * File bodies are measured and discarded, never stored: the harness needs to prove the resume
 * arrived, not keep a copy of the candidate's resume in memory.
 */
function parseMultipart(buf, boundary) {
  const fields = Object.create(null);
  const files = Object.create(null);
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];

  let pos = buf.indexOf(delim);
  if (pos < 0) return { fields, files, partCount: 0 };
  pos += delim.length;
  while (pos < buf.length) {
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break;          // closing "--"
    if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2;       // CRLF after the boundary
    const next = buf.indexOf(delim, pos);
    if (next < 0) break;
    let end = next;
    if (buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;   // trailing CRLF belongs to the delimiter
    parts.push(buf.subarray(pos, end));
    pos = next + delim.length;
  }

  for (const part of parts) {
    const sep = part.indexOf(CRLF2);
    if (sep < 0) continue;
    const headers = part.subarray(0, sep).toString('utf8');
    const body = part.subarray(sep + CRLF2.length);
    const name = headers.match(/\bname="([^"]*)"/i)?.[1];
    if (name == null) continue;
    const filename = headers.match(/\bfilename="([^"]*)"/i)?.[1];

    if (filename == null) {
      const val = body.toString('utf8');
      // Mirror querystring.parse: a repeated key collects into an array.
      fields[name] = name in fields ? [].concat(fields[name], val) : val;
      continue;
    }
    // A file input with nothing chosen still sends a part, with filename="" and an empty body.
    // Recording null rather than omitting it is what separates "the resolver skipped this field"
    // from "the resolver filled it and the upload failed" — indistinguishable under urlencoded.
    files[name] = filename === ''
      ? null
      : { filename, contentType: headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim()
            || 'application/octet-stream', size: body.length };
  }
  return { fields, files, partCount: parts.length };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const send = (code, body, type = 'text/html; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type }); res.end(body);
  };

  if (req.method === 'GET') {
    if (path === '/')           return send(200, indexPage());
    if (path === '/greenhouse') return send(200, greenhouseStep1());
    if (path === '/lever')      return send(200, leverForm());
    if (path === '/ashby')      return send(200, ashbyForm());
    // The measured replica of the live posting. See ashbySpaForm for what each param reaches.
    if (path === '/ashby-spa') {
      const q = url.searchParams.get('delay');
      return send(200, ashbySpaForm({
        delayMs:      q === null ? undefined : Number(q),
        answerable:   url.searchParams.get('answerable') === '1',
        autofillTrap: url.searchParams.get('autofilltrap') === '1',
        deadSubmit:   url.searchParams.get('deadsubmit') === '1',
      }));
    }
    if (path === '/ashby-spa/thanks') return send(200, ashbySpaThanks());
    if (path === '/spa') {
      // ?delay=<ms> overrides the hydration delay; ?delay=0 renders synchronously.
      // ?variant=2 serves a CHANGED form, for the schema-reconciliation case.
      const q = url.searchParams.get('delay');
      const variant = Number(url.searchParams.get('variant') || 1);
      return send(200, spaForm(q === null ? undefined : Number(q), variant));
    }
    // A 302 rather than serving the sign-in directly, because that is what a real portal does and it
    // is what makes the run's final URL differ from the URL it was queued with — the reason the gate
    // packet stores the URL the gate was OBSERVED at.
    if (path === '/gated') {
      res.writeHead(302, { Location: '/gated/signin' });
      return res.end();
    }
    if (path === '/gated/signin')  return send(200, gatedSignin());
    // The form the candidate reaches after crossing the gate themselves — G2 fills it, G3 reviews it.
    if (path === '/gated/form')    return send(200, gatedForm());
    if (path === '/gated/captcha') return send(200, gatedCaptcha());
    if (path === '/gated/mixed')   return send(200, gatedMixed());
    if (path === '/multistep')       return send(200, multistepStep1());
    // Also GET-able so the pushState URL is a real address — a reload after an SPA advance must
    // land on the same step rather than a 404, as it does on a real portal.
    if (path === '/multistep/step2') return send(200, multistepStep2());
    if (path === '/workday')       return send(200, workdayShell());
    if (path === '/workday/inner') return send(200, workdayInner());
    if (path === '/workday/decoy') return send(200, workdayDecoy());
    if (path === '/_submissions')
      return send(200, JSON.stringify({ count: submissions.length, submissions }, null, 2),
                  'application/json; charset=utf-8');
  }

  if (req.method === 'POST') {
    const raw = await readBody(req);
    const ctype = req.headers['content-type'] || '';
    const boundary = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    const { fields, files, partCount } = ctype.includes('multipart/form-data') && boundary
      ? parseMultipart(raw, (boundary[1] || boundary[2]).trim())
      : { fields: parseQuery(raw.toString('utf8')), files: {}, partCount: 0 };

    if (path === '/_reset') {
      submissions.length = 0;
      return send(200, JSON.stringify({ ok: true }), 'application/json');
    }

    if (path === '/greenhouse/step2') {
      return send(200, greenhouseStep2(fields, files));
    }

    if (path === '/multistep/step2') {
      return send(200, multistepStep2(fields));
    }

    if (path.startsWith('/_submit/')) {
      const provider = path.split('/')[2];
      // Uploads from an earlier step of a multi-step flow, carried in as a hidden field.
      const carried = fields._step1_files ? JSON.parse(fields._step1_files) : null;
      if (carried) { delete fields._step1_files; Object.assign(files, carried); }
      const record = { provider, at: new Date().toISOString(), fields, files, partCount };
      submissions.push(record);
      console.log(`[fakeAts] SUBMITTED via ${provider}:`);
      console.log(JSON.stringify(fields, null, 2));
      console.log(`[fakeAts] files (${partCount} parts):`, JSON.stringify(files, null, 2));
      return send(200, page('Application received', `
        <h1>Thank you for your application</h1>
        <p>Your application has been submitted successfully. We'll be in touch.</p>
        <p style="font-size:12px;color:#666">Recorded as submission #${submissions.length}.
        This phrasing is intentional: it is what <code>classifyFlowState</code> matches on to
        return <code>'submitted'</code>.</p>`));
    }
  }

  send(404, page('Not found', '<h1>404</h1>'));
});

server.listen(PORT, () => {
  console.log(`[fakeAts] listening on http://localhost:${PORT}`);
  console.log('[fakeAts] forms: /greenhouse  /lever  /ashby');
  console.log('[fakeAts] assert against GET /_submissions — never on status alone.');
  console.log('[fakeAts] uploads are real multipart; check record.files, not record.fields.');
});
