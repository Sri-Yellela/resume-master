// TASK G4 — application form schemas as a KB fact.
//
// The end-to-end proof is scripts/g4SchemaCapture.mjs, which captures the JS-rendered form in a real
// browser AFTER filling it in, so "no user answer is stored" is tested against a form that actually
// contains some. What is here is the invariant requirement 1 asks to be asserted rather than
// commented, plus the reconciliation rules a real run only exercises one path through.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";

import {
  normaliseCapturedFields, unmappedFields, shapeHash, hostOf, recordFormSchema,
  formSchemaSummary, mapFormSchemaRow, decayedConfidence, isStale,
  FIELD_KEYS, STALE_DECAY_FLOOR,
} from "../services/kb/formSchemaLayer.js";
import { MIGRATIONS } from "../scripts/migrations.js";

const DAY = 86400;

function setup() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);`);
  db.exec(MIGRATIONS.find(m => m.id === "081_company_form_schemas").sql);
  return db;
}

// Exactly what discoverFields emits — including current_value, which is what the candidate typed.
const DISCOVERED = [
  { field_id: "f_name", name: "name", type: "text", label: "Full name", is_required: true,
    options: [], handler_type: "full-name", current_value: "Ada Lovelace" },
  { field_id: "f_email", name: "email", type: "email", label: "Email", is_required: true,
    options: [], handler_type: "email", current_value: "ada@example.com" },
  { field_id: "f_hear", name: "hear_about_us", type: "textarea", label: "How did you hear about us?",
    is_required: true, options: [], handler_type: null, current_value: "a friend told me" },
];

// ── Requirement 1: structure only, asserted ──────────────────────────────────

test("NO PROPERTY OUTSIDE THE WHITELIST IS EVER STORED", () => {
  const clean = normaliseCapturedFields(DISCOVERED);
  for (const f of clean) {
    assert.deepEqual(Object.keys(f).sort(), [...FIELD_KEYS].sort(),
      "a field may carry exactly the whitelisted properties and nothing else");
  }
});

test("THE CANDIDATE'S TYPED VALUES DO NOT SURVIVE NORMALISATION", () => {
  const text = JSON.stringify(normaliseCapturedFields(DISCOVERED));
  assert.ok(!text.includes("Ada Lovelace"));
  assert.ok(!text.includes("ada@example.com"));
  assert.ok(!text.includes("a friend told me"));
  assert.ok(!text.includes("current_value"));
});

test("an inventive producer cannot smuggle a value through an unexpected key", () => {
  // The reason this is a whitelist and not a strip-list: a blacklist has to know every name a value
  // might arrive under, and silently passes the next one.
  const clean = normaliseCapturedFields([{
    name: "email", label: "Email", type: "email",
    value: "ada@example.com", answer: "ada@example.com", defaultValue: "ada@example.com",
    userProfile: { email: "ada@example.com" }, notes: "ada@example.com",
  }]);
  assert.ok(!JSON.stringify(clean).includes("ada@example.com"));
});

test("what the form ASKS is kept — that is the entire asset", () => {
  const clean = normaliseCapturedFields(DISCOVERED);
  assert.equal(clean[0].label, "Full name");
  assert.equal(clean[0].type, "text");
  assert.equal(clean[0].required, true);
  assert.equal(clean[0].name, "name");
  assert.equal(clean[2].label, "How did you hear about us?");
});

test("option lists are kept, and only their own value and label", () => {
  const clean = normaliseCapturedFields([{
    name: "src", label: "Source", type: "select",
    options: [{ value: "web", label: "Web", selected: true, chosenByUser: "yes" }],
  }]);
  assert.deepEqual(clean[0].options, [{ value: "web", label: "Web" }]);
});

test("both extractors are accepted without a third one being written", () => {
  // discoverFields emits is_required/field_id; the extension's probeFormShape emits required/index.
  const fromServer = normaliseCapturedFields([{ name: "a", label: "A", is_required: true, field_id: "x" }]);
  const fromExtension = normaliseCapturedFields([{ name: "a", label: "A", required: true, index: 0 }]);
  assert.equal(fromServer[0].required, true);
  assert.equal(fromExtension[0].required, true);
  assert.deepEqual(Object.keys(fromServer[0]).sort(), Object.keys(fromExtension[0]).sort());
});

test("field order is preserved and renumbered densely", () => {
  const clean = normaliseCapturedFields([
    { name: "c", order: 9 }, { name: "a", order: 1 }, { name: "b", order: 4 },
  ]);
  assert.deepEqual(clean.map(f => f.name), ["a", "b", "c"]);
  assert.deepEqual(clean.map(f => f.order), [0, 1, 2]);
});

// ── Requirement 4: unmapped fields are the valuable part ─────────────────────

test("a question nothing can answer is identified", () => {
  const clean = normaliseCapturedFields(DISCOVERED);
  const unmapped = unmappedFields(clean).map(f => f.label);
  assert.deepEqual(unmapped, ["How did you hear about us?"]);
});

test("unmapped uses WHOLE-TOKEN matching, not substring", () => {
  // `includes` counts "Name of Referrer" as answerable because `name` is a handler hint — and the
  // resolver refuses to fill that field by design, so it is exactly a question the run will stop on.
  const clean = normaliseCapturedFields([
    { name: "referrer_name", label: "Name of Referrer", type: "text" },
    { name: "first_name", label: "First Name", type: "text", handler_type: "first-name" },
  ]);
  const unmapped = unmappedFields(clean).map(f => f.name);
  assert.ok(unmapped.includes("referrer_name"), "a third-party field is not answerable");
  assert.ok(!unmapped.includes("first_name"));
});

test("a file input is not a question the candidate has to answer", () => {
  const clean = normaliseCapturedFields([{ name: "resume", label: "Resume", type: "file" }]);
  assert.equal(unmappedFields(clean).length, 0, "the packet already carries the resume");
});

// ── Requirement 3: reconciliation, confidence, staleness ─────────────────────

test("the shape hash changes when the form does, and not otherwise", () => {
  const a = normaliseCapturedFields(DISCOVERED);
  const b = normaliseCapturedFields([...DISCOVERED].reverse());
  assert.equal(shapeHash(a), shapeHash(b), "re-ordering the same questions is the same form");

  const added = normaliseCapturedFields([...DISCOVERED, { name: "portfolio", label: "Portfolio", type: "url" }]);
  assert.notEqual(shapeHash(a), shapeHash(added), "an added question is a different form");

  const retyped = normaliseCapturedFields(DISCOVERED.map(f =>
    f.name === "email" ? { ...f, type: "text" } : f));
  assert.notEqual(shapeHash(a), shapeHash(retyped), "a retyped question is a different form");

  const nowRequired = normaliseCapturedFields(DISCOVERED.map(f =>
    f.name === "hear_about_us" ? { ...f, is_required: false } : f));
  assert.notEqual(shapeHash(a), shapeHash(nowRequired), "a changed required flag is a different form");
});

test("repeat sightings corroborate and promote", () => {
  const db = setup();
  let last;
  for (let i = 0; i < 3; i++) last = recordFormSchema(db, { applyHost: "jobs.acme.com", fields: DISCOVERED });
  assert.equal(last.corroborationCount, 3);
  assert.equal(last.status, "confirmed");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM company_form_schemas").get().n, 1);
  db.close();
});

test("A CHANGED FORM RECONCILES RATHER THAN DUPLICATING", () => {
  const db = setup();
  for (let i = 0; i < 3; i++) recordFormSchema(db, { applyHost: "jobs.acme.com", fields: DISCOVERED });
  const changed = recordFormSchema(db, {
    applyHost: "jobs.acme.com",
    fields: [...DISCOVERED, { name: "portfolio", label: "Portfolio", type: "url" }],
  });

  assert.equal(changed.changed, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM company_form_schemas").get().n, 1, "one row");
  assert.equal(changed.corroborationCount, 1, "the old evidence was for a form that no longer exists");
  assert.equal(changed.status, "proposed", "a confirmed schema drops back when the form changes");

  const row = db.prepare("SELECT * FROM company_form_schemas").get();
  assert.ok(row.previous_shape_hash && row.previous_shape_hash !== row.shape_hash);
  assert.ok(row.changed_at, "the change is dated");
  assert.equal(mapFormSchemaRow(row).fields.length, 4, "the stored shape is the new one");
  db.close();
});

test("demotion on change is a DELIBERATE divergence from orgLayer, which never demotes", () => {
  // An org unit that stops appearing may simply not be hiring. A form that comes back DIFFERENT is
  // positive evidence the stored one is wrong, which is not the same situation.
  const org = fs.readFileSync("services/kb/orgLayer.js", "utf8");
  assert.match(org, /status\s+= CASE WHEN company_org_units\.status = 'confirmed'/,
    "orgLayer must still be the never-demote case this diverges from");
  const layer = fs.readFileSync("services/kb/formSchemaLayer.js", "utf8");
  assert.match(layer, /deliberate divergence from orgLayer/);
});

test("first_seen survives a change; the company is not lost by a later capture", () => {
  const db = setup();
  recordFormSchema(db, { applyHost: "jobs.acme.com", company: "Acme", fields: DISCOVERED, now: 1000 });
  recordFormSchema(db, {
    applyHost: "jobs.acme.com", fields: [...DISCOVERED, { name: "x", label: "X" }], now: 2000,
  });
  const row = db.prepare("SELECT * FROM company_form_schemas").get();
  assert.equal(row.first_seen, 1000);
  assert.equal(row.last_seen, 2000);
  assert.equal(row.company, "Acme", "a capture that omits the company must not erase it");
  db.close();
});

test("confidence is derived at read time, because nothing sweeps this table", () => {
  const db = setup();
  const now = Math.floor(Date.now() / 1000);
  recordFormSchema(db, { applyHost: "jobs.acme.com", fields: DISCOVERED, now });
  const row = db.prepare("SELECT * FROM company_form_schemas").get();
  assert.ok(decayedConfidence(row, now) > decayedConfidence(row, now + 120 * DAY),
    "a schema nobody has seen in four months is worth less than it was");
  db.close();
});

test("STALENESS IS ABOUT AGE, NOT ABOUT CORROBORATION", () => {
  // These call for opposite responses — one wants a second sighting, the other wants a fresh look —
  // and conflating them made every capture report as stale on the day it was made.
  const db = setup();
  const now = Math.floor(Date.now() / 1000);
  recordFormSchema(db, { applyHost: "jobs.acme.com", fields: DISCOVERED, now });
  const row = db.prepare("SELECT * FROM company_form_schemas").get();

  assert.equal(isStale(row, now), false, "a form seen once today is uncorroborated, not stale");
  assert.equal(isStale(row, now + 90 * DAY), true, "a form last seen three months ago is stale");
  assert.ok(STALE_DECAY_FLOOR > 0 && STALE_DECAY_FLOOR < 1);
  db.close();
});

test("a stale schema does not get to predict what a run will do", () => {
  const db = setup();
  const old = Math.floor(Date.now() / 1000) - 200 * DAY;
  recordFormSchema(db, { applyHost: "jobs.acme.com", fields: DISCOVERED, now: old });
  const summary = formSchemaSummary(db, "https://jobs.acme.com/x");
  assert.equal(summary.stale, true);
  assert.equal(summary.willLikelyHold, false,
    "which is not the same as predicting the run will go fine — the count is still reported");
  assert.ok(summary.unmappedCount >= 1, "the fact is still there to be read");
  db.close();
});

// ── The failure the ⛔ existed to prevent ────────────────────────────────────

test("AN EMPTY SCHEMA IS REFUSED, NOT STORED", () => {
  // Persisting one would cache the absence of information into the asset meant to compound, and a
  // later reader could not tell "this form has no fields" from "discovery ran before it rendered".
  const db = setup();
  assert.throws(() => recordFormSchema(db, { applyHost: "jobs.acme.com", fields: [] }),
    /empty form schema/);
  assert.throws(() => recordFormSchema(db, { applyHost: "jobs.acme.com", fields: null }),
    /empty form schema/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM company_form_schemas").get().n, 0);
  db.close();
});

test("a schema with no host to be keyed by is refused", () => {
  const db = setup();
  assert.throws(() => recordFormSchema(db, { applyHost: "", fields: DISCOVERED }), /apply host/);
  db.close();
});

// ── Requirement 5: one store, two consumers ─────────────────────────────────

test("both producers write the same shape and are told apart by source", () => {
  const db = setup();
  recordFormSchema(db, { applyHost: "a.example.com", fields: DISCOVERED, source: "extension_gated" });
  recordFormSchema(db, { applyHost: "b.example.com", fields: DISCOVERED, source: "server_discovery" });
  const rows = db.prepare("SELECT apply_host, source, fields_json FROM company_form_schemas ORDER BY apply_host").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].fields_json, rows[1].fields_json, "the same form is the same fact either way");
  assert.deepEqual(rows.map(r => r.source), ["extension_gated", "server_discovery"]);
  db.close();
});

test("the store is keyed by apply HOST, so one capture serves every posting behind it", () => {
  const db = setup();
  recordFormSchema(db, { applyHost: hostOf("https://jobs.acme.com/postings/1"), fields: DISCOVERED });
  for (const url of ["https://jobs.acme.com/postings/2", "https://jobs.acme.com/apply/999?x=1"]) {
    assert.equal(formSchemaSummary(db, url)?.known, true, url);
  }
  assert.equal(formSchemaSummary(db, "https://other.example.com/1"), null);
  db.close();
});

test("hostOf never throws and is case-insensitive", () => {
  assert.equal(hostOf("https://Jobs.ACME.com/x"), "jobs.acme.com");
  assert.equal(hostOf("not a url"), null);
  assert.equal(hostOf(null), null);
});

// ── Consent ─────────────────────────────────────────────────────────────────

test("capture is opt-in and enforced on the SERVER, not just in the client", () => {
  const src = fs.readFileSync("routes/apply.js", "utf8");
  const i = src.indexOf('app.post("/api/apply/form-schema"');
  assert.ok(i > 0, "the capture endpoint must exist");
  const body = src.slice(i, i + 2000);
  assert.match(body, /form_schema_capture !== 1/, "it must check consent before storing anything");
  assert.match(body, /capture_not_enabled/);
  // A client-side check is a request the client can simply not make, so the refusal that counts is
  // this one. The column's DEFAULT 0 is asserted by the migration test below.
  assert.ok(body.indexOf("capture_not_enabled") < body.indexOf("recordFormSchema"),
    "consent must be checked BEFORE anything is recorded");
});

test("migration 081 is present, additive, and byte-identical in both migration paths", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const script = fs.readFileSync("scripts/migrations.js", "utf8");
  const block = (src) => {
    const i = src.indexOf('id: "081_company_form_schemas"');
    assert.ok(i > 0, "migration 081 must exist");
    return src.slice(i, src.indexOf("\n    },", i));
  };
  assert.equal(block(server), block(script));
  assert.match(block(server), /CREATE TABLE IF NOT EXISTS company_form_schemas/);
  assert.match(block(server), /ALTER TABLE users ADD COLUMN form_schema_capture INTEGER NOT NULL DEFAULT 0/);
  assert.doesNotMatch(block(server), /DROP\s+TABLE|DROP\s+COLUMN|RENAME/i);
});

/** Strip comments so a grep-proof is about CODE, not about the prose explaining the code. */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("no code path writes an answer into the schema store", () => {
  // Grep-proof, as the task asks for. The store is written in exactly one place, and that place
  // whitelists. Comments are stripped first: this file discusses current_value at length precisely
  // because it must never store it, and a naive grep would flag its own explanation.
  const layer = codeOnly(fs.readFileSync("services/kb/formSchemaLayer.js", "utf8"));
  assert.doesNotMatch(layer, /current_value/,
    "no executable line may even name the property that holds what the candidate typed");
  for (const f of ["routes/apply.js", "extension/gated-handoff.js"]) {
    assert.doesNotMatch(codeOnly(fs.readFileSync(f, "utf8")), /company_form_schemas/,
      `${f} must go through formSchemaLayer, so the whitelist cannot be bypassed`);
  }
});
