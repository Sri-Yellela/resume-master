// client/src/components/AuthScreen.jsx — Design System v4
import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";
import { useViewport } from "../hooks/useViewport.js";
import { Footer } from "./Footer.jsx";

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
  const [tab,       setTab]       = useState("login");
  const [regStep,   setRegStep]   = useState(1);
  const [adminMode, setAdminMode] = useState(false);
  // Login form
  const [login,   setLoginF]  = useState({ username:"", password:"" });
  // Registration step 1 — only in React state, never sent until step 2 completes
  const [step1,   setStep1]   = useState({ username:"", password:"", confirmPassword:"", apify_token:"" });
  // Registration step 2
  const [step2,   setStep2]   = useState({ first_name:"", middle_name:"", last_name:"", name_suffix:"", email:"", phone:"" });
  const [error,   setError]   = useState("");
  const [loading, setLoading] = useState(false);

  const setL  = (k,v) => setLoginF(f => ({ ...f, [k]:v }));
  const setS1 = (k,v) => setStep1(f => ({ ...f, [k]:v }));
  const setS2 = (k,v) => setStep2(f => ({ ...f, [k]:v }));

  // Warn before tab close while on step 2 (data would be lost)
  useEffect(() => {
    if (tab !== "register" || regStep !== 2) return;
    const handler = e => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [tab, regStep]);

  const handleLogin = async e => {
    e.preventDefault(); setError(""); setLoading(true);
    try {
      const d = await api("/api/auth/login", { method:"POST", body:JSON.stringify({ username:login.username, password:login.password }) });
      if (d.user) onLogin(d.user);
      else setError(d.error || "Login failed");
    } catch(err) { setError(err.message); }
    setLoading(false);
  };

  const handleStep1 = e => {
    e.preventDefault(); setError("");
    if (!step1.username.trim() || !step1.password) return setError("Username and password are required");
    if (step1.password.length < 8) return setError("Password must be at least 8 characters");
    if (step1.password !== step1.confirmPassword) return setError("Passwords do not match");
    if (step1.apify_token && !step1.apify_token.startsWith("apify_api_"))
      return setError("Apify token should start with apify_api_");
    setRegStep(2);
  };

  const handleRegister = async e => {
    e.preventDefault(); setError(""); setLoading(true);
    try {
      const d = await api("/api/auth/register", { method:"POST", body:JSON.stringify({
        username: step1.username.trim(),
        password: step1.password,
        apifyToken: step1.apify_token.trim() || undefined,
        profile: {
          first_name:  step2.first_name.trim(),
          middle_name: step2.middle_name.trim() || undefined,
          last_name:   step2.last_name.trim(),
          name_suffix: step2.name_suffix.trim() || undefined,
          email:       step2.email.trim(),
          phone:       step2.phone.trim() || undefined,
        },
      }) });
      if (d.user) onLogin(d.user);
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
  const halfInput = { ...inputStyle, flex:1 };

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
          <button key={t} onClick={() => { setTab(t); setRegStep(1); setError(""); }}
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
          {adminMode && (
            <div style={{ padding:"8px 12px", borderRadius:8, fontSize:12, fontWeight:600,
                          background:theme.surfaceHigh, color:theme.textMuted,
                          border:`1px solid ${theme.border}`, display:"flex", alignItems:"center", gap:6 }}>
              🔒 Sign in with your admin credentials
            </div>
          )}
          <input style={inputStyle} placeholder="Username" value={login.username}
            onChange={e=>{ setL("username",e.target.value); setAdminMode(false); }} autoFocus/>
          <input style={inputStyle} placeholder="Password" type="password" value={login.password}
            onChange={e=>setL("password",e.target.value)}/>
          {error && <div style={{ color:theme.danger, fontSize:12 }}>{error}</div>}
          <button type="submit" disabled={loading}
            style={{ width:"100%", padding:"12px 0", borderRadius:999, border:"none",
                     background:theme.gradAccent, color:"white", fontWeight:800,
                     fontSize:14, cursor:"pointer", marginTop:4,
                     opacity:loading?0.7:1, transition:"opacity 0.2s" }}>
            {loading ? "Signing in…" : "Sign In →"}
          </button>
        </form>

      ) : regStep === 1 ? (
        /* ── Register step 1: credentials ── */
        <form onSubmit={handleStep1} style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ fontSize:11, color:theme.textDim, fontWeight:600,
                        textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:2 }}>
            Step 1 of 2 — Account credentials
          </div>
          <input style={inputStyle} placeholder="Username" value={step1.username}
            onChange={e=>setS1("username",e.target.value)} autoFocus/>
          <input style={inputStyle} placeholder="Password (min 8 chars)" type="password" value={step1.password}
            onChange={e=>setS1("password",e.target.value)}/>
          <input style={inputStyle} placeholder="Confirm password" type="password" value={step1.confirmPassword}
            onChange={e=>setS1("confirmPassword",e.target.value)}/>
          <div style={{ fontSize:11, color:theme.textMuted, lineHeight:1.6,
                        padding:"10px 12px", background:theme.surfaceHigh,
                        borderRadius:10, border:`1px solid ${theme.border}` }}>
            <strong>Apify token</strong> powers job search.{" "}
            Get a free token at{" "}
            <a href="https://apify.com" target="_blank" rel="noreferrer"
              style={{ color:theme.accentText, fontWeight:700 }}>apify.com</a>
            {" "}→ Settings → Integrations. You can add it later too.
          </div>
          <input style={inputStyle} placeholder="Apify token (optional, starts with apify_api_…)"
            value={step1.apify_token} onChange={e=>setS1("apify_token",e.target.value)}/>
          {error && <div style={{ color:theme.danger, fontSize:12 }}>{error}</div>}
          <button type="submit"
            style={{ width:"100%", padding:"12px 0", borderRadius:999, border:"none",
                     background:theme.gradAccent, color:"white", fontWeight:800,
                     fontSize:14, cursor:"pointer", marginTop:4 }}>
            Continue →
          </button>
        </form>

      ) : (
        /* ── Register step 2: name + contact ── */
        <form onSubmit={handleRegister} style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ fontSize:11, color:theme.textDim, fontWeight:600,
                        textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:2 }}>
            Step 2 of 2 — Your information
          </div>
          <div style={{ display:"flex", gap:8 }}>
            <input style={halfInput} placeholder="First name *" value={step2.first_name}
              onChange={e=>setS2("first_name",e.target.value)} autoFocus/>
            <input style={{ ...inputStyle, width:72, flex:"none" }} placeholder="M.I."
              value={step2.middle_name} onChange={e=>setS2("middle_name",e.target.value)}/>
          </div>
          <div style={{ display:"flex", gap:8 }}>
            <input style={halfInput} placeholder="Last name *" value={step2.last_name}
              onChange={e=>setS2("last_name",e.target.value)}/>
            <input style={{ ...inputStyle, width:72, flex:"none" }} placeholder="Jr./Sr."
              value={step2.name_suffix} onChange={e=>setS2("name_suffix",e.target.value)}/>
          </div>
          <input style={inputStyle} placeholder="Email *" type="email" value={step2.email}
            onChange={e=>setS2("email",e.target.value)}/>
          <input style={inputStyle} placeholder="Phone (optional)" type="tel" value={step2.phone}
            onChange={e=>setS2("phone",e.target.value)}/>
          {error && <div style={{ color:theme.danger, fontSize:12 }}>{error}</div>}
          <div style={{ display:"flex", gap:8, marginTop:4 }}>
            <button type="button" onClick={() => { setRegStep(1); setError(""); }}
              style={{ padding:"12px 20px", borderRadius:999, border:`1px solid ${theme.border}`,
                       background:"transparent", color:theme.textMuted, fontWeight:700,
                       fontSize:13, cursor:"pointer" }}>
              ← Back
            </button>
            <button type="submit" disabled={loading}
              style={{ flex:1, padding:"12px 0", borderRadius:999, border:"none",
                       background:theme.gradAccent, color:"white", fontWeight:800,
                       fontSize:14, cursor:"pointer",
                       opacity:loading?0.7:1, transition:"opacity 0.2s" }}>
              {loading ? "Creating account…" : "Create Account →"}
            </button>
          </div>
        </form>
      )}

      {/* Admin access — only visible on login tab */}
      {tab === "login" && (
        <div style={{ textAlign:"center", marginTop:24 }}>
          <button
            type="button"
            onClick={() => setAdminMode(true)}
            style={{
              background:"none", border:"none", cursor:"pointer",
              fontSize:12, color:theme.textDim, fontFamily:"'DM Sans',system-ui",
              padding:"4px 8px", borderRadius:4,
              textDecoration:"none",
              transition:"color 0.15s, textDecoration 0.15s",
            }}
            onMouseEnter={e => { e.currentTarget.style.color = theme.textMuted; e.currentTarget.style.textDecoration = "underline"; }}
            onMouseLeave={e => { e.currentTarget.style.color = theme.textDim;   e.currentTarget.style.textDecoration = "none"; }}
          >
            🔒 Admin Access
          </button>
        </div>
      )}
    </motion.div>
  );
}

