// REVAMP v1 — App.jsx
import { useState, useEffect, useCallback, useMemo } from "react";
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
import { useSearchSurface }      from "./hooks/useSearchSurface.js";
import { AppScrollProvider } from "./contexts/AppScrollContext.jsx";
import { JobBoardProvider, useJobBoard } from "./contexts/JobBoardContext.jsx";
import { AutoApplyProvider, useAutoApply } from "./contexts/AutoApplyContext.jsx";
import { AutoApplyPanel }        from "./panels/AutoApplyPanel.jsx";
import { ProfilePanel }          from "./panels/ProfilePanel.jsx";
import { JobProfilesPanel }      from "./panels/JobProfilesPanel.jsx";
import { DatabasePanel }         from "./panels/DatabasePanel.jsx";
import { PlansPanel }            from "./panels/PlansPanel.jsx";
import { IntegrationsPanel }     from "./panels/IntegrationsPanel.jsx";
import { RecruiterPanel }        from "./panels/RecruiterPanel.jsx";
import { JobsConsole }            from "./consoles/PlanConsoles.jsx";
import UnifiedSearchBar          from "./components/UnifiedSearchBar.jsx";
import ImportJobModal            from "./components/ImportJobModal.jsx";
import { Plus, SlidersHorizontal, ArrowUpDown } from "lucide-react";
import UsbSelect                 from "./components/UsbSelect.jsx";
import { SORTS }                 from "../../shared/jobFilterOptions.js";
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
// The board's search bar. A separate component purely because AppDashboard RENDERS
// <JobBoardProvider> and therefore sits outside it — useJobBoard() called up there would read a
// null context. This is the smallest thing that can live inside the provider and still hand
// UnifiedSearchBar its two handlers.
//
// The double-click local->live pattern is the bar's own and is untouched here: it calls
// onLocalFilter on the first click and onSearch on the second, and both arrive at the same
// applyBarFilters — the only difference being the `live` flag, which is what JobsPanel watches to
// decide whether to also go out to the aggregator. Committing the filters on BOTH is deliberate:
// the live half is a superset of the local half, and skipping the commit there would make the
// second click widen the board back out to unfiltered before searching.
function BoardSearchBar({ tabs, ...props }) {
  const { applyBarFilters } = useJobBoard();
  const { needsAttentionCount = 0 } = useAutoApply();

  // The board keeps a MINIMAL indicator and only when something is actually waiting on a human: a
  // count on the tab, not a strip above the postings. This is the requirement that "3 need review"
  // stays discoverable from the board — a review queue nobody sees is worse than a cluttered
  // board — and it is the ONLY thing the pipeline still renders outside its own panel.
  const decorated = (tabs || []).map(t =>
    t.id === "auto-apply" && needsAttentionCount > 0
      ? {
          ...t,
          label: (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {t.label}
              <span
                title={`${needsAttentionCount} need${needsAttentionCount === 1 ? "s" : ""} your attention`}
                style={{
                  minWidth: 16, height: 16, padding: "0 4px", borderRadius: 999,
                  background: "var(--color-primary)", color: "var(--color-on-primary, #0f0f0f)",
                  fontSize: 10, fontWeight: 800, lineHeight: "16px", textAlign: "center",
                }}>
                {needsAttentionCount}
              </span>
            </span>
          ),
        }
      : t,
  );

  return (
    <UnifiedSearchBar
      {...props}
      tabs={decorated}
      onLocalFilter={params => applyBarFilters(params)}
      onSearch={params => applyBarFilters(params, { live: true })}
    />
  );
}

// The board's sort options, from the shared filter contract. Same list, same values, that the
// removed "Newest" select in the control row held. It was a literal here AND a second literal in
// TopBar's collapsed pill, and the two had already drifted on labels ("Pay high to low" here vs
// "Pay ↓" there) — one control, two renderings, disagreeing about what to call the same value.
const SORT_OPTIONS = SORTS.options.map(o => ({ v: o.value, l: o.label }));

