// test/jobClassifier.test.js — Unit tests for the modular job classification engine
// Tests the signal registry, scoring logic, and SQL pattern coverage in
// services/jobClassifier.js.  Does NOT hit the DB or make LLM calls.

import test from "node:test";
import assert from "node:assert/strict";
import { classifyTitle, getRoleKeyForProfile, ROLE_TITLE_SQL, classifyForIngest, getRoleFamilyDomainForKey, INGEST_CONFIDENCE_THRESHOLD } from "../services/jobClassifier.js";

// ── classifyTitle: firmware / embedded ───────────────────────

test("firmware engineer → engineering_embedded_firmware (strong anchor)", () => {
  const r = classifyTitle("Firmware Engineer");
  assert.equal(r.roleKey, "engineering_embedded_firmware");
  assert.ok(r.confidence >= 0.7, `confidence should be >= 0.7, got ${r.confidence}`);
  assert.equal(r.matchedBy, "strong_anchor");
});

test("embedded systems engineer → engineering_embedded_firmware", () => {
  const r = classifyTitle("Senior Embedded Systems Engineer");
  assert.equal(r.roleKey, "engineering_embedded_firmware");
  assert.ok(r.confidence >= 0.7);
});

test("bsp engineer → engineering_embedded_firmware", () => {
  const r = classifyTitle("BSP Engineer");
  assert.equal(r.roleKey, "engineering_embedded_firmware");
  assert.ok(r.confidence >= 0.7);
});

test("uefi engineer → engineering_embedded_firmware", () => {
  const r = classifyTitle("UEFI Engineer");
  assert.equal(r.roleKey, "engineering_embedded_firmware");
  assert.ok(r.confidence >= 0.7);
});

test("device driver developer → engineering_embedded_firmware", () => {
  const r = classifyTitle("Device Driver Developer");
  assert.equal(r.roleKey, "engineering_embedded_firmware");
  assert.ok(r.confidence >= 0.7);
});

// ── classifyTitle: data / AI / ML ────────────────────────────

test("machine learning engineer → data (strong anchor)", () => {
  const r = classifyTitle("Machine Learning Engineer");
  assert.equal(r.roleKey, "data");
  assert.ok(r.confidence >= 0.7);
  assert.equal(r.matchedBy, "strong_anchor");
});

test("data scientist → data", () => {
  const r = classifyTitle("Senior Data Scientist");
  assert.equal(r.roleKey, "data");
  assert.ok(r.confidence >= 0.7);
});

test("data engineer → data", () => {
  const r = classifyTitle("Data Engineer");
  assert.equal(r.roleKey, "data");
  assert.ok(r.confidence >= 0.7);
});

test("ai engineer → data", () => {
  const r = classifyTitle("AI Engineer");
  assert.equal(r.roleKey, "data");
  assert.ok(r.confidence >= 0.7);
});

test("analytics engineer → data", () => {
  const r = classifyTitle("Analytics Engineer");
  assert.equal(r.roleKey, "data");
  assert.ok(r.confidence >= 0.7);
});

test("llm engineer → data", () => {
  const r = classifyTitle("LLM Engineer");
  assert.equal(r.roleKey, "data");
  assert.ok(r.confidence >= 0.7);
});

// ── classifyTitle: PM ─────────────────────────────────────────

test("product manager → pm (strong anchor)", () => {
  const r = classifyTitle("Senior Product Manager");
  assert.equal(r.roleKey, "pm");
  assert.ok(r.confidence >= 0.7);
  assert.equal(r.matchedBy, "strong_anchor");
});

test("program manager → pm", () => {
  const r = classifyTitle("Technical Program Manager");
  assert.equal(r.roleKey, "pm");
  assert.ok(r.confidence >= 0.7);
});

test("scrum master → pm", () => {
  const r = classifyTitle("Scrum Master");
  assert.equal(r.roleKey, "pm");
  assert.ok(r.confidence >= 0.7);
});

test("product designer should NOT → pm (exclusion)", () => {
  const r = classifyTitle("Senior Product Designer");
  // product designer must route to design, not pm
  assert.notEqual(r.roleKey, "pm");
});

// ── classifyTitle: engineering (SWE) ─────────────────────────

test("software engineer → engineering (strong anchor)", () => {
  const r = classifyTitle("Senior Software Engineer");
  assert.equal(r.roleKey, "engineering");
  assert.ok(r.confidence >= 0.7);
  assert.equal(r.matchedBy, "strong_anchor");
});