// ── Main AuthScreen ───────────────────────────────────────────
export default function AuthScreen({ onLogin }) {
  const { theme, mode } = useTheme();
  const { mode: vpMode } = useViewport();
  const isMobile = vpMode === "mobile" || vpMode === "tablet";
  const col1 = COMPANY_POSTERS.slice(0, 8);
  const col2 = COMPANY_POSTERS.slice(8);

  return (
    <div style={{ display:"flex", flexDirection:"column", minHeight:"100vh" }}>
      {/* Main content area — flex:1 fills space between top of page and footer */}
      <div style={{ display:"flex", flexDirection: isMobile ? "column" : "row",
                    flex:1,
                    background:theme.bg, fontFamily:"'DM Sans',system-ui,sans-serif" }}>

        {/* LEFT/TOP — Hero + login form, vertically centered */}
        <div style={{ flex: isMobile ? "1 1 auto" : "0 0 55%",
                      display:"flex", flexDirection:"column",
                      alignItems:"flex-start", justifyContent:"center",
                      padding: isMobile ? "32px 24px" : "40px 64px",
                      overflowY:"auto" }}>
          {/* Logo */}
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom: isMobile ? 28 : 48 }}>
            <span className="site-title" style={{ fontSize: isMobile ? 20 : 22 }}>Resume Master</span>
          </div>

          {/* Hero tiles — editorial style */}
          <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom: isMobile ? 20 : 32 }}>
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
          <p style={{ fontSize: isMobile ? 13 : 15, color:theme.textMuted, lineHeight:1.6,
                      marginBottom: isMobile ? 24 : 36, maxWidth:420 }}>
            AI-tailored resumes, real-time job scraping, one-click autofill.<br/>
            Match every job description with a perfectly tailored resume.
          </p>

          {/* Auth modal */}
          <AuthModal onLogin={onLogin}/>
        </div>

        {/* RIGHT — Scrolling poster cards — hidden on mobile */}
        {!isMobile && <div style={{
          flex:"0 0 45%", overflow:"hidden", position:"relative",
          background: theme.surfaceHigh, minHeight:0,
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
        </div>}
      </div>
      <Footer/>
    </div>
  );
}
