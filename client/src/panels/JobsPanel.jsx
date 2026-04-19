// client/src/panels/JobsPanel.jsx â€” Lucy Brand, shared job pool
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { api, printResume, dislikeJob, authHeaders } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";
import { useViewport } from "../hooks/useViewport.js";
import JobCard from "../components/JobCard.jsx";
import JobDetailPanel from "../components/JobDetailPanel.jsx";
import SandboxPanel from "./SandboxPanel.jsx";
import { ATSPanel } from "./ATSPanel.jsx";
import DomainProfileWizard from "../components/DomainProfileWizard.jsx";
import { useSyncEvents } from "../hooks/useSyncEvents.js";
import { useAppScroll } from "../contexts/AppScrollContext.jsx";
import { useJobBoard } from "../contexts/JobBoardContext.jsx";

const USER_TEXT   = "#0f0f0f";   // black text on accent

// â”€â”€ Pre-scrape param maps (UI â†’ Apify enum) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// workType UI value â†’ Apify workplaceType array
const WORKPLACE_TO_APIFY = {
  Remote:  "remote",
  Hybrid:  "hybrid",
  Onsite:  "office",
  "On-site": "office",
};
// ageFilter UI value â†’ Apify postedLimit string
const AGE_TO_POSTED_LIMIT = {
  "1d":"24h","2d":"24h","3d":"24h","1w":"1w","1m":"1m","1mo":"1m",
};
function buildScrapeParams({ workType, ageFilter, locationFilter, employmentTypePrefs }) {
  const workplaceTypes = workType && WORKPLACE_TO_APIFY[workType]
    ? [WORKPLACE_TO_APIFY[workType]]
    : ["remote","hybrid","office"];
  return {
    workplaceTypes,
    employmentTypes: employmentTypePrefs?.length ? employmentTypePrefs : ["full-time"],
    postedLimit:     AGE_TO_POSTED_LIMIT[ageFilter] || "24h",
    location:        locationFilter?.trim() || "United States",
  };
}

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ago(ts) {
  if (!ts) return "â€”";
  const d = Date.now() - new Date(ts).getTime();
  if (d < 3600000)  return `${Math.floor(d/60000)}m`;
  if (d < 86400000) return `${Math.floor(d/3600000)}h`;
  return `${Math.floor(d/86400000)}d`;
}

// â”€â”€ LinkedIn "in" logo (inline SVG) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const GENERATE_TOOL = "generate";
const A_PLUS_TOOL = "a_plus_resume";
const TOOL_LABELS = { [GENERATE_TOOL]: "Generate", [A_PLUS_TOOL]: "A+ Resume" };

function normalizeTool(tool) {
  return tool === A_PLUS_TOOL ? A_PLUS_TOOL : GENERATE_TOOL;
}

function getActiveArtifact(entry, tool) {
  if (!entry) return null;
  const selected = normalizeTool(tool || entry.activeTool || entry.tool);
  return entry.variants?.[selected] || entry;
}

function mergeArtifact(entry, artifact) {
  const tool = normalizeTool(artifact.tool);
  const variants = { ...(entry?.variants || {}) };
  if (entry?.html && entry.html !== "__exists__" && entry.tool) {
    variants[normalizeTool(entry.tool)] = { ...entry, variants: undefined };
  }
  variants[tool] = { ...artifact, variants: undefined, activeTool: tool };
  return { ...artifact, variants, activeTool: tool };
}

function buildArtifact(job, data, tool) {
  const t = normalizeTool(data?.tool || tool);
  return {
    html: data.html,
    atsScore: data.atsScore ?? data.ats_score,
    atsReport: data.atsReport,
    company: data.company || job.company,
    title: data.title || data.role || job.title,
    jobId: job.jobId,
    jobUrl: job.url,
    source: job.source,
    location: job.location,
    tool: t,
    toolLabel: data.toolLabel || TOOL_LABELS[t],
    version: data.version || null,
  };
}

function LinkedInLogo({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-label="LinkedIn" role="img">
      <rect width="20" height="20" rx="3" fill="#0A66C2"/>
      <text x="4" y="15" fontFamily="Georgia,serif" fontWeight="900" fontSize="13" fill="#fff">in</text>
    </svg>
  );
}

// â”€â”€ Indeed logo (inline SVG) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function IndeedLogo({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-label="Indeed" role="img">
      <rect width="20" height="20" rx="3" fill="#003A9B"/>
      <circle cx="10" cy="8" r="3" fill="#fff"/>
      <rect x="7.5" y="11" width="5" height="6" rx="1" fill="#fff"/>
    </svg>
  );
}

// â”€â”€ Platform logo dispatcher â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function PlatformLogo({ platform, size = 20, theme }) {
  const p = (platform || "").toLowerCase();
  if (p === "linkedin") return <LinkedInLogo size={size}/>;
  if (p === "indeed")   return <IndeedLogo size={size}/>;
  return <span style={{ fontSize:size*0.5, color:theme?.textMuted||"#888" }}>â—†</span>;
}

// â”€â”€ Company icon with monogram fallback â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function CompanyIcon({ company, iconUrl, size = 48 }) {
  const [failed, setFailed] = useState(false);
  const letter = (company || "?")[0].toUpperCase();
  // Deterministic color from company name
  const colors = ["#0A66C2","#7c3aed","#0891b2","#16a34a","#dc2626","#d97706","#9333ea"];
  let hash = 0;
  for (const c of company || "") hash = (hash * 31 + c.charCodeAt(0)) & 0xffff;
  const bg = colors[hash % colors.length];

  if (iconUrl && !failed) {
    return (
      <img
        src={iconUrl}
        alt={company}
        onError={() => setFailed(true)}
        style={{
          width:size, height:size, borderRadius:10,
          objectFit:"contain", border:"1px solid transparent",
          background:"transparent", flexShrink:0,
        }}
      />
    );
  }
  return (
    <div style={{
      width:size, height:size, borderRadius:10,
      background:bg, color:"#fff",
      display:"flex", alignItems:"center", justifyContent:"center",
      fontWeight:800, fontSize:Math.round(size*0.38), flexShrink:0,
      letterSpacing:"-0.5px",
    }}>
      {letter}
    </div>
  );
}

// â”€â”€ Work type badge â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function WorkBadge({ t, theme }) {
  // Use semantic colors that work in both light/dark â€” the fg/bg are theme tokens
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
      {t || "â€”"}
    </span>
  );
}

// â”€â”€ ATS badge â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ATSBadge({ score, onClick }) {
  if (score == null) return null;
  const bg = score>=80 ? "#dcfce7" : score>=60 ? "#fef9c3" : "#fee2e2";
  const fg = score>=80 ? "#166534" : score>=60 ? "#854d0e" : "#991b1b";
  return (
    <span
      onClick={onClick ? e => { e.stopPropagation(); onClick(); } : undefined}
      style={{ background:bg, color:fg, padding:"2px 8px",
               borderRadius:999, fontSize:10, fontWeight:700,
               cursor: onClick ? "pointer" : "default",
               border: onClick ? `1px solid ${fg}33` : "none" }}>
      ATS {score}
    </span>
  );
}

// â”€â”€ Resume badge â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ResumeBadge({ onClick, loading }) {
  return (
    <span
      onClick={onClick ? e => { e.stopPropagation(); onClick(); } : undefined}
      style={{ background:"#e8f6fb", color:"#1a6a8a", padding:"2px 8px",
               borderRadius:999, fontSize:10, fontWeight:700,
               cursor:"pointer", border:"1px solid #A8D8EA44",
               display:"inline-flex", alignItems:"center", gap:3 }}>
      {loading ? "â³" : "ðŸ“„"} Resume
    </span>
  );
}

// â”€â”€ Lucy button (rectangular â†’ pill on hover, 1s) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function LucyBtn({ children, onClick, disabled, accent: accentProp,
                    style = {}, title }) {
  const [hov, setHov] = useState(false);
  const { theme } = useTheme();
  const accent = accentProp || theme.accent;
  return (
    <button
      onClick={onClick} disabled={disabled} title={title}
      onMouseEnter={() => !disabled && setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        // Water-fill: gradient fills upward from bottom over 1s
        backgroundImage: `linear-gradient(to top, ${accent}, ${accent})`,
        backgroundSize: hov && !disabled ? "100% 100%" : "100% 0%",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "bottom",
        backgroundColor: "transparent",
        color: theme.text,
        border: `2.5px solid ${hov && !disabled ? accent : theme.borderStrong}`,
        cursor: disabled ? "not-allowed" : "pointer",
        padding: "7px 18px", fontWeight: 800, fontSize: 12,
        fontFamily: "'Barlow Condensed','DM Sans',sans-serif",
        letterSpacing: "0.1em", textTransform: "uppercase",
        borderRadius: hov && !disabled ? 999 : 2,
        transition: "background-size 1s ease, border-radius 1s ease, border-color 1s ease",
        whiteSpace: "nowrap", flexShrink: 0,
        opacity: disabled ? 0.4 : 1,
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4,
        ...style,
      }}>
      {children}
    </button>
  );
}

// â”€â”€ Icon button â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function IconBtn({ bg, onClick, title, children, disabled = false, size = 28 }) {
  const [hov, setHov] = useState(false);
  const { theme } = useTheme();
  return (
    <button title={title} disabled={disabled} onClick={onClick}
      onMouseEnter={() => !disabled && setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width:size, height:size, borderRadius:999,
        background: disabled ? theme.surfaceHigh : hov ? bg : theme.surfaceHigh,
        border:`1px solid ${disabled ? theme.border : hov ? bg+"44" : theme.border}`,
        display:"flex", alignItems:"center", justifyContent:"center",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize:12, color: hov && !disabled ? "white" : theme.textMuted,
        opacity: disabled ? 0.4 : 1,
        transition:"all 0.15s ease", flexShrink:0,
        transform: hov && !disabled ? "scale(1.1)" : "scale(1)",
      }}>
      {children}
    </button>
  );
}

const EMP_TYPE_OPTIONS = [
  { value:"full-time",  label:"Full-time" },
  { value:"contract",   label:"Contract"  },
  { value:"internship", label:"Internship"},
  { value:"part-time",  label:"Part-time" },
];

