// REVAMP v1 — AuthScreen.jsx
import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { api }      from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";

// ── Helpers ───────────────────────────────────────────────────
function tiltedEllipsePath(cx, cy, rx, ry, angleDeg) {
  const a = angleDeg * Math.PI / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const x1 =  cx + rx * cos;
  const y1 =  cy + rx * sin;
  const x2 =  cx - rx * cos;
  const y2 =  cy - rx * sin;
  return [
    `M ${x1} ${y1}`,
    `A ${rx} ${ry} ${angleDeg} 0 1 ${x2} ${y2}`,
    `A ${rx} ${ry} ${angleDeg} 0 1 ${x1} ${y1}`,
  ].join(" ");
}

// ── AtomEmblem ────────────────────────────────────────────────
// Named export — imported by TopBar for the post-login brand bar.
export function AtomEmblem({ size = 120, textSize = 8.5, orbitSize = 28 }) {
  const cx = size / 2;
  const cy = size / 2;
  const tr = size * 0.38;
  const rx = orbitSize * 0.92;
  const ry = orbitSize * 0.36;
  const nr = size * 0.09;
  const er = size * 0.048;

  const orbits = [
    { id:`orb0-${size}`, tilt:0,   begin:"0s"     },
    { id:`orb1-${size}`, tilt:60,  begin:"-1.13s" },
    { id:`orb2-${size}`, tilt:120, begin:"-2.27s" },
  ];

  return (
    <div style={{ position:"relative", width:size, height:size,
                  display:"flex", alignItems:"center", justifyContent:"center" }}>
      <style>{`
        @keyframes spinTextRing-${size} {
          from { transform: rotate(0deg);   }
          to   { transform: rotate(360deg); }
        }
        @keyframes nucleusPulse-${size} {
          0%,100% { opacity:1;  transform:translate(-50%,-50%) scale(1);    }
          50%     { opacity:.8; transform:translate(-50%,-50%) scale(1.18); }
        }
        .atm-text-${size} {
          animation: spinTextRing-${size} 14s linear infinite;
          transform-origin: ${cx}px ${cy}px;
        }
        .atm-nucleus-${size} {
          animation: nucleusPulse-${size} 2.6s ease-in-out infinite;
          position: absolute; top: 50%; left: 50%;
          transform: translate(-50%,-50%);
        }
      `}</style>

      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
           style={{ position:"absolute", inset:0, overflow:"visible" }}>
        <defs>
          <path id={`tp-${size}`}
            d={`M ${cx},${cy} m -${tr},0 a ${tr},${tr} 0 1,1 ${tr*2},0 a ${tr},${tr} 0 1,1 -${tr*2},0`}/>
          <filter id={`glow-${size}`} x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="1.4" result="blur"/>
            <feMerge>
              <feMergeNode in="blur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
          {orbits.map(o => (
            <path key={o.id} id={o.id}
              d={tiltedEllipsePath(cx, cy, rx, ry, o.tilt)}
              fill="none"/>
          ))}
        </defs>
        {orbits.map(o => (
          <ellipse key={`guide-${o.id}`}
            cx={cx} cy={cy} rx={rx} ry={ry}
            fill="none" stroke="#e879f9"
            strokeWidth={0.7} strokeOpacity={0.28}
            transform={`rotate(${o.tilt} ${cx} ${cy})`}/>
        ))}
        <g className={`atm-text-${size}`}>
          <text style={{ fontSize:textSize, fontWeight:700,
                         fill:"currentColor", letterSpacing:1.0 }}>
            <textPath href={`#tp-${size}`}>
              APPLY • TRACK • LAND • APPLY • TRACK • LAND •{" "}
            </textPath>
          </text>
        </g>
        {orbits.map(o => (
          <circle key={`e-${o.id}`} r={er}
            fill="#e879f9" filter={`url(#glow-${size})`}>
            <animateMotion dur="3.4s" repeatCount="indefinite" begin={o.begin}>
              <mpath href={`#${o.id}`}/>
            </animateMotion>
          </circle>
        ))}
      </svg>
      <div className={`atm-nucleus-${size}`}
           style={{ width:nr*2, height:nr*2, borderRadius:"50%",
                    background:"radial-gradient(circle at 32% 32%, #f5d0fe, #e879f9)",
                    boxShadow:`0 0 ${nr}px ${nr*0.5}px rgba(232,121,249,.55)`,
                    pointerEvents:"none" }}/>
    </div>
  );
}

