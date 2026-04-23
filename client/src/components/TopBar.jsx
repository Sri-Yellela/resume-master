// client/src/components/TopBar.jsx — single animated nav (Lucy Brand)
// position:fixed, converges from full-width bar → centered glassy pill on scroll.
// Consumes AppScrollContext progress/pinned set by PullToRefresh in JobsPanel.
import { useState, useEffect, useRef, useCallback } from "react";
import { useTheme } from "../styles/theme.jsx";
import { useAppScroll } from "../contexts/AppScrollContext.jsx";
import { useJobBoard } from "../contexts/JobBoardContext.jsx";
import { useSyncEvents } from "../hooks/useSyncEvents.js";
import { api } from "../lib/api.js";
import { DockPortal } from "./DockPortal.jsx";
import ProfileSelectorDropdown from "./ProfileSelectorDropdown.jsx";

// ── Inject slideDown keyframe once ────────────────────────────
function injectKeyframes() {
  if (document.getElementById("topbar-kf")) return;
  const s = document.createElement("style");
  s.id = "topbar-kf";
  s.textContent = `
    @keyframes slideDown {
      from { opacity: 0; transform: translateX(-50%) translateY(-8px); }
      to   { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
  `;
  document.head.appendChild(s);
}

// ── Parse hex → [r,g,b] ──────────────────────────────────────
function hexToRgb(hex) {
  if (!hex || hex.length < 7) return [168, 216, 234];
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// ── Animated logo — "R" persists, "esume Master" collapses ───
function AnimatedLucyLogo({ theme, progress: p }) {
  const pc = Math.min(Math.max(p, 0), 1);
  const textMaxW = Math.round((1 - pc) * 130);
  const textOpacity = Math.max(0, 1 - pc * 1.8);
  return (
    <div style={{
      position: "relative", display: "inline-flex", alignItems: "center",
      justifyContent: "center", flexShrink: 0, height: 36, minWidth: 50,
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

// ── Dock divider ─────────────────────────────────────────────
function Divider({ theme }) {
  return (
    <div style={{ width: 1, height: 18, background: `${theme.accent}33`,
                  flexShrink: 0, margin: "0 4px" }}/>
  );
}

// ── Notification bell ─────────────────────────────────────────
function NotificationsBell({ theme }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const [notifs, setNotifs] = useState([]);
  const [unread, setUnread] = useState(0);
  const triggerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await api("/api/notifications");
      setNotifs(d.notifications || []);
      setUnread(d.unreadCount || 0);
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

  useSyncEvents({
    notification:     () => setUnread(n => n + 1),
    scrape_complete:  () => setUnread(n => n + 1),
    resume_generated: () => setUnread(n => n + 1),
  });

  const markAll = async () => {
    try { await api("/api/notifications/read-all", { method: "PATCH" }); } catch {}
    setNotifs(n => n.map(x => ({ ...x, read: 1 })));
    setUnread(0);
  };

  const timeAgo = (ts) => {
    const s = Math.floor(Date.now() / 1000 - ts);
    if (s < 60)    return "just now";
    if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  const TYPE_ICONS = {
    scrape_complete: "🔍", resume_generated: "✦", ats_scored: "🎯",
    enhance_ready: "✨", best_match: "⚡", apply_complete: "✅",
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        onClick={() => {
          if (triggerRef.current) setRect(triggerRef.current.getBoundingClientRect());
          setOpen(o => { if (!o) load(); return !o; });
        }}
        title="Notifications"
        style={{
          background: "transparent", border: "none", cursor: "pointer",
          width: 32, height: 32, borderRadius: 6, position: "relative", flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          color: theme.textMuted, fontSize: 15,
          transition: "color 0.15s, background 0.15s",
        }}
        onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.1)"; e.currentTarget.style.color = theme.accent; }}
        onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = theme.textMuted; }}>
        🔔
        {unread > 0 && (
          <span style={{
            position: "absolute", top: 0, right: 2,
            background: theme.accent, color: "#0f0f0f",
            borderRadius: "50%", width: 16, height: 16,
            fontSize: 9, fontWeight: 800, lineHeight: "16px", textAlign: "center",
          }}>
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && rect && (
        <DockPortal anchorRect={rect} theme={theme} onClose={() => setOpen(false)}
          style={{ minWidth: 300 }}>
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
            <div style={{ padding: "20px 14px", textAlign: "center", fontSize: 12, color: theme.textDim }}>
              No notifications yet
            </div>
          ) : notifs.slice(0, 20).map(n => (
            <div key={n.id} style={{
              padding: "8px 14px", display: "flex", alignItems: "flex-start", gap: 10,
              background: !n.read ? `${theme.accent}0d` : "transparent",
            }}>
              <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>
                {TYPE_ICONS[n.type] || "ℹ"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: theme.text, lineHeight: 1.4 }}>{n.message}</div>
                <div style={{ fontSize: 10, color: theme.textDim, marginTop: 2 }}>{timeAgo(n.created_at)}</div>
              </div>
              {!n.read && (
                <div style={{ width: 6, height: 6, borderRadius: "50%",
                               background: theme.accent, flexShrink: 0, marginTop: 4 }}/>
              )}
            </div>
          ))}
        </DockPortal>
      )}
    </div>
  );
}

// ── Quick actions ─────────────────────────────────────────────
function QuickActions({ theme, onTabChange }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const triggerRef = useRef(null);

  const actions = [
    { icon: "🔍", label: "Search new role", action: () => { onTabChange?.("jobs"); setOpen(false); } },
    { icon: "⚡", label: "ATS sort",       action: () => { onTabChange?.("jobs"); setOpen(false); } },
    { icon: "📄", label: "Export PDF",       action: () => { window.print(); setOpen(false); } },
  ];

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        onClick={() => {
          if (triggerRef.current) setRect(triggerRef.current.getBoundingClientRect());
          setOpen(o => !o);
        }}
        title="Quick actions"
        style={{
          background: "transparent", border: "none", cursor: "pointer",
          width: 32, height: 32, borderRadius: 6, flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          color: theme.textMuted, fontSize: 15,
          transition: "color 0.15s, background 0.15s",
        }}
        onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.1)"; e.currentTarget.style.color = theme.accent; }}
        onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = theme.textMuted; }}>
        ⚡
      </button>

      {open && rect && (
        <DockPortal anchorRect={rect} theme={theme} onClose={() => setOpen(false)}
          style={{ minWidth: 200 }}>
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
        </DockPortal>
      )}
    </div>
  );
}

