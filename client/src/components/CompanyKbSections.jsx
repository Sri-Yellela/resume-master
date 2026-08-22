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

// `postings` is the server's honest floor for how many distinct postings back this stack (see
// services/kb/companyProfile.js getStack) — NOT a sum of per-skill counts, which double-counted
// every posting once per skill it mentioned and made one-posting companies look twelve-fold.
export function StackSection({ stack, postings, theme }) {
  if (!stack?.length) return null;
  // One posting is evidence of almost nothing; say so where the claim is made rather than leaving
  // the reader to notice that every chip below is backed by a single mention.
  const thin = postings <= 2;
  return (
    <div>
      <SectionLabel theme={theme}>Stack</SectionLabel>
      <div style={{ fontSize: 11, color: thin ? "#d97706" : theme.textMuted, marginBottom: 8 }}>
        Based on {postings} recent posting{postings === 1 ? "" : "s"} — evidence, not confirmation.
        {thin && " Too thin to generalise from."}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {stack.map(s => (
          <span key={s.skill}
            title={`Seen in ${s.postingCount} posting${s.postingCount === 1 ? "" : "s"}` +
                   (s.fresh ? "" : " — not reinforced by a recent posting")}
            style={{ fontSize: 11, padding: "3px 9px", borderRadius: 999,
                     background: theme.surfaceHigh, color: s.fresh ? theme.text : theme.textMuted,
                     opacity: s.fresh ? 1 : 0.55, border: `1px solid ${theme.border}`,
                     display: "inline-flex", alignItems: "center", gap: 5 }}>
            {s.skill}
            {/* Per-chip evidence weight: without it a chip seen once is indistinguishable from
                one seen 201 times, which is the whole difference between the sparse and the
                well-covered company. */}
            <span style={{ fontSize: 9, fontWeight: 700, color: theme.textMuted, opacity: 0.8 }}>
              {s.postingCount}
            </span>
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

export function OrgSection({ orgUnits, total, theme }) {
  if (!orgUnits?.length) return null;
  const shown = orgUnits.length;
  const confirmed = orgUnits.filter(u => u.status === "confirmed").length;
  return (
    <div>
      <SectionLabel theme={theme}>Org</SectionLabel>
      <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 8 }}>
        {total > shown
          ? `Highest-confidence ${shown} of ${total} units seen — `
          : `${shown} unit${shown === 1 ? "" : "s"} seen — `}
        {/* 'confirmed' is orgLayer's PROMOTE_MIN_CORROBORATION = 3 distinct postings, not merely
            "more than one" — the copy states the actual bar so 'verified' can't be read as
            stronger than it is. */}
        {confirmed} corroborated across 3+ postings, {shown - confirmed} inferred from fewer.
      </div>
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
  const domains = Object.entries(signal.domainBreakdown || {}).sort((a, b) => b[1] - a[1]);
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
      {/* The domain breakdown was fetched and then used only to name a single top domain inside
          the summary line — the distribution itself never reached the screen. */}
      {domains.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {domains.map(([domain, n]) => (
            <span key={domain} title={`${n} of ${signal.openCount} open postings`}
              style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999,
                       background: theme.surfaceHigh, color: theme.textMuted,
                       border: `1px solid ${theme.border}` }}>
              {domain} <strong style={{ color: theme.text }}>{n}</strong>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
