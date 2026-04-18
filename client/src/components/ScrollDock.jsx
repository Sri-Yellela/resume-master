// client/src/components/ScrollDock.jsx
// Unified nav bar: full-width expanded → floating pill collapsed on scroll.
// Variants: "marketing" | "app" | "tools"
import { useState, useEffect, useRef, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTheme } from "../styles/theme.jsx";
import { useViewport } from "../hooks/useViewport.js";
import { useScrollCollapsed } from "../hooks/useScrollCollapsed.js";
import { useSyncEvents } from "../hooks/useSyncEvents.js";
import { useAppScroll } from "../contexts/AppScrollContext.jsx";
import { api } from "../lib/api.js";

// ── Logo (nested-box Lucy brand mark) ────────────────────────
function LucyLogo({ theme, mini = false }) {
  if (mini) {
    return (
      <div style={{ position: "relative", width: 36, height: 26, display: "flex",
                    alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <div style={{ position: "absolute", inset: 0, background: theme.accent,
                      transform: "rotate(-3deg)", borderRadius: 2 }}/>
        <div style={{ position: "relative", zIndex: 1, padding: "2px 5px",
                      background: "#ffffff", border: "2px solid #0f0f0f",
                      transform: "rotate(-2deg)", borderRadius: 2,
                      display: "flex", alignItems: "center" }}>
          <span style={{ fontFamily: "'Barlow Condensed','DM Sans',system-ui,sans-serif",
                          fontWeight: 800, fontSize: 11, letterSpacing: "0.06em",
                          textTransform: "uppercase", color: "#0f0f0f", fontStyle: "italic",
                          lineHeight: 1, whiteSpace: "nowrap" }}>RM</span>
        </div>
      </div>
    );
  }
  return (
    <div style={{ position: "relative", display: "inline-flex", alignItems: "center",
                  justifyContent: "center", flexShrink: 0, height: 36, width: 158 }}>
      <div style={{ position: "absolute", inset: 0, background: theme.accent,
                    transform: "rotate(-3deg)", borderRadius: 2 }}/>
      <div style={{ position: "relative", zIndex: 1, padding: "3px 10px",
                    background: "#ffffff", border: "2.5px solid #0f0f0f",
                    transform: "rotate(-2deg)", borderRadius: 2,
                    display: "flex", alignItems: "center" }}>
        <span style={{ fontFamily: "'Barlow Condensed','DM Sans',system-ui,sans-serif",
                        fontWeight: 800, fontSize: 15, letterSpacing: "0.06em",
                        textTransform: "uppercase", color: "#0f0f0f", fontStyle: "italic",
                        lineHeight: 1, whiteSpace: "nowrap" }}>Resume Master</span>
      </div>
    </div>
  );
}

// ── Close on outside click ───────────────────────────────────
function useClickOutside(ref, onClose) {
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", h);
    document.addEventListener("touchstart", h);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("touchstart", h); };
  }, [ref, onClose]);
}

// ── Dock divider ─────────────────────────────────────────────
function DockDivider({ theme }) {
  return (
    <div style={{ width: 1, height: 20, background: `${theme.accent}33`,
                  flexShrink: 0, margin: "0 2px" }}/>
  );
}

// ── Inline dropdown panel ─────────────────────────────────────
function DropPanel({ children, style = {}, theme }) {
  return (
    <div style={{
      position: "absolute", top: "calc(100% + 10px)", right: 0,
      background: theme.menuSurface || theme.surface, border: `1px solid ${theme.border}`,
      borderRadius: 12, boxShadow: theme.shadowLg,
      zIndex: 9999, minWidth: 240, padding: "8px 0",
      backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
      ...style,
    }}>
      {children}
    </div>
  );
}

