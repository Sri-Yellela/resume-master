// A portal's SIGN-IN box is not an application field.
//
// The bug: a gated posting redirects to a sign-in page, discovery walks it, finds an input named
// `login_email` labelled "Email", resolves it to the `email` handler and fills it with the
// candidate's address at field_map_exact — 0.9 confidence. The gate was only classified AFTER the
// fill, so the run held correctly having already typed into a third party's login form. Nothing was
// submitted, but on a real portal an email in a sign-in box is an account-existence probe against
// that candidate's own identity.
//
// Two independent defences, because either alone leaves a real hole:
//   1. detectGate runs BEFORE the fill, so a sign-in wall is never typed into at all.
//   2. no credential CONTROL is ever answered, which still holds on a page the classifier does not
//      flag — a login widget beside a real application form, or a login form the heuristics miss.
//
// The end-to-end proof is scripts/g6CredentialGuard.mjs, which drives a real browser at a page
// carrying both forms.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  isCredentialField, sanitizeDiscoveredFields, buildAnswers, detectGate,
  CREDENTIAL_SUBJECT_RE, CREDENTIAL_AUTOCOMPLETE,
} from "../services/applyAutomation.js";

const PAYLOAD = {
  field_map: {
    first_name: "Ada", last_name: "Lovelace", full_name: "Ada Lovelace",
    email: "ada@example.com", phone: "+1 555 0100",
  },
  handler_map: {}, custom_answers: {},
};

const field = (over) => ({
  field_id: "f", name: "", type: "text", label: "", is_required: false, options: [],
  handler_type: null, handler_source: null, current_value: "",
  autocomplete: "", in_credential_form: false, ...over,
});

// ── The predicate ────────────────────────────────────────────────────────────

test("THE EXACT FIELD THAT CAUSED THIS: login_email labelled Email", () => {
  assert.equal(isCredentialField({ name: "login_email", label: "Email" }), true);
});

test("a word-boundary regex alone could not have caught it", () => {
  // \b does not break on an underscore, so `login_email` is a single word to /\blogin\b/. The
  // subject has to be normalised first, and this is the assertion that keeps that normalisation.
  assert.equal(/\blogin\b/i.test("login_email"), false, "the naive form genuinely does not match");
  assert.equal(CREDENTIAL_SUBJECT_RE.test("login_email".replace(/[_-]+/g, " ")), true);
});

test("a control in a form that holds a password is a credential control, whatever it is called", () => {
  // The signal that generalises. It catches a login form whose email field is simply named `email`,
  // which is what most real sign-in forms use and what no name-based rule can distinguish.
  assert.equal(isCredentialField({ name: "email", label: "Email", in_credential_form: true }), true);
  assert.equal(isCredentialField({ name: "email", label: "Email", in_credential_form: false }), false);
});

test("credential autocomplete tokens are honoured", () => {
  for (const ac of CREDENTIAL_AUTOCOMPLETE) {
    assert.equal(isCredentialField({ name: "x", autocomplete: ac }), true, ac);
  }
  assert.equal(isCredentialField({ name: "x", autocomplete: "email" }), false);
});

test("a password control is one regardless of anything else", () => {
  assert.equal(isCredentialField({ name: "whatever", type: "password" }), true);
});

test("credential naming is caught outside a form too", () => {
  // SPA portals frequently have no <form> element at all.
  for (const name of ["username", "user_name", "userid", "user-id", "signin_email",
                      "passcode", "otp", "one_time_code", "verification_code", "mfa_code"]) {
    assert.equal(isCredentialField({ name }), true, name);
  }
});

test("ORDINARY APPLICATION FIELDS ARE NOT CREDENTIALS", () => {
  // The cost of a false positive is a field the candidate must fill by hand, so this list is the
  // guard on the guard.
  for (const f of [
    { name: "email", label: "Email" },
    { name: "first_name", label: "First Name" },
    { name: "job_application[email]", label: "Email" },
    { name: "linkedin_url", label: "LinkedIn Profile" },
    { name: "current_company", label: "Current company" },
    { name: "work_authorization", label: "Are you legally authorized to work?" },
    { name: "requires_sponsorship", label: "Do you require sponsorship?" },
    { name: "cover_letter", label: "Cover letter" },
    { name: "start_date", label: "Earliest start date" },
    { name: "referrer_name", label: "Name of Referrer" },
  ]) {
    assert.equal(isCredentialField(f), false, `${f.name} must stay fillable`);
  }
});

// ── The resolver path ────────────────────────────────────────────────────────

test("sanitize marks a credential field and strips its handler", () => {
  const fields = [field({ name: "login_email", label: "Email", handler_type: "email", handler_source: "attr" })];
  sanitizeDiscoveredFields(fields);
  assert.equal(fields[0].credential, true);
  assert.equal(fields[0].handler_type, null);
  assert.match(fields[0].handler_rejected, /credential_field/);
});

test("the strip is not limited to label-derived handlers", () => {
  // The one that mattered: login_email resolved through an ATTRIBUTE, so the pre-existing check —
  // which only inspects handler_source === 'label' — let it straight through.
  const fields = [field({ name: "login_email", label: "Email", handler_type: "email", handler_source: "attr" })];
  sanitizeDiscoveredFields(fields);
  assert.equal(fields[0].handler_type, null, "an attribute-derived handler must be stripped too");
});

test("buildAnswers fills NOTHING on a sign-in form", () => {
  const fields = sanitizeDiscoveredFields([
    field({ name: "login_email", label: "Email", type: "text", handler_type: "email", handler_source: "attr" }),
    field({ name: "login_password", label: "Password", type: "password" }),
  ]);
  const answers = buildAnswers(fields, PAYLOAD).filter(a => !a.skipped && a.value);
  assert.deepEqual(answers, [], "the candidate's details must not enter a login form");
});

