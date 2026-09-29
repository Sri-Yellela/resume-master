// A3 — the contract, checked against the implementation it claims to describe.
//
// ⚠ In-process, model-backed scenarios use a fake model client (the body SHAPES are produced by the
// real handlers; the model TEXT is canned). The same scenarios run live against a deployed service
// with scripts/verifyContract.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createApp } from "../src/http/app.js";
import { mintToken, parseClientTokens } from "../src/http/auth.js";
import { createMetering } from "../src/http/metering.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";
import { buildOpenApi } from "../src/contract/build.js";
import { ENDPOINTS, CONTRACT_VERSION } from "../src/contract/endpoints.js";
import { SCENARIOS, checkResponse, uncovered, requestFor, headersFor } from "../src/contract/harness.js";
import { staleFiles } from "../scripts/generateContract.mjs";

loadAllPrompts();
const doc = await buildOpenApi();
const components = doc.components.schemas;

async function run(scenario) {
  const { token, entry } = mintToken("draft");
  let reply = scenario.model;
  const anthropic = reply === "none" ? null : { messages: { create: async () => {
    const r = typeof reply === "function" ? reply() : reply;
    if (r instanceof Error) throw r;
    return { content: [{ type: "text", text: r ?? "" }], usage: { input_tokens: 10, output_tokens: 5 } };
  } } };
  const metering = createMetering({ log: () => {} });
  const app = createApp({
    anthropic, log: () => {}, env: {}, version: { version: "0.1.0", commit: null, scorer: "@draft/ats-scorer@1.0.0", llmFormat: false },
    clients: scenario.service === "no-clients" ? null : parseClientTokens(entry),
    metering: scenario.service === "refuse-limits" ? { ...metering, allow: () => false } : metering,
  });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const { method, path, body } = requestFor(scenario);
    const headers = headersFor(scenario, token);
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers, body });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, contentType: res.headers.get("content-type"), body: parsed };
  } finally { await new Promise(r => server.close(r)); }
}

const inProcess = SCENARIOS.filter(s => s.inProcess !== false);

for (const scenario of inProcess) {
  test(`envelope: ${scenario.name}`, async () => {
    const response = await run(scenario);
    assert.deepEqual(checkResponse(scenario, response, components), [],
      `real response does not match the contract: ${JSON.stringify(response.body).slice(0, 300)}`);
  });
}

test("⛔ every declared (route, status) is exercised by at least one in-process scenario", () => {
  assert.deepEqual(uncovered(inProcess), [], "a declared response nothing checks is a declaration on trust");
});

test("⛔ contract/ is current — a shape change without regeneration fails here", async () => {
  assert.deepEqual(await staleFiles(), [], "run `node scripts/generateContract.mjs`");
});

test("⛔ the committed shape hash is the one recorded for CONTRACT_VERSION", () => {
  const versions = JSON.parse(fs.readFileSync("contract/VERSIONS.json", "utf8"));
  const checksums = JSON.parse(fs.readFileSync("contract/CHECKSUMS.json", "utf8"));
  assert.equal(checksums.contractVersion, CONTRACT_VERSION);
  assert.equal(versions[CONTRACT_VERSION], checksums.shapeHash,
    "the shape changed under a version number a consumer may already hold — bump CONTRACT_VERSION");
});

test("the route table and the app agree — no undocumented route, no documented ghost", () => {
  const app = createApp({ log: () => {} });
  const routes = app._router.stack.filter(l => l.route)
    .flatMap(l => Object.keys(l.route.methods).map(m => `${m} ${l.route.path}`)).sort();
  const declared = ENDPOINTS.map(e => `${e.method} ${e.path}`).sort();
  assert.deepEqual(routes, declared);
});

test("model-backed scenarios that need a real model are marked metered and live-only", () => {
  for (const s of SCENARIOS.filter(s => s.metered)) {
    assert.equal(s.inProcess, false, `${s.name}: a metered scenario must not run in npm test`);
    assert.equal(s.live, true, s.name);
  }
});
