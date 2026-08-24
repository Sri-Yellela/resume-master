import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  htmlToText, extractYearsClaims, maxYearsClaim, extractSeniorityClaims, maxSeniority,
  checkResumeClaims, assertResumeClaims, ResumeClaimError, profileContradictionFindings,
  extractSummaryText,
} from "../services/resumeClaimGuard.js";

// The real base resume's shape: two SDE roles, no seniority word anywhere, summary says 4 years.
const BASE_RESUME = `SRI BALAJI YELLELA
Fullstack Software Engineer

SUMMARY
Fullstack Software Engineer with 4 years building scalable, high-performance systems.

EXPERIENCE
Stripe — Software Development Engineer
Aug 2022 – Dec 2023
- Built scalable microservices for real-time payment processing
- Designed fault-tolerant distributed systems using GCP Pub/Sub

Amazon — Software Development Engineer
Jan 2021 – Jul 2022
- Built and operated cloud-native microservices on AWS
- Applied object-oriented programming and design patterns across core services`;

const PROFILE = { years_of_experience: 4 };

const resume = (summary, extra = "") => `<html><head><style>.header{}</style></head><body>
<div class="header"><div class="name">SRI BALAJI YELLELA</div></div>
<div class="section-title">SUMMARY</div><p>${summary}</p>
<div class="section-title">EXPERIENCE</div>
<div class="entry"><div class="entry-org">Stripe</div><div class="entry-role">${extra || "Software Development Engineer"}</div>
<ul class="bullets"><li>Built scalable microservices for payment processing</li></ul></div>
</body></html>`;

// ── Text extraction ──────────────────────────────────────────────────────────

test("htmlToText strips tags, style blocks and the trailing PDF comment", () => {
  const t = htmlToText(resume("Engineer with 4 years of experience.") +
    "<!-- Save and submit as PDF (print to PDF from browser). -->");
  assert.doesNotMatch(t, /<|>/);
  assert.doesNotMatch(t, /\.header/, "CSS must not be read as resume prose");
  assert.doesNotMatch(t, /Save and submit as PDF/, "the instruction comment is not a claim");
  assert.match(t, /Engineer with 4 years of experience/);
});

// ── Years ────────────────────────────────────────────────────────────────────

test("years claims are found in every phrasing a model actually writes", () => {
  const cases = [
    ["8 years of experience", 8],
    ["8+ years", 8],
    ["over 10 years building systems", 10],
    ["5-7 years", 7],
    ["5 to 7 years", 7],
    ["4.5 years", 4.5],
    ["eight years of backend work", 8],
    ["half a decade", 5],
    ["a decade of experience", 10],
    ["12 yrs", 12],
  ];
  for (const [text, expected] of cases) {
    assert.equal(maxYearsClaim(text), expected, text);
  }
});

test("A RANGE CLAIMS ITS TOP — that is the figure an employer reads", () => {
  assert.equal(maxYearsClaim("5-7 years of experience"), 7);
});

test("text with no years figure claims nothing, rather than zero", () => {
  assert.equal(maxYearsClaim("Software Engineer building distributed systems."), null);
  assert.equal(maxYearsClaim(""), null);
});

test("a year NUMBER is not a years-of-experience claim", () => {
  // Dates and quantities are everywhere in a resume; only a "N years" phrase is a claim.
  assert.equal(maxYearsClaim("Aug 2022 - Dec 2023"), null);
  assert.equal(maxYearsClaim("processing 1M+ daily transactions at 99.9% uptime"), null);
  assert.equal(maxYearsClaim("reducing deployment cycle time by 40% across 50+ releases"), null);
});

// ── Seniority ────────────────────────────────────────────────────────────────

test("a seniority claim is only counted when it qualifies a ROLE", () => {
  assert.equal(maxSeniority("Senior Software Engineer")?.word, "senior");
  assert.equal(maxSeniority("Staff Backend Developer")?.word, "staff");
  assert.equal(maxSeniority("Principal Engineer")?.word, "principal");
  assert.equal(maxSeniority("Director of Engineering")?.word, "director");
});

