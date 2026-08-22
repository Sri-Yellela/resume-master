import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";
import { StackSection, OrgSection, HiringSection } from "./CompanyKbSections.jsx";

export default function CompanyViewModal({ company, onClose }) {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError("");
    api(`/api/company/${encodeURIComponent(company)}`)
      .then(d => { if (!cancelled) setProfile(d); })
      .catch(e => { if (!cancelled) setError(e.message || "Could not load company data."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [company]);

  const overlay = {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 9000,
    display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
  };
  const modal = {
    background: theme.surface, border: `1px solid ${theme.border}`,
    borderRadius: 12, width: "100%", maxWidth: 480, maxHeight: "85vh",
    display: "flex", flexDirection: "column", overflow: "hidden",
    boxShadow: "0 24px 80px rgba(0,0,0,0.35)",
  };
  const hdr = {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "14px 18px", borderBottom: `1px solid ${theme.border}`, flexShrink: 0,
  };

  // Portal to document.body: JobCard's root has `transform` + `overflow:hidden`, which would
  // otherwise turn this `position:fixed` overlay into a containing-block child of the card and
  // clip it invisible instead of covering the viewport (matches JobDetailPanel's own portal use).
  return createPortal(
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={modal}>
        <div style={hdr}>
          <div style={{ fontWeight: 800, fontSize: 15, color: theme.text }}>{company}</div>
          <button onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer",
                     color: theme.textMuted, fontSize: 18, lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 18 }}>
          {loading && <div style={{ fontSize: 12, color: theme.textMuted }}>Loading…</div>}
          {error && !loading && (
            <div style={{ background: "#fee2e2", color: "#991b1b", borderRadius: 6, padding: "8px 12px", fontSize: 12 }}>
              {error}
            </div>
          )}
          {!loading && !error && profile && !profile.hasData && (
            <div style={{ fontSize: 12, color: theme.textMuted, textAlign: "center", padding: "20px 0" }}>
              Not enough data on {company} yet.
            </div>
          )}
          {!loading && !error && profile?.hasData && (
            <>
              <StackSection stack={profile.stack} postings={profile.stackPostings} theme={theme} />
              <OrgSection orgUnits={profile.orgUnits} total={profile.orgUnitsTotal} theme={theme} />
              <HiringSection signal={profile.hiringSignal} theme={theme} />
            </>
          )}
        </div>
        {/* FE-6: same KB reference, plus the recruiter's candidate-claim consistency check */}
        <div style={{ padding: "10px 18px", borderTop: `1px solid ${theme.border}`, flexShrink: 0 }}>
          <button
            onClick={() => { onClose(); navigate(`/app/recruiter?company=${encodeURIComponent(company)}`); }}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 0,
                     color: theme.accent, fontSize: 12, fontWeight: 700 }}>
            Open in Recruiter view →
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
