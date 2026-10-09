// D70 Phase 3, the tools-service half: (1) the cache lever reaches the HTTP caller, (2) the SDK's
// automatic retries are capped at one. A FAKE model client throughout — no network, no spend.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { generateResume } from "../src/generation/generate.js";
import { assemblePrompt, loadAllPrompts } from "../src/generation/promptAssembler.js";
import { buildRuntimeInputs } from "../src/generation/runtimeInputs.js";
import { createAnthropicClient, MODEL_MAX_RETRIES } from "../src/model/anthropicCall.js";
import { createApp } from "../src/http/app.js";
import { mintToken, parseClientTokens } from "../src/http/auth.js";
import { buildOpenApi } from "../src/contract/build.js";

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
const INPUT = {
  mode: "GENERATE", domainModuleKey: "engineering",
  candidate: { fullName: "Jane Doe", yearsOfExperience: 4 },
  job: { title: "Backend Engineer", company: "Acme", description: "Build services." },
  baseResumeText: BASE,
};

function fakeClient() {
  const calls = [];
  return { calls, messages: { create: async (params) => {
    calls.push(params);
    return { content: [{ type: "text", text: HONEST }], usage: { input_tokens: 10, output_tokens: 5 } };
  } } };
}
const sent = async (input) => { const c = fakeClient(); await generateResume(c, input, { env: {} }); return c.calls[0]; };

// ── (1) options.cache ───────────────────────────────────────────────────────────────────────────

test("⛔ options.cache absent: the request is byte-for-byte the one assembled before the option existed", async () => {
  const runtimeInputs = buildRuntimeInputs({ ...INPUT, profile: null, claims: null, employers: [] });
  // assemblePrompt called exactly as generate.js called it before 1.5.0 — no options argument.
  const { systemBlocks } = assemblePrompt("engineering", "GENERATE", runtimeInputs, { SUMMARY: false });
  for (const input of [INPUT, { ...INPUT, options: {} }, { ...INPUT, options: { includeSummary: false } }]) {
    const req = await sent(input);
    assert.equal(JSON.stringify(req.system), JSON.stringify(systemBlocks));
    assert.equal(req.messages[0].content, runtimeInputs);
  }
  assert.ok(systemBlocks.filter(b => b.text).every(b => b.cache_control?.type === "ephemeral"));
});

test("options.cache true is the default, stated", async () => {
  assert.equal(JSON.stringify(await sent({ ...INPUT, options: { cache: true } })), JSON.stringify(await sent(INPUT)));
});

test("options.cache false: no cache_control breakpoint anywhere, and the prompt text is unchanged", async () => {
  const off = await sent({ ...INPUT, options: { cache: false } });
  const on = await sent(INPUT);
  assert.ok(!JSON.stringify(off).includes("cache_control"), "cache:false must remove every breakpoint");
  assert.deepEqual(off.system.map(b => b.text), on.system.map(b => b.text));
  assert.equal(off.messages[0].content, on.messages[0].content);
});

test("options.cache is forwarded from the HTTP request; a non-boolean is a 400 before any spend", async () => {
  const anthropic = fakeClient();
  const { token, entry } = mintToken("draft");
  const app = createApp({ anthropic, log: () => {}, clients: parseClientTokens(entry) });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const post = (b) => fetch(`http://127.0.0.1:${server.address().port}/v1/resumes/generate`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(b) });
  try {
    assert.equal((await post({ ...INPUT, options: { cache: false } })).status, 200);
    assert.ok(!JSON.stringify(anthropic.calls[0].system).includes("cache_control"));
    assert.equal((await post(INPUT)).status, 200);
    assert.ok(anthropic.calls[1].system.filter(b => b.text).every(b => b.cache_control?.type === "ephemeral"));
    const bad = await post({ ...INPUT, options: { cache: "false" } });
    assert.equal(bad.status, 400);
    const j = await bad.json();
    assert.equal(j.error, "invalid_request");
    assert.match(j.message, /options\.cache must be a boolean/);
    assert.equal(anthropic.calls.length, 2, "a refused request reached the model");
  } finally { await new Promise(r => server.close(r)); }
});

test("the contract declares GenerateRequest.options.cache: optional boolean, default true", async () => {
  const opts = (await buildOpenApi()).components.schemas.GenerateRequest.properties.options;
  assert.equal(opts.properties.cache.type, "boolean");
  assert.equal(opts.properties.cache.default, true);
  assert.ok(!opts.required.includes("cache"));
});

// ── (2) retries ─────────────────────────────────────────────────────────────────────────────────

test("⛔ the SDK client is built with maxRetries 1 — a transport retry re-bills a whole generation", () => {
  assert.equal(MODEL_MAX_RETRIES, 1);
  const built = [];
  class StubSdk { constructor(opts) { built.push(opts); } }
  const client = createAnthropicClient({ apiKey: "sk-test", Sdk: StubSdk });
  assert.ok(client instanceof StubSdk);
  assert.deepEqual(built, [{ apiKey: "sk-test", maxRetries: 1 }]);
  assert.equal(createAnthropicClient({ apiKey: "", Sdk: StubSdk }), null, "no key is a supported state: no client");
  assert.equal(built.length, 1);
});

test("the server builds its one client through the capped factory, not the SDK's defaults", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /createAnthropicClient\(\{ apiKey: process\.env\.ANTHROPIC_API_KEY \}\)/);
  assert.doesNotMatch(server, /new Anthropic\(/, "a second construction would inherit the SDK default of 2 retries");
  const src = fs.readFileSync("src/model/anthropicCall.js", "utf8");
  assert.match(src, /re-bill|bill the input/i, "the reason for the cap must sit beside it");
});