// ── COMPANY_POSTERS ───────────────────────────────────────────
const COMPANY_POSTERS = [
  { icon:"🧠", title:"AI Resume Tailoring",  desc:"Claude Sonnet rewrites bullets for every JD." },
  { icon:"📡", title:"Live Job Scraping",     desc:"LinkedIn + Indeed on demand, deduplicated." },
  { icon:"⚡", title:"One-Click Autofill",    desc:"Fills forms across all major ATS platforms." },
  { icon:"📊", title:"Application Tracker",  desc:"Every PDF logged, searchable, exportable." },
  { icon:"✦",  title:"ATS Scoring",           desc:"See your keyword match score instantly." },
  { icon:"🎯", title:"Role Normalisation",    desc:"SWE, MLE, DE — always matched correctly." },
  { icon:"💾", title:"Resume Sandbox",        desc:"Edit HTML live with real-time preview." },
  { icon:"🔍", title:"Ghost Job Filter",      desc:"Only real, fresh openings. No noise." },
  { icon:"✨", title:"Smart Search",          desc:"AI extracts best query from your resume." },
  { icon:"📈", title:"Best Possible Score",   desc:"Know your ceiling before you apply." },
];

function PosterCard({ card, theme }) {
  return (
    <div style={{ background:theme.gradPanel, border:`1px solid ${theme.colorBorder}`,
                  borderRadius:12, padding:"14px 16px", marginBottom:12, flexShrink:0 }}>
      <div style={{ fontSize:22, marginBottom:8 }}>{card.icon}</div>
      <div style={{ fontWeight:800, fontSize:13, color:theme.colorText, marginBottom:4 }}>
        {card.title}
      </div>
      <div style={{ fontSize:11, color:theme.colorMuted, lineHeight:1.6 }}>
        {card.desc}
      </div>
    </div>
  );
}

