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
 *   GET  /_submissions         JSON of everything submitted so far (for assertions)
 *   POST /_reset               clear recorded submissions
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
  <form method="POST" action="/greenhouse/step2">
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

function greenhouseStep2(carry) {
  const hidden = Object.entries(carry)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(String(v))}">`).join('');
  return page('Senior Engineer — Step 2', `
  <h1>Senior Engineer</h1><p>Step 2 of 2 — Eligibility</p>
  <form method="POST" action="/_submit/greenhouse">
    ${hidden}
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
  <form method="POST" action="/_submit/lever">
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
      <p style="font-size:13px;color:#666">Button reads "Review and Submit" — SUBMIT_RE is ^-anchored.</p>
    </fieldset>
    <button type="submit">Review and Submit</button>
  </form>`);
}

// ── Ashby-flavoured single-step form ─────────────────────────────────────────
function ashbyForm() {
  return page('Platform Engineer — Application', `
  <h1>Platform Engineer</h1>
  <form method="POST" action="/_submit/ashby">
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
  <form method="POST" action="/_submit/workday">
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
    <li><a href="/ashby">/ashby</a> — 1-step (required typeahead, non-ISO date)</li>
  </ul>
  <p><a href="/_submissions">/_submissions</a> — recorded submissions (JSON)</p>
  <h2>Traps</h2>
  <pre style="white-space:pre-wrap;font-size:12px">${escapeHtml(JSON.stringify(TRAPS, null, 2))}</pre>`);
}

// ── Server ───────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on('end', () => resolve(raw));
  });
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
    if (path === '/workday')       return send(200, workdayShell());
    if (path === '/workday/inner') return send(200, workdayInner());
    if (path === '/workday/decoy') return send(200, workdayDecoy());
    if (path === '/_submissions')
      return send(200, JSON.stringify({ count: submissions.length, submissions }, null, 2),
                  'application/json; charset=utf-8');
  }

  if (req.method === 'POST') {
    const raw = await readBody(req);
    // NOTE: multipart (file uploads) is not parsed — file fields are recorded as present-only.
    const fields = req.headers['content-type']?.includes('multipart/form-data')
      ? { _multipart: true, _rawLength: raw.length }
      : parseQuery(raw);

    if (path === '/_reset') {
      submissions.length = 0;
      return send(200, JSON.stringify({ ok: true }), 'application/json');
    }

    if (path === '/greenhouse/step2') {
      return send(200, greenhouseStep2(fields));
    }

    if (path.startsWith('/_submit/')) {
      const provider = path.split('/')[2];
      const record = { provider, at: new Date().toISOString(), fields };
      submissions.push(record);
      console.log(`[fakeAts] SUBMITTED via ${provider}:`);
      console.log(JSON.stringify(fields, null, 2));
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
});
