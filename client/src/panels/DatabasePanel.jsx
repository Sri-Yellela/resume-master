// client/src/panels/DatabasePanel.jsx — v2
// Added: date column, animated calendar picker, search, sort on all columns
import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../lib/api.js";

// ── Calendar component ────────────────────────────────────────
const DAYS   = ["Su","Mo","Tu","We","Th","Fr","Sa"];
const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];

function Calendar({ value, onChange, onClose }) {
  const today = new Date();
  const init  = value ? new Date(value) : today;
  const [view, setView] = useState({ year: init.getFullYear(), month: init.getMonth() });

  const selected = value ? new Date(value) : null;
  const firstDay = new Date(view.year, view.month, 1).getDay();
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
  const cells = Array(firstDay).fill(null).concat(
    Array.from({ length: daysInMonth }, (_, i) => i + 1)
  );
  // Pad to full rows
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

  const pick = (day) => {
    if (!day) return;
    const d = new Date(view.year, view.month, day);
    const iso = d.toISOString().slice(0, 10);
    onChange(iso);
    onClose();
  };

  const isSelected = (day) => {
    if (!day || !selected) return false;
    return selected.getFullYear() === view.year &&
           selected.getMonth()    === view.month &&
           selected.getDate()     === day;
  };
  const isToday = (day) => {
    if (!day) return false;
    return today.getFullYear() === view.year &&
           today.getMonth()    === view.month &&
           today.getDate()     === day;
  };

  return (
    <div style={cal.wrap}>
      {/* Header */}
      <div style={cal.header}>
        <button style={cal.navBtn} onClick={prev}>‹</button>
        <span style={cal.monthLabel}>{MONTHS[view.month]} {view.year}</span>
        <button style={cal.navBtn} onClick={next}>›</button>
      </div>
      {/* Day labels */}
      <div style={cal.grid}>
        {DAYS.map(d => <div key={d} style={cal.dayLabel}>{d}</div>)}
        {cells.map((day, i) => (
          <div key={i}
            style={{
              ...cal.cell,
              ...(day ? cal.cellActive : {}),
              ...(isToday(day)    ? cal.cellToday    : {}),
              ...(isSelected(day) ? cal.cellSelected : {}),
            }}
            onClick={() => pick(day)}>
            {day || ""}
          </div>
        ))}
      </div>
      {/* Clear */}
      <div style={cal.footer}>
        <button style={cal.clearBtn} onClick={() => { onChange(""); onClose(); }}>Clear date</button>
        <button style={cal.clearBtn} onClick={() => { onChange(new Date().toISOString().slice(0,10)); onClose(); }}>Today</button>
      </div>
    </div>
  );
}

const cal = {
  wrap:         { background:"#1e293b", border:"1px solid #334155",
                  borderRadius:12, padding:16, width:260,
                  boxShadow:"0 20px 60px rgba(0,0,0,.6)",
                  position:"absolute", zIndex:300,
                  top:"calc(100% + 6px)", left:0,
                  // If near bottom, flip upward
                  maxHeight:"320px", overflowY:"auto" },
  header:       { display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 },
  navBtn:       { background:"transparent", border:"1px solid #334155", color:"#94a3b8",
                  borderRadius:6, width:28, height:28, cursor:"pointer", fontSize:16,
                  display:"flex", alignItems:"center", justifyContent:"center" },
  monthLabel:   { fontWeight:700, fontSize:13, color:"#f8fafc" },
  grid:         { display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2 },
  dayLabel:     { textAlign:"center", fontSize:9, fontWeight:700, color:"#475569",
                  padding:"4px 0", textTransform:"uppercase" },
  cell:         { textAlign:"center", fontSize:11, padding:"6px 2px", borderRadius:6,
                  color:"#475569", userSelect:"none" },
  cellActive:   { color:"#cbd5e1", cursor:"pointer" },
  cellToday:    { color:"#38bdf8", fontWeight:700, border:"1px solid #38bdf8" },
  cellSelected: { background:"#3b82f6", color:"#fff", fontWeight:700 },
  footer:       { display:"flex", justifyContent:"space-between", marginTop:10, paddingTop:10,
                  borderTop:"1px solid #1e293b" },
  clearBtn:     { background:"transparent", border:"none", color:"#64748b", fontSize:10,
                  cursor:"pointer", fontWeight:600 },
};

