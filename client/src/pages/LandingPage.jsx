// client/src/pages/LandingPage.jsx
// Auth is passed as a prop from App.jsx — no useAuth hook in this project.
import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import UnifiedSearchBar from "../components/UnifiedSearchBar.jsx";
import BelowFoldContent from "../components/BelowFoldContent.jsx";
import { StampLogo } from "../components/StampLogo.jsx";
import { useLogoSize } from "../hooks/useLogoSize.js";
import { useTheme } from "../styles/theme.jsx";
import { api } from "../lib/api.js";
import "./LandingPage.css";

// ── Lazy-loaded JobCard wrapper (avoids circular imports) ─────────────────────
function JobCardWrapper({ job, index, onDismiss, isLoggedOut = false }) {
  const [JobCard, setJC] = useState(null);
  useEffect(() => {
    import("../components/JobCard.jsx")
      .then(m => setJC(() => m.default))
      .catch(() => {});
  }, []);
  if (!JobCard) return null;
  return (
    <div className="job-card--animated" style={{ "--ci": index }}>
      <JobCard job={job} onDismiss={onDismiss} isLoggedOut={isLoggedOut} />
    </div>
  );
}

// ── LandingPage ───────────────────────────────────────────────────────────────
export default function LandingPage({ authUser }) {
  const { theme } = useTheme();
  const isWide = useLogoSize();
  const [uiMode,      setUiMode]      = useState("hero");
  const [jobs,        setJobs]        = useState([]);
  const [total,       setTotal]       = useState(0);
  const [page,        setPage]        = useState(1);
  const [loading,     setLoading]     = useState(true);
  const [searchRes,   setSearchRes]   = useState(null);
  const liveSearchDone = useRef(false);
  const DOCK_THRESHOLD = 80;

  const pageSize   = authUser ? 20 : 12;
  const displayJobs = searchRes ?? jobs;
  const totalPages  = Math.ceil(total / pageSize);

  const loadFeed = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const ep = authUser
        ? `/api/jobs?page=${p}&pageSize=20`
        : `/api/jobs/generic?page=${p}&pageSize=12`;
      const d = await api(ep);
      if (d.success !== false) {
        setJobs(d.jobs || []);
        setTotal(d.total || 0);
        setPage(p);
      }
    } catch (e) {
      console.error("[LandingPage] loadFeed", e);
    } finally {
      setLoading(false);
    }
  }, [authUser]);

  // Load feed on mount
  useEffect(() => { loadFeed(1); }, [loadFeed]);

  // Scroll-driven hero ↔ dock (locked to dock after live search)
  useEffect(() => {
    function onScroll() {
      if (liveSearchDone.current) return;
      setUiMode(window.scrollY > DOCK_THRESHOLD ? "dock" : "hero");
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const handleLocalFilter = useCallback(({ query, location, experience, domain, status }) => {
    if (!query && !location && !experience && !domain && !status) {
      setSearchRes(null);
      return;
    }
    setSearchRes(jobs.filter(j => {
      const t = `${j.title} ${j.company} ${j.location || ""} ${j.description || ""}`.toLowerCase();
      if (query      && !t.includes(query.toLowerCase()))                          return false;
      if (location   && !(j.location || "").toLowerCase().includes(location.toLowerCase())) return false;
      if (experience && j.bucket_seniority !== experience)                         return false;
      if (domain     && j.bucket_domain !== domain)                                return false;
      if (status === "starred" && !j._user?.starred)                              return false;
      if (status === "applied" && j._user?.status !== "applied")                  return false;
      return true;
    }));
  }, [jobs]);

  const handleSearch = useCallback(async (params) => {
    liveSearchDone.current = true;
    setUiMode("dock");
    setLoading(true);
    setSearchRes(null);
    try {
      const d = await api("/api/jobs/search", {
        method: "POST",
        body: JSON.stringify({ ...params, page: 1, pageSize: 20 }),
      });
      if (d.success !== false) {
        setSearchRes(d.jobs || []);
        setTotal(d.total || 0);
        setPage(1);
      }
    } catch (e) {
      console.error("[LandingPage] search", e);
      setSearchRes([]);
    } finally {
      setLoading(false);
    }
    return Promise.resolve();
  }, []);

  function handleDismiss(url) {
    setJobs(p => p.filter(j => j.url !== url));
    setSearchRes(p => p ? p.filter(j => j.url !== url) : null);
  }

  function resetSearch() {
    liveSearchDone.current = false;
    setSearchRes(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
    // scroll listener will animate back to hero
  }

  const isDock = uiMode === "dock";

  return (
    <div className={`lp lp--${uiMode}`} style={{ background: theme.bg }}>

      {/* Hero logo zone — in absolute position, scrolls away naturally */}
      <div className={`lp__hero-zone${uiMode === 'dock' ? ' lp__hero-zone--hidden' : ''}`}>
        <StampLogo size="lg" progress={isWide ? 0 : 1} />
        <p className="lp__hero-tagline">
          {authUser ? 'Your personalized job feed.' : 'Build the perfect resume. Land your next role.'}
        </p>
      </div>

      {/* UnifiedSearchBar — hero centered → dock sticky-top (NavBar is rendered by App.jsx) */}
      <UnifiedSearchBar
        mode={uiMode}
        onSearch={handleSearch}
        onLocalFilter={handleLocalFilter}
      />

      {/* Main content — padding-top via CSS pushes below the fixed USBar */}
      <main className="lp__main">

        {/* Skeleton loaders */}
        {loading && (
          <div className="lp__grid">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="lp__skel" style={{ animationDelay: `${i * 70}ms` }} />
            ))}
          </div>
        )}

        {/* Job grid */}
        {!loading && displayJobs.length > 0 && (
          <>
            <div className="lp__job-count-bar">
              <span>
                {displayJobs.length} job{displayJobs.length !== 1 ? "s" : ""}
                {searchRes === null && total > displayJobs.length ? ` of ${total}` : ""}
              </span>
              {searchRes !== null && (
                <button onClick={resetSearch} className="lp__reset-btn">
                  ← Back to feed
                </button>
              )}
            </div>

            <div className="lp__grid">
              {displayJobs.map((job, i) => (
                <JobCardWrapper key={job.job_id || job.id || job.url || i}
                  job={job} index={i} onDismiss={handleDismiss}
                  isLoggedOut={!authUser} />
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="lp__pages">
                <button className="lp__page-btn"
                  disabled={page <= 1} onClick={() => loadFeed(page - 1)}>
                  ← Prev
                </button>
                <span className="lp__pageinfo">{page} / {totalPages}</span>
                <button className="lp__page-btn"
                  disabled={page >= totalPages} onClick={() => loadFeed(page + 1)}>
                  Next →
                </button>
              </div>
            )}

            {/* Sign-up prompt for logged-out users */}
            {!authUser && (
              <div className="lp__signup-prompt">
                <div className="lp__signup-prompt__title">
                  Sign up to save jobs, score your resume, and generate tailored applications
                </div>
                <Link to="/register" className="lp__cta-btn">
                  Create free account
                </Link>
              </div>
            )}
          </>
        )}

        {/* Empty state */}
        {!loading && displayJobs.length === 0 && isDock && (
          <div className="lp__empty">
            <p className="lp__empty-msg">
              {searchRes !== null ? "No jobs match your search." : "No jobs available yet."}
            </p>
            <button onClick={() => { resetSearch(); loadFeed(1); }} className="lp__cta-btn lp__cta-btn--sm">
              Reset
            </button>
          </div>
        )}

        {/* Below-fold marketing content (logged-out only) */}
        {!authUser && <BelowFoldContent />}
      </main>
    </div>
  );
}
