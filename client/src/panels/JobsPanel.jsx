// client/src/panels/JobsPanel.jsx
import { useState, useRef, useCallback, useEffect } from "react";
import { api, saveWithPicker } from "../lib/api.js";
import SandboxPanel from "./SandboxPanel.jsx";
import { ATSPanel } from "./ATSPanel.jsx";

// ── Badges ────────────────────────────────────────────────────
const WORK_CLR = { Remote:["#d1fae5","#065f46"], Hybrid:["#dbeafe","#1e3a8a"], Onsite:["#fef3c7","#92400e"] };
const SRC_CLR  = { LinkedIn:["#dbeafe","#1e40af"], Indeed:["#fef9c3","#92400e"] };
const Chip = ({label,bg,fg}) => (
  <span style={{background:bg,color:fg,padding:"2px 6px",borderRadius:8,fontSize:9,fontWeight:700,whiteSpace:"nowrap"}}>{label}</span>
);
const WorkBadge = ({t}) => { const [bg,fg]=WORK_CLR[t]||["#e5e7eb","#374151"]; return <Chip label={t||"—"} bg={bg} fg={fg}/>; };
const SrcBadge  = ({s}) => { const [bg,fg]=SRC_CLR[s] ||["#f1f5f9","#64748b"]; return <Chip label={s}     bg={bg} fg={fg}/>; };
const ATSBadge  = ({score}) => {
  if (score==null) return null;
  const bg=score>=80?"#dcfce7":score>=60?"#fef9c3":"#fee2e2";
  const fg=score>=80?"#166534":score>=60?"#854d0e":"#991b1b";
  return <Chip label={`ATS ${score}`} bg={bg} fg={fg}/>;
};

function ago(ts) {
  if (!ts) return "—";
  const d=Date.now()-new Date(ts).getTime();
  if(d<3600000)  return `${Math.floor(d/60000)}m`;
  if(d<86400000) return `${Math.floor(d/3600000)}h`;
  return `${Math.floor(d/86400000)}d`;
}
function timeLeft(ms) {
  if (!ms||ms<=0) return "cache expired";
  return `${Math.floor(ms/3600000)}h ${Math.floor((ms%3600000)/60000)}m`;
}

const AppliedFlag = ({applied,companyBefore}) => applied
  ? <span title="Already applied to this job" style={{fontSize:11}}>🚩</span>
  : companyBefore ? <span title="Applied to this company before" style={{fontSize:11,opacity:.5}}>🏳</span>
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

