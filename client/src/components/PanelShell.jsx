import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Z } from "../styles/zLayers.js";
import {
  PANEL_MIN_WIDTH, PANEL_DEFAULT_WIDTH, PANEL_EDGE_GAP, PANEL_GAP, storedPanelWidth,
} from "../lib/panelGeometry.js";

// ── PanelShell / PanelDock — the overlay tier, and the tiling that happens INSIDE it ───────────
//
// U3 made the PDF and ATS surfaces overlay popups rather than react-resizable-panels columns, and
// that part is intact: every panel is portalled out of the board and painted above a scrim. What it
// got wrong is WHERE the tiling happens. Each panel was independently `position: fixed`, and the
// host tiled them by handing each one a different `right` offset. Panels laid out against the
// VIEWPORT, one at a time, with nothing holding the group together — and the consequences were
// exactly what you would predict from that:
//
//   - Dragging one panel wider pushed its neighbour off the left edge of the screen (measured:
//     dragging the ATS panel 200px wider moved the PDF panel from x=132 to x=-68). Two panels
//     right-anchored independently cannot resize AGAINST each other; the second one just gets
//     shoved. The group had no outer bounds to keep stable, because it had no bounds at all.
//   - "Squeezing the job list into a narrow strip" was the visible result: 2x560px of panel plus
//     gaps covers 1132 of a 1280px viewport, and the board is not resized but is dimmed under it,
//     which reads exactly like a squeezed column.
//
// PanelDock is the missing object: ONE fixed overlay surface, inset from the viewport edges, whose
// outer bounds are a property of the open SET rather than of any one panel. Panels are flex
// children of it. Tiling is now internal by construction — a panel cannot lay out against the
// board because it has no relationship with the board, only with the dock and its neighbours.
//
// The seven properties of the reference panel are unchanged and still live in one place:
//
//   1. Inset overlay with rounded corners — the DOCK owns the inset (right/top/bottom), each panel
//      owns the radius. Still never flush, never full-height, never in the layout flow.
//   2. A scrim that DIMS but does not hide. One for the whole group — see PanelScrim.
//   3. Backdrop blur on the panel surface itself (dark glass), not a flat opaque fill.
//   4. TWO pinned regions — the identity header AND the action bar — as `flexShrink: 0` children of
//      a fixed-height flex column, which pins them harder than `position: sticky`: they cannot move
//      at all rather than sticking once scrolled to.
//   5. The body is its own scroll container with `overscrollBehavior: "contain"`, so reaching its
//      end does not start scrolling anything behind it.
//   6. One close affordance, top-right, owned by the primitive rather than by each caller.
//   7. Modal tier: the dock sits at Z.MODAL, above the board, the Applications table and the search
//      surface. Focus ordering between peers is now a z-index WITHIN the dock, not a global one.

// Geometry and persistence live in lib/panelGeometry.js: PanelShell needs them to draw and
// usePanelHost needs them to divide, and one copy is how the dock and the panels inside it stay in
// agreement. Aliased to the short local names the rest of this file reads with.
const MIN_WIDTH = PANEL_MIN_WIDTH;
const DEFAULT_WIDTH = PANEL_DEFAULT_WIDTH;
const EDGE_GAP = PANEL_EDGE_GAP;

// ── The clearance below the FIXED chrome ───────────────────────────────────────────────────────
//
// Was the literal 80, in two places: here and JobsPanel's FILTER_DRAWER_TOP, which copied it so the
// two drawers would share a top edge. Y4 asks for the panels to stack below the chrome measured
// rather than hardcoded, because the chrome's height now varies by tab.
//
// Only the FIXED part of the chrome matters to a fixed overlay — the hero and the search bar are
// in-flow and scroll away underneath it, which is what an overlay is for. So this is the measured
// bar height plus a gap, and --app-chrome-height is published from the one measurement in
// hooks/useChromeHeight.js. 46 + 34 is the 80 it was, exactly: this preserves today's geometry and
// removes the way it could stop being right.
//
// ONE CONSTANT, exported, rather than two numbers that read each other. That is what makes "the two
// drawers share a top edge" true by construction instead of true by a test noticing.
export const PANEL_TOP_INSET = "calc(var(--app-chrome-height, 46px) + 34px)";
export const PANEL_BOTTOM_INSET = 16;

// One scrim for the whole group. Rendered once by the host rather than once per panel, because two
// stacked 45% scrims compound to ~70% and the board stops being visible behind them — which would
// break property 2 precisely when a second panel opens.
export function PanelScrim({ show, onClick }) {
  // Portalled to document.body for the same reason the dock is: a position:fixed element is still
  // clipped by an ancestor with a transform or a filter, and it is still confined to an ancestor's
  // stacking context. The scrim has to cover ALL app content, so it must not descend from any of it.
  return createPortal(
    <AnimatePresence>
      {show && (
        <motion.div key="panel-scrim"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClick}
          style={{ position: "fixed", inset: 0, zIndex: Z.MODAL_SCRIM,
                   background: "rgba(0,0,0,0.45)",
                   backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}/>
      )}
    </AnimatePresence>,
    document.body
  );
}