function UserAvatarMenu({ theme, user, onLogout, onTabChange, onUserChange, profiles, onActivateProfile, onDeleteProfile }) {
  const [open,        setOpen]        = useState(false);
  const [rect,        setRect]        = useState(null);
  const triggerRef = useRef(null);
  const { accentId, setAccentId, ACCENT_OPTIONS, bgMode, setBgMode, BG_MODES } = useTheme();
  const planTier = user?.planTier || "BASIC";
  const planLabel = planTier === "PRO" ? "Pro" : planTier === "PLUS" ? "Plus" : "Basic";
  const toolLabel = planTier === "PRO" ? "Generate + A+ Resume"
    : planTier === "PLUS" ? "Generate"
    : "Baseline jobs console";

  const menuItemStyle = {
    padding: "10px 16px", cursor: "pointer", fontSize: 13,
    color: theme.text, background: "transparent", border: "none",
    display: "block", width: "100%", textAlign: "left",
  };
  const activeProfile = profiles?.find(p => p.is_active) || profiles?.[0] || null;

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        onClick={() => {
          if (triggerRef.current) setRect(triggerRef.current.getBoundingClientRect());
          setOpen(o => !o);
        }}
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
        {(user?.username || "U")[0].toUpperCase()}
      </button>

      {open && rect && (
        <DockPortal anchorRect={rect} theme={theme} onClose={() => setOpen(false)}
          style={{ minWidth: 320, maxWidth: "calc(100vw - 24px)" }}>
          {/* PROFILE nav */}
          <div style={{ padding: "10px 16px 8px", borderBottom: `1px solid ${theme.border}` }}>
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
              {user?.username} - {user?.isAdmin ? "Administrator" : "Member"}
            </div>
          </div>

          <div style={{ padding: "10px 16px 10px", borderBottom: `1px solid ${theme.border}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                           letterSpacing: "0.08em", color: theme.textDim, marginBottom: 8 }}>
              Job Profile
            </div>
            <button onClick={() => { setOpen(false); onTabChange?.("job-profiles"); }}
              style={{ ...menuItemStyle, padding:"0 0 8px", color:theme.accentText, fontWeight:700 }}>
              Manage Job Profiles
            </button>
            {profiles?.length > 0 ? (
              <ProfileSelectorDropdown
                theme={theme}
                profiles={profiles}
                activeProfile={activeProfile}
                onActivate={onActivateProfile}
                onDelete={onDeleteProfile}
                onAdd={() => { setOpen(false); onTabChange?.("job-profiles"); }}
              />
            ) : (
              <button onClick={() => { setOpen(false); onTabChange?.("job-profiles"); }}
                style={{ width:"100%", border:`1px solid ${theme.border}`, borderRadius:6,
                         background:theme.surfaceHigh, color:theme.text, padding:"8px 10px",
                         cursor:"pointer", textAlign:"left", fontSize:12, fontWeight:700 }}>
                Add your first job profile
              </button>
            )}
          </div>

          {/* Accent color */}
          <div style={{ padding: "10px 16px 8px", borderBottom: `1px solid ${theme.border}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                           letterSpacing: "0.08em", color: theme.textDim, marginBottom: 8 }}>
              Accent Color
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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

          {/* Background style */}
          <div style={{ padding: "10px 16px 10px", borderBottom: `1px solid ${theme.border}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                           letterSpacing: "0.08em", color: theme.textDim, marginBottom: 8 }}>
              Background
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {BG_MODES.map(m => (
                <button key={m.id} title={m.label} onClick={() => setBgMode(m.id)}
                  style={{
                    width: 60, height: 38, borderRadius: 8, flexShrink: 0,
                    background: m.previewBg,
                    border: bgMode === m.id ? `2px solid ${theme.accent}` : `1px solid ${theme.border}`,
                    outline: bgMode === m.id ? `2px solid ${theme.accent}44` : "none",
                    outlineOffset: 1,
                    cursor: "pointer", padding: 0,
                    position: "relative", overflow: "hidden",
                    transition: "border 0.15s, outline 0.15s",
                  }}>
                  {bgMode === m.id && (
                    <span style={{
                      position: "absolute", inset: 0,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      background: "rgba(0,0,0,0.25)", color: "#fff",
                      fontSize: 14, fontWeight: 700,
                    }}>On</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Plan */}
          <div style={{ padding: "8px 16px", borderBottom: `1px solid ${theme.border}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                           letterSpacing: "0.08em", color: theme.textDim, marginBottom: 6 }}>
              Plan
            </div>
            <div style={{ fontSize: 13, color: theme.text, fontWeight: 700 }}>{planLabel}</div>
            <div style={{ fontSize: 11, color: theme.textDim, marginTop: 2 }}>{toolLabel}</div>
            <button onClick={() => { setOpen(false); onTabChange?.("plans"); }}
              style={{ ...menuItemStyle, marginTop:4, color:theme.accentText, fontWeight:700 }}>
              View Plans
            </button>
            <button onClick={() => { setOpen(false); onTabChange?.("integrations"); }}
              style={{ ...menuItemStyle, marginTop:2, color:theme.accentText, fontWeight:700 }}>
              Integrations
            </button>
          </div>

          {/* Sign out */}
          <button
            onClick={() => { setOpen(false); onLogout?.(); }}
            onMouseEnter={e => e.currentTarget.style.background = "#fef2f2"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            style={{ ...menuItemStyle, color: "#dc2626", fontWeight: 600 }}>
            Sign Out
          </button>
        </DockPortal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Main TopBar — position:fixed, convergence animation
// ═══════════════════════════════════════════════════════════════
export default function TopBar({
  user, onTabChange, onLogout, onUserChange, onProfileActivate,
}) {
  const { theme } = useTheme();
  const { progress: rawProgress, pinned } = useAppScroll();
  // pinned (pagination click) holds dock fully collapsed
  const p = pinned ? 1 : rawProgress;
  const scrolled = p >= 0.5;

  const [hovered,       setHovered]       = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const hoverTimerRef = useRef(null);

  // Clear hover + search state when un-scrolled
  useEffect(() => { if (!scrolled) { setHovered(false); setSearchFocused(false); } }, [scrolled]);

  // Inject slideDown keyframe
  useEffect(() => { injectKeyframes(); }, []);

  // Hover handlers with 100ms grace period so gap between pills doesn't dismiss row 2
  const handleMouseEnter = useCallback(() => {
    clearTimeout(hoverTimerRef.current);
    if (scrolled) setHovered(true);
  }, [scrolled]);

  const handleMouseLeave = useCallback(() => {
    if (scrolled) hoverTimerRef.current = setTimeout(() => setHovered(false), 100);
  }, [scrolled]);

  const {
    boardTab, setBoardTab, localSearch, setLocalSearch, sortBy, setSortBy,
    setActiveProfileId, deleteProfileCache,
  } = useJobBoard() || {};

  const [vw, setVw] = useState(typeof window !== "undefined" ? window.innerWidth : 1280);
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Domain profiles for docked pill switcher
  const [profiles, setProfiles] = useState([]);
  const loadProfiles = useCallback(() => {
    if (!user) return;
    api("/api/domain-profiles")
      .then(d => {
        const rows = Array.isArray(d) ? d : [];
        setProfiles(rows);
        const active = rows.find(p => p.is_active) || rows[0];
        if (active) setActiveProfileId?.(active.id);
      })
      .catch(() => {});
  }, [user, setActiveProfileId]);

  useEffect(() => { loadProfiles(); }, [loadProfiles]);

  useSyncEvents({
    profile_switched: ({ profileId }) => {
      if (profileId) setActiveProfileId?.(Number(profileId));
      loadProfiles();
    },
  });

  const activateProfile = async (id) => {
    const prev = profiles;
    setProfiles(ps => ps.map(pr => ({ ...pr, is_active: pr.id === id ? 1 : 0 })));
    setActiveProfileId?.(id);
    onProfileActivate?.(id);
    try {
      await api(`/api/domain-profiles/${id}/activate`, { method: "POST" });
    } catch {
      setProfiles(prev);
      const active = prev.find(p => p.is_active) || prev[0];
      if (active) setActiveProfileId?.(active.id);
    }
  };

  const deleteProfile = async (id) => {
    const profile = profiles.find(p => p.id === id);
    if (!profile) return;
    if (profiles.length <= 1) return;
    if (!confirm(`Delete job profile "${profile.profile_name}"?`)) return;
    try {
      await api(`/api/domain-profiles/${id}`, { method: "DELETE" });
      deleteProfileCache?.(id);
      const next = await api("/api/domain-profiles");
      const rows = Array.isArray(next) ? next : [];
      setProfiles(rows);
      const active = rows.find(p => p.is_active) || rows[0];
      if (active) setActiveProfileId?.(active.id);
      onProfileActivate?.(active?.id);
    } catch(e) {
      alert(e.message || "Could not delete profile");
    }
  };

  // ── Geometry interpolation ──
  const [ar, ag, ab] = hexToRgb(theme.accent);

  const pillWidth  = Math.round(vw - p * (vw - 400));
  const radius     = Math.round(p * 9999);
  const blur       = Math.round(12 + p * 8);
  const topOffset  = Math.round(p * 10);
  const padH       = 20;

  // Background: solid surface → glassy accent gradient
  const surfaceAlphaHex = Math.round((0.95 - p * 0.45) * 255).toString(16).padStart(2, "0");
  const bgBase = `${theme.surfaceBase}${surfaceAlphaHex}`;
  const a1 = (p * 0.18).toFixed(3);
  const a2 = (p * 0.08).toFixed(3);
  const a3 = (p * 0.12).toFixed(3);
  const pillBg = `linear-gradient(135deg, rgba(${ar},${ag},${ab},${a1}) 0%, rgba(${ar},${ag},${ab},${a2}) 40%, rgba(255,255,255,${a3}) 100%), ${bgBase}`;

  // Border: barely visible at full width → accent pill border when collapsed
  const borderColor = p < 0.02
    ? `${theme.border}33`
    : `rgba(${ar},${ag},${ab},${(p * 0.25).toFixed(3)})`;

  // Shadow: elevation + glassy inset highlight
  const shadow = p > 0.05
    ? `0 ${Math.round(p * 4)}px ${Math.round(p * 24)}px rgba(0,0,0,${(p * 0.10).toFixed(2)}), inset 0 1px 0 rgba(255,255,255,${(p * 0.35).toFixed(2)})`
    : "none";

  // Pill 2 styling (fully-collapsed glassy pill, same accent)
  const pill2Bg = `linear-gradient(135deg, rgba(${ar},${ag},${ab},0.18) 0%, rgba(${ar},${ag},${ab},0.08) 40%, rgba(255,255,255,0.12) 100%), ${theme.surfaceBase}88`;

  return (
    <>
      {/* ── Pill 1: main nav bar — always visible ── */}
      <div
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={{
          position: "fixed",
          top: topOffset,
          left: "50%",
          transform: "translateX(-50%)",
          width: pillWidth,
          height: 46,
          borderRadius: radius,
          background: pillBg,
          backdropFilter: `blur(${blur}px)`,
          WebkitBackdropFilter: `blur(${blur}px)`,
          border: `1px solid ${borderColor}`,
          boxShadow: shadow,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: `0 ${padH}px`,
          overflow: "visible",
          zIndex: 1000,
          fontFamily: "'DM Sans',system-ui,sans-serif",
        }}>
        {/* Logo — "R" always visible, "esume Master" collapses */}
        <AnimatedLucyLogo theme={theme} progress={p}/>

        {/* Right: utility icons */}
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          {scrolled && <Divider theme={theme}/>}
          {user && <NotificationsBell theme={theme}/>}
          {user && <QuickActions theme={theme} onTabChange={onTabChange}/>}
          {scrolled && <Divider theme={theme}/>}
          {user && (
            <UserAvatarMenu
              theme={theme} user={user} onLogout={onLogout}
              onTabChange={onTabChange} onUserChange={onUserChange}
              profiles={profiles}
              onActivateProfile={activateProfile}
              onDeleteProfile={deleteProfile}
            />
          )}
        </div>
      </div>

      {/* ── Pill 2: filter row — slides down when scrolled + hovered ── */}
      {scrolled && hovered && boardTab !== undefined && (
        <div
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          style={{
            position: "fixed",
            top: topOffset + 46 + 8,
            left: "50%",
            transform: "translateX(-50%)",
            height: 36,
            borderRadius: 9999,
            background: pill2Bg,
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            border: `1px solid rgba(${ar},${ag},${ab},0.25)`,
            boxShadow: `0 4px 24px rgba(0,0,0,0.10), inset 0 1px 0 rgba(255,255,255,0.35)`,
            display: "inline-flex",
            alignItems: "center",
            padding: "0 14px",
            gap: 6,
            zIndex: 1000,
            fontFamily: "'DM Sans',system-ui,sans-serif",
            animation: "slideDown 200ms ease",
            whiteSpace: "nowrap",
          }}>
          {/* Board tab pills */}
          {[["all","All"],["saved","★"],["pending","⏳"]].map(([id, lbl]) => (
            <button key={id} onClick={() => setBoardTab?.(id)}
              style={{
                padding: "0 10px", height: 26, border: "none", cursor: "pointer",
                fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 800,
                fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase",
                borderRadius: 9999, flexShrink: 0,
                background: boardTab === id ? theme.accent : `${theme.accent}18`,
                color: boardTab === id ? "#0f0f0f" : theme.textMuted,
                transition: "background 0.15s, color 0.15s",
              }}>
              {lbl}
            </button>
          ))}
          <Divider theme={theme}/>
          {/* Sort */}
          <select value={sortBy || "dateDesc"} onChange={e => setSortBy?.(e.target.value)}
            style={{ height: 26, padding: "4px 8px", borderRadius: 4, flexShrink: 0,
                     minWidth: 80, border: `1px solid ${theme.border}`, background: theme.surface,
                     fontSize: 12, color: theme.text, outline: "none", cursor: "pointer" }}>
            <option value="dateDesc">Newest</option>
            <option value="dateAsc">Oldest</option>
            <option value="compHigh">Pay ↓</option>
            <option value="compLow">Pay ↑</option>
            <option value="yoeLow">Exp ↑</option>
            <option value="yoeHigh">Exp ↓</option>
            <option value="atsScore">ATS Sort</option>
          </select>
          {profiles.length > 0 && (
            <ProfileSelectorDropdown
              theme={theme}
              profiles={profiles}
              activeProfile={profiles.find(p => p.is_active) || profiles[0]}
              onActivate={activateProfile}
              onDelete={deleteProfile}
              onAdd={() => onTabChange?.("job-profiles")}
              compact
              title="Switch profile"
            />
          )}
          {/* Local search — expands on focus */}
          <input
            value={localSearch || ""}
            onChange={e => setLocalSearch?.(e.target.value)}
            onKeyDown={e => e.key === "Escape" && setLocalSearch?.("")}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder="Filter jobs…"
            style={{
              height: 26, padding: "4px 10px", borderRadius: 4,
              border: `1px solid ${theme.border}`, background: theme.surface,
              color: theme.text, fontSize: 12, outline: "none",
              width: searchFocused ? 150 : 96,
              transition: "width 0.2s ease",
            }}/>
          {localSearch && (
            <button onClick={() => setLocalSearch?.("")}
              style={{ background: "none", border: "none", color: theme.textDim,
                       cursor: "pointer", fontSize: 13, padding: "0 2px", flexShrink: 0 }}>
              ✕
            </button>
          )}
        </div>
      )}
    </>
  );
}
