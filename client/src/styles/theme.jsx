// client/src/styles/theme.jsx — Design System v5 (iOS 26 glass — 6 bg modes)
import { useState, useEffect, createContext, useContext } from "react";

// Lucy brand accent colors:
//   User board (JobsPanel, main UI) = soft sky blue #A8D8EA
//   Admin panel                     = citrus yellow #F5E642
export const LUCY_USER_ACCENT  = "#A8D8EA";
export const LUCY_ADMIN_ACCENT = "#F5E642";

export const ACCENT_OPTIONS = [
  { id:"sky",    label:"Sky Blue",      color:"#A8D8EA", mutedLight:"#e8f6fb", mutedDark:"#0a1f2a", textLight:"#1a6a8a", textDark:"#A8D8EA" },
  { id:"lemon",  label:"Lemon Yellow",  color:"#F0EF8A", mutedLight:"#fafad0", mutedDark:"#2a2800", textLight:"#5a5000", textDark:"#F0EF8A" },
  { id:"green",  label:"Celtic Green",  color:"#88C87A", mutedLight:"#e4f5e0", mutedDark:"#0a200a", textLight:"#1a5a14", textDark:"#88C87A" },
  { id:"sunset", label:"Sunset Orange", color:"#FFB07A", mutedLight:"#fff0e2", mutedDark:"#2a1400", textLight:"#8a3600", textDark:"#FFB07A" },
];

export const BG_MODES = [
  { id: "glass-light",      label: "Glass Light",    previewBg: "linear-gradient(135deg, rgba(100,180,255,0.35) 0%, rgba(200,120,255,0.25) 50%, rgba(255,200,150,0.30) 100%), #f0f4f8" },
  { id: "glass-dark",       label: "Glass Dark",     previewBg: "linear-gradient(135deg, rgba(60,100,200,0.50) 0%, rgba(120,60,180,0.40) 50%, rgba(20,80,60,0.45) 100%), #080810" },
  { id: "high-glass-light", label: "Hi-Glass Light", previewBg: "linear-gradient(135deg, rgba(80,160,255,0.55) 0%, rgba(180,90,255,0.45) 50%, rgba(255,180,100,0.50) 100%), #edf2fc" },
  { id: "high-glass-dark",  label: "Hi-Glass Dark",  previewBg: "linear-gradient(135deg, rgba(60,100,220,0.65) 0%, rgba(130,50,200,0.55) 50%, rgba(20,90,60,0.60) 100%), #04040e" },
  { id: "solid-white",      label: "Solid White",    previewBg: "#ffffff" },
  { id: "solid-black",      label: "Solid Black",    previewBg: "#000000" },
];

