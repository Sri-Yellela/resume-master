// Below-fold marketing content — extracted from LandingPage.jsx
import { Link } from "react-router-dom";

const FEATURES = [
  {
    title: "AI Resume Generation",
    desc: "Tailored resumes built from your profile and the job description. ATS-optimized, recruiter-ready.",
  },
  {
    title: "ATS Score & Gap Analysis",
    desc: "See exactly which keywords are missing. Fix them before applying.",
  },
  {
    title: "Cover Letter Generator",
    desc: "Professional, conversational, or enthusiastic — generated in seconds.",
  },
  {
    title: "Auto Apply",
    desc: "Semi-automated application filling. You review, you submit.",
  },
];

export default function BelowFoldContent() {
  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "60px 20px 80px" }}>
      {/* Feature grid */}
      <div style={{ textAlign: "center", marginBottom: 40 }}>
        <div style={{
          fontFamily: "'Barlow Condensed','DM Sans',sans-serif",
          fontWeight: 800, fontSize: 28, color: "var(--color-text)",
          letterSpacing: "-0.02em",
        }}>
          Everything you need to land the job
        </div>
        <div style={{ fontSize: 14, color: "var(--color-text-muted)", marginTop: 8 }}>
          From resume to offer — Resume Master has every step covered.
        </div>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
        gap: 16,
        marginBottom: 48,
      }}>
        {FEATURES.map((f, i) => (
          <div key={f.title} style={{
            background: "var(--bg-card)",
            backdropFilter: "var(--bg-blur-sm)", WebkitBackdropFilter: "var(--bg-blur-sm)",
            border: "1px solid var(--border-glass)", borderRadius: 12,
            padding: "24px 22px",
          }}>
            <div style={{
              fontFamily: "var(--font-display, 'Instrument Serif', serif)",
              fontSize: 28, fontWeight: 400,
              color: "var(--color-primary)",
              letterSpacing: "-0.02em", lineHeight: 1, marginBottom: 4,
            }}>{String(i + 1).padStart(2, "0")}</div>
            <div style={{
              width: 24, height: 1.5, background: "var(--color-primary)",
              opacity: 0.4, marginBottom: 14,
            }}/>
            <div style={{ fontWeight: 700, fontSize: 14, color: "var(--color-text)", marginBottom: 6 }}>{f.title}</div>
            <div style={{ fontSize: 12, color: "var(--color-text-muted)", lineHeight: 1.6 }}>{f.desc}</div>
          </div>
        ))}
      </div>

      {/* CTA */}
      <div style={{ textAlign: "center" }}>
        <Link to="/register" style={{
          display: "inline-block",
          background: "var(--color-primary)",
          color: "#0f0f0f",
          padding: "12px 32px",
          borderRadius: 8,
          fontWeight: 800,
          fontSize: 14,
          textDecoration: "none",
          letterSpacing: "0.02em",
        }}>
          Get Started Free
        </Link>
        <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 10 }}>
          No credit card required.
        </div>
      </div>
    </div>
  );
}
