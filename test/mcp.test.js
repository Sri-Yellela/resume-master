// E1 — the MCP server, driven by the OFFICIAL MCP client over real Streamable HTTP, in-process.
//
// The client is @modelcontextprotocol/sdk's own Client. That matters beyond convenience: it
// VALIDATES every tool result's structuredContent against the tool's outputSchema (ajv), so each
// callTool below is also a check that the GENERATED schema describes what the tool really returns.
//
// ⛔ Each guard here was seen to FAIL by injecting the violation it names — see the commit message.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/http/app.js";
import { mintToken, parseClientTokens } from "../src/http/auth.js";
import { createMetering } from "../src/http/metering.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";
import { buildOpenApi, inlineRefs } from "../src/contract/build.js";
import { loadMcpContract, servedTool } from "../src/mcp/server.js";
import { atsOutcome } from "../src/tools/deterministic.js";
// A55: the 401 says what to send and how a token is got (never what was wrong with the one presented).
const UNAUTH_MESSAGE = "Send Authorization: Bearer rmk_<client>.<secret>. API tokens are issued by the operator on request — " +
  "there is no self-serve API sign-up yet. The free tools (ATS check, formatting) need no token on the site, resumemaster.one.";

loadAllPrompts();

const JOB = { title: "Backend Engineer", company: "Acme", description: "Python, Kubernetes, Kafka, Terraform and AWS.",
  skills_json: JSON.stringify(["Python", "Kubernetes", "Kafka", "Terraform", "AWS"].map(skill => ({ skill, type: "hard" }))) };
const DECLINED_INPUT = { job: { title: "Role", description: "Join us." }, resumeText: "Python" };

// A model client that counts. Every MCP tool is deterministic: this must never be touched.
function spyModel() {
  const spy = { calls: 0 };
  spy.client = { messages: { create: async () => { spy.calls++; return { content: [{ type: "text", text: "x" }], usage: {} }; } } };
  return spy;
}

async function serve({ clients, anthropic = null, metering } = {}) {
  const logs = [];
  const log = e => logs.push(e);
  const app = createApp({ anthropic, clients, log, version: { version: "0.1.0-test" },
    metering: metering ?? createMetering({ log }) });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return { url, logs, close: () => new Promise(r => server.close(r)) };
}

async function connect(url, token) {
  const transport = new StreamableHTTPClientTransport(new URL(url),
    { requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} } });
  const client = new Client({ name: "mcp-test", version: "1" });
  await client.connect(transport);
  return client;
}

async function withClient(fn, { anthropic, metering } = {}) {
  const { token, entry } = mintToken("draft");
  const s = await serve({ clients: parseClientTokens(entry), anthropic, metering });
  let client;
  try {
    client = await connect(s.url, token);
    return await fn(client, s, token);
  } finally {
    await client?.close();
    await s.close();
  }
}

// ── the in-process client: list, and call each ─────────────────────────────────────────────────

