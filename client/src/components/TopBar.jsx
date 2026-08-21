// SCRAPING � SCHEDULED FOR REMOVAL AFTER MIGRATION
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
import { Z } from "../styles/zLayers.js";
import { SORTS } from "../../../shared/jobFilterOptions.js";

// ── Inject slideDown keyframe once ────────────────────────────
function injectKeyframes() {
  if (document.getElementById("topbar-kf")) return;
  const s = document.createElement("style");
  s.id = "topbar-kf";
  s.textContent = `
    /* TRANSFORM ONLY — deliberately not opacity.
       The collapsed pill is the incoming half of a swap whose outgoing half (the main search bar)
       disappears synchronously. Fading in from opacity 0 therefore opened a window in which the bar
       was already gone and the pill was not yet visible: captured at the crossing as
       \`bar: null, pill: { opacity: 0 }\`, which is the reported gap between the two surfaces. The
       pill is now at full opacity on its first frame and only slides into place, so there is no
       point at which neither surface is on screen. */
    @keyframes slideDown {
      from { transform: translateX(-50%) translateY(-8px); }
      to   { transform: translateX(-50%) translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      @keyframes slideDown {
        from { transform: translateX(-50%) translateY(0); }
        to   { transform: translateX(-50%) translateY(0); }
      }
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
//
// THE MARK IS WHITE. W6 made it translucent — `rgba(255,255,255,0.06)` behind a
// `--border-glass` hairline with muted text — on the reasoning that a solid stamp was "the one
// element on the surface that did not belong to it". That was a regression, not an improvement:
// the top bar is fully transparent at rest (see pillBg below), so a 6%-white fill on a dark
// starfield left the mark with almost no edge of its own. It is white again, and matched to
// components/StampLogo.jsx VERBATIM — same #ffffff fill, same 2.5px #0f0f0f border, same
// borderRadius 2, same #0f0f0f italic text — because that is the marketing rendering of the same
// mark and the two must not be two different logos.
//
// Two things W6 added are gone with the translucency, and neither is a feature being dropped:
// `backdropFilter: blur(8px)`, which has nothing to blur behind an opaque fill; and
// `transition: "background 0.15s, border-color 0.15s"`, which was for a hover lift that was never
// wired — there is no mouse handler on this element, so the transition could not fire.
//
// NOTHING ELSE ABOUT THIS MARK CHANGES. The rotation, the size, the placement, the collapse
// animation and its timings are the mark's character and are deliberately untouched.
function AnimatedLucyLogo({ progress: p }) {
  const pc = Math.min(Math.max(p, 0), 1);
  const textMaxW = Math.round((1 - pc) * 130);
  const textOpacity = Math.max(0, 1 - pc * 1.8);
  return (
    <div style={{
      position: "relative", display: "inline-flex", alignItems: "center",
      justifyContent: "center", flexShrink: 0, height: 36, minWidth: 50,
    }}>
      {/* NO `overflow: hidden` HERE — that is the clipping, and it was measurable. A/B'd on the
          running app at 1440x900, deviceScaleFactor 6, by forcing this one property to `visible`
          and differencing the two screenshots: 33 device pixels changed. The box is
          `transform: rotate(-2deg)` with a border radius, so clipping to its own padding box
          shaves the mark's own corner and the italic glyph bearings, which sit flush against the
          content edge (the trailing "R" of MASTER has 0.12px of slack).

          It is also redundant, which is why removing it is safe rather than a trade: the ONLY
          thing that needs clipping is the collapsing "esume Master" span, and that span carries
          its own `overflow: hidden` below — the same split StampLogo.jsx already uses, where the
          clip lives on `collapseStyle` and not on the box. So the collapse animation is
          unaffected and the mark is no longer cropped by its own container. */}
      <div style={{
        position: "relative", zIndex: 1, padding: "3px 10px",
        background: "#ffffff", border: "2.5px solid #0f0f0f",
        transform: "rotate(-2deg)", borderRadius: 2,
        display: "flex", alignItems: "center",
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

// ── Notifications ─────────────────────────────────────────────
//
// These used to be a bell of their own in the top bar, beside a quick-actions button. Both are
// gone from the bar (W6): quick actions entirely, and the bell INTO the profile menu.
//
// The one thing that could not move with it is the unread count. A notification nobody can see is
// not a notification, and burying the count behind a menu you have to open first would make unread
// items invisible — so the badge stays in the bar, on the avatar, and only the LIST moved. That
// split is why this is a hook plus a section rather than one component: the badge and the list are
// two renderings of one piece of state, in two places, and they must not be able to disagree.
function useNotifications() {
  const [notifs, setNotifs] = useState([]);
  const [unread, setUnread] = useState(0);

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

  const markAll = useCallback(async () => {
    try { await api("/api/notifications/read-all", { method: "PATCH" }); } catch {}
    setNotifs(n => n.map(x => ({ ...x, read: 1 })));
    setUnread(0);
  }, []);

  return { notifs, unread, load, markAll };
}

const NOTIF_TYPE_ICONS = {
  scrape_complete: "🔍", resume_generated: "✦", ats_scored: "🎯",
  enhance_ready: "✨", best_match: "⚡", apply_complete: "✅",
};

function notifTimeAgo(ts) {
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60)    return "just now";
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// The list, rendered inside the profile menu. Every row, the mark-all-read action, the per-item
// unread dot, the icons and the relative timestamps are the bell's, unchanged — this is where they
// live now, not a reduced version of them. Scrolls within itself so a long list cannot push the
// rest of the menu off screen.
function NotificationsSection({ theme, notifs, unread, markAll }) {
  return (
    <div style={{ borderBottom: `1px solid ${theme.border}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "10px 16px 8px" }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                       letterSpacing: "0.08em", color: theme.textDim }}>
          Notifications{unread > 0 ? ` (${unread})` : ""}
        </span>
        {unread > 0 && (
          <button onClick={markAll}
            style={{ background: "none", border: "none", cursor: "pointer",
                     fontSize: 10, color: theme.accentText, fontWeight: 700, padding: 0 }}>
            Mark all read
          </button>
        )}
      </div>
      {notifs.length === 0 ? (
        <div style={{ padding: "8px 16px 14px", fontSize: 12, color: theme.textDim }}>
          No notifications yet
        </div>
      ) : (
        <div style={{ maxHeight: 220, overflowY: "auto", paddingBottom: 6 }}>
          {notifs.slice(0, 20).map(n => (
            <div key={n.id} style={{
              padding: "8px 16px", display: "flex", alignItems: "flex-start", gap: 10,
              background: !n.read ? `${theme.accent}0d` : "transparent",
            }}>
              <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>
                {NOTIF_TYPE_ICONS[n.type] || "ℹ"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: theme.text, lineHeight: 1.4 }}>{n.message}</div>
                <div style={{ fontSize: 10, color: theme.textDim, marginTop: 2 }}>{notifTimeAgo(n.created_at)}</div>
              </div>
              {!n.read && (
                <div style={{ width: 6, height: 6, borderRadius: "50%",
                               background: theme.accent, flexShrink: 0, marginTop: 4 }}/>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Quick actions removed (W6). The control was a ⚡ button opening three items: "Search new role"
// and "ATS sort", which both did nothing but navigate to the jobs tab — the same thing the JOBS tab
// beside them already does, and neither actually searched or sorted anything — and "Export PDF",
// which called window.print() on the whole application chrome. Nothing here is preserved elsewhere
// because there was no behaviour to preserve.

function UserAvatarMenu({ theme, user, onLogout, onTabChange, onUserChange, profiles, onActivateProfile, onDeleteProfile }) {
  const [open,        setOpen]        = useState(false);
  const [rect,        setRect]        = useState(null);
  const triggerRef = useRef(null);
  // Notifications moved in here from their own bell in the bar. The COUNT stays outside, on the
  // avatar — see the badge below.
  const { notifs, unread, load: loadNotifs, markAll } = useNotifications();
  const { accentId, setAccentId, ACCENT_OPTIONS, themeId, setThemeId, availableThemes } = useTheme();
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
          setOpen(o => { if (!o) loadNotifs(); return !o; });
        }}
        title={unread > 0
          ? `${user?.username || "Account"} — ${unread} unread notification${unread === 1 ? "" : "s"}`
          : user?.username}
        aria-label={unread > 0
          ? `Account menu, ${unread} unread notification${unread === 1 ? "" : "s"}`
          : "Account menu"}
        style={{
          width: 30, height: 30, borderRadius: "50%", border: "none", cursor: "pointer",
          background: theme.accent, color: "#0f0f0f",
          fontWeight: 800, fontSize: 12, position: "relative",
          display: "flex", alignItems: "center", justifyContent: "center",
          outline: open ? `2px solid ${theme.accent}` : "none",
          outlineOffset: 2, transition: "outline 0.15s",
          fontFamily: "'DM Sans',system-ui,sans-serif",
        }}>
        {(user?.username || "U")[0].toUpperCase()}
        {/* The unread count, kept OUTSIDE the menu on purpose. Moving notifications into the
            profile menu is only safe if the fact that there ARE unread ones survives the move —
            otherwise they become invisible until someone happens to open a menu. Same "9+" cap and
            the same badge the bell carried, now on the avatar. Bordered against the avatar's own
            accent fill so it reads as a separate mark rather than part of the initial. */}
        {unread > 0 && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute", top: -3, right: -3,
              minWidth: 16, height: 16, padding: "0 3px",
              background: theme.warning || "#dc2626", color: "#fff",
              border: `2px solid ${theme.surfaceBase || theme.surface}`,
              borderRadius: 999,
              fontSize: 9, fontWeight: 800, lineHeight: "12px", textAlign: "center",
            }}>
            {unread > 9 ? "9+" : unread}
          </span>
        )}
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

          <NotificationsSection theme={theme} notifs={notifs} unread={unread} markAll={markAll}/>

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

          {/* Theme picker — hidden until more than one theme is registered */}
          {availableThemes.length > 1 && (
            <div style={{ padding: "10px 16px 8px", borderBottom: `1px solid ${theme.border}` }}>
              <div className="rm-section-label">Theme</div>
              {availableThemes.map(t => (
                <button key={t.id} onClick={() => setThemeId(t.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "8px 12px", marginBottom: 4, width: "100%",
                    background: themeId === t.id ? "rgba(255,255,255,0.06)" : "transparent",
                    border: themeId === t.id ? `1px solid var(--color-primary)` : "1px solid var(--border-glass)",
                    borderRadius: 8, cursor: "pointer", color: "var(--color-text)",
                    fontSize: 12, textAlign: "left",
                  }}>
                  <span style={{ fontWeight: 600 }}>{t.label}</span>
                  <span style={{ marginLeft: "auto", color: "var(--color-text-faint)", fontSize: 10 }}>
                    {themeId === t.id ? "Active" : "Switch"}
                  </span>
                </button>
              ))}
            </div>
          )}

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
  // "bar" | "pill" — which search surface AppDashboard has decided is showing. Defaults to "bar"
  // so any caller that does not pass it (none today) gets the collapsed pill hidden rather than
  // a second surface appearing alongside the main one.
  searchSurface = "bar",
  // Whether the BOARD is the panel on screen. The collapsed pill carries board controls — the
  // All/★/⏳ tabs, the sort, the profile switcher, "Filter jobs…" — and every one of them acts on a
  // job board. Rendering them over Database, Recruiter, Job Profiles or Auto Apply offers controls
  // for something that is not there. Defaults to true so a caller that does not pass it behaves as
  // before rather than losing the pill silently.
  boardIsActive = true,
}) {
  const { theme } = useTheme();
  const { progress: rawProgress, pinned } = useAppScroll();
  // The collapsed pill's VISIBILITY is not decided here any more — it comes from the one derived
  // search-surface value in AppDashboard (hooks/useSearchSurface.js). This component used to answer
  // the same question independently from the board's inner scroll container while the main bar
  // answered it from window.scrollY, which is exactly how both ended up on screen together.
  // `scrolled` below still drives this bar's own GEOMETRY (the nav collapse animation), which is a
  // different question and stays local.
  const pillIsTheSearchSurface = searchSurface === "pill";
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

  const pillWidth = Math.round(vw - p * (vw - 400));
  // The dock spans the full interpolated pill width and is centred on the VIEWPORT.
  //
  // It was once constrained to the jobs panel's measured rect, broadcast via an
  // "rm:jobs-panel-zone" CustomEvent. That publisher/consumer pair and its geometry
  // (dockMaxWidth, the clamp, dockScale) were removed deliberately in Step 7b of the cinematic
  // redesign — see .cinematic/STATE.md, "TopBar flatten + ScrollDock split". Viewport centring
  // is the intended end state, not a regression: the board's content column is itself centred,
  // so the two coincide (measured at vw=1600: search bar spans 340..1260, centre 800 = vw/2).
  //
  // A `constrainedPillWidth = pillWidth` alias survived that removal and read as though a clamp
  // were still in force, which is misleading enough that it was filed as a suspected regression
  // before the history was checked. Removed — pillWidth is used directly below.
  const dockCenter = vw / 2;
  const radius     = Math.round(p * 9999);
  const blur       = Math.round(12 + p * 8);
  const topOffset  = Math.round(p * 10);
  const padH       = 20;

  // Background: 100% translucent — the bar reads as "nothing is there", only the
  // logo + utility icons float over the page. The faint glass treatment is kept
  // ONLY for the collapsed pill state (scrolled), where a subtle surface helps
  // legibility of the floating controls; at rest (p≈0) it is fully transparent.
  const a1 = (p * 0.18).toFixed(3);
  const a2 = (p * 0.08).toFixed(3);
  const a3 = (p * 0.12).toFixed(3);
  const pillBg = p < 0.02
    ? "transparent"
    : `linear-gradient(135deg, rgba(${ar},${ag},${ab},${a1}) 0%, rgba(${ar},${ag},${ab},${a2}) 40%, rgba(255,255,255,${a3}) 100%), ${theme.surfaceBase}${Math.round(p * 0.55 * 255).toString(16).padStart(2, "0")}`;

  // Border: none at rest (fully translucent) → accent pill border when collapsed
  const borderColor = p < 0.02
    ? "transparent"
    : `rgba(${ar},${ag},${ab},${(p * 0.25).toFixed(3)})`;

  // Backdrop blur only once the pill begins to form; none at rest
  const effectiveBlur = p < 0.02 ? 0 : blur;

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
          left: dockCenter,
          transform: "translateX(-50%)",
          width: pillWidth,
          height: 46,
          borderRadius: radius,
          background: pillBg,
          backdropFilter: `blur(${effectiveBlur}px)`,
          WebkitBackdropFilter: `blur(${effectiveBlur}px)`,
          border: `1px solid ${borderColor}`,
          boxShadow: shadow,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: `0 ${padH}px`,
          overflow: "visible",
          opacity: pillWidth <= 0 ? 0 : 1,
          pointerEvents: pillWidth <= 0 ? "none" : "auto",
          zIndex: Z.NAV,
          fontFamily: "'DM Sans',system-ui,sans-serif",
        }}>
        {/* Logo — "R" always visible, "esume Master" collapses */}
        <AnimatedLucyLogo progress={p}/>

        {/* Right: utility icons */}
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          {scrolled && <Divider theme={theme}/>}
          {/* The bell and the quick-actions button are gone from the bar (W6). Notifications live
              in the profile menu below; their unread count rides on the avatar so it is still
              visible without opening anything. */}
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

      {/* ── Pill 2: the COLLAPSED SEARCH SURFACE ── */}
      {/* Gated on the SHARED surface value plus the presence of board controls to render — not on a
          second scroll boolean of its own. `hovered` is deliberately NOT part of this condition:
          it was an independent input, and requirement was one source of truth, so hover no longer
          decides whether the pill exists.

          IT LIVES IN THE SEARCH TIER, NOT THE NAV TIER — and that one value was the whole defect.
          This element and UnifiedSearchBar are two renderings of ONE surface: whichever is showing,
          it is the app's search surface. The bar was at Z.SEARCH (400) and this was at Z.NAV (1500),
          so the same surface sat in two different tiers depending only on the scroll offset, and the
          two halves ended up on opposite sides of the modal scrim.

          Measured, at 1280x800, page scrolled 500, PDF + ATS open: this pill painted at z 1500 over
          a scrim at 800 and tiles at 850, overlapping both tiles' headers by 10px, undimmed while
          the board behind it was dimmed. useBoardLock then spared it as well — it skips every shell
          child at or above Z.NAV, on the correct reasoning that nav chrome must stay reachable — so
          the board's tab / star / pending buttons, its sort select, its profile switcher and its
          filter input all remained clickable and tab-reachable through an open modal. That is why
          the panels looked wrong only sometimes: at scroll 0 the surface is the BAR, correctly below
          the scrim, and everything looked right; scrolled, the surface became this pill, above it.

          At Z.SEARCH the pill is dimmed by the scrim, covered by the tiles and inerted with the rest
          of the board, exactly as the bar already was. Pill 1 above keeps Z.NAV: it is genuinely nav
          chrome and is meant to stay live over a panel. */}
      {pillIsTheSearchSurface && boardIsActive && boardTab !== undefined && (
        <div
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          style={{
            position: "fixed",
            top: topOffset + 46 + 8,
            left: dockCenter,
            transform: "translateX(-50%)",
            maxWidth: Math.max(180, vw - 40),
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
            opacity: pillWidth <= 0 ? 0 : 1,
            pointerEvents: pillWidth <= 0 ? "none" : "auto",
            // The SEARCH tier — the same one UnifiedSearchBar uses. See the note above the gate.
            zIndex: Z.SEARCH,
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
            {/* From the shared contract, not a second literal list. This copy had already drifted
                from the board's own sort select on LABELS — "Pay ↓" here against "Pay high to low"
                there, for the identical value — which is the mild form of the same defect that
                'mid level' vs 'mid' is the severe form of. */}
            {SORTS.options.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
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
