// ── TASK AC2: the review modal, restructured ─────────────────────────────────────────────────
//
// COMPANY → APPLICATION → PROBLEMS, with co-resolvable problems grouped.
//
// The modal was a flat list of problem-cards built from run-job rows by its own inline JSX. Two
// problems on one job rendered as two entries; a dead posting for an unrelated job sat between
// them wearing a "Review" pill and leading nowhere; and nothing said which application was which.
//
// What is asserted HERE is the logic — which problems can share one crossing, and which cannot.
// What the DOM does with it is asserted in a real browser by scripts/abPanelUi.mjs, because "how
// many entries does one application produce" is exactly the class of defect a source-string test
// passes over. Both exist because neither alone caught AC1.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  resolutionPlan, groupByApplication, groupByCompany,
  CO_RESOLVABLE_GATE_REASONS, QUESTION_REASON_TO_HOLD,
} from "../client/src/lib/applyObstacles.js";

const read = (p) => fs.readFileSync(p, "utf8");
const panel = read("client/src/panels/AutoApplyPanel.jsx");
const sections = read("client/src/panels/AutoApplyPanelSections.jsx");

// ── Fixtures: the shapes the server really returns ───────────────────────────────────────────

const row = (o) => ({
  id: o.id, runId: o.runId ?? 1, jobId: o.jobId, company: o.company ?? null, title: o.title ?? null,
  status: o.status ?? "held_review", reasonCode: o.reasonCode ?? null, reasonDetail: null,
  startedAt: o.at ?? 1000, finishedAt: o.at ?? 1000, attemptCount: 1,
  atsScore: o.atsScore ?? null, resumeAvailable: true, screenshotAvailable: true,
  applyUrl: o.applyUrl ?? null,
});

const packet = (o) => ({
  packetId: o.packetId, jobId: o.jobId, runJobId: o.runJobId ?? null,
  expectedOrigin: o.origin, gateReason: o.gateReason, kind: o.kind ?? "gate",
  stale: false, postingGone: false, answerCount: 9,
});

const portal = (origin, host, count) => ({ origin, host, count, packetIds: [], gateReasons: ["login_required"] });

const question = (o) => ({
  question: o.q, reason: o.reason ?? "unanswered", eligibility: !!o.eligibility,
  blocking: (o.blocks || []).map(jobId => ({ jobId, runId: 1 })),
});

// ── Requirement 1: one entry per APPLICATION, never per problem ──────────────────────────────

test("AC2: two problems on ONE job are one application with two things to resolve", () => {
  // Exactly the shape the server returns after a job is held, re-run and held again — one row per
  // RUN-JOB. Keyed per problem this is two entries; keyed per application it is one.
  const apps = groupByApplication([
    row({ id: 1, jobId: "j1", company: "Anthropic", title: "RE", reasonCode: "incomplete_form", at: 200 }),
    row({ id: 2, jobId: "j1", company: "Anthropic", title: "RE", reasonCode: "manual_review", at: 100 }),
  ]);
  assert.equal(apps.length, 1, "two run-job rows for one job produced two applications");
  assert.equal(apps[0].reasons.length, 2, "the second problem was dropped rather than listed");
  assert.equal(apps[0].company, "Anthropic");
});