test("the official MCP client connects, lists exactly the deterministic tools, and calls each", async () => {
  await withClient(async (client) => {
    assert.equal(client.getServerVersion().name, "resume-master");
    assert.match(client.getInstructions(), /generation is not offered/i);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ["format_resume_print_html", "score_ats_fit"]);
    assert.ok(!tools.some(t => /generat|enhance|parse/i.test(t.name)), "a model-backed tool shipped in E1");
    for (const t of tools) {
      assert.equal(t.annotations.readOnlyHint, true, t.name);
      assert.ok(t.outputSchema, `${t.name} has no outputSchema — its result would go unvalidated`);
    }

    // callTool validates structuredContent against the generated outputSchema — a mismatch throws.
    const scored = await client.callTool({ name: "score_ats_fit", arguments: { job: JOB, resumeText: "Python Kubernetes engineer" } });
    assert.equal(scored.isError, undefined);
    assert.equal(scored.structuredContent.outcome, "scored");
    assert.equal(typeof scored.structuredContent.score, "number");
    assert.equal(scored.structuredContent.report.source, "local_ats_v5");
    assert.match(scored.content[0].text, /^Scored \d+\/100/);

    const formatted = await client.callTool({ name: "format_resume_print_html", arguments: { html: "JANE DOE\nSUMMARY\nBuilt things." } });
    assert.equal(formatted.structuredContent.contentType, "text/html");
    assert.match(formatted.structuredContent.html, /<style>/);
    assert.match(formatted.structuredContent.howToGetPdf, /not a PDF/);

    // A refusal is a tool error with its meaning — not a result, and not a protocol failure.
    const refused = await client.callTool({ name: "score_ats_fit", arguments: { resumeText: "x" } });
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent, undefined, "a refusal carries no result shape a caller could read as one");
    assert.match(refused.content[0].text, /says nothing about the résumé/);
    assert.equal(JSON.parse(refused.content[0].text.split("\n")[1]).error, "invalid_request");
    const badWeights = await client.callTool({ name: "score_ats_fit", arguments: { job: JOB, resumeText: "x", termWeights: { kafka: 3 } } });
    assert.equal(badWeights.isError, true, "a plain-object termWeights must be refused, never scored unweighted");

    await assert.rejects(client.callTool({ name: "generate_resume", arguments: {} }), /unknown tool/);
  });
});

// ── ⛔ zero model calls ─────────────────────────────────────────────────────────────────────────
//
// The package's own test (vendor/ats-scorer/test/package.test.js) pins that the SCORER's source
// contains no messages.create. That says nothing about the path in front of it. These pin the MCP
// path: at runtime, with a live counting model client handed to the app, and statically, over the
// whole import graph of the MCP server.

test("⛔ ATS scoring via MCP makes ZERO model calls — a live model client is present and never touched", async () => {
  const spy = spyModel();
  await withClient(async (client, s) => {
    await client.callTool({ name: "score_ats_fit", arguments: { job: JOB, resumeText: "Python Kubernetes engineer" } });
    await client.callTool({ name: "score_ats_fit", arguments: DECLINED_INPUT });
    await client.callTool({ name: "format_resume_print_html", arguments: { html: "JANE DOE" } });
    assert.equal(spy.calls, 0, "an MCP tool reached the model");
    const m = s.logs.filter(l => l.metering && l.via === "mcp");
    assert.equal(m.length, 3);
    for (const l of m) assert.equal(l.calls + l.input_tokens + l.output_tokens, 0, `${l.route} metered model spend`);
  }, { anthropic: spy.client });
});

const importsOf = (file) => [...fs.readFileSync(file, "utf8").matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map(m => m[1]);
function importGraph(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of importsOf(file)) if (spec.startsWith(".")) walk(path.resolve(path.dirname(file), spec));
  };
  walk(path.resolve(entry));
  return [...seen];
}

test("⛔ nothing the MCP server imports can reach a model — the whole import graph, statically", () => {
  const graph = importGraph("src/mcp/server.js");
  assert.ok(graph.some(f => f.endsWith(path.join("tools", "deterministic.js"))), "the walk did not reach the tools");
  for (const f of graph) {
    const rel = path.relative(process.cwd(), f);
    assert.doesNotMatch(rel, /^src[\\/](model|generation|parsing)[\\/]/, `the MCP server imports ${rel}`);
    const src = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(src, /messages\.(create|batches)|callAnthropic|@anthropic-ai/, `${rel} reaches for a model`);
  }
});

// ── ⛔ "not enough signal" is its own state, end to end ─────────────────────────────────────────

test("⛔ a DECLINED score round-trips over MCP as not_enough_signal — never as a number", async () => {
  await withClient(async (client, _s, token) => {
    const r = await client.callTool({ name: "score_ats_fit", arguments: DECLINED_INPUT });
    const sc = r.structuredContent;
    assert.equal(sc.outcome, "not_enough_signal");
    assert.equal(sc.score, null, "a declined score must be null, never 0");
    assert.ok(sc.report.decline_reasons.length > 0, "the reasons must travel");
    assert.equal(sc.report.scorable, false);
    assert.match(sc.meaning, /NOT a low score/);
    // The text is what many clients show the model: it must LEAD with the refusal's meaning.
    assert.match(r.content[0].text, /^NOT ENOUGH SIGNAL/);
    assert.match(r.content[0].text, /NOT a low score/);
    assert.equal(r.isError, undefined, "a decline is a correct answer, not an error");

    // Same input over HTTP: the report is byte-for-byte the one MCP wrapped.
    const http = await fetch(_s.url.replace("/mcp", "/v1/ats/score"), { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(DECLINED_INPUT) });
    assert.deepEqual(sc.report, (await http.json()).report);
  });
});

