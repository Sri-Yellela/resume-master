// D123 P2 (draft's WORKLOG): THE LEAN TAILORING CALL. The model returns JSON of changes to bullets and skills;
// code builds the résumé, checks the changes deterministically, repairs once on the stronger model, and reverts
// anything still refused. Synthetic person; a fake client — nothing reaches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { generateResume } from "../src/generation/generate.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";
import { validateJobKeywords } from "../src/generation/runtimeInputs.js";
import { indexBullets, checkLeanChanges, parseChanges, renderTailorInput, TAILOR_MODEL, TAILOR_REPAIR_MODEL } from "../src/generation/tailor.js";
import { buildStructuredResume } from "../src/formatting/resumeFormatter.js";
import { MODEL_HAIKU, MODEL_SONNET } from "../src/model/anthropicCall.js";
import { InvalidRequestError } from "../src/errors.js";

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
const POSTING_SECRET = "Our harbour-view office celebrates every launch with cake.";
const KEYWORDS = { matched: ["Java", "Redis"], claimed: ["Kubernetes"], verbs: ["Built"], phrases: ["low-latency APIs"],
  placements: [{ term: "Kafka", employer: "Quillmark Freight" }] };
const INPUT = {
  mode: "GENERATE", candidate: { fullName: "Alex Rivers", yearsOfExperience: 3 },
  profile: { name: "SWE", seniority: "mid" },
  job: { title: "Backend Engineer", company: "Acme", description: `Build APIs. ${POSTING_SECRET}`, keywords: KEYWORDS },
  baseResumeText: BASE, options: { tailoring: "lean" },
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

test("d123OneCallPerTailoring: a clean answer is ONE Haiku call, no classifier, and the posting's text is never sent", async () => {
  const client = fakeClient([{ bullets: { e1b1: "Built a **low-latency** REST API in **Java** and **Kafka** serving 40,000 requests a day" } }]);
  const out = await generateResume(client, INPUT);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].model, MODEL_HAIKU);
  assert.equal(TAILOR_MODEL, MODEL_HAIKU);
  assert.ok(!JSON.stringify(client.calls).includes(POSTING_SECRET), "the posting's text must not reach the model");
  assert.equal(out.usage.length, 1);
  assert.equal(out.usage[0].purpose, "resume_tailor");
  assert.deepEqual(out.tailoring, { mode: "lean", model: MODEL_HAIKU, repaired: false, changed: 1, refused: [] });
  assert.match(out.html, /<strong>Kafka<\/strong>/);
  assert.match(out.html, /Quillmark Freight/);
  assert.match(out.html, /Jan 2023 - Present/);
  assert.match(out.html, /Wrote ETL jobs in Python/, "an untouched bullet is the candidate's own");
});

test("d123ChangesOnlyJson: the model sees bullet ids and skills rows, never the header or education, and its HTML is not asked for", () => {
  const structure = buildStructuredResume(BASE);
  const ids = indexBullets(structure).map(b => b.id);
  assert.deepEqual(ids, ["e1b1", "e1b2", "e2b1"]);
  const user = renderTailorInput({ structure, job: INPUT.job, keywords: KEYWORDS });
  assert.match(user, /e1b2: Cut p95 latency/);
  assert.match(user, /Kafka @ Quillmark Freight/);
  assert.ok(!user.includes("alex.rivers@example.com"), "contact details are not sent");
  assert.ok(!user.includes("Harrowgate"), "education is not sent");
  assert.equal(parseChanges("not json"), null);
  assert.deepEqual(parseChanges('```json\n{"bullets":{"e1b1":"x"}}\n```'), { bullets: { e1b1: "x" }, skills: null });
});

test("d123NumberNotInBullet / d123TermWrongEmployer / d123SkillNotSupported: the deterministic checks", () => {
  const structure = buildStructuredResume(BASE);
  const r = checkLeanChanges({ structure, baseResumeText: BASE, keywords: KEYWORDS, changes: {
    bullets: {
      e1b1: "Built a REST API in Java serving 60,000 requests a day",        // a new number
      e1b2: "Cut p95 latency from 820 ms to 310 ms with a Redis cache on EC2", // EC2 is not a standalone number: fine
      e2b1: "Wrote ETL jobs in Python and Kafka that load sales data into PostgreSQL", // Kafka placeable only at Quillmark
    },
    skills: [{ label: "Languages", values: "Java, Kafka, Rust" }, { label: "Tools", values: "Redis, Docker" }],
  } });
  const kinds = r.violations.map(v => `${v.id}:${v.kind}`).sort();
  assert.deepEqual(kinds, ["e1b1:number_not_in_bullet", "e2b1:term_wrong_employer", "skills:skill_not_supported"]);
  assert.deepEqual(Object.keys(r.bullets), ["e1b2"]);
  const values = r.skills.flatMap(x => x.values.split(", "));
  assert.ok(values.includes("Kafka"), "a placeable term may enter Skills");
  assert.ok(!values.includes("Rust"), "an unsupported skill is dropped");
  for (const v of ["Python", "SQL", "PostgreSQL"]) assert.ok(values.includes(v), `${v}: an existing skill is never dropped`);
});

