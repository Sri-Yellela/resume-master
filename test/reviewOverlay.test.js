// TASK G3 — the provenance overlay.
//
// The overlay is verified end to end in scripts/g3ReviewOverlay.mjs, rendered over the real trap
// form in a real browser. What is here is the ordering and readiness logic, which is the actual
// feature: the claim is that a candidate reads three uncertain fields instead of thirty certain
// ones, and that claim is entirely about which band a field lands in.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

import {
  orderForReview, readinessOf, toReviewItem, keyOf,
  CONFIDENCE_BY_PROVENANCE, MATCH_CONFIDENCE, LOW_CONFIDENCE, GUESS_PROVENANCE, TIER_LABEL,
} from "../extension/review-overlay.js";
import { CONFIDENCE_BY_PROVENANCE as SERVER_CONFIDENCE } from "../services/applyAutomation.js";

const item = (over) => ({
  field: "Field", name: "field", value: "v",
  provenance: "handler_exact", matchedBy: "exact", eligibility: false, ...over,
});

// ── The two tables must agree ────────────────────────────────────────────────

test("the extension's confidence table matches the server's exactly", () => {
  // An extension cannot import from the server, so this table is duplicated. A drift would mean the
  // overlay calls a value certain that the resolver treated as a guess — the two would be describing
  // the same answer differently to the same person.
  assert.deepEqual(CONFIDENCE_BY_PROVENANCE, SERVER_CONFIDENCE);
});

test("the low-confidence threshold matches the server's auto-submit floor", () => {
  const src = fs.readFileSync("services/applyAutomation.js", "utf8");
  const m = src.match(/AUTO_SUBMIT_MIN_CONFIDENCE = ([\d.]+)/);
  assert.ok(m, "the server must still declare an auto-submit floor");
  assert.equal(LOW_CONFIDENCE, Number(m[1]),
    "'too uncertain to submit unattended' and 'worth a human's attention' must be the same line");
});

// ── Ordering is the feature ──────────────────────────────────────────────────

test("ELIGIBILITY PINS TO THE TOP EVEN WHEN IT IS COMPLETELY CERTAIN", () => {
  // §6: these are attestations to an employer. Being sure of the answer is not the same as being
  // entitled to make it on the candidate's behalf, so confidence does not move them.
  const bands = orderForReview([
    item({ name: "email", provenance: "handler_exact" }),
    item({ name: "work_authorization", provenance: "handler_exact", eligibility: true }),
    item({ name: "org", provenance: "label_fuzzy" }),
  ]);
  assert.equal(bands.eligibility.length, 1);
  assert.equal(bands.eligibility[0].name, "work_authorization");
  assert.ok(!bands.uncertain.some(i => i.eligibility), "eligibility never appears in another band");
  assert.ok(!bands.settled.some(i => i.eligibility));
});

test("a certain value placed by a LABEL match is still uncertain overall", () => {
  // The failure this rule was written for: "Current Company" resolved field_map_exact (0.9) and was
  // placed into a control matched only by its label. Showing it as "resolved exactly" reports the
  // value's certainty while hiding the placement's doubt, and it sat in the collapsed section with
  // nothing to acknowledge.
  const bands = orderForReview([item({ name: "current_company", provenance: "field_map_exact", matchedBy: "label" })]);
  assert.equal(bands.settled.length, 0);
  assert.equal(bands.uncertain.length, 1);
  assert.equal(bands.uncertain[0].tierLabel, "guessed field");
  assert.equal(bands.uncertain[0].confidence, MATCH_CONFIDENCE.label);
});

test("confidence is the weaker of the two, never the flattering one", () => {
  const guessedValueExactField = toReviewItem(item({ provenance: "label_fuzzy", matchedBy: "exact" }));
  assert.equal(guessedValueExactField.confidence, CONFIDENCE_BY_PROVENANCE.label_fuzzy);
  assert.equal(guessedValueExactField.tierLabel, "guessed value");

  const exactValueGuessedField = toReviewItem(item({ provenance: "handler_exact", matchedBy: "label" }));
  assert.equal(exactValueGuessedField.confidence, MATCH_CONFIDENCE.label);
});

test("the least certain field is read first inside each band", () => {
  const bands = orderForReview([
    item({ name: "a", provenance: "handler_exact" }),
    item({ name: "b", provenance: "field_map_exact" }),
    item({ name: "c", provenance: "label_exact" }),
  ]);
  const order = bands.settled.map(i => i.name);
  assert.deepEqual(order, ["c", "b", "a"], "ascending confidence — most doubt first");
});

test("certain fields are collapsed, not discarded", () => {
  const bands = orderForReview([
    item({ name: "a", provenance: "handler_exact" }),
    item({ name: "b", provenance: "field_map_exact" }),
  ]);
  assert.equal(bands.settled.length, 2, "a candidate who wants to read them still can");
  assert.equal(bands.uncertain.length, 0);
});

// ── Readiness ────────────────────────────────────────────────────────────────

test("a guess blocks ready until it is individually acknowledged", () => {
  const items = [item({ name: "org", provenance: "label_fuzzy" })];
  assert.equal(readinessOf(items).ready, false);
  assert.equal(readinessOf(items).guessCount, 1);
  assert.equal(readinessOf(items, new Set([keyOf(toReviewItem(items[0]))])).ready, true);
});

