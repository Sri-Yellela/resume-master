// client/src/components/JobCard.jsx — shared expandable job card
import { useState } from "react";

// ── Helpers ─────────────────────────────────────────────────────
function ago(ts) {
  if (!ts) return "—";
  const d = Date.now() - new Date(ts).getTime();
  if (d < 3600000)  return `${Math.floor(d / 60000)}m`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h`;
  return `${Math.floor(d / 86400000)}d`;
}

// ── LinkedIn "in" logo ──────────────────────────────────────────
function LinkedInLogo({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-label="LinkedIn" role="img">
      <rect width="20" height="20" rx="3" fill="#0A66C2"/>
      <text x="4" y="15" fontFamily="Georgia,serif" fontWeight="900" fontSize="13" fill="#fff">in</text>
    </svg>
  );
}

function PlatformLogo({ platform, size = 16, theme }) {
  const p = (platform || "").toLowerCase();
  if (p === "linkedin") return <LinkedInLogo size={size}/>;
  return <span style={{ fontSize: size * 0.6, color: theme?.textMuted || "#888" }}>◆</span>;
}

// ── Company icon ────────────────────────────────────────────────
function CompanyIcon({ company, iconUrl, size = 48 }) {
  const [failed, setFailed] = useState(false);
  const letter = (company || "?")[0].toUpperCase();
  const colors = ["#0A66C2","#7c3aed","#0891b2","#16a34a","#dc2626","#d97706","#9333ea"];
  let hash = 0;
  for (const c of company || "") hash = (hash * 31 + c.charCodeAt(0)) & 0xffff;
  const bg = colors[hash % colors.length];
  if (iconUrl && !failed) {
    return (
      <img src={iconUrl} alt={company} onError={() => setFailed(true)}
        style={{ width:size, height:size, borderRadius:10, objectFit:"contain",
                 border:"1px solid transparent", background:"transparent", flexShrink:0 }}/>
    );
  }
  return (
    <div style={{ width:size, height:size, borderRadius:10, background:bg, color:"#fff",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontWeight:800, fontSize:Math.round(size*0.38), flexShrink:0, letterSpacing:"-0.5px" }}>
      {letter}
    </div>
  );
}

// ── Work badge ──────────────────────────────────────────────────
function WorkBadge({ t, theme }) {
  const map = {
    Remote: { bg:"#e8f6fb", fg:"#1a6a8a" },
    Hybrid: { bg:"#f0f9ff", fg:"#0284c7" },
  };
  const s = map[t] || null;
  if (s) {
    return (
      <span style={{ background:s.bg, color:s.fg, padding:"2px 8px",
                     borderRadius:999, fontSize:10, fontWeight:700, whiteSpace:"nowrap" }}>
        {t}
      </span>
    );
  }
  return (
    <span style={{ background:theme?.surfaceHigh, color:theme?.textMuted, padding:"2px 8px",
                   borderRadius:999, fontSize:10, fontWeight:700, whiteSpace:"nowrap" }}>
      {t || "Onsite"}
    </span>
  );
}

// ── ATS badge ───────────────────────────────────────────────────
function ATSBadge({ score, onClick }) {
  if (score == null) return null;
  const bg = score >= 80 ? "#dcfce7" : score >= 60 ? "#fef9c3" : "#fee2e2";
  const fg = score >= 80 ? "#166534" : score >= 60 ? "#854d0e" : "#991b1b";
  return (
    <span onClick={onClick ? e => { e.stopPropagation(); onClick(); } : undefined}
      style={{ background:bg, color:fg, padding:"2px 8px", borderRadius:999,
               fontSize:10, fontWeight:700, cursor:onClick?"pointer":"default",
               border:onClick?`1px solid ${fg}33`:"none" }}>
      ATS {score}
    </span>
  );
}

// ── Plain description renderer ───────────────────────────────────
function DescriptionText({ text, theme }) {
  if (!text) return null;
  const trimmed = text.slice(0, 1200);
  return (
    <p style={{ fontSize:11, color:theme.textMuted, lineHeight:1.7, margin:0, whiteSpace:"pre-wrap" }}>
      {trimmed}
      {text.length > 1200 && <span style={{ color:theme.textDim }}> … (truncated)</span>}
    </p>
  );
}

// ── Coming-soon pill ────────────────────────────────────────────
function ComingSoon({ label }) {
  return (
    <span style={{ fontSize:9, padding:"1px 6px", borderRadius:999, fontWeight:700,
                   background:"#f3f4f6", color:"#9ca3af", border:"1px dashed #d1d5db",
                   whiteSpace:"nowrap", letterSpacing:"0.04em" }}>
      {label} · soon
    </span>
  );
}

// ── Icon button ─────────────────────────────────────────────────
function IconBtn({ bg, onClick, title, children, disabled = false, size = 28, theme }) {
  const [hov, setHov] = useState(false);
  return (
    <button title={title} disabled={disabled} onClick={onClick}
      onMouseEnter={() => !disabled && setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width:size, height:size, borderRadius:999,
        background: disabled ? (theme?.surfaceHigh||"#f3f4f6") : hov ? bg : (theme?.surfaceHigh||"#f3f4f6"),
        border:`1px solid ${disabled ? (theme?.border||"#e5e7eb") : hov ? bg+"44" : (theme?.border||"#e5e7eb")}`,
        display:"flex", alignItems:"center", justifyContent:"center",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize:12, color: hov && !disabled ? "white" : (theme?.textMuted||"#6b7280"),
        opacity: disabled ? 0.4 : 1,
        transition:"all 0.15s ease", flexShrink:0,
        transform: hov && !disabled ? "scale(1.1)" : "scale(1)",
      }}>
      {children}
    </button>
  );
}

// ── Main JobCard ─────────────────────────────────────────────────
export default function JobCard({
  job,
  theme,
  isDark,
  showDislike = true,
  showApplyButton = true,
  g,                  // generated resume entry
  done,               // has generated resume
  st,                 // loading state string
  applyMode,
  canUseGenerate = applyMode !== "SIMPLE",
  canUseAPlusResume = false,
  onGenerate,
  onAPlusResume,
  onViewSandbox,
  onExport,
  onVisit,
  onStar,
  onDislike,
  onCardClick,
  onAts,
  onResume,
  onSelect,           // split-view: select this card (replaces expand)
  selected,           // split-view: this card is selected
  compact,            // split-view: tighter layout
  cardTier = 1,       // 1=full, 2=medium (manual resize), 3=condensed (3+ panels open)
}) {
  const [hov,      setHov]      = useState(false);
  const [expanded, setExpanded] = useState(false);

  const frostedBg = isDark
    ? (hov ? "rgba(28,28,28,0.88)" : "rgba(17,17,17,0.55)")
    : (hov ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.44)");
  const frostedBlur = hov ? "blur(20px) saturate(2)" : "blur(12px) saturate(1.6)";
  const frostedOverlay = isDark
    ? "linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(200,200,200,0.02) 100%)"
    : "linear-gradient(135deg, rgba(255,255,255,0.18) 0%, rgba(200,200,200,0.06) 100%)";

  const hasDesc    = !!(job.description || job.descriptionHtml);
  const hasSalary  = job.salaryMin != null || job.salaryMax != null;
  const salaryStr  = hasSalary
    ? [job.salaryMin, job.salaryMax].filter(Boolean).map(v =>
        `${job.salaryCurrency || "$"}${(v/1000).toFixed(0)}k`
      ).join("–")
    : null;

  const yoeStr = job.expRaw
    ? job.expRaw
    : job.minYearsExp != null
      ? (job.maxYearsExp != null ? `${job.minYearsExp}–${job.maxYearsExp}y` : `${job.minYearsExp}y+`)
      : null;

  const handleCardClick = (e) => {
    if (e.target.closest("a") || e.target.closest("button")) return;
    if (onSelect) { onSelect(); return; }
    if (onCardClick) { onCardClick(); return; }
    setExpanded(prev => !prev);
  };

  // RESPONSIVE TIERS: driven by open-panel count (see getCardTier in JobsPanel.jsx).
  // Tier 1 (full layout):   A alone or A+B — cardTier=1
  // Tier 2 (medium):        manual drag to 180-279px — cardTier=2
  // Tier 3 (condensed):     3+ panels open (A at 10%) — cardTier=3
  // To change tier triggers, edit getCardTier() in JobsPanel.jsx.
  const tier = cardTier;

  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        background: frostedBg,
        backdropFilter: frostedBlur,
        WebkitBackdropFilter: frostedBlur,
        border: `1px solid ${selected ? theme.accent : (hov ? theme.accent + "66" : theme.border + "88")}`,
        borderRadius: 4, margin: "0 16px 8px",
        boxShadow: hov
          ? `0 0 0 2px ${theme.accent}, 0 8px 24px ${theme.accent}44`
          : theme.shadowSm,
        transform: hov ? "translateY(-3px) scale(1.008)" : "translateY(0) scale(1)",
        transition: "all 0.2s ease", position: "relative",
        opacity: job.disliked ? 0.3 : job.visited ? 0.75 : 1,
        filter: job.disliked ? "grayscale(0.7)" : "none",
        overflow: "hidden",
      }}>

      {/* ── Frosted glass overlay (gradient + noise texture) ── */}
      <div aria-hidden style={{
        position:"absolute", inset:0, pointerEvents:"none", borderRadius:"inherit", zIndex:0,
        background: frostedOverlay,
      }}/>
      <div aria-hidden style={{
        position:"absolute", inset:0, pointerEvents:"none", borderRadius:"inherit", zIndex:2,
        opacity: isDark ? 0.12 : 0.08, mixBlendMode: isDark ? "overlay" : "multiply",
        backgroundImage:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")`,
        backgroundSize:"160px 160px",
      }}/>

      {/* ── TIER_3_CONTENT: condensed narrow mode (< 180px) ── */}
      {tier === 3 && (
        <div onClick={handleCardClick}
          title={`${job.company} — ${job.title}`}
          style={{ padding:"10px 8px 10px", display:"flex", flexDirection:"column",
                   alignItems:"center", gap:5, cursor:"pointer", position:"relative", zIndex:1,
                   minHeight:72 }}>
          {/* Logo — fades in as tier changes */}
          <div style={{ opacity:1, transition:"opacity 0.15s ease 0.05s" }}>
            <CompanyIcon company={job.company} iconUrl={job.companyIconUrl} size={32}/>
          </div>
          {/* Company name */}
          <span style={{ fontSize:10, fontWeight:700, color:theme.text, textAlign:"center",
                         overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                         width:"100%", maxWidth:110,
                         opacity:1, transition:"opacity 0.15s ease 0.05s" }}>
            {job.company}
          </span>
          {/* Resume badge — only if a resume has been generated */}
          {done && (
            <span style={{
              fontSize:9, fontWeight:700, padding:"2px 6px", borderRadius:999,
              background:theme.accentMuted, color:theme.accentText,
              border:`1px solid ${theme.accent}44`, whiteSpace:"nowrap",
              opacity:1, transition:"opacity 0.2s ease 0.22s",
            }}>
              ✓ Resume
            </span>
          )}
        </div>
      )}

      {/* ── Tier 2: condensed two-row (180–279px) ── */}
      {tier === 2 && (
        <div onClick={handleCardClick}
          style={{ padding:"10px 12px", display:"flex", alignItems:"center", gap:10,
                   cursor:"pointer", position:"relative", zIndex:1,
                   opacity:1, transition:"opacity 0.15s ease" }}>
          <CompanyIcon company={job.company} iconUrl={job.companyIconUrl} size={36}/>
          <div style={{ flex:1, minWidth:0 }}>
            {/* Row 1: company + age + ATS + star + dislike */}
            <div style={{ display:"flex", alignItems:"center", gap:4, marginBottom:3 }}>
              <span style={{ fontWeight:700, fontSize:12, color:theme.text,
                              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1, minWidth:0 }}>
                {job.company}
              </span>
              <span style={{ fontSize:10, color:"#16a34a", fontWeight:600, flexShrink:0 }}>{ago(job.postedAt)}</span>
              {(g?.atsScore != null || job?.baseAtsScore != null) && <ATSBadge score={g?.atsScore ?? job?.baseAtsScore} onClick={onAts}/>}
              {onStar && (
                <button title={job.starred ? "Remove from saved" : "Save job"}
                  onClick={e => { e.stopPropagation(); onStar(); }}
                  style={{ width:28, height:28, minWidth:28, borderRadius:"50%",
                    background: job.starred ? "#f59e0b22" : "transparent",
                    border: job.starred ? "2px solid #f59e0b" : `2px solid ${theme.border}`,
                    display:"flex", alignItems:"center", justifyContent:"center",
                    cursor:"pointer", fontSize:12, color: job.starred ? "#f59e0b" : theme.textDim,
                    transition:"all 0.2s", flexShrink:0 }}>
                  {job.starred ? "★" : "☆"}
                </button>
              )}
              {showDislike && onDislike && (
                <button title="Not interested"
                  onClick={e => { e.stopPropagation(); onDislike(); }}
                  style={{ width:28, height:28, minWidth:28, borderRadius:"50%",
                    background: job.disliked ? "#fef2f2" : "transparent",
                    border: job.disliked ? "2px solid #dc2626" : `2px solid ${theme.border}`,
                    display:"flex", alignItems:"center", justifyContent:"center",
                    cursor:"pointer", color: job.disliked ? "#dc2626" : theme.textDim,
                    transition:"all 0.2s", flexShrink:0 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/>
                    <path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/>
                  </svg>
                </button>
              )}
            </div>
            {/* Row 2: job title */}
            <div style={{ fontSize:11, color:theme.textMuted,
                          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {job.title}
            </div>
          </div>
        </div>
      )}

      {/* ── Tier 1: full layout (>= 280px) — unchanged ── */}
      {tier === 1 && (
        <div onClick={handleCardClick}
          style={{ padding: compact ? "10px 14px" : "14px 18px", display:"flex", alignItems:"center", gap:14, cursor:"pointer", position:"relative", zIndex:1 }}>

          {/* Company icon */}
          <CompanyIcon company={job.company} iconUrl={job.companyIconUrl} size={48}/>

          {/* Center info */}
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
              <span style={{ fontWeight:700, fontSize:14, color:theme.text,
                              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {job.company}
              </span>
              {job.alreadyApplied && (
                <span title="Applied" style={{ fontSize:10, color:"#16a34a", fontWeight:700 }}>✓APPLIED</span>
              )}
              {!job.alreadyApplied && job.companyAppliedBefore && (
                <span title="Applied to this company before" style={{ fontSize:10, color:"#d97706" }}>↩prev</span>
              )}
              {job.visited && (
                <span style={{ fontSize:9, color:theme.textDim, background:theme.surfaceHigh,
                                padding:"1px 6px", borderRadius:999 }}>visited</span>
              )}
            </div>
            <div style={{ fontSize:12, color:theme.textMuted, marginBottom:6,
                          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {job.title}
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:5, flexWrap:"wrap" }}>
              <WorkBadge t={job.workType} theme={theme}/>
              <span style={{ display:"flex", alignItems:"center", gap:4 }}>
                <PlatformLogo platform={job.sourcePlatform || job.source} size={16} theme={theme}/>
              </span>
              {job.location && (
                <span style={{ fontSize:10, color:theme.textDim }}>{job.location}</span>
              )}
              {yoeStr && (
                <span style={{ fontSize:10, color:theme.textDim }}>{yoeStr} exp</span>
              )}
              {salaryStr && (
                <span style={{ fontSize:10, color:"#16a34a", fontWeight:700 }}>{salaryStr}</span>
              )}
              {!salaryStr && job.compensation && (
                <span style={{ fontSize:10, color:"#16a34a", fontWeight:700 }}>{job.compensation}</span>
              )}
              {job.applicantCount != null && (
                <span style={{ fontSize:10, color:theme.textDim }}>
                  {job.applicantCount > 200 ? "200+ applicants" : `${job.applicantCount} applicants`}
                </span>
              )}
            </div>
          </div>

          {/* Right side */}
          <div style={{ display:"flex", alignItems:"center", gap:5, flexShrink:0 }}>
            <span style={{ fontSize:11, color:"#16a34a", fontWeight:600 }}>{ago(job.postedAt)}</span>

            {(g?.atsScore != null || job?.baseAtsScore != null) && (
              <ATSBadge score={g?.atsScore ?? job?.baseAtsScore} onClick={onAts}/>
            )}
            {done && (
              <span onClick={onResume ? e => { e.stopPropagation(); onResume(); } : undefined}
                style={{ background:"#e8f6fb", color:"#1a6a8a", padding:"2px 8px",
                         borderRadius:999, fontSize:10, fontWeight:700, cursor:"pointer",
                         border:"1px solid #A8D8EA44", display:"inline-flex", alignItems:"center", gap:3 }}>
                {st==="loading" ? "⏳" : "📄"} Resume
              </span>
            )}

            {/* Star */}
            {onStar && (
              <button title={job.starred ? "Remove from saved" : "Save job"}
                onClick={e => { e.stopPropagation(); onStar(); }}
                style={{
                  width:30, height:30, borderRadius:"50%",
                  background: job.starred ? "#f59e0b22" : "transparent",
                  border: job.starred ? "2px solid #f59e0b" : `2px solid ${theme.border}`,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  cursor:"pointer", fontSize:14,
                  color: job.starred ? "#f59e0b" : theme.textDim,
                  transition:"all 0.2s", flexShrink:0,
                  transform: job.starred ? "scale(1.15)" : "scale(1)",
                }}>
                {job.starred ? "★" : "☆"}
              </button>
            )}

            {/* Dislike */}
            {showDislike && onDislike && (
              <button title="Not interested"
                onClick={e => { e.stopPropagation(); onDislike(); }}
                style={{
                  width:28, height:28, borderRadius:"50%",
                  background: job.disliked ? "#fef2f2" : "transparent",
                  border: job.disliked ? "2px solid #dc2626" : `2px solid ${theme.border}`,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  cursor:"pointer",
                  color: job.disliked ? "#dc2626" : theme.textDim,
                  transition:"all 0.2s", flexShrink:0,
                }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/>
                  <path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/>
                </svg>
              </button>
            )}

            {/* Generate */}
            {canUseGenerate && onGenerate && showApplyButton && (
              <IconBtn bg={theme.accent} title={done ? "Regenerate" : "Generate resume"}
                disabled={!!st} theme={theme}
                onClick={e => { e.stopPropagation(); onGenerate(done && g?.html !== "__exists__"); }}>
                {st ? "⏳" : done ? "↻" : "✦"}
              </IconBtn>
            )}
            {canUseAPlusResume && onAPlusResume && showApplyButton && (
              <IconBtn bg="#16a34a" title={done ? "Rebuild A+ Resume" : "A+ Resume"}
                disabled={!!st} theme={theme}
                onClick={e => { e.stopPropagation(); onAPlusResume(done && g?.html !== "__exists__"); }}>
                A+
              </IconBtn>
            )}

            {/* View sandbox */}
            {done && g?.html !== "__exists__" && showApplyButton && (
              <IconBtn bg="#0284c7" title="View in sandbox" theme={theme}
                onClick={e => { e.stopPropagation(); onViewSandbox?.(); }}>
                👁
              </IconBtn>
            )}

            {/* Visit URL */}
            {onVisit && showApplyButton && job.url && (
              <IconBtn bg={theme.accent} title="Open job listing" theme={theme}
                onClick={e => { e.stopPropagation(); onVisit(); }}>
                ↗
              </IconBtn>
            )}
          </div>
        </div>
      )}

      {/* ── Expanded section ──────────────────────────────────── */}
      {expanded && (
        <div style={{
          borderTop: `1px solid ${theme.border}44`,
          padding: "12px 18px 16px",
          display: "flex", flexDirection: "column", gap: 10,
        }}>
          {/* Description */}
          {job.description && (
            <DescriptionText text={job.description} theme={theme}/>
          )}

          {/* Extra meta row */}
          <div style={{ display:"flex", flexWrap:"wrap", gap:8, alignItems:"center", paddingTop:4 }}>
            {salaryStr && (
              <span style={{ fontSize:11, color:"#16a34a", fontWeight:700, background:"#dcfce733",
                              padding:"2px 8px", borderRadius:4 }}>
                💰 {salaryStr}
              </span>
            )}
            {yoeStr && (
              <span style={{ fontSize:11, color:theme.textMuted, background:theme.surfaceHigh,
                              padding:"2px 8px", borderRadius:4 }}>
                🎓 {yoeStr} exp required
              </span>
            )}
            {job.applicantCount != null && (
              <span style={{ fontSize:11, color:theme.textMuted, background:theme.surfaceHigh,
                              padding:"2px 8px", borderRadius:4 }}>
                👥 {job.applicantCount > 200 ? "200+" : job.applicantCount} applicants
              </span>
            )}
            {showApplyButton !== false && (job.applyUrl || job.url) && (
              <a href={job.applyUrl || job.url} target="_blank" rel="noreferrer"
                onClick={e => e.stopPropagation()}
                style={{ fontSize:11, color:theme.accentText, fontWeight:700,
                          textDecoration:"underline", background:theme.accentMuted,
                          padding:"2px 8px", borderRadius:4 }}>
                Apply directly ↗
              </a>
            )}
          </div>

          {/* Recruiter section — coming soon */}
          {(canUseGenerate || canUseAPlusResume) && showApplyButton && (
            <div style={{ display:"flex", flexWrap:"wrap", gap:8, alignItems:"center" }}>
              {canUseGenerate && onGenerate && (
                <button onClick={e => { e.stopPropagation(); onGenerate(done && g?.html !== "__exists__"); }}
                  disabled={!!st}
                  style={{ border:"none", borderRadius:6, padding:"8px 12px",
                           background:theme.accent, color:"#0f0f0f", cursor:st ? "not-allowed" : "pointer",
                           fontSize:12, fontWeight:800 }}>
                  {done ? "Regenerate" : "Generate"}
                </button>
              )}
              {canUseAPlusResume && onAPlusResume && (
                <button onClick={e => { e.stopPropagation(); onAPlusResume(done && g?.html !== "__exists__"); }}
                  disabled={!!st}
                  style={{ border:"none", borderRadius:6, padding:"8px 12px",
                           background:"#16a34a", color:"#fff", cursor:st ? "not-allowed" : "pointer",
                           fontSize:12, fontWeight:800 }}>
                  A+ Resume
                </button>
              )}
            </div>
          )}

          <div style={{
            borderTop: `1px dashed ${theme.border}`,
            paddingTop: 8, marginTop: 4,
            display: "flex", alignItems: "center", gap: 8,
          }}>
            <span style={{ fontSize:10, color:theme.textDim, fontWeight:700,
                            textTransform:"uppercase", letterSpacing:"0.06em" }}>
              Recruiter
            </span>
            <ComingSoon label="auto-contact"/>
            <ComingSoon label="LinkedIn reach-out"/>
          </div>
        </div>
      )}
    </div>
  );
}
