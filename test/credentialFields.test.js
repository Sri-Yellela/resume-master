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
  isCredentialField, sanitizeDiscoveredFields, buildAnswers, detectGate, classifyGateEvidence,
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

// detectGate reads MEASURED evidence now, not a boolean, so the fake supplies evidence in
// GATE_EVIDENCE_SRC's shape. That is what makes the visibility rule testable at all: the old fake
// answered "is there a recaptcha node" — the exact question that could not distinguish AE1's hidden
// anchor frame from a challenge a human has to solve.
const ev = (over = {}) => ({ challenges: [], configured: [], credentials: [], ...over });
const shown  = (over) => ({ selector: ".g-recaptcha", tag: "div", visible: true,  why: "rendered", w: 304, h: 78, ...over });
const hidden = (over) => ({ selector: ".g-recaptcha", tag: "div", visible: false, why: "no_box", w: 0, h: 0, ...over });
const pwd = (over) => ({ selector: 'input[type="password"]', tag: "input", visible: true, why: "rendered",
                         w: 200, h: 30, formVisible: true, formHasVisibleText: true, ...over });

const fakePage = ({ evidence = ev(), url = "https://x.example.com/apply" }) => ({
  url: () => url,
  evaluate: async () => evidence,
});

test("detectGate finds a login wall by its password input", async () => {
  assert.equal(await detectGate(fakePage({ evidence: ev({ credentials: [pwd()] }) })), "login_required");
});

test("detectGate finds a login wall by its URL", async () => {
  assert.equal(await detectGate(fakePage({ url: "https://x.example.com/users/sign-in" })), "login_required");
});

test("detectGate finds a CAPTCHA", async () => {
  assert.equal(await detectGate(fakePage({ evidence: ev({ challenges: [shown()] }) })), "captcha_required");
});

test("detectGate says nothing about an ordinary application page", async () => {
  assert.equal(await detectGate(fakePage({})), null);
});

// ── AE1: presence is not proof ───────────────────────────────────────────────

test("THE EXACT ELEMENT THAT CAUSED AE1: an invisible reCAPTCHA anchor frame is not a gate", async () => {
  // Measured off the live posting by scripts/ae1Diagnose.mjs. 256x60, visibility:hidden — invisible
  // reCAPTCHA's bot-scoring frame, which every visitor loads and nobody interacts with. The old
  // probe called this captcha_required and terminated a run on a plain 15-field apply form.
  const anchor = {
    selector: 'iframe[src*="/recaptcha/"]', tag: "iframe", visible: false, why: "visibility_hidden",
    w: 256, h: 60, src: "https://www.recaptcha.net/recaptcha/api2/anchor?ar=1&k=6LeFb_YU",
  };
  assert.equal(await detectGate(fakePage({ evidence: ev({ challenges: [anchor] }) })), null);
});

test("a data-sitekey attribute is never proof, in any visibility state", () => {
  // It says a captcha is PROVISIONED, not that one is presented — invisible Turnstile and reCAPTCHA
  // v3 both carry it on pages that challenge nobody. Reported as context, never as a verdict.
  for (const vis of [true, false]) {
    const v = classifyGateEvidence(
      ev({ configured: [{ selector: "[data-sitekey]", tag: "div", visible: vis, why: "rendered", w: 300, h: 80 }] }),
      "https://x.example.com/apply");
    assert.equal(v.gate, null, `data-sitekey with visible=${vis} must not decide a gate`);
  }
});

test("a hidden node never outvotes the absence of a visible one", () => {
  const v = classifyGateEvidence(ev({ challenges: [hidden(), hidden({ why: "transparent" })] }), "https://x/apply");
  assert.equal(v.gate, null);
  assert.equal(v.captcha, false);
});

test("the probe reads the DOM, never page source", () => {
  // A bundled JS chunk that merely mentions 'hcaptcha' is not a challenge, and no text match could
  // tell the two apart. Every probe has to be a querySelector against live nodes.
  const src = fs.readFileSync("services/applyAutomation.js", "utf8");
  const probe = src.slice(src.indexOf("export const GATE_EVIDENCE_SRC"), src.indexOf("export const EMPTY_GATE_EVIDENCE"));
  assert.ok(probe.length > 200, "the probe source must be locatable");
  for (const forbidden of ["innerHTML", "outerHTML", "documentElement.innerHTML", "textContent.includes", "document.scripts"]) {
    assert.ok(!probe.includes(forbidden), `the gate probe must not read ${forbidden}`);
  }
  assert.match(probe, /getComputedStyle/, "rendered-ness has to be measured, not assumed");
  assert.match(probe, /getClientRects/, "a node with no box is not on the page");
});

