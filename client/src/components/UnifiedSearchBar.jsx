// client/src/components/UnifiedSearchBar.jsx
// Unified search bar: HERO mode (centered landing) ↔ DOCK mode (sticky top strip)
// Single-click: local filter + 5-second countdown
// Double-click (within 5s): fires live API search
import { useState, useRef, useEffect } from "react";
import { useTheme } from "../styles/theme.jsx";

const EXPERIENCE_OPTIONS = [
  { value: "",             label: "Any Level" },
  { value: "intern",       label: "Intern" },
  { value: "entry level",  label: "Entry Level" },
  { value: "mid level",    label: "Mid Level" },
  { value: "senior",       label: "Senior" },
  { value: "staff",        label: "Staff / Lead" },
  { value: "director",     label: "Director" },
];

const DOMAIN_OPTIONS = [
  { value: "",           label: "Any Domain" },
  { value: "saas",       label: "Tech / SaaS" },
  { value: "fintech",    label: "Fintech" },
  { value: "healthtech", label: "Healthtech" },
  { value: "edtech",     label: "EdTech" },
  { value: "ai ml",      label: "AI / ML" },
  { value: "ecommerce",  label: "E-commerce" },
  { value: "devtools",   label: "Dev Tools" },
];

const DOUBLE_CLICK_WINDOW_MS = 5000;

