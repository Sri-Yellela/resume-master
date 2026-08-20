// U3: the PDF and ATS surfaces are PEERS of the JD drawer, through one extracted primitive.
//
// Before: JobDetailPanel was a portal drawer that hand-rolled its own scrim, animation, sticky
// header, action bar and z-index, while the PDF sandbox and the ATS report were
// react-resizable-panels COLUMNS wedged into the region below the search bar. That is why they were
// cramped (the board could squeeze them, and getPanelDefaults could squeeze the board to 6%) and why
// they sat BEHIND the JD drawer rather than beside it — a column cannot overlay a portal.
//
// The reference panel's seven properties are asserted against PanelShell, once, because there is now
// exactly one implementation of them and all three panel types render through it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8");
const shell   = read("client/src/components/PanelShell.jsx");
const host    = read("client/src/hooks/usePanelHost.js");
const jd      = read("client/src/components/JobDetailPanel.jsx");
const sandbox = read("client/src/panels/SandboxPanel.jsx");
const ats     = read("client/src/panels/AtsReportPanel.jsx");
const atsBody = read("client/src/panels/ATSPanel.jsx");
const jobs    = read("client/src/panels/JobsPanel.jsx");
const app     = read("client/src/App.jsx");

// ── The seven properties of the reference panel ───────────────────────────────────────────────

test("1. right-anchored overlay, inset from the viewport edges, with rounded corners", () => {
  assert.match(shell, /position: "fixed"/);
  assert.match(shell, /\{ right: rightOffset, top: 80, bottom: 16,/);   // inset on all four sides
  assert.match(shell, /borderRadius: 16,/);
  // Not full-height, not flush, and not in the layout flow: it is portalled to body.
  assert.match(shell, /document\.body\s*\)/);
});

test("2. the scrim dims but does not hide, and there is exactly one for the group", () => {
  assert.match(shell, /background: "rgba\(0,0,0,0\.45\)"/);
  assert.match(shell, /backdropFilter: "blur\(4px\)"/);
  // One scrim, rendered by the host — two stacked 45% scrims compound to ~70% and the board stops
  // being visible behind them, which would break this property exactly when a second panel opens.
  assert.match(shell, /export function PanelScrim/);
  assert.equal((jobs.match(/<PanelScrim\b/g) || []).length, 1);
});

