// REVAMP v1 — App.jsx
import { useState, useEffect, useCallback } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { api, setAuthContext }   from "./lib/api.js";
import { useTheme }              from "./styles/theme.jsx";
import { useInactivityLogout }   from "./hooks/useInactivityLogout.js";
import { useSyncEvents }         from "./hooks/useSyncEvents.js";
import AuthScreen                from "./components/AuthScreen.jsx";
import AdminLayout               from "./components/AdminLayout.jsx";
import AdminLoginPage            from "./pages/AdminLoginPage.jsx";
import DBInspector               from "./pages/admin/DBInspector.jsx";
import TopBar                    from "./components/TopBar.jsx";
import AppShell                  from "./components/AppShell.jsx";
import { AppScrollProvider } from "./contexts/AppScrollContext.jsx";
import { JobBoardProvider }     from "./contexts/JobBoardContext.jsx";
import { ProfilePanel }          from "./panels/ProfilePanel.jsx";
import { JobProfilesPanel }      from "./panels/JobProfilesPanel.jsx";
import { DatabasePanel }         from "./panels/DatabasePanel.jsx";
import { PlansPanel }            from "./panels/PlansPanel.jsx";
import { IntegrationsPanel }     from "./panels/IntegrationsPanel.jsx";
import { JobsConsole }            from "./consoles/PlanConsoles.jsx";
import JobDetailPanel            from "./components/JobDetailPanel.jsx";
import UnifiedSearchBar          from "./components/UnifiedSearchBar.jsx";
import { ATSToolPage }           from "./pages/tools/ATSToolPage.jsx";
import { GenerateToolPage }      from "./pages/tools/GenerateToolPage.jsx";
import { ApplyToolPage }         from "./pages/tools/ApplyToolPage.jsx";

import LandingPage    from "./pages/LandingPage.jsx";
import NavBar         from "./components/NavBar.jsx";
import ProductsPage   from "./pages/ProductsPage.jsx";
import BlogPage       from "./pages/BlogPage.jsx";
import NotFoundPage   from "./pages/NotFoundPage.jsx";

// Marketing pages (lazy-loaded is fine but direct imports work too)
import { FeaturesPage }    from "./pages/marketing/FeaturesPage.jsx";
import { HowItWorksPage }  from "./pages/marketing/HowItWorksPage.jsx";
import { PricingPage }     from "./pages/marketing/PricingPage.jsx";
import { AboutPage }       from "./pages/marketing/AboutPage.jsx";
import { ContactPage }     from "./pages/marketing/ContactPage.jsx";
import { FAQPage }         from "./pages/marketing/FAQPage.jsx";
import { PrivacyPage }     from "./pages/marketing/PrivacyPage.jsx";
import { TermsPage }       from "./pages/marketing/TermsPage.jsx";

const CONSOLE_ROUTE = "jobs";
const LEGACY_CONSOLE_ROUTES = new Set(["simple-apply", "tailored", "custom-sampler"]);

