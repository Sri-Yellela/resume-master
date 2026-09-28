// The HTTP surface, against a real listening server and a FAKE model client.
// ⚠ STRUCTURAL for the model-backed routes — see test/generate.test.js. The deterministic routes
// (/v1/ats/score, /v1/resumes/format, /v1/version) are real runs.
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/http/app.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";

loadAllPrompts();

// Sentinel PII. If any of these strings ever appears in a log line, the service retained content.
const PHONE = "555-867-5309";
const EMAIL = "sentinel.candidate@example.org";
const STREET = "742 Evergreen Terrace";
const SENTINELS = [PHONE, EMAIL, STREET];

const BASE = `JANE DOE ${PHONE} ${EMAIL} ${STREET}
SUMMARY
Software Engineer with 4 years building distributed systems.
EXPERIENCE
Stripe — Software Engineer`;
const honest = `<html><body><div class="header"><div class="name">JANE DOE</div><div class="contact">${PHONE} ${EMAIL}</div></div>
<div class="section-title">SUMMARY</div><p>Software Engineer with 4 years building distributed systems.</p>
<div class="section-title">EXPERIENCE</div><div class="entry"><div class="entry-org">Stripe</div><ul class="bullets"><li>Built services</li></ul></div></body></html>`;
const inflated = honest.replace("with 4 years", "with 9 years");

const body = { mode: "GENERATE", domainModuleKey: "engineering", baseResumeText: BASE,
  candidate: { fullName: "Jane Doe", yearsOfExperience: 4, phone: PHONE, email: EMAIL },
  job: { title: "Backend Engineer", company: "Acme", description: "Build services." } };

function fake(respond) {
  return { messages: { create: async () => {
    const r = respond();
    if (r instanceof Error) throw r;
    return { content: [{ type: "text", text: r }], usage: { input_tokens: 10, output_tokens: 5 } };
  } } };
}

async function serve(anthropic) {
  const logs = [];
  const app = createApp({ anthropic, version: { version: "0.1.0-test" }, log: e => logs.push(JSON.stringify(e)) });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, payload, raw) => fetch(base + path, { method: "POST",
    headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(payload) });
  return { base, post, logs, close: () => new Promise(r => server.close(r)) };
}

test("/v1/version answers JSON with the service name — assert the KEY, never a 200", async () => {
  const s = await serve(null);
  try {
    const r = await fetch(s.base + "/v1/version");
    assert.equal(r.headers.get("content-type").split(";")[0], "application/json");
    const j = await r.json();
    assert.equal(j.service, "resume-master");
    assert.equal(j.version, "0.1.0-test");
  } finally { await s.close(); }
});

test("⛔ an unknown path is a JSON 404, never a 200 page", async () => {
  const s = await serve(null);
  try {
    for (const path of ["/", "/api/config", "/v1/nope", "/index.html"]) {
      const r = await fetch(s.base + path);
      assert.equal(r.status, 404, path);
      assert.deepEqual(await r.json(), { error: "not_found" });
    }
  } finally { await s.close(); }
});

test("generate returns the document; a claim violation returns 422 and NO document", async () => {
  let reply = honest;
  const s = await serve(fake(() => reply));
  try {
    const ok = await s.post("/v1/resumes/generate", body);
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.match(j.html, /Stripe/);
    assert.equal(j.usage[0].purpose, "resume_generate");

    reply = inflated;
    const bad = await s.post("/v1/resumes/generate", body);
    assert.equal(bad.status, 422);
    const b = await bad.json();
    assert.equal(b.error, "resume_claim_violation");
    assert.equal(b.retryable, true, "generation is stochastic; the next attempt may be honest");
    assert.equal(b.html, undefined, "⛔ a refused document is never returned");
    assert.ok(b.violations.length > 0);
    assert.equal(b.usage.length, 1, "the spend is still reported for metering");
  } finally { await s.close(); }
});

