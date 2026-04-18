import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveSimpleApplyProfile,
  localAtsScore,
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

test("local ATS score prefers matching Simple Apply pooled jobs", () => {
  const profile = deriveSimpleApplyProfile("Software Engineer React Node TypeScript AWS SQL");
  const matching = localAtsScore({
    title: "Senior Software Engineer",
    description: "React Node TypeScript AWS SQL backend APIs",
    search_query: "software engineer",
    employment_type: "full-time",
    work_type: "remote",
    scraped_at: Math.floor(Date.now() / 1000),
    ghost_score: 0,
  }, profile, "engineering");
  const weak = localAtsScore({
    title: "Project Coordinator",
    description: "vendor schedules and office administration",
    search_query: "project coordinator",
    employment_type: "full-time",
    scraped_at: Math.floor(Date.now() / 1000),
    ghost_score: 3,
  }, profile, "engineering");
  assert.ok(matching > weak);
});

test("local ATS score does not let generic overlap beat a strong title match", () => {
  const profile = deriveSimpleApplyProfile("Software Engineer React Node TypeScript AWS SQL Agile Jira leadership");
  const strongTitle = localAtsScore({
    title: "Software Engineer",
    description: "backend services and APIs",
    search_query: "software engineer",
    employment_type: "full-time",
    work_type: "hybrid",
    scraped_at: Math.floor(Date.now() / 1000),
    ghost_score: 0,
  }, profile, "engineering");
  const broadOverlap = localAtsScore({
    title: "Project Manager",
    description: "Agile Jira leadership stakeholder communication strategy",
    search_query: "project manager",
    employment_type: "full-time",
    work_type: "remote",
    scraped_at: Math.floor(Date.now() / 1000),
    ghost_score: 0,
  }, profile, "engineering");
  assert.ok(strongTitle > broadOverlap);
});
