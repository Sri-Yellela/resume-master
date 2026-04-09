// client/src/panels/JobsPanel.jsx — Design System v4
import { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api, saveWithPicker } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";
import SandboxPanel from "./SandboxPanel.jsx";
import { ATSPanel } from "./ATSPanel.jsx";

// ── Helpers ───────────────────────────────────────────────────
function companyColor(name) {
  const colors = ["#e85d04","#7c3aed","#0891b2","#16a34a","#dc2626","#d97706","#9333ea","#0284c7"];
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffff;
  return colors[hash % colors.length];
}

function ago(ts) {
  if (!ts) return "—";
  const d = Date.now() - new Date(ts).getTime();
  if (d<3600000)  return `${Math.floor(d/60000)}m`;
  if (d<86400000) return `${Math.floor(d/3600000)}h`;
  return `${Math.floor(d/86400000)}d`;
}
function timeLeft(ms) {
  if (!ms||ms<=0) return "cache expired";
  return `${Math.floor(ms/3600000)}h ${Math.floor((ms%3600000)/60000)}m`;
}

// ── Client-side alias map (mirrors server normaliser) ─────────
const ALIASES = {
  "swe":"Software Engineer","software dev":"Software Engineer",
  "software developer":"Software Engineer","mle":"Machine Learning Engineer",
  "ml engineer":"Machine Learning Engineer","ml":"Machine Learning Engineer",
  "ds":"Data Scientist","data science":"Data Scientist","sde":"Software Engineer",
  "frontend":"Frontend Engineer","front end":"Frontend Engineer","front-end":"Frontend Engineer",
  "backend":"Backend Engineer","back end":"Backend Engineer","back-end":"Backend Engineer",
  "fullstack":"Full Stack Engineer","full stack":"Full Stack Engineer","full-stack":"Full Stack Engineer",
  "devops":"DevOps Engineer","dev ops":"DevOps Engineer","sre":"Site Reliability Engineer",
  "pm":"Product Manager","tpm":"Technical Program Manager","em":"Engineering Manager",
  "de":"Data Engineer","data eng":"Data Engineer","ai engineer":"AI Engineer",
  "genai":"Generative AI Engineer","gen ai":"Generative AI Engineer","llm":"LLM Engineer",
};

// ── Badges ────────────────────────────────────────────────────
function WorkBadge({ t }) {
  const { theme } = useTheme();
  const map = {
    Remote: { bg:theme.accentMuted, fg:theme.accentText },
    Hybrid: { bg:theme.infoMuted,   fg:theme.info },
    Onsite: { bg:theme.surfaceHigh, fg:theme.textMuted },
  };
  const s = map[t] || { bg:theme.surfaceHigh, fg:theme.textMuted };
  return (
    <span className="rm-badge" style={{ background:s.bg, color:s.fg }}>
      {t || "—"}
    </span>
  );
}

function SrcBadge({ s }) {
  const map = {
    LinkedIn: { bg:"rgba(59,130,246,0.12)", fg:"#3b82f6" },
    Indeed:   { bg:"rgba(234,179,8,0.12)",  fg:"#ca8a04" },
  };
  const st = map[s] || { bg:"rgba(128,128,128,0.1)", fg:"#888" };
  return (
    <span className="rm-badge" style={{ background:st.bg, color:st.fg }}>
      {s}
    </span>
  );
}

const ATSBadge = ({ score }) => {
  if (score==null) return null;
  const bg = score>=80 ? "#dcfce7" : score>=60 ? "#fef9c3" : "#fee2e2";
  const fg = score>=80 ? "#166534" : score>=60 ? "#854d0e" : "#991b1b";
  return (
    <span className="rm-badge" style={{ background:bg, color:fg }}>
      ATS {score}
    </span>
  );
};

const AppliedFlag = ({ applied, companyBefore }) => applied
  ? <span title="Already applied to this job" style={{ fontSize:11 }}>🚩</span>
  : companyBefore ? <span title="Applied to this company before" style={{ fontSize:11, opacity:.5 }}>🏳</span>
  : null;

