// client/src/pages/marketing/HowItWorksPage.jsx
import ScrollDock from "../../components/ScrollDock.jsx";
import { Footer } from "../../components/Footer.jsx";
import { useMonetisationEnabled } from "../../lib/monetisation.jsx";

// Step 3 is the only tiered step; the other four describe the product identically either way.
// Both wordings are kept so turning the lever on restores the tier copy exactly, rather than
// obliging someone to reconstruct it.
const STEPS = (monetisationEnabled) => [
  { n: 1, title: "Upload your base resume",
    body: "We extract your experience, skills, and history. This is your foundation — we do the rest." },
  { n: 2, title: "Search for roles",
    body: "Type any role. ATS Search and ATS Sort run in the shared jobs console." },
  { n: 3, title: monetisationEnabled ? "Use unlocked tools" : "Use the tools",
    body: monetisationEnabled
      ? "Plus adds Generate on expanded job cards. Pro adds A+ Resume for deeper JD-driven resume generation."
      : "Generate sits on expanded job cards. A+ Resume goes deeper on the job description." },
  { n: 4, title: "Review your ATS score",
    body: "See your match score instantly. Green keywords you already cover, red keywords to watch." },
  { n: 5, title: "Apply",
    body: "Hit Apply. Our automation fills the form. You review and submit." },
];

export function HowItWorksPage() {
  const monetisationEnabled = useMonetisationEnabled();
  const steps = STEPS(monetisationEnabled);
  return (
    <div className="scroll-dock-page" style={{ minHeight: "100vh", display: "flex", flexDirection: "column",
                  background: "transparent", color: "var(--color-text)",
                  fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <ScrollDock variant="marketing" />
      <main style={{ flex: 1, maxWidth: 800, margin: "0 auto", padding: "64px 24px" }}>
        <h1 style={{ fontSize: "clamp(32px, 5vw, 52px)", fontWeight: 900, letterSpacing: "-1.5px",
                      color: "var(--color-text)", marginBottom: 16, lineHeight: 1.1,
                      fontFamily: "'Barlow Condensed', 'DM Sans', system-ui" }}>
          From job listing to submitted application in minutes
        </h1>
        <p style={{ fontSize: 16, color: "var(--color-text-muted)", lineHeight: 1.6, marginBottom: 56, maxWidth: 560 }}>
          {monetisationEnabled
            ? "One jobs console. Simple Apply is built in, and upgrades add tools when you need them."
            : "One jobs console, with Simple Apply built in and every tool available."}
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {steps.map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 24, paddingBottom: 40, position: "relative" }}>
              {/* Connector line */}
              {i < STEPS.length - 1 && (
                <div style={{ position: "absolute", left: 23, top: 52, width: 2, bottom: 0,
                               background: "var(--color-border)" }}/>
              )}
              {/* Step number */}
              <div style={{ width: 48, height: 48, borderRadius: "50%", flexShrink: 0,
                             background: "var(--color-primary-muted)", border: "2px solid var(--color-primary)",
                             display: "flex", alignItems: "center", justifyContent: "center",
                             fontSize: 18, fontWeight: 900, color: "var(--color-primary-text)", zIndex: 1 }}>
                {s.n}
              </div>
              <div style={{ paddingTop: 8 }}>
                <h2 style={{ fontSize: 18, fontWeight: 800, color: "var(--color-text)", marginBottom: 8 }}>
                  {s.title}
                </h2>
                <p style={{ fontSize: 14, color: "var(--color-text-muted)", lineHeight: 1.7, margin: 0, maxWidth: 520 }}>
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
