import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveSimpleApplyProfile,
} from "../services/simpleApplyProfile.js";

test("Simple Apply profile is compact and high-signal", () => {
  const profile = deriveSimpleApplyProfile(`
    Senior Software Engineer with React, Node, TypeScript, AWS, Docker, Kubernetes,
    SQL, REST APIs, GraphQL, and backend platform experience.
  `);
  assert.ok(profile.titles.includes("software engineer"));
  assert.ok(profile.skills.includes("react"));
  assert.ok(profile.skills.includes("typescript"));
  assert.ok(profile.keywords.length <= 28);
  assert.ok(profile.searchTerms.length <= 8);
});

test("Simple Apply ATS search terms are capped and deduplicated", () => {
  const profile = deriveSimpleApplyProfile(`
    Software Engineer Software Engineer React React Node TypeScript AWS Docker Kubernetes
    GraphQL REST SQL PostgreSQL stakeholder stakeholder communication management support
    ${"Python ".repeat(40)}
  `, ["Software Engineer", "Software Engineer", "Backend Engineer"]);
  assert.ok(profile.titles.length <= 8);
  assert.ok(profile.skills.length <= 16);
  assert.ok(profile.keywords.length <= 28);
  assert.ok(profile.searchTerms.length <= 8);
  assert.equal(new Set(profile.searchTerms).size, profile.searchTerms.length);
  assert.doesNotMatch(profile.keywords.join(" "), /stakeholder|communication|management|support/);
});
