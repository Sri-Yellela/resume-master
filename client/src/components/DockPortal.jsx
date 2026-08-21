// DockPortal — renders dropdown content via portal to document.body.
// Prevents clipping by any parent's overflow, transform, or z-index context.
// Uses viewport-clamped positioning so panels never overflow left/right/bottom.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Z } from "../styles/zLayers.js";

function getPortalPosition(anchorRect, panelWidth) {
  const anchorCenter = anchorRect.left + anchorRect.width / 2;
  let left = anchorCenter - panelWidth / 2;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  left = Math.max(12, Math.min(left, vw - panelWidth - 12));
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const preferredTop = anchorRect.bottom + 8;
  const top = Math.min(preferredTop, Math.max(12, vh - 232));
  return { top, left };
}

/**
 * `tier` — which z tier this portal paints at. Defaults to Z.POPOVER, which is right for a MENU:
 * a menu is invoked from chrome that stays live over a modal, so it must never be underlapped.
 *
 * The search bar's own dropdowns are the exception, and they pass Z.SEARCH_DROPDOWN. They belong to
 * a surface that a drawer or a panel COVERS, so painting them at the top tier put a dropdown from a
 * covered control over the thing covering it. Y2's scale places them directly above SEARCH and below
 * the drawer instead. The portal itself is unchanged either way — the whole reason this component
 * exists is escaping a clipping ancestor, and that is orthogonal to which tier it lands in.
 */
export function DockPortal({ children, anchorRect, theme, onClose, style = {}, tier = Z.POPOVER }) {
  const panelRef = useRef(null);

  // ── Outside click: dismiss WITHOUT consuming the click ──────────────────────────────────────
  //
  // This replaced a full-screen transparent <div> at z-index 1999 that had onClick={onClose}. That
  // div did close the dropdown, but it also ATE the click: the user's press landed on the overlay
  // instead of on whatever they were aiming at, so dismissing a menu and pressing a button
  // underneath took two clicks, and the first one silently did nothing. A dropdown should get out of
  // the way, not intercept.
  //
  // A document-level pointerdown listener closes on the same gesture while leaving the event to
  // continue to its real target. Two things keep it from misfiring:
  //
  //   - It is registered in an effect, i.e. AFTER the click that opened the dropdown has already
  //     dispatched, so the opening gesture cannot immediately close it.
  //   - The anchor's own rect is hit-tested and ignored. Without that, clicking the trigger again to
  //     toggle closed would close here and then be re-opened by the trigger's own handler, and the
  //     menu could never be dismissed from its own button.
  useEffect(() => {
    if (!anchorRect) return;
    const onPointerDown = (e) => {
      if (panelRef.current?.contains(e.target)) return;             // inside the panel: not an outside click
      const { clientX: x, clientY: y } = e;
      if (x >= anchorRect.left && x <= anchorRect.right &&
          y >= anchorRect.top  && y <= anchorRect.bottom) return;   // on the trigger: let it toggle
      onClose?.();
    };
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchorRect, onClose]);

  if (!anchorRect) return null;
  const panelWidth = (style.minWidth != null ? Number(style.minWidth) : 0) || 260;
  const pos = getPortalPosition(anchorRect, panelWidth);
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const maxH = Math.max(160, vh - pos.top - 12);

  return createPortal(
    <div ref={panelRef} style={{
      position: "fixed",
      top: pos.top,
      left: pos.left,
      // The caller's tier (client/src/styles/zLayers.js), POPOVER by default. Portalled to
      // document.body either way, so no ancestor's overflow:hidden or transform can clip it.
      zIndex: tier,
      background: theme?.menuSurface || theme?.surface || "rgba(20,20,20,0.98)",
      border: `1px solid ${theme?.border || "rgba(255,255,255,0.1)"}`,
      borderRadius: 8,
      boxShadow: theme?.shadowLg || "0 8px 32px rgba(0,0,0,0.3)",
      backdropFilter: "blur(20px)",
      WebkitBackdropFilter: "blur(20px)",
      padding: "8px 0 16px",
      maxHeight: `min(${maxH}px, calc(100vh - ${pos.top + 12}px))`,
      overflowY: "auto",
      overflowX: "hidden",
      ...style,
    }}>
      {children}
    </div>,
    document.body
  );
}
