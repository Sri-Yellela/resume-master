// THE AUTO APPLY PANEL IS ORGANISED AROUND OBSTACLES, NOT RUNS.
//
// It used to be a strip of run badges — "0✓ 1 review ↗" three times — plus a modal. "Run 47" is not
// a thing a user thinks about; they think about a job they want and what is stopping them. Worse,
// the strip flattened a rich terminal vocabulary into two words, "review" or "failed", losing the
// distinction that matters most:
//
//     WE DELIBERATELY HELD THIS TO PROTECT YOU        vs        THIS BROKE
//
// A resume below your ATS floor, a question we refused to guess, and an application filled and
// waiting for approval are the system working. A missing browser binary is not. Both said "failed".
//
// These tests pin the SERVER's four-way partition — which guarantees no application can fall out of
// every bucket — and the rule that every row names an obstacle and an action rather than a status
// code. The PANEL is now organised around three outcomes (needs review, submitted, problems) over a
// company tier, which is a different cut of the same data: the server's job is that nothing is lost,
// the panel's is that a human can act on it. AB4 separated held-on-purpose from broken INSIDE
// problems rather than leaving both under one word, which is the same flattening in a new place.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  describeApplication, sectionFor, boardApplicationChip, groupByApplication, groupByCompany,
  splitByFault, SECTION, PREREQUISITE_LABELS,
} from "../client/src/lib/applyObstacles.js";
// AD1: the outcome partition itself, so the sub-tab assertions read the shared source of truth
// rather than three literal words that could drift from what routes/apply.js files rows under.
import { OUTCOME, OUTCOME_LABELS } from "../shared/applyOutcomeGroups.js";
import { at } from "../test-support/sourceAnchors.js";

const read = (p) => fs.readFileSync(p, "utf8");
const panel = read("client/src/panels/AutoApplyPanel.jsx");
const sections = read("client/src/panels/AutoApplyPanelSections.jsx");
const obstacles = read("client/src/lib/applyObstacles.js");
const card = read("client/src/components/JobCard.jsx");
const ctx = read("client/src/contexts/AutoApplyContext.jsx");
const applyRoute = read("routes/apply.js");

// ── The four surfaces ────────────────────────────────────────────────────────────────────────

test("the panel is organised around OUTCOME: three SUB-TABS, plus progress (AB4 -> AD1)", () => {
  // Was ["Needs you", "In flight", "Submitted", "Stopped"], then AB4's three SECTIONS stacked down
  // the page. AD1 keeps the three outcomes and changes only how you reach one: they are SUB-TABS
  // over a dated listing, in the Database panel's layout, so the page is ONE listing rather than
  // three stacked ones plus a run history underneath showing the same rows a second time.
  //
  // RE-PINNED, NOT DELETED. What is being asserted — the panel is organised around three outcomes,
  // progress is not a fourth, and "Stopped" as one flattening word does not come back — is exactly
  // what it was. The three headings became three tabs whose labels come from OUTCOME_LABELS, the
  // same shared partition routes/apply.js files rows with; re-asserting the literal words here
  // would recreate the drift that partition exists to prevent.
  assert.match(panel, /<PanelSubTabs/);
  assert.match(panel, /\[OUTCOME\.COMPLETED, OUTCOME\.PENDING, OUTCOME\.ABORTED\]\.map/);
  assert.match(panel, /label: OUTCOME_LABELS\[g\]\.label\.toUpperCase\(\)/);
  assert.deepEqual(
    [OUTCOME.COMPLETED, OUTCOME.PENDING, OUTCOME.ABORTED].map(g => OUTCOME_LABELS[g].label),
    ["Completed", "Pending", "Aborted"]);
  // Held-on-purpose vs broke lives INSIDE aborted, still separated and still labelled.
  assert.match(panel, /These broke —/);
  assert.match(panel, /Held on purpose —/);
  assert.ok(!/SectionHeading[^>]*>\s*Stopped\s*</.test(panel),
    "the Stopped heading is back — it collapses held-on-purpose into failed");
  // IN FLIGHT is NOT an outcome — a queued application is neither submitted, nor waiting on the
  // user, nor broken — so it is not a fourth tab. It still has to exist: dropping it would lose a
  // capability, at the moment a user most needs it (a run they just started).
  assert.match(panel, /SectionHeading[^>]*>\s*In flight\s*</);
  assert.match(panel, /count=\{applyInFlight\.length\}/);
  assert.match(panel, /count=\{needsYouCount\}/);
  // The counts that sat on the SUBMITTED and PROBLEMS headings are the sub-tab count pills now, and
  // AD1 requirement 4 scopes them to the SELECTED DATE — with the label beside them saying so,
  // which is what makes the choice unambiguous rather than the number.
  assert.match(panel, /count: historyDate && history\?\.counts \? \(history\.counts\[g\] \?\? 0\) : null/);
  assert.match(panel, /Counts are for \$\{localDateLabel\(historyDate\)\}/);
  assert.match(panel, /"Pick a date to see counts"/);
});

