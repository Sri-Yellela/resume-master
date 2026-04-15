// DockPortal — renders dropdown content via portal to document.body.
// Prevents clipping by any parent's overflow, transform, or z-index context.
import { createPortal } from "react-dom";

export function DockPortal({ children, anchorRect, theme, onClose, style = {} }) {
  if (!anchorRect) return null;
  return createPortal(
    <>
      {/* Backdrop: transparent full-screen overlay captures outside clicks */}
      <div
        style={{ position: "fixed", inset: 0, zIndex: 1999 }}
        onClick={onClose}
        onContextMenu={e => { e.preventDefault(); onClose(); }}
      />
      {/* Dropdown panel: positioned below the anchor */}
      <div style={{
        position: "fixed",
        top: anchorRect.bottom + 8,
        left: anchorRect.left + anchorRect.width / 2,
        transform: "translateX(-50%)",
        zIndex: 2000,
        background: theme?.surface || "rgba(20,20,20,0.95)",
        border: `1px solid ${theme?.border || "rgba(255,255,255,0.1)"}`,
        borderRadius: 12,
        boxShadow: theme?.shadowLg || "0 8px 32px rgba(0,0,0,0.3)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        padding: "8px 0",
        minWidth: 200,
        ...style,
      }}>
        {children}
      </div>
    </>,
    document.body
  );
}
