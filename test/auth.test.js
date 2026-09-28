// Per-client service tokens and per-client accounting. Real runs — no model involved.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createApp } from "../src/http/app.js";
import { mintToken, parseClientTokens, authenticate, hashToken } from "../src/http/auth.js";
import { createMetering } from "../src/http/metering.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";

loadAllPrompts();

async function serve({ clients, anthropic = null, log } = {}) {
  const logs = [];
  const app = createApp({ anthropic, clients, log: log || (e => logs.push(e)), version: { version: "t" } });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, token) => fetch(base + path, { method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body) });
  return { base, post, logs, close: () => new Promise(r => server.close(r)) };
}

const FORMAT = ["/v1/resumes/format", { html: "JANE DOE\nSUMMARY\nBuilt things." }];

test("the environment holds a HASH; the token itself is never stored", () => {
  const { token, entry } = mintToken("draft");
  assert.match(token, /^rmk_draft\.[A-Za-z0-9_-]{43}$/);
  assert.equal(entry, `draft:${hashToken(token)}`);
  assert.ok(!entry.includes(token.split(".")[1]), "the entry must not contain the secret");
});

test("a valid token authenticates as its OWN client, and only that one", () => {
  const draft = mintToken("draft"), acme = mintToken("acme");
  const clients = parseClientTokens(`${draft.entry},${acme.entry}`);
  assert.equal(authenticate(clients, `Bearer ${draft.token}`), "draft");
  assert.equal(authenticate(clients, `Bearer ${acme.token}`), "acme");
  // A token whose client-id prefix is edited does not become the other client.
  assert.equal(authenticate(clients, `Bearer ${draft.token.replace("rmk_draft.", "rmk_acme.")}`), null);
  // The tampered token must DIFFER: replacing the last character with a fixed "A" was a no-op for
  // the 1-in-64 tokens already ending in "A", and this test failed intermittently until it said so.
  const last = draft.token.slice(-1);
  const tampered = draft.token.slice(0, -1) + (last === "A" ? "B" : "A");
  assert.notEqual(tampered, draft.token);
  for (const bad of [undefined, "", "Bearer", `Basic ${draft.token}`, `Bearer ${draft.token}x`, `bearer ${draft.token}`,
                     `Bearer ${tampered}`]) {
    assert.equal(authenticate(clients, bad), null, String(bad));
  }
});

test("⛔ unauthenticated requests are refused before the body is even parsed", async () => {
  const { entry } = mintToken("draft");
  const s = await serve({ clients: parseClientTokens(entry) });
  try {
    const none = await s.post(...FORMAT);
    assert.equal(none.status, 401);
    assert.deepEqual(await none.json(), { error: "unauthenticated", retryable: false });
    // A malformed AND oversized body still gets 401, not 400/413 — auth runs first.
    const r = await fetch(s.base + "/v1/resumes/generate", { method: "POST",
      headers: { "content-type": "application/json" }, body: "{" + "x".repeat(16 * 1024 * 1024) });
    assert.equal(r.status, 401);
  } finally { await s.close(); }
});

test("every /v1 route requires a token except /v1/version; /health is open", async () => {
  const { entry } = mintToken("draft");
  const s = await serve({ clients: parseClientTokens(entry) });
  try {
    for (const p of ["/v1/resumes/format", "/v1/ats/score", "/v1/resumes/generate", "/v1/resumes/enhance", "/v1/resumes/parse-pdf"]) {
      assert.equal((await s.post(p, {})).status, 401, p);
    }
    assert.equal((await (await fetch(s.base + "/v1/version")).json()).service, "resume-master");
    assert.equal((await (await fetch(s.base + "/health")).json()).ok, true);
  } finally { await s.close(); }
});

test("⛔ REVOKE: remove the entry and the token stops working; ROTATE: two hashes overlap", async () => {
  const oldT = mintToken("draft"), newT = mintToken("draft");
  // rotation window: both valid
  let s = await serve({ clients: parseClientTokens(`${oldT.entry},${newT.entry}`) });
  try {
    assert.equal((await s.post(...FORMAT, oldT.token)).status, 200);
    assert.equal((await s.post(...FORMAT, newT.token)).status, 200);
  } finally { await s.close(); }
  // old entry deleted, service restarted
  s = await serve({ clients: parseClientTokens(newT.entry) });
  try {
    assert.equal((await s.post(...FORMAT, oldT.token)).status, 401, "a revoked token must stop working");
    assert.equal((await s.post(...FORMAT, newT.token)).status, 200);
  } finally { await s.close(); }
});

