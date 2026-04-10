// client/src/styles/theme.jsx — Design System v4
import { useState, createContext, useContext } from "react";

// Lucy brand accent colors:
//   User board (JobsPanel, main UI) = soft sky blue #A8D8EA
//   Admin panel                     = citrus yellow #F5E642
// These are defined per-screen; the global theme uses the user accent.
export const LUCY_USER_ACCENT  = "#A8D8EA";
export const LUCY_ADMIN_ACCENT = "#F5E642";

export const THEMES = {
  light: {
    bg:           "#ffffff",
    surface:      "#ffffff",
    surfaceHigh:  "#f5f5f3",
    overlay:      "rgba(0,0,0,0.04)",
    border:       "#e5e5e5",
    borderStrong: "#c0c0c0",
    text:         "#0f0f0f",
    textMuted:    "#6b6b6b",
    textDim:      "#a3a3a3",
    // Lucy sky-blue accent (user board)
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
    gradSubtle:   "linear-gradient(135deg, #ffffff 0%, #f0f8fb 100%)",
    fontDisplay:  "'Barlow Condensed', 'DM Sans', system-ui, sans-serif",
    fontBody:     "'DM Sans', system-ui, sans-serif",
    fontMono:     "'JetBrains Mono', monospace",
    // Lucy admin yellow (used in AdminPanel)
    adminAccent:      "#F5E642",
    adminAccentText:  "#5a5000",
    adminAccentMuted: "#fdfbca",
    // Legacy compat
    colorPrimary:   "#A8D8EA",
    colorSecondary: "#1a6a8a",
    colorAccent:    "#1a6a8a",
    colorSurface:   "#ffffff",
    colorBorder:    "#e5e5e5",
    colorText:      "#0f0f0f",
    colorMuted:     "#6b6b6b",
    colorDim:       "#a3a3a3",
    colorCard:      "#f5f5f3",
    colorInputBg:   "#ffffff",
    colorTag:       "#e8f6fb",
    gradBg:         "#ffffff",
    gradPanel:      "#ffffff",
    gradHover:      "rgba(0,0,0,0.04)",
    glowPrimary:    "0 0 0 3px #A8D8EA44",
    shimmer1:       "#ffffff",
    shimmer2:       "#f5f5f3",
    radiusPill:     "999px",
    radiusCard:     "16px",
    radiusInput:    "10px",
  },
  dark: {
    bg:           "#0a0a0a",
    surface:      "#111111",
    surfaceHigh:  "#1a1a1a",
    overlay:      "rgba(255,255,255,0.04)",
    border:       "#2a2a2a",
    borderStrong: "#3a3a3a",
    text:         "#f5f5f5",
    textMuted:    "#888888",
    textDim:      "#555555",
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
    gradSubtle:   "linear-gradient(135deg, #111111 0%, #1a1a1a 100%)",
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
    colorSurface:   "#111111",
    colorBorder:    "#2a2a2a",
    colorText:      "#f5f5f5",
    colorMuted:     "#888888",
    colorDim:       "#555555",
    colorCard:      "#1a1a1a",
    colorInputBg:   "#111111",
    colorTag:       "#0a1f2a",
    gradBg:         "#0a0a0a",
    gradPanel:      "#111111",
    gradHover:      "rgba(255,255,255,0.04)",
    glowPrimary:    "0 0 0 3px #A8D8EA33",
    shimmer1:       "#111111",
    shimmer2:       "#1a1a1a",
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
    // Legacy: any of the old theme names → dark
    const legacySaved = localStorage.getItem("rm_theme");
    return LEGACY_MAP[legacySaved] || "light";
  });

  const theme = THEMES[mode] || THEMES.light;

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
    }}>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; }
        html { color-scheme: ${mode}; }
        body {
          margin: 0;
          font-family: 'DM Sans', system-ui, sans-serif;
          background: ${theme.bg};
          color: ${theme.text};
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
          transition: background 0.3s ease, color 0.3s ease;
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
        }
        .rm-card {
          background: ${theme.surface};
          border: 1px solid ${theme.border};
          border-radius: 16px;
          padding: 20px 24px;
          box-shadow: ${theme.shadowSm};
          transition: box-shadow 0.2s ease;
        }
        .rm-card-interactive {
          background: ${theme.surface};
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
        /* Lucy tin button style: rectangular, pill on hover (1s transition) */
        .rm-btn {
          display: inline-flex; align-items: center; justify-content: center;
          gap: 6px; padding: 8px 20px; border-radius: 2px;
          font-family: 'Barlow Condensed', 'DM Sans', system-ui, sans-serif;
          font-weight: 800; font-size: 13px; letter-spacing: 0.08em;
          text-transform: uppercase; border: none; cursor: pointer;
          transition: border-radius 1s ease, filter 0.15s ease, box-shadow 0.15s ease;
          white-space: nowrap; text-decoration: none;
        }
        .rm-btn:hover:not(:disabled) { border-radius: 999px; }
        .rm-btn:active { transform: scale(0.97); }
        .rm-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
        .rm-btn-primary { background: ${theme.accent}; color: #0f0f0f; }
        .rm-btn-primary:hover:not(:disabled) { filter: brightness(1.05); box-shadow: 0 0 0 4px ${theme.accent}44; }
        .rm-btn-ghost { background: transparent; color: ${theme.text}; border: 1px solid ${theme.border}; }
        .rm-btn-ghost:hover:not(:disabled) { background: ${theme.overlay}; border-color: ${theme.borderStrong}; }
        .rm-btn-sm { padding: 5px 14px; font-size: 11px; gap: 4px; }
        .rm-btn-icon { padding: 0; width: 36px; height: 36px; border-radius: 999px; font-size: 16px; }
        .rm-btn-icon.sm { width: 28px; height: 28px; font-size: 13px; }
        .rm-input {
          width: 100%; height: 40px; padding: 0 14px;
          border-radius: 10px; border: 1px solid ${theme.border};
          background: ${theme.surface}; color: ${theme.text};
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
          background: linear-gradient(90deg, ${theme.surfaceHigh} 25%, ${theme.border} 50%, ${theme.surfaceHigh} 75%);
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
