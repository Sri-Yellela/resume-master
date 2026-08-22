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

// 'FY2026Q1' -> 'FY2026 Q1'. The store's key format is compact because it sorts; this is the only
// place it becomes prose.
//
// Three shapes, because one period no longer always means one quarter: the pre-FY2023 DOL files are
// fiscal-year cumulative, so services/kb/lcaLayer.js labels a full-year period 'FY2021' and a
// partial run 'FY2021Q1-Q3'. Passing those through unchanged would be fine; spacing them keeps the
// chips reading like the quarter chips beside them.
export function formatPeriod(period) {
  const s = String(period || "");
  const q = /^FY(\d{4})Q([1-4])$/.exec(s);
  if (q) return `FY${q[1]} Q${q[2]}`;
  const range = /^FY(\d{4})Q1-Q([1-4])$/.exec(s);
  if (range) return `FY${range[1]} Q1–Q${range[2]}`;
  const year = /^FY(\d{4})$/.exec(s);
  if (year) return `FY${year[1]}`;
  return s;
}

// "Oct 2020 – Dec 2025" from the corpus's real first and last decision dates. Dates rather than
// fiscal labels: once a period can mean a whole year, "FY2021 Q1–FY2026 Q1" is ambiguous about
// where the window actually starts, and a reader weighing "no filings found" deserves the real span.
function formatWindow(startEpoch, endEpoch) {
  if (!startEpoch || !endEpoch) return "";
  const fmt = (t) => new Date(t * 1000).toLocaleDateString("en-US",
    { month: "short", year: "numeric", timeZone: "UTC" });
  return ` (${fmt(startEpoch)} – ${fmt(endEpoch)})`;
}

/**
 * H-1B sponsorship evidence from DOL LCA filings (TASK X3).
 *
 * THE INTEGRITY LINE, and it is the whole reason this component is longer than the others:
 * "this company filed 47 H-1B petitions" is evidence about the EMPLOYER. It is NOT a promise about
 * the role the reader is looking at. Nothing here ever renders "this job sponsors", and the
 * disclaimer sits directly under the number rather than at the bottom of the panel, because a
 * caveat the reader scrolls past has not been given.
 *
 * WHAT IT REFUSES TO RENDER. `presentable` false — an ambiguous name match, or none at all —
 * returns null. Not a zero, not "no data", nothing. Measured reason: four unrelated `Mercury *`
 * employers file every quarter and one of them (Mercury Insurance Services) files for "Senior
 * Software Engineer", so there is no way to tell from the data which Mercury a board row means. A
 * silent section is the correct output for that, and a "0" would be a false claim.
 *
 * A HIGH-CONFIDENCE ZERO IS A REAL FINDING, though, and it is distinguished in copy: "no filings in
 * the 5 quarters searched" is information, as long as it says how long it looked and does not
 * promise the company will refuse.
 */
export function SponsorshipSection({ lca, theme }) {
  if (!lca?.presentable) return null;

  const entities = lca.matchedEntities || [];
  // Legal names usually END in a period ("Stripe, Inc."), so anything that follows one in a sentence
  // has to drop it or the copy reads "Matched to Stripe, Inc.." — which looks like a rendering bug
  // and undermines the one line whose whole job is to look carefully written.
  const entityNames = entities.map(e => e.name).join(" + ");
  const entityNamesMid = entityNames.replace(/\.$/, "");
  const periods = Object.entries(lca.byPeriod || {})
    .sort((a, b) => String(b[0]).localeCompare(String(a[0])));
  const searched = lca.periodsCovered;
  const hasFilings = lca.certifiedTotal > 0;
  // Name the window, don't just count it. "Nothing found in 21 quarters" is a far stronger negative
  // than "nothing found in 2" and the reader cannot tell those apart from a bare number.
  const span = formatWindow(lca.corpusWindowStart, lca.corpusWindowEnd);
  // Tier C (0.60): matched by brand prefix, not by the registered name. It renders, but only ever
  // with the legal entity named and the basis of the match stated.
  const nameMatched = !lca.highConfidence;
  const stale = lca.recency === "stale";

  return (
    <div>
      <SectionLabel theme={theme}>Sponsorship (H-1B)</SectionLabel>
      {hasFilings ? (
        <div style={{ fontSize: 12, color: theme.text, marginBottom: 4 }}>
          <strong>{entityNames}</strong> had <strong>{lca.certifiedTotal}</strong> H-1B labor
          condition application{lca.certifiedTotal === 1 ? "" : "s"} certified by the US Department
          of Labor across {searched} quarter{searched === 1 ? "" : "s"}{span}
          {lca.latestPeriod ? `, most recently ${formatPeriod(lca.latestPeriod)}` : ""}.
        </div>
      ) : (
        <div style={{ fontSize: 12, color: theme.text, marginBottom: 4 }}>
          No H-1B filings found for <strong>{entityNames}</strong> in {searched} quarter
          {searched === 1 ? "" : "s"} of DOL disclosure data{span}.
        </div>
      )}
      {/* The caveat, immediately under the claim it qualifies — never at the foot of the panel. */}
      <div style={{ fontSize: 11, color: "#d97706", marginBottom: 8 }}>
        {hasFilings
          ? "Evidence about the employer — not confirmation that this role sponsors."
          : "Absence of a filing is evidence, not proof this employer will not sponsor."}
      </div>
      {periods.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {periods.map(([period, n]) => (
            <span key={period} title={`${n} certified in ${formatPeriod(period)}`}
              style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999,
                       background: theme.surfaceHigh, color: theme.textMuted,
                       border: `1px solid ${theme.border}` }}>
              {formatPeriod(period)} <strong style={{ color: theme.text }}>{n}</strong>
            </span>
          ))}
        </div>
      )}
      {stale && (
        <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 8 }}>
          Last filing was {lca.quartersSinceFiling} quarter
          {lca.quartersSinceFiling === 1 ? "" : "s"} before the newest data we hold
          {lca.latestCorpusPeriod ? ` (${formatPeriod(lca.latestCorpusPeriod)})` : ""} — this
          employer may have stopped sponsoring.
        </div>
      )}
      {lca.topTitles?.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {lca.topTitles.map(t => (
            <span key={t.title} title={`${t.count} filing${t.count === 1 ? "" : "s"}`}
              style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999,
                       background: theme.surfaceHigh, color: theme.textMuted,
                       border: `1px solid ${theme.border}` }}>
              {t.title} <strong style={{ color: theme.text }}>{t.count}</strong>
            </span>
          ))}
        </div>
      )}
      {/* The provenance line goes amber on a name match, because ConfidenceBar's shared threshold
          turns green at exactly 60 and 0.60 is the LOWEST tier we will render at all. A green bar
          beside "verify the employer" reads as reassurance next to a warning; the colour has to
          agree with the words. The bar itself is left alone — it is OrgSection's too. */}
      <div style={{ fontSize: 10, color: nameMatched ? "#d97706" : theme.textMuted,
                    display: "flex", alignItems: "center", gap: 6 }}>
        <ConfidenceBar confidence={lca.matchConfidence} theme={theme} />
        <span>
          {nameMatched
            ? `Matched on name to ${entityNamesMid} — verify the employer.`
            : `Matched to ${entityNamesMid}.`}
          {" DOL OFLC LCA disclosure data."}
        </span>
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
