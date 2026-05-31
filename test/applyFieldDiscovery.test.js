// test/applyFieldDiscovery.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  FIELD_TYPES,
  HANDLER_BY_ATTR,
  PROFILE_KEY_TO_HANDLER,
  buildAnswers,
  classifyFlowState,
} from "../services/applyAutomation.js";

const serverSrc      = fs.readFileSync("server.js", "utf8");
const accountSrc     = fs.readFileSync("routes/account.js", "utf8");
const profilePanelSrc = fs.readFileSync("client/src/panels/ProfilePanel.jsx", "utf8");
const automationSrc  = fs.readFileSync("services/applyAutomation.js", "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// 1. FIELD_TYPES has all 17 required types
// ─────────────────────────────────────────────────────────────────────────────
test("FIELD_TYPES has all 17 required types", () => {
  const required = [
    'text', 'text_area', 'select', 'multi_select', 'radio', 'checkbox',
    'file', 'date', 'number', 'typeahead', 'toggle', 'rich_text',
    'hidden', 'password', 'static', 'complex', 'unknown',
  ];
  assert.equal(FIELD_TYPES.length, 17);
  for (const t of required) {
    assert.ok(FIELD_TYPES.includes(t), `FIELD_TYPES missing: ${t}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. HANDLER_BY_ATTR maps first-name, last-name, email, phone handlers
// ─────────────────────────────────────────────────────────────────────────────
test("HANDLER_BY_ATTR maps first-name, last-name, email, phone handler_types", () => {
  assert.equal(HANDLER_BY_ATTR['first_name'], 'first-name');
  assert.equal(HANDLER_BY_ATTR['fname'],      'first-name');
  assert.equal(HANDLER_BY_ATTR['last_name'],  'last-name');
  assert.equal(HANDLER_BY_ATTR['lname'],      'last-name');
  assert.equal(HANDLER_BY_ATTR['email'],      'email');
  assert.equal(HANDLER_BY_ATTR['phone'],      'phone');
  assert.equal(HANDLER_BY_ATTR['tel'],        'phone');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. PROFILE_KEY_TO_HANDLER maps new profile fields
// ─────────────────────────────────────────────────────────────────────────────
test("PROFILE_KEY_TO_HANDLER maps new profile fields", () => {
  assert.equal(PROFILE_KEY_TO_HANDLER['website_url'],      'website');
  assert.equal(PROFILE_KEY_TO_HANDLER['portfolio_url'],    'portfolio');
  assert.equal(PROFILE_KEY_TO_HANDLER['highest_degree'],   'degree');
  assert.equal(PROFILE_KEY_TO_HANDLER['field_of_study'],   'field-of-study');
  assert.equal(PROFILE_KEY_TO_HANDLER['university'],       'school');
  assert.equal(PROFILE_KEY_TO_HANDLER['graduation_year'],  'grad-year');
  assert.equal(PROFILE_KEY_TO_HANDLER['current_job_title'],'current-title');
  assert.equal(PROFILE_KEY_TO_HANDLER['current_company'],  'current-company');
  assert.equal(PROFILE_KEY_TO_HANDLER['years_of_experience'], 'years-experience');
  assert.equal(PROFILE_KEY_TO_HANDLER['desired_salary'],   'salary');
  assert.equal(PROFILE_KEY_TO_HANDLER['available_start_date'], 'start-date');
  assert.equal(PROFILE_KEY_TO_HANDLER['willing_to_relocate'], 'relocate');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. discoverFields, buildAnswers, classifyFlowState exported from applyAutomation.js
// ─────────────────────────────────────────────────────────────────────────────
test("discoverFields, buildAnswers, classifyFlowState are exported from applyAutomation.js", () => {
  assert.match(automationSrc, /export async function discoverFields/);
  assert.match(automationSrc, /export function buildAnswers/);
  assert.match(automationSrc, /export async function classifyFlowState/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. buildAnswers: given fields with handler_types, returns correct answers from handler_map
// ─────────────────────────────────────────────────────────────────────────────
test("buildAnswers returns correct answers from handler_map", () => {
  const fields = [
    { field_id: "fname", name: "fname", type: "text", label: "First Name", handler_type: "first-name", is_required: true, options: [] },
    { field_id: "lname", name: "lname", type: "text", label: "Last Name",  handler_type: "last-name",  is_required: true, options: [] },
    { field_id: "email", name: "email", type: "text", label: "Email",      handler_type: "email",      is_required: true, options: [] },
  ];
  const payload = {
    handler_map: { 'first-name': 'Jane', 'last-name': 'Doe', 'email': 'jane@example.com' },
    field_map: {},
    custom_answers: {},
  };
  const answers = buildAnswers(fields, payload);
  assert.equal(answers.length, 3);
  assert.equal(answers.find(a => a.field_id === 'fname')?.value, 'Jane');
  assert.equal(answers.find(a => a.field_id === 'lname')?.value, 'Doe');
  assert.equal(answers.find(a => a.field_id === 'email')?.value, 'jane@example.com');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. buildAnswers: typeahead field sets typeahead_selection
// ─────────────────────────────────────────────────────────────────────────────
test("buildAnswers: typeahead field sets typeahead_selection", () => {
  const fields = [
    { field_id: "school_field", name: "school_field", type: "typeahead", label: "University", handler_type: "school", is_required: false, options: [] },
  ];
  const payload = {
    handler_map: { 'school': 'Northeastern University' },
    field_map: {},
    custom_answers: {},
  };
  const answers = buildAnswers(fields, payload);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].type, 'typeahead');
  assert.equal(answers[0].typeahead_selection, 'Northeastern University');
  assert.equal(answers[0].value, 'Northeastern University');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. buildAnswers: custom_answers fallback resolves "How did you hear about us?"
// ─────────────────────────────────────────────────────────────────────────────
test("buildAnswers: custom_answers fallback resolves question", () => {
  const fields = [
    { field_id: "q1", name: "q1", type: "text", label: "How did you hear about us?", handler_type: null, is_required: false, options: [] },
  ];
  const payload = {
    handler_map: {},
    field_map: {},
    custom_answers: { "How did you hear about us?": "LinkedIn" },
  };
  const answers = buildAnswers(fields, payload);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].value, 'LinkedIn');
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. buildAnswers: skips file/hidden/password types
// ─────────────────────────────────────────────────────────────────────────────
test("buildAnswers: skips file, hidden, password types", () => {
  const fields = [
    { field_id: "resume_file", name: "resume_file", type: "file",     label: "Resume", handler_type: "resume",   is_required: false, options: [] },
    { field_id: "hidden1",     name: "hidden1",     type: "hidden",   label: "",       handler_type: null,       is_required: false, options: [] },
    { field_id: "pass1",       name: "pass1",       type: "password", label: "Password", handler_type: null,     is_required: false, options: [] },
    { field_id: "name1",       name: "name1",       type: "text",     label: "Name",   handler_type: "full-name", is_required: false, options: [] },
  ];
  const payload = {
    handler_map: { 'full-name': 'Jane Doe', 'resume': '/path/to/resume.pdf' },
    field_map: {},
    custom_answers: {},
  };
  const answers = buildAnswers(fields, payload);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].field_id, 'name1');
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. buildAnswers: checkbox handler_type resolves to 'true'/'false'
// ─────────────────────────────────────────────────────────────────────────────
test("buildAnswers: checkbox handler_type resolves to 'true' or 'false'", () => {
  const fields = [
    { field_id: "sponsor", name: "sponsor", type: "checkbox", label: "Requires sponsorship", handler_type: "sponsorship", is_required: false, options: [] },
    { field_id: "relocate", name: "relocate", type: "checkbox", label: "Willing to relocate", handler_type: "relocate", is_required: false, options: [] },
  ];
  const payload = {
    handler_map: { 'sponsorship': 'Yes', 'relocate': 'No' },
    field_map: {},
    custom_answers: {},
  };
  const answers = buildAnswers(fields, payload);
  assert.equal(answers.length, 2);
  assert.equal(answers.find(a => a.field_id === 'sponsor')?.value,  'true');
  assert.equal(answers.find(a => a.field_id === 'relocate')?.value, 'false');
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. classifyFlowState: source has all terminal state strings
// ─────────────────────────────────────────────────────────────────────────────
test("classifyFlowState source contains all terminal state strings", () => {
  assert.match(automationSrc, /login_required/);
  assert.match(automationSrc, /captcha_required/);
  assert.match(automationSrc, /submitted/);
  assert.match(automationSrc, /expired/);
  assert.match(automationSrc, /redirected/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Mock page helper
// ─────────────────────────────────────────────────────────────────────────────
function makeMockPage(opts = {}) {
  const {
    bodyText = "",
    hasPassword = false,
    hasCaptcha = false,
    hasNext = false,
    hasSubmit = false,
    hasForm = true,
    url = "https://example.com",
  } = opts;
  return {
    url: () => url,
    evaluate: async (fnOrStr) => {
      if (typeof fnOrStr !== "string") return null;
      if (fnOrStr.includes("innerText") || fnOrStr.includes("body?.innerText")) return bodyText.toLowerCase();
      if (fnOrStr.includes('type="password"') || fnOrStr.includes("type='password'") || fnOrStr.includes("password")) return hasPassword;
      if (fnOrStr.includes("recaptcha") || fnOrStr.includes("hcaptcha") || fnOrStr.includes("data-sitekey")) return hasCaptcha;
      if (fnOrStr.includes("NEXT_RE") || (fnOrStr.includes("next") && fnOrStr.includes("continue"))) return hasNext;
      if (fnOrStr.includes("SUBMIT_RE") || fnOrStr.includes("submit application")) return hasSubmit;
      if (fnOrStr.includes("input:not")) return hasForm;
      if (fnOrStr.includes("http-equiv") || fnOrStr.includes("refresh")) return false;
      return false;
    },
    $$: async () => [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. classifyFlowState: mock page with "thank you" body returns 'submitted'
// ─────────────────────────────────────────────────────────────────────────────
test("classifyFlowState: 'thank you for your application' body returns submitted", async () => {
  const page = makeMockPage({ bodyText: "thank you for your application" });
  const state = await classifyFlowState(page);
  assert.equal(state, "submitted");
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. classifyFlowState: mock page with password input returns 'login_required'
// ─────────────────────────────────────────────────────────────────────────────
test("classifyFlowState: page with password input returns login_required", async () => {
  const page = makeMockPage({ hasPassword: true });
  const state = await classifyFlowState(page);
  assert.equal(state, "login_required");
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Migration 060_user_profile_extended in server.js has custom_answers column
// ─────────────────────────────────────────────────────────────────────────────
test("Migration 060_user_profile_extended in server.js has custom_answers column", () => {
  assert.match(serverSrc, /060_user_profile_extended/);
  assert.match(serverSrc, /custom_answers TEXT NOT NULL DEFAULT '{}'/);
  assert.match(serverSrc, /website_url TEXT/);
  assert.match(serverSrc, /highest_degree TEXT/);
  assert.match(serverSrc, /desired_salary INTEGER/);
  assert.match(serverSrc, /willing_to_relocate INTEGER NOT NULL DEFAULT 0/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. buildAutofillPayload in server.js emits handler_map with expected keys
// ─────────────────────────────────────────────────────────────────────────────
test("buildAutofillPayload in server.js emits handler_map with first-name, email, salary, current-title", () => {
  assert.match(serverSrc, /handler_map:/);
  assert.match(serverSrc, /'first-name':/);
  assert.match(serverSrc, /'email':/);
  assert.match(serverSrc, /'salary':/);
  assert.match(serverSrc, /'current-title':/);
  assert.match(serverSrc, /custom_answers:/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. POST /api/profile in account.js saves custom_answers and desired_salary
// ─────────────────────────────────────────────────────────────────────────────
test("POST /api/profile in account.js saves custom_answers and desired_salary", () => {
  assert.match(accountSrc, /custom_answers/);
  assert.match(accountSrc, /desired_salary/);
  assert.match(accountSrc, /website_url/);
  assert.match(accountSrc, /willing_to_relocate/);
  assert.match(accountSrc, /JSON\.stringify/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. ProfilePanel.jsx has custom_answers, desired_salary, highest_degree fields
// ─────────────────────────────────────────────────────────────────────────────
test("ProfilePanel.jsx has custom_answers, desired_salary, highest_degree fields", () => {
  assert.match(profilePanelSrc, /custom_answers/);
  assert.match(profilePanelSrc, /desired_salary/);
  assert.match(profilePanelSrc, /highest_degree/);
  assert.match(profilePanelSrc, /website_url/);
  assert.match(profilePanelSrc, /willing_to_relocate/);
  assert.match(profilePanelSrc, /Application Extras/);
  assert.match(profilePanelSrc, /Education/);
  assert.match(profilePanelSrc, /Custom Answers/);
});
