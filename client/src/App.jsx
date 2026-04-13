// REVAMP v1 — App.jsx
import { useState, useEffect, useCallback } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
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

// Marketing pages (lazy-loaded is fine but direct imports work too)
import { FeaturesPage }    from "./pages/marketing/FeaturesPage.jsx";
import { HowItWorksPage }  from "./pages/marketing/HowItWorksPage.jsx";
import { PricingPage }     from "./pages/marketing/PricingPage.jsx";
import { AboutPage }       from "./pages/marketing/AboutPage.jsx";
import { ContactPage }     from "./pages/marketing/ContactPage.jsx";
import { FAQPage }         from "./pages/marketing/FAQPage.jsx";
import { PrivacyPage }     from "./pages/marketing/PrivacyPage.jsx";
import { TermsPage }       from "./pages/marketing/TermsPage.jsx";

function AppDashboard({ authUser, setAuthUser }) {
  const { theme } = useTheme();
  const { mode: vpMode } = useViewport();
  const [activeTab,          setActiveTab]          = useState("jobs");
  const [jobBoardRefreshKey, setJobBoardRefreshKey] = useState(0);
  const [resumeWidget,       setResumeWidget]       = useState(null);

  const handleLogout = useCallback(async () => {
    try { await api("/api/auth/logout", { method:"POST" }); } catch {}
    setAuthUser(null);
  }, [setAuthUser]);

  const handlePanelChange = useCallback((tab) => {
    if (tab === "jobs" && activeTab !== "jobs") setJobBoardRefreshKey(k => k + 1);
    setActiveTab(tab);
  }, [activeTab]);

  useInactivityLogout(handleLogout, true);

  useEffect(() => {
    const handleVisibility = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const d = await api("/api/auth/me");
        if (!d.authenticated) handleLogout();
      } catch {}
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [handleLogout]);

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

function AppRouter() {
  const { theme } = useTheme();
  const [authUser,    setAuthUser]    = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    api("/api/auth/me")
      .then(d => { if (d.authenticated) setAuthUser(d.user); })
      .catch(() => {})
      .finally(() => setAuthChecked(true));
  }, []);

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

  return (
    <Routes>
      {/* Marketing pages — always public */}
      <Route path="/features"    element={<FeaturesPage/>}/>
      <Route path="/how-it-works" element={<HowItWorksPage/>}/>
      <Route path="/pricing"     element={<PricingPage/>}/>
      <Route path="/about"       element={<AboutPage/>}/>
      <Route path="/contact"     element={<ContactPage/>}/>
      <Route path="/faq"         element={<FAQPage/>}/>
      <Route path="/privacy"     element={<PrivacyPage/>}/>
      <Route path="/terms"       element={<TermsPage/>}/>

      {/* Auth page — redirect to / if already logged in */}
      <Route path="/login" element={
        authUser
          ? <Navigate to="/" replace/>
          : <AuthScreen onLogin={setAuthUser}/>
      }/>

      {/* App dashboard — redirect to /login if not authenticated */}
      <Route path="/*" element={
        authUser
          ? <AppDashboard authUser={authUser} setAuthUser={setAuthUser}/>
          : <Navigate to="/login" replace/>
      }/>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRouter/>
    </BrowserRouter>
  );
}
