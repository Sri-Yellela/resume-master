import CinematicBackground from "../components/CinematicBackground.jsx";

export const baseTheme = {
  bg:           "var(--bg-page)",
  surface:      "var(--bg-card)",
  surfaceHigh:  "var(--bg-panel)",
  menuSurface:  "var(--bg-menu)",
  modalSurface: "var(--bg-modal)",
  backdrop:     "var(--bg-blur)",
  backdropCard: "var(--bg-blur-sm)",
  bgBase:       "#1c1c1e",
  surfaceBase:  "#1c1c1e",
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
};

export const cssVars = {
  "--bg-page":      "hsl(201 100% 13% / 0.64)",
  "--bg-card":      "hsl(201 60% 16% / 0.68)",
  "--bg-panel":     "hsl(201 50% 18% / 0.72)",
  "--bg-menu":      "hsl(201 70% 10% / 0.98)",
  "--bg-modal":     "hsl(201 70% 10% / 0.97)",
  "--bg-input":     "hsl(0 0% 100% / 0.04)",
  "--bg-hover":     "hsl(0 0% 100% / 0.04)",
  "--bg-blur":      "blur(40px) saturate(180%)",
  "--bg-blur-sm":   "blur(20px) saturate(160%)",
  "--border-glass": "hsl(0 0% 100% / 0.08)",
};

export function styles(t) {
  return `
        body {
          margin: 0;
          font-family: 'DM Sans', system-ui, sans-serif;
          background: transparent;
          color: ${t.text};
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
          transition: color 0.3s ease;
        }
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
          color: ${t.text};
          font-style: italic;
        }
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
          background: ${t.surface};
          backdrop-filter: ${t.backdropCard};
          -webkit-backdrop-filter: ${t.backdropCard};
          border: 1px solid ${t.border};
          border-radius: 16px;
          padding: 20px 24px;
          box-shadow: ${t.shadowSm};
          transition: box-shadow 0.2s ease;
        }
        .rm-card-interactive {
          background: ${t.surface};
          backdrop-filter: ${t.backdropCard};
          -webkit-backdrop-filter: ${t.backdropCard};
          border: 1px solid ${t.border};
          border-radius: 16px;
          padding: 16px 20px;
          box-shadow: ${t.shadowSm};
          transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
          cursor: pointer;
        }
        .rm-card-interactive:hover {
          box-shadow: ${t.shadowLg};
          transform: translateY(-2px) scale(1.005);
          border-color: ${t.borderStrong};
        }
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
          background-image: linear-gradient(to top, ${t.accent}, ${t.accent});
          background-size: 100% 100%; border-color: ${t.accent};
        }
        .rm-btn-secondary:hover:not(:disabled) {
          background-image: linear-gradient(to top, var(--bg-panel), var(--bg-panel));
          background-size: 100% 100%; border-color: ${t.borderStrong};
        }
        .rm-btn-ghost { border-color: ${t.border}; color: ${t.textMuted}; }
        .rm-btn-ghost:hover:not(:disabled) {
          border-radius: 999px;
          background-image: linear-gradient(to top, ${t.overlay}, ${t.overlay});
          background-size: 100% 100%; border-color: ${t.borderStrong}; color: ${t.text};
        }
        .rm-btn-sm { padding: 5px 14px; font-size: 11px; gap: 4px; }
        .rm-btn-icon { padding: 0; width: 36px; height: 36px; border-radius: 999px; font-size: 16px; border: none; }
        .rm-btn-icon.sm { width: 28px; height: 28px; font-size: 13px; }
        .rm-input {
          width: 100%; height: 40px; padding: 0 14px;
          border-radius: 10px; border: 1px solid ${t.border};
          background: ${t.colorInputBg}; color: ${t.text};
          backdrop-filter: ${t.backdropCard};
          -webkit-backdrop-filter: ${t.backdropCard};
          font-family: 'DM Sans', system-ui, sans-serif; font-size: 13px;
          outline: none; transition: border-color 0.15s, box-shadow 0.15s;
        }
        .rm-input:focus { border-color: ${t.accent}; box-shadow: 0 0 0 3px ${t.accent}22; }
        .rm-input::placeholder { color: ${t.textDim}; }
        .rm-badge {
          display: inline-flex; align-items: center; padding: 3px 10px;
          border-radius: 999px; font-size: 10px; font-weight: 700;
          letter-spacing: 0.02em; white-space: nowrap;
        }
        .rm-tag {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 600;
          background: ${t.accentMuted}; color: ${t.accentText};
          border: 1px solid ${t.accent}22;
        }
        .rm-section-label {
          font-size: 10px; font-weight: 700; letter-spacing: 0.1em;
          text-transform: uppercase; color: ${t.textDim}; margin: 0 0 8px;
        }
        .animate-in { animation: fadeUp 0.3s cubic-bezier(0.34, 1.2, 0.64, 1) both; }
        .rm-table-row {
          transition: all 0.18s cubic-bezier(0.34, 1.56, 0.64, 1);
          position: relative;
        }
        .rm-table-row:hover {
          transform: scale(1.008);
          box-shadow: ${t.shadowMd};
          z-index: 5;
          background: ${t.overlay} !important;
        }
        .rm-skeleton {
          background: linear-gradient(90deg, rgba(44,44,46,0.65) 25%, ${t.border} 50%, rgba(44,44,46,0.65) 75%);
          background-size: 200% 100%;
          animation: shimmer 1.5s ease infinite;
          border-radius: 8px;
        }
  `;
}

export default {
  id: "cinematic",
  label: "Cinematic",
  description: "Immersive dark glass with video background",
  baseTheme,
  cssVars,
  styles,
  Wrapper: CinematicBackground,
  fonts: {
    display: "'Instrument Serif', serif",
    body: "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'",
  },
};
