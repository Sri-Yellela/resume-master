// REVAMP v2 — ATSPanel.jsx (shadcn UI integrated)
import { useTheme } from "../styles/theme.jsx";
import { Badge } from "../components/ui/badge";
import { Progress } from "../components/ui/progress";
import { ScrollArea } from "../components/ui/scroll-area";
import { Card, CardContent } from "../components/ui/card";
import { Separator } from "../components/ui/separator";

export function ATSPanel({ report, score }) {
  const { theme } = useTheme();

  if (!report) return (
    <div style={{ padding:16, color:theme.colorMuted, fontSize:12 }}>
      Generate a resume to see the ATS report.
    </div>
  );

  // SVG arc ring
  const R = 28, cx = 36, cy = 36, stroke = 6;
  const circumference = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(100, score ?? 0));
  const dashOffset = circumference * (1 - pct / 100);

  return (
    <ScrollArea style={{ height:"100%" }}>
      <div style={{ padding:"12px 14px", fontSize:12, display:"flex",
                    flexDirection:"column", gap:10, boxSizing:"border-box" }}>

        {/* Score ring + verdict */}
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          <div style={{ position:"relative", width:72, height:72, flexShrink:0 }}>
            <svg width={72} height={72} viewBox="0 0 72 72">
              {/* Track */}
              <circle cx={cx} cy={cy} r={R}
                fill="none" stroke={theme.colorSurface} strokeWidth={stroke}/>
              {/* Progress arc */}
              <circle cx={cx} cy={cy} r={R}
                fill="none"
                stroke={theme.colorPrimary}
                strokeWidth={stroke}
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                transform={`rotate(-90 ${cx} ${cy})`}
                style={{ transition:"stroke-dashoffset 0.6s ease" }}/>
            </svg>
            {/* Score text — gradient */}
            <div style={{
              position:"absolute", inset:0,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontWeight:900, fontSize:18,
              background:theme.gradAccent,
              WebkitBackgroundClip:"text",
              WebkitTextFillColor:"transparent",
            }}>
              {score ?? "—"}
            </div>
          </div>
          <div style={{ color:theme.colorMuted, fontStyle:"italic",
                        lineHeight:1.5, fontSize:11 }}>
            {report.verdict}
          </div>
        </div>

        {report.tier1_matched?.length > 0 && (
          <TagSection title="✓ Matched" theme={theme}
            bg={`rgba(${hexToRgb(theme.colorAccent)},0.15)`}
            fg={theme.colorAccent}
            items={report.tier1_matched}/>
        )}
        {report.tier1_missing?.length > 0 && (
          <TagSection title="✗ Missing" theme={theme}
            bg="rgba(239,68,68,0.15)"
            fg="#ef4444"
            items={report.tier1_missing}/>
        )}
        {report.strengths?.length > 0 && (
          <ListSection title="💪 Strengths" theme={theme} items={report.strengths}/>
        )}
        {report.improvements?.length > 0 && (
          <ListSection title="🔧 Improvements" theme={theme} items={report.improvements}/>
        )}
      </div>
    </ScrollArea>
  );
}

function hexToRgb(hex) {
  const h = hex.replace("#","");
  const n = parseInt(h.length === 3
    ? h.split("").map(c => c+c).join("") : h, 16);
  return `${(n>>16)&255},${(n>>8)&255},${n&255}`;
}

function TagSection({ title, bg, fg, items, theme }) {
  return (
    <div>
      <div style={{ fontWeight:700, color:fg, marginBottom:4, fontSize:11 }}>{title}</div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
        {items.map(k => (
          <Badge key={k} variant="outline"
            style={{ background:bg, color:fg, borderColor:fg, fontSize:10 }}>
            {k}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function ListSection({ title, items, theme }) {
  return (
    <div>
      <div style={{ fontWeight:700, color:theme.colorPrimary,
                    marginBottom:4, fontSize:11 }}>
        {title}
      </div>
      <ul style={{ margin:0, paddingLeft:0, listStyle:"none",
                   color:theme.colorText, lineHeight:1.7 }}>
        {items.map((t, i) => (
          <li key={i} style={{ paddingLeft:12,
                                borderLeft:`3px solid ${theme.colorPrimary}`,
                                marginBottom:4, fontSize:11 }}>
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}
