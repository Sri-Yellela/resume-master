// client/src/pages/marketing/PrivacyPage.jsx
import { Link } from "react-router-dom";
import { useTheme } from "../../styles/theme.jsx";
import ScrollDock from "../../components/ScrollDock.jsx";
import { Footer } from "../../components/Footer.jsx";

const LAST_UPDATED  = 'May 19, 2026';
const CONTACT_EMAIL = 'privacy@resumemaster.one';

function Section({ title, children, theme }) {
  return (
    <section style={{ marginBottom: 40 }}>
      <h2 style={{
        fontSize: 18, fontWeight: 800, color: theme.text,
        marginBottom: 12, paddingBottom: 8,
        borderBottom: `1px solid ${theme.border}`,
        fontFamily: "'Barlow Condensed', 'DM Sans', system-ui",
        letterSpacing: "-0.2px",
      }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function P({ children, theme }) {
  return (
    <p style={{
      fontSize: 14, color: theme.textMuted,
      lineHeight: 1.8, margin: "0 0 12px",
      maxWidth: "66ch",
    }}>
      {children}
    </p>
  );
}

function UL({ children, theme }) {
  return (
    <ul style={{
      paddingLeft: 22, margin: "0 0 12px",
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      {children}
    </ul>
  );
}

function LI({ children, theme }) {
  return (
    <li style={{
      fontSize: 14, color: theme.textMuted,
      lineHeight: 1.75, maxWidth: "64ch",
    }}>
      {children}
    </li>
  );
}

function H3({ children, theme }) {
  return (
    <h3 style={{
      fontSize: 15, fontWeight: 700, color: theme.text,
      margin: "20px 0 8px",
    }}>
      {children}
    </h3>
  );
}

function Strong({ children, theme }) {
  return <strong style={{ fontWeight: 700, color: theme.text }}>{children}</strong>;
}

export function PrivacyPage() {
  const { theme } = useTheme();
  const t = theme;

  return (
    <div className="scroll-dock-page" style={{
      minHeight: "100vh", display: "flex", flexDirection: "column",
      background: t.bg, color: t.text,
      fontFamily: "'DM Sans', system-ui, sans-serif",
    }}>
      <ScrollDock variant="marketing" />

      <main style={{ flex: 1, maxWidth: 720, margin: "0 auto", padding: "64px 24px 80px" }}>

        {/* Header */}
        <header style={{ marginBottom: 48, paddingBottom: 24, borderBottom: `1px solid ${t.border}` }}>
          <h1 style={{
            fontSize: "clamp(28px, 4vw, 44px)", fontWeight: 900,
            letterSpacing: "-1px", color: t.text, marginBottom: 8,
            lineHeight: 1.1, fontFamily: "'Barlow Condensed', 'DM Sans', system-ui",
          }}>
            Privacy Policy
          </h1>
          <p style={{ fontSize: 13, color: t.textDim }}>
            Last updated: {LAST_UPDATED}
          </p>
        </header>

        {/* Overview */}
        <Section title="Overview" theme={t}>
          <P theme={t}>
            Resume Master ("we", "us", "our") operates resumemaster.one and the Resume Master
            browser extension. This policy explains what data we collect, how we use it, and
            your rights over your information.
          </P>
          <P theme={t}>
            <Strong theme={t}>We do not sell your personal data.</Strong> We do not share it
            with third parties except as described in this policy.
          </P>
        </Section>

        {/* Information We Collect */}
        <Section title="Information We Collect" theme={t}>
          <H3 theme={t}>Account Information</H3>
          <P theme={t}>
            When you create an account, we collect your email address and a hashed password
            (we never store plaintext passwords). If you sign in with LinkedIn OAuth, we receive
            your name and email address only — no LinkedIn profile data, posts, connections,
            or activity.
          </P>

          <H3 theme={t}>Resume Data</H3>
          <P theme={t}>
            We store the resume content you create or upload: work history, education, skills,
            and contact information. This data is stored solely to provide the resume-building
            service to you. You can delete it at any time from your account settings.
          </P>

          <H3 theme={t}>Job Listings</H3>
          <P theme={t}>
            When you search for jobs, save jobs, or import jobs via the browser extension, we
            store job listing data (title, company, location, description, URL) in association
            with your account. This data comes from public job boards and pages you actively
            visit — we do not access job data without your interaction.
          </P>

          <H3 theme={t}>Browser Extension</H3>
          <P theme={t}>
            The Resume Master browser extension reads job listing pages that you actively visit
            on LinkedIn, Indeed, Glassdoor, Lever, Greenhouse, and Workable. Specifically:
          </P>
          <UL theme={t}>
            <LI theme={t}>
              It reads the <Strong theme={t}>visible text</Strong> of job listing pages to extract
              title, company, location, and description.
            </LI>
            <LI theme={t}>
              It does <Strong theme={t}>not</Strong> read, store, or transmit your LinkedIn
              session cookies, login credentials, or any authentication tokens.
            </LI>
            <LI theme={t}>
              It does <Strong theme={t}>not</Strong> access any LinkedIn page you have not
              navigated to yourself.
            </LI>
            <LI theme={t}>
              It does <Strong theme={t}>not</Strong> read your LinkedIn messages, connections,
              profile feed, or any page other than job listings and your saved jobs list.
            </LI>
            <LI theme={t}>
              Data extracted by the extension is sent to resumemaster.one and associated with
              your logged-in account using a browser session cookie — the same session used
              when you log into the website. The extension never directly reads or transmits
              this cookie.
            </LI>
          </UL>

          <H3 theme={t}>Usage Data</H3>
          <P theme={t}>
            We collect standard server logs (IP address, browser type, pages visited, timestamps)
            for security and debugging. We do not use third-party analytics services that
            track you across the web.
          </P>
        </Section>

        {/* How We Use Your Data */}
        <Section title="How We Use Your Data" theme={t}>
          <UL theme={t}>
            <LI theme={t}>To provide the resume builder, ATS scoring, and job search features.</LI>
            <LI theme={t}>To save your work and sync it across devices.</LI>
            <LI theme={t}>To authenticate you securely.</LI>
            <LI theme={t}>
              To send transactional emails (password reset, account confirmation) —
              no marketing emails without explicit opt-in.
            </LI>
            <LI theme={t}>
              To improve the service using aggregate, anonymized usage patterns only.
            </LI>
            <LI theme={t}>
              We do <Strong theme={t}>not</Strong> use your resume content or job data
              to train AI models.
            </LI>
          </UL>
        </Section>

        {/* Data Storage & Security */}
        <Section title="Data Storage and Security" theme={t}>
          <P theme={t}>
            Your data is stored on servers hosted by Railway (railway.app). Data is encrypted
            in transit via TLS. Passwords are hashed using bcrypt. Session tokens are stored
            server-side only. LinkedIn access tokens are discarded after the OAuth flow and
            are not written to the database or logs.
          </P>
          <P theme={t}>
            We retain your data for as long as your account is active. If you delete your
            account, all associated data is permanently deleted within 30 days.
          </P>
        </Section>

        {/* Third-Party Services */}
        <Section title="Third-Party Services" theme={t}>
          <P theme={t}>We use the following third-party services:</P>
          <UL theme={t}>
            <LI theme={t}>
              <Strong theme={t}>Railway</Strong> — infrastructure hosting. Subject to Railway's
              privacy policy.
            </LI>
            <LI theme={t}>
              <Strong theme={t}>Anthropic</Strong> — AI resume generation and ATS analysis.
              Job descriptions and resume content are sent to Anthropic's API. Anthropic does
              not use API inputs to train models.
            </LI>
            <LI theme={t}>
              <Strong theme={t}>SerpApi</Strong> — job search results. Search queries are
              sent to SerpApi's servers; no personal data is included in search queries.
            </LI>
            <LI theme={t}>
              <Strong theme={t}>Adzuna</Strong> — job listings via their official publisher API.
            </LI>
            <LI theme={t}>
              <Strong theme={t}>Clearbit Logo API</Strong> — company logo images. We request
              logos by company domain only; no user data is sent.
            </LI>
            <LI theme={t}>
              <Strong theme={t}>LinkedIn OAuth</Strong> (optional) — if you choose to sign in
              with LinkedIn, LinkedIn provides your name and email to us under their OAuth
              terms. We do not receive any other LinkedIn data.
            </LI>
          </UL>
        </Section>

        {/* Your Rights */}
        <Section title="Your Rights" theme={t}>
          <UL theme={t}>
            <LI theme={t}>
              <Strong theme={t}>Access:</Strong> You can view data we hold about you
              in your account settings.
            </LI>
            <LI theme={t}>
              <Strong theme={t}>Export:</Strong> You can export your resumes and job list
              at any time.
            </LI>
            <LI theme={t}>
              <Strong theme={t}>Delete:</Strong> You can delete your account and all
              associated data from account settings or by emailing us.
            </LI>
            <LI theme={t}>
              <Strong theme={t}>Correction:</Strong> You can update your profile information
              at any time.
            </LI>
            <LI theme={t}>
              <Strong theme={t}>GDPR / CCPA:</Strong> If you are located in the EU or
              California, you have additional rights under GDPR and CCPA respectively.
              Contact us to exercise these rights.
            </LI>
          </UL>
        </Section>

        {/* Cookies */}
        <Section title="Cookies" theme={t}>
          <P theme={t}>
            We use a single session cookie to keep you logged in. This cookie is HttpOnly
            and Secure — JavaScript cannot read it. We do not use advertising cookies,
            tracking pixels, or third-party analytics cookies.
          </P>
        </Section>

        {/* Children */}
        <Section title="Children's Privacy" theme={t}>
          <P theme={t}>
            Resume Master is not directed at children under 13. We do not knowingly collect
            data from anyone under 13. If you believe a child has provided us data, contact
            us and we will delete it promptly.
          </P>
        </Section>

        {/* Changes */}
        <Section title="Changes to This Policy" theme={t}>
          <P theme={t}>
            We may update this policy from time to time. The "Last updated" date at the top
            reflects any changes. For significant changes we will notify registered users
            by email.
          </P>
        </Section>

        {/* Contact */}
        <section style={{
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: 12,
          padding: "24px 28px",
          marginBottom: 40,
        }}>
          <h2 style={{
            fontSize: 18, fontWeight: 800, color: t.text,
            marginBottom: 12, fontFamily: "'Barlow Condensed', 'DM Sans', system-ui",
          }}>
            Contact Us
          </h2>
          <P theme={t}>Questions about this policy or your data:</P>
          <a href={`mailto:${CONTACT_EMAIL}`} style={{
            display: "inline-block",
            fontSize: 14, fontWeight: 600,
            color: t.accent, textDecoration: "none",
            borderBottom: `1px solid transparent`,
            transition: "border-color 180ms ease",
          }}
          onMouseEnter={e => e.currentTarget.style.borderBottomColor = t.accent}
          onMouseLeave={e => e.currentTarget.style.borderBottomColor = "transparent"}>
            {CONTACT_EMAIL}
          </a>
        </section>

        {/* Footer nav */}
        <div style={{
          display: "flex", alignItems: "center", gap: 16,
          paddingTop: 24, borderTop: `1px solid ${t.border}`,
          fontSize: 13, color: t.textDim,
        }}>
          <Link to="/" style={{ color: t.textMuted, textDecoration: "none" }}
            onMouseEnter={e => e.currentTarget.style.color = t.accent}
            onMouseLeave={e => e.currentTarget.style.color = t.textMuted}>
            ← Back to Resume Master
          </Link>
          <span>·</span>
          <Link to="/terms" style={{ color: t.textMuted, textDecoration: "none" }}
            onMouseEnter={e => e.currentTarget.style.color = t.accent}
            onMouseLeave={e => e.currentTarget.style.color = t.textMuted}>
            Terms of Service
          </Link>
          <span>·</span>
          <Link to="/contact" style={{ color: t.textMuted, textDecoration: "none" }}
            onMouseEnter={e => e.currentTarget.style.color = t.accent}
            onMouseLeave={e => e.currentTarget.style.color = t.textMuted}>
            Contact
          </Link>
        </div>

      </main>

      <Footer />
    </div>
  );
}