test("d123RepairOnceThenStop + d123HaikuDefaultSonnetFallback: one Sonnet repair, then refused edits are reverted — never a third call", async () => {
  const bad = { bullets: { e1b1: "Built a REST API in Java serving 90,000 requests a day", e2b1: "Wrote **Python** ETL jobs that load sales data into PostgreSQL" } };
  const client = fakeClient([bad, bad, bad]);
  const out = await generateResume(client, INPUT);
  assert.equal(client.calls.length, 2, "Haiku, then one repair");
  assert.equal(client.calls[0].model, MODEL_HAIKU);
  assert.equal(client.calls[1].model, MODEL_SONNET);
  assert.equal(TAILOR_REPAIR_MODEL, MODEL_SONNET);
  assert.deepEqual(client.calls[1].thinking, { type: "disabled" });
  assert.match(client.calls[1].messages[0].content, /adds 90000/);
  assert.deepEqual(out.usage.map(u => u.purpose), ["resume_tailor", "resume_tailor_repair"]);
  assert.equal(out.tailoring.repaired, true);
  assert.deepEqual(out.tailoring.refused, [{ id: "e1b1", kind: "number_not_in_bullet" }]);
  assert.match(out.html, /40,000 requests a day/, "the refused bullet is the candidate's own");
  assert.ok(!out.html.includes("90,000"));
  assert.match(out.html, /<strong>Python<\/strong> ETL jobs/, "the accepted edit stands");
});

test("d123UnreadableAnswerRepaired: unreadable JSON gets the one repair; a second unreadable answer leaves the base résumé", async () => {
  const client = fakeClient(["sorry, here is your resume", "still not json"]);
  const out = await generateResume(client, INPUT);
  assert.equal(client.calls.length, 2);
  assert.equal(out.tailoring.changed, 0);
  assert.deepEqual(out.tailoring.refused, [{ id: "*", kind: "unreadable_answer" }]);
  assert.match(out.html, /Built a REST API in Java serving 40,000 requests a day/);
});

test("d123LeanStillClaimGuarded: the contractual claim guard runs on the lean document", async () => {
  const client = fakeClient([{ bullets: { e1b1: "Senior engineer who built a REST API in Java serving 40,000 requests a day" } }]);
  await assert.rejects(generateResume(client, INPUT), e => e.code === "resume_claim_violation" && e.usageSoFar?.length === 1);
});

test("d123LeanRequestRules: lean needs job.keywords and mode GENERATE; placements are refused outside lean; placements validated", async () => {
  const client = fakeClient([{}]);
  const noKw = { ...INPUT, job: { ...INPUT.job, keywords: undefined } };
  await assert.rejects(generateResume(client, noKw), InvalidRequestError);
  await assert.rejects(generateResume(client, { ...INPUT, mode: "A_PLUS" }), InvalidRequestError);
  await assert.rejects(generateResume(client, { ...INPUT, options: { tailoring: "fast" } }), InvalidRequestError);
  await assert.rejects(generateResume(client, { ...INPUT, domainModuleKey: "engineering", options: { jobContext: "keywords" } }), /placements is read only/);
  assert.equal(client.calls.length, 0, "nothing was sent for a refused request");
  assert.match(validateJobKeywords({ placements: [{ term: "Kafka" }] }), /term, employer/);
  assert.match(validateJobKeywords({ placements: [{ term: "Kafka", employer: "X", why: "y" }] }), /only term and employer/);
  assert.equal(validateJobKeywords({ placements: [{ term: "Kafka", employer: "Quillmark Freight" }] }), null);
});

test("d123SummaryToggle: with the summary off, a base résumé's summary is not carried into the lean document", async () => {
  const withSummary = BASE.replace("EXPERIENCE", "SUMMARY\nEngineer who builds APIs.\n\nEXPERIENCE");
  const client = fakeClient([{}]);
  const off = await generateResume(client, { ...INPUT, baseResumeText: withSummary });
  assert.ok(!off.html.includes("Engineer who builds APIs."));
  const on = await generateResume(client, { ...INPUT, baseResumeText: withSummary, options: { tailoring: "lean", includeSummary: true } });
  assert.ok(on.html.includes("Engineer who builds APIs."));
});
