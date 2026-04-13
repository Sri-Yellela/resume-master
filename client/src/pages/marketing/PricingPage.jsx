// client/src/pages/marketing/PricingPage.jsx
import { Link } from "react-router-dom";
import { useTheme } from "../../styles/theme.jsx";
import { MarketingNav } from "../../components/MarketingNav.jsx";
import { Footer } from "../../components/Footer.jsx";

const TIERS = [
  {
    name: "Free",
    price: "$0",
    period: "/month",
    badge: null,
    recommended: false,
    comingSoon: false,
    features: [
      "5 resume generations per month",
      "10 job scrapes per month",
      "ATS keyword analysis",
      "Resume history",
    ],
    cta: "Get started free",
    ctaLink: "/login",
  },
  {
    name: "Pro",
    price: "$19",
    period: "/month",
    badge: "Most popular",
    recommended: true,
    comingSoon: false,
    features: [
      "Unlimited resume generations",
      "Unlimited job scrapes",
      "ATS scoring and analysis",
      "Apply automation",
      "Resume version history",
      "Priority support",
    ],
    cta: "Start free trial",
    ctaLink: "/login",
  },
  {
    name: "Teams",
    price: "Contact us",
    period: "",
    badge: "Coming soon",
    recommended: false,
    comingSoon: true,
    features: [
      "Everything in Pro",
      "Team dashboard",
      "Shared resume templates",
      "Admin controls",
      "Custom integrations",
    ],
    cta: "Contact us",
    ctaLink: "/contact",
  },
];

export function PricingPage() {
  const { theme } = useTheme();
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column",
                  background: theme.bg, color: theme.text,
                  fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <MarketingNav/>
      <main style={{ flex: 1, maxWidth: 960, margin: "0 auto", padding: "64px 24px" }}>
        <h1 style={{ fontSize: "clamp(32px, 5vw, 52px)", fontWeight: 900, letterSpacing: "-1.5px",
                      color: theme.text, marginBottom: 12, lineHeight: 1.1, textAlign: "center",
                      fontFamily: "'Barlow Condensed', 'DM Sans', system-ui" }}>
          Simple pricing. No surprises.
        </h1>
        <p style={{ fontSize: 16, color: theme.textMuted, lineHeight: 1.6, marginBottom: 48,
                     textAlign: "center" }}>
          Start free. Upgrade when you're ready.
        </p>

        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", justifyContent: "center" }}>
          {TIERS.map((t, i) => (
            <div key={i} style={{
              flex: "1 1 260px", maxWidth: 300,
              background: t.recommended ? theme.accentMuted : theme.surface,
              border: `2px solid ${t.recommended ? theme.accent : theme.border}`,
              borderRadius: 20, padding: "28px 24px",
              display: "flex", flexDirection: "column",
              opacity: t.comingSoon ? 0.6 : 1,
              position: "relative",
            }}>
              {t.badge && (
                <div style={{
                  position: "absolute", top: -12, left: "50%", transform: "translateX(-50%)",
                  background: t.recommended ? theme.accent : theme.surfaceHigh,
                  color: t.recommended ? theme.accentText : theme.textMuted,
                  fontSize: 11, fontWeight: 700, padding: "3px 12px", borderRadius: 999,
                  border: `1px solid ${theme.border}`, whiteSpace: "nowrap",
                }}>
                  {t.badge}
                </div>
              )}
              <div style={{ fontSize: 15, fontWeight: 800, color: theme.text, marginBottom: 8 }}>
                {t.name}
              </div>
              <div style={{ marginBottom: 20 }}>
                <span style={{ fontSize: 36, fontWeight: 900, color: theme.text, letterSpacing: "-1px" }}>
                  {t.price}
                </span>
                <span style={{ fontSize: 13, color: theme.textMuted }}>{t.period}</span>
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: "0 0 24px 0", flex: 1 }}>
                {t.features.map((f, j) => (
                  <li key={j} style={{ display: "flex", gap: 8, fontSize: 13, color: theme.textMuted,
                                        lineHeight: 1.6, marginBottom: 8 }}>
                    <span style={{ color: theme.success, flexShrink: 0 }}>✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              {t.comingSoon ? (
                <div style={{ padding: "10px 0", textAlign: "center", fontSize: 13,
                               color: theme.textDim, fontWeight: 600 }}>
                  Coming soon
                </div>
              ) : (
                <Link to={t.ctaLink} style={{
                  display: "block", textAlign: "center", padding: "11px 0",
                  borderRadius: 999, textDecoration: "none", fontWeight: 700, fontSize: 14,
                  background: t.recommended ? theme.accent : "transparent",
                  color: t.recommended ? theme.accentText : theme.accentText,
                  border: `1.5px solid ${theme.accent}`,
                }}>
                  {t.cta}
                </Link>
              )}
            </div>
          ))}
        </div>

        <p style={{ textAlign: "center", fontSize: 13, color: theme.textDim,
                     marginTop: 32, lineHeight: 1.6 }}>
          Free plan limits are enforced automatically. Upgrade anytime — no contracts.
        </p>
      </main>
      <Footer/>
    </div>
  );
}
