// REVAMP v1 — App.jsx
import { useState, useEffect, useCallback } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { api }                   from "./lib/api.js";
import { useTheme }              from "./styles/theme.jsx";
import { useViewport }           from "./hooks/useViewport.js";
import { useInactivityLogout }   from "./hooks/useInactivityLogout.js";
import AuthScreen                from "./components/AuthScreen.jsx";
import AdminLayout               from "./components/AdminLayout.jsx";
import AdminLoginPage            from "./pages/AdminLoginPage.jsx";
import DomainProfileWizard       from "./components/DomainProfileWizard.jsx";
import TopBar                    from "./components/TopBar.jsx";
import JobsPanel                 from "./panels/JobsPanel.jsx";
import { ProfilePanel }          from "./panels/ProfilePanel.jsx";
import { DatabasePanel }         from "./panels/DatabasePanel.jsx";
import { ATSToolPage }           from "./pages/tools/ATSToolPage.jsx";
import { GenerateToolPage }      from "./pages/tools/GenerateToolPage.jsx";
import { ApplyToolPage }         from "./pages/tools/ApplyToolPage.jsx";

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
  // Domain profile onboarding: show blocking wizard if not complete
  const [showProfileWizard,  setShowProfileWizard]  = useState(
    !authUser?.domain_profile_complete
  );

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
      {/* Blocking domain profile wizard — shown until onboarding complete */}
      {showProfileWizard && (
        <DomainProfileWizard
          bannerText="Before you continue, help us personalise your job search. This takes 2 minutes and unlocks targeted results for your domain."
          onComplete={async (profile) => {
            try { await api("/api/auth/complete-profile", { method: "PATCH" }); } catch {}
            setAuthUser(u => ({ ...u, domain_profile_complete: 1 }));
            setShowProfileWizard(false);
          }}
        />
      )}
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
      </div>
    </div>
  );
}

function AppRouter() {
  const { theme } = useTheme();
  const [authUser,    setAuthUser]    = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  const handleAdminLogout = useCallback(async () => {
    try { await api("/api/auth/logout", { method:"POST" }); } catch {}
    setAuthUser(null);
  }, []);

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
      {/* Standalone tool pages — always public */}
      <Route path="/tools/ats"      element={<ATSToolPage/>}/>
      <Route path="/tools/generate" element={<GenerateToolPage/>}/>
      <Route path="/tools/apply"    element={<ApplyToolPage/>}/>

      {/* Marketing pages — always public */}
      <Route path="/features"     element={<FeaturesPage/>}/>
      <Route path="/how-it-works" element={<HowItWorksPage/>}/>
      <Route path="/pricing"      element={<PricingPage/>}/>
      <Route path="/about"        element={<AboutPage/>}/>
      <Route path="/contact"      element={<ContactPage/>}/>
      <Route path="/faq"          element={<FAQPage/>}/>
      <Route path="/privacy"      element={<PrivacyPage/>}/>
      <Route path="/terms"        element={<TermsPage/>}/>

      {/* Admin login — redirect if already authenticated */}
      <Route path="/admin/login" element={
        authUser
          ? (authUser.isAdmin ? <Navigate to="/admin" replace/> : <Navigate to="/app" replace/>)
          : <AdminLoginPage onLogin={setAuthUser}/>
      }/>

      {/* Admin dashboard — requires auth + isAdmin */}
      <Route path="/admin" element={
        !authUser
          ? <Navigate to="/admin/login" replace/>
          : !authUser.isAdmin
            ? <Navigate to="/app" replace/>
            : <AdminLayout user={authUser} onLogout={handleAdminLogout}/>
      }/>

      {/* User login — redirect to /app if logged in as user, /admin if admin */}
      <Route path="/login" element={
        authUser
          ? (authUser.isAdmin ? <Navigate to="/admin" replace/> : <Navigate to="/app" replace/>)
          : <AuthScreen onLogin={setAuthUser}/>
      }/>

      {/* User app — redirect admin to /admin */}
      <Route path="/app" element={
        !authUser
          ? <Navigate to="/login" replace/>
          : authUser.isAdmin
            ? <Navigate to="/admin" replace/>
            : <AppDashboard authUser={authUser} setAuthUser={setAuthUser}/>
      }/>

      {/* Root and catch-all: redirect based on auth state */}
      <Route path="/" element={
        !authUser
          ? <Navigate to="/login" replace/>
          : authUser.isAdmin
            ? <Navigate to="/admin" replace/>
            : <Navigate to="/app" replace/>
      }/>
      <Route path="*" element={
        !authUser
          ? <Navigate to="/login" replace/>
          : authUser.isAdmin
            ? <Navigate to="/admin" replace/>
            : <Navigate to="/app" replace/>
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