test("backend engineer → engineering", () => {
  const r = classifyTitle("Backend Engineer");
  assert.equal(r.roleKey, "engineering");
  assert.ok(r.confidence >= 0.7);
});

test("devops engineer → engineering", () => {
  const r = classifyTitle("DevOps Engineer");
  assert.equal(r.roleKey, "engineering");
  assert.ok(r.confidence >= 0.7);
});

// ── SWE must NOT be catch-all ─────────────────────────────────

test("firmware engineer does NOT route to engineering (exclusion wins)", () => {
  const r = classifyTitle("Firmware Engineer");
  assert.notEqual(r.roleKey, "engineering");
});

test("machine learning engineer does NOT route to engineering (exclusion wins)", () => {
  const r = classifyTitle("Machine Learning Engineer");
  assert.notEqual(r.roleKey, "engineering");
});

test("data scientist does NOT route to engineering (exclusion wins)", () => {
  const r = classifyTitle("Data Scientist");
  assert.notEqual(r.roleKey, "engineering");
});

test("project manager does NOT route to engineering (exclusion wins)", () => {
  const r = classifyTitle("Project Manager");
  assert.notEqual(r.roleKey, "engineering");
});

test("product manager does NOT route to engineering (exclusion wins)", () => {
  const r = classifyTitle("Product Manager");
  assert.notEqual(r.roleKey, "engineering");
});

// ── classifyTitle: HR ─────────────────────────────────────────

test("recruiter → hr", () => {
  const r = classifyTitle("Technical Recruiter");
  assert.equal(r.roleKey, "hr");
  assert.ok(r.confidence >= 0.7);
});

test("talent acquisition specialist → hr", () => {
  const r = classifyTitle("Talent Acquisition Specialist");
  assert.equal(r.roleKey, "hr");
  assert.ok(r.confidence >= 0.7);
});

test("hr business partner → hr", () => {
  const r = classifyTitle("HR Business Partner");
  assert.equal(r.roleKey, "hr");
  assert.ok(r.confidence >= 0.7);
});

test("compensation analyst → hr", () => {
  const r = classifyTitle("Compensation Analyst");
  assert.equal(r.roleKey, "hr");
  assert.ok(r.confidence >= 0.7);
});

// ── classifyTitle: finance ────────────────────────────────────

test("financial analyst → finance", () => {
  const r = classifyTitle("Senior Financial Analyst");
  assert.equal(r.roleKey, "finance");
  assert.ok(r.confidence >= 0.7);
});

test("fp&a analyst → finance", () => {
  const r = classifyTitle("FP&A Analyst");
  assert.equal(r.roleKey, "finance");
  assert.ok(r.confidence >= 0.7);
});

test("investment banking analyst → finance", () => {
  const r = classifyTitle("Investment Banking Analyst");
  assert.equal(r.roleKey, "finance");
  assert.ok(r.confidence >= 0.7);
});

// ── classifyTitle: design ─────────────────────────────────────

test("ux designer → design", () => {
  const r = classifyTitle("Senior UX Designer");
  assert.equal(r.roleKey, "design");
  assert.ok(r.confidence >= 0.7);
});

test("product designer → design (not pm)", () => {
  const r = classifyTitle("Product Designer");
  assert.equal(r.roleKey, "design");
  assert.notEqual(r.roleKey, "pm");
});

test("ux researcher → design", () => {
  const r = classifyTitle("UX Researcher");
  assert.equal(r.roleKey, "design");
  assert.ok(r.confidence >= 0.7);
});

// ── classifyTitle: marketing ──────────────────────────────────

test("marketing manager → marketing", () => {
  const r = classifyTitle("Senior Marketing Manager");
  assert.equal(r.roleKey, "marketing");
  assert.ok(r.confidence >= 0.7);
});

test("seo specialist → marketing", () => {
  const r = classifyTitle("SEO Specialist");
  assert.equal(r.roleKey, "marketing");
  assert.ok(r.confidence >= 0.7);
});

test("product marketing manager → marketing", () => {
  const r = classifyTitle("Product Marketing Manager");
  assert.equal(r.roleKey, "marketing");
  assert.ok(r.confidence >= 0.7);
});

// ── classifyTitle: legal ──────────────────────────────────────

test("attorney → legal", () => {
  const r = classifyTitle("Associate Attorney");
  assert.equal(r.roleKey, "legal");
  assert.ok(r.confidence >= 0.7);
});

test("compliance officer → legal", () => {
  const r = classifyTitle("Compliance Officer");
  assert.equal(r.roleKey, "legal");
  assert.ok(r.confidence >= 0.7);
});

// ── classifyTitle: operations ─────────────────────────────────

