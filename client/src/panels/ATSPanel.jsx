// client/src/panels/ATSPanel.jsx — Design System v4
import { useTheme } from "../styles/theme.jsx";

export function ATSPanel({ report, score }) {
  const { theme } = useTheme();

  if (!report) return (
    <div style={{ padding:24, display:"flex", flexDirection:"column",
                  alignItems:"center", justifyContent:"center", gap:12,
                  height:"100%", color:theme.textMuted, fontSize:13, textAlign:"center" }}>
      <div style={{ fontSize:40 }}>📊</div>
      <div>Generate a resume for this role to see your ATS report.</div>
    </div>
  );

  const R = 32, cx = 40, cy = 40, stroke = 7;
  const circumference = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(100, score ?? 0));
  const dashOffset = circumference * (1 - pct / 100);
  const scoreColor = pct >= 80 ? theme.success : pct >= 60 ? theme.warning : theme.danger;

  return (
    <div style={{ padding:"16px 16px", display:"flex", flexDirection:"column",
                  gap:14, overflowY:"auto", height:"100%" }}>

      {/* Score card */}
      <div style={{ background:theme.surface, border:`1px solid ${theme.border}`,
                    borderRadius:16, padding:"16px", display:"flex", alignItems:"center", gap:16 }}>
        {/* Ring */}
        <div style={{ position:"relative", width:80, height:80, flexShrink:0 }}>
          <svg width={80} height={80} viewBox="0 0 80 80">
            <circle cx={cx} cy={cy} r={R} fill="none" stroke={theme.surfaceHigh} strokeWidth={stroke}/>
            <circle cx={cx} cy={cy} r={R} fill="none" stroke={scoreColor} strokeWidth={stroke}
              strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{ transition:"stroke-dashoffset 0.8s ease-out" }}/>
          </svg>
          <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center",
                        justifyContent:"center", fontWeight:900, fontSize:22, color:scoreColor }}>
            {score ?? "—"}
          </div>
        </div>
        {/* Verdict */}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:12, color:theme.textMuted, fontStyle:"italic",
                        lineHeight:1.6, marginBottom:8 }}>
            {report.verdict}
          </div>
          {report?.best_possible_score != null && (
            <div style={{ fontSize:11, padding:"6px 10px", borderRadius:8,
                          background: pct === report.best_possible_score ? theme.successMuted : theme.surfaceHigh,
                          color: pct === report.best_possible_score ? theme.success : theme.textMuted,
                          border:`1px solid ${pct === report.best_possible_score ? theme.success+"33" : theme.border}` }}>
              {pct === report.best_possible_score
                ? "✓ Max achievable score for your profile"
                : <>
                    <span style={{ fontWeight:700 }}>Best possible: {report.best_possible_score}</span>
                    {report.best_possible_reason && <span> — {report.best_possible_reason}</span>}
                  </>
              }
            </div>
          )}
        </div>
      </div>

      {/* Matched keywords */}
      {report?.tier1_matched?.length > 0 && (
        <TagSection title="✓ Matched Keywords"
          bg={theme.successMuted} fg={theme.success} border={theme.success+"33"}
          items={report.tier1_matched}/>
      )}

      {/* Missing keywords */}
      {report?.tier1_missing?.length > 0 && (
        <TagSection title="✗ Missing Keywords"
          bg={theme.dangerMuted} fg={theme.danger} border={theme.danger+"33"}
          items={report.tier1_missing}/>
      )}

      {/* Action verbs matched */}
      {report?.action_verbs_matched?.length > 0 && (
        <TagSection title="⚡ Action Verbs Found"
          bg={theme.infoMuted} fg={theme.info} border={theme.info+"33"}
          items={report.action_verbs_matched}/>
      )}

      {/* Action verbs missing */}
      {report?.action_verbs_missing?.length > 0 && (
        <TagSection title="⚠ Action Verbs Missing"
          bg={theme.warningMuted} fg={theme.warning} border={theme.warning+"33"}
          items={report.action_verbs_missing}/>
      )}

      {/* Strengths */}
      {report?.strengths?.length > 0 && (
        <ListSection title="💪 Strengths" items={report.strengths} color={theme.success} theme={theme}/>
      )}

      {/* Improvements */}
      {report?.improvements?.length > 0 && (
        <ListSection title="🔧 Improvements" items={report.improvements} color={theme.accent} theme={theme}/>
      )}
    </div>
  );
}

function TagSection({ title, bg, fg, border, items }) {
  return (
    <div>
      <div className="rm-section-label" style={{ color:fg }}>{title}</div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
        {items.map(k => (
          <span key={k} className="rm-badge"
            style={{ background:bg, color:fg, border:`1px solid ${border}` }}>
            {k}
          </span>
        ))}
      </div>
    </div>
  );
}

function ListSection({ title, items, color, theme }) {
  return (
    <div>
      <div className="rm-section-label" style={{ color }}>{title}</div>
      <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
        {items.map((t,i) => (
          <div key={i} style={{ display:"flex", gap:8, fontSize:12,
                                 color:theme.textMuted, lineHeight:1.6 }}>
            <span style={{ color, flexShrink:0, fontWeight:700 }}>·</span>
            <span>{t}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
