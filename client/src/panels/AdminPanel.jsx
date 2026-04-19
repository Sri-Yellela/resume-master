// client/src/panels/AdminPanel.jsx — Lucy Brand (yellow accent)
import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api }      from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";

// Lucy admin yellow accent — consistent across this panel
const ADMIN_ACCENT = "#F5E642";
const ADMIN_TEXT   = "#0f0f0f";

// ── DateRange presets ─────────────────────────────────────────
function DateRange({ from, to, onFromChange, onToChange }) {
  const { theme } = useTheme();
  const presets = [
    { label: "Today",    days: 1 },
    { label: "7 days",   days: 7 },
    { label: "30 days",  days: 30 },
    { label: "90 days",  days: 90 },
    { label: "All time", days: 3650 },
  ];
  return (
    <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
      {presets.map(p => {
        const pFrom = Math.floor(Date.now()/1000) - p.days * 86400;
        const active = Math.abs(from - pFrom) < 86401;
        return (
          <button key={p.label} onClick={() => { onFromChange(pFrom); onToChange(Math.floor(Date.now()/1000) + 86400); }}
            style={{
              padding:"4px 12px", borderRadius:999, border:`1px solid ${active ? theme.accent : theme.border}`,
              background: active ? theme.accent : "transparent", color: active ? "#0f0f0f" : theme.text,
              fontSize:11, fontWeight:700, cursor:"pointer",
            }}>
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

// ── MiniLineChart ─────────────────────────────────────────────
function MiniLineChart({ data, width=300, height=80, color="#7c3aed" }) {
  const { theme } = useTheme();
  if (!data || data.length < 2) return (
    <div style={{ width, height, display:"flex", alignItems:"center", justifyContent:"center",
                  color:theme.textDim, fontSize:11 }}>No data</div>
  );
  const values = data.map(d => d.value);
  const maxV = Math.max(...values, 1);
  const minV = Math.min(...values, 0);
  const range = maxV - minV || 1;
  const pad = 8;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const pts = data.map((d, i) => {
    const x = pad + (i / (data.length - 1)) * w;
    const y = pad + h - ((d.value - minV) / range) * h;
    return `${x},${y}`;
  });
  return (
    <svg width={width} height={height} style={{ overflow:"visible" }}>
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"/>
      <circle cx={pts[pts.length-1].split(",")[0]} cy={pts[pts.length-1].split(",")[1]} r={3} fill={color}/>
    </svg>
  );
}

// ── MiniBarChart ──────────────────────────────────────────────
function MiniBarChart({ data, width=300, height=80, color="#7c3aed" }) {
  const { theme } = useTheme();
  if (!data || data.length === 0) return (
    <div style={{ width, height, display:"flex", alignItems:"center", justifyContent:"center",
                  color:theme.textDim, fontSize:11 }}>No data</div>
  );
  const maxV = Math.max(...data.map(d => d.value), 1);
  const pad = 4;
  const barW = Math.max(4, (width - pad * 2) / data.length - 2);
  return (
    <svg width={width} height={height}>
      {data.map((d, i) => {
        const bh = Math.max(2, (d.value / maxV) * (height - pad * 2));
        const x = pad + i * ((width - pad*2) / data.length);
        return (
          <rect key={i} x={x} y={height - pad - bh} width={barW} height={bh}
            fill={color} rx={2} opacity={0.85}/>
        );
      })}
    </svg>
  );
}

// ── StatCard ──────────────────────────────────────────────────
function StatCard({ label, value, sub, color, theme }) {
  return (
    <div style={{
      background:theme.surface, border:`1px solid ${theme.border}`,
      borderRadius:12, padding:"16px 18px", flex:1, minWidth:140,
    }}>
      <div style={{ fontSize:10, fontWeight:700, textTransform:"uppercase",
                    letterSpacing:"0.07em", color:theme.textMuted, marginBottom:6 }}>
        {label}
      </div>
      <div style={{ fontSize:22, fontWeight:900, color: color || theme.text, lineHeight:1 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize:11, color:theme.textMuted, marginTop:4 }}>{sub}</div>}
    </div>
  );
}

// ── UsageTab ──────────────────────────────────────────────────
function UsageTab({ theme }) {
  const [from, setFrom] = useState(Math.floor(Date.now()/1000) - 30*86400);
  const [to,   setTo]   = useState(Math.floor(Date.now()/1000) + 86400);
  const [overview, setOverview] = useState(null);
  const [timeseries, setTimeseries] = useState({});
  const [modelCalls, setModelCalls] = useState([]);
  const [loading, setLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, tsResumes, tsCost, calls] = await Promise.all([
        api(`/api/admin/analytics/overview?from=${from}&to=${to}`),
        api(`/api/admin/analytics/timeseries?from=${from}&to=${to}&metric=resumes&granularity=day`),
        api(`/api/admin/analytics/timeseries?from=${from}&to=${to}&metric=cost&granularity=day`),
        api(`/api/admin/analytics/model-calls?from=${from}&to=${to}&pageSize=40`),
      ]);
      setOverview(ov);
      setTimeseries({ resumes: tsResumes, cost: tsCost });
      setModelCalls(calls.rows || []);
    } catch(e) { console.error(e); }
    setLoading(false);
  }, [from, to]);

  useEffect(() => { loadData(); }, [loadData]);

  if (loading && !overview) return (
    <div style={{ padding:32, textAlign:"center", color:theme.textMuted }}>Loading…</div>
  );
  if (!overview) return null;

  const fmtNum = n => n == null ? "—" : n >= 1e6 ? `${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `${(n/1e3).toFixed(1)}k` : String(Math.round(n));
  const fmtUsd = n => n == null ? "—" : `$${Number(n).toFixed(4)}`;
  const fmtPct = n => n == null ? "—" : `${(n*100).toFixed(1)}%`;

  const fmtDate = ts => ts ? new Date(ts*1000).toLocaleString() : "â€”";
  const shortModel = model => (model || "â€”").replace("claude-", "").replace("-20250514", "").replace("-20251001", "");

  const cacheColor = overview.cacheHitRate >= 0.7 ? "#16a34a" : overview.cacheHitRate >= 0.4 ? "#d97706" : "#dc2626";

  return (
    <div style={{ padding:"20px", display:"flex", flexDirection:"column", gap:20 }}>
      <DateRange from={from} to={to} onFromChange={setFrom} onToChange={setTo}/>

      {/* Stat cards */}
      <div style={{ display:"flex", gap:12, flexWrap:"wrap" }}>
        <StatCard label="Active Users" value={overview.activeUsers} sub={`of ${overview.totalUsers} total`} theme={theme}/>
        <StatCard label="Resumes Generated" value={overview.totalResumes}
          sub={overview.avgAtsImprovement != null ? `▲${overview.avgAtsImprovement.toFixed(1)} pts ATS avg` : null}
          theme={theme} color={theme.accent}/>
        <StatCard label="Jobs Scraped" value={fmtNum(overview.totalJobsInserted)} sub={`${overview.totalScrapes} scrape runs`} theme={theme}/>
        <StatCard label="Token Usage" value={fmtNum(overview.totalTokensUsed)} sub="tokens" theme={theme}/>
        <StatCard label="API Cost" value={fmtUsd(overview.totalCostUsd)} theme={theme} color="#dc2626"/>
        <StatCard label="Cache Savings" value={fmtUsd(overview.totalCostSaved)} theme={theme} color="#16a34a"/>
        <StatCard label="Cache Hit Rate" value={fmtPct(overview.cacheHitRate)} theme={theme} color={cacheColor}/>
        <StatCard label="Avg ATS Δ"
          value={overview.avgAtsImprovement != null ? `+${overview.avgAtsImprovement.toFixed(1)}` : "—"}
          sub={overview.avgAtsScoreBefore != null ? `${overview.avgAtsScoreBefore?.toFixed(0)} → ${overview.avgAtsScoreAfter?.toFixed(0)}` : null}
          theme={theme} color={theme.accent}/>
      </div>

      {/* Charts */}
      <div style={{ display:"flex", gap:16, flexWrap:"wrap" }}>
        <div style={{ flex:1, minWidth:280, background:theme.surface, border:`1px solid ${theme.border}`,
                      borderRadius:12, padding:16 }}>
          <div style={{ fontSize:12, fontWeight:700, marginBottom:12, color:theme.text }}>Resumes Generated</div>
          <MiniLineChart data={timeseries.resumes || []} width={300} height={90} color={theme.accent}/>
        </div>
        <div style={{ flex:1, minWidth:280, background:theme.surface, border:`1px solid ${theme.border}`,
                      borderRadius:12, padding:16 }}>
          <div style={{ fontSize:12, fontWeight:700, marginBottom:12, color:theme.text }}>API Cost (USD/day)</div>
          <MiniBarChart data={timeseries.cost || []} width={300} height={90} color="#dc2626"/>
        </div>
      </div>

      {/* Top event types */}
      {overview.topEventTypes?.length > 0 && (
        <div style={{ background:theme.surface, border:`1px solid ${theme.border}`, borderRadius:12, padding:16 }}>
          <div style={{ fontSize:12, fontWeight:700, marginBottom:12, color:theme.text }}>Event Breakdown</div>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {overview.topEventTypes.map(ev => (
              <div key={ev.event_type} style={{ display:"flex", alignItems:"center", gap:10 }}>
                <div style={{ width:160, fontSize:12, color:theme.text }}>{ev.event_type}</div>
                <div style={{ flex:1, height:6, background:theme.surfaceHigh, borderRadius:999 }}>
                  <div style={{ height:6, borderRadius:999, background:theme.accent,
                                width: `${Math.min(100, (ev.count / (overview.topEventTypes[0]?.count||1))*100)}%` }}/>
                </div>
                <div style={{ width:50, textAlign:"right", fontSize:12, color:theme.textMuted }}>{ev.count}</div>
                <div style={{ width:70, textAlign:"right", fontSize:11, color:"#dc2626" }}>{fmtUsd(ev.cost)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {overview.actionCosts?.length > 0 && (
        <div style={{ background:theme.surface, border:`1px solid ${theme.border}`, borderRadius:12, padding:16 }}>
          <div style={{ fontSize:12, fontWeight:700, marginBottom:12, color:theme.text }}>Cost by Generation Action</div>
          <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
            {overview.actionCosts.map((row, idx) => {
              const label = row.event_subtype ? `${row.event_type} / ${row.event_subtype}` : row.event_type;
              const maxCost = overview.actionCosts[0]?.cost || 1;
              const totalTokens = (row.input_tokens || 0) + (row.output_tokens || 0)
                + (row.cache_read_tokens || 0) + (row.cache_creation_tokens || 0);
              return (
                <div key={`${row.event_type}-${row.event_subtype}-${idx}`} style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <div style={{ width:220, fontSize:12, color:theme.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {label}
                  </div>
                  <div style={{ flex:1, height:7, background:theme.surfaceHigh, borderRadius:999 }}>
                    <div style={{ height:7, borderRadius:999, background:"#dc2626",
                                  width: `${Math.min(100, (row.cost / maxCost) * 100)}%` }}/>
                  </div>
                  <div style={{ width:55, textAlign:"right", fontSize:11, color:theme.textMuted }}>{row.calls} calls</div>
                  <div style={{ width:80, textAlign:"right", fontSize:11, color:theme.textMuted }}>{fmtNum(totalTokens)} tok</div>
                  <div style={{ width:76, textAlign:"right", fontSize:11, color:"#dc2626" }}>{fmtUsd(row.cost)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ background:theme.surface, border:`1px solid ${theme.border}`, borderRadius:12, overflow:"hidden" }}>
        <div style={{ padding:"12px 16px", borderBottom:`1px solid ${theme.border}` }}>
          <div style={{ fontSize:12, fontWeight:700, color:theme.text }}>Generation / Model Call Usage</div>
          <div style={{ fontSize:11, color:theme.textMuted, marginTop:3 }}>
            Most recent tracked model calls. Cache state is derived from stored token fields.
          </div>
        </div>
        <div style={{ overflowX:"auto" }}>
          <div style={{ minWidth:920 }}>
            <div style={{
              display:"grid",
              gridTemplateColumns:"150px 120px 140px 150px repeat(4, 86px) 76px 90px",
              gap:8, padding:"9px 14px", background:theme.surfaceHigh,
              fontSize:10, fontWeight:700, textTransform:"uppercase",
              letterSpacing:"0.06em", color:theme.textMuted,
            }}>
              <div>Time</div><div>User</div><div>Action</div><div>Model</div>
              <div>Input</div><div>Output</div><div>Cache Read</div><div>Cache Create</div>
              <div>Cache</div><div>Cost</div>
            </div>
            {modelCalls.length === 0 ? (
              <div style={{ padding:"18px 16px", fontSize:12, color:theme.textMuted }}>
                No tracked model calls in this date range.
              </div>
            ) : modelCalls.map(call => (
              <div key={call.id} style={{
                display:"grid",
                gridTemplateColumns:"150px 120px 140px 150px repeat(4, 86px) 76px 90px",
                gap:8, padding:"9px 14px", borderTop:`1px solid ${theme.border}`,
                fontSize:11, alignItems:"center", color:theme.textMuted,
              }}>
                <div>{fmtDate(call.created_at)}</div>
                <div style={{ color:theme.text, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {call.username}
                </div>
                <div style={{ color:theme.text }}>{call.event_subtype || call.event_type}</div>
                <div title={call.model || ""}>{shortModel(call.model)}</div>
                <div>{fmtNum(call.input_tokens || 0)}</div>
                <div>{fmtNum(call.output_tokens || 0)}</div>
                <div>{fmtNum(call.cache_read_tokens || 0)}</div>
                <div>{fmtNum(call.cache_creation_tokens || 0)}</div>
                <div style={{
                  color: call.cache_state === "warm" || call.cache_state === "partial" ? "#16a34a"
                    : call.cache_state === "cold_write" ? "#d97706" : theme.textMuted,
                  fontWeight:700,
                }}>
                  {call.cache_state || (call.cached ? "warm" : "cold")}
                </div>
                <div style={{ color:"#dc2626" }}>{fmtUsd(call.cost_usd || 0)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── LimitsModal ───────────────────────────────────────────────
function LimitsModal({ userId, username, initialLimits, onSave, onClose, theme }) {
  const [limits, setLimits] = useState({
    monthly_resumes: initialLimits.monthly_resumes ?? "",
    monthly_ats_scores: initialLimits.monthly_ats_scores ?? "",
    monthly_job_scrapes: initialLimits.monthly_job_scrapes ?? "",
    monthly_pdf_exports: initialLimits.monthly_pdf_exports ?? "",
    monthly_apply_runs: initialLimits.monthly_apply_runs ?? "",
    monthly_token_budget: initialLimits.monthly_token_budget ?? "",
    daily_resumes: initialLimits.daily_resumes ?? "",
    daily_job_scrapes: initialLimits.daily_job_scrapes ?? "",
    notes: initialLimits.notes ?? "",
  });
  const [saving, setSaving] = useState(false);

  const numOrNull = v => v === "" || v == null ? null : parseInt(v);
  const fields = [
    { key:"monthly_resumes",     label:"Monthly resumes",         unit:"resumes/mo" },
    { key:"daily_resumes",       label:"Daily resumes",           unit:"resumes/day" },
    { key:"monthly_ats_scores",  label:"Monthly ATS scores",      unit:"scores/mo" },
    { key:"monthly_job_scrapes", label:"Monthly job scrapes",     unit:"scrapes/mo" },
    { key:"daily_job_scrapes",   label:"Daily job scrapes",       unit:"scrapes/day" },
    { key:"monthly_pdf_exports", label:"Monthly PDF exports",     unit:"exports/mo" },
    { key:"monthly_apply_runs",  label:"Monthly apply runs",      unit:"runs/mo" },
    { key:"monthly_token_budget",label:"Monthly token budget",    unit:"tokens" },
  ];
  const inp = {
    height:36, padding:"0 12px", borderRadius:8, border:`1px solid ${theme.border}`,
    background:theme.surface, color:theme.text, fontSize:12, outline:"none", width:"100%",
    boxSizing:"border-box",
  };
  return (
    <div style={{ position:"fixed", inset:0, zIndex:1100, display:"flex",
                  alignItems:"center", justifyContent:"center",
                  background:"rgba(0,0,0,0.5)" }}
      onClick={e => { if(e.target===e.currentTarget) onClose(); }}>
      <div style={{ background:theme.surface, borderRadius:16, padding:28,
                    maxWidth:420, width:"90%", maxHeight:"80vh", overflowY:"auto",
                    border:`1px solid ${theme.border}` }}>
        <div style={{ fontSize:16, fontWeight:800, marginBottom:16, color:theme.text }}>
          Limits: {username}
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {fields.map(f => (
            <div key={f.key}>
              <div style={{ fontSize:11, fontWeight:700, color:theme.textMuted, marginBottom:4 }}>
                {f.label} <span style={{ fontWeight:400 }}>({f.unit}, blank = unlimited)</span>
              </div>
              <input style={inp} type="number" min={0}
                value={limits[f.key]} placeholder="Unlimited"
                onChange={e => setLimits(l => ({ ...l, [f.key]: e.target.value }))}/>
            </div>
          ))}
          <div>
            <div style={{ fontSize:11, fontWeight:700, color:theme.textMuted, marginBottom:4 }}>Admin notes</div>
            <textarea style={{ ...inp, height:72, padding:"8px 12px", resize:"vertical" }}
              value={limits.notes} onChange={e => setLimits(l => ({ ...l, notes: e.target.value }))}/>
          </div>
        </div>
        <div style={{ display:"flex", gap:8, marginTop:20 }}>
          <button onClick={onClose}
            style={{ flex:1, padding:"10px 0", borderRadius:999, border:`1px solid ${theme.border}`,
                     background:"transparent", color:theme.text, fontWeight:700, fontSize:13, cursor:"pointer" }}>
            Cancel
          </button>
          <button disabled={saving} onClick={async () => {
            setSaving(true);
            await onSave({
              monthly_resumes: numOrNull(limits.monthly_resumes),
              monthly_ats_scores: numOrNull(limits.monthly_ats_scores),
              monthly_job_scrapes: numOrNull(limits.monthly_job_scrapes),
              monthly_pdf_exports: numOrNull(limits.monthly_pdf_exports),
              monthly_apply_runs: numOrNull(limits.monthly_apply_runs),
              monthly_token_budget: numOrNull(limits.monthly_token_budget),
              daily_resumes: numOrNull(limits.daily_resumes),
              daily_job_scrapes: numOrNull(limits.daily_job_scrapes),
              notes: limits.notes || null,
            });
            setSaving(false);
          }}
            style={{ flex:2, padding:"10px 0", borderRadius:999, border:"none",
                     background:theme.accent, color:"#0f0f0f", fontWeight:800, fontSize:13,
                     cursor:"pointer", opacity:saving?0.7:1 }}>
            {saving ? "Saving…" : "Save Limits"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── UsersTab ──────────────────────────────────────────────────
function UsersTab({ theme }) {
  const [from, setFrom] = useState(Math.floor(Date.now()/1000) - 30*86400);
  const [to,   setTo]   = useState(Math.floor(Date.now()/1000) + 86400);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editLimits, setEditLimits] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [events, setEvents] = useState({});

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api(`/api/admin/analytics/users?from=${from}&to=${to}`);
      setUsers(data);
    } catch(e) {}
    setLoading(false);
  }, [from, to]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const loadEvents = async (userId) => {
    if (events[userId]) return;
    try {
      const data = await api(`/api/admin/analytics/users/${userId}/events?pageSize=20`);
      setEvents(e => ({ ...e, [userId]: data }));
    } catch(e) {}
  };

  const fmtNum = n => n == null ? "—" : n >= 1e6 ? `${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `${(n/1e3).toFixed(1)}k` : String(Math.round(n));
  const fmtUsd = n => n == null ? "—" : `$${Number(n).toFixed(4)}`;
  const fmtPct = n => n == null ? "—" : `${(n*100).toFixed(0)}%`;

  return (
    <div style={{ padding:20, display:"flex", flexDirection:"column", gap:16 }}>
      <DateRange from={from} to={to} onFromChange={setFrom} onToChange={setTo}/>

      {loading ? <div style={{ color:theme.textMuted, fontSize:12 }}>Loading…</div> : (
        <div style={{ background:theme.surface, border:`1px solid ${theme.border}`, borderRadius:12, overflow:"hidden" }}>
          {/* Table header */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 60px 60px 80px 80px 70px 70px 80px 80px",
                        padding:"10px 16px", background:theme.surfaceHigh,
                        fontSize:10, fontWeight:700, textTransform:"uppercase",
                        letterSpacing:"0.06em", color:theme.textMuted }}>
            <div>User</div><div>Resumes</div><div>Scrapes</div>
            <div>Tokens</div><div>Cost</div><div>Cache%</div>
            <div>ATS Δ</div><div>Last Active</div><div>Actions</div>
          </div>
          {users.map(u => (
            <div key={u.userId}>
              <div onClick={() => { setExpanded(e => e===u.userId?null:u.userId); loadEvents(u.userId); }}
                style={{ display:"grid", gridTemplateColumns:"1fr 60px 60px 80px 80px 70px 70px 80px 80px",
                         padding:"12px 16px", borderTop:`1px solid ${theme.border}`,
                         cursor:"pointer", fontSize:12,
                         background: expanded===u.userId ? theme.surfaceHigh : "transparent" }}>
                <div style={{ fontWeight:700, color:theme.text }}>{u.username}</div>
                <div style={{ color:theme.textMuted }}>{u.resumesGenerated}</div>
                <div style={{ color:theme.textMuted }}>{u.jobScrapes}</div>
                <div style={{ color:theme.textMuted }}>{fmtNum(u.totalTokens)}</div>
                <div style={{ color:"#dc2626" }}>{fmtUsd(u.totalCost)}</div>
                <div style={{ color:theme.textMuted }}>{fmtPct(u.cacheHitRate)}</div>
                <div style={{ color:theme.accent }}>
                  {u.avgAtsScoreAfter != null && u.avgAtsScoreBefore != null
                    ? `+${(u.avgAtsScoreAfter - u.avgAtsScoreBefore).toFixed(0)}`
                    : "—"}
                </div>
                <div style={{ color:theme.textMuted, fontSize:11 }}>
                  {u.lastActiveAt ? new Date(u.lastActiveAt*1000).toLocaleDateString() : "—"}
                </div>
                <div onClick={e2 => { e2.stopPropagation(); setEditLimits({ userId:u.userId, username:u.username, limits:u.limits||{} }); }}>
                  <span style={{ fontSize:11, padding:"2px 8px", borderRadius:999,
                                 border:`1px solid ${theme.border}`, cursor:"pointer",
                                 color:theme.text, whiteSpace:"nowrap" }}>
                    Limits
                  </span>
                </div>
              </div>
              {/* Expanded row */}
              {expanded === u.userId && (
                <div style={{ padding:"12px 16px 16px", borderTop:`1px solid ${theme.border}`,
                              background:theme.surfaceHigh }}>
                  <div style={{ fontSize:11, fontWeight:700, color:theme.textMuted, marginBottom:8 }}>
                    Recent Events
                  </div>
                  {(events[u.userId] || []).slice(0,10).map(ev => (
                    <div key={ev.id} style={{ display:"flex", gap:12, fontSize:11,
                                              color:theme.textMuted, padding:"3px 0",
                                              borderBottom:`1px solid ${theme.border}` }}>
                      <span style={{ color:theme.text, fontWeight:600, width:140 }}>{ev.event_type}</span>
                      <span>{ev.model?.replace("claude-","")}</span>
                      <span>{(ev.input_tokens||0)+(ev.output_tokens||0)} tok</span>
                      <span style={{ color:"#dc2626" }}>${Number(ev.cost_usd||0).toFixed(5)}</span>
                      <span>{new Date(ev.created_at*1000).toLocaleString()}</span>
                    </div>
                  ))}
                  {!events[u.userId] && <div style={{ color:theme.textDim, fontSize:11 }}>Loading…</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Limits editor modal */}
      {editLimits && (
        <LimitsModal
          userId={editLimits.userId}
          username={editLimits.username}
          initialLimits={editLimits.limits}
          theme={theme}
          onSave={async (limits) => {
            await api(`/api/admin/analytics/limits/${editLimits.userId}`, {
              method:"PUT", body:JSON.stringify(limits),
            });
            setEditLimits(null);
            loadUsers();
          }}
          onClose={() => setEditLimits(null)}
        />
      )}
    </div>
  );
}

// ── CacheTab ──────────────────────────────────────────────────
function CacheTab({ theme }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    api("/api/admin/analytics/cache").then(setData).catch(()=>{});
  }, []);
  if (!data) return <div style={{ padding:32, color:theme.textMuted }}>Loading…</div>;
  const fmtPct = n => `${(n*100).toFixed(1)}%`;
  const fmtUsd = n => `$${Number(n||0).toFixed(4)}`;
  return (
    <div style={{ padding:20, display:"flex", flexDirection:"column", gap:16 }}>
      {/* Cache-state summary */}
      <div style={{ background:theme.surface, border:`1px solid ${theme.border}`,
                    borderRadius:12, padding:20, display:"flex", alignItems:"center", gap:20 }}>
        <div style={{ textAlign:"center" }}>
          <div style={{ fontSize:40, fontWeight:900,
                        color: data.warmthScore >= 70 ? "#16a34a" : data.warmthScore >= 40 ? "#d97706" : "#dc2626" }}>
            {data.warmthScore}
          </div>
          <div style={{ fontSize:10, color:theme.textMuted, fontWeight:700 }}>CACHE READ CALLS</div>
        </div>
        <div>
          <div style={{ fontSize:13, color:theme.text, lineHeight:1.6 }}>
            {fmtPct(data.hitRate)} of recorded model calls had some cache read tokens.
            Full warm calls: {fmtPct(data.fullHitRate || 0)}. Partial cache calls: {fmtPct(data.partialHitRate || 0)}.
            Cache writes: {data.totalCacheWrites || 0}. Cold calls: {data.totalCacheMisses || 0}.
            Token cache-read ratio: {fmtPct(data.cacheReadTokenRatio || 0)}.
          </div>
          <div style={{ fontSize:11, color:theme.textMuted, marginTop:4 }}>
            {data.totalCacheHits} hits · {data.totalCacheMisses} misses · {(data.totalTokensSaved||0).toLocaleString()} tokens saved
          </div>
        </div>
      </div>
      {/* By layer */}
      {data.byLayer?.length > 0 && (
        <div style={{ background:theme.surface, border:`1px solid ${theme.border}`, borderRadius:12, overflow:"hidden" }}>
          <div style={{ padding:"10px 16px", background:theme.surfaceHigh, fontSize:10,
                        fontWeight:700, textTransform:"uppercase", letterSpacing:"0.06em",
                        color:theme.textMuted }}>By Layer</div>
          {data.byLayer.map(l => (
            <div key={l.layer} style={{ display:"flex", gap:12, padding:"10px 16px",
                                         borderTop:`1px solid ${theme.border}`, fontSize:12 }}>
              <div style={{ width:160, color:theme.text, fontWeight:600 }}>{l.layer || "unknown"}</div>
              <div style={{ color:theme.textMuted }}>{l.hits} hits</div>
              <div style={{ color:theme.textMuted }}>{l.partials || 0} partial</div>
              <div style={{ color:theme.textMuted }}>{l.writes || 0} writes</div>
              <div style={{ color:theme.textMuted }}>{l.misses} misses</div>
              <div style={{ color:theme.textMuted }}>{l.hits + l.misses > 0 ? fmtPct(l.hits / (l.hits + l.misses)) : "—"}</div>
              <div style={{ color:"#16a34a" }}>{fmtUsd(l.cost_saved)}</div>
            </div>
          ))}
        </div>
      )}
      {/* By domain */}
      {data.byDomain?.length > 0 && (
        <div style={{ background:theme.surface, border:`1px solid ${theme.border}`, borderRadius:12, overflow:"hidden" }}>
          <div style={{ padding:"10px 16px", background:theme.surfaceHigh, fontSize:10,
                        fontWeight:700, textTransform:"uppercase", letterSpacing:"0.06em",
                        color:theme.textMuted }}>By Domain Module</div>
          {data.byDomain.map(d => (
            <div key={d.domain_module} style={{ display:"flex", gap:12, padding:"10px 16px",
                                                 borderTop:`1px solid ${theme.border}`, fontSize:12 }}>
              <div style={{ width:160, color:theme.text, fontWeight:600 }}>{d.domain_module}</div>
              <div style={{ color:theme.textMuted }}>{d.calls} calls</div>
              <div style={{ color:theme.textMuted }}>{d.hits} hits</div>
              <div style={{ color:theme.textMuted }}>{d.partials || 0} partial</div>
              <div style={{ color:theme.textMuted }}>{d.writes || 0} writes</div>
              <div style={{ color:theme.textMuted }}>{d.misses || 0} cold</div>
              <div style={{ color:theme.textMuted }}>{d.calls > 0 ? fmtPct(d.hits / d.calls) : "—"}</div>
              <div style={{ color:"#16a34a" }}>{fmtUsd(d.cost_saved)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ContactMessagesSection({ theme }) {
  const [messages, setMessages]   = useState([]);
  const [loading,  setLoading]    = useState(true);
  const [expanded, setExpanded]   = useState(null);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const loadMessages = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api(`/api/admin/contact-messages${unreadOnly ? "?unread=1" : ""}`);
      setMessages(Array.isArray(rows) ? rows : []);
    } catch {}
    setLoading(false);
  }, [unreadOnly]);

  useEffect(() => { loadMessages(); }, [loadMessages]);

  const markRead = async (id) => {
    try {
      await api(`/api/admin/contact-messages/${id}/read`, { method: "PATCH" });
      setMessages(ms => ms.map(m => m.id === id ? { ...m, read: 1 } : m));
    } catch {}
  };

  const unreadCount = messages.filter(m => !m.read).length;

  return (
    <div style={{ marginBottom: 40 }}>
      {/* Section header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h2 style={{ fontSize: 14, fontWeight: 800, color: ADMIN_ACCENT, margin: 0,
                      letterSpacing: "0.05em", textTransform: "uppercase" }}>
          Contact Messages
        </h2>
        {unreadCount > 0 && (
          <span style={{ background: theme.danger, color: "white", fontSize: 11,
                          fontWeight: 700, padding: "2px 8px", borderRadius: 999 }}>
            {unreadCount} unread
          </span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 12, color: theme.textMuted, display: "flex",
                           gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={unreadOnly}
              onChange={e => setUnreadOnly(e.target.checked)}/>
            Unread only
          </label>
          <button className="rm-btn rm-btn-ghost rm-btn-sm" onClick={loadMessages}>
            ↻ Refresh
          </button>
        </div>
      </div>

      <div style={{ background: theme.surface, border: `1px solid ${theme.border}`,
                     borderRadius: 16, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 32, textAlign: "center", color: theme.textDim, fontSize: 13 }}>
            Loading…
          </div>
        ) : messages.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: theme.textDim, fontSize: 13 }}>
            No messages yet.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: theme.surfaceHigh, borderBottom: `1px solid ${theme.border}` }}>
                {["Name", "Email", "Subject", "Preview", "Date", ""].map(h => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontSize: 11,
                                        fontWeight: 700, color: theme.textMuted,
                                        textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {messages.map(m => (
                <>
                  <tr key={m.id}
                    style={{ borderBottom: `1px solid ${theme.border}`,
                               background: expanded === m.id ? theme.surfaceHigh : "transparent",
                               cursor: "pointer",
                               opacity: m.read ? 0.65 : 1 }}
                    onClick={() => setExpanded(expanded === m.id ? null : m.id)}>
                    <td style={{ padding: "10px 14px", fontSize: 13, color: theme.text,
                                  fontWeight: m.read ? 400 : 700 }}>
                      {m.name}
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 12, color: theme.textMuted }}>
                      {m.email}
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 12, color: theme.textMuted }}>
                      {m.subject || "—"}
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 12, color: theme.textDim,
                                  maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis",
                                  whiteSpace: "nowrap" }}>
                      {m.message.slice(0, 80)}{m.message.length > 80 ? "…" : ""}
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 11, color: theme.textDim,
                                  whiteSpace: "nowrap" }}>
                      {new Date(m.created_at * 1000).toLocaleDateString()}
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      {!m.read && (
                        <button className="rm-btn rm-btn-ghost rm-btn-sm"
                          onClick={e => { e.stopPropagation(); markRead(m.id); }}
                          style={{ whiteSpace: "nowrap" }}>
                          Mark read
                        </button>
                      )}
                    </td>
                  </tr>
                  {expanded === m.id && (
                    <tr key={`exp-${m.id}`} style={{ background: theme.surfaceHigh }}>
                      <td colSpan={6} style={{ padding: "16px 20px" }}>
                        <div style={{ fontSize: 13, color: theme.textMuted,
                                       lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
                          {m.message}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function AdminPanel() {
  const { theme } = useTheme();
  const [users,    setUsers]    = useState([]);
  const [upgradeRequests, setUpgradeRequests] = useState([]);
  const [profileRequests, setProfileRequests] = useState([]);
  const [backups,  setBackups]  = useState([]);
  const [newU,     setNewU]     = useState({ username:"", password:"", isAdmin:false });
  const [status,   setStatus]   = useState("");
  const [bStatus,  setBStatus]  = useState("");
  const [backing,  setBacking]  = useState(false);
  const [section,  setSection]  = useState("users");

  // Top-level tab: "system" | "usage" | "users_analytics" | "cache"
  const [topTab, setTopTab] = useState("system");

  useEffect(() => { loadUsers(); loadBackups(); loadUpgradeRequests(); loadProfileRequests(); }, []);

  const loadUsers   = () => api("/api/admin/users").then(setUsers).catch(() => {});
  const loadBackups = () => api("/api/admin/backups").then(setBackups).catch(() => {});
  const loadUpgradeRequests = () => api("/api/admin/upgrade-requests").then(setUpgradeRequests).catch(() => {});
  const loadProfileRequests = () => api("/api/admin/domain-profile-requests").then(setProfileRequests).catch(() => {});

  const createUser = async e => {
    e.preventDefault();
    try {
      await api("/api/admin/users", { method:"POST", body:JSON.stringify(newU) });
      setNewU({ username:"", password:"", isAdmin:false });
      setStatus("✓ User created");
      loadUsers();
    } catch(e2) { setStatus("✗ " + e2.message); }
    setTimeout(() => setStatus(""), 3000);
  };

  const deleteUser = async id => {
    if (!confirm("Delete this user and all their data?")) return;
    await api(`/api/admin/users/${id}`, { method:"DELETE" });
    setUsers(u => u.filter(x => x.id !== id));
  };

  const grantPlan = async (userId, planTier) => {
    await api(`/api/admin/users/${userId}/plan`, {
      method:"PATCH",
      body:JSON.stringify({ planTier }),
    });
    loadUsers();
    loadUpgradeRequests();
  };

  const grantUpgradeRequest = async (id) => {
    await api(`/api/admin/upgrade-requests/${id}/grant`, { method:"PATCH" });
    loadUsers();
    loadUpgradeRequests();
  };

  const updateProfileRequestStatus = async (id, status) => {
    await api(`/api/admin/domain-profile-requests/${id}/status`, {
      method:"PATCH",
      body:JSON.stringify({ status }),
    });
    loadProfileRequests();
  };

  const triggerBackup = async () => {
    setBacking(true); setBStatus("");
    try {
      const r = await api("/api/admin/backups", {
        method:"POST", body:JSON.stringify({ label:"manual" }),
      });
      setBStatus(`✓ Backup created: ${r.filename}`);
      loadBackups();
    } catch(e) { setBStatus("✗ " + e.message); }
    setBacking(false);
    setTimeout(() => setBStatus(""), 6000);
  };

  const restoreBackup = async filename => {
    if (!confirm(`Restore from:\n${filename}\n\nCurrent data will be backed up first, then overwritten. The server must be restarted after restore. Continue?`)) return;
    try {
      const r = await api("/api/admin/backups/restore", {
        method:"POST", body:JSON.stringify({ filename }),
      });
      alert(`${r.message}\n\nRestart the server now to apply the restored database.`);
      loadBackups();
    } catch(e) { alert("Restore failed: " + e.message); }
  };

  const fmtSize = bytes => bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;

  const SECTIONS = [["users","Users"],["backups","Backups"]];

  const thStyle = {
    padding:"10px 14px", textAlign:"left", fontSize:10,
    fontWeight:700, color:theme.textDim,
    textTransform:"uppercase", letterSpacing:"0.08em",
    borderBottom:`1px solid ${theme.border}`,
    whiteSpace:"nowrap",
  };

  const TOP_TABS = [
    { id:"system",          label:"System" },
    { id:"usage",           label:"Usage" },
    { id:"users_analytics", label:"Users" },
    { id:"cache",           label:"Cache" },
  ];

  return (
    <div style={{ padding:"32px 24px", overflowY:"auto", height:"100%",
                  boxSizing:"border-box", background:theme.bg, maxWidth:1200,
                  borderTop:`4px solid ${ADMIN_ACCENT}` }}>

      {/* Lucy admin header — yellow accent */}
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:24 }}>
        <span style={{
          fontFamily:"'Barlow Condensed','DM Sans',sans-serif",
          fontWeight:800, fontSize:28, letterSpacing:"0.08em",
          textTransform:"uppercase", color:ADMIN_TEXT,
          background:ADMIN_ACCENT, padding:"4px 16px", borderRadius:2,
        }}>Admin</span>
        <span style={{
          fontFamily:"'Barlow Condensed','DM Sans',sans-serif",
          fontWeight:800, fontSize:28, letterSpacing:"0.08em",
          textTransform:"uppercase", color:theme.text,
        }}>Panel</span>
        <div style={{ flex:1 }}/>
        {/* DB Inspector shortcut */}
        <a href="/admin/db" style={{ textDecoration:"none" }}>
          <div style={{
            display:"flex", alignItems:"center", gap:10,
            background:theme.surface, border:`1px solid ${theme.border}`,
            borderRadius:10, padding:"10px 16px", cursor:"pointer",
            transition:"border-color 0.15s",
          }}
          onMouseEnter={e => e.currentTarget.style.borderColor = ADMIN_ACCENT}
          onMouseLeave={e => e.currentTarget.style.borderColor = theme.border}>
            <span style={{ fontSize:18 }}>🔬</span>
            <div>
              <div style={{ fontWeight:800, fontSize:12, color:theme.text, letterSpacing:"0.05em" }}>
                DB Inspector
              </div>
              <div style={{ fontSize:10, color:theme.textMuted }}>
                Scrapes · Pool · Schema · Trace
              </div>
            </div>
            <span style={{ fontSize:11, color:ADMIN_ACCENT, fontWeight:700, marginLeft:4 }}>→</span>
          </div>
        </a>
      </div>

      {/* ── Top-level tabs ── */}
      <div style={{ display:"flex", borderBottom:`2px solid ${ADMIN_ACCENT}`, marginBottom:24 }}>
        {TOP_TABS.map(({ id, label }) => (
          <button key={id}
            style={{
              padding:"10px 20px", border:"none", cursor:"pointer",
              fontFamily:"'Barlow Condensed','DM Sans',sans-serif",
              fontWeight:800, fontSize:14, letterSpacing:"0.06em", textTransform:"uppercase",
              background: topTab===id ? ADMIN_ACCENT : "transparent",
              color: topTab===id ? ADMIN_TEXT : theme.textMuted,
              transition:"all 0.15s", borderRadius:"2px 2px 0 0",
            }}
            onClick={() => setTopTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {/* ── Usage analytics tab ── */}
      {topTab === "usage" && <UsageTab theme={theme}/>}
      {topTab === "users_analytics" && <UsersTab theme={theme}/>}
      {topTab === "cache" && <CacheTab theme={theme}/>}

      {/* ── CONTACT MESSAGES SECTION ──────────────────────────────── */}
      <ContactMessagesSection theme={theme}/>

      {/* ── System tab (existing user management + backups) ── */}
      {topTab === "system" && (
        <>
          {/* ── Section tabs — Lucy style ── */}
          <div style={{ display:"flex", borderBottom:`1px solid ${theme.border}`, marginBottom:24 }}>
            {SECTIONS.map(([id, lbl]) => (
              <button key={id}
                style={{
                  padding:"8px 16px", border:"none", cursor:"pointer",
                  fontFamily:"'Barlow Condensed','DM Sans',sans-serif",
                  fontWeight:800, fontSize:13, letterSpacing:"0.06em", textTransform:"uppercase",
                  background: section===id ? theme.surfaceHigh : "transparent",
                  color: section===id ? theme.text : theme.textMuted,
                  transition:"all 0.15s", borderRadius:"4px 4px 0 0",
                  borderBottom: section===id ? `2px solid ${theme.accent}` : "2px solid transparent",
                }}
                onClick={() => setSection(id)}>
                {lbl}
              </button>
            ))}
          </div>

          <AnimatePresence mode="wait">
            {section === "users" && (
              <motion.div key="users"
                initial={{ opacity:0, y:6 }} animate={{ opacity:1, y:0 }}
                exit={{ opacity:0, y:-6 }} transition={{ duration:0.18 }}>

                {/* Create user card */}
                <div className="rm-card" style={{ marginBottom:24, maxWidth:440 }}>
                  <div style={{ fontWeight:700, fontSize:14, color:theme.text, marginBottom:16 }}>
                    Create User
                  </div>
                  <form onSubmit={createUser} style={{ display:"flex", flexDirection:"column", gap:10 }}>
                    <input className="rm-input" value={newU.username}
                      onChange={e => setNewU(u => ({ ...u, username:e.target.value }))}
                      placeholder="Username"/>
                    <input className="rm-input" type="password" value={newU.password}
                      onChange={e => setNewU(u => ({ ...u, password:e.target.value }))}
                      placeholder="Password (min 8 chars)"/>
                    <label style={{ display:"flex", alignItems:"center", gap:8,
                                    fontSize:13, color:theme.text, cursor:"pointer" }}>
                      <input type="checkbox" checked={newU.isAdmin}
                        onChange={e => setNewU(u => ({ ...u, isAdmin:e.target.checked }))}
                        style={{ accentColor:theme.accent, width:16, height:16 }}/>
                      Admin user
                    </label>
                    <div style={{ display:"flex", gap:10, alignItems:"center", marginTop:4 }}>
                      <button type="submit" className="rm-btn rm-btn-primary rm-btn-sm">
                        Create
                      </button>
                      {status && (
                        <span style={{ fontSize:12,
                          color:status.startsWith("✓") ? theme.success : theme.danger }}>
                          {status}
                        </span>
                      )}
                    </div>
                  </form>
                </div>

                {/* User table */}
                {upgradeRequests.filter(r => r.status === "pending").length > 0 && (
                  <div className="rm-card" style={{ marginBottom:24 }}>
                    <div style={{ fontWeight:700, fontSize:14, color:theme.text, marginBottom:12 }}>
                      Pending Upgrade Requests
                    </div>
                    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                      {upgradeRequests.filter(r => r.status === "pending").map(r => (
                        <div key={r.id} style={{ display:"flex", alignItems:"center", gap:10,
                                                 padding:"8px 10px", border:`1px solid ${theme.border}`,
                                                 borderRadius:8 }}>
                          <span style={{ flex:1, fontSize:12 }}>
                            <strong>{r.username}</strong> requests {r.requested_tier}
                          </span>
                          <button className="rm-btn rm-btn-primary rm-btn-sm"
                            onClick={() => grantUpgradeRequest(r.id)}>
                            Grant
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {profileRequests.filter(r => r.status === "pending").length > 0 && (
                  <div className="rm-card" style={{ marginBottom:24 }}>
                    <div style={{ fontWeight:700, fontSize:14, color:theme.text, marginBottom:12 }}>
                      Other Job Profile Requests
                    </div>
                    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                      {profileRequests.filter(r => r.status === "pending").map(r => (
                        <div key={r.id} style={{ display:"flex", alignItems:"flex-start", gap:10,
                                                 padding:"10px", border:`1px solid ${theme.border}`,
                                                 borderRadius:8 }}>
                          <span style={{ flex:1, fontSize:12, color:theme.textMuted, lineHeight:1.5 }}>
                            <strong style={{ color:theme.text }}>{r.username}</strong> requests{" "}
                            <strong style={{ color:theme.text }}>{r.desired_title}</strong>
                            {r.role_family ? ` (${r.role_family})` : ""}
                            {(r.target_titles || []).length > 0 && (
                              <span> - aliases: {(r.target_titles || []).slice(0, 4).join(", ")}</span>
                            )}
                            {(r.skills || []).length > 0 && (
                              <span> - skills: {(r.skills || []).slice(0, 4).join(", ")}</span>
                            )}
                            {r.notes ? <span> - note: {r.notes}</span> : null}
                          </span>
                          <button className="rm-btn rm-btn-ghost rm-btn-sm"
                            onClick={() => updateProfileRequestStatus(r.id, "reviewing")}>
                            Review
                          </button>
                          <button className="rm-btn rm-btn-primary rm-btn-sm"
                            onClick={() => updateProfileRequestStatus(r.id, "resolved")}>
                            Resolve
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div style={{ background:theme.surface, border:`1px solid ${theme.border}`,
                              borderRadius:16, overflow:"hidden" }}>
                  <table style={{ width:"100%", borderCollapse:"collapse" }}>
                    <thead>
                      <tr style={{ background:theme.surfaceHigh, borderBottom:`1px solid ${theme.border}` }}>
                        {["Username","Role","Plan","Tools","Created","Actions"].map(h => (
                          <th key={h} style={thStyle}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((u, i) => (
                        <tr key={u.id} className="rm-table-row"
                          style={{ borderBottom:`1px solid ${theme.border}` }}>
                          <td style={{ padding:"12px 14px", fontSize:13,
                                       color:theme.text, fontWeight:600 }}>
                            {u.username}
                          </td>
                          <td style={{ padding:"12px 14px" }}>
                            <span className="rm-badge" style={{
                              background: u.is_admin ? "#f3e8ff" : theme.surfaceHigh,
                              color: u.is_admin ? "#7c3aed" : theme.textMuted,
                              border:`1px solid ${u.is_admin ? "#7c3aed33" : theme.border}`,
                            }}>
                              {u.is_admin ? "Admin" : "User"}
                            </span>
                          </td>
                          <td style={{ padding:"12px 14px", fontSize:12, color:theme.textMuted }}>
                            {u.plan_tier || "BASIC"}
                          </td>
                          <td style={{ padding:"12px 14px", fontSize:12, color:theme.textMuted }}>
                            {(u.plan_tier || "BASIC") === "PRO"
                              ? "Generate + A+ Resume"
                              : (u.plan_tier || "BASIC") === "PLUS"
                                ? "Generate"
                                : "Baseline console"}
                          </td>
                          <td style={{ padding:"12px 14px", fontSize:11, color:theme.textDim }}>
                            {new Date(u.created_at * 1000).toLocaleDateString()}
                          </td>
                          <td style={{ padding:"12px 14px" }}>
                            <div style={{ display:"flex", gap:6 }}>
                              {!u.is_admin && (
                                <select value={u.plan_tier || "BASIC"} onChange={e => grantPlan(u.id, e.target.value)}
                                  style={{ background:theme.surfaceHigh, color:theme.text,
                                           border:`1px solid ${theme.border}`, borderRadius:6,
                                           fontSize:11, padding:"4px 6px" }}>
                                  <option value="BASIC">Basic</option>
                                  <option value="PLUS">Plus</option>
                                  <option value="PRO">Pro</option>
                                </select>
                              )}
                              {!u.is_admin && (
                                <button className="rm-btn rm-btn-ghost rm-btn-sm"
                                  style={{ color:theme.danger, borderColor:theme.danger+"44" }}
                                  onClick={() => deleteUser(u.id)}>
                                  Delete
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </motion.div>
            )}

            {section === "backups" && (
              <motion.div key="backups"
                initial={{ opacity:0, y:6 }} animate={{ opacity:1, y:0 }}
                exit={{ opacity:0, y:-6 }} transition={{ duration:0.18 }}>

                {/* Backup card */}
                <div className="rm-card" style={{ marginBottom:24, maxWidth:560 }}>
                  <div style={{ fontWeight:700, fontSize:14, color:theme.text, marginBottom:10 }}>
                    Database Backup
                  </div>
                  <div style={{ fontSize:12, color:theme.textMuted, lineHeight:1.6, marginBottom:14 }}>
                    Backups are saved to{" "}
                    <code style={{ color:theme.accentText, fontFamily:"monospace" }}>data/backups/</code>{" "}
                    and kept for the last 30 snapshots.
                    An automatic backup runs daily at 2:00 AM. Restore creates a safety backup
                    of the current DB before overwriting.
                    After restoring, <strong style={{ color:theme.text }}>restart the server</strong> to apply.
                  </div>
                  <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                    <button
                      disabled={backing} onClick={triggerBackup}
                      style={{
                        background: backing ? theme.border : ADMIN_ACCENT,
                        color: ADMIN_TEXT, border:"none", borderRadius:2,
                        padding:"8px 20px", cursor:"pointer",
                        fontFamily:"'Barlow Condensed','DM Sans',sans-serif",
                        fontWeight:800, fontSize:13, letterSpacing:"0.08em",
                        textTransform:"uppercase",
                        transition:"border-radius 1s ease",
                      }}
                      onMouseEnter={e => e.currentTarget.style.borderRadius="999px"}
                      onMouseLeave={e => e.currentTarget.style.borderRadius="2px"}>
                      {backing ? "Creating…" : "Backup Now"}
                    </button>
                    {bStatus && (
                      <span style={{ fontSize:12,
                        color:bStatus.startsWith("✓") ? theme.success : theme.danger }}>
                        {bStatus}
                      </span>
                    )}
                  </div>
                </div>

                {/* Backup list */}
                <div style={{ background:theme.surface, border:`1px solid ${theme.border}`,
                              borderRadius:16, overflow:"hidden", maxWidth:700 }}>
                  <div style={{ background:theme.surfaceHigh, padding:"10px 16px",
                                display:"flex", alignItems:"center",
                                justifyContent:"space-between",
                                borderBottom:`1px solid ${theme.border}` }}>
                    <span style={{ fontSize:11, fontWeight:700, color:theme.textMuted }}>
                      Restore Points ({backups.length})
                    </span>
                    <button className="rm-btn rm-btn-ghost rm-btn-sm"
                      onClick={loadBackups}>
                      ↻ Refresh
                    </button>
                  </div>
                  {backups.length === 0 ? (
                    <div style={{ padding:"32px", color:theme.textDim,
                                  fontSize:13, textAlign:"center" }}>
                      No backups yet — click "Backup Now" to create the first one.
                    </div>
                  ) : (
                    <table style={{ width:"100%", borderCollapse:"collapse" }}>
                      <thead>
                        <tr style={{ background:theme.surfaceHigh, borderBottom:`1px solid ${theme.border}` }}>
                          {["File","Type","Created","Size",""].map(h => (
                            <th key={h} style={thStyle}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {backups.map((b, i) => (
                          <tr key={i} className="rm-table-row"
                            style={{ borderBottom:`1px solid ${theme.border}` }}>
                            <td style={{ padding:"10px 14px", fontSize:11,
                                         color:theme.textMuted, fontFamily:"monospace",
                                         maxWidth:260, overflow:"hidden",
                                         textOverflow:"ellipsis", whiteSpace:"nowrap" }}
                              title={b.filename}>
                              {b.filename}
                            </td>
                            <td style={{ padding:"10px 14px" }}>
                              <span className="rm-badge" style={{
                                background: b.label==="auto-daily" ? theme.infoMuted
                                          : b.label==="manual"     ? theme.surfaceHigh
                                          : theme.dangerMuted,
                                color: b.label==="auto-daily" ? theme.info
                                     : b.label==="manual"     ? theme.textMuted
                                     : theme.danger,
                              }}>
                                {b.label}
                              </span>
                            </td>
                            <td style={{ padding:"10px 14px", fontSize:11, color:theme.textMuted }}>
                              {new Date(b.created).toLocaleString()}
                            </td>
                            <td style={{ padding:"10px 14px", fontSize:11, color:theme.textDim }}>
                              {b.size ? fmtSize(b.size) : "—"}
                            </td>
                            <td style={{ padding:"10px 14px" }}>
                              <button className="rm-btn rm-btn-ghost rm-btn-sm"
                                style={{ color:theme.success, borderColor:theme.success+"44" }}
                                onClick={() => restoreBackup(b.filename)}>
                                Restore
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}
