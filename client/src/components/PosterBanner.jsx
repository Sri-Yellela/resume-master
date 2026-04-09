// PosterBanner.jsx — adapted from EventsCarousel.tsx (no supabase, static data)
const POSTER_CARDS = [
  { icon:"📊", headline:"ATS-Optimised Resumes", sub:"Tailored to every job description" },
  { icon:"🎯", headline:"Land Your Next Role",   sub:"Intelligent resume generation" },
  { icon:"🚀", headline:"Apply Smarter",          sub:"Not harder — let AI do the heavy lifting" },
  { icon:"📈", headline:"Track Every Application",sub:"Never lose a lead again" },
  { icon:"🤖", headline:"AI-Powered Writing",     sub:"Claude Sonnet rewrites every bullet" },
  { icon:"👻", headline:"Ghost Job Detection",    sub:"Filtered before you even see them" },
  { icon:"⚡", headline:"One-Click Autofill",     sub:"Chrome extension fills forms instantly" },
  { icon:"🏆", headline:"Beat the Screener",      sub:"ATS scoring on every generated resume" },
];

const col1 = POSTER_CARDS.slice(0, 4);
const col2 = POSTER_CARDS.slice(4);

// Double cards for seamless loop
const col1Items = [...col1, ...col1];
const col2Items = [...col2, ...col2];

export function PosterBanner() {
  return (
    <div style={{ display:"flex", gap:12, height:"100%", overflow:"hidden" }}>
      <style>{`
        @keyframes scrollUp {
          0%   { transform: translateY(0); }
          100% { transform: translateY(-50%); }
        }
        .poster-col1 { animation: scrollUp 35s linear infinite; }
        .poster-col2 { animation: scrollUp 28s linear infinite; }
        .poster-col1:hover, .poster-col2:hover { animation-play-state: paused; }
      `}</style>

      {/* Column 1 */}
      <div style={{
        flex: 1, overflow:"hidden",
        maskImage:"linear-gradient(transparent, black 10%, black 90%, transparent)",
        WebkitMaskImage:"linear-gradient(transparent, black 10%, black 90%, transparent)",
      }}>
        <div className="poster-col1">
          {col1Items.map((c, i) => (
            <div key={i} style={{
              background:"rgba(255,255,255,0.04)",
              border:"1px solid rgba(255,255,255,0.08)",
              borderRadius:12, padding:"14px 16px",
              marginBottom:12, flexShrink:0,
            }}>
              <div style={{ fontSize:22, marginBottom:6 }}>{c.icon}</div>
              <div style={{ fontWeight:700, fontSize:13, color:"var(--tw-text-opacity,#f8fafc)", marginBottom:3 }}>
                {c.headline}
              </div>
              <div style={{ fontSize:11, color:"rgba(255,255,255,0.45)", lineHeight:1.6 }}>
                {c.sub}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Column 2 */}
      <div style={{
        flex: 1, overflow:"hidden",
        maskImage:"linear-gradient(transparent, black 10%, black 90%, transparent)",
        WebkitMaskImage:"linear-gradient(transparent, black 10%, black 90%, transparent)",
      }}>
        <div className="poster-col2" style={{ marginTop:40 }}>
          {col2Items.map((c, i) => (
            <div key={i} style={{
              background:"rgba(255,255,255,0.04)",
              border:"1px solid rgba(255,255,255,0.08)",
              borderRadius:12, padding:"14px 16px",
              marginBottom:12, flexShrink:0,
            }}>
              <div style={{ fontSize:22, marginBottom:6 }}>{c.icon}</div>
              <div style={{ fontWeight:700, fontSize:13, color:"var(--tw-text-opacity,#f8fafc)", marginBottom:3 }}>
                {c.headline}
              </div>
              <div style={{ fontSize:11, color:"rgba(255,255,255,0.45)", lineHeight:1.6 }}>
                {c.sub}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
