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
  // The INSET is the dock's — it is the overlay surface now, and the panels tile inside it. That is
  // the fix: three independently viewport-anchored panels were not a group, so one could be pushed
  // off the screen by its neighbour growing.
  assert.match(shell, /position: "fixed"/);
  assert.match(shell, /\{ right: EDGE_GAP, top: 80, bottom: 16, width:/);   // inset on all four sides
  assert.match(shell, /borderRadius: 16,/);
  // Not full-height, not flush, and not in the layout flow: the dock is portalled to body.
  assert.match(shell, /document\.body\s*\)/);
  assert.equal((shell.match(/createPortal\(/g) || []).length, 2,
    "expected exactly two portals — the scrim and the dock. A panel portalling itself is how they " +
    "stopped being a group in the first place");
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
  // Declared once, on the dock, for the whole group. Ordering BETWEEN peers is then local to the
  // dock's stacking context rather than a second scale value competing with the app's.
  assert.match(shell, /zIndex: Z\.MODAL,/);
  assert.match(shell, /zIndex: focused \? 1 : 0,/);
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

test("the PDF view that leads is the one that is legible at the panel's width", () => {
  // Page view scales A4 (794px) to whatever the panel has, so its legibility is a pure function of
  // width: at the 360px minimum the scale is 0.45 and body text lands under 6px. Below the
  // threshold the panel therefore opens REFLOWED, re-rendered at its measured width rather than
  // scaled down to it. At or above it, Page leads, because it is the only view whose page breaks
  // match the exported PDF.
  assert.match(sandbox, /const PAGE_VIEW_MIN_WIDTH = 700;/);
  assert.match(sandbox, /const \[viewChoice, setViewChoice\] = useState\(null\);/);
  assert.match(sandbox, /\(\(width \?\? PAGE_VIEW_MIN_WIDTH\) >= PAGE_VIEW_MIN_WIDTH \? "page" : "reading"\)/);
  // An explicit choice wins at every width thereafter — the width decides the DEFAULT, it does not
  // override the person.
  assert.match(sandbox, /const viewMode = viewChoice/);
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
  assert.match(shell, /if \(!focused\) return undefined;[\s\S]*?e\.key === "Escape"/);
});

// ── The board behind the scrim ────────────────────────────────────────────────────────────────

test("the board is inert and frozen while any panel is open", () => {
  const lock = read("client/src/hooks/useBoardLock.js");
  assert.match(jobs, /useBoardLock\(openPanelCount > 0\)/);

  // FOCUS. `pointer-events: none` stops the mouse and nothing else — Tab walked into the board's
  // controls behind the scrim and put the focus ring on an element the user could not see. `inert`
  // is the only thing that removes a subtree from the tab order, the a11y tree and hit-testing at
  // once.
  assert.match(lock, /child\.setAttribute\("inert", ""\)/);
  assert.match(lock, /for \(const el of inerted\) el\.removeAttribute\("inert"\)/);
  // What stays alive is read from the z-scale, not from a list of component names: anything
  // painting at or above NAV is above the scrim, therefore undimmed and visibly clickable, and a
  // control that looks live but is inert is worse than one that works.
  assert.match(lock, /if \(Number\.isFinite\(z\) && z >= Z\.NAV\) continue;/);
  assert.match(app, /data-app-shell/);

  // SCROLL, and the scroll POSITION. `overflow: hidden` on body is the lock that loses it — the
  // document stops being scrollable, the browser clamps scrollTop, and closing the panel drops the
  // user at the top of a board they had scrolled halfway down.
  assert.match(lock, /const scrollY = window\.scrollY/);
  assert.match(lock, /body\.style\.position = "fixed";/);
  assert.match(lock, /body\.style\.top = `-\$\{scrollY\}px`;/);
  assert.match(lock, /window\.scrollTo\(0, scrollY\)/);
  assert.ok(!/body\.style\.overflow = "hidden"/.test(lock),
    "the lock that discards the scroll position is back");

  // And the gutter it opens up, measured BEFORE locking — after it there is no scrollbar left to
  // measure and the compensation would always be zero.
  assert.match(lock, /const gutter = Math\.max\(0, window\.innerWidth - document\.documentElement\.clientWidth\);/);
  assert.match(lock, /body\.style\.paddingRight = `\$\{priorPad \+ gutter\}px`;/);
});

test("keyboard scrolling targets the focused panel, not the page", () => {
  // The browser already does this for free when the focused element is inside the scroll container,
  // so the fix is to put focus there rather than to re-derive the browser's scrolling rules in a
  // key handler. tabIndex -1 keeps it programmatically focusable without joining the tab order, so
  // Tab still reaches the close button and the action bar in their natural positions.
  assert.match(shell, /scrollRef\.current\?\.focus\?\.\(\{ preventScroll: true \}\)/);
  assert.match(shell, /tabIndex=\{-1\} data-panel-body=""/);
});
