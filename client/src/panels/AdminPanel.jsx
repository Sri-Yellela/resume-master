// REVAMP v2 — AdminPanel.jsx (shadcn UI integrated)
// Added: DB backup, restore, migration status
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api }      from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Separator } from "../components/ui/separator";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "../components/ui/alert-dialog";
import {
  Table, TableBody, TableCell, TableHead,
  TableHeader, TableRow,
} from "../components/ui/table";

export function AdminPanel() {
  const { theme } = useTheme();
  const [users,    setUsers]    = useState([]);
  const [backups,  setBackups]  = useState([]);
  const [newU,     setNewU]     = useState({ username:"", password:"", isAdmin:false });
  const [status,   setStatus]   = useState("");
  const [bStatus,  setBStatus]  = useState("");
  const [backing,  setBacking]  = useState(false);
  const [section,  setSection]  = useState("users"); // users | backups

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

  const resetQuota = async id => {
    await api(`/api/admin/users/${id}/refresh-quota`, { method:"DELETE" });
    alert("Quota reset.");
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

  const SECTIONS = [["users","👥 Users"],["backups","💾 Backups"]];

  return (
    <div style={{ padding:"20px 24px", overflowY:"auto", height:"100%",
                  boxSizing:"border-box", background:theme.gradBg }}>
      <h2 style={{ fontWeight:800, fontSize:15, color:theme.colorPrimary, marginBottom:18 }}>
        🛡 Admin Panel
      </h2>

      {/* ── Section tabs ── */}
      <div style={{ display:"flex", gap:3, marginBottom:20,
                    background:`rgba(0,0,0,0.3)`, borderRadius:8, padding:3 }}>
        {SECTIONS.map(([id, lbl]) => (
          <button key={id}
            style={{ position:"relative", flex:1,
                     background:section===id ? theme.colorSurface : "transparent",
                     color:section===id ? theme.colorText : theme.colorMuted,
                     border:"none", borderRadius:6, padding:"7px 0",
                     cursor:"pointer", fontSize:12, fontWeight:700,
                     overflow:"hidden" }}
            onClick={() => setSection(id)}>
            {lbl}
            {section === id && (
              <motion.div layoutId="admin-tab-indicator"
                style={{ position:"absolute", bottom:0, left:"10%", right:"10%",
                         height:2, background:theme.colorPrimary, borderRadius:1 }}/>
            )}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {section === "users" && (
          <motion.div key="users"
            initial={{ opacity:0, y:6 }} animate={{ opacity:1, y:0 }}
            exit={{ opacity:0, y:-6 }} transition={{ duration:0.18 }}>

            {/* Create user */}
            <Card style={{ background:theme.gradPanel, borderColor:theme.colorBorder,
                           marginBottom:22, maxWidth:440 }}>
              <CardHeader style={{ padding:"16px 20px 8px" }}>
                <CardTitle style={{ fontWeight:700, fontSize:12, color:theme.colorText }}>
                  Create User
                </CardTitle>
              </CardHeader>
              <CardContent style={{ padding:"0 20px 16px" }}>
                <form onSubmit={createUser} style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  <Input value={newU.username}
                    onChange={e => setNewU(u => ({ ...u, username:e.target.value }))}
                    placeholder="Username"
                    style={{ background:theme.colorSurface, borderColor:theme.colorBorder,
                             color:theme.colorText, fontSize:12 }}/>
                  <Input type="password" value={newU.password}
                    onChange={e => setNewU(u => ({ ...u, password:e.target.value }))}
                    placeholder="Password (min 8 chars)"
                    style={{ background:theme.colorSurface, borderColor:theme.colorBorder,
                             color:theme.colorText, fontSize:12 }}/>
                  <label style={{ display:"flex", alignItems:"center", gap:6,
                                  fontSize:12, color:theme.colorText }}>
                    <input type="checkbox" checked={newU.isAdmin}
                      onChange={e => setNewU(u => ({ ...u, isAdmin:e.target.checked }))}
                      style={{ accentColor:theme.colorPrimary }}/>
                    Admin user
                  </label>
                  <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                    <Button type="submit"
                      style={{ background:theme.colorPrimary, color:"#000",
                               fontSize:10, padding:"3px 8px", height:"auto" }}>
                      Create
                    </Button>
                    {status && (
                      <span style={{ fontSize:11,
                        color:status.startsWith("✓") ? "#86efac" : "#fca5a5" }}>
                        {status}
                      </span>
                    )}
                  </div>
                </form>
              </CardContent>
            </Card>

            {/* User table */}
            <div style={{ background:theme.gradPanel, border:`1px solid ${theme.colorBorder}`,
                          borderRadius:10, overflow:"hidden" }}>
              <table style={{ width:"100%", borderCollapse:"collapse" }}>
                <thead>
                  <tr style={{ background:`rgba(0,0,0,0.3)` }}>
                    {["Username","Role","Mode","Created","Actions"].map(h => (
                      <th key={h} style={{ padding:"8px 12px", textAlign:"left",
                                          fontSize:10, fontWeight:700,
                                          color:theme.colorMuted, textTransform:"uppercase",
                                          letterSpacing:"0.06em",
                                          borderBottom:`1px solid ${theme.colorBorder}` }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {users.map((u, i) => (
                    <tr key={u.id}
                      style={{ background:i%2===0 ? theme.gradPanel : "rgba(0,0,0,0.2)",
                               borderBottom:`1px solid ${theme.colorBorder}` }}>
                      <td style={{ padding:"7px 12px", fontSize:12,
                                   color:theme.colorText, fontWeight:600 }}>
                        {u.username}
                      </td>
                      <td style={{ padding:"7px 12px" }}>
                        <Badge variant="outline"
                          style={{
                            fontSize:10, fontWeight:700,
                            background:u.is_admin
                              ? `rgba(${hexToRgb(theme.colorPrimary)},0.2)`
                              : `rgba(255,255,255,0.06)`,
                            color:u.is_admin ? theme.colorPrimary : theme.colorMuted,
                            borderColor:u.is_admin ? theme.colorPrimary : theme.colorBorder,
                          }}>
                          {u.is_admin ? "Admin" : "User"}
                        </Badge>
                      </td>
                      <td style={{ padding:"7px 12px", fontSize:11, color:theme.colorMuted }}>
                        {u.apply_mode}
                      </td>
                      <td style={{ padding:"7px 12px", fontSize:10, color:theme.colorDim }}>
                        {new Date(u.created_at * 1000).toLocaleDateString()}
                      </td>
                      <td style={{ padding:"7px 12px" }}>
                        <div style={{ display:"flex", gap:5 }}>
                          <ABtn theme={theme} bg={theme.colorSecondary}
                            onClick={() => resetQuota(u.id)}>
                            Reset Quota
                          </ABtn>
                          {!u.is_admin && (
                            <ABtn theme={theme} bg="#ef4444"
                              onClick={() => deleteUser(u.id)}>
                              Delete
                            </ABtn>
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

            {/* Actions */}
            <Card style={{ background:theme.gradPanel, borderColor:theme.colorBorder,
                           marginBottom:22, maxWidth:560 }}>
              <CardHeader style={{ padding:"16px 20px 8px" }}>
                <CardTitle style={{ fontWeight:700, fontSize:12, color:theme.colorText }}>
                  Database Backup
                </CardTitle>
              </CardHeader>
              <CardContent style={{ padding:"0 20px 16px" }}>
                <div style={{ fontSize:11, color:theme.colorMuted,
                              lineHeight:1.6, marginBottom:12 }}>
                  Backups are saved to{" "}
                  <code style={{ color:theme.colorAccent }}>data/backups/</code>{" "}
                  and kept for the last 30 snapshots.
                  An automatic backup runs daily at 2:00 AM. Restore creates a safety backup
                  of the current DB before overwriting.
                  After restoring, <strong style={{ color:theme.colorText }}>restart the server</strong> to apply.
                </div>
                <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                  <Button
                    disabled={backing} onClick={triggerBackup}
                    style={{ background:theme.colorPrimary, color:"#000",
                             fontSize:12, padding:"7px 16px", height:"auto" }}>
                    {backing ? "Creating backup…" : "💾 Backup Now"}
                  </Button>
                  {bStatus && (
                    <span style={{ fontSize:11,
                      color:bStatus.startsWith("✓") ? "#86efac" : "#fca5a5" }}>
                      {bStatus}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Backup list */}
            <div style={{ background:theme.gradPanel, border:`1px solid ${theme.colorBorder}`,
                          borderRadius:10, overflow:"hidden", maxWidth:700 }}>
              <div style={{ background:`rgba(0,0,0,0.3)`, padding:"8px 12px",
                            display:"flex", alignItems:"center",
                            justifyContent:"space-between" }}>
                <span style={{ fontSize:10, fontWeight:700, color:theme.colorMuted,
                               textTransform:"uppercase", letterSpacing:"0.8px" }}>
                  Restore Points ({backups.length})
                </span>
                <button style={{ background:"transparent", border:"none",
                                 color:theme.colorMuted, fontSize:10, cursor:"pointer" }}
                  onClick={loadBackups}>
                  ↻ Refresh
                </button>
              </div>
              {backups.length === 0 ? (
                <div style={{ padding:"24px", color:theme.colorDim,
                              fontSize:12, textAlign:"center" }}>
                  No backups yet — click "Backup Now" to create the first one.
                </div>
              ) : (
                <table style={{ width:"100%", borderCollapse:"collapse" }}>
                  <thead>
                    <tr style={{ background:`rgba(0,0,0,0.3)` }}>
                      {["File","Type","Created","Size",""].map(h => (
                        <th key={h} style={{ padding:"7px 12px", textAlign:"left",
                                            fontSize:10, fontWeight:700,
                                            color:theme.colorMuted,
                                            textTransform:"uppercase",
                                            letterSpacing:"0.06em",
                                            borderBottom:`1px solid ${theme.colorBorder}` }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {backups.map((b, i) => (
                      <tr key={i}
                        style={{ borderBottom:`1px solid ${theme.colorBorder}`,
                                 background:i%2===0 ? "transparent" : "rgba(0,0,0,0.15)" }}>
                        <td style={{ padding:"7px 12px", fontSize:10,
                                     color:theme.colorMuted, fontFamily:"monospace",
                                     maxWidth:260, overflow:"hidden",
                                     textOverflow:"ellipsis", whiteSpace:"nowrap" }}
                          title={b.filename}>
                          {b.filename}
                        </td>
                        <td style={{ padding:"7px 12px" }}>
                          <Badge variant="outline"
                            style={{
                              background:b.label==="auto-daily"
                                ? `rgba(${hexToRgb(theme.colorPrimary)},0.15)`
                                : b.label==="manual"
                                  ? `rgba(255,255,255,0.08)`
                                  : "rgba(239,68,68,0.15)",
                              color:b.label==="auto-daily" ? theme.colorPrimary
                                : b.label==="manual" ? theme.colorMuted : "#fca5a5",
                              borderColor:theme.colorBorder,
                              fontSize:9, fontWeight:700,
                            }}>
                            {b.label}
                          </Badge>
                        </td>
                        <td style={{ padding:"7px 12px", fontSize:10, color:theme.colorMuted }}>
                          {new Date(b.created).toLocaleString()}
                        </td>
                        <td style={{ padding:"7px 12px", fontSize:10, color:theme.colorDim }}>
                          {b.size ? fmtSize(b.size) : "—"}
                        </td>
                        <td style={{ padding:"7px 12px" }}>
                          <ABtn theme={theme} bg="#10b981"
                            onClick={() => restoreBackup(b.filename)}>
                            Restore
                          </ABtn>
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

function hexToRgb(hex) {
  const h = hex.replace("#","");
  const n = parseInt(h.length === 3
    ? h.split("").map(c => c+c).join("") : h, 16);
  return `${(n>>16)&255},${(n>>8)&255},${n&255}`;
}

function ABtn({ theme, bg, onClick, children, disabled, lg, type = "button" }) {
  const [hov, setHov] = useState(false);
  return (
    <button type={type}
      style={{ position:"relative", overflow:"hidden",
               background:disabled ? theme.colorDim : (hov ? "transparent" : bg),
               color:disabled ? theme.colorMuted : "#fff",
               border:`1px solid ${disabled ? theme.colorDim : bg}`,
               borderRadius:5,
               padding:lg ? "7px 16px" : "3px 8px",
               cursor:disabled ? "not-allowed" : "pointer",
               fontSize:lg ? 12 : 10, fontWeight:700,
               opacity:disabled ? 0.5 : 1, transition:"color 0.2s" }}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}>
      <span style={{
        position:"absolute", inset:0, background:bg,
        transform:hov && !disabled ? "translateY(0)" : "translateY(100%)",
        transition:"transform 0.2s ease", zIndex:0,
      }}/>
      <span style={{ position:"relative", zIndex:1 }}>{children}</span>
    </button>
  );
}
