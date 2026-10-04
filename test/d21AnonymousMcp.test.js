// D21 (owner, 10-04) — one MCP server, every host; anonymous first. ChatGPT's plugin directory reaches
// an MCP server anonymously or by OAuth 2.1 — not by a static bearer token — so score_ats_fit is served
// with NO token, behind caps that must exist before the door does. These drive the real app over real
// HTTP, with the official MCP client where the client is the point.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/http/app.js";
import { mintToken, parseClientTokens, ANONYMOUS_CLIENT, CLIENT_ID_RE } from "../src/http/auth.js";
import { createMetering, parseAnonymousPolicy, createAnonymousLimiter, parseFreeLimits } from "../src/http/metering.js";
import { buildMcpTools, buildComponents } from "../src/contract/build.js";
import { MCP_TOOLS } from "../src/contract/endpoints.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";

loadAllPrompts();

const JOB = { title: "Backend Engineer", company: "Acme", description: "Python, Kubernetes, Kafka, Terraform and AWS.",
  skills_json: JSON.stringify(["Python", "Kubernetes", "Kafka", "Terraform", "AWS"].map(skill => ({ skill, type: "hard" }))) };
const ACCEPT = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const rpc = (method, params) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });

async function serve({ policy = { perIpPerMinute: 100, perIpPerDay: 100, perDay: 100 }, clients = null, freeLimits = null, now } = {}) {
  const logs = [];
  const log = e => logs.push(e);
  const app = createApp({ clients, log, version: { version: "0.1.0-test" },
    metering: createMetering({ log, freeLimits }), anonymous: createAnonymousLimiter(policy, now ? { now } : {}) });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { ...ACCEPT, ...headers }, body });
  return { base, url: `${base}/mcp`, logs, post, close: () => new Promise(r => server.close(r)) };
}

test("⛔ RM_MCP_ANONYMOUS: absent = off; partial, malformed or zero REFUSES TO BOOT — never uncapped", () => {
  assert.equal(parseAnonymousPolicy(undefined), null);
  assert.equal(parseAnonymousPolicy("  "), null);
  assert.deepEqual(parseAnonymousPolicy("perIpPerMinute=10,perIpPerDay=200,perDay=5000"), { perIpPerMinute: 10, perIpPerDay: 200, perDay: 5000 });
  for (const bad of ["perIpPerMinute=10", "perIpPerMinute=10,perIpPerDay=200", "perIpPerMinute=0,perIpPerDay=1,perDay=1",
    "perIpPerMinute=x,perIpPerDay=1,perDay=1", "everyone=1,perIpPerMinute=1,perIpPerDay=1,perDay=1"]) {
    assert.throws(() => parseAnonymousPolicy(bad), /RM_MCP_ANONYMOUS/, bad);
  }
  const src = fs.readFileSync("server.js", "utf8");
  assert.match(src, /parseAnonymousPolicy\(process\.env\.RM_MCP_ANONYMOUS\)/);
  assert.match(src, /parseFreeLimits\(process\.env\.RM_FREE_LIMITS_PER_DAY\)/);
});

test("the anonymous client id can never be a minted client's id", () => {
  assert.equal(CLIENT_ID_RE.test(ANONYMOUS_CLIENT), false);
  assert.throws(() => mintToken(ANONYMOUS_CLIENT));
});

test("the limiter: per address per minute, per address per day, and in total per day — addresses are independent", () => {
  let t = Date.UTC(2026, 9, 4, 12, 0, 0);
  const l = createAnonymousLimiter({ perIpPerMinute: 2, perIpPerDay: 3, perDay: 5 }, { now: () => t });
  assert.deepEqual([l.take("a"), l.take("a"), l.take("a")], [null, null, "perIpPerMinute"]);
  t += 61_000;
  assert.deepEqual([l.take("a"), l.take("a")], [null, "perIpPerDay"], "3 a day for one address");
  assert.deepEqual([l.take("b"), l.take("c"), l.take("d")], [null, null, "perDay"], "5 a day for everyone");
  t += 86_400_000;
  assert.equal(l.take("a"), null, "a new UTC day resets every count");
});

test("⛔ privacy bound: a hashed address is held at most a minute, and never past its UTC day", () => {
  let t = Date.UTC(2026, 9, 4, 23, 59, 0);
  const l = createAnonymousLimiter({ perIpPerMinute: 5, perIpPerDay: 50, perDay: 500 }, { now: () => t });
  for (const ip of ["a", "b", "c"]) l.take(ip);
  assert.deepEqual(l.held(), { minute: 3, day: 3 });
  t += 30_000;                      // 23:59:30 — same minute, same day
  l.take("d");
  assert.deepEqual(l.held(), { minute: 4, day: 4 });
  t += 31_000;                      // 00:00:01 the next day — both windows turned
  l.take("e");
  assert.deepEqual(l.held(), { minute: 1, day: 1 }, "yesterday's and last minute's addresses are gone, not swept later");
});

test("anonymous on: the official MCP client connects with NO token, sees only score_ats_fit, and scores", async () => {
  const s = await serve();
  const client = new Client({ name: "d21", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(s.url)));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name), ["score_ats_fit"]);
    assert.deepEqual(tools[0].annotations, { title: tools[0].title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const r = await client.callTool({ name: "score_ats_fit", arguments: { job: JOB, resumeText: "Python Kubernetes Kafka Terraform AWS" } });
    assert.equal(r.structuredContent.outcome, "scored");
    const denied = await client.callTool({ name: "format_resume_print_html", arguments: { html: "JANE DOE" } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /not offered without an API token/);
    const m = s.logs.filter(l => l.metering);
    assert.deepEqual(m.map(l => [l.client, l.route, l.result]), [
      [ANONYMOUS_CLIENT, "mcp.score_ats_fit", "ok"], [ANONYMOUS_CLIENT, "mcp.format_resume_print_html", "unauthenticated"]]);
  } finally { await client.close(); await s.close(); }
});