// ── Notification bell (app variant) ─────────────────────────
function NotificationsBell({ theme }) {
  const [open, setOpen] = useState(false);
  const [notifs, setNotifs] = useState([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false));

  const load = useCallback(async () => {
    try {
      const d = await api("/api/notifications");
      setNotifs(d.notifications || []);
      setUnread(d.unreadCount || 0);
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

  // Real-time badge bump via SSE
  useSyncEvents({
    notification: () => setUnread(n => n + 1),
    scrape_complete: () => setUnread(n => n + 1),
    resume_generated: () => setUnread(n => n + 1),
  });

  const markAll = async () => {
    try { await api("/api/notifications/read-all", { method: "PATCH" }); } catch {}
    setNotifs(n => n.map(x => ({ ...x, read: 1 })));
    setUnread(0);
  };

  const timeAgo = (ts) => {
    const s = Math.floor(Date.now() / 1000 - ts);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  const ICONS = {
    scrape_complete: "🔍",
    resume_generated: "✦",
    ats_scored: "🎯",
    enhance_ready: "✨",
    best_match: "⚡",
    apply_complete: "✅",
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => { setOpen(o => !o); if (!open) load(); }}
        title="Notifications"
        style={{
          background: "transparent", border: "none", cursor: "pointer",
          padding: "4px 8px", borderRadius: 8, position: "relative",
          display: "flex", alignItems: "center", color: theme.textMuted,
          fontSize: 16, transition: "color 0.15s",
        }}
        onMouseEnter={e => e.currentTarget.style.color = theme.accent}
        onMouseLeave={e => e.currentTarget.style.color = theme.textMuted}>
        🔔
        {unread > 0 && (
          <span style={{
            position: "absolute", top: 0, right: 2,
            background: theme.accent, color: "#0f0f0f",
            borderRadius: "50%", width: 16, height: 16,
            fontSize: 9, fontWeight: 800, lineHeight: "16px",
            textAlign: "center", display: "block",
          }}>
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <DropPanel theme={theme} style={{ minWidth: 300, right: "auto", left: "50%",
                                          transform: "translateX(-50%)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                        padding: "6px 14px 10px", borderBottom: `1px solid ${theme.border}` }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: theme.text }}>Notifications</span>
            {unread > 0 && (
              <button onClick={markAll}
                style={{ background: "none", border: "none", cursor: "pointer",
                         fontSize: 10, color: theme.accentText, fontWeight: 700, padding: 0 }}>
                Mark all read
              </button>
            )}
          </div>
          {notifs.length === 0 ? (
            <div style={{ padding: "20px 14px", textAlign: "center",
                           fontSize: 12, color: theme.textDim }}>
              No notifications yet
            </div>
          ) : (
            notifs.slice(0, 20).map(n => (
              <div key={n.id} style={{
                padding: "8px 14px", display: "flex", alignItems: "flex-start", gap: 10,
                background: !n.read ? `${theme.accent}0d` : "transparent",
                transition: "background 0.15s",
              }}>
                <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>
                  {ICONS[n.type] || "ℹ"}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: theme.text, lineHeight: 1.4 }}>
                    {n.message}
                  </div>
                  <div style={{ fontSize: 10, color: theme.textDim, marginTop: 2 }}>
                    {timeAgo(n.created_at)}
                  </div>
                </div>
                {!n.read && (
                  <div style={{ width: 6, height: 6, borderRadius: "50%",
                                 background: theme.accent, flexShrink: 0, marginTop: 4 }}/>
                )}
              </div>
            ))
          )}
        </DropPanel>
      )}
    </div>
  );
}

// ── Profile switcher (app variant) ───────────────────────────
function ProfileSwitcher({ theme, onProfileActivate, onTabChange }) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false));

  useEffect(() => {
    api("/api/domain-profiles")
      .then(d => setProfiles(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, []);

  const active = profiles.find(p => p.is_active);

  const activate = async (id) => {
    try {
      await api(`/api/domain-profiles/${id}/activate`, { method: "POST" });
      setProfiles(ps => ps.map(p => ({ ...p, is_active: p.id === id ? 1 : 0 })));
      onProfileActivate?.(id);
    } catch {}
    setOpen(false);
  };

  if (!profiles.length) return null;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Switch profile"
        style={{
          background: "transparent", border: "none", cursor: "pointer",
          padding: "4px 10px", borderRadius: 8,
          display: "flex", alignItems: "center", gap: 5,
          color: theme.textMuted, fontSize: 12, fontWeight: 600,
          transition: "color 0.15s", maxWidth: 130, overflow: "hidden",
        }}
        onMouseEnter={e => e.currentTarget.style.color = theme.text}
        onMouseLeave={e => e.currentTarget.style.color = theme.textMuted}>
        <span style={{ width: 6, height: 6, borderRadius: "50%",
                        background: theme.accent, flexShrink: 0 }}/>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 96 }}>
          {active?.profile_name || "Profile"}
        </span>
        <span style={{ fontSize: 9 }}>▾</span>
      </button>

      {open && (
        <DropPanel theme={theme} style={{ minWidth: 200 }}>
          <div style={{ padding: "6px 14px 8px", fontSize: 10, fontWeight: 700,
                         textTransform: "uppercase", letterSpacing: "0.08em", color: theme.textDim }}>
            Switch Profile
          </div>
          {profiles.map(p => (
            <button key={p.id} onClick={() => activate(p.id)}
              onMouseEnter={e => e.currentTarget.style.background = theme.overlay}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%",
                background: "transparent", border: "none", padding: "8px 14px",
                cursor: "pointer", fontSize: 13, color: theme.text, textAlign: "left",
              }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                              background: p.is_active ? theme.accent : theme.border }}/>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.profile_name}
              </span>
              {p.is_active && <span style={{ fontSize: 10, color: theme.accent, fontWeight: 700 }}>✓</span>}
            </button>
          ))}
          {profiles.length < 4 && (
            <button
              onClick={() => { setOpen(false); onTabChange?.("profile"); }}
              onMouseEnter={e => e.currentTarget.style.background = theme.overlay}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
              style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%",
                background: "transparent", border: "none", borderTop: `1px solid ${theme.border}`,
                padding: "8px 14px", cursor: "pointer", fontSize: 12,
                color: theme.textMuted, textAlign: "left", marginTop: 4,
              }}>
              <span>+</span> New Profile
            </button>
          )}
        </DropPanel>
      )}
    </div>
  );
}

