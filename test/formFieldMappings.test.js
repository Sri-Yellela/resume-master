// TASK H — label → field mappings derived from captured form structure.
//
// ⛔ THE HARD BOUNDARY, AND IT IS ASSERTED HERE RATHER THAN STATED IN A COMMENT (the task said so
// in those words). No eligibility field may be mapped by this table. Two live defects say why, and
// both are label matching getting clever near an attestation:
//
//   · `login_email`, labelled "Email", resolved to the email handler and typed the candidate's home
//     address into a portal's SIGN-IN box at 0.9 confidence — the second-highest tier. The legacy
//     sweep also wrote to the PASSWORD field, because its type-exclusion list never included
//     password.
//   · A `work_authorization` key substring-matched "do you now or in the future require sponsorship
//     for work authorization" — a semantically INVERTED question, and a materially false
//     attestation to an employer.
//
// A derived table is a label matcher with more data behind it, and more data does not make an
// inverted question answerable.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { getPlatformLabelMap } from "../services/platformDetector.js";
import {
  recordMappingProposal, loadConfirmedMappings, loadAllConfirmedMappings, confirmMapping,
  rejectMapping, mappingStats, forbiddenMapping, labelKey, EXCLUDED_FIELD_KEYS,
} from "../services/kb/formFieldMappings.js";

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE form_field_mappings (
      platform TEXT NOT NULL, label TEXT NOT NULL, field_key TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0, corroboration_count INTEGER NOT NULL DEFAULT 0,
      source_hosts_json TEXT, status TEXT NOT NULL DEFAULT 'proposed',
      reviewed_at INTEGER, reviewed_by TEXT, first_seen INTEGER, last_seen INTEGER,
      PRIMARY KEY (platform, label)
    );
  `);
  return db;
}

// ── THE HARD BOUNDARY ───────────────────────────────────────────────────────────────────────────

test("⛔ every eligibility, EEO and credential key is refused BY KEY", () => {
  const db = makeDb();
  for (const key of ["work_authorization", "requires_sponsorship", "visa_type", "clearance_level",
                     "criminal_history", "years_experience", "gender", "ethnicity",
                     "veteran_status", "disability_status", "password", "login_email"]) {
    const r = recordMappingProposal(db, { platform: "generic", label: "Some Label", fieldKey: key });
    assert.equal(r.recorded, false, `${key} must be refused`);
    assert.match(r.refused, /eligibility|EEO|credential/i);
  }
  assert.equal(mappingStats(db).proposed, 0, "not one row may exist to be confirmed later");
  db.close();
});

test("⛔ THE SPONSORSHIP INVERSION: refused BY LABEL, even with an innocuous key", () => {
  // The live defect exactly. The question is about sponsorship; the key proposed was
  // `work_authorization`. Answering the first from the second is a materially false attestation.
  // A key-only check would have let this through, because work_authorization "looks like" the
  // right handler for a work-authorization question.
  const db = makeDb();
  const r = recordMappingProposal(db, {
    platform: "greenhouse", fieldKey: "location",
    label: "Do you now or in the future require sponsorship for work authorization?",
  });
  assert.equal(r.recorded, false);
  assert.match(r.refused, /eligibility question/);
  db.close();
});

test("⛔ a credential label is refused even when the key is a legitimate profile field", () => {
  // The login_email shape: the label was a perfectly ordinary "Email". Here the sign-in framing is
  // what disqualifies it, not the key.
  const db = makeDb();
  for (const label of ["Password", "Sign in email", "Log in", "Username"]) {
    const r = recordMappingProposal(db, { platform: "generic", label, fieldKey: "email" });
    assert.equal(r.recorded, false, `${label} must be refused`);
  }
  db.close();
});

test("the eligibility labels that ARE mapped live in the authored map, not this one", () => {
  // The hand-written PLATFORM_LABEL_MAPS still carry "Sponsorship", "Work Authorization",
  // "Clearance" and "Years of Experience" — those are the EXACT handler mappings the task says
  // eligibility must resolve through. This table is strictly narrower, on purpose.
  const authored = getPlatformLabelMap("greenhouse");
  assert.equal(authored["Work Authorization"], "work_authorization");
  for (const key of Object.values(authored)) {
    // and every one of those keys is on the derived table's refusal list
    if (["work_authorization", "requires_sponsorship", "clearance_level", "years_experience"].includes(key)) {
      assert.ok(EXCLUDED_FIELD_KEYS.has(key), `${key} must be un-derivable`);
    }
  }
});

test("refusals are REPORTED, not silently dropped", () => {
  // A generator that quietly discards a third of its candidates cannot be reviewed, and "the table
  // has no sponsorship mapping" would be indistinguishable from "the generator never saw one".
  const db = makeDb();
  const r = recordMappingProposal(db, { platform: "generic", label: "Visa status", fieldKey: "location" });
  assert.equal(r.recorded, false);
  assert.ok(r.refused && r.refused.length > 10, "the reason must be reportable, not a bare false");
  db.close();
});

test("a forbidden mapping cannot reach the resolver even if a row somehow exists", () => {
  // Belt and braces: the store refuses, and the LOAD refuses again. Two independent gates, because
  // this one guards what actually gets typed into an employer's form.
  const db = makeDb();
  db.prepare(`INSERT INTO form_field_mappings (platform,label,field_key,status) VALUES ('generic','sponsorship','requires_sponsorship','confirmed')`).run();
  assert.deepEqual(loadConfirmedMappings(db, "generic"), {});
  assert.deepEqual(loadAllConfirmedMappings(db), {});
  db.close();
});

// ── PROPOSALS NEVER REACH THE RESOLVER ──────────────────────────────────────────────────────────

test("a proposal is invisible until a human confirms it", () => {
  // A wrong mapping fills the wrong answer into a real employer's form, and that cannot be recalled.
  const db = makeDb();
  assert.equal(recordMappingProposal(db, { platform: "ashby", label: "Preferred Name", fieldKey: "preferred_name" }).recorded, true);
  assert.deepEqual(loadConfirmedMappings(db, "ashby"), {});
  confirmMapping(db, "ashby", "Preferred Name");
  assert.deepEqual(loadConfirmedMappings(db, "ashby"), { [labelKey("Preferred Name")]: "preferred_name" });
  db.close();
});

test("a rejection is sticky — a later capture cannot resurrect it", () => {
  const db = makeDb();
  recordMappingProposal(db, { platform: "ashby", label: "Referrer Name", fieldKey: "full_name" });
  rejectMapping(db, "ashby", "Referrer Name");
  const again = recordMappingProposal(db, { platform: "ashby", label: "Referrer Name", fieldKey: "full_name" });
  assert.equal(again.recorded, false);
  assert.equal(again.refused, "already reviewed");
  db.close();
});

test("corroboration counts distinct HOSTS and never promotes", () => {
  const db = makeDb();
  for (const host of ["a.example", "b.example", "a.example"]) {
    recordMappingProposal(db, { platform: "ashby", label: "Preferred Name", fieldKey: "preferred_name", host });
  }
  const row = db.prepare("SELECT * FROM form_field_mappings").get();
  assert.equal(row.corroboration_count, 2, "the repeat host must not count twice");
  assert.equal(row.status, "proposed", "no amount of corroboration promotes a mapping");
  db.close();
});

// ── THE MERGE DIRECTION IS THE SAFETY PROPERTY ──────────────────────────────────────────────────

test("⛔ a derived mapping FILLS A GAP and can never override the authored map", () => {
  // If a derived entry could shadow an authored one, a table built from labels scraped off employer
  // forms would be deciding how an attestation is answered. The merge order forbids it structurally.
  const derived = { [labelKey("Work Authorization")]: "location", [labelKey("Preferred Name")]: "preferred_name" };
  const map = getPlatformLabelMap("greenhouse", derived);
  assert.equal(map["Work Authorization"], "work_authorization",
    "the authored eligibility mapping must survive a derived entry claiming the same label");
  assert.equal(map[labelKey("Preferred Name")], "preferred_name",
    "but a label the authored map does not cover is filled");
});

test("without a derived map, the label map is exactly what it was", () => {
  assert.deepEqual(getPlatformLabelMap("lever"), getPlatformLabelMap("lever", null));
  assert.deepEqual(getPlatformLabelMap("generic"), getPlatformLabelMap("generic", {}));
});

// ── NO MODEL IN THE FILL PATH ───────────────────────────────────────────────────────────────────

test("⛔ nothing in this feature calls a model — the fill path stays deterministic", () => {
  // Jobo's integration terms say "No AI-generated answers" and §7 says the same. The output of task
  // H is a reviewed table that deterministic code consumes; if any part of it produced a model call
  // during a fill, the design is wrong.
  for (const f of ["services/kb/formFieldMappings.js", "services/platformDetector.js",
                   "scripts/al8FormFieldMappings.mjs"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.ok(!/callModel|messages\.create|anthropic/i.test(src.replace(/^\s*(\/\/|\*).*$/gm, "")),
      `${f} must not reference a model — buildAnswers stays deterministic`);
  }
});

test("applyAutomation still has no database handle", () => {
  // The derived map is INJECTED for this reason: the automation layer is pure, and the DB stays in
  // routes/apply.js. Growing a database handle here to load a table would be the easy change and
  // the wrong one.
  const src = fs.readFileSync("services/applyAutomation.js", "utf8");
  assert.ok(!/better-sqlite3|from ['"]\.\.\/scripts\/migrations/.test(src));
  assert.match(src, /derivedLabelMaps/, "it must accept the injected map instead");
});

test("the resolver's provenance tiers are untouched", () => {
  // Requirement 4: a table-derived mapping resolves at 'field_map_exact' — the same tier an
  // authored label does, because it IS the label map — and never at 'label_fuzzy'. The A2 rule
  // stands: a label_fuzzy answer is not auto-submitted in mode 'full'.
  const src = fs.readFileSync("services/applyAutomation.js", "utf8");
  assert.match(src, /FIELD_MAP_EXACT: 'field_map_exact'/);
  assert.match(src, /field_map_exact: 0\.9/);
  assert.match(src, /label_fuzzy:\s+0\.3/);
});