// â”€â”€ Filters panel (collapsible) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function FiltersPanel({
  open, onClose,
  categories,
  role, setRole,
  location, setLocation,
  workType, setWorkType,
  employmentTypePrefs, setEmploymentTypePrefs,
  catFilter, setCatFilter,
  srcFilter, setSrcFilter,
  minYoe, setMinYoe,
  maxYoe, setMaxYoe,
  maxApplicants, setMaxApplicants,
  visitedFilter, setVisitedFilter,
  ageFilter, setAgeFilter,
  onReset,
}) {
  const { theme } = useTheme();
  if (!open) return null;
  const selStyle = {
    width:"100%", height:36, padding:"0 10px",
    border:`1px solid ${theme.border}`, borderRadius:4,
    background:theme.surface, color:theme.text, fontSize:12, outline:"none",
  };
  const labelStyle = { fontSize:11, fontWeight:700, color:theme.textMuted,
                        textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 };
  return (
    <div style={{
      position:"fixed", inset:0, zIndex:500,
      display:"flex", alignItems:"flex-start", justifyContent:"flex-end",
    }}
    onClick={e => { if(e.target===e.currentTarget) onClose(); }}>
      <motion.div
        initial={{ x:360 }} animate={{ x:0 }} exit={{ x:360 }}
        transition={{ type:"tween", duration:0.22 }}
        style={{
          width:320, height:"100%", background:theme.surface,
          borderLeft:`3px solid ${theme.accent}`,
          padding:"24px 20px", overflowY:"auto",
          display:"flex", flexDirection:"column", gap:16,
        }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                          fontSize:20, letterSpacing:"0.06em", textTransform:"uppercase" }}>
            Filters
          </span>
          <button onClick={onClose} style={{ background:"none", border:"none",
                                             cursor:"pointer", fontSize:18, color:theme.textMuted }}>âœ•</button>
        </div>

        <div>
          <div style={labelStyle}>Role</div>
          <input value={role} onChange={e=>setRole(e.target.value)}
            placeholder="e.g. Software Engineer"
            style={{...selStyle, padding:"0 10px", height:36, borderRadius:4}}/>
        </div>

        <div>
          <div style={labelStyle}>Location</div>
          <input value={location} onChange={e=>setLocation(e.target.value)}
            placeholder="e.g. San Francisco"
            style={{...selStyle, padding:"0 10px", height:36, borderRadius:4}}/>
        </div>

        <div>
          <div style={labelStyle}>Work Type</div>
          <select value={workType} onChange={e=>setWorkType(e.target.value)} style={selStyle}>
            <option value="">All types</option>
            <option>Remote</option><option>Hybrid</option><option>Onsite</option>
          </select>
        </div>

        <div>
          <div style={labelStyle}>Employment Type</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
            {EMP_TYPE_OPTIONS.map(opt => {
              const active = employmentTypePrefs.includes(opt.value);
              return (
                <button key={opt.value}
                  type="button"
                  onClick={() => {
                    const next = active
                      ? employmentTypePrefs.filter(v => v !== opt.value)
                      : [...employmentTypePrefs, opt.value];
                    // Always keep at least one selected
                    if (next.length > 0) setEmploymentTypePrefs(next);
                  }}
                  style={{
                    padding:"5px 12px", borderRadius:999, fontSize:11, fontWeight:600,
                    cursor:"pointer", border:`1px solid ${active ? theme.accent : theme.border}`,
                    background: active ? theme.accentMuted : "transparent",
                    color: active ? theme.accentText : theme.textMuted,
                    transition:"all 0.15s",
                  }}>
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div style={labelStyle}>Category</div>
          <select value={catFilter} onChange={e=>setCatFilter(e.target.value)} style={selStyle}>
            <option value="">All categories</option>
            {categories.map(c=><option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div>
          <div style={labelStyle}>Source</div>
          <select value={srcFilter} onChange={e=>setSrcFilter(e.target.value)} style={selStyle}>
            <option value="">All sources</option>
            <option value="linkedin">LinkedIn</option>
            <option value="indeed">Indeed</option>
          </select>
        </div>

        <div>
          <div style={labelStyle}>Date Posted</div>
          <select value={ageFilter} onChange={e=>setAgeFilter(e.target.value)} style={selStyle}>
            <option value="">Any time</option>
            <option value="1d">Past 24h</option>
            <option value="2d">Past 2 days</option>
            <option value="3d">Past 3 days</option>
            <option value="1w">Past week</option>
            <option value="1m">Past month</option>
          </select>
        </div>

        <div>
          <div style={labelStyle}>
            Years of Experience: {minYoe || 0}â€“{maxYoe || "Any"}
          </div>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <input type="number" min={0} max={30} placeholder="Min"
              value={minYoe} onChange={e=>setMinYoe(e.target.value)}
              style={{...selStyle, width:70}}/>
            <span style={{ fontSize:12, color:theme.textMuted }}>to</span>
            <input type="number" min={0} max={30} placeholder="Max"
              value={maxYoe} onChange={e=>setMaxYoe(e.target.value)}
              style={{...selStyle, width:70}}/>
          </div>
        </div>

        <div>
          <div style={labelStyle}>Max Applicants</div>
          <input type="number" min={0} placeholder="e.g. 100"
            value={maxApplicants} onChange={e=>setMaxApplicants(e.target.value)}
            style={{...selStyle, width:"100%"}}/>
          <div style={{ fontSize:10, color:theme.textDim, marginTop:4 }}>
            Hide jobs with more applicants than this
          </div>
        </div>

        <div>
          <div style={labelStyle}>Status</div>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            <select value={visitedFilter} onChange={e=>setVisitedFilter(e.target.value)} style={selStyle}>
              <option value="">Visited & unvisited</option>
              <option value="0">Unvisited only</option>
              <option value="1">Visited only</option>
            </select>
          </div>
        </div>

        {/* Coming soon: Salary range filter */}
        <div style={{ padding:"10px 12px", background:theme.surfaceHigh, borderRadius:4,
                      border:`1px dashed ${theme.border}`, opacity:0.7 }}>
          <div style={{ ...labelStyle, marginBottom:6 }}>Salary Range
            <span style={{ marginLeft:6, fontSize:9, padding:"1px 6px", borderRadius:999,
                           background:"#f3f4f6", color:"#9ca3af", border:"1px dashed #d1d5db",
                           fontWeight:700, letterSpacing:"0.04em" }}>soon</span>
          </div>
          <div style={{ display:"flex", gap:6 }}>
            <input disabled placeholder="$60k" style={{...selStyle, flex:1, opacity:0.5, cursor:"not-allowed"}}/>
            <input disabled placeholder="$200k" style={{...selStyle, flex:1, opacity:0.5, cursor:"not-allowed"}}/>
          </div>
        </div>

        <div style={{ display:"flex", gap:8, paddingTop:8 }}>
          <LucyBtn onClick={onReset} accent={theme.surfaceHigh} style={{ flex:1 }}>
            Reset All
          </LucyBtn>
          <LucyBtn onClick={onClose} style={{ flex:1 }}>
            Apply
          </LucyBtn>
        </div>
      </motion.div>
    </div>
  );
}

// -- Aliases (mirrors server normaliser) -----------------------
const ALIASES = {
  "swe":"Software Engineer","software dev":"Software Engineer",
  "mle":"Machine Learning Engineer","ml":"Machine Learning Engineer",
  "ds":"Data Scientist","sde":"Software Engineer",
  "frontend":"Frontend Engineer","front end":"Frontend Engineer",
  "backend":"Backend Engineer","back end":"Backend Engineer",
  "fullstack":"Full Stack Engineer","full stack":"Full Stack Engineer",
  "devops":"DevOps Engineer","sre":"Site Reliability Engineer",
  "pm":"Product Manager","tpm":"Technical Program Manager","em":"Engineering Manager",
  "de":"Data Engineer","ai engineer":"AI Engineer",
  "genai":"Generative AI Engineer","gen ai":"Generative AI Engineer","llm":"LLM Engineer",
};

// -- Pull-to-refresh -------------------------------------------
function PullToRefresh({ onRefresh, refreshing, theme, children }) {
  const scrollRef = useRef(null);
  const { update: updateScroll, scrollToTopRef } = useAppScroll();
  const [pullY,   setPullY]   = useState(0);
  const [ready,   setReady]   = useState(false);
  const startY = useRef(null);
  const THRESHOLD = 56;

  // Register scroll-to-top fn so goPage can scroll this container, not window
  useEffect(() => {
    scrollToTopRef.current = () => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    };
    return () => { scrollToTopRef.current = null; };
  }, [scrollToTopRef]);

  // Touch: pull-down gesture when already at the top
  const onTouchStart = (e) => {
    if ((scrollRef.current?.scrollTop ?? 1) === 0)
      startY.current = e.touches[0].clientY;
  };
  const onTouchMove = (e) => {
    if (startY.current === null) return;
    const dy = e.touches[0].clientY - startY.current;
    if (dy > 0) {
      setPullY(Math.min(dy * 0.55, THRESHOLD + 20));
      setReady(dy * 0.55 >= THRESHOLD);
    }
  };
  const onTouchEnd = () => {
    if (ready) onRefresh();
    setPullY(0); setReady(false); startY.current = null;
  };

  // Desktop: expose the scrollRef so parent can detect wheel-at-top if needed
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      {/* Pull indicator — animates down then snaps back */}
      <div style={{
        height: pullY, flexShrink:0, overflow:"hidden",
        display:"flex", alignItems:"center", justifyContent:"center",
        background: theme.accentMuted,
        transition: pullY === 0 ? "height 0.22s ease" : "none",
      }}>
        {pullY > 12 && (
          <span style={{ fontSize:11, fontWeight:700, color:theme.accentText }}>
            {ready ? "? Release to refresh" : "? Keep pulling…"}
          </span>
        )}
      </div>

      {/* Desktop "check for new" strip — visible at very top, compact */}
      {!refreshing && pullY === 0 && (
        <div onClick={onRefresh} style={{
          flexShrink:0, padding:"4px 20px",
          display:"flex", alignItems:"center", justifyContent:"center", gap:6,
          background:theme.accentMuted, borderBottom:`1px solid ${theme.accent}22`,
          cursor:"pointer", fontSize:10, fontWeight:700,
          color:theme.accentText, letterSpacing:"0.06em", textTransform:"uppercase",
        }}>
          ? Check for new jobs
        </div>
      )}
      {refreshing && (
        <div style={{
          flexShrink:0, padding:"4px 20px",
          display:"flex", alignItems:"center", justifyContent:"center", gap:6,
          background:theme.accentMuted, borderBottom:`1px solid ${theme.accent}22`,
          fontSize:10, fontWeight:700, color:theme.accentText,
          letterSpacing:"0.06em", textTransform:"uppercase",
        }}>
          <span style={{ display:"inline-block", animation:"spin 0.8s linear infinite" }}>?</span>
          Checking…
        </div>
      )}

      <div
        ref={scrollRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onScroll={(e) => updateScroll(e.currentTarget.scrollTop / 90)}
        style={{ flex:1, overflowY:"auto", paddingTop:4, paddingBottom:8 }}>
        {children}
      </div>
    </div>
  );
}



// DEFAULT SIZES (canonical, do not edit inline):
// A+B only:       A=30  B=70
// A+B+C:          A=10  B=43  C=47
// A+B+D:          A=10  B=65  D=25
// A+B+C+D:        A=10  B=33  C=33  D=24
// Rule: A=10% whenever any panel beyond B is open.
// Reset fires via useEffect on C/D visibility change.
// ALL panel open triggers share one visibility setter —
// never set panel visibility outside openSandbox / openAtsPanel.
// To change defaults edit getPanelDefaults() below.
// -- Card tier — driven by open-panel count, not pixel width ------
// Tier 1 (full layout):  A alone, or A+B (detail only, 30% default)
// Tier 3 (condensed):    A+B+C or A+B+C+D (panel A shrinks to 10%)
// Tier 2 (medium):       only reached by manual drag — ResizeObserver
//                        overrides Tier 1 ? 2 when user drags A to 180-279px.
//                        Tier 3 always wins over pixel measurement.
function getCardTier(panelBVisible, panelCVisible, panelDVisible) {
  const extraPanels = [panelBVisible, panelCVisible, panelDVisible].filter(Boolean).length;
  if (extraPanels === 0) return 1; // A only — full width
  if (extraPanels === 1) return 1; // A+B — still 30%, full layout
  return 3;                        // A+B+C or A+B+C+D — 10%, condensed
}

function getPanelDefaults(showDetail, showSandbox, showAts) {
  const count = [true, showDetail, showSandbox, showAts].filter(Boolean).length;
  // Only jobs panel visible
  if (count === 1) return { jobs: 100, detail: 0, sandbox: 0, ats: 0 };
  // Two-panel: A + B — A=30%, B=70%
  if (count === 2 && showDetail && !showSandbox && !showAts) return { jobs: 30, detail: 70, sandbox: 0, ats: 0 };
  // All four panels: A=10% B=33% C=33% D=24%
  if (showDetail && showSandbox && showAts) return { jobs: 10, detail: 33, sandbox: 33, ats: 24 };
  // A + B + C (sandbox, no ATS): A=10% B=43% C=47%
  if (showDetail && showSandbox && !showAts) return { jobs: 10, detail: 43, sandbox: 47, ats: 0 };
  // A + B + D (ATS, no sandbox): A=10% B=65% D=25%
  if (showDetail && !showSandbox && showAts) return { jobs: 10, detail: 65, sandbox: 0, ats: 25 };
  // Fallback: A=10, D=25 if visible, remainder split B+C
  const aSize = 10, dSize = showAts ? 25 : 0;
  const remaining = 100 - aSize - dSize;
  const bcPanels = [showDetail, showSandbox].filter(Boolean).length;
  if (bcPanels === 0) return { jobs: 10, detail: 0, sandbox: 0, ats: 90 };
  const bcSize = remaining / bcPanels;
  return { jobs: aSize, detail: showDetail ? bcSize : 0, sandbox: showSandbox ? bcSize : 0, ats: dSize };
}

// -- Main panel ------------------------------------------------
export default function JobsPanel({ user, onUserChange, refreshKey = 0, onResumeStateChange, isActive = true }) {
  const { theme, isDark } = useTheme();
  const { mode: vpMode } = useViewport();
  const { pin: pinDock, scrollToTopRef, progress: scrollProgress } = useAppScroll();
  const isWide     = vpMode === "wide";
  const isMobile   = vpMode === "mobile" || vpMode === "tablet";
  const isPortrait = vpMode === "portrait" || vpMode === "laptop";

  // Mobile pane state
  const [mobilePane, setMobilePane] = useState("jobs"); // "jobs" | "editor" | "ats"

  // Tracks jobs disliked in this browser session — survives filter/sort refetches
  // but is cleared on page reload (so server exclusions take effect on next login)
  const sessionDislikedRef = useRef(new Map()); // jobId ? job object

  // Job data
  const [jobs,        setJobs]        = useState([]);
  const [totalJobs,   setTotalJobs]   = useState(0);
  const [totalPages,  setTotalPages]  = useState(0);
  const [currentPage, setCurrentPage] = useState(1);

  // UI state
  const [scraping,    setScraping]    = useState(false);  // Apify live scrape
  const [bgLoading,   setBgLoading]   = useState(false);  // background DB fetch
  const [categories,  setCategories]  = useState([]);
  const [resumeText,  setResumeText]  = useState("");
  const [fileName,    setFileName]    = useState("");
  const [uploading,   setUploading]   = useState(false);
  const [generated,   setGenerated]   = useState({});
  const [loading,     setLoading]     = useState({});
  const [sandbox,     setSandbox]     = useState(null);
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const [rightTab,      setRightTab]      = useState("history");
  const [rightPanelOpen, setRightPanelOpen] = useState(false);

  // Split view
  const [selectedJob,  setSelectedJob]  = useState(null);

  // Open / close sandbox — panel size rebalancing handled by useEffect below
  const openSandbox = useCallback((entry) => {
    setSandbox(entry);
    setSandboxOpen(true);
    if (isMobile) setMobilePane("editor");
  }, [isMobile]);

  const closeSandbox = useCallback(() => {
    setSandboxOpen(false);
    if (isMobile) setMobilePane("jobs");
  }, [isMobile]);

  const openAtsPanel = useCallback((atsData) => {
    if (atsData) setActiveAts(atsData);
    setRightPanelOpen(true);
    setRightTab("ats");
    if (isMobile) setMobilePane("ats");
  }, [isMobile]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeAtsPanel = useCallback(() => {
    setRightPanelOpen(false);
  }, []);

  const [activeAts,   setActiveAts]   = useState(null);
  const [smartSearching, setSmartSearching] = useState(false);

  // Domain profiles
  const [domainProfiles,   setDomainProfiles]   = useState([]);
  const [profileWizardOpen, setProfileWizardOpen] = useState(false);
  // Increments when active profile changes — triggers job board refetch
  const [profileSwitchKey, setProfileSwitchKey] = useState(0);

  // Load domain profiles on mount
  useEffect(() => {
    api("/api/domain-profiles").then(setDomainProfiles).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Live scrape status
  const [scrapeError,    setScrapeError]    = useState("");
  const [scrapeNewCount, setScrapeNewCount] = useState(0);

  // LIVE POLLING: polls /api/jobs/poll every 4s during active scrape.
  // Stops when scraping:false returned or after 3 consecutive failures.
  // To change poll interval edit POLL_INTERVAL_MS below.
  const POLL_INTERVAL_MS = 4000;
  const [pollStatus,   setPollStatus]   = useState("idle"); // "idle"|"polling"|"complete"|"error"
  const [pollNewCount, setPollNewCount] = useState(0);
  const pollIntervalRef = useRef(null);

  // AUTO-SCRAPE: Set Role triggers background scrape automatically if local results < 50
  // (THRESHOLD in server.js). Search New always forces a fresh scrape.
  // To change the threshold edit THRESHOLD in /api/scrape.
  const [resultsUpToDate, setResultsUpToDate] = useState(false);

  // Generation progress
  const [genStage, setGenStage] = useState("");
  const genTimerRef = useRef(null);

  // Panel resize refs (react-resizable-panels imperative API)
  const jobsPanelRef    = useRef(null);
  const detailPanelRef  = useRef(null);
  const sandboxPanelRef = useRef(null);
  const atsPanelRef     = useRef(null);

  // ResizeObserver: tracks manual drag width for Tier 1 ? 2 override only
  const jobsPanelElementRef = useRef(null);
  const [manualWidth, setManualWidth] = useState(null);

  // effectiveTier: panel count is primary driver; ResizeObserver only overrides Tier 1 ? 2
  const effectiveTier = useMemo(() => {
    const baseTier = getCardTier(!!selectedJob, sandboxOpen, rightPanelOpen);
    if (baseTier === 3) return 3; // panel count wins — never override Tier 3
    if (manualWidth !== null && manualWidth < 280 && manualWidth >= 180) return 2;
    return baseTier;
  }, [!!selectedJob, sandboxOpen, rightPanelOpen, manualWidth]); // eslint-disable-line react-hooks/exhaustive-deps


  // Task 5 — Inline error states
  const [smartSearchError, setSmartSearchError] = useState("");
  const [uploadError,      setUploadError]      = useState("");

  // Task 6 — Company reuse modal
  const [companyReuseTarget, setCompanyReuseTarget] = useState(null);

  // Board tabs — shared via JobBoardContext so TopBar compact row can drive them
  const { boardTab, setBoardTab, localSearch, setLocalSearch, sortBy, setSortBy } = useJobBoard();
  const [pendingJobs, setPendingJobs] = useState([]);

  // Enhance resume state
  // ENHANCE GATING: one free per account lifetime.
  // enhance_used is set server-side on API call, not on adoption. Cannot be reset.
  // Future paid unlock: enhance_paid flag in users table.
  // To change gating logic: edit /api/base-resume/enhance in server.js and update enhance-status response.
  const [enhanceUsed,    setEnhanceUsed]    = useState(false);
  const [enhancePaid,    setEnhancePaid]    = useState(false);
  const [enhancing,      setEnhancing]      = useState(false);
  const [enhanceResult,  setEnhanceResult]  = useState(null); // { original, enhanced, delta }
  const [enhanceModalOpen, setEnhanceModalOpen] = useState(false);

  // Filter panel
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Employment type preferences — persisted in localStorage
  const [employmentTypePrefs, setEmploymentTypePrefsRaw] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("empTypePrefs") || "null");
      return Array.isArray(saved) && saved.length ? saved : ["full-time"];
    } catch { return ["full-time"]; }
  });
  const setEmploymentTypePrefs = (val) => {
    setEmploymentTypePrefsRaw(val);
    try { localStorage.setItem("empTypePrefs", JSON.stringify(val)); } catch {}
  };

  // Scrape trigger input
  const [searchInput, setSearchInput] = useState("");

  // Filters
  const [roleFilter,    setRoleFilter]    = useState("");
  const [locationFilter,setLocationFilter]= useState("");
  const [workType,      setWorkType]      = useState("");
  const [catFilter,     setCatFilter]     = useState("");
  const [srcFilter,     setSrcFilter]     = useState("");
  const [minYoe,        setMinYoe]        = useState("");
  const [maxYoe,        setMaxYoe]        = useState("");
  const [maxApplicants, setMaxApplicants] = useState("");
  const [visitedFilter, setVisitedFilter] = useState("");
  const [ageFilter,     setAgeFilter]     = useState("");

  const fileRef        = useRef();
  const jobCountRef    = useRef(0);
  const displayJobsRef = useRef([]);
  jobCountRef.current = jobs.length;
  const applyMode = user?.applyMode || "SIMPLE";
  const planTier = String(user?.planTier || "BASIC").toUpperCase();
  const canUseGenerate = planTier === "PLUS" || planTier === "PRO";
  const canUseAPlusResume = planTier === "PRO";

  // Apply initial A+B defaults (30/70) once on mount.
  // The visibility-change effect below doesn't fire on first render because
  // C and D start false — this effect covers that gap.
  useEffect(() => {
    if (isMobile) return;
    let r1, r2, r3;
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => {
        r3 = requestAnimationFrame(() => {
          try {
            if (jobsPanelRef.current)   jobsPanelRef.current.resize(30);
            if (detailPanelRef.current) detailPanelRef.current.resize(70);
          } catch(e) { console.warn("[panels] initial resize not ready:", e.message); }
        });
      });
    });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); cancelAnimationFrame(r3); };
  }, [isMobile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset panel sizes to defaults when panel visibility changes.
  // Triple RAF ensures react-resizable-panels has fully committed the new
  // layout before imperative resize() calls fire. resize() can throw if the
  // panel is not yet initialised — catch silently, next interaction corrects.
  useEffect(() => {
    if (isMobile) return;
    const showDetail  = !!selectedJob;
    const showSandbox = sandboxOpen;
    const showAts     = rightPanelOpen;
    const d = getPanelDefaults(showDetail, showSandbox, showAts);
    let r1, r2, r3;
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => {
        r3 = requestAnimationFrame(() => {
          try {
            if (jobsPanelRef.current)                           jobsPanelRef.current.resize(d.jobs);
            if (showDetail  && detailPanelRef.current)          detailPanelRef.current.resize(d.detail);
            if (showSandbox && sandboxPanelRef.current)         sandboxPanelRef.current.resize(d.sandbox);
            if (showAts     && atsPanelRef.current)             atsPanelRef.current.resize(d.ats);
          } catch(e) { console.warn("[panels] resize not ready:", e.message); }
        });
      });
    });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); cancelAnimationFrame(r3); };
  }, [!!selectedJob, sandboxOpen, rightPanelOpen, isMobile]); // eslint-disable-line react-hooks/exhaustive-deps

  // ResizeObserver — only used for Tier 1 ? 2 manual-drag fallback
  useEffect(() => {
    const el = jobsPanelElementRef.current;
    if (!el) return;
    let debounceTimer;
    const ro = new ResizeObserver(entries => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const w = entries[0]?.contentRect.width;
        if (w !== undefined) setManualWidth(w);
      }, 50);
    });
    ro.observe(el);
    return () => { clearTimeout(debounceTimer); ro.disconnect(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-open resume + ATS panel when a pending job card is selected
  useEffect(() => {
    if (!selectedJob || boardTab !== "pending") return;
    const key = selectedJob.jobId;

    // If pending job response included resume_html, use it directly (no extra fetch)
    if (selectedJob.resume_html) {
      const entry = {
        html:      selectedJob.resume_html,
        atsScore:  selectedJob.ats_score,
        atsReport: selectedJob.ats_report,
        company:   selectedJob.company,
        title:     selectedJob.title,
        jobId:     selectedJob.jobId,
        tool:      selectedJob.apply_mode === "CUSTOM_SAMPLER" ? A_PLUS_TOOL : GENERATE_TOOL,
        toolLabel: selectedJob.apply_mode === "CUSTOM_SAMPLER" ? TOOL_LABELS[A_PLUS_TOOL] : TOOL_LABELS[GENERATE_TOOL],
      };
      setGenerated(p => ({ ...p, [key]: entry }));
      openSandbox({ ...entry });
      openAtsPanel({ score: entry.atsScore, report: entry.atsReport,
                     company: selectedJob.company, title: selectedJob.title });
      return;
    }

    // Fallback: resume exists in DB (generated[key] = __exists__) — fetch on demand
    if (generated[key]?.html) {
      generateActual(selectedJob, false, true);
      return;
    }

    // No resume data found — show error in sandbox
    openSandbox({
      generating: false,
      error: "Resume data not found — try regenerating.",
      company: selectedJob.company,
      title:   selectedJob.title,
    });
  }, [selectedJob?.jobId, boardTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleResumeClear = useCallback(() => {
    setResumeText(""); setFileName("");
    api("/api/base-resume", { method:"POST", body:JSON.stringify({ content:"", name:"" }) });
  }, []);

  useEffect(() => {
    onResumeStateChange?.({
      text: resumeText, fileName, uploading,
      onUploadClick: () => fileRef.current?.click(),
      onClear: handleResumeClear,
      enhanceUsed, enhancePaid, enhancing,
      onEnhance: handleEnhance,
    });
  }, [resumeText, fileName, uploading, enhanceUsed, enhancePaid, enhancing]); // eslint-disable-line react-hooks/exhaustive-deps
  const PAGE_SIZE = 25;

  // -- Split-view: job selection ---------------------------------
  const handleJobSelect = useCallback((job) => {
    setSelectedJob(prev => {
      if (prev?.jobId === job.jobId) return null; // toggle off
      return job;
    });
    markVisited(job.jobId);
    if (!job.visited) {
      api(`/api/jobs/${job.jobId}/visited`, { method:"PATCH" }).catch(()=>{});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard nav: Escape closes, ArrowUp/Down navigates
  useEffect(() => {
    if (!selectedJob) return;
    const handler = (e) => {
      if (e.key === "Escape") { setSelectedJob(null); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedJob(prev => {
          if (!prev) return prev;
          const jobs = displayJobsRef.current;
          const idx = jobs.findIndex(j => j.jobId === prev.jobId);
          const nextIdx = e.key === "ArrowDown" ? idx + 1 : idx - 1;
          if (nextIdx >= 0 && nextIdx < jobs.length) {
            const next = jobs[nextIdx];
            markVisited(next.jobId);
            return next;
          }
          return prev;
        });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedJob]); // eslint-disable-line react-hooks/exhaustive-deps

  // -- Build query params from current filter state ----------
  const buildParams = useCallback((page = 1, overrideStarred = null) => {
    const p = new URLSearchParams();
    p.set("page", String(page));
    p.set("pageSize", String(PAGE_SIZE));
    p.set("sort", sortBy);
    if (roleFilter.trim())    p.set("role",     roleFilter.trim().toLowerCase());
    if (locationFilter.trim())p.set("location", locationFilter.trim());
    if (workType)             p.set("workType", workType);
    if (employmentTypePrefs.length && !(employmentTypePrefs.length === 1 && employmentTypePrefs[0] === "full-time"))
      p.set("employmentType", employmentTypePrefs.join(","));
    if (catFilter)            p.set("category", catFilter);
    if (srcFilter)            p.set("source",   srcFilter);
    if (minYoe !== "")        p.set("minYoe",        minYoe);
    if (maxYoe !== "")        p.set("maxYoe",        maxYoe);
    if (maxApplicants !== "") p.set("maxApplicants", maxApplicants);
    if (visitedFilter)        p.set("visited",       visitedFilter);
    if (ageFilter)            p.set("ageFilter",     ageFilter);
    if (overrideStarred === "1" || boardTab === "saved") p.set("starred","1");
    if (localSearch.trim())   p.set("localSearch",   localSearch.trim().toLowerCase());
    return p.toString();
  }, [sortBy, roleFilter, locationFilter, workType, employmentTypePrefs, catFilter, srcFilter,
      minYoe, maxYoe, maxApplicants, visitedFilter, ageFilter, boardTab, localSearch]);

  // -- Fetch pending jobs ----------------------------------------
  const fetchPending = useCallback(async () => {
    try {
      const rows = await api("/api/jobs/pending");
      setPendingJobs(Array.isArray(rows) ? rows : []);
    } catch {}
  }, []);

  // -- Fetch jobs — never clears board before data arrives ------
  const fetchJobs = useCallback(async (page = 1, mergeMode = false) => {
    if (boardTab === "pending") { fetchPending(); return; }
    setBgLoading(true);
    try {
      const qs = buildParams(page);
      const d = await api(`/api/jobs?${qs}`);
      if (d.needsProfileSetup) {
        setScrapeError("Create a job search profile to load matching jobs.");
      }
      const incoming = d.jobs || [];
      if (mergeMode) {
        setJobs(prev => {
          const map = new Map(prev.map(j => [j.jobId, j]));
          incoming.forEach(j => map.set(j.jobId, j));
          return [...map.values()];
        });
      } else {
        // Replace list but re-inject any jobs disliked this session so they
        // remain visible (faded) until the user reloads the page.
        setJobs(() => {
          const result = new Map(incoming.map(j => [j.jobId, j]));
          for (const [id, job] of sessionDislikedRef.current) {
            if (!result.has(id)) result.set(id, job);
          }
          return [...result.values()];
        });
      }
      setTotalJobs(d.total || 0);
      setTotalPages(d.totalPages || 0);
      setCurrentPage(page);
    } finally {
      setBgLoading(false);
    }
  }, [buildParams, boardTab, fetchPending]);

  // -- Boot --------------------------------------------------
  useEffect(() => {
    if (!user) return;
    Promise.all([
      api("/api/jobs?page=1&pageSize=25&sort=dateDesc"),
      api("/api/categories"),
      api("/api/base-resume"),
      api("/api/resumes"),
    ]).then(([jr, cats, rr, gr]) => {
      setJobs(jr.jobs || []);
      setTotalJobs(jr.total || 0);
      setTotalPages(jr.totalPages || 0);
      setCategories(cats || []);
      if (rr.content) { setResumeText(rr.content); setFileName(rr.name || "Saved resume"); }
      if (gr?.length) {
        const map = {};
        gr.forEach(r => { map[r.job_id] = { html:"__exists__", atsScore:r.ats_score,
          atsReport:r.ats_report, company:r.company, title:r.role,
          jobId:r.job_id, tool:r.apply_mode === "CUSTOM_SAMPLER" ? A_PLUS_TOOL : GENERATE_TOOL,
          toolLabel:r.apply_mode === "CUSTOM_SAMPLER" ? TOOL_LABELS[A_PLUS_TOOL] : TOOL_LABELS[GENERATE_TOOL] }; });
        setGenerated(map);
      }
    }).catch(console.error);
    // Fetch enhance status
    api("/api/base-resume/enhance-status").then(s => {
      setEnhanceUsed(s.enhanceUsed || false);
      setEnhancePaid(s.enhancePaid || false);
    }).catch(() => {});
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch when server-side filters/sort/tab change (background — board stays visible)
  // Note: localSearch is NOT in this dep array — it has its own debounced effect below
  useEffect(() => {
    if (!user) return;
    fetchJobs(1);
  }, [sortBy, roleFilter, locationFilter, workType, employmentTypePrefs, catFilter, srcFilter,
      minYoe, maxYoe, maxApplicants, visitedFilter, ageFilter, boardTab, refreshKey,
      profileSwitchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced backend search — fires 300ms after user stops typing
  useEffect(() => {
    if (!user) return;
    const timer = setTimeout(() => {
      setCurrentPage(1);
      fetchJobs(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [localSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Multi-session sync — reflect changes from other tabs/devices without full reload
  useSyncEvents({
    job_flag: ({ jobId, starred, disliked }) => {
      setJobs(prev => prev.map(j =>
        j.jobId === jobId
          ? { ...j, ...(starred  != null ? { starred:  !!starred,  disliked: false } : {}),
                     ...(disliked != null ? { disliked: !!disliked, starred:  false } : {}) }
          : j
      ));
    },
    resume_generated: () => {
      fetchJobs(currentPage);
    },
    profile_switched: () => {
      setProfileSwitchKey(k => k + 1);
    },
    scrape_complete: () => {
      fetchJobs(1);
    },
  });

  // Shared poll loop — used by handleSearch, handlePullRefresh, handleSetRole
  const startPollLoop = useCallback((roleQ, pollSince) => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    setPollStatus("polling");
    setPollNewCount(0);
    let failCount = 0;
    const seenIds = new Set();
    let totalNew = 0;

    pollIntervalRef.current = setInterval(async () => {
      try {
        const qs = new URLSearchParams({ since: String(pollSince), query: roleQ });
        const pollData = await api(`/api/jobs/poll?${qs.toString()}`);
        failCount = 0;
        if (pollData.needsProfileSetup) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
          setScraping(false);
          setPollStatus("idle");
          setScrapeError("Create a job search profile to load matching jobs.");
          return;
        }
        if (pollData.scrapeUnavailable && pollData.message) {
          setScrapeError(pollData.message);
        }

        const newJobs = (pollData.jobs || []).filter(j => !seenIds.has(j.jobId));
        if (newJobs.length > 0) {
          newJobs.forEach(j => seenIds.add(j.jobId));
          totalNew += newJobs.length;
          setPollNewCount(totalNew);
          setJobs(prev => {
            const existingIds = new Set(prev.map(j => j.jobId));
            const toAdd = newJobs.filter(j => !existingIds.has(j.jobId));
            return toAdd.length > 0 ? [...toAdd, ...prev] : prev;
          });
        }

        if (!pollData.scraping) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
          setScraping(false);
          setScrapeNewCount(totalNew);
          setPollStatus("complete");
          setTimeout(() => { setPollStatus("idle"); setScrapeNewCount(0); }, 5000);
        }
      } catch {
        failCount++;
        if (failCount >= 3) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
          setScraping(false);
          setPollStatus("error");
          setScrapeError("Could not fetch new jobs — check your Apify token");
        }
      }
    }, POLL_INTERVAL_MS);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Set active role — immediately shows DB results, then auto-scrapes if count < threshold
  const handleSetRole = useCallback(async (overrideQuery) => {
    const q = (overrideQuery || searchInput).trim();
    if (!q) return;
    setScrapeError("");
    setRoleFilter(q.toLowerCase());
    setSearchInput(q);
    fetchJobs(1);
    return;
    // AUTO-SCRAPE: silently trigger background scrape if local results < THRESHOLD (50)
    try {
      const result = await api("/api/scrape", { method:"POST", body:JSON.stringify({ query:q, ...buildScrapeParams({ workType, ageFilter, locationFilter, employmentTypePrefs }) }) });
      if (!result || result.missingToken || result.limitReached || result.error) return;
      const roleQ = (result.query || q).toLowerCase();
      if (result.scraping) {
        startPollLoop(roleQ, Date.now());
      } else if (result.fromCache) {
        setResultsUpToDate(true);
        setTimeout(() => setResultsUpToDate(false), 2000);
      }
    } catch {} // silent — DB results already shown
  }, [searchInput, startPollLoop]);

  // -- Scrape / search ---------------------------------------
  const handleSearch = useCallback(async (overrideQuery) => {
    const q = (overrideQuery || searchInput).trim();
    if (!q) return;
    setScrapeError("");
    setScraping(true);
    let managedByPoller = false;
    try {
      const result = await api("/api/scrape", { method:"POST", body:JSON.stringify({ query:q, ...buildScrapeParams({ workType, ageFilter, locationFilter, employmentTypePrefs }) }) });
      if (result.needsProfileSetup) {
        setScrapeError(result.error || "Create a job search profile to search jobs.");
        return;
      }
      if (result.missingToken) {
        setScrapeError("No Apify token set. Add it via avatar ? Apify Token.");
        return;
      }
      if (result.limitReached) {
        setScrapeError(result.error);
        return;
      }
      if (result.error) { setScrapeError(result.error); return; }

      // Server normalises the query (pm ? Product Manager); use it for role filter
      const roleQ = (result.query || q).toLowerCase();

      if (result.scraping) {
        managedByPoller = true;
        setRoleFilter(roleQ);
        startPollLoop(roleQ, Date.now());
        return;
      }

      // Cache hit — jobs already in DB
      const qs = new URLSearchParams();
      qs.set("page","1"); qs.set("pageSize","25"); qs.set("sort", sortBy);
      qs.set("role", roleQ);
      const d = await api(`/api/jobs?${qs.toString()}`);
      setJobs(() => {
        const result = new Map((d.jobs || []).map(j => [j.jobId, j]));
        for (const [id, job] of sessionDislikedRef.current) {
          if (!result.has(id)) result.set(id, job);
        }
        return [...result.values()];
      });
      setTotalJobs(d.total || 0);
      setTotalPages(d.totalPages || 0);
      setCurrentPage(1);
      setRoleFilter(roleQ);
    } catch(e) { setScrapeError(e.message); }
    finally { if (!managedByPoller) setScraping(false); }
  }, [searchInput, fetchJobs, jobs.length, sortBy, startPollLoop]); // eslint-disable-line react-hooks/exhaustive-deps

  // -- Pull / Check-for-new: DB-first, then scrape if quota unmet -
  // Merges new jobs into the board; removes visited entries.
  const handlePullRefresh = useCallback(async () => {
    const q = (searchInput || roleFilter).trim();
    if (!q) return;
    if (scraping || bgLoading) return;
    setScrapeError(""); setScrapeNewCount(0);
    setScraping(true);
    let managedByPoller = false;
    try {
      const result = await api("/api/scrape", { method:"POST", body:JSON.stringify({ query:q, ...buildScrapeParams({ workType, ageFilter, locationFilter, employmentTypePrefs }) }) });
      if (result.needsProfileSetup) {
        setScrapeError(result.error || "Create a job search profile to search jobs.");
        return;
      }
      if (result.missingToken) {
        setScrapeError("No Apify token — add it in avatar ? Apify Token.");
        return;
      }
      if (result.limitReached) {
        setScrapeError(result.error);
        return;
      }
      if (result.error) { setScrapeError(result.error); return; }

      const roleQ = (result.query || q).toLowerCase();

      if (result.scraping) {
        managedByPoller = true;
        setRoleFilter(roleQ);
        startPollLoop(roleQ, Date.now());
        return;
      }

      // Cache hit — merge immediately
      const qs = new URLSearchParams();
      qs.set("page","1"); qs.set("pageSize","50"); qs.set("sort", sortBy);
      qs.set("role", roleQ); qs.set("visited","0");
      const d = await api(`/api/jobs?${qs.toString()}`);
      const incoming = d.jobs || [];
      setJobs(prev => {
        const map = new Map(prev.filter(j => !j.visited).map(j => [j.jobId, j]));
        incoming.forEach(j => map.set(j.jobId, j));
        return [...map.values()].sort((a, b) =>
          new Date(b.postedAt || 0) - new Date(a.postedAt || 0)
        );
      });
      if (incoming.length > 0) {
        setScrapeNewCount(incoming.length);
        setTimeout(() => setScrapeNewCount(0), 4000);
      }
      setTotalJobs(d.total || 0);
      setRoleFilter(roleQ);
    } catch(e) { setScrapeError(e.message); }
    finally { if (!managedByPoller) setScraping(false); }
  }, [searchInput, roleFilter, sortBy, scraping, bgLoading, startPollLoop]); // eslint-disable-line react-hooks/exhaustive-deps

  // -- Legacy Refresh button (end-of-list) -----------------------
  const handleRefresh = handlePullRefresh;

  // -- Resume Enhancer ------------------------------------------
  const handleEnhance = useCallback(async () => {
    if (enhancing) return;
    setEnhancing(true);
    try {
      const result = await api("/api/base-resume/enhance", { method: "POST" });
      setEnhanceResult(result);
      setEnhanceModalOpen(true);
    } catch(e) {
      if (e.status === 403) {
        setEnhanceUsed(true);
      } else {
        setUploadError("Enhancement failed: " + e.message);
      }
    } finally {
      // Consume the free use regardless of outcome — server already set enhance_used
      setEnhanceUsed(true);
      setEnhancing(false);
    }
  }, [enhancing]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAdoptEnhanced = useCallback(async () => {
    try {
      await api("/api/base-resume/adopt-enhanced", { method: "PATCH" });
      if (enhanceResult?.enhanced?.text) setResumeText(enhanceResult.enhanced.text);
    } catch(e) { console.warn("[adopt]", e.message); }
    setEnhanceModalOpen(false);
  }, [enhanceResult]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSmartSearch = useCallback(async () => {
    if (!resumeText) {
      setSmartSearchError("Upload your base resume first — smart search extracts the best query from it.");
      fileRef.current?.click(); return;
    }
    setSmartSearchError("");
    setSmartSearching(true);
    try {
      const result = await api("/api/smart-search", { method:"POST", body:JSON.stringify({ resumeText }) });
      if (result.error) { setSmartSearchError(result.error); return; }
      const q = result.searchQuery;
      if (q) { setSearchInput(q); await handleSearch(q); }
    } catch(e) { setSmartSearchError("Smart search failed: " + e.message); }
    finally { setSmartSearching(false); }
  }, [resumeText, handleSearch]);

  // -- File upload -------------------------------------------
  const handleFile = useCallback(async e => {
    const file = e.target.files[0]; if (!file) return;
    setFileName(file.name); setUploading(true); setUploadError("");
    try {
      const ext = file.name.split(".").pop().toLowerCase();
      let text = "";
      if (ext === "pdf") {
        const fd = new FormData(); fd.append("file", file);
        const r = await fetch("/api/parse-pdf", { method:"POST", credentials:"include", headers:authHeaders(), body:fd });
        const d = await r.json(); if (d.error) throw new Error(d.error);
        text = d.text;
      } else if (ext === "docx") {
        const mammoth = (await import("mammoth")).default;
        text = (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
      } else { text = await file.text(); }
      setResumeText(text);
      await api("/api/base-resume", { method:"POST", body:JSON.stringify({ content:text, name:file.name }) });
    } catch(err) {
      setUploadError("Error: " + err.message);
      setFileName(""); if (fileRef.current) fileRef.current.value = "";
    } finally { setUploading(false); }
  }, []);

  // -- Generate (actual logic) -------------------------------
  const generateActual = useCallback(async (job, force = false, skipCompanyCheck = false, tool = "generate") => {
    tool = normalizeTool(tool);
    if (tool === A_PLUS_TOOL ? !canUseAPlusResume : !canUseGenerate) { return; }
    if (!resumeText)            { return; }
    const key = job.jobId, existing = generated[key];
    if (loading[key]) { return; }
    const existingArtifact = getActiveArtifact(existing, tool);
    if (existingArtifact?.html && existingArtifact.html !== "__exists__" && !force) {
      const entry = {...existing, ...existingArtifact, company:existingArtifact.company||job.company, title:existingArtifact.title||job.title};
      openSandbox(entry);
      openAtsPanel({ score:existingArtifact.atsScore, report:existingArtifact.atsReport, company:job.company, title:job.title });
      return;
    }
    if (existing?.html === "__exists__" && existing.tool === tool && !force) {
      // Resume exists in DB but not in memory — fetch on demand
      setLoading(p => ({ ...p, [key]: tool }));
      try {
        const d = await api(`/api/resumes/${key}`);
        const entry = buildArtifact(job, { html: d.html, ats_score: d.ats_score, atsReport: d.atsReport, company: d.company, role: d.role, tool }, tool);
        setGenerated(p => ({ ...p, [key]: entry }));
        openSandbox({ ...entry, company: entry.company, title: entry.title });
        openAtsPanel({ score: d.ats_score, report: d.atsReport, company: d.company, title: d.role });
      } catch(e) { setSandbox({ generating: false, error: e.message, company: job.company, title: job.title }); }
      finally { setLoading(p => { const n = {...p}; delete n[key]; return n; }); }
      return;
    }

    // Open sandbox with skeleton state immediately
    openSandbox({ generating: true, company: job.company, title: job.title, jobId:key, tool, toolLabel:TOOL_LABELS[tool] });

    // Cycle through generation stages
    const stages = [
      [0,    "Analysing job description…"],
      [5000, "Selecting companies…"],
      [12000,"Writing experience bullets…"],
      [22000,"Formatting resume…"],
    ];
    if (genTimerRef.current) clearInterval(genTimerRef.current);
    const startTime = Date.now();
    const advanceStage = () => {
      const elapsed = Date.now() - startTime;
      const current = [...stages].reverse().find(([ms]) => elapsed >= ms);
      const stage = current?.[1] || stages[0][1];
      setGenStage(stage);
      setSandbox(s => s?.generating ? { ...s, stage } : s);
    };
    advanceStage();
    genTimerRef.current = setInterval(advanceStage, 1000);

    setLoading(p => ({ ...p, [key]:tool }));
    try {
      const d = await api("/api/generate", { method:"POST",
        body:JSON.stringify({ jobId:key, job, resumeText, forceRegen:force, tool }) });
      if (d.limitReached) {
        setSandbox({ generating: false, error: d.error, company: job.company, title: job.title });
        return; // don't throw, just show error in sandbox panel
      }
      if (d.error) throw new Error(d.error);
      const artifact = buildArtifact(job, d, tool);
      setGenerated(p => ({ ...p, [key]: mergeArtifact(p[key], artifact) }));
      openSandbox(mergeArtifact(generated[key], artifact));
      openAtsPanel({ score:d.atsScore, report:d.atsReport, company:job.company, title:job.title });
    } catch(e) {
      setSandbox({ generating: false, error: e.message, company: job.company, title: job.title });
    }
    finally {
      if (genTimerRef.current) { clearInterval(genTimerRef.current); genTimerRef.current = null; }
      setGenStage("");
      setLoading(p => { const n = {...p}; delete n[key]; return n; });
    }
  }, [resumeText, generated, loading, canUseGenerate, canUseAPlusResume, openSandbox]); // eslint-disable-line react-hooks/exhaustive-deps

  // -- Generate (with company-reuse check) ------------------
  const generate = useCallback(async (job, force = false, tool = "generate") => {
    tool = normalizeTool(tool);
    if (tool === A_PLUS_TOOL ? !canUseAPlusResume : !canUseGenerate) { return; }
    if (!resumeText)            { return; }
    if (loading[job.jobId])     { return; }
    // Company check: if we have a prior resume for this company and this is a fresh generate (not force),
    // show the reuse modal instead of generating.
    if (!force) {
      const priorEntry = Object.values(generated).find(v =>
        getActiveArtifact(v)?.html && getActiveArtifact(v)?.html !== "__exists__" &&
        getActiveArtifact(v)?.company?.toLowerCase() === (job.company || "").toLowerCase()
      );
      if (priorEntry && !generated[job.jobId]?.html) {
        setCompanyReuseTarget({ job, priorEntry, tool });
        return;
      }
    }
    await generateActual(job, force, false, tool);
  }, [generated, generateActual, resumeText, canUseGenerate, canUseAPlusResume, loading]);

  const saveSandboxHtml = useCallback(async (html, artifact = null) => {
    const current = artifact || getActiveArtifact(sandbox);
    if (!current) return;
    const key = current.jobId || Object.entries(generated).find(([,v]) => getActiveArtifact(v)?.company === current.company)?.[0];
    if (key) {
      await api(`/api/resumes/${key}/html`, { method:"POST", body:JSON.stringify({ html, tool:current.tool, version:current.version }) });
      setGenerated(p => {
        const prev = p[key];
        const updated = { ...current, html };
        return { ...p, [key]: mergeArtifact(prev, updated) };
      });
    }
    setSandbox(s => ({...s, html}));
  }, [sandbox, generated]);

  const exportAndTrack = useCallback(async (job, html, company, artifact = null) => {
    const current = artifact || getActiveArtifact(sandbox);
    const targetJob = job || (current?.jobId ? {
      jobId: current.jobId, company: current.company, title: current.title,
      url: current.jobUrl, source: current.source, location: current.location,
    } : null);
    const filename = `Resume_${(company||current?.company||"").replace(/\s+/g,"_")}`;
    if (current?.jobId) {
      await api(`/api/resumes/${current.jobId}/keep`, { method:"POST",
        body:JSON.stringify({ tool:current.tool, version:current.version }) }).catch(()=>{});
    }
    printResume(html, filename);
    if (targetJob) {
      await api("/api/applications", { method:"POST", body:JSON.stringify({
        jobId:targetJob.jobId, company:targetJob.company, role:targetJob.title,
        jobUrl:targetJob.url, source:targetJob.source, location:targetJob.location,
        applyMode: current?.tool === A_PLUS_TOOL ? "CUSTOM_SAMPLER" : applyMode, resumeFile:filename + ".pdf",
      }) }).catch(()=>{});
      await fetchJobs(currentPage);
    }
  }, [applyMode, fetchJobs, currentPage, sandbox]);

  // -- Starred toggle ----------------------------------------
  const toggleStar = useCallback(async (jobId) => {
    try {
      const d = await api(`/api/jobs/${jobId}/starred`, { method:"PATCH" });
      setJobs(prev => prev.map(j => j.jobId === jobId ? {...j, starred: d.starred, disliked: false} : j));
    } catch {}
  }, []);

  // -- Dislike toggle — deferred removal ------------------------
  // Card stays visible (faded/greyed) for the rest of the session.
  // sessionDislikedRef ensures the card survives any fetchJobs call
  // (sort change, filter change, pagination, etc.) within this session.
  // Only a page reload clears the ref and lets the server exclusion apply.
  const toggleDislike = useCallback(async (jobId) => {
    try {
      const d = await dislikeJob(jobId);
      const isNowDisliked = !!d.disliked;
      setJobs(prev => {
        return prev.map(j => {
          if (j.jobId !== jobId) return j;
          const updated = { ...j, disliked: isNowDisliked, starred: isNowDisliked ? false : j.starred };
          if (isNowDisliked) {
            sessionDislikedRef.current.set(jobId, updated);
          } else {
            sessionDislikedRef.current.delete(jobId);
          }
          return updated;
        });
      });
      setPendingJobs(prev => prev.map(j => j.jobId !== jobId ? j : {
        ...j, disliked: isNowDisliked, starred: isNowDisliked ? false : j.starred,
      }));
    } catch {}
  }, []);

  // -- Mark visited in local state ---------------------------
  const markVisited = useCallback((jobId) => {
    setJobs(prev => prev.map(j => j.jobId === jobId ? {...j, visited:true} : j));
  }, []);

  // -- Direct URL open (no dialog) ------------------------------
  const visitUrl = useCallback(async (job) => {
    if (!job.url) return;
    try { await api(`/api/jobs/${job.jobId}/visited`, { method:"PATCH" }); } catch {}
    markVisited(job.jobId);
    window.open(job.url, "_blank", "noreferrer");
  }, [markVisited]);

  // -- Pagination --------------------------------------------
  const goPage = async (p) => {
    pinDock();                       // collapse dock immediately
    scrollToTopRef.current?.();      // scroll job list to top (not window)
    await fetchJobs(p);
  };

  // -- Filter reset ------------------------------------------
  const resetFilters = () => {
    setRoleFilter(""); setLocationFilter(""); setWorkType(""); setEmploymentTypePrefs(["full-time"]); setCatFilter("");
    setSrcFilter(""); setMinYoe(""); setMaxYoe(""); setMaxApplicants(""); setVisitedFilter("");
    setAgeFilter(""); setLocalSearch("");
  };

  // displayJobs: backend handles localSearch filtering across all pages
  const displayJobs = useMemo(() => {
    return boardTab === "pending" ? pendingJobs : jobs;
  }, [jobs, pendingJobs, boardTab]);
  displayJobsRef.current = displayJobs;

  const genCount = Object.values(generated).filter(v=>v?.html && v.html !== "__exists__").length;
  const normalisedPreview = ALIASES[searchInput.trim().toLowerCase()]
    || (searchInput.trim() ? searchInput.trim().replace(/\b\w/g, c=>c.toUpperCase()) : "");
  const showPreview = !!(normalisedPreview && normalisedPreview.toLowerCase() !== searchInput.trim().toLowerCase());

  const isLastPage = currentPage >= totalPages;

  // BUTTON STATES: 'Set Role' = save role + local DB lookup.
  // 'Refresh Search' = explicit Apify scrape/refresh.
  // To change labels edit the buttonLabel derived value below.
  const roleIsSet = !!roleFilter &&
    searchInput.trim().toLowerCase() === roleFilter.trim();
  const buttonLabel = scraping ? "Searching…" : roleIsSet ? "Refresh Search" : "Set Role";

  // Panel sizing is handled by react-resizable-panels + getPanelDefaults().
  // See the getPanelDefaults() function above for default size rules.

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", background:theme.bg }}>

      {/* Domain profile wizard modal (non-blocking "+ New Profile") */}
      {profileWizardOpen && (
        <DomainProfileWizard
          onComplete={profile => {
            setDomainProfiles(prev => [...prev, profile]);
            setProfileWizardOpen(false);
          }}
          onDismiss={() => setProfileWizardOpen(false)}
        />
      )}

      <AnimatePresence>
        {filtersOpen && (
          <FiltersPanel
            open={filtersOpen} onClose={() => setFiltersOpen(false)}
            categories={categories}
            role={roleFilter}         setRole={setRoleFilter}
            location={locationFilter} setLocation={setLocationFilter}
            workType={workType}       setWorkType={setWorkType}
            employmentTypePrefs={employmentTypePrefs} setEmploymentTypePrefs={setEmploymentTypePrefs}
            catFilter={catFilter}     setCatFilter={setCatFilter}
            srcFilter={srcFilter}     setSrcFilter={setSrcFilter}
            minYoe={minYoe}           setMinYoe={setMinYoe}
            maxYoe={maxYoe}           setMaxYoe={setMaxYoe}
            maxApplicants={maxApplicants} setMaxApplicants={setMaxApplicants}
            visitedFilter={visitedFilter} setVisitedFilter={setVisitedFilter}
            ageFilter={ageFilter}     setAgeFilter={setAgeFilter}
            onReset={resetFilters}
          />
        )}
      </AnimatePresence>

      {/* â”€â”€ Unified toolbar â€” hidden when dock is active (scrollProgress â‰¥ 0.5) â”€â”€ */}
      {/* Row A: tabs | filters | sort | local-search | job count */}
      {/* Row B (wraps): search input | Search | resume upload */}
      {scrollProgress < 0.5 && <div style={{
        background:theme.surface, borderBottom:`1px solid ${theme.border}`,
        padding:"10px 20px", display:"flex", alignItems:"center", gap:8,
        flexShrink:0, flexWrap:"wrap",
      }}>

        {/* â”€â”€ Row A â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {/* Board tabs */}
        <div style={{ display:"flex", flexShrink:0, overflow:"hidden",
                      border:`2px solid ${theme.borderStrong}`, borderRadius:2 }}>
          {[["all","All Jobs"],["saved","Saved â˜…"],["pending","Pending"]].map(([id,lbl]) => (
            <button key={id} onClick={() => setBoardTab(id)}
              style={{
                padding:"6px 16px", border:"none", cursor:"pointer",
                fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                fontSize:13, letterSpacing:"0.08em", textTransform:"uppercase",
                background: boardTab===id ? theme.accent : theme.surface,
                color: boardTab===id ? "#0f0f0f" : theme.text,
                transition:"background 0.15s",
                borderRight: `2px solid ${theme.borderStrong}`,
              }}>
              {lbl}
            </button>
          ))}
        </div>

        {/* Filters button â€” always visible, bold outline */}
        <button
          onClick={() => setFiltersOpen(o => !o)}
          style={{
            display:"inline-flex", alignItems:"center", gap:6, flexShrink:0,
            background: filtersOpen ? theme.accent : theme.surface,
            border: `2px solid ${theme.borderStrong}`,
            borderRadius:2, padding:"6px 16px",
            fontFamily:"'Barlow Condensed',sans-serif",
            fontWeight:800, fontSize:13, letterSpacing:"0.08em", textTransform:"uppercase",
            cursor:"pointer", color: filtersOpen ? "#0f0f0f" : theme.text,
            transition:"background 0.15s",
          }}>
          â–¤ Filters
        </button>

        {/* Sort */}
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}
          style={{ height:34, padding:"0 10px", borderRadius:2, flexShrink:0,
                   border:`2px solid ${theme.borderStrong}`, background:theme.surface,
                   fontSize:13, color:theme.text, outline:"none",
                   fontFamily:"'DM Sans',system-ui", cursor:"pointer" }}>
          <option value="dateDesc">Newest</option>
          <option value="dateAsc">Oldest</option>
          <option value="compHigh">Pay â†“</option>
          <option value="compLow">Pay â†‘</option>
          <option value="yoeLow">Exp â†‘</option>
          <option value="yoeHigh">Exp â†“</option>
          <option value="atsScore">ATS Sort</option>
        </select>

        {/* Local search â€” live client-side, every keystroke */}
        <input value={localSearch} onChange={e => setLocalSearch(e.target.value)}
          onKeyDown={e => { if (e.key === "Escape") setLocalSearch(""); }}
          placeholder="Filter loaded jobsâ€¦"
          style={{ flex:1, minWidth:140, height:34, padding:"0 12px",
                   borderRadius:2, border:`1px solid ${theme.border}`,
                   background:theme.surface, color:theme.text,
                   fontFamily:"'DM Sans',system-ui", fontSize:13, outline:"none" }}/>
        {localSearch && (
          <button onClick={() => setLocalSearch("")}
            style={{ background:"none", border:"none", color:theme.textDim,
                     cursor:"pointer", fontSize:14, padding:"0 2px", flexShrink:0 }}>âœ•</button>
        )}

        {/* Background loading indicator + job count */}
        <span style={{ fontSize:11, color:theme.textMuted, whiteSpace:"nowrap", flexShrink:0,
                       display:"flex", alignItems:"center", gap:5 }}>
          {bgLoading && (
            <span style={{ display:"inline-block", width:10, height:10,
                           border:`2px solid ${theme.border}`, borderTop:`2px solid ${theme.accent}`,
                           borderRadius:"50%", animation:"spin 0.7s linear infinite" }}/>
          )}
          {boardTab === "pending"
            ? `${displayJobs.length}`
            : `${totalJobs}`
          } job{totalJobs !== 1 ? "s" : ""}
          {localSearch && !bgLoading ? " matched" : ""}
        </span>

        {/* â”€â”€ Row B (wraps to next line) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {/* Full-width divider */}
        <div style={{ flexBasis:"100%", height:0 }}/>

        {/* Scrape query input */}
        <div style={{ position:"relative", flex:1, minWidth:200 }}>
          <span style={{ position:"absolute", left:12, top:"50%",
                         transform:"translateY(-50%)", fontSize:14, color:theme.textDim,
                         pointerEvents:"none" }}>ðŸ”</span>
          <input value={searchInput} onChange={e=>setSearchInput(e.target.value)}
            onKeyDown={e => e.key==="Enter" && (roleIsSet ? handleSearch() : handleSetRole())}
            placeholder="ATS search role â€” e.g. ML Engineer, SWEâ€¦"
            style={{ width:"100%", height:38, paddingLeft:38, paddingRight:14,
                     borderRadius:2, border:`1px solid ${theme.border}`,
                     background:theme.surface, color:theme.text,
                     fontFamily:"'DM Sans',system-ui", fontSize:13, outline:"none",
                     boxSizing:"border-box" }}/>
          {showPreview && (
            <div style={{ position:"absolute", top:"calc(100% + 4px)", left:0,
              fontSize:10, color:theme.textMuted, background:theme.surface,
              border:`1px solid ${theme.border}`,
              borderRadius:4, padding:"4px 10px", whiteSpace:"nowrap", zIndex:10 }}>
              Will search as: <span style={{ color:theme.accentText, fontWeight:700 }}>{normalisedPreview}</span>
            </div>
          )}
        </div>

        <LucyBtn
          onClick={() => roleIsSet ? handleSearch() : handleSetRole()}
          disabled={scraping || bgLoading}
          title={roleIsSet ? "Fetch new job listings for this role from LinkedIn" : "Set the role and show matching jobs already in the local pool"}>
          {buttonLabel}
        </LucyBtn>
        {smartSearchError && (
          <div style={{ flexBasis:"100%", padding:"4px 0", fontSize:11, color:"#991b1b" }}>
            âœ— {smartSearchError}
            <button onClick={() => setSmartSearchError("")} style={{ marginLeft:6, background:"none", border:"none", cursor:"pointer", fontSize:11, color:"#991b1b" }}>Dismiss</button>
          </div>
        )}

        {uploadError && (
          <div style={{ flexBasis:"100%", padding:"4px 0", fontSize:11, color:"#991b1b" }}>
            âœ— {uploadError}
            <button onClick={() => setUploadError("")} style={{ marginLeft:6, background:"none", border:"none", cursor:"pointer", fontSize:11, color:"#991b1b" }}>Dismiss</button>
          </div>
        )}

      </div>}
      {/* Hidden file input â€” always mounted so TopBar resume upload button works even when toolbar is hidden */}
      <input ref={fileRef} type="file" accept=".txt,.html,.md,.docx,.pdf"
        onChange={handleFile} style={{ display:"none" }}/>

      {/* â”€â”€ Resume Enhance modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {enhanceModalOpen && enhanceResult && (
        <div style={{
          position:"fixed", inset:0, zIndex:600,
          background:"rgba(0,0,0,0.6)", display:"flex", alignItems:"center", justifyContent:"center",
        }}>
          <div style={{
            background:theme.modalSurface || theme.surface, borderRadius:8, width:"min(92vw, 760px)",
            maxHeight:"85vh", overflowY:"auto", padding:0,
            border:`1px solid ${theme.border}`, boxShadow:"0 24px 64px rgba(0,0,0,0.35)",
          }}>
            {/* Header */}
            <div style={{ padding:"20px 24px 16px", borderBottom:`1px solid ${theme.border}` }}>
              <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                             fontSize:20, letterSpacing:"0.06em", textTransform:"uppercase" }}>
                Resume Enhancement
              </div>
              {enhanceResult.delta != null && (
                <div style={{ fontSize:12, color:theme.textMuted, marginTop:4 }}>
                  ATS score improved by
                  <span style={{ color: enhanceResult.delta > 0 ? "#16a34a" : "#dc2626",
                                  fontWeight:700, marginLeft:4 }}>
                    {enhanceResult.delta > 0 ? "+" : ""}{enhanceResult.delta} points
                  </span>
                  {" "}({enhanceResult.original?.atsScore ?? "â€”"} â†’ {enhanceResult.enhanced?.atsScore ?? "â€”"})
                </div>
              )}
            </div>
            {/* Side-by-side comparison */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:0 }}>
              <div style={{ padding:"16px 20px", borderRight:`1px solid ${theme.border}` }}>
                <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase",
                               letterSpacing:"0.06em", color:theme.textMuted, marginBottom:8 }}>
                  Original
                </div>
                <pre style={{ fontSize:11, color:theme.text, whiteSpace:"pre-wrap",
                               wordBreak:"break-word", maxHeight:340, overflowY:"auto",
                               fontFamily:"monospace", margin:0 }}>
                  {enhanceResult.original?.text}
                </pre>
              </div>
              <div style={{ padding:"16px 20px" }}>
                <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase",
                               letterSpacing:"0.06em", color:"#16a34a", marginBottom:8 }}>
                  Enhanced
                </div>
                <pre style={{ fontSize:11, color:theme.text, whiteSpace:"pre-wrap",
                               wordBreak:"break-word", maxHeight:340, overflowY:"auto",
                               fontFamily:"monospace", margin:0 }}>
                  {enhanceResult.enhanced?.text}
                </pre>
              </div>
            </div>
            {/* Footer */}
            <div style={{ padding:"16px 24px", borderTop:`1px solid ${theme.border}`,
                           display:"flex", flexDirection:"column", gap:10, alignItems:"center" }}>
              <div style={{ display:"flex", gap:10, width:"100%", justifyContent:"center" }}>
                <button onClick={handleAdoptEnhanced}
                  style={{
                    padding:"10px 24px", borderRadius:4, fontWeight:800, fontSize:13,
                    background:theme.accent, color:"#fff", border:"none", cursor:"pointer",
                    fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.06em",
                    textTransform:"uppercase",
                  }}>
                  Adopt Enhanced Version
                </button>
                <button onClick={() => setEnhanceModalOpen(false)}
                  style={{
                    padding:"10px 24px", borderRadius:4, fontWeight:800, fontSize:13,
                    background:"transparent", color:theme.textMuted,
                    border:`1.5px solid ${theme.border}`, cursor:"pointer",
                    fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.06em",
                    textTransform:"uppercase",
                  }}>
                  Keep Original
                </button>
              </div>
              <div style={{ fontSize:10, color:theme.textDim, textAlign:"center", maxWidth:480 }}>
                This is your one-time free enhancement. Your choice here does not affect whether it has been used.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* â”€â”€ Body: responsive layout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}

      {/* Company reuse modal (Task 6) */}
      {companyReuseTarget && (
        <CompanyReuseModal
          company={companyReuseTarget.job.company}
          theme={theme}
          onUseExisting={() => {
            const { job, priorEntry } = companyReuseTarget;
            setCompanyReuseTarget(null);
            const key = job.jobId;
            setGenerated(p => ({ ...p, [key]: priorEntry }));
            openSandbox({ ...priorEntry, company: job.company, title: job.title });
            if (priorEntry.atsReport || priorEntry.atsScore != null) {
              openAtsPanel({ score: priorEntry.atsScore, report: priorEntry.atsReport, company: job.company, title: job.title });
            }
          }}
          onGenerateNew={() => {
            const { job, tool } = companyReuseTarget;
            setCompanyReuseTarget(null);
            generateActual(job, false, true, tool);
          }}
          onCancel={() => setCompanyReuseTarget(null)}
        />
      )}

      {/* â”€â”€ MOBILE / TABLET: single-pane + bottom nav â”€â”€ */}
      {isMobile && (
        <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", position:"relative" }}>
          {/* Full-screen job detail overlay for mobile */}
          {selectedJob && (() => {
            const g2 = generated[selectedJob.jobId], done2 = !!g2?.html, st2 = loading[selectedJob.jobId];
            return (
              <div style={{ position:"absolute", inset:0, zIndex:60, display:"flex", flexDirection:"column",
                            background:theme.bg }}>
                <JobDetailPanel
                  job={selectedJob} theme={theme} isDark={isDark}
                  g={g2} done={done2} st={st2} applyMode={applyMode}
                  canUseGenerate={canUseGenerate} canUseAPlusResume={canUseAPlusResume}
                  onClose={() => setSelectedJob(null)}
                  onGenerate={force => generate(selectedJob, force)}
                  onAPlusResume={force => generate(selectedJob, force, "a_plus_resume")}
                  onViewSandbox={() => { const e2 = {...g2, company:g2?.company||selectedJob.company, title:g2?.title||selectedJob.title}; openSandbox(e2); openAtsPanel({ score:g2?.atsScore, report:g2?.atsReport, company:selectedJob.company, title:selectedJob.title }); setMobilePane("editor"); setSelectedJob(null); }}
                  onExport={() => exportAndTrack(selectedJob, getActiveArtifact(g2)?.html, selectedJob.company, getActiveArtifact(g2))}
                  onVisit={() => visitUrl(selectedJob)}
                  onStar={() => toggleStar(selectedJob.jobId)}
                  onDislike={() => toggleDislike?.(selectedJob.jobId)}
                  onAts={() => { openAtsPanel({ score:g2?.atsScore, report:g2?.atsReport, company:selectedJob.company, title:selectedJob.title }); setSelectedJob(null); }}
                  onResume={() => generate(selectedJob, false)}
                />
              </div>
            );
          })()}
          {/* Active pane */}
          <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>
            {mobilePane === "jobs" && (
              <JobsColumn
                jobs={displayJobs} scraping={scraping} scrapeError={scrapeError}
                scrapeNewCount={scrapeNewCount} onClearScrapeNew={() => setScrapeNewCount(0)}
                onClearScrapeError={() => setScrapeError("")}
                pollStatus={pollStatus} pollNewCount={pollNewCount}
                resultsUpToDate={resultsUpToDate}
                onRetryPoll={handlePullRefresh}
                generated={generated} loading={loading}
                applyMode={applyMode} canUseGenerate={canUseGenerate} canUseAPlusResume={canUseAPlusResume}
                theme={theme} isDark={isDark}
                totalPages={totalPages} currentPage={currentPage} isLastPage={isLastPage}
                generate={generate} openSandbox={openSandbox} exportAndTrack={exportAndTrack}
                visitUrl={visitUrl} toggleStar={toggleStar} openAtsPanel={openAtsPanel}
                goPage={goPage} handleRefresh={handleRefresh} onPullRefresh={handlePullRefresh}
                setMobilePane={setMobilePane} isMobile={isMobile}
                onJobSelect={handleJobSelect} selectedJobId={selectedJob?.jobId}
                cardTier={1}
              />
            )}
            {mobilePane === "editor" && (
              <SandboxPanel entry={sandbox} onClose={closeSandbox}
                onSave={saveSandboxHtml} onExport={exportAndTrack}/>
            )}
            {mobilePane === "ats" && (
              <div style={{ flex:1, overflowY:"auto" }}>
                <div style={{ display:"flex", borderBottom:`1px solid ${theme.border}`,
                              padding:"0 14px", flexShrink:0 }}>
                  {[["ats","ATS Report"],["history",`History${genCount>0?` (${genCount})`:""}`]].map(([id,lbl]) => (
                    <button key={id} onClick={() => setRightTab(id)}
                      style={{
                        padding:"10px 16px", border:"none", background:"transparent",
                        fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                        fontSize:13, letterSpacing:"0.06em", textTransform:"uppercase",
                        color: rightTab===id ? theme.text : theme.textDim,
                        cursor:"pointer", position:"relative",
                        borderBottom: rightTab===id ? `2px solid ${theme.accent}` : "2px solid transparent",
                      }}>
                      {lbl}
                    </button>
                  ))}
                </div>
                {rightTab === "ats" && <ATSPanel report={activeAts?.report} score={activeAts?.score} jobId={selectedJob?.jobId} resumeText={resumeText}/>}
                {rightTab === "history" && (
                  <HistoryList generated={generated}
                    theme={theme}
                    onOpen={e => {
                      openSandbox(e);
                      openAtsPanel({ score:e.atsScore, report:e.atsReport, company:e.company, title:e.title||e.role });
                    }}
                    onExport={exportAndTrack}/>
                )}
              </div>
            )}
          </div>
          {/* Bottom nav */}
          <div style={{ display:"flex", borderTop:`1px solid ${theme.border}`,
                        background:theme.surface, flexShrink:0 }}>
            {[
              { id:"jobs",   label:"Jobs",   icon:"ðŸ’¼" },
              { id:"editor", label:"Resume", icon:"âœ" },
              { id:"ats",    label:"ATS",    icon:"ðŸ“Š" },
            ].map(({ id, label, icon }) => (
              <button key={id} onClick={() => setMobilePane(id)}
                style={{
                  flex:1, padding:"10px 0", border:"none", cursor:"pointer",
                  background:"transparent", display:"flex", flexDirection:"column",
                  alignItems:"center", gap:2,
                  color: mobilePane===id ? theme.accent : theme.textMuted,
                  fontSize:10, fontWeight:700,
                }}>
                <span style={{ fontSize:18 }}>{icon}</span>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* â”€â”€ PORTRAIT / LAPTOP + WIDE: resizable panels (react-resizable-panels) â”€â”€ */}
      {(isWide || (isPortrait && !isMobile)) && (
        <div style={{ flex:1, overflow:"hidden", display:"flex" }}>
        <PanelGroup orientation="horizontal" style={{ flex: 1, overflow: "hidden" }}>

          {/* PANEL A â€” Jobs list (always visible) */}
          <Panel
            ref={jobsPanelRef}
            defaultSize={!!selectedJob ? 30 : 100}
            minSize={10}
            style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <JobsColumn
              jobs={displayJobs} scraping={scraping} scrapeError={scrapeError}
              scrapeNewCount={scrapeNewCount} onClearScrapeNew={() => setScrapeNewCount(0)}
              onClearScrapeError={() => setScrapeError("")}
              pollStatus={pollStatus} pollNewCount={pollNewCount}
              resultsUpToDate={resultsUpToDate}
              onRetryPoll={handlePullRefresh}
              generated={generated} loading={loading}
              applyMode={applyMode} canUseGenerate={canUseGenerate} canUseAPlusResume={canUseAPlusResume}
              theme={theme} isDark={isDark}
              totalPages={totalPages} currentPage={currentPage} isLastPage={isLastPage}
              generate={generate} openSandbox={openSandbox} exportAndTrack={exportAndTrack}
              visitUrl={visitUrl} toggleStar={toggleStar} toggleDislike={toggleDislike}
              openAtsPanel={openAtsPanel}
              goPage={goPage} handleRefresh={handleRefresh} onPullRefresh={handlePullRefresh}
              setMobilePane={setMobilePane} isMobile={isMobile}
              compact={!!selectedJob} selectedJobId={selectedJob?.jobId} onJobSelect={handleJobSelect}
              cardTier={effectiveTier}
              containerRef={jobsPanelElementRef}
            />
          </Panel>

          {/* PANEL B â€” Job detail */}
          {selectedJob && (() => {
            const g2 = generated[selectedJob.jobId], done2 = !!g2?.html, st2 = loading[selectedJob.jobId];
            return (
              <>
                <ResizeHandle theme={theme} />
                <Panel
                  ref={detailPanelRef}
                  defaultSize={70}
                  minSize={10}
                  style={{ display: "flex", flexDirection: "column", overflow: "hidden",
                           borderLeft: `1px solid ${theme.border}` }}>
                  <JobDetailPanel
                    job={selectedJob} theme={theme} isDark={isDark}
                    g={g2} done={done2} st={st2} applyMode={applyMode}
                    canUseGenerate={canUseGenerate} canUseAPlusResume={canUseAPlusResume}
                    onClose={() => setSelectedJob(null)}
                    onGenerate={force => generate(selectedJob, force)}
                    onAPlusResume={force => generate(selectedJob, force, "a_plus_resume")}
                    onViewSandbox={() => { const e2 = {...g2, company:g2?.company||selectedJob.company, title:g2?.title||selectedJob.title}; openSandbox(e2); openAtsPanel({ score:g2?.atsScore, report:g2?.atsReport, company:selectedJob.company, title:selectedJob.title }); }}
                    onExport={() => exportAndTrack(selectedJob, getActiveArtifact(g2)?.html, selectedJob.company, getActiveArtifact(g2))}
                    onVisit={() => visitUrl(selectedJob)}
                    onStar={() => toggleStar(selectedJob.jobId)}
                    onDislike={() => toggleDislike?.(selectedJob.jobId)}
                    onAts={() => { openAtsPanel({ score:g2?.atsScore, report:g2?.atsReport, company:selectedJob.company, title:selectedJob.title }); }}
                    onResume={() => generate(selectedJob, false)}
                  />
                </Panel>
              </>
            );
          })()}

          {/* PANEL C â€” Sandbox / Resume */}
          {/* No maxSize cap â€” CSS scale transform in SandboxPanel handles wider-than-A4 display. */}
          {sandboxOpen && (
            <>
              <ResizeHandle theme={theme} />
              <Panel
                ref={sandboxPanelRef}
                defaultSize={40}
                minSize={10}
                style={{ display: "flex", flexDirection: "column", overflow: "hidden",
                         borderLeft: `1px solid ${theme.border}` }}>
                <SandboxPanel entry={sandbox} onClose={closeSandbox}
                  onSave={saveSandboxHtml} onExport={exportAndTrack}/>
              </Panel>
            </>
          )}

          {/* PANEL D â€” ATS + History */}
          {rightPanelOpen && (
            <>
              <ResizeHandle theme={theme} />
              <Panel
                ref={atsPanelRef}
                defaultSize={20}
                minSize={10}
                style={{ display: "flex", flexDirection: "column", overflow: "hidden",
                         borderLeft: `1px solid ${theme.border}` }}>
                <div style={{ display:"flex", borderBottom:`1px solid ${theme.border}`,
                              padding:"0 14px", flexShrink:0, alignItems:"center" }}>
                  {[["ats","ATS Report"],["history",`History${genCount>0?` (${genCount})`:""}`]].map(([id,lbl]) => (
                    <button key={id} onClick={() => setRightTab(id)}
                      style={{
                        padding:"10px 16px", border:"none", background:"transparent",
                        fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                        fontSize:13, letterSpacing:"0.06em", textTransform:"uppercase",
                        color: rightTab===id ? theme.text : theme.textDim,
                        cursor:"pointer",
                        borderBottom: rightTab===id ? `2px solid ${theme.accent}` : "2px solid transparent",
                      }}>
                      {lbl}
                    </button>
                  ))}
                  <button onClick={closeAtsPanel} title="Close panel"
                    style={{ marginLeft:"auto", background:"none", border:"none", cursor:"pointer",
                             color:theme.textMuted, fontSize:16, padding:"4px 6px" }}>âœ•</button>
                </div>
                <div style={{ flex:1, overflowY:"auto" }}>
                  {rightTab === "ats" && <ATSPanel report={activeAts?.report} score={activeAts?.score} jobId={selectedJob?.jobId} resumeText={resumeText}/>}
                  {rightTab === "history" && (
                    <HistoryList generated={generated} theme={theme}
                      onOpen={e => {
                        openSandbox(e);
                        openAtsPanel({ score:e.atsScore, report:e.atsReport, company:e.company, title:e.title||e.role });
                      }}
                      onExport={exportAndTrack}/>
                  )}
                </div>
              </Panel>
            </>
          )}

        </PanelGroup>
        </div>
      )}
    </div>
  );
}

// â”€â”€ Drag resize handle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ResizeHandle({ theme: themeProp }) {
  const { theme: t } = useTheme();
  const theme = themeProp || t;
  const [active, setActive] = useState(false);
  return (
    <PanelResizeHandle
      style={{
        width: 7, flexShrink: 0, cursor: "col-resize",
        display: "flex", alignItems: "stretch", background: "transparent",
        zIndex: 10,
      }}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
    >
      <div style={{
        width: active ? 3 : 2,
        margin: "0 auto",
        background: active ? theme.accent : theme.border,
        transition: "all 0.15s ease",
        borderRadius: 2,
      }} />
    </PanelResizeHandle>
  );
}

// â”€â”€ Jobs column (shared across layout modes) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function JobsColumn({ jobs, scraping, scrapeError, scrapeNewCount, onClearScrapeNew, onClearScrapeError,
                      pollStatus, pollNewCount, resultsUpToDate, onRetryPoll,
                      generated, loading, applyMode, canUseGenerate, canUseAPlusResume, theme, isDark,
                      totalPages, currentPage, isLastPage,
                      generate, openSandbox, exportAndTrack,
                      visitUrl, toggleStar, toggleDislike, openAtsPanel,
                      goPage, handleRefresh, onPullRefresh,
                      setMobilePane, isMobile,
                      compact, selectedJobId, onJobSelect,
                      cardTier = 1, containerRef }) {
  return (
    <div ref={containerRef} style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden",
                  background: isDark
                    ? `linear-gradient(160deg, ${theme.accentMuted}55 0%, ${theme.bg} 55%)`
                    : `linear-gradient(160deg, ${theme.accentMuted} 0%, ${theme.bg} 50%)` }}>
      {jobs.length === 0 && !scraping ? <EmptyState theme={theme}/> : (
        <PullToRefresh onRefresh={onPullRefresh} refreshing={scraping} theme={theme}>

          {/* Live polling pulsing bar â€” shows while scrape is in progress */}
          {pollStatus === "polling" && (
            <div style={{ margin:"6px 16px 0", padding:"8px 12px", borderRadius:4,
                          background:theme.accentMuted, border:`1px solid ${theme.accent}33`,
                          display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ display:"inline-block", width:8, height:8, borderRadius:"50%",
                             background:theme.accent, animation:"pulse 1.5s ease-in-out infinite" }}/>
              <span style={{ fontSize:11, color:theme.accentText, fontWeight:600 }}>
                {pollNewCount > 0
                  ? `Fetchingâ€¦ ${pollNewCount} new job${pollNewCount !== 1 ? "s" : ""} found so far`
                  : "Fetching new jobsâ€¦"}
              </span>
            </div>
          )}

          {/* Scrape complete â€” fades after 5s */}
          {pollStatus === "complete" && scrapeNewCount > 0 && (
            <div style={{ margin:"6px 16px 0", padding:"8px 12px", borderRadius:4,
                          background:"#dcfce7", border:"1px solid #86efac",
                          display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <span style={{ fontSize:11, fontWeight:700, color:"#166534" }}>
                âœ“ Scrape complete â€” {scrapeNewCount} new job{scrapeNewCount !== 1 ? "s" : ""} added
              </span>
              <button onClick={onClearScrapeNew} style={{ background:"none", border:"none",
                cursor:"pointer", color:"#166534", fontSize:13 }}>âœ•</button>
            </div>
          )}

          {/* Results up to date (Set Role cache hit) */}
          {resultsUpToDate && (
            <div style={{ margin:"6px 16px 0", padding:"6px 12px", borderRadius:4,
                          background:theme.surfaceHigh, border:`1px solid ${theme.border}`,
                          fontSize:11, color:theme.textMuted }}>
              âœ“ Results up to date
            </div>
          )}

          {/* Scrape error banner */}
          {scrapeError && (
            <div style={{ margin:"8px 16px 0", padding:"10px 14px", borderRadius:4,
                          background:"#fee2e2", border:"1px solid #fca5a5",
                          display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <span style={{ fontSize:12, color:"#991b1b" }}>
                âœ— {scrapeError}
              </span>
              <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                {pollStatus === "error" && onRetryPoll && (
                  <button onClick={onRetryPoll}
                    style={{ background:"none", border:`1px solid #991b1b`, borderRadius:4,
                             cursor:"pointer", color:"#991b1b", fontSize:11, padding:"2px 8px",
                             fontWeight:700 }}>
                    Retry
                  </button>
                )}
                <button onClick={onClearScrapeError} style={{ background:"none", border:"none",
                  cursor:"pointer", color:"#991b1b", fontSize:14 }}>âœ•</button>
              </div>
            </div>
          )}

          {/* Job cards â€” always rendered (even when scraping) */}
          {jobs.map(job => {
            const key = job.jobId, g = generated[key],
                  done = !!g?.html, st = loading[key];
            return (
              <JobCard
                key={key} job={job} g={g} done={done} st={st}
                applyMode={applyMode}
                canUseGenerate={canUseGenerate} canUseAPlusResume={canUseAPlusResume}
                theme={theme} isDark={isDark}
                showDislike={true}
                showApplyButton={!compact}
                compact={compact}
                selected={selectedJobId === key}
                onSelect={onJobSelect ? () => onJobSelect(job) : undefined}
                cardTier={cardTier}
                onGenerate={force => generate(job, force)}
                onAPlusResume={force => generate(job, force, "a_plus_resume")}
                onViewSandbox={() => {
                  const entry = {...g, company:g.company||job.company, title:g.title||job.title};
                  openSandbox(entry);
                  openAtsPanel({ score:g.atsScore, report:g.atsReport, company:job.company, title:job.title });
                }}
                onExport={() => exportAndTrack(job, getActiveArtifact(g)?.html, job.company, getActiveArtifact(g))}
                onVisit={() => visitUrl(job)}
                onStar={() => toggleStar(key)}
                onDislike={() => toggleDislike?.(key)}
                onCardClick={!onJobSelect ? () => {
                  if (done && g.html !== "__exists__") {
                    const entry = {...g, company:g.company||job.company, title:g.title||job.title};
                    openSandbox(entry);
                    openAtsPanel({ score:g.atsScore, report:g.atsReport, company:job.company, title:job.title });
                  } else if (job.url) {
                    visitUrl(job);
                  }
                } : undefined}
                onAts={() => {
                  if (g?.atsReport || g?.atsScore != null) {
                    openAtsPanel({ score:g.atsScore, report:g.atsReport, company:job.company, title:job.title });
                  }
                }}
                onResume={() => generate(job, false)}
              />
            );
          })}

          {/* Pagination controls */}
          {totalPages > 1 && (
            <div style={{ display:"flex", alignItems:"center", justifyContent:"center",
                           gap:8, padding:"16px 20px", borderTop:`1px solid ${theme.border}` }}>
              <LucyBtn onClick={() => goPage(currentPage-1)}
                        disabled={currentPage <= 1} accent={theme.surfaceHigh}>
                â† Prev
              </LucyBtn>
              <span style={{ fontSize:12, color:theme.textMuted }}>
                Page {currentPage} of {totalPages}
              </span>
              <LucyBtn onClick={() => goPage(currentPage+1)}
                        disabled={currentPage >= totalPages} accent={theme.surfaceHigh}>
                Next â†’
              </LucyBtn>
            </div>
          )}

        </PullToRefresh>
      )}
    </div>
  );
}

// JobCard is imported from ../components/JobCard.jsx

// â”€â”€ Empty state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function EmptyState({ theme }) {
  const { theme: t } = useTheme();
  const th = theme || t;
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center",
                  justifyContent:"center", gap:16, padding:40, color:th.textDim }}>
      <div style={{ fontSize:56 }}>ðŸ”</div>
      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                    fontSize:22, letterSpacing:"0.06em", textTransform:"uppercase", color:th.text }}>
        Search for a role above
      </div>
      <div style={{ fontSize:12, textAlign:"center", color:th.textDim, maxWidth:320, lineHeight:1.8 }}>
        LinkedIn + Indeed Â· full-time only Â· deduplicated Â· ghost jobs filtered
      </div>
    </div>
  );
}

// â”€â”€ History list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function HistoryList({ generated, onOpen, onExport, theme: themeProp }) {
  const { theme: t } = useTheme();
  const theme = themeProp || t;
  const entries = Object.entries(generated).filter(([,v]) => v?.html && v.html !== "__exists__");
  if (!entries.length) return (
    <div style={{ padding:24, color:theme.textDim, fontSize:12, textAlign:"center" }}>
      No resumes generated yet.
    </div>
  );
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
      {entries.map(([jid,v]) => {
        const letter = (v.company||"?")[0].toUpperCase();
        const colors = ["#0A66C2","#7c3aed","#0891b2","#16a34a","#dc2626","#d97706","#9333ea"];
        let hash = 0;
        for (const c of v.company||"") hash = (hash*31+c.charCodeAt(0))&0xffff;
        const bg = colors[hash%colors.length];
        return (
          <div key={jid} style={{ padding:"12px 16px", borderBottom:`1px solid ${theme.border}`,
                                   display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:32, height:32, borderRadius:8, background:bg,
                           display:"flex", alignItems:"center", justifyContent:"center",
                           fontWeight:800, fontSize:11, color:"#fff", flexShrink:0 }}>
              {letter}
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontWeight:700, fontSize:12, color:theme.text,
                             overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {v.company}
              </div>
              <div style={{ fontSize:10, color:theme.textDim, overflow:"hidden",
                             textOverflow:"ellipsis", whiteSpace:"nowrap", marginBottom:3 }}>
                {v.title||v.role}
              </div>
              <ATSBadge score={v.atsScore}/>
            </div>
            <div style={{ display:"flex", gap:5, flexShrink:0 }}>
              <IconBtn bg="#0284c7" size={26} title="Open in sandbox" onClick={() => onOpen(v)}>ðŸ‘</IconBtn>
              <IconBtn bg="#16a34a" size={26} title="Export PDF" onClick={() => onExport(null,v.html,v.company)}>ðŸ“¥</IconBtn>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// â”€â”€ Company Reuse Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function CompanyReuseModal({ company, onUseExisting, onGenerateNew, onCancel, theme }) {
  return (
    <div style={{
      position:"fixed", inset:0, zIndex:1000, display:"flex",
      alignItems:"center", justifyContent:"center",
      background:"rgba(0,0,0,0.45)", backdropFilter:"blur(3px)",
    }}
    onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div style={{
        background:theme.surface, borderRadius:12, padding:28,
        maxWidth:380, width:"90%", boxShadow:theme.shadowLg,
        border:`1px solid ${theme.border}`,
        display:"flex", flexDirection:"column", gap:16,
      }}>
        <div style={{ fontSize:18, fontWeight:800, color:theme.text }}>
          Previously applied to {company}
        </div>
        <div style={{ fontSize:13, color:theme.textMuted, lineHeight:1.6 }}>
          You've already generated a resume for a role at <strong style={{ color:theme.text }}>{company}</strong>.
          Use your existing resume for this role, or generate a new one?
        </div>
        <div style={{ display:"flex", gap:10, flexDirection:"column" }}>
          <button onClick={onUseExisting} style={{
            padding:"10px 0", borderRadius:999, border:`2px solid ${theme.accent}`,
            background:theme.accent, color:"#0f0f0f", fontWeight:800, fontSize:13,
            cursor:"pointer", fontFamily:"'Barlow Condensed',sans-serif",
            letterSpacing:"0.06em", textTransform:"uppercase",
          }}>
            Use Existing Resume
          </button>
          <button onClick={onGenerateNew} style={{
            padding:"10px 0", borderRadius:999, border:`2px solid ${theme.border}`,
            background:"transparent", color:theme.text, fontWeight:800, fontSize:13,
            cursor:"pointer", fontFamily:"'Barlow Condensed',sans-serif",
            letterSpacing:"0.06em", textTransform:"uppercase",
          }}>
            Generate New
          </button>
          <button onClick={onCancel} style={{
            padding:"6px 0", border:"none", background:"none",
            color:theme.textMuted, fontSize:12, cursor:"pointer",
          }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