// The consolidated control row (W4): a filter icon and a sort icon, beside IMPORT.
//
// Inside JobBoardProvider for the same reason BoardSearchBar is — AppDashboard renders the
// provider and so cannot read it. The filter icon only TOGGLES; the panel itself, and every piece
// of staging logic behind it, stays in JobsPanel untouched. The sort icon reuses UsbSelect, the
// same dropdown the search bar uses, so the board has one dropdown implementation rather than one
// per surface.
function BoardControlIcons() {
  const { filterPanelOpen, setFilterPanelOpen, activeFilterCount, sortBy, setSortBy } = useJobBoard();
  const on = activeFilterCount > 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <button
        type="button"
        onClick={() => setFilterPanelOpen(o => !o)}
        aria-expanded={filterPanelOpen}
        aria-label={on ? `Filters (${activeFilterCount} active)` : "Filters"}
        title={on ? `${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"} active` : "Filters"}
        style={{
          position: "relative", display: "flex", alignItems: "center", gap: 6,
          padding: "6px 10px", borderRadius: 999,
          background: filterPanelOpen ? "rgba(255,255,255,0.06)" : "transparent",
          border: `1px solid ${on || filterPanelOpen ? "var(--color-primary)" : "var(--border-glass)"}`,
          color: on || filterPanelOpen ? "var(--color-primary)" : "var(--color-text-muted)",
          cursor: "pointer",
        }}>
        <SlidersHorizontal size={15} />
        {/* The badge is load-bearing, not decoration: with the filters behind an icon it is the
            only thing that explains an unexpectedly narrow board. It carries the COUNT rather than
            being a dot, so "why is this empty" has a number attached to it. */}
        {on && (
          <span
            aria-hidden="true"
            style={{
              minWidth: 16, height: 16, padding: "0 4px", borderRadius: 999,
              background: "var(--color-primary)", color: "var(--color-on-primary, #0f0f0f)",
              fontSize: 10, fontWeight: 800, lineHeight: "16px", textAlign: "center",
            }}>
            {activeFilterCount}
          </span>
        )}
      </button>

      <UsbSelect
        iconOnly
        icon={ArrowUpDown}
        ariaLabel="Sort"
        value={sortBy || "dateDesc"}
        onChange={setSortBy}
        options={SORT_OPTIONS}
      />
    </div>
  );
}