// ── Apply popup ───────────────────────────────────────────────
function ApplyPopup({ job, onClose }) {
  useEffect(() => {
    const h = e => { if (e.key==="Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div style={pp.overlay} onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div style={pp.modal}>
        <div style={pp.header}>
          <div>
            <div style={pp.company}>{job.company}</div>
            <div style={pp.role}>{job.title}</div>
          </div>
          <button onClick={onClose} style={pp.close}>✕</button>
        </div>
        <div style={pp.hint}>
          The job portal will open in a new tab. The Chrome extension will autofill your profile.
          If you haven't installed it yet, use the bookmarklet from the extension popup.
        </div>
        <div style={pp.actions}>
          <a href={job.url} target="_blank" rel="noreferrer"
            style={pp.applyBtn} onClick={onClose}>
            Open Application →
          </a>
        </div>
      </div>
    </div>
  );
}

const pp = {
  overlay: { position:"fixed", inset:0, background:"rgba(0,0,0,.7)",
             zIndex:1000, display:"flex", alignItems:"center",
             justifyContent:"center", padding:16 },
  modal:   { background:"#1e293b", borderRadius:12,
             padding:24, width:"100%", maxWidth:420,
             maxHeight:"calc(100vh - 32px)", overflowY:"auto",
             boxShadow:"0 25px 60px rgba(0,0,0,.6)",
             border:"1px solid #334155" },
  header:  { display:"flex", justifyContent:"space-between",
             alignItems:"flex-start", marginBottom:14 },
  company: { fontWeight:800, fontSize:15, color:"#38bdf8", wordBreak:"break-word" },
  role:    { fontSize:12, color:"#94a3b8", marginTop:3, wordBreak:"break-word" },
  close:   { background:"transparent", border:"none", color:"#64748b",
             cursor:"pointer", fontSize:16, padding:4, flexShrink:0 },
  hint:    { fontSize:11, color:"#64748b", lineHeight:1.7, marginBottom:18,
             background:"#0f172a", padding:"10px 12px", borderRadius:7 },
  actions: { display:"flex", justifyContent:"flex-end" },
  applyBtn:{ background:"#3b82f6", color:"#fff", padding:"9px 20px",
             borderRadius:7, textDecoration:"none", fontWeight:700,
             fontSize:13, display:"inline-block" },
};

// ── Main panel ────────────────────────────────────────────────
export default function JobsPanel({ user, onUserChange }) {
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
      // Reset the file input so the user can re-select the same file.
      // Without this, onChange never fires again after an error.
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
  const filtered = jobs.filter(j =>
    (!typeFilter||j.workType===typeFilter)&&
    (!catFilter ||j.category===catFilter)&&
    (!srcFilter ||j.source===srcFilter)
  );
  const genCount = Object.values(generated).filter(v=>v?.html&&v.html!=="__exists__").length;

  const normalisedPreview = ALIASES[searchInput.trim().toLowerCase()]
    || (searchInput.trim() ? searchInput.trim().replace(/\b\w/g,c=>c.toUpperCase()) : "");
  const showPreview = !!(normalisedPreview &&
    normalisedPreview.toLowerCase() !== searchInput.trim().toLowerCase());

  // ── Render ───────────────────────────────────────────────────
  return (
    <div style={s.root}>
      {applyJob && <ApplyPopup job={applyJob} onClose={()=>setApplyJob(null)}/>}

      {/* Filter bar */}
      <div style={s.bar}>
        <div style={{ position:"relative", flex:"1 1 160px", minWidth:120 }}>
          <input value={searchInput} onChange={e=>setSearchInput(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&handleSearch()}
            placeholder="Search role — e.g. ML Engineer, SWE, Data Scientist…"
            style={{...s.searchInp, width:"100%"}}/>
          {showPreview && (
            <div style={{ position:"absolute", top:"100%", left:0, marginTop:3,
              fontSize:10, color:"#64748b", background:"#0a0f1a",
              border:"1px solid #1e293b", borderRadius:5, padding:"3px 8px",
              whiteSpace:"nowrap", zIndex:10 }}>
              Will search as: <span style={{color:"#38bdf8",fontWeight:700}}>{normalisedPreview}</span>
            </div>
          )}
        </div>
        <Btn bg={scraping?"#475569":"#3b82f6"} disabled={scraping} onClick={handleSearch}>
          {scraping?"⏳ Scraping…":"🔍 Search"}
        </Btn>
        <div style={s.divider}/>
        <select value={ageFilter}  onChange={e=>setAgeFilter(e.target.value)}  style={s.sel}>
          <option value="">Any age</option>
          <option value="1d">Past 24h</option><option value="2d">2 days</option>
          <option value="3d">3 days</option><option value="1w">1 week</option>
          <option value="1m">1 month</option>
        </select>
        <select value={catFilter}  onChange={e=>setCatFilter(e.target.value)}  style={{...s.sel,maxWidth:150}}>
          <option value="">All categories</option>
          {categories.map(c=><option key={c} value={c}>{c}</option>)}
        </select>
        <select value={srcFilter}  onChange={e=>setSrcFilter(e.target.value)}  style={s.sel}>
          <option value="">All sources</option>
          {sources.map(s2=><option key={s2} value={s2}>{s2}</option>)}
        </select>
        <select value={typeFilter} onChange={e=>setTypeFilter(e.target.value)} style={s.sel}>
          <option value="">All types</option>
          <option>Remote</option><option>Hybrid</option><option>Onsite</option>
        </select>
        <div style={{flex:1}}/>
        <input ref={fileRef} type="file" accept=".txt,.html,.md,.docx,.pdf"
          onChange={handleFile} style={{display:"none"}}/>
        <Btn bg={resumeText?"#10b981":uploading?"#f59e0b":"#3b82f6"}
          onClick={()=>!uploading&&fileRef.current.click()}>
          {uploading?"⏳ Parsing…":resumeText?`✓ ${fileName.length>22?fileName.slice(0,22)+"…":fileName}`:"📄 Upload Resume"}
        </Btn>
        {resumeText&&!uploading&&(
          <Btn bg="#ef4444" onClick={()=>{
            setResumeText(""); setFileName("");
            api("/api/base-resume",{method:"POST",body:JSON.stringify({content:"",name:""})});
          }}>✕</Btn>
        )}
        {cacheInfo&&<span style={s.tag}>{timeLeft(cacheInfo.expiresIn)}</span>}
        {quota&&(
          <span style={{...s.tag,color:quota.remaining===0?"#ef4444":"#f59e0b",fontWeight:700}}>
            {quota.remaining} refresh{quota.remaining!==1?"es":""} left today
          </span>
        )}
        <span style={{...s.tag,color:"#334155"}}>{filtered.length}/{jobs.length}</span>
      </div>

      {/* Three-column body */}
      <div style={s.body}>
        {/* LEFT — job table */}
        <div style={{...s.col,flex:sandboxOpen?"0 0 36%":"0 0 58%",borderRight:"1px solid #1e293b"}}>
          {jobs.length===0 ? <EmptyState/> : (
            <div style={{flex:1,overflowY:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead>
                  <tr style={{background:"#0a0f1a",position:"sticky",top:0,zIndex:5}}>
                    {["Company","Role","Cat","Src","Type","Loc","Age",""].map(h=>(
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((job,i)=>{
                    const key=job.jobId,g=generated[key],done=!!g?.html,st=loading[key];
                    return (
                      <tr key={key} style={{background:i%2===0?"#0f172a":"#0a0f1a",borderBottom:"1px solid #1e293b"}}>
                        <td style={s.td}>
                          <div style={{display:"flex",alignItems:"center",gap:3}}>
                            <button onClick={()=>job.url&&setApplyJob(job)}
                              style={{background:"none",border:"none",color:"#38bdf8",
                                fontWeight:700,fontSize:11,cursor:job.url?"pointer":"default",
                                padding:0,textAlign:"left"}}>
                              {job.company}
                            </button>
                            <AppliedFlag applied={job.alreadyApplied} companyBefore={job.companyAppliedBefore}/>
                          </div>
                        </td>
                        <td style={{...s.td,fontSize:10,color:"#cbd5e1",maxWidth:160,whiteSpace:"normal"}}>{job.title}</td>
                        <td style={s.td}>
                          <span style={{background:"#1e1b4b",color:"#a5b4fc",padding:"2px 5px",
                            borderRadius:6,fontSize:9,fontWeight:600,whiteSpace:"nowrap"}}>
                            {(job.category||"Other").split(" / ")[0]}
                          </span>
                        </td>
                        <td style={s.td}><SrcBadge s={job.source}/></td>
                        <td style={s.td}><WorkBadge t={job.workType}/></td>
                        <td style={{...s.td,fontSize:9,color:"#475569",maxWidth:80}}>{job.location}</td>
                        <td style={{...s.td,fontSize:9,color:"#059669",fontWeight:600}}>{ago(job.postedAt)}</td>
                        <td style={s.td}>
                          <div style={{display:"flex",gap:3,alignItems:"center"}}>
                            {mode!=="SIMPLE"&&(
                              st
                                ?<span style={{fontSize:10,color:"#f59e0b"}}>⏳</span>
                                :<Btn sm bg={done?"#7c3aed":"#2563eb"} onClick={()=>generate(job,done)}
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
                            {job.url&&(
                              <Btn sm bg="#6366f1" onClick={()=>setApplyJob(job)} title="Apply">Apply</Btn>
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
          <div style={{...s.col,flex:1,borderRight:"1px solid #1e293b"}}>
            <SandboxPanel entry={sandbox} onClose={()=>setSandboxOpen(false)}
              onSave={saveSandboxHtml} onExport={exportAndTrack}/>
          </div>
        )}

        {/* RIGHT — ATS + History */}
        <div style={{...s.col,flex:sandboxOpen?"0 0 22%":"0 0 42%"}}>
          <div style={{display:"flex",borderBottom:"1px solid #1e293b",flexShrink:0,background:"#0a0f1a"}}>
            {[["ats","📊 ATS"],["history",`🕓 History${genCount>0?` (${genCount})`:""}`]].map(([id,lbl])=>(
              <button key={id} style={{background:"transparent",
                color:rightTab===id?"#38bdf8":"#64748b",border:"none",
                borderBottom:rightTab===id?"2px solid #38bdf8":"2px solid transparent",
                padding:"6px 14px",cursor:"pointer",fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}
                onClick={()=>setRightTab(id)}>{lbl}
              </button>
            ))}
          </div>
          <div style={{flex:1,overflowY:"auto"}}>
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
  return (
    <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",
      justifyContent:"center",color:"#334155",gap:12,padding:40}}>
      <div style={{fontSize:42}}>🔍</div>
      <div style={{fontWeight:700,color:"#475569",fontSize:14}}>Search for a role above</div>
      <div style={{fontSize:11,textAlign:"center",color:"#334155",maxWidth:320,lineHeight:1.8}}>
        LinkedIn + Indeed · full-time only · deduplicated · ghost jobs filtered
      </div>
    </div>
  );
}

function HistoryList({ generated, onOpen, onExport }) {
  const entries=Object.entries(generated).filter(([,v])=>v?.html&&v.html!=="__exists__");
  if (!entries.length) return (
    <div style={{padding:24,color:"#334155",fontSize:12,textAlign:"center"}}>No resumes generated yet.</div>
  );
  return entries.map(([jid,v])=>(
    <div key={jid} style={{padding:"9px 12px",borderBottom:"1px solid #1e293b",
      display:"flex",alignItems:"center",gap:7}}>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontWeight:700,fontSize:12,color:"#e2e8f0",overflow:"hidden",
          textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{v.company}</div>
        <div style={{fontSize:10,color:"#64748b",overflow:"hidden",
          textOverflow:"ellipsis",whiteSpace:"nowrap",marginBottom:2}}>{v.title||v.role}</div>
        <ATSBadge score={v.atsScore}/>
      </div>
      <Btn sm bg="#0891b2" onClick={()=>onOpen(v)}>👁</Btn>
      <Btn sm bg="#10b981" onClick={()=>onExport(null,v.html,v.company)}>📥</Btn>
    </div>
  ));
}

function Btn({bg,disabled=false,sm=false,onClick,children,title}) {
  return (
    <button style={{background:disabled?"#475569":bg,color:"#fff",border:"none",
      borderRadius:5,padding:sm?"3px 7px":"5px 11px",cursor:disabled?"not-allowed":"pointer",
      fontSize:sm?10:11,fontWeight:700,whiteSpace:"nowrap",opacity:disabled?0.5:1}}
      disabled={disabled} onClick={onClick} title={title}>{children}</button>
  );
}

const s = {
  root:      {flex:1,display:"flex",flexDirection:"column",overflow:"hidden"},
  bar:       {background:"#0a0f1a",padding:"6px 10px",display:"flex",alignItems:"center",
              gap:5,flexShrink:0,borderBottom:"1px solid #1e293b",flexWrap:"wrap",minHeight:44},
  searchInp: {flex:"1 1 160px",minWidth:120,padding:"5px 9px",borderRadius:5,
              border:"1px solid #1e293b",background:"#0f172a",color:"#f8fafc",
              fontSize:11,outline:"none"},
  sel:       {padding:"4px 7px",borderRadius:4,border:"1px solid #1e293b",
              background:"#0f172a",color:"#f8fafc",fontSize:11,maxWidth:145,flex:"0 0 auto"},
  divider:   {width:1,height:18,background:"#1e293b",flexShrink:0},
  tag:       {fontSize:10,color:"#475569",whiteSpace:"nowrap"},
  body:      {flex:1,display:"flex",overflow:"hidden"},
  col:       {display:"flex",flexDirection:"column",minWidth:0,transition:"flex 0.2s"},
  th:        {padding:"6px 8px",textAlign:"left",fontSize:10,fontWeight:700,
              color:"#475569",whiteSpace:"nowrap",borderBottom:"1px solid #1e293b"},
  td:        {padding:"5px 8px",fontWeight:700,fontSize:11},
};
