// ── BANDS, NOT NUMBERS (AK2 task 4) ─────────────────────────────────────────────────────────────
//
// The engine orders coarsely — rho 0.746 against the owner's human-graded 30, 12.2% of pairs still
// mis-ordered — and cannot support a displayed figure. These tests pin the three things that would
// silently undo that: a surface printing the number again, the cutpoints drifting away from the
// graded evidence, and the auto-apply gate being welded to a display band.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ATS_BAND, ATS_BAND_CUTPOINTS, ATS_BAND_LABELS, atsBandFor, atsBandLabel, resumeDepthWarning,
} from "../shared/atsBands.js";
import { scoreAtsLocally, buildRuntimeAtsBasis, isJuniorPosting, seniorityCapFor } from "../services/localAtsScorer.js";
import { at } from "../test-support/sourceAnchors.js";

test("a null score is NOT_ENOUGH_SIGNAL, never Weak and never zero", () => {
  // The single most important line in this file. scoreAtsLocally returns null when it declines, and
  // any surface that coerced that to 0 would render the engine's most honest output as its worst
  // grade. That decline behaviour is what took the false-match rate from 22.8% to 0.8%.
  assert.equal(atsBandFor(null), ATS_BAND.NOT_ENOUGH_SIGNAL);
  assert.equal(atsBandFor(undefined), ATS_BAND.NOT_ENOUGH_SIGNAL);
  assert.equal(atsBandFor({ score: null }), ATS_BAND.NOT_ENOUGH_SIGNAL);
  assert.equal(atsBandFor(NaN), ATS_BAND.NOT_ENOUGH_SIGNAL);
  assert.notEqual(atsBandFor(null), atsBandFor(0), "a decline must not read the same as a zero");
  assert.equal(atsBandFor(0), ATS_BAND.WEAK);
});

test("cutpoints match the graded evidence they were derived from", () => {
  // 44 is the LOWEST cutpoint at which precision against "the owner graded this 4 or 5" reaches
  // 100% on the 30. Moving it down admits a posting they rated poorly; moving it up only loses good
  // ones. 26 puts Weak at 40.8% of the live board against the owner's 36.7% graded 1-or-2.
  assert.equal(ATS_BAND_CUTPOINTS.strong, 44);
  assert.equal(ATS_BAND_CUTPOINTS.moderate, 26);
  assert.equal(atsBandFor(44), ATS_BAND.STRONG);
  assert.equal(atsBandFor(43), ATS_BAND.MODERATE);
  assert.equal(atsBandFor(26), ATS_BAND.MODERATE);
  assert.equal(atsBandFor(25), ATS_BAND.WEAK);
});

test("the auto-apply gate is NOT the Strong band, in either direction", () => {
  // Requirement 5. The gate asks "is this safe to submit unattended"; the band asks "what should
  // this person be told". Coupling them would cut auto-apply volume from ~36% of the board to ~6%
  // as a side effect of a copy decision.
  const applyRoutes = fs.readFileSync("routes/apply.js", "utf8");
  const gate = /envInt\("ATS_AUTO_APPLY_THRESHOLD",\s*(\d+)\)/.exec(applyRoutes);
  assert.ok(gate, "ATS_AUTO_APPLY_THRESHOLD is gone — the gate must stay a number");
  assert.notEqual(Number(gate[1]), ATS_BAND_CUTPOINTS.strong,
    "the gate and the Strong cutpoint have become the same number; they answer different questions " +
    "and must be able to move independently");

  // And nothing may gate on a band name.
  for (const dir of ["services", "routes"]) {
    for (const file of walk(dir)) {
      const src = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(src, /(band|atsBand)\s*===\s*["']strong["']/i,
        `${file} gates on the Strong BAND. Bands are display only — gate on the score.`);
    }
  }
});

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
    return /\.(js|mjs)$/.test(e.name) ? [p] : [];
  });
}

