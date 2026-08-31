/**
 * The plumbing AF1 needs to actually work: the migration that stores overrides, the profile
 * endpoint that saves them without eating the ones already there, and the settings surface that
 * lets the candidate edit them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import Database from "better-sqlite3";
import { createAccountRouter } from "../routes/account.js";
import { MIGRATIONS } from "../scripts/migrations.js";
import { at } from "../test-support/sourceAnchors.js";

const profilePanel = fs.readFileSync("client/src/panels/ProfilePanel.jsx", "utf8");

// ── Migration 087 ────────────────────────────────────────────────────────────

test("migration 087 is present, additive, and byte-identical in both migration paths", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const script = fs.readFileSync("scripts/migrations.js", "utf8");
  const block = (src) => {
    const i = src.indexOf('id: "087_user_profile_answer_overrides"');
    assert.ok(i > 0, "migration 087 must exist");
    return src.slice(i, at(src, "\n    },", i));
  };
  assert.equal(block(server), block(script),
    "the migration must be byte-identical in server.js and scripts/migrations.js");

  assert.doesNotMatch(block(server), /DROP\s+TABLE|DROP\s+COLUMN|RENAME/i, "additive only");
  assert.match(block(server), /ALTER TABLE user_profile ADD COLUMN custom_answer_overrides TEXT NOT NULL DEFAULT '\{\}'/);
});

test("087 is appended after 086 and does not disturb custom_answers", () => {
  // Ordering, not position: pinning this to "the last migration" made every later migration break
  // a test about custom answers, which is a false alarm about the wrong thing.
  const ids = MIGRATIONS.map(m => m.id);
  assert.ok(ids.indexOf("087_user_profile_answer_overrides") > ids.indexOf("086_user_profile_sponsorship_need"));
  assert.equal(new Set(ids).size, ids.length, "migration ids must be unique");
  // The original column is untouched — an existing store keeps resolving after the upgrade.
  const touchingAnswers = MIGRATIONS.filter(m => /custom_answers/.test(m.sql));
  assert.deepEqual(touchingAnswers.map(m => m.id), ["060_user_profile_extended"]);
});

test("the migration actually applies to a database built from the same list", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER)");
  for (const m of MIGRATIONS) {
    for (const stmt of m.sql.split(";").map(s => s.trim()).filter(Boolean)) db.exec(stmt);
  }
  const cols = db.prepare("PRAGMA table_info(user_profile)").all().map(c => c.name);
  assert.ok(cols.includes("custom_answers"));
  assert.ok(cols.includes("custom_answer_overrides"));
  // The default matters: readAnswerStore is handed this value on every run.
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1,'ada','x')").run();
  db.prepare("INSERT INTO user_profile (user_id) VALUES (1)").run();
  const row = db.prepare("SELECT custom_answer_overrides FROM user_profile WHERE user_id=1").get();
  assert.equal(row.custom_answer_overrides, "{}");
});

// ── POST /api/profile ────────────────────────────────────────────────────────

function accountApp() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER)");
  for (const m of MIGRATIONS) {
    for (const stmt of m.sql.split(";").map(s => s.trim()).filter(Boolean)) db.exec(stmt);
  }
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1,'ada','x')").run();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, applyMode: "APPLY", planTier: "PRO" }; next(); });
  app.use(createAccountRouter({
    db,
    requireAuth: (q, r, n) => n(),
    emitToUser: () => {},
    syncClients: new Map(),
    buildAutofillPayload: () => ({}),
    requireModeEntitlement: () => true,
    normalisePlanTier: (t) => t,
    allowedModesForTier: () => ["APPLY"],
    canUseGenerate: () => true,
    canUseAPlusResume: () => true,
    nextPlan: () => null,
    getAutomationReadiness: () => ({}),
    oauthReadiness: () => ({}),
    probeBrowserAvailability: async () => ({}),
    encryptSecret: () => ({ enc: null, iv: null, tag: null }),
    INTEGRATION_PROVIDERS: [],
    publicIntegrationRow: () => ({}),
    providerColumnFor: () => null,
    INDUSTRY_CATEGORIES: [],
  }));
  const server = app.listen(0);
  return { db, server, url: `http://127.0.0.1:${server.address().port}` };
}

const postProfile = (url, body) => fetch(`${url}/api/profile`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const storeRow = (db) => db.prepare("SELECT custom_answers, custom_answer_overrides FROM user_profile WHERE user_id=1").get();

test("POST /api/profile round-trips both halves of the store", async () => {
  const { db, server, url } = accountApp();
  try {
    const r = await postProfile(url, {
      full_name: "Ada Lovelace",
      custom_answers: { "Have you ever worked for {company} before?": "No" },
      custom_answer_overrides: { Figma: { "Why do you want to join {company}?": "Mine." } },
    });
    assert.equal(r.status, 200);
    const row = storeRow(db);
    assert.deepEqual(JSON.parse(row.custom_answers), { "Have you ever worked for {company} before?": "No" });
    assert.deepEqual(JSON.parse(row.custom_answer_overrides), { figma: { "Why do you want to join {company}?": "Mine." } });
  } finally { server.close(); }
});

test("A CLIENT THAT SENDS NO ANSWERS DOES NOT WIPE THEM", async () => {
  // The extension and any older tab post a profile without these keys. This handler writes every
  // column unconditionally, so absence used to mean "{}" — silently destroying answers the
  // candidate captured over many runs.
  const { db, server, url } = accountApp();
  try {
    await postProfile(url, {
      custom_answers: { "Q?": "A" },
      custom_answer_overrides: { figma: { "Q?": "B" } },
    });
    await postProfile(url, { full_name: "Ada Lovelace", city: "Boston" });
    const row = storeRow(db);
    assert.deepEqual(JSON.parse(row.custom_answers), { "Q?": "A" }, "answers must survive");
    assert.deepEqual(JSON.parse(row.custom_answer_overrides), { figma: { "Q?": "B" } }, "overrides must survive");
  } finally { server.close(); }
});

test("an explicitly empty object DOES clear — deleting the last answer must stick", async () => {
  const { db, server, url } = accountApp();
  try {
    await postProfile(url, { custom_answers: { "Q?": "A" } });
    await postProfile(url, { custom_answers: {} });
    assert.deepEqual(JSON.parse(storeRow(db).custom_answers), {});
  } finally { server.close(); }
});

test("a nested object cannot be stored as an answer", async () => {
  const { db, server, url } = accountApp();
  try {
    await postProfile(url, { custom_answers: { good: "yes", bad: { nope: 1 } } });
    assert.deepEqual(JSON.parse(storeRow(db).custom_answers), { good: "yes" },
      "a nested value would be typed into a form as [object Object]");
  } finally { server.close(); }
});

test("override company keys are normalised on the way in", async () => {
  const { db, server, url } = accountApp();
  try {
    await postProfile(url, { custom_answer_overrides: { "  FiGMa  ": { "Q?": "A" } } });
    assert.deepEqual(JSON.parse(storeRow(db).custom_answer_overrides), { figma: { "Q?": "A" } });
  } finally { server.close(); }
});

// ── The settings surface ─────────────────────────────────────────────────────

test("the panel sends and receives both halves of the store", () => {
  assert.match(profilePanel, /custom_answer_overrides: parseMap\(d\.custom_answer_overrides\)/,
    "must load overrides from GET /api/profile");
  assert.match(profilePanel, /custom_answer_overrides: parseMap\(form\.custom_answer_overrides\)/,
    "must post overrides back");
});

test("the panel can edit and delete, not only add", () => {
  // The whole store arrives by capture, so an un-editable list means a mis-captured question can
  // never be corrected and never fires again.
  assert.match(profilePanel, /onRename=/, "the QUESTION wording must be editable");
  assert.match(profilePanel, /onAnswer=/, "the answer must be editable");
  assert.match(profilePanel, /onDelete=/);
  assert.match(profilePanel, /function CustomAnswerRow/);
  assert.match(profilePanel, /function CompanyOverrides/);
});

test("renaming a question carries its per-company overrides with it", () => {
  const rename = profilePanel.slice(at(profilePanel, "onRename={"), at(profilePanel, "onAnswer={"));
  assert.match(rename, /custom_answer_overrides/,
    "an override keyed to the old wording would be orphaned by a rename");
});

test("deleting a question deletes its overrides too", () => {
  const del = profilePanel.slice(at(profilePanel, "onDelete={"), at(profilePanel, "onOverrides={"));
  assert.match(del, /custom_answer_overrides/);
});

test("the panel names the placeholder and warns where the words must be the candidate's", () => {
  assert.match(profilePanel, /COMPANY_TOKEN = "\{company\}"/);
  assert.match(profilePanel, /Your words only/, "a motivation template must be labelled as such");
  assert.match(profilePanel, /never submitted/i, "and must say what happens to the generic text");
});

test("the panel's template rules match the server's, so the two cannot disagree on screen", async () => {
  const { isTemplate, isMotivationQuestion, SEED_QUESTIONS } = await import("../services/customAnswers.js");
  // The panel re-implements these to render verdicts without a round-trip. A divergence would show
  // the candidate a badge the resolver disagrees with, which is worse than showing nothing.
  const panelSeeds = profilePanel
    .slice(at(profilePanel, "const SEED_QUESTIONS = ["), at(profilePanel, "];", at(profilePanel, "const SEED_QUESTIONS = [")))
    .match(/"([^"]+)"/g).map(s => s.slice(1, -1));
  assert.deepEqual(panelSeeds, SEED_QUESTIONS.map(s => s.question),
    "the seed wordings must be identical on both sides");

  for (const q of panelSeeds) {
    const panelTemplate = /\{\s*company\s*\}/i.test(q);
    assert.equal(panelTemplate, isTemplate(q), `template verdict differs for ${q}`);
  }
  // And the one that must never be auto-answered is the one the panel flags.
  assert.equal(isMotivationQuestion("Why do you want to join {company}?"), true);
});

test("the seed button adds wordings only — never an answer", () => {
  const seedBlock = profilePanel.slice(
    at(profilePanel, "+ Add the 5 commonly-asked questions") - 900,
    at(profilePanel, "+ Add the 5 commonly-asked questions"),
  );
  assert.match(seedBlock, /next\[q\] = ""/, "a seeded question must arrive blank");
});