/**
 * PanelDock — the overlay surface the panels tile inside.
 *
 * Its geometry is a function of the open SET (how many panels, how wide each one is), never of one
 * panel's drag. That is the whole point: a neighbour-resize moves width from one child to the other
 * and leaves the sum — and therefore the dock — exactly where it was.
 *
 * @param {number}  p.width       total px across all open panels plus the gaps between them
 * @param {boolean} p.fullScreen  narrow-viewport fallback — one panel, filling the dock
 */
export function PanelDock({ width, fullScreen = false, children }) {
  const geometry = fullScreen
    // Narrow-viewport fallback: the dock spans the viewport and its single child fills it. Still
    // inset (8px) and still rounded, so it reads as the same object rather than becoming a
    // different component below a breakpoint.
    ? { left: 8, right: 8, top: 64, bottom: 8 }
    : { right: EDGE_GAP, top: PANEL_TOP_INSET, bottom: PANEL_BOTTOM_INSET,
        width: `min(${Math.round(width)}px, calc(100vw - ${EDGE_GAP * 2}px))` };

  return createPortal(
    <div
      data-panel-dock=""
      style={{
        position: "fixed",
        ...geometry,
        zIndex: Z.MODAL,
        display: "flex",
        flexDirection: "row",
        gap: PANEL_GAP,
        // The dock is a container, not a surface. Without this the transparent gap between two
        // panels would swallow clicks meant for the scrim, and closing by clicking beside a panel
        // would fail on a 12px-wide strip that looks like nothing at all.
        pointerEvents: "none",
      }}>
      {children}
    </div>,
    document.body
  );
}

/**
 * @param {object}   p
 * @param {string}   p.panelId      stable per TYPE ("jd" | "pdf" | "ats") — the persistence key
 * @param {number}   p.slot         0 = rightmost. Position within the tiled group.
 * @param {number}   p.width        px, assigned by the host from the dock's budget
 * @param {boolean}  p.fullScreen   narrow-viewport fallback — see usePanelHost
 * @param {boolean}  p.focused      the focused panel renders above its peers and keeps key handling
 * @param {"neighbour"|"dock"|"none"} p.resizeMode
 *        "neighbour" — the handle trades width with the panel on this one's left; the dock's outer
 *                      bounds do not move.
 *        "dock"      — the only open panel; the handle resizes the dock itself, which is the JD
 *                      drawer's historical behaviour and is preserved for the single-panel case.
 *        "none"      — leftmost of two or more; it has no left neighbour to resize against, and a
 *                      handle here could only grow the dock leftwards, i.e. move its outer bounds.
 * @param {Function} p.onResizeStart  host snapshots the current widths
 * @param {Function} p.onResize       called with the cumulative px delta since pointerdown
 * @param {Function} p.onResizeEnd    host persists
 * @param {ReactNode} p.header       pinned region 1 (identity)
 * @param {ReactNode} [p.actions]    pinned region 2 (action bar). Omitted -> one pinned region,
 *                                   which is correct for a panel that genuinely has no actions.
 */