test("supply chain manager → operations", () => {
  const r = classifyTitle("Supply Chain Manager");
  assert.equal(r.roleKey, "operations");
  assert.ok(r.confidence >= 0.7);
});

test("logistics coordinator → operations", () => {
  const r = classifyTitle("Logistics Coordinator");
  assert.equal(r.roleKey, "operations");
  assert.ok(r.confidence >= 0.7);
});

// ── classifyTitle: healthcare ─────────────────────────────────

test("registered nurse → healthcare", () => {
  const r = classifyTitle("Registered Nurse");
  assert.equal(r.roleKey, "healthcare");
  assert.ok(r.confidence >= 0.7);
});

test("physical therapist → healthcare", () => {
  const r = classifyTitle("Physical Therapist");
  assert.equal(r.roleKey, "healthcare");
  assert.ok(r.confidence >= 0.7);
});

// ── Low-confidence / unclassified ────────────────────────────

test("vague technical title does not silently become SWE", () => {
  // "Technical Specialist" has no strong SWE anchors — should be weak/unclassified
  const r = classifyTitle("Technical Specialist");
  // If it does classify, it must not be a high-confidence SWE result
  if (r.roleKey === "engineering") {
    assert.ok(r.confidence < 0.65, "Ambiguous title must not get high-confidence SWE assignment");
  }
});

test("unrecognized title returns unclassified or low confidence", () => {
  const r = classifyTitle("Banana Peeler Coordinator III");
  assert.ok(
    r.roleKey === "unclassified" || r.confidence < 0.65,
    `Expected unclassified or low confidence, got ${r.roleKey} @ ${r.confidence}`
  );
});

test("broad skills alone (Python, SQL, cloud) do not force a classification", () => {
  // Description contains many shared-skill keywords but no strong anchor in title
  const r = classifyTitle("Specialist", "Python SQL cloud APIs automation testing CI/CD dashboards");
  assert.ok(
    r.roleKey === "unclassified" || r.confidence < 0.65,
    `Shared skills alone must not produce high-confidence classification: ${r.roleKey} @ ${r.confidence}`
  );
});

// ── getRoleKeyForProfile ──────────────────────────────────────

test("getRoleKeyForProfile: firmware domain → engineering_embedded_firmware", () => {
  const key = getRoleKeyForProfile({ role_family: "engineering", domain: "engineering_embedded_firmware" });
  assert.equal(key, "engineering_embedded_firmware");
});

test("getRoleKeyForProfile: standard SWE → engineering", () => {
  const key = getRoleKeyForProfile({ role_family: "engineering", domain: "it_digital" });
  assert.equal(key, "engineering");
});

test("getRoleKeyForProfile: data profile → data", () => {
  const key = getRoleKeyForProfile({ role_family: "data", domain: "data" });
  assert.equal(key, "data");
});

test("getRoleKeyForProfile: pm profile → pm", () => {
  const key = getRoleKeyForProfile({ role_family: "pm", domain: "pm_it" });
  assert.equal(key, "pm");
});

test("getRoleKeyForProfile: hr profile → hr", () => {
  const key = getRoleKeyForProfile({ role_family: "hr", domain: "hr" });
  assert.equal(key, "hr");
});

test("getRoleKeyForProfile: null profile → general", () => {
  const key = getRoleKeyForProfile(null);
  assert.equal(key, "general");
});

// ── ROLE_TITLE_SQL pattern coverage ──────────────────────────

test("ROLE_TITLE_SQL.engineering includes standard SWE patterns", () => {
  const { includes } = ROLE_TITLE_SQL.engineering;
  assert.ok(includes.some(p => p.includes("engineer")));
  assert.ok(includes.some(p => p.includes("developer")));
  assert.ok(includes.some(p => p.includes("software")));
});

test("ROLE_TITLE_SQL.engineering excludes firmware, ML, PM specialty anchors", () => {
  const { excludes } = ROLE_TITLE_SQL.engineering;
  const exStr = excludes.join("|");
  assert.ok(exStr.includes("firmware"),           "must exclude firmware");
  assert.ok(exStr.includes("embedded"),           "must exclude embedded");
  assert.ok(exStr.includes("bsp"),                "must exclude bsp");
  assert.ok(exStr.includes("machine learning"),   "must exclude machine learning");
  assert.ok(exStr.includes("data scientist"),     "must exclude data scientist");
  assert.ok(exStr.includes("data engineer"),      "must exclude data engineer");
  assert.ok(exStr.includes("analytics engineer"), "must exclude analytics engineer");
  assert.ok(exStr.includes("project manager"),    "must exclude project manager");
  assert.ok(exStr.includes("product manager"),    "must exclude product manager");
});

