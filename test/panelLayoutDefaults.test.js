// Panel sizing and arrangement.
//
// This file used to pin getPanelDefaults' percentage table (jobs=100 alone, jobs=30 with one panel,
// jobs=6 with two or more, plus a +10 bonus for the resume column) and the triple-RAF effect that
// reapplied it on every open/close transition. All of that is gone, and not because it was wrong —
// because the thing it distributed no longer exists. The JD, PDF and ATS surfaces were
// react-resizable-panels COLUMNS competing with the board for horizontal space, which is why the
// board could be squeezed to 6% and why the PDF sandbox had to scale a page down to fit. They are
// popup panels now, laid out by one host inside one overlay dock, so the board keeps the full width.
//
// The INTENT of the old tests — panel geometry is deterministic and reapplied predictably, not left
// to chance — is preserved below against the mechanism that now provides it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const shell     = fs.readFileSync("client/src/components/PanelShell.jsx", "utf8");
const host      = fs.readFileSync("client/src/hooks/usePanelHost.js", "utf8");
const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
const geometry  = fs.readFileSync("client/src/lib/panelGeometry.js", "utf8");

test("the board is the only remaining resizable column", () => {
  // One Panel, no ResizeHandle between competing panels: nothing left to redistribute.
  assert.equal((jobsPanel.match(/<Panel\b/g) || []).length, 1,
    "a second column is back — the panels are supposed to overlay the board, not take space from it");
  assert.ok(!/<ResizeHandle/.test(jobsPanel),
    "the inter-column drag handle is back; panel width is now dragged on the panel itself");
  // And the machinery that redistributed percentages must stay gone.
  assert.ok(!/function getPanelDefaults\(/.test(jobsPanel), "getPanelDefaults is back");
  assert.ok(!/initialPanelDefaultsAppliedRef = useRef/.test(jobsPanel), "the rebalancing effect is back");
});

test("panel width is deterministic: a minimum, a default, and a persisted per-type override", async () => {
  const g = await import("../client/src/lib/panelGeometry.js");
  assert.equal(g.PANEL_MIN_WIDTH, 360);
  assert.equal(g.PANEL_DEFAULT_WIDTH, 560);   // the JD drawer's historical width
  assert.match(geometry, /const WIDTH_KEY = "rm_panel_widths_v1";/);
  // Persisted per TYPE, so "the PDF panel is wide, the ATS report is narrow" survives a reload.
  assert.match(geometry, /export function storedPanelWidth\(panelId, fallback = PANEL_DEFAULT_WIDTH\)/);
  assert.match(geometry, /Number\.isFinite\(w\) && w >= PANEL_MIN_WIDTH \? w : fallback/,
    "a stored width below the minimum must fall back, or one bad drag makes a panel unusable forever");
  // Written on release, not on every pointermove. The write moved to the HOST along with the widths
  // themselves — the shell reports a gesture, the host owns the numbers — so a panel can no longer
  // persist a width that disagrees with the one it was rendered at.
  assert.match(host, /const endResize = useCallback\(\(\) => \{[\s\S]*?writePanelWidth\(/);
  assert.ok(!/const \[width, setWidth\] = useState/.test(shell),
    "the shell owns a width again — two owners is how a panel and its neighbour come to disagree");
});

test("the budget is divided when the SET or the VIEWPORT changes, never mid-drag", async () => {
  // Callable, not string-matched: the arithmetic lives in a plain module precisely so a test can
  // run it rather than assert on its source text.
  const { fitPanelWidths, tileCapacity, dockBudget } = await import("../client/src/lib/panelGeometry.js");
  assert.equal(dockBudget(1280, 3), 1224);
  // Three 560px defaults do not fit a 1280px viewport, so every panel is scaled by ONE factor
  // rather than the last one being starved.
  const three = fitPanelWidths([560, 560, 560], 1224);
  assert.equal(three.reduce((a, b) => a + b, 0), 1224, "the fit must spend the budget exactly");
  assert.ok(three.every(w => w >= 360), "the minimum is a hard floor, not a target");
  assert.deepEqual(three, [408, 408, 408]);
  // Widths that already fit are left alone — a fit is not an excuse to redistribute.
  assert.deepEqual(fitPanelWidths([400, 500], 1224), [400, 500]);
  // Keyed on the SET, deliberately not on the focus order. Refitting when a peer is merely clicked
  // would make every focus change nudge all the widths; refitting on every drag frame is worse, and
  // is the bug this replaced — the fit scales EVERY panel by one factor, so a local trade between
  // two neighbours moved a third panel two slots away.
  assert.match(host, /const setKey = `\$\{\[\.\.\.bySlot\]\.sort\(\)\.join\("\|"\)\}:\$\{viewportWidth\}`/);
  assert.match(host, /if \(widthsRef\.current\.key !== setKey\)/);
  // Capacity is the same arithmetic asked in reverse, so the two cannot disagree.
  assert.equal(tileCapacity(1280), 3);
  assert.equal(tileCapacity(1000), 2);
  assert.equal(tileCapacity(820), 1);
});

test("the drag grows the panel in the direction the handle is on", () => {
  // The handle is on the LEFT edge of a right-anchored panel, so dragging left must GROW it.
  // `startX - clientX` is the sign that makes that true; the naive `clientX - startX` shrinks the
  // panel when the user drags it wider.
  assert.match(shell, /onResize\?\.\(d\.startX - e\.clientX\)/);
  // Pointer capture, or a fast drag detaches from the 8px handle and the panel sticks mid-resize.
  assert.match(shell, /setPointerCapture\?\.\(e\.pointerId\)/);
  // The gesture reports a CUMULATIVE delta and the host applies it to a snapshot taken at
  // pointerdown. Applying a cumulative delta to a moving base compounds, and the panel runs away
  // from the cursor.
  assert.match(shell, /dragRef\.current = \{ startX: e\.clientX \}/);
  assert.match(host, /dragBaseRef\.current = \{ \.\.\.widthsRef\.current\.map \}/);
});

test("a resize TRADES width with one neighbour, and the dock's outer bounds do not move", () => {
  // The property the previous arrangement could not have: three independently right-anchored panels
  // have no group bounds, so growing one pushed the next off the screen (measured: the PDF panel
  // went to x=-68). Only the two entries either side of the handle are written, and their sum is
  // preserved, so the dock cannot move.
  assert.match(host, /widthsRef\.current\.map\[id\] = base\[id\] \+ d;/);
  assert.match(host, /widthsRef\.current\.map\[left\.id\] = base\[left\.id\] - d;/);
  // Clamped so NEITHER side can cross the minimum — clamping only the dragged panel lets its
  // neighbour be crushed to nothing.
  assert.match(host, /PANEL_MIN_WIDTH - base\[id\][\s\S]*?base\[left\.id\] - PANEL_MIN_WIDTH/);
  // A handle exists only where there is something to resize AGAINST. The leftmost panel of two or
  // more has no left neighbour, and a handle there could only move the dock's outer bound.
  assert.match(host, /resizeMode: slot \+ 1 < n \? "neighbour" : \(n === 1 \? "dock" : "none"\)/);
  assert.match(shell, /resizeMode !== "none" && \(/);
});

test("side-by-side has a defined capacity and a defined overflow rule", () => {
  // THREE panels tile — all three peers on screen at once is the arrangement the set exists for.
  assert.match(geometry, /export const MAX_TILED = 3;/);
  // The decision, asserted so it cannot drift into "whatever the code happens to do": the panel
  // that does not fit evicts the LEAST RECENTLY FOCUSED one rather than being refused.
  assert.match(host, /const evictCount = order\.length - capacity;/);
  assert.match(host, /order\.slice\(0, evictCount\)/);
  assert.match(host, /descriptors\.find\(d => d\.id === id\)\?\.close\?\.\(\)/);
  // Eviction is by FOCUS order, not open order — otherwise the panel you are actively using is the
  // one that gets closed.
  assert.match(host, /focusOrderRef/);
});

test("panels tile inside the dock, not against the viewport", () => {
  // Slot 0 is the rightmost position — where the JD drawer has always appeared — so a newly opened
  // panel shows up where the user already expects one.
  assert.match(host, /const bySlot = \[\.\.\.order\]\.reverse\(\)\.slice\(0, capacity\)/);
  // Expressed as CSS `order`, not by reordering the JSX, so a panel keeps its DOM node — and
  // therefore its scroll position — when its slot changes.
  assert.match(shell, /order: -slot,/);
  // Each panel is a FLEX CHILD of the dock. This is the line that makes the tiling internal: a
  // panel has no relationship with the viewport, only with its siblings, so it cannot lay out
  // against the board or be shoved past the screen edge.
  assert.match(shell, /flex: fullScreen \? "1 1 auto" : `0 0 \$\{Math\.round\(width\)\}px`/);
  assert.ok(!/right: rightOffset/.test(shell),
    "a panel is anchoring itself to the viewport again instead of tiling inside the dock");
  // The dock's width is the sum of the set plus the gaps — a property of the group, not of a drag.
  assert.match(host, /const dockWidth = bySlot\.reduce\(\(a, id\) => a \+ widths\[id\], 0\) \+ PANEL_GAP \* \(n - 1\)/);
  // The dock must not eat clicks meant for the scrim in the gaps between panels.
  assert.match(shell, /pointerEvents: "none",/);
  assert.match(shell, /pointerEvents: "auto",/);
});

test("the narrow-viewport fallback is defined, not left to collapse arbitrarily", () => {
  assert.match(geometry, /export const SIDE_BY_SIDE_MIN_VIEWPORT = 900;/);
  assert.match(host, /const fullScreenMode = viewportWidth < SIDE_BY_SIDE_MIN_VIEWPORT;/);
  // Capacity between that floor and three-up is not a second breakpoint table that could disagree
  // with the first — it is how many PANEL_MIN_WIDTH panels actually fit.
  assert.match(host, /const capacity = tileCapacity\(viewportWidth\);/);
  // Full-screen, but still inset and rounded — the same object, not a different component below a
  // breakpoint. The inset moved to the DOCK, which is what the single panel now fills.
  assert.match(shell, /\{ left: 8, right: 8, top: 64, bottom: 8 \}/);
});