test("PROSE IS NOT A TITLE — the cases that would refuse a correct resume", () => {
  // Each of these contains a seniority word and claims no seniority. A false positive here does not
  // log a warning; it throws away a correct resume.
  for (const prose of [
    "Lead the migration of 12 downstream services",
    "Led the migration of 12 downstream services",
    "Leading indicator dashboards for reconciliation failures",
    "Built headless CMS integrations",
    "Went ahead of schedule on the platform rewrite",
    "Demonstrated seniority in technical design reviews",
    "Staffed the on-call rotation",
    "Associated the payment records with merchant accounts",
    "Reduced mid-tier latency",
    "Wrote the header parsing layer",
  ]) {
    assert.equal(maxSeniority(prose), null, prose);
  }
});

test("the real base resume asserts no seniority at all", () => {
  assert.equal(maxSeniority(BASE_RESUME), null,
    "'Software Development Engineer' is a title with no level word");
});

// ── The assertion ────────────────────────────────────────────────────────────

test("VERIFY: a JD demanding 8 years cannot make a 4-year profile claim 8", () => {
  const html = resume("Senior Software Engineer with 8 years building scalable payment systems.");
  const r = checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE_RESUME });
  assert.equal(r.ok, false);

  const years = r.violations.find(v => v.kind === "years_exceed_profile");
  assert.ok(years, "the years claim must be caught");
  assert.equal(years.claimed, 8);
  assert.equal(years.allowed, 4);

  // And the seniority the JD's title dragged in with it.
  const sen = r.violations.find(v => v.kind === "seniority_unsupported");
  assert.ok(sen, "the seniority claim must be caught too");
  assert.equal(sen.claimed, "senior");

  // It is a FAILURE, not a warning.
  assert.throws(() => assertResumeClaims({ html, profile: PROFILE, baseResumeText: BASE_RESUME }),
    (e) => e instanceof ResumeClaimError && e.code === "resume_claim_violation");
});

test("the honest resume passes untouched", () => {
  const html = resume("Fullstack Software Engineer with 4 years building scalable, high-performance systems.");
  const r = checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE_RESUME });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.equal(r.checked.claimedYears, 4);
  assert.equal(r.checked.profileYears, 4);
  assert.doesNotThrow(() => assertResumeClaims({ html, profile: PROFILE, baseResumeText: BASE_RESUME }));
});

// ── AG3: the opposite drift ─────────────────────────────────────────────────────────────────────
//
// This used to assert the reverse — that under-claiming was the candidate's business and silent.
// AG3 reverses that call: both directions are the profile disagreeing with itself, and a summary
// that quietly says three when the profile says four costs the candidate a screen they qualified
// for, on an unattended run they never read.
test("AG3: a summary claiming FEWER years than the profile is a violation too", () => {
  const html = resume("Software Engineer with 3 years building distributed systems.");
  const r = checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE_RESUME });
  assert.equal(r.ok, false);
  const v = r.violations.find(x => x.kind === "years_below_profile");
  assert.ok(v, "the under-claim must be reported by its own kind");
  assert.equal(v.claimed, 3);
  assert.equal(v.allowed, 4);
  assert.deepEqual(v.evidence, ["3 years"]);
  assert.equal(r.checked.summaryYears, 3);
});

test("AG3: the under-claim refuses the artifact, it does not merely warn", () => {
  const html = resume("Software Engineer with 2 years building distributed systems.");
  assert.throws(() => assertResumeClaims({ html, profile: PROFILE, baseResumeText: BASE_RESUME }),
    e => e instanceof ResumeClaimError && e.code === "resume_claim_violation");
});

test("AG3: a SCOPED years figure outside the summary is not an under-claim", () => {
  // "3 years of Python" inside a skills line is a narrower, honest statement — not the document's
  // total. Reading it as one would refuse an honest resume, which is the failure mode that kept
  // this check off in the first place.
  const html = resume(
    "Fullstack Software Engineer with 4 years building scalable systems.",
  ).replace("</body>", '<div class="section-title">TECHNICAL SKILLS</div><p>Python (3 years), Go (2 years)</p></body>');
  const r = checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE_RESUME });
  assert.equal(r.ok, true, r.violations.map(v => v.message).join(" | "));
});

test("AG3: a summary that matches the profile passes in both directions", () => {
  const html = resume("Fullstack Software Engineer with 4 years building scalable systems.");
  const r = checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE_RESUME });
  assert.equal(r.ok, true, r.violations.map(v => v.message).join(" | "));
  assert.equal(r.checked.summaryYears, 4);
});

