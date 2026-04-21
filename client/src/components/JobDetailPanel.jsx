// client/src/components/JobDetailPanel.jsx — right-panel job detail in split view
import { useState, useCallback } from "react";
import { HighlightedDescription } from "./HighlightedDescription.jsx";
import { api } from "../lib/api.js";

function ago(ts) {
  if (!ts) return "—";
  const d = Date.now() - new Date(ts).getTime();
  if (d < 3600000)  return `${Math.floor(d / 60000)}m`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h`;
  return `${Math.floor(d / 86400000)}d`;
}

function WorkBadge({ t, theme }) {
  const map = { Remote:{ bg:"#e8f6fb", fg:"#1a6a8a" }, Hybrid:{ bg:"#f0f9ff", fg:"#0284c7" } };
  const s = map[t] || null;
  if (s) return <span style={{ background:s.bg, color:s.fg, padding:"2px 8px", borderRadius:999, fontSize:10, fontWeight:700 }}>{t}</span>;
  return <span style={{ background:theme.surfaceHigh, color:theme.textMuted, padding:"2px 8px", borderRadius:999, fontSize:10, fontWeight:700 }}>{t || "Onsite"}</span>;
}

function CompanyIcon({ company, iconUrl, size = 44 }) {
  const [failed, setFailed] = useState(false);
  const letter = (company || "?")[0].toUpperCase();
  const colors = ["#0A66C2","#7c3aed","#0891b2","#16a34a","#dc2626","#d97706","#9333ea"];
  let hash = 0;
  for (const c of company || "") hash = (hash * 31 + c.charCodeAt(0)) & 0xffff;
  const bg = colors[hash % colors.length];
  if (iconUrl && !failed) {
    return <img src={iconUrl} alt={company} onError={() => setFailed(true)}
      style={{ width:size, height:size, borderRadius:8, objectFit:"contain", flexShrink:0 }}/>;
  }
  return (
    <div style={{ width:size, height:size, borderRadius:8, background:bg, color:"#fff",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontWeight:800, fontSize:Math.round(size*0.38), flexShrink:0, letterSpacing:"-0.5px" }}>
      {letter}
    </div>
  );
}

function ActionBtn({ onClick, title, children, accent = "#0284c7", theme, active, disabled = false }) {
  const [hov, setHov] = useState(false);
  return (
    <button title={title} onClick={disabled ? undefined : onClick} disabled={disabled}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display:"flex", alignItems:"center", gap:5,
        padding:"6px 12px", borderRadius:4, border:`1px solid ${active || hov ? accent : theme.border}`,
        background: active ? accent+"22" : hov ? accent+"11" : "transparent",
        color: active || hov ? accent : theme.textMuted,
        cursor: disabled ? "not-allowed" : "pointer", fontSize:11, fontWeight:600,
        opacity: disabled ? 0.55 : 1,
        transition:"all 0.15s", flexShrink:0,
      }}>
      {children}
    </button>
  );
}

export default function JobDetailPanel({
  job,
  theme, isDark,
  g, done, st,
  applyMode,
  canUseGenerate = applyMode !== "SIMPLE",
  canUseAPlusResume = false,
  onClose,
  onGenerate,
  onAPlusResume,
  onViewSandbox,
  onExport,
  onVisit,
  onStar,
  onDislike,
  onAts,
  onResume,
  onQueueApply,
}) {
  if (!job) return null;

  // ── Apply automation state ───────────────────────────────────
  const [applyLoading,  setApplyLoading]  = useState(false);
  const [applyResult,   setApplyResult]   = useState(null); // { status, message, error }
  const [semiActive,    setSemiActive]    = useState(false);

  const handleAutoApply = useCallback(async (mode = "semi") => {
    setApplyLoading(true); setApplyResult(null);
    try {
      const d = await api("/api/apply", { method:"POST", body:JSON.stringify({
        jobId: job.jobId, jobUrl: job.applyUrl || job.url, mode,
      }) });
      if (mode === "semi" && d.status === "semi_launched") {
        setSemiActive(true);
        setApplyResult({ status:"semi", message: d.message });
      } else if (d.status === "submitted") {
        setApplyResult({ status:"success", message:"Application submitted!" });
      } else if (d.status === "filled_not_submitted") {
        setApplyResult({ status:"warn", message:"Form filled — submit button not found." });
      } else if (d.status === "error") {
        setApplyResult({ status:"error", message: d.error || "Automation failed", fallbackUrl: d.fallbackUrl || null });
      } else {
        setApplyResult({ status:"info", message: d.message || "Done" });
      }
    } catch(e) { setApplyResult({ status:"error", message: e.message }); }
    finally { setApplyLoading(false); }
  }, [job]);

  const closeSemi = useCallback(async () => {
    await api(`/api/apply/close/${job.jobId}`, { method:"POST" }).catch(()=>{});
    setSemiActive(false); setApplyResult(null);
  }, [job]);

  const hasSalary = job.salaryMin != null || job.salaryMax != null;
  const salaryStr = hasSalary
    ? [job.salaryMin, job.salaryMax].filter(Boolean)
        .map(v => `${job.salaryCurrency || "$"}${(v/1000).toFixed(0)}k`).join("–")
    : null;
  const yoeStr = job.expRaw
    ? job.expRaw
    : job.minYearsExp != null
      ? (job.maxYearsExp != null ? `${job.minYearsExp}–${job.maxYearsExp}y` : `${job.minYearsExp}y+`)
      : null;
  const atsScore = g?.atsScore;
  const generateLoading = st === "generate";
  const aPlusLoading = st === "a_plus_resume";
  const atsBg = atsScore >= 80 ? "#dcfce7" : atsScore >= 60 ? "#fef9c3" : "#fee2e2";
  const atsFg = atsScore >= 80 ? "#166534" : atsScore >= 60 ? "#854d0e" : "#991b1b";

  return (
    <div style={{
      display:"flex", flexDirection:"column", height:"100%", overflow:"hidden",
      background: isDark ? "rgba(17,17,17,0.95)" : "rgba(255,255,255,0.97)",
    }}>
      {/* Header */}
      <div style={{
        display:"flex", alignItems:"flex-start", gap:10,
        padding:"12px 14px 10px", borderBottom:`1px solid ${theme.border}`,
        flexShrink:0, background:theme.surface,
      }}>
        <CompanyIcon company={job.company} iconUrl={job.companyIconUrl}/>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontWeight:700, fontSize:14, color:theme.text,
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {job.company}
          </div>
          <div style={{ fontSize:12, color:theme.textMuted, marginTop:2,
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {job.title}
          </div>
          <div style={{ display:"flex", alignItems:"center", flexWrap:"wrap", gap:5, marginTop:5 }}>
            <WorkBadge t={job.workType} theme={theme}/>
            {job.location && <span style={{ fontSize:10, color:theme.textDim }}>{job.location}</span>}
            {yoeStr && <span style={{ fontSize:10, color:theme.textDim }}>{yoeStr} exp</span>}
            {salaryStr && <span style={{ fontSize:10, color:"#16a34a", fontWeight:700 }}>{salaryStr}</span>}
            {!salaryStr && job.compensation && <span style={{ fontSize:10, color:"#16a34a", fontWeight:700 }}>{job.compensation}</span>}
            <span style={{ fontSize:10, color:"#16a34a", fontWeight:600 }}>{ago(job.postedAt)}</span>
            {atsScore != null && (
              <span onClick={() => onAts?.()}
                style={{ background:atsBg, color:atsFg, padding:"2px 8px", borderRadius:999,
                          fontSize:10, fontWeight:700, cursor:"pointer", border:`1px solid ${atsFg}33` }}>
                ATS {atsScore}
              </span>
            )}
            {done && (
              <span onClick={() => onResume?.()} style={{ background:"#e8f6fb", color:"#1a6a8a",
                padding:"2px 8px", borderRadius:999, fontSize:10, fontWeight:700, cursor:"pointer" }}>
                {st==="loading" ? "⏳" : "📄"} Resume
              </span>
            )}
          </div>
        </div>
        {/* Close button */}
        <button onClick={onClose}
          style={{ background:"none", border:"none", cursor:"pointer", color:theme.textMuted,
                   fontSize:16, padding:"0 2px", flexShrink:0, lineHeight:1 }}>
          ✕
        </button>
      </div>

      {/* Action bar */}
      <div style={{
        display:"flex", alignItems:"center", gap:6, flexWrap:"wrap",
        padding:"8px 14px", borderBottom:`1px solid ${theme.border}`,
        flexShrink:0, background:theme.surface,
      }}>
        {canUseGenerate && onGenerate && (
          <ActionBtn onClick={() => onGenerate(done && g?.html !== "__exists__")}
            title={done ? "Regenerate resume" : "Generate resume"} accent={theme.accent} theme={theme} disabled={!!st}>
            {generateLoading ? "⏳ Generating" : done ? "↻ Regen" : "✦ Generate"}
          </ActionBtn>
        )}
        {canUseAPlusResume && onAPlusResume && (
          <ActionBtn onClick={() => onAPlusResume(done && g?.html !== "__exists__")}
            title={done ? "Rebuild A+ Resume" : "A+ Resume"} accent="#16a34a" theme={theme} disabled={!!st}>
            {aPlusLoading ? "⏳ Building A+" : "A+ Resume"}
          </ActionBtn>
        )}
        {done && g?.html !== "__exists__" && (
          <ActionBtn onClick={() => onViewSandbox?.()} title="View in sandbox" accent="#0284c7" theme={theme}>
            👁 Preview
          </ActionBtn>
        )}
        {done && g?.html !== "__exists__" && (
          <ActionBtn onClick={() => onExport?.()} title="Export PDF" accent="#16a34a" theme={theme}>
            📥 PDF
          </ActionBtn>
        )}
        {(job.applyUrl || job.url) && !semiActive && (
          <ActionBtn onClick={() => handleAutoApply("semi")} title="Open pre-filled application in browser"
            accent={theme.accent} theme={theme} active={applyLoading}>
            {applyLoading ? "⏳" : "Apply"}
          </ActionBtn>
        )}
        {(job.applyUrl || job.url) && onQueueApply && (
          <ActionBtn onClick={() => onQueueApply(job)} title="Add this job to the auto-apply queue" accent="#16a34a" theme={theme}>
            Queue Auto
          </ActionBtn>
        )}
        {semiActive && (
          <ActionBtn onClick={closeSemi} title="Close automation browser" accent="#dc2626" theme={theme}>
            ⏹ Close Browser
          </ActionBtn>
        )}
        {onStar && (
          <ActionBtn onClick={() => onStar?.()} title={job.starred ? "Remove saved" : "Save"} accent="#f59e0b" theme={theme} active={job.starred}>
            {job.starred ? "★ Saved" : "☆ Save"}
          </ActionBtn>
        )}
        {onDislike && (
          <ActionBtn onClick={() => onDislike?.()} title="Not interested" accent="#dc2626" theme={theme} active={job.disliked}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/>
              <path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/>
            </svg>
            Pass
          </ActionBtn>
        )}
      </div>

      {/* Apply result toast */}
      {applyResult && (
        <div style={{
          margin:"0 14px 0", padding:"8px 12px",
          background: applyResult.status === "success" ? "#dcfce7"
                    : applyResult.status === "error"   ? "#fee2e2"
                    : applyResult.status === "semi"    ? theme.accentMuted
                    : "#fef9c3",
          color: applyResult.status === "success" ? "#166534"
               : applyResult.status === "error"   ? "#991b1b"
               : applyResult.status === "semi"    ? theme.accentText
               : "#854d0e",
          borderRadius:6, fontSize:11, fontWeight:600,
          display:"flex", alignItems:"center", justifyContent:"space-between",
          flexShrink:0,
        }}>
          <span>
            {applyResult.status === "success" ? "✓ " : applyResult.status === "error" ? "✗ " : "ℹ "}
            {applyResult.message}
            {applyResult.fallbackUrl && (
              <a href={applyResult.fallbackUrl} target="_blank" rel="noreferrer"
                style={{ color:"inherit", marginLeft:6, textDecoration:"underline" }}>
                Apply directly ↗
              </a>
            )}
          </span>
          <button onClick={() => setApplyResult(null)}
            style={{ background:"none", border:"none", cursor:"pointer", fontSize:12, opacity:0.6, padding:"0 2px" }}>
            ✕
          </button>
        </div>
      )}
      {semiActive && (
        <div style={{ margin:"6px 14px 0", padding:"6px 12px", background:theme.accentMuted,
                      color:theme.accentText, borderRadius:6, fontSize:11,
                      display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
          <span style={{ display:"inline-block", width:7, height:7, borderRadius:"50%",
                          background:theme.accent, animation:"pulse 1.5s infinite" }}/>
          Automation browser is open — fill remaining fields and submit
        </div>
      )}

      {/* Description */}
      <div style={{ flex:1, overflowY:"auto", padding:"14px 14px" }}>
        {job.applicantCount != null && (
          <div style={{ fontSize:11, color:theme.textDim, marginBottom:10 }}>
            👥 {job.applicantCount > 200 ? "200+" : job.applicantCount} applicants
          </div>
        )}

        {job.description ? (
          <HighlightedDescription
            text={job.description}
            theme={theme}
            maxChars={3000}
          />
        ) : (
          <p style={{ fontSize:12, color:theme.textDim, fontStyle:"italic" }}>No description available.</p>
        )}

        {/* Direct apply link */}
        {(job.applyUrl || job.url) && (
          <div style={{ marginTop:16, paddingTop:12, borderTop:`1px solid ${theme.border}44` }}>
            <a href={job.applyUrl || job.url} target="_blank" rel="noreferrer"
              style={{ fontSize:12, color:theme.accentText, fontWeight:700,
                        textDecoration:"underline", background:theme.accentMuted,
                        padding:"6px 14px", borderRadius:4, display:"inline-block" }}>
              Apply directly ↗
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
