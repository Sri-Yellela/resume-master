// client/src/pages/marketing/HowItWorksPage.jsx
import { useTheme } from "../../styles/theme.jsx";
import { MarketingNav } from "../../components/MarketingNav.jsx";
import { Footer } from "../../components/Footer.jsx";

const STEPS = [
  { n: 1, title: "Upload your base resume",
    body: "We extract your experience, skills, and history. This is your foundation — we do the rest." },
  { n: 2, title: "Search for roles",
    body: "Type any role. We pull fresh listings from LinkedIn and surface the best matches for your background." },
  { n: 3, title: "Generate a tailored resume",
    body: "Click Generate. Our AI rewrites your resume for the specific job description, hitting every required keyword while keeping your story authentic." },
  { n: 4, title: "Review your ATS score",
    body: "See your match score instantly. Green keywords you already cover, red keywords to watch." },
  { n: 5, title: "Apply",
    body: "Hit Apply. Our automation fills the form. You review and submit." },
];

export function HowItWorksPage() {
  const { theme } = useTheme();
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column",
                  background: theme.bg, color: theme.text,
                  fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <MarketingNav/>
      <main style={{ flex: 1, maxWidth: 800, margin: "0 auto", padding: "64px 24px" }}>
        <h1 style={{ fontSize: "clamp(32px, 5vw, 52px)", fontWeight: 900, letterSpacing: "-1.5px",
                      color: theme.text, marginBottom: 16, lineHeight: 1.1,
                      fontFamily: "'Barlow Condensed', 'DM Sans', system-ui" }}>
          From job listing to submitted application in minutes
        </h1>
        <p style={{ fontSize: 16, color: theme.textMuted, lineHeight: 1.6, marginBottom: 56, maxWidth: 560 }}>
          Five simple steps. No résumé tailoring by hand. No form-filling marathons.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {STEPS.map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 24, paddingBottom: 40, position: "relative" }}>
              {/* Connector line */}
              {i < STEPS.length - 1 && (
                <div style={{ position: "absolute", left: 23, top: 52, width: 2, bottom: 0,
                               background: theme.border }}/>
              )}
              {/* Step number */}
              <div style={{ width: 48, height: 48, borderRadius: "50%", flexShrink: 0,
                             background: theme.accentMuted, border: `2px solid ${theme.accent}`,
                             display: "flex", alignItems: "center", justifyContent: "center",
                             fontSize: 18, fontWeight: 900, color: theme.accentText, zIndex: 1 }}>
                {s.n}
              </div>
              <div style={{ paddingTop: 8 }}>
                <h2 style={{ fontSize: 18, fontWeight: 800, color: theme.text, marginBottom: 8 }}>
                  {s.title}
                </h2>
                <p style={{ fontSize: 14, color: theme.textMuted, lineHeight: 1.7, margin: 0, maxWidth: 520 }}>
                  {s.body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </main>
      <Footer/>
    </div>
  );
}