// ── IconBtn ───────────────────────────────────────────────────
function IconBtn({ bg, onClick, title, children, disabled=false, size=28 }) {
  const { theme } = useTheme();
  const [hov, setHov] = useState(false);
  return (
    <button title={title} disabled={disabled} onClick={onClick}
      onMouseEnter={() => !disabled && setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width:size, height:size, borderRadius:"999px",
        background: disabled ? theme.surfaceHigh : hov ? bg : theme.surfaceHigh,
        border:`1px solid ${disabled ? theme.border : hov ? bg+"44" : theme.border}`,
        display:"flex", alignItems:"center", justifyContent:"center",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize:12, color: hov && !disabled ? "white" : theme.textMuted,
        opacity: disabled ? 0.4 : 1,
        transition:"all 0.15s ease",
        flexShrink:0,
        transform: hov && !disabled ? "scale(1.1)" : "scale(1)",
      }}>
      {children}
    </button>
  );
}

// ── Apply popup ───────────────────────────────────────────────
function ApplyPopup({ job, onClose }) {
  const { theme } = useTheme();

  useEffect(() => {
    const h = e => { if (e.key==="Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.75)",
                  backdropFilter:"blur(8px)", zIndex:1000,
                  display:"flex", alignItems:"center",
                  justifyContent:"center", padding:16 }}
         onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <motion.div
        initial={{ opacity:0, scale:0.95 }} animate={{ opacity:1, scale:1 }}
        exit={{ opacity:0, scale:0.95 }} transition={{ duration:0.18 }}
        style={{ background:theme.surface, borderRadius:24,
                 padding:28, width:"100%", maxWidth:420,
                 maxHeight:"calc(100vh - 32px)", overflowY:"auto",
                 boxShadow:theme.shadowXl,
                 border:`1px solid ${theme.border}` }}>
        <div style={{ display:"flex", justifyContent:"space-between",
                      alignItems:"flex-start", marginBottom:14 }}>
          <div>
            <div style={{ fontWeight:800, fontSize:15, color:theme.accent,
                          wordBreak:"break-word" }}>{job.company}</div>
            <div style={{ fontSize:12, color:theme.textMuted, marginTop:3,
                          wordBreak:"break-word" }}>{job.title}</div>
          </div>
          <button onClick={onClose}
            style={{ background:"transparent", border:"none",
                     color:theme.textMuted, cursor:"pointer",
                     fontSize:16, padding:4, flexShrink:0 }}>✕</button>
        </div>
        <div style={{ fontSize:11, color:theme.textMuted, lineHeight:1.7, marginBottom:18,
                      background:theme.surfaceHigh, padding:"10px 12px", borderRadius:10,
                      border:`1px solid ${theme.border}` }}>
          The job portal will open in a new tab. The Chrome extension will autofill your profile.
          If you haven't installed it yet, use the bookmarklet from the extension popup.
        </div>
        <div style={{ display:"flex", justifyContent:"flex-end" }}>
          <a href={job.url} target="_blank" rel="noreferrer"
            style={{ background:theme.gradAccent, color:"white", padding:"10px 22px",
                     borderRadius:999, textDecoration:"none", fontWeight:700,
                     fontSize:13, display:"inline-block" }}
            onClick={onClose}>
            Open Application →
          </a>
        </div>
      </motion.div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────
export default function JobsPanel({ user, onUserChange }) {
  const { theme, mode } = useTheme();

  const [jobs,        setJobs]        = useState([]);
  const [cacheInfo,   setCacheInfo]   = useState(null);
  const [categories,  setCategories]  = useState([]);
  const [resumeText,  setResumeText]  = useState("");
  const [fileName,    setFileName]    = useState("");
  const [uploading,   setUploading]   = useState(false);
  const [generated,   setGenerated]   = useState({});
  const [loading,     setLoading]     = useState({});
  const [sandbox,     setSandbox]     = useState(null);
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const [rightTab,    setRightTab]    = useState("ats");
  const [activeAts,   setActiveAts]   = useState(null);
  const [scraping,    setScraping]    = useState(false);
  const [quota,       setQuota]       = useState(null);
  const [searchInput, setSearchInput] = useState("");
  const [typeFilter,  setTypeFilter]  = useState("");
  const [catFilter,   setCatFilter]   = useState("");
  const [srcFilter,   setSrcFilter]   = useState("");
  const [expFilter,   setExpFilter]   = useState("");
  const [ageFilter,   setAgeFilter]   = useState("");
  const [applyJob,    setApplyJob]    = useState(null);
  const [smartSearching, setSmartSearching] = useState(false);

  const fileRef = useRef();
  const applyMode = user?.applyMode || "TAILORED";

  // Boot
  useEffect(() => {
    if (!user) return;
    Promise.all([
      api("/api/jobs"),
      api("/api/categories"),
      api("/api/base-resume"),
      api("/api/resumes"),
      api("/api/scrape/quota"),
    ]).then(([jr,cats,rr,gr,q]) => {
      if (jr.jobs?.length) { setJobs(jr.jobs); setCacheInfo(jr); }
      setCategories(cats||[]);
      if (rr.content) { setResumeText(rr.content); setFileName(rr.name||"Saved resume"); }
      if (gr?.length) {
        const map={};
        gr.forEach(r=>{ map[r.job_id]={html:"__exists__",atsScore:r.ats_score,
          atsReport:r.ats_report,company:r.company,title:r.role}; });
        setGenerated(map);
      }
      setQuota(q);
    }).catch(console.error);
  }, [user]);

  // Search
  const handleSearch = useCallback(async (overrideQuery) => {
    const q=(overrideQuery||searchInput).trim(); if(!q) return;
    setScraping(true);
    try {
      const params=`query=${encodeURIComponent(q)}&ageFilter=${ageFilter}&hideGhost=true&hideFlag=true`;
      const check=await api(`/api/jobs?${params}`);
      if (check.cacheValid&&check.jobs?.length) { setJobs(check.jobs); setCacheInfo(check); return; }
      const result=await api("/api/scrape",{method:"POST",body:JSON.stringify({query:q})});
      if (result.missingToken) {
        alert("⚠ No Apify token set.\n\nTo search for jobs you need a free Apify token:\n1. Go to console.apify.com\n2. Sign up free\n3. Settings → Integrations → copy your API token\n4. In this app: ☰ menu → API Keys → paste and Save\n\nAlso subscribe to:\n• curious_coder/linkedin-jobs-scraper\n• curious_coder/indeed-scraper");
        return;
      }
      if (result.error) { alert(result.error); return; }
      setQuota(result.quota);
      const jr=await api(`/api/jobs?${params}`);
      setJobs(jr.jobs||[]); setCacheInfo(jr);
    } catch(e) { alert("Scrape failed: "+e.message); }
    finally { setScraping(false); }
  }, [searchInput,ageFilter]);

  // Smart search
  const handleSmartSearch = useCallback(async () => {
    if (!resumeText) {
      alert("Upload your base resume first — smart search extracts the best query from it.");
      fileRef.current?.click();
      return;
    }
    setSmartSearching(true);
    try {
      const result = await api("/api/smart-search", {
        method: "POST",
        body: JSON.stringify({ resumeText }),
      });
      if (result.error) { alert(result.error); return; }
      const q = result.searchQuery;
      if (q) {
        setSearchInput(q);
        await handleSearch(q);
      }
    } catch(e) { alert("Smart search failed: " + e.message); }
    finally { setSmartSearching(false); }
  }, [resumeText, handleSearch]);

  // File upload
  const handleFile = useCallback(async e => {
    const file=e.target.files[0]; if(!file) return;
    setFileName(file.name); setUploading(true);
    try {
      const ext=file.name.split(".").pop().toLowerCase();
      let text="";
      if (ext==="pdf") {
        const fd=new FormData(); fd.append("file",file);
        const r=await fetch("/api/parse-pdf",{method:"POST",credentials:"include",body:fd});
        const d=await r.json(); if(d.error) throw new Error(d.error);
        text=d.text;
      } else if (ext==="docx") {
        const mammoth=(await import("mammoth")).default;
        text=(await mammoth.extractRawText({arrayBuffer:await file.arrayBuffer()})).value;
      } else { text=await file.text(); }
      setResumeText(text);
      await api("/api/base-resume",{method:"POST",body:JSON.stringify({content:text,name:file.name})});
    } catch(err) {
      alert("Error: "+err.message);
      setFileName("");
      if (fileRef.current) fileRef.current.value = "";
    }
    finally { setUploading(false); }
  },[]);

  // Generate
  const generate = useCallback(async (job,force=false) => {
    if (applyMode==="SIMPLE") { alert("Generation is disabled in Simple Apply mode."); return; }
    if (!resumeText)          { alert("Upload your base resume first."); return; }
    const key=job.jobId, existing=generated[key];
    if (existing?.html&&existing.html!=="__exists__"&&!force) {
      setSandbox({...existing,company:existing.company||job.company,title:existing.title||job.title});
      setSandboxOpen(true);
      setActiveAts({score:existing.atsScore,report:existing.atsReport,company:job.company,title:job.title});
      setRightTab("ats"); return;
    }
    setLoading(p=>({...p,[key]:"generating"}));
    try {
      const d=await api("/api/generate",{method:"POST",body:JSON.stringify({jobId:key,job,resumeText,forceRegen:force})});
      if (d.error) throw new Error(d.error);
      setGenerated(p=>({...p,[key]:{html:d.html,atsScore:d.atsScore,atsReport:d.atsReport,company:job.company,title:job.title}}));
      setSandbox({html:d.html,company:job.company,title:job.title});
      setSandboxOpen(true);
      setActiveAts({score:d.atsScore,report:d.atsReport,company:job.company,title:job.title});
      setRightTab("ats");
    } catch(e) { alert("Generation failed: "+e.message); }
    finally { setLoading(p=>{ const n={...p}; delete n[key]; return n; }); }
  },[resumeText,generated,applyMode]);

  const saveSandboxHtml = useCallback(async html => {
    if (!sandbox) return;
    const key=Object.entries(generated).find(([,v])=>v.company===sandbox.company)?.[0];
    if (key) await api(`/api/resumes/${key}/html`,{method:"POST",body:JSON.stringify({html})});
    setSandbox(s=>({...s,html}));
  },[sandbox,generated]);

  const exportAndTrack = useCallback(async (job,html,company) => {
    const filename=`Resume_${(company||"").replace(/\s+/g,"_")}.pdf`;
    const r=await fetch("/api/export-pdf",{method:"POST",credentials:"include",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({html,filename})});
    if (!r.ok) { alert("PDF export failed"); return; }
    const blob=await r.blob();
    let savedPath=filename;
    try { savedPath=await saveWithPicker(blob,filename,"application/pdf"); }
    catch(e) { if(e.name==="AbortError") return; }
    if (job) {
      await api("/api/applications",{method:"POST",body:JSON.stringify({
        jobId:job.jobId,company:job.company,role:job.title,
        jobUrl:job.url,source:job.source,location:job.location,
        applyMode,resumeFile:savedPath,
      })}).catch(()=>{});
      const params=`query=${encodeURIComponent(searchInput)}&ageFilter=${ageFilter}&hideGhost=true&hideFlag=true`;
      const jr=await api(`/api/jobs?${params}`); setJobs(jr.jobs||[]);
    }
  },[applyMode,searchInput,ageFilter]);

  // ── Derived values ───────────────────────────────────────────
  const sources  = [...new Set(jobs.map(j=>j.source).filter(Boolean))];
  const expYears = expFilter !== "" ? Number(expFilter) : null;
  const expTolerance = expYears !== null ? Math.round(Math.sqrt(expYears || 1)) : null;

  const filtered = jobs.filter(j => {
    if (!typeFilter || j.workType === typeFilter) {} else return false;
    if (!catFilter  || j.category === catFilter)  {} else return false;
    if (!srcFilter  || j.source === srcFilter)    {} else return false;
    if (expYears !== null && expTolerance !== null) {
      const jExp = j.yearsExperience;
      if (jExp != null) {
        if (jExp < expYears - expTolerance || jExp > expYears + expTolerance) return false;
      }
    }
    return true;
  });
  const genCount = Object.values(generated).filter(v=>v?.html&&v.html!=="__exists__").length;

  const normalisedPreview = ALIASES[searchInput.trim().toLowerCase()]
    || (searchInput.trim() ? searchInput.trim().replace(/\b\w/g,c=>c.toUpperCase()) : "");
  const showPreview = !!(normalisedPreview &&
    normalisedPreview.toLowerCase() !== searchInput.trim().toLowerCase());

  const selStyle = {
    padding:"4px 10px", borderRadius:10, height:36,
    border:`1px solid ${theme.border}`,
    background:theme.surface, color:theme.text,
    fontSize:12, maxWidth:145, flex:"0 0 auto", outline:"none",
  };

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden",
                  background:theme.bg }}>

      <AnimatePresence>
        {applyJob && <ApplyPopup job={applyJob} onClose={()=>setApplyJob(null)}/>}
      </AnimatePresence>

      {/* ── Filter bar ── */}
      <div style={{
        background: mode==="light" ? "rgba(255,255,255,0.92)" : "rgba(17,17,17,0.92)",
        backdropFilter:"blur(16px)", borderBottom:`1px solid ${theme.border}`,
        padding:"10px 20px", display:"flex", alignItems:"center", gap:10,
        flexShrink:0, flexWrap:"wrap", position:"sticky", top:56, zIndex:50,
      }}>
        {/* Search input */}
        <div style={{ position:"relative", flex:1, minWidth:200 }}>
          <span style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)",
                         fontSize:14, color:theme.textDim, pointerEvents:"none" }}>🔍</span>
          <input value={searchInput} onChange={e=>setSearchInput(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&handleSearch()}
            placeholder="Search role — e.g. ML Engineer, SWE, Data Scientist…"
            style={{ width:"100%", height:40, paddingLeft:38, paddingRight:14,
                     borderRadius:999, border:`1px solid ${theme.border}`,
                     background:theme.surface, color:theme.text,
                     fontFamily:"'DM Sans',system-ui", fontSize:13, outline:"none",
                     boxSizing:"border-box", transition:"border-color 0.15s" }}/>
          {showPreview && (
            <div style={{ position:"absolute", top:"calc(100% + 4px)", left:0,
              fontSize:10, color:theme.textMuted,
              background:theme.surface, border:`1px solid ${theme.border}`,
              borderRadius:8, padding:"4px 10px",
              whiteSpace:"nowrap", zIndex:10, boxShadow:theme.shadowSm }}>
              Will search as: <span style={{ color:theme.accent, fontWeight:700 }}>{normalisedPreview}</span>
            </div>
          )}
        </div>

        <button onClick={()=>handleSearch()} disabled={scraping} className="rm-btn rm-btn-primary"
          style={{ flexShrink:0 }}>
          {scraping ? "⏳ Searching…" : "Search"}
        </button>
        <button onClick={handleSmartSearch} disabled={smartSearching||scraping}
          className="rm-btn rm-btn-ghost"
          style={{ color:theme.accent, borderColor:theme.accent+"44", flexShrink:0 }}>
          {smartSearching ? "⏳ Analysing…" : "✦ Best Match"}
        </button>

        {/* divider */}
        <div style={{ width:1, height:24, background:theme.border, flexShrink:0 }}/>

        {/* Resume upload */}
        <input ref={fileRef} type="file" accept=".txt,.html,.md,.docx,.pdf"
          onChange={handleFile} style={{ display:"none" }}/>
        <button onClick={()=>!uploading&&fileRef.current.click()}
          className="rm-btn rm-btn-ghost"
          style={{
            flexShrink:0,
            color: resumeText ? theme.success : uploading ? theme.warning : theme.textMuted,
            borderColor: resumeText ? theme.success+"44" : theme.border,
          }}>
          {uploading ? "⏳ Parsing…"
            : resumeText ? `✓ ${fileName.length>22 ? fileName.slice(0,22)+"…" : fileName}`
            : "📄 Upload Resume"}
        </button>
        {resumeText&&!uploading&&(
          <button className="rm-btn rm-btn-ghost rm-btn-sm"
            style={{ color:theme.danger, borderColor:theme.danger+"33", flexShrink:0 }}
            onClick={()=>{
              setResumeText(""); setFileName("");
              api("/api/base-resume",{method:"POST",body:JSON.stringify({content:"",name:""})});
            }}>✕</button>
        )}

        {/* Filters */}
        <select value={ageFilter}  onChange={e=>setAgeFilter(e.target.value)}  style={selStyle}>
          <option value="">Any age</option>
          <option value="1d">Past 24h</option><option value="2d">2 days</option>
          <option value="3d">3 days</option><option value="1w">1 week</option>
          <option value="1m">1 month</option>
        </select>
        <select value={catFilter}  onChange={e=>setCatFilter(e.target.value)}  style={{...selStyle,maxWidth:150}}>
          <option value="">All categories</option>
          {categories.map(c=><option key={c} value={c}>{c}</option>)}
        </select>
        <select value={srcFilter}  onChange={e=>setSrcFilter(e.target.value)}  style={selStyle}>
          <option value="">All sources</option>
          {sources.map(s2=><option key={s2} value={s2}>{s2}</option>)}
        </select>
        <select value={typeFilter} onChange={e=>setTypeFilter(e.target.value)} style={selStyle}>
          <option value="">All types</option>
          <option>Remote</option><option>Hybrid</option><option>Onsite</option>
        </select>

        {/* Exp slider */}
        <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
          <span style={{ fontSize:10, color:theme.textMuted, whiteSpace:"nowrap" }}>Exp:</span>
          <input type="range" min={0} max={30} step={1}
            value={expFilter===""?15:Number(expFilter)}
            onChange={e=>setExpFilter(e.target.value)}
            style={{ width:80, accentColor:theme.accent }}
            title={expFilter===""?"Not filtering by experience":`${expFilter} yrs ±${Math.round(Math.sqrt(Number(expFilter)||1))}`}/>
          <span style={{ fontSize:10, color:theme.accent, fontWeight:700, minWidth:32, whiteSpace:"nowrap" }}>
            {expFilter===""?"Any":`${expFilter}y ±${Math.round(Math.sqrt(Number(expFilter)||1))}`}
          </span>
          {expFilter!==""&&(
            <button onClick={()=>setExpFilter("")}
              style={{ background:"none", border:"none", color:theme.textMuted, cursor:"pointer", fontSize:11, padding:0 }}>✕</button>
          )}
        </div>

        <div style={{ flex:1 }}/>

        {/* Status chips */}
        {cacheInfo&&(
          <span style={{ fontSize:10, color:theme.textMuted, whiteSpace:"nowrap" }}>
            {timeLeft(cacheInfo.expiresIn)}
          </span>
        )}
        {quota&&(
          <span style={{ fontSize:10, color:quota.remaining===0?theme.danger:theme.warning,
                         fontWeight:700, whiteSpace:"nowrap" }}>
            {quota.remaining} refresh{quota.remaining!==1?"es":""} left
          </span>
        )}
        <span style={{ fontSize:10, color:theme.textDim, whiteSpace:"nowrap" }}>
          {filtered.length}/{jobs.length}
        </span>
      </div>

      {/* ── Three-column body ── */}
      <div style={{ flex:1, display:"flex", overflow:"hidden" }}>

        {/* LEFT — job cards */}
        <div style={{ display:"flex", flexDirection:"column", minWidth:0,
                      transition:"flex 0.2s",
                      flex:sandboxOpen?"0 0 36%":"0 0 58%",
                      borderRight:`1px solid ${theme.border}` }}>

          {jobs.length===0 && !scraping ? <EmptyState/> : (
            <div style={{ flex:1, overflowY:"auto", paddingTop:8, paddingBottom:8 }}>

              {/* Skeleton cards while scraping */}
              {scraping && Array.from({length:8},(_,i)=>(
                <div key={i} style={{ background:theme.surface, border:`1px solid ${theme.border}`,
                                      borderRadius:16, padding:"14px 18px", margin:"0 16px 8px",
                                      display:"flex", alignItems:"center", gap:14,
                                      animationDelay:`${i*0.1}s` }}>
                  <div className="rm-skeleton" style={{ width:40, height:40, borderRadius:"50%", flexShrink:0 }}/>
                  <div style={{ flex:1, display:"flex", flexDirection:"column", gap:8 }}>
                    <div className="rm-skeleton" style={{ height:14, width:"40%", animationDelay:`${i*0.1}s` }}/>
                    <div className="rm-skeleton" style={{ height:11, width:"60%", animationDelay:`${i*0.1+0.05}s` }}/>
                    <div className="rm-skeleton" style={{ height:10, width:"30%", animationDelay:`${i*0.1+0.1}s` }}/>
                  </div>
                </div>
              ))}

              {/* Job cards */}
              {!scraping && filtered.map((job) => {
                const key=job.jobId, g=generated[key], done=!!g?.html, st=loading[key];
                return (
                  <div key={key}
                    onClick={() => {
                      if (done && g.html !== "__exists__") {
                        setSandbox({...g,company:g.company||job.company,title:g.title||job.title});
                        setSandboxOpen(true);
                        setActiveAts({score:g.atsScore,report:g.atsReport,company:job.company,title:job.title});
                        setRightTab("ats");
                      } else if (job.url) {
                        setApplyJob(job);
                      }
                    }}
                    style={{
                      background: theme.surface,
                      border: `1px solid ${theme.border}`,
                      borderRadius: 16, padding:"14px 18px",
                      margin:"0 16px 8px",
                      display:"flex", alignItems:"center", gap:14,
                      cursor:"pointer",
                      transition:"all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)",
                      position:"relative",
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.transform = "translateY(-2px) scale(1.005)";
                      e.currentTarget.style.boxShadow = theme.shadowLg;
                      e.currentTarget.style.borderColor = theme.borderStrong;
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.transform = "translateY(0) scale(1)";
                      e.currentTarget.style.boxShadow = "none";
                      e.currentTarget.style.borderColor = theme.border;
                    }}>

                    {/* Company avatar */}
                    <div style={{
                      width:40, height:40, borderRadius:"50%",
                      background: companyColor(job.company),
                      display:"flex", alignItems:"center", justifyContent:"center",
                      fontWeight:800, fontSize:14, color:"white",
                      flexShrink:0, letterSpacing:"-0.5px",
                    }}>
                      {job.company.slice(0,2).toUpperCase()}
                    </div>

                    {/* Center info */}
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
                        {job.url ? (
                          <a href={job.url} target="_blank" rel="noreferrer"
                            onClick={e=>e.stopPropagation()}
                            style={{ fontWeight:700, fontSize:14, color:theme.text,
                                     overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                                     textDecoration:"none", maxWidth:200 }}>
                            {job.company}
                          </a>
                        ) : (
                          <span style={{ fontWeight:700, fontSize:14, color:theme.text,
                                         overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                            {job.company}
                          </span>
                        )}
                        <AppliedFlag applied={job.alreadyApplied} companyBefore={job.companyAppliedBefore}/>
                      </div>
                      <div style={{ fontSize:12, color:theme.textMuted, marginBottom:6,
                                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                        {job.title}
                      </div>
                      <div style={{ display:"flex", alignItems:"center", gap:5, flexWrap:"wrap" }}>
                        <WorkBadge t={job.workType}/>
                        <SrcBadge s={job.source}/>
                        {job.category && (
                          <span className="rm-badge" style={{ background:theme.accentMuted, color:theme.accentText }}>
                            {(job.category||"").split(" / ")[0]}
                          </span>
                        )}
                        {job.location && (
                          <span style={{ fontSize:10, color:theme.textDim }}>{job.location}</span>
                        )}
                      </div>
                    </div>

                    {/* Right side */}
                    <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
                      <span style={{ fontSize:11, color:theme.success, fontWeight:600 }}>{ago(job.postedAt)}</span>
                      {g?.atsScore != null && <ATSBadge score={g.atsScore}/>}
                      {/* Generate / Regen */}
                      {applyMode !== "SIMPLE" && (
                        <IconBtn bg={theme.accent} title={done ? "Regenerate" : "Generate resume"}
                          disabled={!!st}
                          onClick={e => { e.stopPropagation(); generate(job, done && g.html !== "__exists__"); }}>
                          {st ? "⏳" : done ? "↻" : "✦"}
                        </IconBtn>
                      )}
                      {/* Sandbox view */}
                      {done && g.html !== "__exists__" && (
                        <IconBtn bg={theme.info} title="View in sandbox"
                          onClick={e => {
                            e.stopPropagation();
                            setSandbox({...g,company:g.company||job.company,title:g.title||job.title});
                            setSandboxOpen(true);
                            setActiveAts({score:g.atsScore,report:g.atsReport,company:job.company,title:job.title});
                            setRightTab("ats");
                          }}>
                          👁
                        </IconBtn>
                      )}
                      {/* PDF */}
                      {done && g.html !== "__exists__" && (
                        <IconBtn bg={theme.success} title="Export PDF"
                          onClick={e => { e.stopPropagation(); exportAndTrack(job,g.html,job.company); }}>
                          📥
                        </IconBtn>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* CENTRE — Sandbox */}
        {sandboxOpen && (
          <div style={{ display:"flex", flexDirection:"column", minWidth:0, flex:1,
                        transition:"flex 0.2s",
                        borderRight:`1px solid ${theme.border}` }}>
            <SandboxPanel entry={sandbox} onClose={()=>setSandboxOpen(false)}
              onSave={saveSandboxHtml} onExport={exportAndTrack}/>
          </div>
        )}

        {/* RIGHT — ATS + History */}
        <div style={{ display:"flex", flexDirection:"column", minWidth:0, transition:"flex 0.2s",
                      flex:sandboxOpen?"0 0 22%":"0 0 42%" }}>
          {/* Tabs */}
          <div style={{ display:"flex", borderBottom:`1px solid ${theme.border}`,
                        padding:"0 14px", flexShrink:0 }}>
            {[
              ["ats", "ATS Report"],
              ["history", `History${genCount>0?` (${genCount})`:""}`],
            ].map(([id,lbl]) => (
              <button key={id} onClick={()=>setRightTab(id)}
                style={{ padding:"10px 16px", border:"none", background:"transparent",
                         fontWeight: rightTab===id ? 700 : 500, fontSize:12,
                         color: rightTab===id ? theme.accent : theme.textMuted,
                         cursor:"pointer", position:"relative",
                         transition:"color 0.15s" }}>
                {lbl}
                {rightTab===id && (
                  <motion.div layoutId="right-tab-underline"
                    style={{ position:"absolute", bottom:-1, left:0, right:0,
                             height:2, background:theme.accent, borderRadius:999 }}/>
                )}
              </button>
            ))}
          </div>
          <div style={{ flex:1, overflowY:"auto" }}>
            {rightTab==="ats" && <ATSPanel report={activeAts?.report} score={activeAts?.score}/>}
            {rightTab==="history" && (
              <HistoryList generated={generated}
                onOpen={e=>{
                  setSandbox(e); setSandboxOpen(true);
                  setActiveAts({score:e.atsScore,report:e.atsReport,company:e.company,title:e.title||e.role});
                  setRightTab("ats");
                }}
                onExport={exportAndTrack}/>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  const { theme } = useTheme();
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center",
                  justifyContent:"center", color:theme.textDim, gap:16, padding:40 }}>
      <div style={{ fontSize:56 }}>🔍</div>
      <div style={{ fontWeight:800, color:theme.textMuted, fontSize:16 }}>Search for a role above</div>
      <div style={{ fontSize:12, textAlign:"center", color:theme.textDim,
                    maxWidth:320, lineHeight:1.8 }}>
        LinkedIn + Indeed · full-time only · deduplicated · ghost jobs filtered
      </div>
    </div>
  );
}

function HistoryList({ generated, onOpen, onExport }) {
  const { theme } = useTheme();
  const entries = Object.entries(generated).filter(([,v])=>v?.html&&v.html!=="__exists__");
  if (!entries.length) return (
    <div style={{ padding:24, color:theme.textDim, fontSize:12, textAlign:"center" }}>
      No resumes generated yet.
    </div>
  );
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
      {entries.map(([jid,v]) => (
        <div key={jid} style={{ padding:"12px 16px", borderBottom:`1px solid ${theme.border}`,
                                 display:"flex", alignItems:"center", gap:10 }}>
          <div style={{
            width:32, height:32, borderRadius:"50%",
            background: companyColor(v.company||""),
            display:"flex", alignItems:"center", justifyContent:"center",
            fontWeight:800, fontSize:11, color:"white", flexShrink:0,
          }}>
            {(v.company||"?").slice(0,2).toUpperCase()}
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontWeight:700, fontSize:12, color:theme.text,
                          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {v.company}
            </div>
            <div style={{ fontSize:10, color:theme.textMuted, overflow:"hidden",
                          textOverflow:"ellipsis", whiteSpace:"nowrap", marginBottom:3 }}>
              {v.title||v.role}
            </div>
            <ATSBadge score={v.atsScore}/>
          </div>
          <div style={{ display:"flex", gap:5, flexShrink:0 }}>
            <IconBtn bg={theme.info} size={26} title="Open in sandbox" onClick={()=>onOpen(v)}>👁</IconBtn>
            <IconBtn bg={theme.success} size={26} title="Export PDF" onClick={()=>onExport(null,v.html,v.company)}>📥</IconBtn>
          </div>
        </div>
      ))}
    </div>
  );
}