// ── Quick Actions (app variant) ──────────────────────────────
function QuickActions({ theme, onTabChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false));

  const actions = [
    { icon: "🔍", label: "Search new role", action: () => { onTabChange?.("jobs"); setOpen(false); } },
    { icon: "✨", label: "Enhance resume", action: () => { onTabChange?.("jobs"); setOpen(false); } },
    { icon: "⚡", label: "ATS sort", action: () => { onTabChange?.("jobs"); setOpen(false); } },
    { icon: "📄", label: "Export PDF", action: () => { window.print(); setOpen(false); } },
  ];

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Quick actions"
        style={{
          background: "transparent", border: "none", cursor: "pointer",
          padding: "4px 8px", borderRadius: 8,
          color: theme.textMuted, fontSize: 16, transition: "color 0.15s",
        }}
        onMouseEnter={e => e.currentTarget.style.color = theme.accent}
        onMouseLeave={e => e.currentTarget.style.color = theme.textMuted}>
        ⚡
      </button>

      {open && (
        <DropPanel theme={theme} style={{ minWidth: 200, right: "auto", left: "50%",
                                          transform: "translateX(-50%)" }}>
          <div style={{ padding: "6px 14px 8px", fontSize: 10, fontWeight: 700,
                         textTransform: "uppercase", letterSpacing: "0.08em", color: theme.textDim }}>
            Quick Actions
          </div>
          {actions.map(a => (
            <button key={a.label} onClick={a.action}
              onMouseEnter={e => e.currentTarget.style.background = theme.overlay}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%",
                background: "transparent", border: "none", padding: "9px 14px",
                cursor: "pointer", fontSize: 13, color: theme.text, textAlign: "left",
              }}>
              <span>{a.icon}</span>
              <span>{a.label}</span>
            </button>
          ))}
        </DropPanel>
      )}
    </div>
  );
}

