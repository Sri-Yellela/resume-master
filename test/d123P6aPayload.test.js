// D123 P6a + P6g + P6d (draft's WORKLOG), contract 1.8.0: THE PAYLOAD, THE GISTS, THE FREE TIER and the per-request
// model choice. Synthetic person; a fake client — nothing reaches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { generateResume, generateGists } from "../src/generation/generate.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";
import { validateJobKeywords } from "../src/generation/runtimeInputs.js";
import { renderPayloadInput, checkPayloadChanges, capBold, codeSkills, bulletsNeedModel, PAYLOAD_SYSTEM, GIST_MODEL,
         NEW_BULLETS_PER_ENTRY } from "../src/generation/tailor.js";
import { buildStructuredResume } from "../src/formatting/resumeFormatter.js";
import { MODEL_HAIKU, MODEL_SONNET } from "../src/model/anthropicCall.js";

loadAllPrompts();

const BASE = `Alex Rivers
Denver, CO | alex.rivers@example.com

EXPERIENCE
Software Engineer, Quillmark Freight, Denver, CO | Jan 2023 - Present
- Built a REST API in Java serving 40,000 requests a day
- Cut p95 latency from 820 ms to 310 ms with a Redis cache

Software Engineer Intern, Ferngate Retail, Dallas, TX | Jun 2022 - Aug 2022
- Wrote ETL jobs in Python that load sales data into PostgreSQL

SKILLS
Languages: Java, Python, SQL
Tools: Redis, PostgreSQL, Docker

EDUCATION
B.S. Computer Science, Harrowgate State University | 2022`;
const HEADER1 = "Software Engineer | Quillmark Freight, Denver, CO";
const GISTS = [{ employer: "Quillmark Freight", text: "Backend engineer on a freight-booking platform: built and ran the services carriers book loads through, with an eye on reliability and response times. Worked with message queues between booking and billing." }];
const KEYWORDS = { matched: ["Java", "Redis"], claimed: [], verbs: ["Designed", "Built"], phrases: ["own backend services"],
  mustHave: ["Java", "message queues", "PostgreSQL"], niceToHave: ["Kubernetes"], broader: [{ term: "SQL databases", from: "PostgreSQL" }] };
const INPUT = {
  mode: "GENERATE", candidate: { fullName: "Alex Rivers", yearsOfExperience: 3 }, profile: { name: "SWE", seniority: "mid" },
  job: { title: "Backend Engineer", company: "Acme", keywords: KEYWORDS },
  baseResumeText: BASE, gists: GISTS, options: { tailoring: "payload" },
};

function fakeClient(answers) {
  const calls = [];
  return { calls, messages: { create: async (params) => {
    calls.push(params);
    const text = answers[Math.min(calls.length - 1, answers.length - 1)];
    return { content: [{ type: "text", text: typeof text === "string" ? text : JSON.stringify(text) }],
      usage: { input_tokens: 100, output_tokens: 50 } };
  } } };
}

test("p6gOriginalsSentAndRewordedFirst: the payload carries the job block, each employer's gist and its own bullets", () => {
  const user = renderPayloadInput({ structure: buildStructuredResume(BASE), job: INPUT.job, keywords: KEYWORDS, gists: GISTS });
  assert.match(user, /MUST-HAVE terms: Java, message queues, PostgreSQL/);
  assert.match(user, /Nice-to-have terms: Kubernetes/);
  assert.match(user, /Posting verbs, most used first: Designed, Built/);
  assert.match(user, /Gist: Backend engineer on a freight-booking platform/);
  assert.match(user, /e1b1: Built a REST API in Java serving 40,000 requests a day/, "the originals travel with the gist");
  assert.match(user, /Terms shown: Java, Redis/);
  assert.equal((user.match(/Gist:/g) || []).length, 1, "an employer without a gist gets none");
  assert.match(PAYLOAD_SYSTEM, /REWORD FIRST/);
  assert.match(PAYLOAD_SYSTEM, /BULLET CRAFT|bullet/i);
});