test("no user-facing surface prints the raw ATS number", () => {
  // Five separate copies of `ATS {score}` existed, each with its own >=80/>=60 colour ramp carried
  // over from v3 — under v4 (median 27, max 64) nothing ever cleared 60, so every row on the board
  // painted red and the badge read as "every job is bad".
  const files = [
    "client/src/components/JobCard.jsx",
    "client/src/components/JobDetailPanel.jsx",
    "client/src/panels/JobsPanel.jsx",
    "client/src/panels/AutoApplyPanel.jsx",
    "client/src/panels/AutoApplyPanelSections.jsx",
    "client/src/panels/ATSPanel.jsx",
    "client/src/pages/tools/GenerateToolPage.jsx",
  ];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(src, /ATS \{[a-zA-Z.?\s]*[aA]tsScore/,
      `${file} renders the raw ATS number. Render a band from shared/atsBands.js instead.`);
    assert.doesNotMatch(src, />= *80 *\? *"#dcfce7"/,
      `${file} still carries the v3 colour ramp, which paints the whole v4 board red.`);
  }
});

test("every band has distinct copy, and NOT_ENOUGH_SIGNAL is not on the fit scale", () => {
  const labels = Object.values(ATS_BAND).map(b => atsBandLabel(b).label);
  assert.equal(new Set(labels).size, labels.length, "two bands share a label");
  const unknown = atsBandLabel(ATS_BAND.NOT_ENOUGH_SIGNAL);
  const weak = atsBandLabel(ATS_BAND.WEAK);
  assert.notEqual(unknown.bg, weak.bg, "'Not enough signal' must not look like 'Weak'");
  assert.notEqual(unknown.fg, weak.fg);
  assert.doesNotMatch(unknown.label, /match/i,
    "'Not enough signal' must not be worded as a degree of fit — it is the absence of a judgement");
  assert.match(unknown.blurb, /not a poor match/i);
});

// ── The seniority guard ─────────────────────────────────────────────────────────────────────────

test("the junior-title detector reads TITLES, and does not fire on a posting that EXCLUDES interns", () => {
  assert.ok(isJuniorPosting("Software Engineer Intern (Winter 2027)"));
  assert.ok(isJuniorPosting("Software Engineer, New Grad (Dec 2026)"));
  assert.ok(isJuniorPosting("Software Engineer, Early Career"));
  // The false positives that a description scan produced. Three senior backend roles open with
  // "if you are an intern, new grad, staff, frontend or fullstack applicant, please do not apply
  // using this link" — a posting excluding interns, read as evidence that it is one.
  assert.ok(!isJuniorPosting("Backend Engineer, Payments"));
  assert.ok(!isJuniorPosting("Full Stack Engineer, Money as a Service"));
  // \b matching, so these are not interns either.
  assert.ok(!isJuniorPosting("Internal Tools Engineer"));
  assert.ok(!isJuniorPosting("International Payments Engineer"));
});

test("the guard caps for a mid profile, and leaves an entry-level profile alone", () => {
  assert.equal(seniorityCapFor("Software Engineer Intern", "mid")?.cap, 20);
  assert.equal(seniorityCapFor("Software Engineer Intern", "senior")?.cap, 20);
  // An intern applying to an internship is not a mismatch.
  assert.equal(seniorityCapFor("Software Engineer Intern", "intern"), null);
  assert.equal(seniorityCapFor("Software Engineer Intern", "entry"), null);
  // UNKNOWN seniority must not fire it. Declining to cap is the conservative direction; a profile
  // that simply has not filled the field must not be told every junior role is a poor match.
  assert.equal(seniorityCapFor("Software Engineer Intern", null), null);
  assert.equal(seniorityCapFor("Software Engineer Intern", ""), null);
  // And it never touches a normal posting.
  assert.equal(seniorityCapFor("Backend Engineer, Payments", "mid"), null);
});

