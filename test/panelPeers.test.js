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
import { Z as Z_SCALE } from "../client/src/styles/zLayers.js";

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
  // The insets are named constants now, not literals, and the top one tracks the measured chrome
  // height (Y4) so the dock cannot stop clearing a bar whose size changed. 46 + 34 is the 80 it was.
  assert.match(shell, /\{ right: EDGE_GAP, top: PANEL_TOP_INSET, bottom: PANEL_BOTTOM_INSET,/);
  assert.match(shell, /export const PANEL_TOP_INSET = "calc\(var\(--app-chrome-height, 46px\) \+ 34px\)";/);
  assert.match(shell, /export const PANEL_BOTTOM_INSET = 16;/);
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
  // What stays alive is read from the z-scale, not from a list of component names: anything the
  // scrim does not cover stays live, and anything it covers goes inert, so nothing ever looks live
  // while being inert.
  //
  // THE THRESHOLD IS THE SCRIM, NOT THE NAV. It used to read `z >= Z.NAV`, which was the same line
  // only because NAV was 1500 and the scrim 800. Y2 lowered NAV to 250 so the top bar can never
  // occlude an overlay; left as `>= Z.NAV`, this loop would then have spared every child at 250 or
  // more — INCLUDING the search surface at Z.SEARCH (400), which is exactly the defect the test
  // below this one was written for: a live, tab-reachable search surface underneath an open modal.
  assert.match(lock, /if \(Number\.isFinite\(z\) && z >= Z\.MODAL_SCRIM\) continue;/);
  // Stripped source for the negative: the hook's own note explains the old threshold by quoting it,
  // and matching a comment is how a source-string test passes while the code says something else.
  const lockCode = lock.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/z >= Z\.NAV/.test(lockCode),
    "the lock spares everything above the top bar again, which now includes the search surface");
  assert.match(app, /data-app-shell/);

  // Proven against the real scale rather than by reading the source: every tier at or above the
  // scrim must be spared, and every tier below it must be inerted. The top bar is BELOW now, and
  // that is the intended consequence — dimmed and inert together.
  const spared = (z) => z >= Z_SCALE.MODAL_SCRIM;
  for (const t of ["MODAL_SCRIM", "MODAL", "POPOVER"]) {
    assert.ok(spared(Z_SCALE[t]), `${t} must stay live — the scrim does not cover it`);
  }
  for (const t of ["CONTENT", "NAV", "PANEL_POPOVER", "SEARCH", "SEARCH_DROPDOWN", "DRAWER"]) {
    assert.ok(!spared(Z_SCALE[t]), `${t} is under the scrim and must be inerted`);
  }

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

// ── The corrective pass: two things the panels' CONTAINER was right about and the app was not ──

test("there is ONE search surface, so it cannot be in two tiers", () => {
  // THE DEFECT THIS GUARDED, AND WHY THE GUARD CHANGED SHAPE. "The search bar renders above the
  // panel bodies" had one cause: the search surface had TWO renderings — UnifiedSearchBar (expanded)
  // and TopBar's collapsed filter pill — and the pill carried Z.NAV while the bar carried Z.SEARCH.
  // One surface in two tiers, chosen by nothing but the scroll offset, landing on opposite sides of
  // MODAL_SCRIM.
  //
  // Measured at 1280x800 with the page scrolled 500 and the PDF + ATS tiles open: the pill painted
  // at z 1500 over a scrim at 800 and tiles at 850, overlapping BOTH tiles' headers by 10px, at full
  // brightness while the board beneath it was dimmed — and still clickable and tab-reachable through
  // the modal, because useBoardLock spared everything at or above Z.NAV. That is also why the
  // unscrolled state looked right and the scrolled state looked wrong.
  //
  // The fix at the time was to put the pill in the SEARCH tier so both renderings agreed. Y4 removes
  // the second rendering instead, which is the stronger form of the same fix: two tiers for one
  // surface is unreachable when there is one surface. So this no longer asserts the pill's tier — it
  // asserts that there is nothing to give a tier to.
  const topbar = read("client/src/components/TopBar.jsx");
  const barCode = topbar
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*(?:\/\/|\*).*$/gm, "");
  assert.ok(!/pillIsTheSearchSurface/.test(barCode),
    "the collapsed search surface is back — one surface in two tiers is reachable again");
  assert.ok(!/zIndex: Z\.SEARCH/.test(barCode),
    "the top bar renders something in the SEARCH tier again; the search surface is not its to own");
  // The bar itself is the only thing left here, and it is NAV. Y2 lowered that tier so it can no
  // longer occlude an overlay, which is asserted in searchSurfaceLayering.
  assert.equal((barCode.match(/zIndex: Z\.NAV,/g) || []).length, 1,
    "the top bar should declare exactly one z tier, its own");

  // And the CSS half declares the tier once, on the base rule, so the layouts cannot disagree:
  // .usb--dock was inheriting a bare 200, i.e. below PANEL_POPOVER.
  const usbCss = read("client/src/components/UnifiedSearchBar.css");
  assert.ok(!/z-index: 200;/.test(usbCss), "the search surface is back below panel popovers");
  assert.equal((usbCss.match(/z-index:/g) || []).length, 1,
    "one tier, declared once — two copies is how the dock layout drifted from the hero layout");
});

test("the panel openers do not switch to mobile panes that no longer exist", () => {
  // openSandbox / closeSandbox / openAtsPanel used to set mobilePane to "editor" / "ats". Those
  // panes rendered the sandbox and the report INLINE and were deleted when both became popup
  // panels — the mobile branch renders the board and nothing else. So the switch emptied the board
  // behind the overlay, and closeAtsPanel never reset it, so closing the panels left it empty.
  // Measured at 880x700 and 600x900: zero job cards behind an open panel, and zero after closing.
  // Stripped source: this test's own notes name the mechanism being asserted absent, and a comment
  // describing a removed switch reads as the switch still being there.
  const jobsCode = jobs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/setMobilePane/.test(jobsCode),
    "the pane switch is back, pointing at a pane that renders nothing");
  assert.ok(!/mobilePane/.test(jobsCode),
    "the board is gated on a pane value again; nothing can set it, so it can only hide the board");
  // The bottom-nav Resume / ATS items reach the PANELS that own those surfaces now, rather than a
  // pane — the tab still shows the resume and still shows the report.
  assert.match(jobs, /onPress: \(\) => openSandbox\(sandbox\)/);
  assert.match(jobs, /onPress: \(\) => openAtsPanel\(null\)/);
  assert.match(jobs, /enabled: !!sandbox,/);
  assert.match(jobs, /enabled: !!activeAts,/);
});
