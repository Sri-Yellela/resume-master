// client/src/components/AuthScreen.jsx — v4
import { useState, useEffect } from "react";
import { api } from "../lib/api.js";

// ── Helpers ───────────────────────────────────────────────────
// Build a full ellipse path string with rx/ry centred at (cx,cy),
// tilted by `angleDeg`. Bakes the tilt into the coordinates so
// animateMotion + mpath follows the correct tilted ellipse.
function tiltedEllipsePath(cx, cy, rx, ry, angleDeg) {
  const a = angleDeg * Math.PI / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  // Parametric ellipse: x(t)=rx*cos(t), y(t)=ry*sin(t), rotated by angle
  // We need 4 points to build an SVG arc approximation.
  // Simpler: use two arcs (semicircles) with rotated end-points.
  const x1 =  cx + rx * cos;
  const y1 =  cy + rx * sin;
  const x2 =  cx - rx * cos;
  const y2 =  cy - rx * sin;
  // xAxisRotation for the arc = angleDeg, largeArc=0, sweep=1
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
  const tr = size * 0.38;       // text ring radius
  const rx = orbitSize * 0.92;  // orbital ellipse x-radius
  const ry = orbitSize * 0.36;  // orbital ellipse y-radius
  const nr = size * 0.09;       // nucleus radius
  const er = size * 0.048;      // electron radius

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
          {/* Text ring path */}
          <path id={`tp-${size}`}
            d={`M ${cx},${cy} m -${tr},0 a ${tr},${tr} 0 1,1 ${tr*2},0 a ${tr},${tr} 0 1,1 -${tr*2},0`}/>

          {/* Glow filter */}
          <filter id={`glow-${size}`} x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="1.4" result="blur"/>
            <feMerge>
              <feMergeNode in="blur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>

          {/* Tilted ellipse motion paths — tilt baked into d attribute */}
          {orbits.map(o => (
            <path key={o.id} id={o.id}
              d={tiltedEllipsePath(cx, cy, rx, ry, o.tilt)}
              fill="none"/>
          ))}
        </defs>

        {/* Orbital guide ellipses — faint, tilted via transform (visual only) */}
        {orbits.map(o => (
          <ellipse key={`guide-${o.id}`}
            cx={cx} cy={cy} rx={rx} ry={ry}
            fill="none" stroke="#e879f9"
            strokeWidth={0.7} strokeOpacity={0.28}
            transform={`rotate(${o.tilt} ${cx} ${cy})`}/>
        ))}

        {/* Rotating text ring */}
        <g className={`atm-text-${size}`}>
          <text style={{ fontSize:textSize, fontWeight:700,
                         fill:"currentColor", letterSpacing:1.0 }}>
            <textPath href={`#tp-${size}`}>
              APPLY • TRACK • LAND • APPLY • TRACK • LAND •{" "}
            </textPath>
          </text>
        </g>

        {/* Electrons — each follows its own tilted ellipse path */}
        {orbits.map(o => (
          <circle key={`e-${o.id}`} r={er}
            fill="#e879f9"
            filter={`url(#glow-${size})`}>
            <animateMotion
              dur="3.4s"
              repeatCount="indefinite"
              begin={o.begin}>
              <mpath href={`#${o.id}`}/>
            </animateMotion>
          </circle>
        ))}
      </svg>

      {/* Nucleus */}
      <div className={`atm-nucleus-${size}`}
           style={{ width:nr*2, height:nr*2, borderRadius:"50%",
                    background:"radial-gradient(circle at 32% 32%, #f5d0fe, #e879f9)",
                    boxShadow:`0 0 ${nr}px ${nr*0.5}px rgba(232,121,249,.55)`,
                    pointerEvents:"none" }}/>
    </div>
  );
}

