// Contract 1.9.0 (draft's WORKLOG 44x owner list, items 2 + 3): a base whose headings end in a colon ("Education:")
// parsed to ZERO sections, and tailoring then answered 200 with the header alone (80 of 1,466 characters on 11-05).
// Synthetic person; a fake client — nothing reaches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { buildStructuredResume } from "../src/formatting/resumeFormatter.js";
import { generateResume } from "../src/generation/generate.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";
import { ResumeUnparsedError } from "../src/errors.js";
import { createApp } from "../src/http/app.js";
import { mintToken, parseClientTokens } from "../src/http/auth.js";

loadAllPrompts();

const COLON_BASE = `Morgan Vale
Tacoma, WA | morgan.vale@example.com

Work Experience:
Data Engineer, Larkspur Logistics, Tacoma, WA | Mar 2022 - Present
- Built Spark jobs in Python that load shipment events into Snowflake
- Cut the nightly load from 3 hours to 40 minutes by partitioning on route

Technical Skills:
Languages: Python, SQL, Scala
Tools: Spark, Airflow, Snowflake

Education：
B.S. Information Systems, Coldwater State University | 2021`;

const NO_HEADINGS = `Morgan Vale
Tacoma, WA | morgan.vale@example.com
Data Engineer at Larkspur Logistics since 2022, building Spark jobs in Python that load shipment events into Snowflake.
Cut the nightly load from 3 hours to 40 minutes by partitioning on route. Python, SQL, Scala, Spark, Airflow.
B.S. Information Systems, Coldwater State University, 2021.`;

const KEYWORDS = { matched: ["Python", "Spark"], claimed: [], verbs: ["Built"], phrases: [], mustHave: ["Python"], niceToHave: [], broader: [] };
const INPUT = (baseResumeText) => ({
  mode: "GENERATE", candidate: { fullName: "Morgan Vale", yearsOfExperience: 3 }, profile: { name: "Data", seniority: "mid" },
  job: { title: "Data Engineer", company: "Acme", keywords: KEYWORDS }, baseResumeText, options: { tailoring: "code" },
});
const noModel = { messages: { create: async () => { throw new Error("no model call expected"); } } };

test("colon headings: 'Work Experience:', 'Technical Skills:' and 'Education：' (full-width) are read as their sections", () => {
  const s = buildStructuredResume(COLON_BASE);
  assert.deepEqual(s.sections.map(x => x.title), ["EXPERIENCE", "TECHNICAL SKILLS", "EDUCATION"]);
  assert.equal(s.header.name, "Morgan Vale");
  assert.ok(s.sections.find(x => x.title === "EXPERIENCE").entries.length >= 1);
  // the same base without the colons reads the same way
  assert.deepEqual(buildStructuredResume(COLON_BASE.replace(/[:：]$/gm, "")).sections.map(x => x.title), s.sections.map(x => x.title));
});

test("colon headings: a code tailoring now returns the whole résumé, not the header", async () => {
  const out = await generateResume(noModel, INPUT(COLON_BASE));
  assert.match(out.html, /Larkspur Logistics/);
  assert.match(out.html, /Coldwater State University/);
  assert.match(out.html, /Snowflake/);
});

test("⛔ resume_unparsed: a real base with no readable heading is refused before any model call, never answered header-only", async () => {
  for (const tailoring of ["code", "lean", "payload"]) {
    const input = INPUT(NO_HEADINGS);
    input.options = { tailoring };
    if (tailoring === "lean") input.job = { ...input.job, keywords: { matched: ["Python"], claimed: [], verbs: [], phrases: [] } };
    await assert.rejects(generateResume(noModel, input),
      e => e instanceof ResumeUnparsedError && e.code === "resume_unparsed" && e.permanent === true, tailoring);
  }
});

test("resume_unparsed: a short base (a header and little else) is not refused — that is an empty résumé, not an unreadable one", async () => {
  const out = await generateResume(noModel, INPUT("Morgan Vale\nTacoma, WA | morgan.vale@example.com"));
  assert.match(out.html, /Morgan Vale/);
});

test("resume_unparsed over HTTP: 422, retryable false, permanent true, a message, no html", async () => {
  const { token, entry } = mintToken("draft");
  const app = createApp({ anthropic: noModel, version: { version: "0.1.0-test" }, log: () => {}, clients: parseClientTokens(entry) });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const { port } = server.address();
    const r = await fetch(`http://127.0.0.1:${port}/v1/resumes/generate`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(INPUT(NO_HEADINGS)) });
    const b = await r.json();
    assert.equal(r.status, 422, JSON.stringify(b));
    assert.equal(b.error, "resume_unparsed");
    assert.equal(b.retryable, false);
    assert.equal(b.permanent, true);
    assert.match(b.message, /section heading/);
    assert.equal(b.html, undefined);
  } finally { server.close(); }
});
