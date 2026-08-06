import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";
import { StackSection, OrgSection, HiringSection } from "../components/CompanyKbSections.jsx";

const STATUS_COPY = {
  consistent: { label: "Consistent", color: "#16a34a", bg: "#dcfce7" },
  flagged:    { label: "Flagged inconsistency", color: "#991b1b", bg: "#fee2e2" },
  no_claim:   { label: "No claim to check", color: "#6b7280", bg: "var(--color-surface-offset)" },
};

function CompanyKbCard({ company, theme }) {
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!company) { setProfile(null); return; }
    let cancelled = false;
    setLoading(true); setError("");
    api(`/api/company/${encodeURIComponent(company)}`)
      .then(d => { if (!cancelled) setProfile(d); })
      .catch(e => { if (!cancelled) setError(e.message || "Could not load company data."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [company]);

  if (!company) return null;
  return (
    <section style={{ border: `1px solid ${theme.border}`, background: theme.surface,
      borderRadius: 8, padding: 18, display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 800,
        fontSize: 16, letterSpacing: "0.06em", textTransform: "uppercase", color: theme.text }}>
        {company} — KB Reference
      </div>
      {loading && <div style={{ fontSize: 12, color: theme.textMuted }}>Loading…</div>}
      {error && !loading && (
        <div style={{ background: "#fee2e2", color: "#991b1b", borderRadius: 6, padding: "8px 12px", fontSize: 12 }}>
          {error}
        </div>
      )}
      {!loading && !error && profile && !profile.hasData && (
        <div style={{ fontSize: 12, color: theme.textMuted }}>Not enough data on {company} yet.</div>
      )}
      {!loading && !error && profile?.hasData && (
        <>
          <StackSection stack={profile.stack} theme={theme} />
          <OrgSection orgUnits={profile.orgUnits} theme={theme} />
          <HiringSection signal={profile.hiringSignal} theme={theme} />
        </>
      )}
    </section>
  );
}

function ConsistencyCheckCard({ company, theme }) {
  const [resumeText, setResumeText] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  const runCheck = async () => {
    if (!company || !resumeText.trim()) return;
    setChecking(true); setError(""); setResult(null);
    try {
      const d = await api(`/api/company/${encodeURIComponent(company)}/consistency-check`, {
        method: "POST",
        body: JSON.stringify({ resumeText }),
      });
      setResult(d);
    } catch (e) {
      setError(e.message || "Could not run the consistency check.");
    } finally {
      setChecking(false);
    }
  };

  if (!company) return null;
  const statusCopy = result ? STATUS_COPY[result.status] : null;

  return (
    <section style={{ border: `1px solid ${theme.border}`, background: theme.surface,
      borderRadius: 8, padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 800,
          fontSize: 16, letterSpacing: "0.06em", textTransform: "uppercase", color: theme.text }}>
          Candidate-Claim Consistency Check
        </div>
        <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 4, lineHeight: 1.5 }}>
          Paste a candidate's resume text below. This checks whether their {company} claims
          cohere with {company}'s public job-posting KB above — it is advisory evidence, not a
          verdict on the person, and nothing pasted here is stored.
        </div>
      </div>
      <textarea
        value={resumeText}
        onChange={e => setResumeText(e.target.value)}
        rows={8}
        placeholder={`Paste the candidate's resume text here (checked against ${company})...`}
        style={{ width: "100%", borderRadius: 6, border: `1px solid ${theme.border}`,
                 background: theme.bg, color: theme.text, fontSize: 12,
                 padding: "8px 10px", resize: "vertical", fontFamily: "inherit",
                 outline: "none", boxSizing: "border-box" }}
      />
      <button onClick={runCheck} disabled={checking || !resumeText.trim()}
        style={{ border: "none", borderRadius: 6, padding: "9px 14px", fontWeight: 800, fontSize: 12,
                 cursor: checking || !resumeText.trim() ? "not-allowed" : "pointer",
                 opacity: checking || !resumeText.trim() ? 0.6 : 1,
                 background: theme.accent, color: "#0f0f0f", alignSelf: "flex-start" }}>
        {checking ? "Checking…" : "Check consistency"}
      </button>
      {error && (
        <div style={{ background: "#fee2e2", color: "#991b1b", borderRadius: 6, padding: "8px 12px", fontSize: 12 }}>
          {error}
        </div>
      )}
      {result && statusCopy && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ alignSelf: "flex-start", fontSize: 11, fontWeight: 800, padding: "3px 10px",
                         borderRadius: 999, background: statusCopy.bg, color: statusCopy.color }}>
            {statusCopy.label}
          </span>
          {result.findings.map((f, i) => (
            <div key={i} style={{ fontSize: 12, color: theme.text, background: theme.surfaceHigh,
                                   border: `1px solid ${theme.border}`, borderRadius: 6, padding: "8px 10px" }}>
              {f.message}
              {f.evidence?.length > 0 && (
                <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 4 }}>
                  {f.evidence.join(" ")}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function RecruiterPanel() {
  const { theme } = useTheme();
  const location = useLocation();
  const [companyInput, setCompanyInput] = useState("");
  const [activeCompany, setActiveCompany] = useState("");

  // Deep-linked from a job card's company (JobCard.jsx) via /app/recruiter?company=X.
  useEffect(() => {
    const fromQuery = new URLSearchParams(location.search).get("company");
    if (fromQuery) { setCompanyInput(fromQuery); setActiveCompany(fromQuery); }
  }, [location.search]);

  const load = () => setActiveCompany(companyInput.trim());

  return (
    <div style={{ flex: 1, overflowY: "auto", background: "var(--color-bg)", padding: "28px 24px 44px" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 800,
            fontSize: 24, letterSpacing: "0.06em", textTransform: "uppercase", color: theme.text }}>
            Recruiter
          </div>
          <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 4, lineHeight: 1.6, maxWidth: 560 }}>
            Companies and roles only — a KB reference and candidate-claim consistency aid, not a
            background-check or identity-linked service. No individual dossiers are built or
            stored here.
          </div>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={companyInput}
            onChange={e => setCompanyInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && load()}
            placeholder="Company name (e.g. Figma)"
            style={{ flex: 1, border: `1px solid ${theme.border}`, borderRadius: 6,
                     background: theme.surface, color: theme.text, fontSize: 13,
                     padding: "9px 12px", outline: "none" }}
          />
          <button onClick={load} disabled={!companyInput.trim()}
            style={{ border: "none", borderRadius: 6, padding: "9px 16px", fontWeight: 800, fontSize: 12,
                     cursor: companyInput.trim() ? "pointer" : "not-allowed",
                     opacity: companyInput.trim() ? 1 : 0.6,
                     background: theme.accent, color: "#0f0f0f" }}>
            Load
          </button>
        </div>

        <CompanyKbCard company={activeCompany} theme={theme} />
        <ConsistencyCheckCard company={activeCompany} theme={theme} />

        {!activeCompany && (
          <div style={{ fontSize: 12, color: theme.textMuted, textAlign: "center", padding: "40px 0" }}>
            Enter a company to load its KB reference and run a consistency check.
          </div>
        )}
      </div>
    </div>
  );
}
