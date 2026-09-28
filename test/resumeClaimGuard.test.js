import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  htmlToText, extractYearsClaims, maxYearsClaim, extractSeniorityClaims, maxSeniority,
  checkResumeClaims, assertResumeClaims, ResumeClaimError, profileContradictionFindings,
  extractSummaryText,
} from "../src/integrity/resumeClaimGuard.js";
import { at } from "../test-support/sourceAnchors.js";

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

// ── The candidate's declared level is the authority ─────────────────────────────────────────────
//
// The base resume was the only authority before, and most resumes never write a level down — this
// fixture's two roles are both "Software Development Engineer", which states none. So the ceiling
// was rank 0 and NO seniority word was permitted anywhere in the output, however the candidate
// described themselves on their own profile. Measured against a JD titled "Senior Platform
// Engineer": six of eight real generations refused. Choosing a level is a deliberate act in the
// profile wizard, and it is the candidate's to make.
const DECLARED = level => ({ seniority: level });

test("SENIORITY: the level the candidate chose on their profile is allowed", () => {
  const html = resume("Senior Software Engineer with 4 years building payment systems.");
  // Without the declaration this is refused — the base resume states no level at all.
  assert.equal(checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE_RESUME }).ok, false);
  // With it, it is the candidate's own word for themselves.
  const r = checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE_RESUME, domainProfile: DECLARED("senior") });
  assert.equal(r.ok, true, r.violations.map(v => v.message).join(" | "));
});

test("SENIORITY: the generator may not reach ABOVE the declared level", () => {
  const html = resume("Principal Software Engineer with 4 years building payment systems.");
  const r = checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE_RESUME, domainProfile: DECLARED("senior") });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].kind, "seniority_unsupported");
  assert.equal(r.violations[0].claimed, "principal");
  assert.equal(r.violations[0].allowed, "senior");
  assert.match(r.violations[0].message, /change the level on your profile/);
});

test("SENIORITY: declaring 'mid' still refuses a JD's senior title", () => {
  // The exact case that was refusing six of eight generations — and it should still refuse, because
  // this candidate chose mid. "Up to the candidate" is not "up to the job description".
  const html = resume("Senior Platform Engineer with 4 years building scalable systems.");
  const r = checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE_RESUME, domainProfile: DECLARED("mid") });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].claimed, "senior");
  assert.equal(r.violations[0].allowed, "mid");
});

test("SENIORITY: the ceiling is the HIGHER of the declaration and the base resume", () => {
  const staffResume = BASE_RESUME.replace(/Software Development Engineer/g, "Staff Software Engineer");
  // Declared mid, but the base resume evidences staff — a real promotion the profile is stale about.
  // Evidence must not be thrown away by a lower declaration.
  const html = resume("Staff Software Engineer with 4 years building payment systems.");
  assert.equal(
    checkResumeClaims({ html, profile: PROFILE, baseResumeText: staffResume, domainProfile: DECLARED("mid") }).ok,
    true,
  );
  // And the declaration lifts the ceiling when the base resume is the silent one.
  assert.equal(
    checkResumeClaims({
      html: resume("Senior Software Engineer with 4 years."),
      profile: PROFILE, baseResumeText: BASE_RESUME, domainProfile: DECLARED("senior"),
    }).ok,
    true,
  );
});

test("SENIORITY: every value the profile can hold has a rank", async () => {
  // In draft, shared/jobFilterOptions.js owned the enum. Here it is the classifier's list — the
  // values a caller's profile.seniority is documented to hold — so a fifth value added there and
  // not ranked by the guard would fall through to "no declaration" and restore the over-refusal.
  const { PROFILE_SENIORITY_VALUES } = await import("../src/generation/classifier.js");
  assert.deepEqual([...PROFILE_SENIORITY_VALUES], ["junior", "mid", "senior", "executive"],
    "draft's PROFILE_SENIORITY at the move; the classifier prompt interpolates this list");
  const html = resume("Senior Software Engineer with 4 years.");
  for (const value of PROFILE_SENIORITY_VALUES) {
    const r = checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE_RESUME, domainProfile: { seniority: value } });
    // "senior" and above allow it; "junior"/"mid" do not. Either way the value must be RECOGNISED —
    // an unknown value would behave exactly like junior, which is the failure being guarded.
    const expectAllowed = ["senior", "executive"].includes(value);
    assert.equal(r.ok, expectAllowed, `${value} behaved unexpectedly`);
  }
});

