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
  lowercase_yes: {
    finding: "buildAnswers checks value === 'Yes' (capital Y only), so 'yes' coerces to 'false' " +
             '— silently answering No.',
    field:   'authorized_to_work',
    expect:  "'yes' must be submitted as an affirmative, not 'false'",
  },
  submit_label: {
    finding: 'SUBMIT_RE is anchored at ^, so a button labelled "Review and Submit" never matches ' +
             'and the run silently ends as filled_not_submitted.',
    expect:  'the run either submits or reports filled_not_submitted — never a false "submitted"',
  },
  required_unmapped: {
    finding: 'buildAnswers skips unresolvable fields; the completeness gate must then HOLD ' +
             'rather than submit an incomplete form.',
    field:   'hear_about_us',
    expect:  "status === 'held_review' with this label in missingRequired",
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
function spaForm(delayMs) {
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
    var chunk2 =
      '<label class="req" for="f_resume">Resume</label>' +
      '<input id="f_resume" type="file" name="resume" required>' +
      '<label for="f_linkedin">LinkedIn</label><input id="f_linkedin" name="linkedin">' +
      '<label for="f_github">GitHub</label><input id="f_github" name="github">' +
      '<label for="f_addr">Address</label><input id="f_addr" name="address1">' +
      '<label class="req" for="f_auth">I am authorized to work without sponsorship</label>' +
      '<input id="f_auth" type="checkbox" name="authorized_no_sponsorship" required>';
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
    <li><a href="/multistep">/multistep</a> — 2-step offering a real POST, a pushState advance and
      a cross-origin control from one step 1 (TASK G0: activeTab grant lifetime)</li>
    <li><a href="/gated">/gated</a> — 302 to a sign-in wall, no form behind it
      (TASK G1: login_required → held_gate + packet). <a href="/gated/captcha">/gated/captcha</a>
      is the captcha_required variant. Neither is crossable, by design.</li>
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
    if (path === '/spa') {
      // ?delay=<ms> overrides the hydration delay; ?delay=0 renders synchronously.
      const q = url.searchParams.get('delay');
      return send(200, spaForm(q === null ? undefined : Number(q)));
    }
    // A 302 rather than serving the sign-in directly, because that is what a real portal does and it
    // is what makes the run's final URL differ from the URL it was queued with — the reason the gate
    // packet stores the URL the gate was OBSERVED at.
    if (path === '/gated') {
      res.writeHead(302, { Location: '/gated/signin' });
      return res.end();
    }
    if (path === '/gated/signin')  return send(200, gatedSignin());
    if (path === '/gated/captcha') return send(200, gatedCaptcha());
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
