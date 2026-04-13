// client/src/components/Footer.jsx
import { Link } from "react-router-dom";

export function Footer() {
  return (
    <footer style={{
      background: "#0a0a0a", borderTop: "1px solid #1f1f1f",
      padding: "48px 24px 32px", fontFamily: "'DM Sans', system-ui, sans-serif",
    }}>
      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        <div style={{ display: "flex", gap: 40, flexWrap: "wrap" }}>
          {/* Column 1 — Brand */}
          <div style={{ flex: "1 1 200px", minWidth: 180 }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: "#f5f5f5",
                          letterSpacing: "-0.5px", marginBottom: 10 }}>
              Resume Master
            </div>
            <p style={{ fontSize: 13, color: "#9ca3af", lineHeight: 1.6, marginBottom: 16, maxWidth: 220 }}>
              AI-powered resumes for the modern job search.
            </p>
            <p style={{ fontSize: 11, color: "#6b7280" }}>
              © 2025 Resume Master. All rights reserved.
            </p>
          </div>

          {/* Column 2 — Product */}
          <div style={{ flex: "1 1 120px" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280",
                          textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>
              Product
            </div>
            {[
              { label: "Features",     to: "/features" },
              { label: "How It Works", to: "/how-it-works" },
              { label: "Pricing",      to: "/pricing" },
              { label: "FAQ",          to: "/faq" },
            ].map(({ label, to }) => (
              <Link key={to} to={to} style={{
                display: "block", fontSize: 13, color: "#9ca3af",
                textDecoration: "none", marginBottom: 10,
              }}
              onMouseEnter={e => e.target.style.color = "#f5f5f5"}
              onMouseLeave={e => e.target.style.color = "#9ca3af"}>
                {label}
              </Link>
            ))}
          </div>

          {/* Column 3 — Company */}
          <div style={{ flex: "1 1 120px" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280",
                          textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>
              Company
            </div>
            {[
              { label: "About",          to: "/about" },
              { label: "Contact",        to: "/contact" },
              { label: "Privacy Policy", to: "/privacy" },
              { label: "Terms of Service", to: "/terms" },
            ].map(({ label, to }) => (
              <Link key={to} to={to} style={{
                display: "block", fontSize: 13, color: "#9ca3af",
                textDecoration: "none", marginBottom: 10,
              }}
              onMouseEnter={e => e.target.style.color = "#f5f5f5"}
              onMouseLeave={e => e.target.style.color = "#9ca3af"}>
                {label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
