// client/src/pages/admin/DBInspector.jsx — Admin DB diagnostic tool
import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../../lib/api.js";
import { useTheme } from "../../styles/theme.jsx";

const ACCENT = "#F5E642";
const TABS = [
  { id: "scrape",   label: "Scrape Monitor" },
  { id: "schema",   label: "Schema Explorer" },
  { id: "tables",   label: "Table Browser" },
  { id: "pool",     label: "User Pool" },
  { id: "trace",    label: "Job Trace" },
  { id: "simulate", label: "Query Simulator" },
];

// ── Shared helpers ────────────────────────────────────────────
function ago(ts) {
  if (!ts) return "—";
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs/60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs/3600)}h ago`;
  return `${Math.floor(secs/86400)}d ago`;
}
function fmt(n) { return n == null ? "—" : Number(n).toLocaleString(); }
function truncate(s, n=40) { if (!s) return "—"; return s.length > n ? s.slice(0,n)+"…" : s; }

function Pill({ color, children }) {
  return (
    <span style={{
      display:"inline-block", padding:"2px 8px", borderRadius:999,
      fontSize:10, fontWeight:700, background:color+"22", color,
      border:`1px solid ${color}44`, letterSpacing:"0.05em",
    }}>{children}</span>
  );
}

function StatCard({ label, value, sub, accent, theme }) {
  return (
    <div style={{
      background:theme.surface, border:`1px solid ${theme.border}`,
      borderRadius:10, padding:"14px 16px", flex:1, minWidth:120,
    }}>
      <div style={{ fontSize:10, fontWeight:700, textTransform:"uppercase",
                    letterSpacing:"0.07em", color:theme.textMuted, marginBottom:4 }}>{label}</div>
      <div style={{ fontSize:20, fontWeight:900, color: accent || theme.text }}>{value}</div>
      {sub && <div style={{ fontSize:10, color:theme.textMuted, marginTop:2 }}>{sub}</div>}
    </div>
  );
}

function Spinner({ theme }) {
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", padding:40, gap:12 }}>
      <div style={{
        width:20, height:20,
        border:`2px solid ${theme.border}`,
        borderTop:`2px solid ${ACCENT}`,
        borderRadius:"50%", animation:"spin 0.7s linear infinite",
      }}/>
      <span style={{ color:theme.textMuted, fontSize:12 }}>Loading…</span>
    </div>
  );
}

function ErrBox({ msg, theme }) {
  if (!msg) return null;
  return (
    <div style={{ background:"#dc262620", border:"1px solid #dc262644", borderRadius:8,
                  padding:"10px 14px", color:"#dc2626", fontSize:12, margin:"8px 0" }}>
      {msg}
    </div>
  );
}

function KeyValueGrid({ data, theme, highlight }) {
  if (!data) return null;
  return (
    <div style={{ display:"grid", gridTemplateColumns:"160px 1fr", gap:"2px 8px", fontSize:11 }}>
      {Object.entries(data).map(([k, v]) => (
        <div key={k} style={{ display:"contents" }}>
          <div style={{ fontWeight:700, padding:"3px 0",
                        color: highlight?.includes(k) ? ACCENT : theme.textMuted }}>{k}</div>
          <div style={{ padding:"3px 0", wordBreak:"break-all",
                        color: highlight?.includes(k) ? ACCENT : theme.text }}>
            {v == null ? <span style={{color:theme.textMuted}}>NULL</span>
                       : String(v).length > 200 ? String(v).slice(0,200)+"…" : String(v)}
          </div>
        </div>
      ))}
    </div>
  );
}

function SchemaMapView({ theme }) {
  const [graph, setGraph] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 20, y: 20 });
  const [drag, setDrag] = useState(null);

  useEffect(() => {
    api("/api/admin/db/schema/graph").then(setGraph).catch(e => setError(e.message));
  }, []);

  if (error) return <ErrBox msg={error} theme={theme}/>;
  if (!graph) return <Spinner theme={theme}/>;

  const nodeW = 220;
  const colGap = 280;
  const rowGap = 210;
  const positions = {};
  graph.tables.forEach((t, i) => {
    positions[t.name] = {
      x: (i % 4) * colGap,
      y: Math.floor(i / 4) * rowGap,
    };
  });

  const related = new Set();
  if (selected) {
    related.add(selected);
    graph.relationships.forEach(r => {
      if (r.fromTable === selected) related.add(r.toTable);
      if (r.toTable === selected) related.add(r.fromTable);
    });
  }

  const onWheel = (e) => {
    e.preventDefault();
    setScale(s => Math.min(1.8, Math.max(0.45, s + (e.deltaY > 0 ? -0.08 : 0.08))));
  };

  return (
    <div
      onWheel={onWheel}
      onMouseDown={e => setDrag({ x:e.clientX, y:e.clientY, ox:offset.x, oy:offset.y })}
      onMouseMove={e => {
        if (!drag) return;
        setOffset({ x: drag.ox + e.clientX - drag.x, y: drag.oy + e.clientY - drag.y });
      }}
      onMouseUp={() => setDrag(null)}
      onMouseLeave={() => setDrag(null)}
      style={{
        height:"calc(100vh - 290px)", minHeight:460, overflow:"hidden",
        border:`1px solid ${theme.border}`, borderRadius:10, background:theme.surface,
        position:"relative", cursor:drag ? "grabbing" : "grab",
      }}
    >
      <div style={{
        position:"absolute", top:10, right:10, zIndex:3,
        display:"flex", gap:6, alignItems:"center",
      }}>
        <button onClick={() => setScale(s => Math.min(1.8, s + 0.1))}
          style={{ padding:"4px 9px", borderRadius:6, border:`1px solid ${theme.border}`,
                   background:theme.surfaceHigh, color:theme.text, cursor:"pointer" }}>+</button>
        <button onClick={() => setScale(s => Math.max(0.45, s - 0.1))}
          style={{ padding:"4px 9px", borderRadius:6, border:`1px solid ${theme.border}`,
                   background:theme.surfaceHigh, color:theme.text, cursor:"pointer" }}>-</button>
        <button onClick={() => { setScale(1); setOffset({ x:20, y:20 }); }}
          style={{ padding:"4px 9px", borderRadius:6, border:`1px solid ${theme.border}`,
                   background:theme.surfaceHigh, color:theme.text, cursor:"pointer", fontSize:11 }}>Reset</button>
      </div>

      <div style={{
        transform:`translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
        transformOrigin:"0 0", position:"absolute", inset:0,
      }}>
        <svg width="1600" height="1600" style={{ position:"absolute", inset:0, overflow:"visible" }}>
          {graph.relationships.map(r => {
            const a = positions[r.fromTable], b = positions[r.toTable];
            if (!a || !b) return null;
            const active = !selected || related.has(r.fromTable) || related.has(r.toTable);
            return (
              <line key={r.id}
                x1={a.x + nodeW} y1={a.y + 48}
                x2={b.x} y2={b.y + 48}
                stroke={active ? ACCENT : theme.border}
                strokeWidth={active ? 2 : 1}
                opacity={active ? 0.75 : 0.25}
              />
            );
          })}
        </svg>

        {graph.tables.map(t => {
          const p = positions[t.name];
          const active = !selected || related.has(t.name);
          return (
            <div key={t.name}
              onMouseDown={e => e.stopPropagation()}
              onClick={() => setSelected(selected === t.name ? null : t.name)}
              style={{
                position:"absolute", left:p.x, top:p.y, width:nodeW,
                border:`1px solid ${selected === t.name ? ACCENT : theme.border}`,
                borderRadius:8, background:theme.bg, opacity:active ? 1 : 0.35,
                boxShadow:selected === t.name ? `0 0 0 2px ${ACCENT}33` : "none",
                overflow:"hidden", cursor:"pointer",
              }}
            >
              <div style={{
                padding:"8px 10px", background:theme.surfaceHigh,
                borderBottom:`1px solid ${theme.border}`, fontWeight:900, fontSize:12,
                display:"flex", justifyContent:"space-between", gap:8,
              }}>
                <span>{t.name}</span>
                <span style={{ color:theme.textMuted, fontSize:10 }}>{fmt(t.rowCount)}</span>
              </div>
              <div style={{ maxHeight:145, overflow:"hidden", padding:"5px 0" }}>
                {t.columns.slice(0, 8).map(c => (
                  <div key={c.name} style={{
                    display:"grid", gridTemplateColumns:"16px 1fr auto",
                    gap:5, padding:"2px 10px", fontSize:10,
                  }}>
                    <span style={{ color:c.primaryKey ? ACCENT : theme.textMuted }}>{c.primaryKey ? "PK" : ""}</span>
                    <span style={{ color:c.primaryKey ? ACCENT : theme.text }}>{c.name}</span>
                    <span style={{ color:theme.textMuted }}>{c.type || ""}</span>
                  </div>
                ))}
                {t.columns.length > 8 && (
                  <div style={{ padding:"3px 10px", color:theme.textMuted, fontSize:10 }}>
                    +{t.columns.length - 8} more
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Tab 1: Scrape Monitor ────────────────────────────────────
function ScrapeMonitorTab({ theme }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [filterUser, setFilterUser] = useState("");
  const [copied, setCopied] = useState(null); // 'text' | 'html' | null

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({ limit: 50 });
      if (filterUser) params.set("userId", filterUser);
      const d = await api(`/api/admin/db/scrape-monitor?${params}`);
      setData(d);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [filterUser]);

  useEffect(() => { load(); }, [load]);

  const statusLabel = (job) => {
    if (!job.domain_profile_id) return { label:"⚠ No Tag", color:"#d97706" };
    return { label:"✓ Tagged", color:"#16a34a" };
  };

  const s = data?.stats;
  return (
    <div>
      <div style={{ display:"flex", gap:12, alignItems:"center", marginBottom:16, flexWrap:"wrap" }}>
        <span style={{ fontWeight:800, fontSize:14 }}>Last 50 Scraped Jobs</span>
        <div style={{ flex:1 }}/>
        <input
          placeholder="Filter by user ID…"
          value={filterUser}
          onChange={e => setFilterUser(e.target.value)}
          style={{ background:theme.surfaceHigh, border:`1px solid ${theme.border}`,
                   borderRadius:6, padding:"5px 10px", color:theme.text, fontSize:11, width:160 }}
        />
        <button onClick={load}
          style={{ background:ACCENT, color:"#0f0f0f", border:"none", borderRadius:6,
                   padding:"5px 14px", fontWeight:700, fontSize:11, cursor:"pointer" }}>
          Refresh
        </button>
      </div>

      {s && (
        <div style={{ display:"flex", gap:10, marginBottom:16, flexWrap:"wrap" }}>
          <StatCard label="Total Scraped" value={fmt(s.total)} theme={theme}/>
          <StatCard label="With Profile" value={fmt(s.withProfile)} accent="#16a34a" theme={theme}/>
          <StatCard label="No Profile Tag" value={fmt(s.nullProfile)} accent={s.nullProfile > 0 ? "#d97706" : theme.text} theme={theme}/>
          <StatCard label="Avg ATS Score" value={s.avgAtsScore != null ? s.avgAtsScore+"%" : "—"} theme={theme}/>
        </div>
      )}

      {loading && <Spinner theme={theme}/>}
      <ErrBox msg={error} theme={theme}/>

      {data?.jobs?.length > 0 && (
        <div style={{ border:`1px solid ${theme.border}`, borderRadius:10, overflow:"hidden" }}>
          {/* Header */}
          <div style={{
            display:"grid",
            gridTemplateColumns:"2fr 1.5fr 1.5fr 1.5fr 60px 60px 70px",
            padding:"8px 14px", background:theme.surfaceHigh,
            fontSize:10, fontWeight:700, textTransform:"uppercase",
            letterSpacing:"0.06em", color:theme.textMuted,
          }}>
            <div>Title</div><div>Company</div><div>Domain Profile</div>
            <div>Search Query</div><div>ATS</div><div>Age</div><div>Status</div>
          </div>

          {data.jobs.map((job, i) => {
            const st = statusLabel(job);
            const isExp = expanded === job.job_id;
            return (
              <div key={job.job_id}>
                <div
                  onClick={() => setExpanded(isExp ? null : job.job_id)}
                  style={{
                    display:"grid",
                    gridTemplateColumns:"2fr 1.5fr 1.5fr 1.5fr 60px 60px 70px",
                    padding:"9px 14px", cursor:"pointer",
                    background: isExp ? theme.surfaceHigh : i%2===0 ? "transparent" : theme.surface+"80",
                    borderTop:`1px solid ${theme.border}`,
                    transition:"background 0.1s",
                    fontSize:12,
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = theme.surfaceHigh}
                  onMouseLeave={e => e.currentTarget.style.background = isExp ? theme.surfaceHigh : i%2===0 ? "transparent" : theme.surface+"80"}
                >
                  <div style={{ fontWeight:600 }}>{truncate(job.title, 35)}</div>
                  <div style={{ color:theme.textMuted }}>{truncate(job.company, 25)}</div>
                  <div style={{ color:theme.textMuted, fontSize:11 }}>
                    {job.profile_name ? (
                      <span>{truncate(job.profile_name,22)}<br/>
                        <span style={{fontSize:10,color:theme.textDim}}>@{job.profile_owner_username}</span>
                      </span>
                    ) : <span style={{color:"#d97706"}}>—</span>}
                  </div>
                  <div style={{ color:theme.textMuted, fontSize:11 }}>{truncate(job.search_query,28)}</div>
                  <div style={{ color: job.ats_score != null ? (job.ats_score>=70?"#16a34a":job.ats_score>=50?"#d97706":"#dc2626") : theme.textMuted }}>
                    {job.ats_score != null ? job.ats_score+"%" : "—"}
                  </div>
                  <div style={{ color:theme.textMuted, fontSize:11 }}>{ago(job.scraped_at)}</div>
                  <div><Pill color={st.color}>{st.label}</Pill></div>
                </div>

                {isExp && (
                  <div style={{ padding:"16px 20px", background:theme.surfaceHigh,
                                borderTop:`1px solid ${theme.border}` }}>
                    <KeyValueGrid
                      data={(() => {
                        const { description, description_html, description_truncated, ...rest } = job;
                        return rest;
                      })()}
                      theme={theme}
                      highlight={["domain_profile_id","ats_score"]}
                    />

                    {/* Description section */}
                    <div style={{
                      marginTop:16,
                      borderTop:`1px solid ${theme.border}`,
                      paddingTop:12,
                    }}>
                      <div style={{
                        display:"flex", justifyContent:"space-between",
                        alignItems:"center", marginBottom:8,
                      }}>
                        <span style={{
                          fontSize:11, fontWeight:600, textTransform:"uppercase",
                          letterSpacing:"0.08em", color:theme.textMuted,
                        }}>
                          Job Description
                        </span>
                        <div style={{ display:"flex", gap:8 }}>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(job.description || "");
                              setCopied("text");
                              setTimeout(() => setCopied(null), 2000);
                            }}
                            style={{
                              fontSize:11, padding:"3px 10px", borderRadius:6,
                              border:`1px solid ${theme.border}`,
                              background: copied === "text" ? "#4ade8022" : theme.surface,
                              color: copied === "text" ? "#4ade80" : theme.textMuted,
                              cursor:"pointer",
                            }}>
                            {copied === "text" ? "✓ Copied" : "Copy Text"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(job.description_html || "");
                              setCopied("html");
                              setTimeout(() => setCopied(null), 2000);
                            }}
                            style={{
                              fontSize:11, padding:"3px 10px", borderRadius:6,
                              border:`1px solid ${theme.border}`,
                              background: copied === "html" ? "#4ade8022" : theme.surface,
                              color: copied === "html" ? "#4ade80" : theme.textMuted,
                              cursor:"pointer",
                            }}>
                            {copied === "html" ? "✓ Copied" : "Copy HTML"}
                          </button>
                        </div>
                      </div>

                      <div style={{
                        maxHeight:200, overflowY:"auto",
                        fontSize:12, lineHeight:1.6, color:theme.textMuted,
                        background:theme.bg, borderRadius:8,
                        padding:"10px 12px", whiteSpace:"pre-wrap",
                        fontFamily:"monospace",
                        border:`1px solid ${theme.border}`,
                      }}>
                        {job.description
                          ? job.description
                          : <span style={{ color:theme.textDim, fontStyle:"italic" }}>
                              No description available
                            </span>
                        }
                      </div>

                      {job.description_truncated && (
                        <div style={{ fontSize:11, color:"#d97706", marginTop:4 }}>
                          Description truncated at 10,000 chars. Copy button copies full text.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {data?.jobs?.length === 0 && !loading && (
        <div style={{ textAlign:"center", color:theme.textMuted, padding:40 }}>No scraped jobs found.</div>
      )}
    </div>
  );
}

// ── Tab 2: Schema Explorer ───────────────────────────────────
function SchemaExplorerTab({ theme }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [recentRows, setRecentRows] = useState(null);
  const [recentLoading, setRecentLoading] = useState(false);
  const [schemaCopied, setSchemaCopied] = useState(false);
  const [schemaView, setSchemaView] = useState("tables");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await api("/api/admin/db/schema")); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const selectTable = async (t) => {
    setSelected(t); setRecentRows(null); setRecentLoading(true);
    try {
      const rows = await api(`/api/admin/db/table-rows/${t.name}`);
      setRecentRows(rows);
    } catch {}
    setRecentLoading(false);
  };

  if (loading) return <Spinner theme={theme}/>;
  if (error) return <ErrBox msg={error} theme={theme}/>;
  if (!data) return null;

  const fmtBytes = (b) => {
    if (b > 1e6) return (b/1e6).toFixed(1)+" MB";
    if (b > 1e3) return (b/1e3).toFixed(1)+" KB";
    return b+" B";
  };

  const fkCols = new Set((selected?.foreignKeys || []).map(fk => fk.from));

  const fetchSchemaExport = async () => {
    const res = await fetch("/api/admin/db/schema/export", { credentials:"include" });
    return res.json();
  };

  return (
    <div>
    {/* Controls bar */}
    <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:16 }}>
      {["tables","map"].map(v => (
        <button key={v} type="button" onClick={() => setSchemaView(v)}
          style={{
            padding:"6px 14px", borderRadius:8,
            border:`1px solid ${schemaView === v ? ACCENT : theme.border}`,
            background:schemaView === v ? ACCENT : theme.surfaceHigh,
            color:schemaView === v ? "#0f0f0f" : theme.text,
            cursor:"pointer", fontSize:12, fontWeight:700,
          }}>
          {v === "tables" ? "Tables" : "Map View"}
        </button>
      ))}
      <button
        type="button"
        onClick={async () => {
          try {
            const d = await fetchSchemaExport();
            await navigator.clipboard.writeText(d.schema);
            setSchemaCopied(true);
            setTimeout(() => setSchemaCopied(false), 3000);
          } catch(e) { console.error("Schema copy failed:", e); }
        }}
        style={{
          display:"flex", alignItems:"center", gap:6,
          padding:"6px 14px", borderRadius:8,
          border:`1px solid ${schemaCopied ? "#4ade8066" : theme.border}`,
          background: schemaCopied ? "#4ade8018" : theme.surfaceHigh,
          color: schemaCopied ? "#4ade80" : theme.text,
          cursor:"pointer", fontSize:12, fontWeight:600, transition:"all 0.2s",
        }}>
        {schemaCopied ? "✓ Schema Copied!" : "📋 Copy Full Schema"}
      </button>
      <button
        type="button"
        onClick={async () => {
          try {
            const d = await fetchSchemaExport();
            const blob = new Blob([d.schema], { type:"text/plain" });
            const url = URL.createObjectURL(blob);
            Object.assign(document.createElement("a"), {
              href: url,
              download: `resume_master_schema_${new Date().toISOString().slice(0,10)}.sql`,
            }).click();
            URL.revokeObjectURL(url);
          } catch(e) { console.error("Schema download failed:", e); }
        }}
        style={{
          padding:"6px 14px", borderRadius:8,
          border:`1px solid ${theme.border}`,
          background:theme.surfaceHigh, color:theme.text,
          cursor:"pointer", fontSize:12,
        }}>
        ⬇ Download .sql
      </button>
    </div>
    {schemaView === "map" ? <SchemaMapView theme={theme}/> : (
    <div style={{ display:"flex", gap:0, height:"calc(100vh - 260px)", minHeight:400 }}>
      {/* Left sidebar */}
      <div style={{
        width:220, flexShrink:0, borderRight:`1px solid ${theme.border}`,
        overflowY:"auto", paddingRight:0,
      }}>
        <div style={{ padding:"10px 14px", fontSize:10, fontWeight:700, textTransform:"uppercase",
                      letterSpacing:"0.07em", color:theme.textMuted }}>
          Tables ({data.tables.length})
        </div>
        {data.tables.map(t => (
          <div key={t.name}
            onClick={() => selectTable(t)}
            style={{
              display:"flex", justifyContent:"space-between", alignItems:"center",
              padding:"8px 14px", cursor:"pointer",
              background: selected?.name === t.name ? ACCENT+"22" : "transparent",
              borderLeft: selected?.name === t.name ? `3px solid ${ACCENT}` : "3px solid transparent",
              fontSize:12, transition:"all 0.1s",
            }}
            onMouseEnter={e => { if (selected?.name !== t.name) e.currentTarget.style.background = theme.surfaceHigh; }}
            onMouseLeave={e => { if (selected?.name !== t.name) e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ fontWeight:selected?.name===t.name ? 700 : 400, color:theme.text }}>{t.name}</span>
            <span style={{ fontSize:10, color:theme.textMuted, fontWeight:600 }}>{fmt(t.rowCount)}</span>
          </div>
        ))}
        <div style={{ padding:"10px 14px", marginTop:8, borderTop:`1px solid ${theme.border}` }}>
          <div style={{ fontSize:10, color:theme.textMuted, fontWeight:700, textTransform:"uppercase",
                        letterSpacing:"0.07em", marginBottom:4 }}>DB Info</div>
          <div style={{ fontSize:11, color:theme.textMuted }}>
            Size: {fmtBytes(data.dbSizeBytes)}<br/>
            WAL: {data.walMode ? "✓ enabled" : "✗ off"}
          </div>
        </div>
      </div>

      {/* Right panel */}
      <div style={{ flex:1, overflowY:"auto", padding:"0 0 0 20px" }}>
        {!selected ? (
          <div style={{ display:"flex", alignItems:"center", justifyContent:"center",
                        height:"100%", color:theme.textMuted, fontSize:13 }}>
            Select a table to inspect
          </div>
        ) : (
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:16 }}>
              <span style={{ fontSize:16, fontWeight:900 }}>{selected.name}</span>
              <span style={{ fontSize:11, color:theme.textMuted }}>{fmt(selected.rowCount)} rows</span>
              <div style={{ flex:1 }}/>
              <a href={`/api/admin/db/export/${selected.name}`}
                style={{ fontSize:11, color:ACCENT, textDecoration:"none", fontWeight:700 }}>
                Export CSV ↓
              </a>
            </div>

            {/* Columns */}
            <div style={{ marginBottom:20 }}>
              <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase",
                            letterSpacing:"0.07em", color:theme.textMuted, marginBottom:8 }}>Columns</div>
              <div style={{ border:`1px solid ${theme.border}`, borderRadius:8, overflow:"hidden" }}>
                <div style={{
                  display:"grid", gridTemplateColumns:"30px 1.5fr 1fr 60px 80px 50px",
                  padding:"6px 12px", background:theme.surfaceHigh,
                  fontSize:10, fontWeight:700, textTransform:"uppercase",
                  letterSpacing:"0.06em", color:theme.textMuted,
                }}>
                  <div>#</div><div>Name</div><div>Type</div>
                  <div>Not Null</div><div>Default</div><div>PK</div>
                </div>
                {selected.columns.map(col => (
                  <div key={col.cid} style={{
                    display:"grid", gridTemplateColumns:"30px 1.5fr 1fr 60px 80px 50px",
                    padding:"6px 12px", borderTop:`1px solid ${theme.border}`, fontSize:11,
                    background: fkCols.has(col.name) ? ACCENT+"11" : "transparent",
                  }}>
                    <div style={{ color:theme.textMuted }}>{col.cid}</div>
                    <div style={{ fontWeight:600, color: col.pk ? ACCENT : fkCols.has(col.name) ? "#7c3aed" : theme.text }}>
                      {col.name} {col.pk ? "🔑" : ""} {fkCols.has(col.name) ? "🔗" : ""}
                    </div>
                    <div style={{ color:theme.textMuted }}>{col.type || "—"}</div>
                    <div style={{ color: col.notnull ? "#16a34a" : theme.textMuted }}>{col.notnull ? "✓" : "—"}</div>
                    <div style={{ color:theme.textMuted, fontSize:10 }}>{col.dflt_value ?? "—"}</div>
                    <div style={{ color: col.pk ? ACCENT : theme.textMuted }}>{col.pk || "—"}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Indexes */}
            {selected.indexes.length > 0 && (
              <div style={{ marginBottom:20 }}>
                <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase",
                              letterSpacing:"0.07em", color:theme.textMuted, marginBottom:8 }}>
                  Indexes ({selected.indexes.length})
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                  {selected.indexes.map(idx => (
                    <div key={idx.name} style={{
                      display:"flex", gap:10, alignItems:"center", fontSize:11,
                      padding:"5px 10px", background:theme.surfaceHigh, borderRadius:6,
                    }}>
                      {idx.unique && <span style={{ color:ACCENT, fontWeight:700 }}>⚡</span>}
                      <span style={{ fontWeight:600 }}>{idx.name}</span>
                      <span style={{ color:theme.textMuted }}>→ ({idx.columns.join(", ")})</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Foreign Keys */}
            {selected.foreignKeys.length > 0 && (
              <div style={{ marginBottom:20 }}>
                <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase",
                              letterSpacing:"0.07em", color:theme.textMuted, marginBottom:8 }}>
                  Foreign Keys
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                  {selected.foreignKeys.map((fk, i) => (
                    <div key={i} style={{ fontSize:11, padding:"5px 10px",
                                          background:theme.surfaceHigh, borderRadius:6 }}>
                      <span style={{ color:"#7c3aed", fontWeight:600 }}>{fk.from}</span>
                      {" → "}
                      <span style={{ fontWeight:600 }}>{fk.table}.{fk.to}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Recent Rows */}
            <div style={{ marginBottom:20 }}>
              <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase",
                            letterSpacing:"0.07em", color:theme.textMuted, marginBottom:8 }}>
                Recent Rows (last 10)
              </div>
              {recentLoading && <Spinner theme={theme}/>}
              {recentRows?.length > 0 && (() => {
                const cols = Object.keys(recentRows[0]);
                return (
                  <div style={{ overflowX:"auto" }}>
                    <table style={{ width:"100%", borderCollapse:"collapse", fontSize:10 }}>
                      <thead>
                        <tr style={{ background:theme.surfaceHigh }}>
                          {cols.map(c => (
                            <th key={c} style={{ padding:"5px 8px", textAlign:"left",
                                                  color:theme.textMuted, fontWeight:700,
                                                  borderBottom:`1px solid ${theme.border}`,
                                                  whiteSpace:"nowrap" }}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {recentRows.map((row, i) => (
                          <tr key={i} style={{ borderBottom:`1px solid ${theme.border}` }}>
                            {cols.map(c => (
                              <td key={c} style={{ padding:"4px 8px", color:theme.text, fontSize:10,
                                                    maxWidth:200, overflow:"hidden", textOverflow:"ellipsis",
                                                    whiteSpace:"nowrap" }}>
                                {row[c] == null ? <span style={{color:theme.textMuted}}>NULL</span>
                                               : truncate(String(row[c]), 60)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>

            {/* Migration History */}
            {data.migrations.length > 0 && (
              <div style={{ marginBottom:20 }}>
                <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase",
                              letterSpacing:"0.07em", color:theme.textMuted, marginBottom:8 }}>
                  Migration History
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                  {data.migrations.map(m => (
                    <div key={m.id} style={{ display:"flex", gap:12, fontSize:11,
                                             padding:"4px 10px", background:theme.surfaceHigh, borderRadius:5 }}>
                      <span style={{ color:"#16a34a", fontWeight:700 }}>✓</span>
                      <span style={{ fontWeight:600 }}>{m.id}</span>
                      <span style={{ color:theme.textMuted }}>{m.applied_at ? new Date(m.applied_at*1000).toISOString().slice(0,19).replace("T"," ") : "—"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
    )}
    </div>
  );
}

// ── Tab 3: User Pool Inspector ───────────────────────────────
function UserPoolTab({ theme }) {
  const [users, setUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [poolFilter, setPoolFilter] = useState("All");
  const [cleanResult, setCleanResult] = useState(null);
  const [retagResult, setRetagResult] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);

  useEffect(() => {
    api("/api/admin/users").then(d => setUsers(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  const loadPool = useCallback(async (userId) => {
    if (!userId) return;
    setLoading(true); setError(null); setData(null);
    try { setData(await api(`/api/admin/db/user-pool/${userId}`)); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  const cleanPool = async () => {
    if (!selectedUser) return;
    setActionLoading("clean"); setCleanResult(null);
    try { setCleanResult(await api(`/api/admin/db/clean-user-pool/${selectedUser}`, { method:"POST" })); }
    catch (e) { setCleanResult({ error: e.message }); }
    setActionLoading(null);
    loadPool(selectedUser);
  };

  const retagPool = async () => {
    if (!selectedUser) return;
    setActionLoading("retag"); setRetagResult(null);
    try { setRetagResult(await api(`/api/admin/db/retag-user-pool/${selectedUser}`, { method:"POST" })); }
    catch (e) { setRetagResult({ error: e.message }); }
    setActionLoading(null);
    loadPool(selectedUser);
  };

  const filteredJobs = data?.sampleJobs?.filter(j => {
    if (poolFilter === "All") return true;
    if (poolFilter === "Correct") return j.status === "CORRECT";
    if (poolFilter === "Wrong") return j.status !== "CORRECT" && j.status !== "NULL_TAG";
    if (poolFilter === "NULL") return j.status === "NULL_TAG";
    return true;
  }) || [];

  const totalJobs = data?.sampleJobs?.length || 0;
  const correctJobs = data?.sampleJobs?.filter(j => j.status === "CORRECT").length || 0;
  const wrongJobs = data?.sampleJobs?.filter(j => j.status !== "CORRECT").length || 0;

  return (
    <div>
      {/* User selector */}
      <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:20 }}>
        <select value={selectedUser} onChange={e => { setSelectedUser(e.target.value); loadPool(e.target.value); }}
          style={{ background:theme.surfaceHigh, border:`1px solid ${theme.border}`,
                   borderRadius:6, padding:"6px 12px", color:theme.text, fontSize:12, minWidth:240 }}>
          <option value="">Select a user…</option>
          {users.filter(u => !u.is_admin).map(u => (
            <option key={u.id} value={u.id}>{u.username} (id:{u.id})</option>
          ))}
        </select>
        <button onClick={() => loadPool(selectedUser)} disabled={!selectedUser || loading}
          style={{ background:ACCENT, color:"#0f0f0f", border:"none", borderRadius:6,
                   padding:"6px 16px", fontWeight:700, fontSize:11, cursor:"pointer", opacity:!selectedUser?0.5:1 }}>
          Load
        </button>
      </div>

      {loading && <Spinner theme={theme}/>}
      <ErrBox msg={error} theme={theme}/>

      {data && (
        <div style={{ display:"grid", gridTemplateColumns:"280px 1fr", gap:20 }}>
          {/* Left: Profile Summary */}
          <div>
            {data.activeProfile ? (
              <div style={{ border:`1px solid ${ACCENT}44`, borderRadius:10, padding:14, marginBottom:14 }}>
                <div style={{ fontSize:10, fontWeight:700, textTransform:"uppercase",
                              letterSpacing:"0.07em", color:ACCENT, marginBottom:8 }}>Active Profile</div>
                <div style={{ fontWeight:800, fontSize:13, marginBottom:4 }}>{data.activeProfile.profile_name}</div>
                <div style={{ fontSize:11, color:theme.textMuted }}>{data.activeProfile.role_family}</div>
                <div style={{ fontSize:11, color:theme.textMuted }}>{data.activeProfile.domain}</div>
                {data.activeProfile.target_titles && (
                  <div style={{ marginTop:8, display:"flex", flexWrap:"wrap", gap:4 }}>
                    {(() => {
                      try { return JSON.parse(data.activeProfile.target_titles).slice(0,6).map(t => (
                        <Pill key={t} color={ACCENT}>{t}</Pill>
                      )); } catch { return null; }
                    })()}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ border:`1px solid #dc262644`, borderRadius:10, padding:14, marginBottom:14,
                            color:"#dc2626", fontSize:12 }}>No active profile</div>
            )}

            <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase",
                          letterSpacing:"0.07em", color:theme.textMuted, marginBottom:6 }}>All Profiles</div>
            {data.allProfiles.map(p => (
              <div key={p.id} style={{ padding:"6px 10px", borderRadius:6, marginBottom:4,
                                       background: p.is_active ? ACCENT+"22" : theme.surfaceHigh,
                                       fontSize:11 }}>
                <span style={{ fontWeight:600 }}>{p.profile_name}</span>
                {p.is_active && <span style={{ marginLeft:6, color:ACCENT, fontSize:10, fontWeight:700 }}>ACTIVE</span>}
                <br/>
                <span style={{ color:theme.textMuted }}>{p.role_family}</span>
              </div>
            ))}

            {data.searches.length > 0 && (
              <>
                <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase",
                              letterSpacing:"0.07em", color:theme.textMuted, margin:"12px 0 6px" }}>
                  Search Queries
                </div>
                {data.searches.map((s, i) => (
                  <div key={i} style={{ fontSize:11, padding:"4px 10px", background:theme.surfaceHigh,
                                         borderRadius:5, marginBottom:3 }}>
                    <span style={{ fontWeight:600 }}>{s.search_query}</span>
                    <span style={{ color:theme.textMuted, float:"right" }}>{ago(s.last_scraped_at)}</span>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Right: Pool Analysis */}
          <div>
            <div style={{ display:"flex", gap:10, marginBottom:16, flexWrap:"wrap" }}>
              <StatCard label="Total in Pool" value={fmt(totalJobs)} theme={theme}/>
              <StatCard label="Correct" value={fmt(correctJobs)} accent="#16a34a" theme={theme}/>
              <StatCard label="Wrong / NULL" value={fmt(wrongJobs)} accent={wrongJobs > 0 ? "#dc2626" : theme.text} theme={theme}/>
            </div>

            {/* Filter pills */}
            <div style={{ display:"flex", gap:6, marginBottom:12 }}>
              {["All","Correct","Wrong","NULL"].map(f => (
                <button key={f} onClick={() => setPoolFilter(f)}
                  style={{
                    padding:"3px 12px", borderRadius:999, border:`1px solid ${poolFilter===f ? ACCENT : theme.border}`,
                    background: poolFilter===f ? ACCENT : "transparent",
                    color: poolFilter===f ? "#0f0f0f" : theme.text,
                    fontSize:11, fontWeight:700, cursor:"pointer",
                  }}>{f}</button>
              ))}
            </div>

            <div style={{ border:`1px solid ${theme.border}`, borderRadius:10, overflow:"hidden", marginBottom:16 }}>
              <div style={{
                display:"grid", gridTemplateColumns:"2fr 1.5fr 1.5fr 80px",
                padding:"7px 12px", background:theme.surfaceHigh,
                fontSize:10, fontWeight:700, textTransform:"uppercase",
                letterSpacing:"0.06em", color:theme.textMuted,
              }}>
                <div>Title</div><div>Company</div><div>Tagged Profile</div><div>Status</div>
              </div>
              {filteredJobs.slice(0,50).map((job, i) => {
                const statusColor = job.status === "CORRECT" ? "#16a34a"
                  : job.status === "NULL_TAG" ? "#d97706" : "#dc2626";
                const statusLabel = job.status === "CORRECT" ? "✓ Correct"
                  : job.status === "NULL_TAG" ? "⚠ NULL" : "✗ Wrong";
                return (
                  <div key={i} style={{
                    display:"grid", gridTemplateColumns:"2fr 1.5fr 1.5fr 80px",
                    padding:"7px 12px", borderTop:`1px solid ${theme.border}`, fontSize:11,
                  }}>
                    <div style={{ fontWeight:600 }}>{truncate(job.title,32)}</div>
                    <div style={{ color:theme.textMuted }}>{truncate(job.company,24)}</div>
                    <div style={{ color:theme.textMuted, fontSize:10 }}>{job.tagged_to_profile || "—"}</div>
                    <div><Pill color={statusColor}>{statusLabel}</Pill></div>
                  </div>
                );
              })}
              {filteredJobs.length === 0 && (
                <div style={{ padding:"20px", textAlign:"center", color:theme.textMuted, fontSize:12 }}>
                  No jobs in this category.
                </div>
              )}
            </div>

            {/* Utility buttons */}
            <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
              <button onClick={cleanPool} disabled={!selectedUser || actionLoading === "clean"}
                style={{ background:"#dc262620", color:"#dc2626", border:"1px solid #dc262644",
                         borderRadius:6, padding:"7px 16px", fontSize:11, fontWeight:700, cursor:"pointer" }}>
                {actionLoading==="clean" ? "Cleaning…" : "🧹 Clean Pool"}
              </button>
              <button onClick={retagPool} disabled={!selectedUser || actionLoading === "retag"}
                style={{ background:ACCENT+"22", color:ACCENT, border:`1px solid ${ACCENT}44`,
                         borderRadius:6, padding:"7px 16px", fontSize:11, fontWeight:700, cursor:"pointer" }}>
                {actionLoading==="retag" ? "Retagging…" : "🏷 Re-tag Pool"}
              </button>
            </div>
            {cleanResult && (
              <div style={{ marginTop:8, fontSize:11, color:"#16a34a" }}>
                {cleanResult.error ? <span style={{color:"#dc2626"}}>{cleanResult.error}</span>
                : `Removed ${cleanResult.removed} jobs, preserved ${cleanResult.preserved} applied.`}
              </div>
            )}
            {retagResult && (
              <div style={{ marginTop:8, fontSize:11, color:"#16a34a" }}>
                {retagResult.error ? <span style={{color:"#dc2626"}}>{retagResult.error}</span>
                : `Tagged ${retagResult.tagged} jobs, ${retagResult.stillNull} still untagged.`}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tab 4: Job Trace ─────────────────────────────────────────
function JobTraceTab({ theme, initialJobId }) {
  const [jobId, setJobId] = useState(initialJobId || "");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const trace = async () => {
    if (!jobId.trim()) return;
    setLoading(true); setError(null); setData(null);
    try { setData(await api(`/api/admin/db/job-trace/${encodeURIComponent(jobId.trim())}`)); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const d = data?.diagnosis;
  return (
    <div>
      <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:20 }}>
        <input
          value={jobId} onChange={e => setJobId(e.target.value)}
          onKeyDown={e => e.key === "Enter" && trace()}
          placeholder="Enter Job ID…"
          style={{ background:theme.surfaceHigh, border:`1px solid ${theme.border}`,
                   borderRadius:6, padding:"7px 12px", color:theme.text, fontSize:12, width:360 }}
        />
        <button onClick={trace} disabled={!jobId.trim() || loading}
          style={{ background:ACCENT, color:"#0f0f0f", border:"none", borderRadius:6,
                   padding:"7px 20px", fontWeight:700, fontSize:12, cursor:"pointer" }}>
          {loading ? "Tracing…" : "Trace"}
        </button>
      </div>

      <ErrBox msg={error} theme={theme}/>
      {loading && <Spinner theme={theme}/>}

      {data && (
        <>
          {/* Job header */}
          <div style={{ background:theme.surfaceHigh, borderRadius:10, padding:14,
                        marginBottom:16, display:"flex", gap:16, alignItems:"flex-start" }}>
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:900, fontSize:15 }}>{data.scraped_job.title}</div>
              <div style={{ color:theme.textMuted, fontSize:12, marginTop:2 }}>
                {data.scraped_job.company} · {data.scraped_job.location}
              </div>
              <div style={{ display:"flex", gap:8, marginTop:8, flexWrap:"wrap" }}>
                {data.scraped_job.employment_type && <Pill color="#7c3aed">{data.scraped_job.employment_type}</Pill>}
                {data.scraped_job.work_type && <Pill color="#0ea5e9">{data.scraped_job.work_type}</Pill>}
                {data.scraped_job.ats_score != null && (
                  <Pill color={data.scraped_job.ats_score>=70?"#16a34a":data.scraped_job.ats_score>=50?"#d97706":"#dc2626"}>
                    ATS {data.scraped_job.ats_score}%
                  </Pill>
                )}
              </div>
            </div>
          </div>

          {/* 2x2 grid of cards */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14 }}>

            {/* Card 1: scraped_jobs row */}
            <div style={{ border:`1px solid ${theme.border}`, borderRadius:10, padding:14 }}>
              <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase",
                            letterSpacing:"0.07em", color:theme.textMuted, marginBottom:10 }}>
                scraped_jobs row
              </div>
              <div style={{ marginBottom:8 }}>
                <span style={{ fontSize:10, color:theme.textMuted }}>domain_profile_id: </span>
                <Pill color={data.scraped_job.domain_profile_id ? "#16a34a" : "#dc2626"}>
                  {data.scraped_job.domain_profile_id ?? "NULL"}
                </Pill>
              </div>
              {data.role_mappings?.length > 0 && (
                <div style={{ marginBottom:8, display:"flex", gap:5, flexWrap:"wrap" }}>
                  {data.role_mappings.map(r => (
                    <Pill key={r.role_key} color={ACCENT}>{r.role_key}</Pill>
                  ))}
                </div>
              )}
              <KeyValueGrid
                data={{
                  job_id: data.scraped_job.job_id,
                  title: data.scraped_job.title,
                  company: data.scraped_job.company,
                  search_query: data.scraped_job.search_query,
                  source_platform: data.scraped_job.source_platform,
                  employment_type: data.scraped_job.employment_type,
                  scraped_at: data.scraped_job.scraped_at ? ago(data.scraped_job.scraped_at) : "—",
                  ats_score: data.scraped_job.ats_score,
                  ghost_score: data.scraped_job.ghost_score,
                }}
                theme={theme}
                highlight={["domain_profile_id"]}
              />
            </div>

            {/* Card 2: user_jobs rows */}
            <div style={{ border:`1px solid ${theme.border}`, borderRadius:10, padding:14 }}>
              <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase",
                            letterSpacing:"0.07em", color:theme.textMuted, marginBottom:10 }}>
                user_jobs ({data.user_jobs.length} users)
              </div>
              {data.user_jobs.length === 0 && (
                <div style={{ color:theme.textMuted, fontSize:12 }}>No user_jobs rows for this job.</div>
              )}
              {data.user_jobs.map((uj, i) => (
                <div key={i} style={{ background:theme.surfaceHigh, borderRadius:7, padding:"8px 10px",
                                       marginBottom:6, fontSize:11 }}>
                  <div style={{ fontWeight:700, marginBottom:4 }}>@{uj.username}</div>
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                    <Pill color={uj.applied?"#16a34a":"#6b7280"}>{uj.applied?"Applied":"Not applied"}</Pill>
                    {uj.disliked ? <Pill color="#dc2626">Disliked</Pill> : null}
                    {uj.starred ? <Pill color={ACCENT}>Starred</Pill> : null}
                    <Pill color={uj.domain_profile_id===data.scraped_job.domain_profile_id?"#16a34a":"#dc2626"}>
                      profile:{uj.domain_profile_id ?? "NULL"}
                    </Pill>
                  </div>
                </div>
              ))}
            </div>

            {/* Card 3: Resumes & Applications */}
            <div style={{ border:`1px solid ${theme.border}`, borderRadius:10, padding:14 }}>
              <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase",
                            letterSpacing:"0.07em", color:theme.textMuted, marginBottom:10 }}>
                Resumes & Applications
              </div>
              {data.resumes.length === 0 && data.applications.length === 0 && (
                <div style={{ color:theme.textMuted, fontSize:12 }}>None generated or submitted.</div>
              )}
              {data.resumes.map((r, i) => (
                <div key={i} style={{ background:theme.surfaceHigh, borderRadius:6, padding:"6px 10px",
                                       marginBottom:4, fontSize:11 }}>
                  Resume generated — ATS: {r.ats_score ?? "—"}
                </div>
              ))}
              {data.applications.map((a, i) => (
                <div key={i} style={{ background:"#16a34a11", border:"1px solid #16a34a33",
                                       borderRadius:6, padding:"6px 10px", marginBottom:4, fontSize:11 }}>
                  Applied by @{a.username} — {a.applied_at ? new Date(a.applied_at*1000).toISOString().slice(0,10) : "—"}
                </div>
              ))}
            </div>

            {/* Card 4: Diagnosis */}
            <div style={{
              border:`1px solid ${d?.isCorrectlyIsolated ? "#16a34a" : "#dc2626"}44`,
              background: d?.isCorrectlyIsolated ? "#16a34a08" : "#dc262608",
              borderRadius:10, padding:14,
            }}>
              <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase",
                            letterSpacing:"0.07em", color:theme.textMuted, marginBottom:10 }}>
                Diagnosis
              </div>
              {d?.isCorrectlyIsolated ? (
                <div style={{ color:"#16a34a", fontWeight:700, marginBottom:8 }}>
                  ✓ Correctly tagged to "{data.domain_profile?.profile_name}" owned by @{d.profileOwner}
                </div>
              ) : (
                <div style={{ color:"#dc2626", fontWeight:700, marginBottom:8 }}>
                  ✗ {d?.hasProfile ? "Profile isolation issue" : "No domain profile tag"}
                </div>
              )}

              {d?.usersWithJob?.length > 0 && (
                <div style={{ fontSize:11, color:theme.textMuted, marginBottom:8 }}>
                  Appears in pools of: {d.usersWithJob.map(u => `@${u}`).join(", ")}
                </div>
              )}

              {d?.issues?.length > 0 && (
                <div>
                  <div style={{ fontSize:11, fontWeight:700, color:"#dc2626", marginBottom:4 }}>Issues:</div>
                  {d.issues.map((issue, i) => (
                    <div key={i} style={{ fontSize:11, color:"#dc2626", padding:"3px 0",
                                          borderLeft:"2px solid #dc2626", paddingLeft:8, marginBottom:4 }}>
                      {issue}
                    </div>
                  ))}
                </div>
              )}

              {data.domain_profile && (
                <div style={{ marginTop:10, fontSize:11, color:theme.textMuted }}>
                  Profile owner: @{data.domain_profile.owner_username}<br/>
                  Profile: {data.domain_profile.profile_name}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Tab 5: Query Simulator ───────────────────────────────────
function QuerySimulatorTab({ theme }) {
  const [users, setUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showSql, setShowSql] = useState(false);
  const [rawSql, setRawSql] = useState("SELECT * FROM scraped_jobs ORDER BY scraped_at DESC LIMIT 10;");
  const [rawResults, setRawResults] = useState(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawError, setRawError] = useState(null);

  useEffect(() => {
    api("/api/admin/users").then(d => setUsers(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  const simulate = async () => {
    if (!selectedUser) return;
    setLoading(true); setError(null); setData(null);
    try { setData(await api(`/api/admin/db/simulate-jobs/${selectedUser}`)); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const runRawQuery = async () => {
    if (!rawSql.trim()) return;
    setRawLoading(true); setRawError(null); setRawResults(null);
    try { setRawResults(await api(`/api/admin/db/raw-query?sql=${encodeURIComponent(rawSql)}`)); }
    catch (e) { setRawError(e.message); }
    finally { setRawLoading(false); }
  };

  const REASON_COLORS = {
    wrong_profile:"#dc2626", applied:"#16a34a",
    disliked:"#d97706", too_old:"#6b7280", resume_generated:"#7c3aed",
  };

  return (
    <div>
      {/* User selector */}
      <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:20 }}>
        <select value={selectedUser} onChange={e => setSelectedUser(e.target.value)}
          style={{ background:theme.surfaceHigh, border:`1px solid ${theme.border}`,
                   borderRadius:6, padding:"6px 12px", color:theme.text, fontSize:12, minWidth:240 }}>
          <option value="">Select a user to simulate…</option>
          {users.filter(u => !u.is_admin).map(u => (
            <option key={u.id} value={u.id}>{u.username} (id:{u.id})</option>
          ))}
        </select>
        <button onClick={simulate} disabled={!selectedUser || loading}
          style={{ background:ACCENT, color:"#0f0f0f", border:"none", borderRadius:6,
                   padding:"6px 20px", fontWeight:700, fontSize:12, cursor:"pointer",
                   opacity:!selectedUser?0.5:1 }}>
          {loading ? "Simulating…" : "Simulate"}
        </button>
      </div>

      <ErrBox msg={error} theme={theme}/>
      {loading && <Spinner theme={theme}/>}

      {data && (
        <>
          {/* Summary cards */}
          <div style={{ display:"flex", gap:10, marginBottom:16, flexWrap:"wrap" }}>
            <StatCard label="Active Profile" value={data.activeProfile?.profile_name || "None"}
              theme={theme} accent={data.activeProfile ? ACCENT : "#dc2626"}/>
            <StatCard label="Jobs in Pool" value={fmt(data.totalJobsInPool)} theme={theme}/>
            <StatCard label="Would Show" value={fmt(data.jobsPassingAllFilters)}
              accent="#16a34a" theme={theme}/>
            <StatCard label="Session Sync Adds" value={fmt(data.sessionSyncWouldAdd)}
              accent="#7c3aed" theme={theme}/>
            <StatCard label="Filtered Out"
              value={fmt(data.totalJobsInPool - data.jobsPassingAllFilters)}
              accent="#dc2626" theme={theme}/>
          </div>

          {/* Conditions */}
          <div style={{ marginBottom:16 }}>
            <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase",
                          letterSpacing:"0.07em", color:theme.textMuted, marginBottom:8 }}>
              WHERE Conditions Applied
            </div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
              {data.conditions.map((c, i) => (
                <span key={i} style={{
                  padding:"3px 10px", borderRadius:999, fontSize:10, fontWeight:700,
                  background:ACCENT+"22", color:ACCENT, border:`1px solid ${ACCENT}44`,
                }}>
                  {c}
                </span>
              ))}
            </div>
          </div>

          {/* Filter reason breakdown */}
          {Object.keys(data.filterReasonCounts).length > 0 && (
            <div style={{ marginBottom:16, display:"flex", gap:8, flexWrap:"wrap" }}>
              <div style={{ fontSize:11, fontWeight:700, color:theme.textMuted, alignSelf:"center" }}>
                Filtered reasons:
              </div>
              {Object.entries(data.filterReasonCounts).map(([reason, count]) => (
                <Pill key={reason} color={REASON_COLORS[reason] || "#6b7280"}>
                  {reason}: {count}
                </Pill>
              ))}
            </div>
          )}

          {/* Two-column table */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:16 }}>
            {/* Would Show */}
            <div>
              <div style={{ fontSize:11, fontWeight:700, color:"#16a34a", marginBottom:8 }}>
                Would Show ({data.jobsPassingAllFilters})
              </div>
              <div style={{ border:"1px solid #16a34a44", borderRadius:8, overflow:"hidden" }}>
                <div style={{ display:"grid", gridTemplateColumns:"2fr 1.5fr 50px",
                              padding:"6px 10px", background:"#16a34a11",
                              fontSize:10, fontWeight:700, color:theme.textMuted,
                              textTransform:"uppercase", letterSpacing:"0.06em" }}>
                  <div>Title</div><div>Company</div><div>ATS</div>
                </div>
                {data.sampleResults.map((job, i) => (
                  <div key={i} style={{
                    display:"grid", gridTemplateColumns:"2fr 1.5fr 50px",
                    padding:"6px 10px", borderTop:"1px solid #16a34a22", fontSize:11,
                  }}>
                    <div style={{ fontWeight:600 }}>{truncate(job.title,28)}</div>
                    <div style={{ color:theme.textMuted }}>{truncate(job.company,20)}</div>
                    <div style={{ color:job.ats_score>=70?"#16a34a":job.ats_score>=50?"#d97706":"#dc2626" }}>
                      {job.ats_score != null ? job.ats_score+"%" : "—"}
                    </div>
                  </div>
                ))}
                {data.sampleResults.length === 0 && (
                  <div style={{ padding:"16px", textAlign:"center", color:"#16a34a", fontSize:12 }}>
                    No jobs would show.
                  </div>
                )}
              </div>
            </div>

            {/* Filtered Out */}
            <div>
              <div style={{ fontSize:11, fontWeight:700, color:"#dc2626", marginBottom:8 }}>
                Filtered Out (sample)
              </div>
              <div style={{ border:"1px solid #dc262644", borderRadius:8, overflow:"hidden" }}>
                <div style={{ display:"grid", gridTemplateColumns:"2fr 1.5fr 90px",
                              padding:"6px 10px", background:"#dc262611",
                              fontSize:10, fontWeight:700, color:theme.textMuted,
                              textTransform:"uppercase", letterSpacing:"0.06em" }}>
                  <div>Title</div><div>Company</div><div>Reason</div>
                </div>
                {data.sampleFiltered.map((job, i) => (
                  <div key={i} style={{
                    display:"grid", gridTemplateColumns:"2fr 1.5fr 90px",
                    padding:"6px 10px", borderTop:"1px solid #dc262622", fontSize:11,
                  }}>
                    <div style={{ fontWeight:600 }}>{truncate(job.title,28)}</div>
                    <div style={{ color:theme.textMuted }}>{truncate(job.company,20)}</div>
                    <Pill color={REASON_COLORS[job.filterReason]||"#6b7280"}>{job.filterReason}</Pill>
                  </div>
                ))}
                {data.sampleFiltered.length === 0 && (
                  <div style={{ padding:"16px", textAlign:"center", color:theme.textMuted, fontSize:12 }}>
                    No filtered jobs.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Raw SQL panel */}
          <div style={{ border:`1px solid ${theme.border}`, borderRadius:10, overflow:"hidden", marginBottom:24 }}>
            <button
              onClick={() => setShowSql(!showSql)}
              style={{ width:"100%", textAlign:"left", padding:"10px 14px",
                       background:theme.surfaceHigh, border:"none", cursor:"pointer",
                       color:theme.text, fontSize:11, fontWeight:700 }}>
              {showSql ? "▾" : "▸"} Raw SQL Query
            </button>
            {showSql && (
              <div style={{ padding:14 }}>
                <pre style={{ background:"#0f0f0f", color:"#e5e7eb", padding:14, borderRadius:8,
                              fontSize:11, overflowX:"auto", margin:0, lineHeight:1.5 }}>
                  {data.rawSql}
                </pre>
                <button
                  onClick={() => navigator.clipboard.writeText(data.rawSql)}
                  style={{ marginTop:8, background:ACCENT, color:"#0f0f0f", border:"none",
                           borderRadius:6, padding:"4px 14px", fontSize:11, fontWeight:700, cursor:"pointer" }}>
                  Copy SQL
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* Raw Query Sandbox — always visible */}
      <div style={{ border:`1px solid ${theme.border}`, borderRadius:10, padding:16 }}>
        <div style={{ fontSize:12, fontWeight:800, marginBottom:4 }}>Raw Query Sandbox</div>
        <div style={{ fontSize:11, color:"#d97706", marginBottom:10 }}>
          SELECT queries only — max 200 rows returned
        </div>
        <textarea
          value={rawSql}
          onChange={e => setRawSql(e.target.value)}
          rows={4}
          style={{
            width:"100%", boxSizing:"border-box",
            background:"#0f0f0f", color:"#e5e7eb",
            border:`1px solid ${theme.border}`, borderRadius:8,
            padding:"10px 12px", fontSize:12, fontFamily:"monospace",
            lineHeight:1.5, resize:"vertical", marginBottom:8,
          }}
        />
        <div style={{ display:"flex", gap:8, marginBottom:12 }}>
          <button onClick={runRawQuery} disabled={rawLoading}
            style={{ background:ACCENT, color:"#0f0f0f", border:"none", borderRadius:6,
                     padding:"6px 18px", fontWeight:700, fontSize:11, cursor:"pointer" }}>
            {rawLoading ? "Running…" : "Run"}
          </button>
          {rawResults && (
            <button onClick={() => {
              if (!rawResults.rows?.length) return;
              const cols = rawResults.columns;
              const csv = [cols.join(","), ...rawResults.rows.map(r => cols.map(c => {
                const v = r[c]; if (v==null) return "";
                const s = String(v);
                return (s.includes(",") || s.includes('"') || s.includes("\n")) ? `"${s.replace(/"/g,'""')}"` : s;
              }).join(","))].join("\n");
              const blob = new Blob([csv], { type:"text/csv" });
              const url = URL.createObjectURL(blob);
              Object.assign(document.createElement("a"), { href:url, download:"query_results.csv" }).click();
              URL.revokeObjectURL(url);
            }}
              style={{ background:"transparent", color:ACCENT, border:`1px solid ${ACCENT}44`,
                       borderRadius:6, padding:"6px 18px", fontWeight:700, fontSize:11, cursor:"pointer" }}>
              Export CSV
            </button>
          )}
        </div>

        <ErrBox msg={rawError} theme={theme}/>

        {rawResults && (
          <div>
            <div style={{ fontSize:11, color:theme.textMuted, marginBottom:8 }}>
              {rawResults.count} row{rawResults.count !== 1 ? "s" : ""} returned
            </div>
            {rawResults.rows?.length > 0 && (
              <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:10 }}>
                  <thead>
                    <tr style={{ background:theme.surfaceHigh }}>
                      {rawResults.columns.map(c => (
                        <th key={c} style={{ padding:"5px 8px", textAlign:"left", color:theme.textMuted,
                                             fontWeight:700, borderBottom:`1px solid ${theme.border}`,
                                             whiteSpace:"nowrap" }}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rawResults.rows.map((row, i) => (
                      <tr key={i} style={{ borderBottom:`1px solid ${theme.border}` }}>
                        {rawResults.columns.map(c => (
                          <td key={c} style={{ padding:"4px 8px", color:theme.text, fontSize:10,
                                               maxWidth:200, overflow:"hidden", textOverflow:"ellipsis",
                                               whiteSpace:"nowrap" }}>
                            {row[c] == null ? <span style={{color:theme.textMuted}}>NULL</span>
                                            : truncate(String(row[c]), 60)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main DBInspector ──────────────────────────────────────────
function TableBrowserTab({ theme }) {
  const [tables, setTables] = useState([]);
  const [selected, setSelected] = useState("");
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api("/api/admin/db/tables").then(d => {
      const list = d.tables || [];
      setTables(list);
      if (list.length && !selected) setSelected(list[0].name);
    }).catch(e => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setLoading(true); setError(null);
    api(`/api/admin/db/table-data/${selected}?page=${page}&pageSize=25`)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [selected, page]);

  const cols = data?.columns?.map(c => c.name) || [];

  return (
    <div style={{ display:"grid", gridTemplateColumns:"240px 1fr", gap:18 }}>
      <div style={{ border:`1px solid ${theme.border}`, borderRadius:10, overflow:"hidden" }}>
        <div style={{ padding:"10px 12px", background:theme.surfaceHigh,
                      fontSize:10, fontWeight:800, textTransform:"uppercase",
                      letterSpacing:"0.07em", color:theme.textMuted }}>
          Tables
        </div>
        <div style={{ maxHeight:"calc(100vh - 250px)", overflowY:"auto" }}>
          {tables.map(t => (
            <button key={t.name}
              onClick={() => { setSelected(t.name); setPage(1); }}
              style={{
                width:"100%", display:"flex", justifyContent:"space-between",
                padding:"8px 12px", border:"none", borderTop:`1px solid ${theme.border}`,
                background:selected === t.name ? ACCENT+"22" : "transparent",
                color:theme.text, cursor:"pointer", textAlign:"left", fontSize:12,
              }}>
              <span style={{ fontWeight:selected === t.name ? 800 : 500 }}>{t.name}</span>
              <span style={{ color:theme.textMuted }}>{fmt(t.rowCount)}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
          <div>
            <div style={{ fontSize:18, fontWeight:900 }}>{selected || "Select a table"}</div>
            {data && <div style={{ fontSize:11, color:theme.textMuted }}>
              {fmt(data.total)} rows · page {data.page} of {data.totalPages || 1}
            </div>}
          </div>
          <div style={{ flex:1 }}/>
          <button disabled={!data || page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}
            style={{ padding:"5px 12px", borderRadius:6, border:`1px solid ${theme.border}`,
                     background:theme.surfaceHigh, color:theme.text, cursor:"pointer",
                     opacity:!data || page <= 1 ? 0.5 : 1 }}>
            Prev
          </button>
          <button disabled={!data || page >= data.totalPages} onClick={() => setPage(p => p + 1)}
            style={{ padding:"5px 12px", borderRadius:6, border:`1px solid ${theme.border}`,
                     background:theme.surfaceHigh, color:theme.text, cursor:"pointer",
                     opacity:!data || page >= data.totalPages ? 0.5 : 1 }}>
            Next
          </button>
        </div>

        <ErrBox msg={error} theme={theme}/>
        {loading && <Spinner theme={theme}/>}
        {data && !loading && (
          <div style={{ border:`1px solid ${theme.border}`, borderRadius:10, overflow:"auto",
                        maxHeight:"calc(100vh - 245px)" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
              <thead>
                <tr style={{ background:theme.surfaceHigh, position:"sticky", top:0 }}>
                  {cols.map(c => (
                    <th key={c} style={{ padding:"7px 9px", textAlign:"left",
                                         borderBottom:`1px solid ${theme.border}`,
                                         color:theme.textMuted, whiteSpace:"nowrap" }}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, i) => (
                  <tr key={i} style={{ borderBottom:`1px solid ${theme.border}` }}>
                    {cols.map(c => (
                      <td key={c} style={{ padding:"6px 9px", maxWidth:260,
                                           whiteSpace:"nowrap", overflow:"hidden",
                                           textOverflow:"ellipsis", color:theme.text }}>
                        {row[c] == null ? <span style={{ color:theme.textMuted }}>NULL</span> : String(row[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default function DBInspector() {
  const { theme } = useTheme();
  const [activeTab, setActiveTab] = useState("scrape");
  const [lastUpdated, setLastUpdated] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const refreshTimerRef = useRef(null);
  const [traceJobId, setTraceJobId] = useState(null);

  useEffect(() => {
    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    if (autoRefresh > 0) {
      refreshTimerRef.current = setInterval(() => {
        setRefreshKey(k => k+1);
        setLastUpdated(new Date().toLocaleTimeString());
      }, autoRefresh * 1000);
    }
    return () => { if (refreshTimerRef.current) clearInterval(refreshTimerRef.current); };
  }, [autoRefresh]);

  const doRefresh = () => {
    setRefreshKey(k => k+1);
    setLastUpdated(new Date().toLocaleTimeString());
  };

  return (
    <div style={{
      fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13,
      background:theme.bg, minHeight:"calc(100vh - 56px)", color:theme.text,
      padding:"20px 24px",
    }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Global controls */}
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:20, flexWrap:"wrap" }}>
        <a href="/admin"
          style={{ fontSize:12, color:theme.textMuted, textDecoration:"none", fontWeight:600,
                   display:"flex", alignItems:"center", gap:4 }}>
          ← Admin Dashboard
        </a>
        <div style={{ flex:1 }}/>
        {lastUpdated && (
          <span style={{ fontSize:11, color:theme.textMuted }}>Updated: {lastUpdated}</span>
        )}
        <div style={{ display:"flex", gap:4 }}>
          {[{v:0,l:"Off"},{v:30,l:"30s"},{v:60,l:"60s"}].map(({v,l}) => (
            <button key={v} onClick={() => setAutoRefresh(v)}
              style={{
                padding:"3px 10px", borderRadius:999, fontSize:10, fontWeight:700, cursor:"pointer",
                border:`1px solid ${autoRefresh===v ? ACCENT : theme.border}`,
                background: autoRefresh===v ? ACCENT : "transparent",
                color: autoRefresh===v ? "#0f0f0f" : theme.textMuted,
              }}>{l}</button>
          ))}
        </div>
        <button onClick={doRefresh}
          style={{ background:ACCENT, color:"#0f0f0f", border:"none", borderRadius:6,
                   padding:"5px 14px", fontWeight:700, fontSize:11, cursor:"pointer" }}>
          Refresh
        </button>
      </div>

      {/* Tab bar */}
      <div style={{
        display:"flex", gap:0, borderBottom:`1px solid ${theme.border}`, marginBottom:24,
      }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            style={{
              background:"transparent", border:"none", cursor:"pointer",
              padding:"10px 18px", fontSize:12, fontWeight:800, letterSpacing:"0.05em",
              textTransform:"uppercase", color: activeTab===t.id ? theme.text : theme.textMuted,
              borderBottom: activeTab===t.id ? `2px solid ${ACCENT}` : "2px solid transparent",
              transition:"all 0.15s", position:"relative", top:1,
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div key={refreshKey}>
        {activeTab === "scrape" && <ScrapeMonitorTab theme={theme}/>}
        {activeTab === "schema" && <SchemaExplorerTab theme={theme}/>}
        {activeTab === "tables" && <TableBrowserTab theme={theme}/>}
        {activeTab === "pool" && <UserPoolTab theme={theme}/>}
        {activeTab === "trace" && <JobTraceTab theme={theme} initialJobId={traceJobId}/>}
        {activeTab === "simulate" && <QuerySimulatorTab theme={theme}/>}
      </div>
    </div>
  );
}
