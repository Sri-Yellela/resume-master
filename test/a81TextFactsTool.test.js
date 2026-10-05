// A81 (agent-raised 10-04): the ATS tool read years, clearance and citizenship from signalProfile
// only, so an assistant sending job + resumeText was always told the years were "not set" and always
// got a clearance miss. With scorer 1.1.0 the tools service opts in to reading years (dated roles) and
// a stated clearance from the text WHEN NO signalProfile IS SENT; citizenship is never read. Synthetic
// résumés only.
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/http/app.js";
import { createMetering, createAnonymousLimiter } from "../src/http/metering.js";
import { scoreAts } from "../src/tools/deterministic.js";
import { MCP_TOOLS } from "../src/contract/endpoints.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";

loadAllPrompts();

const RESUME = "ALEX EXAMPLE\nEXPERIENCE\nAcme — Senior Engineer\nJan 2015 – Dec 2024\nActive TS/SCI clearance.\n" +
  "Built Python services on Kubernetes with Kafka, Terraform and AWS.\nEDUCATION\nState University, B.S.  2011 – 2015";
const JOB = { title: "Backend Engineer", company: "Acme",
  description: "Python, Kubernetes, Kafka, Terraform and AWS. Requires 5+ years of experience. " +
    "An active TS/SCI security clearance is required. U.S. citizenship required.",
  skills_json: JSON.stringify(["Python", "Kubernetes", "Kafka", "Terraform", "AWS"].map(skill => ({ skill, type: "hard" }))) };

test("no signalProfile: years from the dated roles and the stated clearance are read — citizenship is not", () => {
  const { report } = scoreAts({ job: JOB, resumeText: RESUME });
  assert.deepEqual(report.facts_from_text, { years_experience: { years: 10, source: "dated_roles", roles: 1 },
    clearance: { stated: true, text: "TS/SCI" }, not_read: ["citizenship"] });
  assert.equal(report.experience.fit, true);
  assert.match(report.experience.summary, /dated roles cover about 10 years\) meets 5\+ year requirement/);
  assert.deepEqual(report.hard_constraint_misses, ["U.S. citizenship"]);
});

test("⛔ a caller that SENDS a signalProfile is scored exactly as before A81 — no text facts, no new key", () => {
  for (const signalProfile of [{}, { yearsExperience: 3, structuredFacts: {} }]) {
    const { report } = scoreAts({ job: JOB, resumeText: RESUME, signalProfile });
    assert.equal("facts_from_text" in report, false);
    assert.ok(report.hard_constraint_misses.includes("Security clearance"), "the profile did not state a clearance");
  }
  assert.equal(scoreAts({ job: JOB, resumeText: RESUME, signalProfile: {} }).report.experience.summary,
    "Job asks for 5+ years; profile years are not set.");
});

test("over anonymous /mcp: score_ats_fit returns what was read from the text", async () => {
  const log = () => {};
  const app = createApp({ log, version: { version: "test" }, metering: createMetering({ log }),
    anonymous: createAnonymousLimiter({ perIpPerMinute: 50, perIpPerDay: 50, perDay: 50 }) });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const client = new Client({ name: "a81", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
    const r = await client.callTool({ name: "score_ats_fit", arguments: { job: JOB, resumeText: RESUME } });
    assert.equal(r.structuredContent.outcome, "scored");
    assert.deepEqual(r.structuredContent.report.facts_from_text.not_read, ["citizenship"]);
    assert.equal(r.structuredContent.report.facts_from_text.clearance.text, "TS/SCI");
  } finally { await client.close(); await new Promise(r => server.close(r)); }
});

test("the tool description matches: years and a stated clearance ARE read; citizenship is NEVER read or asked for", () => {
  const d = MCP_TOOLS.find(t => t.name === "score_ats_fit").description;
  assert.doesNotMatch(d, /NOT READ FROM THE RÉSUMÉ TEXT/, "3e9347c's caveat described the scorer before A81");
  assert.match(d, /READ FROM THE RÉSUMÉ TEXT when no signalProfile is sent/);
  assert.match(d, /facts_from_text/);
  assert.match(d, /CITIZENSHIP IS NEVER READ/);
  assert.match(d, /Do not ask the user for citizenship or clearance status/);
});
