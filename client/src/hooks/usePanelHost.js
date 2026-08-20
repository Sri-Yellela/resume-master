import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PANEL_MIN_WIDTH, PANEL_EDGE_GAP, PANEL_GAP, MAX_TILED, SIDE_BY_SIDE_MIN_VIEWPORT,
  dockBudget, fitPanelWidths, storedPanelWidth, tileCapacity, writePanelWidth,
} from "../lib/panelGeometry.js";

// ── usePanelHost — the ordered set of open popup panels, and the dock they tile inside ─────────
//
// JD, PDF and ATS are peers, so something has to own "which are open, in what order, which has
// focus, and how wide each one is". That is this hook. It deliberately does NOT own the open/closed
// booleans themselves: those already live in JobsPanel (selectedJob, sandboxOpen, rightPanelOpen)
// and are set by a dozen existing call sites (openSandbox from the generate flow, openAtsPanel from
// a card, handleJobSelect, the sync-event handlers). Re-homing all of them would be a rewrite with
// no user-visible benefit and a large regression surface, and the JD panel's behaviour is required
// to be unchanged. So the host OBSERVES the descriptors it is given and derives the layout.
//
// WHAT CHANGED, AND WHY. The host used to tile by handing each panel a different `right` offset
// against the viewport. That is not tiling, it is three independent right-anchored elements that
// happen not to overlap — and it fails the moment one of them changes size: dragging the ATS panel
// 200px wider pushed the PDF panel from x=132 to x=-68, off the left edge of the screen, because
// nothing owned the group's outer bounds. Now the host allocates ONE budget across the open set and
// the dock's width is the sum of it. A resize moves width from one panel to its neighbour and
// leaves that sum alone, so the dock cannot move.
//
// SIDE BY SIDE, AND THE PANEL THAT DOES NOT FIT. Up to THREE panels tile — all three peers can be
// on screen at once, which is the arrangement the set was built for. When a FOURTH would open, the
// rule U3 decided stands unchanged: the LEAST RECENTLY FOCUSED panel is closed to make room.
//
//   - Refusing to open would leave a dead click. The user asked for a surface and nothing would
//     appear; the generate flow in particular calls openSandbox() itself, so a refusal there would
//     silently discard a resume the user just paid a model call for.
//   - Replacing the least recently focused is the one eviction the user is least likely to notice,
//     because it is by definition the panel they have not touched.
//
// Focus order, not open order, drives eviction. Open order alone would evict the panel you opened
// first even if you were actively using it. With three slots and three panel types the rule is now
// mostly theoretical — it fires only if a fourth type is ever added — but it stays because "what
// happens when one more opens" must have an answer that is written down rather than emergent.
/**
 * @param {Array<{id: string, open: boolean, close: Function}>} descriptors
 *        Declared in a stable order. `open` is owned by the caller; `close` is how the host evicts.
 * @param {number} viewportWidth
 * @returns {{
 *   visible: Array<{id, slot, width, focused, fullScreen, resizeMode}>,
 *   dockWidth: number,
 *   focusPanel: (id: string) => void,
 *   beginResize: () => void,
 *   resizeBy: (id: string, delta: number) => void,
 *   endResize: () => void,
 *   openCount: number,
 *   fullScreenMode: boolean,
 * }}
 */
