// D70 Phase 1 (draft's WORKLOG): KEYWORDS INSTEAD OF THE POSTING, behind options.jobContext.
// "description" (the default) is the pinned prompt, byte for byte; "keywords" sends job.keywords and the
// posting's text goes nowhere — not to the generation prompt, not to the classifier.
import test from "node:test";
import assert from "node:assert/strict";
import { generateResume } from "../src/generation/generate.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";
import { buildRuntimeInputs, validateJobKeywords, renderJobKeywords, KEYWORD_LIMITS, JOB_CONTEXTS } from "../src/generation/runtimeInputs.js";
import { DECLARED_SCHEMAS } from "../src/contract/endpoints.js";
import { InvalidRequestError } from "../src/errors.js";

loadAllPrompts();

const BASE = `JANE DOE
SUMMARY
Software Engineer with 4 years building distributed systems.
EXPERIENCE
Stripe — Software Engineer
- Built payment services`;
const HONEST = `<html><body><div class="header"><div class="name">JANE DOE</div></div>
<div class="section-title">SUMMARY</div><p>Software Engineer with 4 years building distributed systems.</p>
<div class="section-title">EXPERIENCE</div><div class="entry"><div class="entry-org">Stripe</div>
<ul class="bullets"><li>Built payment services</li></ul></div></body></html>`;
const SECRET = "Our ninth-floor office overlooks the harbour and we celebrate every launch with cake.";
const KEYWORDS = { matched: ["Go", "PostgreSQL"], claimed: ["Kubernetes"], verbs: ["Built"], competencies: ["system design"],
  phrases: ["payments platform", "on-call"], seniority: "Senior" };
const INPUT = {
  mode: "GENERATE", domainModuleKey: "engineering",
  candidate: { fullName: "Jane Doe", yearsOfExperience: 4 },
  job: { title: "Backend Engineer", company: "Acme", description: `Build services. ${SECRET}` },
  baseResumeText: BASE,
};
function fakeClient() {
  const calls = [];
  return { calls, messages: { create: async (params) => {
    calls.push(params);
    return { content: [{ type: "text", text: params.system ? HONEST : JSON.stringify({ domainModuleKey: "engineering" }) }],
      usage: { input_tokens: 10, output_tokens: 5 } };
  } } };
}

test("⛔ D70 P1: absent and \"description\" render exactly the pinned prompt", () => {
  const a = buildRuntimeInputs({ ...INPUT });
  assert.equal(buildRuntimeInputs({ ...INPUT, jobContext: "description" }), a);
  assert.match(a, /\*\*TARGET JOB DESCRIPTION\*\*\nBuild services\./);
});

test("⛔ D70 P1: \"keywords\" renders the keywords and never the posting's text — even when job.description is sent", async () => {
  const c = fakeClient();
  await generateResume(c, { ...INPUT, job: { ...INPUT.job, keywords: KEYWORDS }, options: { jobContext: "keywords" } }, { env: {} });
  const sent = JSON.stringify(c.calls);
  assert.doesNotMatch(sent, /ninth-floor office/, "the posting's text reached the model");
  assert.doesNotMatch(sent, /TARGET JOB DESCRIPTION/);
  for (const t of ["PostgreSQL", "Kubernetes", "payments platform", "on-call", "Senior"]) assert.ok(sent.includes(t), t);
  assert.match(sent, /KEYWORDS ONLY/);
});

test("⛔ D70 P1: the classifier, too, reads the keywords and not the posting", async () => {
  const c = fakeClient();
  const input = { ...INPUT, domainModuleKey: undefined, job: { ...INPUT.job, keywords: KEYWORDS }, options: { jobContext: "keywords" } };
  try { await generateResume(c, input, { env: {} }); } catch { /* the stub's classifier reply may not parse — the request is what is checked */ }
  assert.ok(c.calls.length >= 1);
  assert.doesNotMatch(JSON.stringify(c.calls[0]), /ninth-floor office/);
});

test("D70 P1: validation — keywords mode needs job.keywords; bad shapes are refused before any call", async () => {
  const refuse = async (input) => {
    const c = fakeClient();
    await assert.rejects(generateResume(c, input, { env: {} }), InvalidRequestError);
    assert.equal(c.calls.length, 0, "no model call on a refused request");
  };
  await refuse({ ...INPUT, options: { jobContext: "keywords" } });
  await refuse({ ...INPUT, options: { jobContext: "posting" } });
  await refuse({ ...INPUT, job: { ...INPUT.job, keywords: { matched: "Go" } } });
  await refuse({ ...INPUT, job: { ...INPUT.job, keywords: { invented: ["x"] } } });
  await refuse({ ...INPUT, job: { ...INPUT.job, keywords: { phrases: Array(13).fill("p") } } });
  assert.equal(validateJobKeywords(KEYWORDS), null);
  assert.equal(validateJobKeywords({ matched: ["x".repeat(81)] })?.includes("longer than 80"), true);
});

test("D70 P1: the contract declares both fields, with the validator's own bounds", () => {
  assert.deepEqual(DECLARED_SCHEMAS.GenerateRequest.properties.options.properties.jobContext.enum, [...JOB_CONTEXTS]);
  assert.equal(DECLARED_SCHEMAS.GenerateRequest.properties.options.properties.jobContext.default, "description");
  const k = DECLARED_SCHEMAS.JobKeywords.properties;
  for (const [list, max] of Object.entries(KEYWORD_LIMITS.maxItems)) {
    assert.equal(k[list].maxItems, max, list);
    assert.equal(k[list].items.maxLength, KEYWORD_LIMITS.maxLength, list);
  }
  assert.ok(DECLARED_SCHEMAS.Job.properties.keywords, "job.keywords is declared");
  assert.ok(!DECLARED_SCHEMAS.Job.required?.includes("keywords"), "and optional");
});

test("D70 P1: an empty list leaves its line out", () => {
  const block = renderJobKeywords({ matched: ["Go"] });
  assert.match(block, /evidences:\*\* Go/);
  assert.doesNotMatch(block, /claimed \(candidate-supplied/);
});
