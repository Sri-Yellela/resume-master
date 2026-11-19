// draft's WORKLOG D192 (3) + (4): the ATS contract 2.0.0 — POST /v2/ats/score beside the unchanged /v1, and the company
// lookup Resume Master makes only when it scores on its own.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCompanyLookup, LOOKUP_TTL_MS } from "../src/tools/companyLookup.js";
import { scoreAts, scoreAtsV2, companyNameFromPosting } from "../src/tools/deterministic.js";

const JOB = { title: "Senior Backend Engineer", company: "Kestrel Payments",
  description: "What you'll do\n- Build payment infrastructure with Kafka, Python and Terraform on AWS\n- Lead a team of 5 engineers\nRequirements\n- Python, Kafka, Terraform, AWS, PostgreSQL" };
const RESUME = "Experience\n- Built payment infrastructure on Kafka in Python on AWS for fintech merchants\nSkills: Python, Kafka, AWS, PostgreSQL, Airflow";
const STACK = { matched: true, name: "Kestrel Payments", slug: "kestrel-payments", industry: "financial technology",
  techStack: [{ name: "Apache Kafka", category: "data", postingShare: 0.64 }, { name: "Terraform", category: "devops", postingShare: 0.4 }, { name: "Prefect", category: "data", postingShare: 0.27 }] };
const fakeFetch = (answer, calls) => async (url) => { calls.push(url); return { ok: true, json: async () => answer }; };

test("d192OldContractStillServed — /v2's report is /v1's report, field for field", async () => {
  const v1 = scoreAts({ job: JOB, resumeText: RESUME });
  const v2 = await scoreAtsV2({ job: JOB, resumeText: RESUME, company: { techStack: [] } });
  assert.deepEqual(v2.report, v1.report);
  assert.equal(v2.contract, "2.0.0");
  assert.equal("contextual" in v1, false);
});

test("d192DraftCallerSkipsLookup — a request that carries the stack is never looked up", async () => {
  const calls = [];
  const lookupCompany = createCompanyLookup({ fetchImpl: fakeFetch(STACK, calls) });
  const r = await scoreAtsV2({ job: JOB, resumeText: RESUME, company: { industry: "fintech", techStack: STACK.techStack } }, { lookupCompany });
  assert.equal(calls.length, 0);
  assert.equal(r.company.source, "request");
  assert.deepEqual(r.contextual.similarities.stack, ["Apache Kafka"]);
});

test("d192RmStandaloneLooksUpCompany — no stack in the request: the company's name is asked of draft's public endpoint", async () => {
  const calls = [];
  const lookupCompany = createCompanyLookup({ url: "https://draft.example/api/public/company-stack", fetchImpl: fakeFetch(STACK, calls) });
  const r = await scoreAtsV2({ job: JOB, resumeText: RESUME }, { lookupCompany });
  assert.deepEqual(calls, ["https://draft.example/api/public/company-stack?name=Kestrel%20Payments"]);
  assert.equal(r.company.source, "lookup");
  assert.equal(r.contextual.parts.tech_stack.status, "ok");
  assert.ok(r.contextual.dissimilarities.some(d => d.kind === "stack_gap" && d.tech === "Terraform" && d.action === "learn"));
  assert.ok(r.contextual.similarities.ecosystem.some(e => e.yours === "Apache Airflow" && e.theirs === "Prefect"), "Airflow read from the résumé text");
  assert.equal(companyNameFromPosting("About Kestrel Payments\nWe move money."), "Kestrel Payments");
  assert.equal(companyNameFromPosting("Engineers at Kestrel Payments are building"), "Kestrel Payments");
  assert.equal(companyNameFromPosting("Join us. Great culture."), null);
});

test("d192RmCaches24h — one lookup per company per day, in memory; a failure is not kept", async () => {
  const calls = [];
  let t = 1_000;
  const lookup = createCompanyLookup({ fetchImpl: fakeFetch(STACK, calls), now: () => t });
  await lookup("Kestrel Payments"); await lookup("kestrel payments"); await lookup("KESTREL PAYMENTS!");
  assert.equal(calls.length, 1);
  t += LOOKUP_TTL_MS - 1; await lookup("Kestrel Payments"); assert.equal(calls.length, 1);
  t += 2; await lookup("Kestrel Payments"); assert.equal(calls.length, 2, "asked again after 24 h");
  const failing = createCompanyLookup({ fetchImpl: async () => { throw new Error("down"); } });
  assert.equal(await failing("Kestrel Payments"), null);
  assert.equal(failing.cacheSize(), 0);
  const unmatched = createCompanyLookup({ fetchImpl: fakeFetch({ matched: false }, []) });
  assert.deepEqual(await unmatched("Nobody"), { matched: false, industry: null, techStack: [] });
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "tools", "companyLookup.js"), "utf8");
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ""), /writeFile|node:fs|better-sqlite3|anthropic/, "memory only, no model");
});

test("a failed lookup is no data, never an error", async () => {
  const lookupCompany = createCompanyLookup({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  const r = await scoreAtsV2({ job: JOB, resumeText: RESUME }, { lookupCompany });
  assert.equal(r.company.source, "none");
  assert.equal(r.contextual.parts.tech_stack.status, "no_data");
  assert.equal(typeof r.contextual.score, "number");
});
