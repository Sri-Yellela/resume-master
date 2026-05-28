const POSTER_CARDS = [
  { headline: "ATS-Optimised Resumes", sub: "Generated from the job description" },
  { headline: "Land Your Next Role",   sub: "Intelligent resume generation" },
  { headline: "Apply Smarter",          sub: "Not harder — let AI do the heavy lifting" },
  { headline: "Track Every Application",sub: "Never lose a lead again" },
  { headline: "AI-Powered Writing",     sub: "Claude rewrites every bullet" },
  { headline: "Ghost Job Detection",    sub: "Filtered before you even see them" },
  { headline: "One-Click Autofill",     sub: "Chrome extension fills forms instantly" },
  { headline: "Beat the Screener",      sub: "ATS scoring on every generated resume" },
];

const items = [...POSTER_CARDS, ...POSTER_CARDS];

export function PosterBanner() {
  return (
    <div style={{
      width: "100%", overflow: "hidden", padding: "60px 0",
      maskImage: "linear-gradient(to right, transparent, black 8%, black 92%, transparent)",
      WebkitMaskImage: "linear-gradient(to right, transparent, black 8%, black 92%, transparent)",
    }}>
      <style>{`
        @keyframes posterScrollLeft {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .poster-track { animation: posterScrollLeft 60s linear infinite; }
        .poster-track:hover { animation-play-state: paused; }
      `}</style>
      <div className="poster-track" style={{ display: "flex", gap: 16, width: "max-content" }}>
        {items.map((c, i) => (
          <div key={i} style={{
            flexShrink: 0, width: 280,
            background: "var(--bg-card)",
            backdropFilter: "var(--bg-blur-sm)", WebkitBackdropFilter: "var(--bg-blur-sm)",
            border: "1px solid var(--border-glass)", borderRadius: 14,
            padding: "20px 22px",
          }}>
            <div style={{
              fontFamily: "var(--font-display, 'Instrument Serif', serif)",
              fontSize: 18, fontWeight: 400, color: "var(--color-text)",
              marginBottom: 6, letterSpacing: "-0.01em", lineHeight: 1.2,
            }}>{c.headline}</div>
            <div style={{ fontSize: 12, color: "var(--color-text-muted)", lineHeight: 1.5 }}>{c.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