test("3. backdrop blur on the panel surface itself (dark glass), not a flat fill", () => {
  assert.match(shell, /className="liquid-panel"/);
  const css = read("client/src/index.css");
  assert.match(css, /\.liquid-panel \{[\s\S]*?backdrop-filter: blur\(14px\)/);
  assert.match(css, /\.liquid-panel \{[\s\S]*?background: rgba\(255, 255, 255, 0\.03\)/);
});

test("4. TWO sticky regions — identity header AND action bar — and only the body scrolls", () => {
  // Both are flexShrink:0 children of a fixed-height flex column, which pins them harder than
  // position:sticky: they cannot move at all rather than sticking once scrolled to.
  assert.equal((shell.match(/flexShrink: 0, background: "var\(--color-surface\)"/g) || []).length, 2,
    "expected exactly two pinned regions (header + action bar)");
  assert.match(shell, /header=\{header\}|\{header\}/);
  assert.match(shell, /\{actions\}/);
  // All three panel types supply both slots.
  for (const [name, src] of [["JD", jd], ["PDF", sandbox], ["ATS", ats]]) {
    assert.match(src, /header=\{/, `${name} must fill the identity header slot`);
    assert.match(src, /actions=\{/, `${name} must fill the action bar slot`);
  }
});

test("5. the body is its own scroll container and does not chain to the page", () => {
  assert.match(shell, /flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden",/);
  assert.match(shell, /overscrollBehavior: "contain"/);
  // No panel may nest a second scroller inside that body.
  assert.ok(!/overflowY: "auto"/.test(sandbox), "the PDF panel is scrolling itself again");
  assert.ok(!/overflowY:"auto"/.test(atsBody),  "the ATS report is scrolling itself again");
  assert.ok(!/overflowY:"auto"/.test(jd),       "the JD body is scrolling itself again");
});

test("6. one close affordance, top-right of the header, owned by the primitive", () => {
  assert.match(shell, /aria-label="Close panel"/);
  // Each panel type must NOT ship its own — that is how two divergent drawers started.
  assert.ok(!/aria-label="Close detail"/.test(jd), "JD has its own close button again");
  assert.equal((shell.match(/aria-label="Close panel"/g) || []).length, 1);
});

test("7. modal tier: above the board, the Applications table AND the search overlay", async () => {
  const { Z } = await import("../client/src/styles/zLayers.js");
  assert.ok(Z.MODAL > Z.SEARCH);
  assert.ok(Z.MODAL > Z.PANEL_POPOVER);
  assert.ok(Z.MODAL_SCRIM > Z.SEARCH);
  assert.match(shell, /zIndex: Z\.MODAL \+ \(focused \? 1 : 0\)/);
});

// ── Peers, not lookalikes ─────────────────────────────────────────────────────────────────────

test("all three panels render through the one primitive", () => {
  for (const [name, src] of [["JD", jd], ["PDF", sandbox], ["ATS", ats]]) {
    assert.match(src, /<PanelShell/, `${name} must render through PanelShell`);
    assert.match(src, /panelId="(jd|pdf|ats)"/, `${name} must declare a panel type id`);
  }
  // And none of them may reimplement the chrome the primitive provides.
  assert.ok(!/createPortal/.test(jd), "JD is portalling itself again instead of via PanelShell");
  assert.ok(!/AnimatePresence/.test(jd), "JD is animating itself again");
});

test("the PDF and ATS surfaces are no longer inline columns", () => {
  // The two <Panel> columns and their handles are gone; only the board's column remains.
  assert.equal((jobs.match(/<Panel\b/g) || []).length, 1);
  assert.ok(!/<SandboxPanel entry=\{sandbox\} onClose=\{closeSandbox\}\s*\n\s*onSave/.test(
    jobs.slice(0, jobs.indexOf("The popup panel group"))),
    "an inline copy of the sandbox survives above the popup group");
  // Exactly one mount of each panel type.
  assert.equal((jobs.match(/<SandboxPanel\b/g) || []).length, 1);
  assert.equal((jobs.match(/<AtsReportPanel\b/g) || []).length, 1);
  assert.equal((jobs.match(/<JobDetailPanel\b/g) || []).length, 1);
});

test("one host owns the ordered set, and JD moved under it", () => {
  assert.match(jobs, /usePanelHost\(panelDescriptors, vpWidth\)/);
  assert.match(jobs, /\{ id: "jd",\s+open: !!selectedJob/);
  assert.match(jobs, /\{ id: "pdf", open: sandboxOpen/);
  assert.match(jobs, /\{ id: "ats", open: rightPanelOpen/);
  // Three peers cannot tile from two different parents, so App no longer mounts JD itself.
  assert.ok(!/<JobDetailPanel/.test(app), "App is mounting the JD drawer outside the host again");
});

// ── The PDF's two render paths ────────────────────────────────────────────────────────────────

test("the PDF defaults to the faithful A4 view, with reflow as an opt-in", () => {
  assert.match(sandbox, /const \[viewMode, setViewMode\] = useState\("page"\);/,
    "Page view must be the default — it is the only view that matches the exported PDF");
  assert.match(sandbox, /viewMode === "reading" \? \(/);
  // Reading view reflows by rendering at the panel's measured width — no transform, no A4 width.
  assert.match(sandbox, /width: "100%",/);
  assert.match(sandbox, /new ResizeObserver/);
  assert.match(sandbox, /setReadingWidth/);
  // Page view keeps the scale-to-fit A4 stack, because pageCount and the page boundaries are
  // computed at RESUME_PAGE_WIDTH and reflowing would move them.
  assert.match(sandbox, /transform:       `scale\(\$\{scaleRef\.current\}\)`/);
});

test("Reading view states that it does not show pagination", () => {
  // Reflowed text does not break where A4 breaks. A preview that implied otherwise would be worse
  // than one that scaled down, so the limitation is on screen rather than in a comment.
  assert.match(sandbox, /Reading view reflows to the panel width — page breaks are not shown\./);
  assert.match(sandbox, /does not show real pagination/);
});

// ── Contracts that must survive the refactor ──────────────────────────────────────────────────

test("the failsafe review strip still renders nothing when kbFindings is empty", () => {
  // Its contract: empty findings must mean ZERO visual change. The strip is still gated on a
  // non-empty array, and it is still inside the panel body rather than the sticky chrome.
  assert.match(sandbox, /activeEntry\?\.kbFindings\?\.length > 0 && \(/);
  assert.ok(!/kbFindings\?\.length >= 0/.test(sandbox));
  assert.ok(!/kbFindings \|\| \[\]/.test(sandbox.slice(0, sandbox.indexOf("kbFindings?.length > 0"))));
});

test("the generate -> sandbox flow is untouched", () => {
  // openSandbox is still what the generate path calls, and it still sets the same state; the host
  // observes that state rather than replacing it, which is why none of these call sites changed.
  assert.match(jobs, /const openSandbox = useCallback\(\(entry\) => \{/);
  assert.match(jobs, /setSandboxOpen\(true\)/);
  assert.match(jobs, /entry=\{sandbox\} onClose=\{closeSandbox\}/);
  assert.match(jobs, /onSave=\{saveSandboxHtml\} onExport=\{exportAndTrack\}/);
});

test("Escape closes only the focused panel", () => {
  // One keypress closing every open panel is never what "go back" means.
  assert.match(shell, /if \(!focused\) return;[\s\S]*?e\.key === "Escape"/);
});
