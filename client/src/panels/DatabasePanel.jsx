// client/src/panels/DatabasePanel.jsx — Design System v4
import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api, printResume } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";
import { useJobBoard } from "../contexts/JobBoardContext.jsx";
import JobCard      from "../components/JobCard.jsx";
import { DockPortal } from "../components/DockPortal.jsx";
import { Z } from "../styles/zLayers.js";
// AC4: the calendar this panel established, extracted so the Auto Apply panel's dated run history
// can reuse it rather than growing a second date picker. Same component, same two call sites here.
import { DateCalendar } from "../components/ui/DateCalendar.jsx";
// TASK AD1: this panel's CHROME — the underline sub-tab row with its count pills, the rounded
// search box, and the "Filter by date" pill with its portalled calendar — extracted so the Auto
// Apply panel can adopt this layout by rendering the same components rather than by copying the
// markup. The three call sites below are the originals, now reading from the shared file: if this
// panel kept its own copy the extraction would be a clone with extra steps, and the two surfaces
// would drift the first time either was touched.
import { PanelSubTabs, PanelSearch, DateFilterButton } from "../components/ui/PanelControls.jsx";
// AK1: the employer-response vocabulary, shared with the server so a cell cannot invent a label or
// a value the API would reject. responseBucket is imported rather than reimplemented because "no
// outcome recorded" means different things at two days and at two months, and a UI that worked that
// out for itself would get it wrong the same way a naive query does.
import {
  RESPONSE_OUTCOME, RESPONSE_OUTCOMES, RESPONSE_LABELS, MATURITY_DAYS, responseBucket,
} from "../../../shared/applicationResponse.js";

// ── Calendar component ────────────────────────────────────────
//
// MOVED to components/ui/DateCalendar.jsx and imported above. Task AC4 reuses this widget for the
// Auto Apply panel's dated run history rather than building a second date picker, so it was
// lifted out whole; both of this panel's uses — the applied-jobs date FILTER in the toolbar and
// the per-row "set date" cell — render the extracted component unchanged. The toolbar one now
// reaches it through PanelControls' DateFilterButton, which is the button plus the portal plus
// this calendar as one piece; the per-row cell still renders DateCalendar directly, because a
// table cell is not a filter pill and has no button to share.


// ── Column definitions ─────────────────────────────────────────
const APP_COLS = [
  { key:"company",    label:"Company",      editable:true,  width:150, sortable:true  },
  { key:"role",       label:"Role",         editable:true,  width:190, sortable:true  },
  { key:"location",   label:"Location",     editable:true,  width:120, sortable:true  },
  { key:"source",     label:"Source",       editable:false, width:85,  sortable:true  },
  { key:"apply_mode", label:"Tool",         editable:false, width:105, sortable:true  },
  { key:"applied_at", label:"Date Applied", editable:true,  width:130, sortable:true, isDate:true },
  // AK1 — THE PAIR, SIDE BY SIDE, AND THAT ADJACENCY IS THE POINT.
  //
  // The score the resume had at the moment it was sent, and what the employer did about it. Neither
  // was recordable before AK1 and neither is useful alone: the score is unverifiable without the
  // outcome, and the outcome cannot be attributed without the score. Putting them in one row is what
  // makes "does this number predict anything" a question someone can look at rather than compute.
  { key:"ats_score_at_apply", label:"ATS @ Apply", editable:false, width:110, sortable:true, isAtsAtApply:true },
  // 200, not 150. At 150 the longest real value — "Rejected · via Interview", a row that reached an
  // interview and was then turned down — rendered as "Rejected · via Inte…". That row is the entire
  // reason furthest_stage is a separate column, so truncating it defeats the column. Measured in the
  // browser, not guessed: scripts/ak2ApplicationsOutcomeUi.mjs screenshots this cell.
  { key:"response_outcome",   label:"Outcome",     editable:false, width:200, sortable:true, isOutcome:true },
  { key:"resume_file",label:"Resume File",  editable:false, width:200, sortable:false },
  { key:"job_url",    label:"Job URL",      editable:false, width:60,  sortable:false },
  { key:"notes",      label:"Notes",        editable:true,  width:180, sortable:false },
];

