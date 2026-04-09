// client/src/panels/JobsPanel.jsx (shadcn UI integrated)
import { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api, saveWithPicker } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";
import SandboxPanel from "./SandboxPanel.jsx";
import { ATSPanel } from "./ATSPanel.jsx";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";
import { ScrollArea } from "../components/ui/scroll-area";
import { Button } from "../components/ui/button";
import { CTAButton } from "../components/CTAButton";
import { MetaChips } from "../components/MetaChips";

// ── Helpers ───────────────────────────────────────────────────
function hexToRgb(hex) {
  const h = hex.replace("#","");
  const n = parseInt(h.length===3 ? h.split("").map(c=>c+c).join("") : h, 16);
  return `${(n>>16)&255},${(n>>8)&255},${n&255}`;
}

// ── Badges ────────────────────────────────────────────────────
const Chip = ({ label, bg, fg }) => (
  <span style={{ background:bg, color:fg, padding:"3px 10px", borderRadius:"999px",
                 fontSize:9, fontWeight:700, whiteSpace:"nowrap" }}>
    {label}
  </span>
);

function WorkBadge({ t }) {
  const { theme } = useTheme();
  const bg = t==="Remote" ? `rgba(${hexToRgb(theme.colorPrimary)},0.15)`
           : t==="Hybrid"  ? `rgba(${hexToRgb(theme.colorAccent)},0.15)`
           : t==="Onsite"  ? `rgba(${hexToRgb(theme.colorSecondary)},0.15)`
           : "rgba(255,255,255,0.06)";
  const fg = t==="Remote" ? theme.colorPrimary
           : t==="Hybrid"  ? theme.colorAccent
           : t==="Onsite"  ? theme.colorSecondary
           : theme.colorMuted;
  return <Chip label={t||"—"} bg={bg} fg={fg}/>;
}

function SrcBadge({ s }) {
  const { theme } = useTheme();
  const bg = s==="LinkedIn" ? "rgba(59,130,246,0.15)"
           : s==="Indeed"   ? "rgba(234,179,8,0.15)"
           : "rgba(255,255,255,0.06)";
  const fg = s==="LinkedIn" ? "#60a5fa"
           : s==="Indeed"   ? "#eab308"
           : theme.colorMuted;
  return <Chip label={s} bg={bg} fg={fg}/>;
}

const ATSBadge = ({ score }) => {
  if (score==null) return null;
  const bg = score>=80?"#dcfce7":score>=60?"#fef9c3":"#fee2e2";
  const fg = score>=80?"#166534":score>=60?"#854d0e":"#991b1b";
  return <Chip label={`ATS ${score}`} bg={bg} fg={fg}/>;
};

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

const AppliedFlag = ({ applied, companyBefore }) => applied
  ? <span title="Already applied to this job" style={{ fontSize:11 }}>🚩</span>
  : companyBefore ? <span title="Applied to this company before" style={{ fontSize:11, opacity:.5 }}>🏳</span>
  : null;

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

