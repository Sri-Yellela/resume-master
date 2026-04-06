// client/src/components/TopBar.jsx — v9
// Changes: corrected Indeed actor slug in hint text, aligned hasApifyToken key,
//          added token clear button, loading state for ApifyTokenRow
import { useState, useRef, useEffect } from "react";
import { api }        from "../lib/api.js";
import { AtomEmblem } from "./AuthScreen.jsx";

const APPLY_MODES = [
  { value:"SIMPLE",         label:"Simple Apply",   icon:"⚡", desc:"Job board only — no generation",
    info:"Job board link only. No resume generation. Use this if you want to apply manually or already have a resume ready." },
  { value:"TAILORED",       label:"Tailored Apply",  icon:"✦", desc:"Rewrite bullets, fixed employers",
    info:"Rewrites your resume bullets to match the job description. Uses fixed employer names from a predefined map based on job category." },
  { value:"CUSTOM_SAMPLER", label:"Custom Sampler",  icon:"⚙", desc:"Full customisation, JD-driven companies",
    info:"Full customisation — rewrites your entire resume driven by the job description. Company names are pulled directly from the JD. Best ATS scores." },
];

// ── Viewport-aware dropdown wrapper ───────────────────────────
function DropdownPortal({ anchorRef, open, onClose, align, children }) {
  const [rect, setRect] = useState(null);

  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    setRect(r);
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const h = e => {
      if (anchorRef.current && !anchorRef.current.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open, anchorRef, onClose]);

  if (!open || !rect) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const PREFERRED_W = align === "left" ? 272 : 216;
  const GAP = 6;
  const MARGIN = 8;

  const spaceBelow = vh - rect.bottom - MARGIN;
  const spaceAbove = rect.top - MARGIN;
  const openUp = spaceBelow < 260 && spaceAbove > spaceBelow;
  const maxH   = openUp ? Math.min(spaceAbove, vh - 32) : Math.min(spaceBelow, vh - 32);

  let left, width;
  if (align === "left") {
    left  = Math.max(MARGIN, Math.min(rect.left, vw - PREFERRED_W - MARGIN));
    width = Math.min(PREFERRED_W, vw - left - MARGIN);
  } else {
    const idealLeft = rect.right - PREFERRED_W;
    left  = Math.max(MARGIN, idealLeft);
    width = Math.min(PREFERRED_W, vw - left - MARGIN);
  }

  const top = openUp
    ? rect.top - GAP - Math.min(maxH, 9999)
    : rect.bottom + GAP;

  return (
    <div
      style={{
        position:"fixed",
        top:   openUp ? "auto" : top,
        bottom:openUp ? vh - rect.top + GAP : "auto",
        left,
        width,
        maxHeight: maxH,
        background:"#1e293b",
        border:"1px solid #334155",
        borderRadius:10,
        boxShadow:"0 20px 60px rgba(0,0,0,.7)",
        zIndex:9999,
        overflowY:"auto",
        overflowX:"hidden",
        boxSizing:"border-box",
      }}
      onMouseDown={e => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

export default function TopBar({ user, activeTab, onTabChange, onLogout, onUserChange }) {
  const [sandwichOpen, setSandwichOpen] = useState(false);
  const [profileOpen,  setProfileOpen]  = useState(false);
  const [mode,         setMode]         = useState(user?.applyMode || "TAILORED");
  const [savingMode,   setSavingMode]   = useState(false);
  const [modeInfo,     setModeInfo]     = useState(null); // { value, rect }

  const sandwichRef = useRef();
  const profileRef  = useRef();

  const changeMode = async newMode => {
    setSavingMode(true);
    try {
      await api("/api/settings/apply-mode", { method:"PATCH", body:JSON.stringify({ mode:newMode }) });
      setMode(newMode);
      onUserChange?.({ ...user, applyMode:newMode });
    } catch {}
    setSavingMode(false);
  };

  const currentMode = APPLY_MODES.find(m => m.value === mode) || APPLY_MODES[1];

  const tabs = [
    { id:"jobs",     label:"Jobs"     },
    { id:"database", label:"Database" },
    ...(user?.isAdmin ? [{ id:"admin", label:"Admin" }] : []),
  ];

  return (
    <>
      <header style={s.bar}>
        {/* Brand */}
        <div style={s.brand}>
          <AtomEmblem size={38} textSize={5.5} orbitSize={10}/>
          <span className="site-title" style={s.siteTitle}>Resume Master</span>
        </div>

        {/* Tabs */}
        <nav style={s.tabs}>
          {tabs.map(t => (
            <button key={t.id}
              style={{ ...s.tab, ...(activeTab===t.id ? s.tabActive : {}) }}
              onClick={() => onTabChange(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>

        <div style={{ flex:1 }}/>

        {/* Mode badge */}
        <div style={s.modeBadge}>
          {savingMode ? "⏳" : currentMode.icon} {currentMode.label}
        </div>

        {/* Sandwich */}
        <div ref={sandwichRef} style={{ position:"relative" }}>
          <button style={s.iconBtn}
            onClick={() => { setSandwichOpen(o => !o); setProfileOpen(false); }}
            title="Settings">
            <div style={s.ham}>
              <span style={s.hamLine}/><span style={s.hamLine}/><span style={s.hamLine}/>
            </div>
          </button>
        </div>

        {/* Avatar */}
        <div ref={profileRef} style={{ position:"relative" }}>
          <button style={s.avatar}
            onClick={() => { setProfileOpen(o => !o); setSandwichOpen(false); }}
            title={user?.username}>
            {(user?.username||"U")[0].toUpperCase()}
          </button>
        </div>
      </header>

      {/* ── Sandwich dropdown ── */}
      <DropdownPortal
        anchorRef={sandwichRef}
        open={sandwichOpen}
        onClose={() => setSandwichOpen(false)}
        align="left">
        <SLabel>Apply Mode</SLabel>
        {APPLY_MODES.map(m => (
          <button key={m.value}
            style={{ ...s.modeOpt, ...(mode===m.value ? s.modeOptActive : {}) }}
            onClick={() => { changeMode(m.value); setSandwichOpen(false); }}>
            <span style={{ fontSize:14, flexShrink:0 }}>{m.icon}</span>
            <div style={{ flex:1, minWidth:0, overflow:"hidden" }}>
              <div style={{ fontWeight:700, color:"#f8fafc", fontSize:12,
                            display:"flex", alignItems:"center", gap:3 }}>
                <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {m.label}
                </span>
                <span role="button" tabIndex={0}
                  style={{ color:"#475569", cursor:"pointer", userSelect:"none",
                           flexShrink:0, fontSize:11, lineHeight:1, fontWeight:400 }}
                  onClick={e => {
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setModeInfo(modeInfo?.value === m.value ? null : { value:m.value, rect });
                  }}
                  onKeyDown={e => { if (e.key==="Enter"||e.key===" ") e.currentTarget.click(); }}
                  title="More info">
                  ⓘ
                </span>
              </div>
              <div style={{ fontSize:10, color:"#64748b", marginTop:1,
                            whiteSpace:"normal", wordBreak:"break-word" }}>
                {m.desc}
              </div>
            </div>
            {mode===m.value && <span style={{ color:"#e879f9", fontWeight:900, flexShrink:0 }}>✓</span>}
          </button>
        ))}
        <Divider/>
        <SLabel>API Keys</SLabel>
        <ApifyTokenRow/>
        <Divider/>
        <SLabel>Job Refresh</SLabel>
        <DItem icon="🔄" label="View Refresh Quota" onClick={async () => {
          setSandwichOpen(false);
          const q = await api("/api/scrape/quota");
          alert(`Refreshes used today: ${q.used} / 4\nRemaining: ${q.remaining}${
            q.windowEnds ? `\nResets: ${new Date(q.windowEnds*1000).toLocaleString()}` : ""}`);
        }}/>
      </DropdownPortal>

      {/* ── Mode info popover ── */}
      {modeInfo && (
        <ModeInfoPopover
          rect={modeInfo.rect}
          text={APPLY_MODES.find(m => m.value === modeInfo.value)?.info}
          onClose={() => setModeInfo(null)}
        />
      )}

      {/* ── Avatar dropdown ── */}
      <DropdownPortal
        anchorRef={profileRef}
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        align="right">
        <div style={{ padding:"10px 12px 6px" }}>
          <div style={{ color:"#f8fafc", fontWeight:700, fontSize:13,
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {user?.username}
          </div>
          <div style={{ fontSize:10, color:"#64748b", marginTop:2 }}>
            {user?.isAdmin ? "Administrator" : "User"} · {currentMode.label}
          </div>
        </div>
        <Divider/>
        <DItem icon="👤" label="Edit Profile" onClick={() => { onTabChange("profile"); setProfileOpen(false); }}/>
        {user?.isAdmin && (
          <DItem icon="🛡" label="Admin Panel" onClick={() => { onTabChange("admin"); setProfileOpen(false); }}/>
        )}
        <Divider/>
        <DItem icon="🚪" label="Sign out" onClick={onLogout} danger/>
      </DropdownPortal>
    </>
  );
}

// ── Sub-components ────────────────────────────────────────────
const SLabel = ({ children }) => (
  <div style={{ fontSize:9, fontWeight:700, color:"#475569",
                letterSpacing:"0.8px", textTransform:"uppercase",
                padding:"8px 12px 4px" }}>
    {children}
  </div>
);
const Divider = () => <div style={{ height:1, background:"#334155", margin:"4px 0" }}/>;

function DItem({ icon, label, onClick, danger }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      style={{ display:"flex", alignItems:"center", gap:8, width:"100%",
               background:hov ? "#0f172a" : "transparent", border:"none",
               color:danger ? "#f87171" : "#cbd5e1",
               fontSize:12, padding:"7px 12px", cursor:"pointer",
               textAlign:"left", boxSizing:"border-box",
               whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}>
      <span style={{ width:18, textAlign:"center", flexShrink:0 }}>{icon}</span>
      {label}
    </button>
  );
}

function ApifyTokenRow() {
  const [token,    setToken]    = useState("");
  const [hasToken, setHasToken] = useState(false); // reflects server state
  const [saved,    setSaved]    = useState(false);
  const [busy,     setBusy]     = useState(false);

  // Load current token status on mount
  useEffect(() => {
    api("/api/settings")
      .then(d => setHasToken(!!d.hasApifyToken))
      .catch(() => {});
  }, []);

  const save = async () => {
    const t = token.trim();
    if (!t) return;
    setBusy(true);
    try {
      await api("/api/settings/apify-token", { method:"PATCH", body:JSON.stringify({ token:t }) });
      setSaved(true);
      setHasToken(true);
      setToken("");
      setTimeout(() => setSaved(false), 2500);
    } catch(e) { alert("Failed to save token: "+e.message); }
    setBusy(false);
  };

  const clear = async () => {
    if (!confirm("Remove your Apify token? You won't be able to search for jobs until you add one again.")) return;
    setBusy(true);
    try {
      await api("/api/settings/apify-token", { method:"DELETE" });
      setHasToken(false);
      setToken("");
    } catch(e) { alert("Failed to clear token: "+e.message); }
    setBusy(false);
  };

  return (
    <div style={{ padding:"6px 12px 10px", boxSizing:"border-box", width:"100%" }}>
      <div style={{ fontSize:10, color:"#64748b", marginBottom:5,
                    lineHeight:1.5, wordBreak:"break-word" }}>
        {hasToken
          ? <span style={{ color:"#86efac", fontWeight:700 }}>✓ Token saved</span>
          : <><span style={{ color:"#f87171", fontWeight:700 }}>Required</span> to search for jobs.</>
        }
        <br/>
        Get a free token at{" "}
        <a href="https://console.apify.com" target="_blank" rel="noreferrer"
           style={{ color:"#e879f9", textDecoration:"none" }}>
          console.apify.com
        </a>{" "}→ Settings → Integrations.<br/>
        Subscribe to{" "}
        {/* Correct actor slugs */}
        <span style={{ color:"#94a3b8" }}>curious_coder/linkedin-jobs-scraper</span>{" "}
        and <span style={{ color:"#94a3b8" }}>valig/indeed-jobs-scraper</span>.
      </div>
      <div style={{ display:"flex", gap:5, width:"100%", boxSizing:"border-box" }}>
        <input
          type="password" value={token}
          onChange={e => setToken(e.target.value)}
          onKeyDown={e => e.key==="Enter" && save()}
          placeholder={hasToken ? "Paste new token to replace…" : "apify_api_…"}
          style={{ flex:1, minWidth:0, padding:"5px 8px", borderRadius:5,
                   border:"1px solid #334155", background:"#0f172a",
                   color:"#f8fafc", fontSize:11, outline:"none",
                   boxSizing:"border-box" }}
        />
        <button onClick={save} disabled={busy || !token.trim()}
          style={{ flexShrink:0,
                   background:saved ? "#10b981" : "#e879f9",
                   color:saved ? "#fff" : "#111", border:"none",
                   borderRadius:5, padding:"5px 10px", cursor:"pointer",
                   fontSize:11, fontWeight:700,
                   opacity:(busy || !token.trim()) ? 0.5 : 1 }}>
          {saved ? "✓" : busy ? "…" : "Save"}
        </button>
        {hasToken && (
          <button onClick={clear} disabled={busy}
            style={{ flexShrink:0, background:"transparent",
                     color:"#f87171", border:"1px solid #f87171",
                     borderRadius:5, padding:"5px 8px", cursor:"pointer",
                     fontSize:11, fontWeight:700,
                     opacity:busy ? 0.5 : 1 }}
            title="Remove saved token">
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

function ModeInfoPopover({ rect, text, onClose }) {
  const popRef = useRef();
  const maxWidth = 240;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = rect.right + 8;
  if (left + maxWidth > vw - 8) left = Math.max(8, rect.left - maxWidth - 8);
  let top = rect.top;
  if (top + 120 > vh - 8) top = Math.max(8, vh - 128);

  useEffect(() => {
    const onKey = e => { if (e.key === "Escape") onClose(); };
    const onMD  = e => {
      if (popRef.current?.contains(e.target)) return;
      onClose();
    };
    document.addEventListener("keydown",   onKey);
    document.addEventListener("mousedown", onMD);
    return () => {
      document.removeEventListener("keydown",   onKey);
      document.removeEventListener("mousedown", onMD);
    };
  }, [onClose]);

  return (
    <div ref={popRef} style={{
      position:"fixed", top, left, maxWidth,
      background:"#1e293b", border:"1px solid #334155", borderRadius:8,
      padding:"10px 12px", color:"#94a3b8", fontSize:10, lineHeight:1.6,
      zIndex:10000, boxShadow:"0 8px 24px rgba(0,0,0,.6)", wordBreak:"break-word",
    }}>
      {text}
    </div>
  );
}

const s = {
  bar:         { background:"#0a0f1a", borderBottom:"1px solid #1e293b",
                 padding:"0 12px", height:52,
                 display:"flex", alignItems:"center", gap:8,
                 flexShrink:0, zIndex:100 },
  brand:       { display:"flex", alignItems:"center", gap:10, flexShrink:0 },
  siteTitle:   { fontSize:24, letterSpacing:"0.5px", whiteSpace:"nowrap" },
  tabs:        { display:"flex", gap:2 },
  tab:         { background:"transparent", color:"#64748b", border:"none",
                 padding:"4px 14px", borderRadius:5, cursor:"pointer",
                 fontSize:12, fontWeight:600 },
  tabActive:   { background:"#1e293b", color:"#f8fafc" },
  modeBadge:   { background:"#1e293b", color:"#94a3b8", fontSize:10,
                 fontWeight:700, padding:"3px 10px", borderRadius:6,
                 whiteSpace:"nowrap", flexShrink:0 },
  iconBtn:     { background:"transparent", border:"none", cursor:"pointer",
                 padding:"6px 8px", borderRadius:6,
                 display:"flex", alignItems:"center" },
  ham:         { display:"flex", flexDirection:"column", gap:4 },
  hamLine:     { display:"block", width:18, height:2,
                 background:"#94a3b8", borderRadius:2 },
  avatar:      { background:"#e879f9", color:"#111", border:"none",
                 borderRadius:"50%", width:32, height:32, cursor:"pointer",
                 fontWeight:800, fontSize:13,
                 display:"flex", alignItems:"center", justifyContent:"center" },
  modeOpt:     { display:"flex", alignItems:"flex-start", gap:10,
                 background:"transparent", border:"none", color:"#cbd5e1",
                 fontSize:12, padding:"9px 12px", cursor:"pointer",
                 width:"100%", textAlign:"left", boxSizing:"border-box" },
  modeOptActive:{ background:"#0f172a" },
};
