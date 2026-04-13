// client/src/panels/JobsPanel.jsx — Lucy Brand, shared job pool
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { api, printResume, dislikeJob } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";
import { useViewport } from "../hooks/useViewport.js";
import JobCard from "../components/JobCard.jsx";
import JobDetailPanel from "../components/JobDetailPanel.jsx";
import SandboxPanel from "./SandboxPanel.jsx";
import { ATSPanel } from "./ATSPanel.jsx";

const USER_TEXT   = "#0f0f0f";   // black text on accent

// ── Pre-scrape param maps (UI → Apify enum) ───────────────────
// workType UI value → Apify workplaceType array
const WORKPLACE_TO_APIFY = {
  Remote:  "remote",
  Hybrid:  "hybrid",
  Onsite:  "office",
  "On-site": "office",
};
// ageFilter UI value → Apify postedLimit string
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

// ── Helpers ───────────────────────────────────────────────────
function ago(ts) {
  if (!ts) return "—";
  const d = Date.now() - new Date(ts).getTime();
  if (d < 3600000)  return `${Math.floor(d/60000)}m`;
  if (d < 86400000) return `${Math.floor(d/3600000)}h`;
  return `${Math.floor(d/86400000)}d`;
}

// ── LinkedIn "in" logo (inline SVG) ──────────────────────────
function LinkedInLogo({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-label="LinkedIn" role="img">
      <rect width="20" height="20" rx="3" fill="#0A66C2"/>
      <text x="4" y="15" fontFamily="Georgia,serif" fontWeight="900" fontSize="13" fill="#fff">in</text>
    </svg>
  );
}

// ── Indeed logo (inline SVG) ──────────────────────────────────
function IndeedLogo({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-label="Indeed" role="img">
      <rect width="20" height="20" rx="3" fill="#003A9B"/>
      <circle cx="10" cy="8" r="3" fill="#fff"/>
      <rect x="7.5" y="11" width="5" height="6" rx="1" fill="#fff"/>
    </svg>
  );
}

// ── Platform logo dispatcher ───────────────────────────────────
function PlatformLogo({ platform, size = 20, theme }) {
  const p = (platform || "").toLowerCase();
  if (p === "linkedin") return <LinkedInLogo size={size}/>;
  if (p === "indeed")   return <IndeedLogo size={size}/>;
  return <span style={{ fontSize:size*0.5, color:theme?.textMuted||"#888" }}>◆</span>;
}

// ── Company icon with monogram fallback ───────────────────────
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

// ── Work type badge ────────────────────────────────────────────
function WorkBadge({ t, theme }) {
  // Use semantic colors that work in both light/dark — the fg/bg are theme tokens
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
      {t || "—"}
    </span>
  );
}

// ── ATS badge ─────────────────────────────────────────────────
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

// ── Resume badge ──────────────────────────────────────────────
function ResumeBadge({ onClick, loading }) {
  return (
    <span
      onClick={onClick ? e => { e.stopPropagation(); onClick(); } : undefined}
      style={{ background:"#e8f6fb", color:"#1a6a8a", padding:"2px 8px",
               borderRadius:999, fontSize:10, fontWeight:700,
               cursor:"pointer", border:"1px solid #A8D8EA44",
               display:"inline-flex", alignItems:"center", gap:3 }}>
      {loading ? "⏳" : "📄"} Resume
    </span>
  );
}

// ── Lucy button (rectangular → pill on hover, 1s) ─────────────
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

// ── Icon button ───────────────────────────────────────────────
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

// ── Filters panel (collapsible) ───────────────────────────────
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
                                             cursor:"pointer", fontSize:18, color:theme.textMuted }}>✕</button>
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
            Years of Experience: {minYoe || 0}–{maxYoe || "Any"}
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

// ── Aliases (mirrors server normaliser) ───────────────────────
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