test("clearing the handler alone would not have been enough", () => {
  // Steps 3 and 4 of buildAnswers match on the LABEL, and a sign-in box labelled "Email" is matched
  // by both — so a field with no handler at all is still reachable without the explicit skip.
  const fields = [field({ name: "login_email", label: "Email", handler_type: null, credential: true })];
  const answers = buildAnswers(fields, PAYLOAD).filter(a => !a.skipped && a.value);
  assert.equal(answers.length, 0);
});

test("the application form on the same page is still filled", () => {
  const fields = sanitizeDiscoveredFields([
    field({ name: "email", label: "Email", handler_type: "email", handler_source: "attr", in_credential_form: true }),
    field({ name: "applicant_email", label: "Email Address", handler_type: "email", handler_source: "attr" }),
    field({ name: "first_name", label: "First Name", handler_type: "first-name", handler_source: "attr" }),
  ]);
  const answers = buildAnswers(fields, PAYLOAD).filter(a => !a.skipped && a.value);
  assert.deepEqual(answers.map(a => a.name).sort(), ["applicant_email", "first_name"],
    "the login field is refused and the application's identical-looking one is not");
});

// ── Defence 1: the gate is detected before anything is typed ─────────────────

const fakePage = ({ html = "", url = "https://x.example.com/apply" }) => ({
  url: () => url,
  evaluate: async (src) => {
    if (String(src).includes("password")) return /type="password"/.test(html);
    if (String(src).includes("recaptcha")) return /recaptcha|g-recaptcha|data-sitekey/.test(html);
    return false;
  },
});

test("detectGate finds a login wall by its password input", async () => {
  assert.equal(await detectGate(fakePage({ html: '<input type="password">' })), "login_required");
});

test("detectGate finds a login wall by its URL", async () => {
  assert.equal(await detectGate(fakePage({ url: "https://x.example.com/users/sign-in" })), "login_required");
});

test("detectGate finds a CAPTCHA", async () => {
  assert.equal(await detectGate(fakePage({ html: '<div class="g-recaptcha"></div>' })), "captcha_required");
});

test("detectGate says nothing about an ordinary application page", async () => {
  assert.equal(await detectGate(fakePage({ html: '<input name="first_name">' })), null);
});

test("the gate is checked BEFORE the fill, not only after it", () => {
  const src = fs.readFileSync("services/applyAutomation.js", "utf8");
  const preCheck = src.indexOf("const preFillGate =");
  const firstFill = src.indexOf("await runDiscovery();");
  assert.ok(preCheck > 0, "there must be a pre-fill gate check");
  assert.ok(preCheck < firstFill,
    "the gate check must come before the first discovery/fill pass, or the login form is typed into first");
});

test("classifyFlowState and the pre-fill check share ONE definition of a gate", () => {
  // Two copies would drift, and the drift would show up as a page filled by one and held by the
  // other — the exact inconsistency this bug was made of.
  const src = fs.readFileSync("services/applyAutomation.js", "utf8");
  const classify = src.slice(src.indexOf("export async function classifyFlowState"));
  assert.match(classify.slice(0, 2000), /const gate = await detectGate\(page\)/);
  assert.equal((src.match(/input\[type="password"\]'\)`\)/g) || []).length, 1,
    "the password probe must exist in exactly one place");
});

// ── Defence 2 covers the legacy in-page sweep ────────────────────────────────

test("EVERY write site in the legacy sweep is credential-guarded", () => {
  // This sweep bypasses buildAnswers entirely — the file says so itself — so a fix in the resolver
  // does not touch it. It is injected into the page and cannot be imported, which is why this is
  // asserted against the source.
  const src = fs.readFileSync("services/applyAutomation.js", "utf8");
  const sweep = src.slice(src.indexOf("const FILL_FN_SRC = `"), src.indexOf("const DISCOVER_FN_SRC"));
  assert.match(sweep, /function isCredential\(el\)/, "the sweep needs its own in-page predicate");

  // One guard per fill step: generic name/id, placeholder hint, label map, dropdown, radio.
  const guards = (sweep.match(/if \(isCredential\((?:el|sel|r)\)\) return;/g) || []).length;
  assert.equal(guards, 5, `expected all 5 fill steps guarded, found ${guards}`);
});

test("the sweep's predicate is the same policy, not a second copy of it", () => {
  const src = fs.readFileSync("services/applyAutomation.js", "utf8");
  assert.match(src, /credentialRe:\s+CREDENTIAL_SUBJECT_RE\.source/,
    "the regex must be passed in from the one Node-side definition");
  assert.match(src, /credentialAutocomplete: \[\.\.\.CREDENTIAL_AUTOCOMPLETE\]/);
});

test("the sweep refuses a password control it would otherwise have written to", () => {
  // Found while measuring the fix: the sweep's type exclusion list is
  // hidden/submit/button/file/image — password is not on it. A profile carrying a key named
  // `password` would have had it typed into the page's password box by step 1.
  const src = fs.readFileSync("services/applyAutomation.js", "utf8");
  const sweep = src.slice(src.indexOf("const FILL_FN_SRC = `"), src.indexOf("const DISCOVER_FN_SRC"));
  assert.match(sweep, /\["hidden","submit","button","file","image"\]\.includes\(el\.type\)\) return;\s*\n\s*if \(isCredential\(el\)\) return;/,
    "the credential guard must sit immediately after the type filter that omits password");
  assert.equal(isCredentialField({ name: "password", type: "password" }), true);
});
