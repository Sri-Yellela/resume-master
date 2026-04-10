// client/src/panels/AdminPanel.jsx — Lucy Brand (yellow accent)
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api }      from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";

// Lucy admin yellow accent — consistent across this panel
const ADMIN_ACCENT = "#F5E642";
const ADMIN_TEXT   = "#0f0f0f";

export function AdminPanel() {
  const { theme } = useTheme();
  const [users,    setUsers]    = useState([]);
  const [backups,  setBackups]  = useState([]);
  const [newU,     setNewU]     = useState({ username:"", password:"", isAdmin:false });
  const [status,   setStatus]   = useState("");
  const [bStatus,  setBStatus]  = useState("");
  const [backing,  setBacking]  = useState(false);
  const [section,  setSection]  = useState("users");

  useEffect(() => { loadUsers(); loadBackups(); }, []);

  const loadUsers   = () => api("/api/admin/users").then(setUsers).catch(() => {});
  const loadBackups = () => api("/api/admin/backups").then(setBackups).catch(() => {});

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

  return (
    <div style={{ padding:"32px 24px", overflowY:"auto", height:"100%",
                  boxSizing:"border-box", background:theme.bg, maxWidth:900,
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
      </div>

      {/* ── Section tabs — Lucy style ── */}
      <div style={{ display:"flex", borderBottom:`2px solid ${ADMIN_ACCENT}`, marginBottom:24 }}>
        {SECTIONS.map(([id, lbl]) => (
          <button key={id}
            style={{
              padding:"10px 20px", border:"none", cursor:"pointer",
              fontFamily:"'Barlow Condensed','DM Sans',sans-serif",
              fontWeight:800, fontSize:14, letterSpacing:"0.06em", textTransform:"uppercase",
              background: section===id ? ADMIN_ACCENT : "transparent",
              color: section===id ? ADMIN_TEXT : theme.textMuted,
              transition:"all 0.15s", borderRadius:"2px 2px 0 0",
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
            <div style={{ background:theme.surface, border:`1px solid ${theme.border}`,
                          borderRadius:16, overflow:"hidden" }}>
              <table style={{ width:"100%", borderCollapse:"collapse" }}>
                <thead>
                  <tr style={{ background:theme.surfaceHigh, borderBottom:`1px solid ${theme.border}` }}>
                    {["Username","Role","Mode","Created","Actions"].map(h => (
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
                        {u.apply_mode}
                      </td>
                      <td style={{ padding:"12px 14px", fontSize:11, color:theme.textDim }}>
                        {new Date(u.created_at * 1000).toLocaleDateString()}
                      </td>
                      <td style={{ padding:"12px 14px" }}>
                        <div style={{ display:"flex", gap:6 }}>
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
    </div>
  );
}
