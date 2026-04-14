// client/src/pages/marketing/FeaturesPage.jsx
import { Link } from "react-router-dom";
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


        {/* Try it free — standalone tools */}
        <div style={{ marginTop: 64 }}>
          <h2 style={{ fontSize: "clamp(24px, 3vw, 36px)", fontWeight: 900,
                       letterSpacing: "-0.8px", color: theme.text, marginBottom: 8,
                       fontFamily: "'Barlow Condensed', 'DM Sans', system-ui" }}>
            Try it free — no account required
          </h2>
          <p style={{ fontSize: 14, color: theme.textMuted, lineHeight: 1.6, marginBottom: 32, maxWidth: 480 }}>
            Test the core tools before you sign up. Each tool is fully functional.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 16 }}>
            {[
              { path: "/tools/ats",      title: "ATS Scorer",       desc: "Score your resume against any job description.", limit: "3 free scores / month" },
              { path: "/tools/generate", title: "Resume Generator", desc: "Get a tailored resume for any job in 30 seconds.", limit: "2 free resumes / month" },
              { path: "/tools/apply",    title: "Auto Apply",       desc: "Fill applications at any job portal automatically.", limit: "2 free runs / month (sign in required)" },
            ].map(t => (
              <div key={t.path} style={{
                padding: "24px", background: theme.surface, border: `1px solid ${theme.border}`,
                borderRadius: 12, display: "flex", flexDirection: "column", gap: 10,
              }}>
                <div style={{ fontWeight: 800, fontSize: 15, color: theme.text }}>{t.title}</div>
                <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.5, flex: 1 }}>{t.desc}</div>
                <div style={{ fontSize: 11, color: theme.textMuted, fontStyle: "italic" }}>{t.limit}</div>
                <Link to={t.path}>
                  <button style={{
                    width: "100%", padding: "8px", borderRadius: 6, border: "none",
                    background: theme.accent, color: "#0f0f0f",
                    fontWeight: 700, fontSize: 13, cursor: "pointer",
                  }}>
                    Try free →
                  </button>
                </Link>
              </div>
            ))}
          </div>
        </div>
      </main>
      <Footer/>
    </div>
  );
}
