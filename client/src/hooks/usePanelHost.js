import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PANEL_MIN_WIDTH, storedPanelWidth } from "../components/PanelShell.jsx";

// ── usePanelHost — the ordered set of open popup panels ────────────────────────────────────────
//
// JD, PDF and ATS are peers, so something has to own "which are open, in what order, which has
// focus, and where each one sits". That is this hook. It deliberately does NOT own the open/closed
// booleans themselves: those already live in JobsPanel (selectedJob, sandboxOpen, rightPanelOpen)
// and are set by a dozen existing call sites (openSandbox from the generate flow, openAtsPanel from
// a card, handleJobSelect, the sync-event handlers). Re-homing all of them would be a rewrite with
// no user-visible benefit and a large regression surface, and the JD panel's behaviour is required
// to be unchanged. So the host OBSERVES the descriptors it is given and derives the layout.
//
// SIDE-BY-SIDE, AND THE THIRD PANEL. Two panels may sit side by side. When a third opens, the
// LEAST RECENTLY FOCUSED one is closed to make room — decided explicitly, and this is the choice:
//
//   - Refusing to open would leave a dead click. The user asked for a surface and nothing would
//     appear; the generate flow in particular calls openSandbox() itself, so a refusal there would
//     silently discard a resume the user just paid a model call for.
//   - Replacing the least recently focused is the one eviction the user is least likely to notice,
//     because it is by definition the panel they have not touched. It also makes the common
//     sequence (open JD, generate, PDF appears, glance at ATS) behave the way a two-slot dock
//     should: the thing you stopped using yields.
//
// Focus order, not open order, drives eviction. Open order alone would evict the panel you opened
// first even if you were actively using it.
const MAX_SIDE_BY_SIDE = 2;
const EDGE_GAP = 16;   // matches the JD panel's historical right:16 inset
const PANEL_GAP = 12;  // between two side-by-side panels

// Below this viewport width two panels cannot both clear PANEL_MIN_WIDTH (2*360 + gaps + insets
// > 760), so side-by-side is not viable and the fallback is a single FULL-SCREEN panel: the focused
// one. Chosen over a stacked/accordion arrangement because a resume page and an ATS report are both
// tall, dense documents — halving the height of each would make both unreadable, whereas one at a
// time stays fully usable. The others are not lost: they stay open in the host and are one tap away
// once the focused one is closed.
const SIDE_BY_SIDE_MIN_VIEWPORT = 900;

/**
 * @param {Array<{id: string, open: boolean, close: Function}>} descriptors
 *        Declared in a stable order. `open` is owned by the caller; `close` is how the host evicts.
 * @param {number} viewportWidth
 * @returns {{
 *   visible: Array<{id, slot, rightOffset, focused, fullScreen}>,
 *   focusPanel: (id: string) => void,
 *   reportWidth: (id: string, width: number) => void,
 *   openCount: number,
 *   fullScreenMode: boolean,
 * }}
 */
export function usePanelHost(descriptors, viewportWidth) {
  // Focus order, most-recent LAST. A ref rather than state: it is bookkeeping that must be readable
  // synchronously inside the eviction effect without waiting for a re-render.
  const focusOrderRef = useRef([]);
  const [focusTick, setFocusTick] = useState(0);
  // Live widths, so the panels tile correctly while one is being dragged. Seeded from the persisted
  // value so the FIRST paint is already correct rather than snapping after a frame.
  const widthsRef = useRef({});
  const [widthTick, setWidthTick] = useState(0);

  const openIds = useMemo(
    () => descriptors.filter(d => d.open).map(d => d.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [descriptors.map(d => `${d.id}:${d.open ? 1 : 0}`).join("|")],
  );

  const fullScreenMode = viewportWidth < SIDE_BY_SIDE_MIN_VIEWPORT;
  const capacity = fullScreenMode ? 1 : MAX_SIDE_BY_SIDE;

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

  const reportWidth = useCallback((id, width) => {
    if (widthsRef.current[id] === width) return;
    widthsRef.current[id] = width;
    setWidthTick(t => t + 1);
  }, []);

  const visible = useMemo(() => {
    const order = focusOrderRef.current.filter(id => openIds.includes(id));
    // Most recently focused takes SLOT 0 — the rightmost position, which is exactly where the JD
    // drawer has always appeared. A newly-opened panel therefore shows up where the user already
    // expects a panel to be, and the one they were not using slides left.
    const bySlot = [...order].reverse().slice(0, capacity);
    const focusedId = order[order.length - 1];

    let offset = EDGE_GAP;
    return bySlot.map((id, slot) => {
      const rightOffset = offset;
      const w = widthsRef.current[id] ?? storedPanelWidth(id);
      offset += Math.max(PANEL_MIN_WIDTH, w) + PANEL_GAP;
      return { id, slot, rightOffset, focused: id === focusedId, fullScreen: fullScreenMode };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openIds.join("|"), focusTick, widthTick, capacity, fullScreenMode]);

  return { visible, focusPanel, reportWidth, openCount: openIds.length, fullScreenMode };
}

export { SIDE_BY_SIDE_MIN_VIEWPORT, MAX_SIDE_BY_SIDE };
