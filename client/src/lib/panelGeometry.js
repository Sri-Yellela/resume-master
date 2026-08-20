// ── Panel geometry — the numbers and the arithmetic, with no component attached ────────────────
//
// PanelShell needs these to draw, usePanelHost needs them to divide, and a test needs to be able to
// CALL them rather than match them as strings in a .jsx file Node cannot import. Two copies of a
// layout constant is how a dock ends up disagreeing with the panels inside it, so there is one.

export const PANEL_MIN_WIDTH = 360;      // below this a resume page is not legible even reflowed
export const PANEL_DEFAULT_WIDTH = 560;  // the JD drawer's historical width — unchanged for it
export const PANEL_EDGE_GAP = 16;        // dock inset from the viewport's right edge
export const PANEL_GAP = 12;             // between two tiled panels

// Up to THREE panels tile — all three peers on screen at once is the arrangement the set exists
// for. When a FOURTH would open, the LEAST RECENTLY FOCUSED is closed to make room; see
// usePanelHost for why eviction rather than refusal.
export const MAX_TILED = 3;

// Below this viewport width even TWO panels cannot both clear PANEL_MIN_WIDTH, so tiling is not
// viable at all and the fallback is a single FULL-SCREEN panel: the focused one. Chosen over a
// stacked/accordion arrangement because a resume page and an ATS report are both tall, dense
// documents — halving the height of each would make both unreadable, whereas one at a time stays
// fully usable.
export const SIDE_BY_SIDE_MIN_VIEWPORT = 900;

const WIDTH_KEY = "rm_panel_widths_v1";

// Widths persist PER PANEL TYPE, not per instance: "the PDF panel is wide, the ATS report is
// narrow" is a durable preference about the kind of content, and it should survive a reload.
function readWidths() {
  try { return JSON.parse(localStorage.getItem(WIDTH_KEY) || "{}") || {}; }
  catch { return {}; }
}

export function writePanelWidth(panelId, width) {
  try {
    const all = readWidths();
    all[panelId] = Math.round(width);
    localStorage.setItem(WIDTH_KEY, JSON.stringify(all));
  } catch { /* private mode / quota — the session still works, it just will not remember */ }
}

export function storedPanelWidth(panelId, fallback = PANEL_DEFAULT_WIDTH) {
  const w = readWidths()[panelId];
  // A stored width below the minimum must fall back, or one bad drag makes a panel unusable forever.
  return Number.isFinite(w) && w >= PANEL_MIN_WIDTH ? w : fallback;
}

// How many panels of at least PANEL_MIN_WIDTH actually fit, rather than a second breakpoint table
// that could disagree with the first. This is the same arithmetic the dock does, asked in reverse.
export function tileCapacity(viewportWidth) {
  if (!Number.isFinite(viewportWidth) || viewportWidth < SIDE_BY_SIDE_MIN_VIEWPORT) return 1;
  const available = viewportWidth - PANEL_EDGE_GAP * 2;
  const fit = Math.floor((available + PANEL_GAP) / (PANEL_MIN_WIDTH + PANEL_GAP));
  return Math.max(1, Math.min(MAX_TILED, fit));
}

// Distribute the dock's budget across the open panels.
//
// Preferred widths are what the user last dragged each TYPE to. When they do not all fit — three
// panels at the 560px default want 1704px and a 1280px viewport has 1224px to give — every panel is
// scaled by the same factor rather than the last one being starved, with PANEL_MIN_WIDTH as a hard
// floor. Capacity guarantees the floor is always payable, so this cannot return a panel narrower
// than the minimum.
export function fitPanelWidths(preferred, available) {
  const n = preferred.length;
  if (n === 0) return [];
  if (available <= n * PANEL_MIN_WIDTH) return preferred.map(() => PANEL_MIN_WIDTH);

  const sum = preferred.reduce((a, b) => a + b, 0);
  if (sum <= available) return preferred.map(w => Math.round(w));

  const scaled = preferred.map(w => Math.max(PANEL_MIN_WIDTH, Math.round(w * available / sum)));
  // Rounding and the minimum floor both leave drift. Settle it on the widest panel, which is the
  // one that can absorb a few pixels without approaching its own minimum.
  let drift = available - scaled.reduce((a, b) => a + b, 0);
  while (drift !== 0) {
    const widest = scaled.indexOf(Math.max(...scaled));
    const step = drift > 0 ? 1 : -1;
    if (step < 0 && scaled[widest] <= PANEL_MIN_WIDTH) break;   // nothing left to give back
    scaled[widest] += step;
    drift -= step;
  }
  return scaled;
}

// The px budget the dock has to divide between `n` panels at this viewport width.
export function dockBudget(viewportWidth, n) {
  return Math.max(
    n * PANEL_MIN_WIDTH,
    viewportWidth - PANEL_EDGE_GAP * 2 - PANEL_GAP * (n - 1),
  );
}
