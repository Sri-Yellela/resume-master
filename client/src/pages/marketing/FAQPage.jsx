// client/src/pages/marketing/FAQPage.jsx
import { useState } from "react";
import { useTheme } from "../../styles/theme.jsx";
import ScrollDock from "../../components/ScrollDock.jsx";
import { Footer } from "../../components/Footer.jsx";

const FAQS = [
  { q: "Is my resume data private?",
    a: "Yes. Your resume and job data are stored only on your account and never shared or used to train AI models." },
  { q: "Does this work for non-tech roles?",
    a: "Yes. Resume Master supports all professional roles — engineering, product management, finance, marketing, HR, healthcare, legal, and more." },
  { q: "What job boards do you pull from?",
    a: "We currently source listings from LinkedIn via the Apify scraping platform. You need your own Apify token to use job scraping." },
  { q: "How is this different from other resume tools?",
    a: "Most tools give you a template. We give you a resume that is written specifically for the job description you are applying to, with keyword analysis and apply automation built in." },
  { q: "What is an ATS score?",
    a: "An ATS (Applicant Tracking System) score measures how well your resume matches the job description based on keywords, skills, and language. Most large companies filter resumes by ATS score before a human sees them." },
  { q: "Can I use my own resume?",
    a: "Yes. You upload your base resume once. We use it as the foundation for every tailored resume we generate." },
  { q: "What happens to my data if I cancel?",
    a: "Your data remains accessible until you delete your account. We do not delete data on cancellation." },
];

function FAQItem({ q, a }) {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: `1px solid ${theme.border}`, borderRadius: 12, overflow: "hidden",
                   marginBottom: 8 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: "100%", padding: "16px 20px", background: theme.surface,
                  border: "none", cursor: "pointer", display: "flex",
                  justifyContent: "space-between", alignItems: "center",
                  color: theme.text, fontWeight: 700, fontSize: 14, textAlign: "left",
                  fontFamily: "'DM Sans', system-ui" }}>
        {q}
        <span style={{ fontSize: 18, color: theme.accentText, transform: open ? "rotate(45deg)" : "none",
                         transition: "transform 0.2s", flexShrink: 0, marginLeft: 12 }}>+</span>
      </button>
      {open && (
        <div style={{ padding: "0 20px 18px", fontSize: 14, color: theme.textMuted,
                       lineHeight: 1.7, background: theme.surface }}>
          {a}
        </div>
      )}
    </div>
  );
}

export function FAQPage() {
  const { theme } = useTheme();
  return (
    <div className="scroll-dock-page" style={{ minHeight: "100vh", display: "flex", flexDirection: "column",
                  background: theme.bg, color: theme.text,
                  fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <ScrollDock variant="marketing" />
      <main style={{ flex: 1, maxWidth: 720, margin: "0 auto", padding: "64px 24px" }}>
        <h1 style={{ fontSize: "clamp(32px, 5vw, 52px)", fontWeight: 900, letterSpacing: "-1.5px",
                      color: theme.text, marginBottom: 48, lineHeight: 1.1,
                      fontFamily: "'Barlow Condensed', 'DM Sans', system-ui" }}>
          Frequently asked questions
        </h1>
        {FAQS.map((f, i) => <FAQItem key={i} q={f.q} a={f.a}/>)}
      </main>
      <Footer/>
    </div>
  );
}
