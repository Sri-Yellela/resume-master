// client/src/pages/marketing/FAQPage.jsx
import { useState } from "react";
import ScrollDock from "../../components/ScrollDock.jsx";
import { Footer } from "../../components/Footer.jsx";

const FAQS = [
  { q: "Is my resume data private?", a: "Yes. Your resume and job data stay on your account and are never used to train AI models." },
  { q: "Does the extension scrape my LinkedIn profile?", a: "No. The extension only reads the visible job description text on job listing pages, and only when you explicitly click 'Send to Resume Master'. It never accesses your LinkedIn profile or any private data." },
  { q: "Does Resume Master auto-apply to jobs on my behalf?", a: "Not currently. You can queue jobs and track applications in Resume Master, but submissions go to the employer's official application page. You review and submit manually." },
  { q: "Where do job listings come from?", a: "Job listings are sourced from Adzuna and Indeed via their official publisher APIs. We do not scrape any job boards." },
  { q: "What LinkedIn data does Resume Master access?", a: "Only your name and email address, and only when you explicitly click 'Import from LinkedIn' and approve the consent screen. We do not access your connections, work history, or any other LinkedIn data." },
  { q: "Does this work for non-tech roles?", a: "Yes. Resume Master supports professional roles across engineering, product, finance, marketing, HR, healthcare, legal, and more." },
  { q: "What is an ATS score?", a: "An ATS score estimates how well your resume matches a pasted job description based on keywords, skills, and language." },
  { q: "Can I use my own resume?", a: "Yes. You upload your base resume once. Generate and A+ Resume use it as the foundation for resume tools." },
];

function FAQItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: 12, overflow: "hidden", marginBottom: 8 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: "100%", padding: "16px 20px", background: "var(--color-surface)",
                  border: "none", cursor: "pointer", display: "flex",
                  justifyContent: "space-between", alignItems: "center",
                  color: "var(--color-text)", fontWeight: 700, fontSize: 14, textAlign: "left",
                  fontFamily: "'DM Sans', system-ui" }}>
        {q}
        <span style={{ fontSize: 18, color: "var(--color-primary-text)", transform: open ? "rotate(45deg)" : "none",
                         transition: "transform 0.2s", flexShrink: 0, marginLeft: 12 }}>+</span>
      </button>
      {open && (
        <div style={{ padding: "0 20px 18px", fontSize: 14, color: "var(--color-text-muted)",
                       lineHeight: 1.7, background: "var(--color-surface)" }}>
          {a}
        </div>
      )}
    </div>
  );
}

export function FAQPage() {
  return (
    <div className="scroll-dock-page" style={{ minHeight: "100vh", display: "flex", flexDirection: "column",
                  background: "transparent", color: "var(--color-text)",
                  fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <ScrollDock variant="marketing" />
      <main style={{ flex: 1, maxWidth: 720, margin: "0 auto", padding: "64px 24px" }}>
        <h1 style={{ fontSize: "clamp(32px, 5vw, 52px)", fontWeight: 900, letterSpacing: "-1.5px",
                      color: "var(--color-text)", marginBottom: 48, lineHeight: 1.1,
                      fontFamily: "'Barlow Condensed', 'DM Sans', system-ui" }}>
          Frequently asked questions
        </h1>
        {FAQS.map((f, i) => <FAQItem key={i} q={f.q} a={f.a}/>) }
      </main>
      <Footer/>
    </div>
  );
}
