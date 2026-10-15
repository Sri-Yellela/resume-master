// A97 (owner, 10-14): the remaining spend gaps after the ledger (bf928b4).
//   (1) an SDK transport retry is COUNTED — `attempts` on the usage record and in model_usage;
//   (2) generate/enhance refuse oversized inputs (400) instead of sending them to Sonnet;
//   (3) the model-limit policy parses the shape the owner would set, and "off" is said out loud.
// ⛔ No test here reaches Anthropic. The attempt tests run the REAL SDK over a FAKE transport (the
// `fetchImpl` the client wraps), so the SDK's own retry logic is what is being counted.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createAnthropicClient, callAnthropic, countsAttempts, noteAttempt, MODEL_MAX_RETRIES, MODEL_SONNET } from "../src/model/anthropicCall.js";
import { generateResume } from "../src/generation/generate.js";
import { enhanceResume } from "../src/generation/enhance.js";
import { INPUT_LIMITS } from "../src/generation/inputLimits.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";
import { createApp } from "../src/http/app.js";
import { mintToken, parseClientTokens } from "../src/http/auth.js";
import { createMetering, parseLimits, limitsBootSummary } from "../src/http/metering.js";
import { openStore } from "../src/store/db.js";
import { createModelUsageLedger, modelUsageSummary } from "../src/accounts/modelUsage.js";
import { buildOpenApi } from "../src/contract/build.js";

loadAllPrompts();

// ── a fake transport for the real SDK ─────────────────────────────────────────────────────────────
const OK_BODY = { id: "msg_1", type: "message", role: "assistant", model: MODEL_SONNET,
  content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 30, output_tokens: 7 } };
const ok = () => new Response(JSON.stringify(OK_BODY), { status: 200, headers: { "content-type": "application/json" } });
const overloaded = () => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
  { status: 529, headers: { "content-type": "application/json", "retry-after-ms": "1" } });
const badRequest = () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" } }),
  { status: 400, headers: { "content-type": "application/json" } });
function transport(...replies) {
  const sent = [];
  return { sent, fetchImpl: async (url, init) => {
    sent.push(init?.headers?.["x-stainless-retry-count"] ?? null);
    const next = replies.shift();
    if (!next) throw new Error("fake transport: no reply left");
    return next();
  } };
}
const PARAMS = { purpose: "resume_generate", model: MODEL_SONNET, max_tokens: 10, messages: [{ role: "user", content: "x" }] };

// ── (1) attempts ─────────────────────────────────────────────────────────────────────────────────

test("A97: a call the SDK sent once records attempts 1", async () => {
  const t = transport(ok);
  const { usage } = await callAnthropic(createAnthropicClient({ apiKey: "sk-test", fetchImpl: t.fetchImpl }), PARAMS);
  assert.equal(usage.attempts, 1);
  assert.equal(usage.input_tokens, 30);
  assert.equal(t.sent.length, 1);
});

test("⛔ A97: an SDK transport retry is COUNTED — 529 then 200 is one logical call with attempts 2", async () => {
  const t = transport(overloaded, ok);
  const { usage } = await callAnthropic(createAnthropicClient({ apiKey: "sk-test", fetchImpl: t.fetchImpl }), PARAMS);
  assert.equal(usage.success, true);
  assert.equal(usage.attempts, 2, "the retried send was invisible before A97");
  assert.deepEqual(t.sent, ["0", "1"], "the SDK's own retry counter agrees: two sends");
});

test("A97: a call that fails after its one retry records attempts 2 on the error's usage", async () => {
  const t = transport(overloaded, overloaded);
  await assert.rejects(callAnthropic(createAnthropicClient({ apiKey: "sk-test", fetchImpl: t.fetchImpl }), PARAMS), (e) => {
    assert.equal(e.usage.success, false);
    assert.equal(e.usage.attempts, 2);
    return true;
  });
  assert.equal(t.sent.length, 1 + MODEL_MAX_RETRIES, "the retry POLICY is unchanged: at most one retry");
});

test("A97: a non-retryable refusal is sent once — attempts 1", async () => {
  const t = transport(badRequest);
  await assert.rejects(callAnthropic(createAnthropicClient({ apiKey: "sk-test", fetchImpl: t.fetchImpl }), PARAMS),
    (e) => e.usage.attempts === 1 && e.permanent === true);
});

