// TASK AD1 — THE AUTO APPLY PANEL ADOPTS THE DATABASE PANEL'S LAYOUT.
//
// The panel was a STACK: a queue, an in-flight section, a needs-review section, a submitted section,
// a problems section, and then — underneath all of it — a separate dated run-history surface showing
// the same records a second time in a smaller rendering. Six things down one page, two of which were
// the same rows.
//
// It is now the shape the Database panel has always been: a sub-tab row with per-tab counts, a
// control row with a search box and a "Filter by date" calendar, and a body. The three sub-tabs are
// AC4's outcome partition — COMPLETED / PENDING / ABORTED — so the run history is not "removed", it
// IS the panel now.
//
// What these tests hold:
//   1. the chrome is REUSED, not cloned, and the Database panel renders the same components
//   2. the removed run-history surface lost nothing — every consumer still has what it needs
//   3. nothing is fetched until a date is picked, and a tab switch fetches ONE tab
//   4. the counts are date-scoped and SAY so
//   5. PENDING is where you land
//   6. everything AC1–AC4 delivered is still on the page
//   8. the AUTO APPLY tab badge still counts what needs attention, without a preload
//
// (Requirement 7 — the three empty states — is pinned in applyRunHistory.test.js beside the two
// states it grew out of, and the totality of the status mapping is pinned there too.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { OUTCOME, OUTCOME_STATUSES, OUTCOME_LABELS } from "../shared/applyOutcomeGroups.js";
import { at } from "../test-support/sourceAnchors.js";

const read = (f) => fs.readFileSync(f, "utf8");
const panel    = read("client/src/panels/AutoApplyPanel.jsx");
const sections = read("client/src/panels/AutoApplyPanelSections.jsx");
const ctx      = read("client/src/contexts/AutoApplyContext.jsx");
const dbPanel  = read("client/src/panels/DatabasePanel.jsx");
const controls = read("client/src/components/ui/PanelControls.jsx");
const applyRoute = read("routes/apply.js");
const harness  = read("scripts/abPanelUi.mjs");

// ── Requirement: REUSE, DO NOT CLONE ─────────────────────────────────────────────────────────

test("AD1: the layout is ONE implementation, rendered by both panels", () => {
  // The instruction is explicit — "Extract or reuse the primitives... a second copy of this layout
  // is how two surfaces drift apart" — and the only proof that survives is that the panel it came
  // FROM stopped holding its own copy. An extraction the source panel does not use is a clone.
  for (const name of ["PanelSubTabs", "PanelSearch", "DateFilterButton"]) {
    assert.ok(new RegExp(`export function ${name}\\(`).test(controls),
      `${name} was not extracted`);
    assert.ok(new RegExp(`<${name}`).test(dbPanel), `DatabasePanel does not render ${name}`);
    assert.ok(new RegExp(`<${name}`).test(panel), `AutoApplyPanel does not render ${name}`);
  }
  // And neither panel writes the markup any more. These are the exact strings the two copies would
  // reintroduce: the underline, the magnifier, the pill's label.
  for (const [name, src] of [["DatabasePanel", dbPanel], ["AutoApplyPanel", panel]]) {
    assert.ok(!/layoutId="db-tab-underline"[\s\S]{0,200}?<motion\.div/.test(src),
      `${name} is drawing its own tab underline again`);
    assert.ok(!/pointerEvents:"none", color:theme\.textDim \}\}>🔍/.test(src),
      `${name} is drawing its own search box again`);
  }
  assert.match(controls, /pointerEvents: "none", color: theme\.textDim \}\}>🔍/);
  assert.match(controls, /📅 \{value \? `Date: \$\{format\(value\)\}` : label\}/);
});

