// REVAMP v2 — DatabasePanel.jsx (shadcn UI integrated)
// Added: date column, animated calendar picker, search, sort on all columns
import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api }      from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { ScrollArea } from "../components/ui/scroll-area";

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
    <div style={{ background:theme.gradPanel, border:`1px solid ${theme.colorBorder}`,
                  borderRadius:12, padding:16, width:260,
                  boxShadow:"0 20px 60px rgba(0,0,0,.6)",
                  position:"absolute", zIndex:300,
                  top:"calc(100% + 6px)", left:0,
                  maxHeight:"320px", overflowY:"auto" }}>
      <div style={{ display:"flex", alignItems:"center",
                    justifyContent:"space-between", marginBottom:12 }}>
        <button style={{ background:"transparent",
                         border:`1px solid ${theme.colorBorder}`,
                         color:theme.colorMuted, borderRadius:"999px", width:28, height:28,
                         cursor:"pointer", fontSize:16,
                         display:"flex", alignItems:"center", justifyContent:"center" }}
          onClick={prev}>‹</button>
        <span style={{ fontWeight:700, fontSize:13, color:theme.colorText }}>
          {MONTHS[view.month]} {view.year}
        </span>
        <button style={{ background:"transparent",
                         border:`1px solid ${theme.colorBorder}`,
                         color:theme.colorMuted, borderRadius:"999px", width:28, height:28,
                         cursor:"pointer", fontSize:16,
                         display:"flex", alignItems:"center", justifyContent:"center" }}
          onClick={next}>›</button>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2 }}>
        {DAYS.map(d => (
          <div key={d} style={{ textAlign:"center", fontSize:9, fontWeight:700,
                                color:theme.colorMuted, padding:"4px 0",
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
                color:sel ? "#fff" : tod ? theme.colorPrimary : day ? theme.colorText : "transparent",
                background:sel ? theme.colorPrimary : "transparent",
                border:tod && !sel ? `1px solid ${theme.colorPrimary}` : "1px solid transparent",
                fontWeight:sel || tod ? 700 : 400,
                position:"relative",
              }}
              onClick={() => pick(day)}>
              {day || ""}
              {tod && !sel && (
                <span style={{ position:"absolute", bottom:1, left:"50%",
                               transform:"translateX(-50%)",
                               width:3, height:3, borderRadius:"50%",
                               background:theme.colorAccent, display:"block" }}/>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", marginTop:10,
                    paddingTop:10, borderTop:`1px solid ${theme.colorBorder}` }}>
        <button style={{ background:"transparent", border:"none",
                         color:theme.colorMuted, fontSize:10, cursor:"pointer", fontWeight:600 }}
          onClick={() => { onChange(""); onClose(); }}>Clear date</button>
        <button style={{ background:"transparent", border:"none",
                         color:theme.colorMuted, fontSize:10, cursor:"pointer", fontWeight:600 }}
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

// ── Main panel ────────────────────────────────────────────────
export function DatabasePanel({ user }) {
  const { theme } = useTheme();
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

  useEffect(() => { load(); }, [load]);
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

  const SHEETS = [["applications","📋 Job Applications"],["resumes","📄 Resume History"]];

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column",
                  overflow:"hidden", background:theme.gradBg }}>

      {/* ── Header ── */}
      <div style={{ background:theme.gradPanel,
                    borderBottom:`1px solid ${theme.colorBorder}`,
                    display:"flex", alignItems:"stretch", flexShrink:0 }}>
        <div style={{ display:"flex" }}>
          {SHEETS.map(([id, lbl]) => (
            <button key={id}
              style={{ background:activeSheet===id ? theme.colorPrimary : "transparent",
                       color:activeSheet===id ? "#000" : theme.colorMuted,
                       border:"none",
                       borderRadius:"999px", margin:"6px 4px",
                       padding:"6px 18px", cursor:"pointer", fontSize:12, fontWeight:700,
                       display:"flex", alignItems:"center", gap:8, whiteSpace:"nowrap",
                       transition:"background 0.2s, color 0.2s" }}
              onClick={() => { setActiveSheet(id); setSearch(""); setFilterDate(""); }}>
              {lbl}
              <span style={{ background:activeSheet===id ? "rgba(0,0,0,0.2)" : theme.colorSurface,
                             color:activeSheet===id ? "#000" : theme.colorMuted,
                             fontSize:10, fontWeight:700,
                             padding:"1px 6px", borderRadius:8 }}>
                {id === "applications" ? apps.length : resumes.length}
              </span>
            </button>
          ))}
        </div>
        <div style={{ flex:1 }}/>
        <button style={{ background:"transparent", color:theme.colorMuted, border:"none",
                         padding:"8px 14px", cursor:"pointer", fontSize:11, fontWeight:700,
                         borderLeft:`1px solid ${theme.colorBorder}`, borderRadius:0 }}
          onClick={load} disabled={loading}>
          {loading ? "⏳" : "↻"} Refresh
        </button>
        <button style={{ background:theme.colorPrimary, color:"#000", border:"none",
                         padding:"8px 16px", cursor:"pointer", fontSize:11, fontWeight:700,
                         borderLeft:`1px solid ${theme.colorBorder}`, borderRadius:"0 0 0 0" }}
          onClick={exportExcel}>
          📥 Export Excel
        </button>
      </div>

      {/* ── Toolbar ── */}
      <div style={{ background:theme.gradPanel, padding:"8px 12px",
                    display:"flex", alignItems:"center", gap:8,
                    borderBottom:`1px solid ${theme.colorBorder}`,
                    flexShrink:0, flexWrap:"wrap" }}>
        <div style={{ position:"relative", display:"flex", alignItems:"center",
                      flex:"0 0 260px" }}>
          <span style={{ position:"absolute", left:8, fontSize:12, pointerEvents:"none" }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder={`Search ${isApps ? "applications" : "resumes"}…`}
            style={{ width:"100%", padding:"6px 28px",
                     borderRadius:"10px", border:`1px solid ${theme.colorBorder}`,
                     background:theme.colorSurface, color:theme.colorText,
                     fontSize:11, outline:"none" }}/>
          {search && (
            <button style={{ position:"absolute", right:8, background:"transparent",
                             border:"none", color:theme.colorMuted, cursor:"pointer",
                             fontSize:11 }}
              onClick={() => setSearch("")}>✕</button>
          )}
        </div>

        {isApps && (
          <div ref={calRef} style={{ position:"relative" }}>
            <button style={{ background:filterDate ? `rgba(${hexToRgb(theme.colorPrimary)},0.15)` : theme.colorSurface,
                             color:filterDate ? theme.colorPrimary : theme.colorMuted,
                             border:`1px solid ${filterDate ? theme.colorPrimary : theme.colorBorder}`,
                             borderRadius:"999px", padding:"5px 12px", cursor:"pointer", fontSize:11,
                             fontWeight:600, display:"flex", alignItems:"center",
                             gap:6, whiteSpace:"nowrap" }}
              onClick={() => setCalFilter(o => !o)}>
              📅 {filterDate ? `Date: ${fmtDate(filterDate)}` : "Filter by date"}
              {filterDate && (
                <span style={{ marginLeft:4, color:theme.colorMuted,
                               fontWeight:700, fontSize:10 }}
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
        <span style={{ fontSize:10, color:theme.colorMuted, whiteSpace:"nowrap" }}>
          {displayRows.length} of {rows.length} row{rows.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* ── Table ── */}
      {loading ? (
        <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center",
                      color:theme.colorMuted, fontSize:13 }}>
          Loading data…
        </div>
      ) : displayRows.length === 0 ? (
        <EmptyState sheet={activeSheet} hasFilter={!!(search || filterDate)} theme={theme}/>
      ) : (
        <div style={{ flex:1, overflow:"auto" }}>
          <table style={{ borderCollapse:"collapse", width:"100%", tableLayout:"fixed" }}>
            <thead>
              <tr style={{ background:theme.gradPanel,
                           position:"sticky", top:0, zIndex:5 }}>
                <th style={{ padding:"7px 10px", textAlign:"left", fontSize:10,
                             fontWeight:700, color:theme.colorMuted,
                             textTransform:"uppercase", letterSpacing:"0.06em",
                             borderBottom:`1px solid ${theme.colorBorder}`,
                             whiteSpace:"nowrap", overflow:"hidden",
                             userSelect:"none", width:36 }}>#</th>
                {cols.map(c => (
                  <th key={c.key}
                    style={{ padding:"7px 10px", textAlign:"left", fontSize:10,
                             fontWeight:700, color:theme.colorMuted,
                             textTransform:"uppercase", letterSpacing:"0.06em",
                             borderBottom:`1px solid ${theme.colorBorder}`,
                             whiteSpace:"nowrap", overflow:"hidden",
                             userSelect:"none", width:c.width, minWidth:c.width,
                             cursor:c.sortable ? "pointer" : "default" }}
                    onClick={() => c.sortable && toggleSort(c.key)}>
                    <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                      {c.label}
                      {c.editable && <span style={{ fontSize:9, color:theme.colorDim }}>✎</span>}
                      {c.sortable && (
                        <span style={{ fontSize:9,
                          color:sortCol===c.key ? theme.colorPrimary : theme.colorDim }}>
                          {sortCol===c.key ? (sortDir==="asc" ? "▲" : "▼") : "⇅"}
                        </span>
                      )}
                    </div>
                  </th>
                ))}
                <th style={{ padding:"7px 10px", textAlign:"left", fontSize:10,
                             fontWeight:700, color:theme.colorMuted,
                             borderBottom:`1px solid ${theme.colorBorder}`,
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
                    style={{
                      background:isFlash
                        ? `rgba(${hexToRgb(theme.colorPrimary)},0.15)`
                        : i%2===0 ? "transparent" : "rgba(0,0,0,0.15)",
                      borderBottom:`1px solid ${theme.colorBorder}`,
                      outline:isFlash ? `2px solid ${theme.colorPrimary}` : "none",
                      transition:"background 0.3s",
                    }}>
                    <td style={{ padding:"5px 10px", fontSize:11,
                                 color:theme.colorDim, width:36 }}>{i+1}</td>

                    {cols.map(c => {
                      const isEditing = editCell?.rowId===rowId && editCell?.col===c.key;
                      const raw = row[c.key] ?? "";

                      if (c.isDate) {
                        const isoVal = typeof raw === "number"
                          ? new Date(raw*1000).toISOString().slice(0,10)
                          : (typeof raw === "string" && raw.length >= 10 ? raw.slice(0,10) : "");
                        const isCalOpen = calCell?.rowId === rowId;
                        return (
                          <td key={c.key} style={{ padding:"5px 10px", fontSize:11,
                                                   width:c.width, position:"relative",
                                                   color:theme.colorText }}>
                            <div ref={isCalOpen ? calRef : null} style={{ position:"relative" }}>
                              <button
                                style={{ background:"transparent",
                                         border:`1px ${isoVal ? "solid" : "dashed"} ${isoVal ? theme.colorPrimary : theme.colorBorder}`,
                                         borderRadius:5, color:isoVal ? theme.colorAccent : theme.colorDim,
                                         fontSize:11, padding:"3px 8px",
                                         cursor:"pointer", whiteSpace:"nowrap" }}
                                onClick={() => setCalCell(isCalOpen ? null : { rowId })}>
                                {isoVal ? fmtDate(isoVal) : (
                                  <span style={{ color:theme.colorDim }}>+ Set date</span>
                                )}
                                {isSaving && <span style={{ color:"#f59e0b", marginLeft:4 }}>⏳</span>}
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
                        <td key={c.key} style={{ padding:"5px 10px", fontSize:11,
                                                  width:c.width, color:theme.colorText }}>
                          {raw ? (
                            <a href={raw} target="_blank" rel="noreferrer"
                              style={{ color:theme.colorPrimary, fontSize:10,
                                       textDecoration:"none" }}>
                              ↗ Open
                            </a>
                          ) : "—"}
                        </td>
                      );

                      if (c.key === "ats_score") return (
                        <td key={c.key} style={{ padding:"5px 10px", fontSize:11,
                                                  width:c.width, color:theme.colorText }}>
                          {raw != null && raw !== "" ? (
                            <span style={{
                              background:raw>=80?"#dcfce7":raw>=60?"#fef9c3":"#fee2e2",
                              color:raw>=80?"#166534":raw>=60?"#854d0e":"#991b1b",
                              padding:"2px 7px", borderRadius:8, fontSize:10, fontWeight:700,
                            }}>{raw}</span>
                          ) : "—"}
                        </td>
                      );

                      const display = c.key === "applied_at" ? fmtDate(raw) : raw;
                      return (
                        <td key={c.key}
                          style={{ padding:"5px 10px", fontSize:11,
                                   color:theme.colorText, width:c.width, maxWidth:c.width,
                                   overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                                   cursor:(c.editable && isApps) ? "pointer" : "default",
                                   background:isEditing ? theme.colorSurface : undefined }}
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
                              style={{ width:"100%", background:theme.colorSurface,
                                       color:theme.colorText,
                                       border:`1px solid ${theme.colorPrimary}`,
                                       borderRadius:4, padding:"3px 6px",
                                       fontSize:11, outline:"none", boxSizing:"border-box" }}/>
                          ) : (
                            <span style={{ display:"block", overflow:"hidden",
                                           textOverflow:"ellipsis", whiteSpace:"nowrap" }}
                              title={String(display || "")}>
                              {display || <span style={{ color:theme.colorDim }}>—</span>}
                              {isSaving && <span style={{ color:"#f59e0b", marginLeft:4 }}>⏳</span>}
                            </span>
                          )}
                        </td>
                      );
                    })}

                    <td style={{ padding:"5px 10px", fontSize:11,
                                 color:theme.colorText, width:50 }}>
                      <button style={{ background:"transparent", border:"none",
                                       color:theme.colorDim, cursor:"pointer",
                                       fontSize:12, padding:"2px 6px", borderRadius:4 }}
                        onClick={() => isApps ? deleteApp(rowId) : deleteResume(rowId)}
                        title="Delete row">✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function hexToRgb(hex) {
  const h = hex.replace("#","");
  const n = parseInt(h.length === 3
    ? h.split("").map(c => c+c).join("") : h, 16);
  return `${(n>>16)&255},${(n>>8)&255},${n&255}`;
}

function EmptyState({ sheet, hasFilter, theme }) {
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column",
                  alignItems:"center", justifyContent:"center",
                  color:theme.colorDim, gap:12, padding:40 }}>
      <div style={{ fontSize:40 }}>{sheet === "applications" ? "📋" : "📄"}</div>
      <div style={{ fontWeight:700, color:theme.colorMuted, fontSize:14 }}>
        {hasFilter ? "No rows match your filter" :
          sheet === "applications" ? "No applications tracked yet" : "No resumes generated yet"}
      </div>
      <div style={{ fontSize:11, color:theme.colorDim,
                    textAlign:"center", maxWidth:300, lineHeight:1.8 }}>
        {hasFilter ? "Try clearing the search or date filter." :
          sheet === "applications"
            ? "When you export a PDF for a job, it's automatically logged here."
            : "Generate resumes from the Jobs tab — they appear here with ATS scores."}
      </div>
    </div>
  );
}