test("acknowledging one guess does not acknowledge the others", () => {
  // Bulk approval would recreate exactly what the overlay replaces: one gesture meaning "I read none
  // of this".
  const items = [
    item({ name: "a", field: "A", provenance: "label_fuzzy" }),
    item({ name: "b", field: "B", provenance: "label_fuzzy" }),
  ];
  const ack = new Set([keyOf(toReviewItem(items[0]))]);
  const r = readinessOf(items, ack);
  assert.equal(r.ready, false);
  assert.equal(r.unacknowledged.length, 1);
  assert.equal(r.unacknowledged[0].name, "b");
});

test("everything certain is ready with nothing to acknowledge", () => {
  const r = readinessOf([item({ provenance: "handler_exact", matchedBy: "exact" })]);
  assert.equal(r.ready, true);
  assert.equal(r.guessCount, 0);
});

test("A FUZZY-MATCHED ELIGIBILITY ANSWER IS A RESOLVER BUG, NOT A QUESTION", () => {
  // Requirement 4. G2's matcher refuses to place one, so reaching here means the resolver produced
  // it. Asking the candidate to acknowledge it would be asking them to rubber-stamp a defect on a
  // legally material answer — so it blocks ready and cannot be acknowledged away.
  const items = [item({ name: "requires_sponsorship", provenance: "label_fuzzy", eligibility: true })];
  const r = readinessOf(items, new Set([keyOf(toReviewItem(items[0]))]));
  assert.equal(r.ready, false, "acknowledging must NOT clear it");
  assert.ok(Array.isArray(r.resolverBug) && r.resolverBug.length === 1);
  assert.equal(r.resolverBug[0].name, "requires_sponsorship");
});

test("an eligibility answer placed by a guessed FIELD is caught the same way", () => {
  const items = [item({ name: "work_authorization", provenance: "handler_exact", matchedBy: "label", eligibility: true })];
  const r = readinessOf(items);
  assert.equal(r.ready, false);
  assert.ok(r.resolverBug, "a guessed placement of an attestation is the same defect class");
});

// ── The overlay never submits ────────────────────────────────────────────────

test("the overlay has no path to submitting the form", () => {
  const src = fs.readFileSync("extension/review-overlay.js", "utf8");
  assert.doesNotMatch(src, /\.submit\s*\(/);
  assert.doesNotMatch(src, /requestSubmit/);
  assert.doesNotMatch(src, /type=["']submit["']/);
  assert.match(src, /Submit the form yourself/, "it should say plainly whose job that is");
});

test("guess provenance is exactly the tiers the resolver treats as guesses", () => {
  for (const p of ["label_fuzzy", "default"]) assert.ok(GUESS_PROVENANCE.has(p));
  for (const p of ["handler_exact", "field_map_exact", "label_exact", "custom_answer"]) {
    assert.ok(!GUESS_PROVENANCE.has(p), `${p} is a resolution, not a guess`);
  }
});

test("an ASSUMED sponsorship tense is a guess; a DERIVED one is not", () => {
  // The situation is known in both cases. What was inferred in the assumed case is the QUESTION's
  // time scope — and answering an eligibility question on an inferred reading is exactly the thing
  // a candidate should have to say yes to.
  assert.ok(GUESS_PROVENANCE.has("sponsorship_assumed_future"));
  assert.ok(!GUESS_PROVENANCE.has("sponsorship_derived"),
    "an explicitly tensed question read correctly is a resolution");
});

test("every provenance the resolver can emit has a tier label", () => {
  // A missing label renders as `undefined` in the overlay chip — visible to the candidate, and the
  // sort of thing that only shows up once a new provenance ships.
  for (const p of Object.keys(CONFIDENCE_BY_PROVENANCE)) {
    assert.ok(TIER_LABEL[p], `no TIER_LABEL for provenance "${p}"`);
  }
});

// ── Migration ────────────────────────────────────────────────────────────────

test("migration 080 is present, additive, and byte-identical in both migration paths", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const script = fs.readFileSync("scripts/migrations.js", "utf8");
  const block = (src) => {
    const i = src.indexOf('id: "080_apply_gate_review"');
    assert.ok(i > 0, "migration 080 must exist");
    return src.slice(i, src.indexOf("\n    },", i));
  };
  assert.equal(block(server), block(script));
  assert.match(block(server), /ALTER TABLE apply_run_jobs ADD COLUMN gate_review_json TEXT/);
  assert.doesNotMatch(block(server), /DROP|RENAME/i);
});

test("the recorded review does not store corrected values", () => {
  // The audit question is WHAT the candidate changed, not what they changed it to — that value is
  // going to the employer either way, and keeping a second copy of it here buys nothing.
  const src = fs.readFileSync("routes/apply.js", "utf8");
  const i = src.indexOf('app.post("/api/apply/gate-review"');
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf("app.post", i + 10));
  assert.match(body, /field: String\(e\?\.key/, "only the field identity is kept");
  assert.doesNotMatch(body, /value: String\(e\?\.value/, "the new value must not be persisted");
});