function AuthBootstrapScreen({ theme }) {
  return (
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
}

function UserRouteGate({ authStatus, authUser, children }) {
  if (authStatus === "unknown") return null;
  if (authStatus !== "authenticated" || !authUser) return <Navigate to="/login" replace/>;
  if (authUser.isAdmin) return <Navigate to="/admin" replace/>;
  return children;
}

function AdminRouteGate({ authStatus, authUser, children }) {
  if (authStatus === "unknown") return null;
  if (authStatus !== "authenticated" || !authUser || !authUser.isAdmin) {
    return <Navigate to="/admin/login" replace/>;
  }
  return children;
}

function PublicLoginRoute({ authStatus, authUser, children, admin = false }) {
  if (authStatus === "unknown") return null;
  if (authStatus === "authenticated" && authUser) {
    if (admin) return authUser.isAdmin ? <Navigate to="/admin" replace/> : children;
    return authUser.isAdmin ? <Navigate to="/admin" replace/> : <Navigate to="/app" replace/>;
  }
  return children;
}
function AppDashboard({ authUser, setAuthUser }) {
  const { theme } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const [jobBoardRefreshKey, setJobBoardRefreshKey] = useState(0);
  const [uiMode, setUiMode] = useState("hero");
  const DOCK_THRESHOLD = 80;
  const consolePath = `/app/${CONSOLE_ROUTE}`;
  const routeKey = location.pathname.replace(/^\/app\/?/, "") || "";
  const activeTab = routeKey === CONSOLE_ROUTE || LEGACY_CONSOLE_ROUTES.has(routeKey) || routeKey === ""
    ? "console" : routeKey;
  const appTabs = [
    { id: "console",      label: "Jobs" },
    { id: "job-profiles", label: "Job Profiles" },
    { id: "database",     label: "Database" },
  ];

  const handleLogout = useCallback(async () => {
    try { await api("/api/auth/logout", { method:"POST" }); } catch {}
    setAuthContext("");
    setAuthUser(null);
  }, [setAuthUser]);

  const handlePanelChange = useCallback((tab) => {
    if (tab === "jobs" || tab === "console") {
      if (activeTab !== "console") setJobBoardRefreshKey(k => k + 1);
      navigate(consolePath);
      return;
    }
    if (["database","plans","profile","job-profiles","integrations"].includes(tab)) {
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
      navigate(consolePath, { replace:true });
    },
  });

  useEffect(() => {
    if (!routeKey || LEGACY_CONSOLE_ROUTES.has(routeKey)) {
      navigate(consolePath, { replace:true });
      return;
    }
    if (routeKey !== CONSOLE_ROUTE && !["database","plans","profile","job-profiles","integrations"].includes(routeKey)) {
      navigate(consolePath, { replace:true });
    }
  }, [routeKey, consolePath, navigate]);

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

  // Force-logout immediately when any API call gets a 401 (dispatched by api.js).
  useEffect(() => {
    const handle = () => handleLogout();
    window.addEventListener("rm:session-expired", handle);
    return () => window.removeEventListener("rm:session-expired", handle);
  }, [handleLogout]);

  // Scroll-driven hero <-> dock
  useEffect(() => {
    const onScroll = () => setUiMode(window.scrollY > DOCK_THRESHOLD ? "dock" : "hero");
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <JobBoardProvider>
      <AppScrollProvider>
        <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13,
                      minHeight:"100vh", display:"flex", flexDirection:"column",
                      color:theme.text }}>

          <TopBar
            user={authUser}
            onTabChange={handlePanelChange}
            onLogout={handleLogout}
            onUserChange={setAuthUser}
            onProfileActivate={handleProfileActivate}
          />

          {activeTab === "console" && uiMode === "hero" && (
            <div style={{ textAlign:"center", padding:"80px 20px 40px",
                          animation:"fadeUp 0.6s ease both" }}>
              <div style={{
                fontFamily:"var(--font-display, 'Instrument Serif', serif)",
                fontSize:"clamp(2rem, 5vw, 4rem)", fontWeight:400,
                color:"var(--color-text)", letterSpacing:"-0.025em", marginBottom:8,
              }}>
                {authUser?.first_name ? `Welcome back, ${authUser.first_name}.` : "Your jobs."}
              </div>
              <div style={{ fontSize:14, color:"var(--color-text-muted)", maxWidth:520, margin:"0 auto" }}>
                Pick up where you left off.
              </div>
            </div>
          )}

          <UnifiedSearchBar
            mode={uiMode}
            tabs={appTabs}
            activeTab={activeTab}
            onTabChange={handlePanelChange}
            onSearch={() => {}}
            onLocalFilter={() => {}}
          />

          <main style={{ flex:1, paddingTop: uiMode === "dock" ? 80 : 24 }}>
            {activeTab === "console" && (
              <JobsConsole user={authUser} onUserChange={setAuthUser}
                refreshKey={jobBoardRefreshKey} isActive={activeTab === "console"}/>
            )}
            {activeTab === "database"     && <DatabasePanel user={authUser}/>}
            {activeTab === "integrations" && <IntegrationsPanel/>}
            {activeTab === "plans"        && <PlansPanel user={authUser} onUserChange={setAuthUser}/>}
            {activeTab === "profile"      && <ProfilePanel user={authUser} onOpenJobProfiles={() => handlePanelChange("job-profiles")}/>}
            {activeTab === "job-profiles" && <JobProfilesPanel/>}
          </main>

          <JobDetailPanel/>
        </div>
      </AppScrollProvider>
    </JobBoardProvider>
  );
}