test("AG3: extractSummaryText reads the summary and stops at the next section", () => {
  const html = resume("Engineer with 4 years of experience.");
  const summary = extractSummaryText(html);
  assert.match(summary, /Engineer with 4 years of experience/);
  assert.doesNotMatch(summary, /Built scalable microservices/, "the summary must stop at EXPERIENCE");
  assert.doesNotMatch(summary, /SUMMARY/, "the heading is not part of the summary");
  assert.equal(extractSummaryText("<p>no headings anywhere</p>"), "",
    "no summary section means no under-claim check, rather than a guessed one");
});

test("a resume that states no years figure is not a violation", () => {
  const html = resume("Fullstack Software Engineer building scalable, high-performance systems.");
  assert.equal(checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE_RESUME }).ok, true);
});

test("with no profile years stated, the years check is SKIPPED rather than assumed", () => {
  // Guessing a ceiling would be the same fault the guard exists to prevent.
  const html = resume("Engineer with 12 years of experience.");
  for (const profile of [{}, { years_of_experience: null }, { years_of_experience: 0 }, { years_of_experience: "" }]) {
    const r = checkResumeClaims({ html, profile, baseResumeText: BASE_RESUME });
    assert.equal(r.violations.some(v => v.kind === "years_exceed_profile"), false, JSON.stringify(profile));
    assert.equal(r.checked.profileYears, null);
  }
});

test("with no base resume, the seniority check is SKIPPED rather than assumed", () => {
  const html = resume("Principal Engineer with 4 years of experience.");
  const r = checkResumeClaims({ html, profile: PROFILE, baseResumeText: "" });
  assert.equal(r.violations.some(v => v.kind === "seniority_unsupported"), false);
  assert.equal(r.ok, true);
});

test("a seniority claim the base resume DOES support is allowed", () => {
  const senior = BASE_RESUME.replace(/Software Development Engineer/g, "Senior Software Engineer");
  const html = resume("Senior Software Engineer with 4 years building payment systems.");
  assert.equal(checkResumeClaims({ html, profile: PROFILE, baseResumeText: senior }).ok, true);
});

test("a seniority claim ABOVE what the base resume supports is not", () => {
  const senior = BASE_RESUME.replace(/Software Development Engineer/g, "Senior Software Engineer");
  const html = resume("Principal Software Engineer with 4 years building payment systems.");
  const r = checkResumeClaims({ html, profile: PROFILE, baseResumeText: senior });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].kind, "seniority_unsupported");
  assert.equal(r.violations[0].claimed, "principal");
  assert.equal(r.violations[0].allowed, "senior");
});

test("the claim is caught wherever it appears, not only in the summary", () => {
  // The summary is the usual place, but an inflated EXPERIENCE title is the same lie.
  const html = resume("Fullstack Software Engineer with 4 years of experience.", "Staff Software Engineer");
  const r = checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE_RESUME });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].kind, "seniority_unsupported");
  assert.equal(r.violations[0].claimed, "staff");
});

test("the guard never rewrites — it reports and refuses", () => {
  const html = resume("Senior Software Engineer with 8 years of experience.");
  const before = html;
  const r = checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE_RESUME });
  assert.equal(html, before, "the input must not be mutated");
  for (const v of r.violations) {
    assert.ok(!("corrected" in v) && !("rewrite" in v) && !("to" in v),
      "rewriting an implausible claim into a plausible one is the same fabrication");
  }
});

// ── kbFindings shape ─────────────────────────────────────────────────────────

test("violations are expressible as kbFindings the review surface already renders", () => {
  const html = resume("Senior Software Engineer with 8 years of experience.");
  const findings = profileContradictionFindings({ html, profile: PROFILE, baseResumeText: BASE_RESUME });
  assert.equal(findings.length, 2);
  for (const f of findings) {
    // The shape validateResumeClaims already returns, so no consumer needs to change.
    for (const key of ["type", "severity", "message", "evidence"]) assert.ok(key in f, key);
    assert.equal(f.type, "flag");
    assert.equal(f.severity, "review");
    assert.equal(f.scope, "profile", "distinguishable from a company-KB finding");
  }
});

test("an honest resume produces no findings", () => {
  const html = resume("Fullstack Software Engineer with 4 years of experience.");
  assert.deepEqual(profileContradictionFindings({ html, profile: PROFILE, baseResumeText: BASE_RESUME }), []);
});

// ── Robustness ───────────────────────────────────────────────────────────────