test("⛔ A97: concurrent calls on ONE shared client each count only their own sends", async () => {
  // Call A is retried (529, then 200); call B is sent once. One client, interleaved.
  const replies = { a: [overloaded, ok], b: [ok] };
  const client = createAnthropicClient({ apiKey: "sk-test", fetchImpl: async (_url, init) => {
    const which = JSON.parse(init.body).messages[0].content;
    return replies[which].shift()();
  } });
  const call = (which) => callAnthropic(client, { ...PARAMS, messages: [{ role: "user", content: which }] });
  const [a, b] = await Promise.all([call("a"), call("b")]);
  assert.equal(a.usage.attempts, 2);
  assert.equal(b.usage.attempts, 1);
});

test("A97: a client this service did not build reports attempts null — never a guessed 1", async () => {
  const fake = { messages: { create: async () => ({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }) } };
  assert.equal((await callAnthropic(fake, PARAMS)).usage.attempts, null);
  const counted = countsAttempts({ messages: { create: async () => { noteAttempt(); return { content: [], usage: {} }; } } });
  assert.equal((await callAnthropic(counted, PARAMS)).usage.attempts, 1);
});

test("A97: migration 006 adds model_usage.attempts; the ledger writes it and the summary sums it", () => {
  const db = openStore(":memory:");
  assert.ok(db.prepare("SELECT id FROM schema_migrations").pluck().all().includes("006_model_usage_attempts"));
  assert.ok(db.prepare("PRAGMA table_info(model_usage)").all().some(c => c.name === "attempts"));
  const ledger = createModelUsageLedger(db, { keyLabel: "k", keyFp: "abcd1234" });
  const u = { purpose: "resume_generate", model: MODEL_SONNET, success: true, input_tokens: 1, output_tokens: 1 };
  ledger("draft", "resumes.generate", [{ ...u, attempts: 2 }, { ...u, attempts: 1 }, { ...u, attempts: null }]);
  assert.deepEqual(db.prepare("SELECT attempts FROM model_usage ORDER BY id").pluck().all(), [2, 1, null]);
  const [row] = modelUsageSummary(db);
  assert.equal(row.attempts, 3);
  assert.equal(row.retried, 1, "one call needed a retry");
});

test("A97: the metering line carries the summed attempts", () => {
  const lines = [];
  createMetering({ log: l => lines.push(l) }).record("draft", "resumes.generate", [{ attempts: 2 }, { attempts: 1 }, { attempts: null }]);
  assert.equal(lines[0].attempts, 3);
  assert.equal(lines[0].retried_calls, 1);
});

test("A97: the factory still caps retries at one and passes the counting transport", () => {
  const built = [];
  class StubSdk { constructor(opts) { built.push(opts); } }
  createAnthropicClient({ apiKey: "sk-test", Sdk: StubSdk });
  assert.equal(built[0].maxRetries, 1);
  assert.equal(typeof built[0].fetch, "function");
});

test("the contract declares UsageRecord.attempts as number | null", async () => {
  const p = (await buildOpenApi()).components.schemas.UsageRecord.properties.attempts;
  assert.deepEqual([].concat(p.type).sort(), ["null", "number"]);
});

// ── (2) input caps ───────────────────────────────────────────────────────────────────────────────

const BASE = `JANE DOE
SUMMARY
Software Engineer with 4 years building distributed systems.
EXPERIENCE
Stripe — Software Engineer`;
const GEN = { mode: "GENERATE", domainModuleKey: "engineering", baseResumeText: BASE,
  candidate: { fullName: "Jane Doe", yearsOfExperience: 4 },
  job: { title: "Backend Engineer", company: "Acme", description: "Build services." } };
function spy() {
  const calls = [];
  return { calls, messages: { create: async (p) => { calls.push(p); return { content: [{ type: "text", text: "x" }], usage: {} }; } } };
}
const big = (n) => "a".repeat(n);

test("the cap numbers are the documented ones", () => {
  assert.deepEqual(INPUT_LIMITS, { baseResumeText: 100_000, jobDescription: 50_000, resumeText: 100_000,
    selectedAdditions: 100, selectedAdditionChars: 500, generateRequestChars: 250_000, enhanceRequestChars: 200_000 });
  const api = fs.readFileSync("docs/API.md", "utf8");
  for (const n of ["100,000", "50,000", "250,000", "200,000"]) assert.ok(api.includes(n), `docs/API.md states ${n}`);
});

