// client/src/panels/DatabasePanel.jsx — Design System v4
import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api }      from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";

// ── Calendar component ────────────────────────────────────────
const DAYS   = ["Su","Mo","Tu","We","Th","Fr","Sa"];
const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];

function Calendar({ value, onChange, onClose, theme }) {
  const today = new Date();
  const init  = value ? new Date(value) : today;
  const [view, setView] = useState({ year: init.getFullYear(), month: init.getMonth() });

  const selected = value ? new Date(value) : null;
  const firstDay = new Date(view.year, view.month, 1).getDay();
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
  const cells = Array(firstDay).fill(null).concat(
    Array.from({ length: daysInMonth }, (_, i) => i + 1)
  );
  while (cells.length % 7 !== 0) cells.push(null);

  const prev = () => setView(v => {
    const m = v.month === 0 ? 11 : v.month - 1;
    const y = v.month === 0 ? v.year - 1 : v.year;
    return { year: y, month: m };
  });
  const next = () => setView(v => {
    const m = v.month === 11 ? 0 : v.month + 1;
    const y = v.month === 11 ? v.year + 1 : v.year;
    return { year: y, month: m };
  });

  const pick = day => {
    if (!day) return;
    const d = new Date(view.year, view.month, day);
    onChange(d.toISOString().slice(0, 10));
    onClose();
  };

  const isSelected = day => {
    if (!day || !selected) return false;
    return selected.getFullYear() === view.year &&
           selected.getMonth()    === view.month &&
           selected.getDate()     === day;
  };
  const isToday = day => {
    if (!day) return false;
    return today.getFullYear() === view.year &&
           today.getMonth()    === view.month &&
           today.getDate()     === day;
  };

  return (
    <div style={{ background:theme.surface, border:`1px solid ${theme.border}`,
                  borderRadius:16, padding:16, width:260,
                  boxShadow:theme.shadowLg,
                  position:"absolute", zIndex:300,
                  top:"calc(100% + 6px)", left:0,
                  maxHeight:"320px", overflowY:"auto" }}>
      <div style={{ display:"flex", alignItems:"center",
                    justifyContent:"space-between", marginBottom:12 }}>
        <button style={{ background:"transparent",
                         border:`1px solid ${theme.border}`,
                         color:theme.textMuted, borderRadius:"999px", width:28, height:28,
                         cursor:"pointer", fontSize:16,
                         display:"flex", alignItems:"center", justifyContent:"center" }}
          onClick={prev}>‹</button>
        <span style={{ fontWeight:700, fontSize:13, color:theme.text }}>
          {MONTHS[view.month]} {view.year}
        </span>
        <button style={{ background:"transparent",
                         border:`1px solid ${theme.border}`,
                         color:theme.textMuted, borderRadius:"999px", width:28, height:28,
                         cursor:"pointer", fontSize:16,
                         display:"flex", alignItems:"center", justifyContent:"center" }}
          onClick={next}>›</button>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2 }}>
        {DAYS.map(d => (
          <div key={d} style={{ textAlign:"center", fontSize:9, fontWeight:700,
                                color:theme.textMuted, padding:"4px 0",
                                textTransform:"uppercase" }}>
            {d}
          </div>
        ))}
        {cells.map((day, i) => {
          const sel = isSelected(day);
          const tod = isToday(day);
          return (
            <div key={i}
              style={{
                textAlign:"center", fontSize:11, padding:"6px 2px", borderRadius:6,
                cursor:day ? "pointer" : "default", userSelect:"none",
                color:sel ? "#fff" : tod ? theme.accent : day ? theme.text : "transparent",
                background:sel ? theme.accent : "transparent",
                border:tod && !sel ? `1px solid ${theme.accent}` : "1px solid transparent",
                fontWeight:sel || tod ? 700 : 400,
                position:"relative",
              }}
              onClick={() => pick(day)}>
              {day || ""}
              {tod && !sel && (
                <span style={{ position:"absolute", bottom:1, left:"50%",
                               transform:"translateX(-50%)",
                               width:3, height:3, borderRadius:"50%",
                               background:theme.accent, display:"block" }}/>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", marginTop:10,
                    paddingTop:10, borderTop:`1px solid ${theme.border}` }}>
        <button style={{ background:"transparent", border:"none",
                         color:theme.textMuted, fontSize:10, cursor:"pointer", fontWeight:600 }}
          onClick={() => { onChange(""); onClose(); }}>Clear date</button>
        <button style={{ background:"transparent", border:"none",
                         color:theme.textMuted, fontSize:10, cursor:"pointer", fontWeight:600 }}
          onClick={() => { onChange(new Date().toISOString().slice(0,10)); onClose(); }}>
          Today
        </button>
      </div>
    </div>
  );
}

// ── Column definitions ─────────────────────────────────────────
const APP_COLS = [
  { key:"company",    label:"Company",      editable:true,  width:150, sortable:true  },
  { key:"role",       label:"Role",         editable:true,  width:190, sortable:true  },
  { key:"location",   label:"Location",     editable:true,  width:120, sortable:true  },
  { key:"source",     label:"Source",       editable:false, width:85,  sortable:true  },
  { key:"apply_mode", label:"Mode",         editable:false, width:105, sortable:true  },
  { key:"applied_at", label:"Date Applied", editable:true,  width:130, sortable:true, isDate:true },
  { key:"resume_file",label:"Resume File",  editable:false, width:200, sortable:false },
  { key:"job_url",    label:"Job URL",      editable:false, width:60,  sortable:false },
  { key:"notes",      label:"Notes",        editable:true,  width:180, sortable:false },
];

const RES_COLS = [
  { key:"company",    label:"Company",  editable:false, width:160, sortable:true  },
  { key:"role",       label:"Role",     editable:false, width:200, sortable:true  },
  { key:"category",   label:"Category", editable:false, width:155, sortable:true  },
  { key:"ats_score",  label:"ATS",      editable:false, width:60,  sortable:true  },
  { key:"apply_mode", label:"Mode",     editable:false, width:110, sortable:true  },
  { key:"updated_at", label:"Updated",  editable:false, width:100, sortable:true  },
];

function fmtDate(val) {
  if (!val) return "";
  if (typeof val === "number") return new Date(val * 1000).toLocaleDateString();
  if (typeof val === "string" && val.includes("-")) {
    const [y,m,d] = val.split("-");
    return `${m}/${d}/${y}`;
  }
  return val;
}

function isoToUnix(iso) {
  if (!iso) return null;
  return Math.floor(new Date(iso).getTime() / 1000);
}

function hexToRgb(hex) {
  const h = hex.replace("#","");
  const n = parseInt(h.length === 3
    ? h.split("").map(c => c+c).join("") : h, 16);
  return `${(n>>16)&255},${(n>>8)&255},${n&255}`;
}

// ── Main panel ────────────────────────────────────────────────
export function DatabasePanel({ user }) {
  const { theme, mode } = useTheme();
  const [activeSheet,  setActiveSheet]  = useState("applications");
  const [apps,         setApps]         = useState([]);
  const [resumes,      setResumes]      = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [saving,       setSaving]       = useState({});
  const [editCell,     setEditCell]     = useState(null);
  const [editVal,      setEditVal]      = useState("");
  const [calCell,      setCalCell]      = useState(null);
  const [flashRow,     setFlashRow]     = useState(null);
  const [search,       setSearch]       = useState("");
  const [sortCol,      setSortCol]      = useState("applied_at");
  const [sortDir,      setSortDir]      = useState("desc");
  const [filterDate,   setFilterDate]   = useState("");
  const [calFilter,    setCalFilter]    = useState(false);

  // ── Saved Jobs tab state ──────────────────────────────────────
  const [savedJobs,    setSavedJobs]    = useState([]);
  const [savedGen,     setSavedGen]     = useState({}); // jobId→{html,atsScore}
  const [baseResume,   setBaseResume]   = useState("");
  const [genLoading,   setGenLoading]   = useState({});

  const inputRef = useRef();
  const calRef   = useRef();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, r] = await Promise.all([api("/api/applications"), api("/api/resumes")]);
      setApps(a || []);
      setResumes((r || []).map(row => ({
        ...row,
        updated_at: row.updated_at ? new Date(row.updated_at * 1000).toLocaleDateString() : "",
      })));
    } catch(e) { alert("Failed to load: " + e.message); }
    finally { setLoading(false); }
  }, []);

  const loadSaved = useCallback(async () => {
    try {
      const [jr, rr, br] = await Promise.all([
        api("/api/jobs?starred=1&hideGhost=true&pageSize=100"),
        api("/api/resumes"),
        api("/api/base-resume"),
      ]);
      setSavedJobs(jr.jobs || []);
      if (br?.content) setBaseResume(br.content);
      if (rr?.length) {
        const map = {};
        rr.forEach(r => { map[r.job_id] = { html:"__exists__", atsScore:r.ats_score }; });
        setSavedGen(map);
      }
    } catch {}
  }, []);

  const generateForSaved = useCallback(async (job, force = false) => {
    const applyMode = user?.applyMode || "TAILORED";
    if (applyMode === "SIMPLE") { alert("Generation disabled in Simple mode."); return; }
    if (!baseResume) { alert("Upload your base resume in the Jobs tab first."); return; }
    setGenLoading(p => ({...p, [job.jobId]: true}));
    try {
      const d = await api("/api/generate", { method:"POST",
        body:JSON.stringify({ jobId:job.jobId, job, resumeText:baseResume, forceRegen:force }) });
      if (d.error) throw new Error(d.error);
      setSavedGen(p => ({...p, [job.jobId]:{ html:d.html, atsScore:d.atsScore }}));
    } catch(e) { alert("Generation failed: " + e.message); }
    setGenLoading(p => { const n={...p}; delete n[job.jobId]; return n; });
  }, [baseResume, user]);

  const exportSavedPdf = useCallback(async (job, html) => {
    const filename = `Resume_${(job.company||"").replace(/\s+/g,"_")}.pdf`;
    const r = await fetch("/api/export-pdf", { method:"POST", credentials:"include",
      headers:{"Content-Type":"application/json"}, body:JSON.stringify({ html, filename }) });
    if (!r.ok) { alert("PDF export failed"); return; }
    const blob = await r.blob();
    const u = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href:u, download:filename }).click();
    URL.revokeObjectURL(u);
    await api("/api/applications", { method:"POST", body:JSON.stringify({
      jobId:job.jobId, company:job.company, role:job.title,
      jobUrl:job.url, source:job.source, location:job.location,
      applyMode:user?.applyMode||"TAILORED", resumeFile:filename,
    }) }).catch(()=>{});
  }, [user]);

  const unsaveJob = useCallback(async (jobId) => {
    await api(`/api/jobs/${jobId}/starred`, { method:"PATCH" });
    setSavedJobs(prev => prev.filter(j => j.jobId !== jobId));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (activeSheet === "saved") loadSaved(); }, [activeSheet, loadSaved]);
  useEffect(() => { if (editCell && inputRef.current) inputRef.current.focus(); }, [editCell]);

  useEffect(() => {
    const h = e => {
      if (calRef.current && !calRef.current.contains(e.target)) {
        setCalCell(null); setCalFilter(false);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const toggleSort = key => {
    if (sortCol === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(key); setSortDir("asc"); }
  };

  const sortRows = rows => {
    if (!sortCol) return rows;
    return [...rows].sort((a, b) => {
      let va = a[sortCol] ?? "";
      let vb = b[sortCol] ?? "";
      if (typeof va === "number" && typeof vb === "number") {
        return sortDir === "asc" ? va - vb : vb - va;
      }
      va = String(va).toLowerCase();
      vb = String(vb).toLowerCase();
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ?  1 : -1;
      return 0;
    });
  };

  const filterRows = (rows, cols) => {
    let r = rows;
    if (search.trim()) {
      const q = search.toLowerCase();
      r = r.filter(row => cols.some(c => String(row[c.key]||"").toLowerCase().includes(q)));
    }
    if (filterDate && activeSheet === "applications") {
      r = r.filter(row => {
        const d = row.applied_at;
        if (!d) return false;
        const rowDate = typeof d === "number"
          ? new Date(d * 1000).toISOString().slice(0, 10)
          : (typeof d === "string" && d.length >= 10 ? d.slice(0, 10) : "");
        return rowDate === filterDate;
      });
    }
    return sortRows(r);
  };

  const startEdit = (rowId, col, currentVal) => {
    setEditCell({ rowId, col }); setEditVal(currentVal || "");
  };

  const commitEdit = async (row, newValue) => {
    const { rowId, col } = editCell || {};
    if (!rowId || !col) return;
    const val = newValue !== undefined ? newValue : editVal;
    setEditCell(null);
    const payload = col === "applied_at" && val
      ? { [col]: isoToUnix(val) }
      : { [col]: val };
    setApps(prev => prev.map(r => r.job_id === rowId
      ? { ...r, [col]: col === "applied_at" && val ? isoToUnix(val) : val }
      : r));
    setSaving(p => ({ ...p, [rowId]: true }));
    try {
      await api(`/api/applications/${encodeURIComponent(rowId)}`, {
        method:"PATCH", body:JSON.stringify(payload),
      });
    } catch(e) { alert("Save failed: " + e.message); load(); }
    setSaving(p => { const n={...p}; delete n[rowId]; return n; });
  };

  const cancelEdit = () => setEditCell(null);

  const handleDatePick = async (rowId, iso) => {
    setCalCell(null);
    const unix = iso ? isoToUnix(iso) : null;
    setApps(prev => prev.map(r => r.job_id === rowId ? { ...r, applied_at: unix } : r));
    setSaving(p => ({ ...p, [rowId]: true }));
    try {
      await api(`/api/applications/${encodeURIComponent(rowId)}`, {
        method:"PATCH", body:JSON.stringify({ applied_at: unix }),
      });
    } catch(e) { alert("Save failed: " + e.message); load(); }
    setSaving(p => { const n={...p}; delete n[rowId]; return n; });
  };

  const deleteApp = async jobId => {
    if (!confirm("Remove this application from tracking?")) return;
    await api(`/api/applications/${encodeURIComponent(jobId)}`, { method:"DELETE" });
    setApps(prev => prev.filter(r => r.job_id !== jobId));
  };
  const deleteResume = async jobId => {
    if (!confirm("Delete this resume and all its versions?")) return;
    await api(`/api/resumes/${encodeURIComponent(jobId)}`, { method:"DELETE" });
    setResumes(prev => prev.filter(r => r.job_id !== jobId));
  };

  const exportExcel = async () => {
    try {
      const r = await api("/api/export/excel");
      const b = await r.blob();
      const u = URL.createObjectURL(b);
      Object.assign(document.createElement("a"), {
        href: u,
        download:`ResuMaster_${user?.username}_${new Date().toISOString().slice(0,10)}.xlsx`,
      }).click();
      URL.revokeObjectURL(u);
    } catch(e) { alert("Export failed: " + e.message); }
  };

  const rows        = activeSheet === "applications" ? apps : resumes;
  const cols        = activeSheet === "applications" ? APP_COLS : RES_COLS;
  const isApps      = activeSheet === "applications";
  const displayRows = filterRows(rows, cols);

  const SHEETS = [["applications","Applications"],["resumes","Resumes"],["saved","Saved Jobs"]];

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column",
                  overflow:"hidden", background:theme.bg }}>

      {/* ── Header ── */}
      <div style={{
        background: mode==="light" ? "rgba(255,255,255,0.92)" : "rgba(17,17,17,0.92)",  /* intentional translucent surface */
        backdropFilter:"blur(16px)",
        borderBottom:`1px solid ${theme.border}`,
        display:"flex", alignItems:"stretch", flexShrink:0,
        padding:"0 14px",
      }}>
        {/* Tab switcher — underline style */}
        <div style={{ display:"flex" }}>
          {SHEETS.map(([id, lbl]) => (
            <button key={id}
              style={{ background:"transparent",
                       color: activeSheet===id ? theme.accent : theme.textMuted,
                       border:"none", padding:"12px 16px",
                       cursor:"pointer", fontSize:13,
                       fontWeight: activeSheet===id ? 700 : 500,
                       position:"relative", transition:"color 0.15s",
                       display:"flex", alignItems:"center", gap:8, whiteSpace:"nowrap" }}
              onClick={() => { setActiveSheet(id); setSearch(""); setFilterDate(""); }}>
              {lbl}
              <span style={{ background:activeSheet===id ? theme.accentMuted : theme.surfaceHigh,
                             color:activeSheet===id ? theme.accentText : theme.textMuted,
                             fontSize:10, fontWeight:700,
                             padding:"1px 7px", borderRadius:999 }}>
                {id === "applications" ? apps.length : id === "resumes" ? resumes.length : savedJobs.length}
              </span>
              {activeSheet===id && (
                <motion.div layoutId="db-tab-underline"
                  style={{ position:"absolute", bottom:0, left:0, right:0,
                           height:2, background:theme.accent, borderRadius:999 }}/>
              )}
            </button>
          ))}
        </div>
        <div style={{ flex:1 }}/>
        <div style={{ display:"flex", alignItems:"center", gap:8, paddingRight:4 }}>
          <button className="rm-btn rm-btn-ghost rm-btn-sm"
            onClick={load} disabled={loading}>
            {loading ? "⏳" : "↻"} Refresh
          </button>
          <button className="rm-btn rm-btn-primary rm-btn-sm" onClick={exportExcel}>
            📥 Export Excel
          </button>
        </div>
      </div>

      {/* ── Toolbar (hidden for saved tab — it has its own toolbar) ── */}
      {activeSheet !== "saved" && <div style={{ background:theme.surface, padding:"10px 16px",
                    display:"flex", alignItems:"center", gap:10,
                    borderBottom:`1px solid ${theme.border}`,
                    flexShrink:0, flexWrap:"wrap" }}>
        {/* Search */}
        <div style={{ position:"relative", display:"flex", alignItems:"center",
                      flex:"0 0 260px" }}>
          <span style={{ position:"absolute", left:12, fontSize:13,
                         pointerEvents:"none", color:theme.textDim }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === "Escape") setSearch(""); }}
            placeholder={`Search ${isApps ? "applications" : "resumes"}…`}
            className="rm-input"
            style={{ paddingLeft:36, borderRadius:999 }}/>
          {search && (
            <button style={{ position:"absolute", right:12, background:"transparent",
                             border:"none", color:theme.textMuted, cursor:"pointer",
                             fontSize:11 }}
              onClick={() => setSearch("")}>✕</button>
          )}
        </div>

        {isApps && (
          <div ref={calRef} style={{ position:"relative" }}>
            <button
              style={{ display:"flex", alignItems:"center", gap:6,
                       background:filterDate ? theme.accentMuted : theme.surfaceHigh,
                       color:filterDate ? theme.accentText : theme.textMuted,
                       border:`1px solid ${filterDate ? theme.accent+"44" : theme.border}`,
                       borderRadius:999, padding:"6px 14px", cursor:"pointer", fontSize:12,
                       fontWeight:600, whiteSpace:"nowrap" }}
              onClick={() => setCalFilter(o => !o)}>
              📅 {filterDate ? `Date: ${fmtDate(filterDate)}` : "Filter by date"}
              {filterDate && (
                <span style={{ marginLeft:4, color:theme.textMuted, fontWeight:700, fontSize:10 }}
                  onClick={e => { e.stopPropagation(); setFilterDate(""); }}>✕</span>
              )}
            </button>
            <AnimatePresence>
              {calFilter && (
                <motion.div key="cal-filter"
                  initial={{ opacity:0, scale:0.96, y:-4 }}
                  animate={{ opacity:1, scale:1, y:0 }}
                  exit={{ opacity:0, scale:0.96, y:-4 }}
                  transition={{ duration:0.15 }}>
                  <Calendar theme={theme}
                    value={filterDate}
                    onChange={setFilterDate}
                    onClose={() => setCalFilter(false)}/>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        <div style={{ flex:1 }}/>
        <span style={{ fontSize:11, color:theme.textMuted, whiteSpace:"nowrap" }}>
          {displayRows.length} of {rows.length} row{rows.length !== 1 ? "s" : ""}
        </span>
      </div>}

      {/* ── Saved Jobs pane (replaces table entirely when on saved tab) ── */}
      {activeSheet === "saved" && (
        <SavedJobsPane
          jobs={savedJobs} generated={savedGen} genLoading={genLoading}
          applyMode={user?.applyMode || "TAILORED"} hasResume={!!baseResume}
          theme={theme} mode={mode}
          onGenerate={(job, force) => generateForSaved(job, force)}
          onExport={(job, html) => exportSavedPdf(job, html)}
          onUnsave={unsaveJob}
          onRefresh={loadSaved}
        />
      )}

      {/* ── Table (applications / resumes) ── */}
      {activeSheet !== "saved" && loading ? (
        <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center",
                      color:theme.textMuted, fontSize:13 }}>
          Loading data…
        </div>
      ) : activeSheet !== "saved" && displayRows.length === 0 ? (
        <EmptyState sheet={activeSheet} hasFilter={!!(search || filterDate)} theme={theme}/>
      ) : activeSheet !== "saved" ? (
        <div style={{ flex:1, overflow:"auto" }}>
          <table style={{ borderCollapse:"collapse", width:"100%", tableLayout:"fixed" }}>
            <thead>
              <tr style={{ background:theme.surfaceHigh, borderBottom:`1px solid ${theme.border}`,
                           position:"sticky", top:0, zIndex:5 }}>
                <th style={{ padding:"10px 14px", textAlign:"left", fontSize:10,
                             fontWeight:700, color:theme.textDim,
                             textTransform:"uppercase", letterSpacing:"0.08em",
                             borderBottom:`1px solid ${theme.border}`,
                             whiteSpace:"nowrap", overflow:"hidden",
                             userSelect:"none", width:36 }}>#</th>
                {cols.map(c => (
                  <th key={c.key}
                    style={{ padding:"10px 14px", textAlign:"left", fontSize:10,
                             fontWeight:700, color:theme.textDim,
                             textTransform:"uppercase", letterSpacing:"0.08em",
                             borderBottom:`1px solid ${theme.border}`,
                             whiteSpace:"nowrap", overflow:"hidden",
                             userSelect:"none", width:c.width, minWidth:c.width,
                             cursor:c.sortable ? "pointer" : "default" }}
                    onClick={() => c.sortable && toggleSort(c.key)}>
                    <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                      {c.label}
                      {c.editable && <span style={{ fontSize:9, color:theme.textDim }}>✎</span>}
                      {c.sortable && (
                        <span style={{ fontSize:9,
                          color:sortCol===c.key ? theme.accent : theme.textDim }}>
                          {sortCol===c.key ? (sortDir==="asc" ? "▲" : "▼") : "⇅"}
                        </span>
                      )}
                    </div>
                  </th>
                ))}
                <th style={{ padding:"10px 14px", textAlign:"left", fontSize:10,
                             fontWeight:700, color:theme.textDim,
                             borderBottom:`1px solid ${theme.border}`,
                             width:50 }}/>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row, i) => {
                const rowId    = row.job_id;
                const isFlash  = flashRow === rowId;
                const isSaving = saving[rowId];
                return (
                  <tr key={rowId || i} id={`row-${rowId}`}
                    className="rm-table-row"
                    style={{
                      background:isFlash ? `${theme.accent}22` : "transparent",
                      borderBottom:`1px solid ${theme.border}`,
                      outline:isFlash ? `2px solid ${theme.accent}` : "none",
                    }}>
                    <td style={{ padding:"12px 14px", fontSize:11,
                                 color:theme.textDim, width:36 }}>{i+1}</td>

                    {cols.map(c => {
                      const isEditing = editCell?.rowId===rowId && editCell?.col===c.key;
                      const raw = row[c.key] ?? "";

                      if (c.isDate) {
                        const isoVal = typeof raw === "number"
                          ? new Date(raw*1000).toISOString().slice(0,10)
                          : (typeof raw === "string" && raw.length >= 10 ? raw.slice(0,10) : "");
                        const isCalOpen = calCell?.rowId === rowId;
                        return (
                          <td key={c.key} style={{ padding:"12px 14px", fontSize:12,
                                                   width:c.width, position:"relative",
                                                   color:theme.text }}>
                            <div ref={isCalOpen ? calRef : null} style={{ position:"relative" }}>
                              <button
                                style={{ background:"transparent",
                                         border:`1px ${isoVal ? "solid" : "dashed"} ${isoVal ? theme.accent+"66" : theme.border}`,
                                         borderRadius:8, color:isoVal ? theme.accent : theme.textDim,
                                         fontSize:11, padding:"3px 10px",
                                         cursor:"pointer", whiteSpace:"nowrap" }}
                                onClick={() => setCalCell(isCalOpen ? null : { rowId })}>
                                {isoVal ? fmtDate(isoVal) : (
                                  <span style={{ color:theme.textDim }}>+ Set date</span>
                                )}
                                {isSaving && <span style={{ color:theme.warning, marginLeft:4 }}>⏳</span>}
                              </button>
                              <AnimatePresence>
                                {isCalOpen && (
                                  <motion.div key="cal"
                                    initial={{ opacity:0, scale:0.96, y:-4 }}
                                    animate={{ opacity:1, scale:1, y:0 }}
                                    exit={{ opacity:0, scale:0.96, y:-4 }}
                                    transition={{ duration:0.15 }}>
                                    <Calendar theme={theme}
                                      value={isoVal}
                                      onChange={iso => handleDatePick(rowId, iso)}
                                      onClose={() => setCalCell(null)}/>
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </div>
                          </td>
                        );
                      }

                      if (c.key === "job_url") return (
                        <td key={c.key} style={{ padding:"12px 14px", fontSize:12,
                                                  width:c.width, color:theme.text }}>
                          {raw ? (
                            <a href={raw} target="_blank" rel="noreferrer"
                              style={{ color:theme.accent, fontSize:11,
                                       textDecoration:"none" }}>
                              ↗ Open
                            </a>
                          ) : "—"}
                        </td>
                      );

                      if (c.key === "ats_score") return (
                        <td key={c.key} style={{ padding:"12px 14px", fontSize:12,
                                                  width:c.width, color:theme.text }}>
                          {raw != null && raw !== "" ? (
                            <span className="rm-badge" style={{
                              background:raw>=80 ? theme.successMuted : raw>=60 ? theme.warningMuted : theme.dangerMuted,
                              color:raw>=80 ? theme.success : raw>=60 ? theme.warning : theme.danger,
                            }}>{raw}</span>
                          ) : "—"}
                        </td>
                      );

                      const display = c.key === "applied_at" ? fmtDate(raw) : raw;
                      return (
                        <td key={c.key}
                          style={{ padding:"12px 14px", fontSize:12,
                                   color:theme.text, width:c.width, maxWidth:c.width,
                                   overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                                   cursor:(c.editable && isApps) ? "pointer" : "default",
                                   background:isEditing ? theme.surfaceHigh : undefined }}
                          onClick={() => c.editable && !isEditing && isApps &&
                                        startEdit(rowId, c.key, raw)}>
                          {isEditing ? (
                            <input ref={inputRef} value={editVal}
                              onChange={e => setEditVal(e.target.value)}
                              onBlur={() => commitEdit(row)}
                              onKeyDown={e => {
                                if (e.key==="Enter")  commitEdit(row);
                                if (e.key==="Escape") cancelEdit();
                              }}
                              style={{ width:"100%", background:theme.surface,
                                       color:theme.text,
                                       border:`1px solid ${theme.accent}`,
                                       borderRadius:6, padding:"3px 8px",
                                       fontSize:12, outline:"none", boxSizing:"border-box" }}/>
                          ) : (
                            <span style={{ display:"block", overflow:"hidden",
                                           textOverflow:"ellipsis", whiteSpace:"nowrap" }}
                              title={String(display || "")}>
                              {display || <span style={{ color:theme.textDim }}>—</span>}
                              {isSaving && <span style={{ color:theme.warning, marginLeft:4 }}>⏳</span>}
                            </span>
                          )}
                        </td>
                      );
                    })}

                    <td style={{ padding:"12px 14px", fontSize:12,
                                 color:theme.text, width:50 }}>
                      <button style={{ background:"transparent", border:"none",
                                       color:theme.textDim, cursor:"pointer",
                                       fontSize:12, padding:"2px 6px", borderRadius:4,
                                       transition:"color 0.15s" }}
                        onMouseEnter={e => { e.currentTarget.style.color = theme.danger; }}
                        onMouseLeave={e => { e.currentTarget.style.color = theme.textDim; }}
                        onClick={() => isApps ? deleteApp(rowId) : deleteResume(rowId)}
                        title="Delete row">✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

// ── Saved Jobs pane ───────────────────────────────────────────
function SavedJobsPane({ jobs, generated, genLoading, applyMode, hasResume,
                          theme, mode, onGenerate, onExport, onUnsave, onRefresh }) {
  const USER_ACCENT = "#A8D8EA";

  if (jobs.length === 0) return (
    <div style={{ flex:1, display:"flex", flexDirection:"column",
                  alignItems:"center", justifyContent:"center", gap:12, padding:40 }}>
      <div style={{ fontSize:40 }}>★</div>
      <div style={{ fontWeight:700, color:theme.textMuted, fontSize:14 }}>No saved jobs yet</div>
      <div style={{ fontSize:12, color:theme.textDim, textAlign:"center", maxWidth:300, lineHeight:1.8 }}>
        Star jobs on the Jobs board to save them here. You can generate tailored resumes and export PDFs from this panel.
      </div>
      <button className="rm-btn rm-btn-secondary rm-btn-sm" onClick={onRefresh}>↻ Refresh</button>
    </div>
  );

  const thS = {
    padding:"10px 14px", textAlign:"left", fontSize:10, fontWeight:700,
    color:theme.textDim, textTransform:"uppercase", letterSpacing:"0.08em",
    borderBottom:`1px solid ${theme.border}`, whiteSpace:"nowrap",
    background:theme.surfaceHigh,
  };
  const tdS = { padding:"11px 14px", fontSize:12, color:theme.text, verticalAlign:"middle" };

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      {/* toolbar */}
      <div style={{ padding:"8px 16px", display:"flex", alignItems:"center", gap:8,
                    borderBottom:`1px solid ${theme.border}`, flexShrink:0,
                    background:theme.surface }}>
        <span style={{ fontSize:12, color:theme.textMuted }}>
          {jobs.length} saved job{jobs.length !== 1 ? "s" : ""}
        </span>
        {!hasResume && (
          <span style={{ fontSize:11, color:theme.warning, background:theme.warningMuted,
                         border:`1px solid ${theme.warning}33`, borderRadius:4,
                         padding:"2px 10px" }}>
            Upload base resume in Jobs tab to enable generation
          </span>
        )}
        <div style={{ flex:1 }}/>
        <button className="rm-btn rm-btn-ghost rm-btn-sm" onClick={onRefresh}>↻ Refresh</button>
      </div>

      {/* table */}
      <div style={{ flex:1, overflowY:"auto" }}>
        <table style={{ borderCollapse:"collapse", width:"100%", tableLayout:"fixed" }}>
          <thead>
            <tr style={{ position:"sticky", top:0, zIndex:5 }}>
              {["Company","Title","Location","Source","ATS","Actions"].map(h => (
                <th key={h} style={{ ...thS,
                  width: h==="Actions" ? 180 : h==="ATS" ? 60 : h==="Source" ? 90 : "auto" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {jobs.map(job => {
              const g = generated[job.jobId];
              const done = !!g?.html;
              const busy = !!genLoading[job.jobId];
              // Monogram colors
              const colors = ["#0A66C2","#7c3aed","#0891b2","#16a34a","#dc2626","#d97706"];
              let hash = 0;
              for (const c of job.company||"") hash = (hash*31+c.charCodeAt(0))&0xffff;
              const iconBg = colors[hash % colors.length];

              return (
                <tr key={job.jobId} className="rm-table-row"
                  style={{ borderBottom:`1px solid ${theme.border}` }}>
                  {/* Company */}
                  <td style={{ ...tdS }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      {job.companyIconUrl ? (
                        <img src={job.companyIconUrl} alt={job.company}
                          style={{ width:28, height:28, borderRadius:6, objectFit:"contain",
                                   border:`1px solid ${theme.border}`, background:"transparent", flexShrink:0 }}
                          onError={e => { e.currentTarget.style.display="none"; }}/>
                      ) : (
                        <div style={{ width:28, height:28, borderRadius:6, background:iconBg,
                                      display:"flex", alignItems:"center", justifyContent:"center",
                                      fontSize:11, fontWeight:800, color:"#fff", flexShrink:0 }}>
                          {(job.company||"?")[0].toUpperCase()}
                        </div>
                      )}
                      <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                                     fontWeight:600 }}>
                        {job.company}
                      </span>
                    </div>
                  </td>
                  {/* Title */}
                  <td style={{ ...tdS, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                                color:theme.textMuted }}>
                    {job.title}
                  </td>
                  {/* Location */}
                  <td style={{ ...tdS, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                                color:theme.textDim, fontSize:11 }}>
                    {job.location || "—"}
                  </td>
                  {/* Source */}
                  <td style={{ ...tdS }}>
                    <span style={{ background:theme.surfaceHigh, color:theme.textMuted,
                                   padding:"2px 8px", borderRadius:999, fontSize:10, fontWeight:700 }}>
                      {(job.source||job.sourcePlatform||"—").slice(0,8)}
                    </span>
                  </td>
                  {/* ATS */}
                  <td style={{ ...tdS }}>
                    {g?.atsScore != null ? (
                      <span className="rm-badge" style={{
                        background: g.atsScore>=80 ? theme.successMuted : g.atsScore>=60 ? theme.warningMuted : theme.dangerMuted,
                        color: g.atsScore>=80 ? theme.success : g.atsScore>=60 ? theme.warning : theme.danger,
                        padding:"2px 8px", borderRadius:999, fontSize:10, fontWeight:700,
                      }}>{g.atsScore}</span>
                    ) : <span style={{ color:theme.textDim, fontSize:11 }}>—</span>}
                  </td>
                  {/* Actions */}
                  <td style={{ ...tdS }}>
                    <div style={{ display:"flex", alignItems:"center", gap:5, flexWrap:"nowrap" }}>
                      {/* Generate / Regen — hidden in SIMPLE mode */}
                      {applyMode !== "SIMPLE" && (
                        <button title={done ? "Regenerate resume" : "Generate resume"}
                          disabled={busy || !hasResume}
                          onClick={() => onGenerate(job, done && g.html !== "__exists__")}
                          style={{
                            padding:"3px 10px", fontSize:11, fontWeight:700,
                            fontFamily:"'Barlow Condensed',sans-serif",
                            border:`1.5px solid ${busy||!hasResume ? theme.border : theme.borderStrong}`,
                            borderRadius:2, cursor:busy||!hasResume ? "not-allowed":"pointer",
                            background:"transparent", color:busy||!hasResume ? theme.textDim:theme.text,
                            opacity:busy||!hasResume ? 0.5 : 1, whiteSpace:"nowrap",
                          }}>
                          {busy ? "⏳" : done ? "↻ Regen" : "✦ Generate"}
                        </button>
                      )}
                      {/* Export PDF — only if html is fully generated */}
                      {done && g.html !== "__exists__" && (
                        <button title="Export PDF"
                          onClick={() => onExport(job, g.html)}
                          style={{
                            padding:"3px 10px", fontSize:11, fontWeight:700,
                            fontFamily:"'Barlow Condensed',sans-serif",
                            border:"1.5px solid #16a34a", borderRadius:2,
                            cursor:"pointer", background:"transparent", color:"#16a34a",
                            whiteSpace:"nowrap",
                          }}>
                          📥 PDF
                        </button>
                      )}
                      {/* Open URL */}
                      {job.url && (
                        <button title="Open job listing"
                          onClick={() => window.open(job.url, "_blank", "noreferrer")}
                          style={{
                            padding:"3px 8px", fontSize:11, border:`1.5px solid ${theme.border}`,
                            borderRadius:2, cursor:"pointer", background:"transparent",
                            color:theme.textMuted,
                          }}>↗</button>
                      )}
                      {/* Unsave */}
                      <button title="Remove from saved"
                        onClick={() => onUnsave(job.jobId)}
                        style={{
                          padding:"3px 8px", fontSize:11, border:`1.5px solid ${theme.border}`,
                          borderRadius:2, cursor:"pointer", background:"transparent",
                          color:"#f59e0b",
                        }}>★</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmptyState({ sheet, hasFilter, theme }) {
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column",
                  alignItems:"center", justifyContent:"center",
                  color:theme.textDim, gap:12, padding:40 }}>
      <div style={{ fontSize:40 }}>{sheet === "applications" ? "📋" : "📄"}</div>
      <div style={{ fontWeight:700, color:theme.textMuted, fontSize:14 }}>
        {hasFilter ? "No rows match your filter" :
          sheet === "applications" ? "No applications tracked yet" : "No resumes generated yet"}
      </div>
      <div style={{ fontSize:12, color:theme.textDim,
                    textAlign:"center", maxWidth:300, lineHeight:1.8 }}>
        {hasFilter ? "Try clearing the search or date filter." :
          sheet === "applications"
            ? "When you export a PDF for a job, it's automatically logged here."
            : "Generate resumes from the Jobs tab — they appear here with ATS scores."}
      </div>
    </div>
  );
}
