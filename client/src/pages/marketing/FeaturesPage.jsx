// client/src/pages/marketing/FeaturesPage.jsx
import { Link } from "react-router-dom";
import ScrollDock from "../../components/ScrollDock.jsx";
import { Footer } from "../../components/Footer.jsx";
import { BRAND } from "../../../../shared/brand.js";
import { useMonetisationEnabled } from "../../lib/monetisation.jsx";

// Two vocabularies for the same five features, chosen by the lever. The tier-named strings are
// kept rather than rewritten, because they are the copy this page carries the moment monetisation
// turns on — deleting them would mean writing them again from memory later. The untiered strings
// describe the SAME product: with the lever off, every tool here is available to every account, so
// "Plus unlocks Generate" would not merely be a commercial claim, it would be false.
const FEATURES = (monetisationEnabled) => [
  {
    icon: "✦",
    title: "Generate",
    body: monetisationEnabled
      ? "Plus unlocks Generate inside expanded job cards. The tool reads the job description, matches your experience, and drafts a focused resume."
      : "Generate lives inside expanded job cards. The tool reads the job description, matches your experience, and drafts a focused resume.",
  },
  {
    icon: "🎯",
    title: "ATS Keyword Analysis",
    body: "See exactly which keywords you have and which you're missing before you apply. Green means covered, red means opportunity.",
  },
  {
    icon: "🔍",
    title: "Job Discovery",
    body: monetisationEnabled
      ? "Basic starts in one shared jobs console with ATS Search, ATS Sort, role filters, and profile-isolated listings."
      : "One shared jobs console with ATS Search, ATS Sort, role filters, and profile-isolated listings.",
  },
  {
    icon: "⚡",
    title: "Apply Automation",
    body: "One click fills the application form at any portal — Workday, Greenhouse, Lever, or any careers page.",
  },
  {
    icon: "📋",
    title: "A+ Resume",
    body: monetisationEnabled
      ? "Pro unlocks A+ Resume inside expanded job cards for deeper JD-driven resume generation."
      : "A+ Resume sits inside expanded job cards for deeper JD-driven resume generation.",
  },
];

export function FeaturesPage() {
  const monetisationEnabled = useMonetisationEnabled();
  const features = FEATURES(monetisationEnabled);
  return (
    <div className="scroll-dock-page" style={{ minHeight: "100vh", display: "flex", flexDirection: "column",
                  background: "transparent", color: "var(--color-text)",
                  fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <ScrollDock variant="marketing" />
      <main style={{ flex: 1, maxWidth: 800, margin: "0 auto", padding: "64px 24px" }}>
        <h1 style={{ fontSize: "clamp(32px, 5vw, 52px)", fontWeight: 900, letterSpacing: "-1.5px",
                      color: "var(--color-text)", marginBottom: 16, lineHeight: 1.1,
                      fontFamily: "'Barlow Condensed', 'DM Sans', system-ui" }}>
          Everything you need to land the interview
        </h1>
        <p style={{ fontSize: 16, color: "var(--color-text-muted)", lineHeight: 1.6, marginBottom: 56, maxWidth: 560 }}>
          {monetisationEnabled
            ? `${BRAND} starts with one jobs console. Upgrades add Generate and A+ Resume where you already review jobs.`
            : `${BRAND} is one jobs console, with Generate and A+ Resume where you already review jobs.`}
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          {features.map((f, i) => (
            <div key={i} style={{
              display: "flex", gap: 24, padding: "28px 32px",
              background: "var(--color-surface)", border: "1px solid var(--color-border)",
              borderRadius: 16, alignItems: "flex-start",
            }}>
              <div style={{ fontSize: 28, flexShrink: 0, width: 48, height: 48,
                             display: "flex", alignItems: "center", justifyContent: "center",
                             background: "var(--color-primary-muted)", borderRadius: 12,
                             color: "var(--color-primary-text)" }}>
                {f.icon}
              </div>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 800, color: "var(--color-text)",
                              marginBottom: 8, letterSpacing: "-0.3px" }}>
                  {f.title}
                </h2>
                <p style={{ fontSize: 14, color: "var(--color-text-muted)", lineHeight: 1.7, margin: 0 }}>
                  {f.body}
                </p>
              </div>
            </div>
          ))}
        </div>


        {/* Try it free — standalone tools */}
        <div style={{ marginTop: 64 }}>
          <h2 style={{ fontSize: "clamp(24px, 3vw, 36px)", fontWeight: 900,
                       letterSpacing: "-0.8px", color: "var(--color-text)", marginBottom: 8,
                       fontFamily: "'Barlow Condensed', 'DM Sans', system-ui" }}>
            Try it free — no account required
          </h2>
          <p style={{ fontSize: 14, color: "var(--color-text-muted)", lineHeight: 1.6, marginBottom: 32, maxWidth: 480 }}>
            Test the core tools before you sign up. Each tool is fully functional.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 16 }}>
            {[
              // THE QUOTAS HERE ARE THE ONES THE SERVER ACTUALLY ENFORCES, which two of them were
              // not. standaloneRateLimit takes (service, anonMax, userMax): ATS is (1, 3), so "3
              // free scores" was the SIGNED-IN number printed under a heading that says no account
              // is required — an anonymous visitor got one. Generate now requires a standalone
              // account at all, so its old unqualified "2 free resumes" would be a promise the
              // route refuses outright. Same class of error as the privacy policy claiming the
              // extension stored "two things" when it stored four: a public page stating a number
              // nobody checked against the code.
              { path: "/tools/ats",      title: "ATS Scorer",       desc: "Score your resume against any job description.", limit: "1 free score / month, 3 with an account" },
              { path: "/tools/generate", title: "Resume Generator", desc: "Generate a focused resume for any job in 30 seconds.", limit: "2 free resumes / month (sign in required)" },
              { path: "/tools/apply",    title: "Auto Apply",       desc: "Fill applications at any job portal automatically.", limit: "2 free runs / month (sign in required)" },
            ].map(t => (
              <div key={t.path} style={{
                padding: "24px", background: "var(--color-surface)", border: "1px solid var(--color-border)",
                borderRadius: 12, display: "flex", flexDirection: "column", gap: 10,
              }}>
                <div style={{ fontWeight: 800, fontSize: 15, color: "var(--color-text)" }}>{t.title}</div>
                <div style={{ fontSize: 13, color: "var(--color-text-muted)", lineHeight: 1.5, flex: 1 }}>{t.desc}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-muted)", fontStyle: "italic" }}>{t.limit}</div>
                <Link to={t.path}>
                  <button style={{
                    width: "100%", padding: "8px", borderRadius: 6, border: "none",
                    background: "var(--color-primary)", color: "#0f0f0f",
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