test("malformed or empty input never throws inside a live run", () => {
  for (const html of ["", null, undefined, "<html>", "not html at all", "<p>4 years</p>"]) {
    assert.doesNotThrow(() => checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE_RESUME }));
  }
  assert.doesNotThrow(() => checkResumeClaims({ html: resume("x"), profile: null, baseResumeText: null }));
});

test("extractYearsClaims reports every claim, largest first, with its evidence", () => {
  const claims = extractYearsClaims("4 years here, 8 years there, and 6 years elsewhere");
  assert.deepEqual(claims.map(c => c.years), [8, 6, 4]);
  assert.match(claims[0].text, /8 years/);
});

test("extractSeniorityClaims reports the phrase it matched, for a reviewable message", () => {
  const [top] = extractSeniorityClaims("Principal Software Engineer and Senior Data Scientist");
  assert.equal(top.word, "principal");
  assert.match(top.phrase, /principal software engineer/i);
});

// ── The wiring (AF2 requirements 2, 3, 4) ────────────────────────────────────

test("the prompt names the profile as the authority and forbids the JD setting a quantity", () => {
  const rules = fs.readFileSync("prompts/layer1_global_rules.md", "utf8");
  assert.match(rules, /The years figure comes from `Candidate years of experience`/,
    "the summary rule must name its source");
  assert.match(rules, /Never from the JD\./);
  assert.match(rules, /It never sets a QUANTITY or a LEVEL/,
    "the truthfulness section must state the emphasis-vs-quantity distinction");
  assert.match(rules, /do not rewrite an implausible claim in the base resume into a plausible one/i,
    "§7 forbids correction in both directions");
  // The pre-fix wording is what let the JD supply the figure.
  assert.doesNotMatch(rules, /Open with target role title and total relevant years/,
    "'total RELEVANT years' left the source of the number to the JD");
});

test("the prompt tells the model to keep the honest figure rather than blur or omit it", () => {
  const rules = fs.readFileSync("prompts/layer1_global_rules.md", "utf8");
  // Dodging the gap is the other way to mislead: a vague summary reads as compliance.
  assert.match(rules, /Do not write a range, "N\+", or a vaguer phrasing to blur the gap/);
  assert.match(rules, /do not omit the figure to avoid stating it/);
});

test("the runtime inputs carry the profile's years, marked authoritative", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /Candidate years of experience \(AUTHORITATIVE — the JD may not change this\)/,
    "without this the JD's demand is the only quantity in context");
  assert.match(server, /derive from the base resume dates only, never from the JD/,
    "and the unset case must say where to look instead");
  // A target is not a fact.
  assert.match(server, /Seniority the user is TARGETING \(an aspiration, not a level to claim\)/);
  assert.doesNotMatch(server, /\*\*Target seniority:\*\*/);
});

test("the assertion runs in coreGenerateResume, BEFORE the artifact is persisted", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const start = server.indexOf("async function coreGenerateResume");
  assert.ok(start > 0);
  const body = server.slice(start, server.indexOf("\n// ", server.indexOf("return { html: formattedHtml")));
  const assertAt = body.indexOf("assertResumeClaims(");
  assert.ok(assertAt > 0, "coreGenerateResume must assert its own output");

  // Ordering is the whole point: after the assertion throws, nothing may write the artifact.
  const insertAt = body.indexOf("INSERT INTO resume_versions");
  const returnAt = body.indexOf("return { html: formattedHtml");
  assert.ok(insertAt === -1 || assertAt < insertAt, "the assertion must precede persistence");
  assert.ok(assertAt < returnAt, "the assertion must precede the return");

  // It must be the shared kernel, so BOTH the HTTP handler and the apply worker are covered — under
  // full-auto no human reads the resume, so a check only on the HTTP path protects nobody.
  assert.match(body, /assertResumeClaims\(\{ html: formattedHtml, profile, baseResumeText: authoritativeResumeText \}\)/);
});

// ── AG3 item 1: no generation path reaches persistence without the guard ────────────────────────

