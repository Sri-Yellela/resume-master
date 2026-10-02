// A57 (owner, 10-02): accounts, a credit ledger and OPT-IN storage — a deliberate reversal of the
// stateless decision, for people on the site only. Real server, real SQLite (:memory:), FAKE model.
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/http/app.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";
import { mintToken, parseClientTokens } from "../src/http/auth.js";
import { openStore } from "../src/store/db.js";
import { ensureMonthlyGrant, balance, refund } from "../src/accounts/credits.js";
import { purgeExpired } from "../src/accounts/artifacts.js";
import { createRateLimiter } from "../src/http/siteRoutes.js";

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

function fake(respond) {
  const calls = { n: 0 };
  return { calls, messages: { create: async () => {
    calls.n++;
    const r = respond();
    if (r instanceof Error) throw r;
    return { content: [{ type: "text", text: r }], usage: { input_tokens: 10, output_tokens: 5 } };
  } } };
}

async function serve({ anthropic = null, store = openStore(":memory:"), env = {}, siteOptions = {} } = {}) {
  const logs = [];
  const { token, entry } = mintToken("draft");
  const app = createApp({ anthropic, version: { version: "test" }, log: e => logs.push(JSON.stringify(e)),
    clients: parseClientTokens(entry), store, env: { RM_ADMIN_EMAILS: "boss@example.org", ...env }, siteOptions });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const call = async (method, path, payload, { web = true, auth = true } = {}) => {
    const r = await fetch(base + path, { method,
      headers: { "content-type": "application/json", ...(web ? { "x-rm-client": "web" } : {}), ...(auth && cookie ? { cookie } : {}) },
      body: payload === undefined ? undefined : JSON.stringify(payload) });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return r;
  };
  const tokenPost = (path, payload) => fetch(base + path, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
  return { base, call, tokenPost, store, logs, getCookie: () => cookie, setCookie: c => { cookie = c; },
           close: () => new Promise(r => server.close(r)) };
}

test("sign up: a session cookie (HttpOnly, SameSite=Lax), the free monthly grant, and cross-site writes refused", async () => {
  const s = await serve();
  try {
    const refused = await s.call("POST", "/v1/site/account/signup", { email: "a@example.org", password: "long enough pw" }, { web: false });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error, "cross_site_refused");

    const r = await fetch(s.base + "/v1/site/account/signup", { method: "POST",
      headers: { "content-type": "application/json", "x-rm-client": "web" },
      body: JSON.stringify({ email: "a@example.org", password: "long enough pw" }) });
    assert.equal(r.status, 201);
    const set = r.headers.get("set-cookie");
    assert.match(set, /rm_session=[A-Za-z0-9_-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+/);
    const j = await r.json();
    assert.equal(j.user.email, "a@example.org");
    assert.equal(j.balance, 10, "the free monthly grant");
    assert.equal(s.store.prepare("SELECT COUNT(*) FROM sessions").pluck().get(), 1);
    assert.notEqual(s.store.prepare("SELECT sid_hash FROM sessions").pluck().get(), set.split(";")[0].split("=")[1],
      "only the session's hash is stored");
    assert.match(s.store.prepare("SELECT password_hash FROM users").pluck().get(), /^scrypt\$/);

    assert.equal((await s.call("POST", "/v1/site/account/signup", { email: "A@example.org", password: "long enough pw" })).status, 409);
    assert.equal((await s.call("POST", "/v1/site/account/signup", { email: "b@example.org", password: "short" })).status, 400);
  } finally { await s.close(); }
});

test("sign in says the same thing for an unknown email and a wrong password; sign out ends the session", async () => {
  const s = await serve();
  try {
    await s.call("POST", "/v1/site/account/signup", { email: "a@example.org", password: "long enough pw" });
    await s.call("POST", "/v1/site/account/signout", {});
    assert.equal((await s.call("GET", "/v1/site/account")).status, 401);
    const wrong = await (await s.call("POST", "/v1/site/account/signin", { email: "a@example.org", password: "not the password" })).json();
    const nobody = await (await s.call("POST", "/v1/site/account/signin", { email: "zz@example.org", password: "not the password" })).json();
    assert.equal(wrong.message, nobody.message);
    assert.equal((await s.call("POST", "/v1/site/account/signin", { email: "a@example.org", password: "long enough pw" })).status, 200);
    assert.equal((await s.call("GET", "/v1/site/account")).status, 200);
  } finally { await s.close(); }
});

test("⛔ debit on SUCCESS: a generation costs one credit and records route + tokens; a failure costs nothing", async () => {
  let reply = honest;
  const model = fake(() => reply);
  const s = await serve({ anthropic: model });
  try {
    await s.call("POST", "/v1/site/account/signup", { email: "a@example.org", password: "long enough pw" });
    const ok = await s.call("POST", "/v1/site/tools/generate", genBody);
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.match(j.html, /JANE DOE/);
    assert.deepEqual(j.credits, { charged: 1, balance: 9 });
    const debit = s.store.prepare("SELECT * FROM credit_ledger WHERE reason='debit'").get();
    assert.equal(debit.route, "resumes.generate");
    assert.equal(debit.delta, -1);
    assert.ok(debit.input_tokens > 0 && debit.output_tokens > 0, "what it cost in tokens is recorded");

    reply = honest.replace("with 4 years", "with 9 years");             // the claim guard withholds it
    const withheld = await s.call("POST", "/v1/site/tools/generate", genBody);
    assert.equal(withheld.status, 422);
    reply = Object.assign(new Error("credit balance is too low"), { status: 400 });
    const failed = await s.call("POST", "/v1/site/tools/generate", genBody);
    assert.ok(failed.status >= 500);
    assert.equal(balance(s.store, 1), 9, "neither the withheld document nor the upstream failure cost a credit");
    assert.equal(s.store.prepare("SELECT COUNT(*) FROM credit_ledger WHERE reason='debit'").pluck().get(), 1);
  } finally { await s.close(); }
});

test("no credits: refused with the numbers BEFORE the model is called", async () => {
  const model = fake(() => honest);
  const s = await serve({ anthropic: model, env: { RM_MONTHLY_GRANT: "0" } });
  try {
    await s.call("POST", "/v1/site/account/signup", { email: "a@example.org", password: "long enough pw" });
    const r = await s.call("POST", "/v1/site/tools/generate", genBody);
    assert.equal(r.status, 402);
    const j = await r.json();
    assert.equal(j.error, "insufficient_credits");
    assert.deepEqual([j.balance, j.cost], [0, 1]);
    assert.match(j.message, /nothing is sold yet/);
    assert.equal(model.calls.n, 0, "nothing was spent");
    assert.equal((await s.call("POST", "/v1/site/tools/generate", genBody, { auth: false })).status, 401, "signed out: sign in first");
  } finally { await s.close(); }
});

test("ATS and format are FREE and ANONYMOUS — no account, no credit, no store — bounded by a per-IP rate", async () => {
  const s = await serve({ siteOptions: { publicLimiter: createRateLimiter({ perMinute: 2 }) } });
  try {
    const ats = { job: { title: "Backend Engineer", description: "Go, PostgreSQL, Kubernetes, gRPC. Build services." },
                  resumeText: "Backend engineer. Go, PostgreSQL, Kubernetes. Built services." };
    const r = await s.call("POST", "/v1/site/tools/ats", ats, { auth: false });
    assert.equal(r.status, 200);
    assert.ok(["scored", "not_enough_signal"].includes((await r.json()).outcome));
    assert.equal((await s.call("POST", "/v1/site/tools/format", { html: honest }, { auth: false })).status, 200);
    const limited = await s.call("POST", "/v1/site/tools/ats", ats, { auth: false });
    assert.equal(limited.status, 429);
    assert.equal(s.store.prepare("SELECT COUNT(*) FROM credit_ledger").pluck().get(), 0);
    assert.equal(s.store.prepare("SELECT COUNT(*) FROM artifacts").pluck().get(), 0);
  } finally { await s.close(); }
});

test("opt-in storage: kept only with store:true, listed, read back, and a delete deletes", async () => {
  const s = await serve();
  try {
    await s.call("POST", "/v1/site/account/signup", { email: "a@example.org", password: "long enough pw" });
    await s.call("POST", "/v1/site/tools/format", { html: honest });
    assert.equal(s.store.prepare("SELECT COUNT(*) FROM artifacts").pluck().get(), 0, "not asked, not kept");
    const kept = await (await s.call("POST", "/v1/site/tools/format", { html: honest, store: true, title: "Mine" })).json();
    assert.equal(kept.saved.stored, true);
    const list = await (await s.call("GET", "/v1/site/documents")).json();
    assert.equal(list.documents.length, 1);
    assert.equal(list.documents[0].title, "Mine");
    assert.equal(list.retentionDays, 90);
    const doc = await (await s.call("GET", `/v1/site/documents/${kept.saved.id}`)).json();
    assert.match(doc.content, /JANE DOE/);
    assert.equal((await s.call("DELETE", `/v1/site/documents/${kept.saved.id}`)).status, 200);
    assert.equal(s.store.prepare("SELECT COUNT(*) FROM artifacts").pluck().get(), 0);
    assert.equal(s.store.pragma("secure_delete", { simple: true }), 1, "freed pages are zeroed, not merely unlinked");

    // Anonymous store:true keeps nothing and says why.
    s.setCookie("");
    const anon = await (await s.call("POST", "/v1/site/tools/format", { html: honest, store: true })).json();
    assert.deepEqual(anon.saved, { stored: false, reason: "signed_out" });

    // Expiry.
    s.store.prepare("INSERT INTO artifacts (user_id, kind, content, bytes, expires_at) VALUES (1, 'pdf_text', 'x', 1, unixepoch() - 1)").run();
    assert.equal(purgeExpired(s.store), 1);
  } finally { await s.close(); }
});

test("the monthly grant is once a month; a refund is once a debit; an admin grant needs an admin", async () => {
  const s = await serve({ anthropic: fake(() => honest) });
  try {
    await s.call("POST", "/v1/site/account/signup", { email: "a@example.org", password: "long enough pw" });
    assert.equal(ensureMonthlyGrant(s.store, 1), false, "already granted this month");
    assert.equal(ensureMonthlyGrant(s.store, 1, { when: new Date(Date.now() + 40 * 86400000) }), true, "next month's");
    await s.call("POST", "/v1/site/tools/generate", genBody);
    const debitId = s.store.prepare("SELECT id FROM credit_ledger WHERE reason='debit'").pluck().get();
    assert.equal(refund(s.store, debitId).ok, true);
    assert.equal(refund(s.store, debitId).code, "already_refunded");
    assert.equal((await s.call("POST", "/v1/site/admin/credits/grant", { email: "a@example.org", amount: 5 })).status, 403);
    await s.call("POST", "/v1/site/account/signup", { email: "boss@example.org", password: "long enough pw" });
    const g = await s.call("POST", "/v1/site/admin/credits/grant", { email: "a@example.org", amount: 5 });
    assert.equal(g.status, 200);
  } finally { await s.close(); }
});

test("password reset: 503 until email is configured; then a one-time link that ends every session", async () => {
  const s1 = await serve();
  try {
    const r = await s1.call("POST", "/v1/site/account/password-reset", { email: "a@example.org" });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, "email_unconfigured");
  } finally { await s1.close(); }

  const sent = [];
  const s = await serve({ env: { RESEND_API_KEY: "re_test", EMAIL_FROM: "Resume Master <no-reply@example.org>" },
                          siteOptions: { sendEmail: async (m) => { sent.push(m); return { ok: true }; } } });
  try {
    await s.call("POST", "/v1/site/account/signup", { email: "a@example.org", password: "long enough pw" });
    const unknown = await (await s.call("POST", "/v1/site/account/password-reset", { email: "zz@example.org" })).json();
    const known = await (await s.call("POST", "/v1/site/account/password-reset", { email: "a@example.org" })).json();
    assert.equal(unknown.message, known.message, "the answer does not reveal which emails have accounts");
    assert.equal(sent.length, 1);
    const token = sent[0].resetUrl.split("#reset=")[1];
    assert.equal((await s.call("POST", "/v1/site/account/password-reset/confirm", { token, password: "a brand new pw" })).status, 200);
    assert.equal(s.store.prepare("SELECT COUNT(*) FROM sessions").pluck().get(), 0, "every session ended");
    assert.equal((await s.call("POST", "/v1/site/account/password-reset/confirm", { token, password: "again new pw" })).status, 400, "once");
    assert.equal((await s.call("POST", "/v1/site/account/signin", { email: "a@example.org", password: "a brand new pw" })).status, 200);
    assert.ok(!s.logs.some(l => l.includes(token)), "the link is never logged");
  } finally { await s.close(); }
});

