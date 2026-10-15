// A97 (owner, 10-14): the model-spend ledger. ~$7 left the account with no record the service kept;
// every model call now writes one counts-only row to model_usage. Real server, real SQLite
// (:memory:), FAKE model — no test here calls Anthropic.
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/http/app.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";
import { mintToken, parseClientTokens } from "../src/http/auth.js";
import { createMetering } from "../src/http/metering.js";
import { openStore } from "../src/store/db.js";
import { createModelUsageLedger, modelUsageSummary } from "../src/accounts/modelUsage.js";
import { costOf, keyFingerprint, PRICES } from "../src/model/prices.js";
import { MODEL_SONNET, MODEL_HAIKU } from "../src/model/anthropicCall.js";
import { classify } from "../src/generation/classifier.js";

loadAllPrompts();

const BASE = `JANE DOE 555-000-1111 jane@example.org
SUMMARY
Software Engineer with 4 years building distributed systems.
EXPERIENCE
Stripe — Software Engineer`;
const honest = `<html><body><div class="header"><div class="name">JANE DOE</div></div>
<div class="section-title">SUMMARY</div><p>Software Engineer with 4 years building distributed systems.</p>
<div class="section-title">EXPERIENCE</div><div class="entry"><div class="entry-org">Stripe</div><ul class="bullets"><li>Built services</li></ul></div></body></html>`;
const genBody = { mode: "GENERATE", domainModuleKey: "engineering", baseResumeText: BASE,
  candidate: { fullName: "Jane Doe", yearsOfExperience: 4 },
  job: { title: "Backend Engineer", company: "Acme", description: "Build services." } };

const USAGE = { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 200, cache_read_input_tokens: 100 };
function fake(respond) {
  return { messages: { create: async () => {
    const r = respond();
    if (r instanceof Error) throw r;
    return { content: [{ type: "text", text: r }], usage: USAGE };
  } } };
}

async function serve({ anthropic, ledgerOverride } = {}) {
  const logs = [];
  const store = openStore(":memory:");
  const log = e => logs.push(JSON.stringify(e));
  const ledger = ledgerOverride ?? createModelUsageLedger(store, { keyLabel: "tools-test", keyFp: keyFingerprint("sk-test") });
  const { token, entry } = mintToken("draft");
  const app = createApp({ anthropic, version: { version: "test" }, log, clients: parseClientTokens(entry), store,
    metering: createMetering({ log, ledger }) });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokenPost = (path, payload) => fetch(base + path, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
  return { store, logs, tokenPost, rows: () => store.prepare("SELECT * FROM model_usage ORDER BY id").all(),
           close: () => new Promise(r => server.close(r)) };
}

test("migration 005 creates model_usage", () => {
  const db = openStore(":memory:");
  assert.ok(db.prepare("SELECT id FROM schema_migrations").pluck().all().includes("005_model_usage"));
  const cols = db.prepare("PRAGMA table_info(model_usage)").all().map(c => c.name);
  for (const c of ["client", "route", "model", "success", "input_tokens", "cost_usd", "key_label", "key_fp"]) assert.ok(cols.includes(c), c);
});

test("⛔ the ledger has no column that could hold content or a person", () => {
  const cols = openStore(":memory:").prepare("PRAGMA table_info(model_usage)").all().map(c => c.name);
  for (const c of cols) assert.doesNotMatch(c, /user|email|name|text|body|prompt|resume|job|message|content|ip/i, c);
});

test("costOf prices the four token kinds at the per-token rates; an unpriced model is null, not $0", () => {
  const c = costOf({ model: MODEL_SONNET, ...USAGE });
  assert.ok(Math.abs(c - (1000 * 2e-6 + 500 * 10e-6 + 200 * 2.5e-6 + 100 * 0.2e-6)) < 1e-12);
  assert.ok(Math.abs(costOf({ model: MODEL_HAIKU, input_tokens: 1e6 }) - 1) < 1e-9, "Haiku input is $1 per MTok");
  assert.equal(costOf({ model: "claude-unknown", input_tokens: 5 }), null);
  assert.deepEqual(Object.keys(PRICES).sort(), [MODEL_HAIKU, MODEL_SONNET].sort(),
    "every model this service calls has a price — add one with the model");
});

test("keyFingerprint is 8 hex, stable, and holds no part of the key", () => {
  const fp = keyFingerprint("sk-ant-api03-abcdefgh");
  assert.match(fp, /^[0-9a-f]{8}$/);
  assert.equal(fp, keyFingerprint("sk-ant-api03-abcdefgh"));
  assert.notEqual(fp, keyFingerprint("sk-ant-api03-abcdefgi"));
  assert.equal(keyFingerprint(""), null);
});

test("a token-API generation writes one row per model call: client, route, model, price and key — and no content", async () => {
  const s = await serve({ anthropic: fake(() => honest) });
  try {
    assert.equal((await s.tokenPost("/v1/resumes/generate", genBody)).status, 200);
    const rows = s.rows();
    assert.equal(rows.length, 1, "domainModuleKey given: the one Sonnet call, no classifier");
    const [r] = rows;
    assert.equal(r.client, "draft");
    assert.equal(r.route, "resumes.generate");
    assert.equal(r.purpose, "resume_generate");
    assert.equal(r.model, MODEL_SONNET);
    assert.equal(r.success, 1);
    assert.equal(r.input_tokens, 1000);
    assert.equal(r.cache_creation_input_tokens, 200);
    assert.ok(Math.abs(r.cost_usd - costOf({ model: MODEL_SONNET, ...USAGE })) < 1e-12);
    assert.equal(r.key_label, "tools-test");
    assert.equal(r.key_fp, keyFingerprint("sk-test"));
    assert.doesNotMatch(JSON.stringify(rows), /JANE|jane@|555-000|Stripe|Acme|Backend/i);
  } finally { await s.close(); }
});

test("without a domain the classifier's Haiku call is a second row", async () => {
  let n = 0;
  const s = await serve({ anthropic: fake(() => (n++ === 0
    ? JSON.stringify({ roleFamily: "engineering", domain: "it_digital" }) : honest)) });
  try {
    const { domainModuleKey, ...noDomain } = genBody;
    assert.equal((await s.tokenPost("/v1/resumes/generate", noDomain)).status, 200);
    assert.deepEqual(s.rows().map(r => [r.purpose, r.model]), [["classifier", MODEL_HAIKU], ["resume_generate", MODEL_SONNET]]);
  } finally { await s.close(); }
});

test("a failed model call is a row too (success 0) — a failure can have spent", async () => {
  const s = await serve({ anthropic: fake(() => Object.assign(new Error("overloaded"), { status: 529 })) });
  try {
    assert.equal((await s.tokenPost("/v1/resumes/generate", genBody)).status, 502);
    const rows = s.rows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].success, 0);
  } finally { await s.close(); }
});

