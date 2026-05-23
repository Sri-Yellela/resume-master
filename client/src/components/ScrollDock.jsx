/*
 * ScrollDock — marketing + tools nav bar.
 * AppDockBar (authenticated) removed in Step 7 — TopBar.jsx handles the app.
 * MarketingToolsDock (public pages) and its helpers remain active.
 */
import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useTheme } from "../styles/theme.jsx";
import { useViewport } from "../hooks/useViewport.js";
import { useScrollCollapsed } from "../hooks/useScrollCollapsed.js";

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

// ── Dock divider ─────────────────────────────────────────────
function DockDivider({ theme }) {
  return (
    <div style={{ width: 1, height: 20, background: `${theme.accent}33`,
                  flexShrink: 0, margin: "0 2px" }}/>
  );
}

// ── Mobile hamburger overlay ──────────────────────────────────
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
export default function ScrollDock({ variant = "marketing" }) {
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
