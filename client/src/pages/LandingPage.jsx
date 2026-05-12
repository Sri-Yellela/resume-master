// client/src/pages/LandingPage.jsx
// Auth is passed as a prop from App.jsx — no useAuth hook in this project.
import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import UnifiedSearchBar from "../components/UnifiedSearchBar.jsx";
import BelowFoldContent from "../components/BelowFoldContent.jsx";
import { useTheme } from "../styles/theme.jsx";
import { api } from "../lib/api.js";
import "./LandingPage.css";

// ── Minimal read-only job card for logged-out public feed ─────────────────────
function PublicJobCard({ job }) {
  const { theme } = useTheme();
  return (
    <div style={{
      background: theme.surface,
      border: `1px solid ${theme.border}`,
      borderRadius: 10,
      padding: "14px 16px",
      display: "flex",
      flexDirection: "column",
      gap: 6,
    }}>
      <div style={{ fontWeight: 700, fontSize: 13, color: theme.text,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {job.title}
      </div>
      <div style={{ fontSize: 12, color: theme.textMuted }}>{job.company}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {job.location && (
          <span style={{ fontSize: 10, color: theme.textDim }}>{job.location}</span>
        )}
        {job.source_label && (
          <span style={{
            fontSize: 10, color: theme.textMuted,
            background: theme.surfaceHigh,
            padding: "1px 6px", borderRadius: 999,
          }}>
            {job.source_label}
          </span>
        )}
      </div>
      <a href={job.url} target="_blank" rel="noreferrer"
        style={{ fontSize: 11, color: theme.accentText, fontWeight: 700, marginTop: 4 }}>
        View job ↗
      </a>
    </div>
  );
}

// ── Lazy-loaded JobCard wrapper (avoids circular imports) ─────────────────────
function JobCardWrapper({ job, index, onDismiss }) {
  const [JobCard, setJC] = useState(null);
  useEffect(() => {
    import("../components/JobCard.jsx")
      .then(m => setJC(() => m.default))
      .catch(() => {});
  }, []);
  if (!JobCard) return null;
  return (
    <div className="job-card--animated" style={{ "--ci": index }}>
      <JobCard job={job} onDismiss={onDismiss} />
    </div>
  );
}

// ── LandingPage ───────────────────────────────────────────────────────────────
export default function LandingPage({ authUser }) {
  const { theme } = useTheme();
  const [uiMode,      setUiMode]      = useState("hero");
  const [jobs,        setJobs]        = useState([]);
  const [total,       setTotal]       = useState(0);
  const [page,        setPage]        = useState(1);
  const [loading,     setLoading]     = useState(true);
  const [searchRes,   setSearchRes]   = useState(null);
  const liveSearchDone = useRef(false);
  const DOCK_THRESHOLD = 60;

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
    <div className={`lp lp--${uiMode}`} style={{ background: theme.bg, color: theme.text,
      fontFamily: "'DM Sans',system-ui,sans-serif" }}>

      {/* Nav — fades out when dock takes over */}
      {!isDock && (
        <nav style={{
          position: "fixed", top: 0, left: 0, right: 0,
          height: 52, zIndex: 300,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 24px",
          background: `${theme.surface}f2`,
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          borderBottom: `1px solid ${theme.border}22`,
        }}>
          <span style={{
            fontFamily: "'Barlow Condensed','DM Sans',sans-serif",
            fontWeight: 800, fontSize: 17, letterSpacing: "0.04em",
            textTransform: "uppercase", color: theme.text, fontStyle: "italic",
          }}>
            Resume Master
          </span>
          <div style={{ display: "flex", gap: 10 }}>
            <Link to="/login" style={{ fontSize: 13, fontWeight: 600, color: theme.textMuted,
              textDecoration: "none", padding: "6px 14px", borderRadius: 6 }}>
              Sign In
            </Link>
            <Link to="/register" style={{ fontSize: 13, fontWeight: 700, color: "#0f0f0f",
              textDecoration: "none", padding: "6px 16px", borderRadius: 6,
              background: theme.accent }}>
              Get Started
            </Link>
          </div>
        </nav>
      )}

      {/* UnifiedSearchBar — hero centered → dock sticky-top */}
      <UnifiedSearchBar
        mode={uiMode}
        isLoggedOut={!authUser}
        onSearch={handleSearch}
        onLocalFilter={handleLocalFilter}
      />

      {/* Main content */}
      <main className="lp__main">
        <div className="lp__spacer" aria-hidden="true" />

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
            <div style={{
              fontSize: 12, color: theme.textMuted, marginBottom: 12,
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <span>
                {displayJobs.length} job{displayJobs.length !== 1 ? "s" : ""}
                {searchRes === null && total > displayJobs.length ? ` of ${total}` : ""}
              </span>
              {searchRes !== null && (
                <button onClick={resetSearch}
                  style={{ background: "none", border: "none", color: theme.accentText,
                           cursor: "pointer", fontSize: 12, fontWeight: 600, padding: 0 }}>
                  ← Back to feed
                </button>
              )}
            </div>

            <div className="lp__grid">
              {displayJobs.map((job, i) => (
                authUser
                  ? <JobCardWrapper key={job.job_id || job.id || job.url || i}
                      job={job} index={i} onDismiss={handleDismiss} />
                  : <div key={job.job_id || job.id || job.url || i}
                      className="job-card--animated" style={{ "--ci": i }}>
                      <PublicJobCard job={job} />
                    </div>
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
              <div style={{
                marginTop: 32, padding: "20px 24px",
                background: `${theme.accent}18`,
                border: `1px solid ${theme.accent}44`,
                borderRadius: 10, textAlign: "center",
              }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: theme.text, marginBottom: 6 }}>
                  Sign up to save jobs, score your resume, and generate tailored applications
                </div>
                <Link to="/register" style={{
                  display: "inline-block", marginTop: 8,
                  background: theme.accent, color: "#0f0f0f",
                  padding: "8px 24px", borderRadius: 6,
                  fontWeight: 800, fontSize: 13, textDecoration: "none",
                }}>
                  Create free account
                </Link>
              </div>
            )}
          </>
        )}

        {/* Empty state */}
        {!loading && displayJobs.length === 0 && isDock && (
          <div className="lp__empty">
            <p style={{ color: theme.textMuted }}>
              {searchRes !== null ? "No jobs match your search." : "No jobs available yet."}
            </p>
            <button onClick={() => { resetSearch(); loadFeed(1); }}
              style={{ marginTop: 12, padding: "8px 20px", borderRadius: 6,
                       background: theme.accent, color: "#0f0f0f",
                       border: "none", fontWeight: 700, cursor: "pointer", fontSize: 13 }}>
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
