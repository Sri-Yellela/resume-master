// SCRAPING � SCHEDULED FOR REMOVAL AFTER MIGRATION
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildRuntimeAtsBasis, LOCAL_ATS_SOURCE, normaliseAtsTerm, scoreAtsLocally } from "../services/localAtsScorer.js";

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
  assert.equal(a.source, LOCAL_ATS_SOURCE);
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

test("AG1: the report version was bumped, so cached fragment reports are not served forever", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const panel = fs.readFileSync("client/src/panels/ATSPanel.jsx", "utf8");

  // A report is cached in four places and the read path serves it whenever `source` matches. If
  // the version had stayed local_ats_v1, every job already scored would keep showing "and
  // scalable. We" and the fix would only ever apply to jobs nobody had looked at yet.
  assert.notEqual(LOCAL_ATS_SOURCE, "local_ats_v1", "the report content changed; the version must too");

  // Every cache gate compares against the constant, so a future bump cannot strand a reader on an
  // old string. Three read gates in the keywords route, plus the scrape-time log.
  assert.equal((server.match(/parsed\?\.source === LOCAL_ATS_SOURCE/g) || []).length, 3);
  assert.doesNotMatch(server, /"local_ats_v1"/, "no gate may still spell the old version");

  // The panel hides the LLM-only sections for the whole local family, not one version of it.
  assert.match(panel, /String\(activeReport\.source \|\| ""\)\.startsWith\("local_ats"\)/);
});

// ── AG1: the extractor emits skills, not text fragments ─────────────────────────────────────────
//
// The prose below is lifted verbatim from the OpenAI "Software Engineer, Agent Productivity"
// posting that produced the defect. Against it the old 1-3 word window emitted "and scalable. We",
// "s core productivity", "OpenAI operate securely", "a customer zero" and "facing"/"paved" as
// action verbs — 26 of the 26 "missing skills" were sentence fragments. These tests pin the shape
// of what may be emitted, not a specific term list, so the vocabulary can grow without churn.
const AGENT_PRODUCTIVITY_JD = [
  "OpenAI's Application Engineering team builds the internal products and platforms that help",
  "OpenAI operate securely and at scale. We engineer, own, and evolve OpenAI's core productivity",
  "ecosystem, creating secure applications, integrations, automation, and reusable tooling where",
  "off-the-shelf software is not enough. Our work spans employee-facing experiences and the",
  "services, APIs, control planes, and governance that make them reliable, permission-aware, and",
  "scalable. We also act as a customer zero for OpenAI's technology, building the enterprise",
  "foundations that let employees and agents safely access the context, tools, and actions they",
  "need. We partner closely with IT, Security, product teams, and platform providers. We create",
  "paved paths that let teams move quickly without compromising security or operational quality.",
  "Read our policy at https://cdn.openai.com/policies/eeo-policy-statement.pdf or report via",
  "https://form.asana.com/?d=57018692298241. For unincorporated Los Angeles County workers we",
  "consider criminal history in accordance with the law.",
].join(" ");

function agentProductivityReport(extra = {}) {
  const runtimeBasis = buildRuntimeAtsBasis({
    resumeText: "Built React REST API services on AWS. Automated CI/CD deployments.",
    signalProfile: { skills: ["React", "AWS"], yearsExperience: 4, structuredFacts: {} },
    domainProfile: { selected_verbs: JSON.stringify(["Built", "Automated"]) },
  });
  return scoreAtsLocally({
    job: {
      title: "Software Engineer, Agent Productivity",
      company: "OpenAI",
      description: AGENT_PRODUCTIVITY_JD,
      ...extra,
    },
    runtimeBasis,
  });
}

function allTerms(report) {
  return [...report.tier1_matched, ...report.tier1_missing];
}

test("AG1: no emitted term is a fragment sliced out of the job description's prose", () => {
  const report = agentProductivityReport();
  const emitted = [...allTerms(report), ...report.action_verbs_matched, ...report.action_verbs_missing];
  assert.ok(emitted.length > 0, "the report should still say something");

  for (const term of emitted) {
    // Sentence punctuation inside a chip — the signature of "and scalable. We".
    assert.doesNotMatch(term, /[;:!?]/, `sentence punctuation in ${JSON.stringify(term)}`);
    assert.doesNotMatch(term, /\.\s|[.,]$/, `mid-sentence cut in ${JSON.stringify(term)}`);
    // Leading or trailing filler — "and at scale", "employees and", the "s" of "OpenAI's".
    assert.doesNotMatch(
      term,
      /^(?:and|or|the|a|an|of|to|in|with|we|you|is|are|that|this|our|s)\b/i,
      `leading filler in ${JSON.stringify(term)}`,
    );
    assert.doesNotMatch(
      term,
      /\b(?:and|or|the|a|an|of|to|in|with|we|you|is|are|that|this|our|s)$/i,
      `trailing filler in ${JSON.stringify(term)}`,
    );
    assert.ok(term.trim().length >= 2, `single-letter fragment ${JSON.stringify(term)}`);
  }

  // The specific fragments the panel actually showed a user.
  for (const fragment of [
    "and scalable. We", "s core productivity", "OpenAI operate securely", "a customer zero",
    "and at scale", "We engineer", "is not enough", "employees and agents", "safely access the",
    "building the enterprise", "foundations that let", "permission-aware",
  ]) {
    assert.ok(
      !emitted.some(t => t.toLowerCase() === fragment.toLowerCase()),
      `regression: ${JSON.stringify(fragment)} is back`,
    );
  }
});