test("PROBLEMS keeps 'we protected you' distinguishable from 'this failed'", () => {
  // The requirement is explicit that the HELD ON PURPOSE copy is right and must stay visible,
  // because the two need different affordances and produce different feelings.
  // RE-PINNED FOR AD1: splitByFault is applied to the DAY'S aborted rows rather than to the
  // cross-run `applyStopped` feed, because the ABORTED tab is one day of one outcome. The split
  // itself, and the two labelled halves it produces, are unchanged — which is the point.
  assert.match(panel, /const listedSplit\s+= splitByFault\(listedJobs\)/);
  // And the distinction is visible WITHOUT OPENING ANYTHING: two headings, two tones, two pills.
  assert.match(panel, /pillText="did not complete"/);
  // The held pill is CONDITIONAL, and that is AC3's rule surviving into the ABORTED tab rather than
  // a weakening of this one: a tile whose postings the 7-day cleanup removed is not "held on
  // purpose", because nothing is holding it and there is nothing left to hold. A dead posting is
  // filed under ABORTED by the override, so this is where such a tile now lands.
  assert.match(panel, /pillText=\{allGone \? "posting gone" : "held on purpose"\}/);
  assert.match(panel, /const allGone = items\.every\(j => j\.postingGone\)/);
  assert.match(panel, /These broke —/);
  assert.match(panel, /Held on purpose —/);
  assert.match(panel, /Nothing went wrong with these/);

  const { broke, held } = splitByFault([
    { status: "failed",   reasonCode: "internal_error" },
    { status: "failed",   reasonCode: "browser_binary_not_found" },
    { status: "rejected", reasonCode: null },
    { status: "held_review", reasonCode: "ats_below_threshold" },
  ]);
  assert.equal(broke.length, 2);
  assert.equal(held.length, 2, "a rejection and a protective hold are not failures");
});

test("every section groups by COMPANY — seven roles at one employer belong together", () => {
  // RE-PINNED FOR AD1. The four cross-run groupings became three per-tab ones over the same day's
  // rows — the sections they fed are sub-tabs now — and the RULE is identical in each: company over
  // application. Note that PENDING groups by APPLICATION first (AB2: three held run-job rows for one
  // posting are one card, not three) while COMPLETED and ABORTED group the raw rows, because a
  // submitted attempt and a failed attempt are each their own event, and collapsing two of them
  // would hide one of the two things that actually happened.
  assert.match(panel, /const listedByCompany\s+= groupByCompany\(groupByApplication\(listedJobs\)\)/);
  assert.match(panel, /const listedFlatByCompany = groupByCompany\(listedJobs\)/);
  assert.match(panel, /groupByCompany\(listedSplit\.broke\)/);
  assert.match(panel, /groupByCompany\(listedSplit\.held\)/);
  assert.match(sections, /export function CompanyHeading/);

  const g = groupByCompany([
    { company: "OpenAI", title: "A", finishedAt: 3 },
    { company: "OpenAI", title: "B", finishedAt: 5 },
    { company: "Stripe", title: "C", finishedAt: 9 },
  ]);
  assert.equal(g.length, 2);
  // Biggest employer first — that is the group the user came here to find.
  assert.equal(g[0].company, "OpenAI");
  assert.equal(g[0].items.length, 2);
  // Most recent first within a company.
  assert.equal(g[0].items[0].title, "B");
  // A posting removed by the cleanup has no company; they collect under one honest heading rather
  // than each becoming its own group of employers the user has never heard of.
  const anon = groupByCompany([{ company: null, finishedAt: 1 }, { company: "", finishedAt: 2 }]);
  assert.equal(anon.length, 1);
  // AE3: the string moved into shared/atsHosts.js, which is now the ONE place a company becomes
  // display text — so an unnameable employer and an ATS host cannot be labelled differently.
  assert.match(sections, /\{companyLabel\(company\)\}/);
});