const RES_COLS = [
  { key:"company",    label:"Company",  editable:false, width:160, sortable:true  },
  { key:"role",       label:"Role",     editable:false, width:200, sortable:true  },
  { key:"category",   label:"Category", editable:false, width:155, sortable:true  },
  { key:"ats_score",  label:"ATS",      editable:false, width:60,  sortable:true  },
  { key:"apply_mode", label:"Tool",     editable:false, width:110, sortable:true  },
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

function fmtTool(val) {
  if (val === "CUSTOM_SAMPLER") return "A+ Resume";
  if (val === "TAILORED") return "Generate";
  return "Baseline";
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

// ── ATS report display ────────────────────────────────────────
function AtsReportDisplay({ report, score, theme }) {
  if (!report) return <p style={{ color:theme.textMuted }}>No report.</p>;
  const sections = Array.isArray(report) ? report : (report.sections || []);
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      {sections.map((s, i) => (
        <div key={i} style={{ background:theme.surfaceHigh, borderRadius:12, padding:16 }}>
          <div style={{ fontWeight:700, fontSize:13, color:theme.text, marginBottom:8 }}>{s.section || s.name || s.title || "Section"}</div>
          <div style={{ fontSize:12, color:theme.textMuted, lineHeight:1.7 }}>{s.feedback || s.comment || s.description || JSON.stringify(s)}</div>
          {s.score != null && <div style={{ fontSize:11, color:theme.accent, marginTop:4, fontWeight:700 }}>Score: {s.score}</div>}
        </div>
      ))}
    </div>
  );
}

// ── Detail modal (resume preview or ATS report) ───────────────
function DetailModal({ modal, onClose, theme }) {
  const [view,      setView]      = useState(null); // "resume" | "ats"
  const exporting = false;

  // Sync view to modal.type when modal changes
  useEffect(() => { if (modal) setView(modal.type); }, [modal?.type, modal?.company]);

  if (!modal) return null;

  const isResume   = view === "resume";
  const hasResume  = !!modal.html;
  const hasAts     = !!(modal.atsReport || modal.atsScore != null);

  const atsBg = modal.atsScore != null
    ? (modal.atsScore >= 80 ? theme.successMuted : modal.atsScore >= 60 ? theme.warningMuted : theme.dangerMuted)
    : theme.surfaceHigh;
  const atsFg = modal.atsScore != null
    ? (modal.atsScore >= 80 ? theme.success : modal.atsScore >= 60 ? theme.warning : theme.danger)
    : theme.textMuted;

  const exportPdf = () => {
    if (!modal.html || exporting) return;
    const filename = `Resume_${(modal.company || "resume").replace(/\s+/g, "_")}`;
    printResume(modal.html, filename);
  };

  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        // Named tier rather than the literal 1000 it carried, which sat between MODAL (850) and
        // the old NAV (1500) and belonged to neither. Same class as the other two panel-local
        // takeovers.
        position:"fixed", inset:0, zIndex:Z.MODAL_SCRIM,
        background:"rgba(0,0,0,0.55)",
        display:"flex", alignItems:"center", justifyContent:"center",
        padding:24,
      }}>
      <div style={{
        background:theme.surface, borderRadius:16,
        width:"90%", maxWidth:960, height:"88vh",
        display:"flex", flexDirection:"column",
        boxShadow:theme.shadowLg, overflow:"hidden",
      }}>
        {/* ── Header ───────────────────────────── */}
        <div style={{
          padding:"14px 20px", borderBottom:`1px solid ${theme.border}`,
          display:"flex", alignItems:"center", gap:12, flexShrink:0, flexWrap:"wrap",
        }}>
          {/* Title */}
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                          fontSize:17, letterSpacing:"0.06em", textTransform:"uppercase",
                          color:theme.text, overflow:"hidden", textOverflow:"ellipsis",
                          whiteSpace:"nowrap" }}>
              {modal.company}
            </div>
            <div style={{ fontSize:11, color:theme.textMuted }}>{modal.role}</div>
          </div>

          {/* View tabs (Resume / ATS) */}
          <div style={{ display:"flex", gap:0, border:`1px solid ${theme.borderStrong}`,
                        borderRadius:6, overflow:"hidden", flexShrink:0 }}>
            {[["resume","📄 Resume"],["ats","📊 ATS"]].map(([id, lbl]) => (
              <button key={id} onClick={() => setView(id)}
                disabled={id === "resume" ? !hasResume : !hasAts}
                style={{
                  padding:"5px 14px", border:"none", cursor: (id==="resume"?hasResume:hasAts) ? "pointer" : "not-allowed",
                  background: view===id ? theme.accent : theme.surface,
                  color: view===id ? "#0f0f0f" : (id==="resume"?hasResume:hasAts) ? theme.text : theme.textDim,
                  fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                  fontSize:12, letterSpacing:"0.06em", textTransform:"uppercase",
                  transition:"background 0.15s",
                  borderRight: id==="resume" ? `1px solid ${theme.borderStrong}` : "none",
                }}>
                {lbl}
              </button>
            ))}
          </div>

          {/* ATS score chip */}
          {modal.atsScore != null && (
            <span style={{ padding:"4px 12px", borderRadius:999, fontSize:12,
                           fontWeight:700, background:atsBg, color:atsFg, flexShrink:0 }}>
              ATS {modal.atsScore}
            </span>
          )}

          {/* Export PDF button — only when viewing resume */}
          {isResume && hasResume && (
            <button onClick={exportPdf} disabled={exporting}
              style={{
                display:"inline-flex", alignItems:"center", gap:5, flexShrink:0,
                padding:"6px 16px", borderRadius:2,
                fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                fontSize:12, letterSpacing:"0.08em", textTransform:"uppercase",
                background:"transparent", border:`2px solid ${theme.borderStrong}`,
                color:theme.text, cursor: exporting ? "not-allowed" : "pointer",
                opacity: exporting ? 0.6 : 1, transition:"border-radius 0.4s ease",
              }}
              onMouseEnter={e => {
                if (!exporting) {
                  e.currentTarget.style.borderRadius = "999px";
                  e.currentTarget.style.background   = theme.accent;
                  e.currentTarget.style.borderColor  = theme.accent;
                }
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderRadius = "2px";
                e.currentTarget.style.background   = "transparent";
                e.currentTarget.style.borderColor  = theme.borderStrong;
              }}>
              {exporting ? "⏳ Exporting…" : "↓ Export PDF"}
            </button>
          )}

          {/* Close */}
          <button onClick={onClose}
            style={{ background:"none", border:"none", color:theme.textMuted,
                     cursor:"pointer", fontSize:20, lineHeight:1, flexShrink:0,
                     padding:"0 4px" }}>✕</button>
        </div>

        {/* ── Content ──────────────────────────── */}
        <div style={{ flex:1, overflow:"hidden", display:"flex" }}>
          {isResume ? (
            <iframe
              srcDoc={modal.html || "<p style='padding:40px;font-family:sans-serif;color:#888'>No resume HTML stored.</p>"}
              style={{ width:"100%", height:"100%", border:"none", background:"#ffffff" }}
              title="Resume Preview"
              sandbox="allow-same-origin"/>
          ) : (
            <div style={{ flex:1, overflowY:"auto", padding:24 }}>
              {modal.atsReport ? (
                <AtsReportDisplay report={modal.atsReport} score={modal.atsScore} theme={theme}/>
              ) : (
                <p style={{ color:theme.textMuted, fontSize:13 }}>No ATS report available for this application.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────
export function DatabasePanel({ user }) {
  const { theme } = useTheme();
  const { activeProfileId, setActiveProfileId } = useJobBoard() || {};
  const [activeSheet,  setActiveSheet]  = useState("applications");
  const [apps,         setApps]         = useState([]);
  const [resumes,      setResumes]      = useState([]);
  const [detailModal,  setDetailModal]  = useState(null);
  const [detailLoading,setDetailLoading]= useState(false);
  const [loading,      setLoading]      = useState(false);
  const [saving,       setSaving]       = useState({});
  const [editCell,     setEditCell]     = useState(null);
  const [editVal,      setEditVal]      = useState("");
  const [calCell,      setCalCell]      = useState(null);
  // AK1: which row's outcome picker is open, and where to anchor it. Same shape as calCell — the
  // date cell established this pattern and an outcome cell is the same kind of thing.
  const [outcomeCell,  setOutcomeCell]  = useState(null);
  const [flashRow,     setFlashRow]     = useState(null);
  const [search,       setSearch]       = useState("");
  const [sortCol,      setSortCol]      = useState("applied_at");
  const [sortDir,      setSortDir]      = useState("desc");
  const [filterDate,   setFilterDate]   = useState("");

  // ── Saved Jobs tab state ──────────────────────────────────────
  const [savedJobs,    setSavedJobs]    = useState([]);
  const [savedGen,     setSavedGen]     = useState({}); // jobId→{html,atsScore}
  const [baseResume,   setBaseResume]   = useState("");
  const [genLoading,   setGenLoading]   = useState({});

  // ── Pending Apply tab state ───────────────────────────────────
  const [pendingJobs,  setPendingJobs]  = useState([]);

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
      let profileId = activeProfileId;
      if (!profileId) {
        const profiles = await api("/api/domain-profiles");
        const active = (Array.isArray(profiles) ? profiles : []).find(p => p.is_active) || profiles?.[0];
        profileId = active?.id || null;
        if (profileId) setActiveProfileId?.(profileId);
      }
      const [jr, rr, br] = await Promise.all([
        api("/api/jobs?starred=1&pageSize=100"),
        api("/api/resumes"),
        profileId ? api(`/api/domain-profiles/${profileId}/base-resume`) : Promise.resolve({ content: "" }),
      ]);
      setSavedJobs(jr.jobs || []);
      setBaseResume(br?.content || "");
      if (rr?.length) {
        const map = {};
        rr.forEach(r => { map[r.job_id] = { html:"__exists__", atsScore:r.ats_score }; });
        setSavedGen(map);
      }
    } catch {}
  }, [activeProfileId, setActiveProfileId]);

  const loadPending = useCallback(async () => {
    try {
      const rows = await api("/api/jobs/pending");
      setPendingJobs(Array.isArray(rows) ? rows : []);
    } catch {}
  }, []);

  const generateForSaved = useCallback(async (job, force = false, tool = "generate") => {
    const planTier = String(user?.planTier || "BASIC").toUpperCase();
    if (planTier === "BASIC") { alert("Upgrade from Plans to unlock Generate."); return; }
    if (tool === "a_plus_resume") { return; } // A+ is silently applied server-side for eligible users
    if (!baseResume) { alert("Upload this job profile's base resume in Job Profiles first."); return; }
    setGenLoading(p => ({...p, [job.jobId]: true}));
    try {
      const d = await api("/api/generate", { method:"POST",
        body:JSON.stringify({ jobId:job.jobId, job, resumeText:baseResume, forceRegen:force, tool }) });
      if (d.error) throw new Error(d.error);
      setSavedGen(p => ({...p, [job.jobId]:{ html:d.html, atsScore:d.atsScore }}));
    } catch(e) { alert("Generation failed: " + e.message); }
    setGenLoading(p => { const n={...p}; delete n[job.jobId]; return n; });
  }, [baseResume, user]);

  const exportSavedPdf = useCallback(async (job, html) => {
    const filename = `Resume_${(job.company||"").replace(/\s+/g,"_")}`;
    printResume(html, filename);
    await api("/api/applications", { method:"POST", body:JSON.stringify({
      jobId:job.jobId, company:job.company, role:job.title,
      jobUrl:job.url, source:job.source, location:job.location,
      applyMode:user?.applyMode||"SIMPLE", resumeFile:filename + ".pdf",
    }) }).catch(()=>{});
  }, [user]);

  const unsaveJob = useCallback(async (jobId) => {
    await api(`/api/jobs/${jobId}/starred`, { method:"PATCH" });
    setSavedJobs(prev => prev.filter(j => j.jobId !== jobId));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (activeSheet === "saved") loadSaved(); }, [activeSheet, loadSaved]);
  useEffect(() => { if (activeSheet === "pending") loadPending(); }, [activeSheet, loadPending]);
  useEffect(() => { if (editCell && inputRef.current) inputRef.current.focus(); }, [editCell]);

  // The document mousedown handler that used to close these calendars lived here and tested
  // `calRef.contains(e.target)`. Now that the calendar is portalled to document.body it is no longer
  // a DOM descendant of calRef, so that test would have reported every click INSIDE the calendar as
  // an outside click — picking a day or changing month would have dismissed it instead. DockPortal
  // owns outside-click dismissal for both calendars (it tests the portalled panel itself and
  // hit-tests the trigger), and unlike this handler it does not consume the click.

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

  /**
   * AK1 — record what the employer did.
   *
   * NOT the generic PATCH /api/applications/:jobId that every other editable cell here uses. That
   * endpoint writes whatever field it is handed, and these columns must not be written that way:
   * first_response_at is set once and never moved, and furthest_stage only ever advances, so that
   * screen -> interview -> rejected keeps the interview instead of reading as a resume rejection.
   * Those rules live in mergeResponse on the server, and the dedicated endpoint is how they are
   * enforced for every caller rather than re-implemented in a click handler.
   *
   * The response body is authoritative: the merge may legitimately return something other than what
   * was sent (recording `screen` on a row that already reached `interview` leaves the stage alone),
   * so the row is replaced with what came back rather than with what was clicked.
   */
  const handleOutcomePick = async (rowId, outcome) => {
    setOutcomeCell(null);
    setSaving(p => ({ ...p, [rowId]: true }));
    try {
      const res = await api(`/api/apply/applications/${encodeURIComponent(rowId)}/response`, {
        method:"PATCH", body:JSON.stringify({ outcome }),
      });
      const a = res?.application;
      if (a) {
        setApps(prev => prev.map(r => r.job_id === rowId ? {
          ...r,
          response_outcome:  a.responseOutcome  ?? null,
          furthest_stage:    a.furthestStage    ?? null,
          first_response_at: a.firstResponseAt  ?? null,
          outcome_at:        a.outcomeAt        ?? null,
        } : r));
      } else {
        load();
      }
    } catch(e) { alert("Could not record outcome: " + e.message); load(); }
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

  const openDetail = async (jobId, type, existingData = null) => {
    if (existingData) {
      setDetailModal({ ...existingData, type });
      return;
    }
    setDetailLoading(true);
    try {
      const d = await api(`/api/resumes/${jobId}`);
      setDetailModal({
        type,
        html: d.html,
        atsReport: d.atsReport,
        atsScore: d.ats_score,
        company: d.company,
        role: d.role,
      });
    } catch(e) {
      alert("Failed to load: " + e.message);
    } finally {
      setDetailLoading(false);
    }
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

  const SHEETS = [["applications","Applications"],["resumes","Resumes"],["saved","Saved Jobs"],["pending","Pending Apply"]];

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column",
                  overflow:"hidden", background:theme.bg }}>

      <DetailModal modal={detailModal} onClose={() => setDetailModal(null)} theme={theme}/>

      {/* ── Header ──
          AD1: the same PanelSubTabs the Auto Apply panel renders. Identical behaviour to the markup
          it replaces — same underline, same count pill, same "changing sheet clears the search and
          the date filter" rule, which is the panel's own and stays here rather than moving into a
          shared component that has no business knowing about it. */}
      <PanelSubTabs
        theme={theme}
        layoutId="db-tab-underline"
        active={activeSheet}
        onSelect={(id) => { setActiveSheet(id); setSearch(""); setFilterDate(""); }}
        tabs={SHEETS.map(([id, lbl]) => ({
          id, label: lbl,
          count: id === "applications" ? apps.length
            : id === "resumes" ? resumes.length
            : id === "pending" ? pendingJobs.length : null,
        }))}
        right={
          <div style={{ display:"flex", alignItems:"center", gap:8, paddingRight:4 }}>
            <button className="rm-btn rm-btn-ghost rm-btn-sm"
              onClick={load} disabled={loading}>
              {loading ? "⏳" : "↻"} Refresh
            </button>
            <button className="rm-btn rm-btn-primary rm-btn-sm" onClick={exportExcel}>
              📥 Export Excel
            </button>
          </div>
        }
      />

      {/* ── Toolbar (hidden for saved/pending tab — they have their own toolbars) ── */}
      {activeSheet !== "saved" && activeSheet !== "pending" && <div style={{ background:theme.surface, padding:"10px 16px",
                    display:"flex", alignItems:"center", gap:10,
                    borderBottom:`1px solid ${theme.border}`,
                    flexShrink:0, flexWrap:"wrap" }}>
        {/* Search — AD1's shared primitive. */}
        <PanelSearch theme={theme} value={search} onChange={setSearch}
          placeholder={`Search ${isApps ? "applications" : "resumes"}…`}/>

        {/* Filter by date — the button, the portal and the calendar as one piece. No `markers` is
            passed, so nothing is dotted here: the marker prop is opt-in and this panel did not opt
            in, which is what keeps the Auto Apply reuse from changing this surface. */}
        {isApps && (
          <DateFilterButton
            theme={theme}
            value={filterDate}
            format={fmtDate}
            onChange={setFilterDate}
            onClear={() => setFilterDate("")}
            portalKey="cal-filter"/>
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
          applyMode={user?.applyMode || "SIMPLE"} planTier={user?.planTier || "BASIC"} hasResume={!!baseResume}
          theme={theme}
          onGenerate={(job, force, tool) => generateForSaved(job, force, tool)}
          onExport={(job, html) => exportSavedPdf(job, html)}
          onUnsave={unsaveJob}
          onRefresh={loadSaved}
        />
      )}

      {/* ── Pending Apply pane ── */}
      {activeSheet === "pending" && (
        <PendingJobsPane
          jobs={pendingJobs}
          theme={theme}
          onRefresh={loadPending}
          onDislike={async (jobId) => {
            await api(`/api/jobs/${jobId}/disliked`, { method:"PATCH" }).catch(()=>{});
            setPendingJobs(prev => prev.filter(j => j.job_id !== jobId && j.jobId !== jobId));
          }}
        />
      )}

      {isApps && displayRows.length > 0 && (
        <ResponseSummary rows={displayRows} theme={theme}/>
      )}

      {/* ── Table (applications / resumes) ── */}
      {activeSheet !== "saved" && activeSheet !== "pending" && loading ? (
        <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center",
                      color:theme.textMuted, fontSize:13 }}>
          Loading data…
        </div>
      ) : activeSheet !== "saved" && activeSheet !== "pending" && displayRows.length === 0 ? (
        <EmptyState sheet={activeSheet} hasFilter={!!(search || filterDate)} theme={theme}/>
      ) : activeSheet !== "saved" && activeSheet !== "pending" ? (
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
                             width:120 }}/>
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
                                         border:`1px ${isoVal ? "solid" : "dashed"} ${isoVal ? "color-mix(in srgb, var(--color-primary) 40%, transparent)" : theme.border}`,
                                         borderRadius:8, color:isoVal ? theme.accent : theme.textDim,
                                         fontSize:11, padding:"3px 10px",
                                         cursor:"pointer", whiteSpace:"nowrap" }}
                                onClick={e => setCalCell(isCalOpen ? null : {
                                  rowId, rect: e.currentTarget.getBoundingClientRect(),
                                })}>
                                {isoVal ? fmtDate(isoVal) : (
                                  <span style={{ color:theme.textDim }}>+ Set date</span>
                                )}
                                {isSaving && <span style={{ color:theme.warning, marginLeft:4 }}>⏳</span>}
                              </button>
                              <AnimatePresence>
                                {isCalOpen && calCell?.rect && (
                                  <DockPortal anchorRect={calCell.rect} theme={theme}
                                    onClose={() => setCalCell(null)} style={{ minWidth:260, padding:0 }}>
                                    <motion.div key="cal"
                                      initial={{ opacity:0, scale:0.96, y:-4 }}
                                      animate={{ opacity:1, scale:1, y:0 }}
                                      exit={{ opacity:0, scale:0.96, y:-4 }}
                                      transition={{ duration:0.15 }}>
                                      <DateCalendar theme={theme}
                                        value={isoVal}
                                        onChange={iso => handleDatePick(rowId, iso)}
                                        onClose={() => setCalCell(null)}/>
                                    </motion.div>
                                  </DockPortal>
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

                      if (c.isAtsAtApply) {
                        // DELIBERATELY NOT COLOUR-BANDED like the ats_score column below.
                        //
                        // That one paints >=80 green / >=60 amber / else red. Under local_ats_v4 the
                        // whole board runs median 28, p90 38, max 63 — every row would render red,
                        // which reads as "every application was bad" when it is just a different
                        // scale. And at rho=0.504 the ranking is honest but the absolute number does
                        // not support a good/bad verdict anyway. So the number is shown plainly, with
                        // the scorer that produced it on hover, because a score is only comparable to
                        // another score from the same version.
                        const ver = row.ats_scorer_version || null;
                        return (
                          <td key={c.key} style={{ padding:"12px 14px", fontSize:12,
                                                   width:c.width, color:theme.text }}>
                            {raw != null && raw !== "" ? (
                              <span title={ver ? `Scored by ${ver} at the time of applying` : "Scorer version not recorded"}
                                style={{ fontFamily:theme.fontMono, fontSize:12, color:theme.textMuted,
                                         background:theme.surfaceHigh, border:`1px solid ${theme.border}`,
                                         borderRadius:6, padding:"2px 8px", whiteSpace:"nowrap" }}>
                                {raw}
                              </span>
                            ) : <span style={{ color:theme.textDim }}>—</span>}
                          </td>
                        );
                      }

                      if (c.isOutcome) {
                        const bucket = responseBucket(row);
                        const meta   = raw ? RESPONSE_LABELS[raw] : null;
                        const isOpen = outcomeCell?.rowId === rowId;
                        // The stage is shown only when it says something the outcome does not — a row
                        // that reached an interview and was then rejected is the case this column
                        // exists to keep legible.
                        const stage  = row.furthest_stage && row.furthest_stage !== raw
                          ? RESPONSE_LABELS[row.furthest_stage]?.label : null;
                        return (
                          <td key={c.key} style={{ padding:"12px 14px", fontSize:12,
                                                   width:c.width, position:"relative", color:theme.text }}>
                            <div style={{ position:"relative" }}>
                              <button
                                title={bucket === "unresolved" && !raw
                                  ? `Nothing recorded yet — counted as unresolved until ${MATURITY_DAYS} days after applying`
                                  : meta?.note || "Record what the employer did"}
                                style={{ background:meta ? "transparent" : "transparent",
                                         border:`1px ${meta ? "solid" : "dashed"} ${meta ? meta.color : theme.border}`,
                                         borderRadius:8, color:meta ? meta.color : theme.textDim,
                                         fontSize:11, padding:"3px 10px", cursor:"pointer",
                                         whiteSpace:"nowrap", maxWidth:"100%", overflow:"hidden",
                                         textOverflow:"ellipsis" }}
                                onClick={e => setOutcomeCell(isOpen ? null : {
                                  rowId, rect: e.currentTarget.getBoundingClientRect(),
                                })}>
                                {meta ? meta.label : <span style={{ color:theme.textDim }}>+ Set outcome</span>}
                                {stage ? <span style={{ color:theme.textDim, marginLeft:5 }}>· via {stage}</span> : null}
                                {isSaving ? <span style={{ color:theme.warning, marginLeft:4 }}>⏳</span> : null}
                              </button>
                              <AnimatePresence>
                                {isOpen && outcomeCell?.rect && (
                                  <DockPortal anchorRect={outcomeCell.rect} theme={theme}
                                    onClose={() => setOutcomeCell(null)} style={{ minWidth:210, padding:6 }}>
                                    <motion.div key="outcome"
                                      initial={{ opacity:0, scale:0.96, y:-4 }}
                                      animate={{ opacity:1, scale:1, y:0 }}
                                      exit={{ opacity:0, scale:0.96, y:-4 }}
                                      transition={{ duration:0.15 }}
                                      style={{ display:"flex", flexDirection:"column", gap:2 }}>
                                      {RESPONSE_OUTCOMES.map(o => {
                                        const m = RESPONSE_LABELS[o];
                                        const active = raw === o;
                                        return (
                                          <button key={o} onClick={() => handleOutcomePick(rowId, o)}
                                            style={{ display:"flex", alignItems:"baseline", gap:8,
                                                     textAlign:"left", width:"100%",
                                                     background:active ? theme.surfaceHigh : "transparent",
                                                     border:"none", borderRadius:6, cursor:"pointer",
                                                     padding:"6px 10px", color:theme.text, fontSize:12 }}>
                                            <span style={{ width:7, height:7, borderRadius:"50%",
                                                           background:m.color, flexShrink:0 }}/>
                                            <span style={{ fontWeight:active ? 700 : 500 }}>{m.label}</span>
                                            <span style={{ color:theme.textDim, fontSize:10, marginLeft:"auto" }}>
                                              {m.note}
                                            </span>
                                          </button>
                                        );
                                      })}
                                    </motion.div>
                                  </DockPortal>
                                )}
                              </AnimatePresence>
                            </div>
                          </td>
                        );
                      }

                      if (c.key === "ats_score") return (
                        <td key={c.key} style={{ padding:"12px 14px", fontSize:12,
                                                  width:c.width, color:theme.text }}>
                          {raw != null && raw !== "" ? (
                            <span className="rm-badge"
                              onClick={() => openDetail(rowId, "ats")}
                              style={{
                                background:raw>=80 ? theme.successMuted : raw>=60 ? theme.warningMuted : theme.dangerMuted,
                                color:raw>=80 ? theme.success : raw>=60 ? theme.warning : theme.danger,
                                cursor:"pointer",
                              }}>{raw}</span>
                          ) : "—"}
                        </td>
                      );

                      const display = c.key === "applied_at" ? fmtDate(raw) : c.key === "apply_mode" ? fmtTool(raw) : raw;
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

                    <td style={{ padding:"8px 14px", fontSize:12, color:theme.text, width:120, whiteSpace:"nowrap" }}>
                      <div style={{ display:"flex", gap:4, alignItems:"center" }}>
                        {/* View ATS */}
                        <button
                          onClick={() => openDetail(rowId, "ats")}
                          disabled={detailLoading}
                          title="View ATS Report"
                          style={{ background:theme.surfaceHigh, border:`1px solid ${theme.border}`,
                                   color:theme.textMuted, cursor:"pointer",
                                   fontSize:10, padding:"3px 8px", borderRadius:4,
                                   fontWeight:700, letterSpacing:"0.04em" }}>
                          ATS
                        </button>
                        {/* View Resume */}
                        <button
                          onClick={() => openDetail(rowId, "resume")}
                          disabled={detailLoading}
                          title="View Resume"
                          style={{ background:theme.surfaceHigh, border:`1px solid ${theme.border}`,
                                   color:theme.textMuted, cursor:"pointer",
                                   fontSize:10, padding:"3px 8px", borderRadius:4,
                                   fontWeight:700, letterSpacing:"0.04em" }}>
                          CV
                        </button>
                        {/* Delete */}
                        <button
                          style={{ background:"transparent", border:"none",
                                   color:theme.textDim, cursor:"pointer",
                                   fontSize:12, padding:"2px 6px", borderRadius:4 }}
                          onMouseEnter={e => { e.currentTarget.style.color = theme.danger; }}
                          onMouseLeave={e => { e.currentTarget.style.color = theme.textDim; }}
                          onClick={() => isApps ? deleteApp(rowId) : deleteResume(rowId)}
                          title="Delete row">✕</button>
                      </div>
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

// ── Pending Apply pane ────────────────────────────────────────
function PendingJobsPane({ jobs, theme, onRefresh, onDislike }) {
  if (jobs.length === 0) return (
    <div style={{ flex:1, display:"flex", flexDirection:"column",
                  alignItems:"center", justifyContent:"center", gap:12, padding:40 }}>
      <div style={{ fontSize:40 }}>📋</div>
      <div style={{ fontWeight:700, color:theme.textMuted, fontSize:14 }}>No pending applications</div>
      <div style={{ fontSize:12, color:theme.textDim, textAlign:"center", maxWidth:320, lineHeight:1.8 }}>
        When you generate a resume for a job it moves here until you apply or pass on it.
      </div>
      <button className="rm-btn rm-btn-secondary rm-btn-sm" onClick={onRefresh}>↻ Refresh</button>
    </div>
  );
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      <div style={{ padding:"8px 16px", display:"flex", alignItems:"center", gap:8,
                    borderBottom:`1px solid ${theme.border}`, flexShrink:0, background:theme.surface }}>
        <span style={{ fontSize:12, color:theme.textMuted }}>
          {jobs.length} pending job{jobs.length !== 1 ? "s" : ""} — resume ready, not yet applied
        </span>
        <div style={{ flex:1 }}/>
        <button className="rm-btn rm-btn-ghost rm-btn-sm" onClick={onRefresh}>↻ Refresh</button>
      </div>
      <div style={{ flex:1, overflowY:"auto",
                    // AE5 moved JobCard's own `margin: "0 16px 8px"` onto its container, because a
                    // per-card margin double-insets a grid cell. This list is not a grid, so it
                    // takes over the exact spacing the card used to carry and looks unchanged.
                    display:"flex", flexDirection:"column", gap:8, padding:"8px 16px 16px" }}>
        {jobs.map(job => {
          const jid = job.job_id || job.jobId;
          return (
            <JobCard
              key={jid}
              job={{ ...job, jobId: jid }}
              theme={theme}
              showApplyButton={true}
              applyMode="SIMPLE"
              onVisit={() => job.url && window.open(job.url, "_blank", "noreferrer")}
              onDislike={() => onDislike?.(jid)}
              onCardClick={() => job.url && window.open(job.url, "_blank", "noreferrer")}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Saved Jobs pane ───────────────────────────────────────────
function SavedJobsPane({ jobs, generated, genLoading, applyMode, planTier, hasResume,
                          theme, onGenerate, onExport, onUnsave, onRefresh }) {

  if (jobs.length === 0) return (
    <div style={{ flex:1, display:"flex", flexDirection:"column",
                  alignItems:"center", justifyContent:"center", gap:12, padding:40 }}>
      <div style={{ fontSize:40 }}>★</div>
      <div style={{ fontWeight:700, color:theme.textMuted, fontSize:14 }}>No saved jobs yet</div>
      <div style={{ fontSize:12, color:theme.textDim, textAlign:"center", maxWidth:300, lineHeight:1.8 }}>
        Star jobs on the Jobs board to save them here. Generate and A+ Resume access is controlled by your plan.
      </div>
      <button className="rm-btn rm-btn-secondary rm-btn-sm" onClick={onRefresh}>↻ Refresh</button>
    </div>
  );

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden",
                  background: `linear-gradient(160deg, ${theme.accentMuted}55 0%, ${theme.bg} 55%)` }}>
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

      {/* card list */}
      <div style={{ flex:1, overflowY:"auto",
                    // AE5 moved JobCard's own `margin: "0 16px 8px"` onto its container, because a
                    // per-card margin double-insets a grid cell. This list is not a grid, so it
                    // takes over the exact spacing the card used to carry and looks unchanged.
                    display:"flex", flexDirection:"column", gap:8, padding:"8px 16px 16px" }}>
        {jobs.map(job => {
          const g    = generated[job.jobId];
          const done = !!g?.html;
          const st   = genLoading[job.jobId] ? "generating" : null;
          return (
            <JobCard
              key={job.jobId}
              job={{ ...job, starred: true }}
              theme={theme}
              showApplyButton={true}
              g={g}
              done={done}
              st={st}
              applyMode={applyMode}
              canUseGenerate={String(planTier || "BASIC").toUpperCase() !== "BASIC"}
              canUseAPlusResume={false}
              onGenerate={() => onGenerate(job, done && g?.html !== "__exists__")}
              onExport={() => done && g?.html !== "__exists__" && onExport(job, g.html)}
              onVisit={() => job.url && window.open(job.url, "_blank", "noreferrer")}
              onStar={() => onUnsave(job.jobId)}
              onCardClick={() => job.url && window.open(job.url, "_blank", "noreferrer")}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * AK1 — the payoff strip: what came back, and whether the score saw it coming.
 *
 * THREE COUNTS, NOT TWO, AND THE THIRD IS THE HONEST ONE. An application sent last week with
 * nothing recorded is UNRESOLVED, not a rejection. Folding it into the denominator is what makes an
 * early response rate read near zero — worst exactly when someone first opens this panel and
 * concludes their resume is broken. So unresolved rows are counted, shown, and excluded.
 *
 * The mean-score comparison is shown only once BOTH sides have enough rows to be worth reading. The
 * threshold is deliberately conservative: this whole feature exists to answer "does the score
 * predict anything", and a difference computed over four applications would answer it confidently
 * and wrongly, which is the failure the engine work was about avoiding in the first place.
 */
function ResponseSummary({ rows, theme }) {
  let responded = 0, silent = 0, unresolved = 0;
  const scoresResponded = [], scoresSilent = [];
  for (const r of rows) {
    const bucket = responseBucket(r);
    const score = r.ats_score_at_apply;
    if (bucket === "responded") { responded++; if (score != null) scoresResponded.push(score); }
    else if (bucket === "silent") { silent++; if (score != null) scoresSilent.push(score); }
    else unresolved++;
  }
  const decided = responded + silent;
  const rate = decided ? Math.round((responded / decided) * 100) : null;
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const mr = mean(scoresResponded), ms = mean(scoresSilent);
  // 8 a side is not statistical significance and is not claimed to be — it is the point below which
  // a delta is visibly meaningless. The server's correlation endpoint holds a stricter bar (20).
  const enough = scoresResponded.length >= 8 && scoresSilent.length >= 8;

  const Stat = ({ label, value, color, title }) => (
    <div title={title} style={{ display:"flex", alignItems:"baseline", gap:6 }}>
      <span style={{ fontSize:15, fontWeight:700, color:color || theme.text, fontFamily:theme.fontMono }}>{value}</span>
      <span style={{ fontSize:10, color:theme.textDim, textTransform:"uppercase", letterSpacing:"0.06em" }}>{label}</span>
    </div>
  );

  return (
    <div style={{ display:"flex", alignItems:"center", gap:20, flexWrap:"wrap",
                  padding:"10px 16px", borderBottom:`1px solid ${theme.border}`,
                  background:theme.surfaceHigh }}>
      <Stat label="replied" value={responded} color={theme.success}
        title="A rejection counts here: something read the application and answered."/>
      <Stat label="no reply" value={silent} color={theme.textMuted}
        title={`Marked as no response, or applied over ${MATURITY_DAYS} days ago with nothing recorded.`}/>
      <Stat label="too recent" value={unresolved} color={theme.textDim}
        title={`Applied less than ${MATURITY_DAYS} days ago with nothing recorded — in no denominator yet.`}/>
      {rate != null && (
        <Stat label="reply rate" value={`${rate}%`} color={theme.accent}
          title={`${responded} of ${decided} resolved applications. Excludes the ${unresolved} too recent to count.`}/>
      )}
      {enough ? (
        <div style={{ marginLeft:"auto", fontSize:11, color:theme.textMuted }}>
          mean ATS at apply:{" "}
          <strong style={{ color:theme.success }}>{mr.toFixed(1)}</strong> when they replied vs{" "}
          <strong style={{ color:theme.textMuted }}>{ms.toFixed(1)}</strong> when they did not
        </div>
      ) : (
        <div style={{ marginLeft:"auto", fontSize:11, color:theme.textDim }}>
          not enough outcomes yet to compare scores
        </div>
      )}
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