test("AC2: the modal groups by the SAME functions the panel's sections use, not a second grouping", () => {
  // Requirement 1 says the modal must MATCH the card summary. The only way that cannot drift is if
  // there is one grouping and one renderer, so the assertion is on the identifiers.
  assert.match(panel, /const modalApplications = groupByApplication\(applyRunDetail \? applyRunDetail\.jobs : scopedReviewJobs\)/);
  assert.match(panel, /const modalCompanies    = groupByCompany\(modalApplications\)/);
  // The old flat list, gone. It rendered run-job rows at the top level of the popup.
  assert.ok(!/\(applyRunDetail \? applyRunDetail\.jobs : scopedReviewJobs\)\.map\(job =>/.test(panel),
    "the modal still renders run-job rows as its top-level list");
  // And the entry is the card component the panel itself uses — not a second implementation.
  const modal = panel.slice(panel.indexOf("Apply Runs Review Modal"));
  assert.match(modal, /<ApplicationObstacleCard/, "the modal built its own entry again");
  assert.match(modal, /<CompanyHeading company=\{company\} count=\{items\.length\} theme=\{theme\} \/>/);
});

// ── Requirement 2: group co-resolvable problems, and ONLY where they really are ──────────────

test("AC2: a portal sign-in shared by four applications is ONE action with the count", () => {
  const apps = groupByApplication([
    row({ id: 10, jobId: "wd0", company: "Salesforce", title: "Eng", status: "held_gate", reasonCode: "login_required" }),
  ]);
  const plan = resolutionPlan(apps[0], {
    portals: [portal("https://sf.wd1.myworkdayjobs.com", "sf.wd1.myworkdayjobs.com", 4)],
    packets: [packet({ packetId: 1, jobId: "wd0", runJobId: 10, origin: "https://sf.wd1.myworkdayjobs.com", gateReason: "login_required" })],
    questions: [],
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].kind, "group");
  assert.equal(plan[0].unblocks, 4);
  assert.match(plan[0].headline, /Sign in to sf\.wd1\.myworkdayjobs\.com once/);
  assert.match(plan[0].detail, /3 others/, "the count of OTHERS is what makes it an offer");
});

test("AC2: a batch of ONE is not dressed up as a batch", () => {
  // "Sign in once → 1 application ready" is not an amortisation, it is the problem. Presenting it
  // as one inflates a single sign-in into an offer it cannot keep.
  const apps = groupByApplication([
    row({ id: 10, jobId: "wd0", company: "Salesforce", status: "held_gate", reasonCode: "login_required" }),
  ]);
  const plan = resolutionPlan(apps[0], {
    portals: [portal("https://sf.wd1.myworkdayjobs.com", "sf.wd1.myworkdayjobs.com", 1)],
    packets: [packet({ packetId: 1, jobId: "wd0", runJobId: 10, origin: "https://sf.wd1.myworkdayjobs.com", gateReason: "login_required" })],
    questions: [],
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].kind, "single", "a portal with one application was presented as a batch");
});

test("AC2: a CAPTCHA is NOT co-resolvable, even though the server groups it by origin", () => {
  // THE TRAP THIS TEST EXISTS FOR. GET /api/apply/gate-packets groups captcha_required into
  // `portals` alongside login_required, because both are gate reasons. Reading that grouping
  // naively would promise "solve one → 4 ready", and a CAPTCHA is a per-attempt human challenge,
  // not a session grant. Solving one clears one.
  assert.ok(!CO_RESOLVABLE_GATE_REASONS.has("captcha_required"),
    "captcha_required is being treated as co-resolvable — it is not a session grant");
  const apps = groupByApplication([
    row({ id: 20, jobId: "cap0", company: "Acme", status: "held_gate", reasonCode: "captcha_required" }),
  ]);
  const plan = resolutionPlan(apps[0], {
    // The portal count is 4 — the temptation is right there in the data.
    portals: [{ origin: "https://acme.com", host: "acme.com", count: 4, gateReasons: ["captcha_required"] }],
    packets: [packet({ packetId: 2, jobId: "cap0", runJobId: 20, origin: "https://acme.com", gateReason: "captcha_required" })],
    questions: [],
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].kind, "single");
  assert.equal(plan[0].unblocks, 1, "a CAPTCHA claimed to unblock more than one application");
});

test("AC2: a question blocking two applications is one action; blocking one is not", () => {
  const apps = groupByApplication([
    row({ id: 30, jobId: "j1", company: "OpenAI", reasonCode: "manual_review" }),
  ]);
  const shared = resolutionPlan(apps[0], {
    portals: [], packets: [],
    questions: [question({ q: "Are you authorised to work in the US?", blocks: ["j1", "j2"], eligibility: true })],
  });
  assert.equal(shared.filter(i => i.kind === "group").length, 1);
  assert.equal(shared[0].unblocks, 2);

  const alone = resolutionPlan(apps[0], {
    portals: [], packets: [],
    questions: [question({ q: "Are you authorised to work in the US?", blocks: ["j1"] })],
  });
  assert.ok(alone.every(i => i.kind === "single"),
    "a question blocking one application was presented as an amortised action");
});

test("AC2: `blocking` is counted by DISTINCT job — a re-run must not read as a second application", () => {
  // GET /api/apply/questions returns one `blocking` entry per RUN-JOB. A job held, re-run and held
  // again appears twice, and counting rows would report "unblocks 2" for one application. That is
  // the same overcount AB2 removed from the cards.
  const apps = groupByApplication([row({ id: 40, jobId: "j1", company: "OpenAI", reasonCode: "manual_review" })]);
  const plan = resolutionPlan(apps[0], {
    portals: [], packets: [],
    questions: [question({ q: "Sponsorship?", blocks: ["j1", "j1", "j1"] })],
  });
  assert.ok(plan.every(i => i.kind === "single"),
    "three run-job rows for ONE job were counted as three applications unblocked");
});

test("AC2: a shared question CLAIMS the hold it is the concrete form of, so one problem is not two", () => {
  // manual_review ("the form asked something only you can answer") and the question itself are one
  // fact at two levels of detail. Listing both reports one problem as two, and the grouped one
  // would claim to unblock 2 while the category beside it silently meant the same thing.
  const apps = groupByApplication([
    row({ id: 50, jobId: "j1", company: "Anthropic", reasonCode: "incomplete_form", at: 200 }),
    row({ id: 51, jobId: "j1", company: "Anthropic", reasonCode: "manual_review", at: 100 }),
  ]);
  const plan = resolutionPlan(apps[0], {
    portals: [], packets: [],
    questions: [question({ q: "Sponsorship?", reason: "unanswered", blocks: ["j1", "j2"] })],
  });
  assert.equal(plan.length, 2, "two problems became three items");
  assert.equal(plan[0].kind, "group");
  assert.equal(plan[0].reasons[0].code, "manual_review",
    "the question claimed the wrong hold — the binding is by the question's own reason");
  assert.equal(plan[1].kind, "single");
  assert.equal(plan[1].reasons[0].code, "incomplete_form",
    "incomplete_form is a SECOND empty field, so it must survive as its own problem");
});

test("AC2: the binding is by the question's own reason, not by whichever attempt is newest", () => {
  // Picking the first plausible reason off a list is a guess that lands differently depending on
  // which attempt happened to be newest. QUESTION_REASON_TO_HOLD makes it deterministic.
  assert.deepEqual(QUESTION_REASON_TO_HOLD.low_confidence, ["low_confidence_answers"]);
  assert.deepEqual(QUESTION_REASON_TO_HOLD.unanswered, ["manual_review", "incomplete_form"]);
  const apps = groupByApplication([
    row({ id: 60, jobId: "j1", reasonCode: "manual_review", at: 200 }),
    row({ id: 61, jobId: "j1", reasonCode: "low_confidence_answers", at: 100 }),
  ]);
  const plan = resolutionPlan(apps[0], {
    portals: [], packets: [],
    questions: [question({ q: "Salary?", reason: "low_confidence", blocks: ["j1", "j2"] })],
  });
  assert.equal(plan[0].reasons[0].code, "low_confidence_answers",
    "a low_confidence question claimed manual_review because it was newer");
});

test("AC2: nothing else claims co-resolution — every other hold stands alone", () => {
  // The list from the requirement: state which groupings are possible and which are not, and do not
  // claim co-resolution where the holds cannot actually share one crossing.
  const NOT_CO_RESOLVABLE = [
    "ats_below_threshold", "no_submit_button", "no_fields_discovered", "resume_unavailable",
    "generation_failed", "answers_changed_since_approval", "daily_cap_reached",
    "full_auto_disabled", "provider_review_only", "browser_binary_not_found", "internal_error",
    "form_schema_empty", "form_schema_no_host", "gate_token_no_secret", "submit_unverified",
  ];
  for (const code of NOT_CO_RESOLVABLE) {
    const apps = groupByApplication([row({ id: 70, jobId: "j1", company: "X", reasonCode: code })]);
    const plan = resolutionPlan(apps[0], {
      // Every co-resolution input is present and pointed at this application. Nothing may bite.
      portals: [portal("https://x.com", "x.com", 5)],
      packets: [packet({ packetId: 3, jobId: "j1", runJobId: 70, origin: "https://x.com", gateReason: code })],
      questions: [],
    });
    assert.equal(plan.length, 1, `${code} produced more than one item`);
    assert.equal(plan[0].kind, "single", `${code} was presented as co-resolvable`);
    assert.equal(plan[0].unblocks, 1, `${code} claimed to unblock ${plan[0].unblocks} applications`);
  }
});

test("AC2: amortised actions are ordered first, biggest first", () => {
  const apps = groupByApplication([
    row({ id: 80, jobId: "j1", company: "X", status: "held_gate", reasonCode: "login_required", at: 300 }),
    row({ id: 81, jobId: "j1", company: "X", reasonCode: "ats_below_threshold", at: 200 }),
    row({ id: 82, jobId: "j1", company: "X", reasonCode: "manual_review", at: 100 }),
  ]);
  const plan = resolutionPlan(apps[0], {
    portals: [portal("https://x.com", "x.com", 6)],
    packets: [packet({ packetId: 4, jobId: "j1", runJobId: 80, origin: "https://x.com", gateReason: "login_required" })],
    questions: [question({ q: "Sponsorship?", blocks: ["j1", "j2", "j3"] })],
  });
  assert.deepEqual(plan.map(i => i.kind), ["group", "group", "single"]);
  assert.deepEqual(plan.map(i => i.unblocks), [6, 3, 1],
    "the most amortised action is not first — that ordering is the whole argument for grouping");
});

test("AC2: co-resolution reads the SERVER's groupings, and does not re-derive them", () => {
  // The requirement: preserve the existing per-portal batch logic rather than writing a second
  // grouping. The portal grouping lives in routes/apply.js (by expected_origin, the unit an
  // activeTab grant is scoped to); the question deduplication lives in GET /api/apply/questions.
  const lib = read("client/src/lib/applyObstacles.js");
  assert.match(panel, /portals: applyGatePortals, packets: applyHandoffPackets, questions: applyQuestions/);
  // The origin is matched against the packet's STORED origin. Parsing it back out of an apply URL
  // would be the second grouping, and it would be wrong — a posting host and the login host it
  // redirects to routinely differ.
  assert.match(lib, /portals\.find\(p => p\.origin === packet\.expectedOrigin\)/);
  assert.ok(!/new URL\([^)]*applyUrl/.test(lib),
    "the origin is being re-derived from an apply URL instead of read off the packet");
});

// ── Requirements 3, 4 and 5: the states and the controls ─────────────────────────────────────

test("AC2: held-on-purpose vs broken, and the dead posting, are states the ENTRY already carries", () => {
  // Requirement 3 and 4. Both live on the component the modal now renders, which is why the modal
  // gets them for free rather than needing a second description that could disagree.
  assert.match(sections, /app\.postingGone \? "the posting is gone"/);
  assert.match(sections, /app\.protective \? "held on purpose" : "did not complete"/);
  // A dead posting gets NO action and says why — not a Review button leading nowhere.
  assert.match(sections, /\{app\.postingGone \? \(\s*<span[\s\S]*?posting gone — cannot be resumed/);
});

test("AC2 requirement 5: every control survives, and the attempts are one disclosure away", () => {
  // The modal's old flat row carried the per-attempt detail. Collapsing run-jobs into one
  // application is only honest if that detail stays reachable, so it moved into AttemptRow and is
  // rendered as the card's children.
  assert.match(sections, /export function AttemptRow\(/);
  for (const control of [
    // AE4 removed the held-attempt screenshot; a SUBMITTED attempt keeps its own, which is the
    // control this now pins. An attempt that went out and an attempt that held are different rows.
    /Resume PDF ↗/, /job\.status === "submitted" && job\.screenshotAvailable/,
    /ATS \{job\.atsScore\}/, /Open & fill ↗/, /Run it again/,
    /posting gone — cannot be resumed/, /submission verified/, /unverified submit/,
  ]) {
    assert.match(sections, control, `a control was dropped from the attempt row: ${control}`);
  }
  // And on the application entry itself.
  // The application entry is a HELD application by construction, so AE4 leaves it no screenshot.
  for (const control of [/Resume PDF ↗/, /ATS \{app\.atsScore\}/, /The posting ↗/,
                         /Generate a resume/]) {
    assert.match(sections, control, `a control was dropped from the application entry: ${control}`);
  }
  const modal = panel.slice(panel.indexOf("Apply Runs Review Modal"));
  assert.match(modal, /<AttemptRow key=\{row\.id\} job=\{row\}/);
  assert.match(modal, /Show\`\} \$\{app\.rows\.length\} attempt|Hide"\} \$\{app\.rows\.length\}|attempt\$\{app\.rows\.length === 1 \? "" : "s"\}/,
    "the attempts disclosure does not say how many attempts there are");
});

test("AC2: the modal's own Open is scoped too — AC1 must not come back one surface along", () => {
  const modal = panel.slice(panel.indexOf("Apply Runs Review Modal"));
  assert.match(modal, /onResolve=\{resumable \? \(\) => openHandoff\(packet, app\) : openApplicationReview\}/);
  assert.ok(!/\bopenEverything\b/.test(modal.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")),
    "the modal reaches the unscoped handler");
});

test("AC2: a company with several applications is one heading, not several", () => {
  const apps = groupByApplication([
    row({ id: 90, jobId: "a", company: "OpenAI", title: "Staff", reasonCode: "manual_review", at: 300 }),
    row({ id: 91, jobId: "b", company: "OpenAI", title: "ML", reasonCode: "manual_review", at: 200 }),
    row({ id: 92, jobId: "c", company: "Stripe", title: "Infra", reasonCode: "manual_review", at: 100 }),
  ]);
  const companies = groupByCompany(apps);
  assert.deepEqual(companies.map(c => [c.company, c.items.length]), [["OpenAI", 2], ["Stripe", 1]]);
});
