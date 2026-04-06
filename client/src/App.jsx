// client/src/App.jsx — v8
// AuthScreen has its own full-page layout with no TopBar.
// TopBar + panels only mount after successful login.
import { useState, useEffect } from "react";
import { api }           from "./lib/api.js";
import AuthScreen        from "./components/AuthScreen.jsx";
import TopBar            from "./components/TopBar.jsx";
import JobsPanel         from "./panels/JobsPanel.jsx";
import { ProfilePanel }  from "./panels/ProfilePanel.jsx";
import { DatabasePanel } from "./panels/DatabasePanel.jsx";
import { AdminPanel }    from "./panels/AdminPanel.jsx";

export default function App() {
  const [authUser,    setAuthUser]    = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [activeTab,   setActiveTab]   = useState("jobs");

  useEffect(() => {
    api("/api/auth/me")
      .then(d => { if (d.authenticated) setAuthUser(d.user); })
      .catch(() => {})
      .finally(() => setAuthChecked(true));
  }, []);

  const handleLogout = async () => {
    await api("/api/auth/logout", { method:"POST" });
    setAuthUser(null);
  };

  // ── Loading splash ────────────────────────────────────────
  if (!authChecked) return (
    <div style={s.loading}>
      <div style={s.spinner}/>
      <span style={{ color:"#475569", fontSize:13 }}>Loading…</span>
    </div>
  );

  // ── Not logged in — full-page landing, NO TopBar ──────────
  if (!authUser) return <AuthScreen onLogin={setAuthUser}/>;

  // ── Logged in — TopBar + panels ───────────────────────────
  return (
    <div style={s.root}>
      <TopBar
        user={authUser}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onLogout={handleLogout}
        onUserChange={setAuthUser}
      />
      <div style={s.body}>
        {activeTab === "jobs"     && <JobsPanel     user={authUser} onUserChange={setAuthUser}/>}
        {activeTab === "database" && <DatabasePanel user={authUser}/>}
        {activeTab === "profile"  && <ProfilePanel  user={authUser}/>}
        {activeTab === "admin"    && authUser.isAdmin && <AdminPanel/>}
      </div>
    </div>
  );
}

const s = {
  root:    { fontFamily:"'Inter',Arial,sans-serif", fontSize:13, background:"#0f172a",
             height:"100vh", display:"flex", flexDirection:"column",
             overflow:"hidden", color:"#f8fafc" },
  body:    { flex:1, overflow:"hidden", display:"flex", flexDirection:"column" },
  loading: { height:"100vh", display:"flex", flexDirection:"column",
             alignItems:"center", justifyContent:"center",
             background:"#0f172a", gap:14 },
  spinner: { width:32, height:32, border:"3px solid #1e293b",
             borderTop:"3px solid #e879f9", borderRadius:"50%",
             animation:"spin 0.8s linear infinite" },
};
