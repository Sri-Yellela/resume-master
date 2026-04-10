// client/src/components/AuthScreen.jsx — Design System v4
import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";

// ── AtomEmblem — keep this exported, TopBar imports it ────────
function tiltedEllipsePath(cx, cy, rx, ry, angleDeg) {
  const a = angleDeg * Math.PI / 180;
  const cos = Math.cos(a); const sin = Math.sin(a);
  const x1 = cx + rx * cos; const y1 = cy + rx * sin;
  const x2 = cx - rx * cos; const y2 = cy - rx * sin;
  return [`M ${x1} ${y1}`,`A ${rx} ${ry} ${angleDeg} 0 1 ${x2} ${y2}`,`A ${rx} ${ry} ${angleDeg} 0 1 ${x1} ${y1}`].join(" ");
}

export function AtomEmblem({ size = 120, textSize = 8.5, orbitSize = 28 }) {
  const { theme } = useTheme();
  const cx = size / 2; const cy = size / 2;
  const tr = size * 0.38; const rx = orbitSize * 0.92; const ry = orbitSize * 0.36;
  const nr = size * 0.09; const er = size * 0.048;
  const orbits = [
    { id:`orb0-${size}`, tilt:0,   begin:"0s" },
    { id:`orb1-${size}`, tilt:60,  begin:"-1.13s" },
    { id:`orb2-${size}`, tilt:120, begin:"-2.27s" },
  ];
  return (
    <div style={{ position:"relative", width:size, height:size, display:"flex", alignItems:"center", justifyContent:"center" }}>
      <style>{`
        @keyframes spinTextRing-${size} { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes nucleusPulse-${size} { 0%,100% { opacity:1; transform:translate(-50%,-50%) scale(1); } 50% { opacity:.8; transform:translate(-50%,-50%) scale(1.18); } }
        .atm-text-${size} { animation: spinTextRing-${size} 14s linear infinite; transform-origin: ${cx}px ${cy}px; }
        .atm-nucleus-${size} { animation: nucleusPulse-${size} 2.6s ease-in-out infinite; position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); }
      `}</style>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ position:"absolute", inset:0, overflow:"visible" }}>
        <defs>
          <path id={`tp-${size}`} d={`M ${cx},${cy} m -${tr},0 a ${tr},${tr} 0 1,1 ${tr*2},0 a ${tr},${tr} 0 1,1 -${tr*2},0`}/>
          <filter id={`glow-${size}`} x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="1.4" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          {orbits.map(o => <path key={o.id} id={o.id} d={tiltedEllipsePath(cx,cy,rx,ry,o.tilt)} fill="none"/>)}
        </defs>
        {orbits.map(o => (
          <ellipse key={`guide-${o.id}`} cx={cx} cy={cy} rx={rx} ry={ry}
            fill="none" stroke={theme.accent} strokeWidth={0.7} strokeOpacity={0.3}
            transform={`rotate(${o.tilt} ${cx} ${cy})`}/>
        ))}
        <g className={`atm-text-${size}`}>
          <text style={{ fontSize:textSize, fontWeight:700, fill:theme.text, letterSpacing:1.0 }}>
            <textPath href={`#tp-${size}`}>APPLY • TRACK • LAND • APPLY • TRACK • LAND • </textPath>
          </text>
        </g>
        {orbits.map(o => (
          <circle key={`e-${o.id}`} r={er} fill={theme.accent} filter={`url(#glow-${size})`}>
            <animateMotion dur="3.4s" repeatCount="indefinite" begin={o.begin}>
              <mpath href={`#${o.id}`}/>
            </animateMotion>
          </circle>
        ))}
        <circle cx={cx} cy={cy} r={nr} fill={theme.accent} opacity={0.9} filter={`url(#glow-${size})`}/>
      </svg>
      <div className={`atm-nucleus-${size}`}
        style={{ width:nr*2, height:nr*2, borderRadius:"50%", background:theme.accent, opacity:0.85 }}/>
    </div>
  );
}