// ── The credential half keeps the wider net ──────────────────────────────────

test("a two-step sign-in still walls the run even with the password step not yet shown", () => {
  // The errors are not symmetric: a false CAPTCHA costs an application, a missed sign-in wall types
  // the candidate's identity into a third party's login box. So the credential probe accepts a
  // visible owning form as proof, not only a visible password input.
  const v = classifyGateEvidence(
    ev({ credentials: [pwd({ visible: false, why: "display_none", formVisible: true, formHasVisibleText: true })] }),
    "https://x.example.com/apply");
  assert.equal(v.gate, "login_required");
  assert.equal(v.login, true);
});

test("a password input in a hidden subtree with no visible form is not a wall", () => {
  const v = classifyGateEvidence(
    ev({ credentials: [pwd({ visible: false, why: "no_box", formVisible: false, formHasVisibleText: false })] }),
    "https://x.example.com/apply");
  assert.equal(v.gate, null);
});

test("a page carrying BOTH keeps login separately readable, so the pre-fill check is not fooled", () => {
  // detectGate reports the challenge first, as it always did. If `login` were only inferable from
  // that collapsed answer, the pre-fill check would read 'captcha_required', decline to halt, and
  // type into the sign-in form sitting on the same page.
  const v = classifyGateEvidence(ev({ challenges: [shown()], credentials: [pwd()] }), "https://x/apply");
  assert.equal(v.gate, "captcha_required");
  assert.equal(v.login, true);
  assert.equal(v.captcha, true);
});

test("the gate is checked BEFORE the fill, not only after it", () => {
  const src = fs.readFileSync("services/applyAutomation.js", "utf8");
  const preCheck = src.indexOf("const preFillGate =");
  const firstFill = src.indexOf("await runDiscovery();");
  assert.ok(preCheck > 0, "there must be a pre-fill gate check");
  assert.ok(preCheck < firstFill,
    "the gate check must come before the first discovery/fill pass, or the login form is typed into first");
});

test("a CREDENTIAL wall halts the pre-fill; a challenge does not (AE2)", () => {
  // Halting on a challenge is what produced a handoff packet with nothing in it: the run returned
  // with resolvedAnswers: [] before discovery had seen the employer's controls.
  const src = fs.readFileSync("services/applyAutomation.js", "utf8");
  assert.match(src, /if \(preFillGate\?\.login\) \{/,
    "the pre-fill halt must key on the credential half specifically");
  const halt = src.slice(src.indexOf("if (preFillGate?.login) {"), src.indexOf("await runDiscovery();"));
  assert.match(halt, /flowState: 'login_required'/,
    "the only gate that may hold with zero answers is the one where typing is the harm");
  assert.ok(!/if \(preFillGate\)\s*\{/.test(src),
    "no branch may halt the fill on either gate indiscriminately");
});

test("classifyFlowState and the pre-fill check share ONE definition of a gate", () => {
  // Two copies would drift, and the drift would show up as a page filled by one and held by the
  // other — the exact inconsistency this bug was made of.
  const src = fs.readFileSync("services/applyAutomation.js", "utf8");
  const classify = src.slice(src.indexOf("export async function classifyFlowState"));
  assert.match(classify.slice(0, 2000), /const gate = await detectGate\(page\)/);
  // The gate's password probe lives in the evidence source and nowhere else. Counted inside that
  // slice rather than across the file, because defence 2's in-page credential-form check queries
  // the same selector for a different question ("is this control in a login form") and is not a
  // second copy of the gate rule.
  const probe = src.slice(src.indexOf("export const GATE_EVIDENCE_SRC"), src.indexOf("export const EMPTY_GATE_EVIDENCE"));
  assert.equal((probe.match(/querySelectorAll\('input\[type="password"\]'\)/g) || []).length, 1,
    "the gate's password probe must exist in exactly one place");
  const decider = src.slice(src.indexOf("export function classifyGateEvidence"), src.indexOf("export async function gatherGateEvidence"));
  assert.ok(!decider.includes("querySelector"),
    "the DECISION must be a pure function of measured evidence — a DOM query here would be a second definition");
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