// ── Column definitions ─────────────────────────────────────────
const APP_COLS = [
  { key:"company",    label:"Company",     editable:true,  width:150, sortable:true  },
  { key:"role",       label:"Role",        editable:true,  width:190, sortable:true  },
  { key:"location",   label:"Location",    editable:true,  width:120, sortable:true  },
  { key:"source",     label:"Source",      editable:false, width:85,  sortable:true  },
  { key:"apply_mode", label:"Mode",        editable:false, width:105, sortable:true  },
  { key:"applied_at", label:"Date Applied",editable:true,  width:130, sortable:true, isDate:true },
  { key:"resume_file",label:"Resume File", editable:false, width:200, sortable:false },
  { key:"job_url",    label:"Job URL",     editable:false, width:60,  sortable:false },
  { key:"notes",      label:"Notes",       editable:true,  width:180, sortable:false },
];

const RES_COLS = [
  { key:"company",    label:"Company",  editable:false, width:160, sortable:true  },
  { key:"role",       label:"Role",     editable:false, width:200, sortable:true  },
  { key:"category",   label:"Category", editable:false, width:155, sortable:true  },
  { key:"ats_score",  label:"ATS",      editable:false, width:60,  sortable:true  },
  { key:"apply_mode", label:"Mode",     editable:false, width:110, sortable:true  },
  { key:"updated_at", label:"Updated",  editable:false, width:100, sortable:true  },
];

