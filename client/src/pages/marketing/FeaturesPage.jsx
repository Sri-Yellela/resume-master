// client/src/pages/marketing/FeaturesPage.jsx
import { useTheme } from "../../styles/theme.jsx";
import { MarketingNav } from "../../components/MarketingNav.jsx";
import { Footer } from "../../components/Footer.jsx";

const FEATURES = [
  {
    icon: "✦",
    title: "AI Resume Generation",
    body: "Tailored resumes generated in seconds. Our AI reads the job description, matches your experience, and writes bullets that hit every keyword the ATS is looking for.",
  },
  {
    icon: "🎯",
    title: "ATS Keyword Analysis",
    body: "See exactly which keywords you have and which you're missing before you apply. Green means covered, red means opportunity.",
  },
  {
    icon: "🔍",
    title: "Job Discovery",
    body: "Scrape fresh job listings directly from LinkedIn. Filter by role, location, work type, and seniority. Your pipeline, always fresh.",
  },
  {
    icon: "⚡",
    title: "Apply Automation",
    body: "One click fills the application form at any portal — Workday, Greenhouse, Lever, or any careers page.",
  },
  {
    icon: "📋",
    title: "Resume History",
    body: "Every resume you generate is saved. Revisit, reuse, and track your applications in one place.",
  },
];

export function FeaturesPage() {
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
          Everything you need to land the interview
        </h1>
        <p style={{ fontSize: 16, color: theme.textMuted, lineHeight: 1.6, marginBottom: 56, maxWidth: 560 }}>
          Resume Master brings together every tool you need for a modern job search — from AI resume writing to automated applications.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          {FEATURES.map((f, i) => (
            <div key={i} style={{
              display: "flex", gap: 24, padding: "28px 32px",
              background: theme.surface, border: `1px solid ${theme.border}`,
              borderRadius: 16, alignItems: "flex-start",
            }}>
              <div style={{ fontSize: 28, flexShrink: 0, width: 48, height: 48,
                             display: "flex", alignItems: "center", justifyContent: "center",
                             background: theme.accentMuted, borderRadius: 12,
                             color: theme.accentText }}>
                {f.icon}
              </div>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 800, color: theme.text,
                              marginBottom: 8, letterSpacing: "-0.3px" }}>
                  {f.title}
                </h2>
                <p style={{ fontSize: 14, color: theme.textMuted, lineHeight: 1.7, margin: 0 }}>
                  {f.body}
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