test("AG1: verbs are action verbs in isolation, not tokens that happen to end in -ed or -ing", () => {
  const report = agentProductivityReport();
  const verbs = [...report.action_verbs_matched, ...report.action_verbs_missing];

  // Participles lifted mid-phrase: "customer-facing", "paved paths", "without compromising",
  // "own, and evolve". Each ends in -ed/-ing and each used to be reported as a missing verb.
  for (const notAVerb of ["facing", "paved", "compromising", "owning"]) {
    assert.ok(
      !verbs.some(v => v.toLowerCase() === notAVerb),
      `regression: ${JSON.stringify(notAVerb)} reported as an action verb`,
    );
  }
  // Every verb is a single word — a verb phrase means the window is back.
  for (const verb of verbs) assert.doesNotMatch(verb, /\s/, `verb phrase ${JSON.stringify(verb)}`);
});

test("AG1: the employer's own name is never a skill the resume is missing", () => {
  const report = agentProductivityReport();
  for (const term of allTerms(report)) {
    assert.doesNotMatch(term, /openai/i, `company name emitted as a skill: ${JSON.stringify(term)}`);
  }
});

test("AG1: words that appear only inside a URL are not skills", () => {
  const report = agentProductivityReport();
  const terms = allTerms(report).map(t => t.toLowerCase());
  // "https://cdn.openai.com" and "form.asana.com" are boilerplate links, not a request for CDN
  // experience or Asana experience.
  assert.ok(!terms.includes("cdn"), "CDN came from a policy URL");
  assert.ok(!terms.includes("asana"), "Asana came from a report-a-concern URL");
});

test("AG1: one company's stack does not leak into another company's posting", () => {
  const report = agentProductivityReport();
  const terms = allTerms(report).map(t => t.toLowerCase());
  // "Workers" is Cloudflare's product. Pooling every company's stack into one list matched it
  // against "Los Angeles County workers" in this posting's legal boilerplate.
  assert.ok(!terms.includes("workers"), "a foreign company stack term matched generic prose");
});

test("AG1: the posting's own extracted skills are a source, in both stored shapes", () => {
  const objectShape = agentProductivityReport({
    skills_json: JSON.stringify([{ skill: "identity and access management", type: "hard" }]),
  });
  const stringShape = agentProductivityReport({
    skills_json: JSON.stringify(["identity and access management"]),
  });
  for (const report of [objectShape, stringShape]) {
    assert.ok(
      allTerms(report).some(t => t.toLowerCase() === "identity and access management"),
      "skills_json should feed the report, so the panel agrees with the board's chips",
    );
  }
});

test("AG1: a verb's tense is not two separate verbs", () => {
  const report = scoreAtsLocally({
    job: { title: "Engineer", company: "Acme", description: "You will build and optimize services." },
    runtimeBasis: buildRuntimeAtsBasis({
      resumeText: "Wrote services.",
      signalProfile: {},
      domainProfile: { selected_verbs: JSON.stringify(["Built", "Optimised"]) },
    }),
  });
  const verbs = [...report.action_verbs_matched, ...report.action_verbs_missing]
    .map(v => v.toLowerCase());
  assert.ok(!(verbs.includes("build") && verbs.includes("built")), "Build and Built are one verb");
  assert.ok(!(verbs.includes("optimise") && verbs.includes("optimize")), "one verb, two spellings");
});

test("AG1: an unrecognised posting yields a short report rather than an invented one", () => {
  // Precision over recall. Nothing here is a skill, so nothing should be claimed to be one.
  const report = scoreAtsLocally({
    job: { title: "Correspondent", company: "Daily Herald", description: "We value curiosity and a warm manner with the people we meet." },
    runtimeBasis: buildRuntimeAtsBasis({ resumeText: "Reporter.", signalProfile: {}, domainProfile: {} }),
  });
  for (const term of allTerms(report)) {
    assert.doesNotMatch(term, /^(?:we|and|a|the|with|people)\b/i, `prose emitted: ${JSON.stringify(term)}`);
  }
});

