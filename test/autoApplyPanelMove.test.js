// The auto-apply pipeline moved to its own tab. It is a MOVE — nothing was dropped.
//
// The risk in a move this size is that a piece is quietly left behind, so the surface is checked
// from both ends: absent from the board, present in the panel. The state is checked the same way.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8");
const board   = read("client/src/panels/JobsPanel.jsx");
const panel   = read("client/src/panels/AutoApplyPanel.jsx");
const ctx     = read("client/src/contexts/AutoApplyContext.jsx");
const app     = read("client/src/App.jsx");

test("the board no longer owns any of the pipeline except putting a job in the queue", () => {
  const code = board.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const gone of [
    "applyRuns", "applyPending", "applyQuestions", "applyGatePortals", "applyRunDetail",
    "applyReadiness", "startApplyRun", "decidePending", "artifactUrl", "loadApplyRuns",
    "submitApplyAnswers", "confirmApproveAll", "questionDrafts",
  ]) {
    // Word-boundary, not substring: `applyPending` is a prefix of `applyPendingFilters`, which is
    // the FILTER drawer's apply handler and has nothing to do with the pipeline.
    // The escape must be `\\b` — inside a template literal a lone `\b` is a BACKSPACE character,
    // which matches nothing here and would make this whole loop pass on any input.
    assert.ok(!new RegExp(`\\b${gone}\\b`).test(code),
      `${gone} is back on the board — the pipeline is leaking into it`);
  }
  // The one thing it keeps, and the wire it keeps it through.
  assert.match(board, /const \{ addToApplyQueue \} = useAutoApply\(\);/);
  assert.match(board, /onQueueApply: addToApplyQueue/);
});

test("every piece of the surface arrived in the panel — nothing dropped in the move", () => {
  // Run status, the review queue, the held-gate batches, the question queue, the pending-approval
  // queue and the per-run detail are each named in the requirement as things that must survive.
  for (const [what, needle] of [
    ["the run control",        /Autofill for Review/],
    ["run status badges",      /run\.submittedCount/],
    ["the review queue",       /need review/],
    ["held-gate batches",      /applyGatePortals\.map/],
    // Reads the scoped list since AB3 — the queue survives, its contents are now scoped to the card
    // the popup was opened from rather than being every question every time.
    ["the question queue",     /Answer \{scopedQuestions\.length\}/],
    // Copy changed with the obstacle restructure ("awaiting" -> "waiting for"), so this matches the
    // COUNT-plus-noun shape rather than one adjective. The capability is stronger than it was: the
    // pending queue now has its own obstacle card with its own action, not a CTA among others.
    ["pending approvals",      /application\$\{applyPending\.length === 1 \? "" : "s"\} waiting for your approval/],
    // AC4 replaced the run-history chip list with a dated view. Per-run detail is reached from every
    // application row instead of from a chip, and the run's status and counts moved into the detail
    // modal's own header — so what is asserted is the capability, not the call site that carried it.
    ["per-run detail",         /onOpenRun=\{loadApplyRunDetail\}/],
    ["the queue's tier notice",/automationTier === "account"/],
    ["the readiness gate",     /applyReadiness && !applyReadiness\.available/],
  ]) {
    assert.match(panel, needle, `${what} did not make it into AutoApplyPanel`);
  }
});

test("no apply behaviour changed — the requests and their guards moved verbatim", () => {
  // Placement only. Same endpoints, same methods, same bodies.
  for (const call of [
    '"/api/apply/runs"', '"/api/apply/gate-packets"', '"/api/apply/questions"',
    '"/api/apply/answers"', '"/api/apply/pending"', '"/api/apply/readiness"',
    "`/api/apply/runs/${runId}`", "`/api/apply/run-jobs/${runJobId}/review`",
  ]) {
    assert.ok(ctx.includes(call), `${call} did not move with the pipeline`);
  }
  // The one behavioural invariant this pipeline is built on: nothing is submitted without approval.
  // startApplyRun posts mode "auto" and NEVER approvalMode, which the server reads as
  // approval-required. A full-auto run must not become reachable by accident in a move.
  assert.match(ctx, /const mode = intent === "review" \? "auto" : intent;/);
  // Comments stripped: the note above startApplyRun explains that approvalMode is deliberately NOT
  // sent, and a bare search would read that explanation as the thing it warns against.
  const ctxCode = ctx.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*(?:\/\/|\*).*$/gm, "");
  assert.ok(!/approvalMode/.test(ctxCode),
    "the move introduced an approvalMode — full-auto must stay unreachable from this UI");
  // The in-flight poll, and its stop condition, moved intact: an idle board must cost no requests.
  assert.match(ctx, /const runInFlight = applyRuns\.some\(r => r\.status === "queued" \|\| r\.status === "running"\)/);
  assert.match(ctx, /if \(!user \|\| !runInFlight\) return;/);
});

