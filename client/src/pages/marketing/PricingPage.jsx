// client/src/pages/marketing/PricingPage.jsx
import { Link } from "react-router-dom";
import ScrollDock from "../../components/ScrollDock.jsx";
import { Footer } from "../../components/Footer.jsx";

const TIERS = [
  {
    name: "Basic",
    price: "Included",
    period: "",
    badge: null,
    recommended: false,
    comingSoon: false,
    features: [
      "Shared jobs console",
      "Baseline Simple Apply workflow",
      "ATS Search and ATS Sort",
      "Profile-isolated saved jobs",
    ],
    cta: "Get started free",
    ctaLink: "/login",
  },
  {
    name: "Plus",
    price: "Request",
    period: "",
    badge: "Generate",
    recommended: true,
    comingSoon: false,
    features: [
      "Everything in Basic",
      "Generate tool on expanded job cards",
      "Focused resumes from selected jobs",
      "Resume history and preview",
    ],
    cta: "Request upgrade",
    ctaLink: "/login",
  },
  {
    name: "Pro",
    price: "Request",
    period: "",
    badge: "A+ Resume",
    recommended: false,
    comingSoon: false,
    features: [
      "Everything in Plus",
      "A+ Resume tool on expanded job cards",
      "A+ resume workflow",
      "Admin-approved access changes",
    ],
    cta: "Request upgrade",
    ctaLink: "/login",
  },
];

export function PricingPage() {
  return (
    <div className="scroll-dock-page" style={{ minHeight: "100vh", display: "flex", flexDirection: "column",
                  background: "transparent", color: "var(--color-text)",
                  fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <ScrollDock variant="marketing" />
      <main style={{ flex: 1, maxWidth: 960, margin: "0 auto", padding: "64px 24px" }}>
        <h1 style={{ fontSize: "clamp(32px, 5vw, 52px)", fontWeight: 900, letterSpacing: "-1.5px",
                      color: "var(--color-text)", marginBottom: 12, lineHeight: 1.1, textAlign: "center",
                      fontFamily: "'Barlow Condensed', 'DM Sans', system-ui" }}>
          Simple pricing. No surprises.
        </h1>
        <p style={{ fontSize: 16, color: "var(--color-text-muted)", lineHeight: 1.6, marginBottom: 48,
                     textAlign: "center" }}>
          Start in the shared jobs console. Request upgrades from Plans when you need more tools.
        </p>

        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", justifyContent: "center" }}>
          {TIERS.map((t, i) => (
            <div key={i} style={{
              flex: "1 1 260px", maxWidth: 300,
              background: t.recommended ? "var(--color-primary-muted)" : "var(--color-surface)",
              border: `2px solid ${t.recommended ? "var(--color-primary)" : "var(--color-border)"}`,
              borderRadius: 20, padding: "28px 24px",
              display: "flex", flexDirection: "column",
              opacity: t.comingSoon ? 0.6 : 1,
              position: "relative",
            }}>
              {t.badge && (
                <div style={{
                  position: "absolute", top: -12, left: "50%", transform: "translateX(-50%)",
                  background: t.recommended ? "var(--color-primary)" : "var(--color-surface-offset)",
                  color: t.recommended ? "var(--color-primary-text)" : "var(--color-text-muted)",
                  fontSize: 11, fontWeight: 700, padding: "3px 12px", borderRadius: 999,
                  border: "1px solid var(--color-border)", whiteSpace: "nowrap",
                }}>
                  {t.badge}
                </div>
              )}
              <div style={{ fontSize: 15, fontWeight: 800, color: "var(--color-text)", marginBottom: 8 }}>
                {t.name}
              </div>
              <div style={{ marginBottom: 20 }}>
                <span style={{ fontSize: 36, fontWeight: 900, color: "var(--color-text)", letterSpacing: "-1px" }}>
                  {t.price}
                </span>
                <span style={{ fontSize: 13, color: "var(--color-text-muted)" }}>{t.period}</span>
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: "0 0 24px 0", flex: 1 }}>
                {t.features.map((f, j) => (
                  <li key={j} style={{ display: "flex", gap: 8, fontSize: 13, color: "var(--color-text-muted)",
                                        lineHeight: 1.6, marginBottom: 8 }}>
                    <span style={{ color: "#22c55e", flexShrink: 0 }}>✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              {t.comingSoon ? (
                <div style={{ padding: "10px 0", textAlign: "center", fontSize: 13,
                               color: "var(--color-text-faint)", fontWeight: 600 }}>
                  Coming soon
                </div>
              ) : (
                <Link to={t.ctaLink} style={{
                  display: "block", textAlign: "center", padding: "11px 0",
                  borderRadius: 999, textDecoration: "none", fontWeight: 700, fontSize: 14,
                  background: t.recommended ? "var(--color-primary)" : "transparent",
                  color: "var(--color-primary-text)",
                  border: "1.5px solid var(--color-primary)",
                }}>
                  {t.cta}
                </Link>
              )}
            </div>
          ))}
        </div>

        <p style={{ textAlign: "center", fontSize: 13, color: "var(--color-text-faint)",
                     marginTop: 32, lineHeight: 1.6 }}>
          Upgrade requests are handled through Plans and granted by an admin while paid upgrades are being prepared.
        </p>
      </main>
      <Footer/>
    </div>
  );
}
