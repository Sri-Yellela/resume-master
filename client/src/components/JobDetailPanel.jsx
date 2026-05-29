import { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { HighlightedDescription } from "./HighlightedDescription.jsx";
import { api } from "../lib/api.js";
import { useJobBoard } from "../contexts/JobBoardContext.jsx";
import { useTheme } from "../styles/theme.jsx";
import CoverLetterModal from "./CoverLetterModal.jsx";

function ago(postedAt, scrapedAt) {
  let ms = postedAt ? new Date(postedAt).getTime() : NaN;
  if (isNaN(ms) || ms <= 0) {
    ms = scrapedAt != null ? Number(scrapedAt) * 1000 : NaN;
  }
  if (isNaN(ms) || ms <= 0) return "—";
  const d = Date.now() - ms;
  if (d < 0) return "—";
  if (d < 3600000)  return `${Math.floor(d / 60000)}m`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h`;
  return `${Math.floor(d / 86400000)}d`;
}

function WorkBadge({ t }) {
  const map = { Remote:{ bg:"#e8f6fb", fg:"#1a6a8a" }, Hybrid:{ bg:"#f0f9ff", fg:"#0284c7" } };
  const s = map[t] || null;
  if (s) return <span style={{ background:s.bg, color:s.fg, padding:"2px 8px", borderRadius:999, fontSize:10, fontWeight:700 }}>{t}</span>;
  return <span style={{ background:"var(--color-surface-offset)", color:"var(--color-text-muted)", padding:"2px 8px", borderRadius:999, fontSize:10, fontWeight:700 }}>{t || "Onsite"}</span>;
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

function ActionBtn({ onClick, title, children, accent = "#0284c7", active, disabled = false }) {
  const [hov, setHov] = useState(false);
  return (
    <button title={title} onClick={disabled ? undefined : onClick} disabled={disabled}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display:"flex", alignItems:"center", gap:5,
        padding:"6px 12px", borderRadius:4, border:`1px solid ${active || hov ? accent : "var(--color-border)"}`,
        background: active
          ? `color-mix(in srgb, ${accent} 13%, transparent)`
          : hov
            ? `color-mix(in srgb, ${accent} 7%, transparent)`
            : "transparent",
        color: active || hov ? accent : "var(--color-text-muted)",
        cursor: disabled ? "not-allowed" : "pointer", fontSize:11, fontWeight:600,
        opacity: disabled ? 0.55 : 1,
        transition:"all 0.15s", flexShrink:0,
      }}>
      {children}
    </button>
  );
}

export default function JobDetailPanel() {
  const { selectedJob, setSelectedJob, selectedJobMeta } = useJobBoard();
  const { theme } = useTheme();
  const closeBtnRef = useRef(null);
  const close = useCallback(() => setSelectedJob(null), [setSelectedJob]);

  useEffect(() => {
    if (!selectedJob) return;
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    closeBtnRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedJob, close]);

  // Apply automation state (self-contained in portal)
  const [applyLoading, setApplyLoading] = useState(false);
  const [applyResult, setApplyResult] = useState(null);
  const [semiActive, setSemiActive] = useState(false);
  const [showCoverLetter, setShowCoverLetter] = useState(false);

  // Reset apply state when job changes
  useEffect(() => {
    setApplyLoading(false); setApplyResult(null); setSemiActive(false); setShowCoverLetter(false);
  }, [selectedJob?.jobId]);

  const handleAutoApply = useCallback(async (mode = "semi") => {
    if (!selectedJob) return;
    setApplyLoading(true); setApplyResult(null);
    try {
      const d = await api("/api/apply", { method:"POST", body:JSON.stringify({
        jobId: selectedJob.jobId, jobUrl: selectedJob.applyUrl || selectedJob.url, mode,
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
  }, [selectedJob]);

  const closeSemi = useCallback(async () => {
    if (!selectedJob) return;
    await api(`/api/apply/close/${selectedJob.jobId}`, { method:"POST" }).catch(()=>{});
    setSemiActive(false); setApplyResult(null);
  }, [selectedJob]);

  return createPortal(
    <AnimatePresence>
      {selectedJob && (
        <>
          <motion.div key="backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }} onClick={close}
            style={{ position:"fixed", inset:0, zIndex:30,
                     background:"rgba(0,0,0,0.45)", backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)" }}/>
          <motion.div key="drawer"
            initial={{ x: 560, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 560, opacity: 0 }}
            transition={{ type:"spring", damping:26, stiffness:220 }}
            className="liquid-panel"
            style={{
              position:"fixed", right:16, top:80, bottom:16,
              width:"min(560px, 92vw)", borderRadius:16,
              zIndex:40, overflow:"hidden",
              display:"flex", flexDirection:"column",
            }}>
            {/* Drawer header */}
            <div style={{
              display:"flex", alignItems:"flex-start", gap:10,
              padding:"12px 14px 10px", borderBottom:"1px solid var(--border-glass)",
              flexShrink:0, background:"var(--color-surface)",
            }}>
              <CompanyIcon company={selectedJob.company} iconUrl={selectedJob.companyIconUrl}/>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontWeight:700, fontSize:14, color:"var(--color-text)",
                              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {selectedJob.company}
                </div>
                <div style={{ fontSize:12, color:"var(--color-text-muted)", marginTop:2,
                              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {selectedJob.title}
                </div>
                {(() => {
                  const job = selectedJob;
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
                  const g = selectedJobMeta?.g;
                  const atsScore = g?.atsScore ?? job?.baseAtsScore ?? null;
                  const atsBg = atsScore >= 80 ? "#dcfce7" : atsScore >= 60 ? "#fef9c3" : "#fee2e2";
                  const atsFg = atsScore >= 80 ? "#166534" : atsScore >= 60 ? "#854d0e" : "#991b1b";
                  const done = selectedJobMeta?.done;
                  const st = selectedJobMeta?.st;
                  return (
                    <div style={{ display:"flex", alignItems:"center", flexWrap:"wrap", gap:5, marginTop:5 }}>
                      <WorkBadge t={job.workType}/>
                      {job.location && <span style={{ fontSize:10, color:"var(--color-text-faint)" }}>{job.location}</span>}
                      {yoeStr && <span style={{ fontSize:10, color:"var(--color-text-faint)" }}>{yoeStr} exp</span>}
                      {salaryStr && <span style={{ fontSize:10, color:"#16a34a", fontWeight:700 }}>{salaryStr}</span>}
                      {!salaryStr && job.compensation && <span style={{ fontSize:10, color:"#16a34a", fontWeight:700 }}>{job.compensation}</span>}
                      <span style={{ fontSize:10, color:"#16a34a", fontWeight:600 }}>{ago(job.postedAt, job.scrapedAt)}</span>
                      {atsScore != null && (
                        <span onClick={() => selectedJobMeta?.onAts?.()}
                          style={{ background:atsBg, color:atsFg, padding:"2px 8px", borderRadius:999,
                                    fontSize:10, fontWeight:700, cursor:"pointer", border:`1px solid ${atsFg}33` }}>
                          ATS {atsScore}
                        </span>
                      )}
                      {done && (
                        <span onClick={() => selectedJobMeta?.onResume?.()} style={{ background:"#e8f6fb", color:"#1a6a8a",
                          padding:"2px 8px", borderRadius:999, fontSize:10, fontWeight:700, cursor:"pointer" }}>
                          {st==="loading" ? "⏳" : "📄"} Resume
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>
              <button ref={closeBtnRef} onClick={close}
                style={{ background:"none", border:"none", cursor:"pointer", color:"var(--color-text-muted)",
                         fontSize:16, padding:"0 2px", flexShrink:0, lineHeight:1 }}
                aria-label="Close detail">
                ✕
              </button>
            </div>

            {/* Action bar */}
            {selectedJobMeta && (() => {
              const { g, done, st, applyMode: am, canUseGenerate: canGen, onGenerate, onViewSandbox, onExport, onStar, onDislike, onQueueApply } = selectedJobMeta;
              const generateLoading = st === "generate";
              const aPlusLoading = st === "a_plus_resume";
              return (
                <div style={{
                  display:"flex", alignItems:"center", gap:6, flexWrap:"wrap",
                  padding:"8px 14px", borderBottom:"1px solid var(--border-glass)",
                  flexShrink:0, background:"var(--color-surface)",
                }}>
                  {canGen && onGenerate && (
                    <ActionBtn onClick={() => onGenerate(done && g?.html !== "__exists__")}
                      title={done ? "Regenerate resume" : "Generate resume"} accent="var(--color-primary)" disabled={!!st}>
                      {generateLoading ? "⏳ Generating" : done ? "↻ Regen" : "✦ Generate"}
                    </ActionBtn>
                  )}
                  {done && g?.html !== "__exists__" && (
                    <ActionBtn onClick={() => onViewSandbox?.()} title="View in sandbox" accent="#0284c7">
                      👁 Preview
                    </ActionBtn>
                  )}
                  {done && g?.html !== "__exists__" && (
                    <ActionBtn onClick={() => onExport?.()} title="Export PDF" accent="#16a34a">
                      📥 PDF
                    </ActionBtn>
                  )}
                  {(selectedJob.applyUrl || selectedJob.url) && !semiActive && (
                    <ActionBtn onClick={() => handleAutoApply("semi")} title="Open pre-filled application in browser"
                      accent="var(--color-primary)" active={applyLoading}>
                      {applyLoading ? "⏳" : "Apply"}
                    </ActionBtn>
                  )}
                  {(selectedJob.applyUrl || selectedJob.url) && onQueueApply && (
                    <ActionBtn onClick={() => onQueueApply(selectedJob)} title="Add to auto-apply queue" accent="#16a34a">
                      Queue Auto
                    </ActionBtn>
                  )}
                  {semiActive && (
                    <ActionBtn onClick={closeSemi} title="Close automation browser" accent="#dc2626">
                      ⏹ Close Browser
                    </ActionBtn>
                  )}
                  {onStar && (
                    <ActionBtn onClick={() => onStar?.()} title={selectedJob.starred ? "Remove saved" : "Save"} accent="#f59e0b" active={selectedJob.starred}>
                      {selectedJob.starred ? "★ Saved" : "☆ Save"}
                    </ActionBtn>
                  )}
                  {onDislike && (
                    <ActionBtn onClick={() => onDislike?.()} title="Not interested" accent="#dc2626" active={selectedJob.disliked}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/>
                        <path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/>
                      </svg>
                      Pass
                    </ActionBtn>
                  )}
                  <ActionBtn onClick={() => setShowCoverLetter(true)} title="Write a cover letter" accent="#7c3aed">
                    ✉ Cover Letter
                  </ActionBtn>
                </div>
              );
            })()}

            {/* Cover Letter modal */}
            {showCoverLetter && (
              <CoverLetterModal
                resumeText={selectedJobMeta?.resumeText || ""}
                jobDescription={selectedJob.description}
                jobTitle={selectedJob.title}
                company={selectedJob.company}
                onClose={() => setShowCoverLetter(false)}
              />
            )}

            {/* Apply result toast */}
            {applyResult && (
              <div style={{
                margin:"0 14px 0", padding:"8px 12px",
                background: applyResult.status === "success" ? "#dcfce7"
                          : applyResult.status === "error"   ? "#fee2e2"
                          : applyResult.status === "semi"    ? "var(--color-primary-muted)"
                          : "#fef9c3",
                color: applyResult.status === "success" ? "#166534"
                     : applyResult.status === "error"   ? "#991b1b"
                     : applyResult.status === "semi"    ? "var(--color-primary-text)"
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
              <div style={{ margin:"6px 14px 0", padding:"6px 12px", background:"var(--color-primary-muted)",
                            color:"var(--color-primary-text)", borderRadius:6, fontSize:11,
                            display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
                <span style={{ display:"inline-block", width:7, height:7, borderRadius:"50%",
                                background:"var(--color-primary)", animation:"pulse 1.5s infinite" }}/>
                Automation browser is open — fill remaining fields and submit
              </div>
            )}

            {/* Scrollable description */}
            <div style={{ flex:1, overflowY:"auto", padding:"14px 14px" }}>
              {selectedJob.applicantCount != null && (
                <div style={{ fontSize:11, color:"var(--color-text-faint)", marginBottom:10 }}>
                  👥 {selectedJob.applicantCount > 200 ? "200+" : selectedJob.applicantCount} applicants
                </div>
              )}
              {selectedJob.description ? (
                <HighlightedDescription
                  text={selectedJob.description}
                  theme={theme}
                  truncate={false}
                />
              ) : (
                <p style={{ fontSize:12, color:"var(--color-text-faint)", fontStyle:"italic" }}>No description available.</p>
              )}
              {(selectedJob.applyUrl || selectedJob.url) && (
                <div style={{ marginTop:16, paddingTop:12, borderTop:"1px solid var(--border-glass)" }}>
                  <a href={selectedJob.applyUrl || selectedJob.url} target="_blank" rel="noreferrer"
                    style={{ fontSize:12, color:"var(--color-primary-text)", fontWeight:700,
                              textDecoration:"underline", background:"var(--color-primary-muted)",
                              padding:"6px 14px", borderRadius:4, display:"inline-block" }}>
                    Apply directly ↗
                  </a>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}