test("ROLE_TITLE_SQL.engineering_embedded_firmware includes firmware anchors", () => {
  const { includes } = ROLE_TITLE_SQL.engineering_embedded_firmware;
  const incStr = includes.join("|");
  assert.ok(incStr.includes("firmware"));
  assert.ok(incStr.includes("embedded"));
  assert.ok(incStr.includes("bsp"));
  assert.ok(incStr.includes("silicon validation"));
  assert.ok(incStr.includes("bootloader"));
  assert.ok(incStr.includes("rtos"));
  assert.ok(incStr.includes("uefi"));
  assert.ok(incStr.includes("hardware debug"));
});

test("ROLE_TITLE_SQL.pm excludes product designer and cross-domain directors", () => {
  const { excludes } = ROLE_TITLE_SQL.pm;
  const exStr = excludes.join("|");
  assert.ok(exStr.includes("product designer"), "must exclude product designer");
  assert.ok(exStr.includes("creative director"), "must exclude creative director");
  assert.ok(exStr.includes("design director"),  "must exclude design director");
});

test("ROLE_TITLE_SQL.data uses specific multi-word patterns (not bare %ai%)", () => {
  const { includes } = ROLE_TITLE_SQL.data;
  const incStr = includes.join("|");
  assert.ok(incStr.includes("data scientist"),  "must include data scientist");
  assert.ok(incStr.includes("machine learning"),"must include machine learning");
  // Verify bare '%ai%' is NOT present (too broad — catches 'retail', 'supply chain', etc.)
  assert.ok(!includes.includes("%ai%"), "bare %ai% must not be in data includes — use %ai engineer% instead");
});

test("ROLE_TITLE_SQL covers all primary role families", () => {
  const families = [
    "engineering", "engineering_embedded_firmware",
    "pm", "data", "hr", "finance", "design",
    "marketing", "legal", "operations", "healthcare",
  ];
  for (const f of families) {
    assert.ok(
      ROLE_TITLE_SQL[f]?.includes?.length > 0,
      `ROLE_TITLE_SQL.${f} must have at least one include pattern`
    );
  }
});

// ── classifyForIngest ─────────────────────────────────────────

test("classifyForIngest returns result for high-confidence firmware title", () => {
  const result = classifyForIngest("Firmware Engineer", "");
  assert.ok(result !== null, "should return result for a clear firmware title");
  assert.equal(result.roleKey, "engineering_embedded_firmware");
  assert.ok(result.confidence >= INGEST_CONFIDENCE_THRESHOLD);
});

test("classifyForIngest returns result for high-confidence SWE title", () => {
  const result = classifyForIngest("Senior Software Engineer", "");
  assert.ok(result !== null);
  assert.equal(result.roleKey, "engineering");
  assert.ok(result.confidence >= INGEST_CONFIDENCE_THRESHOLD);
});

test("classifyForIngest returns null for vague/ambiguous title", () => {
  // "Technical Specialist" has no strong anchors — should fall below threshold
  const result = classifyForIngest("Technical Specialist", "");
  assert.ok(
    result === null || result.confidence < INGEST_CONFIDENCE_THRESHOLD,
    `Ambiguous title must not meet ingest threshold, got ${result?.confidence}`
  );
});

test("classifyForIngest returns null for fully unrecognized title", () => {
  const result = classifyForIngest("Banana Peeler Coordinator III", "");
  assert.equal(result, null, "Unrecognized title must return null from classifyForIngest");
});

test("classifyForIngest: description anchors can push confident title over threshold", () => {
  // "Software Engineer" title with strong firmware description anchors
  // — firmware description anchors should NOT override the title's engineering routing
  const firmwareDesc = "working with JTAG, TRACE32, and Lauterbach debuggers; ARM Cortex; Yocto";
  const r = classifyForIngest("Firmware Engineer", firmwareDesc);
  assert.ok(r !== null, "Firmware Engineer + firmware desc should exceed ingest threshold");
  assert.equal(r.roleKey, "engineering_embedded_firmware");
});

test("classifyForIngest: data scientist title meets threshold with dbt/BigQuery desc", () => {
  const desc = "You will use dbt and BigQuery; model training; feature engineering with Airflow";
  const r = classifyForIngest("Data Scientist", desc);
  assert.ok(r !== null);
  assert.equal(r.roleKey, "data");
  assert.ok(r.confidence >= INGEST_CONFIDENCE_THRESHOLD);
  assert.ok(r.matchedBy === "strong_anchor+desc" || r.matchedBy === "strong_anchor");
});