function AppRouter() {
  const { theme } = useTheme();
  const [authUser,    setAuthUser]    = useState(null);
  const [authStatus,  setAuthStatus]  = useState("unknown");

  const handleAdminLogout = useCallback(async () => {
    try { await api("/api/auth/logout", { method:"POST" }); } catch {}
    setAuthContext("");
    setAuthUser(null);
    setAuthStatus("unauthenticated");
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthAuthContext = params.get("authContext");
    if (oauthAuthContext) {
      setAuthContext(oauthAuthContext);
      params.delete("authContext");
      const nextSearch = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`);
    }
    api("/api/auth/me")
      .then(d => {
        if (d.authenticated && d.user) {
          setAuthUser(d.user);
          setAuthStatus("authenticated");
          return;
        }
        setAuthUser(null);
        setAuthStatus("unauthenticated");
      })
      .catch(() => {})
      .finally(() => setAuthStatus(prev => prev === "unknown" ? "unauthenticated" : prev));
  }, []);

  const handlePublicLogout = useCallback(async () => {
    try { await api("/api/auth/logout", { method:"POST" }); } catch {}
    setAuthContext("");
    setAuthUser(null);
    setAuthStatus("unauthenticated");
  }, []);

  if (authStatus === "unknown") return (
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

  // NavBar helper — renders the shared public nav with current auth state
  const navBar = (
    <NavBar user={authUser} onLogout={handlePublicLogout}
      onLogin={(user) => { setAuthUser(user); setAuthStatus("authenticated"); }}/>
  );

  return (
    <AppShell>
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

        {/* New public pages with NavBar */}
        <Route path="/products" element={<>{navBar}<ProductsPage/></>}/>
        <Route path="/blog"     element={<>{navBar}<BlogPage/></>}/>

        {/* Admin login — redirect if already authenticated */}
        <Route path="/admin/login" element={
          <PublicLoginRoute authStatus={authStatus} authUser={authUser} admin>
            <AdminLoginPage onLogin={(user) => {
              setAuthUser(user);
              setAuthStatus("authenticated");
            }}/>
          </PublicLoginRoute>
        }/>

        {/* Admin dashboard — requires auth + isAdmin */}
        <Route path="/admin" element={
          <AdminRouteGate authStatus={authStatus} authUser={authUser}>
            <AdminLayout user={authUser} onLogout={handleAdminLogout}/>
          </AdminRouteGate>
        }/>

        {/* Admin DB Inspector */}
        <Route path="/admin/db" element={
          <AdminRouteGate authStatus={authStatus} authUser={authUser}>
            <AdminLayout user={authUser} onLogout={handleAdminLogout}><DBInspector/></AdminLayout>
          </AdminRouteGate>
        }/>

        {/* User login — redirect to /app if logged in as user, /admin if admin */}
        <Route path="/login" element={
          <PublicLoginRoute authStatus={authStatus} authUser={authUser}>
            <AuthScreen onLogin={(user) => {
              setAuthUser(user);
              setAuthStatus("authenticated");
            }}/>
          </PublicLoginRoute>
        }/>

        {/* Register — same screen as login, opens register tab */}
        <Route path="/register" element={
          <PublicLoginRoute authStatus={authStatus} authUser={authUser}>
            <AuthScreen initialTab="register" onLogin={(user) => {
              setAuthUser(user);
              setAuthStatus("authenticated");
            }}/>
          </PublicLoginRoute>
        }/>

        {/* User app — redirect admin to /admin */}
        <Route path="/app/*" element={
          <UserRouteGate authStatus={authStatus} authUser={authUser}>
            <AppDashboard authUser={authUser} setAuthUser={setAuthUser}/>
          </UserRouteGate>
        }/>

        {/* Root: landing page for logged-out, redirect for logged-in */}
        <Route path="/" element={
          authStatus === "unknown" ? null
          : authStatus === "authenticated" && authUser
            ? (authUser.isAdmin ? <Navigate to="/admin" replace/> : <Navigate to="/app" replace/>)
            : <>{navBar}<LandingPage authUser={null}/></>
        }/>

        {/* 404 — authenticated users redirect, logged-out users see NotFoundPage */}
        <Route path="*" element={
          authStatus === "authenticated" && authUser
            ? (authUser.isAdmin ? <Navigate to="/admin" replace/> : <Navigate to="/app" replace/>)
            : <>{navBar}<NotFoundPage/></>
        }/>
      </Routes>
    </AppShell>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRouter/>
    </BrowserRouter>
  );
}