test("⛔ generate refuses an oversized baseResumeText or job.description — before any model call, never truncated", async () => {
  for (const [input, re] of [
    [{ ...GEN, baseResumeText: big(INPUT_LIMITS.baseResumeText + 1) }, /baseResumeText is 100,001 characters; the limit is 100,000/],
    [{ ...GEN, job: { ...GEN.job, description: big(INPUT_LIMITS.jobDescription + 1) } }, /job\.description is 50,001 characters; the limit is 50,000/],
    [{ ...GEN, candidate: { ...GEN.candidate, location: big(INPUT_LIMITS.generateRequestChars) } }, /request is .* characters; the limit for a generation request is 250,000/],
  ]) {
    const c = spy();
    await assert.rejects(generateResume(c, input, { env: {} }), (e) => e.name === "InvalidRequestError" && re.test(e.message) || e.message);
    assert.equal(c.calls.length, 0, "a refused input reached the model");
  }
  // At the limit exactly: accepted.
  const c = spy();
  await generateResume(c, { ...GEN, baseResumeText: BASE + big(INPUT_LIMITS.baseResumeText - BASE.length) }, { env: {} }).catch(() => {});
  assert.equal(c.calls.length, 1);
});

test("⛔ enhance refuses an oversized resumeText or selectedAdditions, before any model call", async () => {
  for (const input of [
    { resumeText: big(INPUT_LIMITS.resumeText + 1) },
    { resumeText: BASE, selectedAdditions: Array(INPUT_LIMITS.selectedAdditions + 1).fill("Kafka") },
    { resumeText: BASE, selectedAdditions: [big(INPUT_LIMITS.selectedAdditionChars + 1)] },
    { resumeText: BASE, selectedAdditions: "Kafka" },
    { resumeText: BASE, profile: { name: big(INPUT_LIMITS.enhanceRequestChars) } },
  ]) {
    const c = spy();
    await assert.rejects(enhanceResume(c, input), { name: "InvalidRequestError" });
    assert.equal(c.calls.length, 0);
  }
  const c = spy();
  await enhanceResume(c, { resumeText: big(INPUT_LIMITS.resumeText), selectedAdditions: Array(INPUT_LIMITS.selectedAdditions).fill("Kafka") });
  assert.equal(c.calls.length, 1, "at the limits: accepted");
});

test("over HTTP an oversized input is 400 invalid_request with the field and the limit, and nothing is metered", async () => {
  const anthropic = spy();
  const logs = [];
  const { token, entry } = mintToken("draft");
  const app = createApp({ anthropic, log: e => logs.push(e), clients: parseClientTokens(entry), metering: createMetering({ log: e => logs.push(e) }) });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const post = (path, b) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(b) });
  try {
    const r = await post("/v1/resumes/generate", { ...GEN, baseResumeText: big(INPUT_LIMITS.baseResumeText + 1) });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_request");
    assert.match(j.message, /baseResumeText .* limit is 100,000 characters/);
    const e = await post("/v1/resumes/enhance", { resumeText: big(INPUT_LIMITS.resumeText + 1) });
    assert.equal(e.status, 400);
    assert.equal(anthropic.calls.length, 0);
    assert.ok(logs.filter(l => l.metering).every(l => l.calls === 0), "no model call was metered");
  } finally { await new Promise(r => server.close(r)); }
});

test("the contract declares the caps as maxLength / maxItems", async () => {
  const s = (await buildOpenApi()).components.schemas;
  assert.equal(s.GenerateRequest.properties.baseResumeText.maxLength, 100_000);
  assert.equal(s.Job.properties.description.maxLength, 50_000);
  assert.equal(s.EnhanceRequest.properties.resumeText.maxLength, 100_000);
  assert.equal(s.EnhanceRequest.properties.selectedAdditions.maxItems, 100);
  assert.equal(s.EnhanceRequest.properties.selectedAdditions.items.maxLength, 500);
});

// ── (3) model limits: off is said out loud ───────────────────────────────────────────────────────

test("parseLimits accepts the shape the owner would set: draft=200,*=20", () => {
  const m = parseLimits("draft=200,*=20");
  assert.deepEqual([...m], [["draft", 200], ["*", 20]]);
  assert.deepEqual([...parseLimits(" draft=200 , *=20 ")], [["draft", 200], ["*", 20]]);
  assert.equal(parseLimits(undefined).size, 0);
  assert.throws(() => parseLimits("draft=lots"), /malformed/);
});

test("limitsBootSummary: off says OFF and what that means; on lists the caps", () => {
  const off = limitsBootSummary(parseLimits(""));
  assert.match(off, /^OFF/);
  assert.match(off, /RM_LIMITS_PER_DAY/);
  assert.match(off, /unlimited/);
  assert.deepEqual(limitsBootSummary(parseLimits("draft=200,*=20")), { draft: 200, "*": 20 });
});

test("the boot line uses the summary, so an unset policy reads as a warning, not a bare 'off'", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /limitsBootSummary\(limits\)/);
});