test("⛔ the outcome is conservative: only a scorable report with a numeric score is 'scored'", () => {
  assert.equal(atsOutcome({ scorable: true, score: 71 }).outcome, "scored");
  for (const r of [{ scorable: false, score: 0 }, { scorable: true, score: null }, { scorable: false, score: null },
                   { score: 50 }, {}, null]) {
    const o = atsOutcome(r);
    assert.equal(o.outcome, "not_enough_signal", JSON.stringify(r));
    assert.equal(o.score, null, JSON.stringify(r));
  }
});

test("⛔ the tool descriptions say what each does, what it refuses and what a refusal means", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const ats = tools.find(t => t.name === "score_ats_fit").description;
    for (const re of [/NO model call/, /not_enough_signal/, /NOT a low\s+score/, /Never present it as a\s+score/, /Refused/,
                      /companies and roles only/, /No band/]) {
      assert.match(ats, re, `score_ats_fit description lacks ${re}`);
    }
    const fmt = tools.find(t => t.name === "format_resume_print_html").description;
    for (const re of [/NOT a PDF/, /no server-side PDF/, /does not write/, /claim guard/, /Refused/, /A refusal means/]) {
      assert.match(fmt, re, `format_resume_print_html description lacks ${re}`);
    }
  });
});

// ── ⛔ schemas are GENERATED from the HTTP contract, and what /mcp serves IS the contract ───────

test("⛔ DRIFT: tools/list serves the generated contract's x-mcp table verbatim", async () => {
  const { tools: contractTools } = loadMcpContract();
  const fresh = (await buildOpenApi())["x-mcp"].tools;
  assert.deepEqual(contractTools, fresh, "contract/ x-mcp is stale — run `npm run contract`");
  // D21: compared on the WIRE, as a host receives it. The official SDK client parses tools/list
  // through its own schema and drops keys it does not model — `securitySchemes`, which ChatGPT reads —
  // so the client's view is not what was served.
  await withClient(async (_client, s, token) => {
    const r = await fetch(s.url, { method: "POST", headers: { "content-type": "application/json",
      accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const { result } = await r.json();
    assert.deepEqual(result.tools, contractTools.map(servedTool), "/mcp serves a tool table that is not the contract's");
  });
});

test("⛔ DRIFT: each tool's inputSchema IS its HTTP endpoint's request schema; its result wraps the HTTP shape", () => {
  const doc = JSON.parse(fs.readFileSync("contract/resume-master-api.v1.json", "utf8"));
  const components = doc.components.schemas;
  const httpRequest = (route) => {
    const [method, p] = route.split(" ");
    return doc.paths[p][method.toLowerCase()].requestBody.content["application/json"].schema;
  };
  const httpOk = (route) => {
    const [method, p] = route.split(" ");
    return inlineRefs(doc.paths[p][method.toLowerCase()].responses["200"].content["application/json"].schema, components);
  };
  const tools = Object.fromEntries(doc["x-mcp"].tools.map(t => [t.name, t]));
  for (const t of Object.values(tools)) {
    assert.deepEqual(t.inputSchema, inlineRefs(httpRequest(t["x-endpoint"]), components),
      `${t.name}: inputSchema differs from ${t["x-endpoint"]}'s request schema`);
    assert.equal(JSON.stringify(t.inputSchema).includes("$ref"), false, `${t.name}: an unresolved $ref`);
    assert.equal(JSON.stringify(t.outputSchema).includes("$ref"), false, `${t.name}: an unresolved $ref`);
  }
  assert.deepEqual(tools.score_ats_fit.outputSchema.properties.report, httpOk("POST /v1/ats/score").properties.report,
    "the MCP report is not the HTTP report");
  assert.deepEqual(tools.format_resume_print_html.outputSchema.properties.html, httpOk("POST /v1/resumes/format").properties.html);
});

test("⛔ no tool schema is written by hand in the MCP server", () => {
  const src = fs.readFileSync("src/mcp/server.js", "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /inputSchema\s*:|outputSchema\s*:|type\s*:\s*["']object["']|properties\s*:/,
    "src/mcp/server.js declares a schema — declare it in src/contract/endpoints.js and regenerate");
});

// ── ⛔ auth: the same service token, refused before the body is read ────────────────────────────

test("⛔ MCP auth: no token and a wrong token are 401; the official client cannot connect", async () => {
  const { entry } = mintToken("draft");
  const s = await serve({ clients: parseClientTokens(entry) });
  try {
    await assert.rejects(connect(s.url, null), /unauthenticated/, "connected with no token");
    await assert.rejects(connect(s.url, `rmk_draft.${"A".repeat(43)}`), /unauthenticated/, "connected with a wrong token");
    await assert.rejects(connect(s.url, mintToken("draft").token), /unauthenticated/, "connected with another deployment's token");
    const r = await fetch(s.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: "unauthenticated", retryable: false, message: UNAUTH_MESSAGE });
    assert.ok(!s.logs.some(l => l.metering), "an unauthenticated request was metered — it reached a tool");
  } finally { await s.close(); }
});

test("⛔ MCP auth: an unauthenticated OVERSIZED, MALFORMED body is still 401 — refused before it is read", async () => {
  const { entry } = mintToken("draft");
  const s = await serve({ clients: parseClientTokens(entry) });
  try {
    const r = await fetch(s.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "{" + "x".repeat(16 * 1024 * 1024) });
    assert.equal(r.status, 401, "the body was parsed before the caller was authenticated");
  } finally { await s.close(); }
});

