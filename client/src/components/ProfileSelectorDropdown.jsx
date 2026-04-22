import { useRef, useState } from "react";
import { DockPortal } from "./DockPortal.jsx";

export default function ProfileSelectorDropdown({
  theme,
  profiles = [],
  activeProfile,
  onActivate,
  onDelete,
  onAdd,
  compact = false,
  title = "Select active profile",
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const buttonRef = useRef(null);
  const canDelete = profiles.length > 1;
  const canAdd = profiles.length < 4;
  const active = activeProfile || profiles.find(p => p.is_active) || profiles[0] || null;

  if (!profiles.length) return null;

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button
        ref={buttonRef}
        type="button"
        title={title}
        onClick={() => {
          if (buttonRef.current) setRect(buttonRef.current.getBoundingClientRect());
          setOpen(o => !o);
        }}
        style={{
          height: compact ? 26 : 34,
          minWidth: compact ? 128 : 170,
          maxWidth: compact ? 170 : 240,
          padding: compact ? "0 9px" : "0 10px",
          borderRadius: compact ? 4 : 6,
          border: `1px solid ${theme.border}`,
          background: theme.surface,
          color: theme.text,
          fontSize: compact ? 11 : 12,
          fontWeight: 700,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          fontFamily: "'DM Sans',system-ui",
        }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {active?.profile_name || "Profile"}
        </span>
        <span aria-hidden="true" style={{ color: theme.textDim, fontSize: 10 }}>v</span>
      </button>

      {open && rect && (
        <DockPortal anchorRect={rect} theme={theme} onClose={() => setOpen(false)}
          style={{ minWidth: compact ? 230 : 270, maxWidth: "calc(100vw - 24px)" }}>
          <div style={{ padding: "6px 10px 8px", borderBottom: `1px solid ${theme.border}` }}>
            <div style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase",
                           letterSpacing: "0.08em", color: theme.textDim }}>
              Job Profile
            </div>
          </div>
          <div style={{ padding: "6px 6px" }}>
            {profiles.map(profile => {
              const isActive = active?.id === profile.id || profile.is_active;
              return (
                <div
                  key={profile.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setOpen(false);
                    if (!isActive) onActivate?.(profile.id);
                  }}
                  onKeyDown={e => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setOpen(false);
                      if (!isActive) onActivate?.(profile.id);
                    }
                  }}
                  style={{
                    width: "100%",
                    minHeight: 34,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "5px 6px 5px 10px",
                    border: "none",
                    borderRadius: 6,
                    background: isActive ? `${theme.accent}22` : "transparent",
                    color: theme.text,
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "'DM Sans',system-ui",
                  }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%",
                                 background: isActive ? theme.accent : theme.border,
                                 flexShrink: 0 }}/>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden",
                                 textOverflow: "ellipsis", whiteSpace: "nowrap",
                                 fontSize: 12, fontWeight: isActive ? 800 : 600 }}>
                    {profile.profile_name}
                  </span>
                  <span
                    role="button"
                    tabIndex={canDelete ? 0 : -1}
                    title={canDelete ? `Delete ${profile.profile_name}` : "Cannot delete your only profile"}
                    aria-disabled={!canDelete}
                    onClick={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (canDelete) onDelete?.(profile.id);
                    }}
                    onKeyDown={e => {
                      if ((e.key === "Enter" || e.key === " ") && canDelete) {
                        e.preventDefault();
                        e.stopPropagation();
                        onDelete?.(profile.id);
                      }
                    }}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 4,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      border: `1px solid ${canDelete ? "#dc262644" : theme.border}`,
                      background: canDelete ? "#fef2f2" : theme.surfaceHigh,
                      color: canDelete ? "#dc2626" : theme.textDim,
                      cursor: canDelete ? "pointer" : "not-allowed",
                      fontSize: 13,
                      fontWeight: 900,
                      flexShrink: 0,
                    }}>
                    x
                  </span>
                </div>
              );
            })}
          </div>
          <div style={{ padding: "8px 10px 4px", borderTop: `1px solid ${theme.border}`,
                        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 10, color: theme.textDim }}>{profiles.length}/4 profiles</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <a
                href="/app/profile"
                onClick={() => setOpen(false)}
                style={{
                  color: theme.text,
                  fontSize: 11,
                  fontWeight: 700,
                  textDecoration: "none",
                  border: `1px solid ${theme.border}`,
                  borderRadius: 6,
                  padding: "6px 10px",
                  background: theme.surface,
                }}>
                Manage Profiles
              </a>
              <button
                type="button"
                disabled={!canAdd}
                onClick={() => { if (canAdd) { setOpen(false); onAdd?.(); } }}
                style={{
                  background: canAdd ? theme.accent : theme.surfaceHigh,
                  color: canAdd ? "#0f0f0f" : theme.textDim,
                  border: "none",
                  borderRadius: 6,
                  padding: "6px 10px",
                  cursor: canAdd ? "pointer" : "not-allowed",
                  fontSize: 12,
                  fontWeight: 800,
                }}>
                + Add Profile
              </button>
            </div>
          </div>
        </DockPortal>
      )}
    </div>
  );
}
