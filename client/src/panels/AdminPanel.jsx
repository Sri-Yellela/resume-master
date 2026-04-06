// client/src/panels/AdminPanel.jsx — v2
// Added: DB backup, restore, migration status
import { useState, useEffect } from "react";
import { api } from "../lib/api.js";

export function AdminPanel() {
  const [users,    setUsers]    = useState([]);
  const [backups,  setBackups]  = useState([]);
  const [newU,     setNewU]     = useState({ username:"", password:"", isAdmin:false });
  const [status,   setStatus]   = useState("");
  const [bStatus,  setBStatus]  = useState("");
  const [backing,  setBacking]  = useState(false);
  const [section,  setSection]  = useState("users"); // users | backups

  useEffect(() => { loadUsers(); loadBackups(); }, []);

  const loadUsers   = () => api("/api/admin/users").then(setUsers).catch(()=>{});
  const loadBackups = () => api("/api/admin/backups").then(setBackups).catch(()=>{});

  const createUser = async e => {
    e.preventDefault();
    try {
      await api("/api/admin/users",{method:"POST",body:JSON.stringify(newU)});
      setNewU({username:"",password:"",isAdmin:false});
      setStatus("✓ User created");
      loadUsers();
    } catch(e2) { setStatus("✗ "+e2.message); }
    setTimeout(()=>setStatus(""),3000);
  };

  const deleteUser = async id => {
    if (!confirm("Delete this user and all their data?")) return;
    await api(`/api/admin/users/${id}`,{method:"DELETE"});
    setUsers(u=>u.filter(x=>x.id!==id));
  };

  const resetQuota = async id => {
    await api(`/api/admin/users/${id}/refresh-quota`,{method:"DELETE"});
    alert("Quota reset.");
  };

  const triggerBackup = async () => {
    setBacking(true); setBStatus("");
    try {
      const r = await api("/api/admin/backups",{method:"POST",body:JSON.stringify({label:"manual"})});
      setBStatus(`✓ Backup created: ${r.filename}`);
      loadBackups();
    } catch(e) { setBStatus("✗ "+e.message); }
    setBacking(false);
    setTimeout(()=>setBStatus(""),6000);
  };

  const restoreBackup = async filename => {
    if (!confirm(`Restore from:\n${filename}\n\nCurrent data will be backed up first, then overwritten. The server must be restarted after restore. Continue?`)) return;
    try {
      const r = await api("/api/admin/backups/restore",{method:"POST",body:JSON.stringify({filename})});
      alert(`${r.message}\n\nRestart the server now to apply the restored database.`);
      loadBackups();
    } catch(e) { alert("Restore failed: "+e.message); }
  };

  const fmtSize = bytes => bytes > 1024*1024
    ? `${(bytes/1024/1024).toFixed(1)} MB`
    : `${(bytes/1024).toFixed(0)} KB`;

  const ai  = {padding:"6px 10px",borderRadius:5,border:"1px solid #334155",background:"#0f172a",color:"#f8fafc",fontSize:12,outline:"none",width:"100%",boxSizing:"border-box"};
  const abtn = bg => ({background:bg,color:"#fff",border:"none",borderRadius:4,padding:"3px 8px",cursor:"pointer",fontSize:10,fontWeight:700});

  return (
    <div style={{padding:"20px 24px",overflowY:"auto",height:"100%",boxSizing:"border-box"}}>
      <h2 style={{fontWeight:800,fontSize:15,color:"#38bdf8",marginBottom:18}}>🛡 Admin Panel</h2>

      {/* ── Section tabs ── */}
      <div style={{display:"flex",gap:3,marginBottom:20,background:"#0a0f1a",borderRadius:8,padding:3}}>
        {[["users","👥 Users"],["backups","💾 Backups"]].map(([id,lbl])=>(
          <button key={id}
            style={{flex:1,background:section===id?"#1e293b":"transparent",color:section===id?"#f8fafc":"#64748b",
              border:"none",borderRadius:6,padding:"7px 0",cursor:"pointer",fontSize:12,fontWeight:700}}
            onClick={()=>setSection(id)}>{lbl}</button>
        ))}
      </div>

      {/* ── USERS section ── */}
      {section==="users" && (
        <>
          {/* Create user */}
          <div style={{background:"#1e293b",borderRadius:10,padding:"16px 20px",marginBottom:22,maxWidth:440}}>
            <div style={{fontWeight:700,fontSize:12,color:"#f8fafc",marginBottom:12}}>Create User</div>
            <form onSubmit={createUser} style={{display:"flex",flexDirection:"column",gap:8}}>
              <input value={newU.username} onChange={e=>setNewU(u=>({...u,username:e.target.value}))} placeholder="Username" style={ai}/>
              <input type="password" value={newU.password} onChange={e=>setNewU(u=>({...u,password:e.target.value}))} placeholder="Password (min 8 chars)" style={ai}/>
              <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:"#cbd5e1"}}>
                <input type="checkbox" checked={newU.isAdmin} onChange={e=>setNewU(u=>({...u,isAdmin:e.target.checked}))} style={{accentColor:"#3b82f6"}}/>
                Admin user
              </label>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <button type="submit" style={{background:"#3b82f6",color:"#fff",border:"none",borderRadius:5,padding:"6px 16px",cursor:"pointer",fontWeight:700,fontSize:12}}>Create</button>
                {status&&<span style={{fontSize:11,color:status.startsWith("✓")?"#86efac":"#fca5a5"}}>{status}</span>}
              </div>
            </form>
          </div>

          {/* User table */}
          <div style={{background:"#1e293b",borderRadius:10,overflow:"hidden"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead>
                <tr style={{background:"#0a0f1a"}}>
                  {["Username","Role","Mode","Created","Actions"].map(h=>(
                    <th key={h} style={{padding:"8px 12px",textAlign:"left",fontSize:10,fontWeight:700,color:"#475569",borderBottom:"1px solid #334155"}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map(u=>(
                  <tr key={u.id} style={{borderBottom:"1px solid #1e293b"}}>
                    <td style={{padding:"7px 12px",fontSize:12,color:"#f8fafc",fontWeight:600}}>{u.username}</td>
                    <td style={{padding:"7px 12px"}}><span style={{fontSize:10,color:u.is_admin?"#f59e0b":"#94a3b8",fontWeight:700}}>{u.is_admin?"Admin":"User"}</span></td>
                    <td style={{padding:"7px 12px",fontSize:11,color:"#64748b"}}>{u.apply_mode}</td>
                    <td style={{padding:"7px 12px",fontSize:10,color:"#475569"}}>{new Date(u.created_at*1000).toLocaleDateString()}</td>
                    <td style={{padding:"7px 12px"}}>
                      <div style={{display:"flex",gap:5}}>
                        <button style={abtn("#f59e0b")} onClick={()=>resetQuota(u.id)}>Reset Quota</button>
                        {!u.is_admin&&<button style={abtn("#ef4444")} onClick={()=>deleteUser(u.id)}>Delete</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── BACKUPS section ── */}
      {section==="backups" && (
        <>
          {/* Actions */}
          <div style={{background:"#1e293b",borderRadius:10,padding:"16px 20px",marginBottom:22,maxWidth:560}}>
            <div style={{fontWeight:700,fontSize:12,color:"#f8fafc",marginBottom:8}}>Database Backup</div>
            <div style={{fontSize:11,color:"#64748b",lineHeight:1.6,marginBottom:12}}>
              Backups are saved to <code style={{color:"#94a3b8"}}>data/backups/</code> and kept for the last 30 snapshots.
              An automatic backup runs daily at 2:00 AM. Restore creates a safety backup of the current DB before overwriting.
              After restoring, <strong style={{color:"#f8fafc"}}>restart the server</strong> to apply.
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <button
                style={{background:"#3b82f6",color:"#fff",border:"none",borderRadius:5,
                  padding:"7px 16px",cursor:"pointer",fontWeight:700,fontSize:12,
                  opacity:backing?0.5:1}}
                disabled={backing}
                onClick={triggerBackup}>
                {backing?"Creating backup…":"💾 Backup Now"}
              </button>
              {bStatus&&<span style={{fontSize:11,color:bStatus.startsWith("✓")?"#86efac":"#fca5a5"}}>{bStatus}</span>}
            </div>
          </div>

          {/* Backup list */}
          <div style={{background:"#1e293b",borderRadius:10,overflow:"hidden",maxWidth:700}}>
            <div style={{background:"#0a0f1a",padding:"8px 12px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <span style={{fontSize:10,fontWeight:700,color:"#475569",textTransform:"uppercase",letterSpacing:"0.8px"}}>
                Restore Points ({backups.length})
              </span>
              <button style={{background:"transparent",border:"none",color:"#64748b",fontSize:10,cursor:"pointer"}} onClick={loadBackups}>↻ Refresh</button>
            </div>
            {backups.length===0 ? (
              <div style={{padding:"24px",color:"#334155",fontSize:12,textAlign:"center"}}>
                No backups yet — click "Backup Now" to create the first one.
              </div>
            ) : (
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead>
                  <tr style={{background:"#0a0f1a"}}>
                    {["File","Type","Created","Size",""].map(h=>(
                      <th key={h} style={{padding:"7px 12px",textAlign:"left",fontSize:10,fontWeight:700,color:"#475569",borderBottom:"1px solid #334155"}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {backups.map((b,i)=>(
                    <tr key={i} style={{borderBottom:"1px solid #0f172a"}}>
                      <td style={{padding:"7px 12px",fontSize:10,color:"#94a3b8",fontFamily:"monospace",maxWidth:260,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}
                        title={b.filename}>{b.filename}</td>
                      <td style={{padding:"7px 12px"}}>
                        <span style={{background:b.label==="auto-daily"?"#1e3a5f":b.label==="manual"?"#1e293b":"#3b1d1d",
                          color:b.label==="auto-daily"?"#38bdf8":b.label==="manual"?"#94a3b8":"#fca5a5",
                          fontSize:9,fontWeight:700,padding:"2px 7px",borderRadius:6}}>
                          {b.label}
                        </span>
                      </td>
                      <td style={{padding:"7px 12px",fontSize:10,color:"#64748b"}}>
                        {new Date(b.created).toLocaleString()}
                      </td>
                      <td style={{padding:"7px 12px",fontSize:10,color:"#475569"}}>
                        {b.size ? fmtSize(b.size) : "—"}
                      </td>
                      <td style={{padding:"7px 12px"}}>
                        <button style={abtn("#10b981")} onClick={()=>restoreBackup(b.filename)}>
                          Restore
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