test("⛔ MCP auth: no clients configured FAILS CLOSED (503 auth_unconfigured), never open", async () => {
  for (const clients of [null, parseClientTokens("")]) {
    const s = await serve({ clients });
    try {
      const r = await fetch(s.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
        authorization: `Bearer rmk_draft.${"A".repeat(43)}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      assert.equal(r.status, 503);
      const j = await r.json();
      assert.equal(j.error, "auth_unconfigured");
      assert.equal(j.retryable, false);
      await assert.rejects(connect(s.url, mintToken("draft").token), /503|auth_unconfigured/i);
    } finally { await s.close(); }
  }
});

// ── accounting, statelessness, no content in any log ───────────────────────────────────────────

// Measured: on every refusal path the sentinel test below drives, the SDK's error MESSAGES are fixed
// strings — so a handler that logged e.message would pass that test today. It would stop passing
// the day an SDK release quotes the request in a message. Hence this static rule: the MCP error
// handlers log an error's name, never its message or data. (Seen to fail by injecting
// `console.error("transport", e?.message)` into transport.onerror.)
test("⛔ the MCP error handlers log a name only — never an error's message or data", () => {
  const src = fs.readFileSync("src/mcp/server.js", "utf8");
  const handlers = [...src.matchAll(/\.onerror\s*=\s*\(?\s*(\w+)\s*\)?\s*=>\s*([^;]*);/g)];
  assert.equal(handlers.length, 2, "expected the server and transport onerror handlers");
  for (const [, v, body] of handlers) {
    assert.doesNotMatch(body, new RegExp(`\\b${v}\\??\\.(message|data|stack)|String\\(${v}\\)|JSON\\.stringify\\(${v}|console\\.`),
      `an onerror handler logs more than a name: ${body}`);
  }
});

test("per-client accounting: one metering line per MCP tool call, keyed by client and tool; none for list", async () => {
  await withClient(async (client, s) => {
    const before = s.logs.filter(l => l.metering).length;
    await client.listTools();
    assert.equal(s.logs.filter(l => l.metering).length, before, "tools/list is not a tool call");
    await client.callTool({ name: "score_ats_fit", arguments: { job: JOB, resumeText: "Python" } });
    await client.callTool({ name: "score_ats_fit", arguments: {} });
    const m = s.logs.filter(l => l.metering);
    assert.deepEqual(m.map(l => [l.client, l.route, l.via, l.result]), [
      ["draft", "mcp.score_ats_fit", "mcp", "ok"],
      ["draft", "mcp.score_ats_fit", "mcp", "invalid_request"],
    ]);
  });
});

test("the FREE limit hook is consulted on every MCP tool call, before the tool runs — never the model budget", async () => {
  const seen = [], model = [];
  const log = () => {};
  const metering = { ...createMetering({ log }), allow: (client, route) => { model.push([client, route]); return true; },
    allowFree: (client, route) => { seen.push([client, route]); return false; } };
  await withClient(async (client) => {
    const r = await client.callTool({ name: "score_ats_fit", arguments: { job: JOB, resumeText: "Python" } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /limit_exceeded/);
    assert.match(r.content[0].text, /says nothing about the résumé/);
    assert.deepEqual(seen, [["draft", "mcp.score_ats_fit"]]);
    assert.deepEqual(model, [], "a deterministic tool call took from the model budget");
  }, { metering });
});

test("⛔ stateless: no session id is issued, and a tool call needs no prior session", async () => {
  const { token, entry } = mintToken("draft");
  const s = await serve({ clients: parseClientTokens(entry) });
  try {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` };
    const init = await fetch(s.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) });
    assert.equal(init.headers.get("mcp-session-id"), null, "a session id was issued");
    // A cold tools/call, no initialize on this connection: answered.
    const r = await fetch(s.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "score_ats_fit", arguments: DECLINED_INPUT } }) });
    const j = await r.json();
    assert.equal(j.id, 7);
    assert.equal(j.result.structuredContent.outcome, "not_enough_signal");
  } finally { await s.close(); }
});

