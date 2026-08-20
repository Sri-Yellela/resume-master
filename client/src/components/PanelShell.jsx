import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Z } from "../styles/zLayers.js";

// ── PanelShell — the one drawer implementation ────────────────────────────────────────────────
//
// Extracted from JobDetailPanel, which was the only surface that had this right. The PDF sandbox
// and the ATS report were laid out INLINE, as react-resizable-panels columns squeezed into the
// region below the search bar, and consequently sat behind the JD drawer instead of beside it.
// Two divergent implementations of the same drawer is the thing this removes: JD, PDF and ATS now
// render through this component, so they are peers by construction rather than by resemblance.
//
// The seven properties of the reference panel, and where each one lives here:
//
//   1. Right-anchored overlay, INSET from the viewport edges with rounded corners — `right`/`top`/
//      `bottom` below, never flush, never full-height, never in the layout flow.
//   2. A scrim that DIMS but does not hide (rgba(0,0,0,0.45) + a 4px blur). Board content stays
//      legible behind it. One scrim for the whole group, not one per panel — see PanelScrim.
//   3. Backdrop blur on the panel surface itself: the `liquid-panel` class (dark glass), not a flat
//      opaque fill.
//   4. TWO sticky regions — the identity header AND the action bar beneath it — and only the body
//      scrolls. Both are `flexShrink:0` children of a fixed-height flex column, which pins them
//      more firmly than `position:sticky` would: they cannot move at all, rather than sticking once
//      scrolled to. The mechanism differs from the spec's wording; the property it asks for is
//      exactly preserved.
//   5. The body is its own scroll container (`flex:1; overflowY:auto`) with its own scrollbar, and
//      `overscrollBehavior:"contain"` so reaching its end does not start scrolling the page behind
//      it. That last part is the one thing the JD panel was missing.
//   6. Close affordance top-right of the header — rendered here, not by each caller, so all three
//      panels agree.
//   7. Modal tier: Z.MODAL sits above the board, above the Applications table and above the search
//      surface (Z.SEARCH). Before the z-index scale landed, the JD drawer was at 40 and the search
//      bar at 50 — this relationship was inverted.
//
// Everything a panel type differs in is a slot: `header`, `actions`, `children`. Different content
// in the same structure is the primitive working, not divergence.

const MIN_WIDTH = 360;          // below this a resume page is not legible even in Reading view
const DEFAULT_WIDTH = 560;      // the JD panel's historical width — unchanged for it
const WIDTH_KEY = "rm_panel_widths_v1";

// Widths persist PER PANEL TYPE, not per instance: "the PDF panel is wide, the ATS report is
// narrow" is a durable preference about the kind of content, and it should survive a reload.
function readWidths() {
  try { return JSON.parse(localStorage.getItem(WIDTH_KEY) || "{}") || {}; }
  catch { return {}; }
}
function writeWidth(panelId, width) {
  try {
    const all = readWidths();
    all[panelId] = Math.round(width);
    localStorage.setItem(WIDTH_KEY, JSON.stringify(all));
  } catch { /* private mode / quota — the session still works, it just will not remember */ }
}
export function storedPanelWidth(panelId, fallback = DEFAULT_WIDTH) {
  const w = readWidths()[panelId];
  return Number.isFinite(w) && w >= MIN_WIDTH ? w : fallback;
}