export const THEMES = {
  light: {
    // ── Surfaces resolve via CSS vars per bg mode ─────────────
    bg:           "var(--bg-page)",
    surface:      "var(--bg-card)",
    surfaceHigh:  "var(--bg-panel)",
    menuSurface:  "var(--bg-menu)",
    modalSurface: "var(--bg-modal)",
    backdrop:     "var(--bg-blur)",
    backdropCard: "var(--bg-blur-sm)",
    // Solid hex fallbacks for alpha-concatenation (TopBar pillBg)
    bgBase:       "#ffffff",
    surfaceBase:  "#ffffff",
    // ─────────────────────────────────────────────────────────
    overlay:      "rgba(0,0,0,0.04)",
    border:       "#e5e5e5",
    borderStrong: "#c0c0c0",
    text:         "#0f0f0f",
    textMuted:    "#3d3d3d",
    textDim:      "#4B5563",
    accent:       "#A8D8EA",
    accentMuted:  "#e8f6fb",
    accentText:   "#1a6a8a",
    success:      "#16a34a",
    successMuted: "#f0fdf4",
    danger:       "#dc2626",
    dangerMuted:  "#fef2f2",
    warning:      "#d97706",
    warningMuted: "#fffbeb",
    info:         "#0284c7",
    infoMuted:    "#f0f9ff",
    shadowSm:     "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)",
    shadowMd:     "0 4px 12px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04)",
    shadowLg:     "0 20px 40px rgba(0,0,0,0.10), 0 8px 16px rgba(0,0,0,0.06)",
    shadowXl:     "0 40px 80px rgba(0,0,0,0.12), 0 16px 32px rgba(0,0,0,0.08)",
    gradAccent:   "#A8D8EA",
    gradSubtle:   "linear-gradient(135deg, var(--bg-page) 0%, var(--bg-panel) 100%)",
    fontDisplay:  "'Barlow Condensed', 'DM Sans', system-ui, sans-serif",
    fontBody:     "'DM Sans', system-ui, sans-serif",
    fontMono:     "'JetBrains Mono', monospace",
    adminAccent:      "#F5E642",
    adminAccentText:  "#5a5000",
    adminAccentMuted: "#fdfbca",
    // Legacy compat
    colorPrimary:   "#A8D8EA",
    colorSecondary: "#1a6a8a",
    colorAccent:    "#1a6a8a",
    colorSurface:   "var(--bg-card)",
    colorBorder:    "#e5e5e5",
    colorText:      "#0f0f0f",
    colorMuted:     "#3d3d3d",
    colorDim:       "#4B5563",
    colorCard:      "var(--bg-panel)",
    colorInputBg:   "var(--bg-input)",
    colorTag:       "#e8f6fb",
    gradBg:         "var(--bg-page)",
    gradPanel:      "var(--bg-card)",
    gradHover:      "rgba(0,0,0,0.04)",
    glowPrimary:    "0 0 0 3px #A8D8EA44",
    shimmer1:       "rgba(245,245,247,0.65)",
    shimmer2:       "#e5e5e5",
    radiusPill:     "999px",
    radiusCard:     "16px",
    radiusInput:    "10px",
  },
  dark: {
    // ── Surfaces resolve via CSS vars per bg mode ─────────────
    bg:           "var(--bg-page)",
    surface:      "var(--bg-card)",
    surfaceHigh:  "var(--bg-panel)",
    menuSurface:  "var(--bg-menu)",
    modalSurface: "var(--bg-modal)",
    backdrop:     "var(--bg-blur)",
    backdropCard: "var(--bg-blur-sm)",
    // Solid hex fallbacks for alpha-concatenation (TopBar pillBg)
    bgBase:       "#1c1c1e",
    surfaceBase:  "#1c1c1e",
    // ─────────────────────────────────────────────────────────
    overlay:      "rgba(255,255,255,0.04)",
    border:       "#2a2a2a",
    borderStrong: "#3a3a3a",
    text:         "#f5f5f5",
    textMuted:    "#c0c0c0",
    textDim:      "#9CA3AF",
    accent:       "#A8D8EA",
    accentMuted:  "#0a1f2a",
    accentText:   "#A8D8EA",
    success:      "#22c55e",
    successMuted: "#0a1f0a",
    danger:       "#ef4444",
    dangerMuted:  "#1f0a0a",
    warning:      "#f59e0b",
    warningMuted: "#1f1500",
    info:         "#38bdf8",
    infoMuted:    "#0a1525",
    shadowSm:     "0 1px 3px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.3)",
    shadowMd:     "0 4px 12px rgba(0,0,0,0.5), 0 2px 4px rgba(0,0,0,0.3)",
    shadowLg:     "0 20px 40px rgba(0,0,0,0.6), 0 8px 16px rgba(0,0,0,0.4)",
    shadowXl:     "0 40px 80px rgba(0,0,0,0.7), 0 16px 32px rgba(0,0,0,0.5)",
    gradAccent:   "#A8D8EA",
    gradSubtle:   "linear-gradient(135deg, var(--bg-page) 0%, var(--bg-panel) 100%)",
    fontDisplay:  "'Barlow Condensed', 'DM Sans', system-ui, sans-serif",
    fontBody:     "'DM Sans', system-ui, sans-serif",
    fontMono:     "'JetBrains Mono', monospace",
    adminAccent:      "#F5E642",
    adminAccentText:  "#5a5000",
    adminAccentMuted: "#2a2800",
    // Legacy compat
    colorPrimary:   "#A8D8EA",
    colorSecondary: "#A8D8EA",
    colorAccent:    "#A8D8EA",
    colorSurface:   "var(--bg-card)",
    colorBorder:    "#2a2a2a",
    colorText:      "#f5f5f5",
    colorMuted:     "#c0c0c0",
    colorDim:       "#9CA3AF",
    colorCard:      "var(--bg-panel)",
    colorInputBg:   "var(--bg-input)",
    colorTag:       "#0a1f2a",
    gradBg:         "var(--bg-page)",
    gradPanel:      "var(--bg-card)",
    gradHover:      "rgba(255,255,255,0.04)",
    glowPrimary:    "0 0 0 3px #A8D8EA33",
    shimmer1:       "rgba(44,44,46,0.65)",
    shimmer2:       "#2a2a2a",
    radiusPill:     "999px",
    radiusCard:     "16px",
    radiusInput:    "10px",
  },
};

