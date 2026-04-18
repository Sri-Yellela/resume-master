// REVAMP v1 — App.jsx
import { useState, useEffect, useCallback } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { api }                   from "./lib/api.js";
import { useTheme }              from "./styles/theme.jsx";
import { useViewport }           from "./hooks/useViewport.js";
import { useInactivityLogout }   from "./hooks/useInactivityLogout.js";
import { useSyncEvents }         from "./hooks/useSyncEvents.js";
import AuthScreen                from "./components/AuthScreen.jsx";
import AdminLayout               from "./components/AdminLayout.jsx";
import AdminLoginPage            from "./pages/AdminLoginPage.jsx";
import DBInspector               from "./pages/admin/DBInspector.jsx";
import TopBar                    from "./components/TopBar.jsx";
import { AppScrollProvider, useAppScroll } from "./contexts/AppScrollContext.jsx";
import { JobBoardProvider }     from "./contexts/JobBoardContext.jsx";
import { ProfilePanel }          from "./panels/ProfilePanel.jsx";
import { DatabasePanel }         from "./panels/DatabasePanel.jsx";
import { PlansPanel }            from "./panels/PlansPanel.jsx";
import { SimpleApplyConsole, TailoredConsole, CustomSamplerConsole } from "./consoles/PlanConsoles.jsx";
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

const CONSOLE_BY_PLAN = {
  BASIC: { route:"simple-apply", label:"Simple Apply", icon:"SA", applyMode:"SIMPLE" },
  PLUS:  { route:"tailored", label:"Tailored", icon:"TR", applyMode:"TAILORED" },
  PRO:   { route:"custom-sampler", label:"Custom Sampler", icon:"CS", applyMode:"CUSTOM_SAMPLER" },
};

const CONSOLE_ROUTES = new Set(Object.values(CONSOLE_BY_PLAN).map(c => c.route));

function planTier(user) {
  const tier = String(user?.planTier || "BASIC").toUpperCase();
  return CONSOLE_BY_PLAN[tier] ? tier : "BASIC";
}
// AppShell: inside AppScrollProvider — drives dynamic paddingTop + tab visibility
function AppShell({ theme, isMobile, activeTab, handlePanelChange, appTabs, children }) {
  const { progress: p } = useAppScroll();
  const paddingTop = Math.round(52 * (1 - p));
  const showTabs   = p < 0.5;
  return (
    <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column", paddingTop }}>
      {showTabs && (
        <nav style={{
          display:"flex", alignItems:"center",
          background: theme.surface,
          borderBottom: `1px solid ${theme.border}`,
          padding: isMobile ? "0 12px" : "0 20px",
          flexShrink: 0,
        }}>
          {appTabs.map(t => {
            const isActive = activeTab === t.id;
            return (
              <button key={t.id} onClick={() => handlePanelChange(t.id)}
                style={{
                  background: "transparent", border: "none",
                  padding: isMobile ? "10px 8px" : "10px 14px",
                  fontFamily: "'Barlow Condensed','DM Sans',sans-serif",
                  fontWeight: isActive ? 800 : 600,
                  fontSize: 14, letterSpacing: "0.06em", textTransform: "uppercase",
                  color: isActive ? theme.text : theme.textMuted,
                  cursor: "pointer", position: "relative",
                  transition: "color 0.15s",
                }}>
                {isMobile ? t.icon : t.label}
                {isActive && (
                  <div style={{
                    position: "absolute", bottom: 0, left: "50%",
                    transform: "translateX(-50%)",
                    width: 16, height: 2, borderRadius: 999,
                    background: theme.accent,
                  }}/>
                )}
              </button>
            );
          })}
        </nav>
      )}
      {children}
    </div>
  );
}