test("⛔ no clients configured FAILS CLOSED, and says why", async () => {
  for (const clients of [null, parseClientTokens("")]) {
    const s = await serve({ clients });
    try {
      const r = await s.post(...FORMAT, "rmk_draft." + "A".repeat(43));
      assert.equal(r.status, 503);
      assert.equal((await r.json()).error, "auth_unconfigured");
    } finally { await s.close(); }
  }
});

test("a malformed token list refuses to boot rather than silently dropping a client", () => {
  assert.throws(() => parseClientTokens("draft:nothex"), /malformed entry/);
  assert.throws(() => parseClientTokens(`Draft:${"a".repeat(64)}`), /malformed entry/);
  assert.throws(() => parseClientTokens(`draft:${"a".repeat(63)}`), /malformed entry/);
  assert.equal(parseClientTokens(` draft:${"a".repeat(64)} , acme:${"b".repeat(64)} `).size, 2);
});

test("per-client accounting: one metering line per model request, counts only, keyed by client", async () => {
  const { token, entry } = mintToken("draft");
  const anthropic = { messages: { create: async () => ({ content: [{ type: "text", text: "Jane Doe\nSUMMARY\nx" }],
    usage: { input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 6704, cache_read_input_tokens: 0 } }) } };
  const s = await serve({ clients: parseClientTokens(entry), anthropic });
  try {
    await s.post("/v1/resumes/enhance", { resumeText: "SECRET-RESUME-BODY 555-867-5309" }, token);
    const m = s.logs.filter(l => l.metering);
    assert.equal(m.length, 1);
    assert.deepEqual(m[0], { metering: true, client: "draft", route: "resumes.enhance", calls: 1, failed_calls: 0,
      input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 6704, cache_read_input_tokens: 0 });
    const req = s.logs.find(l => l.path === "/v1/resumes/enhance");
    assert.equal(req.client, "draft", "the request log names the client");
    assert.ok(!JSON.stringify(s.logs).includes("SECRET-RESUME-BODY"), "content reached a log line");
    assert.ok(!JSON.stringify(s.logs).includes(token.split(".")[1]), "the token reached a log line");
  } finally { await s.close(); }
});

test("a FAILED model call is metered too — it can still have spent", async () => {
  const { token, entry } = mintToken("draft");
  const anthropic = { messages: { create: async () => { throw Object.assign(new Error("overloaded_error"), { status: 529 }); } } };
  const s = await serve({ clients: parseClientTokens(entry), anthropic });
  try {
    await s.post("/v1/resumes/enhance", { resumeText: "x" }, token);
    const m = s.logs.find(l => l.metering);
    assert.equal(m.client, "draft");
    assert.equal(m.failed_calls, 1);
  } finally { await s.close(); }
});

test("⛔ limits are OFF — the hook exists on every model route and allows everything", async () => {
  const metering = createMetering({ log: () => {} });
  assert.equal(metering.limitsEnabled, false);
  for (let i = 0; i < 1000; i++) assert.equal(metering.allow("draft", "resumes.generate"), true);
  // the hook is actually consulted: a policy that refuses produces 429 on a model route, before spend
  const { token, entry } = mintToken("draft");
  let spent = 0;
  const anthropic = { messages: { create: async () => { spent++; return { content: [], usage: {} }; } } };
  const app = createApp({ anthropic, clients: parseClientTokens(entry), log: () => {},
    metering: { ...metering, allow: () => false } });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/v1/resumes/enhance`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ resumeText: "x" }) });
    assert.equal(r.status, 429);
    assert.equal(spent, 0, "a refused request must not reach the model");
  } finally { await new Promise(r => server.close(r)); }
});

test("the mint script's output format matches what the parser accepts", () => {
  const src = fs.readFileSync("scripts/mintClientToken.mjs", "utf8");
  assert.match(src, /mintToken\(clientId\)/);
  const { entry } = mintToken("draft");
  assert.equal(parseClientTokens(entry).size, 1);
});
