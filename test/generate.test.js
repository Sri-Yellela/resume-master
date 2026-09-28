// The generation kernel, driven by a FAKE model client.
//
// ⚠ STRUCTURAL, NOT A RUN. Every "model response" below is canned HTML. These tests prove the
// wiring — what is sent, what is checked, what is returned or withheld — and nothing about what a
// real model writes. No generation has been exercised end to end: the Anthropic balance is unfunded.
import test from "node:test";
import assert from "node:assert/strict";
import { generateResume } from "../src/generation/generate.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";
import { FORMATTING_SYSTEM } from "../src/formatting/formattingSystem.js";
import { ResumeClaimError, ResumeClaimNotInspectedError } from "../src/integrity/resumeClaimGuard.js";

loadAllPrompts();

const BASE = `JANE DOE
Software Engineer
SUMMARY
Software Engineer with 4 years building distributed systems.
EXPERIENCE
Stripe — Software Engineer
- Built payment services`;

const doc = (summary) => `<html><head></head><body>
<div class="header"><div class="name">JANE DOE</div></div>
<div class="section-title">SUMMARY</div><p>${summary}</p>
<div class="section-title">EXPERIENCE</div>
<div class="entry"><div class="entry-org">Stripe</div><div class="entry-role">Software Engineer</div>
<ul class="bullets"><li>Built payment services</li></ul></div></body></html>`;

function fakeClient(...responses) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        const r = responses[Math.min(calls.length - 1, responses.length - 1)];
        if (r instanceof Error) throw r;
        return { content: [{ type: "text", text: r }], usage: { input_tokens: 100, output_tokens: 50,
          cache_creation_input_tokens: 6704, cache_read_input_tokens: 0 } };
      },
    },
  };
}

const INPUT = {
  mode: "GENERATE",
  domainModuleKey: "engineering",
  candidate: { fullName: "Jane Doe", yearsOfExperience: 4, email: "jane@example.com" },
  profile: { name: "Backend", seniority: "mid", keywords: [], tools: [], actionVerbs: [] },
  job: { title: "Senior Backend Engineer", company: "Acme", description: "8+ years required." },
  baseResumeText: BASE,
};

test("an honest document is returned, with the usage of every call and nothing else", async () => {
  const client = fakeClient(doc("Software Engineer with 4 years building distributed systems."));
  const out = await generateResume(client, INPUT, { env: {} });
  assert.match(out.html, /Stripe/);
  assert.equal(out.claimCheck.ok, true);
  assert.ok(out.claimCheck.inspected.documentChars > 0, "the guard must have READ something");
  assert.equal(out.domainModuleKey, "engineering");
  assert.equal(out.usage.length, 1);
  assert.deepEqual(Object.keys(out.usage[0]).sort(), ["cache_creation_input_tokens", "cache_read_input_tokens",
    "duration_ms", "input_tokens", "model", "output_tokens", "purpose", "success"],
    "a usage record carries counts, never content");
  assert.equal(out.usage[0].purpose, "resume_generate");
});