test("a route that calls no model writes nothing", async () => {
  const s = await serve({ anthropic: fake(() => honest) });
  try {
    assert.equal((await s.tokenPost("/v1/ats/score", { job: { title: "x", description: "Go" }, resumeText: "Go" })).status, 200);
    assert.equal(s.rows().length, 0);
  } finally { await s.close(); }
});

test("⛔ a ledger that throws does not fail the request; the error is logged by name only", async () => {
  const s = await serve({ anthropic: fake(() => honest), ledgerOverride: () => { throw Object.assign(new Error("disk full"), { code: "SQLITE_FULL" }); } });
  try {
    assert.equal((await s.tokenPost("/v1/resumes/generate", genBody)).status, 200);
    assert.ok(s.logs.some(l => l.includes('"metering_ledger_error":"SQLITE_FULL"')));
  } finally { await s.close(); }
});

test("no store, no ledger", () => {
  assert.equal(createModelUsageLedger(null), null);
});

test("the classifier's PAID call is metered even when its reply does not parse", async () => {
  await assert.rejects(classify(fake(() => "not json"), BASE, "Build services."), (e) => {
    assert.equal(e.usage?.purpose, "classifier");
    assert.equal(e.usage?.input_tokens, 1000);
    return true;
  });
});

test("the summary groups by day, client, route, model and key", () => {
  const db = openStore(":memory:");
  const ledger = createModelUsageLedger(db, { keyLabel: "k", keyFp: "abcd1234" });
  const u = { purpose: "resume_generate", model: MODEL_SONNET, success: true, ...USAGE };
  ledger("draft", "resumes.generate", [u, u]);
  ledger("draft", "resumes.generate", [{ ...u, model: "claude-unknown" }]);
  const rows = modelUsageSummary(db);
  const priced = rows.find(r => r.model === MODEL_SONNET);
  assert.equal(priced.calls, 2);
  assert.equal(priced.key_label, "k");
  assert.equal(rows.find(r => r.model === "claude-unknown").unpriced, 1);
});
