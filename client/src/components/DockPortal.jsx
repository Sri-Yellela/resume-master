// DockPortal — renders dropdown content via portal to document.body.
// Prevents clipping by any parent's overflow, transform, or z-index context.
// Uses viewport-clamped positioning so panels never overflow left/right/bottom.
import { createPortal } from "react-dom";

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

export function DockPortal({ children, anchorRect, theme, onClose, style = {} }) {
  if (!anchorRect) return null;
  const panelWidth = (style.minWidth != null ? Number(style.minWidth) : 0) || 260;
  const pos = getPortalPosition(anchorRect, panelWidth);
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const maxH = Math.max(160, vh - pos.top - 12);

  return createPortal(
    <>
      {/* Backdrop: transparent full-screen overlay captures outside clicks */}
      <div
        style={{ position: "fixed", inset: 0, zIndex: 1999 }}
        onClick={onClose}
        onContextMenu={e => { e.preventDefault(); onClose(); }}
      />
      {/* Dropdown panel: viewport-clamped position */}
      <div style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        zIndex: 10000,
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
      </div>
    </>,
    document.body
  );
}