// ── Pull-to-refresh ───────────────────────────────────────────
function PullToRefresh({ onRefresh, refreshing, theme, children }) {
  const scrollRef = useRef(null);
  const [pullY,   setPullY]   = useState(0);
  const [ready,   setReady]   = useState(false);
  const startY = useRef(null);
  const THRESHOLD = 56;

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
            {ready ? "↑ Release to refresh" : "↓ Keep pulling…"}
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
          ↻ Check for new jobs
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
          <span style={{ display:"inline-block", animation:"spin 0.8s linear infinite" }}>↻</span>
          Checking…
        </div>
      )}

      <div
        ref={scrollRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
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

// ── Main panel ────────────────────────────────────────────────
export default function JobsPanel({ user, onUserChange, refreshKey = 0, onResumeStateChange, isActive = true }) {
  const { theme, isDark } = useTheme();
  const { mode: vpMode } = useViewport();
  const isWide     = vpMode === "wide";
  const isMobile   = vpMode === "mobile" || vpMode === "tablet";
  const isPortrait = vpMode === "portrait" || vpMode === "laptop";

  // Mobile pane state
  const [mobilePane, setMobilePane] = useState("jobs"); // "jobs" | "editor" | "ats"

  // Tracks jobs disliked in this browser session — survives filter/sort refetches
  // but is cleared on page reload (so server exclusions take effect on next login)
  const sessionDislikedRef = useRef(new Map()); // jobId → job object

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

  // ResizeObserver: track jobs panel pixel width for responsive card tiers
  const jobsPanelElementRef = useRef(null);
  const [jobsPanelWidth, setJobsPanelWidth] = useState(400);


  // Task 5 — Inline error states
  const [smartSearchError, setSmartSearchError] = useState("");
  const [uploadError,      setUploadError]      = useState("");

  // Task 6 — Company reuse modal
  const [companyReuseTarget, setCompanyReuseTarget] = useState(null);

  // Board tabs
  const [boardTab,    setBoardTab]    = useState("all");  // "all" | "saved" | "pending"
  const [pendingJobs, setPendingJobs] = useState([]);

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

  // Local text search (scoped to loaded jobs)
  const [localSearch, setLocalSearch] = useState("");

  // Sort
  const [sortBy,      setSortBy]      = useState("dateDesc");

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
  const applyMode = user?.applyMode || "TAILORED";

  // Reset panel sizes to defaults when panel visibility changes.
  // Programmatic resize fires after the new panel mounts (requestAnimationFrame).
  useEffect(() => {
    if (isMobile) return;
    const showDetail  = !!selectedJob;
    const showSandbox = sandboxOpen;
    const showAts     = rightPanelOpen;
    const d = getPanelDefaults(showDetail, showSandbox, showAts);
    requestAnimationFrame(() => {
      jobsPanelRef.current?.resize(d.jobs);
      if (showDetail)  detailPanelRef.current?.resize(d.detail);
      if (showSandbox) sandboxPanelRef.current?.resize(d.sandbox);
      if (showAts)     atsPanelRef.current?.resize(d.ats);
    });
  }, [!!selectedJob, sandboxOpen, rightPanelOpen, isMobile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Observe jobs panel container width for responsive card tiers
  useEffect(() => {
    const el = jobsPanelElementRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setJobsPanelWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
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
    });
  }, [resumeText, fileName, uploading]); // eslint-disable-line react-hooks/exhaustive-deps
  const PAGE_SIZE = 25;

  // ── Split-view: job selection ─────────────────────────────────
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

  // ── Build query params from current filter state ──────────
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
    return p.toString();
  }, [sortBy, roleFilter, locationFilter, workType, employmentTypePrefs, catFilter, srcFilter,
      minYoe, maxYoe, maxApplicants, visitedFilter, ageFilter, boardTab]);

  // ── Fetch pending jobs ────────────────────────────────────────
  const fetchPending = useCallback(async () => {
    try {
      const rows = await api("/api/jobs/pending");
      setPendingJobs(Array.isArray(rows) ? rows : []);
    } catch {}
  }, []);

  // ── Fetch jobs — never clears board before data arrives ──────
  const fetchJobs = useCallback(async (page = 1, mergeMode = false) => {
    if (boardTab === "pending") { fetchPending(); return; }
    setBgLoading(true);
    try {
      const qs = buildParams(page);
      const d = await api(`/api/jobs?${qs}`);
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

  // ── Boot ──────────────────────────────────────────────────
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
          atsReport:r.ats_report, company:r.company, title:r.role }; });
        setGenerated(map);
      }
    }).catch(console.error);
  }, [user]);

  // Re-fetch when server-side filters/sort/tab change (background — board stays visible)
  useEffect(() => {
    if (!user) return;
    fetchJobs(1);
  }, [sortBy, roleFilter, locationFilter, workType, employmentTypePrefs, catFilter, srcFilter,
      minYoe, maxYoe, maxApplicants, visitedFilter, ageFilter, boardTab, refreshKey]);

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

  // ── Scrape / search ───────────────────────────────────────
  const handleSearch = useCallback(async (overrideQuery) => {
    const q = (overrideQuery || searchInput).trim();
    if (!q) return;
    setScrapeError("");
    setScraping(true);
    let managedByPoller = false;
    try {
      const result = await api("/api/scrape", { method:"POST", body:JSON.stringify({ query:q, ...buildScrapeParams({ workType, ageFilter, locationFilter, employmentTypePrefs }) }) });
      if (result.missingToken) {
        setScrapeError("No Apify token set. Add it via avatar → Apify Token.");
        return;
      }
      if (result.limitReached) {
        setScrapeError(result.error);
        return;
      }
      if (result.error) { setScrapeError(result.error); return; }

      // Server normalises the query (pm → Product Manager); use it for role filter
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

  // ── Pull / Check-for-new: DB-first, then scrape if quota unmet ─
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
      if (result.missingToken) {
        setScrapeError("No Apify token — add it in avatar → Apify Token.");
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

  // ── Legacy Refresh button (end-of-list) ───────────────────────
  const handleRefresh = handlePullRefresh;

  // ── Smart search ──────────────────────────────────────────
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

  // ── File upload ───────────────────────────────────────────
  const handleFile = useCallback(async e => {
    const file = e.target.files[0]; if (!file) return;
    setFileName(file.name); setUploading(true); setUploadError("");
    try {
      const ext = file.name.split(".").pop().toLowerCase();
      let text = "";
      if (ext === "pdf") {
        const fd = new FormData(); fd.append("file", file);
        const r = await fetch("/api/parse-pdf", { method:"POST", credentials:"include", body:fd });
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

  // ── Generate (actual logic) ───────────────────────────────
  const generateActual = useCallback(async (job, force = false, skipCompanyCheck = false) => {
    if (applyMode === "SIMPLE") { return; }
    if (!resumeText)            { return; }
    const key = job.jobId, existing = generated[key];
    if (existing?.html && existing.html !== "__exists__" && !force) {
      const entry = {...existing, company:existing.company||job.company, title:existing.title||job.title};
      openSandbox(entry);
      openAtsPanel({ score:existing.atsScore, report:existing.atsReport, company:job.company, title:job.title });
      return;
    }
    if (existing?.html === "__exists__" && !force) {
      // Resume exists in DB but not in memory — fetch on demand
      setLoading(p => ({ ...p, [key]: "loading" }));
      try {
        const d = await api(`/api/resumes/${key}`);
        const entry = { html: d.html, atsScore: d.ats_score, atsReport: d.atsReport, company: d.company, title: d.role };
        setGenerated(p => ({ ...p, [key]: entry }));
        openSandbox({ ...entry, company: entry.company, title: entry.title });
        openAtsPanel({ score: d.ats_score, report: d.atsReport, company: d.company, title: d.role });
      } catch(e) { setSandbox({ generating: false, error: e.message, company: job.company, title: job.title }); }
      finally { setLoading(p => { const n = {...p}; delete n[key]; return n; }); }
      return;
    }

    // Open sandbox with skeleton state immediately
    openSandbox({ generating: true, company: job.company, title: job.title });

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

    setLoading(p => ({ ...p, [key]:"generating" }));
    try {
      const d = await api("/api/generate", { method:"POST",
        body:JSON.stringify({ jobId:key, job, resumeText, forceRegen:force }) });
      if (d.limitReached) {
        setSandbox({ generating: false, error: d.error, company: job.company, title: job.title });
        return; // don't throw, just show error in sandbox panel
      }
      if (d.error) throw new Error(d.error);
      setGenerated(p => ({ ...p, [key]:{ html:d.html, atsScore:d.atsScore, atsReport:d.atsReport,
        company:job.company, title:job.title } }));
      openSandbox({ html:d.html, company:job.company, title:job.title });
      openAtsPanel({ score:d.atsScore, report:d.atsReport, company:job.company, title:job.title });
    } catch(e) {
      setSandbox({ generating: false, error: e.message, company: job.company, title: job.title });
    }
    finally {
      if (genTimerRef.current) { clearInterval(genTimerRef.current); genTimerRef.current = null; }
      setGenStage("");
      setLoading(p => { const n = {...p}; delete n[key]; return n; });
    }
  }, [resumeText, generated, applyMode, openSandbox]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Generate (with company-reuse check) ──────────────────
  const generate = useCallback(async (job, force = false) => {
    if (applyMode === "SIMPLE") { return; }
    if (!resumeText)            { return; }
    // Company check: if we have a prior resume for this company and this is a fresh generate (not force),
    // show the reuse modal instead of generating.
    if (!force) {
      const priorEntry = Object.values(generated).find(v =>
        v?.html && v.html !== "__exists__" &&
        v.company?.toLowerCase() === (job.company || "").toLowerCase()
      );
      if (priorEntry && !generated[job.jobId]?.html) {
        setCompanyReuseTarget({ job, priorEntry });
        return;
      }
    }
    await generateActual(job, force, false);
  }, [generated, generateActual, resumeText, applyMode]);

  const saveSandboxHtml = useCallback(async html => {
    if (!sandbox) return;
    const key = Object.entries(generated).find(([,v]) => v.company === sandbox.company)?.[0];
    if (key) await api(`/api/resumes/${key}/html`, { method:"POST", body:JSON.stringify({ html }) });
    setSandbox(s => ({...s, html}));
  }, [sandbox, generated]);

  const exportAndTrack = useCallback(async (job, html, company) => {
    const filename = `Resume_${(company||"").replace(/\s+/g,"_")}`;
    printResume(html, filename);
    if (job) {
      await api("/api/applications", { method:"POST", body:JSON.stringify({
        jobId:job.jobId, company:job.company, role:job.title,
        jobUrl:job.url, source:job.source, location:job.location,
        applyMode, resumeFile:filename + ".pdf",
      }) }).catch(()=>{});
      await fetchJobs(currentPage);
    }
  }, [applyMode, fetchJobs, currentPage]);

  // ── Starred toggle ────────────────────────────────────────
  const toggleStar = useCallback(async (jobId) => {
    try {
      const d = await api(`/api/jobs/${jobId}/starred`, { method:"PATCH" });
      setJobs(prev => prev.map(j => j.jobId === jobId ? {...j, starred: d.starred, disliked: false} : j));
    } catch {}
  }, []);

  // ── Dislike toggle — deferred removal ────────────────────────
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

  // ── Mark visited in local state ───────────────────────────
  const markVisited = useCallback((jobId) => {
    setJobs(prev => prev.map(j => j.jobId === jobId ? {...j, visited:true} : j));
  }, []);

  // ── Direct URL open (no dialog) ──────────────────────────────
  const visitUrl = useCallback(async (job) => {
    if (!job.url) return;
    try { await api(`/api/jobs/${job.jobId}/visited`, { method:"PATCH" }); } catch {}
    markVisited(job.jobId);
    window.open(job.url, "_blank", "noreferrer");
  }, [markVisited]);

  // ── Pagination ────────────────────────────────────────────
  const goPage = async (p) => { await fetchJobs(p); window.scrollTo(0,0); };

  // ── Filter reset ──────────────────────────────────────────
  const resetFilters = () => {
    setRoleFilter(""); setLocationFilter(""); setWorkType(""); setEmploymentTypePrefs(["full-time"]); setCatFilter("");
    setSrcFilter(""); setMinYoe(""); setMaxYoe(""); setMaxApplicants(""); setVisitedFilter("");
    setAgeFilter(""); setLocalSearch("");
  };

  // ── Live client-side filter (instant, no API call) ───────────
  const displayJobs = useMemo(() => {
    const src = boardTab === "pending" ? pendingJobs : jobs;
    if (!localSearch.trim()) return src;
    const q = localSearch.trim().toLowerCase();
    return src.filter(j =>
      j.company?.toLowerCase().includes(q) ||
      j.title?.toLowerCase().includes(q)   ||
      j.location?.toLowerCase().includes(q) ||
      j.category?.toLowerCase().includes(q)
    );
  }, [jobs, pendingJobs, boardTab, localSearch]);
  displayJobsRef.current = displayJobs;

  const genCount = Object.values(generated).filter(v=>v?.html && v.html !== "__exists__").length;
  const normalisedPreview = ALIASES[searchInput.trim().toLowerCase()]
    || (searchInput.trim() ? searchInput.trim().replace(/\b\w/g, c=>c.toUpperCase()) : "");
  const showPreview = !!(normalisedPreview && normalisedPreview.toLowerCase() !== searchInput.trim().toLowerCase());

  const isLastPage = currentPage >= totalPages;

  // BUTTON STATES: 'Set Role' = save role + DB lookup.
  // 'Search New' = trigger fresh Apify scrape.
  // To change labels edit the buttonLabel derived value below.
  const roleIsSet = !!roleFilter &&
    searchInput.trim().toLowerCase() === roleFilter.trim();
  const buttonLabel = scraping ? "Searching…" : roleIsSet ? "Search New" : "Set Role";

  // Panel sizing is handled by react-resizable-panels + getPanelDefaults().
  // See the getPanelDefaults() function above for default size rules.

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", background:theme.bg }}>

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

      {/* ── Unified toolbar ──────────────────────────────── */}
      {/* Row A: tabs | filters | sort | local-search | job count */}
      {/* Row B (wraps): search input | Search | Best Match | resume upload */}
      <div style={{
        background:theme.surface, borderBottom:`1px solid ${theme.border}`,
        padding:"10px 20px", display:"flex", alignItems:"center", gap:8,
        flexShrink:0, flexWrap:"wrap",
      }}>

        {/* ── Row A ──────────────────────────────────── */}
        {/* Board tabs */}
        <div style={{ display:"flex", flexShrink:0, overflow:"hidden",
                      border:`2px solid ${theme.borderStrong}`, borderRadius:2 }}>
          {[["all","All Jobs"],["saved","Saved ★"],["pending","Pending"]].map(([id,lbl]) => (
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

        {/* Filters button — always visible, bold outline */}
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
          ▤ Filters
        </button>

        {/* Sort */}
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}
          style={{ height:34, padding:"0 10px", borderRadius:2, flexShrink:0,
                   border:`2px solid ${theme.borderStrong}`, background:theme.surface,
                   fontSize:13, color:theme.text, outline:"none",
                   fontFamily:"'DM Sans',system-ui", cursor:"pointer" }}>
          <option value="dateDesc">Newest</option>
          <option value="dateAsc">Oldest</option>
          <option value="compHigh">Pay ↓</option>
          <option value="compLow">Pay ↑</option>
          <option value="yoeLow">Exp ↑</option>
          <option value="yoeHigh">Exp ↓</option>
        </select>

        {/* Local search — live client-side, every keystroke */}
        <input value={localSearch} onChange={e => setLocalSearch(e.target.value)}
          onKeyDown={e => { if (e.key === "Escape") setLocalSearch(""); }}
          placeholder="Filter visible jobs…"
          style={{ flex:1, minWidth:140, height:34, padding:"0 12px",
                   borderRadius:2, border:`1px solid ${theme.border}`,
                   background:theme.surface, color:theme.text,
                   fontFamily:"'DM Sans',system-ui", fontSize:13, outline:"none" }}/>
        {localSearch && (
          <button onClick={() => setLocalSearch("")}
            style={{ background:"none", border:"none", color:theme.textDim,
                     cursor:"pointer", fontSize:14, padding:"0 2px", flexShrink:0 }}>✕</button>
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
            : localSearch ? `${displayJobs.length} of ${totalJobs}` : `${totalJobs}`
          } job{displayJobs.length !== 1 ? "s" : ""}
        </span>

        {/* ── Row B (wraps to next line) ──────────────── */}
        {/* Full-width divider */}
        <div style={{ flexBasis:"100%", height:0 }}/>

        {/* Scrape query input */}
        <div style={{ position:"relative", flex:1, minWidth:200 }}>
          <span style={{ position:"absolute", left:12, top:"50%",
                         transform:"translateY(-50%)", fontSize:14, color:theme.textDim,
                         pointerEvents:"none" }}>🔍</span>
          <input value={searchInput} onChange={e=>setSearchInput(e.target.value)}
            onKeyDown={e => e.key==="Enter" && (roleIsSet ? handleSearch() : handleSetRole())}
            placeholder="Search role — e.g. ML Engineer, SWE…"
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
          title={roleIsSet ? "Fetch new job listings for this role from LinkedIn" : undefined}>
          {buttonLabel}
        </LucyBtn>
        <LucyBtn onClick={handleSmartSearch} disabled={smartSearching || scraping}
                  accent={theme.surfaceHigh}>
          {smartSearching ? "Analysing…" : "✦ Best Match"}
        </LucyBtn>

        {smartSearchError && (
          <div style={{ flexBasis:"100%", padding:"4px 0", fontSize:11, color:"#991b1b" }}>
            ✗ {smartSearchError}
            <button onClick={() => setSmartSearchError("")} style={{ marginLeft:6, background:"none", border:"none", cursor:"pointer", fontSize:11, color:"#991b1b" }}>Dismiss</button>
          </div>
        )}

        {uploadError && (
          <div style={{ flexBasis:"100%", padding:"4px 0", fontSize:11, color:"#991b1b" }}>
            ✗ {uploadError}
            <button onClick={() => setUploadError("")} style={{ marginLeft:6, background:"none", border:"none", cursor:"pointer", fontSize:11, color:"#991b1b" }}>Dismiss</button>
          </div>
        )}

        {/* Resume upload — button lives in TopBar mode dropdown */}
        <input ref={fileRef} type="file" accept=".txt,.html,.md,.docx,.pdf"
          onChange={handleFile} style={{ display:"none" }}/>
      </div>

      {/* ── Body: responsive layout ─────────────────────────── */}

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
            const { job } = companyReuseTarget;
            setCompanyReuseTarget(null);
            generateActual(job, false, true);
          }}
          onCancel={() => setCompanyReuseTarget(null)}
        />
      )}

      {/* ── MOBILE / TABLET: single-pane + bottom nav ── */}
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
                  onClose={() => setSelectedJob(null)}
                  onGenerate={force => generate(selectedJob, force)}
                  onViewSandbox={() => { const e2 = {...g2, company:g2?.company||selectedJob.company, title:g2?.title||selectedJob.title}; openSandbox(e2); openAtsPanel({ score:g2?.atsScore, report:g2?.atsReport, company:selectedJob.company, title:selectedJob.title }); setMobilePane("editor"); setSelectedJob(null); }}
                  onExport={() => exportAndTrack(selectedJob, g2?.html, selectedJob.company)}
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
                applyMode={applyMode} theme={theme} isDark={isDark}
                totalPages={totalPages} currentPage={currentPage} isLastPage={isLastPage}
                generate={generate} openSandbox={openSandbox} exportAndTrack={exportAndTrack}
                visitUrl={visitUrl} toggleStar={toggleStar} openAtsPanel={openAtsPanel}
                goPage={goPage} handleRefresh={handleRefresh} onPullRefresh={handlePullRefresh}
                setMobilePane={setMobilePane} isMobile={isMobile}
                onJobSelect={handleJobSelect} selectedJobId={selectedJob?.jobId}
                panelWidth={jobsPanelWidth}
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
              { id:"jobs",   label:"Jobs",   icon:"💼" },
              { id:"editor", label:"Resume", icon:"✏" },
              { id:"ats",    label:"ATS",    icon:"📊" },
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

      {/* ── PORTRAIT / LAPTOP + WIDE: resizable panels (react-resizable-panels) ── */}
      {(isWide || (isPortrait && !isMobile)) && (
        <div style={{ flex:1, overflow:"hidden", display:"flex" }}>
        <PanelGroup orientation="horizontal" style={{ flex: 1, overflow: "hidden" }}>

          {/* PANEL A — Jobs list (always visible) */}
          <Panel
            ref={jobsPanelRef}
            elementRef={jobsPanelElementRef}
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
              applyMode={applyMode} theme={theme} isDark={isDark}
              totalPages={totalPages} currentPage={currentPage} isLastPage={isLastPage}
              generate={generate} openSandbox={openSandbox} exportAndTrack={exportAndTrack}
              visitUrl={visitUrl} toggleStar={toggleStar} toggleDislike={toggleDislike}
              openAtsPanel={openAtsPanel}
              goPage={goPage} handleRefresh={handleRefresh} onPullRefresh={handlePullRefresh}
              setMobilePane={setMobilePane} isMobile={isMobile}
              compact={!!selectedJob} selectedJobId={selectedJob?.jobId} onJobSelect={handleJobSelect}
              panelWidth={jobsPanelWidth}
            />
          </Panel>

          {/* PANEL B — Job detail */}
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
                    onClose={() => setSelectedJob(null)}
                    onGenerate={force => generate(selectedJob, force)}
                    onViewSandbox={() => { const e2 = {...g2, company:g2?.company||selectedJob.company, title:g2?.title||selectedJob.title}; openSandbox(e2); openAtsPanel({ score:g2?.atsScore, report:g2?.atsReport, company:selectedJob.company, title:selectedJob.title }); }}
                    onExport={() => exportAndTrack(selectedJob, g2?.html, selectedJob.company)}
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

          {/* PANEL C — Sandbox / Resume */}
          {/* No maxSize cap — CSS scale transform in SandboxPanel handles wider-than-A4 display. */}
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

          {/* PANEL D — ATS + History */}
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
                             color:theme.textMuted, fontSize:16, padding:"4px 6px" }}>✕</button>
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

// ── Drag resize handle ────────────────────────────────────────
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

// ── Jobs column (shared across layout modes) ──────────────────
function JobsColumn({ jobs, scraping, scrapeError, scrapeNewCount, onClearScrapeNew, onClearScrapeError,
                      pollStatus, pollNewCount, resultsUpToDate, onRetryPoll,
                      generated, loading, applyMode, theme, isDark,
                      totalPages, currentPage, isLastPage,
                      generate, openSandbox, exportAndTrack,
                      visitUrl, toggleStar, toggleDislike, openAtsPanel,
                      goPage, handleRefresh, onPullRefresh,
                      setMobilePane, isMobile,
                      compact, selectedJobId, onJobSelect,
                      panelWidth = 400 }) {
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden",
                  background: isDark
                    ? `linear-gradient(160deg, ${theme.accentMuted}55 0%, ${theme.bg} 55%)`
                    : `linear-gradient(160deg, ${theme.accentMuted} 0%, ${theme.bg} 50%)` }}>
      {jobs.length === 0 && !scraping ? <EmptyState theme={theme}/> : (
        <PullToRefresh onRefresh={onPullRefresh} refreshing={scraping} theme={theme}>

          {/* Live polling pulsing bar — shows while scrape is in progress */}
          {pollStatus === "polling" && (
            <div style={{ margin:"6px 16px 0", padding:"8px 12px", borderRadius:4,
                          background:theme.accentMuted, border:`1px solid ${theme.accent}33`,
                          display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ display:"inline-block", width:8, height:8, borderRadius:"50%",
                             background:theme.accent, animation:"pulse 1.5s ease-in-out infinite" }}/>
              <span style={{ fontSize:11, color:theme.accentText, fontWeight:600 }}>
                {pollNewCount > 0
                  ? `Fetching… ${pollNewCount} new job${pollNewCount !== 1 ? "s" : ""} found so far`
                  : "Fetching new jobs…"}
              </span>
            </div>
          )}

          {/* Scrape complete — fades after 5s */}
          {pollStatus === "complete" && scrapeNewCount > 0 && (
            <div style={{ margin:"6px 16px 0", padding:"8px 12px", borderRadius:4,
                          background:"#dcfce7", border:"1px solid #86efac",
                          display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <span style={{ fontSize:11, fontWeight:700, color:"#166534" }}>
                ✓ Scrape complete — {scrapeNewCount} new job{scrapeNewCount !== 1 ? "s" : ""} added
              </span>
              <button onClick={onClearScrapeNew} style={{ background:"none", border:"none",
                cursor:"pointer", color:"#166534", fontSize:13 }}>✕</button>
            </div>
          )}

          {/* Results up to date (Set Role cache hit) */}
          {resultsUpToDate && (
            <div style={{ margin:"6px 16px 0", padding:"6px 12px", borderRadius:4,
                          background:theme.surfaceHigh, border:`1px solid ${theme.border}`,
                          fontSize:11, color:theme.textMuted }}>
              ✓ Results up to date
            </div>
          )}

          {/* Scrape error banner */}
          {scrapeError && (
            <div style={{ margin:"8px 16px 0", padding:"10px 14px", borderRadius:4,
                          background:"#fee2e2", border:"1px solid #fca5a5",
                          display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <span style={{ fontSize:12, color:"#991b1b" }}>
                ✗ {scrapeError}
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
                  cursor:"pointer", color:"#991b1b", fontSize:14 }}>✕</button>
              </div>
            </div>
          )}

          {/* Job cards — always rendered (even when scraping) */}
          {jobs.map(job => {
            const key = job.jobId, g = generated[key],
                  done = !!g?.html, st = loading[key];
            return (
              <JobCard
                key={key} job={job} g={g} done={done} st={st}
                applyMode={applyMode}
                theme={theme} isDark={isDark}
                showDislike={true}
                showApplyButton={!compact}
                compact={compact}
                selected={selectedJobId === key}
                onSelect={onJobSelect ? () => onJobSelect(job) : undefined}
                panelWidth={panelWidth}
                onGenerate={force => generate(job, force)}
                onViewSandbox={() => {
                  const entry = {...g, company:g.company||job.company, title:g.title||job.title};
                  openSandbox(entry);
                  openAtsPanel({ score:g.atsScore, report:g.atsReport, company:job.company, title:job.title });
                }}
                onExport={() => exportAndTrack(job, g.html, job.company)}
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
                ← Prev
              </LucyBtn>
              <span style={{ fontSize:12, color:theme.textMuted }}>
                Page {currentPage} of {totalPages}
              </span>
              <LucyBtn onClick={() => goPage(currentPage+1)}
                        disabled={currentPage >= totalPages} accent={theme.surfaceHigh}>
                Next →
              </LucyBtn>
            </div>
          )}

        </PullToRefresh>
      )}
    </div>
  );
}

// JobCard is imported from ../components/JobCard.jsx

// ── Empty state ───────────────────────────────────────────────
function EmptyState({ theme }) {
  const { theme: t } = useTheme();
  const th = theme || t;
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center",
                  justifyContent:"center", gap:16, padding:40, color:th.textDim }}>
      <div style={{ fontSize:56 }}>🔍</div>
      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                    fontSize:22, letterSpacing:"0.06em", textTransform:"uppercase", color:th.text }}>
        Search for a role above
      </div>
      <div style={{ fontSize:12, textAlign:"center", color:th.textDim, maxWidth:320, lineHeight:1.8 }}>
        LinkedIn + Indeed · full-time only · deduplicated · ghost jobs filtered
      </div>
    </div>
  );
}

// ── History list ──────────────────────────────────────────────
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
              <IconBtn bg="#0284c7" size={26} title="Open in sandbox" onClick={() => onOpen(v)}>👁</IconBtn>
              <IconBtn bg="#16a34a" size={26} title="Export PDF" onClick={() => onExport(null,v.html,v.company)}>📥</IconBtn>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Company Reuse Modal ────────────────────────────────────────
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
