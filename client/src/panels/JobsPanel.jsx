// client/src/panels/JobsPanel.jsx — Lucy Brand, shared job pool
// User board accent = soft sky blue (#A8D8EA)
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api, saveWithPicker } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";
import { useViewport } from "../hooks/useViewport.js";
import SandboxPanel from "./SandboxPanel.jsx";
import { ATSPanel } from "./ATSPanel.jsx";

const USER_ACCENT = "#A8D8EA";   // soft sky blue — user board
const USER_TEXT   = "#0f0f0f";   // black text on accent

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
function ATSBadge({ score }) {
  if (score == null) return null;
  const bg = score>=80 ? "#dcfce7" : score>=60 ? "#fef9c3" : "#fee2e2";
  const fg = score>=80 ? "#166534" : score>=60 ? "#854d0e" : "#991b1b";
  return (
    <span style={{ background:bg, color:fg, padding:"2px 8px",
                   borderRadius:999, fontSize:10, fontWeight:700 }}>
      ATS {score}
    </span>
  );
}

// ── Lucy button (rectangular → pill on hover, 1s) ─────────────
function LucyBtn({ children, onClick, disabled, accent = USER_ACCENT,
                    style = {}, title }) {
  const [hov, setHov] = useState(false);
  const { theme } = useTheme();
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

// ── Filters panel (collapsible) ───────────────────────────────
function FiltersPanel({
  open, onClose,
  categories,
  role, setRole,
  location, setLocation,
  workType, setWorkType,
  catFilter, setCatFilter,
  srcFilter, setSrcFilter,
  minYoe, setMinYoe,
  maxYoe, setMaxYoe,
  visitedFilter, setVisitedFilter,
  appliedFilter, setAppliedFilter,
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
          borderLeft:`3px solid ${USER_ACCENT}`,
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
          <div style={labelStyle}>Status</div>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            <select value={visitedFilter} onChange={e=>setVisitedFilter(e.target.value)} style={selStyle}>
              <option value="">Visited & unvisited</option>
              <option value="0">Unvisited only</option>
              <option value="1">Visited only</option>
            </select>
            <select value={appliedFilter} onChange={e=>setAppliedFilter(e.target.value)} style={selStyle}>
              <option value="">Applied & not applied</option>
              <option value="0">Not yet applied</option>
              <option value="1">Applied only</option>
            </select>
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

// ── Resize divider ────────────────────────────────────────────
function ResizeDivider({ onDrag }) {
  const [hov, setHov] = useState(false);
  const startRef = useRef(null);

  const onMouseDown = (e) => {
    e.preventDefault();
    startRef.current = e.clientX;

    const onMove = (ev) => {
      if (startRef.current === null) return;
      const delta = ev.clientX - startRef.current;
      startRef.current = ev.clientX;
      const container = document.getElementById("jobs-columns");
      if (container) onDrag(delta, container.offsetWidth);
    };
    const onUp = () => {
      startRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: 8, flexShrink: 0, cursor: "col-resize",
        display: "flex", alignItems: "stretch", justifyContent: "center",
        position: "relative", zIndex: 2,
        userSelect: "none",
      }}>
      <div style={{
        width: 2, background: hov ? USER_ACCENT : "transparent",
        borderLeft: `1px solid ${hov ? USER_ACCENT : "transparent"}`,
        transition: "background 0.15s, border-color 0.15s",
        pointerEvents: "none",
      }}/>
    </div>
  );
}

const PANEL_SIZE_KEY = "rm_panel_sizes";
const DEFAULT_SIZES = { left: 58, right: 42 };
const DEFAULT_SIZES_SANDBOX = { left: 36, center: 32, right: 22 };

// ── Main panel ────────────────────────────────────────────────
export default function JobsPanel({ user, onUserChange }) {
  const { theme } = useTheme();
  const { mode: vpMode } = useViewport();
  const isWide     = vpMode === "wide";
  const isMobile   = vpMode === "mobile" || vpMode === "tablet";
  const isPortrait = vpMode === "portrait" || vpMode === "laptop";

  // Mobile pane state
  const [mobilePane, setMobilePane] = useState("jobs"); // "jobs" | "editor" | "ats"

  // Panel sizes (percentages) — only for wide mode
  const [panelSizes, setPanelSizes] = useState(() => {
    try {
      const saved = localStorage.getItem(PANEL_SIZE_KEY);
      if (saved) return JSON.parse(saved);
    } catch {}
    return DEFAULT_SIZES;
  });

  // Persist panel sizes
  useEffect(() => {
    try { localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(panelSizes)); } catch {}
  }, [panelSizes]);

  // Job data
  const [jobs,        setJobs]        = useState([]);
  const [totalJobs,   setTotalJobs]   = useState(0);
  const [totalPages,  setTotalPages]  = useState(0);
  const [currentPage, setCurrentPage] = useState(1);

  // UI state
  const [scraping,    setScraping]    = useState(false);
  const [categories,  setCategories]  = useState([]);
  const [resumeText,  setResumeText]  = useState("");
  const [fileName,    setFileName]    = useState("");
  const [uploading,   setUploading]   = useState(false);
  const [generated,   setGenerated]   = useState({});
  const [loading,     setLoading]     = useState({});
  const [sandbox,     setSandbox]     = useState(null);
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const [rightTab,    setRightTab]    = useState("ats");

  // Open sandbox and rebalance panel sizes for wide mode
  const openSandbox = useCallback((entry) => {
    setSandbox(entry);
    setSandboxOpen(true);
    if (isWide) {
      setPanelSizes(prev => {
        const total = prev.left + prev.right;
        return { left: Math.max(20, Math.round(total * 0.52)), center: 30, right: Math.max(15, Math.round(total * 0.28)) };
      });
    }
    if (isMobile) setMobilePane("editor");
  }, [isWide, isMobile]);

  const closeSandbox = useCallback(() => {
    setSandboxOpen(false);
    if (isWide) {
      setPanelSizes(prev => {
        const leftPct  = prev.left || 36;
        const rightPct = prev.right || 22;
        const total = leftPct + rightPct;
        return { left: Math.round(total * 0.58), right: Math.round(total * 0.42) };
      });
    }
    if (isMobile) setMobilePane("jobs");
  }, [isWide, isMobile]);
  const [activeAts,   setActiveAts]   = useState(null);
  const [smartSearching, setSmartSearching] = useState(false);

  // Board tabs
  const [boardTab,    setBoardTab]    = useState("all");  // "all" | "saved"

  // Filter panel
  const [filtersOpen, setFiltersOpen] = useState(false);

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
  const [visitedFilter, setVisitedFilter] = useState("");
  const [appliedFilter, setAppliedFilter] = useState("");
  const [ageFilter,     setAgeFilter]     = useState("");

  const fileRef   = useRef();
  const applyMode = user?.applyMode || "TAILORED";
  const PAGE_SIZE = 25;

  // ── Build query params from current filter state ──────────
  const buildParams = useCallback((page = 1, overrideStarred = null) => {
    const p = new URLSearchParams();
    p.set("page", String(page));
    p.set("pageSize", String(PAGE_SIZE));
    p.set("sort", sortBy);
    if (roleFilter.trim())    p.set("role",     roleFilter.trim().toLowerCase());
    if (locationFilter.trim())p.set("location", locationFilter.trim());
    if (workType)             p.set("workType", workType);
    if (catFilter)            p.set("category", catFilter);
    if (srcFilter)            p.set("source",   srcFilter);
    if (minYoe !== "")        p.set("minYoe",   minYoe);
    if (maxYoe !== "")        p.set("maxYoe",   maxYoe);
    if (visitedFilter)        p.set("visited",  visitedFilter);
    if (appliedFilter)        p.set("applied",  appliedFilter);
    if (ageFilter)            p.set("ageFilter",ageFilter);
    if (localSearch.trim())   p.set("localSearch", localSearch.trim().toLowerCase());
    if (overrideStarred === "1" || boardTab === "saved") p.set("starred","1");
    p.set("hideGhost","true");
    p.set("hideFlag","true");
    return p.toString();
  }, [sortBy, roleFilter, locationFilter, workType, catFilter, srcFilter,
      minYoe, maxYoe, visitedFilter, appliedFilter, ageFilter, localSearch, boardTab]);

  // ── Fetch jobs ────────────────────────────────────────────
  const fetchJobs = useCallback(async (page = 1) => {
    const qs = buildParams(page);
    const d = await api(`/api/jobs?${qs}`);
    setJobs(d.jobs || []);
    setTotalJobs(d.total || 0);
    setTotalPages(d.totalPages || 0);
    setCurrentPage(page);
  }, [buildParams]);

  // ── Boot ──────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    Promise.all([
      api("/api/jobs?page=1&pageSize=25&sort=dateDesc&hideGhost=true&hideFlag=true"),
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

  // Re-fetch when filters/sort/page/tab change
  useEffect(() => {
    if (!user) return;
    fetchJobs(1);
  }, [sortBy, roleFilter, locationFilter, workType, catFilter, srcFilter,
      minYoe, maxYoe, visitedFilter, appliedFilter, ageFilter, localSearch, boardTab]);

  // ── Scrape / search ───────────────────────────────────────
  const handleSearch = useCallback(async (overrideQuery) => {
    const q = (overrideQuery || searchInput).trim();
    if (!q) return;
    // If board already has jobs, just filter to this role — no scrape
    if (jobs.length > 0) {
      setRoleFilter(q.toLowerCase());
      setSearchInput(q);
      return;
    }
    setScraping(true);
    try {
      const result = await api("/api/scrape", { method:"POST", body:JSON.stringify({ query:q }) });
      if (result.missingToken) {
        alert("⚠ No Apify token set.\n\nTo search for jobs:\n1. Go to console.apify.com\n2. Sign up free\n3. Settings → Integrations → copy your API token\n4. In this app: avatar → paste and Save");
        return;
      }
      if (result.error) { alert(result.error); return; }
      // Fetch with explicit role so results are scoped to the searched role
      const qs = new URLSearchParams();
      qs.set("page","1"); qs.set("pageSize","25"); qs.set("sort", sortBy);
      qs.set("role", q.toLowerCase()); qs.set("hideGhost","true"); qs.set("hideFlag","true");
      const d = await api(`/api/jobs?${qs.toString()}`);
      setJobs(d.jobs || []);
      setTotalJobs(d.total || 0);
      setTotalPages(d.totalPages || 0);
      setCurrentPage(1);
      setRoleFilter(q.toLowerCase());
    } catch(e) { alert("Scrape failed: " + e.message); }
    finally { setScraping(false); }
  }, [searchInput, fetchJobs, jobs.length, sortBy]);

  // ── Refresh: scrape fresh + hide visited ──────────────────────
  const handleRefresh = useCallback(async () => {
    const q = searchInput.trim();
    if (!q) { alert("Enter a search query first."); return; }
    setScraping(true);
    try {
      const result = await api("/api/scrape", { method:"POST", body:JSON.stringify({ query:q }) });
      if (result.missingToken) { alert("⚠ No Apify token set."); return; }
      if (result.error) { alert(result.error); return; }
      // Fetch fresh, unvisited, scoped to this role
      const qs = new URLSearchParams();
      qs.set("page","1"); qs.set("pageSize","25"); qs.set("sort", sortBy);
      qs.set("role", q.toLowerCase()); qs.set("visited","0");
      qs.set("hideGhost","true"); qs.set("hideFlag","true");
      const d = await api(`/api/jobs?${qs.toString()}`);
      setJobs(d.jobs || []);
      setTotalJobs(d.total || 0);
      setTotalPages(d.totalPages || 0);
      setCurrentPage(1);
      setVisitedFilter("0");
      setRoleFilter(q.toLowerCase());
    } catch(e) { alert("Refresh failed: " + e.message); }
    finally { setScraping(false); }
  }, [searchInput, sortBy]);

  // ── Smart search ──────────────────────────────────────────
  const handleSmartSearch = useCallback(async () => {
    if (!resumeText) {
      alert("Upload your base resume first — smart search extracts the best query from it.");
      fileRef.current?.click(); return;
    }
    setSmartSearching(true);
    try {
      const result = await api("/api/smart-search", { method:"POST", body:JSON.stringify({ resumeText }) });
      if (result.error) { alert(result.error); return; }
      const q = result.searchQuery;
      if (q) { setSearchInput(q); await handleSearch(q); }
    } catch(e) { alert("Smart search failed: " + e.message); }
    finally { setSmartSearching(false); }
  }, [resumeText, handleSearch]);

  // ── File upload ───────────────────────────────────────────
  const handleFile = useCallback(async e => {
    const file = e.target.files[0]; if (!file) return;
    setFileName(file.name); setUploading(true);
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
      alert("Error: " + err.message);
      setFileName(""); if (fileRef.current) fileRef.current.value = "";
    } finally { setUploading(false); }
  }, []);

  // ── Generate ──────────────────────────────────────────────
  const generate = useCallback(async (job, force = false) => {
    if (applyMode === "SIMPLE") { alert("Generation is disabled in Simple Apply mode."); return; }
    if (!resumeText)            { alert("Upload your base resume first."); return; }
    const key = job.jobId, existing = generated[key];
    if (existing?.html && existing.html !== "__exists__" && !force) {
      const entry = {...existing, company:existing.company||job.company, title:existing.title||job.title};
      openSandbox(entry);
      setActiveAts({ score:existing.atsScore, report:existing.atsReport, company:job.company, title:job.title });
      setRightTab("ats"); return;
    }
    setLoading(p => ({ ...p, [key]:"generating" }));
    try {
      const d = await api("/api/generate", { method:"POST",
        body:JSON.stringify({ jobId:key, job, resumeText, forceRegen:force }) });
      if (d.error) throw new Error(d.error);
      setGenerated(p => ({ ...p, [key]:{ html:d.html, atsScore:d.atsScore, atsReport:d.atsReport,
        company:job.company, title:job.title } }));
      openSandbox({ html:d.html, company:job.company, title:job.title });
      setActiveAts({ score:d.atsScore, report:d.atsReport, company:job.company, title:job.title });
      setRightTab("ats");
    } catch(e) { alert("Generation failed: " + e.message); }
    finally { setLoading(p => { const n = {...p}; delete n[key]; return n; }); }
  }, [resumeText, generated, applyMode]);

  const saveSandboxHtml = useCallback(async html => {
    if (!sandbox) return;
    const key = Object.entries(generated).find(([,v]) => v.company === sandbox.company)?.[0];
    if (key) await api(`/api/resumes/${key}/html`, { method:"POST", body:JSON.stringify({ html }) });
    setSandbox(s => ({...s, html}));
  }, [sandbox, generated]);

  const exportAndTrack = useCallback(async (job, html, company) => {
    const filename = `Resume_${(company||"").replace(/\s+/g,"_")}.pdf`;
    const r = await fetch("/api/export-pdf", { method:"POST", credentials:"include",
      headers:{"Content-Type":"application/json"}, body:JSON.stringify({ html, filename }) });
    if (!r.ok) { alert("PDF export failed"); return; }
    const blob = await r.blob();
    let savedPath = filename;
    try { savedPath = await saveWithPicker(blob, filename, "application/pdf"); }
    catch(e) { if (e.name === "AbortError") return; }
    if (job) {
      await api("/api/applications", { method:"POST", body:JSON.stringify({
        jobId:job.jobId, company:job.company, role:job.title,
        jobUrl:job.url, source:job.source, location:job.location,
        applyMode, resumeFile:savedPath,
      }) }).catch(()=>{});
      await fetchJobs(currentPage);
    }
  }, [applyMode, fetchJobs, currentPage]);

  // ── Starred toggle ────────────────────────────────────────
  const toggleStar = useCallback(async (jobId) => {
    try {
      const d = await api(`/api/jobs/${jobId}/starred`, { method:"PATCH" });
      setJobs(prev => prev.map(j => j.jobId === jobId ? {...j, starred: d.starred} : j));
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
    setRoleFilter(""); setLocationFilter(""); setWorkType(""); setCatFilter("");
    setSrcFilter(""); setMinYoe(""); setMaxYoe(""); setVisitedFilter("");
    setAppliedFilter(""); setAgeFilter(""); setLocalSearch("");
  };

  const genCount = Object.values(generated).filter(v=>v?.html && v.html !== "__exists__").length;
  const normalisedPreview = ALIASES[searchInput.trim().toLowerCase()]
    || (searchInput.trim() ? searchInput.trim().replace(/\b\w/g, c=>c.toUpperCase()) : "");
  const showPreview = !!(normalisedPreview && normalisedPreview.toLowerCase() !== searchInput.trim().toLowerCase());

  const isLastPage = currentPage >= totalPages;

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
            catFilter={catFilter}     setCatFilter={setCatFilter}
            srcFilter={srcFilter}     setSrcFilter={setSrcFilter}
            minYoe={minYoe}           setMinYoe={setMinYoe}
            maxYoe={maxYoe}           setMaxYoe={setMaxYoe}
            visitedFilter={visitedFilter} setVisitedFilter={setVisitedFilter}
            appliedFilter={appliedFilter} setAppliedFilter={setAppliedFilter}
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
          {[["all","All Jobs"],["saved","Saved ★"]].map(([id,lbl]) => (
            <button key={id} onClick={() => setBoardTab(id)}
              style={{
                padding:"6px 16px", border:"none", cursor:"pointer",
                fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                fontSize:13, letterSpacing:"0.08em", textTransform:"uppercase",
                background: boardTab===id ? USER_ACCENT : theme.surface,
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
            background: filtersOpen ? USER_ACCENT : theme.surface,
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

        {/* Local search */}
        <input value={localSearch} onChange={e => setLocalSearch(e.target.value)}
          placeholder="Filter visible jobs…"
          style={{ flex:1, minWidth:140, height:34, padding:"0 12px",
                   borderRadius:2, border:`1px solid ${theme.border}`,
                   background:theme.surface, color:theme.text,
                   fontFamily:"'DM Sans',system-ui", fontSize:13, outline:"none" }}/>

        {/* Job count */}
        <span style={{ fontSize:11, color:theme.textMuted, whiteSpace:"nowrap", flexShrink:0 }}>
          {totalJobs} job{totalJobs !== 1 ? "s" : ""}
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
            onKeyDown={e => e.key==="Enter" && handleSearch()}
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

        <LucyBtn onClick={() => handleSearch()} disabled={scraping}>
          {scraping ? "Searching…" : "Search"}
        </LucyBtn>
        <LucyBtn onClick={handleSmartSearch} disabled={smartSearching || scraping}
                  accent={theme.surfaceHigh}>
          {smartSearching ? "Analysing…" : "✦ Best Match"}
        </LucyBtn>

        <div style={{ width:1, height:24, background:theme.border, flexShrink:0 }}/>

        {/* Resume upload */}
        <input ref={fileRef} type="file" accept=".txt,.html,.md,.docx,.pdf"
          onChange={handleFile} style={{ display:"none" }}/>
        <button onClick={() => !uploading && fileRef.current.click()}
          style={{
            background:"transparent", border:`1px solid ${resumeText ? "#16a34a44" : theme.border}`,
            borderRadius:2, padding:"6px 14px", cursor:"pointer",
            fontSize:12, color: resumeText ? "#16a34a" : uploading ? "#d97706" : theme.textMuted,
            fontFamily:"'DM Sans',system-ui", flexShrink:0,
          }}>
          {uploading ? "⏳ Parsing…"
            : resumeText ? `✓ ${fileName.length>22 ? fileName.slice(0,22)+"…" : fileName}`
            : "📄 Upload Resume"}
        </button>
        {resumeText && !uploading && (
          <button
            style={{ background:"none", border:"none", color:theme.danger,
                     cursor:"pointer", fontSize:12, padding:"4px 8px" }}
            onClick={() => {
              setResumeText(""); setFileName("");
              api("/api/base-resume", { method:"POST", body:JSON.stringify({ content:"", name:"" }) });
            }}>✕</button>
        )}
      </div>

      {/* ── Body: responsive layout ─────────────────────────── */}

      {/* ── MOBILE / TABLET: single-pane + bottom nav ── */}
      {isMobile && (
        <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
          {/* Active pane */}
          <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>
            {mobilePane === "jobs" && (
              <JobsColumn
                jobs={jobs} scraping={scraping} generated={generated} loading={loading}
                applyMode={applyMode} theme={theme}
                totalPages={totalPages} currentPage={currentPage} isLastPage={isLastPage}
                generate={generate} openSandbox={openSandbox} exportAndTrack={exportAndTrack}
                visitUrl={visitUrl} toggleStar={toggleStar} setActiveAts={setActiveAts}
                setRightTab={setRightTab} goPage={goPage} handleRefresh={handleRefresh}
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
                        borderBottom: rightTab===id ? `2px solid ${USER_ACCENT}` : "2px solid transparent",
                      }}>
                      {lbl}
                    </button>
                  ))}
                </div>
                {rightTab === "ats" && <ATSPanel report={activeAts?.report} score={activeAts?.score}/>}
                {rightTab === "history" && (
                  <HistoryList generated={generated}
                    theme={theme}
                    onOpen={e => {
                      openSandbox(e);
                      setActiveAts({ score:e.atsScore, report:e.atsReport, company:e.company, title:e.title||e.role });
                      setRightTab("ats");
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
                  color: mobilePane===id ? USER_ACCENT : theme.textMuted,
                  fontSize:10, fontWeight:700,
                }}>
                <span style={{ fontSize:18 }}>{icon}</span>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── PORTRAIT / LAPTOP: two columns, sandbox as overlay ── */}
      {isPortrait && !isMobile && (
        <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
          {/* LEFT jobs */}
          <div style={{ display:"flex", flexDirection:"column", minWidth:0, flex:"0 0 58%",
                        borderRight:`1px solid ${theme.border}` }}>
            <JobsColumn
              jobs={jobs} scraping={scraping} generated={generated} loading={loading}
              applyMode={applyMode} theme={theme}
              totalPages={totalPages} currentPage={currentPage} isLastPage={isLastPage}
              generate={generate} openSandbox={openSandbox} exportAndTrack={exportAndTrack}
              visitUrl={visitUrl} toggleStar={toggleStar} setActiveAts={setActiveAts}
              setRightTab={setRightTab} goPage={goPage} handleRefresh={handleRefresh}
            />
          </div>
          {/* RIGHT ATS */}
          <div style={{ display:"flex", flexDirection:"column", minWidth:0, flex:1 }}>
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
                    borderBottom: rightTab===id ? `2px solid ${USER_ACCENT}` : "2px solid transparent",
                  }}>
                  {lbl}
                </button>
              ))}
            </div>
            <div style={{ flex:1, overflowY:"auto" }}>
              {rightTab === "ats" && <ATSPanel report={activeAts?.report} score={activeAts?.score}/>}
              {rightTab === "history" && (
                <HistoryList generated={generated}
                  theme={theme}
                  onOpen={e => {
                    openSandbox(e);
                    setActiveAts({ score:e.atsScore, report:e.atsReport, company:e.company, title:e.title||e.role });
                    setRightTab("ats");
                  }}
                  onExport={exportAndTrack}/>
              )}
            </div>
          </div>
          {/* Sandbox overlay for portrait/laptop */}
          {sandboxOpen && (
            <div style={{
              position:"absolute", inset:0, zIndex:50,
              display:"flex", flexDirection:"column",
              background:theme.bg,
            }}>
              <div style={{ background:theme.surface, borderBottom:`1px solid ${theme.border}`,
                            padding:"8px 14px", display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
                <button onClick={closeSandbox}
                  style={{ background:"none", border:"none", cursor:"pointer",
                            color:theme.textMuted, fontSize:13, fontWeight:700,
                            display:"flex", alignItems:"center", gap:4 }}>
                  ← Back
                </button>
              </div>
              <SandboxPanel entry={sandbox} onClose={closeSandbox}
                onSave={saveSandboxHtml} onExport={exportAndTrack}/>
            </div>
          )}
        </div>
      )}

      {/* ── WIDE: three-column resizable ── */}
      {isWide && (
        <div id="jobs-columns" style={{ flex:1, display:"flex", overflow:"hidden" }}>

          {/* LEFT — job cards */}
          <div style={{
            display:"flex", flexDirection:"column", minWidth:0,
            flex: `0 0 ${sandboxOpen ? panelSizes.left : panelSizes.left}%`,
          }}>
            <JobsColumn
              jobs={jobs} scraping={scraping} generated={generated} loading={loading}
              applyMode={applyMode} theme={theme}
              totalPages={totalPages} currentPage={currentPage} isLastPage={isLastPage}
              generate={generate} openSandbox={openSandbox} exportAndTrack={exportAndTrack}
              visitUrl={visitUrl} toggleStar={toggleStar} setActiveAts={setActiveAts}
              setRightTab={setRightTab} goPage={goPage} handleRefresh={handleRefresh}
            />
          </div>

          {/* LEFT↔CENTRE or LEFT↔RIGHT divider */}
          <ResizeDivider onDrag={(delta, containerW) => {
            const deltaPct = (delta / containerW) * 100;
            setPanelSizes(prev => {
              if (sandboxOpen) {
                const newLeft = Math.min(Math.max(20, prev.left + deltaPct), 100 - prev.right - 20);
                return { ...prev, left: newLeft };
              } else {
                const newLeft = Math.min(Math.max(20, prev.left + deltaPct), 100 - 15);
                const newRight = 100 - newLeft;
                return { left: newLeft, right: Math.max(15, newRight) };
              }
            });
          }}/>

          {/* CENTRE — Sandbox */}
          {sandboxOpen && (
            <>
              <div style={{ display:"flex", flexDirection:"column", minWidth:0,
                            flex: `0 0 ${panelSizes.center}%` }}>
                <SandboxPanel entry={sandbox} onClose={closeSandbox}
                  onSave={saveSandboxHtml} onExport={exportAndTrack}/>
              </div>
              {/* CENTRE↔RIGHT divider */}
              <ResizeDivider onDrag={(delta, containerW) => {
                const deltaPct = (delta / containerW) * 100;
                setPanelSizes(prev => {
                  const newCenter = Math.min(Math.max(20, (prev.center||30) + deltaPct), 100 - prev.left - 15);
                  const newRight  = Math.max(15, 100 - prev.left - newCenter);
                  return { ...prev, center: newCenter, right: newRight };
                });
              }}/>
            </>
          )}

          {/* RIGHT — ATS + History */}
          <div style={{ display:"flex", flexDirection:"column", minWidth:0,
                        flex: sandboxOpen ? `0 0 ${panelSizes.right}%` : `0 0 ${panelSizes.right}%` }}>
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
                    borderBottom: rightTab===id ? `2px solid ${USER_ACCENT}` : "2px solid transparent",
                  }}>
                  {lbl}
                </button>
              ))}
            </div>
            <div style={{ flex:1, overflowY:"auto" }}>
              {rightTab === "ats" && <ATSPanel report={activeAts?.report} score={activeAts?.score}/>}
              {rightTab === "history" && (
                <HistoryList generated={generated}
                  theme={theme}
                  onOpen={e => {
                    openSandbox(e);
                    setActiveAts({ score:e.atsScore, report:e.atsReport, company:e.company, title:e.title||e.role });
                    setRightTab("ats");
                  }}
                  onExport={exportAndTrack}/>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Jobs column (shared across layout modes) ──────────────────
function JobsColumn({ jobs, scraping, generated, loading, applyMode, theme,
                      totalPages, currentPage, isLastPage,
                      generate, openSandbox, exportAndTrack,
                      visitUrl, toggleStar, setActiveAts, setRightTab,
                      goPage, handleRefresh }) {
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      {jobs.length === 0 && !scraping ? <EmptyState theme={theme}/> : (
        <div style={{ flex:1, overflowY:"auto", paddingTop:8, paddingBottom:8 }}>

          {/* Skeleton cards while scraping */}
          {scraping && Array.from({length:6},(_,i) => (
            <div key={i} style={{ border:`1px solid ${theme.border}`,
              borderRadius:4, padding:"14px 18px", margin:"0 16px 8px",
              display:"flex", alignItems:"center", gap:14 }}>
              <div style={{ width:48, height:48, borderRadius:10, background:theme.surfaceHigh, flexShrink:0 }}/>
              <div style={{ flex:1, display:"flex", flexDirection:"column", gap:8 }}>
                <div style={{ height:14, width:"40%", borderRadius:4, background:theme.surfaceHigh }}/>
                <div style={{ height:11, width:"60%", borderRadius:4, background:theme.surfaceHigh }}/>
              </div>
            </div>
          ))}

          {/* Job cards */}
          {!scraping && jobs.map(job => {
            const key = job.jobId, g = generated[key],
                  done = !!g?.html, st = loading[key];
            return (
              <JobCard
                key={key} job={job} g={g} done={done} st={st}
                applyMode={applyMode}
                theme={theme}
                onGenerate={force => generate(job, force)}
                onViewSandbox={() => {
                  const entry = {...g, company:g.company||job.company, title:g.title||job.title};
                  openSandbox(entry);
                  setActiveAts({ score:g.atsScore, report:g.atsReport, company:job.company, title:job.title });
                  setRightTab("ats");
                }}
                onExport={() => exportAndTrack(job, g.html, job.company)}
                onVisit={() => visitUrl(job)}
                onStar={() => toggleStar(key)}
                onCardClick={() => {
                  if (done && g.html !== "__exists__") {
                    const entry = {...g, company:g.company||job.company, title:g.title||job.title};
                    openSandbox(entry);
                    setActiveAts({ score:g.atsScore, report:g.atsReport, company:job.company, title:job.title });
                    setRightTab("ats");
                  } else if (job.url) {
                    visitUrl(job);
                  }
                }}
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

          {/* Refresh */}
          {jobs.length > 0 && isLastPage && (
            <div style={{ padding:"16px 20px", display:"flex", justifyContent:"center",
                          flexDirection:"column", alignItems:"center", gap:6 }}>
              <LucyBtn onClick={handleRefresh} disabled={scraping}
                        style={{ width:"100%", maxWidth:320, justifyContent:"center" }}>
                {scraping ? "Scraping…" : "↻ Refresh New Jobs"}
              </LucyBtn>
              <span style={{ fontSize:10, color:theme.textDim }}>Scrapes fresh listings · hides visited</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Job card ──────────────────────────────────────────────────
function JobCard({ job, g, done, st, applyMode, theme,
                   onGenerate, onViewSandbox, onExport, onVisit, onStar, onCardClick }) {
  const [hov, setHov] = useState(false);
  return (
    <div
      onClick={onCardClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        background:theme.surface,
        border: hov ? `1px solid ${USER_ACCENT}` : `1px solid ${theme.border}`,
        borderRadius:4, padding:"14px 18px", margin:"0 16px 8px",
        display:"flex", alignItems:"center", gap:14, cursor:"pointer",
        boxShadow: hov ? theme.shadowMd : "none",
        transform: hov ? "translateY(-3px)" : "translateY(0)",
        transition:"all 0.2s ease", position:"relative",
        // Visited: slightly desaturated
        opacity: job.visited ? 0.75 : 1,
      }}>

      {/* Company icon — 48×48 rounded square */}
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
          {/* Platform logo */}
          <span style={{ display:"flex", alignItems:"center", gap:4 }}>
            <PlatformLogo platform={job.sourcePlatform || job.source} size={16} theme={theme}/>
          </span>
          {job.location && (
            <span style={{ fontSize:10, color:theme.textDim }}>{job.location}</span>
          )}
          {job.yearsExperience != null && (
            <span style={{ fontSize:10, color:theme.textDim }}>{job.yearsExperience}y exp</span>
          )}
          {job.compensation && (
            <span style={{ fontSize:10, color:"#16a34a", fontWeight:700 }}>{job.compensation}</span>
          )}
        </div>
      </div>

      {/* Right side */}
      <div style={{ display:"flex", alignItems:"center", gap:5, flexShrink:0 }}>
        <span style={{ fontSize:11, color:"#16a34a", fontWeight:600 }}>{ago(job.postedAt)}</span>
        {g?.atsScore != null && <ATSBadge score={g.atsScore}/>}

        {/* Star / bookmark */}
        <button
          title={job.starred ? "Remove from saved" : "Save job"}
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

        {/* Generate */}
        {applyMode !== "SIMPLE" && (
          <IconBtn bg={USER_ACCENT} title={done ? "Regenerate" : "Generate resume"}
            disabled={!!st}
            onClick={e => { e.stopPropagation(); onGenerate(done && g.html !== "__exists__"); }}>
            {st ? "⏳" : done ? "↻" : "✦"}
          </IconBtn>
        )}

        {/* View in sandbox */}
        {done && g.html !== "__exists__" && (
          <IconBtn bg="#0284c7" title="View in sandbox"
            onClick={e => { e.stopPropagation(); onViewSandbox(); }}>
            👁
          </IconBtn>
        )}

        {/* Export PDF */}
        {done && g.html !== "__exists__" && (
          <IconBtn bg="#16a34a" title="Export PDF"
            onClick={e => { e.stopPropagation(); onExport(); }}>
            📥
          </IconBtn>
        )}

      </div>
    </div>
  );
}

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