test("p6aNewBulletWithinGist: a new bullet is accepted only inside its employer's gist, with no number and a term its entry lacks", () => {
  const structure = buildStructuredResume(BASE);
  const ok = checkPayloadChanges({ structure, baseResumeText: BASE, keywords: KEYWORDS, gists: GISTS,
    changes: { bullets: {}, skills: null, added: { e1: ["Built **message queues** between booking and billing services"] } } });
  assert.deepEqual(ok.violations, []);
  assert.equal(ok.added.e1.length, 1);
  const bad = checkPayloadChanges({ structure, baseResumeText: BASE, keywords: KEYWORDS, gists: GISTS, changes: { bullets: {}, added: {
    e1: ["Built message queues handling 2M events", "Contributed to Java services", "Designed PostgreSQL schemas for billing"],
    e2: ["Built message queues for sales data"] } } });
  const kinds = bad.violations.map(v => v.kind);
  assert.ok(kinds.includes("number_not_in_bullet"), "a new bullet carries no number");
  assert.ok(kinds.includes("new_bullet_no_must_have"), "Java is already in e1's bullets");
  assert.ok(kinds.includes("outside_gist"), "PostgreSQL is not in Quillmark's gist or bullets");
  assert.ok(kinds.includes("new_bullet_without_gist"), "Ferngate has no gist");
  assert.equal(bad.added.e1, undefined);
  assert.ok(NEW_BULLETS_PER_ENTRY >= 1);
});

test("p6gDensityCap: at most two bold terms per bullet, and an edit cannot put a term in a third bullet", () => {
  assert.equal(capBold("Built **Java** and **Redis** with **Kafka**"), "Built **Java** and **Redis** with Kafka");
  const base = `${BASE.split("SKILLS")[0].replace("- Wrote ETL jobs", "- Shipped Java jobs\n- Wrote ETL jobs")}SKILLS\nLanguages: Java`;
  const structure = buildStructuredResume(base);
  const out = checkPayloadChanges({ structure, baseResumeText: base, keywords: KEYWORDS, gists: GISTS,
    changes: { bullets: { e2b2: "Wrote ETL jobs in Python and Java that load sales data into PostgreSQL" } } });
  assert.ok(out.violations.some(v => v.kind === "term_overused" && v.id === "e2b2"), "Java is already in two of the candidate's bullets");
  assert.equal(out.bullets.e2b2, undefined, "the overusing edit is reverted");
});

test("p6gGistBuiltOnceSonnet: the gists are one Sonnet call, numbers are refused, and numberless bullets are listed", async () => {
  assert.equal(GIST_MODEL, MODEL_SONNET);
  const client = fakeClient([{ e1: "Backend engineer on a freight platform.", e2: "Intern who moved 3 datasets." }]);
  const out = await generateGists(client, { baseResumeText: BASE });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].model, MODEL_SONNET);
  assert.deepEqual(client.calls[0].thinking, { type: "disabled" });
  assert.equal(out.usage[0].purpose, "resume_gist");
  assert.equal(out.gists.length, 1, "a gist that states a number is dropped");
  assert.match(out.gists[0].employer, /Quillmark Freight/);
  assert.deepEqual(out.numberless.map(n => n.bullet), ["Wrote ETL jobs in Python that load sales data into PostgreSQL"]);
  await assert.rejects(generateGists(client, {}), /baseResumeText is required/);
});

test("p6dCodeTierNoModel: tailoring \"code\" calls no model; Skills lead with the posting's terms, broader terms and coursework placed", async () => {
  const client = fakeClient(["unused"]);
  const out = await generateResume(client, { ...INPUT, gists: undefined, coursework: ["Art History", "Database Systems", "Distributed Systems"],
                                             options: { tailoring: "code" } });
  assert.equal(client.calls.length, 0);
  assert.deepEqual(out.usage, []);
  assert.equal(out.tailoring.mode, "code");
  assert.equal(out.tailoring.model, "none");
  assert.equal(out.tailoring.modelCalled, false);
  assert.match(out.html, /<strong>Tools<\/strong> PostgreSQL, Redis, SQL databases, Docker/, "the broader term joins the row of the skill that implies it, ranked as a posting term");
  assert.match(out.html, /Relevant Coursework/);
  const rows = codeSkills(buildStructuredResume(BASE), KEYWORDS, []);
  assert.equal(rows[0].label, "Tools", "the row carrying the most posting terms comes first");
  assert.equal(rows[0].values.split(", ")[0], "PostgreSQL", "a row leads with the posting's must-have terms");
});

