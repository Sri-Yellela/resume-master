// REVAMP v1 — App.jsx
import { useState, useEffect } from "react";
import { api }           from "./lib/api.js";
import { useTheme }      from "./styles/theme.jsx";
import AuthScreen        from "./components/AuthScreen.jsx";
import TopBar            from "./components/TopBar.jsx";
import JobsPanel         from "./panels/JobsPanel.jsx";
import { ProfilePanel }  from "./panels/ProfilePanel.jsx";
import { DatabasePanel } from "./panels/DatabasePanel.jsx";
import { AdminPanel }    from "./panels/AdminPanel.jsx";

export default function App() {
  const { theme } = useTheme();
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

  if (!authChecked) return (
    <div style={{ height:"100vh", display:"flex", flexDirection:"column",
                  alignItems:"center", justifyContent:"center",
                  background:theme.gradBg, gap:14 }}>
      <div style={{ width:32, height:32,
                    border:`3px solid ${theme.colorSurface}`,
                    borderTop:`3px solid ${theme.colorPrimary}`,
                    borderRadius:"50%", animation:"spin 0.8s linear infinite" }}/>
      <span style={{ color:theme.colorMuted, fontSize:13 }}>Loading…</span>
    </div>
  );

  if (!authUser) return <AuthScreen onLogin={setAuthUser}/>;

  return (
    <div style={{ fontFamily:"'Inter',Arial,sans-serif", fontSize:13,
                  background:theme.gradBg, height:"100vh",
                  display:"flex", flexDirection:"column",
                  overflow:"hidden", color:theme.colorText }}>
      <TopBar
        user={authUser}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onLogout={handleLogout}
        onUserChange={setAuthUser}
      />
      <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>
        {activeTab === "jobs"     && <JobsPanel     user={authUser} onUserChange={setAuthUser}/>}
        {activeTab === "database" && <DatabasePanel user={authUser}/>}
        {activeTab === "profile"  && <ProfilePanel  user={authUser}/>}
        {activeTab === "admin"    && authUser.isAdmin && <AdminPanel/>}
      </div>
    </div>
  );
}
