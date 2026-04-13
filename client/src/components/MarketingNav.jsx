// client/src/components/MarketingNav.jsx
import { Link } from "react-router-dom";
import { useTheme } from "../styles/theme.jsx";

export function MarketingNav() {
  const { theme } = useTheme();
  return (
    <nav style={{
      background: theme.surface, borderBottom: `1px solid ${theme.border}`,
      padding: "0 24px", height: 56, display: "flex", alignItems: "center",
      justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100,
      fontFamily: "'DM Sans', system-ui, sans-serif",
    }}>
      <Link to="/" style={{ textDecoration: "none" }}>
        <span style={{ fontSize: 17, fontWeight: 900, color: theme.text,
                        letterSpacing: "-0.5px" }}>
          Resume Master
        </span>
      </Link>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {[
          { label: "Features",     to: "/features" },
          { label: "How It Works", to: "/how-it-works" },
          { label: "Pricing",      to: "/pricing" },
        ].map(({ label, to }) => (
          <Link key={to} to={to} style={{
            fontSize: 13, fontWeight: 600, color: theme.textMuted,
            textDecoration: "none", padding: "6px 12px", borderRadius: 8,
          }}>
            {label}
          </Link>
        ))}
        <Link to="/login" style={{
          fontSize: 13, fontWeight: 700, color: theme.accentText,
          textDecoration: "none", padding: "7px 18px", borderRadius: 999,
          background: theme.accentMuted, border: `1px solid ${theme.accent}44`,
        }}>
          Sign In
        </Link>
      </div>
    </nav>
  );
}
