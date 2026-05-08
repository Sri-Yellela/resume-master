// client/src/pages/marketing/PrivacyPage.jsx
import { useTheme } from "../../styles/theme.jsx";
import ScrollDock from "../../components/ScrollDock.jsx";
import { Footer } from "../../components/Footer.jsx";

const SECTIONS = [
  {
    title: "Data We Collect",
    body: "We collect information you provide directly: account credentials, profile information, resume content, generated resumes, job descriptions you submit for ATS scoring, and application tracking entries you create. LinkedIn import collects only the name and email you explicitly share through LinkedIn's OAuth consent screen.",
  },
  {
    title: "How We Use Your Data",
    body: "Your data powers resume building, template selection, PDF export, ATS analysis, manual application tracking, and profile pre-fill. We do not use your resume content or job data to train AI models.",
  },
  {
    title: "Job Listings",
    body: "Job listings are sourced from Adzuna and Indeed via their official publisher APIs. Resume Master does not scrape job boards.",
  },
  {
    title: "Chrome Extension",
    body: "The Chrome extension reads only visible job description text on supported job listing pages, and only when you click Send to Resume Master. It does not access your LinkedIn profile or private data.",
  },
  {
    title: "Applications",
    body: "Applications are submitted manually by you via the official employer application page. Resume Master may track applications you record, but it does not submit LinkedIn applications on your behalf.",
  },
  {
    title: "Third Party Services",
    body: "Resume Master uses LinkedIn OpenID Connect for user-consented name and email import, Anthropic for AI resume generation and ATS analysis, Adzuna for job listings, and Indeed Publisher for job listings.",
  },
  {
    title: "Data Storage and Security",
    body: "Passwords are hashed before storage. Session tokens are stored server-side. LinkedIn access tokens are discarded after the import request and are not written to the database or logs.",
  },
  {
    title: "Contact",
    body: "For privacy-related inquiries, use the contact form at /contact. We will respond within 5 business days.",
  },
];

export function PrivacyPage() {
  const { theme } = useTheme();
  return (
    <div className="scroll-dock-page" style={{ minHeight: "100vh", display: "flex", flexDirection: "column",
                  background: theme.bg, color: theme.text,
                  fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <ScrollDock variant="marketing" />
      <main style={{ flex: 1, maxWidth: 720, margin: "0 auto", padding: "64px 24px" }}>
        <h1 style={{ fontSize: "clamp(28px, 4vw, 44px)", fontWeight: 900, letterSpacing: "-1px",
                      color: theme.text, marginBottom: 8, lineHeight: 1.1,
                      fontFamily: "'Barlow Condensed', 'DM Sans', system-ui" }}>
          Privacy Policy
        </h1>
        <p style={{ fontSize: 13, color: theme.textDim, marginBottom: 48 }}>
          Last updated: May 8, 2026
        </p>
        {SECTIONS.map((s, i) => (
          <div key={i} style={{ marginBottom: 40 }}>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: theme.text, marginBottom: 12 }}>{s.title}</h2>
            <p style={{ fontSize: 14, color: theme.textMuted, lineHeight: 1.8, margin: 0 }}>{s.body}</p>
          </div>
        ))}
      </main>
      <Footer/>
    </div>
  );
}