test("SENIORITY: an unrecognised or empty declaration falls back to the base resume", () => {
  const html = resume("Senior Software Engineer with 4 years.");
  for (const seniority of [null, "", "  ", "wizard", undefined]) {
    const r = checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE_RESUME, domainProfile: { seniority } });
    assert.equal(r.ok, false, `${JSON.stringify(seniority)} must not be read as a declaration`);
  }
});

test("SENIORITY: with a declaration but no base resume, the declaration still governs", () => {
  const html = resume("Senior Software Engineer with 4 years.");
  assert.equal(checkResumeClaims({ html, profile: PROFILE, baseResumeText: "", domainProfile: DECLARED("senior") }).ok, true);
  assert.equal(checkResumeClaims({ html, profile: PROFILE, baseResumeText: "", domainProfile: DECLARED("junior") }).ok, false);
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

  // The level rule names the candidate's declaration, not just the base resume. Without this the
  // prompt tells the model to open with the unqualified role even when the candidate has chosen
  // "Senior" on their profile — which the guard now allows, so the two would disagree.
  assert.match(rules, /Seniority the candidate states they are` in the runtime inputs, or what the base resume evidences — take whichever is higher/);
});

// ── The rule lives in ONE layer ─────────────────────────────────────────────────────────────────
//
// AF2 corrected the SUMMARY opening rule in layer 1 and left layer 2 alone, where eleven domain
// modules restated it loosely and two stated the opposite outright — general.md said "the role
// title from the JD and total years of relevant experience", engineering.md said "the exact target
// role title". Layer 2 is appended AFTER layer 1 in the system blocks, so the contradicting copy
// was the later and more specific instruction.
//
// engineering.md's own header already says why this is wrong: "Do NOT add global rules here — those
// belong in layer1_global_rules.md." A directory-wide check is the part that was missing, and it is
// what stops the next domain module from reintroducing it.
test("no domain module sources the summary's title or years from the JD", () => {
  const dir = "prompts/layer2_domains";
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".md"));
  assert.ok(files.length >= 13, `expected the domain modules, found ${files.length}`);

  for (const file of files) {
    const text = fs.readFileSync(`${dir}/${file}`, "utf8");
    const opening = text.split(/\r?\n/).find(line => line.startsWith("Open "));
    assert.ok(opening, `${file} has no SUMMARY opening rule`);

    // The two wordings that contradicted layer 1 outright.
    assert.doesNotMatch(opening, /role title from the JD|target role title/i,
      `${file} takes the summary's title from the JD`);
    // And the loose restatement, which left whose title and which years unsaid in a paragraph
    // otherwise full of "from the JD".
    assert.doesNotMatch(opening, /^Open with role title, years,/,
      `${file} restates the title/years rule instead of deferring to Layer 1`);
    assert.match(opening, /Open as Layer 1 requires — the candidate's own role title/,
      `${file} must defer to Layer 1 for the title and years`);
  }

  // Layer 2 must not name a years quantity at all — that is Layer 1's, sourced from the profile.
  for (const file of files) {
    const text = fs.readFileSync(`${dir}/${file}`, "utf8");
    assert.doesNotMatch(text, /total years of relevant experience|a specific year count/i,
      `${file} still describes how many years to state`);
  }
});

test("the prompt tells the model to keep the honest figure rather than blur or omit it", () => {
  const rules = fs.readFileSync("prompts/layer1_global_rules.md", "utf8");
  // Dodging the gap is the other way to mislead: a vague summary reads as compliance.
  assert.match(rules, /Do not write a range, "N\+", or a vaguer phrasing to blur the gap/);
  assert.match(rules, /do not omit the figure to avoid stating it/);
});

// The wiring tests that followed here in draft read draft's server.js, routes/apply.js and client —
// draft's own integration, which stays under test in draft. This service's equivalents, against its
// own kernel, are in test/generate.test.js and test/runtimeInputs.test.js.