// One scrim for the whole group. Rendered once by the host rather than once per panel, because two
// stacked 45% scrims compound to ~70% and the board stops being visible behind them — which would
// break property 2 precisely when a second panel opens.
export function PanelScrim({ show, onClick }) {
  // Portalled to document.body for the same reason the panels are: a position:fixed element is
  // still clipped by an ancestor with a transform or a filter, and it is still confined to an
  // ancestor's stacking context. The scrim has to cover ALL app content, so it must not be a
  // descendant of any of it.
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
 * @param {object}   p
 * @param {string}   p.panelId      stable per TYPE ("jd" | "pdf" | "ats") — the width persistence key
 * @param {number}   p.slot         0 = rightmost. Side-by-side position within the open group.
 * @param {number}   p.rightOffset  px from the viewport's right edge (the host computes it from the
 *                                  widths of the panels to this panel's right, so they tile)
 * @param {boolean}  p.fullScreen   narrow-viewport fallback — see the host's note on this
 * @param {boolean}  p.focused      the focused panel renders above its peers and keeps key handling
 * @param {Function} p.onClose
 * @param {Function} p.onFocus
 * @param {Function} [p.onWidthChange] called with the live width during a drag, so the host can
 *                                     re-tile the panels to the left of this one in real time
 * @param {ReactNode} p.header       sticky region 1 (identity)
 * @param {ReactNode} [p.actions]    sticky region 2 (action bar). Omitted -> only one sticky region,
 *                                   which is correct for a panel that genuinely has no actions.
 */
export default function PanelShell({
  panelId, slot = 0, rightOffset = 16, fullScreen = false, focused = true,
  onClose, onFocus, onWidthChange, header, actions, children, bodyRef,
}) {
  const [width, setWidth] = useState(() => storedPanelWidth(panelId));
  const dragRef = useRef(null);
  const closeBtnRef = useRef(null);

  // Escape closes, but only the FOCUSED panel — otherwise one keypress would close every open
  // panel at once, which is never what the user meant by "go back".
  useEffect(() => {
    if (!focused) return;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [focused, onClose]);

  useEffect(() => { closeBtnRef.current?.focus(); }, []);

  // ── Drag to resize ──────────────────────────────────────────────────────────────────────────
  // Pointer events (not mouse) so a touch drag works, and pointer capture so the drag survives the
  // cursor leaving the 8px handle — without capture, a fast drag detaches and the panel sticks.
  const onPointerDown = useCallback((e) => {
    if (fullScreen) return;                       // nothing to resize when a panel is full-screen
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { startX: e.clientX, startW: width };
  }, [width, fullScreen]);

  const onPointerMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    // The handle is on the LEFT edge of a right-anchored panel, so dragging left (negative dx)
    // must GROW it. Hence startX - clientX.
    const next = Math.max(MIN_WIDTH, Math.min(window.innerWidth - 32, d.startW + (d.startX - e.clientX)));
    setWidth(next);
    onWidthChange?.(next);
  }, [onWidthChange]);

  const endDrag = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    // Persist on release, not on every move: a single drag would otherwise write to localStorage a
    // few hundred times.
    writeWidth(panelId, width);
  }, [panelId, width]);

  // A panel type's stored width can change while this one is mounted (the same type reopened
  // elsewhere), and the host needs the live value to tile its neighbours on first paint.
  useEffect(() => { onWidthChange?.(width); }, [width]); // eslint-disable-line react-hooks/exhaustive-deps

  const geometry = fullScreen
    // Narrow-viewport fallback: a single full-screen panel. Still inset (8px) and still rounded, so
    // it reads as the same object rather than becoming a different component below a breakpoint.
    ? { left: 8, right: 8, top: 64, bottom: 8, width: "auto" }
    : { right: rightOffset, top: 80, bottom: 16, width: `min(${width}px, calc(100vw - 32px))` };

  return createPortal(
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
        position: "fixed",
        ...geometry,
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
        // Focused panel sits one step above its peers so its shadow and any menu it opens read as
        // in front. Still strictly below Z.NAV and Z.POPOVER.
        zIndex: Z.MODAL + (focused ? 1 : 0),
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}>

      {/* Resize handle — left edge, since the panel is right-anchored. Hidden when full-screen,
          where there is nothing to resize against. */}
      {!fullScreen && (
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          title="Drag to resize"
          style={{
            position: "absolute", left: 0, top: 0, bottom: 0, width: 8,
            cursor: "col-resize", zIndex: 2, touchAction: "none",
          }}/>
      )}

      {/* STICKY REGION 1 — identity. flexShrink:0 in a fixed-height column: cannot scroll away. */}
      <div style={{
        display: "flex", alignItems: "flex-start", gap: 10,
        padding: "12px 14px 10px", borderBottom: "1px solid var(--border-glass)",
        flexShrink: 0, background: "var(--color-surface)",
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>{header}</div>
        <button ref={closeBtnRef} onClick={onClose}
          style={{ background: "none", border: "none", cursor: "pointer",
                   color: "var(--color-text-muted)", fontSize: 16, padding: "0 2px",
                   flexShrink: 0, lineHeight: 1 }}
          aria-label="Close panel">✕</button>
      </div>

      {/* STICKY REGION 2 — action bar. Same treatment; omitted entirely when a panel has no actions
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

      {/* BODY — the only thing that scrolls. overscrollBehavior:"contain" stops the scroll chaining
          to the page once the body hits its end, which is the difference between "its own scroll
          container" and "a scroll container that drags the app behind it". */}
      <div ref={bodyRef} style={{
        flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden",
        overscrollBehavior: "contain",
      }}>
        {children}
      </div>
    </motion.div>,
    document.body
  );
}

export { MIN_WIDTH as PANEL_MIN_WIDTH, DEFAULT_WIDTH as PANEL_DEFAULT_WIDTH };