// ── Company poster cards ───────────────────────────────────────
const COMPANY_POSTERS = [
  { name:"Google",     cat:"Tech Giant",      bg:"#4285F4", fg:"#fff", accent:"#fbbc04" },
  { name:"Meta",       cat:"Social Platform", bg:"#0866FF", fg:"#fff", accent:"#23d5ab" },
  { name:"Amazon",     cat:"E-Commerce",      bg:"#FF9900", fg:"#111", accent:"#146eb4" },
  { name:"Stripe",     cat:"Fintech",         bg:"#635BFF", fg:"#fff", accent:"#00d4ff" },
  { name:"Airbnb",     cat:"Travel & Stay",   bg:"#FF5A5F", fg:"#fff", accent:"#fff" },
  { name:"Netflix",    cat:"Streaming",       bg:"#E50914", fg:"#fff", accent:"#fff" },
  { name:"Snowflake",  cat:"Data Cloud",      bg:"#29B5E8", fg:"#fff", accent:"#fff" },
  { name:"Databricks", cat:"AI Platform",     bg:"#FF3621", fg:"#fff", accent:"#fff" },
  { name:"OpenAI",     cat:"AI Research",     bg:"#10A37F", fg:"#fff", accent:"#fff" },
  { name:"Anthropic",  cat:"AI Safety",       bg:"#CC785C", fg:"#fff", accent:"#fff" },
  { name:"Uber",       cat:"Mobility",        bg:"#1C1C1C", fg:"#fff", accent:"#fff" },
  { name:"DoorDash",   cat:"Delivery",        bg:"#FF3008", fg:"#fff", accent:"#fff" },
  { name:"Spotify",    cat:"Music & Audio",   bg:"#1DB954", fg:"#fff", accent:"#fff" },
  { name:"Palantir",   cat:"Data Analytics",  bg:"#101113", fg:"#fff", accent:"#7b8cde" },
  { name:"Datadog",    cat:"Observability",   bg:"#632CA6", fg:"#fff", accent:"#fff" },
  { name:"Cloudflare", cat:"Edge Network",    bg:"#F48120", fg:"#fff", accent:"#fff" },
];

function PosterCard({ company, index }) {
  return (
    <div style={{
      background: company.bg, borderRadius: 16, padding:"18px 16px",
      marginBottom: 12, flexShrink: 0,
      transform: `rotate(${index % 2 === 0 ? "1.2deg" : "-1.2deg"})`,
      boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
      position: "relative", overflow: "hidden",
      minHeight: 110, display: "flex", flexDirection: "column",
      justifyContent: "space-between",
    }}>
      <div style={{ fontSize:9, fontWeight:700, letterSpacing:"0.12em", textTransform:"uppercase",
                    color:company.fg, opacity:0.7, background:"rgba(255,255,255,0.15)",
                    borderRadius:999, padding:"3px 10px", alignSelf:"flex-start" }}>
        {company.cat}
      </div>
      <div style={{ fontSize:"clamp(24px,3.5vw,42px)", fontWeight:900, letterSpacing:"-1.5px",
                    color:company.fg, lineHeight:1, fontFamily:"'DM Sans',system-ui,sans-serif", marginTop:8 }}>
        {company.name}
      </div>
      <div style={{ position:"absolute", right:-16, bottom:-16, width:64, height:64,
                    borderRadius:"50%", background:company.accent, opacity:0.25 }}/>
    </div>
  );
}