test("the pipeline's state sits above the tab switch, so a run keeps reporting while you navigate", () => {
  // If the provider were inside the Jobs panel, leaving the board would unmount the poll — and the
  // place you would go to watch a run is the very tab that would have stopped it.
  const dash = app.slice(app.indexOf("<JobBoardProvider>"));
  const providerAt = dash.indexOf("<AutoApplyProvider");
  const panelAt = dash.indexOf("<AutoApplyPanel/>");
  assert.ok(providerAt !== -1 && panelAt !== -1 && providerAt < panelAt,
    "AutoApplyProvider must wrap the panel, above the tab switch");
  assert.match(app, /activeTab === "auto-apply"\s*&& <AutoApplyPanel\/>/);
});

test("the tab exists, routes, and is not bounced back to the board", () => {
  assert.match(app, /\{ id: "auto-apply",\s*label: "Auto Apply" \}/);
  // BOTH directions. There were two hardcoded copies of the tab list — one in handlePanelChange and
  // one in the redirect guard — and adding a tab to appTabs satisfied neither: the tab rendered and
  // navigated nowhere, and typing the URL bounced straight back to the board. Both now derive from
  // the tab row, so a tab added tomorrow routes without anyone remembering either line.
  assert.match(app, /const NAVIGABLE_TABS = useMemo\(/);
  assert.match(app, /if \(NAVIGABLE_TABS\.has\(tab\)\) \{/);
  assert.match(app, /if \(routeKey !== CONSOLE_ROUTE && !NAVIGABLE_TABS\.has\(routeKey\)\) \{/);
  assert.ok(!/\["database","plans","profile","job-profiles","integrations","recruiter"\]/.test(app),
    "a hardcoded tab list is back — it is silent when wrong in both directions");
});

test("the board keeps a count badge, and only when something needs a human", () => {
  // A count on the tab, not a strip. "3 need review" has to stay discoverable from the board — a
  // review queue nobody sees is worse than a cluttered board — but an idle pipeline must show
  // nothing at all.
  assert.match(ctx, /needsAttentionCount: applyPending\.length \+ applyReviewJobs\.length \+ applyQuestions\.length/);
  assert.match(app, /needsAttentionCount > 0/);
  assert.match(app, /needs\$\{needsAttentionCount === 1 \? "s" : ""\} your attention|need\$\{needsAttentionCount === 1 \? "s" : ""\} your attention/);
  // The queue itself is deliberately NOT counted: queueing a job is not something waiting on you.
  assert.ok(!/needsAttentionCount[^;]*applyQueue/.test(ctx),
    "the queue is counted as needing attention — queueing a job is not a thing waiting on a human");
});

test("the tool constants have exactly one home", () => {
  // AutoApplyContext builds the same apply-run request startApplyRun always built. A second copy of
  // a pair of wire values is how a client and a server drift apart.
  assert.match(ctx, /import \{ A_PLUS_TOOL, GENERATE_TOOL \} from "\.\.\/lib\/applyTools\.js"/);
  assert.match(board, /import \{ GENERATE_TOOL, A_PLUS_TOOL, TOOL_LABELS, normalizeTool \} from "\.\.\/lib\/applyTools\.js"/);
  const code = board.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/^const (GENERATE_TOOL|A_PLUS_TOOL) =/m.test(code), "the board redeclared a tool constant");
});