// ── Company ticker ────────────────────────────────────────────
const COMPANIES = [
  { name:"Google",     color:"#4285F4" }, { name:"Meta",       color:"#0866FF" },
  { name:"Amazon",     color:"#FF9900" }, { name:"Apple",      color:"#555555" },
  { name:"Microsoft",  color:"#00A4EF" }, { name:"Netflix",    color:"#E50914" },
  { name:"Stripe",     color:"#635BFF" }, { name:"Airbnb",     color:"#FF5A5F" },
  { name:"Uber",       color:"#000000" }, { name:"Spotify",    color:"#1DB954" },
  { name:"Snowflake",  color:"#29B5E8" }, { name:"Databricks", color:"#FF3621" },
  { name:"OpenAI",     color:"#10A37F" }, { name:"Anthropic",  color:"#CC785C" },
  { name:"Palantir",   color:"#101113" }, { name:"Figma",      color:"#F24E1E" },
];

function CompanyTicker() {
  const items = [...COMPANIES, ...COMPANIES];
  return (
    <div style={{ overflow:"hidden", width:"100%",
                  borderTop:"1px solid #e5e5e5", borderBottom:"1px solid #e5e5e5",
                  padding:"14px 0", background:"#fafafa" }}>
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
                           color:"#111", letterSpacing:"0.5px" }}>{c.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Field normalisers (mirrors ProfilePanel) ──────────────────
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

// ── Auth modal ────────────────────────────────────────────────
function AuthModal({ mode: initialMode, onLogin, onClose }) {
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
  const sp = (k,v) => setProfile(p => ({ ...p, [k]:v }));

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
    if (!username)            { setErr("Choose a username."); return; }
    if (password.length < 8)  { setErr("Password must be at least 8 characters."); return; }
    if (password !== confirm)  { setErr("Passwords do not match."); return; }
    setErr(""); setStep(2);
  };

  const handleRegister = async e => {
    e.preventDefault();
    if (!profile.full_name) { setErr("Full name is required."); return; }
    if (!profile.email)     { setErr("Email is required."); return; }
    setBusy(true); setErr("");
    try {
      const d = await api("/api/auth/register",{
        method:"POST", body:JSON.stringify({ username, password, profile }),
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

  return (
    <div style={mo.overlay} onClick={e => { if(e.target===e.currentTarget) onClose(); }}>
      <div style={mo.card}>
        <button style={mo.close} onClick={onClose}>✕</button>
        <div style={mo.tabs}>
          {[["login","Sign In"],["register","Create Account"]].map(([m,l]) => (
            <button key={m}
              style={{ ...mo.tab, ...(mode===m ? mo.tabActive : {}) }}
              onClick={() => { setMode(m); setStep(1); setErr(""); }}>
              {l}
            </button>
          ))}
        </div>

        {err    && <div style={mo.err}>✗ {err}</div>}
        {status && <div style={mo.ok}>{status}</div>}

        {mode==="login" && (
          <form onSubmit={handleLogin} style={mo.form}>
            <MField label="Username">
              <input style={mo.inp} value={username}
                onChange={e=>setUsername(e.target.value)} placeholder="Username" autoFocus/>
            </MField>
            <MField label="Password">
              <input style={mo.inp} type="password" value={password}
                onChange={e=>setPassword(e.target.value)} placeholder="Password"/>
            </MField>
            <button type="submit" disabled={busy} style={mo.submitBtn}>
              {busy?"Signing in…":"Sign In →"}
            </button>
          </form>
        )}

        {mode==="register" && step===1 && (
          <form onSubmit={handleAccountNext} style={mo.form}>
            <div style={mo.stepLabel}>Step 1 of 2 — Account details</div>
            <MField label="Username">
              <input style={mo.inp} value={username}
                onChange={e=>setUsername(e.target.value)} placeholder="Choose a username" autoFocus/>
            </MField>
            <MField label="Password">
              <input style={mo.inp} type="password" value={password}
                onChange={e=>setPassword(e.target.value)} placeholder="Min. 8 characters"/>
            </MField>
            <MField label="Confirm Password">
              <input style={mo.inp} type="password" value={confirm}
                onChange={e=>setConfirm(e.target.value)} placeholder="Repeat password"/>
            </MField>
            <button type="submit" style={mo.submitBtn}>Next →</button>
          </form>
        )}

        {mode==="register" && step===2 && (
          <form onSubmit={handleRegister}
            style={{ ...mo.form, maxHeight:"55vh", overflowY:"auto", paddingRight:4 }}>
            <div style={mo.stepLabel}>
              Step 2 of 2 — Your profile{" "}
              <span style={{ color:"#9ca3af", fontWeight:400 }}>(used for autofill)</span>
            </div>

            <MSec title="Personal">
              <MField label="Full Name *">
                <input style={mo.inp} value={profile.full_name}
                  onChange={e=>sp("full_name",e.target.value)}
                  placeholder="First Last  or  First Middle Last" autoFocus/>
                <span style={mo.hint}>Enter your name exactly as it should appear on applications.</span>
              </MField>
              <MField label="Email *">
                <input style={mo.inp} type="email" value={profile.email}
                  onChange={e=>sp("email",e.target.value)} placeholder="you@email.com"/>
              </MField>
              <MField label="Phone">
                <input style={mo.inp} type="tel" value={profile.phone}
                  onChange={e=>sp("phone",e.target.value)}
                  onBlur={()=>sp("phone", normalisePhone(profile.phone))}
                  placeholder="+1 (555) 000-0000  or  5550001234"/>
                <span style={mo.hint}>Any format — normalised on save.</span>
              </MField>
              <MField label="LinkedIn">
                <input style={mo.inp} value={profile.linkedin_url}
                  onChange={e=>sp("linkedin_url",e.target.value)}
                  onBlur={()=>sp("linkedin_url", normaliseUrl(profile.linkedin_url))}
                  placeholder="linkedin.com/in/handle"/>
              </MField>
              <MField label="GitHub">
                <input style={mo.inp} value={profile.github_url}
                  onChange={e=>sp("github_url",e.target.value)}
                  onBlur={()=>sp("github_url", normaliseUrl(profile.github_url))}
                  placeholder="github.com/handle"/>
              </MField>
            </MSec>

            <MSec title="Address">
              <MField label="Street Address">
                <input style={mo.inp} value={profile.address_line1}
                  onChange={e=>sp("address_line1",e.target.value)} placeholder="123 Main St"/>
              </MField>
              <MField label="Apt / Suite / Unit">
                <input style={mo.inp} value={profile.address_line2}
                  onChange={e=>sp("address_line2",e.target.value)} placeholder="Apt 4B"/>
              </MField>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                <MField label="City">
                  <input style={mo.inp} value={profile.city}
                    onChange={e=>sp("city",e.target.value)} placeholder="Boston"/>
                </MField>
                <MField label="State">
                  <input style={mo.inp} value={profile.state}
                    onChange={e=>sp("state",e.target.value)}
                    onBlur={()=>sp("state", profile.state.trim().toUpperCase().slice(0,2))}
                    placeholder="MA"/>
                </MField>
                <MField label="ZIP">
                  <input style={mo.inp} value={profile.zip}
                    onChange={e=>sp("zip",e.target.value)}
                    onBlur={()=>sp("zip", profile.zip.replace(/[^\dA-Z\s-]/gi,"").trim().slice(0,7))}
                    placeholder="02101"/>
                </MField>
              </div>
            </MSec>

            <MSec title="Work Authorization">
              <MField label="Visa / Status">
                <select style={mo.inp} value={profile.visa_type}
                  onChange={e=>sp("visa_type",e.target.value)}>
                  <option value="">Select…</option>
                  <option>US Citizen</option><option>Green Card / LPR</option>
                  <option>H-1B</option><option>OPT</option><option>STEM OPT</option>
                  <option>TN Visa</option><option>O-1</option><option>Other</option>
                </select>
              </MField>
              <MField label="Work Authorization">
                <select style={mo.inp} value={profile.work_auth}
                  onChange={e=>sp("work_auth",e.target.value)}>
                  <option value="">Select…</option>
                  <option>Authorized to work in the US without sponsorship</option>
                  <option>Will require sponsorship now or in the future</option>
                </select>
              </MField>
              <label style={mo.chk}>
                <input type="checkbox" checked={profile.requires_sponsorship}
                  onChange={e=>sp("requires_sponsorship",e.target.checked)}
                  style={{ accentColor:"#e879f9" }}/>
                {" "}Requires visa sponsorship
              </label>
              <label style={mo.chk}>
                <input type="checkbox" checked={profile.has_clearance}
                  onChange={e=>sp("has_clearance",e.target.checked)}
                  style={{ accentColor:"#e879f9" }}/>
                {" "}Active security clearance
              </label>
              {profile.has_clearance && (
                <MField label="Clearance Level">
                  <select style={mo.inp} value={profile.clearance_level}
                    onChange={e=>sp("clearance_level",e.target.value)}>
                    <option value="">Select…</option>
                    <option>Public Trust</option><option>Secret</option>
                    <option>Top Secret</option><option>TS/SCI</option>
                    <option>TS/SCI + Poly</option>
                  </select>
                </MField>
              )}
            </MSec>

            <MSec title="Voluntary EEO">
              <MField label="Gender">
                <select style={mo.inp} value={profile.gender}
                  onChange={e=>sp("gender",e.target.value)}>
                  <option value="">Prefer not to say</option>
                  <option>Male</option><option>Female</option><option>Non-binary</option>
                </select>
              </MField>
              <MField label="Race / Ethnicity">
                <select style={mo.inp} value={profile.ethnicity}
                  onChange={e=>sp("ethnicity",e.target.value)}>
                  <option value="">Prefer not to say</option>
                  <option>Hispanic or Latino</option><option>White</option>
                  <option>Black or African American</option><option>Asian</option>
                  <option>Two or more races</option>
                </select>
              </MField>
              <MField label="Veteran Status">
                <select style={mo.inp} value={profile.veteran_status}
                  onChange={e=>sp("veteran_status",e.target.value)}>
                  <option value="">Prefer not to say</option>
                  <option>I am a protected veteran</option>
                  <option>I am not a protected veteran</option>
                </select>
              </MField>
            </MSec>

            <div style={{ display:"flex", gap:8, paddingBottom:8, paddingTop:4 }}>
              <button type="button"
                style={{ ...mo.submitBtn, background:"#374151",
                         flex:"0 0 auto", width:"auto", padding:"10px 18px" }}
                onClick={() => { setStep(1); setErr(""); }}>
                ← Back
              </button>
              <button type="submit" disabled={busy} style={mo.submitBtn}>
                {busy?"Creating account…":"Create Account →"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

const MField = ({ label, children }) => (
  <div style={{ marginBottom:10 }}>
    <div style={{ fontSize:10, color:"#9ca3af", fontWeight:600,
                  textTransform:"uppercase", letterSpacing:"0.5px", marginBottom:3 }}>
      {label}
    </div>
    {children}
  </div>
);
const MSec = ({ title, children }) => (
  <div style={{ marginBottom:16 }}>
    <div style={{ fontSize:10, fontWeight:700, color:"#e879f9",
                  textTransform:"uppercase", letterSpacing:"0.8px",
                  borderBottom:"1px solid #374151", paddingBottom:5, marginBottom:10 }}>
      {title}
    </div>
    {children}
  </div>
);
const mo = {
  overlay:   { position:"fixed", inset:0, background:"rgba(0,0,0,.75)",
               backdropFilter:"blur(4px)", zIndex:1000,
               display:"flex", alignItems:"center",
               justifyContent:"center", padding:16 },
  card:      { background:"#111827", border:"1px solid #374151",
               borderRadius:16, padding:"28px 28px",
               width:"100%", maxWidth:460, position:"relative",
               boxShadow:"0 40px 80px rgba(0,0,0,.6)",
               maxHeight:"calc(100vh - 32px)", overflowY:"auto" },
  close:     { position:"absolute", top:16, right:16, background:"transparent",
               border:"none", color:"#6b7280", cursor:"pointer", fontSize:18 },
  tabs:      { display:"flex", background:"#1f2937", borderRadius:8,
               padding:3, gap:3, marginBottom:20 },
  tab:       { flex:1, background:"transparent", color:"#6b7280", border:"none",
               borderRadius:6, padding:"7px 0", cursor:"pointer",
               fontSize:12, fontWeight:700 },
  tabActive: { background:"#374151", color:"#f9fafb" },
  stepLabel: { fontSize:11, fontWeight:700, color:"#6b7280", marginBottom:14 },
  form:      { display:"flex", flexDirection:"column", gap:0 },
  inp:       { width:"100%", padding:"9px 11px", borderRadius:7,
               border:"1px solid #374151", background:"#1f2937",
               color:"#f9fafb", fontSize:12, outline:"none", boxSizing:"border-box" },
  submitBtn: { width:"100%", padding:"11px", borderRadius:8, border:"none",
               background:"#e879f9", color:"#111", fontWeight:800,
               fontSize:13, cursor:"pointer", marginTop:6 },
  err:       { background:"#450a0a", color:"#fca5a5", fontSize:11,
               padding:"8px 10px", borderRadius:6, marginBottom:12 },
  ok:        { background:"#052e16", color:"#86efac", fontSize:11,
               padding:"8px 10px", borderRadius:6, marginBottom:12 },
  hint:      { fontSize:9, color:"#6b7280", marginTop:2, display:"block", lineHeight:1.4 },
  chk:       { display:"flex", alignItems:"center", gap:8, marginBottom:8,
               cursor:"pointer", fontSize:12, color:"#d1d5db" },
};

// ── Landing page ──────────────────────────────────────────────
// This is a STANDALONE full-page component. It renders its own
// nav bar. TopBar never mounts here — see App.jsx.
export default function AuthScreen({ onLogin }) {
  const [modal, setModal] = useState(null);

  return (
    <div style={lp.root}>
      <style>{`* { box-sizing:border-box; } body { margin:0; }`}</style>

      {/* ── Slim nav — logo only ── */}
      <nav style={lp.nav}>
        <div style={lp.brand}>
          <AtomEmblem size={36} textSize={5} orbitSize={9}/>
          <span className="site-title-light" style={lp.brandName}>Resume Master</span>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section style={lp.hero}>
        <div style={lp.tileGrid}>
          <div style={lp.tileRow}>
            <div style={lp.tile}>Land</div>
            <div style={{ ...lp.tile, ...lp.tilePink }}>your next</div>
          </div>
          <div style={lp.tileRow}>
            <div style={lp.tile}>role</div>
            <div style={lp.tile}>smarter</div>
          </div>
        </div>

        <div style={lp.emblemWrap}>
          <AtomEmblem size={130}/>
        </div>

        <p style={lp.tagline}>
          AI-tailored resumes, real-time job scraping, and one-click autofill —<br/>
          built for engineers who want to apply faster and land better.
        </p>

        <div style={lp.ctas}>
          <button style={lp.ctaPrimary}  onClick={() => setModal("register")}>
            Get Started — it's free
          </button>
          <button style={lp.ctaSecondary} onClick={() => setModal("login")}>
            Sign In
          </button>
        </div>
      </section>

      {/* ── Company ticker ── */}
      <div style={{ margin:"32px 0 0" }}>
        <p style={lp.tickerLabel}>
          Roles at companies like these — tailored, tracked, applied.
        </p>
        <CompanyTicker/>
      </div>

      {/* ── Feature grid ── */}
      <section style={lp.features}>
        {[
          { icon:"🧠", title:"AI Resume Tailoring",
            desc:"Claude Sonnet rewrites your resume for every JD — matching ATS keywords, inferring the right tech stack, enforcing 16–22 bullet discipline." },
          { icon:"📡", title:"Live Job Scraping",
            desc:"LinkedIn + Indeed scraped on demand. Ghost jobs filtered. Full-time only. Deduplicated. Categorised. Refreshed up to 4 times a day." },
          { icon:"⚡", title:"One-Click Autofill",
            desc:"Chrome extension fills every field — text inputs, dropdowns, radio buttons — across Greenhouse, Lever, Workday, iCIMS, and LinkedIn." },
          { icon:"📊", title:"Application Tracker",
            desc:"Every PDF you export is logged. Search, sort, filter by date. Edit notes inline. Export to Excel. Your entire job search in one place." },
        ].map(f => (
          <div key={f.title} style={lp.featureCard}>
            <div style={lp.featureIcon}>{f.icon}</div>
            <div style={lp.featureTitle}>{f.title}</div>
            <div style={lp.featureDesc}>{f.desc}</div>
          </div>
        ))}
      </section>

      {/* ── Footer ── */}
      <footer style={lp.footer}>
        <span>Resume Master · Built for engineers, by engineers.</span>
        <button style={lp.footerAdmin} onClick={() => setModal("login")}>
          Admin Login
        </button>
      </footer>

      {modal && (
        <AuthModal mode={modal} onLogin={onLogin} onClose={() => setModal(null)}/>
      )}
    </div>
  );
}

const lp = {
  root:         { minHeight:"100vh", background:"#ffffff",
                  fontFamily:"'Inter',Arial,sans-serif",
                  color:"#111", display:"flex", flexDirection:"column" },
  nav:          { display:"flex", alignItems:"center", padding:"14px 32px",
                  borderBottom:"1px solid #e5e5e5",
                  position:"sticky", top:0, background:"#ffffff", zIndex:50 },
  brand:        { display:"flex", alignItems:"center", gap:10 },
  brandName:    { whiteSpace:"nowrap" },
  hero:         { padding:"64px 32px 32px", maxWidth:900,
                  margin:"0 auto", width:"100%", position:"relative" },
  tileGrid:     { display:"flex", flexDirection:"column", gap:6, marginBottom:32 },
  tileRow:      { display:"flex", gap:6, flexWrap:"wrap" },
  tile:         { border:"1.5px solid #111", padding:"14px 24px",
                  fontSize:"clamp(28px,5vw,52px)", fontWeight:800,
                  lineHeight:1, letterSpacing:"-1px", background:"#fff" },
  tilePink:     { background:"#e879f9", border:"1.5px solid #e879f9",
                  color:"#fff", borderRadius:40 },
  emblemWrap:   { position:"absolute", top:32, right:32 },
  tagline:      { fontSize:16, color:"#555", lineHeight:1.7,
                  maxWidth:540, margin:"0 0 28px", fontWeight:400 },
  ctas:         { display:"flex", gap:12, flexWrap:"wrap" },
  ctaPrimary:   { background:"#111", color:"#fff", border:"none",
                  padding:"13px 28px", cursor:"pointer",
                  fontSize:13, fontWeight:700, letterSpacing:"0.3px" },
  ctaSecondary: { background:"transparent", color:"#111",
                  border:"1.5px solid #111", padding:"13px 28px",
                  cursor:"pointer", fontSize:13, fontWeight:700 },
  tickerLabel:  { textAlign:"center", fontSize:11, color:"#9ca3af",
                  fontWeight:600, letterSpacing:"0.5px",
                  textTransform:"uppercase", marginBottom:12 },
  features:     { display:"grid",
                  gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",
                  gap:0, borderTop:"1px solid #e5e5e5", margin:"40px 0 0" },
  featureCard:  { padding:"32px 24px", borderRight:"1px solid #e5e5e5",
                  borderBottom:"1px solid #e5e5e5" },
  featureIcon:  { fontSize:22, marginBottom:12 },
  featureTitle: { fontWeight:800, fontSize:14,
                  marginBottom:8, letterSpacing:"-0.3px" },
  featureDesc:  { fontSize:12, color:"#555", lineHeight:1.7 },
  footer:       { padding:"20px 32px", borderTop:"1px solid #e5e5e5",
                  display:"flex", alignItems:"center",
                  justifyContent:"space-between",
                  fontSize:11, color:"#9ca3af", marginTop:"auto" },
  footerAdmin:  { background:"transparent", border:"none",
                  color:"#9ca3af", fontSize:11,
                  cursor:"pointer", textDecoration:"underline" },
};
