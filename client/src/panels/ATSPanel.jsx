// client/src/panels/ATSPanel.jsx — Design System v4
// KEYWORD DATA SOURCE PRIORITY:
// 1. ats_report from generated resume (most accurate)
// 2. ats_only_reports cache (avoid redundant Haiku calls)
// 3. Fresh POST /api/jobs/:id/keywords call (base resume)
// To change keyword display format edit this component.
// To change extraction logic edit ATS_SYSTEM_PROMPT in
// server.js — it is shared between ATS scoring and keyword
// analysis.
import { useState, useEffect } from "react";
import { useTheme } from "../styles/theme.jsx";
import { api } from "../lib/api.js";

export function ATSPanel({ report, score, jobId, resumeText, activeProfileId }) {
  const { theme } = useTheme();
  const [localReport, setLocalReport] = useState(null);
  const [kwLoading,   setKwLoading]   = useState(false);
  const [kwError,     setKwError]     = useState(false);
  const [addedItems,  setAddedItems]  = useState(new Set());

  // Reset local state when the selected job changes
  useEffect(() => {
    setLocalReport(null);
    setKwError(false);
  }, [jobId]);

  // Fetch keyword analysis when no generated-resume report exists
  useEffect(() => {
    if (report) return;              // Priority 1 — generated resume covers this
    if (!jobId || !resumeText) return;
    if (localReport || kwLoading) return;

    let cancelled = false;
    setKwLoading(true);
    setKwError(false);
    api(`/api/jobs/${jobId}/keywords`, {
      method: "POST",
      body: JSON.stringify({ resumeText }),
    })
      .then(data => { if (!cancelled) setLocalReport(data); })
      .catch(() => { if (!cancelled) setKwError(true); })
      .finally(() => { if (!cancelled) setKwLoading(false); });
    return () => { cancelled = true; };
  }, [jobId, resumeText, report]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeReport = report ?? localReport;
  const clickableProfileId = activeProfileId || activeReport?.profileId || activeReport?.domainProfileId || null;
  const addSuggestion = async (kind, label) => {
    if (!clickableProfileId || !label) return;
    const key = `${kind}:${label}`;
    setAddedItems(prev => new Set([...prev, key]));
    try {
      await api(`/api/domain-profiles/${clickableProfileId}/suggestions`, {
        method: "POST",
        body: JSON.stringify({ kind, labels: [label] }),
      });
    } catch {
      setAddedItems(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  // No base resume uploaded yet
  if (!activeReport && !resumeText && !kwLoading) {
    return (
      <div style={{ padding:24, display:"flex", flexDirection:"column",
                    alignItems:"center", justifyContent:"center", gap:12,
                    height:"100%", color:theme.textMuted, fontSize:13, textAlign:"center" }}>
        <div style={{ fontSize:40 }}>📊</div>
        <div>Add a base resume to see keyword analysis for this role.</div>
      </div>
    );
  }

  // Loading skeleton
  if (kwLoading) {
    return (
      <div style={{ padding:24, display:"flex", flexDirection:"column",
                    alignItems:"center", justifyContent:"center", gap:14,
                    height:"100%", color:theme.textMuted, fontSize:13, textAlign:"center" }}>
        <div style={{ fontSize:28, animation:"spin 1.2s linear infinite" }}>⚙️</div>
        <div style={{ color:theme.text, fontWeight:600 }}>Analysing keywords...</div>
        <div style={{ fontSize:11 }}>Checking your resume against the job description</div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:6, justifyContent:"center", marginTop:4 }}>
          {[80,60,100,75,55,90,65,85].map((w,i) => (
            <div key={i} style={{ height:22, width:w, borderRadius:4,
              background:theme.surfaceHigh, opacity:0.6 }}/>
          ))}
        </div>
      </div>
    );
  }

  // Error state
  if (kwError) {
    return (
      <div style={{ padding:24, display:"flex", flexDirection:"column",
                    alignItems:"center", justifyContent:"center", gap:12,
                    height:"100%", color:theme.textMuted, fontSize:13, textAlign:"center" }}>
        <div style={{ fontSize:40 }}>⚠️</div>
        <div>Could not analyse keywords — retry</div>
        <button onClick={() => { setKwError(false); setLocalReport(null); }}
          style={{ marginTop:8, padding:"6px 16px", borderRadius:6, border:"none",
                   background:theme.accent, color:theme.accentText, cursor:"pointer",
                   fontWeight:600, fontSize:12 }}>
          Retry
        </button>
      </div>
    );
  }

  if (!activeReport) return null;

  const R = 32, cx = 40, cy = 40, stroke = 7;
  const circumference = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(100, activeReport.score ?? score ?? 0));
  const scoreColor = pct >= 80 ? theme.success : pct >= 60 ? theme.warning : theme.danger;

  return (
    <div style={{ padding:"16px 16px", display:"flex", flexDirection:"column",
                  gap:14, overflowY:"auto", height:"100%" }}>

      {/* Score card — shown when a score is available */}
      {activeReport.score != null && (
        <div style={{ background:theme.surface, border:`1px solid ${theme.border}`,
                      borderRadius:16, padding:"16px", display:"flex", alignItems:"center", gap:16 }}>
          <div style={{ position:"relative", width:80, height:80, flexShrink:0 }}>
            <svg width={80} height={80} viewBox="0 0 80 80">
              <circle cx={cx} cy={cy} r={R} fill="none" stroke={theme.surfaceHigh} strokeWidth={stroke}/>
              <circle cx={cx} cy={cy} r={R} fill="none" stroke={scoreColor} strokeWidth={stroke}
                strokeLinecap="round" strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - pct / 100)}
                transform={`rotate(-90 ${cx} ${cy})`}
                style={{ transition:"stroke-dashoffset 0.8s ease-out" }}/>
            </svg>
            <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center",
                          justifyContent:"center", fontWeight:900, fontSize:22, color:scoreColor }}>
              {activeReport.score ?? score ?? "—"}
            </div>
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:12, color:theme.textMuted, fontStyle:"italic",
                          lineHeight:1.6, marginBottom:8 }}>
              {activeReport.verdict || activeReport.experience?.summary || "Deterministic local ATS match against this profile."}
            </div>
            {activeReport.best_possible_score != null && (
              <div style={{ fontSize:11, padding:"6px 10px", borderRadius:8,
                            background: pct === activeReport.best_possible_score ? theme.successMuted : theme.surfaceHigh,
                            color: pct === activeReport.best_possible_score ? theme.success : theme.textMuted,
                            border:`1px solid ${pct === activeReport.best_possible_score ? theme.success+"33" : theme.border}` }}>
                {pct === activeReport.best_possible_score
                  ? "✓ Max achievable score for your profile"
                  : <>
                      <span style={{ fontWeight:700 }}>Best possible: {activeReport.best_possible_score}</span>
                      {activeReport.best_possible_reason && <span> — {activeReport.best_possible_reason}</span>}
                    </>
                }
              </div>
            )}
          </div>
        </div>
      )}

      {/* Skills matched */}
      {activeReport.tier1_matched?.length > 0 && (
        <TagSection title="✓ Skills Matched"
          bg={theme.successMuted} fg={theme.success} border={theme.success+"33"}
          items={activeReport.tier1_matched}/>
      )}

      {/* Skills missing */}
      {activeReport.tier1_missing?.length > 0 && (
        <TagSection title="✗ Skills Missing"
          bg={theme.dangerMuted} fg={theme.danger} border={theme.danger+"33"}
          items={activeReport.tier1_missing}
          onItemClick={clickableProfileId ? item => addSuggestion("skill", item) : null}
          addedItems={addedItems}
          kind="skill"/>
      )}

      {/* Action verbs matched */}
      {activeReport.action_verbs_matched?.length > 0 && (
        <TagSection title="⚡ Verbs Matched"
          bg={theme.infoMuted} fg={theme.info} border={theme.info+"33"}
          items={activeReport.action_verbs_matched}/>
      )}

      {/* Action verbs missing */}
      {activeReport.action_verbs_missing?.length > 0 && (
        <TagSection title="⚠ Verbs Missing"
          bg={theme.warningMuted} fg={theme.warning} border={theme.warning+"33"}
          items={activeReport.action_verbs_missing}
          onItemClick={clickableProfileId ? item => addSuggestion("action_verb", item) : null}
          addedItems={addedItems}
          kind="action_verb"/>
      )}

      {activeReport.experience && (
        <ListSection title="Experience Fit" items={[activeReport.experience.summary]} color={activeReport.experience.fit ? theme.success : theme.warning} theme={theme}/>
      )}

      {activeReport.hard_constraint_misses?.length > 0 && (
        <TagSection title="Profile Facts Missing"
          bg={theme.dangerMuted} fg={theme.danger} border={theme.danger+"33"}
          items={activeReport.hard_constraint_misses}/>
      )}

      {/* Strengths */}
      {activeReport.source !== "local_ats_v1" && activeReport.strengths?.length > 0 && (
        <ListSection title="💪 Strengths" items={activeReport.strengths} color={theme.success} theme={theme}/>
      )}

      {/* Improvements */}
      {activeReport.source !== "local_ats_v1" && activeReport.improvements?.length > 0 && (
        <ListSection title="🔧 Improvements" items={activeReport.improvements} color={theme.accent} theme={theme}/>
      )}
    </div>
  );
}

function TagSection({ title, bg, fg, border, items, onItemClick = null, addedItems = new Set(), kind = "skill" }) {
  return (
    <div>
      <div className="rm-section-label" style={{ color:fg }}>{title}</div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
        {items.map(k => (
          <button key={k} type="button" className="rm-badge"
            onClick={() => onItemClick?.(k)}
            disabled={!onItemClick || addedItems.has(`${kind}:${k}`)}
            title={onItemClick ? `Add "${k}" to this profile as an inactive suggestion` : undefined}
            style={{
              background:bg,
              color:fg,
              border:`1px solid ${border}`,
              cursor:onItemClick ? "pointer" : "default",
              opacity:addedItems.has(`${kind}:${k}`) ? 0.55 : 1,
            }}>
            {addedItems.has(`${kind}:${k}`) ? `Added: ${k}` : k}
          </button>
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
