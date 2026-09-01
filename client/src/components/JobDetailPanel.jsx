import { useState, useCallback, useEffect } from "react";
import { HighlightedDescription } from "./HighlightedDescription.jsx";
import { api } from "../lib/api.js";
import { useJobBoard } from "../contexts/JobBoardContext.jsx";
import { useTheme } from "../styles/theme.jsx";
import CoverLetterModal from "./CoverLetterModal.jsx";
import CompanyViewModal from "./CompanyViewModal.jsx";
import PanelShell from "./PanelShell.jsx";
import CompanyIcon from "./ui/CompanyIcon.jsx";
import { atsBandFor, atsBandLabel } from "../../../shared/atsBands.js";

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


// ── FE-1 chips (visa badge, NEW pill, skill chips) — matches JobCard.jsx's styling ──
function VisaBadge({ isH1bSponsor, requiresWorkAuth }) {
  if (isH1bSponsor === 1 || isH1bSponsor === true) {
    return (
      <span style={{ background:"#dcfce7", color:"#166534", padding:"2px 8px",
                     borderRadius:999, fontSize:10, fontWeight:700, whiteSpace:"nowrap" }}>
        Sponsors H-1B
      </span>
    );
  }
  if (requiresWorkAuth === 1 || requiresWorkAuth === true) {
    return (
      <span style={{ background:"var(--color-surface-offset)", color:"var(--color-text-muted)",
                     padding:"2px 8px", borderRadius:999, fontSize:10, fontWeight:700, whiteSpace:"nowrap" }}>
        US work auth req.
      </span>
    );
  }
  return null;
}

function isNewJob(discoveredAt) {
  if (!discoveredAt) return false;
  const ms = Number(discoveredAt) * 1000;
  return Number.isFinite(ms) && Date.now() - ms < 24 * 3600 * 1000;
}

function NewPill() {
  return (
    <span style={{ fontSize:9, fontWeight:800, color:"#16a34a", background:"#dcfce733",
                   padding:"1px 6px", borderRadius:999, whiteSpace:"nowrap", letterSpacing:"0.03em" }}>
      NEW
    </span>
  );
}