test("AD1: the shared chrome owns no panel state — the two panels fetch entirely differently", () => {
  // The Database panel loads everything on mount; the Auto Apply panel loads nothing until a date is
  // picked. A shared component that owned "which tab" or "which date" would have to pick one of
  // those rules for both, and the wrong one violates requirement 3 outright. So the only state in
  // here is whether the popover happens to be open, which is nobody else's business.
  const stateful = [...controls.matchAll(/useState\(/g)];
  assert.equal(stateful.length, 2, "PanelControls grew state that belongs to a panel");
  assert.match(controls, /const \[open, setOpen\] = useState\(false\)/);
  assert.match(controls, /const \[rect, setRect\] = useState\(null\)/);
  // Active tab, search text and selected date all arrive as props.
  for (const prop of ["active", "onSelect", "value", "onChange"]) {
    assert.ok(new RegExp(`\\b${prop}[,}]`).test(controls), `${prop} is not a prop of the chrome`);
  }
});

test("AD1: the Database panel's own behaviour is unchanged by the extraction", () => {
  // Its four sheets, their counts, the rule that changing sheet clears the search and the date
  // filter, and the two toolbar buttons that ride along on the tab row. The behaviour is the
  // panel's; only the markup moved.
  assert.match(dbPanel, /const SHEETS = \[\["applications","Applications"\],\["resumes","Resumes"\],\["saved","Saved Jobs"\],\["pending","Pending Apply"\]\]/);
  assert.match(dbPanel, /onSelect=\{\(id\) => \{ setActiveSheet\(id\); setSearch\(""\); setFilterDate\(""\); \}\}/);
  assert.match(dbPanel, /count: id === "applications" \? apps\.length/);
  assert.match(dbPanel, /Export Excel/);
  assert.match(dbPanel, /\{loading \? "⏳" : "↻"\} Refresh/);
  // The date filter is still only offered on the Applications sheet, and it still clears.
  assert.match(dbPanel, /\{isApps && \(\s*\n\s*<DateFilterButton/);
  assert.match(dbPanel, /onClear=\{\(\) => setFilterDate\(""\)\}/);
  // No markers: the one thing AC4 added to the calendar is opt-in and this panel did not opt in.
  assert.ok(!/markers=/.test(dbPanel));
});

// ── Requirement 2: the run-history surface is gone, and nothing went with it ─────────────────

test("AD1 requirement 2: the separate run-history surface is removed", () => {
  assert.ok(!/export function HistoryGroup/.test(sections), "HistoryGroup survived");
  assert.ok(!/export function HistoryRow/.test(sections), "HistoryRow survived");
  assert.ok(!/<HistoryGroup|<HistoryRow/.test(panel), "the panel still renders the history components");
  assert.ok(!/HistoryGroup,|HistoryRow,|, HistoryGroup|, HistoryRow/.test(
    panel.slice(0, at(panel, "export function AutoApplyPanel"))),
    "the panel still imports the history components");
  assert.ok(!/SectionHeading[^>]*>\s*Run history\s*</.test(panel),
    "the Run history section heading is back — dated navigation was supposed to supersede it");
  // The enumeration of where each piece went is the deliverable, not decoration: a removal that
  // does not say what it moved is indistinguishable from a removal that dropped something.
  assert.match(sections, /HistoryRow AND HistoryGroup ARE GONE/);
  // "What we filled" is deliberately absent from this list since AE4: the affordance was REMOVED
  // from held rows, not moved, so an enumeration accounting for where it went would be describing a
  // relocation that did not happen. Its removal is asserted in applyHeldResumable.test.js.
  for (const moved of ["Abort", "Remove", "Resume PDF", "the obstacle sentence"]) {
    assert.ok(sections.includes(moved), `the enumeration does not account for "${moved}"`);
  }
});

test("AD1 requirement 2: every consumer of the removed surface still has what it needs", () => {
  // Named in the task: runInFlight (the polling) and nothingYet. Both read the CROSS-RUN feeds,
  // which are untouched — the surface that went away was the dated one, and it was never their
  // source. Proven by reading what they are actually built from rather than by assertion.
  const inFlight = ctx.match(/const runInFlight = [^\n]+/)[0];
  assert.match(inFlight, /applyRuns\.some\(r => r\.status === "queued" \|\| r\.status === "running"\)/);
  assert.ok(!/history/i.test(inFlight), "runInFlight now depends on the dated history");
  const nothingYet = panel.slice(at(panel, "const nothingYet ="),
                                 at(panel, "// ── Grouping"));
  assert.ok(!/history/i.test(nothingYet), "nothingYet now depends on the dated history");
  for (const feed of ["applyQueue", "applyRuns", "applyReviewJobs", "applyPending", "applyQuestions",
                      "applyInFlight", "applySubmitted", "applyStopped", "applyPrereqMissing"]) {
    assert.ok(nothingYet.includes(feed), `nothingYet lost its ${feed} term`);
  }
  // PER-RUN DETAIL. AC4 moved it off the run-history chip and onto every application row; it is
  // still there, on the rows the listing renders, and the run's own status still renders in the
  // modal header that opens — which was the chip's other job.
  // Four call sites: the in-flight band, the COMPLETED listing, and both halves of ABORTED.
  assert.equal((panel.match(/onOpenRun=\{loadApplyRunDetail\}/g) || []).length, 4,
    "per-run detail is no longer on every row of the listing");
  assert.match(panel, /applyRunDetail\.run\.status === "completed"/);
});

// ── Requirement 3: on demand, and one tab per fetch ──────────────────────────────────────────

test("AD1 requirement 3: no effect anywhere loads the listing", () => {
  // The real proof is a network check and scripts/abPanelUi.mjs makes it. What is asserted here is
  // the structural reason that stays true, because a loader effect added later would break the
  // requirement silently and a source check names the thing not to add.
  // AH6 added exactly ONE loader effect: the mount asks /api/apply/history/latest, which returns a
  // DATE and never rows, and opens on that day if there is one. Requirement 3 is about what is
  // FETCHED, and no listing is fetched for a day nobody named — which is the part that has not
  // changed and is what is asserted. See test/autoApplyRecentDefault.test.js for the rest.
  const loaders = [...ctx.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[/g)]
    .filter(m => /loadHistory\b/.test(m[1]));
  assert.equal(loaders.length, 1, "only AH6's latest-date bootstrap may load the history");
  assert.match(loaders[0][1], /\/api\/apply\/history\/latest/);
  for (const effectBody of ctx.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[/g)) {
    assert.ok(!/selectHistoryGroup\b/.test(effectBody[1]),
      "an effect switches sub-tab — which fetches, if a date is already selected");
  }
  // Defaulting the TAB costs nothing, and the distinction matters: requirement 3 is about what is
  // fetched, not about what is selected.
  assert.match(ctx, /const \[historyGroup, setHistoryGroup\] = useState\(OUTCOME\.PENDING\)/);
  assert.match(ctx, /const \[historyDate, setHistoryDate\] = useState\(null\)/);
  assert.match(ctx, /const \[history, setHistory\] = useState\(null\)/);
});

test("AD1 requirement 3: switching sub-tabs refetches THAT tab, and only that tab", () => {
  // One request, carrying the group. Not three, and not "fetch the day and filter here" — which
  // would be the same violation wearing a different hat.
  assert.match(ctx, /const selectHistoryGroup = useCallback\(\(group\) => \{/);
  assert.match(ctx, /if \(historyDate\) loadHistory\(historyDate, group\);/);
  assert.match(ctx, /else setHistory\(null\);/);
  assert.match(ctx, /group=\$\{encodeURIComponent\(wanted\)\}/);
  assert.equal((ctx.match(/api\(\s*\n?\s*`\/api\/apply\/history\?/g) || []).length, 1,
    "the history is fetched from more than one place — they will disagree");
  // The panel hands the tab row straight to it, so there is no second path that could skip the
  // refetch or fetch more than one group.
  assert.match(panel, /onSelect=\{selectHistoryGroup\}/);
  assert.match(panel, /active=\{historyGroup\}/);
  // And the SERVER really narrows. A `group` it does not recognise is refused rather than answered
  // with everything, which is the failure mode that would be invisible.
  assert.match(applyRoute, /if \(asked && !Object\.prototype\.hasOwnProperty\.call\(OUTCOME_STATUSES, asked\)\)/);
  assert.match(applyRoute, /error: "bad_group"/);
  assert.match(applyRoute, /\? \{ group: asked, jobs: groups\[asked\] \}/);
});

// ── Requirement 4: the counts, and the decision behind them ──────────────────────────────────

test("AD1 requirement 4: counts are DATE-SCOPED, and the label says which", () => {
  // The decision, and it differs from the Database panel deliberately: that panel's tabs are ENTITY
  // TYPES with stable counts, these are OUTCOME STATES OF ONE ENTITY that a run moves between as it
  // progresses. Date-scoped is also the only option compatible with requirement 3 — a global count
  // needs a query at render.
  assert.match(panel, /count: historyDate && history\?\.counts \? \(history\.counts\[g\] \?\? 0\) : null/);
  assert.match(panel, /Counts are for \$\{localDateLabel\(historyDate\)\}/);
  assert.match(panel, /"Pick a date to see counts"/);
  // Unambiguous in BOTH states, which is what the requirement asks for — including on the tab
  // itself, so the number is never read without its scope.
  assert.match(panel, /\$\{OUTCOME_LABELS\[g\]\.label\} on \$\{localDateLabel\(historyDate\)\}/);
  assert.match(panel, /Pick a date to see how many\./);
  // The reasoning is written down where the next person will be standing when they wonder.
  assert.match(panel, /COUNTS ARE SCOPED TO THE SELECTED DATE/);
});

// ── Requirement 5: where you land ────────────────────────────────────────────────────────────

test("AD1 requirement 5: PENDING is the landing tab — the actionable one is not buried", () => {
  // AB4 fixed exactly this by putting NEEDS REVIEW first; landing on COMPLETED would undo it.
  assert.match(ctx, /useState\(OUTCOME\.PENDING\)/);
  assert.equal(OUTCOME.PENDING, "pending");
  // The ORDER of the row is the requirement's own — COMPLETED · PENDING · ABORTED — and PENDING
  // being the default is what keeps it from being buried behind the first one.
  assert.match(panel, /\[OUTCOME\.COMPLETED, OUTCOME\.PENDING, OUTCOME\.ABORTED\]\.map/);
  // And the actionable work — portals, questions, approvals, prerequisites — is on that tab.
  const band = panel.slice(at(panel, "THE STANDING WORK, ON THE PENDING TAB"),
                           at(panel, "THE BODY — ONE DAY"));
  assert.match(band, /historyGroup === OUTCOME\.PENDING && \(/);
  for (const [what, needle] of [
    ["the portal batches",   /applyGatePortals\.map\(p => \{/],
    ["the prerequisites",    /<PrerequisiteCards/],
    ["confirm questions",    /confirmQuestions\.length > 0 && \(/],
    ["attestations",         /attestQuestions\.length > 0 && \(/],
    ["pending approvals",    /waiting for your approval/],
    ["Review all",           /Review all \{needsYouCount\} →/],
    ["in flight",            /applyInFlight\.map\(job =>/],
  ]) {
    assert.match(band, needle, `${what} is not on the PENDING tab`);
  }
});

test("AD1: the standing work is NOT behind the date picker, and the panel says why", () => {
  // A portal batch releases applications queued across many days; a shared question blocks whatever
  // was asked it, whenever. Filing those under one day would file them under a day that is not true
  // of them, and hiding the product's most differentiated surface behind a calendar would be worse.
  assert.match(panel, /none of it is date-scoped and none of it can be/);
  // It reads the cross-run feeds, not the dated endpoint — so it costs no query at render.
  const band = panel.slice(at(panel, "THE STANDING WORK, ON THE PENDING TAB"),
                           at(panel, "THE BODY — ONE DAY"));
  assert.ok(!/\bhistory\.jobs\b|\blistedJobs\b|\blistedByCompany\b/.test(band),
    "the standing band reads the dated listing — it would empty out until a date is picked");
});

// ── Requirement 6: everything AC1–AC4 delivered is still here ────────────────────────────────

test("AD1 requirement 6: nothing AC1–AC4 built was dropped by the restructure", () => {
  for (const [what, needle] of [
    // AC2/AC3 — company → application → problems, in the listing.
    ["company → application",      /listedByCompany\.map\(\(\{ company, items \}\) => \{/],
    ["the company tile",           /<CompanyTile/],
    ["the application row",        /<CompanyApplicationRow/],
    ["problems, in the modal",     /const modalCompanies    = groupByCompany\(modalApplications\)/],
    // AC1 — Open is scoped, and "Review all" is the only unscoped path.
    ["scoped Open",                /onResolve=\{resumable \? \(\) => openHandoff\(packet, app\) : openApplicationReview\}/],
    ["scoped Details",             /onDetails=\{\(\) => openApplicationReview\(app\)\}/],
    ["the one unscoped path",      /const openEverything = \(\) => openScoped\(null\);/],
    ["Review all, per company",    /onClick=\{\(\) => openCompanyReview\(company, items\)\}/],
    // AB1 — the resumable handoff and its refusals.
    ["the handoff",                /openHandoff\(packet, app\)/],
    ["a stale packet re-runs",     /const rerunJob = \(job\) => \{/],
    ["the handoff message",        /\{handoffMsg && \(/],
    // AB4 — held on purpose vs broke, and the resume button.
    ["broke vs held on purpose",   /These broke —/],
    ["the generate button",        /onGenerateResume=\{job\.resumeAvailable \? null : generateResume\}/],
    // AC4 — abort and soft delete.
    ["abort",                      /onAbort=\{abortApplication\}/],
    ["soft delete",                /onHide=\{hideApplication\}/],
  ]) {
    assert.match(panel, needle, `${what} did not survive AD1`);
  }
  // The row-level evidence, on the rows the listing renders.
  for (const [what, needle] of [
    ["Resume PDF",     /Resume PDF ↗/],
    // AE4: on a held listing row the screenshot said nothing the row did not, so it is gone from
    // here. What has to survive is the SUBMITTED case, which is the one a candidate needs later.
    ["the submitted screenshot", /Screenshot of the form ↗/],
    // AK2: the chip renders a BAND now, not "ATS 43" — the engine cannot support a displayed
    // number (rho 0.746, 12.2% of pairs mis-ordered). What this line has always guarded is that
    // the chip EXISTS on the row, so it is re-pinned on the band call rather than deleted.
    ["the ATS chip",   /atsBandFor\(app\.atsScore/],
    ["the posting",    /The posting ↗/],
    ["Details",        /Details\s*\n\s*<\/button>/],
    ["the soft-hide copy", /hidden, not deleted, and can be restored/],
  ]) {
    assert.match(sections, needle, `${what} is gone from the listing rows`);
  }
});

test("AD1 requirement 6: co-resolution grouping and its exclusions are untouched", () => {
  // resolutionPlan is what lifts the co-resolvable holds out of an application's problem list, and
  // it is the one piece of AC2 that AD1 could most easily have orphaned by restructuring around it.
  assert.match(panel, /const planFor = \(app\) => resolutionPlan\(app, \{/);
  assert.match(panel, /portals: applyGatePortals, packets: applyHandoffPackets, questions: applyQuestions/);
  const obstacles = read("client/src/lib/applyObstacles.js");
  assert.match(obstacles, /export const CO_RESOLVABLE_GATE_REASONS = Object\.freeze\(new Set\(\["login_required"\]\)\)/);
  // The exclusions, by name — each is a hold that looks shareable and is not.
  for (const excluded of ["captcha_required", "daily_cap_reached"]) {
    assert.ok(obstacles.includes(excluded), `the "${excluded}" exclusion is gone`);
  }
  // captcha_required is still named on the panel too, as its own card rather than a portal batch.
  assert.match(panel, /const isCaptcha = p\.gateReasons\?\.includes\("captcha_required"\)/);
  assert.match(panel, /is behind a CAPTCHA or identity check/);
});

// ── Requirement 1: the mapping is AC4's, unchanged ───────────────────────────────────────────

test("AD1 requirement 1: the sub-tabs ARE AC4's partition, not a second copy of it", () => {
  assert.deepEqual(OUTCOME_STATUSES[OUTCOME.COMPLETED], ["submitted"]);
  assert.deepEqual(OUTCOME_STATUSES[OUTCOME.PENDING], ["queued", "running", "held_review", "held_gate"]);
  assert.deepEqual(OUTCOME_STATUSES[OUTCOME.ABORTED], ["failed", "dismissed", "superseded", "cancelled"]);
  // The panel writes none of these words itself — it reads the shared module, which is the same one
  // routes/apply.js files rows with.
  assert.match(panel, /from "\.\.\/\.\.\/\.\.\/shared\/applyOutcomeGroups\.js"/);
  for (const status of Object.values(OUTCOME_STATUSES).flat()) {
    assert.ok(!new RegExp(`"${status}"`).test(panel.slice(0, at(panel, "return ("))),
      `the panel branches on the '${status}' status itself instead of asking the partition`);
  }
  // The dead-posting override is still applied AFTER the map, on the server, where the join is.
  assert.match(applyRoute, /const group = outcomeGroupFor\(\{ \.\.\.pub, postingGone: r\.title == null && r\.company == null \}\)/);
  // The labels the tabs render are the partition's own.
  assert.equal(OUTCOME_LABELS[OUTCOME.ABORTED].label, "Aborted");
});

// ── Requirement 8: the badge ─────────────────────────────────────────────────────────────────

test("AD1 requirement 8: the AUTO APPLY badge still counts what needs attention, with no preload", () => {
  // WHAT IT COUNTS, unchanged by AD1: applications waiting for approval, applications held for
  // review, and open questions. Summed in the context so the badge and the panel cannot disagree
  // about what "needs attention" means.
  assert.match(ctx, /needsAttentionCount: applyPending\.length \+ applyReviewJobs\.length \+ applyQuestions\.length/);
  // AND IT NEEDS NO PRELOAD OF THE LISTING. Its three terms come from the cross-run feeds the
  // provider already loads for the whole session — none of them is the dated endpoint, so the badge
  // is computable with `history === null`, which is its state on every first render.
  for (const term of ["applyPending", "applyReviewJobs", "applyQuestions"]) {
    const setter = `set${term[0].toUpperCase()}${term.slice(1)}`;
    assert.ok(ctx.includes(setter), `${term} has no setter — the badge term is not a real feed`);
  }
  assert.ok(!/needsAttentionCount:[^\n]*history/.test(ctx),
    "the badge now reads the dated history — it cannot be computed before a date is picked");
  // The effect that fills those three feeds is the mount effect, and it fetches none of the history.
  const mount = ctx.match(/useEffect\(\(\) => \{\s*\n\s*if \(user\) \{ loadApplyRuns\(\); loadApplyQuestions\(\); loadApplyPending\(\); \}/);
  assert.ok(mount, "the feeds behind the badge are no longer loaded on mount");
});

// ── The browser harness must actually exercise the new shape ─────────────────────────────────

test("AD1: the real-run harness drives the sub-tabs, not just the old sections", () => {
  // A source test cannot see a tab that never renders or a refetch that loads all three. These are
  // the hooks the browser check reads; asserting they exist here is what keeps a later refactor
  // from quietly making the harness pass over an empty page.
  assert.match(panel, /data-rm-count-scope=/);
  assert.match(controls, /data-rm-subtab=\{id\}/);
  assert.match(controls, /data-rm-subtab-count=\{id\}/);
  assert.match(controls, /data-rm-subtabs=\{layoutId\}/);
  assert.match(harness, /data-rm-subtab/);
  assert.match(harness, /AD1/);
});
