// client/src/pages/marketing/PrivacyPage.jsx
import { useTheme } from "../../styles/theme.jsx";
import ScrollDock from "../../components/ScrollDock.jsx";
import { Footer } from "../../components/Footer.jsx";

const SECTIONS = [
  {
    title: "Data We Collect",
    body: `We collect the information you provide directly: your account credentials (username and hashed password), profile information (name, email, phone), your base resume text, job listings you interact with, and resumes we generate on your behalf. We also collect usage metadata including timestamps of API calls, model token usage, and application activity — this data is used solely for usage metering and is never sold.`,
  },
  {
    title: "How We Use Your Data",
    body: `Your data is used exclusively to provide the Resume Master service: generating tailored resumes, performing ATS analysis, scraping and displaying job listings, and tracking your application history. We do not use your resume content or job data to train AI models. AI calls are made to the Anthropic API (Claude) on your behalf; your resume text is sent to Anthropic only during active generation or analysis requests.`,
  },
  {
    title: "Data Storage and Security",
    body: `All data is stored in an encrypted SQLite database on your hosting server. Passwords are hashed using bcrypt before storage — we never store plaintext passwords. Session tokens are stored server-side and expire on logout or inactivity. We recommend using a strong, unique password for your account.`,
  },
  {
    title: "Third Party Services",
    body: `Resume Master integrates with two third-party services: (1) Anthropic API — used for AI resume generation and ATS scoring. Resume text and job descriptions are transmitted to Anthropic's servers for processing. Anthropic's privacy policy governs their handling of this data. (2) Apify — used for job scraping from LinkedIn. Your Apify API token is stored encrypted in your account and is used only to execute scraping requests on your behalf.`,
  },
  {
    title: "Your Rights",
    body: `You have the right to access all data we hold about you, delete your account and all associated data at any time, export your resume history, and opt out of non-essential data collection. To exercise these rights, contact us at the address below.`,
  },
  {
    title: "Contact",
    body: `For privacy-related inquiries, use the contact form at /contact. We will respond within 5 business days.`,
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
          Last updated: April 2025
        </p>
        {SECTIONS.map((s, i) => (
          <div key={i} style={{ marginBottom: 40 }}>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: theme.text, marginBottom: 12 }}>
              {s.title}
            </h2>
            <p style={{ fontSize: 14, color: theme.textMuted, lineHeight: 1.8, margin: 0 }}>
              {s.body}
            </p>
          </div>
        ))}
      </main>
      <Footer/>
    </div>
  );
}