// ── Dock Settings popover ────────────────────────────────────
function DockSettingsPanel({ theme }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false));

  const DEFAULT_ORDER = ["profile_switcher", "notifications", "quick_actions", "settings", "user_avatar"];
  const LABELS = {
    profile_switcher: "Profile Switcher",
    notifications:    "Notifications",
    quick_actions:    "Quick Actions",
    settings:         "Settings",
    user_avatar:      "User Avatar",
  };
  const ICONS_MAP = {
    profile_switcher: "●",
    notifications:    "🔔",
    quick_actions:    "⚡",
    settings:         "⚙",
    user_avatar:      "👤",
  };
  const LOCKED = new Set(["settings", "user_avatar"]);

  const [prefs, setPrefs] = useState({ itemsOrder: DEFAULT_ORDER, dockEnabled: true });
  const saveTimer = useRef(null);

  useEffect(() => {
    api("/api/dock-preferences")
      .then(d => setPrefs(d))
      .catch(() => {});
  }, []);

  const save = useCallback((updated) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api("/api/dock-preferences", {
        method: "PUT",
        body: JSON.stringify(updated),
      }).catch(() => {});
    }, 800);
  }, []);

  const toggleItem = (key) => {
    if (LOCKED.has(key)) return;
    setPrefs(p => {
      const inOrder = p.itemsOrder.includes(key);
      const newOrder = inOrder
        ? p.itemsOrder.filter(k => k !== key)
        : [...p.itemsOrder.filter(k => k !== "user_avatar"), key, "user_avatar"];
      const updated = { ...p, itemsOrder: newOrder };
      save(updated);
      return updated;
    });
  };

  const moveItem = (key, direction) => {
    setPrefs(p => {
      const order = [...p.itemsOrder];
      const idx = order.indexOf(key);
      if (idx < 0) return p;
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= order.length) return p;
      // Don't allow moving past user_avatar (always last)
      if (order[newIdx] === "user_avatar") return p;
      [order[idx], order[newIdx]] = [order[newIdx], order[idx]];
      const updated = { ...p, itemsOrder: order };
      save(updated);
      return updated;
    });
  };

  const toggleDock = () => {
    setPrefs(p => {
      const updated = { ...p, dockEnabled: !p.dockEnabled };
      save(updated);
      return updated;
    });
  };

  const reset = () => {
    const updated = { itemsOrder: DEFAULT_ORDER, dockEnabled: true };
    setPrefs(updated);
    api("/api/dock-preferences", {
      method: "PUT", body: JSON.stringify(updated),
    }).catch(() => {});
  };

  // All items for display (including hidden ones)
  const allKeys = [...new Set([...DEFAULT_ORDER, ...prefs.itemsOrder])];

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Customise dock"
        style={{
          background: "transparent", border: "none", cursor: "pointer",
          padding: "4px 8px", borderRadius: 8,
          color: theme.textMuted, fontSize: 15, transition: "color 0.15s",
        }}
        onMouseEnter={e => e.currentTarget.style.color = theme.text}
        onMouseLeave={e => e.currentTarget.style.color = theme.textMuted}>
        ⚙
      </button>

      {open && (
        <div style={{
          position: "fixed", top: 68, right: 16, width: 280, zIndex: 9999,
          background: `${theme.surface}f5`,
          backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
          border: `1px solid ${theme.border}`,
          borderRadius: 12, boxShadow: theme.shadowLg, padding: 16,
        }}>
          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: theme.text }}>Customise Dock</span>
            <button onClick={() => setOpen(false)}
              style={{ background: "none", border: "none", cursor: "pointer",
                        color: theme.textDim, fontSize: 16, padding: "0 2px", lineHeight: 1 }}>✕</button>
          </div>

          {/* Items section */}
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                         letterSpacing: "0.08em", color: theme.textDim, marginBottom: 8 }}>
            Items
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 16 }}>
            {allKeys.map((key, idx) => {
              const isVisible = prefs.itemsOrder.includes(key);
              const isLocked = LOCKED.has(key);
              return (
                <div key={key} style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "6px 8px", borderRadius: 8,
                  background: theme.overlay,
                  opacity: isVisible ? 1 : 0.5,
                }}>
                  {/* Reorder buttons */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                    <button onClick={() => moveItem(key, -1)} disabled={isLocked || idx === 0}
                      style={{ background: "none", border: "none", cursor: "pointer",
                                fontSize: 8, color: theme.textDim, padding: "0 2px",
                                opacity: (isLocked || idx === 0) ? 0.3 : 1 }}>▲</button>
                    <button onClick={() => moveItem(key, 1)}
                      disabled={isLocked || key === "user_avatar" || idx === allKeys.length - 1}
                      style={{ background: "none", border: "none", cursor: "pointer",
                                fontSize: 8, color: theme.textDim, padding: "0 2px",
                                opacity: (isLocked || key === "user_avatar") ? 0.3 : 1 }}>▼</button>
                  </div>
                  {/* Icon */}
                  <span style={{ fontSize: 14, width: 20, textAlign: "center" }}>{ICONS_MAP[key]}</span>
                  {/* Label */}
                  <span style={{ flex: 1, fontSize: 12, color: theme.text }}>{LABELS[key]}</span>
                  {/* Toggle or lock */}
                  {isLocked ? (
                    <span title="Always shown" style={{ fontSize: 12, color: theme.textDim }}>🔒</span>
                  ) : (
                    <button onClick={() => toggleItem(key)}
                      style={{
                        width: 32, height: 18, borderRadius: 999, border: "none", cursor: "pointer",
                        background: isVisible ? theme.accent : theme.border,
                        transition: "background 0.2s", position: "relative", flexShrink: 0,
                      }}>
                      <div style={{
                        position: "absolute", top: 2,
                        left: isVisible ? 16 : 2,
                        width: 14, height: 14, borderRadius: "50%",
                        background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                        transition: "left 0.2s",
                      }}/>
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Visibility section */}
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                         letterSpacing: "0.08em", color: theme.textDim, marginBottom: 8 }}>
            Visibility
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10,
                         padding: "6px 8px", borderRadius: 8, background: theme.overlay }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, color: theme.text, fontWeight: 600 }}>
                {prefs.dockEnabled ? "Dock enabled" : "Dock hidden — hover top to show"}
              </div>
              <div style={{ fontSize: 10, color: theme.textDim, lineHeight: 1.4 }}>
                When off, dock hides until you hover near the top
              </div>
            </div>
            <button onClick={toggleDock}
              style={{
                width: 36, height: 20, borderRadius: 999, border: "none", cursor: "pointer",
                background: prefs.dockEnabled ? theme.accent : theme.border,
                transition: "background 0.2s", position: "relative", flexShrink: 0,
              }}>
              <div style={{
                position: "absolute", top: 2,
                left: prefs.dockEnabled ? 18 : 2,
                width: 16, height: 16, borderRadius: "50%",
                background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                transition: "left 0.2s",
              }}/>
            </button>
          </div>

          {/* Footer */}
          <button onClick={reset}
            style={{
              marginTop: 14, background: "none", border: "none", cursor: "pointer",
              fontSize: 11, color: theme.textDim, padding: 0,
              textDecoration: "underline", textDecorationStyle: "dotted",
            }}>
            Reset to defaults
          </button>
        </div>
      )}
    </div>
  );
}