function AppDashboard({ authUser, setAuthUser }) {
  const { theme } = useTheme();
  const { mode: vpMode } = useViewport();
  const isMobile = vpMode === "mobile" || vpMode === "tablet";
  const location = useLocation();
  const navigate = useNavigate();
  const [jobBoardRefreshKey, setJobBoardRefreshKey] = useState(0);
  const [resumeWidget,       setResumeWidget]       = useState(null);
  const consoleConfig = CONSOLE_BY_PLAN[planTier(authUser)];
  const consolePath = `/app/${consoleConfig.route}`;
  const routeKey = location.pathname.replace(/^\/app\/?/, "") || "";
  const activeTab = CONSOLE_ROUTES.has(routeKey) || routeKey === "" ? "console" : routeKey;
  const renderRoute = activeTab === "console" ? consoleConfig.route : routeKey;
  const appTabs = [
    { id:"console", label:consoleConfig.label, icon:consoleConfig.icon },
    { id:"database", label:"Database", icon:"DB" },
  ];

  const handleLogout = useCallback(async () => {
    try { await api("/api/auth/logout", { method:"POST" }); } catch {}
    setAuthUser(null);
  }, [setAuthUser]);

  const handlePanelChange = useCallback((tab) => {
    if (tab === "jobs" || tab === "console") {
      if (activeTab !== "console") setJobBoardRefreshKey(k => k + 1);
      navigate(consolePath);
      return;
    }
    if (["database","plans","profile"].includes(tab)) {
      navigate(`/app/${tab}`);
    }
  }, [activeTab, consolePath, navigate]);

  const handleProfileActivate = useCallback(() => {
    setJobBoardRefreshKey(k => k + 1);
  }, []);

  useInactivityLogout(handleLogout, true);

  useSyncEvents({
    plan_updated: ({ planTier, applyMode }) => {
      setAuthUser(u => u ? ({ ...u, planTier, applyMode, allowedModes:[applyMode] }) : u);
      const nextConsole = CONSOLE_BY_PLAN[planTier] || CONSOLE_BY_PLAN.BASIC;
      navigate(`/app/${nextConsole.route}`, { replace:true });
    },
  });

  useEffect(() => {
    if (!routeKey || routeKey === "jobs") {
      navigate(consolePath, { replace:true });
      return;
    }
    if (CONSOLE_ROUTES.has(routeKey) && routeKey !== consoleConfig.route) {
      navigate(consolePath, { replace:true });
      return;
    }
    if (!CONSOLE_ROUTES.has(routeKey) && !["database","plans","profile"].includes(routeKey)) {
      navigate(consolePath, { replace:true });
    }
  }, [routeKey, consoleConfig.route, consolePath, navigate]);

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
    <JobBoardProvider>
      <AppScrollProvider>
        <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13,
                      background:theme.bg, height:"100vh",
                      display:"flex", flexDirection:"column",
                      overflow:"hidden", color:theme.text,
                      backdropFilter: theme.backdrop,
                      WebkitBackdropFilter: theme.backdrop }}>

          {/* TopBar: position:fixed — takes no space in flex layout */}
          <TopBar
            user={authUser}
            onTabChange={handlePanelChange}
            onLogout={handleLogout}
            onUserChange={setAuthUser}
            resumeWidget={resumeWidget}
            onProfileActivate={handleProfileActivate}
          />

          {/* AppShell: reads scroll progress for dynamic paddingTop + tab visibility */}
          <AppShell theme={theme} isMobile={isMobile} activeTab={activeTab} handlePanelChange={handlePanelChange} appTabs={appTabs}>
            {/* Panels */}
            <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>
              {renderRoute === "simple-apply" && (
                <SimpleApplyConsole user={authUser} onUserChange={setAuthUser}
                  refreshKey={jobBoardRefreshKey} onResumeStateChange={setResumeWidget}
                  isActive={activeTab === "console"}/>
              )}
              {renderRoute === "tailored" && (
                <TailoredConsole user={authUser} onUserChange={setAuthUser}
                  refreshKey={jobBoardRefreshKey} onResumeStateChange={setResumeWidget}
                  isActive={activeTab === "console"}/>
              )}
              {renderRoute === "custom-sampler" && (
                <CustomSamplerConsole user={authUser} onUserChange={setAuthUser}
                  refreshKey={jobBoardRefreshKey} onResumeStateChange={setResumeWidget}
                  isActive={activeTab === "console"}/>
              )}
              {renderRoute === "database" && <DatabasePanel user={authUser}/>}
              {renderRoute === "plans"    && <PlansPanel user={authUser} onUserChange={setAuthUser}/>}
              {renderRoute === "profile"  && <ProfilePanel  user={authUser}/>}
            </div>
          </AppShell>
        </div>
      </AppScrollProvider>
    </JobBoardProvider>
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

      {/* Admin DB Inspector */}
      <Route path="/admin/db" element={
        !authUser
          ? <Navigate to="/admin/login" replace/>
          : !authUser.isAdmin
            ? <Navigate to="/app" replace/>
            : <AdminLayout user={authUser} onLogout={handleAdminLogout}><DBInspector/></AdminLayout>
      }/>

      {/* User login — redirect to /app if logged in as user, /admin if admin */}
      <Route path="/login" element={
        authUser
          ? (authUser.isAdmin ? <Navigate to="/admin" replace/> : <Navigate to="/app" replace/>)
          : <AuthScreen onLogin={setAuthUser}/>
      }/>

      {/* User app — redirect admin to /admin */}
      <Route path="/app/*" element={
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
