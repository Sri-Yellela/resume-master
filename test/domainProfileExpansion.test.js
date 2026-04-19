import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { normaliseRole, buildApifyQueries } from "../services/searchQueryBuilder.js";

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
  for (const tool of ["JTAG", "OpenOCD", "TRACE32", "RTOS"]) {
    assert.ok(embeddedTools.includes(tool), `${tool} should seed firmware profiles`);
  }
});

test("role aliases cover low-level and debug-oriented engineering searches", () => {
  assert.equal(normaliseRole("firmware"), "Firmware Engineer");
  assert.equal(normaliseRole("bsp"), "BSP Engineer");
  assert.equal(normaliseRole("soc bring-up"), "SoC Bring-Up Engineer");
  assert.equal(normaliseRole("compiler engineer"), "Compiler Engineer");

  assert.equal(aliases["hardware debug"].domain, "engineering_embedded_firmware");
  assert.equal(aliases["performance engineer"].domain, "engineering_systems_low_level");

  const firmwareQueries = buildApifyQueries("Firmware Engineer");
  assert.ok(firmwareQueries.includes("Embedded Software Engineer"));
  assert.ok(firmwareQueries.includes("Firmware Developer"));
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