function PosterBanner({ theme }) {
  const col1 = COMPANY_POSTERS.slice(0, 5);
  const col2 = COMPANY_POSTERS.slice(5);

  return (
    <div style={{ display:"flex", gap:12, height:"100%", overflow:"hidden" }}>
      <style>{`
        @keyframes scrollBanner1 { 0%{transform:translateY(0)} 100%{transform:translateY(-50%)} }
        @keyframes scrollBanner2 { 0%{transform:translateY(0)} 100%{transform:translateY(-50%)} }
        .banner-col1 { animation: scrollBanner1 35s linear infinite; }
        .banner-col2 { animation: scrollBanner2 28s linear infinite; }
        .banner-col1:hover, .banner-col2:hover { animation-play-state: paused; }
      `}</style>
      {/* Column 1 */}
      <div style={{ flex:1, overflow:"hidden", maskImage:"linear-gradient(transparent,black 10%,black 90%,transparent)" }}>
        <div className="banner-col1">
          {[...col1, ...col1].map((c, i) => (
            <PosterCard key={i} card={c} theme={theme}/>
          ))}
        </div>
      </div>
      {/* Column 2 */}
      <div style={{ flex:1, overflow:"hidden", maskImage:"linear-gradient(transparent,black 10%,black 90%,transparent)" }}>
        <div className="banner-col2" style={{ marginTop:40 }}>
          {[...col2, ...col2].map((c, i) => (
            <PosterCard key={i} card={c} theme={theme}/>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Company ticker ────────────────────────────────────────────
const COMPANIES = [
  { name:"Google",     color:"#4285F4" }, { name:"Meta",       color:"#0866FF" },
  { name:"Amazon",     color:"#FF9900" }, { name:"Apple",      color:"#aaaaaa" },
  { name:"Microsoft",  color:"#00A4EF" }, { name:"Netflix",    color:"#E50914" },
  { name:"Stripe",     color:"#635BFF" }, { name:"Airbnb",     color:"#FF5A5F" },
  { name:"Uber",       color:"#94a3b8" }, { name:"Spotify",    color:"#1DB954" },
  { name:"Snowflake",  color:"#29B5E8" }, { name:"Databricks", color:"#FF3621" },
  { name:"OpenAI",     color:"#10A37F" }, { name:"Anthropic",  color:"#CC785C" },
  { name:"Palantir",   color:"#64748b" }, { name:"Figma",      color:"#F24E1E" },
];

function CompanyTicker({ theme }) {
  const items = [...COMPANIES, ...COMPANIES];
  return (
    <div style={{ overflow:"hidden", width:"100%",
                  borderTop:`1px solid ${theme.colorBorder}`,
                  borderBottom:`1px solid ${theme.colorBorder}`,
                  padding:"14px 0", background:theme.colorSurface }}>
      <style>{`
        @keyframes tickerScroll {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .ticker-track {
          display:flex; gap:40px; width:max-content;
          animation: tickerScroll 32s linear infinite;
        }
        .ticker-track:hover { animation-play-state: paused; }
      `}</style>
      <div className="ticker-track">
        {items.map((c, i) => (
          <div key={i} style={{ display:"flex", alignItems:"center",
                                gap:8, whiteSpace:"nowrap" }}>
            <div style={{ width:10, height:10, borderRadius:"50%",
                          background:c.color, flexShrink:0 }}/>
            <span style={{ fontSize:13, fontWeight:700,
                           color:theme.colorText, letterSpacing:"0.5px" }}>{c.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Field normalisers ─────────────────────────────────────────
function normalisePhone(raw) {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  const local  = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (local.length !== 10) return raw;
  return `+1 (${local.slice(0,3)}) ${local.slice(3,6)}-${local.slice(6)}`;
}
function normaliseUrl(raw) {
  if (!raw) return "";
  const t = raw.trim();
  return t && !t.startsWith("http") ? "https://" + t : t;
}

// ── Viewport-aware info popover ───────────────────────────────
function InfoPopover({ anchorRef, open, onClose, children, maxWidth = 280 }) {
  const popRef = useRef();
  const [pos, setPos] = useState({ top:0, left:0 });

  useEffect(() => {
    if (!open || !anchorRef?.current) return;
    const r  = anchorRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = r.right + 8;
    if (left + maxWidth > vw - 8) left = Math.max(8, r.left - maxWidth - 8);
    let top = r.top;
    if (top + 180 > vh - 8) top = Math.max(8, vh - 188);
    setPos({ top, left: Math.max(8, left) });
  }, [open, anchorRef, maxWidth]);

  useEffect(() => {
    if (!open) return;
    const onKey = e => { if (e.key === "Escape") onClose(); };
    const onMD  = e => {
      if (anchorRef?.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      onClose();
    };
    document.addEventListener("keydown",   onKey);
    document.addEventListener("mousedown", onMD);
    return () => {
      document.removeEventListener("keydown",   onKey);
      document.removeEventListener("mousedown", onMD);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;
  return (
    <div ref={popRef} style={{
      position:"fixed", top:pos.top, left:pos.left, maxWidth,
      background:"#1e293b", border:"1px solid #334155", borderRadius:8,
      padding:"10px 12px", color:"#94a3b8", fontSize:10, lineHeight:1.6,
      zIndex:2000, boxShadow:"0 8px 24px rgba(0,0,0,.6)", wordBreak:"break-word",
    }}>
      {children}
    </div>
  );
}

// ── Auth modal ────────────────────────────────────────────────
function AuthModal({ mode: initialMode, onLogin, onClose, theme }) {
  const [mode,   setMode]   = useState(initialMode || "login");
  const [step,   setStep]   = useState(1);
  const [busy,   setBusy]   = useState(false);
  const [err,    setErr]    = useState("");
  const [status, setStatus] = useState("");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm,  setConfirm]  = useState("");
  const [profile,  setProfile]  = useState({
    full_name:"", email:"", phone:"",
    linkedin_url:"", github_url:"",
    address_line1:"", address_line2:"",
    city:"", state:"", zip:"", country:"United States", location:"",
    gender:"", ethnicity:"", veteran_status:"", disability_status:"",
    visa_type:"", work_auth:"",
    requires_sponsorship:false, has_clearance:false, clearance_level:"",
  });
  const sp = (k, v) => setProfile(p => ({ ...p, [k]:v }));

  const [apifyToken,    setApifyToken]    = useState("");
  const [apifyTokenErr, setApifyTokenErr] = useState("");
  const [apifyInfoOpen, setApifyInfoOpen] = useState(false);
  const apifyInfoRef = useRef();

  useEffect(() => {
    const h = e => { if (e.key==="Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  const handleLogin = async e => {
    e.preventDefault();
    if (!username||!password) { setErr("Enter username and password."); return; }
    setBusy(true); setErr("");
    try {
      const d = await api("/api/auth/login",{
        method:"POST", body:JSON.stringify({ username, password }),
      });
      if (d.ok) onLogin(d.user);
      else setErr(d.error || "Invalid credentials.");
    } catch { setErr("Server error — is the server running?"); }
    finally { setBusy(false); }
  };

  const handleAccountNext = e => {
    e.preventDefault();
    if (!username)           { setErr("Choose a username."); return; }
    if (password.length < 8) { setErr("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setErr("Passwords do not match."); return; }
    setErr(""); setStep(2);
  };

  const handleRegister = async e => {
    e.preventDefault();
    if (!profile.full_name) { setErr("Full name is required."); return; }
    if (!profile.email)     { setErr("Email is required."); return; }
    if (!apifyToken.trim()) { setApifyTokenErr("Apify token is required"); return; }
    setBusy(true); setErr(""); setApifyTokenErr("");
    try {
      const d = await api("/api/auth/register",{
        method:"POST", body:JSON.stringify({ username, password, profile, apifyToken: apifyToken.trim() }),
      });
      if (d.ok) {
        setStatus("Account created! Signing you in…");
        const login = await api("/api/auth/login",{
          method:"POST", body:JSON.stringify({ username, password }),
        });
        if (login.ok) onLogin(login.user);
        else setErr("Account created but login failed — try signing in.");
      } else { setErr(d.error || "Registration failed."); }
    } catch { setErr("Server error."); }
    finally { setBusy(false); }
  };

  const inp = {
    width:"100%", padding:"9px 11px", borderRadius:"10px",
    border:`1px solid ${theme.colorBorder}`,
    background:`rgba(255,255,255,0.08)`,
    color:theme.colorText, fontSize:12, outline:"none", boxSizing:"border-box",
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.75)",
                  backdropFilter:"blur(8px)", zIndex:1000,
                  display:"flex", alignItems:"center",
                  justifyContent:"center", padding:16 }}
      onClick={e => { if(e.target===e.currentTarget) onClose(); }}>
      <motion.div
        initial={{ opacity:0, scale:0.95 }}
        animate={{ opacity:1, scale:1 }}
        transition={{ duration:0.2 }}
        style={{ background:theme.gradPanel, border:`1px solid ${theme.colorBorder}`,
                 borderRadius:"24px", padding:"28px 28px",
                 width:"100%", maxWidth:460, position:"relative",
                 boxShadow:"0 40px 80px rgba(0,0,0,.6)",
                 maxHeight:"calc(100vh - 32px)", overflowY:"auto" }}>
        <button style={{ position:"absolute", top:16, right:16, background:"transparent",
                         border:"none", color:theme.colorMuted, cursor:"pointer", fontSize:18 }}
          onClick={onClose}>✕</button>

        {/* Mode tabs */}
        <div style={{ display:"flex", background:`rgba(0,0,0,0.3)`, borderRadius:8,
                      padding:3, gap:3, marginBottom:20 }}>
          {[["login","Sign In"],["register","Create Account"]].map(([m, l]) => (
            <button key={m}
              style={{ flex:1,
                       background:mode===m ? theme.colorPrimary : "transparent",
                       color:mode===m ? "#000" : theme.colorMuted,
                       border:"none", borderRadius:"999px", padding:"7px 0",
                       cursor:"pointer", fontSize:12, fontWeight:700,
                       transition:"background 0.2s, color 0.2s" }}
              onClick={() => { setMode(m); setStep(1); setErr(""); }}>
              {l}
            </button>
          ))}
        </div>

        {err    && <div style={{ background:"rgba(239,68,68,0.15)", color:"#fca5a5",
                                  fontSize:11, padding:"8px 10px", borderRadius:6,
                                  marginBottom:12 }}>✗ {err}</div>}
        {status && <div style={{ background:"rgba(16,185,129,0.15)", color:"#86efac",
                                  fontSize:11, padding:"8px 10px", borderRadius:6,
                                  marginBottom:12 }}>{status}</div>}

        {mode === "login" && (
          <form onSubmit={handleLogin} style={{ display:"flex", flexDirection:"column", gap:0 }}>
            <MField label="Username" theme={theme}>
              <input style={inp} value={username}
                onChange={e=>setUsername(e.target.value)} placeholder="Username" autoFocus/>
            </MField>
            <MField label="Password" theme={theme}>
              <input style={inp} type="password" value={password}
                onChange={e=>setPassword(e.target.value)} placeholder="Password"/>
            </MField>
            <button type="submit" disabled={busy}
              style={{ width:"100%", padding:"11px", borderRadius:"999px", border:"none",
                       background:theme.gradAccent, color:"#000", fontWeight:800,
                       fontSize:13, cursor:"pointer", marginTop:6 }}>
              {busy ? "Signing in…" : "Sign In →"}
            </button>
          </form>
        )}

        {mode === "register" && step === 1 && (
          <form onSubmit={handleAccountNext}
            style={{ display:"flex", flexDirection:"column", gap:0 }}>
            <div style={{ fontSize:11, fontWeight:700, color:theme.colorMuted, marginBottom:14 }}>
              Step 1 of 2 — Account details
            </div>
            <MField label="Username" theme={theme}>
              <input style={inp} value={username}
                onChange={e=>setUsername(e.target.value)}
                placeholder="Choose a username" autoFocus/>
            </MField>
            <MField label="Password" theme={theme}>
              <input style={inp} type="password" value={password}
                onChange={e=>setPassword(e.target.value)} placeholder="Min. 8 characters"/>
            </MField>
            <MField label="Confirm Password" theme={theme}>
              <input style={inp} type="password" value={confirm}
                onChange={e=>setConfirm(e.target.value)} placeholder="Repeat password"/>
            </MField>
            <button type="submit"
              style={{ width:"100%", padding:"11px", borderRadius:"999px", border:"none",
                       background:theme.gradAccent, color:"#000", fontWeight:800,
                       fontSize:13, cursor:"pointer", marginTop:6 }}>
              Next →
            </button>
          </form>
        )}

        {mode === "register" && step === 2 && (
          <form onSubmit={handleRegister}
            style={{ display:"flex", flexDirection:"column", gap:0,
                     maxHeight:"55vh", overflowY:"auto", paddingRight:4 }}>
            <div style={{ fontSize:11, fontWeight:700, color:theme.colorMuted, marginBottom:14 }}>
              Step 2 of 2 — Your profile{" "}
              <span style={{ color:theme.colorDim, fontWeight:400 }}>(used for autofill)</span>
            </div>

            <MSec title="Personal" theme={theme}>
              <MField label="Full Name *" theme={theme}>
                <input style={inp} value={profile.full_name}
                  onChange={e=>sp("full_name",e.target.value)}
                  placeholder="First Last  or  First Middle Last" autoFocus/>
                <span style={{ fontSize:9, color:theme.colorDim, marginTop:2,
                               display:"block", lineHeight:1.4 }}>
                  Enter your name exactly as it should appear on applications.
                </span>
              </MField>
              <MField label="Email *" theme={theme}>
                <input style={inp} type="email" value={profile.email}
                  onChange={e=>sp("email",e.target.value)} placeholder="you@email.com"/>
              </MField>
              <MField label="Phone" theme={theme}>
                <input style={inp} type="tel" value={profile.phone}
                  onChange={e=>sp("phone",e.target.value)}
                  onBlur={()=>sp("phone", normalisePhone(profile.phone))}
                  placeholder="+1 (555) 000-0000  or  5550001234"/>
                <span style={{ fontSize:9, color:theme.colorDim, marginTop:2,
                               display:"block", lineHeight:1.4 }}>
                  Any format — normalised on save.
                </span>
              </MField>
              <MField label="LinkedIn" theme={theme}>
                <input style={inp} value={profile.linkedin_url}
                  onChange={e=>sp("linkedin_url",e.target.value)}
                  onBlur={()=>sp("linkedin_url", normaliseUrl(profile.linkedin_url))}
                  placeholder="linkedin.com/in/handle"/>
              </MField>
              <MField label="GitHub" theme={theme}>
                <input style={inp} value={profile.github_url}
                  onChange={e=>sp("github_url",e.target.value)}
                  onBlur={()=>sp("github_url", normaliseUrl(profile.github_url))}
                  placeholder="github.com/handle"/>
              </MField>
            </MSec>

            <MSec title="Address" theme={theme}>
              <MField label="Street Address" theme={theme}>
                <input style={inp} value={profile.address_line1}
                  onChange={e=>sp("address_line1",e.target.value)} placeholder="123 Main St"/>
              </MField>
              <MField label="Apt / Suite / Unit" theme={theme}>
                <input style={inp} value={profile.address_line2}
                  onChange={e=>sp("address_line2",e.target.value)} placeholder="Apt 4B"/>
              </MField>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                <MField label="City" theme={theme}>
                  <input style={inp} value={profile.city}
                    onChange={e=>sp("city",e.target.value)} placeholder="Boston"/>
                </MField>
                <MField label="State" theme={theme}>
                  <input style={inp} value={profile.state}
                    onChange={e=>sp("state",e.target.value)}
                    onBlur={()=>sp("state", profile.state.trim().toUpperCase().slice(0,2))}
                    placeholder="MA"/>
                </MField>
                <MField label="ZIP" theme={theme}>
                  <input style={inp} value={profile.zip}
                    onChange={e=>sp("zip",e.target.value)}
                    onBlur={()=>sp("zip", profile.zip.replace(/[^\dA-Z\s-]/gi,"").trim().slice(0,7))}
                    placeholder="02101"/>
                </MField>
              </div>
            </MSec>

            <MSec title="Work Authorization" theme={theme}>
              <MField label="Visa / Status" theme={theme}>
                <select style={inp} value={profile.visa_type}
                  onChange={e=>sp("visa_type",e.target.value)}>
                  <option value="">Select…</option>
                  <option>US Citizen</option><option>Green Card / LPR</option>
                  <option>H-1B</option><option>OPT</option><option>STEM OPT</option>
                  <option>TN Visa</option><option>O-1</option><option>Other</option>
                </select>
              </MField>
              <MField label="Work Authorization" theme={theme}>
                <select style={inp} value={profile.work_auth}
                  onChange={e=>sp("work_auth",e.target.value)}>
                  <option value="">Select…</option>
                  <option>Authorized to work in the US without sponsorship</option>
                  <option>Will require sponsorship now or in the future</option>
                </select>
              </MField>
              <label style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8,
                              cursor:"pointer", fontSize:12, color:theme.colorText }}>
                <input type="checkbox" checked={profile.requires_sponsorship}
                  onChange={e=>sp("requires_sponsorship",e.target.checked)}
                  style={{ accentColor:"#e879f9" }}/>
                {" "}Requires visa sponsorship
              </label>
              <label style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8,
                              cursor:"pointer", fontSize:12, color:theme.colorText }}>
                <input type="checkbox" checked={profile.has_clearance}
                  onChange={e=>sp("has_clearance",e.target.checked)}
                  style={{ accentColor:"#e879f9" }}/>
                {" "}Active security clearance
              </label>
              {profile.has_clearance && (
                <MField label="Clearance Level" theme={theme}>
                  <select style={inp} value={profile.clearance_level}
                    onChange={e=>sp("clearance_level",e.target.value)}>
                    <option value="">Select…</option>
                    <option>Public Trust</option><option>Secret</option>
                    <option>Top Secret</option><option>TS/SCI</option>
                    <option>TS/SCI + Poly</option>
                  </select>
                </MField>
              )}
            </MSec>

            <MSec title="Voluntary EEO" theme={theme}>
              <MField label="Gender" theme={theme}>
                <select style={inp} value={profile.gender}
                  onChange={e=>sp("gender",e.target.value)}>
                  <option value="">Prefer not to say</option>
                  <option>Male</option><option>Female</option><option>Non-binary</option>
                </select>
              </MField>
              <MField label="Race / Ethnicity" theme={theme}>
                <select style={inp} value={profile.ethnicity}
                  onChange={e=>sp("ethnicity",e.target.value)}>
                  <option value="">Prefer not to say</option>
                  <option>Hispanic or Latino</option><option>White</option>
                  <option>Black or African American</option><option>Asian</option>
                  <option>Two or more races</option>
                </select>
              </MField>
              <MField label="Veteran Status" theme={theme}>
                <select style={inp} value={profile.veteran_status}
                  onChange={e=>sp("veteran_status",e.target.value)}>
                  <option value="">Prefer not to say</option>
                  <option>I am a protected veteran</option>
                  <option>I am not a protected veteran</option>
                </select>
              </MField>
            </MSec>

            <MSec title="Job Search" theme={theme}>
              <div style={{ marginBottom:10 }}>
                <div style={{ fontSize:10, color:theme.colorMuted, fontWeight:600,
                              textTransform:"uppercase", letterSpacing:"0.5px",
                              marginBottom:3, display:"flex", alignItems:"center", gap:4 }}>
                  Apify Token <span style={{ color:"#f87171" }}>*</span>
                  <span ref={apifyInfoRef} role="button" tabIndex={0}
                    style={{ color:theme.colorDim, cursor:"pointer", userSelect:"none",
                             textTransform:"none", fontSize:12, lineHeight:1 }}
                    onClick={() => setApifyInfoOpen(o => !o)}
                    onKeyDown={e => { if (e.key==="Enter"||e.key===" ") setApifyInfoOpen(o => !o); }}>
                    ⓘ
                  </span>
                </div>
                <input style={inp} type="password" value={apifyToken}
                  onChange={e => { setApifyToken(e.target.value);
                                   if (apifyTokenErr) setApifyTokenErr(""); }}
                  placeholder="apify_api_…"/>
                {apifyTokenErr && (
                  <span style={{ fontSize:9, color:"#f87171", marginTop:2,
                                 display:"block", lineHeight:1.4 }}>
                    {apifyTokenErr}
                  </span>
                )}
                <InfoPopover anchorRef={apifyInfoRef} open={apifyInfoOpen}
                  onClose={() => setApifyInfoOpen(false)} maxWidth={280}>
                  Required to search for jobs. Get a free token at{" "}
                  <a href="https://console.apify.com" target="_blank" rel="noreferrer"
                     style={{ color:"#e879f9", textDecoration:"none" }}>
                    console.apify.com
                  </a>{" "}→ Settings → Integrations.<br/><br/>
                  Also subscribe to these two free actors:<br/>
                  • curious_coder/linkedin-jobs-scraper<br/>
                  • valig/indeed-jobs-scraper<br/><br/>
                  Without this token, job search will not work.
                </InfoPopover>
              </div>
            </MSec>

            <div style={{ display:"flex", gap:8, paddingBottom:8, paddingTop:4 }}>
              <button type="button"
                style={{ background:theme.colorSurface, color:theme.colorText,
                         border:`1px solid ${theme.colorBorder}`,
                         borderRadius:"999px", padding:"10px 18px",
                         cursor:"pointer", fontWeight:700, fontSize:13,
                         flex:"0 0 auto" }}
                onClick={() => { setStep(1); setErr(""); }}>
                ← Back
              </button>
              <button type="submit" disabled={busy}
                style={{ flex:1, padding:"11px", borderRadius:"999px", border:"none",
                         background:theme.gradAccent, color:"#000", fontWeight:800,
                         fontSize:13, cursor:"pointer" }}>
                {busy ? "Creating account…" : "Create Account →"}
              </button>
            </div>
          </form>
        )}
      </motion.div>
    </div>
  );
}

const MField = ({ label, children, theme }) => (
  <div style={{ marginBottom:10 }}>
    <div style={{ fontSize:10, color:theme.colorMuted, fontWeight:600,
                  textTransform:"uppercase", letterSpacing:"0.5px", marginBottom:3 }}>
      {label}
    </div>
    {children}
  </div>
);

const MSec = ({ title, children, theme }) => (
  <div style={{ marginBottom:16 }}>
    <div style={{ fontSize:10, fontWeight:700, color:theme.colorPrimary,
                  textTransform:"uppercase", letterSpacing:"0.8px",
                  borderBottom:`1px solid ${theme.colorBorder}`,
                  paddingBottom:5, marginBottom:10 }}>
      {title}
    </div>
    {children}
  </div>
);

// ── Landing page ──────────────────────────────────────────────
export default function AuthScreen({ onLogin }) {
  const { theme } = useTheme();
  const [modal, setModal] = useState(null);

  return (
    <div style={{ minHeight:"100vh", background:theme.gradBg,
                  fontFamily:"'Inter',Arial,sans-serif",
                  color:theme.colorText, display:"flex", flexDirection:"column" }}>
      <style>{`* { box-sizing:border-box; } body { margin:0; }`}</style>

      {/* ── Nav ── */}
      <nav style={{ display:"flex", alignItems:"center", padding:"14px 32px",
                    borderBottom:`1px solid ${theme.colorBorder}`,
                    position:"sticky", top:0,
                    background:theme.gradPanel, zIndex:50 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <AtomEmblem size={36} textSize={5} orbitSize={9}/>
          <span className="site-title" style={{ whiteSpace:"nowrap" }}>Resume Master</span>
        </div>
        <div style={{ flex:1 }}/>
        <button style={{ background:theme.colorSurface, color:theme.colorText,
                         border:`1px solid ${theme.colorBorder}`,
                         padding:"7px 18px", cursor:"pointer",
                         fontSize:12, fontWeight:700, borderRadius:"999px" }}
          onClick={() => setModal("login")}>
          Sign In
        </button>
      </nav>

      {/* ── 50/50 split body ── */}
      <div style={{ flex:1, display:"flex", overflow:"hidden", minHeight:0 }}>

        {/* LEFT — hero */}
        <div style={{ flex:"0 0 50%", padding:"48px 40px 32px",
                      display:"flex", flexDirection:"column",
                      overflowY:"auto" }}>
          {/* Tiles */}
          <div style={{ display:"flex", flexDirection:"column", gap:6, marginBottom:32 }}>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
              <div style={{ border:`1.5px solid ${theme.colorBorder}`, padding:"16px 28px",
                            fontSize:"clamp(32px,5vw,56px)", fontWeight:800,
                            lineHeight:1, letterSpacing:"-1px", borderRadius:"16px",
                            background:theme.colorSurface, color:theme.colorText }}>
                Land
              </div>
              <div style={{ padding:"16px 28px",
                            fontSize:"clamp(32px,5vw,56px)", fontWeight:800,
                            lineHeight:1, letterSpacing:"-1px",
                            background:theme.gradAccent, color:"#000", borderRadius:"999px" }}>
                your next
              </div>
            </div>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
              <div style={{ border:`1.5px solid ${theme.colorBorder}`, padding:"16px 28px",
                            fontSize:"clamp(32px,5vw,56px)", fontWeight:800,
                            lineHeight:1, letterSpacing:"-1px", borderRadius:"16px",
                            background:theme.colorSurface, color:theme.colorText }}>
                role
              </div>
              <div style={{ border:`1.5px solid ${theme.colorBorder}`, padding:"16px 28px",
                            fontSize:"clamp(32px,5vw,56px)", fontWeight:800,
                            lineHeight:1, letterSpacing:"-1px", borderRadius:"16px",
                            background:theme.colorSurface, color:theme.colorText }}>
                smarter
              </div>
            </div>
          </div>

          <div style={{ position:"relative", width:130, height:130, marginBottom:24 }}>
            <AtomEmblem size={130}/>
          </div>

          <p style={{ fontSize:15, color:theme.colorMuted, lineHeight:1.7,
                      maxWidth:480, margin:"0 0 28px", fontWeight:400 }}>
            AI-tailored resumes, real-time job scraping, and one-click autofill —<br/>
            built for engineers who want to apply faster and land better.
          </p>

          <div style={{ display:"flex", gap:12, flexWrap:"wrap", marginBottom:32 }}>
            <button style={{ background:theme.colorText, color:"#000", border:"none",
                             padding:"14px 40px", cursor:"pointer",
                             fontSize:14, fontWeight:800, letterSpacing:"0.3px",
                             borderRadius:"999px" }}
              onClick={() => setModal("register")}>
              Get Started — it's free
            </button>
            <button style={{ background:"transparent", color:theme.colorText,
                             border:`1.5px solid ${theme.colorBorder}`,
                             padding:"14px 28px", cursor:"pointer",
                             fontSize:13, fontWeight:700, borderRadius:"999px" }}
              onClick={() => setModal("login")}>
              Sign In
            </button>
          </div>

          {/* Company ticker */}
          <p style={{ textAlign:"left", fontSize:11, color:theme.colorDim,
                      fontWeight:600, letterSpacing:"0.5px",
                      textTransform:"uppercase", marginBottom:12 }}>
            Roles at companies like these — tailored, tracked, applied.
          </p>
          <CompanyTicker theme={theme}/>

          {/* Footer */}
          <div style={{ marginTop:"auto", paddingTop:24, display:"flex",
                        alignItems:"center", justifyContent:"space-between",
                        fontSize:11, color:theme.colorDim, borderTop:`1px solid ${theme.colorBorder}` }}>
            <span>Resume Master · Built for engineers, by engineers.</span>
            <button style={{ background:"transparent", border:"none",
                             color:theme.colorDim, fontSize:11,
                             cursor:"pointer", textDecoration:"underline" }}
              onClick={() => setModal("login")}>
              Admin Login
            </button>
          </div>
        </div>

        {/* RIGHT — POSTER_CARDS scrolling banner */}
        <div style={{ flex:"0 0 50%", borderLeft:`1px solid ${theme.colorBorder}`,
                      padding:"24px 20px", overflow:"hidden",
                      background:`rgba(0,0,0,0.2)` }}>
          <PosterBanner theme={theme}/>
        </div>
      </div>

      {modal && (
        <AuthModal mode={modal} onLogin={onLogin}
          onClose={() => setModal(null)} theme={theme}/>
      )}
    </div>
  );
}
