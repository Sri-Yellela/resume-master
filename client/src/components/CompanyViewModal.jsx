import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";

// growth_score = (new - expired) / max(1, open) — see services/jobs/hiringSignals.js.
// This only ever turns it into a plain-language line; it never re-derives the number.
function hiringSummaryLine(signal) {
  if (!signal) return null;
  const { growthScore, openCount, domainBreakdown } = signal;
  if (!openCount) return "No active postings right now.";
  const [topDomain] = Object.entries(domainBreakdown || {}).sort((a, b) => b[1] - a[1])[0] || [];
  if (growthScore > 0.15) return `Actively hiring${topDomain ? ` — growing ${topDomain}` : ""}.`;
  if (growthScore > -0.05) return `Steady hiring pace${topDomain ? ` (mostly ${topDomain})` : ""}.`;
  return "Hiring has slowed recently.";
}

function SectionLabel({ children, theme }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, marginBottom: 8,
                  textTransform: "uppercase", letterSpacing: "0.06em" }}>
      {children}
    </div>
  );
}

function StackSection({ stack, theme }) {
  if (!stack?.length) return null;
  return (
    <div>
      <SectionLabel theme={theme}>Stack</SectionLabel>
      <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 8 }}>
        Based on {stack.reduce((n, s) => n + s.postingCount, 0)} recent posting mentions — evidence, not confirmation.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {stack.map(s => (
          <span key={s.skill} title={s.fresh ? "Seen recently" : "Not reinforced by a recent posting"}
            style={{ fontSize: 11, padding: "3px 9px", borderRadius: 999,
                     background: theme.surfaceHigh, color: s.fresh ? theme.text : theme.textMuted,
                     opacity: s.fresh ? 1 : 0.55, border: `1px solid ${theme.border}` }}>
            {s.skill}
          </span>
        ))}
      </div>
    </div>
  );
}

function ConfidenceBar({ confidence, theme }) {
  const pct = Math.round(Math.max(0, Math.min(1, confidence)) * 100);
  return (
    <div style={{ width: 48, height: 5, borderRadius: 999, background: theme.border, overflow: "hidden", flexShrink: 0 }}
      title={`${pct}% confidence`}>
      <div style={{ width: `${pct}%`, height: "100%", background: pct >= 60 ? "#16a34a" : "#d97706" }} />
    </div>
  );
}

function OrgSection({ orgUnits, theme }) {
  if (!orgUnits?.length) return null;
  return (
    <div>
      <SectionLabel theme={theme}>Org</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {orgUnits.map(u => {
          const verified = u.status === "confirmed";
          return (
            <div key={u.orgUnit} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ConfidenceBar confidence={u.confidence} theme={theme} />
              <span style={{ fontSize: 12, color: theme.text, flex: 1, minWidth: 0,
                             overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {u.orgUnit}
              </span>
              <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 7px", borderRadius: 999,
                             background: verified ? "#dcfce7" : theme.surfaceHigh,
                             color: verified ? "#166534" : theme.textMuted, whiteSpace: "nowrap" }}>
                {verified ? "verified" : "inferred"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HiringSection({ signal, theme }) {
  if (!signal) return null;
  const line = hiringSummaryLine(signal);
  return (
    <div>
      <SectionLabel theme={theme}>Hiring Signal</SectionLabel>
      <div style={{ fontSize: 12, color: theme.text, marginBottom: 8 }}>{line}</div>
      <div style={{ display: "flex", gap: 14, fontSize: 11, color: theme.textMuted }}>
        <span><strong style={{ color: theme.text }}>{signal.openCount}</strong> open</span>
        <span><strong style={{ color: "#16a34a" }}>{signal.newCount}</strong> new</span>
        <span><strong style={{ color: "#dc2626" }}>{signal.expiredCount}</strong> expired</span>
        <span style={{ marginLeft: "auto" }}>30d window</span>
      </div>
    </div>
  );
}

export default function CompanyViewModal({ company, onClose }) {
  const { theme } = useTheme();
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
              <StackSection stack={profile.stack} theme={theme} />
              <OrgSection orgUnits={profile.orgUnits} theme={theme} />
              <HiringSection signal={profile.hiringSignal} theme={theme} />
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
