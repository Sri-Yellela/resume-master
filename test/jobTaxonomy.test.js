// test/jobTaxonomy.test.js — Phase 1: unified taxonomy module + sales family
// Verifies that jobTaxonomy.js re-exports the full Taxonomy B SIGNALS (including
// the new sales family) and that ROLE_FAMILIES is complete and consistent.

import test from "node:test";
import assert from "node:assert/strict";
import {
  SIGNALS,
  ROLE_FAMILIES,
  classifyTitle,
  classifyForIngest,
  getRoleKeyForProfile,
  getRoleFamilyDomainForKey,
  INGEST_CONFIDENCE_THRESHOLD,
  ROLE_TITLE_SQL,
} from "../services/jobs/jobTaxonomy.js";

const EXPECTED_FAMILIES = [
  "engineering_embedded_firmware", "data", "pm", "engineering",
  "hr", "finance", "design", "marketing", "legal",
  "operations", "healthcare", "sales",
];

// ── ROLE_FAMILIES completeness ────────────────────────────────

test("ROLE_FAMILIES includes all expected taxonomy keys", () => {
  for (const f of EXPECTED_FAMILIES) {
    assert.ok(ROLE_FAMILIES.includes(f), `ROLE_FAMILIES must include '${f}'`);
  }
});

test("ROLE_FAMILIES includes sales", () => {
  assert.ok(ROLE_FAMILIES.includes("sales"), "ROLE_FAMILIES must include 'sales'");
});

test("ROLE_FAMILIES length covers all 12 families", () => {
  assert.ok(ROLE_FAMILIES.length >= 12, `Expected at least 12 families, got ${ROLE_FAMILIES.length}`);
});

test("ROLE_FAMILIES is derived from SIGNALS (no orphan keys)", () => {
  for (const f of ROLE_FAMILIES) {
    assert.ok(f in SIGNALS, `ROLE_FAMILIES key '${f}' must exist in SIGNALS`);
  }
});

// ── SIGNALS.sales structure ───────────────────────────────────

test("SIGNALS.sales exists", () => {
  assert.ok(SIGNALS.sales, "SIGNALS must have a sales entry");
});

test("SIGNALS.sales has required fields", () => {
  const { strongAnchors, weakSignals, descriptionAnchors, exclusions } = SIGNALS.sales;
  assert.ok(Array.isArray(strongAnchors) && strongAnchors.length > 0,  "sales.strongAnchors must be non-empty");
  assert.ok(Array.isArray(weakSignals)   && weakSignals.length > 0,    "sales.weakSignals must be non-empty");
  assert.ok(Array.isArray(descriptionAnchors),                          "sales.descriptionAnchors must be array");
  assert.ok(Array.isArray(exclusions),                                  "sales.exclusions must be array");
});

test("SIGNALS.sales strongAnchors include account executive", () => {
  assert.ok(SIGNALS.sales.strongAnchors.includes("account executive"));
});

test("SIGNALS.sales strongAnchors include customer success manager", () => {
  assert.ok(SIGNALS.sales.strongAnchors.includes("customer success manager"));
});

test("SIGNALS.sales strongAnchors include bdr and sdr", () => {
  assert.ok(SIGNALS.sales.strongAnchors.includes("bdr"));
  assert.ok(SIGNALS.sales.strongAnchors.includes("sdr"));
});

test("SIGNALS.sales strongAnchors include revenue operations", () => {
  assert.ok(SIGNALS.sales.strongAnchors.includes("revenue operations"));
});

// ── Sales title classification ────────────────────────────────

test("account executive → sales (strong anchor)", () => {
  const r = classifyTitle("Account Executive");
  assert.equal(r.roleKey, "sales");
  assert.ok(r.confidence >= 0.7, `confidence should be >= 0.7, got ${r.confidence}`);
  assert.equal(r.matchedBy, "strong_anchor");
});

test("enterprise account executive → sales", () => {
  const r = classifyTitle("Enterprise Account Executive");
  assert.equal(r.roleKey, "sales");
  assert.ok(r.confidence >= 0.7);
});

test("customer success manager → sales", () => {
  const r = classifyTitle("Customer Success Manager");
  assert.equal(r.roleKey, "sales");
  assert.ok(r.confidence >= 0.7);
});

