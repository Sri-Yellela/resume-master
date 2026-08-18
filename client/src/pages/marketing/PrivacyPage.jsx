// client/src/pages/marketing/PrivacyPage.jsx
import { Link } from "react-router-dom";
import ScrollDock from "../../components/ScrollDock.jsx";
import { Footer } from "../../components/Footer.jsx";

// Effective date, not just "last touched". The Chrome Web Store rules that took effect on
// 2026-08-01 require a policy to state when it takes effect and to commit to telling users about
// material changes to data handling — see the "Changes to This Policy" section.
const EFFECTIVE_DATE = 'August 18, 2026';
const CONTACT_EMAIL  = 'privacy@resumemaster.one';

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
            Effective: {EFFECTIVE_DATE}
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
            When you search for jobs on our site, or capture the job you are viewing with the
            browser extension, we store job listing data (title, company, location, description,
            URL) in association with your account. This data comes from public job boards and
            pages you actively visit — we do not access job data without your interaction.
          </P>
          <P>
            The extension has <Strong>one</Strong> capture action, and the toolbar button and the
            keyboard shortcut are two ways of triggering it. They send the same data to the same
            place, so capturing a job twice updates one record rather than creating a second.
          </P>

          <H3>Browser Extension</H3>
          <P>
            The Resume Master browser extension reads job listing pages that you actively visit
            on six job boards — LinkedIn, Indeed, Glassdoor, Lever, Greenhouse and Workable — and
            only on the individual job-posting pages of those sites, not the sites as a whole.
            Specifically:
          </P>
          <UL>
            <LI>
              It reads the <Strong>visible text</Strong> of a job posting to extract
              title, company, location, and description. It does this when you capture the job,
              by clicking the toolbar button or pressing the keyboard shortcut.
            </LI>
            <LI>
              It reads the <Strong>address (URL) of the tab you invoke it on</Strong>, to
              recognise whether that page is a supported job posting. It cannot see the address
              of any other tab, and it does not record where you go.
            </LI>
            <LI>
              If you click <Strong>ATS Score Tool</Strong> while on a job posting, it copies the
              visible text of that page and opens your Resume Master ATS Score page with the text
              already filled in. That text travels in the address of the page it opens, which
              means it may appear in our ordinary server logs.
            </LI>
            <LI>
              Data extracted by the extension is sent to resumemaster.one and associated with
              your logged-in account using a browser session cookie — the same session used
              when you log into the website. Because it is attached to your account, captured job
              data is personal information, and we treat it as such. The extension never itself
              reads or transmits the cookie's contents.
            </LI>
            <LI>
              Job descriptions you capture may be sent to Anthropic's API when you use them for
              ATS scoring or resume generation, as described under Third-Party Services below.
            </LI>
            <LI>
              It does <Strong>not</Strong> read, store, or transmit your session cookies, login
              credentials, or any authentication tokens for any site.
            </LI>
            <LI>
              It does <Strong>not</Strong> read any page you have not navigated to yourself, and
              does <Strong>not</Strong> collect your browsing history.
            </LI>
            <LI>
              It does <Strong>not</Strong> read your messages, connections, or profile feed on any
              site, and does <Strong>not</Strong> read any page outside the six job boards above —
              with the single exception of an application form you have opened and invoked it on
              yourself, described under "Filling an Application" below.
            </LI>
            <LI>
              It does <Strong>not</Strong> collect lists of jobs. It reads the one posting you are
              looking at. It does not gather search results, job lists, or your saved-jobs list on
              any site — an earlier version of the extension could read a LinkedIn saved-jobs
              list, and that capability was removed.
            </LI>
            <LI>
              It contains <Strong>no remotely hosted code</Strong>. Everything it runs is in the
              package you install from the Chrome Web Store; it never downloads or executes code
              fetched from a server.
            </LI>
          </UL>

          <H3>What the Extension Stores in Your Browser</H3>
          <P>
            The extension keeps three things in your browser's own extension storage. None of it
            is sent anywhere by the extension, and all of it disappears when you uninstall it.
          </P>
          <UL>
            <LI>
              <Strong>Your capture shortcut preference</Strong>, if you change it — a key
              combination. Kept until you change it again or uninstall, and synced by Chrome
              across your signed-in browsers.
            </LI>
            <LI>
              <Strong>The result of your most recent capture</Strong> — the job title and whether
              it succeeded — so the popup can show you the outcome of a capture you made with the
              keyboard while the popup was closed. Overwritten by the next capture.
            </LI>
            <LI>
              <Strong>The prepared answers for an application in progress</Strong>, during a form
              fill only. Held in memory-backed storage that is cleared when you restart your
              browser, expiring after ten minutes and deleted when the tab closes.
            </LI>
          </UL>

          <H3>Filling an Application</H3>
          <P>
            Some employers require an account, or a CAPTCHA, before they will accept an
            application. You cross that sign-in yourself, in your own browser. Once you are
            through it and looking at the application form, you can invoke the extension to fill
            it in. Specifically:
          </P>
          <UL>
            <LI>
              The extension only reaches that page because <Strong>you invoked it there</Strong>.
              It holds no standing permission for any employer or job-portal site; pressing the
              shortcut is what grants it access, to that one tab, at that moment.
            </LI>
            <LI>
              It fetches from your Resume Master account the details you have already saved there
              — your name, email, phone, postal address, work-authorization answers and your
              resume — and enters them into that employer's form. This is{" "}
              <Strong>your own data, going to the employer you chose</Strong>, and it goes nowhere
              else.
            </LI>
            <LI>
              It shows you every answer it filled in, and where each one came from, before you do
              anything. You can change any of them.
            </LI>
            <LI>
              It does <Strong>not</Strong> submit the application. You press the employer's own
              submit button.
            </LI>
            <LI>
              It does <Strong>not</Strong> sign you in, create an account for you, or attempt a
              CAPTCHA, and it never reads or stores any employer's password, session cookie or
              verification code.
            </LI>
            <LI>
              The prepared answers are held only while you are working on that application: in
              memory-backed browser storage, for ten minutes, and cleared when the tab closes.
            </LI>
          </UL>

          <H3>Learning an Application Form (optional, off by default)</H3>
          <P>
            If you turn it on, the extension can report back the <Strong>structure</Strong> of an
            application form it filled — the questions it asks, their types, which are required,
            and the options in any dropdowns. We use this so the same employer's form is
            recognised for other candidates. This setting is <Strong>off unless you switch it
            on</Strong>, and it is enforced on our servers, not just in the extension.
          </P>
          <UL>
            <LI>
              We store the form's <Strong>questions</Strong>, never your{" "}
              <Strong>answers</Strong> — not the values you typed, not anything about you, and
              nothing from the page other than the form's shape.
            </LI>
            <LI>
              What is stored is a fact about the employer's form, not about you. It is not linked
              to your account.
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
              <Strong>Apify</Strong> (optional) — job search, using an Apify account you connect
              yourself with your own token. When you run a search, the job titles, locations and
              filters for that search are sent to Apify to run a public job-board search. Your
              resume, your profile and any captured job data are not sent. If you do not connect
              an Apify token, nothing is sent to them.
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
            We may update this policy from time to time. The "Effective" date at the top reflects
            when the current version took effect.
          </P>
          <P>
            If we make a <Strong>material change to how we handle your data</Strong> — collecting
            something new, using it for a new purpose, or sharing it with someone new — we will
            tell registered users by email <Strong>before that change takes effect</Strong>, and
            we will not apply it retroactively to data already collected under an earlier version
            of this policy. This applies to the browser extension as well as the website: if a new
            version of the extension would collect something this policy does not already
            describe, the policy is updated and users are notified first.
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