// ── Auth modal ────────────────────────────────────────────────
function AuthModal({ onLogin }) {
  const { theme, mode } = useTheme();
  const [tab,      setTab]      = useState("login");
  const [step,     setStep]     = useState(1);
  const [form,     setForm]     = useState({ username:"", password:"", apify_token:"" });
  const [error,    setError]    = useState("");
  const [loading,  setLoading]  = useState(false);

  const set = (k,v) => setForm(f => ({ ...f, [k]:v }));

  const handleLogin = async e => {
    e.preventDefault(); setError(""); setLoading(true);
    try {
      const d = await api("/api/auth/login", { method:"POST", body:JSON.stringify({ username:form.username, password:form.password }) });
      if (d.user) onLogin(d.user);
      else if (d.ok) onLogin(d.user);
      else setError(d.error || "Login failed");
    } catch(err) { setError(err.message); }
    setLoading(false);
  };

  const handleRegister = async e => {
    e.preventDefault(); setError(""); setLoading(true);
    try {
      const d = await api("/api/auth/register", { method:"POST", body:JSON.stringify(form) });
      if (d.user) onLogin(d.user);
      else if (d.ok) onLogin(d.user);
      else setError(d.error || "Registration failed");
    } catch(err) { setError(err.message); }
    setLoading(false);
  };

  const inputStyle = {
    width:"100%", height:42, padding:"0 14px",
    borderRadius:10, border:`1px solid ${theme.border}`,
    background:theme.surface, color:theme.text,
    fontFamily:"'DM Sans',system-ui", fontSize:13,
    outline:"none", boxSizing:"border-box",
    transition:"border-color 0.15s",
  };

  return (
    <motion.div initial={{ opacity:0, scale:0.95 }} animate={{ opacity:1, scale:1 }}
      transition={{ duration:0.2 }}
      style={{ background:theme.surface, borderRadius:24, padding:36,
               width:"100%", maxWidth:400, boxShadow:theme.shadowXl,
               border:`1px solid ${theme.border}` }}>

      {/* Tab switcher */}
      <div style={{ display:"flex", gap:4, marginBottom:28,
                    background:mode==="dark"?"rgba(255,255,255,0.06)":"rgba(0,0,0,0.05)",
                    borderRadius:999, padding:4 }}>
        {["login","register"].map(t => (
          <button key={t} onClick={() => { setTab(t); setStep(1); setError(""); }}
            style={{ flex:1, padding:"7px 0", borderRadius:999, border:"none",
                     fontWeight:700, fontSize:12, cursor:"pointer",
                     background: tab===t ? theme.accent : "transparent",
                     color: tab===t ? "white" : theme.textMuted,
                     transition:"all 0.2s" }}>
            {t === "login" ? "Sign In" : "Create Account"}
          </button>
        ))}
      </div>

      {tab === "login" ? (
        <form onSubmit={handleLogin} style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <input style={inputStyle} placeholder="Username" value={form.username}
            onChange={e=>set("username",e.target.value)} autoFocus/>
          <input style={inputStyle} placeholder="Password" type="password" value={form.password}
            onChange={e=>set("password",e.target.value)}/>
          {error && <div style={{ color:theme.danger, fontSize:12 }}>{error}</div>}
          <button type="submit" disabled={loading}
            style={{ width:"100%", padding:"12px 0", borderRadius:999, border:"none",
                     background:theme.gradAccent, color:"white", fontWeight:800,
                     fontSize:14, cursor:"pointer", marginTop:4,
                     opacity:loading?0.7:1, transition:"opacity 0.2s" }}>
            {loading ? "Signing in…" : "Sign In →"}
          </button>
        </form>
      ) : (
        <form onSubmit={handleRegister} style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <input style={inputStyle} placeholder="Username" value={form.username}
            onChange={e=>set("username",e.target.value)} autoFocus/>
          <input style={inputStyle} placeholder="Password" type="password" value={form.password}
            onChange={e=>set("password",e.target.value)}/>
          <div style={{ fontSize:11, color:theme.textMuted, lineHeight:1.5,
                        padding:"10px 12px", background:theme.surfaceHigh,
                        borderRadius:10, border:`1px solid ${theme.border}` }}>
            Optional: Paste your <strong>Apify token</strong> now for job scraping.<br/>
            (You can also add it later via ☰ menu)
          </div>
          <input style={inputStyle} placeholder="Apify token (optional)" value={form.apify_token}
            onChange={e=>set("apify_token",e.target.value)}/>
          {error && <div style={{ color:theme.danger, fontSize:12 }}>{error}</div>}
          <button type="submit" disabled={loading}
            style={{ width:"100%", padding:"12px 0", borderRadius:999, border:"none",
                     background:theme.gradAccent, color:"white", fontWeight:800,
                     fontSize:14, cursor:"pointer", marginTop:4,
                     opacity:loading?0.7:1, transition:"opacity 0.2s" }}>
            {loading ? "Creating account…" : "Create Account →"}
          </button>
        </form>
      )}
    </motion.div>
  );
}

