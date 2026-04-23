import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyMissingSignal, extractMissingSignals } from "../services/profileSignalAggregator.js";

test("ATS missing signals classify structured profile facts separately from skills", () => {
  const citizenship = classifyMissingSignal("U.S. citizenship");
  const clearance = classifyMissingSignal("TS/SCI");
  const react = classifyMissingSignal("React");

  assert.equal(citizenship?.kind, "structured_fact");
  assert.equal(citizenship?.field, "citizenshipStatus");
  assert.equal(clearance?.kind, "structured_fact");
  assert.equal(clearance?.field, "clearanceLevel");
  assert.equal(react?.kind, "skill");
  assert.equal(react?.label, "React");
});

test("ATS missing signal extraction deduplicates and keeps promotable items only", () => {
  const signals = extractMissingSignals({
    tier1_missing: ["React", "React", "U.S. citizenship", "communication"],
    action_verbs_missing: ["Architected"],
  });
  const labels = signals.map(item => item.label);

  assert.equal(labels.filter(label => label === "React").length, 1);
  assert.ok(labels.includes("U.S. citizenship"));
  assert.ok(!labels.includes("communication"));
});

test("profile enhancement architecture is wired through server routes and profile editor UI", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const routes = fs.readFileSync("routes/domainProfiles.js", "utf8");
  const panel = fs.readFileSync("client/src/panels/ProfilePanel.jsx", "utf8");

  assert.match(server, /CREATE TABLE IF NOT EXISTS profile_signal_suggestions/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS profile_resume_enhancements/);
  assert.match(server, /aggregateAtsMissingSignals\(db/);
  assert.match(server, /buildSelectedEnhancementSkills\(db/);
  assert.match(routes, /router\.put\("\/:id\/suggestions"/);
  assert.match(routes, /router\.get\("\/:id\/enhancement-history"/);
  assert.match(panel, /Inactive ATS-Suggested Skills/);
  assert.match(panel, /Selected For Enhancement/);
  assert.match(panel, /Structured ATS Facts Seen In Target Jobs/);
  assert.match(panel, /Enhance Base Resume/);
});
