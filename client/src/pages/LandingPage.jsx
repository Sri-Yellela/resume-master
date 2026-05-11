// client/src/pages/LandingPage.jsx
// Unified landing: hero (search bar centered) → dock (search bar sticks to top)
// STATE A (logged-out): hero + public job feed + marketing sections below fold
// STATE B (logged-in):  hero + personalized feed → redirect handled in App.jsx
import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import UnifiedSearchBar from "../components/UnifiedSearchBar.jsx";
import { useTheme } from "../styles/theme.jsx";
import { api } from "../lib/api.js";

// Minimal read-only job card for the public feed
function PublicJobCard({ job, theme }) {
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
      <div style={{ fontSize: 12, color: theme.textMuted }}>
        {job.company}
      </div>
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

// Below-fold marketing content (existing value props)
function BelowFoldContent({ theme }) {
  const features = [
    {
      icon: "✦",
      title: "AI Resume Generation",
      desc: "Tailored resumes built from your profile and the job description. ATS-optimized, recruiter-ready.",
    },
    {
      icon: "🎯",
      title: "ATS Score & Gap Analysis",
      desc: "See exactly which keywords are missing. Fix them before applying.",
    },
    {
      icon: "✉",
      title: "Cover Letter Generator",
      desc: "Professional, conversational, or enthusiastic — generated in seconds.",
    },
    {
      icon: "⚡",
      title: "Auto Apply",
      desc: "Semi-automated application filling. You review, you submit.",
    },
  ];

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "60px 20px 80px" }}>
      {/* Feature grid */}
      <div style={{ textAlign: "center", marginBottom: 40 }}>
        <div style={{
          fontFamily: "'Barlow Condensed','DM Sans',sans-serif",
          fontWeight: 800, fontSize: 28, color: theme.text,
          letterSpacing: "-0.02em",
        }}>
          Everything you need to land the job
        </div>
        <div style={{ fontSize: 14, color: theme.textMuted, marginTop: 8 }}>
          From resume to offer — Resume Master has every step covered.
        </div>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
        gap: 16,
        marginBottom: 48,
      }}>
        {features.map(f => (
          <div key={f.title} style={{
            background: theme.surface,
            border: `1px solid ${theme.border}`,
            borderRadius: 12,
            padding: "20px 18px",
          }}>
            <div style={{ fontSize: 24, marginBottom: 10 }}>{f.icon}</div>
            <div style={{ fontWeight: 700, fontSize: 13, color: theme.text, marginBottom: 6 }}>
              {f.title}
            </div>
            <div style={{ fontSize: 12, color: theme.textMuted, lineHeight: 1.6 }}>
              {f.desc}
            </div>
          </div>
        ))}
      </div>

      {/* CTA */}
      <div style={{ textAlign: "center" }}>
        <Link to="/register" style={{
          display: "inline-block",
          background: theme.accent,
          color: "#0f0f0f",
          padding: "12px 32px",
          borderRadius: 8,
          fontWeight: 800,
          fontSize: 14,
          textDecoration: "none",
          letterSpacing: "0.02em",
        }}>
          Get Started Free
        </Link>
        <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 10 }}>
          No credit card required.
        </div>
      </div>
    </div>
  );
}

