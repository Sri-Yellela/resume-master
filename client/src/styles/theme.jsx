// client/src/styles/theme.jsx — Design System v6 (theme registry)
import { useState, createContext, useContext } from "react";
import { getTheme, DEFAULT_THEME_ID, AVAILABLE_THEMES } from "../themes/index.js";
import { baseTheme as cinematicBase } from "../themes/cinematic.js";

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

// Preserved for backward-compat consumers (e.g. TopBar pillBg uses THEMES.dark.surfaceBase)
export const THEMES = { dark: cinematicBase };

export const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [themeId, setThemeIdRaw] = useState(() => {
    try {
      const saved = localStorage.getItem("rm_theme_id");
      if (saved) return saved;
    } catch {}
    return DEFAULT_THEME_ID;
  });

  const setThemeId = (id) => {
    setThemeIdRaw(id);
    try { localStorage.setItem("rm_theme_id", id); } catch {}
  };

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

  const activeTheme = getTheme(themeId);
  const accentOpt = ACCENT_OPTIONS.find(a => a.id === accentId) || ACCENT_OPTIONS[0];
  const isDark = true;

  const theme = {
    ...activeTheme.baseTheme,
    accent:      accentOpt.color,
    accentMuted: accentOpt.mutedDark,
    accentText:  accentOpt.textDark,
    gradAccent:  accentOpt.color,
    glowPrimary: `0 0 0 3px ${accentOpt.color}44`,
    colorPrimary:   accentOpt.color,
    colorSecondary: accentOpt.textDark,
    colorAccent:    accentOpt.textDark,
    colorTag:       accentOpt.mutedDark,
  };

  const cssVarEntries = Object.entries(activeTheme.cssVars || {})
    .map(([k, v]) => `${k}: ${v};`)
    .join("\n          ");

  const themeStyles = typeof activeTheme.styles === "function"
    ? activeTheme.styles(theme)
    : (activeTheme.styles || "");

  return (
    <ThemeContext.Provider value={{
      theme,
      tokens: theme,
      isDark,
      themeId,
      setThemeId,
      availableThemes: AVAILABLE_THEMES,
      accentId,
      setAccentId,
      ACCENT_OPTIONS,
    }}>
      <style>{`
        /* ── Color token bridge: --color-* → live theme ── */
        :root {
          --color-primary:         ${theme.accent};
          --color-primary-hover:   color-mix(in srgb, ${theme.accent} 75%, black);
          --color-primary-muted:   ${theme.accentMuted};
          --color-primary-text:    ${theme.accentText};
          --color-on-primary:      #0f0f0f;
          --shadow-sm:             ${theme.shadowSm};
          --color-warning:         ${theme.warning};
          --color-text:            ${theme.text};
          --color-text-muted:      ${theme.textMuted};
          --color-text-faint:      ${theme.textDim};
          --color-bg:              var(--bg-page);
          --color-surface:         var(--bg-card);
          --color-surface-offset:  var(--bg-panel);
          --color-surface-2:       var(--bg-panel);
          --color-border:          var(--border-glass);
          --color-divider:         var(--border-glass);
          --color-surface-dynamic: rgba(255,255,255,0.88);
        }

        /* ══ Theme CSS vars ══ */
        html {
          color-scheme: dark;
          min-height: 100vh;
          background: transparent;
          ${cssVarEntries}
        }

        ${themeStyles}
      `}</style>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