// ── User Avatar (app variant) ─────────────────────────────────
function UserAvatarMenu({ theme, user, onLogout, onTabChange, onUserChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false));
  const { accentId, setAccentId, ACCENT_OPTIONS } = useTheme();

  const initial = (user?.username || "U")[0].toUpperCase();

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        title={user?.username}
        style={{
          width: 30, height: 30, borderRadius: "50%", border: "none", cursor: "pointer",
          background: theme.accent, color: "#0f0f0f",
          fontWeight: 800, fontSize: 12,
          display: "flex", alignItems: "center", justifyContent: "center",
          outline: open ? `2px solid ${theme.accent}` : "none",
          outlineOffset: 2, transition: "outline 0.15s",
          fontFamily: "'DM Sans',system-ui,sans-serif",
        }}>
        {initial}
      </button>

      {open && (
        <DropPanel theme={theme} style={{ right: 0, minWidth: 260 }}>
          {/* Header */}
          <div style={{ padding: "10px 16px 10px",
                         borderBottom: `1px solid ${theme.border}` }}>
            <button
              onClick={() => { setOpen(false); onTabChange?.("profile"); }}
              style={{
                background: "transparent", border: "none", padding: 0, cursor: "pointer",
                fontFamily: "'Barlow Condensed','DM Sans',sans-serif",
                fontWeight: 800, fontSize: 14, letterSpacing: "0.06em",
                textTransform: "uppercase", color: theme.text,
                display: "block", width: "100%", textAlign: "left",
              }}
              onMouseEnter={e => e.currentTarget.style.color = theme.accent}
              onMouseLeave={e => e.currentTarget.style.color = theme.text}>
              PROFILE
            </button>
            <div style={{ fontSize: 10, color: theme.textDim, marginTop: 2 }}>
              {user?.username} · {user?.isAdmin ? "Administrator" : "Member"}
            </div>
          </div>

          {/* Accent color */}
          <div style={{ padding: "10px 16px 10px", borderBottom: `1px solid ${theme.border}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                           letterSpacing: "0.08em", color: theme.textDim, marginBottom: 8 }}>
              Accent Color
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {ACCENT_OPTIONS.map(opt => (
                <button key={opt.id} title={opt.label} onClick={() => setAccentId(opt.id)}
                  style={{
                    width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
                    background: opt.color,
                    border: accentId === opt.id ? `2px solid ${theme.text}` : "2px solid transparent",
                    outline: accentId === opt.id ? `1.5px solid ${opt.color}` : "none",
                    outlineOffset: "1px", cursor: "pointer",
                    transform: accentId === opt.id ? "scale(1.25)" : "scale(1)",
                    transition: "transform 0.15s", padding: 0,
                  }}/>
              ))}
            </div>
          </div>

          {/* Sign out */}
          <button
            onClick={() => { setOpen(false); onLogout?.(); }}
            onMouseEnter={e => e.currentTarget.style.background = "#fef2f2"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            style={{
              display: "block", width: "100%", textAlign: "left",
              background: "transparent", border: "none", padding: "10px 16px",
              cursor: "pointer", fontSize: 13, color: "#dc2626", fontWeight: 600,
            }}>
            Sign Out
          </button>
        </DropPanel>
      )}
    </div>
  );
}

// ── Hamburger overlay (mobile) ────────────────────────────────
function HamburgerOverlay({ open, onClose, theme, links, ctaLinks }) {
  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!open) return null;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9998,
      background: theme.bg,
      display: "flex", flexDirection: "column",
      padding: "72px 24px 24px",
    }}>
      <button onClick={onClose} style={{
        position: "absolute", top: 16, right: 16,
        background: "none", border: "none", cursor: "pointer",
        fontSize: 22, color: theme.textMuted,
      }}>✕</button>

      <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {links.map(({ label, to }) => (
          <Link key={to} to={to} onClick={onClose}
            style={{
              fontSize: 22, fontWeight: 700, color: theme.text,
              textDecoration: "none", padding: "12px 0",
              borderBottom: `1px solid ${theme.border}`,
              fontFamily: "'Barlow Condensed','DM Sans',sans-serif",
              letterSpacing: "0.04em",
            }}>
            {label}
          </Link>
        ))}
      </nav>

      {ctaLinks && (
        <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 10 }}>
          {ctaLinks.map(({ label, to, primary }) => (
            <Link key={to} to={to} onClick={onClose}
              style={{
                display: "block", textAlign: "center",
                padding: "12px 24px", borderRadius: 8,
                fontSize: 15, fontWeight: 700, textDecoration: "none",
                background: primary ? theme.accent : "transparent",
                color: primary ? "#0f0f0f" : theme.text,
                border: primary ? "none" : `1px solid ${theme.border}`,
              }}>
              {label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Auto-hide hover detection ─────────────────────────────────
function useProximityReveal(dockEnabled) {
  const [nearTop, setNearTop] = useState(false);
  const hideTimer = useRef(null);

  useEffect(() => {
    if (dockEnabled !== false) return;
    const ZONE = 40;
    const onMove = (e) => {
      if (e.clientY < ZONE) {
        clearTimeout(hideTimer.current);
        setNearTop(true);
      } else if (nearTop) {
        clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setNearTop(false), 2000);
      }
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      clearTimeout(hideTimer.current);
    };
  }, [dockEnabled, nearTop]);

  return nearTop;
}

// ── Parse hex color to [r, g, b] for rgba() construction ────────
function hexToRgb(hex) {
  if (!hex || hex.length < 7) return [168, 216, 234]; // accent fallback
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// ── Animated logo: "R" always visible, "esume Master" collapses ──
function AnimatedLucyLogo({ theme, progress: p }) {
  // Clamp to avoid flash during mount
  const pc = Math.min(Math.max(p, 0), 1);
  const textMaxW = Math.round((1 - pc) * 130);
  const textOpacity = Math.max(0, 1 - pc * 1.8);
  return (
    <div style={{
      position: "relative", display: "inline-flex", alignItems: "center",
      justifyContent: "center", flexShrink: 0, height: 36,
      // width shrinks as text collapses; min 50px for "R"
      minWidth: 50,
    }}>
      <div style={{ position: "absolute", inset: 0, background: theme.accent,
                    transform: "rotate(-3deg)", borderRadius: 2 }}/>
      <div style={{
        position: "relative", zIndex: 1, padding: "3px 10px",
        background: "#ffffff", border: "2.5px solid #0f0f0f",
        transform: "rotate(-2deg)", borderRadius: 2,
        display: "flex", alignItems: "center", overflow: "hidden",
      }}>
        <span style={{
          fontFamily: "'Barlow Condensed','DM Sans',system-ui,sans-serif",
          fontWeight: 800, fontSize: 15, letterSpacing: "0.06em",
          textTransform: "uppercase", color: "#0f0f0f", fontStyle: "italic",
          lineHeight: 1, whiteSpace: "nowrap",
        }}>R</span>
        <span style={{
          fontFamily: "'Barlow Condensed','DM Sans',system-ui,sans-serif",
          fontWeight: 800, fontSize: 15, letterSpacing: "0.06em",
          textTransform: "uppercase", color: "#0f0f0f", fontStyle: "italic",
          lineHeight: 1, whiteSpace: "nowrap",
          display: "inline-block",
          maxWidth: textMaxW + "px",
          overflow: "hidden",
          opacity: textOpacity,
          transition: "max-width 0.075s linear, opacity 0.075s linear",
          verticalAlign: "bottom",
        }}>esume Master</span>
      </div>
    </div>
  );
}

// ── App dock bar: convergence animation driven by AppScrollContext ──
function AppDockBar({ user, onLogout, onTabChange, activeTab, onUserChange, onProfileActivate }) {
  const { theme } = useTheme();
  const { progress: rawProgress, pinned } = useAppScroll();
  // Pinned (pagination) holds the dock at fully collapsed; scroll-to-top clears it
  const p = pinned ? 1 : rawProgress;
  const [vw, setVw] = useState(typeof window !== "undefined" ? window.innerWidth : 1280);

  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Dock preferences
  const [dockEnabled, setDockEnabled] = useState(true);
  useEffect(() => {
    if (!user) return;
    api("/api/dock-preferences")
      .then(d => setDockEnabled(d.dockEnabled !== false))
      .catch(() => {});
  }, [user]);

  const PILL_W = 320;
  const [ar, ag, ab] = hexToRgb(theme.accent);

  // Interpolated values
  const pillWidth  = Math.round(vw - p * (vw - PILL_W));
  const pillHeight = Math.round(56 - p * 12);
  const radius     = Math.round(p * 9999);
  const blur       = Math.round(12 + p * 8);
  const topOffset  = Math.round(p * 12);

  // Background: base surface fades out while glassy accent gradient fades in
  const surfaceAlphaHex = Math.round((0.95 - p * 0.45) * 255).toString(16).padStart(2, "0");
  const bgBase     = `${theme.surface}${surfaceAlphaHex}`;
  const a1 = (p * 0.18).toFixed(3);
  const a2 = (p * 0.08).toFixed(3);
  const a3 = (p * 0.12).toFixed(3);
  const pillBg = `linear-gradient(135deg, rgba(${ar},${ag},${ab},${a1}) 0%, rgba(${ar},${ag},${ab},${a2}) 40%, rgba(255,255,255,${a3}) 100%), ${bgBase}`;

  // Border: theme.border at expanded → accent-tinted at pill
  const borderColor = p < 0.02
    ? `${theme.border}1a`
    : `rgba(${ar},${ag},${ab},${(p * 0.25).toFixed(3)})`;

  // Box-shadow: elevation + inset top-edge highlight (glassy light catch)
  const pillShadow = p > 0.05
    ? `0 ${Math.round(p * 4)}px ${Math.round(p * 24)}px rgba(0,0,0,${(p * 0.10).toFixed(2)}), 0 1px 6px rgba(0,0,0,${(p * 0.06).toFixed(2)}), inset 0 1px 0 rgba(255,255,255,${(p * 0.35).toFixed(2)})`
    : "none";

  // Outer wrapper: holds space in flex column (height always 56px)
  // Inner pill: absolutely positioned, animates width/radius/bg
  return (
    <div style={{ position: "relative", height: 56, flexShrink: 0, zIndex: 200 }}>
      <div style={{
        position: "absolute",
        top: topOffset,
        left: "50%",
        transform: "translateX(-50%)",
        width: pillWidth,
        height: pillHeight,
        borderRadius: radius,
        background: pillBg,
        backdropFilter: `blur(${blur}px)`,
        WebkitBackdropFilter: `blur(${blur}px)`,
        border: `1px solid ${borderColor}`,
        boxShadow: pillShadow,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: `0 ${Math.round(32 - p * 22)}px`,
        overflow: "hidden",
        fontFamily: "'DM Sans',system-ui,sans-serif",
      }}>
        {/* Logo */}
        <Link to="/app" style={{ textDecoration: "none", flexShrink: 0 }}>
          <AnimatedLucyLogo theme={theme} progress={p}/>
        </Link>

        {/* App dock items */}
        {user && (
          <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <ProfileSwitcher theme={theme} onProfileActivate={onProfileActivate} onTabChange={onTabChange}/>
            <DockDivider theme={theme}/>
            <NotificationsBell theme={theme}/>
            <DockDivider theme={theme}/>
            <QuickActions theme={theme} onTabChange={onTabChange}/>
            <DockDivider theme={theme}/>
            {dockEnabled && <DockSettingsPanel theme={theme}/>}
            {dockEnabled && <DockDivider theme={theme}/>}
            <UserAvatarMenu theme={theme} user={user} onLogout={onLogout}
              onTabChange={onTabChange} onUserChange={onUserChange}/>
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// Marketing / Tools dock (scroll-collapse pill)
// ══════════════════════════════════════════════════════════════
function MarketingToolsDock({ variant }) {
  const { theme } = useTheme();
  const { mode: vpMode } = useViewport();
  const isMobile = vpMode === "mobile" || vpMode === "tablet";

  const scrolled = useScrollCollapsed(60, false);
  const collapsed = scrolled;

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Variant content definitions
  const MARKETING_LINKS = [
    { label: "Features",     to: "/features" },
    { label: "How It Works", to: "/how-it-works" },
    { label: "Pricing",      to: "/pricing" },
    { label: "About",        to: "/about" },
  ];
  const MARKETING_CTAS = [
    { label: "Sign In",     to: "/login",    primary: false },
    { label: "Get Started", to: "/register", primary: true },
  ];
  const TOOLS_LINKS = [
    { label: "ATS Scorer",         to: "/tools/ats" },
    { label: "Resume Generator",   to: "/tools/generate" },
    { label: "Auto Apply",         to: "/tools/apply" },
  ];
  const TOOLS_CTAS = [
    { label: "← Full Platform", to: "/login",    primary: false },
    { label: "Sign Up Free",    to: "/register", primary: true },
  ];

  const navLinks  = variant === "marketing" ? MARKETING_LINKS : variant === "tools" ? TOOLS_LINKS : [];
  const ctaLinks  = variant === "marketing" ? MARKETING_CTAS  : variant === "tools" ? TOOLS_CTAS  : [];

  // ── Styles ────────────────────────────────────────────────
  const baseStyle = {
    display: "flex", alignItems: "center",
    fontFamily: "'DM Sans',system-ui,sans-serif",
    zIndex: 200,
    transition: "all 0.32s cubic-bezier(0.4, 0, 0.2, 1)",
  };

  const expandedStyle = {
    ...baseStyle,
    position: "fixed",
    top: 0, left: 0, right: 0,
    height: 56,
    padding: "0 32px",
    justifyContent: "space-between",
    background: `${theme.surface}f2`,
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    borderBottom: `1px solid ${theme.accent}1a`,
    borderRadius: 0,
    boxShadow: "none",
  };

  const collapsedStyle = {
    ...baseStyle,
    position: "fixed",
    top: 12,
    left: "50%",
    right: "auto",
    transform: "translateX(-50%)",
    height: 44,
    padding: "0 10px",
    justifyContent: "center",
    gap: 2,
    background: `${theme.surface}80`,
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    border: `1px solid ${theme.border}`,
    borderRadius: 9999,
    boxShadow: "0 4px 24px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.08)",
    maxWidth: "min(720px, calc(100vw - 24px))",
    width: "auto",
  };

  const finalStyle = collapsed ? collapsedStyle : expandedStyle;

  return (
    <>
      <nav style={finalStyle}>
        {/* ── LEFT: Logo ──────────────────────────────── */}
        <Link to="/" style={{ textDecoration: "none", flexShrink: 0 }}>
          <LucyLogo theme={theme} mini={collapsed || (isMobile && !collapsed)} />
        </Link>

        {/* ── CENTER: Nav links (desktop) ─────────────── */}
        {!isMobile && navLinks.length > 0 && (
          <div style={{
            display: "flex", alignItems: "center", gap: 0,
            ...(collapsed ? {} : { position: "absolute", left: "50%", transform: "translateX(-50%)" }),
          }}>
            {collapsed && <DockDivider theme={theme}/>}
            {navLinks.map(({ label, to }) => (
              <NavLinkItem key={to} to={to} label={label}
                collapsed={collapsed} theme={theme}/>
            ))}
          </div>
        )}

        {/* ── RIGHT: CTA buttons (desktop) ─ */}
        {!isMobile && ctaLinks.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {collapsed && <DockDivider theme={theme}/>}
            {ctaLinks.map(({ label, to, primary }) => (
              <Link key={to} to={to} style={{
                fontSize: 13, fontWeight: 700, textDecoration: "none",
                padding: collapsed ? "5px 14px" : "7px 18px",
                borderRadius: 999,
                background: primary ? theme.accent : "transparent",
                color: primary ? "#0f0f0f" : theme.accentText,
                border: primary ? "none" : `1px solid ${theme.accent}55`,
                transition: "all 0.15s",
                whiteSpace: "nowrap",
              }}>
                {label}
              </Link>
            ))}
          </div>
        )}

        {/* ── Mobile: hamburger ─────────────────────────── */}
        {isMobile && (
          <button onClick={() => setMobileMenuOpen(true)}
            style={{
              background: "none", border: "none", cursor: "pointer",
              fontSize: 22, color: theme.textMuted, padding: "4px 8px", marginLeft: "auto",
            }}>
            ☰
          </button>
        )}
      </nav>

      <HamburgerOverlay
        open={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
        theme={theme}
        links={navLinks}
        ctaLinks={ctaLinks}
      />
    </>
  );
}

// ══════════════════════════════════════════════════════════════
// Main ScrollDock — routes to correct component by variant
// ══════════════════════════════════════════════════════════════
export default function ScrollDock({
  variant = "marketing",
  user,
  onLogout,
  onTabChange,
  activeTab,
  onUserChange,
  onProfileActivate,
}) {
  if (variant === "app") {
    return (
      <AppDockBar
        user={user}
        onLogout={onLogout}
        onTabChange={onTabChange}
        activeTab={activeTab}
        onUserChange={onUserChange}
        onProfileActivate={onProfileActivate}
      />
    );
  }
  return <MarketingToolsDock variant={variant}/>;
}

// Helper: nav link with hover state
function NavLinkItem({ to, label, collapsed, theme }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Link to={to}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        fontSize: collapsed ? 12 : 13, fontWeight: 600,
        color: hovered ? theme.accent : theme.textMuted,
        textDecoration: "none",
        padding: collapsed ? "0 10px" : "6px 12px",
        borderRadius: 8, transition: "color 0.15s",
        lineHeight: collapsed ? "44px" : "auto",
        whiteSpace: "nowrap",
      }}>
      {label}
    </Link>
  );
}