test("⛔ no content reaches any log over MCP — sentinel PII down every tool path, console included", async () => {
  const SENTINELS = ["555-867-5309", "sentinel.candidate@example.org", "742 Evergreen Terrace"];
  const text = `JANE DOE ${SENTINELS.join(" ")}\nSUMMARY\nBuilt things.`;
  const printed = [];
  const originals = {};
  for (const k of ["log", "info", "warn", "error", "debug"]) {
    originals[k] = console[k];
    console[k] = (...a) => printed.push(a.map(String).join(" "));
  }
  try {
    await withClient(async (client, s, token) => {
      await client.callTool({ name: "score_ats_fit", arguments: { job: { ...JOB, description: JOB.description + " " + text }, resumeText: text } });
      await client.callTool({ name: "score_ats_fit", arguments: { job: { title: text, description: text }, resumeText: text } });
      await client.callTool({ name: "score_ats_fit", arguments: { job: JOB, resumeText: text, termWeights: { [text]: 1 } } });
      await client.callTool({ name: "format_resume_print_html", arguments: { html: text } });
      await client.callTool({ name: "format_resume_print_html", arguments: { html: "", note: text } });
      await client.callTool({ name: text.slice(0, 40), arguments: { html: text } }).catch(() => {});
      // Past auth, the transport's own refusal paths: not JSON-RPC, an unknown method, a bad Accept.
      const h = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` };
      await fetch(s.url, { method: "POST", headers: h, body: JSON.stringify({ html: text }) });
      await fetch(s.url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: text }) });
      await fetch(s.url, { method: "POST", headers: h, body: `{"jsonrpc":"2.0","id":1,"method":"${text}` });
      await fetch(s.url, { method: "POST", headers: { ...h, accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { x: text } }) });
      await fetch(s.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ html: text }) });
      const everything = JSON.stringify(s.logs) + printed.join("\n");
      for (const x of SENTINELS) assert.ok(!everything.includes(x), `"${x}" reached a log line`);
      assert.ok(s.logs.some(l => l.metering), "the run logged nothing at all — the check would be vacuous");
    });
  } finally {
    Object.assign(console, originals);
  }
});