test("sales development representative → sales", () => {
  const r = classifyTitle("Sales Development Representative");
  assert.equal(r.roleKey, "sales");
  assert.ok(r.confidence >= 0.7);
});

test("bdr → sales", () => {
  const r = classifyTitle("BDR");
  assert.equal(r.roleKey, "sales");
  assert.ok(r.confidence >= 0.7);
});

test("sdr → sales", () => {
  const r = classifyTitle("SDR");
  assert.equal(r.roleKey, "sales");
  assert.ok(r.confidence >= 0.7);
});

test("revenue operations manager → sales", () => {
  const r = classifyTitle("Revenue Operations Manager");
  // strong anchor 'revenue operations' fires → sales
  assert.equal(r.roleKey, "sales");
});

test("solutions engineer → sales (not engineering)", () => {
  const r = classifyTitle("Solutions Engineer");
  assert.equal(r.roleKey, "sales");
  assert.notEqual(r.roleKey, "engineering");
});

test("sales engineer → sales (not engineering)", () => {
  const r = classifyTitle("Sales Engineer");
  assert.equal(r.roleKey, "sales");
  assert.notEqual(r.roleKey, "engineering");
});

test("partnerships manager → sales", () => {
  const r = classifyTitle("Partnerships Manager");
  assert.equal(r.roleKey, "sales");
  assert.ok(r.confidence >= 0.7);
});

test("vp of sales → sales", () => {
  const r = classifyTitle("VP of Sales");
  assert.equal(r.roleKey, "sales");
  assert.ok(r.confidence >= 0.7);
});

test("senior sales manager → sales", () => {
  const r = classifyTitle("Senior Sales Manager");
  assert.equal(r.roleKey, "sales");
  assert.ok(r.confidence >= 0.7);
});

test("classifyForIngest: account executive meets ingest threshold", () => {
  const r = classifyForIngest("Account Executive", "");
  assert.ok(r !== null, "account executive must meet ingest confidence threshold");
  assert.equal(r.roleKey, "sales");
  assert.ok(r.confidence >= INGEST_CONFIDENCE_THRESHOLD);
});

test("classifyForIngest: customer success manager meets ingest threshold", () => {
  const r = classifyForIngest("Customer Success Manager", "");
  assert.ok(r !== null);
  assert.equal(r.roleKey, "sales");
  assert.ok(r.confidence >= INGEST_CONFIDENCE_THRESHOLD);
});

// ── No taxonomy regression — re-exports still work ───────────

test("re-exported classifyTitle still classifies firmware correctly", () => {
  const r = classifyTitle("Firmware Engineer");
  assert.equal(r.roleKey, "engineering_embedded_firmware");
  assert.ok(r.confidence >= 0.7);
});

test("re-exported classifyTitle still classifies data correctly", () => {
  const r = classifyTitle("Machine Learning Engineer");
  assert.equal(r.roleKey, "data");
  assert.ok(r.confidence >= 0.7);
});

test("re-exported getRoleKeyForProfile still works", () => {
  assert.equal(getRoleKeyForProfile({ role_family: "data", domain: "data" }), "data");
  assert.equal(getRoleKeyForProfile(null), "general");
});

test("re-exported getRoleFamilyDomainForKey still works for sales", () => {
  const { role_family, domain } = getRoleFamilyDomainForKey("sales");
  assert.equal(role_family, "sales");
  assert.equal(domain, "sales");
});

test("INGEST_CONFIDENCE_THRESHOLD still 0.75", () => {
  assert.equal(INGEST_CONFIDENCE_THRESHOLD, 0.75);
});

// ── ROLE_TITLE_SQL includes sales ─────────────────────────────

test("ROLE_TITLE_SQL.sales exists with include patterns", () => {
  assert.ok(ROLE_TITLE_SQL.sales, "ROLE_TITLE_SQL must have a sales entry");
  assert.ok(ROLE_TITLE_SQL.sales.includes.length > 0, "sales includes must be non-empty");
});

test("ROLE_TITLE_SQL.sales includes key sales patterns", () => {
  const inc = ROLE_TITLE_SQL.sales.includes.join("|");
  assert.ok(inc.includes("account executive"), "must include account executive");
  assert.ok(inc.includes("customer success"),  "must include customer success");
  assert.ok(inc.includes("business development"), "must include business development");
});