test("INGEST_CONFIDENCE_THRESHOLD is 0.75", () => {
  assert.equal(INGEST_CONFIDENCE_THRESHOLD, 0.75);
});

// ── Description-anchor scoring ────────────────────────────────

test("firmware title with firmware desc anchors has higher confidence than title alone", () => {
  const titleOnly = classifyTitle("Firmware Engineer", "");
  const withDesc  = classifyTitle("Firmware Engineer",
    "JTAG, TRACE32, Lauterbach, ARM Cortex M4, Yocto, FreeRTOS, device tree");
  assert.ok(withDesc.confidence >= titleOnly.confidence,
    "Description anchors should not decrease confidence");
});

test("data title with data desc anchors (dbt, BigQuery, Snowflake) has boosted confidence", () => {
  const titleOnly = classifyTitle("Data Scientist", "");
  const withDesc  = classifyTitle("Data Scientist",
    "Using dbt, BigQuery, Snowflake, Airflow, MLflow, feature store, embeddings");
  assert.ok(withDesc.confidence >= titleOnly.confidence);
  assert.equal(withDesc.matchedBy, "strong_anchor+desc");
});

test("PM title with roadmap/OKR desc anchors has boosted confidence", () => {
  const titleOnly = classifyTitle("Product Manager", "");
  const withDesc  = classifyTitle("Product Manager",
    "Define roadmap, sprint planning, stakeholder alignment, OKR tracking, PRD writing");
  assert.ok(withDesc.confidence >= titleOnly.confidence);
});

test("description anchors alone (no title hit) give desc_anchor_only matchedBy", () => {
  // A vague title + 2+ description anchors
  const r = classifyTitle("Specialist",
    "Using dbt, BigQuery, Snowflake data warehouse, feature engineering, airflow pipeline");
  if (r.roleKey === "data") {
    assert.equal(r.matchedBy, "desc_anchor_only");
    assert.ok(r.confidence >= 0.55 && r.confidence < INGEST_CONFIDENCE_THRESHOLD,
      "desc_anchor_only must be below ingest threshold");
  }
  // desc_anchor_only must never be assigned at ingest
  const ingestResult = classifyForIngest("Specialist",
    "dbt, BigQuery, Snowflake, feature store, Airflow, embeddings");
  assert.equal(ingestResult, null,
    "desc_anchor_only confidence must be below ingest threshold");
});

test("firmware description anchors do NOT make SWE title route to firmware", () => {
  // A SWE title paired with firmware description should stay as engineering
  const r = classifyTitle("Software Engineer",
    "JTAG, TRACE32, ARM Cortex, Yocto, device tree, bootloader, FreeRTOS");
  // engineering exclusions block firmware, so the SWE title should still win as engineering
  // (description anchors can boost but not override exclusion rules)
  assert.notEqual(r.roleKey, "engineering_embedded_firmware",
    "SWE title must not become firmware due to description anchors alone");
});

// ── getRoleFamilyDomainForKey ─────────────────────────────────

test("getRoleFamilyDomainForKey: engineering → it_digital domain", () => {
  const { role_family, domain } = getRoleFamilyDomainForKey("engineering");
  assert.equal(role_family, "engineering");
  assert.equal(domain, "it_digital");
});

test("getRoleFamilyDomainForKey: engineering_embedded_firmware → correct family+domain", () => {
  const { role_family, domain } = getRoleFamilyDomainForKey("engineering_embedded_firmware");
  assert.equal(role_family, "engineering");
  assert.equal(domain, "engineering_embedded_firmware");
});

test("getRoleFamilyDomainForKey: data → data/data", () => {
  const { role_family, domain } = getRoleFamilyDomainForKey("data");
  assert.equal(role_family, "data");
  assert.equal(domain, "data");
});

test("getRoleFamilyDomainForKey: pm → pm/pm", () => {
  const { role_family, domain } = getRoleFamilyDomainForKey("pm");
  assert.equal(role_family, "pm");
  assert.equal(domain, "pm");
});

test("getRoleFamilyDomainForKey: hr → hr/hr", () => {
  const { role_family, domain } = getRoleFamilyDomainForKey("hr");
  assert.equal(role_family, "hr");
  assert.equal(domain, "hr");
});

test("getRoleFamilyDomainForKey: finance → finance/finance", () => {
  const { role_family, domain } = getRoleFamilyDomainForKey("finance");
  assert.equal(role_family, "finance");
  assert.equal(domain, "finance");
});