test("a missing resume is a BUTTON, and only where a resume is the problem (requirement 5)", () => {
  // "resume required" was left as text — a dead chip with a tooltip. It gets a one-click fix.
  assert.match(panel, /const generateResume = \(job\) => \{/);
  assert.match(sections, /Generate a resume/);
  // But keyed on the REASON, not on resumeAvailable: three rows can lack a resume while only one
  // stopped because of it, and a Generate button beside "the apply browser is not installed on the
  // server" contradicts the sentence directly above it.
  assert.match(sections, /onGenerateResume && d\.resumeBlocked/);
  assert.match(sections, /app\.reasons\.some\(r => r\.resumeBlocked\)/);
  assert.equal(describeApplication({ status: "failed", reasonCode: "resume_unavailable" }).resumeBlocked, true);
  assert.equal(describeApplication({ status: "failed", reasonCode: "generation_failed" }).resumeBlocked, true);
  for (const c of ["browser_binary_not_found", "internal_error", "manual_review", "login_required"]) {
    assert.equal(describeApplication({ status: "failed", reasonCode: c }).resumeBlocked, false,
      `"${c}" is not fixed by generating a resume, so it must not offer to`);
  }
  // An unknown reason must not opt in by accident.
  assert.equal(describeApplication({ status: "failed", reasonCode: "brand_new" }).resumeBlocked, false);
});

test("the server serves the four surfaces as a TOTAL partition", () => {
  // stopped is defined by EXCLUSION, so a status added later cannot fall through every bucket and
  // vanish — which is exactly what happened to held_gate when it was split out of held_review.
  assert.match(applyRoute, /const IN_FLIGHT\s+= \['queued', 'running'\]/);
  assert.match(applyRoute, /const NEEDS_YOU\s+= \['held_review', 'held_gate'\]/);
  assert.match(applyRoute, /rj\.status NOT IN \(\$\{\[\.\.\.IN_FLIGHT, \.\.\.NEEDS_YOU\]/);
  assert.match(applyRoute, /inFlight: inFlight\.map\(publicRunJob\)/);
  assert.match(applyRoute, /submitted: submitted\.map\(publicRunJob\)/);
  assert.match(applyRoute, /stopped: stopped\.map\(publicRunJob\)/);
  // The counts that let a caller prove the partition is total.
  assert.match(applyRoute, /statusCounts/);
});

test("sectionFor is total — every status lands in exactly one section", () => {
  const statuses = ["queued", "running", "held_review", "held_gate", "submitted",
                    "failed", "rejected", "manual_review", "expired", "", "something_new"];
  const valid = new Set(Object.values(SECTION));
  for (const s of statuses) {
    const sec = sectionFor(s);
    assert.ok(valid.has(sec), `status "${s}" produced a section outside the four: ${sec}`);
  }
  assert.equal(sectionFor("queued"), SECTION.IN_FLIGHT);
  assert.equal(sectionFor("held_gate"), SECTION.NEEDS_YOU);
  assert.equal(sectionFor("submitted"), SECTION.SUBMITTED);
  // The catch-all, which is the property that matters: an unknown status is still SOMEWHERE.
  assert.equal(sectionFor("a_status_invented_next_year"), SECTION.STOPPED);
});

// ── Every row names an obstacle and an action, never a status code ───────────────────────────

test("every reason code the server can write has a plain-language presentation", () => {
  // Read the vocabulary off the SERVER rather than a hand-kept list, so teaching the pipeline a new
  // reason code fails here until someone writes the sentence for it.
  const emitted = new Set(
    [...applyRoute.matchAll(/reasonCode:\s*"([a-z_]+)"/g)].map(m => m[1])
      .concat([...applyRoute.matchAll(/\?\s*"([a-z_]+)"\s*$/gm)].map(m => m[1]))
  );
  // The ones this restructure is specifically about, named explicitly so the regex above drifting
  // cannot make this test vacuous.
  for (const c of ["ats_below_threshold", "awaiting_approval", "manual_review", "no_submit_button",
                   "resume_unavailable", "internal_error", "login_required", "captcha_required",
                   "incomplete_form", "low_confidence_answers", "no_fields_discovered"]) {
    emitted.add(c);
  }
  for (const code of emitted) {
    const d = describeApplication({ status: "held_review", reasonCode: code });
    assert.ok(d.obstacle && d.obstacle.length > 8,
      `reason code "${code}" has no obstacle sentence`);
    assert.ok(!/_/.test(d.obstacle),
      `reason code "${code}" renders as a code, not a sentence: "${d.obstacle}"`);
  }
});

test("the distinct terminal outcomes get DISTINCT sentences — none collapses into another", () => {
  const codes = ["ats_below_threshold", "awaiting_approval", "manual_review", "no_submit_button",
                 "submit_unverified", "no_fields_discovered", "resume_unavailable",
                 "internal_error", "browser_binary_not_found", "login_required", "captcha_required"];
  const seen = new Map();
  for (const c of codes) {
    const { obstacle } = describeApplication({ status: "held_review", reasonCode: c });
    assert.ok(!seen.has(obstacle),
      `"${c}" and "${seen.get(obstacle)}" render the SAME sentence — that is the flattening this ` +
      `restructure exists to undo`);
    seen.set(obstacle, c);
  }
  assert.equal(seen.size, codes.length);
});

test("held-on-purpose is distinguished from broken, which is the distinction the old UI lost", () => {
  const protective = ["ats_below_threshold", "awaiting_approval", "manual_review",
                      "login_required", "no_submit_button"];
  const broken = ["internal_error", "resume_unavailable", "browser_binary_not_found"];
  for (const c of protective) {
    assert.equal(describeApplication({ status: "held_review", reasonCode: c }).protective, true,
      `"${c}" is the system working as designed and must not read as a failure`);
  }
  for (const c of broken) {
    assert.equal(describeApplication({ status: "failed", reasonCode: c }).protective, false,
      `"${c}" is a real failure and must not read as a deliberate hold`);
  }
  // And the panel colours on it rather than on the status.
  assert.match(sections, /d\.protective \? "#6b7280" : "#dc2626"/);
});

test("retry is offered ONLY where retrying can work", () => {
  // "A 404 model ID and a login wall need different affordances" — offering Retry on something
  // permanent is a lie, so the row says so instead.
  assert.equal(describeApplication({ status: "failed", reasonCode: "internal_error" }).retryable, true);
  assert.equal(describeApplication({ status: "failed", reasonCode: "resume_unavailable" }).retryable, true);
  assert.equal(describeApplication({ status: "failed", reasonCode: "browser_binary_not_found" }).retryable, false);
  assert.equal(describeApplication({ status: "held_review", reasonCode: "no_submit_button" }).retryable, false);
  assert.equal(describeApplication({ status: "rejected" }).retryable, false);

  assert.match(sections, /variant === "stopped" && d\.retryable && onRetry/);
  assert.match(sections, /retrying will not change this/);
});

test("an unknown REASON on a known status inherits that status, and still reads as a sentence", () => {
  // held_review means the pipeline CHOSE to hold, whatever the reason turns out to be, so falling
  // back to the status is right and `protective` stays true. What must never happen is the raw code
  // reaching the screen.
  const d = describeApplication({ status: "held_review", reasonCode: "some_new_thing" });
  assert.ok(!/_/.test(d.obstacle), `an unmapped code leaked through as a code: "${d.obstacle}"`);
  assert.equal(d.protective, true, "a hold is deliberate even when its reason is new");
  assert.ok(d.action, "even an unknown outcome must offer the user something to do");
  assert.equal(d.code, "some_new_thing", "the raw code is kept for logs, just never rendered");
});

test("an unknown STATUS is filed as broken, never claimed as deliberate", () => {
  // This is the half that matters for honesty: an outcome nobody has described cannot be presented
  // as something the system did on purpose, and it lands in STOPPED rather than disappearing.
  const d = describeApplication({ status: "invented_next_year", reasonCode: "" });
  assert.equal(d.section, SECTION.STOPPED);
  assert.equal(d.protective, false);
  assert.ok(!/_/.test(d.obstacle), `an unmapped status leaked through as a code: "${d.obstacle}"`);
  assert.ok(d.action);
});

// ── The obstacle is grouped, and priced by what clearing it unblocks ─────────────────────────

test("the portal gate is ONE action with a count, not N rows", () => {
  // G5's amortisation, which the requirement calls the most differentiated thing in the product.
  assert.match(panel, /Sign in to \$\{p\.host\} once → \$\{p\.count\} application/);
  assert.match(panel, /applyGatePortals\.map/);
  assert.match(panel, /countLabel=\{p\.count === 1 \? "application" : "applications"\}/);
  // A CAPTCHA portal is NOT offered a sign-in — it is named as the user's own job.
  assert.match(panel, /gateReasons\?\.includes\("captcha_required"\)/);
});

test("the grouping has TWO halves, and each is used where it is true (AB2)", () => {
  // This test used to assert that held applications were grouped BY OBSTACLE — one rule, applied
  // everywhere. That rule is right for a portal sign-in and wrong for everything else, and it was
  // showing the same application three times, once per problem, each card claiming "1 APPLICATION".
  //
  //   group by OBSTACLE      when ONE action unblocks MANY applications  (the portal batches above)
  //   group by APPLICATION   when MANY obstacles block ONE application   (held reviews)
  //
  // Both halves are asserted here so neither can be quietly dropped in favour of the other again.
  assert.match(panel, /const heldApplications = groupByApplication\(applyReviewJobs\)/);
  assert.ok(!/const heldByObstacle = new Map\(\)/.test(panel),
    "held applications are grouped by obstacle again — one application with three problems is three cards");
  // The obstacle half survives, untouched, where it genuinely amortises.
  assert.match(panel, /applyGatePortals\.map/);
  assert.match(panel, /Sign in to \$\{p\.host\} once → \$\{p\.count\} application/);
});

test("one application with several obstacles is ONE entry, carrying all of them", () => {
  // The exact observed defect: the same OpenAI application three times, once per problem. The server
  // returns one row per RUN-JOB, so a job held / re-run / held again is three rows.
  const rows = [
    { id: 3, jobId: "j1", company: "OpenAI", title: "Staff Engineer", status: "held_review",
      reasonCode: "captcha_required", finishedAt: 3000 },
    { id: 2, jobId: "j1", company: "OpenAI", title: "Staff Engineer", status: "held_review",
      reasonCode: "manual_review", finishedAt: 2000 },
    { id: 1, jobId: "j1", company: null, title: null, status: "held_review",
      reasonCode: null, finishedAt: 1000 },
  ];
  const grouped = groupByApplication(rows);
  assert.equal(grouped.length, 1, "three problems on one application produced three cards again");
  assert.equal(grouped[0].reasons.length, 3, "the obstacles were collapsed away with the rows");
  // Company and role must be present: "One application — Held for you to look at" names neither.
  assert.equal(grouped[0].company, "OpenAI");
  assert.equal(grouped[0].title, "Staff Engineer");
  // Newest first, so the current state of the application leads.
  assert.equal(grouped[0].primary.code, "captcha_required");
  assert.equal(grouped[0].attempts, 3);
});

test("two DIFFERENT applications stay two cards, and identical walls collapse", () => {
  const two = groupByApplication([
    { id: 1, jobId: "a", company: "OpenAI", title: "A", status: "held_review", reasonCode: "manual_review", finishedAt: 1 },
    { id: 2, jobId: "b", company: "Anthropic", title: "B", status: "held_review", reasonCode: "manual_review", finishedAt: 2 },
  ]);
  assert.equal(two.length, 2, "grouping by application must not merge different applications");
  assert.equal(two[0].company, "Anthropic", "most recent application first");

  // Two attempts against the SAME wall are one thing to resolve, not two.
  const dup = groupByApplication([
    { id: 1, jobId: "a", company: "OpenAI", status: "held_review", reasonCode: "manual_review", finishedAt: 1 },
    { id: 2, jobId: "a", company: "OpenAI", status: "held_review", reasonCode: "manual_review", finishedAt: 2 },
  ]);
  assert.equal(dup.length, 1);
  assert.equal(dup[0].reasons.length, 1, "the same obstacle twice is one thing to resolve");
  assert.equal(dup[0].attempts, 2, "but both attempts are still counted");
});

test("a row with no job id is its own card, never merged into an `undefined` bucket", () => {
  // Merging them would produce one card claiming to be one application while standing for several.
  const g = groupByApplication([
    { id: 1, status: "held_review", reasonCode: "manual_review", finishedAt: 1 },
    { id: 2, status: "held_review", reasonCode: "incomplete_form", finishedAt: 2 },
  ]);
  assert.equal(g.length, 2);
});

test("the card names the application, and counts OBSTACLES rather than applications", () => {
  // A big "1" beside three separate cards is what made one job look like three.
  assert.match(sections, /export function ApplicationObstacleCard/);
  assert.match(sections, /One application · \{app\.reasons\.length\} thing\{many \? "s" : ""\} to resolve/);
  assert.match(sections, /\{companyLabel\(app\.company\)\}/);
  assert.match(sections, /to resolve\s*\n\s*<\/span>/);
  // Every obstacle is listed INSIDE the card. AC2 put a `plan` in front of this list — the same
  // problems with the co-resolvable ones lifted out — so the flat map is now the fallback arm and
  // the panel's own cards still take it. Both arms are asserted, because dropping either would
  // silently stop listing an application's problems on one of the two surfaces.
  assert.match(sections, /: app\.reasons\.map\(\(r, i\) => \(/,
    "the flat obstacle list is gone — the panel's own cards would list nothing");
  assert.match(sections, /\{plan\s*$/m, "the grouped arm is gone — the modal would list nothing");
});

test("the needs-you count is in APPLICATIONS, not run-job rows", () => {
  // One application held three times used to add 3 to the heading and to the tab badge.
  assert.match(panel, /applyQuestions\.length \+ applyPending\.length \+ heldApplications\.length/);
});

test("prerequisites are surfaced BEFORE queueing, as one blocking item with a fix", () => {
  // The gate already computed this and only spoke as a 409 after the user tried to start a run.
  assert.match(ctx, /api\("\/api\/integrations\/status"\)/);
  assert.match(ctx, /setApplyPrereqMissing/);
  assert.match(panel, /<PrerequisiteCards missing=\{applyPrereqMissing\}/);
  // The count is what it unblocks, and must include already-dispatched jobs, not just the basket.
  assert.match(panel, /queuedCount=\{applyQueue\.length \+ applyInFlight\.length\}/);
  for (const key of ["base_resume", "active_profile", "profile_email", "profile_name"]) {
    assert.ok(PREREQUISITE_LABELS[key], `no plain-language label for prerequisite "${key}"`);
    assert.ok(!/_/.test(PREREQUISITE_LABELS[key].obstacle));
  }
});

// ── AB3: Open is scoped to the card ──────────────────────────────────────────────────────────

test("the popup was never GIVEN a scope — that is the defect, not a scope it ignored", () => {
  // AB3 requirement 2 asks which of the two it is. It is the first: `openReview` took no arguments,
  // all seven cards passed the same bare function, and the modal had no scoping parameter at all —
  // so it rendered the full cross-run feeds every time. The fix is a scope that exists.
  assert.match(ctx, /const \[applyReviewScope, setApplyReviewScope\] = useState\(null\)/);
  assert.match(ctx, /applyReviewScope, setApplyReviewScope,/);
  assert.match(panel, /const openScoped = \(s\) => \{ setApplyRunDetail\(null\); setApplyReviewScope\(s\); setApplyRunDetailOpen\(true\); \}/);
  assert.match(panel, /const openApplicationReview = \(app\) => openScoped\(\{/);
  // Every card now opens the popup on the thing it stands for, so no card opens it bare.
  //
  // The two assertions that used to live here were `!/onAction={openReview}/` and
  // `!/onDetails={() => openReview()}/` — CALL-SITE SHAPES, and the two exact strings AB3 had just
  // finished replacing. They could only ever fail if someone re-typed the shape that had already
  // been fixed, and they passed for the whole time Open was unscoped through a third shape. They
  // are replaced by the identifier-level check in the AC1 test below, which does not care what
  // shape a call site takes.
  assert.match(panel, /onDetails=\{\(\) => openApplicationReview\(app\)\}/);
});

// ── AC1: Open is STILL unscoped — the half-fix, and the assertion that closes the class ──────

test("AC1: no CARD-LEVEL handler can name the unscoped entry point, whatever its shape", () => {
  // THE DIAGNOSIS. Not (a) a regression and not (c) a scope ignored downstream: (b) a HALF-FIX.
  // AB3 rewrote every call site whose SHAPE was `onAction={openReview}` / `onDetails={() =>
  // openReview()}` and left the one whose shape differed — `openReview` as the fallback arm of a
  // ternary on `onResolve`. Details was scoped; Open, on the same card, was not.
  //
  // THE MECHANISM. A fix applied by rewriting the call sites that MATCH A PATTERN, while the wrong
  // handler stays in scope as a bare zero-argument callable any site can still name. The pattern
  // covers the shapes the author looked at; the IDENTIFIER covers every shape. So this assertion is
  // written on the identifier, not on a call-site shape — the same reason the earlier assertion in
  // this file (`!/onAction={openReview}/`) failed to catch it.
  const code = panel.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  assert.ok(!/\bopenReview\b/.test(code),
    "the unscoped handler is still named `openReview` in live code — rename it away from the word " +
    "every card's control uses, or the next card-level prop will reach for it again");
  // The unscoped path exists, under a name no card control would reach for by habit.
  assert.match(panel, /const openEverything = \(\) => openScoped\(null\)/);

  // EVERY card-level handler prop must pass something scoped. Read the props off the source rather
  // than trusting one hand-written list: a prop added later is covered without editing this test.
  const CARD_HANDLER_PROPS = /\b(onResolve|onDetails|onAction|onSecondary)=\{([^}]*)\}/g;
  const UNSCOPED = /\bopenEverything\b/;
  for (const [whole, prop, expr] of code.matchAll(CARD_HANDLER_PROPS)) {
    assert.ok(!UNSCOPED.test(expr),
      `${prop} reaches the unscoped "everything" handler — its Open shows every application: ${whole}`);
  }
  // ...and openEverything is reached from exactly ONE place: the deliberate Review-all control.
  const reaches = [...code.matchAll(/openEverything/g)].length;
  assert.equal(reaches, 2, "openEverything must be declared once and called from ONE control");
  assert.match(panel, /<button onClick=\{openEverything\}/);
});

test("AC1: Open and Details on the same card scope to the SAME one application", () => {
  // The bug was that they did not: Details went through openApplicationReview, Open went bare. Both
  // arms are now the scoped handler, so they cannot disagree.
  assert.match(panel, /onResolve=\{resumable \? \(\) => openHandoff\(packet, app\) : openApplicationReview\}/);
  assert.match(panel, /onDetails=\{\(\) => openApplicationReview\(app\)\}/);
  // ApplicationObstacleCard must actually PASS the app, or a scoped handler receives nothing and
  // scopes to an empty set — which renders an empty popup rather than an over-full one.
  assert.match(sections, /onClick=\{\(\) => onResolve\(app\)\}/,
    "the card calls onResolve with no argument, so a scoped handler gets no application");
});

test("EVERY feed the popup renders is filtered by the scope, including the bulk actions", () => {
  // Scoping the visible list but not the bulk action would be worse than not scoping at all: a
  // popup titled with one application, whose "Approve all" submitted every pending one.
  for (const needle of [
    /const scopedReviewJobs = facet\("applications"\)/,
    /const scopedPending    = facet\("pending"\)/,
    /const scopedQuestions  = facet\("questions"\)/,
    /\(applyRunDetail \? applyRunDetail\.jobs : scopedReviewJobs\)/,
    /\{!applyRunDetail && scopedPending\.length > 0 && \(/,
    /\{!applyRunDetail && scopedQuestions\.length > 0 && \(/,
    /decidePending\(scopedPending\.map\(p => p\.runJobId\), true\)/,
    /Approve all \{scopedPending\.length\}/,
  ]) {
    assert.match(panel, needle, `an unscoped feed survives in the popup: ${needle}`);
  }
  // And nothing inside the modal reads the unscoped lists any more.
  const modal = panel.slice(at(panel, "Apply Runs Review Modal"));
  assert.ok(!/applyPending\.(length|map)/.test(modal),
    "the modal still reads the full pending list");
  assert.ok(!/applyQuestions\.(length|map)/.test(modal),
    "the modal still reads the full question list");
});

test("a portal batch is never shown inside a popup scoped to one application", () => {
  // A batch is BY DEFINITION about several applications.
  assert.match(panel, /\{!applyRunDetail && !scope && applyGatePortals\.length > 0 && \(/);
});

test("the popup SAYS which application it is about, and the empty state does too", () => {
  // It used to be titled "Jobs Needing Review" whichever row opened it — the honest name for a
  // popup that was always showing all of them.
  assert.match(panel, /: scope \? scope\.label/);
  assert.match(panel, /"Every application needing review"/);
  // The old title must not be RENDERED. It is still named in the comment that explains why it went,
  // so the check looks at the JSX expression rather than anywhere in the file.
  assert.ok(!/\?\s*"Jobs Needing Review"|:\s*"Jobs Needing Review"/.test(panel),
    "the popup is titled 'Jobs Needing Review' again — the honest name for one showing all of them");
  assert.match(panel, /Nothing left to resolve on \$\{scope\.label\}/);
});

test("REVIEW ALL survives as a deliberate, separate control", () => {
  // Requirement 3: it may exist — it is genuinely useful for working a queue in one sitting — but it
  // must not be what every row's Open does.
  assert.match(panel, /Review all \{needsYouCount\} →/);
  assert.match(panel, /const openEverything = \(\) => openScoped\(null\)/);
});

test("closing the popup clears the scope, so the next open cannot inherit the last card's", () => {
  assert.match(panel, /const closeReview = \(\) => \{ setApplyRunDetailOpen\(false\); setApplyRunDetail\(null\); setApplyReviewScope\(null\); \}/);
  assert.ok(!/setApplyRunDetailOpen\(false\); setApplyRunDetail\(null\); \}/.test(panel),
    "a close path still leaves the scope behind");
});

test("a run detail outranks an application scope — a run is its own question", () => {
  assert.match(panel, /const scope = applyRunDetail \? null : applyReviewScope/);
});

// ── The board and the pipeline stop being separate worlds ────────────────────────────────────

test("the board card shows its application state, from the SAME vocabulary", () => {
  assert.match(card, /import \{ boardApplicationChip \} from "\.\.\/lib\/applyObstacles\.js"/);
  assert.match(card, /<ApplyStateChip jobId=\{job\.jobId \|\| job\.id\}\/>/);
  assert.match(ctx, /applyStateByJobId/);

  // A job with no application adds nothing to the card — the board must not grow a column of blanks.
  assert.equal(boardApplicationChip(null), null);
  assert.equal(boardApplicationChip({}), null);
  assert.equal(boardApplicationChip({ status: "submitted" }).label, "Applied");
  assert.equal(boardApplicationChip({ status: "held_gate" }).label, "Needs you");
  assert.equal(boardApplicationChip({ status: "running" }).label, "Applying now");
  // Broken vs held-on-purpose survives onto the board too.
  assert.equal(boardApplicationChip({ status: "failed", reasonCode: "internal_error" }).label, "Didn't send");
  assert.equal(boardApplicationChip({ status: "rejected" }).label, "Stopped");
});

test("the needs-review count is still reachable from the board", () => {
  // Y4 put a badge on the AUTO APPLY tab; the restructure must not have cost it.
  assert.match(ctx, /needsAttentionCount: applyPending\.length \+ applyReviewJobs\.length \+ applyQuestions\.length/);
});

// ── Nothing was dropped ──────────────────────────────────────────────────────────────────────

test("every capability of the old strip survived the reorganisation", () => {
  for (const [what, needle] of [
    ["the run control",         /Autofill for Review/],
    ["the readiness gate",      /applyReadiness && !applyReadiness\.available/],
    ["the queue's tier notice", /automationTier === "account"/],
    ["the CAPTCHA warning",     /automationTier === "gated"/],
    ["queue removal",           /removeFromApplyQueue\(job\.jobId\)/],
    // AD1 REMOVED THE SEPARATE RUN-HISTORY SURFACE and dated navigation supersedes it: the calendar
    // is the panel's primary navigation and the three outcome groups are its sub-tabs, so a second
    // dated view underneath would have been the same rows twice. The CAPABILITY — "what did I put
    // into auto-apply on this day, and how did each one end" — is what this list is for, and it is
    // now the panel's whole body rather than a section at the bottom of it.
    ["dated navigation",        /onChange=\{\(iso\) => loadHistory\(iso, historyGroup\)\}/],
    ["the three outcome tabs",  /active=\{historyGroup\}/],
    ["abort, on the listing",   /const abortApplication = \(app\) =>/],
    ["soft delete",             /const hideApplication  = \(app\) =>/],
    // AC4 replaced the run-history CHIP LIST with a dated view, so the assertion that used to pin
    // `loadApplyRunDetail(run.id)` — the chip's own onClick — no longer describes anything that
    // exists. The CAPABILITY is what matters and it survives in two places: every application row
    // opens its run through onOpenRun, and the run's own status and counts render in that modal's
    // header (the status moved there deliberately, because the chip's dot was the only place a run
    // said whether it had finished).
    ["per-run detail",          /onOpenRun=\{loadApplyRunDetail\}/],
    ["the run's own status",    /applyRunDetail\.run\.status === "completed"/],
    ["the approvals surface",   /waiting for your approval/],
    // Reads the SCOPED list since AB3 — the surface is unchanged, what it lists is now scoped to
    // whatever the user opened it from.
    ["the questions surface",   /Answer \{scopedQuestions\.length\}/],
    ["bulk approve guard",      /confirmApproveAll/],
    ["artifact links",          /artifactUrl/],
  ]) {
    assert.match(panel, needle, `${what} did not survive the restructure`);
  }
});

test("the obstacle vocabulary is the only place these sentences live", () => {
  // If the panel started writing its own copy for a reason code, the board's chip and the panel
  // would drift — which is the class of bug the shared registry work has been closing all along.
  // The member list is not the point — that the panel READS the shared vocabulary is. Pinning the
  // exact list made this fail the moment the panel legitimately needed a second symbol from it.
  //
  // Nor is WHICH symbol the point. AC2 moved the modal's per-attempt row into the sections module,
  // and describeApplication went with it — the panel no longer calls it directly, and importing a
  // symbol it does not use would be dead code added to satisfy a test. So the assertion is that
  // the panel imports its vocabulary FROM applyObstacles.js and writes none of its own.
  assert.match(panel, /import \{[\s\S]{0,200}?\} from "\.\.\/lib\/applyObstacles\.js"/);
  assert.match(sections, /import \{[^}]*describeApplication[^}]*\} from "\.\.\/lib\/applyObstacles\.js"/);
  assert.ok(!/reasonCode === "/.test(panel),
    "the panel is branching on a reason code again — that belongs in applyObstacles.js");
  assert.ok(!/status === "held_review"/.test(sections),
    "the row component is branching on a status again — it must ask the shared vocabulary");
  assert.match(obstacles, /export function describeApplication/);
  // The STATUS PILL is vocabulary too, and it is a different question from describeApplication's:
  // "how did this attempt end" in one word, beside a timestamp, versus "what is in the way and what
  // clears it" in a sentence. It was written inline in the modal as a chain of ternaries — a second
  // copy of a mapping the rest of the app already had — so that surface said "Failed" where the
  // panel behind it said "This one did not complete". It has a home now.
  assert.match(obstacles, /export function attemptStatusChip/);
  assert.match(sections, /attemptStatusChip\(job\.status, theme\.accent\)/);
  assert.ok(!/status === "submitted" \? "Submitted"/.test(sections),
    "the attempt row is writing its own status labels again");
});
