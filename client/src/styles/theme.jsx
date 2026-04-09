// REVAMP v1 — theme.js
import { useState, createContext, useContext } from "react";

function hexToHsl(hex) {
  const r = parseInt(hex.slice(1,3),16)/255;
  const g = parseInt(hex.slice(3,5),16)/255;
  const b = parseInt(hex.slice(5,7),16)/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h, s, l = (max+min)/2;
  if (max===min) { h=s=0; }
  else {
    const d=max-min; s=l>0.5?d/(2-max-min):d/(max+min);
    switch(max){
      case r: h=((g-b)/d+(g<b?6:0))/6; break;
      case g: h=((b-r)/d+2)/6; break;
      case b: h=((r-g)/d+4)/6; break;
    }
  }
  return `${Math.round(h*360)} ${Math.round(s*100)}% ${Math.round(l*100)}%`;
}

export const THEMES = {
  ember: {
    gradBg:      "linear-gradient(135deg, #1a0a00 0%, #2d1200 40%, #1a0800 100%)",
    gradAccent:  "linear-gradient(135deg, #ff4500 0%, #ff8c00 100%)",
    gradPanel:   "linear-gradient(160deg, #2a1200 0%, #1e0d00 100%)",
    gradHover:   "linear-gradient(160deg, #341800 0%, #281000 100%)",
    colorPrimary:   "#ff6b35",
    colorSecondary: "#ff8c00",
    colorAccent:    "#ffb347",
    colorSurface:   "#2a1200",
    colorBorder:    "#3d1f00",
    colorText:      "#fff8f0",
    colorMuted:     "#b87040",
    colorDim:       "#7a4020",
    shimmer1:       "#2a1200",
    shimmer2:       "#3d1f00",
    radiusPill:  "999px",
    radiusCard:  "20px",
    radiusInput: "10px",
    radiusBtn:   "999px",
    radiusBadge: "999px",
    colorCard:      "#311400",
    colorInputBg:   "#2a1200",
    colorTag:       "#331500",
    glowPrimary:    "0 0 0 3px #ff6b3544",
    fontDisplay:    "'DM Sans', system-ui, sans-serif",
    fontMono:       "'JetBrains Mono', monospace",
  },
  aurora: {
    gradBg:      "linear-gradient(135deg, #05001a 0%, #0d0030 40%, #050015 100%)",
    gradAccent:  "linear-gradient(135deg, #4f00ff 0%, #9b59b6 100%)",
    gradPanel:   "linear-gradient(160deg, #120030 0%, #0a001e 100%)",
    gradHover:   "linear-gradient(160deg, #1a0040 0%, #100028 100%)",
    colorPrimary:   "#7c3aed",
    colorSecondary: "#9b59b6",
    colorAccent:    "#c084fc",
    colorSurface:   "#120030",
    colorBorder:    "#2d0060",
    colorText:      "#f5f0ff",
    colorMuted:     "#7c5cb8",
    colorDim:       "#4a2880",
    shimmer1:       "#120030",
    shimmer2:       "#2d0060",
    radiusPill:  "999px",
    radiusCard:  "20px",
    radiusInput: "10px",
    radiusBtn:   "999px",
    radiusBadge: "999px",
    colorCard:      "#160038",
    colorInputBg:   "#120030",
    colorTag:       "#1a003f",
    glowPrimary:    "0 0 0 3px #7c3aed44",
    fontDisplay:    "'DM Sans', system-ui, sans-serif",
    fontMono:       "'JetBrains Mono', monospace",
  },
  forest: {
    gradBg:      "linear-gradient(135deg, #001a05 0%, #003010 40%, #001508 100%)",
    gradAccent:  "linear-gradient(135deg, #00c851 0%, #aacc00 100%)",
    gradPanel:   "linear-gradient(160deg, #002a0a 0%, #001a06 100%)",
    gradHover:   "linear-gradient(160deg, #003810 0%, #002208 100%)",
    colorPrimary:   "#22c55e",
    colorSecondary: "#84cc16",
    colorAccent:    "#bef264",
    colorSurface:   "#002a0a",
    colorBorder:    "#004d14",
    colorText:      "#f0fff4",
    colorMuted:     "#4ade80",
    colorDim:       "#166534",
    shimmer1:       "#002a0a",
    shimmer2:       "#004d14",
    radiusPill:  "999px",
    radiusCard:  "20px",
    radiusInput: "10px",
    radiusBtn:   "999px",
    radiusBadge: "999px",
    colorCard:      "#002f0b",
    colorInputBg:   "#002a0a",
    colorTag:       "#003310",
    glowPrimary:    "0 0 0 3px #22c55e44",
    fontDisplay:    "'DM Sans', system-ui, sans-serif",
    fontMono:       "'JetBrains Mono', monospace",
  },
  studio: {
    gradBg:      "linear-gradient(135deg, #0a0f1a 0%, #0f172a 40%, #080d18 100%)",
    gradAccent:  "linear-gradient(135deg, #3b82f6 0%, #e879f9 100%)",
    gradPanel:   "linear-gradient(160deg, #1e293b 0%, #0f172a 100%)",
    gradHover:   "linear-gradient(160deg, #263348 0%, #162033 100%)",
    colorPrimary:   "#38bdf8",
    colorSecondary: "#e879f9",
    colorAccent:    "#818cf8",
    colorSurface:   "#1e293b",
    colorBorder:    "#334155",
    colorText:      "#f8fafc",
    colorMuted:     "#64748b",
    colorDim:       "#334155",
    shimmer1:       "#1e293b",
    shimmer2:       "#334155",
    radiusPill:  "999px",
    radiusCard:  "20px",
    radiusInput: "10px",
    radiusBtn:   "999px",
    radiusBadge: "999px",
    colorCard:      "#243044",
    colorInputBg:   "#1e293b",
    colorTag:       "#1e3a4a",
    glowPrimary:    "0 0 0 3px #38bdf844",
    fontDisplay:    "'DM Sans', system-ui, sans-serif",
    fontMono:       "'JetBrains Mono', monospace",
  },
};