// ── Main AuthScreen ───────────────────────────────────────────
export default function AuthScreen({ onLogin }) {
  const { theme, mode } = useTheme();
  const col1 = COMPANY_POSTERS.slice(0, 8);
  const col2 = COMPANY_POSTERS.slice(8);

  return (
    <div style={{ display:"flex", height:"100vh", overflow:"hidden",
                  background:theme.bg, fontFamily:"'DM Sans',system-ui,sans-serif" }}>

      {/* LEFT — Hero */}
      <div style={{ flex:"0 0 55%", display:"flex", flexDirection:"column",
                    justifyContent:"center", padding:"60px 64px",
                    overflowY:"auto" }}>
        {/* Logo */}
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:48 }}>
          <span className="site-title" style={{ fontSize:22 }}>Resume Master</span>
        </div>

        {/* Hero tiles — editorial style */}
        <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:32 }}>
          {/* Row 1 */}
          <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
            <div style={{
              padding:"14px 28px", borderRadius:14,
              border:`1.5px solid ${theme.border}`, background:theme.surface,
              fontSize:"clamp(36px,4.5vw,60px)", fontWeight:900,
              letterSpacing:"-3px", color:theme.text, lineHeight:1,
            }}>Land</div>
            <div style={{
              padding:"14px 28px", borderRadius:999,
              background:theme.gradAccent,
              fontSize:"clamp(36px,4.5vw,60px)", fontWeight:900,
              letterSpacing:"-3px", color:"white", lineHeight:1,
            }}>your next</div>
          </div>
          {/* Row 2 */}
          <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
            <div style={{
              padding:"14px 28px", borderRadius:14,
              border:`1.5px solid ${theme.border}`, background:theme.surface,
              fontSize:"clamp(36px,4.5vw,60px)", fontWeight:900,
              letterSpacing:"-3px", color:theme.text, lineHeight:1,
            }}>role</div>
            <div style={{
              padding:"14px 28px", borderRadius:14,
              border:`1.5px solid ${theme.border}`, background:theme.surface,
              fontSize:"clamp(36px,4.5vw,60px)", fontWeight:900,
              letterSpacing:"-3px", color:theme.text, lineHeight:1,
            }}>faster</div>
          </div>
        </div>

        {/* Subtitle */}
        <p style={{ fontSize:15, color:theme.textMuted, lineHeight:1.6,
                    marginBottom:36, maxWidth:420 }}>
          AI-tailored resumes, real-time job scraping, one-click autofill.<br/>
          Match every job description with a perfectly tailored resume.
        </p>

        {/* Auth modal */}
        <AuthModal onLogin={onLogin}/>
      </div>

      {/* RIGHT — Scrolling poster cards */}
      <div style={{
        flex:"0 0 45%", overflow:"hidden", position:"relative",
        background: theme.surfaceHigh,
      }}>
        {/* Top fade */}
        <div style={{ position:"absolute", top:0, left:0, right:0, height:80,
                      background:`linear-gradient(to bottom, ${theme.surfaceHigh}, transparent)`,
                      zIndex:10 }}/>
        {/* Bottom fade */}
        <div style={{ position:"absolute", bottom:0, left:0, right:0, height:80,
                      background:`linear-gradient(to top, ${theme.surfaceHigh}, transparent)`,
                      zIndex:10 }}/>

        <div style={{ display:"flex", gap:12, height:"100%", padding:"0 16px" }}>
          {/* Column 1 — scrolls up */}
          <div style={{ flex:1, overflow:"hidden" }}>
            <div style={{ display:"flex", flexDirection:"column", animation:"scrollUp 30s linear infinite" }}>
              {[...col1,...col1].map((c,i) => <PosterCard key={i} company={c} index={i}/>)}
            </div>
          </div>
          {/* Column 2 — scrolls up slightly slower */}
          <div style={{ flex:1, overflow:"hidden" }}>
            <div style={{ display:"flex", flexDirection:"column", animation:"scrollUp 38s linear infinite", marginTop:60 }}>
              {[...col2,...col2].map((c,i) => <PosterCard key={i} company={c} index={i+1}/>)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