test("the cap is a CEILING on the real scorer, and says what it capped", () => {
  const runtimeBasis = buildRuntimeAtsBasis({
    resumeText: "Built React REST API services on AWS with Node.js and Kubernetes. Automated CI/CD.",
    signalProfile: { skills: ["React", "REST API", "AWS", "Node.js", "Kubernetes"], yearsExperience: 4, structuredFacts: {} },
    domainProfile: { seniority: "mid", selected_verbs: JSON.stringify(["Built", "Automated"]) },
  });
  const description = "Build React REST APIs with Node.js, Kubernetes and AWS. CI/CD automation.";
  const senior = scoreAtsLocally({ job: { title: "Software Engineer", description }, runtimeBasis });
  const intern = scoreAtsLocally({ job: { title: "Software Engineer Intern", description }, runtimeBasis });

  assert.equal(senior.seniority_cap.applied, false);
  assert.equal(intern.seniority_cap.applied, true);
  assert.ok(intern.score <= 20, `capped score should be <= 20, got ${intern.score}`);
  // The pre-cap score is carried, because a cap with no visible before-value is indistinguishable
  // from a genuinely low score.
  assert.equal(intern.seniority_cap.raw_score, senior.score);
  assert.ok(intern.seniority_cap.raw_score > intern.score, "the cap did not actually bind");
  assert.match(intern.seniority_cap.reason, /early-career/i);
});

test("the guard is keyed on profile seniority, not on years parsed from the resume", () => {
  // Measured, and this is why: extractUserYearsExperience returns null for the owner's real resume
  // ("4 years building scalable systems" never says the word "experience"), so a years-keyed guard
  // is dead code. Repairing the extractor to make it fire was tried and makes ranking WORSE —
  // rho 0.643 -> 0.552 — because it lifts every non-engineering posting that states a satisfied
  // year requirement. That is the same failure AK1 recorded when it reverted renormalisation.
  const src = fs.readFileSync("services/localAtsScorer.js", "utf8");
  const guard = src.slice(at(src, "export function seniorityCapFor"), at(src, "function hardConstraintMisses"));
  assert.doesNotMatch(guard, /yearsExperience/,
    "the guard reads years again — it would never fire, and repairing the extractor to make it " +
    "fire measured worse. Key it on domain_profiles.seniority.");
  assert.match(guard, /seniority/);
});

// ── The thin-resume state ───────────────────────────────────────────────────────────────────────

test("a thin resume is called out as its own state, not delivered as an all-Weak board", () => {
  const thin = resumeDepthWarning({ resumeText: "John Doe. C++ Java.", skills: ["c++", "java"] });
  assert.ok(thin, "a 19-character resume must raise the depth warning");
  assert.match(thin.headline, /too thin/i);
  assert.match(thin.detail, /resume/i);

  const full = resumeDepthWarning({
    resumeText: "x".repeat(5000),
    skills: ["react", "node", "aws", "python", "sql", "docker", "kubernetes", "terraform"],
  });
  assert.equal(full, null, "a real resume must not be flagged");
});

test("the ATS panel renders the band for a DECLINED report, and the depth warning above it", () => {
  const panel = fs.readFileSync("client/src/panels/ATSPanel.jsx", "utf8");
  // The card used to be gated on `score != null`, so a declined report displayed nothing at all.
  assert.match(panel, /atsCard\.render/);
  assert.match(panel, /decline_reasons/);
  assert.match(panel, /atsCard\.depth/);
  assert.match(panel, /seniority_cap/);
  // And the donut is gone — it was the most precise-looking thing on the screen.
  assert.doesNotMatch(panel, /strokeDashoffset/,
    "the score donut is back; a ring filled to 43/100 claims a precision the engine does not have");
});

test("the mobile contract marks the score internal", () => {
  const contract = JSON.parse(fs.readFileSync(path.join("contract", "mobile-api.v1.json"), "utf8"));
  const job = contract.components.schemas.Job.properties.matchScore;
  assert.match(job.description, /INTERNAL/);
  assert.match(job.description, /DO NOT DISPLAY/i);
  // The two apply-side copies too.
  for (const schema of ["PendingResume", "RunJob"]) {
    const node = contract.components.schemas[schema].properties.atsScore;
    assert.match(node.description || "", /INTERNAL/, `${schema}.atsScore is not marked internal`);
  }
});