// Legacy multi-theme names all map to dark
export const LEGACY_MAP = { ember:"dark", aurora:"dark", forest:"dark", studio:"dark", light:"light", dark:"dark" };

export const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(() => {
    const saved = localStorage.getItem("rm_theme_mode");
    if (saved === "light" || saved === "dark") return saved;
    const legacySaved = localStorage.getItem("rm_theme");
    return LEGACY_MAP[legacySaved] || "light";
  });

  const [bgMode, setBgModeRaw] = useState(() => {
    return localStorage.getItem("rm-bg-mode") || "glass-light";
  });

  const [accentId, setAccentIdRaw] = useState(() => {
    const saved = sessionStorage.getItem("rm_session_accent");
    if (saved && ACCENT_OPTIONS.find(a => a.id === saved)) return saved;
    const random = ACCENT_OPTIONS[Math.floor(Math.random() * ACCENT_OPTIONS.length)].id;
    sessionStorage.setItem("rm_session_accent", random);
    return random;
  });

  const setAccentId = (id) => {
    setAccentIdRaw(id);
    sessionStorage.setItem("rm_session_accent", id);
  };

  const setBgMode = (id) => {
    setBgModeRaw(id);
    localStorage.setItem("rm-bg-mode", id);
    document.documentElement.setAttribute("data-bg", id);
  };

  // Sync data-bg attribute on mount and when bgMode changes
  useEffect(() => {
    document.documentElement.setAttribute("data-bg", bgMode);
  }, [bgMode]);

  const accentOpt = ACCENT_OPTIONS.find(a => a.id === accentId) || ACCENT_OPTIONS[0];
  const baseTheme = THEMES[mode] || THEMES.light;
  const theme = {
    ...baseTheme,
    accent:      accentOpt.color,
    accentMuted: mode === "dark" ? accentOpt.mutedDark : accentOpt.mutedLight,
    accentText:  mode === "dark" ? accentOpt.textDark  : accentOpt.textLight,
    gradAccent:  accentOpt.color,
    glowPrimary: `0 0 0 3px ${accentOpt.color}44`,
    colorPrimary:   accentOpt.color,
    colorSecondary: mode === "dark" ? accentOpt.textDark : accentOpt.textLight,
    colorAccent:    mode === "dark" ? accentOpt.textDark : accentOpt.textLight,
    colorTag:       mode === "dark" ? accentOpt.mutedDark : accentOpt.mutedLight,
  };

  const toggleMode = () => {
    const next = mode === "light" ? "dark" : "light";
    setMode(next);
    localStorage.setItem("rm_theme_mode", next);
  };

  // Legacy setTheme compat
  const setTheme = (name) => {
    const mapped = LEGACY_MAP[name] || "dark";
    setMode(mapped);
    localStorage.setItem("rm_theme_mode", mapped);
  };

  return (
    <ThemeContext.Provider value={{
      theme,
      tokens: theme,
      mode,
      isDark: mode === "dark",
      isLight: mode === "light",
      toggleMode,
      setTheme,
      themeName: mode,
      THEMES,
      accentId,
      setAccentId,
      ACCENT_OPTIONS,
      bgMode,
      setBgMode,
      BG_MODES,
    }}>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; }

        /* ══ Default CSS vars (glass-light — no data-bg fallback) ══ */
        html {
          color-scheme: ${mode};
          min-height: 100vh;
          background: #f0f4f8;
          background-image:
            radial-gradient(ellipse 60% 50% at 20% 20%, rgba(100,180,255,0.35) 0%, transparent 70%),
            radial-gradient(ellipse 50% 40% at 80% 15%, rgba(200,120,255,0.25) 0%, transparent 70%),
            radial-gradient(ellipse 40% 60% at 60% 85%, rgba(255,200,150,0.30) 0%, transparent 70%);
          background-attachment: fixed;
          --bg-page:      rgba(255,255,255,0.72);
          --bg-card:      rgba(255,255,255,0.60);
          --bg-panel:     rgba(245,245,247,0.65);
          --bg-menu:      rgba(255,255,255,0.98);
          --bg-modal:     rgba(255,255,255,0.97);
          --bg-input:     rgba(255,255,255,0.55);
          --popover:      0 0% 100%;
          --popover-foreground: 0 0% 6%;
          --bg-hover:     rgba(0,0,0,0.04);
          --bg-blur:      blur(40px) saturate(180%);
          --bg-blur-sm:   blur(20px) saturate(160%);
          --border-glass: rgba(0,0,0,0.08);
          transition: background 0.4s ease;
        }

        /* ══ Glass Light ══ */
        html[data-bg="glass-light"] {
          background: #f0f4f8;
          background-image:
            radial-gradient(ellipse 60% 50% at 20% 20%, rgba(100,180,255,0.35) 0%, transparent 70%),
            radial-gradient(ellipse 50% 40% at 80% 15%, rgba(200,120,255,0.25) 0%, transparent 70%),
            radial-gradient(ellipse 40% 60% at 60% 85%, rgba(255,200,150,0.30) 0%, transparent 70%);
          background-attachment: fixed;
          --bg-page:      rgba(255,255,255,0.72);
          --bg-card:      rgba(255,255,255,0.60);
          --bg-panel:     rgba(245,245,247,0.65);
          --bg-menu:      rgba(255,255,255,0.98);
          --bg-modal:     rgba(255,255,255,0.97);
          --bg-input:     rgba(255,255,255,0.55);
          --popover:      0 0% 100%;
          --popover-foreground: 0 0% 6%;
          --bg-hover:     rgba(0,0,0,0.04);
          --bg-blur:      blur(40px) saturate(180%);
          --bg-blur-sm:   blur(20px) saturate(160%);
          --border-glass: rgba(0,0,0,0.08);
        }

        /* ══ Glass Dark ══ */
        html[data-bg="glass-dark"] {
          background: #080810;
          background-image:
            radial-gradient(ellipse 60% 50% at 20% 20%, rgba(60,100,200,0.40) 0%, transparent 70%),
            radial-gradient(ellipse 50% 40% at 80% 15%, rgba(120,60,180,0.30) 0%, transparent 70%),
            radial-gradient(ellipse 40% 60% at 60% 85%, rgba(20,80,60,0.40) 0%, transparent 70%);
          background-attachment: fixed;
          --bg-page:      rgba(0,0,0,0.72);
          --bg-card:      rgba(28,28,30,0.60);
          --bg-panel:     rgba(44,44,46,0.65);
          --bg-menu:      rgba(28,28,30,0.98);
          --bg-modal:     rgba(28,28,30,0.97);
          --bg-input:     rgba(44,44,46,0.55);
          --popover:      240 4% 11%;
          --popover-foreground: 0 0% 96%;
          --bg-hover:     rgba(255,255,255,0.04);
          --bg-blur:      blur(40px) saturate(180%);
          --bg-blur-sm:   blur(20px) saturate(160%);
          --border-glass: rgba(255,255,255,0.08);
        }

        /* ══ High Glass Light ══ */
        html[data-bg="high-glass-light"] {
          background: #edf2fc;
          background-image:
            radial-gradient(ellipse 60% 50% at 20% 20%, rgba(80,160,255,0.50) 0%, transparent 70%),
            radial-gradient(ellipse 50% 40% at 80% 15%, rgba(180,90,255,0.40) 0%, transparent 70%),
            radial-gradient(ellipse 40% 60% at 60% 85%, rgba(255,180,100,0.45) 0%, transparent 70%);
          background-attachment: fixed;
          --bg-page:      rgba(255,255,255,0.45);
          --bg-card:      rgba(255,255,255,0.35);
          --bg-panel:     rgba(245,245,247,0.40);
          --bg-menu:      rgba(255,255,255,0.98);
          --bg-modal:     rgba(255,255,255,0.97);
          --bg-input:     rgba(255,255,255,0.30);
          --popover:      0 0% 100%;
          --popover-foreground: 0 0% 6%;
          --bg-hover:     rgba(0,0,0,0.03);
          --bg-blur:      blur(60px) saturate(200%);
          --bg-blur-sm:   blur(30px) saturate(180%);
          --border-glass: rgba(255,255,255,0.50);
        }

        /* ══ High Glass Dark ══ */
        html[data-bg="high-glass-dark"] {
          background: #04040e;
          background-image:
            radial-gradient(ellipse 60% 50% at 20% 20%, rgba(60,100,220,0.60) 0%, transparent 70%),
            radial-gradient(ellipse 50% 40% at 80% 15%, rgba(130,50,200,0.50) 0%, transparent 70%),
            radial-gradient(ellipse 40% 60% at 60% 85%, rgba(20,90,60,0.60) 0%, transparent 70%);
          background-attachment: fixed;
          --bg-page:      rgba(0,0,0,0.45);
          --bg-card:      rgba(28,28,30,0.35);
          --bg-panel:     rgba(44,44,46,0.40);
          --bg-menu:      rgba(28,28,30,0.98);
          --bg-modal:     rgba(28,28,30,0.97);
          --bg-input:     rgba(44,44,46,0.35);
          --popover:      240 4% 11%;
          --popover-foreground: 0 0% 96%;
          --bg-hover:     rgba(255,255,255,0.03);
          --bg-blur:      blur(60px) saturate(200%);
          --bg-blur-sm:   blur(30px) saturate(180%);
          --border-glass: rgba(255,255,255,0.15);
        }

        /* ══ Solid White ══ */
        html[data-bg="solid-white"] {
          background: #ffffff;
          --bg-page:      #ffffff;
          --bg-card:      #ffffff;
          --bg-panel:     #f5f5f7;
          --bg-menu:      #ffffff;
          --bg-modal:     #ffffff;
          --bg-input:     #f0f0f2;
          --popover:      0 0% 100%;
          --popover-foreground: 0 0% 6%;
          --bg-hover:     rgba(0,0,0,0.04);
          --bg-blur:      none;
          --bg-blur-sm:   none;
          --border-glass: rgba(0,0,0,0.08);
        }

        /* ══ Solid Black ══ */
        html[data-bg="solid-black"] {
          background: #000000;
          --bg-page:      #000000;
          --bg-card:      #1c1c1e;
          --bg-panel:     #2c2c2e;
          --bg-menu:      #1c1c1e;
          --bg-modal:     #1c1c1e;
          --bg-input:     #2c2c2e;
          --popover:      240 4% 11%;
          --popover-foreground: 0 0% 96%;
          --bg-hover:     rgba(255,255,255,0.04);
          --bg-blur:      none;
          --bg-blur-sm:   none;
          --border-glass: rgba(255,255,255,0.08);
        }

        body {
          margin: 0;
          font-family: 'DM Sans', system-ui, sans-serif;
          background: transparent;
          color: ${theme.text};
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
          transition: color 0.3s ease;
        }
        /* Padding for fixed ScrollDock on public pages */
        .scroll-dock-page {
          padding-top: 56px;
        }
        @media (max-width: 768px) {
          .scroll-dock-page { padding-top: 52px; }
        }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: ${theme.border}; border-radius: 999px; }
        ::-webkit-scrollbar-thumb:hover { background: ${theme.borderStrong}; }
        ::selection { background: ${theme.accent}33; color: ${theme.text}; }
        :focus-visible { outline: 2px solid ${theme.accent}; outline-offset: 2px; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        @keyframes scrollUp { 0% { transform: translateY(0); } 100% { transform: translateY(-50%); } }
        @keyframes slideInRight { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
        .site-title {
          font-family: 'Barlow Condensed', 'DM Sans', system-ui, sans-serif;
          font-weight: 800;
          font-size: 28px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: ${theme.text};
          font-style: italic;
        }
        /* ── Glass surface utility class ── */
        .glass-surface {
          backdrop-filter: var(--bg-blur-sm);
          -webkit-backdrop-filter: var(--bg-blur-sm);
          position: relative;
        }
        .glass-surface::before {
          content: '';
          position: absolute;
          inset: 0;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E");
          opacity: 0.04;
          mix-blend-mode: overlay;
          pointer-events: none;
          border-radius: inherit;
          z-index: 0;
        }
        .rm-card {
          background: ${theme.surface};
          backdrop-filter: ${theme.backdropCard};
          -webkit-backdrop-filter: ${theme.backdropCard};
          border: 1px solid ${theme.border};
          border-radius: 16px;
          padding: 20px 24px;
          box-shadow: ${theme.shadowSm};
          transition: box-shadow 0.2s ease;
        }
        .rm-card-interactive {
          background: ${theme.surface};
          backdrop-filter: ${theme.backdropCard};
          -webkit-backdrop-filter: ${theme.backdropCard};
          border: 1px solid ${theme.border};
          border-radius: 16px;
          padding: 16px 20px;
          box-shadow: ${theme.shadowSm};
          transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
          cursor: pointer;
        }
        .rm-card-interactive:hover {
          box-shadow: ${theme.shadowLg};
          transform: translateY(-2px) scale(1.005);
          border-color: ${theme.borderStrong};
        }
        /* Lucy brand buttons: sharp black rectangle → water-fill + pill on hover (1s) */
        .rm-btn {
          display: inline-flex; align-items: center; justify-content: center;
          gap: 6px; padding: 8px 20px; border-radius: 2px;
          font-family: 'Barlow Condensed', 'DM Sans', system-ui, sans-serif;
          font-weight: 800; font-size: 13px; letter-spacing: 0.1em;
          text-transform: uppercase; cursor: pointer;
          border: 2.5px solid #0f0f0f;
          background-color: transparent;
          background-image: linear-gradient(to top, transparent, transparent);
          background-size: 100% 0%;
          background-repeat: no-repeat;
          background-position: bottom;
          color: #0f0f0f;
          transition: background-size 1s ease, border-radius 1s ease, border-color 1s ease;
          white-space: nowrap; text-decoration: none; box-sizing: border-box;
        }
        .rm-btn:hover:not(:disabled) { border-radius: 999px; }
        .rm-btn:active { transform: scale(0.97); }
        .rm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .rm-btn-primary:hover:not(:disabled) {
          background-image: linear-gradient(to top, ${theme.accent}, ${theme.accent});
          background-size: 100% 100%; border-color: ${theme.accent};
        }
        .rm-btn-secondary:hover:not(:disabled) {
          background-image: linear-gradient(to top, var(--bg-panel), var(--bg-panel));
          background-size: 100% 100%; border-color: ${theme.borderStrong};
        }
        .rm-btn-ghost { border-color: ${theme.border}; color: ${theme.textMuted}; }
        .rm-btn-ghost:hover:not(:disabled) {
          border-radius: 999px;
          background-image: linear-gradient(to top, ${theme.overlay}, ${theme.overlay});
          background-size: 100% 100%; border-color: ${theme.borderStrong}; color: ${theme.text};
        }
        .rm-btn-sm { padding: 5px 14px; font-size: 11px; gap: 4px; }
        .rm-btn-icon { padding: 0; width: 36px; height: 36px; border-radius: 999px; font-size: 16px; border: none; }
        .rm-btn-icon.sm { width: 28px; height: 28px; font-size: 13px; }
        .rm-input {
          width: 100%; height: 40px; padding: 0 14px;
          border-radius: 10px; border: 1px solid ${theme.border};
          background: ${theme.colorInputBg}; color: ${theme.text};
          backdrop-filter: ${theme.backdropCard};
          -webkit-backdrop-filter: ${theme.backdropCard};
          font-family: 'DM Sans', system-ui, sans-serif; font-size: 13px;
          outline: none; transition: border-color 0.15s, box-shadow 0.15s;
        }
        .rm-input:focus { border-color: ${theme.accent}; box-shadow: 0 0 0 3px ${theme.accent}22; }
        .rm-input::placeholder { color: ${theme.textDim}; }
        .rm-badge {
          display: inline-flex; align-items: center; padding: 3px 10px;
          border-radius: 999px; font-size: 10px; font-weight: 700;
          letter-spacing: 0.02em; white-space: nowrap;
        }
        .rm-tag {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 600;
          background: ${theme.accentMuted}; color: ${theme.accentText};
          border: 1px solid ${theme.accent}22;
        }
        .rm-section-label {
          font-size: 10px; font-weight: 700; letter-spacing: 0.1em;
          text-transform: uppercase; color: ${theme.textDim}; margin: 0 0 8px;
        }
        .animate-in { animation: fadeUp 0.3s cubic-bezier(0.34, 1.2, 0.64, 1) both; }
        .rm-table-row {
          transition: all 0.18s cubic-bezier(0.34, 1.56, 0.64, 1);
          position: relative;
        }
        .rm-table-row:hover {
          transform: scale(1.008);
          box-shadow: ${theme.shadowMd};
          z-index: 5;
          background: ${theme.overlay} !important;
        }
        .rm-skeleton {
          background: linear-gradient(90deg, ${mode === "dark" ? "rgba(44,44,46,0.65)" : "rgba(245,245,247,0.65)"} 25%, ${theme.border} 50%, ${mode === "dark" ? "rgba(44,44,46,0.65)" : "rgba(245,245,247,0.65)"} 75%);
          background-size: 200% 100%;
          animation: shimmer 1.5s ease infinite;
          border-radius: 8px;
        }
      `}</style>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
