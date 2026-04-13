// client/src/pages/marketing/AboutPage.jsx
import { useTheme } from "../../styles/theme.jsx";
import { MarketingNav } from "../../components/MarketingNav.jsx";
import { Footer } from "../../components/Footer.jsx";

const SECTIONS = [
  {
    title: "The Problem",
    body: "Applying for jobs is broken. You spend hours tailoring resumes, only to have them filtered out by an ATS before a human ever sees them. Resume Master fixes that.",
  },
  {
    title: "What We Built",
    body: "Resume Master is an AI-powered job application platform that reads job descriptions the way recruiters do, rewrites your resume to match, and automates the application — so you can focus on preparing for the interview, not filling out forms.",
  },
  {
    title: "Our Approach",
    body: "We believe resumes should be authentic and strategic. Every resume we generate is grounded in your real experience. We do not fabricate credentials — we surface what you have in the language the hiring system understands.",
  },
];

export function AboutPage() {
  const { theme } = useTheme();
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column",
                  background: theme.bg, color: theme.text,
                  fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <MarketingNav/>
      <main style={{ flex: 1, maxWidth: 720, margin: "0 auto", padding: "64px 24px" }}>
        <h1 style={{ fontSize: "clamp(32px, 5vw, 52px)", fontWeight: 900, letterSpacing: "-1.5px",
                      color: theme.text, marginBottom: 16, lineHeight: 1.1,
                      fontFamily: "'Barlow Condensed', 'DM Sans', system-ui" }}>
          Built for job seekers who are serious about landing
        </h1>
        <div style={{ display: "flex", flexDirection: "column", gap: 40, marginTop: 48 }}>
          {SECTIONS.map((s, i) => (
            <div key={i}>
              <h2 style={{ fontSize: 20, fontWeight: 800, color: theme.accent,
                            marginBottom: 12, letterSpacing: "-0.3px" }}>
                {s.title}
              </h2>
              <p style={{ fontSize: 15, color: theme.textMuted, lineHeight: 1.8, margin: 0 }}>
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </main>
      <Footer/>
    </div>
  );
}