test("export holds everything; delete removes the account, its ledger and its documents", async () => {
  const s = await serve();
  try {
    await s.call("POST", "/v1/site/account/signup", { email: "a@example.org", password: "long enough pw" });
    await s.call("POST", "/v1/site/tools/format", { html: honest, store: true });
    const exp = await (await s.call("GET", "/v1/site/account/export")).json();
    assert.equal(exp.user.email, "a@example.org");
    assert.equal(exp.artifacts.length, 1);
    assert.equal(exp.ledger.length, 1);
    assert.equal((await s.call("DELETE", "/v1/site/account", { password: "wrong one here" })).status, 401);
    assert.equal((await s.call("DELETE", "/v1/site/account", { password: "long enough pw" })).status, 200);
    for (const t of ["users", "sessions", "credit_ledger", "artifacts"]) {
      assert.equal(s.store.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get(), 0, `${t} emptied`);
    }
  } finally { await s.close(); }
});

test("⛔ the token API stays stateless: a service-token call leaves the store exactly as it found it; no credits for draft", async () => {
  const s = await serve({ anthropic: fake(() => honest) });
  try {
    const counts = () => ["users", "sessions", "credit_ledger", "artifacts"].map(t => s.store.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get());
    const before = counts();
    assert.equal((await s.tokenPost("/v1/ats/score", { job: { title: "x", description: "Go" }, resumeText: "Go" })).status, 200);
    assert.equal((await s.tokenPost("/v1/resumes/generate", { ...genBody, store: true })).status, 200, "draft is exempt from credits");
    assert.deepEqual(counts(), before);
  } finally { await s.close(); }
});

test("without a store, the site's account routes say so (503) and the free tools still work", async () => {
  const s = await serve({ store: null });
  try {
    const r = await s.call("POST", "/v1/site/account/signup", { email: "a@example.org", password: "long enough pw" });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, "accounts_unconfigured");
    const cfg = await (await s.call("GET", "/v1/site/config")).json();
    assert.equal(cfg.accounts, false);
    assert.equal((await s.call("POST", "/v1/site/tools/format", { html: honest })).status, 200);
  } finally { await s.close(); }
});
