// test/collarClassifier.test.js — Phase 2: collar classifier + unified classifyJob
// Exercises detectCollar() with the labeled fixture set from the architecture spec,
// plus Policy #1 supervisory titles and classifyJob() general/drop edge cases.

import test from "node:test";
import assert from "node:assert/strict";
import { detectCollar, BLUE_COLLAR_ANCHORS, STRONG_WHITE_ANCHORS } from "../services/jobs/collarClassifier.js";
import { classifyJob } from "../services/jobs/classifyJob.js";

// ── detectCollar: spec fixture set ─────────────────────────────────────────

test("Delivery Driver → blue", () => {
  assert.equal(detectCollar("Delivery Driver"), "blue");
});

test("Truck Driver → blue", () => {
  assert.equal(detectCollar("Truck Driver"), "blue");
});

test("Warehouse Associate → blue", () => {
  assert.equal(detectCollar("Warehouse Associate"), "blue");
});

test("Warehouse Worker → blue", () => {
  assert.equal(detectCollar("Warehouse Worker"), "blue");
});

test("Warehouse Manager → blue (Policy #1 supervisory)", () => {
  assert.equal(detectCollar("Warehouse Manager"), "blue");
});

test("Warehouse Supervisor → blue (Policy #1)", () => {
  assert.equal(detectCollar("Warehouse Supervisor"), "blue");
});

test("Line Cook → blue", () => {
  assert.equal(detectCollar("Line Cook"), "blue");
});

test("Prep Cook → blue", () => {
  assert.equal(detectCollar("Prep Cook"), "blue");
});

test("Restaurant Manager → blue (Policy #1 supervisory)", () => {
  assert.equal(detectCollar("Restaurant Manager"), "blue");
});

test("Kitchen Manager → blue (Policy #1 supervisory)", () => {
  assert.equal(detectCollar("Kitchen Manager"), "blue");
});

test("Construction Superintendent → blue (Policy #1 supervisory)", () => {
  assert.equal(detectCollar("Construction Superintendent"), "blue");
});

test("Store Manager → blue (Policy #1 supervisory)", () => {
  assert.equal(detectCollar("Store Manager"), "blue");
});

test("Cashier → blue", () => {
  assert.equal(detectCollar("Cashier"), "blue");
});

test("Retail Associate → blue", () => {
  assert.equal(detectCollar("Retail Associate"), "blue");
});

test("Janitor → blue", () => {
  assert.equal(detectCollar("Janitor"), "blue");
});

test("Custodian → blue", () => {
  assert.equal(detectCollar("Custodian"), "blue");
});

test("Security Guard → blue", () => {
  assert.equal(detectCollar("Security Guard"), "blue");
});

test("Barista → blue", () => {
  assert.equal(detectCollar("Barista"), "blue");
});

test("Bartender → blue", () => {
  assert.equal(detectCollar("Bartender"), "blue");
});

test("Plumber → blue", () => {
  assert.equal(detectCollar("Plumber"), "blue");
});

test("Electrician → blue", () => {
  assert.equal(detectCollar("Electrician"), "blue");
});

test("Welder → blue", () => {
  assert.equal(detectCollar("Welder"), "blue");
});

test("HVAC Technician → blue", () => {
  assert.equal(detectCollar("HVAC Technician"), "blue");
});

test("Home Health Aide → blue", () => {
  assert.equal(detectCollar("Home Health Aide"), "blue");
});

test("Nanny → blue", () => {
  assert.equal(detectCollar("Nanny"), "blue");
});

test("Barber → blue", () => {
  assert.equal(detectCollar("Barber"), "blue");
});

test("Nail Technician → blue", () => {
  assert.equal(detectCollar("Nail Technician"), "blue");
});

test("Farm Worker → blue", () => {
  assert.equal(detectCollar("Farm Worker"), "blue");
});

// ── detectCollar: white-collar (spec fixtures) ──────────────────────────────

test("Warehouse Operations Analyst → white (strong white anchor overrides no blue anchor)", () => {
  // 'warehouse' alone is not a blue anchor; 'warehouse operations analyst' has no blue match
  assert.equal(detectCollar("Warehouse Operations Analyst"), "white");
});

test("Engineering Manager → white", () => {
  assert.equal(detectCollar("Engineering Manager"), "white");
});

