// The consent toggle for form-schema capture (TASK G4 requirement 6).
//
// CONTRACT tests, in the idiom of applyPendingUi.test.js: every endpoint the panel calls must really
// exist and really behave that way, and every state the server can return must be one the panel
// renders honestly. Both sides being individually self-consistent is exactly how a control can end
// up showing "off" for a setting that is actually on.
//
// This one is a permission, so the bar is higher than for a preference: a switch that reads as OFF
// while the server says ON would be telling the user we are not doing something we are doing.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import Database from "better-sqlite3";
import applyRoutes from "../routes/apply.js";
import { MIGRATIONS } from "../scripts/migrations.js";

const panel = fs.readFileSync("client/src/panels/IntegrationsPanel.jsx", "utf8");

function setup({ migrate = true } = {}) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE apply_job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, run_job_id INTEGER,
      user_id INTEGER, job_id TEXT, level TEXT DEFAULT 'info', event TEXT, message TEXT,
      details_json TEXT, created_at INTEGER DEFAULT (unixepoch()));
    INSERT INTO users (id, username) VALUES (1, 'ada');
    INSERT INTO users (id, username) VALUES (2, 'grace');
  `);
  if (migrate) db.exec(MIGRATIONS.find(m => m.id === "081_company_form_schemas").sql);

  const app = express();
  app.use(express.json());
  let currentUser = 1;
  app.use((req, _res, next) => { req.user = { id: currentUser }; next(); });
  applyRoutes(app, db, (q, r, n) => n(), () => ({ field_map: {}, handler_map: {}, custom_answers: {} }),
    async () => ({}), async () => Buffer.from("x"), async () => ({}));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base, asUser: (id) => { currentUser = id; } };
}

const get = (base, p) => fetch(`${base}${p}`).then(async r => ({ status: r.status, body: await r.json() }));
const post = (base, p, b) => fetch(`${base}${p}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}),
}).then(async r => ({ status: r.status, body: await r.json() }));

const FIELDS = [{ name: "q1", label: "How did you hear about us?", type: "textarea", is_required: true }];

// ── The endpoints the panel calls ────────────────────────────────────────────

test("the panel calls endpoints that exist and answer the shape it reads", async () => {
  assert.match(panel, /api\("\/api\/apply\/form-schema\/consent"\)/, "the panel must read the setting");
  assert.match(panel, /api\("\/api\/apply\/form-schema\/consent",\s*\{[\s\S]{0,120}method:\s*"POST"/,
    "the panel must write it");

  const t = setup();
  try {
    const read = await get(t.base, "/api/apply/form-schema/consent");
    assert.equal(read.status, 200);
    assert.equal(typeof read.body.enabled, "boolean", "the panel reads r.enabled as a boolean");

    const write = await post(t.base, "/api/apply/form-schema/consent", { enabled: true });
    assert.equal(write.status, 200);
    assert.equal(write.body.enabled, true, "the panel reconciles against r.enabled from the response");
  } finally { t.server.close(); t.db.close(); }
});

test("IT IS OFF UNTIL SOMEBODY TURNS IT ON", async () => {
  const t = setup();
  try {
    assert.equal((await get(t.base, "/api/apply/form-schema/consent")).body.enabled, false);
    const blocked = await post(t.base, "/api/apply/form-schema", {
      applyUrl: "https://jobs.acme.com/x", fields: FIELDS,
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, "capture_not_enabled");
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM company_form_schemas").get().n, 0);
  } finally { t.server.close(); t.db.close(); }
});

test("turning it on permits capture, and turning it off stops it again", async () => {
  const t = setup();
  try {
    await post(t.base, "/api/apply/form-schema/consent", { enabled: true });
    const ok = await post(t.base, "/api/apply/form-schema", { applyUrl: "https://a.example.com/x", fields: FIELDS });
    assert.equal(ok.status, 200);

    await post(t.base, "/api/apply/form-schema/consent", { enabled: false });
    const off = await post(t.base, "/api/apply/form-schema", { applyUrl: "https://b.example.com/y", fields: FIELDS });
    assert.equal(off.status, 403, "withdrawing consent must take effect immediately");
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM company_form_schemas").get().n, 1,
      "only the host captured while it was on");
  } finally { t.server.close(); t.db.close(); }
});

test("consent is per account", async () => {
  const t = setup();
  try {
    await post(t.base, "/api/apply/form-schema/consent", { enabled: true });
    t.asUser(2);
    assert.equal((await get(t.base, "/api/apply/form-schema/consent")).body.enabled, false,
      "one account opting in must not opt another in");
    const blocked = await post(t.base, "/api/apply/form-schema", { applyUrl: "https://a.example.com/x", fields: FIELDS });
    assert.equal(blocked.status, 403);
  } finally { t.server.close(); t.db.close(); }
});

test("anything other than an explicit true is off", async () => {
  const t = setup();
  try {
    for (const body of [{ enabled: "true" }, { enabled: 1 }, {}, { enabled: null }]) {
      await post(t.base, "/api/apply/form-schema/consent", { enabled: true });
      const r = await post(t.base, "/api/apply/form-schema/consent", body);
      assert.equal(r.body.enabled, false, `${JSON.stringify(body)} must not read as consent`);
    }
  } finally { t.server.close(); t.db.close(); }
});

// ── The states the panel has to render honestly ──────────────────────────────

test("an un-migrated deployment reports unavailable rather than pretending", async () => {
  const t = setup({ migrate: false });
  try {
    const r = await post(t.base, "/api/apply/form-schema/consent", { enabled: true });
    assert.equal(r.status, 503, "it cannot be stored, so it must not report success");
    assert.equal(r.body.error, "consent_unavailable");
  } finally { t.server.close(); t.db.close(); }
});

test("UNKNOWN IS NOT RENDERED AS OFF", () => {
  // "off" and "we could not ask" are different claims. The panel holds null while unknown and says
  // so, rather than drawing a switch in the off position for a setting it has not read.
  assert.match(panel, /const \[capture, setCapture\] = useState\(null\)/);
  assert.match(panel, /checked=\{capture === true\}/,
    "the switch must be on only for an explicit true, not for anything truthy");
  assert.match(panel, /disabled=\{captureBusy \|\| capture === null\}/,
    "an unknown setting must not be togglable");
  assert.match(panel, /Nothing is being sent/, "the unavailable state must say what that means");
});

test("the control is a switch, announced as one", () => {
  // A styled div would look identical and be invisible to a screen reader — for a consent control
  // that is a correctness problem, not a polish one.
  assert.match(panel, /role="switch"/);
  assert.match(panel, /aria-checked=\{!!checked\}/);
  assert.match(panel, /aria-label=\{label\}/);
  assert.match(panel, /<button/, "it must be a real button, so it is keyboard-operable");
});

test("the copy says what is sent and what never is", () => {
  // A switch labelled only "form learning" asks for agreement to something the user cannot evaluate.
  assert.match(panel, /the questions that form asks/i, "it must say what IS sent");
  assert.match(panel, /never send/i);
  assert.match(panel, /your answers/i, "it must say what is NOT sent");
  assert.match(panel, /off unless you turn it on/i, "it must state the default");
  assert.match(panel, /turn it off at any time/i, "consent that cannot be withdrawn is not consent");
});

test("the panel reconciles against the server rather than trusting its own optimism", () => {
  // The switch flips immediately for responsiveness, but what it settles on is what the server said.
  assert.match(panel, /setCapture\(!!r\.enabled\)/);
  assert.match(panel, /catch[\s\S]{0,200}await loadCapture\(\)/,
    "a failed write must re-read the real state, not leave the optimistic one on screen");
});