// This test used to pin the one-way "add" contract: ATSPanel called addSkillToProfile /
// addVerbToProfile, which POSTed { kind, labels: [label] } and wrote straight into
// domain_profiles.selected_*. AG2 replaces that flow with a reversible claim, so the contract it
// pinned is deliberately gone. What still matters is pinned below.
test("AG2: the ATS chips claim through the reversible route, not the one-way add", () => {
  const routes = fs.readFileSync("routes/domainProfiles.js", "utf8");
  const panel = fs.readFileSync("client/src/panels/ATSPanel.jsx", "utf8");
  const suggestionsLib = fs.readFileSync("client/src/lib/profileSuggestions.js", "utf8");

  assert.match(routes, /router\.post\("\/:id\/claims"/, "the claim route must exist");
  assert.match(routes, /setProfileSignalClaim/);
  // The route must still not reach into the base resume — a claim is not an edit to the record of
  // what the candidate actually did.
  assert.doesNotMatch(routes, /profile_base_resumes[\s\S]{0,120}claims/);

  assert.match(suggestionsLib, /body: JSON\.stringify\(\{ kind, label, claimed \}\)/);
  assert.match(panel, /await setProfileClaim\(clickableProfileId, kind, label, claimed\)/);
  assert.match(panel, /toggleClaim\("skill", item, claimed\)/);
  assert.match(panel, /toggleClaim\("action_verb", item, claimed\)/);

  // The superseded one-way helpers must be gone from the client, so there is one way to do this.
  for (const dead of ["addSkillToProfile", "addVerbToProfile", "buildProfileSuggestionLookup"]) {
    assert.ok(!new RegExp(`export (async )?function ${dead}\\b`).test(suggestionsLib),
      `${dead} should no longer be exported — AG2 replaced it with a reversible claim`);
    assert.doesNotMatch(panel, new RegExp(`\\b${dead}\\(`), `${dead} still called from the panel`);
  }
});

test("AG2: nothing is pre-selected — only what the candidate claimed reads as claimed", () => {
  const panel = fs.readFileSync("client/src/panels/ATSPanel.jsx", "utf8");
  const suggestionsLib = fs.readFileSync("client/src/lib/profileSuggestions.js", "utf8");
  const aggregator = fs.readFileSync("services/profileSignalAggregator.js", "utf8");

  // The claim lookup reads the claimed buckets ONLY. Scrape-time aggregation writes 'inactive'
  // rows with no user involvement, so including those is an auto-opt-in.
  assert.match(suggestionsLib, /skillKeys: new Set\(keysOf\(suggestions\.claimedSkills\)\)/);
  assert.match(suggestionsLib, /verbKeys: new Set\(keysOf\(suggestions\.claimedActionVerbs\)\)/);
  for (const notAClaim of ["inactiveSkills", "selectedSkills", "inactiveActionVerbs", "selectedActionVerbs"]) {
    assert.doesNotMatch(suggestionsLib, new RegExp(`claimKeys[\\s\\S]{0,200}${notAClaim}`));
  }
  assert.match(aggregator, /CLAIM_STATUSES = new Set\(\["claimed", "applied"\]\)/);

  // A claim must never be a score lever: claims are not written into domain_profiles.selected_*,
  // which is what buildRuntimeAtsBasis scores the resume against.
  //
  // Checked against the code with COMMENTS STRIPPED. The comment explaining why the copy must not
  // say "add this to improve your score" contains that phrase, and matching it there would fail on
  // the very sentence that documents the rule.
  const visible = panel.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  assert.doesNotMatch(visible, /improve your score|boost your score|increase your score/i);
  assert.match(visible, /It does not change this score/,
    "the panel must say plainly that claiming does not move the number");
  assert.match(visible, /is true of you|You claimed this/,
    "the copy must read as the candidate claiming, not as the product advising");
});

test("AG2: a claim informs FUTURE generation and never rewrites an existing resume", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const aggregator = fs.readFileSync("services/profileSignalAggregator.js", "utf8");

  // Read per generation, from the live table — so a claim made today cannot reach yesterday's
  // artifact, and tomorrow's generation sees it without anything being replayed.
  assert.match(server, /listProfileClaims\(db, \{ userId, profileId: activeDomainProfile\.id \}\)/);
  const build = server.slice(server.indexOf("function buildRuntimeInputs"), server.indexOf("// â”€â”€ PDF generation"));
  assert.match(build, /Skills the CANDIDATE has claimed \(candidate-supplied/);
  assert.match(build, /they license WORDING, never HISTORY/,
    "the prompt must bound what a claim authorises");
  assert.match(build, /may NOT invent an employer, a\nproject, a duration, a metric or a responsibility/);

  // The claim store is separate from the profile's own term lists, which are what the ATS scorer
  // reads. Writing claims there would let a claim inflate its own score.
  const claimFn = aggregator.slice(aggregator.indexOf("export function setProfileSignalClaim"),
    aggregator.indexOf("export function listProfileClaims"));
  assert.doesNotMatch(claimFn, /UPDATE domain_profiles/,
    "claiming must not write the profile's scored term lists");
  assert.match(claimFn, /status = 'inactive', selected_at = NULL/, "a claim must be withdrawable");
});

test("ProfilePanel still surfaces ATS-suggested action verbs", () => {
  const profilePanel = fs.readFileSync("client/src/panels/ProfilePanel.jsx", "utf8");
  assert.match(profilePanel, /Inactive ATS-Suggested Action Verbs/);
});