export function usePanelHost(descriptors, viewportWidth) {
  // Focus order, most-recent LAST. A ref rather than state: it is bookkeeping that must be readable
  // synchronously inside the eviction effect without waiting for a re-render.
  const focusOrderRef = useRef([]);
  const [focusTick, setFocusTick] = useState(0);
  // EFFECTIVE widths, in px, for the set that is currently open — not preferences that get refitted
  // on every change.
  //
  // That distinction is the whole of a bug worth naming. Holding preferences and re-running the fit
  // on each drag frame looks equivalent and is not: the fit scales EVERY panel by one factor, so
  // changing one preference changes the factor and therefore moves all the others. Dragging the ATS
  // panel wider visibly resized the JD panel two slots away, because the trade was local but the
  // recomputation was global. The fit runs when the SET or the VIEWPORT changes — the moments a
  // budget genuinely has to be re-divided — and a drag then moves pixels between two neighbours
  // inside that settled result.
  //
  // A ref keyed by the set it was computed for, rather than state seeded by an effect: the first
  // paint is already tiled correctly instead of snapping a frame later. Recomputing for the same
  // key is idempotent, so a double render cannot disturb it.
  const widthsRef = useRef({ key: "", map: {} });
  const [widthTick, setWidthTick] = useState(0);
  // The widths at the instant a drag started. A drag reports its CUMULATIVE delta, so applying it
  // to a moving base would compound and the panel would run away from the cursor.
  const dragBaseRef = useRef(null);

  const openIds = useMemo(
    () => descriptors.filter(d => d.open).map(d => d.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [descriptors.map(d => `${d.id}:${d.open ? 1 : 0}`).join("|")],
  );

  const fullScreenMode = viewportWidth < SIDE_BY_SIDE_MIN_VIEWPORT;
  const capacity = tileCapacity(viewportWidth);

  // Keep the focus order in step with what is actually open: newly-opened panels take focus (the
  // user just asked for them), and closed ones drop out so they cannot be evicted twice or hold a
  // slot they no longer occupy.
  useEffect(() => {
    const prev = focusOrderRef.current;
    const stillOpen = prev.filter(id => openIds.includes(id));
    const newlyOpen = openIds.filter(id => !prev.includes(id));
    const next = [...stillOpen, ...newlyOpen];
    if (next.length !== prev.length || next.some((id, i) => id !== prev[i])) {
      focusOrderRef.current = next;
      setFocusTick(t => t + 1);
    }
  }, [openIds]);

  // Eviction. Runs after the focus order is current, so "least recently focused" is accurate.
  useEffect(() => {
    const order = focusOrderRef.current;
    if (order.length <= capacity) return;
    const evictCount = order.length - capacity;
    // order[0] is least recently focused.
    for (const id of order.slice(0, evictCount)) {
      descriptors.find(d => d.id === id)?.close?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTick, capacity, openIds.join("|")]);

  const focusPanel = useCallback((id) => {
    const order = focusOrderRef.current;
    if (order[order.length - 1] === id) return;   // already focused — no re-render
    if (!order.includes(id)) return;
    focusOrderRef.current = [...order.filter(x => x !== id), id];
    setFocusTick(t => t + 1);
  }, []);

  // ── The tiled layout ────────────────────────────────────────────────────────────────────────
  const layout = useMemo(() => {
    const order = focusOrderRef.current.filter(id => openIds.includes(id));
    // Most recently focused takes SLOT 0 — the rightmost position, which is exactly where the JD
    // drawer has always appeared. A newly-opened panel therefore shows up where the user already
    // expects a panel to be, and the one they were not using slides left.
    const bySlot = [...order].reverse().slice(0, capacity);
    const focusedId = order[order.length - 1];
    const n = bySlot.length;
    if (n === 0) return { visible: [], dockWidth: 0 };

    // Keyed on the SET and the viewport, deliberately not on the focus order: reordering slots
    // moves panels sideways, it does not re-divide the budget, and refitting there would make every
    // click on a peer nudge all their widths.
    const setKey = `${[...bySlot].sort().join("|")}:${viewportWidth}`;
    if (widthsRef.current.key !== setKey) {
      const fitted = fitPanelWidths(
        bySlot.map(id => storedPanelWidth(id)),
        dockBudget(viewportWidth, n),
      );
      widthsRef.current = {
        key: setKey,
        map: Object.fromEntries(bySlot.map((id, i) => [id, fitted[i]])),
      };
    }
    const widths = widthsRef.current.map;

    const visible = bySlot.map((id, slot) => ({
      id,
      slot,
      width: widths[id],
      focused: id === focusedId,
      fullScreen: fullScreenMode,
      // Visual order is left-to-right by DESCENDING slot, so the panel to this one's left is the
      // one at slot+1. A panel with a left neighbour trades width with it and the dock stays put.
      // The leftmost panel has nobody to trade with: when it is the only panel the handle resizes
      // the dock (the JD drawer's historical drag, preserved), and when it is not, there is no
      // handle at all — growing it could only push the dock's outer bound leftwards.
      resizeMode: slot + 1 < n ? "neighbour" : (n === 1 ? "dock" : "none"),
    }));

    const dockWidth = bySlot.reduce((a, id) => a + widths[id], 0) + PANEL_GAP * (n - 1);
    return { visible, dockWidth };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openIds.join("|"), focusTick, capacity, fullScreenMode, viewportWidth, widthTick]);

  const beginResize = useCallback(() => {
    dragBaseRef.current = { ...widthsRef.current.map };
  }, []);

  // `delta` is cumulative px since pointerdown, positive = the dragged panel grows (leftwards).
  const resizeBy = useCallback((id, delta) => {
    const base = dragBaseRef.current;
    if (!base) return;
    const me = layout.visible.find(p => p.id === id);
    if (!me) return;

    if (me.resizeMode === "neighbour") {
      const left = layout.visible.find(p => p.slot === me.slot + 1);
      if (!left) return;
      // Clamped so NEITHER side can go under the minimum. The sum is untouched by construction,
      // which is what keeps the dock's outer bounds fixed through the whole gesture — and only
      // these two entries are written, so no third panel moves.
      const d = Math.max(
        PANEL_MIN_WIDTH - base[id],
        Math.min(base[left.id] - PANEL_MIN_WIDTH, delta),
      );
      widthsRef.current.map[id] = base[id] + d;
      widthsRef.current.map[left.id] = base[left.id] - d;
      setWidthTick(t => t + 1);
      return;
    }
    if (me.resizeMode === "dock") {
      const max = Math.max(PANEL_MIN_WIDTH, window.innerWidth - PANEL_EDGE_GAP * 2);
      widthsRef.current.map[id] = Math.max(PANEL_MIN_WIDTH, Math.min(max, base[id] + delta));
      setWidthTick(t => t + 1);
    }
  }, [layout]);

  const endResize = useCallback(() => {
    if (!dragBaseRef.current) return;
    dragBaseRef.current = null;
    // Persist on release, not on every move: a single drag would otherwise write to localStorage a
    // few hundred times. Only the two panels the gesture actually touched can differ from the
    // snapshot, so writing the whole visible set is cheap and keeps the stored widths consistent
    // with what is on screen.
    for (const p of layout.visible) writePanelWidth(p.id, widthsRef.current.map[p.id] ?? p.width);
  }, [layout]);

  return {
    visible: layout.visible,
    dockWidth: layout.dockWidth,
    focusPanel,
    beginResize,
    resizeBy,
    endResize,
    openCount: openIds.length,
    fullScreenMode,
  };
}

export { SIDE_BY_SIDE_MIN_VIEWPORT, MAX_TILED, tileCapacity, fitPanelWidths };