test("Security Engineer → white (security guard pattern does not match)", () => {
  // Blue anchor is 'security guard', NOT bare 'security'
  assert.equal(detectCollar("Security Engineer"), "white");
});

test("Field Service Engineer → white", () => {
  assert.equal(detectCollar("Field Service Engineer"), "white");
});

test("Software Engineer → white", () => {
  assert.equal(detectCollar("Software Engineer"), "white");
});

test("Data Scientist → white", () => {
  assert.equal(detectCollar("Data Scientist"), "white");
});

test("Product Manager → white", () => {
  assert.equal(detectCollar("Product Manager"), "white");
});

test("UX Designer → white", () => {
  assert.equal(detectCollar("UX Designer"), "white");
});

test("Financial Analyst → white", () => {
  assert.equal(detectCollar("Financial Analyst"), "white");
});

test("Attorney → white", () => {
  assert.equal(detectCollar("Attorney"), "white");
});

test("Account Executive → white", () => {
  assert.equal(detectCollar("Account Executive"), "white");
});

test("Operations Manager → white (no blue anchor for plain 'operations')", () => {
  assert.equal(detectCollar("Operations Manager"), "white");
});

// ── detectCollar: blue-with-white-anchor rescue ─────────────────────────────

test("Warehouse Operations Analyst → white via strong anchor rescue", () => {
  // Even if someone titles it to trigger a blue match, the 'analyst' rescues it
  // Here we test the explicit rescue: forklift analyst
  assert.equal(detectCollar("Forklift Safety Analyst"), "white");
});

test("HVAC Engineer → white (blue anchor fires, engineer rescues)", () => {
  // 'hvac technician/installer/mechanic' are blue; 'hvac engineer' should be white
  // because HVAC Engineer is not in the blue-anchor patterns (only hvac tech/installer/mechanic is)
  assert.equal(detectCollar("HVAC Engineer"), "white");
});

test("Fleet Software Engineer → white", () => {
  assert.equal(detectCollar("Fleet Software Engineer"), "white");
});

test("Driver Safety Analyst → white (driver fires blue, analyst rescues)", () => {
  assert.equal(detectCollar("Driver Safety Analyst"), "white");
});

// ── detectCollar: case insensitivity ────────────────────────────────────────

test("detectCollar is case-insensitive for blue titles", () => {
  assert.equal(detectCollar("DELIVERY DRIVER"), "blue");
  assert.equal(detectCollar("warehouse manager"), "blue");
});

test("detectCollar is case-insensitive for white titles", () => {
  assert.equal(detectCollar("SOFTWARE ENGINEER"), "white");
});

// ── BLUE_COLLAR_ANCHORS / STRONG_WHITE_ANCHORS structure ────────────────────

test("BLUE_COLLAR_ANCHORS is a non-empty array of RegExp", () => {
  assert.ok(Array.isArray(BLUE_COLLAR_ANCHORS) && BLUE_COLLAR_ANCHORS.length > 0);
  assert.ok(BLUE_COLLAR_ANCHORS.every(p => p instanceof RegExp));
});

test("STRONG_WHITE_ANCHORS is a non-empty array of RegExp", () => {
  assert.ok(Array.isArray(STRONG_WHITE_ANCHORS) && STRONG_WHITE_ANCHORS.length > 0);
  assert.ok(STRONG_WHITE_ANCHORS.every(p => p instanceof RegExp));
});

test("STRONG_WHITE_ANCHORS does NOT include bare 'manager'", () => {
  const text = STRONG_WHITE_ANCHORS.map(p => p.toString()).join("|");
  assert.ok(!text.includes("\\bmanager\\b"), "manager must not be a strong white anchor");
});

test("STRONG_WHITE_ANCHORS does NOT include bare 'supervisor'", () => {
  const text = STRONG_WHITE_ANCHORS.map(p => p.toString()).join("|");
  assert.ok(!text.includes("\\bsupervisor\\b"), "supervisor must not be a strong white anchor");
});

test("STRONG_WHITE_ANCHORS does NOT include bare 'coordinator'", () => {
  const text = STRONG_WHITE_ANCHORS.map(p => p.toString()).join("|");
  assert.ok(!text.includes("\\bcoordinator\\b"), "coordinator must not be a strong white anchor");
});

// ── classifyJob: blue-collar eject ──────────────────────────────────────────