function SkillChips({ skills, max = 5 }) {
  if (!skills?.length) return null;
  return (
    <div style={{ display:"flex", flexWrap:"wrap", gap:5, marginBottom:12 }}>
      {skills.slice(0, max).map((s, i) => (
        <span key={i} style={{ fontSize:10, color:"var(--color-text-muted)",
                                background:"var(--color-surface-offset)", padding:"2px 7px",
                                borderRadius:4, border:"1px solid var(--border-glass)" }}>
          {s}
        </span>
      ))}
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

// Layout props (slot, width, focused, fullScreen, resizeMode and the three resize callbacks) come
// from usePanelHost via JobsPanel — this panel is one peer in an ordered set now, not the only
// drawer, and its width is allocated from the dock's budget rather than owned here. Escape
// handling, focus-on-open, the overlay surface, the scrim, the animation and the two pinned regions
// all live in PanelShell, which is shared with the PDF and ATS panels.
export default function JobDetailPanel({
  slot = 0, width, focused = true, fullScreen = false, resizeMode = "dock",
  onFocus, onResizeStart, onResize, onResizeEnd,
}) {
  const { selectedJob, setSelectedJob, selectedJobMeta } = useJobBoard();
  const { theme } = useTheme();
  const close = useCallback(() => setSelectedJob(null), [setSelectedJob]);

  // Apply automation state (self-contained in portal)
  const [applyLoading, setApplyLoading] = useState(false);
  const [applyResult, setApplyResult] = useState(null);
  const [semiActive, setSemiActive] = useState(false);
  const [showCoverLetter, setShowCoverLetter] = useState(false);
  const [showCompanyView, setShowCompanyView] = useState(false);

  // Reset apply state when job changes
  useEffect(() => {
    setApplyLoading(false); setApplyResult(null); setSemiActive(false); setShowCoverLetter(false);
    setShowCompanyView(false);
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

  if (!selectedJob) return null;

  return (
    <PanelShell
      panelId="jd"
      slot={slot} width={width} focused={focused} fullScreen={fullScreen}
      resizeMode={resizeMode}
      onClose={close} onFocus={onFocus}
      onResizeStart={onResizeStart} onResize={onResize} onResizeEnd={onResizeEnd}
      header={
        <div style={{ display:"flex", alignItems:"flex-start", gap:10 }}>
              <CompanyIcon company={selectedJob.company} iconUrl={selectedJob.companyIconUrl} size={44} radius={8}/>
              <div style={{ flex:1, minWidth:0 }}>
                <div onClick={() => setShowCompanyView(true)} title={`View ${selectedJob.company}'s KB profile`}
                  style={{ fontWeight:700, fontSize:14, color:"var(--color-text)", cursor:"pointer",
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
                  // Band, not number — cutpoints and copy from shared/atsBands.js. This was the
                  // third of five copies of the same >=80/>=60 ramp, all of which painted the whole
                  // board red under v4 (median 27, max 64).
                  const atsMeta = atsBandLabel(atsBandFor(atsScore));
                  const done = selectedJobMeta?.done;
                  const st = selectedJobMeta?.st;
                  return (
                    <div style={{ display:"flex", alignItems:"center", flexWrap:"wrap", gap:5, marginTop:5 }}>
                      <WorkBadge t={job.workType}/>
                      {isNewJob(job.discoveredAt) && <NewPill/>}
                      <VisaBadge isH1bSponsor={job.isH1bSponsor} requiresWorkAuth={job.requiresWorkAuth}/>
                      {job.location && <span style={{ fontSize:10, color:"var(--color-text-faint)" }}>{job.location}</span>}
                      {yoeStr && <span style={{ fontSize:10, color:"var(--color-text-faint)" }}>{yoeStr} exp</span>}
                      {salaryStr && <span style={{ fontSize:10, color:"#16a34a", fontWeight:700 }}>{salaryStr}</span>}
                      {!salaryStr && job.compensation && <span style={{ fontSize:10, color:"#16a34a", fontWeight:700 }}>{job.compensation}</span>}
                      <span style={{ fontSize:10, color:"#16a34a", fontWeight:600 }}>{ago(job.postedAt, job.scrapedAt)}</span>
                      <span onClick={() => selectedJobMeta?.onAts?.()} title={atsMeta.blurb}
                        style={{ background:atsMeta.bg, color:atsMeta.fg, padding:"2px 8px", borderRadius:999,
                                  fontSize:10, fontWeight:700, cursor:"pointer", border:`1px solid ${atsMeta.fg}33` }}>
                        {atsMeta.short}
                      </span>
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
        </div>
      }
      actions={selectedJobMeta ? (() => {
              const { g, done, st, applyMode: am, canUseGenerate: canGen, onGenerate, onViewSandbox, onExport, onStar, onDislike, onQueueApply } = selectedJobMeta;
              // Same orphan as the one removed from JobCard: this action bar has no dedicated A+
              // button, so the `aPlusLoading` flag beside this one was computed and never read.
              // A+ is still a live tool — JobsPanel selects it by apply_mode/plan tier — it just
              // has no button of its own here, and `disabled={!!st}` below already covers the
              // in-flight state for whichever tool is running.
              const generateLoading = st === "generate";
              return (
                <>
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
                </>
              );
            })() : null}
    >
      {/* ── BODY (the only scrolling region) ───────────────────────────────────────────────────
          The modals below render through their own portals, so their position here is immaterial;
          the apply toast and the automation banner are inline and stay directly above the
          description, which is what they annotate. */}
      <div style={{ display:"flex", flexDirection:"column", minHeight:"100%" }}>

            {/* Company view (FE-4) */}
            {showCompanyView && (
              <CompanyViewModal company={selectedJob.company} onClose={() => setShowCompanyView(false)} />
            )}

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

            {/* Description. PanelShell's body is the scroll container (property 5), so this is a
                plain padded block — nesting another overflow:auto here would put a second scrollbar
                inside the first. */}
            <div style={{ flex:1, padding:"14px 14px" }}>
              {selectedJob.applicantCount != null && (
                <div style={{ fontSize:11, color:"var(--color-text-faint)", marginBottom:10 }}>
                  👥 {selectedJob.applicantCount > 200 ? "200+" : selectedJob.applicantCount} applicants
                </div>
              )}
              <SkillChips skills={selectedJob.skills}/>
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
      </div>
    </PanelShell>
  );
}