export const DEFAULT_THEME = "ember";

export const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [themeName, setThemeName] = useState(
    () => localStorage.getItem("rm_theme") || DEFAULT_THEME
  );
  const theme = THEMES[themeName] || THEMES[DEFAULT_THEME];

  const setTheme = (name) => {
    setThemeName(name);
    localStorage.setItem("rm_theme", name);
  };

  return (
    <ThemeContext.Provider value={{ theme, themeName, setTheme, THEMES }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700;9..40,800&display=swap');

        :root {
          --background: ${hexToHsl(theme.colorSurface)};
          --foreground: ${hexToHsl(theme.colorText)};
          --primary: ${hexToHsl(theme.colorPrimary)};
          --primary-foreground: 0 0% 0%;
          --secondary: ${hexToHsl(theme.colorSecondary)};
          --secondary-foreground: 0 0% 0%;
          --accent: ${hexToHsl(theme.colorAccent)};
          --accent-foreground: 0 0% 0%;
          --muted: ${hexToHsl(theme.colorDim)};
          --muted-foreground: ${hexToHsl(theme.colorMuted)};
          --border: ${hexToHsl(theme.colorBorder)};
          --input: ${hexToHsl(theme.colorBorder)};
          --ring: ${hexToHsl(theme.colorPrimary)};
          --card: ${hexToHsl(theme.colorSurface)};
          --card-foreground: ${hexToHsl(theme.colorText)};
          --popover: ${hexToHsl(theme.colorSurface)};
          --popover-foreground: ${hexToHsl(theme.colorText)};
          --destructive: 0 72% 51%;
          --destructive-foreground: 0 0% 100%;
          --radius: 0.5rem;
        }

        body { font-family: 'DM Sans', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }

        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: ${theme.colorBorder}; border-radius: 999px; }
        ::-webkit-scrollbar-thumb:hover { background: ${theme.colorMuted}; }

        .site-title {
          font-size: clamp(16px, 2vw, 20px);
          font-weight: 800;
          letter-spacing: -0.5px;
          background: ${theme.gradAccent};
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }

        .pill-btn {
          border-radius: 999px !important;
          font-weight: 700 !important;
        }

        .glass-panel {
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
        }
      `}</style>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