// ── Helpers ───────────────────────────────────────────────────
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
  const [activeSheet,  setActiveSheet]  = useState("applications");
  const [apps,         setApps]         = useState([]);
  const [resumes,      setResumes]      = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [saving,       setSaving]       = useState({});
  const [editCell,     setEditCell]     = useState(null);
  const [editVal,      setEditVal]      = useState("");
  const [calCell,      setCalCell]      = useState(null); // { rowId } — date picker open
  const [flashRow,     setFlashRow]     = useState(null);
  const [search,       setSearch]       = useState("");
  const [sortCol,      setSortCol]      = useState("applied_at");
  const [sortDir,      setSortDir]      = useState("desc");
  const [filterDate,   setFilterDate]   = useState("");
  const [calFilter,    setCalFilter]    = useState(false); // filter calendar open

  const inputRef   = useRef();
  const calRef     = useRef();

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

  // Close calendar on outside click
  useEffect(() => {
    const h = e => {
      if (calRef.current && !calRef.current.contains(e.target)) {
        setCalCell(null); setCalFilter(false);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // ── Sorting ───────────────────────────────────────────────
  const toggleSort = (key) => {
    if (sortCol === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(key); setSortDir("asc"); }
  };

  const sortRows = (rows) => {
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

  // ── Filtering ─────────────────────────────────────────────
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

  // ── Cell editing ──────────────────────────────────────────
  const startEdit = (rowId, col, currentVal) => {
    setEditCell({ rowId, col }); setEditVal(currentVal || "");
  };

  const commitEdit = async (row, newValue) => {
    const { rowId, col } = editCell || {};
    if (!rowId || !col) return;
    const val = newValue !== undefined ? newValue : editVal;
    setEditCell(null);

    // For date columns, store as unix timestamp
    const payload = col === "applied_at" && val
      ? { [col]: isoToUnix(val) }
      : { [col]: val };

    setApps(prev => prev.map(r => r.job_id === rowId
      ? { ...r, [col]: col === "applied_at" && val ? isoToUnix(val) : val }
      : r));

    setSaving(p => ({ ...p, [rowId]: true }));
    try {
      await api(`/api/applications/${encodeURIComponent(rowId)}`, {
        method: "PATCH", body: JSON.stringify(payload),
      });
    } catch(e) { alert("Save failed: " + e.message); load(); }
    setSaving(p => { const n={...p}; delete n[rowId]; return n; });
  };

  const cancelEdit = () => setEditCell(null);

  // ── Date cell save ────────────────────────────────────────
  const handleDatePick = async (rowId, iso) => {
    setCalCell(null);
    const unix = iso ? isoToUnix(iso) : null;
    setApps(prev => prev.map(r => r.job_id === rowId ? { ...r, applied_at: unix } : r));
    setSaving(p => ({ ...p, [rowId]: true }));
    try {
      await api(`/api/applications/${encodeURIComponent(rowId)}`, {
        method: "PATCH", body: JSON.stringify({ applied_at: unix }),
      });
    } catch(e) { alert("Save failed: " + e.message); load(); }
    setSaving(p => { const n={...p}; delete n[rowId]; return n; });
  };

  // ── Delete ────────────────────────────────────────────────
  const deleteApp = async (jobId) => {
    if (!confirm("Remove this application from tracking?")) return;
    await api(`/api/applications/${encodeURIComponent(jobId)}`, { method:"DELETE" });
    setApps(prev => prev.filter(r => r.job_id !== jobId));
  };
  const deleteResume = async (jobId) => {
    if (!confirm("Delete this resume and all its versions?")) return;
    await api(`/api/resumes/${encodeURIComponent(jobId)}`, { method:"DELETE" });
    setResumes(prev => prev.filter(r => r.job_id !== jobId));
  };

  // ── Excel export ──────────────────────────────────────────
  const exportExcel = async () => {
    try {
      const r = await api("/api/export/excel");
      const b = await r.blob();
      const u = URL.createObjectURL(b);
      Object.assign(document.createElement("a"), {
        href: u, download: `ResuMaster_${user?.username}_${new Date().toISOString().slice(0,10)}.xlsx`,
      }).click();
      URL.revokeObjectURL(u);
    } catch(e) { alert("Export failed: " + e.message); }
  };

  const rows   = activeSheet === "applications" ? apps : resumes;
  const cols   = activeSheet === "applications" ? APP_COLS : RES_COLS;
  const isApps = activeSheet === "applications";
  const displayRows = filterRows(rows, cols);

  return (
    <div style={s.root}>

      {/* ── Header ── */}
      <div style={s.header}>
        <div style={s.sheetTabs}>
          {[["applications","📋 Job Applications"],["resumes","📄 Resume History"]].map(([id,lbl]) => (
            <button key={id}
              style={{ ...s.sheetTab, ...(activeSheet===id ? s.sheetTabActive : {}) }}
              onClick={() => { setActiveSheet(id); setSearch(""); setFilterDate(""); }}>
              {lbl}
              <span style={s.badge}>
                {id==="applications" ? apps.length : resumes.length}
              </span>
            </button>
          ))}
        </div>
        <div style={{ flex:1 }}/>
        <button style={s.refreshBtn} onClick={load} disabled={loading}>{loading?"⏳":"↻"} Refresh</button>
        <button style={s.exportBtn}  onClick={exportExcel}>📥 Export Excel</button>
      </div>

      {/* ── Toolbar: search + date filter ── */}
      <div style={s.toolbar}>
        {/* Search */}
        <div style={s.searchWrap}>
          <span style={s.searchIcon}>🔍</span>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder={`Search ${isApps ? "applications" : "resumes"}…`}
            style={s.searchInp}
          />
          {search && (
            <button style={s.clearSearch} onClick={() => setSearch("")}>✕</button>
          )}
        </div>

        {/* Date filter (applications only) */}
        {isApps && (
          <div ref={calRef} style={{ position:"relative" }}>
            <button style={{ ...s.dateFilterBtn, ...(filterDate ? s.dateFilterBtnActive : {}) }}
              onClick={() => setCalFilter(o => !o)}>
              📅 {filterDate ? `Date: ${fmtDate(filterDate)}` : "Filter by date"}
              {filterDate && (
                <span style={s.clearDateX}
                  onClick={e => { e.stopPropagation(); setFilterDate(""); }}>✕</span>
              )}
            </button>
            {calFilter && (
              <Calendar
                value={filterDate}
                onChange={setFilterDate}
                onClose={() => setCalFilter(false)}
              />
            )}
          </div>
        )}

        <div style={{ flex:1 }}/>
        <span style={s.rowCount}>
          {displayRows.length} of {rows.length} row{rows.length!==1?"s":""}
        </span>
      </div>

      {/* ── Table ── */}
      {loading ? (
        <div style={s.loadingState}>Loading data…</div>
      ) : displayRows.length === 0 ? (
        <EmptyState sheet={activeSheet} hasFilter={!!(search||filterDate)}/>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr style={s.thead}>
                <th style={{ ...s.th, width:36 }}>#</th>
                {cols.map(c => (
                  <th key={c.key}
                    style={{ ...s.th, width:c.width, minWidth:c.width,
                      cursor: c.sortable ? "pointer" : "default" }}
                    onClick={() => c.sortable && toggleSort(c.key)}>
                    <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                      {c.label}
                      {c.editable && <span style={s.editHint}>✎</span>}
                      {c.sortable && (
                        <span style={{ fontSize:9, color: sortCol===c.key ? "#38bdf8" : "#334155" }}>
                          {sortCol===c.key ? (sortDir==="asc" ? "▲" : "▼") : "⇅"}
                        </span>
                      )}
                    </div>
                  </th>
                ))}
                <th style={{ ...s.th, width:50 }}></th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row, i) => {
                const rowId   = row.job_id;
                const isFlash = flashRow === rowId;
                const isSaving = saving[rowId];
                return (
                  <tr key={rowId || i} id={`row-${rowId}`}
                    style={{ ...s.tr,
                      background: isFlash ? "#1e3a5f" : i%2===0 ? "#0f172a" : "#0a0f1a",
                      outline: isFlash ? "2px solid #38bdf8" : "none",
                    }}>
                    <td style={{ ...s.td, color:"#475569", width:36 }}>{i+1}</td>

                    {cols.map(c => {
                      const isEditing = editCell?.rowId===rowId && editCell?.col===c.key;
                      const raw = row[c.key] ?? "";

                      // ── Date column ──
                      if (c.isDate) {
                        const isoVal = typeof raw === "number"
                          ? new Date(raw*1000).toISOString().slice(0,10)
                          : (typeof raw === "string" && raw.length >= 10 ? raw.slice(0,10) : "");
                        const isCalOpen = calCell?.rowId === rowId;
                        return (
                          <td key={c.key} style={{ ...s.td, width:c.width, position:"relative" }}>
                            <div ref={isCalOpen ? calRef : null} style={{ position:"relative" }}>
                              <button
                                style={{ ...s.dateCell, ...(isoVal ? s.dateCellFilled : {}) }}
                                onClick={() => setCalCell(isCalOpen ? null : { rowId })}>
                                {isoVal ? fmtDate(isoVal) : <span style={{ color:"#334155" }}>+ Set date</span>}
                                {isSaving && <span style={{ color:"#f59e0b", marginLeft:4 }}>⏳</span>}
                              </button>
                              {isCalOpen && (
                                <Calendar
                                  value={isoVal}
                                  onChange={(iso) => handleDatePick(rowId, iso)}
                                  onClose={() => setCalCell(null)}
                                />
                              )}
                            </div>
                          </td>
                        );
                      }

                      // ── URL column ──
                      if (c.key === "job_url") return (
                        <td key={c.key} style={{ ...s.td, width:c.width }}>
                          {raw ? (
                            <a href={raw} target="_blank" rel="noreferrer"
                              style={{ color:"#38bdf8", fontSize:10, textDecoration:"none" }}>↗ Open</a>
                          ) : "—"}
                        </td>
                      );

                      // ── ATS score ──
                      if (c.key === "ats_score") return (
                        <td key={c.key} style={{ ...s.td, width:c.width }}>
                          {raw != null && raw !== "" ? (
                            <span style={{
                              background: raw>=80?"#dcfce7":raw>=60?"#fef9c3":"#fee2e2",
                              color:      raw>=80?"#166534":raw>=60?"#854d0e":"#991b1b",
                              padding:"2px 7px", borderRadius:8, fontSize:10, fontWeight:700,
                            }}>{raw}</span>
                          ) : "—"}
                        </td>
                      );

                      // ── Editable text cell ──
                      const display = c.key==="applied_at" ? fmtDate(raw) : raw;
                      return (
                        <td key={c.key}
                          style={{ ...s.td, width:c.width, maxWidth:c.width,
                            cursor: (c.editable && isApps) ? "pointer" : "default",
                            background: isEditing ? "#1e293b" : undefined }}
                          onClick={() => c.editable && !isEditing && isApps && startEdit(rowId, c.key, raw)}>
                          {isEditing ? (
                            <input ref={inputRef} value={editVal}
                              onChange={e => setEditVal(e.target.value)}
                              onBlur={() => commitEdit(row)}
                              onKeyDown={e => {
                                if (e.key==="Enter")  commitEdit(row);
                                if (e.key==="Escape") cancelEdit();
                              }}
                              style={s.cellInput}/>
                          ) : (
                            <span style={s.cellText} title={String(display||"")}>
                              {display || <span style={{ color:"#334155" }}>—</span>}
                              {isSaving && <span style={{ color:"#f59e0b", marginLeft:4 }}>⏳</span>}
                            </span>
                          )}
                        </td>
                      );
                    })}

                    {/* Delete */}
                    <td style={{ ...s.td, width:50 }}>
                      <button style={s.delBtn}
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

function EmptyState({ sheet, hasFilter }) {
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center",
      justifyContent:"center", color:"#334155", gap:12, padding:40 }}>
      <div style={{ fontSize:40 }}>{sheet==="applications" ? "📋" : "📄"}</div>
      <div style={{ fontWeight:700, color:"#475569", fontSize:14 }}>
        {hasFilter ? "No rows match your filter" :
          sheet==="applications" ? "No applications tracked yet" : "No resumes generated yet"}
      </div>
      <div style={{ fontSize:11, color:"#334155", textAlign:"center", maxWidth:300, lineHeight:1.8 }}>
        {hasFilter ? "Try clearing the search or date filter." :
          sheet==="applications"
            ? "When you export a PDF for a job, it's automatically logged here."
            : "Generate resumes from the Jobs tab — they appear here with ATS scores."}
      </div>
    </div>
  );
}

const s = {
  root:            { flex:1, display:"flex", flexDirection:"column", overflow:"hidden", background:"#0f172a" },
  header:          { background:"#0a0f1a", borderBottom:"1px solid #1e293b",
                     display:"flex", alignItems:"stretch", flexShrink:0 },
  sheetTabs:       { display:"flex" },
  sheetTab:        { background:"transparent", color:"#64748b", border:"none",
                     borderBottom:"2px solid transparent", padding:"12px 20px",
                     cursor:"pointer", fontSize:12, fontWeight:700,
                     display:"flex", alignItems:"center", gap:8, whiteSpace:"nowrap" },
  sheetTabActive:  { color:"#38bdf8", borderBottom:"2px solid #38bdf8", background:"#0f172a" },
  badge:           { background:"#1e293b", color:"#94a3b8", fontSize:10,
                     fontWeight:700, padding:"1px 6px", borderRadius:8 },
  refreshBtn:      { background:"transparent", color:"#64748b", border:"none",
                     padding:"8px 14px", cursor:"pointer", fontSize:11, fontWeight:700,
                     borderLeft:"1px solid #1e293b" },
  exportBtn:       { background:"#10b981", color:"#fff", border:"none",
                     padding:"8px 16px", cursor:"pointer", fontSize:11, fontWeight:700,
                     borderLeft:"1px solid #1e293b" },
  toolbar:         { background:"#0a0f1a", padding:"8px 12px", display:"flex",
                     alignItems:"center", gap:8, borderBottom:"1px solid #1e293b", flexShrink:0, flexWrap:"wrap" },
  searchWrap:      { position:"relative", display:"flex", alignItems:"center", flex:"0 0 260px" },
  searchIcon:      { position:"absolute", left:8, fontSize:12, pointerEvents:"none" },
  searchInp:       { width:"100%", padding:"6px 28px 6px 28px", borderRadius:6,
                     border:"1px solid #334155", background:"#0f172a", color:"#f8fafc",
                     fontSize:11, outline:"none" },
  clearSearch:     { position:"absolute", right:8, background:"transparent", border:"none",
                     color:"#475569", cursor:"pointer", fontSize:11 },
  dateFilterBtn:   { background:"#1e293b", color:"#94a3b8", border:"1px solid #334155",
                     borderRadius:6, padding:"5px 12px", cursor:"pointer", fontSize:11,
                     fontWeight:600, display:"flex", alignItems:"center", gap:6, whiteSpace:"nowrap" },
  dateFilterBtnActive: { background:"#1e3a5f", color:"#38bdf8", borderColor:"#38bdf8" },
  clearDateX:      { marginLeft:4, color:"#64748b", fontWeight:700, fontSize:10 },
  rowCount:        { fontSize:10, color:"#475569", whiteSpace:"nowrap" },
  tableWrap:       { flex:1, overflow:"auto" },
  table:           { borderCollapse:"collapse", width:"100%", tableLayout:"fixed" },
  thead:           { background:"#0a0f1a", position:"sticky", top:0, zIndex:5 },
  th:              { padding:"7px 10px", textAlign:"left", fontSize:10, fontWeight:700,
                     color:"#475569", borderBottom:"1px solid #1e293b",
                     whiteSpace:"nowrap", overflow:"hidden", userSelect:"none" },
  editHint:        { fontSize:9, color:"#334155" },
  tr:              { borderBottom:"1px solid #0a0f1a", transition:"background 0.3s, outline 0.3s" },
  td:              { padding:"5px 10px", fontSize:11, color:"#cbd5e1",
                     overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  cellText:        { display:"block", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  cellInput:       { width:"100%", background:"#1e3a5f", color:"#f8fafc",
                     border:"1px solid #38bdf8", borderRadius:4, padding:"3px 6px",
                     fontSize:11, outline:"none", boxSizing:"border-box" },
  dateCell:        { background:"transparent", border:"1px dashed #334155", borderRadius:5,
                     color:"#64748b", fontSize:11, padding:"3px 8px", cursor:"pointer",
                     whiteSpace:"nowrap" },
  dateCellFilled:  { borderStyle:"solid", borderColor:"#3b82f6", color:"#93c5fd" },
  delBtn:          { background:"transparent", border:"none", color:"#475569",
                     cursor:"pointer", fontSize:12, padding:"2px 6px", borderRadius:4 },
  loadingState:    { flex:1, display:"flex", alignItems:"center", justifyContent:"center",
                     color:"#475569", fontSize:13 },
};
