// Panel sizing and arrangement.
//
// This file used to pin getPanelDefaults' percentage table (jobs=100 alone, jobs=30 with one panel,
// jobs=6 with two or more, plus a +10 bonus for the resume column) and the triple-RAF effect that
// reapplied it on every open/close transition. All of that is gone, and not because it was wrong —
// because the thing it distributed no longer exists. The JD, PDF and ATS surfaces were
// react-resizable-panels COLUMNS competing with the board for horizontal space, which is why the
// board could be squeezed to 6% and why the PDF sandbox had to scale a page down to fit. They are
// popup panels now, rendered through one PanelShell primitive and laid out by one host, so the board
// keeps the full width and each panel owns its own width.
//
// The INTENT of the old tests — panel geometry is deterministic and reapplied predictably, not
// left to chance — is preserved below against the mechanism that now provides it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const shell     = fs.readFileSync("client/src/components/PanelShell.jsx", "utf8");
const host      = fs.readFileSync("client/src/hooks/usePanelHost.js", "utf8");
const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

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

test("panel width is deterministic: a minimum, a default, and a persisted per-type override", () => {
  assert.match(shell, /const MIN_WIDTH = 360;/);
  assert.match(shell, /const DEFAULT_WIDTH = 560;/);   // the JD drawer's historical width
  assert.match(shell, /const WIDTH_KEY = "rm_panel_widths_v1";/);
  // Persisted per TYPE, so "the PDF panel is wide, the ATS report is narrow" survives a reload.
  assert.match(shell, /export function storedPanelWidth\(panelId, fallback = DEFAULT_WIDTH\)/);
  assert.match(shell, /Number\.isFinite\(w\) && w >= MIN_WIDTH \? w : fallback/,
    "a stored width below the minimum must fall back, or one bad drag makes a panel unusable forever");
  // Written on release, not on every pointermove.
  assert.match(shell, /const endDrag = useCallback\(\(\) => \{[\s\S]*?writeWidth\(panelId, width\)/);
});

test("the drag grows the panel in the direction the handle is on", () => {
  // The handle is on the LEFT edge of a right-anchored panel, so dragging left must GROW it.
  // `startW + (startX - clientX)` is the sign that makes that true; the naive
  // `startW + (clientX - startX)` shrinks the panel when the user drags it wider.
  assert.match(shell, /d\.startW \+ \(d\.startX - e\.clientX\)/);
  assert.match(shell, /Math\.max\(MIN_WIDTH, Math\.min\(window\.innerWidth - 32,/);
  // Pointer capture, or a fast drag detaches from the 8px handle and the panel sticks mid-resize.
  assert.match(shell, /setPointerCapture\?\.\(e\.pointerId\)/);
});

test("side-by-side has a defined capacity and a defined third-panel rule", () => {
  assert.match(host, /const MAX_SIDE_BY_SIDE = 2;/);
  // The decision, asserted so it cannot drift into "whatever the code happens to do": a third panel
  // evicts the LEAST RECENTLY FOCUSED one rather than being refused.
  assert.match(host, /const evictCount = order\.length - capacity;/);
  assert.match(host, /order\.slice\(0, evictCount\)/);
  assert.match(host, /descriptors\.find\(d => d\.id === id\)\?\.close\?\.\(\)/);
  // Eviction is by FOCUS order, not open order — otherwise the panel you are actively using is the
  // one that gets closed.
  assert.match(host, /focusOrderRef/);
});

test("panels tile without overlapping, from live widths", () => {
  // Slot 0 is the rightmost position — where the JD drawer has always appeared — so a newly opened
  // panel shows up where the user already expects one.
  assert.match(host, /const bySlot = \[\.\.\.order\]\.reverse\(\)\.slice\(0, capacity\)/);
  assert.match(host, /offset \+= Math\.max\(PANEL_MIN_WIDTH, w\) \+ PANEL_GAP;/);
  // Live width, falling back to the persisted one, so the first paint is already tiled correctly
  // instead of snapping a frame later.
  assert.match(host, /widthsRef\.current\[id\] \?\? storedPanelWidth\(id\)/);
});

test("the narrow-viewport fallback is defined, not left to collapse arbitrarily", () => {
  assert.match(host, /const SIDE_BY_SIDE_MIN_VIEWPORT = 900;/);
  assert.match(host, /const fullScreenMode = viewportWidth < SIDE_BY_SIDE_MIN_VIEWPORT;/);
  assert.match(host, /const capacity = fullScreenMode \? 1 : MAX_SIDE_BY_SIDE;/);
  // Full-screen, but still inset and rounded — the same object, not a different component below a
  // breakpoint.
  assert.match(shell, /\{ left: 8, right: 8, top: 64, bottom: 8, width: "auto" \}/);
});
