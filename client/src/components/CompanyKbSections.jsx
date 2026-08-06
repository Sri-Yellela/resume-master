// Shared KB-reference rendering (stack / org / hiring signal) — used by both the seeker-facing
// CompanyViewModal (FE-4) and the RecruiterPanel (FE-6) so the two surfaces render the exact
// same evidence-labeled blocks instead of maintaining two copies.

// growth_score = (new - expired) / max(1, open) — see services/jobs/hiringSignals.js.
// This only ever turns it into a plain-language line; it never re-derives the number.
export function hiringSummaryLine(signal) {
  if (!signal) return null;
  const { growthScore, openCount, domainBreakdown } = signal;
  if (!openCount) return "No active postings right now.";
  const [topDomain] = Object.entries(domainBreakdown || {}).sort((a, b) => b[1] - a[1])[0] || [];
  if (growthScore > 0.15) return `Actively hiring${topDomain ? ` — growing ${topDomain}` : ""}.`;
  if (growthScore > -0.05) return `Steady hiring pace${topDomain ? ` (mostly ${topDomain})` : ""}.`;
  return "Hiring has slowed recently.";
}

export function SectionLabel({ children, theme }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, marginBottom: 8,
                  textTransform: "uppercase", letterSpacing: "0.06em" }}>
      {children}
    </div>
  );
}

export function StackSection({ stack, theme }) {
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

export function ConfidenceBar({ confidence, theme }) {
  const pct = Math.round(Math.max(0, Math.min(1, confidence)) * 100);
  return (
    <div style={{ width: 48, height: 5, borderRadius: 999, background: theme.border, overflow: "hidden", flexShrink: 0 }}
      title={`${pct}% confidence`}>
      <div style={{ width: `${pct}%`, height: "100%", background: pct >= 60 ? "#16a34a" : "#d97706" }} />
    </div>
  );
}

export function OrgSection({ orgUnits, theme }) {
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

export function HiringSection({ signal, theme }) {
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