test("the request: static layers carry the breakpoints, the varying inputs ride in the user message", async () => {
  const client = fakeClient(doc("Software Engineer with 4 years building distributed systems."));
  await generateResume(client, INPUT, { env: {} });
  const req = client.calls[0];
  assert.equal(req.model, "claude-sonnet-5");
  assert.deepEqual(req.thinking, { type: "disabled" }, "Sonnet 5 thinks by default and would eat the HTML budget");
  assert.ok(req.system.every(b => b.cache_control?.type === "ephemeral" || !b.text));
  // Nothing request-specific may sit in a cached block, or every request writes a fresh entry.
  for (const b of req.system) {
    assert.doesNotMatch(b.text, /Jane Doe|Acme|8\+ years required|jane@example\.com/,
      "a per-request value leaked into a cached system block");
  }
  assert.equal(req.messages.length, 1);
  assert.match(req.messages[0].content, /## RUNTIME INPUTS[\s\S]*Jane Doe[\s\S]*Acme[\s\S]*BASE RESUME TEXT/);
  assert.equal(req.messages[0].cache_control, undefined);
});

test("⛔ AF2 — a document claiming more years than the profile is WITHHELD, not returned", async () => {
  const client = fakeClient(doc("Senior engineer with 8 years building distributed systems."));
  await assert.rejects(generateResume(client, INPUT, { env: {} }), (e) => {
    assert.ok(e instanceof ResumeClaimError);
    assert.equal(e.code, "resume_claim_violation");
    assert.ok(e.violations.some(v => v.kind === "years_exceed_profile"));
    assert.equal(e.html, undefined, "the refused document must not ride out on the error");
    assert.equal(e.usageSoFar.length, 1, "the spend is still reported, so the caller can meter it");
    return true;
  });
});

test("⛔ there is no way to ask for the guard to be skipped", async () => {
  const client = fakeClient(doc("Engineer with 8 years."));
  for (const options of [{ skipClaimCheck: true }, { claimCheck: false }, { unsafe: true }]) {
    await assert.rejects(generateResume(client, { ...INPUT, options }, { env: {} }), ResumeClaimError);
  }
});

test("⛔ a document the guard could not READ is refused too — 'no violation' never means 'did not look'", async () => {
  const client = fakeClient("");
  await assert.rejects(generateResume(client, INPUT, { env: {} }), ResumeClaimNotInspectedError);
});

test("the declared seniority is the ceiling: 'senior' may say Senior, 'mid' may not", async () => {
  const seniorDoc = doc("Senior Software Engineer with 4 years building distributed systems.")
    .replace('<div class="entry-role">Software Engineer', '<div class="entry-role">Senior Software Engineer');
  const asSenior = { ...INPUT, profile: { ...INPUT.profile, seniority: "senior" } };
  const ok = await generateResume(fakeClient(seniorDoc), asSenior, { env: {} });
  assert.equal(ok.claimCheck.ok, true);
  await assert.rejects(generateResume(fakeClient(seniorDoc), INPUT, { env: {} }), ResumeClaimError);
});

test("the LLM formatting pass is OFF by default and, when on, is instructed with the renderer's CSS", async () => {
  const honest = doc("Software Engineer with 4 years building distributed systems.");
  const off = fakeClient(honest);
  await generateResume(off, INPUT, { env: {} });
  assert.equal(off.calls.length, 1);

  const on = fakeClient(honest, honest);
  const out = await generateResume(on, INPUT, { env: { RESUME_MASTER_LLM_FORMAT: "1" } });
  assert.equal(on.calls.length, 2);
  assert.equal(on.calls[1].system[0].text, FORMATTING_SYSTEM);
  assert.equal(on.calls[1].model, "claude-haiku-4-5-20251001");
  assert.deepEqual(out.usage.map(u => u.purpose), ["resume_generate", "resume_format"]);
});

test("a failed formatting pass leaves the deterministic render standing", async () => {
  const honest = doc("Software Engineer with 4 years building distributed systems.");
  const client = fakeClient(honest, new Error("overloaded_error"));
  const out = await generateResume(client, INPUT, { env: { RESUME_MASTER_LLM_FORMAT: "1" } });
  assert.match(out.html, /Stripe/);
  assert.deepEqual(out.usage.map(u => [u.purpose, u.success]), [["resume_generate", true], ["resume_format", false]]);
});

test("domain resolution: explicit key, else role family, else the classifier", async () => {
  const honest = doc("Software Engineer with 4 years building distributed systems.");
  const byFamily = fakeClient(honest);
  const a = await generateResume(byFamily, { ...INPUT, domainModuleKey: undefined, roleFamily: "pm", domain: "construction" }, { env: {} });
  assert.equal(a.domainModuleKey, "pm_construction");
  assert.equal(byFamily.calls.length, 1, "no classifier call when the caller supplied the family");

  const classified = fakeClient(JSON.stringify({ roleFamily: "data", domain: "general" }), honest);
  const b = await generateResume(classified, { ...INPUT, domainModuleKey: undefined }, { env: {} });
  assert.equal(b.domainModuleKey, "data");
  assert.deepEqual(b.usage.map(u => u.purpose), ["classifier", "resume_generate"]);

  const broken = fakeClient("not json", honest);
  const c = await generateResume(broken, { ...INPUT, domainModuleKey: undefined }, { env: {} });
  assert.equal(c.domainModuleKey, "general", "a failed classification is not a failed generation");
});

test("invalid input is refused before any model call", async () => {
  const client = fakeClient("x");
  await assert.rejects(generateResume(client, { ...INPUT, baseResumeText: "" }, { env: {} }), /baseResumeText is required/);
  await assert.rejects(generateResume(client, { ...INPUT, mode: "TAILORED" }, { env: {} }), /mode must be one of/);
  assert.equal(client.calls.length, 0);
});