test("⛔ anonymous OFF (no policy): a caller with no token is still 401 — today's behaviour exactly", async () => {
  const { entry } = mintToken("draft");
  const s = await serve({ policy: null, clients: parseClientTokens(entry) });
  try {
    assert.equal((await s.post("/mcp", rpc("tools/list"))).status, 401);
  } finally { await s.close(); }
});

test("⛔ a presented token is judged as a token: wrong = 401, no clients = 503 — never a downgrade to anonymous", async () => {
  const s = await serve({ clients: null });
  try {
    assert.equal((await s.post("/mcp", rpc("tools/list"))).status, 200, "anonymous needs no client list");
    const r = await s.post("/mcp", rpc("tools/list"), { authorization: `Bearer rmk_draft.${"A".repeat(43)}` });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, "auth_unconfigured");
  } finally { await s.close(); }
  const { entry } = mintToken("draft");
  const t = await serve({ clients: parseClientTokens(entry) });
  try {
    assert.equal((await t.post("/mcp", rpc("tools/list"), { authorization: `Bearer rmk_draft.${"A".repeat(43)}` })).status, 401);
    assert.equal((await t.post("/mcp", rpc("tools/list"), { authorization: "" })).status, 401, "an empty Authorization header is a presented token");
  } finally { await t.close(); }
});

test("anonymous is /mcp only: every /v1 route still needs a token", async () => {
  const s = await serve({ clients: parseClientTokens(mintToken("draft").entry) });
  try {
    for (const path of ["/v1/ats/score", "/v1/resumes/format", "/v1/resumes/parse-pdf", "/v1/resumes/generate", "/v1/resumes/enhance"]) {
      assert.equal((await s.post(path, JSON.stringify({}))).status, 401, path);
    }
  } finally { await s.close(); }
});

test("⛔ the caps are enforced per forwarded address, refused before the body is read, and no address is ever logged", async () => {
  const s = await serve({ policy: { perIpPerMinute: 2, perIpPerDay: 100, perDay: 100 } });
  const ip = (a) => ({ "x-forwarded-for": a });
  try {
    assert.equal((await s.post("/mcp", rpc("tools/list"), ip("203.0.113.77"))).status, 200);
    assert.equal((await s.post("/mcp", rpc("tools/list"), ip("203.0.113.77"))).status, 200);
    const third = await s.post("/mcp", "{\"not json", ip("203.0.113.77"));
    assert.equal(third.status, 429, "refused before the malformed body was parsed");
    assert.equal((await third.json()).error, "limit_exceeded");
    assert.equal((await s.post("/mcp", rpc("tools/list"), ip("198.51.100.9"))).status, 200, "another address is not affected");
    const all = JSON.stringify(s.logs);
    assert.doesNotMatch(all, /203\.0\.113\.77|198\.51\.100\.9/);
  } finally { await s.close(); }
});

test("⛔ the anonymous body cap is 512 KB — a résumé and a posting, not a 15 MB upload", async () => {
  const s = await serve();
  try {
    const r = await s.post("/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "score_ats_fit", arguments: { job: JOB, resumeText: "x".repeat(600 * 1024) } } }));
    assert.equal(r.status, 413);
  } finally { await s.close(); }
});

test("RM_FREE_LIMITS_PER_DAY caps a token client's FREE calls — /v1 and MCP alike — and leaves the model budget alone", async () => {
  assert.throws(() => parseFreeLimits("acme=lots"), /RM_FREE_LIMITS_PER_DAY/);
  const { token, entry } = mintToken("acme");
  const s = await serve({ policy: null, clients: parseClientTokens(entry), freeLimits: parseFreeLimits("acme=2") });
  const auth = { authorization: `Bearer ${token}` };
  try {
    const body = JSON.stringify({ job: JOB, resumeText: "Python" });
    assert.equal((await s.post("/v1/ats/score", body, auth)).status, 200);
    assert.equal((await s.post("/v1/ats/score", body, auth)).status, 200);
    const third = await s.post("/v1/ats/score", body, auth);
    assert.equal(third.status, 429);
    assert.equal((await third.json()).error, "limit_exceeded");
    const tool = await (await s.post("/mcp", rpc("tools/call", { name: "score_ats_fit", arguments: { job: JOB, resumeText: "Python" } }), auth)).json();
    assert.equal(tool.result.isError, true);
    assert.match(tool.result.content[0].text, /limit_exceeded/);
  } finally { await s.close(); }
});

test("⛔ only a FREE tool may be anonymous — the generator refuses any metered MCP tool at all", async () => {
  const components = await buildComponents();
  const saved = MCP_TOOLS[0].endpoint;
  try {
    MCP_TOOLS[0].endpoint = "POST /v1/resumes/generate";
    assert.throws(() => buildMcpTools(components), /is metered/);
  } finally { MCP_TOOLS[0].endpoint = saved; }
  const tools = buildMcpTools(components);
  for (const t of tools) {
    assert.deepEqual(t.securitySchemes, t["x-anonymous"] ? [{ type: "noauth" }] : [], t.name);
    assert.deepEqual(t._meta.securitySchemes, t.securitySchemes);
  }
  assert.deepEqual(tools.filter(t => t["x-anonymous"]).map(t => t.name), ["score_ats_fit"], "D21 ships ATS scoring first, alone");
});
