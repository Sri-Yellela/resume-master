import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAtsResumeBasis,
  deriveSimpleApplyProfile,
  loadOrCreateSimpleApplyProfile,
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

test("ATS resume basis includes stored user signals before resume text", () => {
  const basis = buildAtsResumeBasis("Built services in Node and React.", {
    titles: ["software engineer"],
    skills: ["node", "react"],
    keywords: ["backend", "api", "platform"],
    structuredFacts: {
      citizenshipStatus: "U.S. citizen",
      workAuthorization: "Authorized to work without sponsorship",
      hasClearance: true,
      clearanceLevel: "Secret",
    },
  });

  assert.match(basis, /STORED USER SIGNALS/);
  assert.match(basis, /Likely titles: software engineer/);
  assert.match(basis, /Skills\/tools: node, react/);
  assert.match(basis, /Citizenship\/work status: U\.S\. citizen/);
  assert.match(basis, /Security clearance: Secret/);
  assert.match(basis, /BASE RESUME TEXT:\nBuilt services in Node and React\./);
});

test("stored signal profile refreshes when base resume source changes", () => {
  const store = {
    base: { content: "Senior Data Engineer with Python, SQL, Spark, AWS, and data pipelines." },
    profile: {
      titles_json: JSON.stringify(["software engineer"]),
      keywords_json: JSON.stringify(["react"]),
      skills_json: JSON.stringify(["react"]),
      search_terms_json: JSON.stringify(["react"]),
      source_hash: "stale",
      updated_at: 1,
    },
  };
  const db = {
    prepare(sql) {
      if (sql.includes("FROM simple_apply_profiles")) {
        return { get: () => store.profile };
      }
      if (sql.includes("FROM base_resume")) {
        return { get: () => store.base };
      }
      if (sql.includes("INSERT INTO simple_apply_profiles")) {
        return {
          run(_userId, titles, keywords, skills, searchTerms, sourceHash) {
            store.profile = {
              titles_json: titles,
              keywords_json: keywords,
              skills_json: skills,
              search_terms_json: searchTerms,
              source_hash: sourceHash,
              updated_at: 2,
            };
          },
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  const profile = loadOrCreateSimpleApplyProfile(db, 7, ["Data Engineer"]);
  assert.ok(profile.searchTerms.includes("data engineer"));
  assert.ok(profile.skills.includes("python"));
  assert.notEqual(store.profile.source_hash, "stale");
});