export default function PanelShell({
  panelId, slot = 0, width = DEFAULT_WIDTH, fullScreen = false, focused = true,
  resizeMode = "dock", onResizeStart, onResize, onResizeEnd,
  onClose, onFocus, header, actions, children, bodyRef,
}) {
  const dragRef = useRef(null);
  const ownBodyRef = useRef(null);
  const scrollRef = bodyRef || ownBodyRef;

  // Escape closes, but only the FOCUSED panel — otherwise one keypress would close every open
  // panel at once, which is never what the user meant by "go back".
  useEffect(() => {
    if (!focused) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [focused, onClose]);

  // Focus the BODY, not the close button.
  //
  // Requirement: Space / PageDown / the arrow keys must scroll the focused panel rather than the
  // page. The browser already does exactly that, for free, provided the focused element is inside
  // the scroll container — so the fix is to put focus there instead of adding a key handler that
  // would have to re-derive the browser's own scrolling rules. A `tabIndex={-1}` scroll container
  // is programmatically focusable without joining the tab order, so Tab still lands on the close
  // button and the action bar in their natural positions.
  useEffect(() => {
    if (!focused) return;
    scrollRef.current?.focus?.({ preventScroll: true });
  }, [focused, scrollRef]);

  // ── Drag to resize ──────────────────────────────────────────────────────────────────────────
  // Pointer events (not mouse) so a touch drag works, and pointer capture so the drag survives the
  // cursor leaving the 8px handle — without capture, a fast drag detaches and the panel sticks.
  const onPointerDown = useCallback((e) => {
    if (fullScreen || resizeMode === "none") return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { startX: e.clientX };
    onResizeStart?.();
  }, [fullScreen, resizeMode, onResizeStart]);

  const onPointerMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    // The handle is on the LEFT edge of a right-anchored panel, so dragging left (negative dx) must
    // GROW it. Hence startX - clientX. The host clamps; this only reports the gesture.
    onResize?.(d.startX - e.clientX);
  }, [onResize]);

  const endDrag = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    // Persist on release, not on every move: a single drag would otherwise write to localStorage a
    // few hundred times.
    onResizeEnd?.();
  }, [onResizeEnd]);

  return (
    <motion.div
      key={`panel-${panelId}`}
      initial={{ x: 560, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 560, opacity: 0 }}
      transition={{ type: "spring", damping: 26, stiffness: 220 }}
      onMouseDown={onFocus}
      className="liquid-panel"
      data-panel-id={panelId}
      data-panel-slot={slot}
      style={{
        // A flex child of the dock, not a viewport-positioned element. This is the line that makes
        // tiling internal: the panel's position is now a consequence of its siblings' widths, so it
        // can never be laid out against the board or shoved past the viewport's edge.
        position: "relative",
        flex: fullScreen ? "1 1 auto" : `0 0 ${Math.round(width)}px`,
        minWidth: 0,
        height: "100%",
        // Slot 0 is the RIGHTMOST position — where the JD drawer has always appeared — so a newly
        // opened panel shows up where the user already expects one and the untouched one slides
        // left. Expressed as CSS `order` rather than by reordering the JSX, so a panel keeps its
        // DOM node when its slot changes and therefore keeps its scroll position.
        order: -slot,
        pointerEvents: "auto",
        // Within the dock's stacking context — the dock itself carries Z.MODAL.
        zIndex: focused ? 1 : 0,
        borderRadius: 16,
        // The dark-glass blur is set INLINE as well as via .liquid-panel, and that is deliberate.
        // The CSS pipeline minifies the class rule down to `-webkit-backdrop-filter` only — the
        // unprefixed declaration is dropped, so the panel's computed backdropFilter reads "none"
        // and the property the reference panel requires (blur on the surface itself, not a flat
        // fill) silently depends on a vendor alias surviving. Declaring it here makes it a property
        // of the primitive rather than of the build. .liquid-panel still supplies the tint, border
        // and shadow, so the surface is unchanged where the class already worked.
        backdropFilter: "blur(14px) saturate(140%)",
        WebkitBackdropFilter: "blur(14px) saturate(140%)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}>

      {/* Resize handle — left edge, since the group is right-anchored. Rendered only where there is
          something to resize AGAINST: see resizeMode. */}
      {!fullScreen && resizeMode !== "none" && (
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          title="Drag to resize"
          data-panel-resize={resizeMode}
          style={{
            position: "absolute", left: 0, top: 0, bottom: 0, width: 8,
            cursor: "col-resize", zIndex: 2, touchAction: "none",
          }}/>
      )}

      {/* PINNED REGION 1 — identity. flexShrink:0 in a fixed-height column: cannot scroll away. */}
      <div style={{
        display: "flex", alignItems: "flex-start", gap: 10,
        padding: "12px 14px 10px", borderBottom: "1px solid var(--border-glass)",
        flexShrink: 0, background: "var(--color-surface)",
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>{header}</div>
        <button onClick={onClose}
          style={{ background: "none", border: "none", cursor: "pointer",
                   color: "var(--color-text-muted)", fontSize: 16, padding: "0 2px",
                   flexShrink: 0, lineHeight: 1 }}
          aria-label="Close panel">✕</button>
      </div>

      {/* PINNED REGION 2 — action bar. Same treatment; omitted entirely when a panel has no actions
          rather than rendering an empty bar. */}
      {actions && (
        <div style={{
          display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
          padding: "8px 14px", borderBottom: "1px solid var(--border-glass)",
          flexShrink: 0, background: "var(--color-surface)",
        }}>
          {actions}
        </div>
      )}

      {/* BODY — the only thing that scrolls, and the keyboard-scroll target (see the focus effect).
          overscrollBehavior:"contain" stops the scroll chaining to the page once the body hits its
          end, which is the difference between "its own scroll container" and "a scroll container
          that drags the app behind it". `outline: none` because this element is focused
          programmatically for scrolling, not by the user tabbing to it — the visible focus ring
          belongs on the close button and the actions, which are still in the tab order. */}
      <div ref={scrollRef} tabIndex={-1} data-panel-body="" style={{
        flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden",
        overscrollBehavior: "contain", outline: "none",
      }}>
        {children}
      </div>
    </motion.div>
  );
}

// Re-exported so callers that already reach for the primitive do not need a second import path.
export { PANEL_MIN_WIDTH, PANEL_DEFAULT_WIDTH, PANEL_EDGE_GAP, PANEL_GAP, storedPanelWidth };
