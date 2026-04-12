// REVAMP v1 — App.jsx
import { useState, useEffect, useCallback } from "react";
import { api }                   from "./lib/api.js";
import { useTheme }              from "./styles/theme.jsx";
import { useViewport }           from "./hooks/useViewport.js";
import { useInactivityLogout }   from "./hooks/useInactivityLogout.js";
import AuthScreen                from "./components/AuthScreen.jsx";
import TopBar                    from "./components/TopBar.jsx";
import JobsPanel                 from "./panels/JobsPanel.jsx";
import { ProfilePanel }          from "./panels/ProfilePanel.jsx";
import { DatabasePanel }         from "./panels/DatabasePanel.jsx";
import { AdminPanel }            from "./panels/AdminPanel.jsx";

export default function App() {
  const { theme } = useTheme();
  const { mode: vpMode } = useViewport();
  const [authUser,           setAuthUser]           = useState(null);
  const [authChecked,        setAuthChecked]        = useState(false);
  const [activeTab,          setActiveTab]          = useState("jobs");
  const [jobBoardRefreshKey, setJobBoardRefreshKey] = useState(0);
  const [resumeWidget,       setResumeWidget]       = useState(null);

  useEffect(() => {
    api("/api/auth/me")
      .then(d => { if (d.authenticated) setAuthUser(d.user); })
      .catch(() => {})
      .finally(() => setAuthChecked(true));
  }, []);

  const handleLogout = useCallback(async () => {
    try { await api("/api/auth/logout", { method:"POST" }); } catch {}
    setAuthUser(null);
  }, []);

  // Navigate between panels; switching back to Jobs triggers a board refresh
  const handlePanelChange = useCallback((tab) => {
    if (tab === "jobs" && activeTab !== "jobs") {
      setJobBoardRefreshKey(k => k + 1);
    }
    setActiveTab(tab);
  }, [activeTab]);

  useInactivityLogout(handleLogout, !!authUser);

  // Re-check auth on tab focus — handles session expiry while tab was hidden
  useEffect(() => {
    const handleVisibility = async () => {
      if (document.visibilityState !== "visible" || !authUser) return;
      try {
        const d = await api("/api/auth/me");
        if (!d.authenticated) handleLogout();
      } catch {}
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [authUser, handleLogout]);

  if (!authChecked) return (
    <div style={{ height:"100vh", display:"flex", flexDirection:"column",
                  alignItems:"center", justifyContent:"center",
                  background:theme.bg, gap:14 }}>
      <div style={{ width:32, height:32,
                    border:`3px solid ${theme.border}`,
                    borderTop:`3px solid ${theme.accent}`,
                    borderRadius:"50%", animation:"spin 0.8s linear infinite" }}/>
      <span style={{ color:theme.textMuted, fontSize:13 }}>Loading…</span>
    </div>
  );

  if (!authUser) return <AuthScreen onLogin={setAuthUser}/>;

  return (
    <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13,
                  background:theme.bg, height:"100vh",
                  display:"flex", flexDirection:"column",
                  overflow:"hidden", color:theme.text }}>
      <TopBar
        user={authUser}
        activeTab={activeTab}
        onTabChange={handlePanelChange}
        onLogout={handleLogout}
        onUserChange={setAuthUser}
        resumeWidget={resumeWidget}
      />
      <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>
        {/* JobsPanel stays mounted across tab switches so state is preserved.
            display:none hides it without unmounting — scroll, selected job,
            ATS panel, and sandbox all survive navigation away and back. */}
        <div style={{ display: activeTab === "jobs" ? "flex" : "none",
                      flex: 1, flexDirection: "column", overflow: "hidden" }}>
          <JobsPanel user={authUser} onUserChange={setAuthUser}
            refreshKey={jobBoardRefreshKey} onResumeStateChange={setResumeWidget}
            isActive={activeTab === "jobs"}/>
        </div>
        {activeTab === "database" && <DatabasePanel user={authUser}/>}
        {activeTab === "profile"  && <ProfilePanel  user={authUser}/>}
        {activeTab === "admin"    && authUser.isAdmin && <AdminPanel/>}
      </div>
    </div>
  );
}