export default function LandingPage({ authUser }) {
  const { theme, isDark } = useTheme();
  const [searchBarMode, setSearchBarMode] = useState("hero"); // "hero" | "dock"
  const [jobs, setJobs]                   = useState([]);
  const [total, setTotal]                 = useState(0);
  const [loading, setLoading]             = useState(true);
  const [searchResults, setSearchResults] = useState(null); // null = showing feed

  // Load public feed on mount
  useEffect(() => {
    api("/api/jobs/generic?pageSize=12")
      .then(d => {
        const loaded = d.jobs || [];
        setJobs(loaded);
        setTotal(d.total || 0);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Animate to dock once jobs load
  useEffect(() => {
    if (!loading && jobs.length > 0 && searchBarMode === "hero") {
      const t = setTimeout(() => setSearchBarMode("dock"), 300);
      return () => clearTimeout(t);
    }
  }, [loading, jobs.length, searchBarMode]);

  const handleLocalFilter = useCallback(({ query, location, experience, domain }) => {
    const q = query.toLowerCase();
    const loc = location.toLowerCase();
    const filtered = jobs.filter(job => {
      const text = `${job.title} ${job.company} ${job.location || ""}`.toLowerCase();
      if (q && !text.includes(q)) return false;
      if (loc && !(job.location || "").toLowerCase().includes(loc)) return false;
      if (domain && !(text.includes(domain.toLowerCase()))) return false;
      return true;
    });
    setSearchResults(filtered);
  }, [jobs]);

  const handleSearch = useCallback(async ({ query, location, experience, domain }) => {
    setSearchBarMode("dock");
    try {
      const d = await api("/api/jobs/search", {
        method: "POST",
        body: JSON.stringify({ query, location, experience, domain, pageSize: 20 }),
      });
      setSearchResults(d.jobs || []);
      setTotal(d.total || 0);
    } catch {
      setSearchResults([]);
    }
  }, []);

  const displayJobs = searchResults !== null ? searchResults : jobs;

  return (
    <div style={{
      minHeight: "100vh",
      background: theme.bg,
      fontFamily: "'DM Sans',system-ui,sans-serif",
    }}>
      {/* Nav */}
      <nav style={{
        position: "fixed", top: 0, left: 0, right: 0,
        height: 52, zIndex: 300,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 24px",
        background: searchBarMode === "dock" ? "transparent" : `${theme.surface}f2`,
        backdropFilter: searchBarMode === "dock" ? "none" : "blur(12px)",
        WebkitBackdropFilter: searchBarMode === "dock" ? "none" : "blur(12px)",
        borderBottom: searchBarMode === "dock" ? "none" : `1px solid ${theme.border}22`,
        pointerEvents: searchBarMode === "dock" ? "none" : "auto",
        transition: "all 0.4s",
      }}>
        <span style={{
          fontFamily: "'Barlow Condensed','DM Sans',sans-serif",
          fontWeight: 800, fontSize: 17, letterSpacing: "0.04em",
          textTransform: "uppercase", color: theme.text,
          fontStyle: "italic",
        }}>
          Resume Master
        </span>
        <div style={{ display: "flex", gap: 10, pointerEvents: "auto" }}>
          <Link to="/login" style={{
            fontSize: 13, fontWeight: 600, color: theme.textMuted,
            textDecoration: "none", padding: "6px 14px", borderRadius: 6,
          }}>
            Sign In
          </Link>
          <Link to="/register" style={{
            fontSize: 13, fontWeight: 700, color: "#0f0f0f",
            textDecoration: "none", padding: "6px 16px", borderRadius: 6,
            background: theme.accent,
          }}>
            Get Started
          </Link>
        </div>
      </nav>

      {/* Hero / search bar */}
      <div style={{
        paddingTop: searchBarMode === "dock" ? 64 : "calc(50vh - 120px)",
        transition: "padding-top 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
      }}>
        <UnifiedSearchBar
          mode={searchBarMode}
          isLoggedOut={!authUser}
          onSearch={handleSearch}
          onLocalFilter={handleLocalFilter}
        />
      </div>

      {/* Job grid */}
      <div style={{
        maxWidth: 960, margin: "0 auto",
        padding: searchBarMode === "dock" ? "16px 20px" : "40px 20px",
        transition: "padding 0.4s",
      }}>
        {loading ? (
          <div style={{ textAlign: "center", color: theme.textMuted, padding: 40, fontSize: 13 }}>
            Loading jobs…
          </div>
        ) : displayJobs.length === 0 ? (
          <div style={{ textAlign: "center", color: theme.textMuted, padding: 40, fontSize: 13 }}>
            {searchResults !== null ? "No jobs match your search." : "No jobs available yet."}
          </div>
        ) : (
          <>
            <div style={{
              fontSize: 12, color: theme.textMuted, marginBottom: 12,
              display: "flex", justifyContent: "space-between",
            }}>
              <span>{displayJobs.length} jobs{searchResults === null && total > displayJobs.length ? ` of ${total}` : ""}</span>
              {searchResults !== null && (
                <button onClick={() => setSearchResults(null)}
                  style={{ background: "none", border: "none", color: theme.accentText,
                           cursor: "pointer", fontSize: 12, fontWeight: 600, padding: 0 }}>
                  ← Back to feed
                </button>
              )}
            </div>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: 12,
            }}>
              {displayJobs.map((job, i) => (
                <div key={job.job_id || job.id || job.url || i}
                  style={{
                    animation: "cardEntrance 360ms cubic-bezier(0.16,1,0.3,1) both",
                    animationDelay: `${Math.min(i * 45, 400)}ms`,
                  }}>
                  <PublicJobCard job={job} theme={theme}/>
                </div>
              ))}
            </div>

            {/* Sign-up prompt */}
            {!authUser && (
              <div style={{
                marginTop: 32, padding: "20px 24px",
                background: `${theme.accent}18`,
                border: `1px solid ${theme.accent}44`,
                borderRadius: 10,
                textAlign: "center",
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
      </div>

      {/* Below fold — marketing content */}
      {!authUser && <BelowFoldContent theme={theme}/>}

      <style>{`
        @keyframes cardEntrance {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