export default function UnifiedSearchBar({
  mode = "hero",       // "hero" | "dock"
  isLoggedOut = false,
  onSearch,            // ({ query, location, experience, domain }) => void — live search
  onLocalFilter,       // ({ query, location, experience, domain }) => void — local filter
  greeting,            // optional personalized greeting string
}) {
  const { theme, isDark } = useTheme();
  const [query,      setQuery]      = useState("");
  const [location,   setLocation]   = useState("");
  const [experience, setExperience] = useState("");
  const [domain,     setDomain]     = useState("");
  const [countdown,  setCountdown]  = useState(null);
  const [searchMode, setSearchMode] = useState("idle"); // "idle"|"local"|"live"|"loading"

  const clickCountRef = useRef(0);
  const clickTimerRef = useRef(null);
  const countdownRef  = useRef(null);

  // Any filter change resets the double-click state
  useEffect(() => {
    clickCountRef.current = 0;
    setCountdown(null);
    setSearchMode("idle");
    clearTimeout(clickTimerRef.current);
    clearInterval(countdownRef.current);
  }, [query, location, experience, domain]);

  function handleSearchClick() {
    clickCountRef.current += 1;

    if (clickCountRef.current === 1) {
      setSearchMode("local");
      onLocalFilter?.({ query, location, experience, domain });

      let remaining = DOUBLE_CLICK_WINDOW_MS / 1000;
      setCountdown(remaining);
      countdownRef.current = setInterval(() => {
        remaining -= 1;
        setCountdown(remaining);
        if (remaining <= 0) {
          clearInterval(countdownRef.current);
          setCountdown(null);
          setSearchMode("idle");
          clickCountRef.current = 0;
        }
      }, 1000);

      clickTimerRef.current = setTimeout(() => {
        clickCountRef.current = 0;
        setSearchMode("idle");
        setCountdown(null);
      }, DOUBLE_CLICK_WINDOW_MS);

    } else if (clickCountRef.current >= 2) {
      clearTimeout(clickTimerRef.current);
      clearInterval(countdownRef.current);
      clickCountRef.current = 0;
      setCountdown(null);
      setSearchMode("live");
      onSearch?.({ query, location, experience, domain });
    }
  }

  const isDock = mode === "dock";
  const accent = theme.accent;

  // ── Styles ────────────────────────────────────────────────────
  const wrapperStyle = {
    width: "100%",
    zIndex: 200,
    fontFamily: "'DM Sans',system-ui,sans-serif",
    transition: "all 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
    ...(isDock ? {
      position: "fixed",
      top: 0, left: 0,
      padding: "8px 16px",
      background: isDark ? `${theme.surface}f0` : `${theme.surface}f5`,
      backdropFilter: "blur(16px)",
      WebkitBackdropFilter: "blur(16px)",
      borderBottom: `1px solid ${theme.border}`,
      boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
    } : {
      position: "relative",
      padding: "32px 20px 24px",
    }),
  };

  const brandingStyle = {
    textAlign: "center",
    marginBottom: 24,
    overflow: "hidden",
    maxHeight: isDock ? 0 : 120,
    opacity: isDock ? 0 : 1,
    transition: "all 0.45s cubic-bezier(0.16, 1, 0.3, 1)",
    pointerEvents: isDock ? "none" : "auto",
  };

  const barStyle = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: theme.bg,
    border: `1px solid ${theme.border}`,
    borderRadius: isDock ? 8 : 12,
    padding: isDock ? "4px 8px" : "8px 10px",
    flexWrap: "nowrap",
    maxWidth: isDock ? "100%" : 860,
    margin: "0 auto",
    transition: "all 0.4s",
  };

  const fieldStyle = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: isDock ? "4px 10px" : "6px 12px",
    borderRight: `1px solid ${theme.border}44`,
    flexShrink: 0,
  };

  const inputStyle = {
    border: "none",
    background: "transparent",
    fontSize: isDock ? 12 : 13,
    color: theme.text,
    outline: "none",
    fontFamily: "inherit",
    minWidth: 0,
  };

  const selectStyle = {
    border: "none",
    background: "transparent",
    fontSize: isDock ? 12 : 13,
    color: theme.text,
    outline: "none",
    cursor: "pointer",
    fontFamily: "inherit",
    appearance: "none",
    WebkitAppearance: "none",
  };

  const btnStyle = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: isDock ? "6px 14px" : "8px 18px",
    background: searchMode === "live" ? "#d97706" : accent,
    color: "#fff",
    border: "none",
    borderRadius: isDock ? 6 : 8,
    fontSize: isDock ? 12 : 13,
    fontWeight: 700,
    cursor: "pointer",
    transition: "background 0.2s",
    whiteSpace: "nowrap",
    flexShrink: 0,
    fontFamily: "inherit",
  };

  return (
    <div style={wrapperStyle}>
      {/* Branding — hero mode only */}
      <div style={brandingStyle}>
        <div style={{
          fontFamily: "'Barlow Condensed','DM Sans',sans-serif",
          fontWeight: 800, fontSize: 36, letterSpacing: "-0.02em",
          color: theme.text, lineHeight: 1.1,
        }}>
          Resume Master
        </div>
        <div style={{ fontSize: 15, color: theme.textMuted, marginTop: 8, lineHeight: 1.6 }}>
          {greeting
            ? `Welcome back, ${greeting}`
            : isLoggedOut
              ? "Your career, powered by AI. Sign up free."
              : "Your personalized job feed."}
        </div>
      </div>

      {/* Search bar */}
      <div style={barStyle}>
        {/* Keyword */}
        <div style={{ ...fieldStyle, flex: "1 1 180px", minWidth: 120 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={theme.textMuted}
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            type="text"
            placeholder="Job title or keywords"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSearchClick()}
            style={{ ...inputStyle, width: "100%" }}
          />
        </div>

        {/* Location */}
        <div style={{ ...fieldStyle, flex: "1 1 120px", minWidth: 90 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={theme.textMuted}
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
          </svg>
          <input
            type="text"
            placeholder="Location or Remote"
            value={location}
            onChange={e => setLocation(e.target.value)}
            style={{ ...inputStyle, width: "100%" }}
          />
        </div>

        {/* Experience */}
        <div style={{ ...fieldStyle }}>
          <select value={experience} onChange={e => setExperience(e.target.value)} style={selectStyle}>
            {EXPERIENCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        {/* Domain */}
        <div style={{ ...fieldStyle, borderRight: "none" }}>
          <select value={domain} onChange={e => setDomain(e.target.value)} style={selectStyle}>
            {DOMAIN_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        {/* Search button */}
        <button onClick={handleSearchClick} style={btnStyle}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          {searchMode === "live" ? "Searching…" : "Search"}
          {countdown !== null && (
            <span style={{
              background: "rgba(255,255,255,0.22)", borderRadius: 999,
              padding: "0 6px", fontSize: 10, fontWeight: 800,
            }}>
              {countdown}s
            </span>
          )}
        </button>
      </div>

      {/* Hint */}
      {searchMode === "local" && countdown !== null && (
        <div style={{ textAlign: "center", fontSize: 11, color: theme.textMuted, marginTop: 6 }}>
          Local results shown · click again within {countdown}s for live search
        </div>
      )}
      {searchMode === "live" && (
        <div style={{ textAlign: "center", fontSize: 11, color: accent, marginTop: 6, fontWeight: 600 }}>
          Searching all sources…
        </div>
      )}
    </div>
  );
}