function AppDashboard({ authUser, setAuthUser }) {
  const { theme } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const [jobBoardRefreshKey, setJobBoardRefreshKey] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  // ONE derived value decides which search surface renders — see hooks/useSearchSurface.js. It
  // replaces a `uiMode` state driven by window.scrollY, which on this layout never changed
  // (documentElement.scrollHeight === innerHeight: the window does not scroll), so the main bar
  // could never yield to the pill while TopBar's pill was being decided independently from the
  // board's inner scroll container. That pair of unrelated booleans is why both were visible.
  const { surface: searchSurface, sentinelRef } = useSearchSurface();
  const consolePath = `/app/${CONSOLE_ROUTE}`;
  const routeKey = location.pathname.replace(/^\/app\/?/, "") || "";
  const activeTab = routeKey === CONSOLE_ROUTE || LEGACY_CONSOLE_ROUTES.has(routeKey) || routeKey === ""
    ? "console" : routeKey;
  const appTabs = [
    { id: "console",      label: "Jobs" },
    // The auto-apply pipeline is a peer of the board now, not a strip above it (W5). It sits in
    // this row for the same reason the others do — it is a place you go, not a thing that happens
    // on the board. BoardSearchBar decorates it with the needs-attention count.
    { id: "auto-apply",   label: "Auto Apply" },
    { id: "job-profiles", label: "Job Profiles" },
    { id: "database",     label: "Database" },
    { id: "recruiter",    label: "Recruiter" },
  ];

  // The console is handled by its own branch above (it has a legacy-route alias and a refresh key),
  // so it is excluded here. The three extras are reachable from the profile menu rather than the
  // tab row, and have always been navigable.
  const NAVIGABLE_TABS = useMemo(
    () => new Set([...appTabs.map(t => t.id).filter(id => id !== "console"),
                   "plans", "profile", "integrations"]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

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
    // Derived from the tab row plus the routes reachable only from elsewhere (the profile menu,
    // billing), rather than a hand-written list. It WAS a hand-written list, and adding "Auto Apply"
    // to appTabs was not enough: the tab rendered, was clickable, and navigated nowhere, because
    // this array had never heard of it. A tab that silently does nothing is the same defect class as
    // a filter wired to a no-op — so the row itself is now the source of truth and a tab added
    // tomorrow routes without anyone remembering this line.
    if (NAVIGABLE_TABS.has(tab)) {
      navigate(`/app/${tab}`);
    }
  }, [activeTab, consolePath, navigate, NAVIGABLE_TABS]);

  const handleProfileActivate = useCallback(() => {
    setJobBoardRefreshKey(k => k + 1);
  }, []);

  // An import stars the row for this user (services/jobs/importJob.js), so it belongs on their
  // board immediately — remount the console the same way activating a profile does, rather than
  // leaving the user to refresh before their own import shows up.
  const handleJobImported = useCallback(() => {
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
    // The SAME set handlePanelChange navigates with, so a tab cannot be routable in one direction
    // and bounced in the other. This was the second hardcoded copy of the tab list, and adding
    // "Auto Apply" to appTabs was not enough for either of them: the tab rendered and did nothing
    // because handlePanelChange had never heard of it, and typing /app/auto-apply bounced straight
    // back to the board because THIS guard had not either. Two lists, both silent when wrong.
    if (routeKey !== CONSOLE_ROUTE && !NAVIGABLE_TABS.has(routeKey)) {
      navigate(consolePath, { replace:true });
    }
  }, [routeKey, consolePath, navigate, NAVIGABLE_TABS]);

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

  // The scroll listener that used to drive hero <-> dock is gone: it read window.scrollY, which is
  // permanently 0 here, and it re-rendered this component on every scroll event — which is how a
  // trivial scroll reset the job board (see JobsPanel's boot-effect note and PlanConsoles' memo).

  return (
    <JobBoardProvider>
    {/* The apply pipeline's state sits ABOVE the board and above the tab switch, deliberately.
        Its loading and polling effects have to keep running while the user is on another tab —
        otherwise a run started from the board would stop reporting the moment you navigated to
        Auto Apply to watch it, which is the one place you would go to watch it. It is also what
        lets the tab carry a needs-attention count while the board is showing. */}
    <AutoApplyProvider
      user={authUser}
      canUseAPlusResume={String(authUser?.planTier || "BASIC").toUpperCase() === "PRO"}>
      <AppScrollProvider>
        {/* data-app-shell marks the element whose children are the app's own surfaces, so the panel
            host can make the BOARD inert while a panel is open without hunting for it by class or
            position. It does not need to know WHICH child is the board: useBoardLock inerts every
            child that renders BELOW the scrim and leaves alone every child at or above
            Z.MODAL_SCRIM.

            Y2 CHANGED WHICH SIDE OF THAT LINE THE TOP BAR IS ON. It used to paint at Z.NAV (1500),
            above the scrim, so it stayed undimmed and live over an open panel — and the note here
            defended that, on the grounds that a control which looks live but is inert is worse than
            one that works. The bar is now at Z.NAV (250), BELOW every overlay, so the scrim covers
            it and useBoardLock inerts it with everything else. That pairing is still coherent, in
            the other direction: dimmed AND inert. What the old arrangement actually produced was a
            bar that occluded the surfaces it was floating over. */}
        <div data-app-shell
             style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13,
                      minHeight:"100vh", display:"flex", flexDirection:"column",
                      color:theme.text }}>

          <TopBar
            user={authUser}
            searchSurface={searchSurface}
            // The pill's contents are board controls; it must not float over a panel with no board.
            boardIsActive={activeTab === "console"}
            onTabChange={handlePanelChange}
            onLogout={handleLogout}
            onUserChange={setAuthUser}
            onProfileActivate={handleProfileActivate}
          />

          {/* The hero and the search bar below it stay MOUNTED whichever surface is showing, and are
              hidden with `visibility` rather than removed. Unmounting them took 386px out of the
              document (measured: scrollHeight 1763 -> 1377), all of it above the fold, and Chrome's
              scroll anchoring compensates for that by subtracting it from the scroll offset —
              scrollY fell 250 -> 0, which put the sentinel back on screen and flipped the surface
              straight back. The threshold was moving itself. Keeping the space reserved costs
              nothing on screen, because at the moment of the flip both are scrolled out of view by
              definition. `visibility: hidden` also takes them out of the tab order, so the hidden
              surface cannot be reached by keyboard. */}
          {activeTab === "console" && (
            <div aria-hidden={searchSurface !== "bar"}
                 style={{ textAlign:"center", padding:"80px 20px 40px",
                          animation:"fadeUp 0.6s ease both",
                          visibility: searchSurface === "bar" ? "visible" : "hidden" }}>
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

          {/* Sentinel: holds the main bar's PLACE in the layout and stays mounted whichever surface
              is showing, so the observed condition remains observable in both states. Observing the
              bar itself would unmount the observer's target the instant the pill took over, and the
              pill could never hand back. Zero height, so it cannot affect layout. */}
          <div ref={sentinelRef} aria-hidden="true" style={{ height: 0 }}/>

          {/* Exactly one search surface, from one value. Never zero, never two — by construction,
              not by two components agreeing. The pill branch lives in TopBar (its collapsed filter
              row), which receives the same value rather than deciding for itself.

              `hidden` rather than a conditional render, for the layout reason above. The bar is
              `position: sticky` and reserves its own space, so removing it moved everything below
              it; and it cannot be wrapped in a hiding container either, because an intermediate box
              would become sticky's containing block and there would be no room left to stick to. */}
          <BoardSearchBar
            hidden={searchSurface !== "bar"}
            mode="hero"
            variant="inline"
            tabs={appTabs}
            activeTab={activeTab}
            onTabChange={handlePanelChange}
            // Jobs tab only: these are board actions, so they would be meaningless sitting above
            // Job Profiles, Database or Recruiter.
            actions={activeTab === "console" ? (
              <>
              <BoardControlIcons />
              <div style={{ width: 1, height: 20, background: "var(--border-glass)", margin: "0 8px" }} />
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                title="Import a job from a link or pasted text"
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "6px 12px", borderRadius: 999,
                  background: "transparent",
                  border: "1px solid var(--color-primary)",
                  color: "var(--color-text)",
                  fontSize: 12, fontWeight: 600, cursor: "pointer",
                  textTransform: "uppercase", letterSpacing: "0.08em",
                  whiteSpace: "nowrap",
                }}>
                <Plus size={13} /> Import
              </button>
              </>
            ) : null}
          />

          <main style={{ flex:1, paddingTop: 24 }}>
            {activeTab === "console" && (
              <JobsConsole user={authUser} onUserChange={setAuthUser}
                refreshKey={jobBoardRefreshKey} isActive={activeTab === "console"}/>
            )}
            {activeTab === "auto-apply"   && <AutoApplyPanel/>}
            {activeTab === "database"     && <DatabasePanel user={authUser}/>}
            {activeTab === "integrations" && <IntegrationsPanel/>}
            {activeTab === "plans"        && <PlansPanel user={authUser} onUserChange={setAuthUser}/>}
            {activeTab === "profile"      && <ProfilePanel user={authUser} onOpenJobProfiles={() => handlePanelChange("job-profiles")}/>}
            {activeTab === "job-profiles" && <JobProfilesPanel/>}
            {activeTab === "recruiter"    && <RecruiterPanel/>}
          </main>

          {/* JobDetailPanel moved into JobsPanel, which is where the PDF and ATS panels live and
              where the shared panel host runs — three peers cannot tile side by side from two
              different parents. One visible consequence, stated rather than hidden: switching tabs
              from the TopBar (which used to sit above the scrim at Z.NAV; since Y2 it sits below,
              and is inert while a panel is open) hides the drawer with the
              board it belongs to instead of leaving it floating over the Database panel. The
              selection itself lives in JobBoardContext, above the tab switch, so returning to Jobs
              restores the same open drawer. */}

          {importOpen && (
            <ImportJobModal
              onClose={() => setImportOpen(false)}
              onImported={handleJobImported}
            />
          )}
        </div>
      </AppScrollProvider>
    </AutoApplyProvider>
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