test("AG3: every resume-generating path funnels through the guarded coreGenerateResume", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const apply = fs.readFileSync("routes/apply.js", "utf8");

  // The UNATTENDED path. The apply worker never calls a model itself — it asks
  // generateResumeForApply, which is a thin wrapper over the same guarded function the HTTP route
  // uses. If that ever stops being true, a resume can be submitted to an employer unread and
  // unchecked, which is the exact failure this guard exists for.
  assert.match(apply, /generateResumeForApply\(userId, jobId, toolType\)/,
    "the apply worker must go through generateResumeForApply");
  const wrapper = server.slice(
    server.indexOf("function generateResumeForApply"),
    server.indexOf("app.post(\"/api/resumes/:jobId/html\""),
  );
  assert.match(wrapper, /coreGenerateResume\(/,
    "generateResumeForApply must delegate to coreGenerateResume rather than call a model itself");

  // And nothing else calls a model to build a resume. Exactly two callers, both accounted for.
  const callers = server.split("coreGenerateResume(").length - 1;
  assert.equal(callers, 3, `expected the definition plus two callers, found ${callers} occurrences`);
});

test("AG3: a withheld resume is never persisted, and the refusal reaches the caller", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const body = server.slice(
    server.indexOf("async function coreGenerateResume"),
    server.indexOf("function generateResumeForApply"),
  );
  const assertAt = body.indexOf("assertResumeClaims(");
  const insertVersion = body.indexOf("INSERT INTO resume_versions");
  const insertResume = body.indexOf("INSERT INTO resumes");
  assert.ok(assertAt > 0, "coreGenerateResume must assert its own output");
  assert.ok(assertAt < insertVersion && assertAt < insertResume,
    "the assertion must run BEFORE either write — a warning after the write is not a refusal");

  // The throw is not swallowed into a generic failure: it is attributed to us and explained.
  const wrapper = server.slice(
    server.indexOf("function generateResumeForApply"),
    server.indexOf("app.post(\"/api/resumes/:jobId/html\""),
  );
  assert.match(wrapper, /classifyGenerationError\(e\)/);
  const attribution = fs.readFileSync("shared/failureAttribution.js", "utf8");
  assert.match(attribution, /e\?\.code === "resume_claim_violation"/,
    "the refusal must keep its own code rather than becoming an upstream error");
});

test("kbFindings reports a profile contradiction alongside a company-KB one", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const start = server.indexOf("const kbFindingsFor =");
  const body = server.slice(start, start + 1200);
  assert.match(body, /validateResumeClaims\(db, html\)/, "the 9.6 check must stay");
  assert.match(body, /profileContradictionFindings\(/, "and the inward-facing one is added");
  // A validator bug must not break a real generate response — the existing contract.
  assert.match(body, /catch \(e\)/);
});

// ── How the refusal reaches the candidate ────────────────────────────────────

test("a claim violation is attributed to US, not to the model provider", async () => {
  const { classifyGenerationError } = await import("../shared/failureAttribution.js");
  const err = new ResumeClaimError({
    violations: [{ kind: "years_exceed_profile", message: "claims 8 years; the profile states 4." }],
    checked: {},
  });
  const f = classifyGenerationError(err);
  assert.equal(f.code, "resume_claim_violation",
    "'generation_failed' would blame the API for our own refusal");
  assert.doesNotMatch(f.detail, /upstream/i);
  assert.match(f.detail, /NOT saved or sent/);
  assert.match(f.detail, /claims 8 years/, "the specific violation must survive into reason_detail");
  // Retryable: the generator is stochastic, so the next attempt may come back honest. It is the
  // SUBMISSION that must never happen, not the retry.
  assert.equal(f.permanent, false);
});

test("an ordinary upstream failure is still classified as before", async () => {
  const { classifyGenerationError } = await import("../shared/failureAttribution.js");
  const e = Object.assign(new Error("overloaded_error"), { status: 529 });
  const f = classifyGenerationError(e);
  assert.equal(f.code, "generation_failed");
  assert.match(f.detail, /upstream generation error/);
});

test("the reason code renders as a sentence, not as a raw code", () => {
  // An unmapped reason code falls through to a fallback that prints the code with its underscores
  // swapped out — which this codebase treats as a bug, not a rendering.
  const src = fs.readFileSync("client/src/lib/applyObstacles.js", "utf8");
  assert.match(src, /resume_claim_violation: \{/);
  const entry = src.slice(src.indexOf("resume_claim_violation: {"), src.indexOf("resume_claim_violation: {") + 400);
  assert.match(entry, /obstacle:/);
  assert.match(entry, /action:/);
  // Protective: the guard did its job. Filing it under "these broke" would be the wrong story.
  assert.match(entry, /protective: true/);
  assert.match(entry, /resumeBlocked: true/);
});
