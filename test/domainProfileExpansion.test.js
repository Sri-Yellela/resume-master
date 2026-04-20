import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { normaliseRole, buildApifyQueries, buildApifyQueriesFromProfile, buildProfileSearchTerms, isTitleRelevantToProfile } from "../services/searchQueryBuilder.js";

const registry = JSON.parse(fs.readFileSync("data/DOMAIN_METADATA_REGISTRY.json", "utf8"));
const aliases = JSON.parse(fs.readFileSync("data/ROLE_ALIAS_MAP.json", "utf8"));
const serverSource = fs.readFileSync("server.js", "utf8");
const routeSource = fs.readFileSync("routes/domainProfiles.js", "utf8");

test("engineering profile registry includes firmware, systems, specialist, and other request options", () => {
  assert.ok(registry.engineering_embedded_firmware);
  assert.ok(registry.engineering_systems_low_level);
  assert.ok(registry.engineering_specialist);
  assert.ok(registry.other_profile_request?.requestOnly);

  const embeddedTitles = registry.engineering_embedded_firmware.suggestedTitles;
  for (const title of [
    "Firmware Engineer",
    "Embedded Software Engineer",
    "Device Driver Engineer",
    "BSP Engineer",
    "SoC Bring-Up Engineer",
    "Post-Silicon Validation Engineer",
  ]) {
    assert.ok(embeddedTitles.includes(title), `${title} should be selectable`);
  }

  const embeddedTools = registry.engineering_embedded_firmware.tools;
  for (const tool of ["JTAG", "OpenOCD", "TRACE32", "T32", "Lauterbach", "LTB", "SPI", "I2C", "PCIe", "RTOS"]) {
    assert.ok(embeddedTools.includes(tool), `${tool} should seed firmware profiles`);
  }
  const embeddedKeywords = registry.engineering_embedded_firmware.keywords.join(" ");
  assert.match(embeddedKeywords, /Lauterbach TRACE32 debugging/);
  assert.match(embeddedKeywords, /PCIe debugging/);
});

test("role aliases cover low-level and debug-oriented engineering searches", () => {
  assert.equal(normaliseRole("firmware"), "Firmware Engineer");
  assert.equal(normaliseRole("bsp"), "BSP Engineer");
  assert.equal(normaliseRole("soc bring-up"), "SoC Bring-Up Engineer");
  assert.equal(normaliseRole("compiler engineer"), "Compiler Engineer");
  assert.equal(normaliseRole("trace32"), "Firmware Debug Engineer");
  assert.equal(normaliseRole("t32"), "Firmware Debug Engineer");
  assert.equal(normaliseRole("ltb"), "Firmware Debug Engineer");

  assert.equal(aliases["hardware debug"].domain, "engineering_embedded_firmware");
  assert.equal(aliases["pcie"].domain, "engineering_embedded_firmware");
  assert.equal(aliases["performance engineer"].domain, "engineering_systems_low_level");

  const firmwareQueries = buildApifyQueries("Firmware Engineer");
  assert.ok(firmwareQueries.includes("Embedded Software Engineer"));
  assert.ok(firmwareQueries.includes("Firmware Developer"));
});

test("firmware profile search terms stay title-like and precise", () => {
  const profile = {
    domain: "engineering_embedded_firmware",
    seniority: "senior",
    profile_name: "Firmware Engineer",
    target_titles: JSON.stringify([
      "Firmware Engineer",
      "Embedded Software Engineer",
      "Device Driver Engineer",
      "BSP Engineer",
      "Firmware Debug Engineer",
      "Hardware Debug Engineer",
      "Post-Silicon Validation Engineer",
    ]),
  };
  const profileQueries = buildApifyQueriesFromProfile(profile);
  assert.ok(profileQueries.includes("Firmware Engineer"));
  assert.ok(profileQueries.includes("Embedded Software Engineer"));
  assert.ok(profileQueries.length <= 6);
  assert.ok(!profileQueries.some(q => /^Senior /.test(q)), "firmware scrape should avoid seniority fan-out");

  const outbound = buildProfileSearchTerms(profile, ["C", "Python", "TRACE32", "JTAG", "Firmware Debug"]);
  assert.ok(outbound.includes("Firmware Engineer"));
  assert.ok(outbound.includes("Firmware Debug Engineer"));
  assert.ok(!outbound.includes("C"));
  assert.ok(!outbound.includes("Python"));
  assert.ok(outbound.length <= 6);
});

test("profile title relevance does not let tokenless skill terms match every job", () => {
  assert.equal(isTitleRelevantToProfile("Product Manager", ["C", "Python"]), false);
  assert.equal(isTitleRelevantToProfile("Firmware Debug Engineer", ["TRACE32 Engineer", "Firmware Debug Engineer"]), true);
});

test("ML and AI aliases map to Data instead of Engineering", () => {
  for (const key of ["mle", "ml engineer", "ml", "ai engineer", "genai", "llm"]) {
    assert.equal(aliases[key].roleFamily, "data");
    assert.equal(aliases[key].domain, "data");
  }
});

test("unsupported role request flow has backend storage and routes", () => {
  assert.match(serverSource, /CREATE TABLE IF NOT EXISTS domain_profile_requests/);
  assert.match(serverSource, /\/api\/admin\/domain-profile-requests/);
  assert.match(routeSource, /router\.post\("\/requests"/);
  assert.match(routeSource, /desired_title required/);
});