test("p6dPayloadFallsToCode: a payload with nothing for the bullets to gain is free", async () => {
  const keywords = { matched: ["Java"], mustHave: ["Java"] };
  assert.equal(bulletsNeedModel(buildStructuredResume(BASE), keywords, GISTS), false);
  const client = fakeClient(["unused"]);
  const out = await generateResume(client, { ...INPUT, job: { ...INPUT.job, keywords } });
  assert.equal(client.calls.length, 0);
  assert.equal(out.tailoring.modelCalled, false);
  assert.equal(bulletsNeedModel(buildStructuredResume(BASE), KEYWORDS, GISTS), true, "message queues is in the gist and no bullet");
});

test("p6aPayloadEndToEnd: one Haiku call, the new bullet lands in its employer, the posting's text is never sent", async () => {
  const client = fakeClient([{ bullets: { e1b1: "Built a REST API in **Java** serving 40,000 requests a day" },
                               new: { e1: ["Built **message queues** between booking and billing services"] } }]);
  const out = await generateResume(client, INPUT);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].model, MODEL_HAIKU);
  assert.equal(client.calls[0].system, PAYLOAD_SYSTEM);
  assert.equal(out.tailoring.mode, "payload");
  assert.equal(out.tailoring.added, 1);
  assert.equal(out.tailoring.modelCalled, true);
  assert.equal(out.domainModuleKey, "payload");
  assert.match(out.html, /message queues/);
  assert.ok(HEADER1);
});

test("modelChoicePerRequest: options.model names the call's model; sonnet runs without thinking; open is refused unconfigured", async () => {
  const client = fakeClient([{ bullets: {} }]);
  await generateResume(client, { ...INPUT, options: { tailoring: "payload", model: "sonnet" } });
  assert.equal(client.calls[0].model, MODEL_SONNET);
  assert.deepEqual(client.calls[0].thinking, { type: "disabled" });
  const lean = fakeClient([{ bullets: {} }]);
  await generateResume(lean, { ...INPUT, gists: undefined, job: { ...INPUT.job, keywords: { matched: ["Java", "Redis"], claimed: ["Kubernetes"] } },
                               options: { tailoring: "lean", model: "haiku" } });
  assert.equal(lean.calls[0].model, MODEL_HAIKU);
  await assert.rejects(generateResume(client, { ...INPUT, options: { tailoring: "payload", model: "open" } }, { env: {} }), /not configured/);
  await assert.rejects(generateResume(client, { ...INPUT, options: { tailoring: "payload", model: "gpt" } }), /options.model must be one of/);
  await assert.rejects(generateResume(client, { ...INPUT, options: { tailoring: "code", model: "haiku" } }), /read only with options.tailoring "lean" or "payload"/);
});

test("p6aRequestRules: gists only with payload; the payload's keyword fields never reach the lean call; bounds validated", async () => {
  const client = fakeClient([{ bullets: {} }]);
  await assert.rejects(generateResume(client, { ...INPUT, options: { tailoring: "lean" } }), /gists are read only/);
  await assert.rejects(generateResume(client, { ...INPUT, gists: undefined, options: { tailoring: "lean" } }), /mustHave, niceToHave and broader are read only/);
  await assert.rejects(generateResume(client, { ...INPUT, gists: [{ employer: "X", text: "y".repeat(401) }] }), /gists must hold/);
  await assert.rejects(generateResume(client, { ...INPUT, coursework: ["x".repeat(81)] }), /coursework must be/);
  assert.match(validateJobKeywords({ broader: [{ term: "SQL" }] }), /broader must hold/);
  assert.equal(validateJobKeywords({ mustHave: ["Java"], niceToHave: ["Go"], broader: [{ term: "SQL", from: "PostgreSQL" }] }), null);
});
