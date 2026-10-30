// T19 hardening (draft's G1, 10-30) — the workspace header and the key check. 10-15: a key created outside a workspace
// was refused on every request, and this service said nothing until a user's generation failed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createAnthropicClient, workspaceHeaderFor, isPermanentModelFailure } from "../src/model/anthropicCall.js";
import { checkModelKey, safeReason } from "../src/model/keyCheck.js";

const NOT_SCOPED = Object.assign(new Error("400 This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use."), { status: 400 });

test("T19: the client sends anthropic-workspace-id when ANTHROPIC_WORKSPACE_ID is set, and not when it is not", () => {
  const seen = [];
  class Sdk { constructor(o) { seen.push(o); } }
  createAnthropicClient({ apiKey: "k", workspaceId: "wrkspc_01AbC", Sdk });
  createAnthropicClient({ apiKey: "k", Sdk });
  createAnthropicClient({ apiKey: "k", workspaceId: "x\r\nX-Inject: 1", Sdk });
  assert.deepEqual(seen[0].defaultHeaders, { "anthropic-workspace-id": "wrkspc_01AbC" });
  assert.equal("defaultHeaders" in seen[1], false);
  assert.equal("defaultHeaders" in seen[2], false, "a malformed id is never sent as a header");
  assert.equal(workspaceHeaderFor(""), null);
});

test("T19: the key check — ok, failed with Anthropic's reason, unreachable for the network", async () => {
  const fake = (impl) => ({ models: { list: impl } });
  assert.equal((await checkModelKey(fake(async () => ({ data: [] })))).state, "ok");
  const failed = await checkModelKey(fake(async () => { throw NOT_SCOPED; }));
  assert.equal(failed.state, "failed");
  assert.match(failed.reason, /not scoped to a workspace/);
  assert.equal((await checkModelKey(fake(async () => { throw Object.assign(new Error("overloaded"), { status: 529 }); }))).state, "unreachable");
  assert.equal((await checkModelKey(fake(() => new Promise(() => {})), { timeoutMs: 20 })).state, "unreachable");
});

test("T19: the refusal is permanent (never retried), and no key or id is printed", () => {
  assert.equal(isPermanentModelFailure(NOT_SCOPED), true);
  const r = safeReason(new Error("invalid x-api-key sk-ant-api03-SECRETSECRET, workspace wrkspc_01XYZ"));
  assert.doesNotMatch(r, /SECRETSECRET|01XYZ/);
});

test("T19: server.js passes the workspace id, says whether the header is on, and checks the key at boot and daily", () => {
  const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(src, /createAnthropicClient\(\{ apiKey: process\.env\.ANTHROPIC_API_KEY, workspaceId: process\.env\.ANTHROPIC_WORKSPACE_ID \}\)/);
  assert.match(src, /workspaceHeader: !!workspaceHeaderFor\(process\.env\.ANTHROPIC_WORKSPACE_ID\)/);
  assert.match(src, /boot: "model_key_check"/);
  assert.match(src, /setInterval\(\(\) => \{ void runKeyCheck\(\); \}, KEY_CHECK_EVERY_MS\)\.unref\(\)/);
});
