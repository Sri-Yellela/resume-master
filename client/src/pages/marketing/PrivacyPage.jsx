// client/src/pages/marketing/PrivacyPage.jsx
import { Link } from "react-router-dom";
import ScrollDock from "../../components/ScrollDock.jsx";
import { Footer } from "../../components/Footer.jsx";

const LAST_UPDATED  = 'May 19, 2026';
const CONTACT_EMAIL = 'privacy@resumemaster.one';

function Section({ title, children }) {
  return (
    <section style={{ marginBottom: 40 }}>
      <h2 style={{
        fontSize: 18, fontWeight: 800, color: "var(--color-text)",
        marginBottom: 12, paddingBottom: 8,
        borderBottom: "1px solid var(--color-border)",
        fontFamily: "'Barlow Condensed', 'DM Sans', system-ui",
        letterSpacing: "-0.2px",
      }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function P({ children }) {
  return (
    <p style={{
      fontSize: 14, color: "var(--color-text-muted)",
      lineHeight: 1.8, margin: "0 0 12px",
      maxWidth: "66ch",
    }}>
      {children}
    </p>
  );
}

function UL({ children }) {
  return (
    <ul style={{
      paddingLeft: 22, margin: "0 0 12px",
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      {children}
    </ul>
  );
}

function LI({ children }) {
  return (
    <li style={{
      fontSize: 14, color: "var(--color-text-muted)",
      lineHeight: 1.75, maxWidth: "64ch",
    }}>
      {children}
    </li>
  );
}

function H3({ children }) {
  return (
    <h3 style={{
      fontSize: 15, fontWeight: 700, color: "var(--color-text)",
      margin: "20px 0 8px",
    }}>
      {children}
    </h3>
  );
}

function Strong({ children }) {
  return <strong style={{ fontWeight: 700, color: "var(--color-text)" }}>{children}</strong>;
}

export function PrivacyPage() {
  return (
    <div className="scroll-dock-page" style={{
      minHeight: "100vh", display: "flex", flexDirection: "column",
      background: "transparent", color: "var(--color-text)",
      fontFamily: "'DM Sans', system-ui, sans-serif",
    }}>
      <ScrollDock variant="marketing" />

      <main style={{ flex: 1, maxWidth: 720, margin: "0 auto", padding: "64px 24px 80px" }}>

        {/* Header */}
        <header style={{ marginBottom: 48, paddingBottom: 24, borderBottom: "1px solid var(--color-border)" }}>
          <h1 style={{
            fontSize: "clamp(28px, 4vw, 44px)", fontWeight: 900,
            letterSpacing: "-1px", color: "var(--color-text)", marginBottom: 8,
            lineHeight: 1.1, fontFamily: "'Barlow Condensed', 'DM Sans', system-ui",
          }}>
            Privacy Policy
          </h1>
          <p style={{ fontSize: 13, color: "var(--color-text-faint)" }}>
            Last updated: {LAST_UPDATED}
          </p>
        </header>

        {/* Overview */}
        <Section title="Overview">
          <P>
            Resume Master ("we", "us", "our") operates resumemaster.one and the Resume Master
            browser extension. This policy explains what data we collect, how we use it, and
            your rights over your information.
          </P>
          <P>
            <Strong>We do not sell your personal data.</Strong> We do not share it
            with third parties except as described in this policy.
          </P>
        </Section>

        {/* Information We Collect */}
        <Section title="Information We Collect">
          <H3>Account Information</H3>
          <P>
            When you create an account, we collect your email address and a hashed password
            (we never store plaintext passwords). If you sign in with LinkedIn OAuth, we receive
            your name and email address only — no LinkedIn profile data, posts, connections,
            or activity.
          </P>

          <H3>Resume Data</H3>
          <P>
            We store the resume content you create or upload: work history, education, skills,
            and contact information. This data is stored solely to provide the resume-building
            service to you. You can delete it at any time from your account settings.
          </P>

          <H3>Job Listings</H3>
          <P>
            When you search for jobs, save jobs, or import jobs via the browser extension, we
            store job listing data (title, company, location, description, URL) in association
            with your account. This data comes from public job boards and pages you actively
            visit — we do not access job data without your interaction.
          </P>

          <H3>Browser Extension</H3>
          <P>
            The Resume Master browser extension reads job listing pages that you actively visit
            on LinkedIn, Indeed, Glassdoor, Lever, Greenhouse, and Workable. Specifically:
          </P>
          <UL>
            <LI>
              It reads the <Strong>visible text</Strong> of job listing pages to extract
              title, company, location, and description.
            </LI>
            <LI>
              It does <Strong>not</Strong> read, store, or transmit your LinkedIn
              session cookies, login credentials, or any authentication tokens.
            </LI>
            <LI>
              It does <Strong>not</Strong> access any LinkedIn page you have not
              navigated to yourself.
            </LI>
            <LI>
              It does <Strong>not</Strong> read your LinkedIn messages, connections,
              profile feed, or any page other than job listings and your saved jobs list.
            </LI>
            <LI>
              Data extracted by the extension is sent to resumemaster.one and associated with
              your logged-in account using a browser session cookie — the same session used
              when you log into the website. The extension never directly reads or transmits
              this cookie.
            </LI>
          </UL>

          <H3>Usage Data</H3>
          <P>
            We collect standard server logs (IP address, browser type, pages visited, timestamps)
            for security and debugging. We do not use third-party analytics services that
            track you across the web.
          </P>
        </Section>

        {/* How We Use Your Data */}
        <Section title="How We Use Your Data">
          <UL>
            <LI>To provide the resume builder, ATS scoring, and job search features.</LI>
            <LI>To save your work and sync it across devices.</LI>
            <LI>To authenticate you securely.</LI>
            <LI>
              To send transactional emails (password reset, account confirmation) —
              no marketing emails without explicit opt-in.
            </LI>
            <LI>
              To improve the service using aggregate, anonymized usage patterns only.
            </LI>
            <LI>
              We do <Strong>not</Strong> use your resume content or job data
              to train AI models.
            </LI>
          </UL>
        </Section>

        {/* Data Storage & Security */}
        <Section title="Data Storage and Security">
          <P>
            Your data is stored on servers hosted by Railway (railway.app). Data is encrypted
            in transit via TLS. Passwords are hashed using bcrypt. Session tokens are stored
            server-side only. LinkedIn access tokens are discarded after the OAuth flow and
            are not written to the database or logs.
          </P>
          <P>
            We retain your data for as long as your account is active. If you delete your
            account, all associated data is permanently deleted within 30 days.
          </P>
        </Section>

        {/* Third-Party Services */}
        <Section title="Third-Party Services">
          <P>We use the following third-party services:</P>
          <UL>
            <LI>
              <Strong>Railway</Strong> — infrastructure hosting. Subject to Railway's
              privacy policy.
            </LI>
            <LI>
              <Strong>Anthropic</Strong> — AI resume generation and ATS analysis.
              Job descriptions and resume content are sent to Anthropic's API. Anthropic does
              not use API inputs to train models.
            </LI>
            <LI>
              <Strong>SerpApi</Strong> — job search results. Search queries are
              sent to SerpApi's servers; no personal data is included in search queries.
            </LI>
            <LI>
              <Strong>Adzuna</Strong> — job listings via their official publisher API.
            </LI>
            <LI>
              <Strong>Clearbit Logo API</Strong> — company logo images. We request
              logos by company domain only; no user data is sent.
            </LI>
            <LI>
              <Strong>LinkedIn OAuth</Strong> (optional) — if you choose to sign in
              with LinkedIn, LinkedIn provides your name and email to us under their OAuth
              terms. We do not receive any other LinkedIn data.
            </LI>
          </UL>
        </Section>

        {/* Your Rights */}
        <Section title="Your Rights">
          <UL>
            <LI>
              <Strong>Access:</Strong> You can view data we hold about you
              in your account settings.
            </LI>
            <LI>
              <Strong>Export:</Strong> You can export your resumes and job list
              at any time.
            </LI>
            <LI>
              <Strong>Delete:</Strong> You can delete your account and all
              associated data from account settings or by emailing us.
            </LI>
            <LI>
              <Strong>Correction:</Strong> You can update your profile information
              at any time.
            </LI>
            <LI>
              <Strong>GDPR / CCPA:</Strong> If you are located in the EU or
              California, you have additional rights under GDPR and CCPA respectively.
              Contact us to exercise these rights.
            </LI>
          </UL>
        </Section>

        {/* Cookies */}
        <Section title="Cookies">
          <P>
            We use a single session cookie to keep you logged in. This cookie is HttpOnly
            and Secure — JavaScript cannot read it. We do not use advertising cookies,
            tracking pixels, or third-party analytics cookies.
          </P>
        </Section>

        {/* Children */}
        <Section title="Children's Privacy">
          <P>
            Resume Master is not directed at children under 13. We do not knowingly collect
            data from anyone under 13. If you believe a child has provided us data, contact
            us and we will delete it promptly.
          </P>
        </Section>

        {/* Changes */}
        <Section title="Changes to This Policy">
          <P>
            We may update this policy from time to time. The "Last updated" date at the top
            reflects any changes. For significant changes we will notify registered users
            by email.
          </P>
        </Section>

        {/* Contact */}
        <section style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: 12,
          padding: "24px 28px",
          marginBottom: 40,
        }}>
          <h2 style={{
            fontSize: 18, fontWeight: 800, color: "var(--color-text)",
            marginBottom: 12, fontFamily: "'Barlow Condensed', 'DM Sans', system-ui",
          }}>
            Contact Us
          </h2>
          <P>Questions about this policy or your data:</P>
          <a href={`mailto:${CONTACT_EMAIL}`} style={{
            display: "inline-block",
            fontSize: 14, fontWeight: 600,
            color: "var(--color-primary)", textDecoration: "none",
            borderBottom: "1px solid transparent",
            transition: "border-color 180ms ease",
          }}
          onMouseEnter={e => e.currentTarget.style.borderBottomColor = "var(--color-primary)"}
          onMouseLeave={e => e.currentTarget.style.borderBottomColor = "transparent"}>
            {CONTACT_EMAIL}
          </a>
        </section>

        {/* Footer nav */}
        <div style={{
          display: "flex", alignItems: "center", gap: 16,
          paddingTop: 24, borderTop: "1px solid var(--color-border)",
          fontSize: 13, color: "var(--color-text-faint)",
        }}>
          <Link to="/" style={{ color: "var(--color-text-muted)", textDecoration: "none" }}
            onMouseEnter={e => e.currentTarget.style.color = "var(--color-primary)"}
            onMouseLeave={e => e.currentTarget.style.color = "var(--color-text-muted)"}>
            ← Back to Resume Master
          </Link>
          <span>·</span>
          <Link to="/terms" style={{ color: "var(--color-text-muted)", textDecoration: "none" }}
            onMouseEnter={e => e.currentTarget.style.color = "var(--color-primary)"}
            onMouseLeave={e => e.currentTarget.style.color = "var(--color-text-muted)"}>
            Terms of Service
          </Link>
          <span>·</span>
          <Link to="/contact" style={{ color: "var(--color-text-muted)", textDecoration: "none" }}
            onMouseEnter={e => e.currentTarget.style.color = "var(--color-primary)"}
            onMouseLeave={e => e.currentTarget.style.color = "var(--color-text-muted)"}>
            Contact
          </Link>
        </div>

      </main>

      <Footer />
    </div>
  );
}