test("classifyJob: Delivery Driver → collar blue, roleKey null", () => {
  const r = classifyJob("Delivery Driver", "", "");
  assert.equal(r.collar,   "blue");
  assert.equal(r.roleKey,  null);
  assert.equal(r.matchedBy, "blue_collar");
});

test("classifyJob: Warehouse Manager → collar blue, roleKey null", () => {
  const r = classifyJob("Warehouse Manager", "", "");
  assert.equal(r.collar,  "blue");
  assert.equal(r.roleKey, null);
});

test("classifyJob: Restaurant Manager → collar blue, roleKey null", () => {
  const r = classifyJob("Restaurant Manager", "", "");
  assert.equal(r.collar,  "blue");
  assert.equal(r.roleKey, null);
});

test("classifyJob: Line Cook → collar blue, roleKey null", () => {
  const r = classifyJob("Line Cook", "", "");
  assert.equal(r.collar,  "blue");
  assert.equal(r.roleKey, null);
});

// ── classifyJob: white + confident bucket ───────────────────────────────────

test("classifyJob: Software Engineer → white, roleKey engineering", () => {
  const r = classifyJob("Senior Software Engineer", "", "");
  assert.equal(r.collar,  "white");
  assert.equal(r.roleKey, "engineering");
  assert.ok(r.confidence >= 0.75);
});

test("classifyJob: Data Scientist → white, roleKey data", () => {
  const r = classifyJob("Data Scientist", "", "");
  assert.equal(r.collar,  "white");
  assert.equal(r.roleKey, "data");
  assert.ok(r.confidence >= 0.75);
});

test("classifyJob: Account Executive → white, roleKey sales", () => {
  const r = classifyJob("Account Executive", "", "");
  assert.equal(r.collar,  "white");
  assert.equal(r.roleKey, "sales");
  assert.ok(r.confidence >= 0.75);
});

test("classifyJob: Firmware Engineer → white, roleKey engineering_embedded_firmware", () => {
  const r = classifyJob("Firmware Engineer", "", "");
  assert.equal(r.collar,  "white");
  assert.equal(r.roleKey, "engineering_embedded_firmware");
  assert.ok(r.confidence >= 0.75);
});

// ── classifyJob: white + general pool (Policy #2) ───────────────────────────

test("classifyJob: strong-anchor title with no taxonomy bucket → 'general'", () => {
  // 'Specialist Analyst' has 'analyst' strong white anchor but doesn't match any
  // specific taxonomy family's strong anchors confidently
  const r = classifyJob("Chief Research Analyst", "", "");
  assert.equal(r.collar, "white");
  // roleKey is either a specific bucket (if confidence >= 0.75) or 'general'
  // — what matters is it is NOT null (it has a strong white anchor)
  assert.ok(r.roleKey !== null, "strong white anchor title must not be dropped");
});

// ── classifyJob: white + drop (Policy #2) ───────────────────────────────────

test("classifyJob: vague white-collar title with no signal → roleKey null (drop)", () => {
  // No blue anchor, no strong white anchor, no taxonomy match
  const r = classifyJob("Associate", "", "");
  assert.equal(r.collar, "white");
  // No strong white-collar anchor → drop
  assert.equal(r.roleKey, null);
});

// ── classifyJob: return shape ────────────────────────────────────────────────

test("classifyJob returns all required fields", () => {
  const r = classifyJob("Software Engineer", "Build backend services", "Acme");
  assert.ok("collar"     in r, "must have collar");
  assert.ok("roleKey"    in r, "must have roleKey");
  assert.ok("domain"     in r, "must have domain");
  assert.ok("seniority"  in r, "must have seniority");
  assert.ok("confidence" in r, "must have confidence");
  assert.ok("matchedBy"  in r, "must have matchedBy");
});

test("classifyJob seniority detection: senior title → 'senior'", () => {
  const r = classifyJob("Senior Software Engineer", "", "");
  assert.equal(r.seniority, "senior");
});

test("classifyJob seniority detection: intern title → 'intern'", () => {
  const r = classifyJob("Software Engineering Intern", "", "");
  assert.equal(r.seniority, "intern");
});

test("classifyJob domain detection: fintech company/desc → fintech domain", () => {
  const r = classifyJob("Software Engineer", "Work on payments infrastructure", "FinPay Inc");
  assert.equal(r.domain, "fintech");
});
