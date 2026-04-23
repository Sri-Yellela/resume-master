import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildRuntimeAtsBasis, normaliseAtsTerm, scoreAtsLocally } from "../services/localAtsScorer.js";

test("local ATS normalization catches common wording variations", () => {
  assert.equal(normaliseAtsTerm("REST APIs"), normaliseAtsTerm("REST API"));
  assert.equal(normaliseAtsTerm("CI/CD"), normaliseAtsTerm("CI CD"));
  assert.equal(normaliseAtsTerm("Services"), normaliseAtsTerm("service"));
});

test("local ATS scorer is deterministic and reports structured match sections", () => {
  const runtimeBasis = buildRuntimeAtsBasis({
    resumeText: "Built React REST API services on AWS. Automated CI/CD deployments.",
    signalProfile: {
      skills: ["React", "REST API", "AWS"],
      keywords: ["CI/CD"],
      yearsExperience: 4,
      structuredFacts: { hasClearance: false, requiresSponsorship: false },
    },
    domainProfile: {
      selected_tools: JSON.stringify(["Node.js"]),
      selected_keywords: JSON.stringify(["distributed systems"]),
      selected_verbs: JSON.stringify(["Built", "Automated"]),
      target_titles: JSON.stringify(["Software Engineer"]),
    },
  });
  const job = {
    title: "Software Engineer",
    description: "Build React REST APIs with Node.js and Kubernetes. Requires 3 years experience.",
  };

  const a = scoreAtsLocally({ job, runtimeBasis });
  const b = scoreAtsLocally({ job, runtimeBasis });

  assert.deepEqual(a, b);
  assert.equal(a.source, "local_ats_v1");
  assert.ok(a.score > 60);
  assert.ok(a.tier1_matched.some(v => normaliseAtsTerm(v) === "react"));
  assert.ok(a.tier1_missing.some(v => normaliseAtsTerm(v).includes("kubernetes")));
  assert.equal(a.experience.fit, true);
  assert.deepEqual(a.strengths, undefined);
  assert.deepEqual(a.improvements, undefined);
});

test("hard profile facts and experience misses affect local ATS score", () => {
  const runtimeBasis = buildRuntimeAtsBasis({
    resumeText: "Python developer with 2 years experience.",
    signalProfile: {
      skills: ["Python"],
      yearsExperience: 2,
      structuredFacts: { hasClearance: false, requiresSponsorship: true },
    },
    domainProfile: {},
  });
  const report = scoreAtsLocally({
    job: {
      title: "Cleared Python Engineer",
      description: "Python role requiring security clearance, no sponsorship, and 6 years experience.",
    },
    runtimeBasis,
  });

  assert.equal(report.experience.fit, false);
  assert.ok(report.hard_constraint_misses.includes("Security clearance"));
  assert.ok(report.hard_constraint_misses.includes("Work authorization without sponsorship"));
  assert.ok(report.score < 80);
});

test("server precomputed and generated ATS paths use local scorer instead of LLM ATS calls", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const scrapeBlock = server.slice(server.indexOf("ATS scoring for newly inserted jobs"), server.indexOf("Async clearbit icon fallback"));
  const keywordBlock = server.slice(server.indexOf('app.post("/api/jobs/:id/keywords"'), server.indexOf('app.get("/api/jobs/pending"'));
  const generateBlock = server.slice(server.indexOf("const resumeStripped = stripResumeHtml(formattedHtml)"), server.indexOf("const version = (db.prepare"));

  assert.match(scrapeBlock, /scoreAtsLocally/);
  assert.doesNotMatch(scrapeBlock, /anthropic\.messages\.create|ATS_SYSTEM_PROMPT|claude-haiku/);
  assert.match(keywordBlock, /scoreAtsLocally/);
  assert.doesNotMatch(keywordBlock, /checkLimit\(db, userId, "ats_score"\)|anthropic\.messages\.create|ATS_SYSTEM_PROMPT/);
  assert.match(generateBlock, /scoreAtsLocally/);
  assert.doesNotMatch(generateBlock, /anthropic\.messages\.create|ATS_SYSTEM_PROMPT/);
});

test("ATS missing chips add profile-scoped inactive suggestions without mutating base metadata", () => {
  const routes = fs.readFileSync("routes/domainProfiles.js", "utf8");
  const panel = fs.readFileSync("client/src/panels/ATSPanel.jsx", "utf8");
  const profilePanel = fs.readFileSync("client/src/panels/ProfilePanel.jsx", "utf8");

  assert.match(routes, /router\.post\("\/:id\/suggestions"/);
  assert.match(routes, /addProfileSignalSuggestions/);
  assert.doesNotMatch(routes, /profile_base_resumes[\s\S]{0,120}suggestions/);
  assert.match(panel, /kind, labels: \[label\]/);
  assert.match(panel, /addSuggestion\("skill", item\)/);
  assert.match(panel, /addSuggestion\("action_verb", item\)/);
  assert.match(profilePanel, /Inactive ATS-Suggested Action Verbs/);
});