// ── RotatingBadge — spinning SVG text for fresh jobs ─────────
function RotatingBadge() {
  const { theme } = useTheme();
  return (
    <svg width={40} height={40} viewBox="0 0 40 40" style={{ display:"block", flexShrink:0 }}>
      <defs>
        <path id="rbp-circle" d="M 20,20 m -14,0 a 14,14 0 1,1 28,0 a 14,14 0 1,1 -28,0"/>
      </defs>
      <g style={{ animation:"spin 20s linear infinite", transformOrigin:"20px 20px" }}>
        <text style={{ fontSize:6, fontWeight:700, fill:theme.colorPrimary, letterSpacing:"0.05em" }}>
          <textPath href="#rbp-circle">NEW · NEW · NEW · </textPath>
        </text>
      </g>
    </svg>
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
        style={{ background:theme.gradPanel, borderRadius:16,
                 padding:24, width:"100%", maxWidth:420,
                 maxHeight:"calc(100vh - 32px)", overflowY:"auto",
                 boxShadow:"0 25px 60px rgba(0,0,0,.6)",
                 border:`1px solid ${theme.colorBorder}` }}>
        <div style={{ display:"flex", justifyContent:"space-between",
                      alignItems:"flex-start", marginBottom:14 }}>
          <div>
            <div style={{ fontWeight:800, fontSize:15, color:theme.colorPrimary,
                          wordBreak:"break-word" }}>{job.company}</div>
            <div style={{ fontSize:12, color:theme.colorMuted, marginTop:3,
                          wordBreak:"break-word" }}>{job.title}</div>
          </div>
          <button onClick={onClose}
            style={{ background:"transparent", border:"none",
                     color:theme.colorMuted, cursor:"pointer",
                     fontSize:16, padding:4, flexShrink:0 }}>✕</button>
        </div>
        <div style={{ fontSize:11, color:theme.colorMuted, lineHeight:1.7, marginBottom:18,
                      background:"rgba(0,0,0,0.3)", padding:"10px 12px", borderRadius:7 }}>
          The job portal will open in a new tab. The Chrome extension will autofill your profile.
          If you haven't installed it yet, use the bookmarklet from the extension popup.
        </div>
        <div style={{ display:"flex", justifyContent:"flex-end" }}>
          <a href={job.url} target="_blank" rel="noreferrer"
            style={{ background:theme.gradAccent, color:"#000", padding:"9px 20px",
                     borderRadius:7, textDecoration:"none", fontWeight:700,
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
  const { theme } = useTheme();

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

  const fileRef = useRef();
  const mode    = user?.applyMode || "TAILORED";

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
  const handleSearch = useCallback(async () => {
    if (!resumeText) {
      alert("Please upload your base resume first. It is required for job search and resume generation.");
      fileRef.current?.click();
      return;
    }
    const q=searchInput.trim(); if(!q) return;
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
    if (mode==="SIMPLE") { alert("Generation is disabled in Simple Apply mode."); return; }
    if (!resumeText)     { alert("Upload your base resume first."); return; }
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
  },[resumeText,generated,mode]);

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
        applyMode:mode,resumeFile:savedPath,
      })}).catch(()=>{});
      const params=`query=${encodeURIComponent(searchInput)}&ageFilter=${ageFilter}&hideGhost=true&hideFlag=true`;
      const jr=await api(`/api/jobs?${params}`); setJobs(jr.jobs||[]);
    }
  },[mode,searchInput,ageFilter]);

  // ── Derived values — all declared before JSX ─────────────────
  const sources  = [...new Set(jobs.map(j=>j.source).filter(Boolean))];
  // Square root tolerance: user sets N years → tolerance = round(sqrt(N))
  // If no expFilter set, fall back to base resume years if available, else show all
  const expYears = expFilter !== "" ? Number(expFilter) : null;
  const expTolerance = expYears !== null ? Math.round(Math.sqrt(expYears || 1)) : null;

  const filtered = jobs.filter(j => {
    if (!typeFilter || j.workType === typeFilter) {} else return false;
    if (!catFilter  || j.category === catFilter)  {} else return false;
    if (!srcFilter  || j.source === srcFilter)    {} else return false;
    // Experience filter — only applied when slider is set
    if (expYears !== null && expTolerance !== null) {
      const jExp = j.yearsExperience;
      if (jExp != null) {
        if (jExp < expYears - expTolerance || jExp > expYears + expTolerance) return false;
      }
      // If job has no yearsExperience field, let it through (don't filter out unknowns)
    }
    return true;
  });
  const genCount = Object.values(generated).filter(v=>v?.html&&v.html!=="__exists__").length;

  const normalisedPreview = ALIASES[searchInput.trim().toLowerCase()]
    || (searchInput.trim() ? searchInput.trim().replace(/\b\w/g,c=>c.toUpperCase()) : "");
  const showPreview = !!(normalisedPreview &&
    normalisedPreview.toLowerCase() !== searchInput.trim().toLowerCase());

  // Inline styles using theme
  const selStyle = {
    padding:"4px 7px", borderRadius:"10px", height:"34px",
    border:`1px solid ${theme.colorBorder}`,
    background:theme.colorSurface, color:theme.colorText,
    fontSize:11, maxWidth:145, flex:"0 0 auto", outline:"none",
  };

  // ── Render ───────────────────────────────────────────────────
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden",
                  background:theme.gradBg }}>

      <AnimatePresence>
        {applyJob && <ApplyPopup job={applyJob} onClose={()=>setApplyJob(null)}/>}
      </AnimatePresence>

      {/* Filter bar */}
      <div style={{ background:theme.gradPanel, padding:"8px 14px",
                    display:"flex", alignItems:"center", gap:8, flexShrink:0,
                    borderBottom:`1px solid ${theme.colorBorder}`,
                    flexWrap:"wrap", minHeight:44 }}>

        <div style={{ position:"relative", flex:"1 1 160px", minWidth:120 }}>
          <input value={searchInput} onChange={e=>setSearchInput(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&handleSearch()}
            placeholder="Search role — e.g. ML Engineer, SWE, Data Scientist…"
            style={{ flex:"1 1 160px", minWidth:120, padding:"5px 14px", borderRadius:"12px", height:"36px",
                     border:`1px solid ${theme.colorBorder}`, background:theme.colorSurface,
                     color:theme.colorText, fontSize:11, outline:"none", width:"100%" }}/>
          {showPreview && (
            <div style={{ position:"absolute", top:"100%", left:0, marginTop:3,
              fontSize:10, color:theme.colorMuted,
              background:theme.gradPanel, border:`1px solid ${theme.colorBorder}`,
              borderRadius:5, padding:"3px 8px",
              whiteSpace:"nowrap", zIndex:10 }}>
              Will search as: <span style={{ color:theme.colorPrimary, fontWeight:700 }}>{normalisedPreview}</span>
            </div>
          )}
        </div>

        <Btn bg={scraping ? theme.colorDim : !resumeText ? theme.colorMuted : theme.colorPrimary}
          disabled={scraping} onClick={handleSearch}
          title={!resumeText?"Upload your resume first to enable search":""}>
          {scraping?"⏳ Scraping…":"🔍 Search"}
        </Btn>

        <div style={{ width:1, height:18, background:theme.colorBorder, flexShrink:0 }}/>

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

        <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
          <span style={{ fontSize:10, color:theme.colorMuted, whiteSpace:"nowrap" }}>Exp:</span>
          <input
            type="range" min={0} max={30} step={1}
            value={expFilter===""?15:Number(expFilter)}
            onChange={e=>setExpFilter(e.target.value)}
            style={{ width:80, accentColor:theme.colorPrimary }}
            title={expFilter===""?"Not filtering by experience":`${expFilter} yrs ±${Math.round(Math.sqrt(Number(expFilter)||1))}`}
          />
          <span style={{ fontSize:10, color:theme.colorPrimary, fontWeight:700,
                         minWidth:32, whiteSpace:"nowrap" }}>
            {expFilter===""?"Any":`${expFilter}y ±${Math.round(Math.sqrt(Number(expFilter)||1))}`}
          </span>
          {expFilter!==""&&(
            <button onClick={()=>setExpFilter("")}
              style={{ background:"none", border:"none", color:theme.colorMuted,
                       cursor:"pointer", fontSize:11, padding:0 }}>✕</button>
          )}
        </div>

        <div style={{ flex:1 }}/>

        <input ref={fileRef} type="file" accept=".txt,.html,.md,.docx,.pdf"
          onChange={handleFile} style={{ display:"none" }}/>
        <Btn bg={resumeText?"#10b981":uploading?"#f59e0b":theme.colorPrimary}
          onClick={()=>!uploading&&fileRef.current.click()}>
          {uploading?"⏳ Parsing…":resumeText?`✓ ${fileName.length>22?fileName.slice(0,22)+"…":fileName}`:"📄 Upload Resume"}
        </Btn>
        {resumeText&&!uploading&&(
          <Btn bg="#ef4444" onClick={()=>{
            setResumeText(""); setFileName("");
            api("/api/base-resume",{method:"POST",body:JSON.stringify({content:"",name:""})});
          }}>✕</Btn>
        )}
        {cacheInfo&&(
          <span style={{ fontSize:10, color:theme.colorMuted, whiteSpace:"nowrap" }}>
            {timeLeft(cacheInfo.expiresIn)}
          </span>
        )}
        {quota&&(
          <span style={{ fontSize:10, color:quota.remaining===0?"#ef4444":"#f59e0b",
                         fontWeight:700, whiteSpace:"nowrap" }}>
            {quota.remaining} refresh{quota.remaining!==1?"es":""} left today
          </span>
        )}
        <span style={{ fontSize:10, color:theme.colorDim, whiteSpace:"nowrap" }}>
          {filtered.length}/{jobs.length}
        </span>
      </div>

      {/* Three-column body */}
      <div style={{ flex:1, display:"flex", overflow:"hidden" }}>

        {/* LEFT — job table */}
        <div style={{ display:"flex", flexDirection:"column", minWidth:0,
                      transition:"flex 0.2s",
                      flex:sandboxOpen?"0 0 36%":"0 0 58%",
                      borderRight:`1px solid ${theme.colorBorder}` }}>
          {jobs.length===0 ? <EmptyState/> : (
            <div style={{ flex:1, overflowY:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse" }}>
                <thead>
                  <tr style={{ background:`rgba(0,0,0,0.4)`, position:"sticky", top:0, zIndex:5 }}>
                    {["Company","Role","Cat","Src","Type","Loc","Age",""].map(h=>(
                      <th key={h} style={{ padding:"8px 10px", textAlign:"left",
                                          fontSize:10, fontWeight:700,
                                          color:theme.colorMuted, whiteSpace:"nowrap",
                                          borderBottom:`1px solid ${theme.colorBorder}`,
                                          textTransform:"uppercase", letterSpacing:"0.08em" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {/* Skeleton shimmer while scraping */}
                  {scraping && Array.from({length:8}).map((_,i)=>(
                    <tr key={`sk-${i}`} style={{ borderBottom:`1px solid ${theme.colorBorder}` }}>
                      {[160,120,60,60,70,80,40,80].map((w,ci)=>(
                        <td key={ci} style={{ padding:"8px 8px" }}>
                          <div style={{
                            height:12, width:w, borderRadius:4,
                            background:`linear-gradient(90deg, ${theme.shimmer1} 25%, ${theme.shimmer2} 50%, ${theme.shimmer1} 75%)`,
                            backgroundSize:"200% 100%",
                            animation:"shimmer 1.4s ease infinite",
                            animationDelay:`${i*0.1}s`,
                          }}/>
                        </td>
                      ))}
                    </tr>
                  ))}

                  {!scraping && filtered.map((job,i)=>{
                    const key=job.jobId, g=generated[key], done=!!g?.html, st=loading[key];
                    const isNew = job.postedAt && Date.now()-new Date(job.postedAt).getTime() < 2*3600000;
                    return (
                      <tr key={key}
                        style={{ background:i%2===0 ? theme.gradPanel : "rgba(0,0,0,0.2)",
                                 borderBottom:`1px solid ${theme.colorBorder}`,
                                 transition:"background 0.15s" }}
                        onMouseEnter={e=>{ e.currentTarget.style.background=theme.gradHover; }}
                        onMouseLeave={e=>{ e.currentTarget.style.background=i%2===0?theme.gradPanel:"rgba(0,0,0,0.2)"; }}>

                        <td style={{ padding:"7px 10px", fontWeight:700, fontSize:11 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:3 }}>
                            {job.url
                              ? <a href={job.url} target="_blank" rel="noreferrer"
                                  style={{ background:"none", border:"none",
                                           color:theme.colorPrimary, fontWeight:700,
                                           fontSize:11, cursor:"pointer",
                                           padding:0, textAlign:"left", textDecoration:"none" }}>
                                  {job.company}
                                </a>
                              : <span style={{ color:theme.colorMuted, fontWeight:700, fontSize:11 }}>
                                  {job.company}
                                </span>
                            }
                            <AppliedFlag applied={job.alreadyApplied} companyBefore={job.companyAppliedBefore}/>
                          </div>
                        </td>

                        <td style={{ padding:"7px 10px", fontSize:10, color:theme.colorText,
                                     maxWidth:160, whiteSpace:"normal" }}>{job.title}</td>

                        <td style={{ padding:"5px 8px" }}>
                          <span style={{ background:`rgba(${hexToRgb(theme.colorPrimary)},0.12)`,
                                         color:theme.colorPrimary, padding:"2px 5px",
                                         borderRadius:6, fontSize:9, fontWeight:600,
                                         whiteSpace:"nowrap" }}>
                            {(job.category||"Other").split(" / ")[0]}
                          </span>
                        </td>

                        <td style={{ padding:"7px 10px" }}><SrcBadge s={job.source}/></td>
                        <td style={{ padding:"7px 10px" }}><WorkBadge t={job.workType}/></td>
                        <td style={{ padding:"7px 10px", fontSize:9, color:theme.colorDim, maxWidth:80 }}>{job.location}</td>

                        <td style={{ padding:"7px 10px", fontSize:9 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:3 }}>
                            {isNew && <RotatingBadge/>}
                            <span style={{ color:"#10b981", fontWeight:600 }}>{ago(job.postedAt)}</span>
                          </div>
                        </td>

                        <td style={{ padding:"7px 10px" }}>
                          <div style={{ display:"flex", gap:3, alignItems:"center" }}>
                            {mode!=="SIMPLE"&&(
                              st
                                ?<span style={{ fontSize:10, color:"#f59e0b" }}>⏳</span>
                                :<Btn sm bg={done?"#7c3aed":theme.colorPrimary}
                                    onClick={()=>generate(job,done)}
                                    title={done?"Regenerate":"Generate resume"}>
                                  {done?"↻":"✦"}
                                </Btn>
                            )}
                            {done&&!st&&(
                              <Btn sm bg="#0891b2" onClick={()=>{
                                const e=generated[key];
                                setSandbox({...e,company:job.company,title:job.title});
                                setSandboxOpen(true);
                                setActiveAts({score:e.atsScore,report:e.atsReport,
                                  company:job.company,title:job.title});
                                setRightTab("ats");
                              }} title="Open in sandbox">👁</Btn>
                            )}
                            {done&&!st&&(
                              <Btn sm bg="#10b981"
                                onClick={()=>exportAndTrack(job,generated[key].html,job.company)}
                                title="Export PDF">📥</Btn>
                            )}
                            {done&&<ATSBadge score={g.atsScore}/>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* CENTRE — Sandbox */}
        {sandboxOpen&&(
          <div style={{ display:"flex", flexDirection:"column", minWidth:0, flex:1,
                        transition:"flex 0.2s",
                        borderRight:`1px solid ${theme.colorBorder}` }}>
            <SandboxPanel entry={sandbox} onClose={()=>setSandboxOpen(false)}
              onSave={saveSandboxHtml} onExport={exportAndTrack}/>
          </div>
        )}

        {/* RIGHT — ATS + History */}
        <div style={{ display:"flex", flexDirection:"column", minWidth:0, transition:"flex 0.2s",
                      flex:sandboxOpen?"0 0 22%":"0 0 42%" }}>
          <div style={{ display:"flex", borderBottom:`1px solid ${theme.colorBorder}`,
                        flexShrink:0, background:`rgba(0,0,0,0.3)` }}>
            {[["ats","📊 ATS"],["history",`🕓 History${genCount>0?` (${genCount})`:""}`]].map(([id,lbl])=>(
              <button key={id}
                style={{ position:"relative", background:"transparent",
                         color:rightTab===id ? theme.colorPrimary : theme.colorMuted,
                         border:"none", padding:"6px 14px", cursor:"pointer",
                         fontSize:11, fontWeight:700, whiteSpace:"nowrap", overflow:"hidden" }}
                onClick={()=>setRightTab(id)}>
                {lbl}
                {rightTab===id && (
                  <motion.div layoutId="jobs-tab-indicator"
                    style={{ position:"absolute", bottom:0, left:"10%", right:"10%",
                             height:2, background:theme.colorPrimary, borderRadius:1 }}/>
                )}
              </button>
            ))}
          </div>
          <div style={{ flex:1, overflowY:"auto" }}>
            {rightTab==="ats"&&<ATSPanel report={activeAts?.report} score={activeAts?.score}/>}
            {rightTab==="history"&&(
              <HistoryList generated={generated}
                onOpen={e=>{setSandbox(e);setSandboxOpen(true);
                  setActiveAts({score:e.atsScore,report:e.atsReport,company:e.company,title:e.title||e.role});
                  setRightTab("ats");}}
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
                  justifyContent:"center", color:theme.colorDim, gap:12, padding:40 }}>
      <div style={{ fontSize:56 }}>🔍</div>
      <div style={{ fontWeight:800, color:theme.colorMuted, fontSize:16 }}>Search for a role above</div>
      <div style={{ fontSize:11, textAlign:"center", color:theme.colorDim,
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
    <div style={{ padding:24, color:theme.colorDim, fontSize:12, textAlign:"center" }}>
      No resumes generated yet.
    </div>
  );
  return entries.map(([jid,v])=>(
    <div key={jid} style={{ padding:"9px 12px", borderBottom:`1px solid ${theme.colorBorder}`,
                             display:"flex", alignItems:"center", gap:7 }}>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontWeight:700, fontSize:12, color:theme.colorText,
                      overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {v.company}
        </div>
        <div style={{ fontSize:10, color:theme.colorMuted, overflow:"hidden",
                      textOverflow:"ellipsis", whiteSpace:"nowrap", marginBottom:2 }}>
          {v.title||v.role}
        </div>
        <ATSBadge score={v.atsScore}/>
      </div>
      <Btn sm bg="#0891b2" onClick={()=>onOpen(v)}>👁</Btn>
      <Btn sm bg="#10b981" onClick={()=>onExport(null,v.html,v.company)}>📥</Btn>
    </div>
  ));
}

function Btn({ bg, disabled=false, sm=false, onClick, children, title }) {
  const { theme } = useTheme();
  const [hov, setHov] = useState(false);
  return (
    <button
      style={{ position:"relative", overflow:"hidden",
               background: disabled ? theme.colorDim : (hov ? "transparent" : bg),
               color: disabled ? theme.colorMuted : "#fff",
               border: `1px solid ${disabled ? theme.colorDim : bg}`,
               borderRadius: "999px",
               padding: sm ? "3px 7px" : "5px 11px",
               cursor: disabled ? "not-allowed" : "pointer",
               fontSize: sm ? 10 : 11, fontWeight: 700,
               whiteSpace: "nowrap", opacity: disabled ? 0.5 : 1,
               transition: "color 0.2s" }}
      disabled={disabled} onClick={onClick} title={title}
      onMouseEnter={()=>!disabled&&setHov(true)}
      onMouseLeave={()=>setHov(false)}>
      <span style={{
        position:"absolute", inset:0, background:bg,
        transform: hov&&!disabled ? "translateY(0)" : "translateY(100%)",
        transition: "transform 0.2s ease", zIndex:0,
      }}/>
      <span style={{ position:"relative", zIndex:1 }}>{children}</span>
    </button>
  );
}