test("⛔ a non-retryable failure SAYS so; a transient one says the opposite", async () => {
  let err;
  const s = await serve(fake(() => err));
  try {
    err = Object.assign(new Error("400 Your credit balance is too low to access the Anthropic API."), { status: 400 });
    const p = await (await s.post("/v1/resumes/generate", body)).json();
    assert.equal(p.error, "upstream_model_failure");
    assert.equal(p.permanent, true);
    assert.equal(p.retryable, false, "'try again' for an exhausted balance can never be true");

    err = Object.assign(new Error("overloaded_error"), { status: 529 });
    const t = await (await s.post("/v1/resumes/generate", body)).json();
    assert.equal(t.retryable, true);
  } finally { await s.close(); }
});

test("with no model key, model routes answer 503 model_unconfigured and deterministic routes still serve", async () => {
  const s = await serve(null);
  try {
    const g = await s.post("/v1/resumes/generate", body);
    assert.equal(g.status, 503);
    assert.deepEqual(await g.json(), { error: "model_unconfigured", retryable: false, usage: [] });
    const f = await s.post("/v1/resumes/format", { html: "JANE DOE\nSUMMARY\nBuilt things." });
    assert.equal(f.status, 200);
    assert.match((await f.json()).html, /<style>/);
  } finally { await s.close(); }
});

test("/v1/ats/score is the shared package — real run, deterministic, weights as pairs", async () => {
  const s = await serve(null);
  try {
    const job = { title: "Backend Engineer", company: "Acme",
      description: "Python, Kubernetes, Kafka, Terraform and AWS.",
      skills_json: JSON.stringify(["Python", "Kubernetes", "Kafka", "Terraform", "AWS"].map(skill => ({ skill, type: "hard" }))) };
    const r1 = await (await s.post("/v1/ats/score", { job, resumeText: "Python Kubernetes engineer" })).json();
    const r2 = await (await s.post("/v1/ats/score", { job, resumeText: "Python Kubernetes engineer" })).json();
    assert.deepEqual(r1, r2);
    assert.equal(r1.report.source, "local_ats_v4");
    assert.equal("resume_depth" in r1.report, false, "band presentation is each product's, not the scorer's");
    const weighted = await (await s.post("/v1/ats/score", { job, resumeText: "Python Kubernetes engineer",
      termWeights: [["kafka", 3], ["terraform", 3], ["aws", 3], ["python", 0.2], ["kubernetes", 0.2]] })).json();
    assert.equal(weighted.report.weighting.applied, true);
    // ⛔ the wrong shape is refused, not scored unweighted
    const bad = await s.post("/v1/ats/score", { job, resumeText: "x", termWeights: { kafka: 3 } });
    assert.equal(bad.status, 400);
  } finally { await s.close(); }
});

test("⛔ NO PAYLOAD IS LOGGED — on success, refusal, failure, malformed JSON or an oversized body", async () => {
  let reply = honest;
  const s = await serve(fake(() => reply));
  try {
    await s.post("/v1/resumes/generate", body);                                        // success
    reply = inflated; await s.post("/v1/resumes/generate", body);                      // refusal
    reply = Object.assign(new Error(`upstream echoed ${PHONE}`), { status: 500 });
    await s.post("/v1/resumes/generate", body);                                        // upstream failure
    await s.post("/v1/resumes/generate", null, `{"baseResumeText": "${PHONE} ${EMAIL} ${STREET}",`); // bad JSON
    await s.post("/v1/resumes/enhance", { resumeText: "" });                           // invalid request
    await s.post("/v1/ats/score", { job: { title: STREET }, resumeText: `${PHONE} ${EMAIL}` });   // deterministic
    await s.post("/v1/resumes/format", null, JSON.stringify({ html: STREET + "x".repeat(16 * 1024 * 1024) })); // 413
    assert.ok(s.logs.length >= 7, `expected a log line per request, got ${s.logs.length}`);
    for (const line of s.logs) {
      for (const secret of SENTINELS) {
        assert.ok(!line.includes(secret), `a log line retained candidate content: ${line.slice(0, 200)}`);
      }
    }
  } finally { await s.close(); }
});
